import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { LEGACY_ROUTE_INVENTORY } from "../../../src/server/route-table.js";
import { createDeploymentsReadsRoutes } from "../../../src/server/routes/deployments-reads.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type {
  DeployListCacheEntry,
  DeploymentRow
} from "../../../src/server/routes/deployments-reads.js";
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
  setEntryMissing(missing: boolean): void;
}

function row(environment: string): DeploymentRow {
  return {
    app: "todo-app",
    environment,
    provider: "azure",
    status: "deployed",
    deploymentId: `dep-${environment}`,
    runUrl: `https://example.test/${environment}`
  };
}

function start(): Harness {
  const state: CanvasState = {};
  const cache = new Map<string, DeployListCacheEntry>();
  const environments: string[] = [];
  const resets: unknown[] = [];
  let entryMissing = false;

  const routes = createTestRouteTable(
    createDeploymentsReadsRoutes({
      readInstanceEntry: () => (entryMissing ? undefined : { state }),
      triggerDeployRepairHandoff: () => false,
      deployHandoffStatus: (current) => ({
        state: current.deployHandoffState || "idle",
        attempts: current.deployHandoffAttempts || 0,
        maxAttempts: 3,
        pending: false
      }),
      resolveRepoAppName: (_repo, branch) =>
        Promise.resolve(`todo-app@${branch}`),
      resolveEnvDeployment: (_repo, environment) =>
        Promise.resolve(row(environment)),
      ghOrThrow: () => Promise.resolve(environments.join("\n")),
      resetDeploymentViewState: (_target, attemptId) => {
        resets.push(attemptId);
      },
      deployListCache: cache,
      deployListTtlMs: 15000
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
        legacyFallback: (_request, response) => {
          response.writeHead(418);
          response.end("legacy");
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
    setEntryMissing(missing) {
      entryMissing = missing;
    }
  };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("deployments read routes real-loopback HIT (RF-05)", () => {
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

  it("leaves a method the migrated declarations do not claim on the legacy fallback", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    // The three listings are declared GET-only and the reset POST-only, so the
    // opposite verb on the same path must still reach the fallback rather than
    // being swallowed by the migrated declaration.
    for (const path of [
      "/api/deploy-status",
      "/api/list-applications",
      "/api/list-deployments"
    ]) {
      const posted = await post(entry.baseUrl, path, "");
      expect(posted.status, path).toBe(418);
    }
    const got = await fetch(`${entry.baseUrl}/api/deploy-reset`);
    expect(got.status).toBe(418);
  });

  it("leaves the mutating deployments routes deferred to a later slice", () => {
    // Written out by hand so the two sides come from different sources: this
    // fires meaningfully when a later slice migrates either route, rather than
    // restating whatever the ledger happens to say.
    for (const key of ["POST /api/delete-deployment", "POST /api/deploy"]) {
      expect(LEGACY_ROUTE_INVENTORY).toContain(key);
    }
  });
});
