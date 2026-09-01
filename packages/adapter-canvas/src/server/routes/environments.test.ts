import { Readable } from "node:stream";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { createCanvasServer } from "../create-canvas-server.js";
import { createRequestContext } from "../request-context.js";
import { createRequestHandler } from "../create-request-handler.js";
import { type ServerRoute } from "../route-table.js";
import {
  createEnvironmentsRoutes,
  handleAppParams,
  handleBypassVerification,
  handleDeleteEnvironment,
  handleListEnvironments,
  handleVerifyStatus,
  overlayDeletingStatus,
  type EnvironmentActiveDeployment,
  type EnvironmentRunDetail,
  type EnvironmentsDependencies,
  type EnvironmentsInstanceEntry,
  type DeleteOperationRecord
} from "./environments.js";
import type { CanvasServerEntry } from "../types.js";
import { getOrCreateServer, persistBestEffort } from "../../server.js";
import {
  addLegacyStep as recordLegacyStep,
  finishSucceeded as finishSetupSucceeded,
  hasCompleteVerificationIdentity,
  isTerminalState as isSetupTerminalState
} from "../../operations.js";
import {
  isSelectedGhAuthorizationError,
  SelectedGhAuthorizationError
} from "../../deploy.js";
import { createTestRouteTable } from "../../../test/support/server/route-table.js";

interface Recording {
  headers: Record<string, string>;
  headerOrder: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      // Mirrors Node: re-setting a header overwrites it and keeps its position.
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(method: string, url: string, body = ""): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url,
    method,
    headers: {}
  }) as unknown as IncomingMessage;
}

function context(
  method: string,
  url: string,
  body = "",
  instances?: ReadonlyMap<string, CanvasServerEntry>
) {
  const { recording, response } = recorder();
  const req = request(method, url, body);
  const map = instances ?? new Map<string, CanvasServerEntry>();
  const ctx = createRequestContext(req, response, "panel", map);
  return { recording, ctx };
}

