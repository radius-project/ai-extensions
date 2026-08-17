import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

export interface BranchInfo {
  name: string;
  sha: string;
}

export interface BranchResult {
  branches?: BranchInfo[];
  workspaceBranch?: string;
  error?: string;
}

// Shaped exactly like `cliExec` from `gh.ts` minus the return value, which none
// of these three routes use. Injecting the call rather than the module keeps the
// handlers free of process spawning and lets the tests drive every branch.
export type RepositoriesCliExec = (
  command: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

export interface RepositoriesDependencies {
  cliExec: RepositoriesCliExec;
  // Reads the live instance state so `discover-branches` can mutate it, and
  // returns undefined when the instance has no entry — which is what the legacy
  // `servers.get(instanceId)` miss meant. The request context's `state` snapshot
  // cannot be used here: it substitutes `{}` for a missing entry and so cannot
  // express the 503 case.
  readInstanceState(instanceId: string): CanvasState | undefined;
  repoMatchesWorkspace(state: CanvasState, repo: string): boolean;
}

const GH_TIMEOUT = 15000;

function lines(stdout: string): string[] {
  return stdout.trim().split("\n").filter(Boolean);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Repository picker source. Personal and org repositories are fetched in
// parallel and every `gh` failure degrades to an empty list rather than
// propagating, because a partially-authenticated `gh` is a normal state here and
// an empty picker is more useful than an error page.
//
// The catch answers 200 with an empty list rather than a 5xx. That is a
// pre-existing success fallback, deliberately preserved: turning it into an
// error status would be observable hardening this structural slice excludes.
export async function handleUserRepos(
  context: CanvasRequestContext,
  dependencies: RepositoriesDependencies
): Promise<void> {
  const { response } = context;
  try {
    const [personalRepos, orgRepos] = await Promise.all([
      new Promise<string[]>((resolve) => {
        dependencies.cliExec(
          "gh",
          [
            "repo",
            "list",
            "--limit",
            "30",
            "--json",
            "nameWithOwner",
            "--jq",
            ".[].nameWithOwner"
          ],
          { timeout: GH_TIMEOUT },
          (err, stdout) => {
            if (err) {
              resolve([]);
              return;
            }
            resolve(lines(stdout));
          }
        );
      }),
      new Promise<string[]>((resolve) => {
        dependencies.cliExec(
          "gh",
          ["org", "list"],
          { timeout: GH_TIMEOUT },
          (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve([]);
              return;
            }
            const orgPromises = lines(stdout).map(
              (org) =>
                new Promise<string[]>((res2) => {
                  dependencies.cliExec(
                    "gh",
                    [
                      "repo",
                      "list",
                      org,
                      "--limit",
                      "20",
                      "--json",
                      "nameWithOwner",
                      "--jq",
                      ".[].nameWithOwner"
                    ],
                    { timeout: GH_TIMEOUT },
                    (err2, stdout2) => {
                      if (err2) {
                        res2([]);
                        return;
                      }
                      res2(lines(stdout2));
                    }
                  );
                })
            );
            Promise.all(orgPromises).then((results) => resolve(results.flat()));
          }
        );
      })
    ]);
    // Personal-first dedupe order is observable in the picker, so the spread
    // order matters as much as the uniqueness.
    const allRepos = [...new Set([...personalRepos, ...orgRepos])];
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ repos: allRepos }));
  } catch {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ repos: [] }));
  }
}

// Branch names for a repository picker. Note the header asymmetry: the missing
// repo path answers 200 without ever setting `Content-Type`, while the success
// and catch paths set it. That inconsistency is pre-existing and observable, so
// it is reproduced verbatim rather than normalized.
export async function handleRepoBranches(
  context: CanvasRequestContext,
  dependencies: RepositoriesDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    // Deliberately not normalized through a `record()` guard: a body of `null`
    // or a bare scalar makes this property read throw, and the throw lands in
    // the catch below, which is the legacy behavior.
    const data = JSON.parse(body) as { repo?: string };
    const repo = data.repo;
    if (!repo) {
      response.writeHead(200);
      response.end(JSON.stringify({ branches: [] }));
      return;
    }
    const result = await new Promise<string[]>((resolve) => {
      dependencies.cliExec(
        "gh",
        [
          "api",
          "--paginate",
          `/repos/${repo}/branches?per_page=100`,
          "--jq",
          ".[].name"
        ],
        { timeout: GH_TIMEOUT },
        (err, stdout) => {
          if (err) {
            resolve([]);
            return;
          }
          resolve(lines(stdout));
        }
      );
    });
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ branches: result }));
  } catch {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ branches: [] }));
  }
}

// Branch discovery for the diff picker. Unlike the other two routes in this
// family this one caches its result on instance state and reports a malformed
// body as 400 rather than falling back to success. Both differences are
// pre-existing and preserved.
export async function handleDiscoverBranches(
  context: CanvasRequestContext,
  dependencies: RepositoriesDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    // Same as `repo-branches`: no `record()` guard, so a `null` body throws out
    // of the property read and into the catch, which answers 400 here.
    const data = JSON.parse(body) as { repo?: string };
    const repo = data.repo || "";
    const result = await new Promise<BranchResult>((resolve) => {
      dependencies.cliExec(
        "gh",
        ["api", "--paginate", `/repos/${repo}/branches?per_page=100`],
        { timeout: GH_TIMEOUT },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ error: stderr || err.message });
            return;
          }
          try {
            const raw: unknown = JSON.parse(stdout.trim());
            const branches =
              Array.isArray(raw) ?
                raw.map((value) => {
                  const branch = record(value);
                  return {
                    name: optionalString(branch.name),
                    sha: optionalString(record(branch.commit).sha)
                  };
                })
              : [];
            resolve({ branches });
          } catch {
            resolve({ error: "Failed to parse branch data" });
          }
        }
      );
    });
    // The state lookup happens *after* the `gh` call, not before. That ordering
    // is observable — the subprocess runs even for an instance that has no
    // entry — so it is preserved. The 503 also omits `Content-Type`, unlike
    // every other response this handler writes.
    const state = dependencies.readInstanceState(context.instanceId);
    if (!state) {
      response.writeHead(503);
      response.end(
        JSON.stringify({ error: "Canvas server state is unavailable." })
      );
      return;
    }
    if (
      state.workspaceBranch &&
      dependencies.repoMatchesWorkspace(state, repo)
    ) {
      const branches = result.branches || [];
      // The workspace branch goes to the FRONT so the picker defaults to the
      // branch the user is actually on, and carries the sentinel sha
      // "worktree" because it may not exist on the remote at all.
      if (!branches.some((b) => b.name === state.workspaceBranch)) {
        branches.unshift({ name: state.workspaceBranch, sha: "worktree" });
      }
      result.branches = branches;
      result.workspaceBranch = state.workspaceBranch;
    }
    if (result.branches) {
      state.branches = result.branches.map((b) => b.name);
      state.branchShas = {};
      for (const b of result.branches) state.branchShas[b.name] = b.sha;
      state.diffTargetRepo = repo;
    }
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify(result));
  } catch (e) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(400);
    response.end(JSON.stringify({ error: errorMessage(e) }));
  }
}

export function createRepositoriesRoutes(
  dependencies: RepositoriesDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/user-repos": (context) => handleUserRepos(context, dependencies),
    "POST /api/repo-branches": (context) =>
      handleRepoBranches(context, dependencies),
    "POST /api/discover-branches": (context) =>
      handleDiscoverBranches(context, dependencies)
  };
}
