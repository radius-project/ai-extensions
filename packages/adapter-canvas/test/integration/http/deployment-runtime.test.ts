import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowObservationScope } from "@radius-project/adapter-shared";
import type {
  DeployMonitorRequest,
  WorkflowObservationScope
} from "@radius-project/adapter-shared";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createTestDeploymentRuntime } from "../../support/server/deployment-runtime.js";
import { createDeferred } from "../../support/browser/fakes.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";
import { redactCredentials } from "@radius-project/core";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function harness() {
  const finished = createDeferred<void>();
  const sendRepair = vi.fn(async () => {});
  let terminal: "success" | "failed" = "success";
  let request: DeployMonitorRequest | undefined;
  let observation: WorkflowObservationScope | undefined;
  const resolveDeployment = vi.fn(async () => null);
  const deployment = createTestDeploymentRuntime({
    resolveDeployment,
    createExecution: () => {
      observation = createWorkflowObservationScope(() => {
        throw new Error("Unexpected artifact read");
      });
      return {
        observation,
        monitor: {
          async run(input) {
            request = input;
            await finished.promise;
            input.entry.state.deployStatus = terminal;
            if (terminal === "failed")
              input.entry.state.deployError = "Model failed";
          }
        }
      };
    },
    delivery: {
      sendRepair,
      redactDiagnostic: redactCredentials,
      reportDiagnostic: () => {}
    }
  });
  const cli = vi.fn(() => {
    throw new Error("Unexpected external command");
  });
  const server = createTestCanvasServerRuntime({
    executionOwner: createEnvironmentExecutionOwner(),
    deploymentRuntime: deployment,
    cliExec: cli
  });
  cleanups.push(async () => {
    finished.resolve();
    await deployment.owner.shutdown(1000);
    await Promise.all(
      [...server.servers.keys()].map((id) => server.stopServer(id, true))
    );
  });
  return {
    server,
    deployment,
    finished,
    sendRepair,
    cli,
    resolveDeployment,
    fail() {
      terminal = "failed";
    },
    observation() {
      if (!observation) throw new Error("Deployment not started");
      return observation;
    },
    log(message: string) {
      if (!request) throw new Error("Deployment not started");
      request.log(message);
    }
  };
}

async function post(entry: CanvasServerEntry, route: string, payload: object) {
  return fetch(`${entry.baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: entry.baseUrl,
      "Sec-Fetch-Site": "same-origin",
      "X-Radius-Mutation-Nonce": String(entry.state.browserMutationNonce || "")
    },
    body: JSON.stringify(payload)
  });
}

const target = {
  targetRepo: "acme/widgets",
  repo: "acme/widgets",
  branch: "feature",
  environment: "production",
  application: "widgets"
};

describe("shared deployment runtime through production Canvas HTTP", () => {
  it("survives close, reattaches on reopen, and keeps active reset independent of target locks", async () => {
    const h = harness();
    const entry = await h.server.getOrCreateServer("panel", "deploying");
    const response = await post(entry, "/api/deploy", target);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const selected = h.deployment.owner.lookup();
    if (selected.kind !== "found") throw new Error("Missing deployment");
    const invocation = selected.invocation;
    const scope = h.observation();
    expect(entry.state).not.toBe(invocation.state);

    await h.server.stopServer("panel", true);
    expect(scope.stopped).toBe(false);
    expect(h.deployment.owner.hasActiveWork()).toBe(true);
    h.log("still observing");
    const reopened = await h.server.getOrCreateServer("panel", "deploying");
    const status = await fetch(`${reopened.baseUrl}/api/deploy-status`);
    expect(await status.json()).toMatchObject({
      status: "in_progress",
      logs: ["still observing"],
      attempt: { id: invocation.attemptId }
    });
    const reset = await post(reopened, "/api/deploy-reset", {
      attemptId: invocation.attemptId
    });
    expect(reset.status).toBe(200);
    await reset.json();
    expect(reopened.state.deployAttempt).toBeUndefined();
    expect(
      h.deployment.owner.lookup({ observationId: invocation.observationId })
        .kind
    ).toBe("found");
    expect(scope.stopped).toBe(false);

    const other = await h.server.getOrCreateServer("other", "deploying");
    for (const route of [
      "/api/deploy",
      "/api/delete-deployment",
      "/api/abandon-deployment"
    ]) {
      const blocked = await post(other, route, target);
      expect(blocked.status, route).toBe(409);
      await blocked.json();
    }
    expect(h.cli).not.toHaveBeenCalled();
    expect(h.resolveDeployment).toHaveBeenCalledOnce();
    h.finished.resolve();
    await vi.waitFor(() =>
      expect(h.deployment.owner.hasActiveWork()).toBe(false)
    );
    expect(scope.stopped).toBe(true);
    expect(reopened.state.deployStatus).toBeUndefined();
    expect(invocation.state.deployStatus).toBe("success");

    const terminal = await fetch(`${other.baseUrl}/api/deploy-status`);
    await terminal.json();
    const terminalReset = await post(other, "/api/deploy-reset", {
      attemptId: invocation.attemptId
    });
    expect(terminalReset.status).toBe(200);
    await terminalReset.json();
    expect(
      h.deployment.owner.lookup({ observationId: invocation.observationId })
        .kind
    ).toBe("missing");
  });

  it("delivers terminal repair without any open panel and keeps subsequent status reads passive", async () => {
    const h = harness();
    h.fail();
    const entry = await h.server.getOrCreateServer("panel", "deploying");
    const started = await post(entry, "/api/deploy", target);
    expect(started.status).toBe(200);
    await started.json();
    await h.server.stopServer("panel", true);
    h.finished.resolve();
    await vi.waitFor(() => expect(h.sendRepair).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.deployment.owner.hasActiveWork()).toBe(false)
    );
    const reopened = await h.server.getOrCreateServer("panel", "deploying");
    for (let count = 0; count < 3; count++) {
      const status = await fetch(`${reopened.baseUrl}/api/deploy-status`);
      expect(await status.json()).toMatchObject({
        status: "failed",
        error: "Model failed",
        repairing: true
      });
    }
    expect(h.sendRepair).toHaveBeenCalledOnce();
  });

  it("does not allow forged Canvas state to suppress or retarget an independent deployment", async () => {
    const h = harness();
    const admitted = await h.deployment.start({
      repo: "acme/widgets",
      environment: "production",
      branch: "feature"
    });
    if (!admitted.ok) throw new Error(admitted.error);
    const entry = await h.server.getOrCreateServer("panel", "deploying");
    entry.state.deployStatus = "success";
    entry.state.deployAttempt = { id: "forged", targetRepo: "elsewhere/repo" };
    const result = await post(entry, "/api/deploy", target);
    expect(result.status).toBe(409);
    await result.json();
    expect(admitted.invocation.state.deployStatus).toBe("in_progress");
    expect(admitted.invocation.target.repo).toBe("acme/widgets");
    const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
    expect(await status.json()).toMatchObject({
      status: "in_progress",
      attempt: { id: admitted.invocation.attemptId }
    });
  });
});