// A dependency bag where every seam throws unless the test overrides it. A
// handler that reaches for a seam the scenario did not script fails loudly
// rather than silently no-op'ing, so a test can only pass by exercising exactly
// the collaborators the legacy arm used.
function deps(
  overrides: Partial<EnvironmentsDependencies>
): EnvironmentsDependencies {
  const unset = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`);
  };
  const base: EnvironmentsDependencies = {
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    // Deliberately distinct from identity so a route that forgets to redact a
    // browser-visible diagnostic is detectable.
    redactDiagnostic: (value) => value.replaceAll("ghp_secret", "[REDACTED]"),
    repoMatchesWorkspace: unset("repoMatchesWorkspace") as never,
    readInstanceEntry: unset("readInstanceEntry") as never,
    runCommand: unset("runCommand") as never,
    fetchFileFromRepo: unset("fetchFileFromRepo") as never,
    appParams: unset("appParams") as never,
    resolveRepoAppName: unset("resolveRepoAppName") as never,
    resolveEnvDeployment: unset("resolveEnvDeployment") as never,
    logError: unset("logError") as never,
    discoverEnvironmentTarget: unset("discoverEnvironmentTarget") as never,
    createOperation: unset("createOperation") as never,
    activeDeleteOperation: () => null,
    buildDeleteStages: unset("buildDeleteStages") as never,
    startOperation: unset("startOperation") as never,
    toClientView: unset("toClientView") as never,
    scheduleEnvironmentOperation: unset(
      "scheduleEnvironmentOperation"
    ) as never,
    cliExec: unset("cliExec") as never,
    activeDeleteEnvironment: () => "",
    envListCacheGet: unset("envListCacheGet") as never,
    envListCacheSet: unset("envListCacheSet") as never,
    envListCacheGeneration: unset("envListCacheGeneration") as never,
    envListCacheDelete: unset("envListCacheDelete") as never,
    envListTtlMs: 15000,
    kickoffWorkflowSync: unset("kickoffWorkflowSync") as never,
    now: unset("now") as never,
    getOperation: unset("getOperation") as never,
    getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
    isSelectedGitHubAuthorizationError: () => false,
    hasCompleteVerificationIdentity: unset(
      "hasCompleteVerificationIdentity"
    ) as never,
    findWorkflowRun: unset("findWorkflowRun") as never,
    settleVerificationDispatchRecovery: () => {},
    getRunDetail: unset("getRunDetail") as never,
    fetchRunLog: unset("fetchRunLog") as never,
    extractErrorLines: unset("extractErrorLines") as never,
    extractGitHubActionsStepLog: unset("extractGitHubActionsStepLog") as never,
    explainOidcEnterpriseClaim: unset("explainOidcEnterpriseClaim") as never,
    explainNoSubscriptions: unset("explainNoSubscriptions") as never,
    addLegacyStep: unset("addLegacyStep") as never,
    isTerminalState: unset("isTerminalState") as never,
    finish: unset("finish") as never,
    finishSucceeded: unset("finishSucceeded") as never,
    persistBestEffort: unset("persistBestEffort") as never,
    persistOperations: unset("persistOperations") as never,
    reportOperationDiagnostic: unset("reportOperationDiagnostic") as never,
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify"
  };
  return { ...base, ...overrides };
}

// A scripted `cliExec` fake keyed on the API path it targets (the `/repos/...`
// argument), which uniquely identifies each call `list-environments` makes.
// An unscripted path resolves to an empty result via the error callback rather
// than throwing, because the verify-runs promise is created eagerly and awaited
// late — a synchronous throw there would surface as an unhandled rejection
// instead of a visible test failure. Misses are recorded so a test can assert
// the handler issued exactly the calls it scripted.
interface CliScript {
  [apiPath: string]: { error?: Error; stdout?: string; stderr?: string };
}

function cliFake(script: CliScript, misses: string[] = []) {
  return (
    _command: string,
    args: string[],
    _options: { timeout: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    const path = args.find((a) => a.startsWith("/repos/")) ?? "";
    const scripted = script[path];
    if (!scripted) {
      misses.push(path);
      callback(new Error(`unscripted cliExec path: ${path}`), "", "");
      return;
    }
    callback(
      scripted.error ?? null,
      scripted.stdout ?? "",
      scripted.stderr ?? ""
    );
  };
}

function createControlledEnvironmentServer(
  overrides: Partial<EnvironmentsDependencies>
) {
  const routes = createTestRouteTable(
    createEnvironmentsRoutes(deps(overrides))
  );
  return createCanvasServer({
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
    defaultPage: "environment",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });
}

describe("environments — app-params", () => {
  it("400s an empty repo without touching the network", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/app-params",
      JSON.stringify({ repo: "" })
    );
    await handleAppParams(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(recording.headerOrder).toEqual(["Content-Type"]);
    expect(JSON.parse(recording.body)).toEqual({
      error: "No repository specified.",
      params: []
    });
  });

  it("treats an empty-string repo as no repo (|| not ??)", async () => {
    // A repo of "" must reach the guard, not be forwarded as a real selection.
    const { recording, ctx } = context(
      "POST",
      "/api/app-params",
      JSON.stringify({ repo: "", branch: "dev" })
    );
    await handleAppParams(ctx, deps({}));
    expect(recording.status).toBe(400);
  });

  it("resolves the default branch when none is supplied and reports found params", async () => {
    const runCommand = vi.fn(() => Promise.resolve("  main  "));
    const fetchFileFromRepo = vi.fn((_repo, path) =>
      Promise.resolve(path === ".radius/app.bicep" ? "param a string" : null)
    );
    const appParams = vi.fn(() => [{ name: "a" }]);
    const { recording, ctx } = context(
      "POST",
      "/api/app-params",
      JSON.stringify({ repo: "o/r" })
    );
    await handleAppParams(
      ctx,
      deps({ runCommand, fetchFileFromRepo, appParams })
    );
    expect(runCommand).toHaveBeenCalledWith("gh", [
      "repo",
      "view",
      "o/r",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name"
    ]);
    // The default-branch lookup output is trimmed.
    expect(fetchFileFromRepo).toHaveBeenNthCalledWith(
      1,
      "o/r",
      ".radius/app.bicep",
      "main"
    );
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({
      branch: "main",
      found: true,
      params: [{ name: "a" }]
    });
  });

  it("falls back to app.bicep and to main when the default lookup fails and yields empty", async () => {
    const runCommand = vi.fn(() => Promise.reject(new Error("gh down")));
    const fetchFileFromRepo = vi.fn((_repo, path) =>
      Promise.resolve(path === "app.bicep" ? "param b int" : null)
    );
    const appParams = vi.fn(() => [{ name: "b" }]);
    const { recording, ctx } = context(
      "POST",
      "/api/app-params",
      JSON.stringify({ repo: "o/r" })
    );
    await handleAppParams(
      ctx,
      deps({ runCommand, fetchFileFromRepo, appParams })
    );
    // Both paths are probed; the second supplies the source.
    expect(fetchFileFromRepo).toHaveBeenNthCalledWith(
      1,
      "o/r",
      ".radius/app.bicep",
      "main"
    );
    expect(fetchFileFromRepo).toHaveBeenNthCalledWith(
      2,
      "o/r",
      "app.bicep",
      "main"
    );
    expect(JSON.parse(recording.body)).toEqual({
      branch: "main",
      found: true,
      params: [{ name: "b" }]
    });
  });

  it("uses the caller's branch verbatim and reports not-found with empty params", async () => {
    const fetchFileFromRepo = vi.fn(() => Promise.resolve(null));
    const { recording, ctx } = context(
      "POST",
      "/api/app-params",
      JSON.stringify({ repo: "o/r", branch: "feature" })
    );
    await handleAppParams(ctx, deps({ fetchFileFromRepo }));
    expect(fetchFileFromRepo).toHaveBeenNthCalledWith(
      1,
      "o/r",
      ".radius/app.bicep",
      "feature"
    );
    expect(JSON.parse(recording.body)).toEqual({
      branch: "feature",
      found: false,
      params: []
    });
  });

  it("answers 200 with an empty list when the body is malformed", async () => {
    // Legacy reads the body with a bare JSON.parse and a malformed body lands
    // in the catch, which is a 200 success fallback — not a 400 or 500.
    const { recording, ctx } = context("POST", "/api/app-params", "{not json");
    await handleAppParams(ctx, deps({}));
    expect(recording.status).toBe(200);
    const parsed = JSON.parse(recording.body);
    expect(parsed.params).toEqual([]);
    expect(typeof parsed.error).toBe("string");
  });
});

describe("environments — delete-environment refusal ladder", () => {
  const entryWith = (
    state: Record<string, unknown> = {}
  ): EnvironmentsInstanceEntry => ({ state: state as never });

  it("rung 1: 400 when repo or environment is missing", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r" })
    );
    await handleDeleteEnvironment(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(recording.headerOrder).toEqual(["Content-Type"]);
    expect(JSON.parse(recording.body)).toEqual({
      error: "repo and environment are required."
    });
  });

  it("rung 1: an empty body parses to {} and 400s rather than throwing", async () => {
    const { recording, ctx } = context("POST", "/api/delete-environment", "");
    await handleDeleteEnvironment(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body)).toEqual({
      error: "repo and environment are required."
    });
  });

  it("rung 2: 503 fail-closed when the active-app check throws", async () => {
    const logError = vi.fn();
    const readInstanceEntry = vi.fn(() => entryWith({ contextBranch: "ctx" }));
    const resolveRepoAppName = vi.fn(() => Promise.resolve("myapp"));
    const resolveEnvDeployment = vi.fn(() =>
      Promise.reject(new Error("github unavailable"))
    );
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        logError,
        readInstanceEntry,
        resolveRepoAppName,
        resolveEnvDeployment
      })
    );
    // The context branch wins the fallback chain.
    expect(resolveRepoAppName).toHaveBeenCalledWith("o/r", "ctx");
    expect(recording.status).toBe(503);
    const body = JSON.parse(recording.body);
    expect(body.error).toContain(
      'Could not verify whether an application is still deployed to "dev"'
    );
    expect(body.error).toContain("github unavailable");
    expect(logError).toHaveBeenCalledOnce();
  });

  it("rung 2: falls through the branch chain to main when no entry state is set", async () => {
    const resolveRepoAppName = vi.fn(() => Promise.resolve("app"));
    const resolveEnvDeployment = vi.fn(() => Promise.reject(new Error("x")));
    const { ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        logError: () => {},
        readInstanceEntry: () => undefined,
        resolveRepoAppName,
        resolveEnvDeployment
      })
    );
    expect(resolveRepoAppName).toHaveBeenCalledWith("o/r", "main");
  });

  it("rung 3: 409 when an app is still deployed, redirecting to the deploy flow", async () => {
    const active: EnvironmentActiveDeployment = {
      app: "store",
      environment: "dev",
      provider: "azure",
      status: "deployed",
      deploymentId: "1",
      runUrl: "u"
    };
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith({ plannedBranch: "pl" }),
        resolveRepoAppName: () => Promise.resolve("store"),
        resolveEnvDeployment: () => Promise.resolve(active)
      })
    );
    expect(recording.status).toBe(409);
    const parsed = JSON.parse(recording.body);
    expect(parsed.code).toBe("app-deployed");
    expect(parsed.app).toBe("store");
    expect(parsed.error).toContain('is still deployed to environment "dev"');
    expect(parsed.redirect).toBe("/?page=deploying&app=store&env=dev");
  });

  it("rung 3: 409 uses the deleting wording when the app is mid-deletion", async () => {
    const active: EnvironmentActiveDeployment = {
      app: "store",
      environment: "dev",
      provider: "azure",
      status: "deleting",
      deploymentId: "1",
      runUrl: "u"
    };
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith({ graphBranch: "gb" }),
        resolveRepoAppName: () => Promise.resolve("store"),
        resolveEnvDeployment: () => Promise.resolve(active)
      })
    );
    expect(recording.status).toBe(409);
    expect(recording.body).toContain("is still being deleted from environment");
  });

  it("rung 3: routes a failed teardown to its recovery controls", async () => {
    const active: EnvironmentActiveDeployment = {
      app: "store",
      environment: "dev",
      provider: "azure",
      status: "delete-failed",
      deploymentId: "1",
      runUrl: "u"
    };
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith({ graphBranch: "gb" }),
        resolveRepoAppName: () => Promise.resolve("store"),
        resolveEnvDeployment: () => Promise.resolve(active)
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body)).toEqual({
      error:
        'The previous teardown of application "store" from environment "dev" failed. Retry Delete or stop tracking the deployment before deleting the environment.',
      code: "app-deployed",
      app: "store",
      environment: "dev",
      redirect: "/?page=deployed&application=store&environment=dev"
    });
  });

  it("rung 4: 503 fail-closed when provider/identity discovery fails", async () => {
    const discoverEnvironmentTarget = vi.fn(() =>
      Promise.reject(new Error("boom"))
    );
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith(),
        resolveRepoAppName: () => Promise.resolve("app"),
        resolveEnvDeployment: () => Promise.resolve(null),
        discoverEnvironmentTarget
      })
    );
    expect(recording.status).toBe(503);
    const body = JSON.parse(recording.body);
    expect(body.error).toContain(
      'Could not read the configuration for environment "dev"'
    );
    expect(body.error).toContain("boom");
  });

  it("clean pass: starts a delete operation and 202s with the client view", async () => {
    const op: DeleteOperationRecord = {
      operationId: "op-del-1",
      currentStage: "delete-radius-env"
    };
    const createOperation = vi.fn(() => op);
    const buildDeleteStages = vi.fn(() => [{ id: "s", state: "pending" }]);
    const startOperation = vi.fn(() => ({ ok: true as const, operation: op }));
    const persistOperations = vi.fn(() => Promise.resolve());
    const toClientView = vi.fn(() => ({ operationId: "op-del-1", view: true }));
    const scheduleEnvironmentOperation = vi.fn(() => true);
    const discoverEnvironmentTarget = vi.fn(() =>
      Promise.resolve({
        provider: "azure",
        clientId: "app-123",
        tenantId: "tenant-1",
        repoId: 7
      })
    );
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith(),
        resolveRepoAppName: () => Promise.resolve("app"),
        resolveEnvDeployment: () => Promise.resolve(null),
        discoverEnvironmentTarget,
        createOperation,
        buildDeleteStages,
        startOperation,
        persistOperations,
        toClientView,
        scheduleEnvironmentOperation
      })
    );
    expect(buildDeleteStages).toHaveBeenCalledWith({
      includeAzureCleanup: true
    });
    expect(op.request).toEqual({
      repo: "o/r",
      environment: "dev",
      provider: "azure",
      clientId: "app-123",
      tenantId: "tenant-1",
      repoId: 7
    });
    expect(startOperation).toHaveBeenCalledWith(op);
    expect(persistOperations).toHaveBeenCalledOnce();
    expect(recording.status).toBe(202);
    expect(recording.headers["Location"]).toBe("/api/operations/op-del-1");
    const body = JSON.parse(recording.body);
    expect(body.operationId).toBe("op-del-1");
    expect(body.operation).toEqual({ operationId: "op-del-1", view: true });
    expect(scheduleEnvironmentOperation).toHaveBeenCalledWith(
      ctx.instanceId,
      op
    );
  });

  it("includes Azure cleanup even when the client id could not be read", async () => {
    const op: DeleteOperationRecord = {
      operationId: "op-del-2",
      currentStage: "delete-radius-env"
    };
    const buildDeleteStages = vi.fn(() => [{ id: "s", state: "pending" }]);
    const startOperation = vi.fn(() => ({ ok: true as const, operation: op }));
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith(),
        resolveRepoAppName: () => Promise.resolve("app"),
        resolveEnvDeployment: () => Promise.resolve(null),
        // Azure provider but no readable AZURE_CLIENT_ID — the credential is most
        // likely orphaned, so the Azure stages must still run (and warn).
        discoverEnvironmentTarget: () =>
          Promise.resolve({
            provider: "azure",
            clientId: "",
            tenantId: "",
            repoId: 7
          }),
        createOperation: () => op,
        buildDeleteStages,
        startOperation,
        persistOperations: () => Promise.resolve(),
        toClientView: () => ({ operationId: "op-del-2" }),
        scheduleEnvironmentOperation: () => true
      })
    );
    expect(buildDeleteStages).toHaveBeenCalledWith({
      includeAzureCleanup: true
    });
    expect(op.request).toEqual({
      repo: "o/r",
      environment: "dev",
      provider: "azure",
      clientId: "",
      tenantId: "",
      repoId: 7
    });
    expect(recording.status).toBe(202);
  });

  it("409s when an operation is already running for the repo", async () => {
    const op: DeleteOperationRecord = {
      operationId: "op-new",
      currentStage: null
    };
    const startOperation = vi.fn(() => ({
      ok: false as const,
      conflict: { operationId: "op-existing" }
    }));
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith(),
        resolveRepoAppName: () => Promise.resolve("app"),
        resolveEnvDeployment: () => Promise.resolve(null),
        discoverEnvironmentTarget: () =>
          Promise.resolve({
            provider: "azure",
            clientId: "",
            tenantId: "",
            repoId: 7
          }),
        createOperation: () => op,
        buildDeleteStages: () => [],
        startOperation
      })
    );
    expect(recording.status).toBe(409);
    const body = JSON.parse(recording.body);
    expect(body.code).toBe("operation-in-progress");
    expect(body.operationId).toBe("op-existing");
  });

  it("returns the existing delete operation without starting another run", async () => {
    const existing: DeleteOperationRecord = {
      operationId: "op-existing-delete",
      currentStage: "delete-radius-env"
    };
    const resolveEnvDeployment = vi.fn();
    const discoverEnvironmentTarget = vi.fn();
    const createOperation = vi.fn();
    const startOperation = vi.fn();
    const toClientView = vi.fn(() => ({
      operationId: existing.operationId,
      kind: "delete"
    }));
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );

    await handleDeleteEnvironment(
      ctx,
      deps({
        activeDeleteOperation: (repo, environment) =>
          repo === "o/r" && environment === "dev" ? existing : null,
        resolveEnvDeployment,
        discoverEnvironmentTarget,
        createOperation,
        startOperation,
        toClientView
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body)).toEqual({
      error: 'Deletion is already running for environment "dev".',
      code: "delete-operation-in-progress",
      operationId: "op-existing-delete",
      operation: { operationId: "op-existing-delete", kind: "delete" }
    });
    expect(resolveEnvDeployment).not.toHaveBeenCalled();
    expect(discoverEnvironmentTarget).not.toHaveBeenCalled();
    expect(createOperation).not.toHaveBeenCalled();
    expect(startOperation).not.toHaveBeenCalled();
  });

  it("400s with provider-unsupported guidance for an AWS environment", async () => {
    const createOperation = vi.fn();
    const startOperation = vi.fn();
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleDeleteEnvironment(
      ctx,
      deps({
        readInstanceEntry: () => entryWith(),
        resolveRepoAppName: () => Promise.resolve("app"),
        resolveEnvDeployment: () => Promise.resolve(null),
        discoverEnvironmentTarget: () =>
          Promise.resolve({
            provider: "aws",
            clientId: "",
            tenantId: "",
            repoId: 7
          }),
        createOperation,
        startOperation
      })
    );
    expect(recording.status).toBe(400);
    const body = JSON.parse(recording.body);
    expect(body.code).toBe("provider-unsupported");
    expect(body.error).toContain("AWS");
    expect(body.error).toContain('"dev" was not deleted');
    // Nothing was started: no operation is created for an unsupported provider.
    expect(createOperation).not.toHaveBeenCalled();
    expect(startOperation).not.toHaveBeenCalled();
  });

  it("outer catch: 400 when the body is malformed JSON", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/delete-environment",
      "{bad"
    );
    await handleDeleteEnvironment(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(typeof JSON.parse(recording.body).error).toBe("string");
  });
});

describe("environments — bypass-verification", () => {
  // A verification operation that tracks a failed permissions run for env "dev".
  const bypassOp = (over: Record<string, unknown> = {}) => ({
    repo: "o/r",
    environment: "dev",
    context: { githubLogin: "octocat" },
    verification: { runId: "555" },
    ...over
  });
  // The gh reads the handler issues in order: (1) the environment's variable
  // names for the RADIUS_MANAGED check. The marker write is (2).
  const managedVars = "RADIUS_MANAGED\nAZURE_CLIENT_ID";
  const bypassBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      repo: "o/r",
      environment: "dev",
      operationId: "op1",
      runId: "555",
      ...over
    });
  // Deps that carry a bypass all the way through to the marker write: a
  // Radius-managed env whose run is a terminal permissions failure.
  const passingDeps = (over: Partial<EnvironmentsDependencies> = {}) =>
    deps({
      getOperation: () => bypassOp(),
      getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () =>
        Promise.resolve({
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
        }),
      fetchRunLog: () =>
        Promise.resolve("Error from server (Forbidden): cannot list resource"),
      extractGitHubActionsStepLog: () => "",
      explainOidcEnterpriseClaim: () => "",
      explainNoSubscriptions: () => "",
      ...over
    });

  it("400s when a required field is missing", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      JSON.stringify({ repo: "o/r", environment: "dev" })
    );
    await handleBypassVerification(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(recording.headerOrder).toEqual(["Content-Type"]);
    expect(JSON.parse(recording.body)).toEqual({
      error: "repo, environment, operationId and runId are required."
    });
  });

  it("an empty body parses to {} and 400s rather than throwing", async () => {
    const { recording, ctx } = context("POST", "/api/bypass-verification", "");
    await handleBypassVerification(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body)).toEqual({
      error: "repo, environment, operationId and runId are required."
    });
  });

  it("409s when the operation does not match the repo/env/run", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody({ runId: "999" })
    );
    await handleBypassVerification(
      ctx,
      deps({ getOperation: () => bypassOp() })
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "does not match this bypass request"
    );
  });

  it("409s when the operation is missing entirely", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(ctx, deps({ getOperation: () => null }));
    expect(recording.status).toBe(409);
  });

  it("409s when the verification identity is incomplete", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      deps({
        getOperation: () => bypassOp(),
        hasCompleteVerificationIdentity: () => false
      })
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "incomplete dispatch identity"
    );
  });

  it("409s when the pinned login or executor cannot be resolved", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      deps({
        getOperation: () => bypassOp(),
        hasCompleteVerificationIdentity: () => true,
        getSelectedGitHubExecutor: () => undefined
      })
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "GitHub account that ran verification"
    );
  });

  it("502s when the managed-environment check cannot be read", async () => {
    const runCommand = vi.fn(() => Promise.reject(new Error("boom")));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({ runCommand } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(502);
    expect(JSON.parse(recording.body).error).toContain(
      "Could not confirm the environment"
    );
  });

  it("409s when the target is not a Radius-managed environment", async () => {
    const runCommand = vi.fn(() => Promise.resolve("SOME_OTHER_VAR"));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({ runCommand } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain("not managed by Radius");
  });

  it("502s when the run cannot be re-read", async () => {
    const runCommand = vi.fn(() => Promise.resolve(managedVars));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({
        runCommand,
        getRunDetail: () => Promise.resolve(null)
      } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(502);
    expect(JSON.parse(recording.body).error).toContain(
      "Could not read the verification run"
    );
  });

  it("409s when the run is still in progress", async () => {
    const runCommand = vi.fn(() => Promise.resolve(managedVars));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({
        runCommand,
        getRunDetail: () =>
          Promise.resolve({
            status: "in_progress",
            conclusion: null,
            steps: []
          })
      } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain("still running");
  });

  it("409s when verification actually passed", async () => {
    const runCommand = vi.fn(() => Promise.resolve(managedVars));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({
        runCommand,
        getRunDetail: () =>
          Promise.resolve({
            status: "completed",
            conclusion: "success",
            steps: []
          })
      } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain("nothing to bypass");
  });

  it("409s when the failure category is not bypassable", async () => {
    const runCommand = vi.fn(() => Promise.resolve(managedVars));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({
        runCommand,
        // Login step + trust evidence classifies as oidc-trust (not bypassable).
        getRunDetail: () =>
          Promise.resolve({
            status: "completed",
            conclusion: "failure",
            steps: [
              { name: "Configure AWS Credentials", conclusion: "failure" }
            ]
          }),
        fetchRunLog: () =>
          Promise.resolve(
            "Not authorized to perform sts:AssumeRoleWithWebIdentity"
          )
      } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain("must be fixed");
  });

  it("500s when writing the marker variable fails", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(managedVars)
      .mockRejectedValueOnce(new Error("boom"));
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({ runCommand } as Partial<EnvironmentsDependencies>)
    );
    expect(recording.status).toBe(500);
    expect(JSON.parse(recording.body)).toEqual({
      error: "Could not record the verification bypass: boom"
    });
  });

  it("clean pass: writes the run-id marker, invalidates the cache, and 200s", async () => {
    const runCommand = vi.fn().mockResolvedValue(managedVars);
    const envListCacheDelete = vi.fn();
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      bypassBody()
    );
    await handleBypassVerification(
      ctx,
      passingDeps({
        runCommand,
        envListCacheDelete
      } as Partial<EnvironmentsDependencies>)
    );
    expect(runCommand).toHaveBeenCalledWith(
      "gh",
      [
        "variable",
        "set",
        "RADIUS_VERIFICATION_BYPASSED",
        "--body",
        "555",
        "--env",
        "dev",
        "--repo",
        "o/r"
      ],
      { timeout: 20000 }
    );
    expect(envListCacheDelete).toHaveBeenCalledWith("o/r");
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      category: "permissions"
    });
  });

  it("outer catch: 400 when the body is malformed JSON", async () => {
    const { recording, ctx } = context(
      "POST",
      "/api/bypass-verification",
      "{bad"
    );
    await handleBypassVerification(ctx, deps({}));
    expect(recording.status).toBe(400);
    expect(typeof JSON.parse(recording.body).error).toBe("string");
  });
});

describe("environments — list-environments", () => {
  // API paths (the `args[1]` each `gh api` call targets), which uniquely key
  // the scripted `cliExec` responses.
  const ENV_PATH = {
    verifyRuns: (repo: string) =>
      `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
    names: (repo: string) => `/repos/${repo}/environments?per_page=100`,
    vars: (repo: string, env: string) =>
      `/repos/${repo}/environments/${env}/variables?per_page=100`,
    deployments: (repo: string, env: string) =>
      `/repos/${repo}/deployments?environment=${env}&per_page=10`,
    statuses: (repo: string, id: string) =>
      `/repos/${repo}/deployments/${id}/statuses?per_page=1`
  };

  it("returns an empty list with no-store, in header order, for a missing repo", async () => {
    const { recording, ctx } = context("GET", "/api/list-environments");
    await handleListEnvironments(ctx, deps({}));
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(["Content-Type", "Cache-Control"]);
    expect(recording.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(recording.body)).toEqual({ environments: [] });
  });

  it("serves a fresh cache hit without spawning gh", async () => {
    const now = vi.fn(() => 1000);
    const envListCacheGet = vi.fn(() => ({
      at: 900,
      payload: { environments: [{ name: "cached" }] }
    }));
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({ now, envListCacheGet, envListTtlMs: 15000 })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [{ name: "cached" }]
    });
  });

  it("ignores a stale cache entry and re-lists", async () => {
    const now = vi.fn(() => 1_000_000);
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: { stdout: "" }
    };
    const envListCacheSet = vi.fn();
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now,
        envListCacheGet: () => ({ at: 0, payload: { environments: [] } }),
        envListCacheSet,
        envListCacheGeneration: () => 0,
        cliExec: cliFake(script),
        envListTtlMs: 15000
      })
    );
    // Empty names → cached empty result.
    expect(JSON.parse(recording.body)).toEqual({ environments: [] });
    expect(envListCacheSet).toHaveBeenCalledWith("o/r", {
      at: 1_000_000,
      payload: { environments: [] }
    });
  });

  it("surfaces a names lookup failure without caching it", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: { error: new Error("no auth"), stderr: "403" }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        cliExec: cliFake(script)
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "403"
    });
  });

  it("redacts credential-shaped stderr before the browser-visible envelope", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: {
        error: new Error("no auth"),
        stderr: "gh: authentication failed using ghp_secret"
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        cliExec: cliFake(script)
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "gh: authentication failed using [REDACTED]"
    });
    expect(recording.body).not.toContain("ghp_secret");
  });

  it("falls back to generic text when redaction empties the diagnostic", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: {
        error: Object.assign(new Error(""), { message: "" }),
        stderr: "   "
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        cliExec: cliFake(script)
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "Failed to list environments."
    });
  });

  it("bounds browser-visible gh stderr", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: {
        error: new Error("failed"),
        stderr: "x".repeat(2001)
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        cliExec: cliFake(script)
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: `${"x".repeat(2000)}...`
    });
  });

  it("filters to RADIUS_MANAGED envs and derives provider and verify status", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: {
        stdout: "42\tcompleted\tsuccess"
      },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev\n8\tunmanaged" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout:
          "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc\nRADIUS_CREDENTIAL_PROFILE\tprod"
      },
      [ENV_PATH.vars("o/r", "unmanaged")]: { stdout: "SOMETHING\tx" },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/42"
      }
    };
    const kickoffWorkflowSync = vi.fn();
    const envListCacheSet = vi.fn();
    const entry: EnvironmentsInstanceEntry = {
      state: { workspaceBranch: "feat" } as never
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 5,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet,
        cliExec: cliFake(script),
        readInstanceEntry: () => entry,
        repoMatchesWorkspace: () => true,
        kickoffWorkflowSync
      })
    );
    const parsed = JSON.parse(recording.body);
    expect(parsed.environments).toEqual([
      {
        name: "dev",
        provider: "azure",
        status: "success",
        webUrl: "https://github.com/o/r/settings/environments/7/edit",
        credentialProfile: "prod",
        config: {}
      }
    ]);
    // A matched workspace branch is passed to the background sync.
    expect(kickoffWorkflowSync).toHaveBeenCalledWith(
      "o/r",
      parsed.environments,
      "feat"
    );
    expect(envListCacheSet).toHaveBeenCalled();
  });

  it("reports a bypassed marker on a failed verify as the bypassed status", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "42\tcompleted\tfailure" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout:
          "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc\nRADIUS_VERIFICATION_BYPASSED\t42"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/42"
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );
    const parsed = JSON.parse(recording.body);
    expect(parsed.environments[0].status).toBe("bypassed");
  });

  it("keeps a failed verify failed when the bypass marker is for a different run", async () => {
    // The marker names run 41, but the environment's current failed run is 42:
    // a later, different failure must not inherit the earlier bypass.
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "42\tcompleted\tfailure" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout:
          "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc\nRADIUS_VERIFICATION_BYPASSED\t41"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/42"
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );
    const parsed = JSON.parse(recording.body);
    expect(parsed.environments[0].status).toBe("failed");
  });

  it("keeps a passing verify as success even when the bypass marker is present", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "42\tcompleted\tsuccess" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout:
          "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc\nRADIUS_VERIFICATION_BYPASSED\t42"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/42"
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );
    const parsed = JSON.parse(recording.body);
    expect(parsed.environments[0].status).toBe("success");
  });

  it("reports unknown instead of pending when verification history is absent", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "42\tcompleted\tsuccess" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout: "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/99"
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );

    await handleListEnvironments(
      ctx,
      deps({
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        now: () => 0,
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );

    expect(JSON.parse(recording.body).environments[0].status).toBe("unknown");
  });

  it.each([
    [
      "azure",
      "AZURE_CLIENT_ID\tabc\nAZURE_RESOURCE_GROUP\tprod-rg\nAZURE_AKS_CLUSTER_NAME\tprod-aks\nRADIUS_NAMESPACE\tpayments\nAZURE_SUBSCRIPTION_ID\tsub-1",
      { resourceGroup: "prod-rg", cluster: "prod-aks", namespace: "payments" }
    ],
    [
      "aws",
      "AWS_ROLE_ARN\tarn:aws:iam::1:role/r\nAWS_EKS_CLUSTER_NAME\teks-1\nRADIUS_NAMESPACE\tpayments\nRADIUS_VPC_ID\tvpc-1\nRADIUS_SUBNET_IDS\tsub-a,sub-b\nAWS_ACCOUNT_ID\t1",
      {
        cluster: "eks-1",
        namespace: "payments",
        vpcId: "vpc-1",
        subnetIds: "sub-a,sub-b"
      }
    ]
  ])(
    "returns the %s environment's own configuration so Edit can reopen the form on it",
    async (_provider, variables, expected) => {
      const script: CliScript = {
        [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
        [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
        [ENV_PATH.vars("o/r", "dev")]: {
          stdout: `RADIUS_MANAGED\ttrue\n${variables}`
        },
        [ENV_PATH.deployments("o/r", "dev")]: { stdout: "" }
      };
      const { recording, ctx } = context(
        "GET",
        "/api/list-environments?repo=o/r"
      );
      await handleListEnvironments(
        ctx,
        deps({
          now: () => 0,
          envListCacheGet: () => undefined,
          envListCacheGeneration: () => 0,
          envListCacheSet: vi.fn(),
          cliExec: cliFake(script),
          readInstanceEntry: () => undefined,
          repoMatchesWorkspace: () => false,
          kickoffWorkflowSync: vi.fn()
        })
      );
      expect(JSON.parse(recording.body).environments[0].config).toEqual(
        expected
      );
    }
  );

  // The namespace the deployment workflow reads is KUBERNETES_NAMESPACE. An
  // environment created before that rename still carries RADIUS_NAMESPACE, and
  // reporting no namespace for either would leave the form's namespace field
  // empty, which a save turns into "default".
  it.each([
    [
      "the name deployments read",
      "AZURE_AKS_CLUSTER_NAME\tprod-aks\nKUBERNETES_NAMESPACE\tpayments",
      "payments"
    ],
    [
      "the legacy name",
      "AZURE_AKS_CLUSTER_NAME\tprod-aks\nRADIUS_NAMESPACE\tlegacy-ns",
      "legacy-ns"
    ],
    [
      "the current name ahead of the legacy one",
      "AZURE_AKS_CLUSTER_NAME\tprod-aks\nKUBERNETES_NAMESPACE\tpayments\nRADIUS_NAMESPACE\tstale-ns",
      "payments"
    ]
  ])("reports the namespace from %s", async (_label, variables, expected) => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout: `RADIUS_MANAGED\ttrue\n${variables}`
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "" }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );
    expect(JSON.parse(recording.body).environments[0].config).toEqual({
      cluster: "prod-aks",
      namespace: expected
    });
  });

  // The workflow resolves the current variable itself, as
  // `vars.KUBERNETES_NAMESPACE || 'default'`. Once it exists it is
  // authoritative even when empty, so a superseded legacy value must not be
  // reported in its place: Edit would show a namespace deployment does not use
  // and would save it back, moving the environment.
  it("reports no namespace when the current variable exists but is empty", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout:
          "RADIUS_MANAGED\ttrue\nAZURE_AKS_CLUSTER_NAME\tprod-aks\nKUBERNETES_NAMESPACE\t\nRADIUS_NAMESPACE\tstale-ns"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "" }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );
    expect(JSON.parse(recording.body).environments[0].config).toEqual({
      cluster: "prod-aks"
    });
  });

  it("omits configuration the environment does not carry", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout:
          "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc\nAZURE_RESOURCE_GROUP\t\nRADIUS_NAMESPACE\tpayments"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "" }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        envListCacheSet: vi.fn(),
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn()
      })
    );
    expect(JSON.parse(recording.body).environments[0].config).toEqual({
      namespace: "payments"
    });
  });

  it("surfaces the top-level catch as an error payload", async () => {
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    // The verify-runs fetch (created first, awaited later) resolves cleanly so
    // it never rejects unobserved; the names fetch — which the handler awaits
    // directly — throws synchronously inside its promise executor and unwinds
    // into the outer catch.
    const cliExec = (
      _command: string,
      args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (args.includes("--paginate")) {
        throw new Error("spawn failed");
      }
      callback(null, "", "");
    };
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        cliExec
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "spawn failed"
    });
  });

  it("uses a generic top-level error when redaction removes the diagnostic", async () => {
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    const cliExec = (
      _command: string,
      args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (args.includes("--paginate")) throw new Error("sensitive");
      callback(null, "", "");
    };
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheGeneration: () => 0,
        cliExec,
        redactDiagnostic: () => ""
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "Failed to list environments."
    });
  });

  it("overlays a live deleting status onto the matching environment on a cache hit", async () => {
    const now = vi.fn(() => 1000);
    const envListCacheGet = vi.fn(() => ({
      at: 900,
      payload: {
        environments: [
          { name: "dev", status: "success" },
          { name: "prod", status: "success" }
        ]
      }
    }));
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now,
        envListCacheGet,
        envListTtlMs: 15000,
        activeDeleteEnvironment: (repo) => (repo === "o/r" ? "prod" : "")
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [
        { name: "dev", status: "success" },
        { name: "prod", status: "deleting" }
      ]
    });
  });

  it("caches the real status but serves the deleting overlay on a fresh list", async () => {
    const script: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "42\tcompleted\tsuccess" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: { stdout: "RADIUS_MANAGED\ttrue" },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/42"
      }
    };
    const envListCacheSet = vi.fn();
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now: () => 0,
        envListCacheGet: () => undefined,
        envListCacheSet,
        envListCacheGeneration: () => 0,
        cliExec: cliFake(script),
        readInstanceEntry: () => undefined,
        repoMatchesWorkspace: () => false,
        kickoffWorkflowSync: vi.fn(),
        activeDeleteEnvironment: () => "dev"
      })
    );
    // The response is overlaid...
    expect(JSON.parse(recording.body).environments[0]).toMatchObject({
      name: "dev",
      status: "deleting"
    });
    // ...but the cache keeps the real verify status so the marker clears once
    // the deletion reaches a terminal state.
    const cached = envListCacheSet.mock.calls[0][1] as {
      payload: { environments: { name: string; status: string }[] };
    };
    expect(cached.payload.environments[0].status).toBe("success");
  });

  it("leaves the listing untouched when no deletion is in progress", async () => {
    const now = vi.fn(() => 1000);
    const { recording, ctx } = context(
      "GET",
      "/api/list-environments?repo=o/r"
    );
    await handleListEnvironments(
      ctx,
      deps({
        now,
        envListCacheGet: () => ({
          at: 900,
          payload: { environments: [{ name: "dev", status: "success" }] }
        }),
        envListTtlMs: 15000,
        activeDeleteEnvironment: () => ""
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [{ name: "dev", status: "success" }]
    });
  });

  // A listing is assembled from many `gh` calls, so a rollback that deletes the
  // GitHub environment can land while one is still running. The listing still
  // answers with what it read, but it must not write that reading into the
  // cache it no longer describes — otherwise the picker keeps serving the
  // rolled-back environment, still Pending, for a whole TTL.
  describe("a listing invalidated while it was being assembled", () => {
    const managedScript: CliScript = {
      [ENV_PATH.verifyRuns("o/r")]: { stdout: "42\tin_progress\t" },
      [ENV_PATH.names("o/r")]: { stdout: "7\tdev" },
      [ENV_PATH.vars("o/r", "dev")]: {
        stdout: "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc"
      },
      [ENV_PATH.deployments("o/r", "dev")]: { stdout: "100" },
      [ENV_PATH.statuses("o/r", "100")]: {
        stdout: "https://github.com/o/r/actions/runs/42"
      }
    };

    it("answers with what it read but refuses to cache it", async () => {
      const envListCacheSet = vi.fn();
      const generations = [0, 1];
      const { recording, ctx } = context(
        "GET",
        "/api/list-environments?repo=o/r"
      );
      await handleListEnvironments(
        ctx,
        deps({
          now: () => 0,
          envListCacheGet: () => undefined,
          envListCacheSet,
          // Read once when the listing starts and once before it caches: the
          // second read is the invalidation the deleting pass performed.
          envListCacheGeneration: () => generations.shift() ?? 1,
          cliExec: cliFake(managedScript),
          readInstanceEntry: () => undefined,
          repoMatchesWorkspace: () => false,
          kickoffWorkflowSync: vi.fn()
        })
      );
      const parsed = JSON.parse(recording.body);
      expect(parsed.environments).toMatchObject([
        { name: "dev", status: "pending" }
      ]);
      expect(envListCacheSet).not.toHaveBeenCalled();
    });

    it("refuses to cache an empty listing invalidated meanwhile", async () => {
      const envListCacheSet = vi.fn();
      const generations = [3, 4];
      const { recording, ctx } = context(
        "GET",
        "/api/list-environments?repo=o/r"
      );
      await handleListEnvironments(
        ctx,
        deps({
          now: () => 0,
          envListCacheGet: () => undefined,
          envListCacheSet,
          envListCacheGeneration: () => generations.shift() ?? 4,
          cliExec: cliFake({
            [ENV_PATH.verifyRuns("o/r")]: { stdout: "" },
            [ENV_PATH.names("o/r")]: { stdout: "" }
          })
        })
      );
      expect(JSON.parse(recording.body)).toEqual({ environments: [] });
      expect(envListCacheSet).not.toHaveBeenCalled();
    });

    it("caches normally when the generation is unchanged", async () => {
      const envListCacheSet = vi.fn();
      const { ctx } = context("GET", "/api/list-environments?repo=o/r");
      await handleListEnvironments(
        ctx,
        deps({
          now: () => 11,
          envListCacheGet: () => undefined,
          envListCacheSet,
          envListCacheGeneration: () => 9,
          cliExec: cliFake(managedScript),
          readInstanceEntry: () => undefined,
          repoMatchesWorkspace: () => false,
          kickoffWorkflowSync: vi.fn()
        })
      );
      expect(envListCacheSet).toHaveBeenCalledWith("o/r", {
        at: 11,
        payload: {
          environments: [expect.objectContaining({ name: "dev" })]
        }
      });
    });
  });
});

