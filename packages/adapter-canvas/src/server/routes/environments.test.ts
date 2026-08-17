import { Readable } from "node:stream";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvasServer } from "../create-canvas-server.js";
import { createRequestContext } from "../request-context.js";
import { createRequestHandler } from "../create-request-handler.js";
import { type ServerRoute } from "../route-table.js";
import {
  createEnvironmentsRoutes,
  handleAppParams,
  handleDeleteEnvironment,
  handleListEnvironments,
  handleVerifyStatus,
  type EnvironmentActiveDeployment,
  type EnvironmentRunDetail,
  type EnvironmentsDependencies,
  type EnvironmentsInstanceEntry
} from "./environments.js";
import type { CanvasServerEntry } from "../types.js";
import { getOrCreateServer, persistBestEffort } from "../../server.js";
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
    repoMatchesWorkspace: unset("repoMatchesWorkspace") as never,
    readInstanceEntry: unset("readInstanceEntry") as never,
    runCommand: unset("runCommand") as never,
    fetchFileFromRepo: unset("fetchFileFromRepo") as never,
    appParams: unset("appParams") as never,
    resolveRepoAppName: unset("resolveRepoAppName") as never,
    resolveEnvDeployment: unset("resolveEnvDeployment") as never,
    logError: unset("logError") as never,
    cliExec: unset("cliExec") as never,
    envListCacheGet: unset("envListCacheGet") as never,
    envListCacheSet: unset("envListCacheSet") as never,
    envListCacheDelete: unset("envListCacheDelete") as never,
    envListTtlMs: 15000,
    kickoffWorkflowSync: unset("kickoffWorkflowSync") as never,
    now: unset("now") as never,
    getOperation: unset("getOperation") as never,
    hasCompleteVerificationIdentity: unset(
      "hasCompleteVerificationIdentity"
    ) as never,
    findWorkflowRun: unset("findWorkflowRun") as never,
    getRunDetail: unset("getRunDetail") as never,
    fetchRunLog: unset("fetchRunLog") as never,
    extractErrorLines: unset("extractErrorLines") as never,
    extractGitHubActionsStepLog: unset("extractGitHubActionsStepLog") as never,
    explainOidcEnterpriseClaim: unset("explainOidcEnterpriseClaim") as never,
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

  it("rung 4: 500 when the DELETE command fails", async () => {
    const runCommand = vi.fn(() => Promise.reject(new Error("boom")));
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
        runCommand
      })
    );
    expect(recording.status).toBe(500);
    expect(JSON.parse(recording.body)).toEqual({
      error: "Could not delete environment: boom"
    });
  });

  it("clean pass: deletes, invalidates the cache, and 200s", async () => {
    const runCommand = vi.fn(() => Promise.resolve(""));
    const envListCacheDelete = vi.fn();
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
        runCommand,
        envListCacheDelete
      })
    );
    expect(runCommand).toHaveBeenCalledWith(
      "gh",
      ["api", "--method", "DELETE", "/repos/o/r/environments/dev"],
      { timeout: 20000 }
    );
    expect(envListCacheDelete).toHaveBeenCalledWith("o/r");
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({ success: true });
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
        cliExec: cliFake(script)
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "403"
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
        credentialProfile: "prod"
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
        cliExec
      })
    );
    expect(JSON.parse(recording.body)).toEqual({
      environments: [],
      error: "spawn failed"
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
        getOperation: () => ({ repo: "o/r", environment: "dev" }),
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

  it("caches a discovered run id onto instance state when there is no operation", async () => {
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
    expect(findWorkflowRun).toHaveBeenCalledWith(
      "o/r",
      "radius-verify-credentials.yml",
      123,
      null
    );
    expect(state.verifyRunId).toBe(555);
    expect(JSON.parse(recording.body)).toEqual({
      state: "pending",
      runId: 555,
      runUrl: "https://github.com/o/r/actions/runs/555"
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

  it("reports success and finishes a verify-stage operation", async () => {
    const finishSucceeded = vi.fn();
    const persistBestEffort = vi.fn(() => Promise.resolve(true));
    const op = {
      repo: "o/r",
      environment: "dev",
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: 9 }
    };
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
        finishSucceeded,
        persistBestEffort,
        persistOperations: () => Promise.resolve(),
        reportOperationDiagnostic: () => {}
      })
    );
    expect(finishSucceeded).toHaveBeenCalledWith(op);
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
    const parsed = JSON.parse(recording.body);
    expect(parsed.state).toBe("failed");
    expect(parsed.error).toContain("OIDC help");
    expect(parsed.error).toContain("Failed step: Verify.");
    expect(parsed.error).toContain("boom");
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
  it("registers exactly the four migrated environment routes", () => {
    const registry = createEnvironmentsRoutes(deps({}));
    expect(Object.keys(registry).sort()).toEqual([
      "GET /api/list-environments",
      "GET /api/verify-status",
      "POST /api/app-params",
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

  it("answers GET verify-status for a missing repo", async () => {
    const res = await fetch(baseUrl + "/api/verify-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "unknown",
      error: "No repository specified."
    });
  });

  it("discovers and persists a matched operation run id over controlled HTTP", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
      currentStage: "verify",
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev"
      }
    };
    const findWorkflowRun = vi.fn(() => Promise.resolve(55));
    const persistOperations = vi.fn(() => Promise.resolve());
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      findWorkflowRun,
      getRunDetail: () => Promise.resolve(null),
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
        runId: 55,
        runUrl: "https://github.com/octo/app/actions/runs/55"
      });
      expect(findWorkflowRun).toHaveBeenCalledWith(
        "octo/app",
        "verify.yml",
        123,
        null
      );
      expect(operation.verification).toEqual({
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev",
        runId: "55",
        runUrl: "https://github.com/octo/app/actions/runs/55"
      });
      expect(persistOperations).toHaveBeenCalledOnce();
    } finally {
      await container.stopAll();
    }
  });

  it("persists terminal verification success over controlled HTTP", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
      currentStage: "verify",
      verification: {
        dispatchedAt: 123,
        workflow: "verify.yml",
        ref: "feature",
        environment: "dev",
        runId: "55"
      }
    };
    const finishSucceeded = vi.fn();
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
      finishSucceeded,
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
      expect(finishSucceeded).toHaveBeenCalledWith(operation);
      expect(persistOperations).toHaveBeenCalledOnce();
    } finally {
      await container.stopAll();
    }
  });

  it("persists terminal verification failure over controlled HTTP", async () => {
    const operation = {
      repo: "octo/app",
      environment: "dev",
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
          "Credential verification failed (failure). Failed step: Verify.\nboom"
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

  it("deletes and invalidates the environment cache over controlled HTTP", async () => {
    const runCommand = vi.fn(() => Promise.resolve(""));
    const envListCacheDelete = vi.fn();
    const container = createControlledEnvironmentServer({
      readInstanceEntry: () => undefined,
      resolveRepoAppName: () => Promise.resolve("todo-app"),
      resolveEnvDeployment: () => Promise.resolve(null),
      runCommand,
      envListCacheDelete
    });
    try {
      const controlled = await container.getOrCreate("delete-success");
      const res = await fetch(controlled.baseUrl + "/api/delete-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "octo/app", environment: "dev" })
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(runCommand).toHaveBeenCalledWith(
        "gh",
        ["api", "--method", "DELETE", "/repos/octo/app/environments/dev"],
        { timeout: 20000 }
      );
      expect(envListCacheDelete).toHaveBeenCalledWith("octo/app");
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
