import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
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
import { createDeploymentDeferred } from "../test/support/deployment.js";
import {
  createProductionDeploymentRuntime,
  type ProductionDeploymentPorts
} from "./index.js";
import type { DeploymentGraphRecovery } from "./deployment-monitor.js";

type Runtime = ReturnType<typeof createProductionDeploymentRuntime>;
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.owner.shutdown(100);
  vi.useRealTimers();
});

function fixture(
  options: {
    defaultBranch?: string;
    lookupFailure?: boolean;
    dispatch?: "success" | "failure" | "timeout";
    azure?: boolean;
    variableResponse?: string;
    models?: Readonly<Record<string, string>>;
    conclusions?: Readonly<Record<string, "success" | "failure">>;
    live?: boolean;
  } = {}
) {
  const calls: string[][] = [];
  const directories: string[] = [];
  const azureCalls: Array<{ args: string[]; timeout?: number }> = [];
  let id = 0;
  let runId = 10;
  const running = Boolean(options.live);
  const runEnvironments = new Map<number, string>();
  const runCorrelations = new Map<number, string>();
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
    const requestedRunId = Number(
      endpoint.match(/\/actions\/runs\/(\d+)/)?.[1] ?? runId
    );
    let stdout: string;
    if (options.azure && command === "az") {
      azureCalls.push({ args, timeout: _options.timeout });
      stdout = JSON.stringify(["repo:owner/app:environment:dev"]);
    } else if (args[0] === "repo" && args[1] === "view") {
      stdout = options.defaultBranch ?? "main";
    } else if (
      ["dev", "prod"].some(
        (environment) =>
          endpoint ===
          `/repos/owner/app/environments/${environment}/variables?per_page=100`
      )
    ) {
      stdout = "";
    } else if (
      ["dev", "prod"].some(
        (environment) =>
          endpoint ===
          `/repos/owner/app/deployments?per_page=100&environment=${environment}`
      )
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
      const environment = args
        .find((arg) => arg.startsWith("environment="))
        ?.slice("environment=".length);
      if (!environment) throw new Error("Missing workflow environment");
      runEnvironments.set(runId, environment);
      const correlation = args
        .find((arg) => arg.startsWith("correlation_id="))
        ?.slice("correlation_id=".length);
      if (!correlation) throw new Error("Missing workflow correlation");
      runCorrelations.set(runId, correlation);
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
      stdout = JSON.stringify(
        args.includes("databaseId,createdAt") ?
          [{ databaseId: options.conclusions ? 10 : runId }]
        : [...runCorrelations].map(([databaseId, correlation]) => ({
            databaseId,
            createdAt: new Date().toISOString(),
            displayTitle: `Radius - Deploy ${runEnvironments.get(databaseId)} ${correlation}`
          }))
      );
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
          environment: runEnvironments.get(Number(args[2])),
          runId: Number(args[2]),
          sequence: 1,
          updatedAt: "2026-09-01T00:00:00Z",
          state: running ? "running" : "succeeded",
          resources:
            options.live ?
              [
                {
                  id: "api",
                  name: "api",
                  type: "Radius.Compute/containers",
                  provisioningState: "Succeeded",
                  status: "success"
                }
              ]
            : []
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
      ["dev", "prod"].some(
        (environment) =>
          endpoint ===
          `/repos/owner/app/environments/${environment}/variables/AZURE_CLIENT_ID`
      )
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
      endpoint.includes("/contents/") &&
      endpoint.split("?")[0].endsWith(".bicep")
    ) {
      const path = endpoint.split("/contents/")[1].split("?")[0];
      const source =
        options.models ?
          options.models[path]
        : "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n  name: 'modeled-app'\n}";
      if (source === undefined) {
        callback(
          Object.assign(new Error("HTTP 404"), { code: 1 }),
          "",
          "HTTP 404"
        );
        return {};
      }
      stdout = Buffer.from(source).toString("base64");
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
      endpoint.includes(`/actions/runs/${requestedRunId}/jobs?`)
    ) {
      stdout = http({
        total_count: 1,
        jobs: [
          {
            name: "deploy",
            steps: [
              {
                name: DEPLOY_RAD_COMMANDS_STEP,
                status: running ? "in_progress" : "completed",
                conclusion:
                  running ? null : (
                    (options.conclusions?.[
                      runEnvironments.get(requestedRunId) || ""
                    ] ?? options.dispatch)
                  )
              }
            ]
          }
        ]
      });
    } else if (
      options.dispatch &&
      endpoint.endsWith(`/actions/runs/${requestedRunId}`)
    ) {
      stdout = http({
        id: requestedRunId,
        status: running ? "in_progress" : "completed",
        conclusion:
          running ? null : (
            (options.conclusions?.[runEnvironments.get(requestedRunId) || ""] ??
            options.dispatch)
          )
      });
    } else if (options.dispatch && endpoint.includes("/artifacts?")) {
      stdout = http({
        total_count: 1,
        artifacts: [
          {
            id: requestedRunId,
            name: `radius-deploy-status-${runEnvironments.get(requestedRunId)}-modeled-app`,
            workflow_run: { id: requestedRunId }
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
  it.each(["stderr", "stdout", "stdin", "azure"] as const)(
    "host-redacts unsuccessful %s command diagnostics before state publication",
    async (boundary) => {
      const h = fixture({
        dispatch: "success",
        azure: boundary === "azure",
        ...(boundary === "stdin" ?
          {
            models: {
              ".radius/app.bicep":
                "@secure()\nparam password string\nresource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'modeled-app'\n}"
            }
          }
        : {})
      });
      const execute: ProductionDeploymentPorts["execute"] = (
        command,
        args,
        options,
        callback
      ) => {
        const failing =
          boundary === "azure" ? command === "az"
          : boundary === "stdin" ? args[0] === "secret"
          : args[0] === "workflow";
        if (failing) {
          callback(
            Object.assign(new Error("private diagnostic"), { code: 1 }),
            boundary === "stdout" ? "private diagnostic" : "",
            boundary === "stdout" ? "" : "private diagnostic"
          );
          return {};
        }
        if (boundary === "stdin" && args[1]?.endsWith("/secrets")) {
          callback(null, "", "");
          return {};
        }
        h.ports.execute(command, args, options, callback);
        return {};
      };
      const redactDiagnostic = vi.fn(h.ports.redactDiagnostic);
      const runtime = createProductionDeploymentRuntime({
        ...h.ports,
        execute,
        redactDiagnostic
      });
      runtimes.push(runtime);
      const result = await runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      });
      if (!result.ok) throw new Error(result.error);
      const snapshots: string[] = [];
      runtime.owner.subscribe(result.invocation, ({ state }) =>
        snapshots.push(JSON.stringify(state))
      );
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.join("")).not.toContain("private");
      expect(redactDiagnostic).toHaveBeenCalledWith("private diagnostic");
      if (boundary !== "stdout")
        expect(JSON.stringify(result.invocation.state)).toContain("[redacted]");
      expect(result.invocation.state.deployStatus).toBe(
        boundary === "azure" ? "complete" : "failed"
      );
      expect(
        runtime.owner.lookup({ attemptId: result.invocation.attemptId })
      ).toMatchObject({ kind: "found", invocation: result.invocation });
    }
  );

  it.each(["matched", "repository", "branch", "missing"] as const)(
    "binds local branch-recovery guidance to %s workspace identity",
    async (identity) => {
      const directory = mkdtempSync(join(tmpdir(), "radius-workspace-"));
      mkdirSync(join(directory, ".radius"));
      writeFileSync(join(directory, ".radius", "app.bicep"), "// uncommitted");
      execFileSync("git", ["init", "--quiet", directory]);
      const h = fixture({ dispatch: "success" });
      const execute: ProductionDeploymentPorts["execute"] = (
        command,
        args,
        options,
        callback
      ) => {
        if (args[1] === "/repos/owner/app/git/ref/heads/topic") {
          callback(null, "", "");
          return {};
        }
        h.ports.execute(command, args, options, callback);
        return {};
      };
      const runtime = createProductionDeploymentRuntime({
        ...h.ports,
        execute
      });
      runtimes.push(runtime);
      try {
        const result = await runtime.start(
          { repo: "owner/app", branch: "topic", environment: "dev" },
          identity === "missing" ?
            {}
          : {
              workspace: {
                repo: identity === "repository" ? "other/app" : "OWNER/APP",
                branch: identity === "branch" ? "unrelated" : "topic",
                workspacePath: directory
              }
            }
        );
        if (!result.ok) throw new Error(result.error);
        await vi.waitFor(
          () => expect(runtime.owner.hasActiveWork()).toBe(false),
          { timeout: 4000 }
        );
        expect(result.invocation.state.deployErrorKind).toBe(
          "branch-not-pushed"
        );
        expect(result.invocation.state.deployError).toContain("owner/app");
        if (identity === "matched") {
          expect(result.invocation.state.deployErrorPaths).toContain(".radius");
          expect(result.invocation.state.deployError).toContain("git push");
        } else {
          expect(result.invocation.state.deployErrorPaths).toBe("");
          expect(result.invocation.state.deployError).not.toContain("git push");
          expect(result.invocation.state.deployError).not.toContain("git add");
        }
        expect(h.calls.some((args) => args[0] === "workflow")).toBe(false);
      } finally {
        await runtime.owner.shutdown(100);
        rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50
        });
      }
    }
  );

  it.each(["", " ", "\t"])(
    "refuses explicit empty model %j before production commands",
    async (appFile) => {
      const h = fixture();
      expect(
        await h.runtime.start({
          repo: "owner/app",
          branch: "topic",
          environment: "dev",
          appFile
        })
      ).toMatchObject({ ok: false, status: 400 });
      expect(h.calls).toEqual([]);
    }
  );

  it("drains an issued dispatch without later callbacks after bounded shutdown", async () => {
    const h = fixture({ dispatch: "success" });
    const entered = createDeploymentDeferred<void>();
    const release = createDeploymentDeferred<void>();
    const execute: ProductionDeploymentPorts["execute"] = (
      command,
      args,
      options,
      callback
    ) => {
      h.ports.execute(command, args, options, (error, stdout, stderr) => {
        if (args[0] !== "workflow") {
          callback(error, stdout, stderr);
          return;
        }
        entered.resolve();
        void release.promise.then(() => callback(error, stdout, stderr));
      });
      return {};
    };
    const runtime = createProductionDeploymentRuntime({ ...h.ports, execute });
    runtimes.push(runtime);
    const dispatchListener = vi.fn();
    const stateListener = vi.fn();
    runtime.subscribeDispatch(dispatchListener);
    try {
      const result = await runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      });
      if (!result.ok) throw new Error(result.error);
      runtime.owner.subscribe(result.invocation, stateListener);
      await entered.promise;
      const priorPublications = stateListener.mock.calls.length;
      expect(await runtime.owner.shutdown(0)).toEqual({
        complete: false,
        pending: [result.invocation.observationId]
      });
      expect(runtime.owner.isCurrent(result.invocation)).toBe(true);
      expect(runtime.owner.hasActiveWork()).toBe(true);
      expect(
        runtime.owner.reserve(result.invocation.target, "delete")
      ).toBeNull();
      release.resolve();
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      expect(stateListener).toHaveBeenCalledTimes(priorPublications);
      expect(dispatchListener).not.toHaveBeenCalled();
      expect(h.diagnostics).not.toHaveBeenCalled();
      expect(h.sendRepair).not.toHaveBeenCalled();
      expect(h.sendNotice).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await runtime.owner.shutdown(100);
    }
  });

  it.each(["invalidate", "shutdown"] as const)(
    "stops remaining dispatch callbacks after reentrant %s",
    async (action) => {
      const h = fixture({ dispatch: "success" });
      const lateListener = vi.fn();
      h.runtime.subscribeDispatch(() => {
        if (action === "shutdown") void h.runtime.owner.shutdown(0);
        else {
          const current = h.runtime.owner.lookup();
          if (current.kind !== "found") throw new Error("Missing attempt");
          h.runtime.owner.invalidate(current.invocation);
        }
      });
      h.runtime.subscribeDispatch(lateListener);
      const result = await h.runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      });
      if (!result.ok) throw new Error(result.error);
      await vi.waitFor(() =>
        expect(h.runtime.owner.hasActiveWork()).toBe(false)
      );
      expect(lateListener).not.toHaveBeenCalled();
      if (action === "shutdown") {
        expect(() => h.runtime.subscribeDispatch(vi.fn())).toThrow(
          "shutting down"
        );
        expect(() =>
          h.runtime.owner.subscribe(result.invocation, vi.fn())
        ).toThrow("shutting down");
      }
      expect(h.diagnostics).not.toHaveBeenCalled();
    }
  );

  it("recovers a fresh invocation's graph and applies artifact progress before workflow completion", async () => {
    const h = fixture({
      dispatch: "success",
      live: true,
      models: {
        "models/custom.bicep":
          "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'modeled-app'\n}"
      }
    });
    const recover = vi.fn<DeploymentGraphRecovery["recover"]>(async () => [
      {
        id: "api",
        name: "api",
        type: "Radius.Compute/containers",
        deployStatus: "pending",
        outputResources: [
          {
            id: "/subscriptions/fixture/resourceGroups/dev/providers/Microsoft.App/containerApps/api",
            deployStatus: "pending"
          }
        ]
      }
    ]);
    try {
      const result = await h.runtime.start(
        {
          repo: "owner/app",
          branch: "topic",
          environment: "dev",
          appFile: "models/custom.bicep"
        },
        { resources: [], plannedGraph: { recover } }
      );
      if (!result.ok) throw new Error(result.error);
      const progressSnapshots: string[] = [];
      h.runtime.owner.subscribe(result.invocation, ({ state }) => {
        const output = state.deployingResources?.[0].outputResources?.[0];
        if (output?.deployStatus === "success")
          progressSnapshots.push(output.portalUrl ?? "");
      });
      await vi.waitFor(() =>
        expect(
          result.invocation.state.deployingResources?.[0].deployStatus
        ).toBe("success")
      );
      expect(result.invocation.state.deployStatus).toBe("in_progress");
      expect(progressSnapshots).toEqual(
        expect.arrayContaining([expect.stringContaining("portal.azure.com/")])
      );
      expect(h.runtime.owner.hasActiveWork()).toBe(true);
      expect(recover).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          appFile: "models/custom.bicep",
          repo: "owner/app",
          branch: "topic"
        })
      );
      expect(
        h.calls.some((args) => args[0] === "run" && args[1] === "download")
      ).toBe(true);
    } finally {
      await h.runtime.owner.shutdown(1000);
      expect(h.runtime.owner.hasActiveWork()).toBe(false);
    }
  });

  it.each(["radius-environment.bicep", "models/RADIUS-RECIPE-PACK.bicep"])(
    "rejects the reserved model %s before any production command",
    async (appFile) => {
      const h = fixture();
      const result = await h.runtime.start({
        repo: "owner/app",
        branch: "feature",
        environment: "dev",
        provider: "azure",
        appFile
      });
      expect(result).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringContaining("reserved")
      });
      expect(h.calls).toEqual([]);
    }
  );

  it("keeps per-run model inputs separate during concurrent environment deployments", async () => {
    const model =
      "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'modeled-app'\n}";
    const h = fixture({
      dispatch: "success",
      conclusions: { dev: "success", prod: "failure" },
      models: {
        "models/dev.bicep": model,
        "models/prod.bicep": model
      }
    });
    const results = await Promise.all(
      ["dev", "prod"].map((environment) =>
        h.runtime.start({
          repo: "owner/app",
          branch: "topic",
          environment,
          appFile: `models/${environment}.bicep`
        })
      )
    );
    expect(results.every((result) => result.ok)).toBe(true);
    await vi.waitFor(() => expect(h.runtime.owner.hasActiveWork()).toBe(false));
    const runs = h.calls.filter((args) => args[0] === "workflow");
    expect(runs).toHaveLength(2);
    const invocations = results.map((result) => {
      if (!result.ok) throw new Error(result.error);
      return result.invocation;
    });
    expect(
      new Set(invocations.map((invocation) => invocation.state.deployRunId))
        .size
    ).toBe(2);
    expect(
      invocations.map((invocation) => invocation.state.deployStatus)
    ).toEqual(["complete", "failed"]);
    expect(h.sendRepair).toHaveBeenCalledTimes(1);
    expect(h.sendRepair.mock.calls[0][0]).toMatchObject({
      attemptId: invocations[1].attemptId,
      appFile: "models/prod.bicep"
    });
    for (const environment of ["dev", "prod"]) {
      const run = runs.find((args) =>
        args.includes(`environment=${environment}`)
      );
      expect(run).toContain(`app_file=models/${environment}.bicep`);
      expect(run?.find((arg) => arg.startsWith("rad_commands="))).toContain(
        `deploy models/${environment}.bicep`
      );
    }
  });

  it("keeps an unidentifiable custom application unknown through status polling", async () => {
    const h = fixture({
      dispatch: "success",
      models: {
        "models/unknown.bicep":
          "param appName string\nresource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: appName\n}",
        ".radius/app.bicep":
          "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'wrong-app'\n}"
      }
    });
    const result = await h.runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev",
      appFile: "models/unknown.bicep"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(h.runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state.deployAppName).toBe("");
    expect(
      h.calls.some((args) => args[1]?.includes("/contents/.radius/app.bicep"))
    ).toBe(false);
  });

  it.each(["models/custom.bicep", "app.bicep"])(
    "dispatches only the admitted %s even when a different default exists",
    async (appFile) => {
      const h = fixture({
        dispatch: "success",
        models: {
          ".radius/app.bicep":
            "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'wrong-app'\n}",
          [appFile]:
            "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'modeled-app'\n}"
        }
      });
      const result = await h.runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev",
        appFile
      });
      if (!result.ok) throw new Error(result.error);
      await vi.waitFor(() =>
        expect(h.calls.some((args) => args[0] === "workflow")).toBe(true)
      );
      expect(result.invocation.state.deployAppName).toBe("modeled-app");
      const dispatch = h.calls.find((args) => args[0] === "workflow");
      expect(dispatch).toContain(`app_file=${appFile}`);
      expect(
        dispatch?.find((arg) => arg.startsWith("rad_commands="))
      ).toContain(`deploy ${appFile}`);
      expect(
        h.calls.some((args) => args[1]?.includes("/contents/.radius/app.bicep"))
      ).toBe(false);
      await vi.waitFor(() =>
        expect(h.runtime.owner.hasActiveWork()).toBe(false)
      );
    }
  );

  it("refuses a missing admitted model rather than deploying the default", async () => {
    const h = fixture({
      dispatch: "success",
      models: {
        ".radius/app.bicep":
          "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'wrong-app'\n}"
      }
    });
    const result = await h.runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev",
      appFile: "models/missing.bicep"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(h.runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployErrorKind: "model-preflight-failed"
    });
    expect(
      h.calls.some((args) => args[0] === "workflow" || args[0] === "secret")
    ).toBe(false);
    expect(h.sendRepair).not.toHaveBeenCalled();
    expect(h.sendNotice).not.toHaveBeenCalled();
  });

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

  it("shares admission exclusion and invalidates a live consumer without releasing issued work", async () => {
    const { runtime, calls, directories, sendRepair, sendNotice } = fixture({
      dispatch: "success",
      live: true
    });
    const target = {
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    };
    const started = await runtime.start(target);
    if (!started.ok) throw new Error(started.error);
    await vi.waitFor(() =>
      expect(started.invocation.state.deployRunId).toBe(11)
    );
    const detached = vi.fn();
    const unsubscribe = runtime.owner.subscribe(started.invocation, detached);
    unsubscribe();
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 409
    });
    const differentlyCased = { repo: "OWNER/APP", environment: "DEV" };
    expect(runtime.owner.reserve(differentlyCased, "delete")).toBeNull();
    expect(runtime.owner.invalidate(started.invocation)).toBe(true);
    expect(
      runtime.owner.lookup({ observationId: started.invocation.observationId })
    ).toEqual({ kind: "missing" });
    expect(
      runtime.owner.lookup({ attemptId: started.invocation.attemptId })
    ).toEqual({ kind: "missing" });
    expect(runtime.owner.reserve(differentlyCased, "abandon")).toBeNull();
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    const reservation = runtime.owner.reserve(differentlyCased, "delete");
    expect(reservation).not.toBeNull();
    if (reservation) runtime.owner.release(reservation);
    expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(1);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(sendRepair).not.toHaveBeenCalled();
    expect(sendNotice).not.toHaveBeenCalled();
    expect(detached).not.toHaveBeenCalled();
    expect(await runtime.owner.shutdown(100)).toEqual({
      complete: true,
      pending: []
    });
  });

  it("retries host delivery without redispatching the failed workflow", async () => {
    vi.useFakeTimers();
    const h = fixture({ dispatch: "failure" });
    h.sendRepair.mockRejectedValueOnce(new Error("delivery unavailable"));
    const started = await h.runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev"
    });
    if (!started.ok) throw new Error(started.error);
    await vi.waitFor(() =>
      expect(started.invocation.state.deployHandoffState).toBe("retryable")
    );
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(h.runtime.owner.hasActiveWork()).toBe(false));
    expect(h.sendRepair).toHaveBeenCalledTimes(2);
    expect(h.sendRepair.mock.calls[0][0]).toEqual(
      h.sendRepair.mock.calls[1][0]
    );
    expect(h.sendRepair.mock.calls[1][0]).toMatchObject({
      attemptId: started.invocation.attemptId
    });
    expect(started.invocation.state.deployHandoffState).toBe("delivered");
    expect(h.calls.filter((args) => args[0] === "workflow")).toHaveLength(1);
    expect(h.directories.every((directory) => !existsSync(directory))).toBe(
      true
    );
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
      dispatch: "success",
      models: {
        "models/repeat.bicep":
          "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'modeled-app'\n}"
      }
    });
    const events = vi.fn();
    const unsubscribe = runtime.subscribeDispatch(events);
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev",
      appFile: "models/repeat.bicep"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(diagnostics).not.toHaveBeenCalled();
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
    expect(repeated.invocation.target.appFile).toBe("models/repeat.bicep");
    expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(2);
    expect(
      calls
        .filter((args) => args[0] === "workflow")
        .every((args) => args.includes("app_file=models/repeat.bicep"))
    ).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmed failure repair authority separate from observation", async () => {
    const { runtime, sendRepair, calls } = fixture({
      dispatch: "failure",
      models: {
        "models/repair.bicep":
          "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'modeled-app'\n}"
      }
    });
    const result = await runtime.start({
      repo: "owner/app",
      branch: "topic",
      environment: "dev",
      appFile: "models/repair.bicep"
    });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
    expect(result.invocation.state.deployStatus).toBe("failed");
    expect(sendRepair).toHaveBeenCalledTimes(1);
    expect(sendRepair).toHaveBeenCalledWith(
      expect.objectContaining({ appFile: "models/repair.bicep" })
    );
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
    expect(repaired.invocation.target.appFile).toBe("models/repair.bicep");
    expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(2);
    expect(
      calls
        .filter((args) => args[0] === "workflow")
        .every((args) => args.includes("app_file=models/repair.bicep"))
    ).toBe(true);
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

  it.each([
    ["sync", new Error("private observer failed")],
    ["sync", "private observer failed"],
    ["async", new Error("private observer failed")],
    ["async", "private observer failed"]
  ] as const)(
    "reports %s observer errors without changing accepted execution: %s",
    async (mode, error) => {
      const { runtime, diagnostics, calls } = fixture({ dispatch: "success" });
      const events = vi.fn(() => true);
      const observer = vi.fn(() => {
        if (mode === "async") return Promise.reject(error);
        throw error;
      });
      runtime.subscribeDispatch(observer);
      runtime.subscribeDispatch(events);
      const result = await runtime.start({
        repo: "owner/app",
        branch: "topic",
        environment: "dev"
      });
      if (!result.ok) throw new Error(result.error);
      runtime.owner.subscribe(result.invocation, observer);
      const stateEvents = vi.fn();
      runtime.owner.subscribe(result.invocation, stateEvents);
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      await vi.waitFor(() =>
        expect(diagnostics).toHaveBeenCalledTimes(observer.mock.calls.length)
      );
      await nextTurn();
      expect(result.invocation.state.deployStatus).toBe("complete");
      expect(events).toHaveBeenCalledExactlyOnceWith("owner/app");
      expect(stateEvents).toHaveBeenCalled();
      expect(diagnostics).toHaveBeenCalledTimes(observer.mock.calls.length);
      expect(diagnostics).toHaveBeenCalledWith("[redacted] observer failed");
      expect(diagnostics.mock.calls.flat().join("\n")).not.toContain("private");
      expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(1);
    }
  );

  it.each(["resolve", "reject"] as const)(
    "does not await observers that %s after deployment and shutdown",
    async (outcome) => {
      const { runtime, diagnostics, calls } = fixture({ dispatch: "success" });
      const dispatchDelivery = createDeploymentDeferred<void>();
      const stateDelivery = createDeploymentDeferred<void>();
      const dispatchObserver = vi.fn(() => dispatchDelivery.promise);
      const stateObserver = vi.fn(() => stateDelivery.promise);
      runtime.subscribeDispatch(dispatchObserver);
      try {
        const result = await runtime.start({
          repo: "owner/app",
          branch: "topic",
          environment: "dev"
        });
        if (!result.ok) throw new Error(result.error);
        runtime.owner.subscribe(result.invocation, stateObserver);
        await vi.waitFor(() =>
          expect(runtime.owner.hasActiveWork()).toBe(false)
        );
        expect(dispatchObserver).toHaveBeenCalledExactlyOnceWith("owner/app");
        expect(stateObserver).toHaveBeenCalled();
        expect(result.invocation.state.deployStatus).toBe("complete");
        const deletion = runtime.owner.reserve(
          result.invocation.target,
          "delete"
        );
        expect(deletion).not.toBeNull();
        if (deletion) runtime.owner.release(deletion);
        expect(await runtime.owner.shutdown(0)).toEqual({
          complete: true,
          pending: []
        });
        expect(diagnostics).not.toHaveBeenCalled();
        if (outcome === "reject") {
          dispatchDelivery.reject(
            new Error("private dispatch observer failed")
          );
          stateDelivery.reject(new Error("private state observer failed"));
        } else {
          dispatchDelivery.resolve();
          stateDelivery.resolve();
        }
        await nextTurn();
        if (outcome === "reject") {
          expect(diagnostics.mock.calls.map(([message]) => message)).toEqual([
            "[redacted] dispatch observer failed",
            ...stateObserver.mock.calls.map(
              () => "[redacted] state observer failed"
            )
          ]);
        } else {
          expect(diagnostics).not.toHaveBeenCalled();
        }
        expect(result.invocation.state.deployStatus).toBe("complete");
        expect(calls.filter((args) => args[0] === "workflow")).toHaveLength(1);
      } finally {
        dispatchDelivery.resolve();
        stateDelivery.resolve();
        await nextTurn();
      }
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