describe("environments — overlayDeletingStatus", () => {
  it("sets only the named environment to deleting", () => {
    const payload = {
      environments: [
        { name: "dev", status: "success" },
        { name: "prod", status: "pending" }
      ]
    };
    expect(overlayDeletingStatus(payload, "prod")).toEqual({
      environments: [
        { name: "dev", status: "success" },
        { name: "prod", status: "deleting" }
      ]
    });
  });

  it("returns the payload unchanged when the environment name is empty", () => {
    const payload = { environments: [{ name: "dev", status: "success" }] };
    expect(overlayDeletingStatus(payload, "")).toBe(payload);
  });

  it("preserves sibling fields on the payload and each environment", () => {
    const payload = {
      environments: [{ name: "dev", status: "success", provider: "azure" }],
      error: undefined
    };
    const result = overlayDeletingStatus(payload, "dev") as {
      environments: { provider: string; status: string }[];
    };
    expect(result.environments[0]).toEqual({
      name: "dev",
      status: "deleting",
      provider: "azure"
    });
  });

  it.each([
    ["null", null],
    ["a non-object", 42],
    ["an object without environments", { error: "boom" }],
    ["environments that is not an array", { environments: "nope" }]
  ])("returns %s payloads unchanged", (_label, payload) => {
    expect(overlayDeletingStatus(payload, "dev")).toBe(payload);
  });

  it("ignores non-object environment entries while overlaying the match", () => {
    const payload = {
      environments: [null, { name: "dev", status: "success" }]
    };
    expect(overlayDeletingStatus(payload, "dev")).toEqual({
      environments: [null, { name: "dev", status: "deleting" }]
    });
  });
});

