import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEPLOY_STATUS_FILES,
  DEPLOY_RAD_COMMANDS_STEP,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AWS_FILE,
  generateDeployWorkflow,
  stripAwsDispatcherJob,
  stripWorkflowRunTrigger
} from "@radius-project/core";
import { deploymentTemplates } from "../test/fixtures/deployment-workflows.js";
import {
  createProductionDeploymentRuntime,
  type ProductionDeploymentPorts
} from "./production-deployment.js";

type Runtime = ReturnType<typeof createProductionDeploymentRuntime>;
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.owner.shutdown(100);
});

function fixture(
  options: {
    defaultBranch?: string;
    lookupFailure?: boolean;
    dispatch?: "success" | "failure" | "timeout";
    azure?: boolean;
    variableResponse?: string;
  } = {}
) {
  const calls: string[][] = [];
  const directories: string[] = [];
  const azureCalls: Array<{ args: string[]; timeout?: number }> = [];
  let id = 0;
  let runId = 10;
  const generated = generateDeployWorkflow(
    "dev",
    ".radius/app.bicep",
    deploymentTemplates
  );
  delete generated[DEPLOY_AWS_FILE];
  generated[DEPLOY_DISPATCHER_FILE] = stripAwsDispatcherJob(
    stripWorkflowRunTrigger(generated[DEPLOY_DISPATCHER_FILE])
  );
  const http = (value: unknown) => "HTTP/2 200\n\n" + JSON.stringify(value);
  const execute: ProductionDeploymentPorts["execute"] = (
    command,
    args,
    _options,
    callback
  ) => {
    calls.push(args);
    const endpoint = args[1];
    let stdout: string;
    if (options.azure && command === "az") {
      azureCalls.push({ args, timeout: _options.timeout });
      stdout = JSON.stringify(["repo:owner/app:environment:dev"]);
    } else if (args[0] === "repo" && args[1] === "view") {
      stdout = options.defaultBranch ?? "main";
    } else if (
      endpoint === "/repos/owner/app/environments/dev/variables?per_page=100"
    ) {
      stdout = "";
    } else if (
      endpoint === "/repos/owner/app/deployments?per_page=100&environment=dev"
    ) {
      if (options.lookupFailure) {
        callback(new Error("deployment lookup unavailable"), "", "");
        return {};
      }
      stdout = "";
    } else if (
      endpoint === "/repos/owner/app/git/ref/heads/topic" ||
      endpoint === "/repos/owner/app/git/ref/heads/main"
    ) {
      stdout = options.dispatch ? "branch-head" : "";
    } else if (
      endpoint === "/repos/owner/app" &&
      args.includes(".default_branch")
    ) {
      stdout = "main";
    } else if (
      options.dispatch &&
      args[0] === "workflow" &&
      args[1] === "run"
    ) {
      runId++;
      if (options.dispatch === "timeout") {
        callback(
          Object.assign(new Error("timed out"), {
            killed: true,
            signal: "SIGTERM"
          }),
          "",
          ""
        );
        return {};
      }
      stdout = `https://github.com/owner/app/actions/runs/${runId}`;
    } else if (options.dispatch && args[0] === "run" && args[1] === "list") {
      stdout = JSON.stringify([
        { databaseId: runId, createdAt: new Date().toISOString() }
      ]);
    } else if (options.dispatch && args[0] === "run" && args[1] === "view") {
      stdout = "Error: application model is invalid";
    } else if (
      options.dispatch &&
      args[0] === "run" &&
      args[1] === "download"
    ) {
      const directory = args[args.indexOf("--dir") + 1];
      directories.push(directory);
      writeFileSync(
        join(directory, DEPLOY_STATUS_FILES.progress),
        JSON.stringify({
          schemaVersion: 1,
          application: "modeled-app",
          environment: "dev",
          runId,
          sequence: 1,
          resources: []
        })
      );
      writeFileSync(
        join(directory, DEPLOY_STATUS_FILES.graph),
        JSON.stringify({
          resources: [
            { id: "api", name: "api", type: "Radius.Compute/containers" }
          ]
        })
      );
      writeFileSync(join(directory, DEPLOY_STATUS_FILES.controlPlane), "");
      stdout = "";
    } else if (
      options.dispatch &&
      endpoint === "/repos/owner/app/environments/dev/variables/AZURE_CLIENT_ID"
    ) {
      stdout =
        options.variableResponse ??
        JSON.stringify({ value: options.azure ? "client-id" : "" });
    } else if (
      options.azure &&
      endpoint === "/repos/owner/app/environments/dev"
    ) {
      stdout = JSON.stringify({ name: "dev" });
    } else if (options.azure && endpoint === "/repos/owner/app") {
      stdout = JSON.stringify({
        full_name: "owner/app",
        id: 202,
        owner: { id: 101 }
      });
    } else if (
      options.azure &&
      endpoint === "/repos/owner/app/actions/oidc/customization/sub"
    ) {
      callback(
        Object.assign(new Error("HTTP 404"), { code: 1 }),
        "",
        "HTTP 404"
      );
      return {};
    } else if (
      options.dispatch &&
      endpoint.includes("/contents/.radius/app.bicep")
    ) {
      stdout = Buffer.from(
        "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n  name: 'modeled-app'\n}"
      ).toString("base64");
    } else if (
      options.dispatch &&
      endpoint.includes("/contents/") &&
      endpoint.includes(".yml")
    ) {
      const file = endpoint.split("?")[0].split("/").pop() ?? "";
      const content =
        endpoint.startsWith("/repos/owner/app/") ?
          generated[file]
        : deploymentTemplates[file];
      if (!content) throw new Error(`Unexpected workflow ${endpoint}`);
      stdout =
        args.includes(".sha") ? "workflow-sha" : (
          Buffer.from(content).toString("base64")
        );
    } else if (
      options.dispatch &&
      endpoint.includes(`/actions/runs/${runId}/jobs?`)
    ) {
      stdout = http({
        total_count: 1,
        jobs: [
          {
            name: "deploy",
            steps: [
              {
                name: DEPLOY_RAD_COMMANDS_STEP,
                status: "completed",
                conclusion: options.dispatch
              }
            ]
          }
        ]
      });
    } else if (
      options.dispatch &&
      endpoint.endsWith(`/actions/runs/${runId}`)
    ) {
      stdout = http({
        id: runId,
        status: "completed",
        conclusion: options.dispatch
      });
    } else if (options.dispatch && endpoint.includes("/artifacts?")) {
      stdout = http({
        total_count: 1,
        artifacts: [
          {
            id: runId,
            name: "radius-deploy-status-dev-modeled-app",
            workflow_run: { id: runId }
          }
        ]
      });
    } else {
      throw new Error(`Unexpected command: ${JSON.stringify(args)}`);
    }
    callback(null, stdout, "");
    return {};
  };
  const diagnostics = vi.fn();
  const sendRepair = vi.fn();
  const sendNotice = vi.fn();
  const ports: ProductionDeploymentPorts = {
    awsEnabled: false,
    execute,
    readProcessEnv: () => ({}),
    ghCredentialSource: () => "injected",
    redactDiagnostic: (message) => message.replaceAll("private", "[redacted]"),
    reportDiagnostic: diagnostics,
    now: () => Date.now(),
    id: () => `deployment-${++id}`,
    sleep: () => {
      throw new Error("Unexpected wait.");
    },
    delivery: { sendRepair, sendNotice }
  };
  const runtime = createProductionDeploymentRuntime(ports);
  runtimes.push(runtime);
  return {
    runtime,
    ports,
    calls,
    diagnostics,
    directories,
    azureCalls,
    sendRepair,
    sendNotice
  };
}

