import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowObservationScope } from "@radius-project/adapter-shared";
import type {
  DeployMonitorRequest,
  WorkflowObservationScope,
  buildGraphViaRad
} from "@radius-project/adapter-shared";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createTestDeploymentRuntime } from "../../support/server/deployment-runtime.js";
import { createDeferred } from "../../support/browser/fakes.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";
import { redactCredentials } from "@radius-project/core";
import { github } from "../../../src/gh.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    vi.restoreAllMocks();
  }
});

function harness(abandonment = false, graphBuild?: typeof buildGraphViaRad) {
  let trackedApplication = "another-app";
  let trackedRunId = 31;
  const finished = createDeferred<void>();
  const sendRepair = vi.fn(async () => {});
  let terminal: "success" | "failed" = "success";
  let request: DeployMonitorRequest | undefined;
  let observation: WorkflowObservationScope | undefined;
  const resolveDeployment = vi.fn(async () => null);
  const deployment = createTestDeploymentRuntime({
    resolveDeployment,
    createExecution: (_invocation, _workspace, plannedGraph) => {
      observation = createWorkflowObservationScope(() => {
        throw new Error("Unexpected artifact read");
      });
      return {
        observation,
        monitor: {
          async run(input) {
            request = input;
            if (graphBuild) {
              if (!plannedGraph)
                throw new Error("Missing Canvas graph recovery");
              const resources = await plannedGraph.recover(input);
              if (resources) input.entry.state.deployingResources = resources;
              input.log("Graph recovery finished");
            }
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
  const cli = vi.fn<
    NonNullable<Parameters<typeof createTestCanvasServerRuntime>[0]["cliExec"]>
  >((_command, args, _options, callback) => {
    const endpoint = args
      .find((arg) => /^\/?repos\//.test(arg))
      ?.replace(/^\/?/, "/");
    if (!abandonment) throw new Error("Unexpected external command");
    let output: string;
    if (
      endpoint ===
      "/repos/acme/widgets/environments/production/variables?per_page=100"
    )
      output = "";
    else if (
      endpoint ===
      "/repos/acme/widgets/deployments?per_page=100&environment=production"
    )
      output = `failed-delete-${trackedRunId}`;
    else if (
      endpoint ===
      `/repos/acme/widgets/deployments/failed-delete-${trackedRunId}/statuses?per_page=1`
    )
      output = `failure\thttps://github.com/acme/widgets/actions/runs/${trackedRunId}\t`;
    else if (endpoint === `/repos/acme/widgets/actions/runs/${trackedRunId}`)
      output = ".github/workflows/delete-application.yml\tcompleted\tfailure";
    else if (
      endpoint ===
      `/repos/acme/widgets/actions/runs/${trackedRunId}/artifacts?per_page=100`
    )
      output = JSON.stringify({
        artifacts: [
          {
            id: trackedRunId,
            name: "rad-delete-result",
            workflow_run: { id: trackedRunId }
          }
        ]
      });
    else if (args[0] === "run" && args[1] === "download") {
      writeFileSync(
        join(args[args.indexOf("--dir") + 1], "rad-delete-result.json"),
        JSON.stringify({
          resourceType: "application",
          name: trackedApplication
        })
      );
      output = "";
    } else if (
      endpoint ===
        `/repos/acme/widgets/deployments/failed-delete-${trackedRunId}/statuses` &&
      args.includes("POST")
    )
      output = "";
    else
      throw new Error(
        `Unexpected abandonment command: ${JSON.stringify(args)}`
      );
    callback(
      null,
      args.includes("--include") ? `HTTP/2 200\n\n${output}` : output,
      ""
    );
    return new ChildProcess();
  });
  const server = createTestCanvasServerRuntime({
    executionOwner: createEnvironmentExecutionOwner(),
    deploymentRuntime: deployment,
    buildGraphViaRad: graphBuild,
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
    trackApplication(application: string) {
      trackedApplication = application;
      trackedRunId++;
    },
    request() {
      return request;
    },
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
  appFile: ".radius/app.bicep",
  targetRepo: "acme/widgets",
  repo: "acme/widgets",
  branch: "feature",
  environment: "production",
  application: "widgets"
};

describe("shared deployment runtime through production Canvas HTTP", () => {
  it.each(["workspace", "remote", "workspace fallback"] as const)(
    "binds fresh-panel graph recovery to the admitted %s model",
    async (source) => {
      const workspace = mkdtempSync(join(tmpdir(), "radius-deploy-graph-"));
      const build = vi
        .fn<typeof buildGraphViaRad>()
        .mockResolvedValue([
          { id: "web", name: "web", type: "Radius.Compute/containers" }
        ]);
      const h = harness(false, build);
      cleanups.push(async () => {
        h.finished.resolve();
        await h.deployment.owner.shutdown(1000);
        rmSync(workspace, { recursive: true, force: true });
      });
      mkdirSync(join(workspace, "models"));
      writeFileSync(join(workspace, "app.bicep"), "wrong default model");
      if (source === "workspace")
        writeFileSync(
          join(workspace, "models", "custom.bicep"),
          "selected model"
        );
      const read = vi
        .spyOn(github, "getContent")
        .mockImplementation(async (apiPath) => {
          if (
            apiPath ===
            "/repos/acme/widgets/contents/models/custom.bicep?ref=feature"
          )
            return "selected model";
          if (
            apiPath ===
            "/repos/acme/widgets/contents/models/bicepconfig.json?ref=feature"
          )
            return null;
          if (
            apiPath ===
            "/repos/radius-project/resource-types-contrib/contents/recipe-packs/azure-aks/azure-aks.bicep?ref=main"
          )
            return "param environment string";
          throw new Error(`Unexpected graph source read: ${apiPath}`);
        });
      const entry = await h.server.getOrCreateServer("panel", "deploying");
      if (source !== "remote")
        Object.assign(entry.state, {
          workspacePath: workspace,
          workspaceRepo: target.repo,
          workspaceBranch: target.branch
        });
      expect(
        (
          await post(entry, "/api/deploy", {
            ...target,
            appFile: "models/custom.bicep"
          })
        ).status
      ).toBe(200);
      await vi.waitFor(() =>
        expect(entry.state.deployLogs?.join("\n")).toContain(
          "Graph recovery finished"
        )
      );
      expect(
        entry.state.deployingResources,
        entry.state.deployLogs?.join("\n")
      ).toMatchObject([{ name: "web", deployStatus: "pending" }]);
      expect(build).toHaveBeenCalledExactlyOnceWith(
        "selected model",
        "models/custom.bicep",
        expect.any(Object)
      );
      expect(
        read.mock.calls.some(
          ([apiPath]) =>
            apiPath ===
            "/repos/acme/widgets/contents/models/custom.bicep?ref=feature"
        )
      ).toBe(source !== "workspace");
      expect(entry.state.plannedResources).toBeUndefined();
    }
  );

  it("reattaches a reused panel to the current repository's tool-started deployment", async () => {
    const h = harness();
    const entry = await h.server.getOrCreateServer("panel", "deploying");
    entry.state.contextRepo = target.repo;
    expect((await post(entry, "/api/deploy", target)).status).toBe(200);
    const first = h.deployment.owner.lookup();
    if (first.kind !== "found") throw new Error("Missing first deployment");
    const second = await h.deployment.start({
      repo: "acme/other",
      branch: "feature",
      environment: "production"
    });
    if (!second.ok) throw new Error(second.error);
    entry.state.contextRepo = "acme/other";
    for (let poll = 0; poll < 2; poll++) {
      const response = await fetch(`${entry.baseUrl}/api/deploy-status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attempt: { id: second.invocation.attemptId, targetRepo: "acme/other" }
      });
    }
    first.invocation.state.deployError = "previous repository";
    h.deployment.owner.publish(first.invocation);
    expect(entry.state.deployError).toBe(second.invocation.state.deployError);
    expect(first.invocation.signal.aborted).toBe(false);
    expect(second.invocation.signal.aborted).toBe(false);
  });

  it.each(["app.bicep", ".radius/app.bicep", null])(
    "resolves the selected branch model through real HTTP (%s)",
    async (appFile) => {
      vi.spyOn(github, "getContent").mockImplementation(async (apiPath) => {
        const model = [".radius/app.bicep", "app.bicep"].find(
          (file) =>
            apiPath === `/repos/acme/widgets/contents/${file}?ref=feature`
        );
        if (!model) throw new Error(`Unexpected source read: ${apiPath}`);
        return model === appFile ?
            "resource app 'Radius.Core/applications@2025-08-01-preview' = { name: 'widgets' }"
          : null;
      });
      const h = harness();
      const entry = await h.server.getOrCreateServer("panel", "deploying");
      const response = await post(entry, "/api/deploy", {
        ...target,
        appFile: undefined
      });
      expect(response.status, await response.clone().text()).toBe(
        appFile ? 200 : 400
      );
      if (appFile) expect(h.request()?.appFile).toBe(appFile);
      else {
        expect(h.request()).toBeUndefined();
        expect(h.deployment.owner.hasActiveWork()).toBe(false);
      }
    }
  );

  it("carries the selected model from Canvas into the shared execution request", async () => {
    const h = harness();
    const entry = await h.server.getOrCreateServer("panel", "deploying");
    const response = await post(entry, "/api/deploy", {
      ...target,
      appFile: "models/custom.bicep"
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(h.request()?.appFile).toBe("models/custom.bicep");
  });

  it("preserves another application's handles and both attached panels after abandonment", async () => {
    const h = harness(true);
    h.fail();
    const first = await h.server.getOrCreateServer("first", "deploying");
    await (await post(first, "/api/deploy", target)).json();
    const selected = h.deployment.owner.lookup();
    if (selected.kind !== "found") throw new Error("Missing invocation");
    selected.invocation.state.deployAppName = "widgets";
    h.finished.resolve();
    await vi.waitFor(() =>
      expect(h.deployment.owner.hasActiveWork()).toBe(false)
    );
    const second = await h.server.getOrCreateServer("second", "deploying");
    for (const entry of [first, second])
      await (await fetch(`${entry.baseUrl}/api/deploy-status`)).json();
    const response = await post(second, "/api/abandon-deployment", {
      ...target,
      application: "another-app"
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ outcome: "abandoned" });
    expect(
      h.deployment.owner.lookup({ attemptId: selected.invocation.attemptId })
        .kind
    ).toBe("found");
    expect(
      h.deployment.owner.lookup({
        observationId: selected.invocation.observationId
      }).kind
    ).toBe("found");
    for (const entry of [first, second]) {
      const status = await (
        await fetch(`${entry.baseUrl}/api/deploy-status`)
      ).json();
      expect(status).toMatchObject({
        status: "failed",
        attempt: { id: selected.invocation.attemptId }
      });
    }
    h.trackApplication("widgets");
    const matching = await post(second, "/api/abandon-deployment", target);
    expect(matching.status).toBe(200);
    await matching.json();
    expect(
      h.deployment.owner.lookup({
        observationId: selected.invocation.observationId
      }).kind
    ).toBe("missing");
    expect(first.state.deployAttempt).toBeUndefined();
    expect(second.state.deployAttempt).toBeUndefined();
  });

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
      const blocked = await post(other, route, {
        ...target,
        environment: "PRODUCTION"
      });
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