describe("environments — verify-status", () => {
  const detail = (
    over: Partial<EnvironmentRunDetail>
  ): EnvironmentRunDetail => ({
    status: "completed",
    conclusion: "success",
    steps: [],
    ...over
  });

  it("reports unknown for a missing repo", async () => {
    const { recording, ctx } = context("GET", "/api/verify-status");
    await handleVerifyStatus(ctx, deps({}));
    expect(recording.headerOrder).toEqual(["Content-Type", "Cache-Control"]);
    expect(JSON.parse(recording.body)).toEqual({
      state: "unknown",
      error: "No repository specified."
    });
  });

  it("rejects an operation id that does not match a tracked operation", async () => {
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&operationId=op1"
    );
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => null
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      state: "expired",
      terminal: true,
      error: "The verification operation does not match this request."
    });
  });

  it("rejects an operation with incomplete dispatch identity", async () => {
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&operationId=op1"
    );
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => ({
          repo: "o/r",
          environment: "dev",
          context: { githubLogin: "octocat" }
        }),
        hasCompleteVerificationIdentity: () => false
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      state: "expired",
      terminal: true,
      error: "The verification operation has incomplete dispatch identity."
    });
  });

  it("pending when no run can be found", async () => {
    const { recording, ctx } = context("GET", "/api/verify-status?repo=o/r");
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        findWorkflowRun: () => Promise.resolve(null)
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      state: "pending",
      runId: null
    });
  });

  it("keeps a pinned operation pending while its executor is being installed", async () => {
    const operation = {
      repo: "o/r",
      environment: "dev",
      context: { githubLogin: "octocat" },
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "main",
        environment: "dev",
        runId: "55"
      }
    };
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&environment=dev&operationId=op1"
    );
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => operation,
        hasCompleteVerificationIdentity: () => true,
        getSelectedGitHubExecutor: () => undefined
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      state: "pending",
      runId: "55"
    });
  });

  it.each([
    {
      phase: "run detail",
      status: 403 as const,
      runId: "55",
      findWorkflowRun: () => {
        throw new Error("known run must not be discovered");
      },
      getRunDetail: () =>
        Promise.reject(
          new SelectedGhAuthorizationError(
            "alice",
            403,
            "gh: Forbidden (HTTP 403)"
          )
        )
    }
  ])(
    "terminalizes selected-account $phase authorization failure immediately",
    async ({ status, runId, findWorkflowRun, getRunDetail }) => {
      const operation: any = {
        operationId: "op1",
        repo: "o/r",
        environment: "dev",
        state: "running",
        currentStage: "verify",
        context: { githubLogin: "alice" },
        verification: {
          dispatchedAt: 123,
          workflow: "verify.yml",
          ref: "main",
          environment: "dev",
          runId
        }
      };
      const steps: string[] = [];
      const persistOperations = vi.fn(() => Promise.resolve());
      const { recording, ctx } = context(
        "GET",
        "/api/verify-status?repo=o/r&environment=dev&operationId=op1"
      );

      await handleVerifyStatus(
        ctx,
        deps({
          readInstanceEntry: () => undefined,
          getOperation: () => operation,
          getSelectedGitHubExecutor: () =>
            successfulSelectedGhExecutor({ login: "alice" }),
          isSelectedGitHubAuthorizationError: isSelectedGhAuthorizationError,
          hasCompleteVerificationIdentity,
          findWorkflowRun,
          getRunDetail,
          addLegacyStep: (_operation, text) => {
            steps.push(text);
          },
          finish: (target: any, state, options: any) => {
            target.state = state;
            target.endedAt = "finished";
            target.failure = options.failure;
          },
          persistBestEffort,
          persistOperations,
          reportOperationDiagnostic: () => {}
        })
      );

      expect(JSON.parse(recording.body)).toEqual({
        state: "failed",
        terminal: true,
        code: "verification-retry-github-account-unavailable",
        runId,
        error:
          "Radius could not use @alice to monitor credential verification. Re-check that account and retry verification."
      });
      expect(operation).toMatchObject({
        state: "failed_partial",
        failure: {
          code: "verification-retry-github-account-unavailable",
          evidence: expect.stringContaining(`HTTP ${status}`)
        }
      });
      expect(steps).toEqual([
        "❌ Could not use @alice to monitor credential verification."
      ]);
      expect(persistOperations).toHaveBeenCalledTimes(1);
    }
  );

  it("does not let a stale successful poll finish a newer verification retry", async () => {
    const operation: any = {
      operationId: "op1",
      repo: "o/r",
      environment: "dev",
      state: "running",
      currentStage: "verify",
      context: { githubLogin: "alice" },
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "main",
        environment: "dev",
        runId: "55",
        retryCommandId: "cmd-old"
      }
    };
    let executor = successfulSelectedGhExecutor({ login: "alice" });
    const finishSucceeded = vi.fn();
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&environment=dev&operationId=op1"
    );

    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => operation,
        getSelectedGitHubExecutor: () => executor,
        hasCompleteVerificationIdentity: () => true,
        getRunDetail: () => {
          operation.verification = {
            ...operation.verification,
            dispatchedAt: 456,
            runId: "77",
            retryCommandId: "cmd-new"
          };
          executor = successfulSelectedGhExecutor({ login: "alice" });
          return Promise.resolve({
            status: "completed",
            conclusion: "success",
            steps: []
          });
        },
        finishSucceeded
      })
    );

    expect(JSON.parse(recording.body)).toEqual({
      state: "pending",
      runId: "77"
    });
    expect(finishSucceeded).not.toHaveBeenCalled();
    expect(operation.state).toBe("running");
  });

  it("does not let a stale authorization failure terminate a newer retry", async () => {
    const operation: any = {
      operationId: "op1",
      repo: "o/r",
      environment: "dev",
      state: "running",
      currentStage: "verify",
      context: { githubLogin: "alice" },
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "main",
        environment: "dev",
        runId: "55",
        retryCommandId: "cmd-old"
      }
    };
    let executor = successfulSelectedGhExecutor({ login: "alice" });
    const finish = vi.fn();
    const persistOperations = vi.fn(() => Promise.resolve());
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&environment=dev&operationId=op1"
    );

    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => operation,
        getSelectedGitHubExecutor: () => executor,
        hasCompleteVerificationIdentity: () => true,
        getRunDetail: () => {
          operation.verification = {
            ...operation.verification,
            dispatchedAt: 456,
            runId: "77",
            retryCommandId: "cmd-new"
          };
          executor = successfulSelectedGhExecutor({ login: "alice" });
          return Promise.reject(
            new SelectedGhAuthorizationError(
              "alice",
              403,
              "gh: Forbidden (HTTP 403)"
            )
          );
        },
        isSelectedGitHubAuthorizationError: isSelectedGhAuthorizationError,
        finish,
        persistOperations
      })
    );

    expect(JSON.parse(recording.body)).toEqual({
      state: "pending",
      runId: "77"
    });
    expect(finish).not.toHaveBeenCalled();
    expect(persistOperations).not.toHaveBeenCalled();
    expect(operation.state).toBe("running");
  });

  it("fails an operation-scoped verification closed without a saved account", async () => {
    const operation = {
      repo: "o/r",
      environment: "dev",
      context: {},
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "main",
        environment: "dev",
        runId: null
      }
    };
    const findWorkflowRun = vi.fn(() => Promise.resolve(null));
    const finish = vi.fn();
    const persistBestEffort = vi.fn(() => Promise.resolve(true));
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&environment=dev&operationId=op1"
    );
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => operation,
        hasCompleteVerificationIdentity,
        getSelectedGitHubExecutor: () => undefined,
        findWorkflowRun,
        addLegacyStep: vi.fn(),
        finish,
        persistBestEffort,
        persistOperations: () => Promise.resolve(),
        reportOperationDiagnostic: () => {}
      })
    );
    expect(findWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(recording.body)).toEqual({
      state: "failed",
      terminal: true,
      code: "verification-retry-github-account-missing",
      runId: null,
      error:
        "Radius cannot monitor credential verification because this operation does not name the GitHub account that started it."
    });
    expect(finish).toHaveBeenCalledWith(
      operation,
      "failed_partial",
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "verification-retry-github-account-missing"
        })
      })
    );
  });

  it("does not cache an unmarked run when there is no operation", async () => {
    const state: Record<string, unknown> = { deployDispatchedAt: 123 };
    const findWorkflowRun = vi.fn(() => Promise.resolve(555));
    const { recording, ctx } = context("GET", "/api/verify-status?repo=o/r");
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => ({ state: state as never }),
        findWorkflowRun,
        getRunDetail: () => Promise.resolve(null)
      })
    );
    expect(findWorkflowRun).not.toHaveBeenCalled();
    expect(state.verifyRunId).toBeUndefined();
    expect(JSON.parse(recording.body)).toEqual({
      state: "pending",
      runId: null
    });
  });

  it("reports in_progress with the active step name", async () => {
    const { recording, ctx } = context("GET", "/api/verify-status?repo=o/r");
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => ({ state: { verifyRunId: 9 } as never }),
        getRunDetail: () =>
          Promise.resolve(
            detail({
              status: "in_progress",
              conclusion: null,
              steps: [{ name: "Azure Login", status: "in_progress" }]
            })
          )
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      state: "in_progress",
      runId: 9,
      runUrl: "https://github.com/o/r/actions/runs/9",
      activity: "Azure Login"
    });
  });

  it("records completion once when repeated polls observe verification success", async () => {
    const addLegacyStep = vi.fn();
    const finishSucceeded = vi.fn((operation: { state: string }) => {
      operation.state = "succeeded";
    });
    const persistBestEffort = vi.fn(() => Promise.resolve(true));
    const op = {
      repo: "o/r",
      environment: "dev",
      context: { githubLogin: "octocat" },
      state: "running",
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: 9 }
    };
    const dependencies = deps({
      readInstanceEntry: () => undefined,
      getOperation: () => op,
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () => Promise.resolve(detail({})),
      addLegacyStep,
      isTerminalState: isSetupTerminalState,
      finishSucceeded,
      persistBestEffort,
      persistOperations: () => Promise.resolve(),
      reportOperationDiagnostic: () => {}
    });
    const first = context("GET", "/api/verify-status?repo=o/r&operationId=op1");
    const second = context(
      "GET",
      "/api/verify-status?repo=o/r&operationId=op1"
    );
    await handleVerifyStatus(first.ctx, dependencies);
    await handleVerifyStatus(second.ctx, dependencies);

    expect(addLegacyStep).toHaveBeenCalledWith(
      op,
      "✅ Environment created. Deploy your application from the Environments list when ready."
    );
    expect(addLegacyStep).toHaveBeenCalledOnce();
    expect(finishSucceeded).toHaveBeenCalledOnce();
    expect(persistBestEffort).toHaveBeenCalledOnce();
    expect(JSON.parse(first.recording.body)).toEqual({
      state: "success",
      runId: 9,
      runUrl: "https://github.com/o/r/actions/runs/9"
    });
    expect(JSON.parse(second.recording.body)).toEqual({
      state: "success",
      runId: 9,
      runUrl: "https://github.com/o/r/actions/runs/9"
    });
  });

  it("finishes a non-terminal verification operation that is not running", async () => {
    const op = {
      repo: "o/r",
      environment: "dev",
      context: { githubLogin: "octocat" },
      state: "input_required",
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: 9 }
    };
    const finishSucceeded = vi.fn((operation: { state: string }) => {
      operation.state = "succeeded";
    });
    const persistBestEffort = vi.fn(() => Promise.resolve(true));
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&operationId=op1"
    );

    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => op,
        hasCompleteVerificationIdentity: () => true,
        getRunDetail: () => Promise.resolve(detail({})),
        addLegacyStep: vi.fn(),
        isTerminalState: isSetupTerminalState,
        finishSucceeded,
        persistBestEffort,
        persistOperations: () => Promise.resolve(),
        reportOperationDiagnostic: () => {}
      })
    );

    expect(finishSucceeded).toHaveBeenCalledOnce();
    expect(persistBestEffort).toHaveBeenCalledOnce();
    expect(JSON.parse(recording.body)).toEqual({
      state: "success",
      runId: 9,
      runUrl: "https://github.com/o/r/actions/runs/9"
    });
  });

  it("reports failure with error lines and OIDC help, and finishes partial", async () => {
    const finish = vi.fn();
    const { recording, ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&operationId=op1"
    );
    const op = {
      repo: "o/r",
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: 9 }
    };
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => op,
        hasCompleteVerificationIdentity: () => true,
        getRunDetail: () =>
          Promise.resolve(
            detail({
              conclusion: "failure",
              steps: [{ name: "Verify", conclusion: "failure" }]
            })
          ),
        fetchRunLog: () => Promise.resolve("log"),
        extractErrorLines: () => ["boom"],
        extractGitHubActionsStepLog: () => "azure log",
        explainOidcEnterpriseClaim: () => "OIDC help",
        finish,
        persistBestEffort: () => Promise.resolve(true),
        persistOperations: () => Promise.resolve(),
        reportOperationDiagnostic: () => {}
      })
    );
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(
      op,
      "failed_partial",
      expect.objectContaining({
        failure: expect.objectContaining({ code: "verify-run-failed" })
      })
    );
    const parsed = JSON.parse(recording.body);
    expect(parsed.state).toBe("failed");
    expect(parsed.error).toContain("OIDC help");
    expect(parsed.error).toContain("Failed step: Verify.");
    expect(parsed.error).toContain("boom");
  });

  it.each([
    [
      "a missing Azure subscription",
      "Azure Login (OIDC)",
      "The identity cannot see a subscription.",
      "No subscriptions found"
    ],
    [
      "the AKS access verification step with an authorization refusal",
      "Verify AKS Access",
      "",
      "Error from server (Forbidden): service account cannot get resource pods"
    ]
  ])(
    "classifies %s as an RBAC verification failure",
    async (_label, stepName, rbacHelp, runLog) => {
      const finish = vi.fn();
      const { ctx } = context(
        "GET",
        "/api/verify-status?repo=o/r&operationId=op1"
      );
      const op = {
        repo: "o/r",
        environment: "dev",
        context: { githubLogin: "octocat" },
        currentStage: "verify",
        verification: { dispatchedAt: 1, runId: 9 }
      };

      await handleVerifyStatus(
        ctx,
        deps({
          readInstanceEntry: () => undefined,
          getOperation: () => op,
          hasCompleteVerificationIdentity: () => true,
          getRunDetail: () =>
            Promise.resolve(
              detail({
                conclusion: "failure",
                steps: [{ name: stepName, conclusion: "failure" }]
              })
            ),
          fetchRunLog: () => Promise.resolve(runLog),
          extractErrorLines: () => [],
          extractGitHubActionsStepLog: () => "No subscriptions found",
          explainOidcEnterpriseClaim: () => "",
          explainNoSubscriptions: () => rbacHelp,
          finish,
          persistBestEffort: () => Promise.resolve(true)
        })
      );

      expect(finish).toHaveBeenCalledWith(
        op,
        "failed_partial",
        expect.objectContaining({
          failure: expect.objectContaining({ code: "verify-run-rbac-failed" })
        })
      );
    }
  );

  it("does not call a runner failure in the AKS access step RBAC propagation", async () => {
    const finish = vi.fn();
    const { ctx } = context(
      "GET",
      "/api/verify-status?repo=o/r&operationId=op1"
    );
    const op = {
      repo: "o/r",
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: 9 }
    };

    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => undefined,
        getOperation: () => op,
        hasCompleteVerificationIdentity: () => true,
        getRunDetail: () =>
          Promise.resolve(
            detail({
              conclusion: "failure",
              steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
            })
          ),
        fetchRunLog: () => Promise.resolve(null),
        extractErrorLines: () => [],
        extractGitHubActionsStepLog: () => "",
        explainOidcEnterpriseClaim: () => "",
        explainNoSubscriptions: () => "",
        finish,
        persistBestEffort: () => Promise.resolve(true)
      })
    );

    expect(finish).toHaveBeenCalledWith(
      op,
      "failed_partial",
      expect.objectContaining({
        failure: expect.objectContaining({ code: "verify-run-failed" })
      })
    );
  });

  it("maps a thrown collaborator to an unknown state", async () => {
    const { recording, ctx } = context("GET", "/api/verify-status?repo=o/r");
    await handleVerifyStatus(
      ctx,
      deps({
        readInstanceEntry: () => {
          throw new Error("state gone");
        }
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      state: "unknown",
      error: "state gone"
    });
  });
});