describe("shared production deployment composition", () => {
  it("constructs without commands or a Canvas dependency and validates host ports", async () => {
    const { runtime, ports, calls } = fixture();
    expect(calls).toEqual([]);
    expect(await runtime.start({})).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
    const incomplete = { ...ports };
    Reflect.deleteProperty(incomplete, "execute");
    expect(() => createProductionDeploymentRuntime(incomplete)).toThrow(
      "execute"
    );
    expect(await runtime.owner.shutdown(0)).toEqual({
      complete: true,
      pending: []
    });
    await expect(
      runtime.start({ repo: "owner/app", environment: "dev" })
    ).rejects.toThrow("shutting down");
  });

  it("owns and observes a preflight failure independently of any panel", async () => {
    const { runtime, calls, diagnostics } = fixture();
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployErrorKind: "branch-not-pushed"
    });
    expect(
      runtime.owner.lookup({ observationId: result.invocation.observationId })
    ).toMatchObject({ kind: "found", invocation: result.invocation });
    expect(
      runtime.owner.lookup({ attemptId: result.invocation.observationId })
    ).toEqual({ kind: "missing" });
    expect(calls.some((args) => args[0] === "workflow")).toBe(false);
    expect(diagnostics).not.toHaveBeenCalled();
    const repeated = await runtime.start({});
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) throw new Error(repeated.error);
    expect(repeated.invocation.target).toEqual(result.invocation.target);
    expect(repeated.invocation.observationId).not.toBe(
      result.invocation.observationId
    );
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
  });

  it("uses the actual default branch and refuses a missing branch result", async () => {
    const { runtime } = fixture();
    const result = await runtime.start({
      repo: "owner/app",
      environment: "dev"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target.branch).toBe("main");
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));

    const missing = fixture({ defaultBranch: "" });
    expect(
      await missing.runtime.start({ repo: "owner/app", environment: "dev" })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("Specify branch explicitly")
    });
  });

  it("fails closed on unavailable deployment evidence without dispatching", async () => {
    const { runtime, calls } = fixture({ lookupFailure: true });
    expect(
      await runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("deployment lookup unavailable")
    });
    expect(calls.some((args) => args[0] === "workflow")).toBe(false);
    expect(runtime.owner.hasActiveWork()).toBe(false);
  });

  it("dispatches and observes success through the same concrete bindings without Canvas", async () => {
    const { runtime, calls, directories, diagnostics } = fixture({
      dispatch: "success"
    });
    const events = vi.fn();
    const unsubscribe = runtime.subscribeDispatch(events);
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state).toMatchObject({
      deployStatus: "complete",
      deployAppName: "modeled-app",
      deployRunId: 11,
      deployedGraph: [
        expect.objectContaining({
          id: "api",
          type: "Radius.Compute/containers"
        })
      ]
    });
    expect(events).toHaveBeenCalledExactlyOnceWith("owner/app");
    expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(1);
    expect(directories.length).toBeGreaterThan(0);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(diagnostics).not.toHaveBeenCalled();
    unsubscribe();
    const repeated = await runtime.start({});
    if (!repeated.ok) throw new Error(repeated.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(repeated.invocation.state.deployStatus).toBe("complete");
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmed failure repair authority separate from observation", async () => {
    const { runtime, sendRepair } = fixture({ dispatch: "failure" });
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state.deployStatus).toBe("failed");
    expect(sendRepair).toHaveBeenCalledTimes(1);
    expect(
      await runtime.start({ attemptId: result.invocation.observationId })
    ).toMatchObject({ ok: false, status: 409 });
    const repaired = await runtime.start({
      attemptId: result.invocation.attemptId
    });
    if (!repaired.ok) throw new Error(repaired.error);
    expect(repaired.invocation.generation).toBeGreaterThan(
      result.invocation.generation
    );
    expect(
      runtime.owner.lookup({ observationId: result.invocation.observationId })
    ).toEqual({ kind: "missing" });
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(repaired.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployRunId: 12
    });
    expect(sendRepair).toHaveBeenCalledTimes(1);
  });

  it("uses the bounded Azure preflight binding before dispatch", async () => {
    const { runtime, azureCalls } = fixture({
      dispatch: "success",
      azure: true
    });
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(azureCalls).toEqual([
      {
        args: [
          "ad",
          "app",
          "federated-credential",
          "list",
          "--id",
          "client-id",
          "--query",
          "[].subject",
          "-o",
          "json"
        ],
        timeout: 15000
      }
    ]);
    expect(result.invocation.state.deployStatus).toBe("complete");
  });

  it("settles supplied graph resources and tolerates incomplete output metadata", async () => {
    const { runtime } = fixture({ dispatch: "success" });
    const result = await runtime.start(
      { repo: "owner/app", branch: "topic", environment: "dev" },
      {
        resources: [
          {
            id: "api",
            name: "api",
            type: "Radius.Compute/containers",
            outputResources: [
              { id: "/subscriptions/sub/resourceGroups/group" },
              {}
            ]
          }
        ]
      }
    );
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state.deployStatus).toBe("complete");
    expect(result.invocation.state.deployingResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "api",
          deployStatus: "success",
          outputResources: [
            expect.objectContaining({
              deployStatus: "success",
              portalUrl: expect.stringContaining("portal.azure.com")
            }),
            expect.objectContaining({ deployStatus: "success" })
          ]
        })
      ])
    );
  });

  it.each(["null", "[]", "42"])(
    "retains an explicit preflight warning for a non-object variable response: %s",
    async (variableResponse) => {
      const { runtime, azureCalls } = fixture({
        dispatch: "success",
        variableResponse
      });
      const result = await runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      });
      if (!result.ok) throw new Error(result.error);
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      expect(result.invocation.state.deployStatus).toBe("complete");
      expect(result.invocation.state.deployLogs).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Could not verify Azure federated credential")
        ])
      );
      expect(azureCalls).toEqual([]);
    }
  );

  it.each([new Error("private observer failed"), "private observer failed"])(
    "reports observer errors without changing accepted execution: %s",
    async (error) => {
      const { runtime, diagnostics } = fixture({ dispatch: "success" });
      const events = vi.fn();
      runtime.subscribeDispatch(() => {
        throw error;
      });
      runtime.subscribeDispatch(events);
      const result = await runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      });
      if (!result.ok) throw new Error(result.error);
      runtime.owner.subscribe(result.invocation, () => {
        throw error;
      });
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      expect(result.invocation.state.deployStatus).toBe("complete");
      expect(events).toHaveBeenCalledExactlyOnceWith("owner/app");
      expect(diagnostics).toHaveBeenCalledWith("[redacted] observer failed");
      expect(diagnostics.mock.calls.flat().join("\n")).not.toContain("private");
    }
  );

  it("does not repeat an ambiguous dispatch or ask an agent to repair it", async () => {
    const { runtime, calls, sendRepair, sendNotice } = fixture({
      dispatch: "timeout"
    });
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployErrorKind: "run-unconfirmed"
    });
    expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(1);
    expect(sendRepair).not.toHaveBeenCalled();
    expect(sendNotice).toHaveBeenCalledTimes(1);
  });
});
