import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createEnvironmentsRoutes } from "../../../src/server/routes/environments.js";
import { createEnvironmentListingCache } from "../../../src/server/services/environment-listing-cache.js";
import { cleanupGitHubEnvironmentArtifact } from "../../../src/server.js";
import {
  createOperation,
  recordGitHubEnvironment
} from "../../../src/operations.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { EnvironmentsDependencies } from "../../../src/server/routes/environments.js";
import type { EnvironmentListingCache } from "../../../src/server/services/environment-listing-cache.js";

// The environment picker reads a repo-scoped, short-TTL cached listing. A
// rollback deletes the GitHub environment behind that listing outside the
// request that will serve it next, so the deleting pass has to invalidate the
// cache — otherwise the picker keeps answering with the rolled-back
// environment, still carrying the status its last verify run left behind.
//
// These cases drive the real listing route over loopback HTTP against the real
// cache the composition root owns, and remove the environment through the real
// rollback cleanup pass and the real delete route, wired the way
// `src/server.ts` wires them.

const REPO = "octo/app";
const TTL_MS = 15000;

interface CliScript {
  [apiPath: string]: { error?: Error; stdout?: string; stderr?: string };
}

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

/** The listing calls the route makes for a single managed `dev` environment. */
function listingScript(environments: string): CliScript {
  return {
    ["/repos/octo/app/actions/workflows/radius-verify-credentials.yml/runs?per_page=100"]:
      { stdout: "42\tcompleted\tsuccess" },
    ["/repos/octo/app/environments?per_page=100"]: { stdout: environments },
    ["/repos/octo/app/environments/dev/variables?per_page=100"]: {
      stdout: "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tabc"
    },
    ["/repos/octo/app/deployments?environment=dev&per_page=10"]: {
      stdout: "100"
    },
    ["/repos/octo/app/deployments/100/statuses?per_page=1"]: {
      stdout: "https://github.com/octo/app/actions/runs/42"
    }
  };
}

interface ListResult {
  status: number;
  cacheControl: string | null;
  body: unknown;
}

/**
 * A `gh` call held open at one API path, so a listing can be observed
 * mid-assembly: `reached` settles once the listing has got that far, and
 * `release` lets it finish.
 */
interface HeldCall {
  reached: Promise<void>;
  release(): void;
}

interface Harness {
  /** The production listing cache this server was composed with. */
  cache: EnvironmentListingCache;
  commands: string[][];
  setScript(script: CliScript): void;
  holdPath(path: string): HeldCall;
  invalidate(repo: string): void;
  list(): Promise<ListResult>;
  deleteEnvironment(
    environment: string
  ): Promise<{ status: number; body: unknown }>;
}

