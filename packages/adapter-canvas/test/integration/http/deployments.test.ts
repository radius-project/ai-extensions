import {
  collectWorkflowFailure,
  redactCredentials
} from "@radius-project/core";
import { redactGhCredentials } from "../../../src/gh.js";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createDeploymentsRoutes } from "../../../src/server/routes/deployments.js";
import { isValidRepoSlug } from "../../../src/azure-oidc.js";
import { createDeploymentAbandonmentService } from "../../../src/server/services/deployment-abandonment.js";
import {
  createDeployRequestService,
  type DeployRequestDependencies
} from "../../../src/server/services/deploy-request.js";
import { createDeploymentViews } from "../../../src/server/services/deployment-views.js";
import { createTestDeploymentRuntime } from "../../support/server/deployment-runtime.js";
import type {
  DeploymentRuntime,
  DeploymentRuntimePorts
} from "@radius-project/adapter-shared";
import { createDeployDispatchService } from "../../../src/server/services/deploy-dispatch.js";
import { resolveEnvironmentDeployment } from "../../../src/server/services/deployment-resolver.js";
import { probeDeleteConflict } from "../../../src/server/services/delete-conflict.js";
import {
  createDeployMonitorService,
  type DeployMonitorService
} from "../../../src/server/services/deploy-monitor.js";
import {
  activeDeploymentMutation,
  DEPLOY_CLOUD_AUTH_DRIFT_KIND,
  DEPLOY_RUN_UNCONFIRMED_KIND,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation,
  releaseDeploymentMutation,
  reserveDeploymentMutation,
  setDeployRepairHandoff,
  triggerDeployRepairHandoff
} from "../../../src/server.js";
import { DEPLOY_REPAIR_ATTEMPT_CAP } from "@radius-project/core";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type {
  DeployListCacheEntry,
  DeploymentRow,
  DeploymentsDependencies
} from "../../../src/server/routes/deployments.js";
import type {
  ArtifactFiles,
  WorkflowArtifact
} from "../../../src/deploy-artifacts.js";
import type { DeployMonitorRequest } from "../../../src/server/services/deploy-monitor.js";
import type { CanvasState } from "../../../src/shared.js";
import { createAwsTrustRepairService } from "../../../src/server/services/aws-trust-repair.js";
import type { EnvironmentTarget } from "../../../src/server/services/environment-target.js";
import type { AwsEnvironmentRepairResult } from "../../../src/server/services/aws-environment-access.js";
import { observeWorkflowRun } from "@radius-project/core";
import {
  readWorkflowRun,
  readWorkflowLog,
  normalizeDeploymentAppFile,
  createWorkflowArtifactReader,
  createDeploymentRepository,
  createDeploymentWorkflows,
  type WorkflowExecution
} from "@radius-project/adapter-shared";
import { createDeployModelSource } from "../../../src/server/services/deploy-model-source.js";
import { createDeployOutcomeService } from "../../../src/server/services/deploy-outcome.js";
import {
  DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE,
  settleDeployStatuses
} from "../../../src/deploy-artifacts.js";
import { createUnconfirmedMonitor } from "../../support/server/unconfirmed-monitor.js";
import { createDeferred } from "../../support/browser/fakes.js";
import { createWorkflowObservationScope } from "../../../src/server/services/workflow-observation-scope.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { pendingEnvironment } from "@radius-project/adapter-shared/test-support/workflow-observation";
import { deploymentTemplates } from "../../../../adapter-shared/test/fixtures/deployment-workflows.js";
import {
  appParams,
  resolveDeployParams,
  partitionParams,
  extractAppName,
  buildDeployRadCommand,
  buildAppGraphRadCommand
} from "../../../src/bicep.js";

let container: CanvasServerContainer | undefined;
const fixtureRuntimes: DeploymentRuntime[] = [];
let deploymentHarness:
  | {
      runtime: DeploymentRuntime;
      views: ReturnType<typeof createDeploymentViews>;
      cleanup(): Promise<void>;
    }
  | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await container?.stopAll();
  await deploymentHarness?.cleanup();
  await Promise.all(
    fixtureRuntimes.splice(0).map((runtime) => runtime.owner.shutdown(1000))
  );
  deploymentHarness = undefined;
  container = undefined;
});

interface Harness {
  runtime: DeploymentRuntime;
  views: ReturnType<typeof createDeploymentViews>;
  state: CanvasState;
  cache: Map<string, DeployListCacheEntry>;
  environments: string[];
  resets: unknown[];
  dispatches: string[][];
  workflowSyncs: unknown[][];
  ghApiCalls: string[][];
  setGhOrThrow(run: (args: string[]) => Promise<string>): void;
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
  // The evidence the force-delete gate reads: the artifact the failed delete
  // run left behind, or its absence.
  artifacts: WorkflowArtifact[];
  artifactFiles: ArtifactFiles | null;
  setArtifactFiles(files: ArtifactFiles | null): void;
  // AWS trust repair: the GitHub environment's variables, the role repairs
  // asked for, and the answer each gets.
  setEnvironmentTarget(target: EnvironmentTarget): void;
  trustRepairs: unknown[];
  setTrustRepairResult(result: AwsEnvironmentRepairResult): void;
}

function row(environment: string, status = "deployed"): DeploymentRow {
  return {
    app: "todo-app",
    identity: { state: "known", application: "todo-app" },
    environment,
    provider: "azure",
    status,
    deploymentId: `dep-${environment}`,
    runUrl: `https://example.test/${environment}`
  };
}

