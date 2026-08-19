import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createEnvironmentsRoutes } from "../../../src/server/routes/environments.js";
import { cleanupGitHubEnvironmentArtifact } from "../../../src/server.js";
import {
  createOperation,
  recordGitHubEnvironment
} from "../../../src/operations.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { EnvironmentsDependencies } from "../../../src/server/routes/environments.js";

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

interface Harness {
  cache: Map<string, { at: number; payload: unknown }>;
  commands: string[][];
  setScript(script: CliScript): void;
  invalidate(repo: string): void;
  list(): Promise<ListResult>;
  deleteEnvironment(
    environment: string
  ): Promise<{ status: number; body: unknown }>;
}

async function start(initialScript: CliScript): Promise<Harness> {
  const cache = new Map<string, { at: number; payload: unknown }>();
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
    },
    envListCacheGet: (repo) => cache.get(repo),
    envListCacheSet: (repo, entry) => {
      cache.set(repo, entry);
    },
    envListCacheDelete: (repo) => {
      cache.delete(repo);
    },
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
    invalidate(repo) {
      cache.delete(repo);
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
    name: "dev"
  });
  return operation;
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
      invalidateEnvironmentListing: (repo) => {
        harness.invalidate(repo);
      }
    });
    const after = await harness.list();

    expect(cleanup.results).toMatchObject([{ outcome: "warning" }]);
    // The environment is still there, so the listing that still reports it is
    // correct and the cached payload stands.
    expect(names(after.body)).toEqual(["dev"]);
    expect(harness.cache.has(REPO)).toBe(true);
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
