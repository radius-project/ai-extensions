import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createDeploymentsRoutes } from "../../../src/server/routes/deployments.js";
import { isValidRepoSlug } from "../../../src/azure-oidc.js";
import { createDeploymentAbandonmentService } from "../../../src/server/services/deployment-abandonment.js";
import { createDeployRequestService } from "../../../src/server/services/deploy-request.js";
import { createDeployDispatchService } from "../../../src/server/services/deploy-dispatch.js";
import { resolveEnvironmentDeployment } from "../../../src/server/services/deployment-resolver.js";
import {
  createDeployMonitorService,
  type DeployMonitorService
} from "../../../src/server/services/deploy-monitor.js";
import {
  activeDeploymentMutation,
  beginDeployAttempt,
  DEPLOY_RUN_UNCONFIRMED_KIND,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation,
  releaseDeploymentMutation,
  reserveDeploymentMutation,
  resolveDeploymentEnvironment,
  resolveDeployRepairLoop
} from "../../../src/server.js";
import { DEPLOY_REPAIR_ATTEMPT_CAP } from "../../../src/runtime/hooks.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type {
  DeployListCacheEntry,
  DeploymentRow
} from "../../../src/server/routes/deployments.js";
import type { DeployMonitorRequest } from "../../../src/server/services/deploy-monitor.js";
import type { CanvasState } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface Harness {
  state: CanvasState;
  cache: Map<string, DeployListCacheEntry>;
  environments: string[];
  resets: unknown[];
  dispatches: string[][];
  workflowSyncs: unknown[][];
  ghApiCalls: string[][];
  setEntryMissing(missing: boolean): void;
  setDeploymentStatus(status: string): void;
  setDeploymentResolver(
    resolver: (
      repo: string,
      environment: string,
      application: string
    ) => Promise<DeploymentRow | null>
  ): void;
  // The credential context the workflow-scope fallback reads, plus the gh
  // results the dispatch sees. Mutable so a scenario can model an injected
  // session token and an explicitly selected account.
  processEnv: NodeJS.ProcessEnv;
  timeOutDispatch(): void;
  failDispatchWith(stderr: string): void;
}

function row(environment: string, status = "deployed"): DeploymentRow {
  return {
    app: "todo-app",
    environment,
    provider: "azure",
    status,
    deploymentId: `dep-${environment}`,
    runUrl: `https://example.test/${environment}`
  };
}