async function start(initialScript: CliScript): Promise<Harness> {
  // The real cache the composition root owns, wired exactly as `src/server.ts`
  // wires it, so the eviction and generation behavior under test is production
  // behavior rather than a restatement of it.
  const cache = createEnvironmentListingCache();
  const held = new Map<string, { gate: Promise<void>; markReached(): void }>();
  const commands: string[][] = [];
  let script = initialScript;
  const dependencies: Partial<EnvironmentsDependencies> = {
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    repoMatchesWorkspace: () => false,
    readInstanceEntry: () => undefined,
    resolveRepoAppName: async () => "store",
    // No application is deployed to the environment, so the delete route's
    // fail-closed guard passes and the deletion itself is what is observed.
    resolveEnvDeployment: async () => null,
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      return "";
    },
    cliExec: (_command, args, _options, callback) => {
      const path = args.find((arg) => arg.startsWith("/repos/")) ?? "";
      const answer = (): void => {
        const scripted = script[path];
        if (!scripted) {
          callback(new Error(`unscripted cliExec path: ${path}`), "", "");
          return;
        }
        callback(
          scripted.error ?? null,
          scripted.stdout ?? "",
          scripted.stderr ?? ""
        );
      };
      const gate = held.get(path);
      if (!gate) {
        answer();
        return;
      }
      gate.markReached();
      void gate.gate.then(answer);
    },
    envListCacheGet: (repo) => cache.get(repo),
    envListCacheSet: (repo, entry) => {
      cache.set(repo, entry);
    },
    envListCacheDelete: (repo) => {
      cache.invalidate(repo);
    },
    envListCacheGeneration: (repo) => cache.generation(repo),
    envListTtlMs: TTL_MS,
    // A frozen clock keeps the TTL from expiring on its own, so a listing that
    // refreshes proves invalidation rather than the passage of time.
    now: () => 0,
    kickoffWorkflowSync: () => {}
  };
  const routes = createTestRouteTable(
    createEnvironmentsRoutes(dependencies as EnvironmentsDependencies)
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
    defaultPage: "environment",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });
  const entry = await container.getOrCreate("environments-rollback-cache");
  return {
    cache,
    commands,
    setScript(next) {
      script = next;
    },
    holdPath(path) {
      let release = (): void => {};
      let markReached = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      held.set(path, { gate, markReached });
      return {
        reached,
        release() {
          held.delete(path);
          release();
        }
      };
    },
    invalidate(repo) {
      cache.invalidate(repo);
    },
    async list() {
      const response = await fetch(
        `${entry.baseUrl}/api/list-environments?repo=${encodeURIComponent(
          REPO
        )}`
      );
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: await response.json()
      };
    },
    async deleteEnvironment(environment) {
      const response = await fetch(`${entry.baseUrl}/api/delete-environment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: REPO, environment })
      });
      return { status: response.status, body: await response.json() };
    }
  };
}

function names(body: unknown): string[] {
  const environments = (body as { environments?: Array<{ name: string }> })
    .environments;
  return (environments ?? []).map((environment) => environment.name);
}

function statuses(body: unknown): string[] {
  const environments = (body as { environments?: Array<{ status: string }> })
    .environments;
  return (environments ?? []).map((environment) => environment.status);
}

function rolledBackOperation() {
  const operation = createOperation({
    provider: "azure",
    repo: REPO,
    environment: "dev"
  });
  recordGitHubEnvironment(operation, {
    state: "created",
    repo: REPO,
    name: "dev",
    // GitHub's own id for the environment. The deleting pass requires the
    // name to still answer for it, so a replacement created under the same
    // name is never what gets removed.
    providerId: "7"
  });
  return operation;
}

const ENV_PRESENT = {
  code: 0,
  stdout: JSON.stringify({ id: 7, name: "dev" }),
  stderr: ""
};
const ENV_GONE = { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };

/**
 * The reads one delete makes: the identity check before it, the environments
 * listing when absence has to be proven, and the confirming reread after.
 */
function environmentReader(stillThere: boolean) {
  let sawIdentity = false;
  return async (args: string[]) => {
    const path = args[1] ?? "";
    if (path.includes("/environments?")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          total_count: stillThere ? 1 : 0,
          environments: stillThere ? [{ name: "dev" }] : []
        }),
        stderr: ""
      };
    }
    if (!sawIdentity) {
      sawIdentity = true;
      return ENV_PRESENT;
    }
    return stillThere ? ENV_PRESENT : ENV_GONE;
  };
}

describe("environment listing cache after a rollback", () => {
  it("serves a repeat listing from the cache within the TTL", async () => {
    const harness = await start(listingScript("7\tdev"));

    const first = await harness.list();
    // GitHub no longer has the environment, but a repeat request inside the
    // TTL is answered from the cached payload — which is exactly why the
    // deleting pass has to invalidate it.
    harness.setScript(listingScript(""));
    const second = await harness.list();

    expect(first.status).toBe(200);
    expect(first.cacheControl).toBe("no-store");
    expect(names(first.body)).toEqual(["dev"]);
    expect(statuses(first.body)).toEqual(["success"]);
    expect(names(second.body)).toEqual(["dev"]);
  });

  it("stops listing an environment the rollback removed", async () => {
    const harness = await start(listingScript("7\tdev"));
    const operation = rolledBackOperation();
    const deleted: string[][] = [];

    expect(names((await harness.list()).body)).toEqual(["dev"]);

    const cleanup = await cleanupGitHubEnvironmentArtifact(operation, {
      attempt: 1,
      runDeleteEnvironment: async (args) => {
        deleted.push(args);
      },
      readEnvironment: environmentReader(false),
      invalidateEnvironmentListing: (repo) => {
        harness.invalidate(repo);
      }
    });
    harness.setScript(listingScript(""));
    const after = await harness.list();

    expect(deleted).toEqual([
      ["api", "--method", "DELETE", "/repos/octo/app/environments/dev"]
    ]);
    expect(cleanup.results).toMatchObject([
      { artifactType: "github_environment", outcome: "deleted" }
    ]);
    expect(after.status).toBe(200);
    expect(names(after.body)).toEqual([]);
    expect(harness.cache.get(REPO)).toEqual({
      at: 0,
      payload: { environments: [] }
    });
  });

  it("keeps listing an environment the rollback could not remove", async () => {
    const harness = await start(listingScript("7\tdev"));
    const operation = rolledBackOperation();

    expect(names((await harness.list()).body)).toEqual(["dev"]);

    const cleanup = await cleanupGitHubEnvironmentArtifact(operation, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("GitHub API request failed.");
      },
      readEnvironment: environmentReader(true),
      invalidateEnvironmentListing: (repo) => {
        harness.invalidate(repo);
      }
    });
    const after = await harness.list();

    // The failure said nothing conclusive, so the delete is unresolved rather
    // than failed; the reread finds the environment exactly where it was and
    // the pass refuses to issue the delete a second time.
    expect(cleanup.results).toMatchObject([
      {
        outcome: "skipped",
        detail: expect.stringContaining("still present at the exact identity")
      }
    ]);
    // The environment is still there, so the listing that still reports it is
    // correct and the cached payload stands.
    expect(names(after.body)).toEqual(["dev"]);
    expect(harness.cache.get(REPO)).toBeDefined();
  });

  it("refreshes the listing when the delete route removes an environment", async () => {
    const harness = await start(listingScript("7\tdev"));

    expect(names((await harness.list()).body)).toEqual(["dev"]);

    const deletion = await harness.deleteEnvironment("dev");
    harness.setScript(listingScript(""));
    const after = await harness.list();

    expect(deletion.status).toBe(200);
    expect(deletion.body).toEqual({ success: true });
    expect(harness.commands).toContainEqual([
      "gh",
      "api",
      "--method",
      "DELETE",
      "/repos/octo/app/environments/dev"
    ]);
    expect(names(after.body)).toEqual([]);
  });
});

// The listing is assembled from many `gh` calls, and the browser asks for it the
// moment a rollback is accepted — while the setup's verify run is still
// incomplete, so the row reads **Pending**. The rollback then deletes the
// environment underneath that in-flight request. Without a guard, the listing
// finishes afterwards and writes the environment it read back into the cache it
// just invalidated, and the picker hands the customer the rolled-back
// environment for a full TTL, exactly when the panel says the rollback is done.
describe("a listing already in flight when the environment is removed", () => {
  const STATUSES_PATH = "/repos/octo/app/deployments/100/statuses?per_page=1";

  /** The listing while the setup's verify run has not completed: a Pending row. */
  function pendingListingScript(environments: string): CliScript {
    return {
      ...listingScript(environments),
      ["/repos/octo/app/actions/workflows/radius-verify-credentials.yml/runs?per_page=100"]:
        { stdout: "42\tin_progress\t" }
    };
  }

  it("is never cached when the rollback removed the environment meanwhile", async () => {
    const harness = await start(pendingListingScript("7\tdev"));
    const held = harness.holdPath(STATUSES_PATH);
    const inFlight = harness.list();
    // The listing has read the repository's environments and is part-way
    // through resolving their statuses when the rollback deletes one.
    await held.reached;

    const cleanup = await cleanupGitHubEnvironmentArtifact(
      rolledBackOperation(),
      {
        attempt: 1,
        runDeleteEnvironment: async () => {},
        readEnvironment: environmentReader(false),
        invalidateEnvironmentListing: (repo) => {
          harness.invalidate(repo);
        }
      }
    );
    held.release();
    const stale = await inFlight;

    expect(cleanup.results).toMatchObject([
      { artifactType: "github_environment", outcome: "deleted" }
    ]);
    // The in-flight request still answers with what it actually read — it is
    // not rewritten after the fact — but that reading is already history.
    expect(statuses(stale.body)).toEqual(["pending"]);
    expect(harness.cache.get(REPO)).toBeUndefined();

    harness.setScript(pendingListingScript(""));
    const after = await harness.list();
    expect(names(after.body)).toEqual([]);
  });

  it("is never cached when the delete route removed the environment meanwhile", async () => {
    const harness = await start(pendingListingScript("7\tdev"));
    const held = harness.holdPath(STATUSES_PATH);
    const inFlight = harness.list();
    await held.reached;

    const deletion = await harness.deleteEnvironment("dev");
    held.release();
    await inFlight;

    expect(deletion.status).toBe(200);
    expect(harness.cache.get(REPO)).toBeUndefined();

    harness.setScript(pendingListingScript(""));
    expect(names((await harness.list()).body)).toEqual([]);
  });

  it("is cached as usual when nothing removed the environment meanwhile", async () => {
    const harness = await start(pendingListingScript("7\tdev"));
    const held = harness.holdPath(STATUSES_PATH);
    const inFlight = harness.list();
    await held.reached;

    held.release();
    const listed = await inFlight;

    expect(statuses(listed.body)).toEqual(["pending"]);
    expect(harness.cache.get(REPO)).toMatchObject({ at: 0 });
    // A repeat request inside the TTL is still served from that cache: the
    // guard refuses a stale write, it does not disable caching.
    harness.setScript(pendingListingScript(""));
    expect(names((await harness.list()).body)).toEqual(["dev"]);
  });
});