function start(
  callbacks: Partial<
    Pick<
      DeploymentsDependencies,
      | "triggerDeployRepairHandoff"
      | "triggerDeployFailureNotice"
      | "listEnvDeployment"
    >
  > = {},
  { awsEnabled = true }: { awsEnabled?: boolean } = {}
): Harness {
  const state: CanvasState = {};
  const runtime = createTestDeploymentRuntime();
  fixtureRuntimes.push(runtime);
  const views = createDeploymentViews(runtime);
  const cache = new Map<string, DeployListCacheEntry>();
  const environments: string[] = [];
  const resets: unknown[] = [];
  const dispatches: string[][] = [];
  const workflowSyncs: unknown[][] = [];
  const ghApiCalls: string[][] = [];
  const processEnv: NodeJS.ProcessEnv = {};
  const artifacts: WorkflowArtifact[] = [];
  let artifactFiles: ArtifactFiles | null = null;
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
  let runGh = (args: string[]): Promise<string> =>
    Promise.resolve(args.includes("--method") ? "" : environments.join("\n"));
  const ghOrThrow = (args: string[]): Promise<string> => {
    ghApiCalls.push(args);
    return runGh(args);
  };
  let environmentTarget: EnvironmentTarget = {
    provider: "aws",
    clientId: "",
    tenantId: "",
    repoId: 0,
    roleArn: "",
    trustSubjects: [],
    region: "",
    cluster: ""
  };
  const trustRepairs: unknown[] = [];
  let trustRepairResult: AwsEnvironmentRepairResult = {
    ok: true,
    roleName: "radius-deploy-octo-todolist",
    added: []
  };
  const awsTrustRepair = createAwsTrustRepairService({
    awsEnabled,
    readInstanceState: () => readInstanceState(),
    cloudAuthDriftKind: DEPLOY_CLOUD_AUTH_DRIFT_KIND,
    readEnvironmentTarget: async () => environmentTarget,
    // Like the real access layer, runs the re-check once the lock is held.
    repair: async (input) => {
      trustRepairs.push(input);
      const changed = await input.confirmTarget();
      return changed ? { ok: false, ...changed } : trustRepairResult;
    },
    errorMessage: (error) => String(error)
  });
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
      id: () => "fixture",
      isValidRepoSlug,
      readInstanceEntry: (instanceId) => {
        if (entryMissing) return undefined;
        views.refresh(instanceId, state);
        return { state };
      },
      triggerDeployRepairHandoff:
        callbacks.triggerDeployRepairHandoff ?? (() => false),
      triggerDeployFailureNotice:
        callbacks.triggerDeployFailureNotice ?? (() => false),
      deployHandoffStatus: (current) => ({
        state: current.deployHandoffState || "idle",
        attempts: current.deployHandoffAttempts || 0,
        maxAttempts: 3,
        pending: false
      }),
      resolveRepoAppName: (_repo, branch) =>
        Promise.resolve(`todo-app@${branch}`),
      resolveEnvDeployment,
      listEnvDeployment:
        callbacks.listEnvDeployment ??
        (async (...args) => ({
          deployment: await resolveEnvDeployment(...args),
          incomplete: false
        })),
      ghOrThrow,
      resetDeploymentViewState: (_target, attemptId) => {
        resets.push(attemptId);
      },
      deployListCache: cache,
      deployListTtlMs: 15000,
      captureDeletedDeployment: views.captureDeletion,
      logError: (message) => {
        throw new Error(message);
      },
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
      deleteApplicationWorkflowFiles: [
        "delete-application.yml",
        "delete-azure.yml"
      ],
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
      probeDeleteConflict: (request) =>
        probeDeleteConflict(request, {
          resolveEnvDeployment,
          listArtifacts: () => Promise.resolve(artifacts),
          downloadArtifact: () => Promise.resolve(artifactFiles)
        }),
      // The deploy route has its own harness below, which drives the real
      // admission service. Reaching it from this one is a wiring bug.
      deployRequest: {
        deploy: () => {
          throw new Error("unexpected deploy dispatch from the read harness");
        }
      },
      abandonment,
      awsTrustRepair
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
    runtime,
    views,
    cache,
    environments,
    resets,
    dispatches,
    workflowSyncs,
    ghApiCalls,
    setGhOrThrow(run) {
      runGh = run;
    },
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
    },
    artifacts,
    get artifactFiles() {
      return artifactFiles;
    },
    setEnvironmentTarget(target) {
      environmentTarget = target;
    },
    trustRepairs,
    setTrustRepairResult(result) {
      trustRepairResult = result;
    },
    setArtifactFiles(files) {
      artifactFiles = files;
    }
  };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("deployments routes real-loopback HIT (RF-05)", () => {
  it("keeps healthy environments visible over HTTP when peers are incomplete or unreadable", async () => {
    const h = start({
      listEnvDeployment: async (_repo, environment) => {
        if (environment === "failed")
          throw new Error("GitHub rate limit. Retry later.");
        if (environment === "incomplete")
          return { deployment: null, incomplete: true };
        return { deployment: row(environment, "success"), incomplete: false };
      }
    });
    h.environments.push("healthy", "incomplete", "failed");
    h.setDeploymentResolver(async () => {
      throw new Error("A listing must not run complete verification");
    });
    const entry = await container!.getOrCreate("panel-a");
    const response = await fetch(
      `${entry.baseUrl}/api/list-deployments?repo=octo/todo`
    );
    expect(await response.json()).toMatchObject({
      deployments: [{ environment: "healthy", status: "success" }],
      environmentDiagnostics: [
        { environment: "incomplete", kind: "incomplete" },
        {
          environment: "failed",
          kind: "error",
          message: "GitHub rate limit. Retry later."
        }
      ]
    });
    expect(h.dispatches).toEqual([]);
    expect(h.workflowSyncs).toEqual([]);
  });

  it("checks complete history beyond record 100 before admitting application deletion or conflict clearance", async () => {
    const h = start();
    const pages: number[] = [];
    h.setDeploymentResolver((repo, environment, application) =>
      resolveEnvironmentDeployment(repo, environment, application, {
        deployWorkflowFile: "run-rad-commands.yml",
        deleteWorkflowFile: "delete-application.yml",
        maxParallelRecords: 10,
        readApplicationIdentity: async () => ({
          state: "known",
          application: "todo-app"
        }),
        ghOrThrow: async (args) => {
          const path = args[1];
          if (path.includes("/variables?")) return "AZURE_CLIENT_ID";
          if (path.includes("/deployments?")) {
            const page = Number(/&page=(\d+)/.exec(path)?.[1] ?? 1);
            pages.push(page);
            return page === 1 ?
                Array.from({ length: 100 }, (_, i) => String(i + 1)).join("\n")
              : "101";
          }
          const status = /\/deployments\/(\d+)\/statuses/.exec(path);
          if (status)
            return `in_progress\thttps://github.com/${repo}/actions/runs/${status[1]}\t`;
          const run = /\/actions\/runs\/(\d+)$/.exec(path);
          if (run)
            return [
              run[1] === "101" ? "run-rad-commands.yml" : "unrelated.yml",
              "in_progress",
              "",
              "1",
              "a".repeat(40),
              "",
              run[1],
              repo,
              "workflow_dispatch"
            ].join("\t");
          throw new Error(`Unexpected history read: ${path}`);
        }
      })
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
    expect(response.status).toBe(409);
    const conflict = await fetch(
      `${entry.baseUrl}/api/delete-conflict?repo=octo%2Ftodo&environment=dev&application=todo-app`
    );
    expect(await conflict.json()).toMatchObject({ conflict: false });
    expect(pages).toEqual([1, 2, 1, 2]);
    expect(h.dispatches).toEqual([]);
    expect(h.workflowSyncs).toEqual([]);
  });

  it("prepares exact-run cleanup over HTTP without writes and rejects a superseded selection", async () => {
    const h = start();
    const entry = await container!.getOrCreate("panel-a");
    const selection = {
      runId: 42,
      runAttempt: 1,
      deploymentId: "7",
      runUrl: "https://github.com/octo/todo/actions/runs/42"
    };
    const current: DeploymentRow = {
      ...row("dev", "failed"),
      deploymentId: selection.deploymentId,
      runUrl: selection.runUrl,
      recovery: {
        ...selection,
        revision: "a".repeat(64),
        deploymentIds: ["7", "6"],
        confirmation: "todo-app/dev",
        canMarkCleanupComplete: true
      }
    };
    h.setDeploymentResolver(async () => current);
    const target = { repo: "octo/todo", environment: "dev" };
    const discovery = await post(
      entry.baseUrl,
      "/api/deployment-cleanup-details",
      JSON.stringify(target)
    );
    expect(await discovery.json()).toMatchObject({
      prepared: false,
      selection
    });
    const prepared = await post(
      entry.baseUrl,
      "/api/deployment-cleanup-details",
      JSON.stringify({ ...target, ...selection })
    );
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({
      prepared: true,
      deployment: { recovery: current.recovery }
    });
    h.setDeploymentResolver(async () => ({
      ...current,
      runUrl: "https://github.com/octo/todo/actions/runs/43"
    }));
    const stale = await post(
      entry.baseUrl,
      "/api/deployment-cleanup-details",
      JSON.stringify({ ...target, ...selection })
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: expect.stringContaining("changed")
    });
    expect(h.ghApiCalls).toEqual([]);
    expect(h.dispatches).toEqual([]);
    expect(h.workflowSyncs).toEqual([]);
  });

  it("retains the local attempt when marker writes race an active rerun without recovery metadata", async () => {
    const h = start();
    const entry = await container!.getOrCreate("panel-a");
    const recovery = {
      runId: 42,
      runAttempt: 1,
      revision: "a".repeat(64),
      deploymentIds: ["7"],
      confirmation: "todo-app/dev",
      canMarkCleanupComplete: true
    };
    const current: DeploymentRow = {
      ...row("dev", "failed"),
      deploymentId: "7",
      runUrl: "https://github.com/octo/todo/actions/runs/42",
      recovery
    };
    Object.assign(h.state, {
      deployStatus: "failed",
      deployAppName: "todo-app",
      deployRunUrl: current.runUrl,
      deployRunId: "42",
      deployAttempt: {
        id: "original",
        targetRepo: "octo/todo",
        environment: "dev"
      }
    });
    let rerunning = false;
    h.setDeploymentResolver(async () =>
      rerunning ?
        {
          ...current,
          deploymentId: "new",
          status: "pending",
          recovery: undefined
        }
      : current
    );
    h.setGhOrThrow(async (args) => {
      if (args.includes("POST")) rerunning = true;
      return "";
    });
    const response = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app",
        deploymentId: "7",
        runUrl: current.runUrl,
        ...recovery
      })
    );
    expect(response.status).toBe(502);
    expect(h.state.deployAttempt?.id).toBe("original");
    expect(h.state.deployStatus).toBe("failed");
    expect(h.dispatches).toEqual([]);
    expect(h.workflowSyncs).toEqual([]);
  });

  it.each([
    {
      workspaceRepo: "acme/workspace",
      workspaceBranch: "feature",
      expected: null
    },
    { workspaceRepo: undefined, workspaceBranch: undefined, expected: null },
    { workspaceRepo: "acme/target", workspaceBranch: "other", expected: null },
    {
      workspaceRepo: "ACME/TARGET",
      workspaceBranch: "feature",
      expected: "feature"
    }
  ])(
    "publishes push eligibility only for matching workspace identity $workspaceRepo@$workspaceBranch",
    async ({ workspaceRepo, workspaceBranch, expected }) => {
      const harness = start();
      Object.assign(harness.state, {
        workspaceRepo,
        workspaceBranch,
        deployStatus: "failed",
        deployErrorKind: "branch-not-pushed",
        deployErrorBranch: "feature",
        deployAttempt: {
          id: "cross-repository",
          targetRepo: "acme/target",
          branch: "feature"
        }
      });
      const entry = await container!.getOrCreate("panel-a");

      const response = await fetch(`${entry.baseUrl}/api/deploy-status`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        errorKind: "branch-not-pushed",
        errorBranch: expected,
        attempt: { targetRepo: "acme/target", branch: "feature" }
      });
    }
  );

  it("returns the same sanitized diagnostics as the direct caller without publishing raw credentials", async () => {
    const credential = "opaque-http-diagnostic-fixture";
    const namedCredential = "unregistered-http-workflow-fixture";
    const controlCredential = "unregistered-http-control-fixture";
    const nested = JSON.stringify(
      JSON.stringify({ client_secret: namedCredential })
    );
    const safeNested = JSON.stringify(
      JSON.stringify({ client_secret: "[REDACTED]" })
    );
    const safeControl = JSON.stringify(
      JSON.stringify({ password: "[REDACTED]" })
    );
    const redactDiagnostic = (value: string) =>
      redactGhCredentials(value, { GH_TOKEN: credential });
    const controlPlane =
      `provisioning client_secret="${credential}" ` +
      JSON.stringify(JSON.stringify({ password: controlCredential }));
    const execution: WorkflowExecution = {
      mode: "ambient",
      run: async (args) => {
        if (args[0] === "api")
          return {
            code: 0,
            stderr: "",
            stdout:
              "HTTP/2 200\n\n" +
              JSON.stringify(
                args[1].includes("/jobs") ?
                  {
                    total_count: 1,
                    jobs: [
                      {
                        name: "deploy",
                        steps: [
                          { name: "Run rad commands", conclusion: "failure" }
                        ]
                      }
                    ]
                  }
                : { status: "completed", conclusion: "failure" }
              )
          };
        if (args.join(" ") === "run view 42 --log --repo org/app")
          return {
            code: 0,
            stderr: "",
            stdout: `deploy\tRun rad commands\t2026-01-01 Error: { quota ${credential} ${nested} }`
          };
        throw new Error("Unexpected command");
      }
    };
    const target = { repo: "org/app", runId: 42 };
    const observed = await observeWorkflowRun(target, {
      readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
    });
    if (!observed) throw new Error("Missing observed run");
    const direct = await collectWorkflowFailure(
      target,
      observed,
      { provider: "azure", resourcesTouched: false },
      {
        redactDiagnostic,
        readLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
        sleep: async () => {},
        readControlPlaneLog: async () => controlPlane
      }
    );
    const repairSnapshots: {
      state: string | undefined;
      error: string | null | undefined;
    }[] = [];
    const harness = start({
      triggerDeployRepairHandoff: (entry) => {
        repairSnapshots.push({
          state: JSON.stringify(entry?.state),
          error: entry?.state.deployError
        });
        return false;
      }
    });
    harness.state.deployStatus = "in_progress";
    harness.state.deployLogs = [];
    harness.state.deployingResources = [
      { name: "db", deployStatus: "pending" }
    ];
    const outcome = createDeployOutcomeService({
      projectSafeGraphResources: () => [],
      settleDeployStatuses,
      fetchRunLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
      redactDiagnostic,
      cloudAuthDriftKind: "cloud-auth-drift",
      sleep: async () => {
        throw new Error("No graph retry expected");
      },
      now: () => 1700000060000
    });
    await outcome.settle({
      entry: { state: harness.state },
      ...target,
      provider: "azure",
      resources: harness.state.deployingResources,
      status: observed.status,
      conclusion: observed.conclusion,
      steps: observed.steps,
      jobs: observed.jobs,
      statusReader: {
        graph: async () => ({ graph: null, status: "malformed" }),
        controlPlaneLog: async () => controlPlane
      },
      deployStepStartedAt: 0,
      log: (message) => harness.state.deployLogs?.push(message),
      setStatus: (resource, status) => {
        resource.deployStatus = status;
      },
      pollDeployStatus: async () => {}
    });
    const entry = await container!.getOrCreate("panel-a");
    const response = await fetch(`${entry.baseUrl}/api/deploy-status`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.error).toBe(direct.message);
    expect(body.resources[0].deployMessage).toBe(direct.radiusError);
    expect(body.logs).toEqual(expect.arrayContaining(direct.narration));
    expect(body.error).toContain('client_secret="[REDACTED]"');
    expect(JSON.stringify(body)).not.toContain(credential);
    expect(repairSnapshots).toHaveLength(1);
    for (const snapshot of repairSnapshots) {
      for (const value of [credential, namedCredential, controlCredential])
        expect(snapshot.state).not.toContain(value);
      expect(snapshot.error).toContain(safeNested);
      expect(snapshot.error).toContain(safeControl);
    }
    expect(body.error).toContain(safeNested);
    expect(body.error).toContain(safeControl);
    expect(body.resources[0].deployMessage).toContain(safeNested);
    expect(body.logs.join("\n")).toContain(safeNested);
    expect(body.logs.join("\n")).toContain(safeControl);
    for (const value of [namedCredential, controlCredential]) {
      expect(body.error).not.toContain(value);
      expect(body.resources[0].deployMessage).not.toContain(value);
      expect(body.logs.join("\n")).not.toContain(value);
      expect(JSON.stringify(body)).not.toContain(value);
    }
  });

  it.each(["deferred", "exhausted"] as const)(
    "preserves a confirmed failure and %s artifact diagnostics through HTTP and the registered status tool",
    async (mode) => {
      vi.useFakeTimers();
      const commands: string[][] = [];
      const expectedNote =
        mode === "deferred" ?
          "Artifact evidence deferred: missing-deadline."
        : "Artifact evidence exhausted: attempts.";
      let repairPolls = 0;
      const harness = start({
        triggerDeployRepairHandoff: (entry) => {
          expect(entry?.state.deployError).toContain(expectedNote);
          expect(entry?.state.deployingResources?.[0].deployStatus).toBe(
            "failed"
          );
          repairPolls++;
          return false;
        }
      });
      const execution: WorkflowExecution = {
        mode: "ambient",
        run: async (args) => {
          commands.push(args);
          if (args[0] === "api") {
            if (args[1].includes("/artifacts"))
              return {
                code: 1,
                stderr: "",
                stdout: `HTTP/2 ${mode === "deferred" ? 429 : 503}\n\n{}`
              };
            return {
              code: 0,
              stderr: "",
              stdout:
                "HTTP/2 200\n\n" +
                JSON.stringify(
                  args[1].includes("/jobs") ?
                    {
                      total_count: 1,
                      jobs: [
                        {
                          name: "deploy",
                          steps: [
                            {
                              name: "Run rad commands",
                              conclusion: "failure"
                            }
                          ]
                        }
                      ]
                    }
                  : { status: "completed", conclusion: "failure" }
                )
            };
          }
          if (args.join(" ") === "run view 42 --log --repo org/app")
            return {
              code: 0,
              stderr: "",
              stdout:
                "deploy\tRun rad commands\t2026-01-01 Error: recipe quota exceeded"
            };
          throw new Error("No opaque download or mutation is admitted");
        }
      };
      const scope = createWorkflowObservationScope((options) =>
        createWorkflowArtifactReader(options, execution.run)
      );
      const observation = scope.observe();
      const detail = await observeWorkflowRun(
        { repo: "org/app", runId: 42 },
        {
          readRun: (repo, runId) =>
            readWorkflowRun(execution, repo, runId, observation)
        }
      );
      if (!detail) throw new Error("Missing confirmed run");
      harness.state.deployStatus = "in_progress";
      harness.state.deployAttempt = { id: "policy-attempt" };
      harness.state.deployingResources = [
        { name: "db", deployStatus: "pending" }
      ];
      let status = harness.state.deployStatus;
      Object.defineProperty(harness.state, "deployStatus", {
        enumerable: true,
        configurable: true,
        get: () => status,
        set: (value: typeof status) => {
          if (value === "failed") {
            expect(harness.state.deployError).toContain(expectedNote);
            expect(harness.state.deployError).toContain(
              "Failed step: Run rad commands"
            );
            expect(harness.state.deployingResources?.[0].deployStatus).toBe(
              "failed"
            );
            expect(harness.state.deployErrorKind).toBeUndefined();
          }
          status = value;
        }
      });
      const reader = scope.reader({ repo: "org/app", runId: 42 });
      const outcome = createDeployOutcomeService({
        redactDiagnostic: redactCredentials,
        projectSafeGraphResources: () => {
          throw new Error("No graph payload");
        },
        settleDeployStatuses,
        fetchRunLog: (repo, runId, request) => {
          expect(request).toBe(observation);
          return readWorkflowLog(execution, repo, runId, request);
        },
        cloudAuthDriftKind: "cloud-auth-drift",
        sleep: () => {
          throw new Error(
            "Transport failure must not activate graph finalization polling"
          );
        },
        now: () => Date.now()
      });
      const settling = outcome.settle({
        entry: { state: harness.state },
        repo: "org/app",
        runId: 42,
        provider: "azure",
        resources: harness.state.deployingResources,
        status: detail.status,
        conclusion: detail.conclusion,
        steps: detail.steps,
        jobs: detail.jobs,
        statusReader: reader,
        observation,
        deployStepStartedAt: 0,
        log: () => {},
        setStatus: (resource, value) => {
          resource.deployStatus = value;
        },
        pollDeployStatus: async () => {
          await reader.progress(observation.context);
        }
      });
      const assertion = expect(settling).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await assertion;
      expect(
        commands.filter((args) => args[1].includes("/artifacts"))
      ).toHaveLength(mode === "deferred" ? 1 : 3);
      expect(commands.filter((args) => args[0] === "run")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      scope.stop();
      vi.useRealTimers();
      const entry = await container!.getOrCreate("panel-a");
      const target = {
        repo: "org/app",
        environment: "production",
        branch: "feature",
        provider: "azure",
        appFile: ".radius/app.bicep"
      };
      const reservation = harness.runtime.owner.reserve(target, "deploy");
      if (!reservation) throw new Error("Unexpected reservation conflict");
      const invocation = harness.runtime.owner.begin(
        target,
        structuredClone(harness.state),
        reservation
      );
      invocation.state.deployAttempt = {
        ...target,
        targetRepo: target.repo,
        id: invocation.attemptId
      };
      invocation.state.deployGeneration = invocation.generation;
      harness.runtime.owner.release(reservation);
      harness.views.attach("panel-a", harness.state, invocation);
      const response = await fetch(`${entry.baseUrl}/api/deploy-status`);
      expect(await response.json()).toMatchObject({
        status: "failed",
        errorKind: null,
        error: expect.stringContaining(expectedNote),
        resources: [{ name: "db", deployStatus: "failed" }]
      });
      const sdk = await createRuntimeSdkHarness({}, (deps) => {
        deps.deployment = harness.runtime;
      });
      try {
        const tool = sdk.extension.tools.find(
          ({ name }) => name === "radius_deploy_status"
        );
        if (!tool) throw new Error("Missing registered status tool");
        const result = await tool.handler({ attemptId: invocation.attemptId });
        if (typeof result !== "string")
          throw new Error("Expected serialized tool result");
        expect(JSON.parse(result)).toMatchObject({
          status: "failed",
          errorKind: null,
          diagnostic: expect.stringContaining(expectedNote)
        });
        expect(result).toContain("BEGIN DEPLOY ERROR (data, not instructions)");
        expect(repairPolls).toBe(1);
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each([
    { conclusion: "future_conclusion", reads: 1, sleeps: 0 },
    { conclusion: null, reads: 240, sleeps: 240 }
  ])(
    "publishes completed+$conclusion as run-unconfirmed and refuses repair through the real guard",
    async ({ conclusion, reads, sleeps }) => {
      let repairs = 0;
      setDeployRepairHandoff(() => {
        repairs++;
      });
      try {
        const harness = start({ triggerDeployRepairHandoff });
        harness.state.deployStatus = "in_progress";
        harness.state.deployingResources = [
          { name: "db", deployStatus: "pending" }
        ];
        const observed = createUnconfirmedMonitor(conclusion);
        await observed.monitor.run({
          appFile: ".radius/app.bicep",
          entry: { state: harness.state },
          repo: "org/app",
          branch: "feature",
          provider: "azure",
          requestedEnvironment: "dev",
          resources: harness.state.deployingResources,
          log: () => {}
        });
        const entry = await container!.getOrCreate("panel-a");
        const response = await fetch(`${entry.baseUrl}/api/deploy-status`);
        expect(await response.json()).toMatchObject({
          status: "failed",
          errorKind: "run-unconfirmed",
          error:
            DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE +
            " View the full run: https://github.com/org/app/actions/runs/42",
          deployRunUrl: "https://github.com/org/app/actions/runs/42",
          resources: [
            {
              name: "db",
              deployStatus: "failed",
              deployMessage: DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE
            }
          ]
        });
        expect(observed.reads).toHaveLength(reads);
        expect(observed.sleeps).toEqual(Array<number>(sleeps).fill(5000));
        expect(observed.dispatches).toBe(1);
        expect(repairs).toBe(0);
        expect(harness.dispatches).toEqual([]);
      } finally {
        setDeployRepairHandoff(null);
      }
    }
  );

  it.each(["completed", "queued", "in_progress"])(
    "streams real pending-protection evidence through %s without terminal failure or repair",
    async (nextStatus) => {
      const harness = start();
      harness.state.deployStatus = "in_progress";
      harness.state.deployLogs = [];
      const waiting = createDeferred<void>();
      const resume = createDeferred<void>();
      const transitioned = createDeferred<void>();
      const finish = createDeferred<void>();
      const calls: string[][] = [];
      let runStatus = "waiting";
      const monitor = createDeployMonitorService({
        plannedGraph: { recover: async () => null },
        dispatch: {
          prepareAndDispatch: async () => ({
            dispatched: true,
            workflowFile: "run-rad-commands.yml",
            dispatchedAt: 1,
            environment: "dev",
            baselineRunId: null
          })
        },
        outcome: {
          settle: async () => {
            harness.state.deployStatus = "complete";
          }
        },
        deployRadCommandsStep: "Run rad commands",
        unconfirmedRunKind: "run-unconfirmed",
        findWorkflowRun: async () => 42,
        getRunDetail: (repo, runId, request) =>
          observeWorkflowRun(
            { repo, runId },
            {
              readRun: (targetRepo, targetRun) =>
                readWorkflowRun(
                  {
                    mode: "ambient",
                    run: async (args) => {
                      calls.push(args);
                      const value =
                        args[1].endsWith("pending_deployments") ?
                          [pendingEnvironment]
                        : args[1].includes("/jobs") ?
                          { jobs: [], total_count: 0 }
                        : {
                            status: runStatus,
                            conclusion:
                              runStatus === "completed" ? "success" : null
                          };
                      return {
                        code: 0,
                        stderr: "",
                        stdout: "HTTP/2 200\n\n" + JSON.stringify(value)
                      };
                    }
                  },
                  targetRepo,
                  targetRun,
                  request,
                  { includeProtection: true }
                )
            }
          ),
        createStatusReader: async () => ({
          progress: async () => null,
          graph: async () => ({ graph: null, status: "missing" }),
          controlPlaneLog: async () => null
        }),
        buildDeployStatusMap: () => new Map(),
        buildDeployMessageMap: () => new Map(),
        applyDeployMessages: () => {},
        applyDeployStatusToResources: () => [],
        settleDeployStatuses,
        generatePortalUrl: () => "",
        optionalString: () => "",
        errorMessage: String,
        now: () => 1700000000000,
        sleep: async () => {
          if (runStatus === "waiting") {
            waiting.resolve();
            await resume.promise;
          } else {
            transitioned.resolve();
            await finish.promise;
          }
        }
      });
      // No observation scope on this fixture: the injected sleep holds the real
      // monitor while the HTTP consumer reads its in-progress state.
      const operation = monitor.run({
        appFile: ".radius/app.bicep",
        entry: { state: harness.state },
        repo: "org/app",
        branch: "feature",
        provider: "azure",
        requestedEnvironment: "dev",
        resources: [],
        log: (message) => harness.state.deployLogs?.push(message)
      });
      try {
        await waiting.promise;
        const entry = await container!.getOrCreate("panel-a");
        const response = await fetch(
          `${entry.baseUrl}/api/deploy-status?since=0`
        );
        expect(await response.json()).toMatchObject({
          status: "in_progress",
          active: true,
          repairing: false,
          error: null,
          logsNew: expect.arrayContaining([
            expect.stringContaining(
              'environment "production <review>" is waiting on protection rules'
            )
          ])
        });
        runStatus = nextStatus;
        resume.resolve();
        if (nextStatus !== "completed") {
          await transitioned.promise;
          const transition = await fetch(
            `${entry.baseUrl}/api/deploy-status?since=0`
          );
          const body = await transition.json();
          expect(body).toMatchObject({
            status: "in_progress",
            active: true,
            repairing: false,
            error: null,
            logsNew: expect.arrayContaining([
              "Observation: run left the protection wait; continuing to monitor."
            ])
          });
          expect(JSON.stringify(body)).not.toContain(
            "approval status is unknown"
          );
          runStatus = "completed";
          finish.resolve();
        }
        await operation;
        const terminal = await fetch(
          `${entry.baseUrl}/api/deploy-status?since=0`
        );
        expect(await terminal.json()).toMatchObject({
          status: "complete",
          error: null,
          repairing: false,
          logsNew: expect.arrayContaining([
            expect.stringContaining(
              nextStatus === "completed" ?
                "earlier protection observations are historical"
              : "run left the protection wait"
            )
          ])
        });
        const expectedCalls = [
          [
            "api",
            "repos/org/app/actions/runs/42",
            "--include",
            "--method",
            "GET"
          ],
          [
            "api",
            "repos/org/app/actions/runs/42/jobs?per_page=100&page=1",
            "--include",
            "--method",
            "GET"
          ],
          [
            "api",
            "repos/org/app/actions/runs/42/pending_deployments",
            "--include",
            "--method",
            "GET"
          ],
          [
            "api",
            "repos/org/app/actions/runs/42",
            "--include",
            "--method",
            "GET"
          ],
          [
            "api",
            "repos/org/app/actions/runs/42/jobs?per_page=100&page=1",
            "--include",
            "--method",
            "GET"
          ]
        ];
        if (nextStatus !== "completed")
          expectedCalls.push(...expectedCalls.slice(-2));
        expect(calls).toEqual(expectedCalls);
        expect(harness.dispatches).toEqual([]);
      } finally {
        runStatus = "completed";
        resume.resolve();
        finish.resolve();
        await operation;
      }
    }
  );

  it.each([
    "primary",
    "unavailable",
    "teardown",
    "teardown-unattributed"
  ] as const)(
    "exposes real %s failure evidence to repair polling but keeps notifications passive",
    async (mode) => {
      const calls: string[] = [];
      const teardown = mode === "teardown" || mode === "teardown-unattributed";
      const harness = start({
        triggerDeployRepairHandoff: (entry) => {
          expect(entry?.state.deployError).toContain(
            teardown ?
              "Review the Teardown logs and verify saved state before retrying."
            : "Failed step: Run rad commands"
          );
          expect(entry?.state.deployingResources?.[0].deployStatus).toBe(
            "failed"
          );
          calls.push("repair");
          return false;
        },
        triggerDeployFailureNotice: () => {
          calls.push("notice");
          return false;
        }
      });
      const execution: WorkflowExecution = {
        mode: "ambient",
        run: async (args) => {
          calls.push(args.join(" "));
          if (args[0] === "api") {
            return {
              code: 0,
              stderr: "",
              stdout:
                args[1].includes("/jobs") ?
                  "HTTP/2 200\n\n" +
                  JSON.stringify({
                    total_count: 1,
                    jobs: [
                      {
                        name: "deploy",
                        steps: [
                          {
                            name: "Run rad commands",
                            status: "completed",
                            conclusion: teardown ? "success" : "failure"
                          },
                          {
                            name: "Teardown",
                            status: "completed",
                            conclusion: "failure"
                          }
                        ]
                      }
                    ]
                  })
                : 'HTTP/2 200\n\n{"status":"completed","conclusion":"failure"}'
            };
          }
          if (args.join(" ") === "run view 42 --log --repo org/app") {
            if (mode === "unavailable")
              throw new Error("fixture-private-log-error");
            return {
              code: 0,
              stderr: "",
              stdout:
                (teardown ? "" : (
                  "deploy\tRun rad commands\t2026-01-01 Error: recipe quota exceeded\n"
                )) +
                (mode === "teardown-unattributed" ? "other-job" : "deploy") +
                "\tTeardown\t2026-01-01 Error: { teardown failed }"
            };
          }
          throw new Error("Unexpected workflow read");
        }
      };
      const observed = await observeWorkflowRun(
        { repo: "org/app", runId: 42 },
        {
          readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
        }
      );
      if (!observed) throw new Error("Expected observed run");
      harness.state.deployStatus = "in_progress";
      harness.state.deployingResources = [
        { name: "db", deployStatus: "pending" }
      ];
      const outcome = createDeployOutcomeService({
        redactDiagnostic: redactCredentials,
        projectSafeGraphResources: () => [],
        settleDeployStatuses,
        fetchRunLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
        cloudAuthDriftKind: "cloud-auth-drift",
        sleep: () => {
          throw new Error("No graph retry expected");
        },
        now: () => 1700000060000
      });
      await outcome.settle({
        entry: { state: harness.state },
        repo: "org/app",
        runId: 42,
        provider: "azure",
        resources: harness.state.deployingResources,
        status: observed.status,
        conclusion: observed.conclusion,
        steps: observed.steps,
        jobs: observed.jobs,
        statusReader: {
          graph: async () => {
            calls.push("graph");
            throw new Error("fixture-private-graph-error");
          },
          controlPlaneLog: async () => {
            calls.push("control-plane");
            throw new Error("fixture-private-artifact-error");
          }
        },
        deployStepStartedAt: 0,
        log: () => {},
        setStatus: (resource, status) => {
          resource.deployStatus = status;
        },
        pollDeployStatus: async (force) => {
          expect(force).toBe(true);
          calls.push("progress");
        }
      });
      const entry = await container!.getOrCreate("panel-a");
      const notification = await fetch(
        `${entry.baseUrl}/api/deploy-notification`
      );
      expect(notification.status).toBe(200);
      expect(calls).not.toContain("repair");
      const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
      const body = await status.json();
      expect(body).toMatchObject({
        status: "failed",
        resources: [
          expect.objectContaining({
            name: "db",
            deployStatus: "failed",
            ...(mode === "primary" ?
              { deployMessage: "Error: recipe quota exceeded" }
            : {})
          })
        ],
        error: expect.stringContaining(
          teardown ?
            "Deployment commands completed successfully, but post-deployment teardown, which saves Radius state, failed. Resources may have changed. Radius state may not have been saved. The next deployment could restore older state that no longer matches the cloud resources. Review the Teardown logs and verify saved state before retrying."
          : "Failed step: Run rad commands, Teardown."
        ),
        errorKind: null
      });
      expect(JSON.stringify(body)).toContain(
        "The control-plane log could not be read."
      );
      expect(
        JSON.stringify(body).includes("The workflow log could not be read.")
      ).toBe(mode === "unavailable");
      expect(JSON.stringify(body)).not.toContain("fixture-private");
      if (teardown) {
        expect(JSON.stringify(body).includes("teardown failed")).toBe(
          mode === "teardown"
        );
      }
      expect(calls).toEqual([
        "api repos/org/app/actions/runs/42 --include --method GET",
        "api repos/org/app/actions/runs/42/jobs?per_page=100&page=1 --include --method GET",
        "graph",
        "progress",
        "run view 42 --log --repo org/app",
        "control-plane",
        "repair",
        "notice"
      ]);
      expect(harness.dispatches).toEqual([]);
    }
  );

  it("preserves terminal attempt status and passes the socket instance to status callbacks", async () => {
    const calls: Array<{
      callback: string;
      instanceId: string;
      state: CanvasState | undefined;
    }> = [];
    const harness = start({
      triggerDeployRepairHandoff: (entry, instanceId) => {
        calls.push({ callback: "repair", instanceId, state: entry?.state });
        return false;
      },
      triggerDeployFailureNotice: (entry, instanceId) => {
        calls.push({ callback: "notice", instanceId, state: entry?.state });
        return false;
      }
    });
    Object.assign(harness.state, {
      deployStatus: "complete",
      deployAttempt: { id: "attempt-42" },
      deployRunUrl: "https://github.com/acme/widgets/actions/runs/42",
      deployStartedAt: 1700000000000,
      deployFinishedAt: 1700000060000
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy-status`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      status: "complete",
      attempt: { id: "attempt-42" },
      deployRunUrl: "https://github.com/acme/widgets/actions/runs/42",
      startedAt: 1700000000000,
      finishedAt: 1700000060000,
      active: false,
      repairing: false
    });
    expect(
      calls.map(({ callback, instanceId }) => [callback, instanceId])
    ).toEqual([
      ["repair", "panel-a"],
      ["notice", "panel-a"]
    ]);
    expect(calls.every(({ state }) => state === harness.state)).toBe(true);
    expect(harness.dispatches).toEqual([]);
  });

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

  it("does not expose unsafe deployed graph state over the real status endpoint", async () => {
    const harness = start();
    const sentinel = "fixture-private-field";
    harness.state.deployedGraph = [
      {
        id: "unsafe",
        name: "unsafe",
        type: "Radius.Security/secrets",
        properties: { data: { privateField: sentinel } }
      }
    ];
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deploy-status`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body).deployedGraph).toBeNull();
    expect(body).not.toContain(sentinel);
  });

  it("serves the ambient deploy notification without the poll's payload or side effects", async () => {
    const harness = start({
      triggerDeployRepairHandoff: () => {
        throw new Error("Notification must not trigger repair");
      },
      triggerDeployFailureNotice: () => {
        throw new Error("Notification must not trigger a failure notice");
      }
    });
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

  it.each(["matching", "default-name", "stale", "unavailable"] as const)(
    "revalidates %s application identity between an HTTP listing and Delete",
    async (scenario) => {
      const h = start();
      h.environments.push("dev");
      const recorded: DeploymentRow = {
        ...row("dev"),
        app: "custom-app",
        identity: { state: "known", application: "custom-app" },
        runUrl: "https://github.com/octo/todo/actions/runs/42"
      };
      h.setDeploymentResolver(async () => recorded);
      h.state.deployAppName = "custom-app";
      h.state.deployStatus = "complete";
      const graph = [
        { id: "web", name: "web", type: "Radius.Compute/containers" }
      ];
      h.state.deployedGraph = graph;
      const entry = await container!.getOrCreate("panel");
      const listing = (await (
        await fetch(`${entry.baseUrl}/api/list-deployments?repo=octo/todo`)
      ).json()) as { deployments: DeploymentRow[] };
      expect(listing).toEqual({ deployments: [recorded] });
      const displayed = listing.deployments[0];
      if (scenario === "stale") recorded.deploymentId = "replacement";
      if (scenario === "unavailable")
        recorded.identity = {
          state: "unavailable",
          reason: "Identity artifact expired."
        };
      const response = await post(
        entry.baseUrl,
        "/api/delete-deployment",
        JSON.stringify({
          repo: "octo/todo",
          environment: displayed.environment,
          application: scenario === "default-name" ? "todo-app" : displayed.app,
          deploymentId: displayed.deploymentId,
          runUrl: displayed.runUrl
        })
      );
      expect(response.status).toBe(scenario === "matching" ? 200 : 409);
      if (scenario === "matching") {
        expect(h.dispatches).toHaveLength(1);
        expect(h.dispatches[0]).toContain("application=custom-app");
      } else {
        expect(h.dispatches).toEqual([]);
        expect(h.workflowSyncs).toEqual([]);
        expect(h.state.deployedGraph).toBe(graph);
        expect(h.state.deployStatus).toBe("complete");
      }
    }
  );

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
      runUrl: "https://github.com/octo/todo/actions/runs/7",
      forced: false
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
        "-f",
        "correlation_id=dep-fixture",
        "--repo",
        "octo/todo"
      ]
    ]);
    // The within-slice invalidation: the reader and the invalidator now live in
    // the same module, so this is proven rather than assumed.
    expect(harness.cache.has("octo/todo")).toBe(false);
  });

  it("discards the deleted application's graph state over a real socket", async () => {
    // The workflow removes this application's deploy-status artifact, but the
    // session that pressed Delete holds its own copy. Proven end to end because
    // both the delete route and the state it clears are read back through the
    // real container, not a handler-level fake.
    const harness = start();
    harness.environments.push("dev");
    Object.assign(harness.state, {
      deployEnvName: "dev",
      deployAppName: "todo-app",
      deployStatus: "complete",
      deployRunId: 7,
      deployedGraph: [{ name: "frontend" }],
      deployedGraphRepo: "octo/todo",
      deployingResources: [{ name: "frontend", deployStatus: "success" }]
    });
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

    expect(response.status).toBe(200);
    expect(harness.state.deployedGraph).toBeNull();
    expect(harness.state.deployedGraphRepo).toBeUndefined();
    expect(harness.state.deployingResources).toBeNull();
    expect(harness.state.deployStatus).toBe("");
    expect(harness.state.deployRunId).toBeNull();
  });

  it("keeps another application's graph state when one application is deleted", async () => {
    const harness = start();
    harness.environments.push("dev");
    Object.assign(harness.state, {
      deployEnvName: "dev",
      deployAppName: "storefront",
      deployStatus: "complete",
      deployedGraph: [{ name: "frontend" }]
    });
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

    expect(response.status).toBe(200);
    expect(harness.state.deployedGraph).toEqual([{ name: "frontend" }]);
    expect(harness.state.deployStatus).toBe("complete");
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

  // The force path is destructive in a way the ordinary delete is not: it drops
  // control-plane records whose external resources may still exist. These cases
  // prove the real probe, the real precondition and the real dispatch agree
  // over a real socket.
  it("offers the force delete only once the failed run's artifact proves the conflict", async () => {
    const harness = start();
    harness.setDeploymentStatus("delete-failed");
    harness.setDeploymentResolver((_repo, environment) =>
      Promise.resolve({
        app: "todo-app",
        identity: { state: "known", application: "todo-app" },
        environment,
        provider: "azure",
        status: "delete-failed",
        deploymentId: `dep-${environment}`,
        runUrl: "https://github.com/octo/todo/actions/runs/7"
      })
    );
    harness.artifacts.push({
      id: 11,
      name: "rad-delete-result",
      workflow_run: { id: 7 }
    });
    harness.setArtifactFiles({
      "rad-delete-result.json": JSON.stringify({
        resourceType: "application",
        name: "todo-app",
        outcome: "failed",
        forced: false,
        output:
          'code Conflict: err the target resource is in progress state: "Updating"'
      })
    });
    const entry = await container!.getOrCreate("panel-a");

    const probe = await fetch(
      `${entry.baseUrl}/api/delete-conflict?repo=octo%2Ftodo&environment=dev&application=todo-app`
    );
    expect(probe.status).toBe(200);
    expect(probe.headers.get("cache-control")).toBe("no-store");
    expect(await probe.json()).toEqual({
      conflict: true,
      resourceState: "Updating",
      forced: false,
      detail: ""
    });

    const response = await post(
      entry.baseUrl,
      "/api/delete-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app",
        force: true
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      runUrl: "https://github.com/octo/todo/actions/runs/7",
      forced: true
    });
    expect(harness.dispatches[0]).toContain("force=true");
  });

  // The POST must stand on its own evidence. A client that skips the probe, or
  // whose probe went stale because a later ordinary retry failed for an
  // unrelated reason, must not be able to force a delete.
  it.each([
    [
      "the failed run left no artifact",
      null,
      "The previous delete failure could not be verified, so this delete was not forced:"
    ],
    [
      "the artifact is malformed",
      { "rad-delete-result.json": "{not json" },
      "The previous delete failure could not be verified, so this delete was not forced:"
    ],
    [
      "the delete failed for an unrelated reason",
      {
        "rad-delete-result.json": JSON.stringify({
          resourceType: "application",
          name: "todo-app",
          outcome: "failed",
          forced: false,
          output: "ERROR: failed to authenticate with the cloud provider"
        })
      },
      "The previous delete did not fail because a resource was stuck in a non-terminal state"
    ]
  ])(
    "refuses a forced delete over a real socket when %s",
    async (_case, files, expected) => {
      const harness = start();
      harness.setDeploymentStatus("delete-failed");
      harness.setDeploymentResolver((_repo, environment) =>
        Promise.resolve({
          app: "todo-app",
          identity: { state: "known", application: "todo-app" },
          environment,
          provider: "azure",
          status: "delete-failed",
          deploymentId: `dep-${environment}`,
          runUrl: "https://github.com/octo/todo/actions/runs/7"
        })
      );
      harness.artifacts.push({
        id: 11,
        name: "rad-delete-result",
        workflow_run: { id: 7 }
      });
      harness.setArtifactFiles(files);
      const entry = await container!.getOrCreate("panel-a");

      const response = await post(
        entry.baseUrl,
        "/api/delete-deployment",
        JSON.stringify({
          repo: "octo/todo",
          environment: "dev",
          application: "todo-app",
          force: true
        })
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain(
        expected
      );
      // Nothing was dispatched, so no external resource can be orphaned.
      expect(harness.dispatches).toEqual([]);
    }
  );

  it("reports no conflict over a real socket when the failed run left no artifact", async () => {
    const harness = start();
    harness.setDeploymentResolver((_repo, environment) =>
      Promise.resolve({
        app: "todo-app",
        identity: { state: "known", application: "todo-app" },
        environment,
        provider: "azure",
        status: "delete-failed",
        deploymentId: `dep-${environment}`,
        runUrl: "https://github.com/octo/todo/actions/runs/7"
      })
    );
    const entry = await container!.getOrCreate("panel-a");

    const probe = await fetch(
      `${entry.baseUrl}/api/delete-conflict?repo=octo%2Ftodo&environment=dev&application=todo-app`
    );
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as {
      conflict: boolean;
      detail: string;
    };
    expect(body.conflict).toBe(false);
    expect(body.detail).toContain("rad-delete-result");
  });

  it("refuses an incomplete conflict probe over a real socket", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/delete-conflict?repo=octo%2Ftodo`
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A valid repo, environment, and application are required."
    });
  });

  it("refuses to force a delete that has not failed, over a real socket", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/delete-deployment",
      JSON.stringify({
        repo: "octo/todo",
        environment: "dev",
        application: "todo-app",
        force: true
      })
    );

    expect(response.status).toBe(409);
    expect(harness.dispatches).toEqual([]);
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

  it("attests an unknown terminal run over HTTP only with a fresh revision and exact typed token", async () => {
    const h = start();
    const runUrl = "https://github.com/octo/todo/actions/runs/42";
    const recovery = {
      runId: 42,
      runAttempt: 1,
      revision: "a".repeat(64),
      deploymentIds: ["7", "8"],
      confirmation: "octo/todo/run-42@1/dev",
      canMarkCleanupComplete: true
    };
    h.setDeploymentResolver(async () =>
      h.ghApiCalls.some((args) => args.includes("POST")) ?
        null
      : {
          app: "",
          environment: "dev",
          status: "failed",
          provider: "azure",
          runUrl,
          deploymentId: "7",
          identity: { state: "unavailable", reason: "Artifact expired" },
          recovery
        }
    );
    const entry = await container!.getOrCreate("panel-a");
    const body = {
      repo: "octo/todo",
      environment: "dev",
      application: "",
      deploymentId: "7",
      runUrl,
      ...recovery
    };
    const wrong = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({ ...body, confirmation: "wrong" })
    );
    expect(wrong.status).toBe(400);
    await wrong.text();
    const stale = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify({ ...body, revision: "b".repeat(64) })
    );
    expect(stale.status).toBe(409);
    await stale.text();
    const accepted = await post(
      entry.baseUrl,
      "/api/abandon-deployment",
      JSON.stringify(body)
    );
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(h.ghApiCalls.filter((args) => args.includes("POST"))).toHaveLength(
      2
    );
    expect(h.dispatches).toEqual([]);
    expect(h.workflowSyncs).toEqual([]);
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

  it("lists active and healthy environments despite unreadable older history and refuses active cleanup", async () => {
    const harness = start();
    harness.environments.push("dev", "healthy");
    harness.setDeploymentResolver((repo, environment, application) =>
      resolveEnvironmentDeployment(repo, environment, application, {
        readApplicationIdentity: async () => ({
          state: "known",
          application: "todo-app"
        }),
        ghOrThrow: async (args) => {
          const endpoint = args[1];
          if (endpoint.includes("/variables?")) return "AZURE_CLIENT_ID";
          if (endpoint.includes("/deployments?"))
            return environment === "dev" ? "2\n1" : "3";
          const deployment = /\/deployments\/(\d+)\/statuses/.exec(endpoint);
          if (deployment) {
            const id = deployment[1];
            return `${id === "2" ? "in_progress" : "success"}\thttps://github.com/${repo}/actions/runs/${id}\t`;
          }
          const run = /\/actions\/runs\/(\d+)$/.exec(endpoint);
          if (run) {
            if (run[1] === "1") throw new Error("HTTP 404: older run missing");
            return [
              ".github/workflows/run-rad-commands.yml",
              run[1] === "2" ? "waiting" : "completed",
              run[1] === "2" ? "" : "success",
              "1",
              "a".repeat(40),
              "",
              run[1],
              repo,
              "workflow_dispatch"
            ].join("\t");
          }
          throw new Error(`Unexpected resolver operation: ${endpoint}`);
        },
        deployWorkflowFile: "run-rad-commands.yml",
        deleteWorkflowFile: "delete-application.yml",
        maxParallelRecords: 10
      })
    );
    const entry = await container!.getOrCreate("panel-a");
    const listing = await fetch(
      `${entry.baseUrl}/api/list-deployments?repo=octo/todo`
    );
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual({
      deployments: [
        {
          app: "todo-app",
          identity: { state: "known", application: "todo-app" },
          environment: "dev",
          provider: "azure",
          status: "pending",
          deploymentId: "2",
          runUrl: "https://github.com/octo/todo/actions/runs/2"
        },
        {
          app: "todo-app",
          identity: { state: "known", application: "todo-app" },
          environment: "healthy",
          provider: "azure",
          status: "success",
          deploymentId: "3",
          runUrl: "https://github.com/octo/todo/actions/runs/3"
        }
      ]
    });
    for (const recovery of [
      {},
      {
        runId: 2,
        runAttempt: 1,
        revision: "a".repeat(64),
        confirmation: "todo-app/dev",
        deploymentId: "2",
        runUrl: "https://github.com/octo/todo/actions/runs/2"
      }
    ]) {
      const cleanup = await post(
        entry.baseUrl,
        "/api/abandon-deployment",
        JSON.stringify({
          repo: "octo/todo",
          environment: "dev",
          application: "todo-app",
          ...recovery
        })
      );
      expect(cleanup.status).toBe(409);
      expect(await cleanup.json()).toMatchObject({ error: expect.any(String) });
    }
    expect(harness.ghApiCalls.some((args) => args.includes("--method"))).toBe(
      false
    );
    expect(harness.state.deploymentMutation).toBeUndefined();
  });

  it.each([false, true])(
    "rescans real history after grouped cleanup with partial failure: %s",
    async (partial) => {
      const harness = start();
      const markers = new Map<string, string>();
      const writes: string[][] = [];
      const gh = async (args: string[]): Promise<string> => {
        const endpoint = args.find((arg) => arg.startsWith("/repos/"));
        if (endpoint === "/repos/octo/todo/environments?per_page=100")
          return "dev";
        if (
          endpoint ===
          "/repos/octo/todo/environments/dev/variables?per_page=100"
        )
          return "AZURE_CLIENT_ID";
        if (
          endpoint ===
          "/repos/octo/todo/deployments?per_page=100&environment=dev"
        )
          return "8\n7\n6";
        const deployment = /\/deployments\/([678])\/statuses/.exec(
          endpoint ?? ""
        );
        if (deployment) {
          const id = deployment[1];
          if (args.includes("POST")) {
            writes.push(args);
            if (partial && id === "7")
              throw new Error("Fixture marker write refused");
            const description = args.find((arg) =>
              arg.startsWith("description=")
            );
            if (!description) throw new Error("Missing marker description");
            markers.set(id, description.slice("description=".length));
            return "";
          }
          if (args.at(-1) === '.[0].description // ""')
            return markers.get(id) ?? "";
          return [
            markers.has(id) ? "inactive"
            : id === "6" ? "success"
            : "failure",
            `https://github.com/octo/todo/actions/runs/${id === "6" ? 41 : 42}`,
            markers.get(id) ?? ""
          ].join("\t");
        }
        const run = /\/actions\/runs\/(41|42)$/.exec(endpoint ?? "");
        if (run)
          return [
            ".github/workflows/run-rad-commands.yml",
            "completed",
            run[1] === "41" ? "success" : "failure",
            "1",
            "a".repeat(40),
            "",
            run[1],
            "octo/todo",
            "workflow_dispatch"
          ].join("\t");
        throw new Error(`Unexpected GitHub operation: ${JSON.stringify(args)}`);
      };
      harness.setGhOrThrow(gh);
      harness.setDeploymentResolver((repo, environment, application) =>
        resolveEnvironmentDeployment(repo, environment, application, {
          readApplicationIdentity: async (_repo, _environment, runId) =>
            runId === 42 ?
              { state: "unavailable", reason: "Identity artifacts expired." }
            : { state: "known", application: "todo-app" },
          ghOrThrow: gh,
          deployWorkflowFile: "run-rad-commands.yml",
          deleteWorkflowFile: "delete-application.yml",
          maxParallelRecords: 10
        })
      );
      const entry = await container!.getOrCreate("panel-a");
      const list = () =>
        fetch(`${entry.baseUrl}/api/list-deployments?repo=octo%2Ftodo`);
      const initial = await list();
      expect(initial.status).toBe(200);
      const current: DeploymentRow = (await initial.json()).deployments[0];
      expect(current.recovery).toMatchObject({
        runId: 42,
        runAttempt: 1,
        canMarkCleanupComplete: true,
        confirmation: "octo/todo/run-42@1/dev"
      });
      if (!current.recovery) throw new Error("Missing recovery evidence");
      expect(harness.cache.has("octo/todo")).toBe(true);
      const response = await post(
        entry.baseUrl,
        "/api/abandon-deployment",
        JSON.stringify({
          repo: "octo/todo",
          environment: "dev",
          application: current.app,
          deploymentId: current.deploymentId,
          runUrl: current.runUrl,
          ...current.recovery
        })
      );
      expect(response.status).toBe(partial ? 502 : 200);
      expect(await response.json()).toMatchObject(
        partial ?
          { error: expect.stringContaining("Cloud resources were not changed") }
        : { outcome: "abandoned" }
      );
      expect(harness.cache.has("octo/todo")).toBe(false);
      const marker = `Radius cleanup v1 run:42 attempt:1 rev:${current.recovery.revision}`;
      expect(writes).toHaveLength(2);
      for (const [index, args] of writes.entries())
        expect(args).toEqual([
          "api",
          "--method",
          "POST",
          `/repos/octo/todo/deployments/${index === 0 ? 8 : 7}/statuses`,
          "-f",
          "state=inactive",
          "-F",
          "auto_inactive=false",
          "-f",
          `description=${marker}`,
          "-f",
          "log_url=https://github.com/octo/todo/actions/runs/42"
        ]);
      expect(markers.get("8")).toBe(marker);
      expect(markers.get("7")).toBe(partial ? undefined : marker);
      expect(markers.has("6")).toBe(false);
      const refreshed = await list();
      expect(refreshed.status).toBe(200);
      expect((await refreshed.json()).deployments).toMatchObject([
        {
          deploymentId: partial ? "8" : "6",
          runUrl: `https://github.com/octo/todo/actions/runs/${partial ? 42 : 41}`,
          status: partial ? "failed" : "success"
        }
      ]);
      expect(harness.dispatches).toEqual([]);
      expect(harness.workflowSyncs).toEqual([]);
    }
  );

  it("fails closed over a real socket when the newest deployment cannot be identified", async () => {
    const harness = start();
    const resolverCalls: string[][] = [];
    harness.setDeploymentResolver((repo, environment, application) =>
      resolveEnvironmentDeployment(repo, environment, application, {
        readApplicationIdentity: async () => {
          throw new Error("Unexpected identity read");
        },
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
        readApplicationIdentity: async () => ({
          state: "known",
          application: "todo-app"
        }),
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
  runtime: DeploymentRuntime;
  views: ReturnType<typeof createDeploymentViews>;
  monitorCalls: DeployMonitorRequest[];
  branchLookups: string[][];
  handoffs: string[];
  observationDelays: number[];
  stateOf(instanceId: string): CanvasState;
  settleMonitor(error?: Error): Promise<void>;
  setPersistedDeployment(row: DeploymentRow | null): void;
  failPersistedLookup(failure: boolean): void;
}

function startDeploy(
  monitorOverride?: DeployMonitorService,
  callbacks: {
    readModelForSelection?: DeployRequestDependencies["readModelForSelection"];
    deletion?: Pick<
      DeploymentsDependencies,
      "runGh" | "findWorkflowRun" | "logError" | "setTimer"
    >;
    delivery?: Pick<
      DeploymentRuntimePorts["delivery"],
      "sendRepair" | "sendNotice"
    >;
    runCommand?(command: string, args: string[]): Promise<string>;
    onMonitorSettled?(
      state: import("@radius-project/core").DeploymentState
    ): void;
  } = {}
): DeployHarness {
  const monitorCalls: DeployMonitorRequest[] = [];
  const branchLookups: string[][] = [];
  const handoffs: string[] = [];
  const observationDelays: number[] = [];
  const pendingMonitors: {
    release(error?: Error): void;
    promise: Promise<void>;
  }[] = [];
  let persisted: DeploymentRow | null = null;
  let persistedFails = false;

  let sequence = 0;
  const runtime = createTestDeploymentRuntime({
    normalizeAppFile: normalizeDeploymentAppFile,
    awsEnabled: true,
    id: () => String(++sequence),
    reportError: () => {},
    statusBlocksMutation: deploymentStatusBlocksMutation,
    resolveDeployment: () =>
      persistedFails ?
        Promise.reject(new Error("gh unreachable"))
      : Promise.resolve(persisted),
    resolveDefaultBranch: async (repo) => {
      const args = [
        "repo",
        "view",
        repo,
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name"
      ];
      branchLookups.push(args);
      return callbacks.runCommand ?
          callbacks.runCommand("gh", args)
        : Promise.resolve("release/7\n");
    },
    delivery: {
      sendRepair: (input) => {
        handoffs.push(input.instanceId || "");
      },
      ...callbacks.delivery,
      redactDiagnostic: redactCredentials,
      reportDiagnostic: () => {}
    },
    createExecution: () => ({
      observation: createWorkflowObservationScope(
        () => {
          throw new Error("Unexpected reader construction");
        },
        {
          monotonic: () => 1,
          wall: () => 1,
          jitter: () => 0,
          sleep: async (milliseconds) => {
            observationDelays.push(milliseconds);
          }
        }
      ),
      monitor: {
        async run(request) {
          try {
            if (monitorOverride) await monitorOverride.run(request);
            else {
              monitorCalls.push(request);
              const pending = createDeferred<void>();
              pendingMonitors.push({
                release: (error) =>
                  error ? pending.reject(error) : pending.resolve(),
                promise: pending.promise
              });
              await pending.promise;
              request.entry.state.deployStatus = "success";
            }
          } finally {
            callbacks.onMonitorSettled?.(request.entry.state);
          }
        }
      }
    })
  });
  const views = createDeploymentViews(runtime);
  const deployRequest = createDeployRequestService({
    runtime,
    plannedGraph: { recover: async () => null },
    readModelForSelection:
      callbacks.readModelForSelection ??
      (async () => ({
        status: "available",
        content: "model",
        fromWorkspace: true
      })),
    attach: views.attach,
    readDeploymentDefaults: views.defaults,
    readInstanceEntry: (instanceId) => container?.instances.get(instanceId),
    reportError: (error) => {
      throw error;
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  });

  const routes = createTestRouteTable(
    createDeploymentsRoutes({
      id: () => "fixture",
      isValidRepoSlug,
      deleteApplicationWorkflowFiles: [],
      readInstanceEntry: (instanceId) => {
        const entry = container?.instances.get(instanceId);
        if (entry) views.refresh(instanceId, entry.state);
        return entry;
      },
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
      listEnvDeployment: () =>
        Promise.resolve({ deployment: null, incomplete: false }),
      ghOrThrow: () => Promise.resolve(""),
      resetDeploymentViewState: views.reset,
      captureDeletedDeployment: views.captureDeletion,
      logError: (message) => {
        throw new Error(message);
      },
      deployListCache: new Map<string, DeployListCacheEntry>(),
      deployListTtlMs: 15000,
      activeDeploymentMutation: () => undefined,
      reserveDeploymentMutation: views.reserve,
      releaseDeploymentMutation: views.release,
      deploymentStatusBlocksMutation: () => false,
      localDeploymentBlocksMutation: () => false,
      ensureWorkflowsCurrent: () =>
        Promise.resolve({ created: [], failed: [] }),
      findWorkflowRun: () => Promise.resolve(null),
      runGh: () => {
        throw new Error("the deploy harness must not run gh");
      },
      probeDeleteConflict: () => {
        throw new Error("the deploy harness must not probe delete conflicts");
      },
      readProcessEnv: () => ({}),
      setTimer: () => ({}),
      deployRequest,
      abandonment: {
        abandon: () => {
          throw new Error("the deploy harness must not abandon deployments");
        }
      },
      awsTrustRepair: {
        repair: () => {
          throw new Error("the deploy harness must not repair AWS trust");
        }
      },
      ...callbacks.deletion
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
  deploymentHarness = {
    runtime,
    views,
    async cleanup() {
      for (const pending of pendingMonitors) pending.release();
      await Promise.all(
        pendingMonitors.map((pending) => pending.promise.catch(() => {}))
      );
      await runtime.owner.shutdown(1000);
    }
  };

  return {
    runtime,
    views,
    monitorCalls,
    branchLookups,
    handoffs,
    observationDelays,
    stateOf: (instanceId) => {
      const entry = container?.instances.get(instanceId);
      if (!entry) throw new Error(`no instance ${instanceId}`);
      return entry.state;
    },
    async settleMonitor(error) {
      for (const pending of pendingMonitors) pending.release(error);
      await Promise.all(
        pendingMonitors.map((pending) => pending.promise.catch(() => {}))
      );
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
  const harness = deploymentHarness;
  if (!harness) throw new Error("Missing deployment runtime");
  const target = {
    repo: "acme/widgets",
    environment: "production",
    branch: "feat",
    provider: "azure",
    appFile: ".radius/app.bicep"
  };
  const reservation = harness.runtime.owner.reserve(target, "deploy");
  if (!reservation) throw new Error("Target is busy");
  const invocation = harness.runtime.owner.begin(
    target,
    { deployStatus: "failed", ...extra },
    reservation
  );
  invocation.state.deployAttempt = {
    ...target,
    targetRepo: target.repo,
    id: invocation.attemptId
  };
  harness.runtime.owner.release(reservation);
  const entry = [...(container?.instances ?? [])].find(
    ([, entry]) => entry.state === state
  );
  if (!entry) throw new Error("Missing panel");
  harness.views.attach(entry[0], state, invocation);
}

describe("POST /api/deploy/repair-aws-trust real-loopback HIT", () => {
  const ROLE_ARN = "arn:aws:iam::123456789012:role/radius-deploy-octo-todo";
  const failedSignIn = (state: CanvasState): void => {
    Object.assign(state, {
      deployStatus: "failed",
      deployErrorKind: DEPLOY_CLOUD_AUTH_DRIFT_KIND,
      deployingRepo: "octo/stale",
      deployEnvName: "stale",
      deployGeneration: 3,
      deployAttempt: {
        id: "attempt-1",
        targetRepo: "octo/todo",
        environment: "dev"
      }
    });
  };

  it("repairs the role of the deploy that failed to sign in, ignoring all but the generation", async () => {
    const harness = start();
    failedSignIn(harness.state);
    harness.setEnvironmentTarget({
      provider: "aws",
      clientId: "",
      tenantId: "",
      repoId: 0,
      roleArn: ROLE_ARN,
      trustSubjects: ["repo:octo/todo:environment:dev"],
      region: "",
      cluster: ""
    });
    harness.setTrustRepairResult({
      ok: true,
      roleName: "radius-deploy-octo-todo",
      added: ["repo:octo/todo:environment:dev"]
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/deploy/repair-aws-trust",
      JSON.stringify({ repo: "evil/repo", environment: "prod", generation: 3 })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code: "aws-trust-repaired",
      added: ["repo:octo/todo:environment:dev"],
      message:
        "IAM role radius-deploy-octo-todo trusts environment dev again. Radius added back repo:octo/todo:environment:dev. Deploy again."
    });
    expect(harness.trustRepairs).toEqual([
      {
        repo: "octo/todo",
        environment: "dev",
        roleArn: ROLE_ARN,
        confirmTarget: expect.any(Function)
      }
    ]);
  });

  it("refuses when this canvas has no deploy that failed to sign in", async () => {
    const harness = start();
    harness.state.deployStatus = "failed";
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/deploy/repair-aws-trust",
      JSON.stringify({ generation: 0 })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "repair-not-applicable"
    });
    expect(harness.trustRepairs).toEqual([]);
  });

  it("refuses Repair while the AWS developer switch is off, changing nothing", async () => {
    const harness = start({}, { awsEnabled: false });
    failedSignIn(harness.state);
    harness.setEnvironmentTarget({
      provider: "aws",
      clientId: "",
      tenantId: "",
      repoId: 0,
      roleArn: ROLE_ARN,
      trustSubjects: [],
      region: "",
      cluster: ""
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/deploy/repair-aws-trust",
      JSON.stringify({ generation: 3 })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "provider-unsupported",
      error:
        "AWS environments aren't supported yet, so Radius repaired nothing."
    });
    expect(harness.trustRepairs).toEqual([]);
  });

  it("answers 400 for a body that is not JSON, rather than calling the deploy stale", async () => {
    const harness = start();
    failedSignIn(harness.state);
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/deploy/repair-aws-trust",
      "not json"
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "repair-request-invalid"
    });
    expect(harness.trustRepairs).toEqual([]);
  });

  it("refuses a panel that shows an earlier deploy", async () => {
    const harness = start();
    failedSignIn(harness.state);
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/deploy/repair-aws-trust",
      JSON.stringify({ generation: 2 })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "repair-stale" });
    expect(harness.trustRepairs).toEqual([]);
  });

  it("refuses an environment that is not set up for AWS", async () => {
    const harness = start();
    failedSignIn(harness.state);
    harness.setEnvironmentTarget({
      provider: "azure",
      clientId: "app",
      tenantId: "tenant",
      repoId: 1,
      roleArn: "",
      trustSubjects: [],
      region: "",
      cluster: ""
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/deploy/repair-aws-trust",
      JSON.stringify({ generation: 3 })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "repair-not-aws" });
    expect(harness.trustRepairs).toEqual([]);
  });
});

describe("POST /api/deploy real-loopback HIT (RF-07)", () => {
  it.each([
    {
      name: "genuine empty managed uses root",
      appFile: undefined,
      managed: "",
      root: true,
      selected: "app.bicep",
      dispatched: true
    },
    {
      name: "unavailable nonempty managed never uses root",
      appFile: undefined,
      managed: "model",
      metadata: { encoding: "none", size: 1_048_577, content: "" },
      root: true,
      selected: undefined,
      dispatched: false,
      refused: true
    },
    {
      name: "explicit unavailable managed never uses root",
      appFile: ".radius/app.bicep",
      managed: "model",
      metadata: { encoding: "none", size: 1_048_577, content: "" },
      root: true,
      selected: ".radius/app.bicep",
      dispatched: false
    },
    {
      name: "truncated managed never uses root",
      appFile: undefined,
      managed: "model",
      metadata: { encoding: "base64", size: 100, content: "" },
      root: true,
      selected: undefined,
      dispatched: false,
      refused: true
    },
    {
      name: "root-only omission",
      appFile: undefined,
      managed: null,
      root: true,
      selected: "app.bicep",
      dispatched: true
    },
    {
      name: "explicit root-only",
      appFile: "app.bicep",
      managed: null,
      root: true,
      selected: "app.bicep",
      dispatched: true
    },
    {
      name: "managed precedence",
      appFile: undefined,
      managed: "model",
      root: true,
      selected: ".radius/app.bicep",
      dispatched: true
    },
    {
      name: "explicit root with both models",
      appFile: "app.bicep",
      managed: "model",
      root: true,
      selected: "app.bicep",
      dispatched: true
    },
    {
      name: "missing explicit root",
      appFile: "app.bicep",
      managed: "model",
      root: false,
      selected: "app.bicep",
      dispatched: false
    },
    {
      name: "whitespace managed must not fall back",
      appFile: undefined,
      managed: "  ",
      root: true,
      selected: ".radius/app.bicep",
      dispatched: false
    }
  ])(
    "preserves model selection through the real request and monitor: $name",
    async ({ appFile, managed, root, selected, dispatched, ...scenario }) => {
      const unexpected = () => {
        throw new Error("Unexpected external operation in root-model deploy");
      };
      const calls: string[][] = [];
      const reads: string[] = [];
      const model =
        "resource app 'Applications.Core/applications@2023-10-01-preview' = { name: 'root-app' }";
      const repository = createDeploymentRepository({
        redactDiagnostic: String,
        execute: (_command, args, _options, callback) => {
          expect(args[0]).toBe("api");
          expect(args).toHaveLength(2);
          const path =
            args[1].includes("/contents/.radius/app.bicep?") ?
              ".radius/app.bicep"
            : "app.bicep";
          expect(args[1]).toBe(
            `/repos/acme/widgets/contents/${path}?ref=feature/root`
          );
          reads.push(path);
          const content =
            path === ".radius/app.bicep" ?
              managed === "model" ?
                model
              : managed
            : root ? model
            : null;
          if (content === null)
            callback({ code: 1 }, "", "Not Found (HTTP 404)");
          else
            callback(
              null,
              JSON.stringify(
                path === ".radius/app.bicep" && "metadata" in scenario ?
                  scenario.metadata
                : {
                    content: Buffer.from(content).toString("base64"),
                    encoding: "base64",
                    size: Buffer.byteLength(content)
                  }
              ),
              ""
            );
          return {};
        }
      });
      const readModelForSelection = createDeployModelSource({
        readWorkspace: async () => null,
        readRepository: repository.readFileResult,
        redactDiagnostic: String
      });
      const dispatch = createDeployDispatchService({
        id: () => "root-model",
        deployWorkflowFile: "run-rad-commands.yml",
        deployWorkflowFiles: ["run-rad-commands.yml"],
        branchNotPushedKind: "branch-not-pushed",
        oidcSubjectMissingKind: "oidc-subject-missing",
        oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
        getBranchHeadSha: async () => "head",
        getDefaultBranch: unexpected,
        runGh: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
        runGhWithStdin: unexpected,
        runAz: unexpected,
        runGitHubJson: unexpected,
        readProcessEnv: () => ({}),
        ghCredentialSource: () => "keyring",
        fetchFileForSelection: (_entry, repo, branch, path) =>
          repository.readFile(repo, path, branch),
        appParams,
        resolveDeployParams,
        partitionParams,
        extractAppName,
        buildDeployRadCommand,
        buildAppGraphRadCommand,
        ensureDeployWorkflowsOnBranch: async () => {},
        ensureWorkflowsCurrent: async () => ({ created: [], updated: [] }),
        verifyAppFileInput: async () => {},
        sleep: unexpected,
        latestWorkflowRunId: async () => 10,
        classifyDeployDispatchFailure: unexpected,
        uncommittedGeneratedPaths: unexpected,
        invalidateDeployListCache: () => {},
        errorMessage: String,
        now: () => 1
      });
      const observed = createUnconfirmedMonitor(null, dispatch);
      const h = startDeploy(observed.monitor, {
        readModelForSelection
      });
      const entry = await container!.getOrCreate("panel-a");
      const response = await post(
        entry.baseUrl,
        "/api/deploy",
        deployBody({ provider: "aws", branch: "feature/root", appFile })
      );
      if ("refused" in scenario && scenario.refused) {
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: expect.stringMatching(/content|base64/)
        });
        expect(reads).toEqual([".radius/app.bicep"]);
        expect(calls).toEqual([]);
        expect(h.stateOf("panel-a").deployAttempt).toBeUndefined();
        expect(activeDeploymentMutation(h.stateOf("panel-a"))).toBeUndefined();
        return;
      }
      expect(response.status).toBe(200);
      await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
      expect(h.stateOf("panel-a").deployAttempt?.appFile).toBe(selected);
      if (dispatched) {
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain(`app_file=${selected}`);
        expect(calls[0]).toContain("feature/root");
        expect(
          calls[0].find((arg) => arg.startsWith("rad_commands="))
        ).toContain(`deploy ${selected}`);
      } else {
        expect(calls).toEqual([]);
        if (appFile === ".radius/app.bicep")
          expect(reads).toEqual([".radius/app.bicep"]);
        expect(h.stateOf("panel-a").deployErrorKind).toBe(
          "model-preflight-failed"
        );
      }
    }
  );

  it("reports unavailable model selection without creating a runtime attempt or retaining a lease", async () => {
    const h = startDeploy(undefined, {
      readModelForSelection: async () => ({
        status: "unavailable",
        error: "GitHub unavailable"
      })
    });
    const entry = await container!.getOrCreate("panel-a");
    const response = await post(
      entry.baseUrl,
      "/api/deploy",
      deployBody({ appFile: undefined })
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("GitHub unavailable")
    });
    expect(h.runtime.owner.lookup()).toEqual({ kind: "missing" });
    expect(h.runtime.owner.hasActiveWork()).toBe(false);
    expect(h.monitorCalls).toEqual([]);
  });

  it.each([null, 42, "../app.bicep", ""])(
    "rejects malformed HTTP model path %j before shared admission",
    async (appFile) => {
      const h = startDeploy();
      const entry = await container!.getOrCreate("panel-a");
      const response = await post(
        entry.baseUrl,
        "/api/deploy",
        deployBody({ appFile })
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
      expect(h.runtime.owner.lookup()).toEqual({ kind: "missing" });
      expect(h.runtime.owner.hasActiveWork()).toBe(false);
      expect(h.monitorCalls).toEqual([]);
    }
  );

  it.each(
    [
      ["run-rad-commands.yml", "workflow_dispatch", "app_file"],
      ["run-rad-commands.yml", "workflow_dispatch", "correlation_id"],
      ["run-rad-commands-azure.yml", "workflow_call", "app_file"]
    ].flatMap(([legacyFile, trigger, input]) =>
      ["missing", "wrong type"].map((shape) => ({
        legacyFile,
        trigger,
        input,
        shape
      }))
    )
  )(
    "refuses installed $legacyFile $shape $input before secret access or dispatch",
    async ({ legacyFile, trigger, input, shape }) => {
      const unexpected = () => {
        throw new Error(
          "Incompatible workflows must stop before external execution"
        );
      };
      const repository = createDeploymentRepository({
        redactDiagnostic: String,
        execute: (_command, args, _options, callback) => {
          expect(args).toHaveLength(2);
          const file = args[1].match(
            /\/contents\/\.github\/workflows\/([^?]+)\?ref=feat$/
          )?.[1];
          const source = file ? deploymentTemplates[file] : undefined;
          if (!source) throw new Error(`Unexpected workflow ${args[1]}`);
          const document = parseDocument(source);
          if (file === legacyFile) {
            const path = ["on", trigger, "inputs", input];
            if (shape === "missing") document.deleteIn(path);
            else document.setIn(path, { type: "boolean" });
          }
          const content = document.toString();
          callback(
            null,
            JSON.stringify({
              content: Buffer.from(content).toString("base64"),
              encoding: "base64",
              size: Buffer.byteLength(content)
            }),
            ""
          );
          return {};
        }
      });
      const workflows = createDeploymentWorkflows(false, {
        readRepositoryFile: unexpected,
        now: () => 0,
        ghOrThrow: unexpected,
        readFile: repository.readFile,
        defaultBranch: unexpected,
        branchHead: unexpected,
        commitFile: unexpected,
        environmentProvider: unexpected,
        reportDiagnostic: unexpected
      });
      const runGh = vi.fn(unexpected);
      const runGhWithStdin = vi.fn(unexpected);
      const dispatch = createDeployDispatchService({
        id: () => "legacy-contract",
        deployWorkflowFile: "run-rad-commands.yml",
        deployWorkflowFiles: workflows.files,
        branchNotPushedKind: "branch-not-pushed",
        oidcSubjectMissingKind: "oidc-subject-missing",
        oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
        getBranchHeadSha: async () => "head",
        getDefaultBranch: unexpected,
        runGh,
        runGhWithStdin,
        runAz: unexpected,
        runGitHubJson: unexpected,
        readProcessEnv: () => ({}),
        ghCredentialSource: () => "keyring",
        fetchFileForSelection: async () => "model with a secure parameter",
        appParams: () => [],
        resolveDeployParams: () => ({ password: "generated-value" }),
        partitionParams: () => ({
          public: {},
          secret: { password: "generated-value" }
        }),
        extractAppName: () => "app",
        buildDeployRadCommand: () => "rad deploy",
        buildAppGraphRadCommand: () => "rad app graph",
        ensureDeployWorkflowsOnBranch: async () => {},
        ensureWorkflowsCurrent: async () => ({ created: [], updated: [] }),
        verifyAppFileInput: workflows.verifyAppFileInput,
        sleep: unexpected,
        latestWorkflowRunId: unexpected,
        classifyDeployDispatchFailure: unexpected,
        uncommittedGeneratedPaths: unexpected,
        invalidateDeployListCache: unexpected,
        errorMessage: String,
        now: () => 0
      });
      const observed = createUnconfirmedMonitor(null, dispatch);
      const harness = startDeploy(observed.monitor);
      const entry = await container!.getOrCreate("panel-a");
      const state = harness.stateOf("panel-a");
      const response = await post(
        entry.baseUrl,
        "/api/deploy",
        deployBody({ provider: "aws" })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      await expect.poll(() => state.deployStatus).toBe("failed");
      await expect.poll(() => activeDeploymentMutation(state)).toBeUndefined();
      const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        status: "failed",
        errorKind: "workflow-preflight-failed",
        error: expect.stringContaining("No workflow was dispatched.")
      });
      expect(runGh).not.toHaveBeenCalled();
      expect(runGhWithStdin).not.toHaveBeenCalled();
      expect(state.deployError).toContain(input);
      expect(state.deployError).toContain("Update the Radius workflows.");
      expect(observed.reads).toEqual([]);
      expect(state.deployHandoffState).not.toBe("pending");
    }
  );

  it("refuses a reserved model through real HTTP admission before any execution", async () => {
    const h = startDeploy();
    const entry = await container!.getOrCreate("panel");
    const response = await post(
      entry.baseUrl,
      "/api/deploy",
      JSON.stringify({
        targetRepo: "acme/widgets",
        branch: "feature",
        environment: "dev",
        appFile: "models/radius-environment.bicep"
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("reserved")
    });
    expect(h.runtime.owner.lookup()).toEqual({ kind: "missing" });
  });

  it("preserves an in-place replacement attempt while a delete waits for acceptance over HTTP", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    startDeploy(undefined, {
      deletion: {
        async runGh() {
          entered.resolve();
          await release.promise;
          return { code: 0, stdout: "", stderr: "" };
        },
        findWorkflowRun: async () => null,
        logError: () => {},
        setTimer: () => ({})
      }
    });
    const entry = await container!.getOrCreate("panel");
    const attempt = {
      id: "old",
      targetRepo: "acme/widgets",
      environment: "dev"
    };
    const graph = [
      { id: "web", name: "web", type: "Radius.Compute/containers" }
    ];
    Object.assign(entry.state, {
      contextRepo: "acme/widgets",
      envName: "dev",
      deployAttempt: attempt,
      deployAppName: "widgets",
      deployStatus: "complete",
      deployRunId: 42,
      deployedGraph: graph,
      deployingResources: graph
    });
    const response = post(
      entry.baseUrl,
      "/api/delete-deployment",
      JSON.stringify({
        repo: "acme/widgets",
        environment: "dev",
        application: "widgets"
      })
    );
    try {
      await entered.promise;
      attempt.id = "replacement";
    } finally {
      release.resolve();
    }
    expect((await response).status).toBe(200);
    expect(entry.state.deployAttempt).toBe(attempt);
    expect(entry.state.deployedGraph).toEqual(graph);
    expect(entry.state.deployRunId).toBe(42);
    expect(entry.state.deployStatus).toBe("complete");
  });

  it.each(["missing", "throwing"] as const)(
    "invalidates a completed tool deployment at delete acceptance, before %s run discovery, and allows fresh tool attachment",
    async (discovery) => {
      const findingRun = createDeferred<void>();
      const finishDiscovery = createDeferred<void>();
      let expire: (() => void) | undefined;
      const dispatch = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const logError = vi.fn();
      const h = startDeploy(
        {
          async run({ entry }) {
            entry.state.deployStatus = "complete";
            entry.state.deployAppName = "widgets";
            entry.state.deployRunId = 42;
            entry.state.deployedGraph = [
              { id: "web", name: "web", type: "Radius.Compute/containers" }
            ];
          }
        },
        {
          deletion: {
            runGh: dispatch,
            logError,
            setTimer(callback) {
              expire = callback;
              return {};
            },
            async findWorkflowRun() {
              findingRun.resolve();
              await finishDiscovery.promise;
              if (discovery === "throwing")
                throw new Error("Run lookup unavailable");
              return null;
            }
          }
        }
      );
      const sdk = await createRuntimeSdkHarness({}, (deps) => {
        deps.deployment = h.runtime;
      });
      try {
        const deploy = sdk.extension.tools.find(
          ({ name }) => name === "radius_deploy"
        );
        const status = sdk.extension.tools.find(
          ({ name }) => name === "radius_deploy_status"
        );
        if (!deploy || !status) throw new Error("Deployment tools missing");
        const target = {
          repo: "acme/widgets",
          branch: "feature",
          environment: "production"
        };
        await deploy.handler(target);
        await vi.waitFor(() =>
          expect(h.runtime.owner.hasActiveWork()).toBe(false)
        );
        const selected = h.runtime.owner.lookup();
        if (selected.kind !== "found") throw new Error("No tool deployment");
        const first = selected.invocation;
        const a = await container!.getOrCreate("panel-a");
        const b = await container!.getOrCreate("panel-b");
        for (const entry of [a, b]) {
          entry.state.contextRepo = target.repo;
          entry.state.envName = target.environment;
          expect(
            await (await fetch(`${entry.baseUrl}/api/deploy-status`)).json()
          ).toMatchObject({
            status: "complete",
            attempt: { id: first.attemptId }
          });
        }
        const deletion = post(
          a.baseUrl,
          "/api/delete-deployment",
          JSON.stringify({
            ...target,
            environment: "PRODUCTION",
            application: "widgets"
          })
        );
        await findingRun.promise;
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]).toEqual([
          expect.arrayContaining(["environment=PRODUCTION"])
        ]);
        expect(
          await status.handler({ observationId: first.observationId })
        ).toContain("No matching");
        expect(await status.handler({ attemptId: first.attemptId })).toContain(
          "No matching"
        );
        expect(await deploy.handler({ attemptId: first.attemptId })).toContain(
          "no longer current"
        );
        expect(await deploy.handler(target)).toContain("in progress");
        for (const entry of [a, b]) {
          await (
            await fetch(
              `${entry.baseUrl}/api/list-deployments?repo=acme/widgets`
            )
          ).json();
          for (let poll = 0; poll < 2; poll++) {
            const payload = await (
              await fetch(`${entry.baseUrl}/api/deploy-status`)
            ).json();
            expect(payload.status).toBe("pending");
            expect(payload.deployedGraph).toBeNull();
            expect(entry.state.deployRunId).toBeUndefined();
          }
        }
        finishDiscovery.resolve();
        const response = await deletion;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          success: true,
          runUrl: "",
          forced: false
        });
        expect(logError).toHaveBeenCalledTimes(
          discovery === "throwing" ? 1 : 0
        );
        const blocked = await post(
          b.baseUrl,
          "/api/delete-deployment",
          JSON.stringify({
            ...target,
            application: "widgets"
          })
        );
        expect(blocked.status).toBe(409);
        expect(dispatch).toHaveBeenCalledOnce();
        expire?.();
        await deploy.handler(target);
        await vi.waitFor(() =>
          expect(h.runtime.owner.hasActiveWork()).toBe(false)
        );
        const next = h.runtime.owner.lookup();
        if (next.kind !== "found") throw new Error("Missing fresh deployment");
        expect(next.invocation.attemptId).not.toBe(first.attemptId);
        for (const entry of [a, b]) {
          const payload = await (
            await fetch(`${entry.baseUrl}/api/deploy-status`)
          ).json();
          expect(payload.attempt.id).toBe(next.invocation.attemptId);
          expect(payload.status).toBe("complete");
        }
        expect(
          await status.handler({ observationId: first.observationId })
        ).toContain("No matching");
      } finally {
        finishDiscovery.resolve();
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each([
    { change: "created", exhausted: false },
    { change: "updated", exhausted: false },
    { change: "created", exhausted: true },
    { change: "updated", exhausted: true }
  ] as const)(
    "surfaces registration retry results for a $change dispatcher (exhausted: $exhausted)",
    async ({ change, exhausted }) => {
      const workflowDispatches: string[][] = [];
      const delays: number[] = [];
      let discoveries = 0;
      let settlements = 0;
      let latestRunId = 41;
      const unexpected = () => {
        throw new Error(
          "unexpected external operation in registration retry test"
        );
      };
      const dispatch = createDeployDispatchService({
        id: () => "execution",
        verifyAppFileInput: async () => {},
        deployWorkflowFile: "run-rad-commands.yml",
        deployWorkflowFiles: [
          "run-rad-commands.yml",
          "run-rad-commands-azure.yml"
        ],
        branchNotPushedKind: "branch-not-pushed",
        oidcSubjectMissingKind: "oidc-subject-missing",
        oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
        getBranchHeadSha: () => Promise.resolve("sha-1"),
        getDefaultBranch: unexpected,
        runGh: async (args) => {
          expect(args.slice(0, 3)).toEqual([
            "workflow",
            "run",
            "run-rad-commands.yml"
          ]);
          workflowDispatches.push(args);
          return exhausted || workflowDispatches.length === 1 ?
              {
                code: 1,
                stdout: "",
                stderr: "HTTP 404: workflow not found on the default branch"
              }
            : { code: 0, stdout: "", stderr: "" };
        },
        runGhWithStdin: unexpected,
        runAz: unexpected,
        runGitHubJson: unexpected,
        readProcessEnv: () => ({}),
        ghCredentialSource: () => "keyring",
        fetchFileForSelection: () => Promise.resolve("model source"),
        appParams: () => [],
        resolveDeployParams: () => ({}),
        partitionParams: () => ({ public: {}, secret: {} }),
        extractAppName: () => "",
        buildDeployRadCommand: () => "rad deploy",
        buildAppGraphRadCommand: () => "rad app graph",
        ensureDeployWorkflowsOnBranch: () => Promise.resolve(),
        ensureWorkflowsCurrent: async () => ({
          created:
            change === "created" ?
              [".github/workflows/run-rad-commands.yml"]
            : [],
          updated:
            change === "updated" ?
              [".github/workflows/run-rad-commands.yml"]
            : []
        }),
        sleep: async (ms) => {
          delays.push(ms);
          latestRunId++;
        },
        latestWorkflowRunId: () => Promise.resolve(latestRunId),
        classifyDeployDispatchFailure: () => "run-unconfirmed",
        uncommittedGeneratedPaths: () => Promise.resolve([]),
        invalidateDeployListCache: () => {},
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error),
        now: () => 1_700_000_000_000
      });
      const monitor = createDeployMonitorService({
        plannedGraph: { recover: unexpected },
        dispatch,
        outcome: {
          settle: async ({ entry, conclusion }) => {
            expect(conclusion).toBe("success");
            settlements++;
            entry.state.deployStatus = "success";
          }
        },
        deployRadCommandsStep: "Run rad commands",
        unconfirmedRunKind: "run-unconfirmed",
        findWorkflowRun: async (_repo, _workflow, _time, _branch, baseline) => {
          expect(baseline).toBe(43);
          discoveries++;
          return 44;
        },
        getRunDetail: async () => ({
          status: "completed",
          conclusion: "success",
          steps: []
        }),
        createStatusReader: async () => ({
          progress: unexpected,
          graph: unexpected,
          controlPlaneLog: unexpected
        }),
        buildDeployStatusMap: unexpected,
        buildDeployMessageMap: unexpected,
        applyDeployMessages: unexpected,
        applyDeployStatusToResources: unexpected,
        settleDeployStatuses: unexpected,
        generatePortalUrl: unexpected,
        optionalString: (value) => (typeof value === "string" ? value : ""),
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error),
        sleep: unexpected,
        now: () => 1_700_000_000_000
      });
      const harness = startDeploy(monitor);
      const entry = await container!.getOrCreate("panel-a");
      const state = harness.stateOf("panel-a");
      state.plannedResources = [{ id: "r1", name: "db" }];

      const response = await post(
        entry.baseUrl,
        "/api/deploy",
        deployBody({ provider: "aws", appFile: undefined })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      await expect
        .poll(() => state.deployStatus)
        .toBe(exhausted ? "failed" : "success");
      await expect.poll(() => activeDeploymentMutation(state)).toBeUndefined();
      expect(workflowDispatches).toHaveLength(exhausted ? 3 : 2);
      expect(
        workflowDispatches.every(
          (args) =>
            JSON.stringify(args) === JSON.stringify(workflowDispatches[0])
        )
      ).toBe(true);
      expect(delays).toEqual(exhausted ? [3000, 2000, 5000] : [3000, 2000]);
      expect(discoveries).toBe(exhausted ? 0 : 1);
      expect(settlements).toBe(exhausted ? 0 : 1);
      const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
      const body = await status.json();
      expect(status.status).toBe(200);
      if (exhausted) {
        expect(body).toMatchObject({
          status: "failed",
          errorKind: "run-unconfirmed",
          error: expect.stringContaining("Radius already waited and retried")
        });
      } else {
        expect(body).toMatchObject({
          status: "success",
          deployRunUrl: "https://github.com/acme/widgets/actions/runs/44"
        });
      }
    }
  );

  it.each([
    { conclusion: "future_conclusion", reads: 1, sleeps: 0 },
    { conclusion: null, reads: 240, sleeps: 240 }
  ])(
    "cleans up completed+$conclusion once, only after dispatch, and never repairs it",
    async ({ conclusion, reads, sleeps }) => {
      const dispatchDone = createDeferred<void>();
      const noticeDone = createDeferred<string>();
      let dispatches = 0;
      let releases = 0;
      let repairs = 0;
      const notices: string[] = [];
      const observed = createUnconfirmedMonitor(conclusion, {
        prepareAndDispatch: async () => {
          dispatches++;
          await dispatchDone.promise;
          return {
            dispatched: true,
            workflowFile: "run-rad-commands.yml",
            dispatchedAt: 1,
            environment: "production",
            baselineRunId: null
          };
        }
      });
      try {
        const harness = startDeploy(observed.monitor, {
          delivery: {
            sendRepair: () => {
              repairs++;
            },
            sendNotice: ({ error }) => {
              notices.push(error);
              return noticeDone.promise;
            }
          },
          onMonitorSettled: (state) => {
            expect(state.deployStatus).toBe("failed");
            expect(state.deployErrorKind).toBe("run-unconfirmed");
            expect(state.deployError).toContain(
              "its outcome could not be confirmed"
            );
            expect(state.deployingResources?.[0]).toMatchObject({
              deployStatus: "failed",
              deployMessage: DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE
            });
            releases++;
          }
        });
        const entry = await container!.getOrCreate("panel-a");
        const state = harness.stateOf("panel-a");
        state.plannedResources = [{ id: "r1", name: "db" }];
        const response = await post(
          entry.baseUrl,
          "/api/deploy",
          deployBody({ appFile: undefined })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(dispatches).toBe(1);
        expect(harness.runtime.owner.hasActiveWork()).toBe(true);
        expect(releases).toBe(0);
        expect(observed.reads).toEqual([]);
        expect(notices).toEqual([]);
        const duplicate = await post(
          entry.baseUrl,
          "/api/deploy",
          deployBody()
        );
        expect(duplicate.status).toBe(409);
        await duplicate.text();
        expect(dispatches).toBe(1);
        expect(releases).toBe(0);

        dispatchDone.resolve();
        await expect.poll(() => releases).toBe(1);
        await expect
          .poll(() => harness.runtime.owner.hasActiveWork())
          .toBe(false);
        const terminal = await fetch(`${entry.baseUrl}/api/deploy-status`);
        await terminal.json();
        expect(observed.reads).toHaveLength(reads);
        expect(
          observed.reads.every(
            (args) =>
              JSON.stringify(args) ===
              JSON.stringify([
                "api",
                "repos/acme/widgets/actions/runs/42",
                "--include",
                "--method",
                "GET"
              ])
          )
        ).toBe(true);
        expect(harness.observationDelays).toEqual(
          Array<number>(sleeps).fill(5000)
        );
        expect(observed.sleeps).toEqual([]);
        expect(notices).toEqual([state.deployError]);
        expect(state.deployNoticeState).toBe("pending");
        expect(state.deployNoticeAttempts).toBe(1);
        expect(state.deployRepairAttempts).toBe(0);
        expect(repairs).toBe(0);
        for (let poll = 0; poll < 2; poll++) {
          const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
          expect(await status.json()).toMatchObject({
            status: "failed",
            errorKind: "run-unconfirmed",
            repairing: false
          });
        }
        expect(notices).toHaveLength(1);
        expect(repairs).toBe(0);
        expect(dispatches).toBe(1);
        expect(releases).toBe(1);
        expect(observed.reads).toHaveLength(reads);

        harness.views.detach("panel-a", entry.state);
        state.deployNoticeState = "idle";
        const replacement = structuredClone(state);
        noticeDone.resolve("notice-id");
        await noticeDone.promise;
        expect(state).toEqual(replacement);
        expect(state.deployNoticeState).toBe("idle");
        expect(releases).toBe(1);
      } finally {
        dispatchDone.resolve();
        noticeDone.resolve("notice-id");
      }
    }
  );

  // Each refusal below gets its own harness. Sharing one test made the
  // case-mismatch half reachable only if the missing-subject half got that
  // far, so a regression in either path reported a single failure that said
  // nothing about which one broke.
  function oidcRefusalHarness(subjects: string[]) {
    const workflowDispatches: string[][] = [];
    const dispatch = createDeployDispatchService({
      id: () => "execution",
      verifyAppFileInput: async () => {},
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
      sleep: () => Promise.resolve(),
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
      settleDeployStatuses: () => {
        throw new Error("an undispatched workflow has no graph to settle");
      },
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
      body: deployBody({ appFile: undefined })
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
      body: deployBody({ appFile: undefined })
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

  it.each(["empty", "failed"] as const)(
    "returns 503 rather than guessing main when default-branch lookup is %s",
    async (outcome) => {
      const harness = startDeploy(undefined, {
        runCommand: () =>
          outcome === "empty" ?
            Promise.resolve(" ")
          : Promise.reject(new Error("branch lookup unavailable"))
      });
      const entry = await container!.getOrCreate("panel-a");
      const response = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        body: deployBody({ branch: "" })
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: expect.stringContaining(
          "Could not resolve the deployment branch:"
        )
      });
      expect(harness.monitorCalls).toEqual([]);
      expect(entry.state.deployAttempt).toBeUndefined();
      expect(activeDeploymentMutation(entry.state)).toBeUndefined();
    }
  );

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
    expect(harness.runtime.owner.hasActiveWork()).toBe(true);
    await harness.settleMonitor();
    expect(activeDeploymentMutation(state)).toBeUndefined();
    expect(harness.handoffs).toEqual([]);
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
    const attemptId = state.deployAttempt?.id;

    const response = await fetch(`${entry.baseUrl}/api/deploy`, {
      method: "POST",
      body: deployBody({ attemptId })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      repairAttempt: 2,
      repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP
    });
    expect(state.deployAttempt?.id).toBe(attemptId);
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
      const attemptId = state.deployAttempt?.id;
      const attemptsBefore = state.deployRepairAttempts;
      const statusBefore = state.deployStatus;

      const response = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        body: deployBody({ attemptId })
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
      expect(state.deployAttempt?.id).toBe(attemptId);
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
      /no longer current/
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
      "Another deployment operation for this repository and environment is in progress."
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
      /Could not verify the deployment target/
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
      error: "A remote deployment operation is already in progress."
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
    expect(String((await jsonBody(response)).error)).toMatch(/JSON object/i);
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
      error: "A valid repo (owner/repo) and environment are required."
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
    expect(harness.handoffs).toEqual([]);
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