function start(): Harness {
  const state: CanvasState = {};
  const cache = new Map<string, DeployListCacheEntry>();
  const environments: string[] = [];
  const resets: unknown[] = [];
  const dispatches: string[][] = [];
  const workflowSyncs: unknown[][] = [];
  const ghApiCalls: string[][] = [];
  const processEnv: NodeJS.ProcessEnv = {};
  let entryMissing = false;
  let deploymentStatus = "deployed";
  let dispatchTimedOut = false;
  let dispatchStderr = "";
  let deploymentResolver: (
    repo: string,
    environment: string,
    application: string
  ) => Promise<DeploymentRow | null> = (_repo, environment, _application) =>
    Promise.resolve(row(environment, deploymentStatus));
  const readInstanceState = (): CanvasState | undefined =>
    entryMissing ? undefined : state;
  const resolveEnvDeployment = (
    repo: string,
    environment: string,
    application: string
  ): Promise<DeploymentRow | null> =>
    deploymentResolver(repo, environment, application);
  const ghOrThrow = (args: string[]): Promise<string> => {
    ghApiCalls.push(args);
    return Promise.resolve(
      args.includes("--method") ? "" : environments.join("\n")
    );
  };
  const abandonment = createDeploymentAbandonmentService({
    isValidRepoSlug,
    readInstanceState: () => readInstanceState(),
    activeDeploymentMutation,
    localDeploymentBlocksMutation,
    reserveDeploymentMutation,
    releaseDeploymentMutation,
    deploymentStatusBlocksMutation,
    resolveEnvDeployment,
    ghOrThrow,
    invalidateDeployListCache: (repo) => {
      cache.delete(repo);
    }
  });

  const routes = createTestRouteTable(
    createDeploymentsRoutes({
      isValidRepoSlug,
      readInstanceEntry: () => (entryMissing ? undefined : { state }),
      triggerDeployRepairHandoff: () => false,
      triggerDeployFailureNotice: () => false,
      deployHandoffStatus: (current) => ({
        state: current.deployHandoffState || "idle",
        attempts: current.deployHandoffAttempts || 0,
        maxAttempts: 3,
        pending: false
      }),
      resolveRepoAppName: (_repo, branch) =>
        Promise.resolve(`todo-app@${branch}`),
      resolveEnvDeployment,
      ghOrThrow,
      resetDeploymentViewState: (_target, attemptId) => {
        resets.push(attemptId);
      },
      deployListCache: cache,
      deployListTtlMs: 15000,
      // The destructive route's collaborators, wired to a permissive happy path
      // so the HIT exercises real HTTP rather than re-proving refusal logic the
      // unit tests already cover.
      activeDeploymentMutation,
      reserveDeploymentMutation,
      releaseDeploymentMutation,
      deploymentStatusBlocksMutation,
      localDeploymentBlocksMutation,
      ensureWorkflowsCurrent: (...args) => {
        workflowSyncs.push(args);
        return Promise.resolve({ created: [], failed: [] });
      },
      findWorkflowRun: () => Promise.resolve(7),
      runGh: (args) => {
        dispatches.push(args);
        return Promise.resolve(
          dispatchStderr ?
            {
              code: 1,
              stdout: "",
              stderr: dispatchStderr,
              timedOut: dispatchTimedOut
            }
          : { code: 0, stdout: "", stderr: "" }
        );
      },
      readProcessEnv: () => processEnv,
      setTimer: () => ({}),
      // The deploy route has its own harness below, which drives the real
      // admission service. Reaching it from this one is a wiring bug.
      deployRequest: {
        deploy: () => {
          throw new Error("unexpected deploy dispatch from the read harness");
        }
      },
      abandonment
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation: () => true,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    state,
    cache,
    environments,
    resets,
    dispatches,
    workflowSyncs,
    ghApiCalls,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    setDeploymentStatus(status) {
      deploymentStatus = status;
    },
    setDeploymentResolver(resolver) {
      deploymentResolver = resolver;
    },
    processEnv,
    timeOutDispatch() {
      dispatchTimedOut = true;
    },
    failDispatchWith(stderr) {
      dispatchStderr = stderr;
    }
  };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("deployments routes real-loopback HIT (RF-05)", () => {
  it("serves the deploy status poll and its incremental log form over a real socket", async () => {
    const harness = start();
    harness.state.deployLogs = ["a", "b", "c"];
    harness.state.deployLogBase = 10;
    harness.state.deployStatus = "in_progress";
    const entry = await container!.getOrCreate("panel-a");

    const full = await fetch(`${entry.baseUrl}/api/deploy-status`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("application/json");
    const fullBody = (await full.json()) as Record<string, unknown>;
    expect(fullBody.logs).toEqual(["a", "b", "c"]);
    expect(fullBody.logTotal).toBe(13);
    expect(fullBody.active).toBe(true);
    expect(fullBody).not.toHaveProperty("logsNew");

    const since = await fetch(`${entry.baseUrl}/api/deploy-status?since=11`);
    const sinceBody = (await since.json()) as Record<string, unknown>;
    expect(sinceBody.logsNew).toEqual(["b", "c"]);
    expect(sinceBody).not.toHaveProperty("logs");
  });

  it("serves the ambient deploy notification without the poll's payload or side effects", async () => {
    const harness = start();
    harness.state.deployAttempt = {
      id: "attempt-3",
      targetRepo: "octo/todolist",
      environment: "dev"
    };
    harness.state.deployStatus = "failed";
    harness.state.deployRunId = 77;
    harness.state.deployGeneration = 6;
    harness.state.deployAppName = "todolist";
    harness.state.deployEnvName = "dev";
    harness.state.deployError = "Bicep template failed to compile";
    harness.state.deployRunUrl =
      "https://github.com/octo/todolist/actions/runs/3";
    harness.state.deployFinishedAt = 1700;
    harness.state.deployLogs = ["a", "b", "c"];
    harness.state.deployingResources = [
      { id: "db", name: "db", type: "Radius.Data/x" }
    ];
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy-notification`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The chip polls this from every page, so the resource list and the log
    // buffer that `/api/deploy-status` carries are deliberately absent.
    expect(await response.json()).toEqual({
      attemptId: "attempt-3",
      generation: 6,
      runId: "77",
      status: "failed",
      application: "todolist",
      environment: "dev",
      error: "Bicep template failed to compile",
      runUrl: "https://github.com/octo/todolist/actions/runs/3",
      repairing: false,
      finishedAt: 1700
    });
  });

  it("answers the deploy notification defaults when the instance has no entry", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy-notification`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attemptId: "",
      generation: 0,
      runId: "",
      status: "pending",
      application: "",
      environment: "",
      error: "",
      runUrl: "",
      repairing: false,
      finishedAt: 0
    });
  });

  it("answers the applications listing with no-store caching headers", async () => {
    const harness = start();
    harness.state.contextBranch = "feature/x";
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/list-applications?repo=octo/todolist`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      '{"applications":[{"name":"todo-app@feature/x"}]}'
    );

    const noRepo = await fetch(`${entry.baseUrl}/api/list-applications`);
    expect(noRepo.status).toBe(200);
    expect(await noRepo.text()).toBe('{"applications":[]}');
  });

  it("caches the deployments listing and lets ?fresh=1 bypass the cache", async () => {
    const harness = start();
    harness.environments.push("dev");
    const entry = await container!.getOrCreate("panel-a");

    const first = await fetch(
      `${entry.baseUrl}/api/list-deployments?repo=octo/todolist`
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ deployments: [row("dev")] });
    expect(harness.cache.has("octo/todolist")).toBe(true);

    // Poison the cache entry: a second plain request must serve it verbatim,
    // proving the cache is read rather than recomputed.
    harness.cache.set("octo/todolist", {
      at: Date.now(),
      payload: { deployments: [row("cached")] }
    });
    const cached = await fetch(
      `${entry.baseUrl}/api/list-deployments?repo=octo/todolist`
    );
    expect(await cached.json()).toEqual({ deployments: [row("cached")] });

    const fresh = await fetch(
      `${entry.baseUrl}/api/list-deployments?repo=octo/todolist&fresh=1`
    );
    expect(await fresh.json()).toEqual({ deployments: [row("dev")] });
  });

  it("resets the deploy view for the requested attempt and rejects a malformed body", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const reset = await post(
      entry.baseUrl,
      "/api/deploy-reset",
      '{"attemptId":"attempt-1"}'
    );
    expect(reset.status).toBe(200);
    expect(await reset.text()).toBe('{"ok":true}');
    expect(harness.resets).toEqual(["attempt-1"]);

    // The declared body policy is `none` and nothing in the dispatcher parses
    // the body, so an absent body is the handler's own problem — and it treats
    // it as an unconditional reset rather than an error.
    const empty = await post(entry.baseUrl, "/api/deploy-reset", "");
    expect(empty.status).toBe(200);
    expect(harness.resets).toEqual(["attempt-1", undefined]);

    const malformed = await post(
      entry.baseUrl,
      "/api/deploy-reset",
      "not json"
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toBe("application/json");
    expect(harness.resets).toHaveLength(2);
  });

  it("still answers the reset when the instance entry is gone", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(entry.baseUrl, "/api/deploy-reset", "{}");
    expect(response.status).toBe(200);
    expect(harness.resets).toEqual([]);
  });

  it("dispatches the delete workflow and evicts the cached listing over a real socket", async () => {
    const harness = start();
    harness.environments.push("dev");
    const entry = await container!.getOrCreate("panel-a");

    // Populate the cache through the reader, so the eviction is observed on the
    // same map the listing route reads from.
    await fetch(`${entry.baseUrl}/api/list-deployments?repo=octo/todo`);
    expect(harness.cache.has("octo/todo")).toBe(true);

    const response = await post(
      entry.baseUrl,
      "/api/delete-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app"
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      success: true,
      runUrl: "https://github.com/octo/todo/actions/runs/7"
    });
    expect(harness.dispatches).toEqual([
      [
        "workflow",
        "run",
        "delete-application.yml",
        "-f",
        "environment=dev",
        "-f",
        "application=todo-app",
        "--repo",
        "octo/todo"
      ]
    ]);
    // The within-slice invalidation: the reader and the invalidator now live in
    // the same module, so this is proven rather than assumed.
    expect(harness.cache.has("octo/todo")).toBe(false);
  });

  it("does not re-dispatch a delete whose first attempt timed out", async () => {
    // End to end over a real socket: a timed-out dispatch may already have been
    // accepted by GitHub, so the scope failure must surface instead of starting
    // a second delete run under the machine-wide account.
    const harness = start();
    harness.environments.push("dev");
    harness.processEnv.GH_TOKEN = "injected";
    harness.timeOutDispatch();
    harness.failDispatchWith(
      "HTTP 403: refusing to allow an OAuth App to dispatch without `workflow` scope"
    );
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/delete-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app"
      })
    );

    expect(response.status).toBe(400);
    expect(harness.dispatches).toHaveLength(1);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('missing the "workflow" scope');
  });

  it("refuses an incomplete delete over a real socket", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/delete-deployment",
      JSON.stringify({ repo: "octo/todo" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A valid repo, environment, and application are required."
    });
  });

  it("stops tracking a failed teardown without synchronizing or dispatching a workflow", async () => {
    const harness = start();
    harness.setDeploymentStatus("delete-failed");
    harness.cache.set("octo/todo", { at: Date.now(), payload: {} });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "abandoned" });
    expect(harness.workflowSyncs).toEqual([]);
    expect(harness.dispatches).toEqual([]);
    expect(harness.ghApiCalls).toContainEqual([
      "api",
      "--method",
      "POST",
      "/repos/octo/todo/deployments/dep-dev/statuses",
      "-f",
      "state=inactive",
      "-f",
      "description=Tracking abandoned in Radius Canvas; cloud resources were not deleted.",
      "-f",
      "log_url=https://example.test/dev"
    ]);
    expect(harness.cache.has("octo/todo")).toBe(false);
  });

  it("rejects malformed and non-failed abandonment over a real socket", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const malformed = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({
        repo: "not-a-repo",
        environment: "dev",
        application: "todo-app"
      })
    );
    expect(malformed.status).toBe(400);

    harness.setDeploymentStatus("success");
    const successful = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app"
      })
    );
    expect(successful.status).toBe(409);
    expect(await successful.json()).toEqual({
      error: "Only a failed teardown can be removed from tracking."
    });
    expect(harness.workflowSyncs).toEqual([]);
    expect(harness.dispatches).toEqual([]);
  });

  it("fails closed over a real socket when the newest deployment cannot be identified", async () => {
    const harness = start();
    const resolverCalls: string[][] = [];
    harness.setDeploymentResolver((repo, environment, application) =>
      resolveEnvironmentDeployment(repo, environment, application, {
        ghOrThrow: (args) => {
          resolverCalls.push(args);
          const path = args[1] ?? "";
          if (path.includes("/variables?")) return Promise.resolve("");
          if (path.includes("/deployments?")) {
            return Promise.resolve("new-deployment\nold-deployment");
          }
          if (
            path.includes("/deployments/new-deployment/statuses?per_page=1")
          ) {
            return Promise.resolve("\t\t");
          }
          if (
            path.includes("/deployments/new-deployment/statuses?per_page=100")
          ) {
            return Promise.resolve("");
          }
          if (
            path.includes("/deployments/old-deployment/statuses?per_page=1")
          ) {
            return Promise.resolve(
              "failure\thttps://github.com/octo/todo/actions/runs/20\t"
            );
          }
          if (path.includes("/actions/runs/20")) {
            return Promise.resolve(
              ".github/workflows/run-rad-commands.yml\tcompleted\tfailure"
            );
          }
          return Promise.reject(new Error(`unexpected path: ${path}`));
        },
        deployWorkflowFile: "run-rad-commands.yml",
        deleteWorkflowFile: "delete-application.yml",
        maxParallelRecords: 10
      })
    );
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app"
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Could not verify the current deployment state. Check your GitHub connection and try again."
    });
    expect(resolverCalls).toContainEqual([
      "api",
      "/repos/octo/todo/deployments/new-deployment/statuses?per_page=100",
      "--jq",
      expect.any(String)
    ]);
    expect(harness.ghApiCalls).not.toContainEqual(
      expect.arrayContaining(["--method", "POST"])
    );
    expect(harness.state.deploymentMutation).toBeUndefined();
  });

  it("stops tracking a failed delete without falling back to the older deployment", async () => {
    const harness = start();
    harness.setDeploymentResolver((repo, environment, application) =>
      resolveEnvironmentDeployment(repo, environment, application, {
        ghOrThrow: (args) => {
          const path = args[1] ?? "";
          if (path.includes("/variables?")) return Promise.resolve("");
          if (path.includes("/deployments?")) {
            return Promise.resolve("failed-delete\nfailed-deploy");
          }
          if (path.includes("/deployments/failed-delete/statuses?per_page=1")) {
            return Promise.resolve(
              "inactive\thttps://github.com/octo/todo/actions/runs/30\t"
            );
          }
          if (path.includes("/deployments/failed-deploy/statuses?per_page=1")) {
            return Promise.resolve(
              "failure\thttps://github.com/octo/todo/actions/runs/20\t"
            );
          }
          if (path.includes("/actions/runs/30")) {
            return Promise.resolve(
              ".github/workflows/delete-application.yml\tcompleted\tfailure"
            );
          }
          if (path.includes("/actions/runs/20")) {
            return Promise.resolve(
              ".github/workflows/run-rad-commands.yml\tcompleted\tfailure"
            );
          }
          return Promise.reject(new Error(`unexpected path: ${path}`));
        },
        deployWorkflowFile: "run-rad-commands.yml",
        deleteWorkflowFile: "delete-application.yml",
        maxParallelRecords: 10
      })
    );
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "abandoned" });
    expect(harness.ghApiCalls).toContainEqual(
      expect.arrayContaining([
        "--method",
        "POST",
        "/repos/octo/todo/deployments/failed-delete/statuses"
      ])
    );
    expect(harness.workflowSyncs).toEqual([]);
    expect(harness.dispatches).toEqual([]);
    expect(harness.state.deploymentMutation).toBeUndefined();
  });

  it("delegates methods the typed declarations do not claim", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    // The three listings are declared GET-only and the two POSTs POST-only, so
    // the opposite verb on the same path must reach unmatched routing rather
    // than being swallowed by a declaration.
    for (const path of [
      "/api/deploy-status",
      "/api/list-applications",
      "/api/list-deployments"
    ]) {
      const posted = await post(entry.baseUrl, path, "");
      expect(posted.status, path).toBe(404);
    }
    for (const path of [
      "/api/deploy-reset",
      "/api/delete-deployment",
      "/api/abandon-deployment"
    ]) {
      const got = await fetch(`${entry.baseUrl}${path}`);
      expect(got.status, path).toBe(404);
    }
  });
});

// ── POST /api/deploy over a real loopback socket ─────────────────────────────
// Drives the real typed request handler, the real route table, and the real
// admission service, with the real repair-loop, reservation and attempt
// helpers from `server.ts`. Only the outside world is faked: the background
// monitor, the persisted GitHub deployment lookup, and the default-branch
// subprocess. Nothing here reaches the network, a CLI, or a cloud.

interface DeployHarness {
  monitorCalls: DeployMonitorRequest[];
  branchLookups: string[][];
  handoffs: string[];
  stateOf(instanceId: string): CanvasState;
  settleMonitor(error?: Error): Promise<void>;
  setPersistedDeployment(row: DeploymentRow | null): void;
  failPersistedLookup(failure: boolean): void;
}

function startDeploy(monitorOverride?: DeployMonitorService): DeployHarness {
  const monitorCalls: DeployMonitorRequest[] = [];
  const branchLookups: string[][] = [];
  const handoffs: string[] = [];
  let releaseMonitor: ((error?: Error) => void) | undefined;
  let monitorSettled: Promise<void> | undefined;
  let persisted: DeploymentRow | null = null;
  let persistedFails = false;

  const deployRequest = createDeployRequestService({
    readInstanceEntry: (instanceId) => container?.instances.get(instanceId),
    resolveDeployRepairLoop,
    resolveDeploymentEnvironment,
    activeDeploymentMutation: (state) => activeDeploymentMutation(state),
    localDeploymentBlocksMutation: (state) =>
      localDeploymentBlocksMutation(state),
    reserveDeploymentMutation: (state, reservation) =>
      reserveDeploymentMutation(state, reservation),
    releaseDeploymentMutation,
    deploymentStatusBlocksMutation,
    resolveEnvDeployment: () =>
      persistedFails ?
        Promise.reject(new Error("gh unreachable"))
      : Promise.resolve(persisted),
    runCommand: (_command, args) => {
      branchLookups.push(args);
      return Promise.resolve("release/7\n");
    },
    canvasGraphResources: (values) =>
      values.filter(
        (value): value is Record<string, never> =>
          !!value && typeof value === "object"
      ),
    beginDeployAttempt,
    triggerDeployRepairHandoff: (_entry, instanceId) => {
      handoffs.push(instanceId);
      return true;
    },
    triggerDeployFailureNotice: () => false,
    monitor: monitorOverride ?? {
      run: (request) => {
        monitorCalls.push(request);
        monitorSettled = new Promise<void>((resolve, reject) => {
          releaseMonitor = (error?: Error) =>
            error ? reject(error) : resolve();
        });
        return monitorSettled;
      }
    },
    unconfirmedRunKind: DEPLOY_RUN_UNCONFIRMED_KIND,
    repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  });

  const routes = createTestRouteTable(
    createDeploymentsRoutes({
      isValidRepoSlug,
      readInstanceEntry: (instanceId) => container?.instances.get(instanceId),
      triggerDeployRepairHandoff: () => false,
      triggerDeployFailureNotice: () => false,
      deployHandoffStatus: () => ({
        state: "idle",
        attempts: 0,
        maxAttempts: 3,
        pending: false
      }),
      resolveRepoAppName: () => Promise.resolve("todo-app"),
      resolveEnvDeployment: () => Promise.resolve(null),
      ghOrThrow: () => Promise.resolve(""),
      resetDeploymentViewState: () => {},
      deployListCache: new Map<string, DeployListCacheEntry>(),
      deployListTtlMs: 15000,
      activeDeploymentMutation: () => undefined,
      reserveDeploymentMutation: () => null,
      releaseDeploymentMutation: () => {},
      deploymentStatusBlocksMutation: () => false,
      localDeploymentBlocksMutation: () => false,
      ensureWorkflowsCurrent: () =>
        Promise.resolve({ created: [], failed: [] }),
      findWorkflowRun: () => Promise.resolve(null),
      runGh: () => {
        throw new Error("the deploy harness must not run gh");
      },
      readProcessEnv: () => ({}),
      setTimer: () => ({}),
      deployRequest,
      abandonment: {
        abandon: () => {
          throw new Error("the deploy harness must not abandon deployments");
        }
      }
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "deploying",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    monitorCalls,
    branchLookups,
    handoffs,
    stateOf: (instanceId) => {
      const entry = container?.instances.get(instanceId);
      if (!entry) throw new Error(`no instance ${instanceId}`);
      return entry.state;
    },
    async settleMonitor(error) {
      if (!releaseMonitor || !monitorSettled) return;
      releaseMonitor(error);
      await monitorSettled.catch(() => {});
      // Let the .catch/.finally chain the request service attached run.
      await new Promise((resolve) => setImmediate(resolve));
    },
    setPersistedDeployment(row) {
      persisted = row;
    },
    failPersistedLookup(failure) {
      persistedFails = failure;
    }
  };
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function deployBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    targetRepo: "acme/widgets",
    environment: "production",
    branch: "feat",
    provider: "azure",
    appFile: ".radius/app.bicep",
    ...overrides
  });
}

function parseError(body: string): string {
  try {
    JSON.parse(body);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected JSON.parse to fail");
}

function failedAttempt(state: CanvasState, extra: Partial<CanvasState>): void {
  state.deployStatus = "failed";
  state.deployAttempt = {
    id: "attempt-A",
    targetRepo: "acme/widgets",
    environment: "production",
    branch: "feat",
    provider: "azure",
    appFile: ".radius/app.bicep"
  };
  Object.assign(state, extra);
}

describe("POST /api/deploy real-loopback HIT (RF-07)", () => {
  // Each refusal below gets its own harness. Sharing one test made the
  // case-mismatch half reachable only if the missing-subject half got that
  // far, so a regression in either path reported a single failure that said
  // nothing about which one broke.
  function oidcRefusalHarness(subjects: string[]) {
    const workflowDispatches: string[][] = [];
    const dispatch = createDeployDispatchService({
      deployWorkflowFile: "run-rad-commands.yml",
      deployWorkflowFiles: [
        "run-rad-commands.yml",
        "run-rad-commands-azure.yml"
      ],
      branchNotPushedKind: "branch-not-pushed",
      oidcSubjectMissingKind: "oidc-subject-missing",
      oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
      getBranchHeadSha: () => Promise.resolve("sha-1"),
      getDefaultBranch: () => Promise.resolve("main"),
      runGh: (args) => {
        if (args[0] === "workflow") workflowDispatches.push(args);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      runGhWithStdin: () => {
        throw new Error("OIDC refusal must happen before secret provisioning");
      },
      runAz: () =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify(subjects),
          stderr: ""
        }),
      runGitHubJson: (path) => {
        if (path.includes("/variables/AZURE_CLIENT_ID")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: { value: "client-123" }
          });
        }
        const environmentMatch =
          /^\/repos\/acme\/widgets\/environments\/([^/]+)$/.exec(path);
        if (environmentMatch) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: { name: decodeURIComponent(environmentMatch[1] ?? "") }
          });
        }
        if (path === "/repos/acme/widgets") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: {
              full_name: "acme/widgets",
              id: 202,
              owner: { id: 101 }
            }
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      },
      readProcessEnv: () => ({}),
      ghCredentialSource: () => "keyring",
      fetchFileForSelection: () => {
        throw new Error("OIDC refusal must happen before reading app.bicep");
      },
      appParams: () => [],
      resolveDeployParams: () => ({}),
      partitionParams: () => ({ secret: {}, public: {} }),
      extractAppName: () => "",
      buildDeployRadCommand: () => "",
      buildAppGraphRadCommand: () => "",
      ensureDeployWorkflowsOnBranch: () => {
        throw new Error("OIDC refusal must happen before workflow publication");
      },
      ensureWorkflowsCurrent: () => {
        throw new Error(
          "OIDC refusal must happen before workflow synchronization"
        );
      },
      classifyDeployDispatchFailure: () => "run-unconfirmed",
      uncommittedGeneratedPaths: () => Promise.resolve([]),
      latestWorkflowRunId: () => {
        throw new Error("OIDC refusal must happen before run discovery");
      },
      invalidateDeployListCache: () => {
        throw new Error("OIDC refusal must not invalidate the deploy cache");
      },
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      now: () => 1_700_000_000_000
    });
    const monitor = createDeployMonitorService({
      plannedGraph: {
        recover: () => {
          throw new Error("the request supplies planned resources");
        }
      },
      dispatch,
      outcome: {
        settle: () => {
          throw new Error("an undispatched workflow has no outcome");
        }
      },
      deployRadCommandsStep: "Run rad commands",
      unconfirmedRunKind: "run-unconfirmed",
      findWorkflowRun: () => {
        throw new Error("an undispatched workflow has no run");
      },
      getRunDetail: () => {
        throw new Error("an undispatched workflow has no run detail");
      },
      createStatusReader: () => {
        throw new Error("an undispatched workflow has no status reader");
      },
      buildDeployStatusMap: () => new Map(),
      buildDeployMessageMap: () => new Map(),
      applyDeployMessages: () => {},
      applyDeployStatusToResources: () => [],
      generatePortalUrl: () => "",
      optionalString: (value) => (typeof value === "string" ? value : ""),
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      sleep: () => Promise.resolve(),
      now: () => 1_700_000_000_000
    });
    return { workflowDispatches, harness: startDeploy(monitor) };
  }

  it("fails closed through the real monitor and dispatch service when no credential covers a subject GitHub could mint", async () => {
    const { workflowDispatches, harness } = oidcRefusalHarness([
      "repo:acme/widgets:environment:development"
    ]);
    const entry = await container!.getOrCreate("panel-a");
    const state = harness.stateOf("panel-a");
    state.plannedResources = [{ id: "r1", name: "db" }];

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect.poll(() => state.deployStatus).toBe("failed");
    expect(state.deployError).toContain(
      '"repo:acme/widgets:environment:production"'
    );
    // The refusal must be marked so the repair loop never opens for a failure
    // the agent cannot fix by editing the model.
    expect(state.deployErrorKind).toBe("oidc-subject-missing");
    expect(workflowDispatches).toEqual([]);
    await expect.poll(() => activeDeploymentMutation(state)).toBeUndefined();
  });

  it("fails closed through the real monitor and dispatch service when the only credential differs by casing", async () => {
    const { workflowDispatches, harness } = oidcRefusalHarness([
      "repo:Acme/Widgets:environment:Production"
    ]);
    const entry = await container!.getOrCreate("panel-a");
    const state = harness.stateOf("panel-a");
    state.plannedResources = [{ id: "r1", name: "db" }];

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect.poll(() => state.deployStatus).toBe("failed");
    expect(state.deployError).toContain(
      'expected "repo:acme/widgets:environment:production" but the app has "repo:Acme/Widgets:environment:Production"'
    );
    expect(state.deployErrorKind).toBe("oidc-subject-case-mismatch");
    expect(workflowDispatches).toEqual([]);
    await expect.poll(() => activeDeploymentMutation(state)).toBeUndefined();
  });

  it("accepts an ordinary deploy, answers 200 immediately, and hands the monitor the resolved attempt", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");
    const state = harness.stateOf("panel-a");
    state.plannedResources = [{ id: "r1", name: "db" }];

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    // An ordinary deploy reports no repair budget: those fields belong to a
    // loop redeploy only.
    expect(await response.text()).toBe('{"ok":true}');
    expect(harness.monitorCalls).toHaveLength(1);
    expect(harness.monitorCalls[0].repo).toBe("acme/widgets");
    expect(harness.monitorCalls[0].branch).toBe("feat");
    expect(harness.monitorCalls[0].provider).toBe("azure");
    // An explicit branch avoids the default-branch subprocess entirely.
    expect(harness.branchLookups).toEqual([]);
    expect(state.deployStatus).toBe("in_progress");
    expect(state.deployRepairAttempts).toBe(0);
    expect(state.deployAttempt?.targetRepo).toBe("acme/widgets");
    expect(state.deployLogs).toEqual([]);
    // The reservation is held by the monitor while it runs, then released
    // exactly once in its terminal cleanup.
    expect(activeDeploymentMutation(state)?.attemptId).toBe(
      state.deployAttempt?.id
    );
    await harness.settleMonitor();
    expect(activeDeploymentMutation(state)).toBeUndefined();
    expect(harness.handoffs).toEqual(["panel-a"]);
  });

  it("resolves the repo default branch when the request names none", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody({ branch: "" })
    });

    expect(response.status).toBe(200);
    expect(harness.branchLookups).toEqual([
      [
        "repo",
        "view",
        "acme/widgets",
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name"
      ]
    ]);
    expect(harness.stateOf("panel-a").deployAttempt?.branch).toBe("release/7");
    await harness.settleMonitor();
  });

  it("accepts a repair redeploy, keeps the attempt id, and reports the loop budget", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");
    const state = harness.stateOf("panel-a");
    failedAttempt(state, { deployRepairAttempts: 1 });

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody({ attemptId: "attempt-A" })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      repairAttempt: 2,
      repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP
    });
    expect(state.deployAttempt?.id).toBe("attempt-A");
    expect(state.deployRepairAttempts).toBe(2);
    expect(state.deployRepairing).toBe(true);
    expect(harness.monitorCalls).toHaveLength(1);
    await harness.settleMonitor();
  });

  it.each([
    [
      "over the repair cap",
      { deployRepairAttempts: DEPLOY_REPAIR_ATTEMPT_CAP },
      /already used its/
    ],
    ["still running", { deployStatus: "in_progress" }, /still running/],
    ["already complete", { deployStatus: "complete" }, /without an attemptId/],
    [
      "unconfirmed run",
      {
        deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND,
        deployRunUrl: "https://github.com/acme/widgets/actions/runs/7"
      },
      /may still be in flight/
    ]
  ])(
    "refuses a repair redeploy that is %s with an inert 409",
    async (_name, extra, message) => {
      const harness = startDeploy();
      const entry = await container!.getOrCreate("panel-a");
      const state = harness.stateOf("panel-a");
      failedAttempt(state, { deployRepairAttempts: 1, ...extra });
      const attemptsBefore = state.deployRepairAttempts;
      const statusBefore = state.deployStatus;

      const response = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        body: deployBody({ attemptId: "attempt-A" })
      });

      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(String((await jsonBody(response)).error)).toMatch(message);
      // Inert: no monitor, no branch lookup, no log buffer, no counter
      // movement, no reservation, and no transition out of the stored status.
      expect(harness.monitorCalls).toEqual([]);
      expect(harness.branchLookups).toEqual([]);
      expect(harness.handoffs).toEqual([]);
      expect(state.deployLogs).toBeUndefined();
      expect(state.deployRepairAttempts).toBe(attemptsBefore);
      expect(state.deployStatus).toBe(statusBefore);
      expect(state.deployAttempt?.id).toBe("attempt-A");
      expect(activeDeploymentMutation(state)).toBeUndefined();
    }
  );

  it("refuses a stale attempt without clobbering the current one", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");
    const state = harness.stateOf("panel-a");
    state.deployStatus = "failed";
    state.deployRepairAttempts = 0;
    state.deployAttempt = {
      id: "attempt-B",
      targetRepo: "acme/other",
      environment: "staging",
      branch: "main",
      provider: "azure",
      appFile: ".radius/app.bicep"
    };

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody({ attemptId: "attempt-A" })
    });

    expect(response.status).toBe(409);
    expect(String((await jsonBody(response)).error)).toMatch(
      /no longer the current attempt/
    );
    expect(harness.monitorCalls).toEqual([]);
    expect(harness.branchLookups).toEqual([]);
    expect(state.deployAttempt?.id).toBe("attempt-B");
    expect(state.deployAttempt?.targetRepo).toBe("acme/other");
    expect(state.deployRepairAttempts).toBe(0);
  });

  it("refuses a second deploy while one is already in flight", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");

    const first = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });
    expect(second.status).toBe(409);
    expect(String((await jsonBody(second)).error)).toContain(
      "A deploy operation for acme/widgets in environment production is already in progress."
    );
    expect(harness.monitorCalls).toHaveLength(1);
    await harness.settleMonitor();
  });

  it("fails closed when the persisted deployment state cannot be read", async () => {
    const harness = startDeploy();
    harness.failPersistedLookup(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });

    expect(response.status).toBe(503);
    expect(String((await jsonBody(response)).error)).toMatch(
      /Could not verify whether this environment/
    );
    expect(harness.monitorCalls).toEqual([]);
    // The reservation taken before the lookup is released again, so a retry is
    // not blocked by the failure.
    expect(
      activeDeploymentMutation(harness.stateOf("panel-a"))
    ).toBeUndefined();
  });

  it("refuses when GitHub still reports the environment busy", async () => {
    const harness = startDeploy();
    harness.setPersistedDeployment({
      app: "todo-app",
      environment: "production",
      provider: "azure",
      status: "deleting",
      deploymentId: "dep-1",
      runUrl: "https://example.test/1"
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This deployment is currently being deleted. Wait for it to finish before deploying again."
    });
    expect(harness.monitorCalls).toEqual([]);
    expect(
      activeDeploymentMutation(harness.stateOf("panel-a"))
    ).toBeUndefined();
  });

  it.each([
    ["malformed JSON", "not json"],
    ["an empty body", ""]
  ])("returns the raw JSON.parse error for %s", async (_name, body) => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: parseError(body) });
    expect(harness.monitorCalls).toEqual([]);
  });

  it("answers 400 for a JSON null body", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: "null"
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(String((await jsonBody(response)).error)).toMatch(/null/i);
    expect(harness.monitorCalls).toEqual([]);
  });

  it("answers 400 when the request names no repository or environment", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: JSON.stringify({ provider: "azure" })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "targetRepo and environment are required."
    });
    expect(harness.monitorCalls).toEqual([]);
  });

  it("settles the deploy as unconfirmed when the background monitor throws", async () => {
    const harness = startDeploy();
    const entry = await container!.getOrCreate("panel-a");
    const state = harness.stateOf("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });
    expect(response.status).toBe(200);

    await harness.settleMonitor(new Error("monitor exploded"));

    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toBe(
      "Deploy monitoring stopped unexpectedly: monitor exploded"
    );
    expect(state.deployErrorKind).toBe(DEPLOY_RUN_UNCONFIRMED_KIND);
    expect(state.deployLogs).toEqual([
      "❌ Deploy monitor stopped unexpectedly: monitor exploded"
    ]);
    // Cleanup still runs on the failure path: handoff attempted once, and the
    // reservation released.
    expect(harness.handoffs).toEqual(["panel-a"]);
    expect(activeDeploymentMutation(state)).toBeUndefined();
  });

  it("delegates unmatched GET /api/deploy", async () => {
    startDeploy();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("unmatched");
  });

  it("keeps two canvas instances isolated", async () => {
    const harness = startDeploy();
    const a = await container!.getOrCreate("panel-a");
    const b = await container!.getOrCreate("panel-b");
    expect(a.baseUrl).not.toBe(b.baseUrl);

    const first = await fetch(`${a.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody()
    });
    expect(first.status).toBe(200);

    // panel-b holds no reservation of its own, so its deploy is admitted even
    // though panel-a is mid-deploy.
    const second = await fetch(`${b.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody({ targetRepo: "acme/other", environment: "staging" })
    });
    expect(second.status).toBe(200);

    const stateA = harness.stateOf("panel-a");
    const stateB = harness.stateOf("panel-b");
    expect(stateA.deployingRepo).toBe("acme/widgets");
    expect(stateB.deployingRepo).toBe("acme/other");
    expect(stateA.deployAttempt?.id).not.toBe(stateB.deployAttempt?.id);
    expect(harness.monitorCalls.map((call) => call.repo)).toEqual([
      "acme/widgets",
      "acme/other"
    ]);
    await harness.settleMonitor();
  });
});