describe("environments — registry", () => {
  it("registers exactly the five migrated environment routes", () => {
    const registry = createEnvironmentsRoutes(deps({}));
    expect(Object.keys(registry).sort()).toEqual([
      "GET /api/list-environments",
      "GET /api/verify-status",
      "POST /api/app-params",
      "POST /api/bypass-verification",
      "POST /api/delete-environment"
    ]);
  });
});

// Real HTTP over an OS-assigned loopback port, driven through the same route
// table the panel hits. Reuses the shared `getOrCreateServer` fixture rather
// than standing up a second server.
describe("environments — real loopback", () => {
  let baseUrl = "";
  let entry: CanvasServerEntry | undefined;

  beforeAll(async () => {
    entry = await getOrCreateServer(
      "environments-loopback-test",
      "environment"
    );
    baseUrl = entry.baseUrl;
  });

  afterAll(() => {
    try {
      entry?.server?.close();
    } catch {
      /* best-effort */
    }
  });

  it("answers GET list-environments with no-store and an empty list", async () => {
    const res = await fetch(baseUrl + "/api/list-environments");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ environments: [] });
  });

  it("serves an aged-out verification status as unknown over controlled HTTP", async () => {
    const script: CliScript = {
      ["/repos/octo/app/actions/workflows/radius-verify-credentials.yml/runs?per_page=100"]:
        {
          stdout: "42\tcompleted\tsuccess"
        },
      ["/repos/octo/app/environments?per_page=100"]: { stdout: "7\tdev" },
      ["/repos/octo/app/environments/dev/variables?per_page=100"]: {
        stdout: "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc"
      },
      ["/repos/octo/app/deployments?environment=dev&per_page=10"]: {
        stdout: "100"
      },
      ["/repos/octo/app/deployments/100/statuses?per_page=1"]: {
        stdout: "https://github.com/octo/app/actions/runs/99"
      }
    };
    const container = createControlledEnvironmentServer({
      envListCacheGet: () => undefined,
      envListCacheGeneration: () => 0,
      envListCacheSet: vi.fn(),
      now: () => 0,
      cliExec: cliFake(script),
      readInstanceEntry: () => undefined,
      repoMatchesWorkspace: () => false,
      kickoffWorkflowSync: vi.fn()
    });

    try {
      const controlled = await container.getOrCreate("unknown-verification");
      const res = await fetch(
        controlled.baseUrl + "/api/list-environments?repo=octo/app"
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        environments: [
          expect.objectContaining({ name: "dev", status: "unknown" })
        ]
      });
    } finally {
      await container.stopAll();
    }
  });

  it("fails closed when verification history cannot be read", async () => {
    const script: CliScript = {
      ["/repos/octo/app/actions/workflows/radius-verify-credentials.yml/runs?per_page=100"]:
        { error: new Error("github unavailable") },
      ["/repos/octo/app/environments?per_page=100"]: { stdout: "7\tdev" },
      ["/repos/octo/app/environments/dev/variables?per_page=100"]: {
        stdout: "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc"
      },
      ["/repos/octo/app/deployments?environment=dev&per_page=10"]: {
        stdout: "100"
      }
    };
    const container = createControlledEnvironmentServer({
      envListCacheGet: () => undefined,
      envListCacheGeneration: () => 0,
      envListCacheSet: vi.fn(),
      now: () => 0,
      cliExec: cliFake(script),
      readInstanceEntry: () => undefined,
      repoMatchesWorkspace: () => false,
      kickoffWorkflowSync: vi.fn()
    });
    try {
      const controlled = await container.getOrCreate(
        "verification-lookup-failure"
      );
      const res = await fetch(
        controlled.baseUrl + "/api/list-environments?repo=octo/app"
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        environments: [
          expect.objectContaining({ name: "dev", status: "pending" })
        ]
      });
    } finally {
      await container.stopAll();
    }
  });

  it("fails closed when a deployment status lookup cannot be read", async () => {
    const script: CliScript = {
      ["/repos/octo/app/actions/workflows/radius-verify-credentials.yml/runs?per_page=100"]:
        { stdout: "42\tcompleted\tsuccess" },
      ["/repos/octo/app/environments?per_page=100"]: { stdout: "7\tdev" },
      ["/repos/octo/app/environments/dev/variables?per_page=100"]: {
        stdout: "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc"
      },
      ["/repos/octo/app/deployments?environment=dev&per_page=10"]: {
        stdout: "100"
      },
      ["/repos/octo/app/deployments/100/statuses?per_page=1"]: {
        error: new Error("secondary rate limit")
      }
    };
    const container = createControlledEnvironmentServer({
      envListCacheGet: () => undefined,
      envListCacheGeneration: () => 0,
      envListCacheSet: vi.fn(),
      now: () => 0,
      cliExec: cliFake(script),
      readInstanceEntry: () => undefined,
      repoMatchesWorkspace: () => false,
      kickoffWorkflowSync: vi.fn()
    });
    try {
      const controlled = await container.getOrCreate("status-lookup-failure");
      const res = await fetch(
        controlled.baseUrl + "/api/list-environments?repo=octo/app"
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        environments: [
          expect.objectContaining({ name: "dev", status: "pending" })
        ]
      });
    } finally {
      await container.stopAll();
    }
  });

  it("records a verification bypass over controlled HTTP", async () => {
    const runCommand = vi.fn().mockResolvedValue("RADIUS_MANAGED");
    const envListCacheDelete = vi.fn();
    const container = createControlledEnvironmentServer({
      runCommand,
      envListCacheDelete,
      getOperation: () => ({
        repo: "octo/app",
        environment: "dev",
        context: { githubLogin: "octocat" },
        verification: { runId: "555" }
      }),
      getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () =>
        Promise.resolve({
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
        }),
      fetchRunLog: () =>
        Promise.resolve("Error from server (Forbidden): cannot list resource"),
      extractGitHubActionsStepLog: () => "",
      explainOidcEnterpriseClaim: () => "",
      explainNoSubscriptions: () => ""
    });
    try {
      const controlled = await container.getOrCreate("bypass-verification");
      const res = await fetch(controlled.baseUrl + "/api/bypass-verification", {
        method: "POST",
        body: JSON.stringify({
          repo: "octo/app",
          environment: "dev",
          operationId: "op1",
          runId: "555"
        })
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        category: "permissions"
      });
      expect(runCommand).toHaveBeenCalledWith(
        "gh",
        [
          "variable",
          "set",
          "RADIUS_VERIFICATION_BYPASSED",
          "--body",
          "555",
          "--env",
          "dev",
          "--repo",
          "octo/app"
        ],
        { timeout: 20000 }
      );
      expect(envListCacheDelete).toHaveBeenCalledWith("octo/app");
    } finally {
      await container.stopAll();
    }
  });

  it("answers GET verify-status for a missing repo", async () => {
    const res = await fetch(baseUrl + "/api/verify-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "unknown",
      error: "No repository specified."
    });
  });

  it("does not let an unrelated successful run finish initial verification", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev"
      }
    };
    const findWorkflowRun = vi.fn(() => Promise.resolve(55));
    const getRunDetail = vi.fn(() => Promise.resolve(null));
    const persistOperations = vi.fn(() => Promise.resolve());
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      findWorkflowRun,
      getRunDetail,
      persistBestEffort,
      persistOperations,
      reportOperationDiagnostic: () => {}
    });
    try {
      const controlled = await container.getOrCreate("verify-discovery");
      const res = await fetch(
        controlled.baseUrl +
          "/api/verify-status?repo=octo/app&environment=dev&operationId=op-1"
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: "pending",
        runId: null
      });
      expect(findWorkflowRun).not.toHaveBeenCalled();
      expect(getRunDetail).not.toHaveBeenCalled();
      expect(operation.verification).toEqual({
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev"
      });
      expect(persistOperations).not.toHaveBeenCalled();
    } finally {
      await container.stopAll();
    }
  });

  it("persists terminal verification success over controlled HTTP", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
      context: { githubLogin: "octocat" },
      state: "running",
      currentStage: "verify",
      stages: [{ id: "verify", state: "running" }],
      steps: [],
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev",
        runId: "55"
      }
    };
    const persistOperations = vi.fn(() => Promise.resolve());
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () =>
        Promise.resolve({
          status: "completed",
          conclusion: "success",
          steps: []
        }),
      addLegacyStep: recordLegacyStep,
      isTerminalState: isSetupTerminalState,
      finishSucceeded: finishSetupSucceeded,
      persistBestEffort,
      persistOperations,
      reportOperationDiagnostic: () => {}
    });
    try {
      const controlled = await container.getOrCreate("verify-success");
      const res = await fetch(
        controlled.baseUrl +
          "/api/verify-status?repo=octo/app&environment=dev&operationId=op-1"
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: "success",
        runId: "55",
        runUrl: "https://github.com/octo/app/actions/runs/55"
      });
      expect(operation.state).toBe("succeeded");
      expect(operation.steps).toEqual([
        expect.objectContaining({
          stage: "verify",
          kind: "observation",
          label:
            "Environment created. Deploy your application from the Environments list when ready.",
          state: "succeeded"
        })
      ]);
      expect(persistOperations).toHaveBeenCalledOnce();
    } finally {
      await container.stopAll();
    }
  });

  it("persists terminal verification failure over controlled HTTP", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev",
        runId: "55"
      }
    };
    const finish = vi.fn();
    const persistOperations = vi.fn(() => Promise.resolve());
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () =>
        Promise.resolve({
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Verify", conclusion: "failure" }]
        }),
      fetchRunLog: () => Promise.resolve("raw log"),
      extractErrorLines: () => ["boom"],
      extractGitHubActionsStepLog: () => "",
      explainOidcEnterpriseClaim: () => "",
      explainNoSubscriptions: () => "",
      finish,
      persistBestEffort,
      persistOperations,
      reportOperationDiagnostic: () => {}
    });
    try {
      const controlled = await container.getOrCreate("verify-failure");
      const res = await fetch(
        controlled.baseUrl +
          "/api/verify-status?repo=octo/app&environment=dev&operationId=op-1"
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: "failed",
        runId: "55",
        runUrl: "https://github.com/octo/app/actions/runs/55",
        error:
          "Credential verification failed (failure). Failed step: Verify.\nboom",
        category: "generic"
      });
      expect(finish).toHaveBeenCalledWith(operation, "failed_partial", {
        failure: {
          code: "verify-run-failed",
          stage: "verify",
          message: "Credential verification failed. Failed step: Verify.",
          classification: "user-fixable",
          evidence:
            "Credential verification failed (failure). Failed step: Verify.\nboom"
        }
      });
      expect(persistOperations).toHaveBeenCalledOnce();
    } finally {
      await container.stopAll();
    }
  });

  it("classifies a cluster-access verification failure with category and permissions", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev",
        runId: "77"
      }
    };
    const finish = vi.fn();
    const persistOperations = vi.fn(() => Promise.resolve());
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () =>
        Promise.resolve({
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Check AKS cluster access", conclusion: "failure" }]
        }),
      fetchRunLog: () =>
        Promise.resolve(
          "Error: AuthorizationFailed. The client does not have permission to perform action 'Microsoft.ContainerService/managedClusters/read'."
        ),
      extractErrorLines: () => ["denied"],
      extractGitHubActionsStepLog: () => "",
      explainOidcEnterpriseClaim: () => "",
      explainNoSubscriptions: () => "",
      finish,
      persistBestEffort,
      persistOperations,
      reportOperationDiagnostic: () => {}
    });
    try {
      const controlled = await container.getOrCreate("verify-cluster-failure");
      const res = await fetch(
        controlled.baseUrl +
          "/api/verify-status?repo=octo/app&environment=dev&operationId=op-1"
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        state: string;
        category: string;
        component?: string;
        missingPermissions?: string[];
      };
      expect(body.state).toBe("failed");
      expect(body.category).toBe("permissions");
      expect(body.component).toBeUndefined();
      expect(body.missingPermissions).toEqual([
        "Microsoft.ContainerService/managedClusters/read"
      ]);
      expect(persistOperations).toHaveBeenCalledOnce();
    } finally {
      await container.stopAll();
    }
  });

  it("400s POST app-params with no repo", async () => {
    const res = await fetch(baseUrl + "/api/app-params", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "No repository specified.",
      params: []
    });
  });

  it("fails closed on POST delete-environment with missing fields", async () => {
    // The destructive route is exercised over the socket. With no
    // repo/environment it must refuse at the first rung (400) before any
    // active-app check or DELETE — the fail-closed guard, on the wire.
    const res = await fetch(baseUrl + "/api/delete-environment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "octo/app" })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "repo and environment are required."
    });
  });

  it("fails closed at 503 when the active-app check fails over controlled HTTP", async () => {
    const runCommand = vi.fn(() => Promise.resolve(""));
    const envListCacheDelete = vi.fn();
    const logError = vi.fn();
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      resolveRepoAppName: () => Promise.resolve("todo-app"),
      resolveEnvDeployment: () =>
        Promise.reject(new Error("github unavailable")),
      logError,
      runCommand,
      envListCacheDelete
    });
    try {
      const controlled = await container.getOrCreate("delete-check-failure");
      const res = await fetch(controlled.baseUrl + "/api/delete-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "octo/app", environment: "dev" })
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error:
          'Could not verify whether an application is still deployed to "dev" ' +
          "(GitHub API error: github unavailable). The environment was not " +
          "deleted — please try again."
      });
      expect(logError).toHaveBeenCalledWith(
        "[radius delete-environment] active-app check failed for " +
          "octo/app/dev: github unavailable"
      );
      expect(runCommand).not.toHaveBeenCalled();
      expect(envListCacheDelete).not.toHaveBeenCalled();
    } finally {
      await container.stopAll();
    }
  });

  it("refuses an active application at 409 over controlled HTTP", async () => {
    const runCommand = vi.fn(() => Promise.resolve(""));
    const envListCacheDelete = vi.fn();
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      resolveRepoAppName: () => Promise.resolve("todo-app"),
      resolveEnvDeployment: () =>
        Promise.resolve({
          app: "todo-app",
          environment: "dev",
          provider: "azure",
          status: "deployed",
          deploymentId: "deployment-1",
          runUrl: "https://example.test/run"
        }),
      runCommand,
      envListCacheDelete
    });
    try {
      const controlled = await container.getOrCreate("delete-active");
      const res = await fetch(controlled.baseUrl + "/api/delete-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "octo/app", environment: "dev" })
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          'Application "todo-app" is still deployed to environment "dev". ' +
          "Delete the application deployment first, then delete the environment.",
        code: "app-deployed",
        app: "todo-app",
        environment: "dev",
        redirect: "/?page=deploying&app=todo-app&env=dev"
      });
      expect(runCommand).not.toHaveBeenCalled();
      expect(envListCacheDelete).not.toHaveBeenCalled();
    } finally {
      await container.stopAll();
    }
  });

  it("starts a delete operation and 202s over controlled HTTP", async () => {
    const op: DeleteOperationRecord = {
      operationId: "op-http-del",
      currentStage: "delete-radius-env"
    };
    const scheduleEnvironmentOperation = vi.fn(() => true);
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      resolveRepoAppName: () => Promise.resolve("todo-app"),
      resolveEnvDeployment: () => Promise.resolve(null),
      discoverEnvironmentTarget: () =>
        Promise.resolve({
          provider: "azure",
          clientId: "app-xyz",
          tenantId: "tenant-1",
          repoId: 7
        }),
      createOperation: () => op,
      buildDeleteStages: () => [{ id: "s", state: "pending" }],
      startOperation: () => ({ ok: true as const, operation: op }),
      persistOperations: () => Promise.resolve(),
      toClientView: () => ({ operationId: "op-http-del" }),
      scheduleEnvironmentOperation
    });
    try {
      const controlled = await container.getOrCreate("delete-success");
      const res = await fetch(controlled.baseUrl + "/api/delete-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "octo/app", environment: "dev" })
      });
      expect(res.status).toBe(202);
      expect(res.headers.get("Location")).toBe("/api/operations/op-http-del");
      const body = (await res.json()) as {
        operationId: string;
        operation: unknown;
      };
      expect(body.operationId).toBe("op-http-del");
      expect(body.operation).toEqual({ operationId: "op-http-del" });
      expect(scheduleEnvironmentOperation).toHaveBeenCalledOnce();
    } finally {
      await container.stopAll();
    }
  });

  it("400s a malformed delete-environment body over the socket", async () => {
    // A non-empty, non-JSON body reaches the outer catch (the handler reads the
    // body manually and `JSON.parse` throws), answering 400 rather than a 413 or
    // a global 500. This is the malformed-input path over a real socket.
    const res = await fetch(baseUrl + "/api/delete-environment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json"
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    // Not the rung-1 message: this is the parse-failure catch, a distinct rung.
    expect(body.error).not.toBe("repo and environment are required.");
  });

  it("delegates a wrong method on a typed path to unmatched routing", async () => {
    // POST to a GET-only path must not be answered by its typed handler. The tell
    // is that the no-store list-environments body is absent.
    const res = await fetch(baseUrl + "/api/list-environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const text = await res.text();
    expect(res.headers.get("cache-control")).not.toBe("no-store");
    expect(text).not.toContain('"environments":[]');
  });

  it("keeps create-environment in its sibling module and enforces its server-owned guard", async () => {
    // The large create action has its own typed module rather than being folded
    // into this environment read/write registry.
    const registry = createEnvironmentsRoutes(deps({}));
    expect(Object.keys(registry)).not.toContain("POST /api/create-environment");
    const res = await fetch(baseUrl + "/api/create-environment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
  });
});

// A focused check that the dispatcher delegates a method mismatch to the
// explicit unmatched handler without needing a live socket.
describe("environments — dispatcher method fallthrough", () => {
  it("hands a POST on a GET-only route to the unmatched handler", async () => {
    const handleUnmatchedRequest = vi.fn(
      (_req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
        res.writeHead(404);
        res.end("unmatched");
      }
    );
    const routes = createServerRouteTableForTest();
    const handler = createRequestHandler({
      instanceId: "panel",
      instances: new Map<string, CanvasServerEntry>(),
      routes,
      handleUnmatchedRequest,
      markActivity: () => {}
    });
    const { recording, response } = recorder();
    await handler(request("POST", "/api/list-environments"), response);
    expect(handleUnmatchedRequest).toHaveBeenCalledOnce();
    expect(recording.status).toBe(404);
  });
});

// Builds a route table containing the environments family plus enough of the
// declared routes to satisfy table validation, using the same production-shaped
// no-op doubles the boundary suite uses.
function createServerRouteTableForTest(): readonly ServerRoute[] {
  // The full production table is validated in route-table.test.ts. Here we only
  // need the environments family wired as real ServerRoutes so the dispatcher's
  // method-matching and unmatched dispatch can be exercised, so we build a
  // minimal, self-contained table from the environments registry.
  const registry = createEnvironmentsRoutes(deps({}));
  const route = (method: "GET" | "POST", path: string): ServerRoute => ({
    method,
    path,
    match: "exact",
    bodyPolicy: method === "POST" ? "json" : "none",
    mutationPolicy: method === "POST" ? "legacy-exempt" : "none",
    owner: "environments",
    handler: registry[`${method} ${path}`]
  });
  return [
    route("POST", "/api/app-params"),
    route("POST", "/api/delete-environment"),
    route("GET", "/api/list-environments"),
    route("GET", "/api/verify-status")
  ];
}
