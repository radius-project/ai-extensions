import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createRepositoriesRoutes } from "../../../src/server/routes/repositories.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasState } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface CliResult {
  error?: Error;
  stdout?: string;
  stderr?: string;
}

interface Harness {
  script: Map<string, CliResult>;
  state: CanvasState;
  setEntryMissing(missing: boolean): void;
}

// Exact argv vectors the three routes are allowed to issue. The fake keys on the
// full joined command line and throws on anything else, so a dropped
// `--paginate`, a swapped `--limit`, a missing `--jq`, or one route issuing
// another route's invocation fails loudly instead of silently matching a looser
// key.
const ARGV = {
  personal:
    "gh repo list --limit 30 --json nameWithOwner --jq .[].nameWithOwner",
  orgs: "gh org list",
  orgRepos: (org: string) =>
    `gh repo list ${org} --limit 20 --json nameWithOwner --jq .[].nameWithOwner`,
  // `repo-branches` asks for names only; `discover-branches` asks for the full
  // objects. They differ solely by the trailing `--jq`, so they must stay
  // distinguishable keys.
  branchNames: (repo: string) =>
    `gh api --paginate /repos/${repo}/branches?per_page=100 --jq .[].name`,
  branchObjects: (repo: string) =>
    `gh api --paginate /repos/${repo}/branches?per_page=100`
};

function key(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function start(): Harness {
  const script = new Map<string, CliResult>();
  const state: CanvasState = {};
  let entryMissing = false;

  const routes = createTestRouteTable(
    createRepositoriesRoutes({
      cliExec: (command, args, _options, callback) => {
        const scripted = script.get(key(command, args));
        if (!scripted) {
          throw new Error(`unscripted cliExec call: ${key(command, args)}`);
        }
        setTimeout(() => {
          callback(
            scripted.error ?? null,
            scripted.stdout ?? "",
            scripted.stderr ?? ""
          );
        }, 0);
      },
      readInstanceState: () => (entryMissing ? undefined : state),
      repoMatchesWorkspace: (current, repo) =>
        !!current.workspaceRepo && current.workspaceRepo === repo
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
    script,
    state,
    setEntryMissing(missing) {
      entryMissing = missing;
    }
  };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("repositories real-loopback HIT (RF-04)", () => {
  it("serves the merged repository list over a real socket", async () => {
    const harness = start();
    harness.script.set(ARGV.personal, { stdout: "octo/app\nocto/site\n" });
    harness.script.set(ARGV.orgs, { stdout: "acme\n" });
    harness.script.set(ARGV.orgRepos("acme"), {
      stdout: "acme/api\nocto/app\n"
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/user-repos`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    // Personal-first order survives the dedupe on the wire.
    expect(await response.text()).toBe(
      '{"repos":["octo/app","octo/site","acme/api"]}'
    );

    // Only GET is declared, so other methods still fall through.
    const posted = await post(entry.baseUrl, "/api/user-repos", "");
    expect(posted.status).toBe(418);
  });

  it("answers 200 with an empty list when gh is unauthenticated", async () => {
    const harness = start();
    harness.script.set(ARGV.personal, { error: new Error("no auth") });
    harness.script.set(ARGV.orgs, { error: new Error("no auth") });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/user-repos`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"repos":[]}');
  });

  it("lists branches and omits Content-Type for a missing repo", async () => {
    const harness = start();
    harness.script.set(ARGV.branchNames("octo/app"), {
      stdout: "main\ndev\n"
    });
    const entry = await container!.getOrCreate("panel-a");

    const listed = await post(
      entry.baseUrl,
      "/api/repo-branches",
      '{"repo":"octo/app"}'
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toBe("application/json");
    expect(await listed.text()).toBe('{"branches":["main","dev"]}');

    // The missing-repo path never sets Content-Type. Node then omits the header
    // entirely rather than defaulting it, which is observable to the client.
    const missing = await post(entry.baseUrl, "/api/repo-branches", "{}");
    expect(missing.status).toBe(200);
    expect(missing.headers.get("content-type")).toBeNull();
    expect(await missing.text()).toBe('{"branches":[]}');

    const malformed = await post(
      entry.baseUrl,
      "/api/repo-branches",
      "not json"
    );
    expect(malformed.status).toBe(200);
    expect(malformed.headers.get("content-type")).toBe("application/json");
    expect(await malformed.text()).toBe('{"branches":[]}');
  });

  it("discovers branches, prefers the workspace branch, and caches state", async () => {
    const harness = start();
    harness.state.workspaceRepo = "octo/app";
    harness.state.workspaceBranch = "feature/x";
    harness.script.set(ARGV.branchObjects("octo/app"), {
      stdout: JSON.stringify([{ name: "main", commit: { sha: "aaa" } }])
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/discover-branches",
      '{"repo":"octo/app"}'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      branches: [
        { name: "feature/x", sha: "worktree" },
        { name: "main", sha: "aaa" }
      ],
      workspaceBranch: "feature/x"
    });
    expect(harness.state.branches).toEqual(["feature/x", "main"]);
    expect(harness.state.branchShas).toEqual({
      "feature/x": "worktree",
      main: "aaa"
    });
    expect(harness.state.diffTargetRepo).toBe("octo/app");
  });

  it("reports gh failure as 200 and a malformed body as 400", async () => {
    const harness = start();
    harness.script.set(ARGV.branchObjects("octo/app"), {
      error: new Error("exit 1"),
      stderr: "gh: not found"
    });
    const entry = await container!.getOrCreate("panel-a");

    const failed = await post(
      entry.baseUrl,
      "/api/discover-branches",
      '{"repo":"octo/app"}'
    );
    expect(failed.status).toBe(200);
    expect(await failed.text()).toBe('{"error":"gh: not found"}');

    // Unlike the other two routes, a malformed body here is a 400, not a 200.
    const malformed = await post(
      entry.baseUrl,
      "/api/discover-branches",
      "not json"
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toBe("application/json");
    expect((await malformed.json()) as { error: string }).toHaveProperty(
      "error"
    );
  });

  it("answers 503 without Content-Type when the instance entry is gone", async () => {
    const harness = start();
    harness.script.set(ARGV.branchObjects("octo/app"), {
      stdout: "[]"
    });
    harness.setEntryMissing(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/discover-branches",
      '{"repo":"octo/app"}'
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe(
      '{"error":"Canvas server state is unavailable."}'
    );

    // Unmigrated routes still reach the fallback. `/api/create-environment` is
    // a residual `environments` route on the merged tree (main migrated
    // `/api/list-applications`, so it can no longer prove fallthrough here).
    const residual = await fetch(`${entry.baseUrl}/api/create-environment`);
    expect(residual.status).toBe(418);
  });
});
