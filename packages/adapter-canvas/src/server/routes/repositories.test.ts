import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createRepositoriesRoutes,
  handleDiscoverBranches,
  handleRepoBranches,
  handleUserRepos,
  type BranchResult,
  type RepositoriesDependencies
} from "./repositories.js";
import type { CanvasState } from "../../shared.js";
import type { CanvasServerEntry } from "../types.js";

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

// A scripted `cliExec` fake. Every expected invocation is matched by the first
// argument of the `gh` argv; anything unscripted throws so an accidental extra
// subprocess call fails loudly instead of silently resolving to an empty list.
interface CliScript {
  [key: string]: { error?: Error; stdout?: string; stderr?: string };
}

function cliFake(script: CliScript) {
  const calls: { command: string; args: string[]; timeout: number }[] = [];
  const exec: RepositoriesDependencies["cliExec"] = (
    command,
    args,
    options,
    callback
  ) => {
    calls.push({ command, args, timeout: options.timeout });
    const key = scriptKey(args);
    const scripted = script[key];
    if (!scripted) {
      throw new Error(`unscripted cliExec call: ${command} ${args.join(" ")}`);
    }
    // Async like the real subprocess callback, so parallelism is real.
    setTimeout(() => {
      callback(
        scripted.error ?? null,
        scripted.stdout ?? "",
        scripted.stderr ?? ""
      );
    }, 0);
  };
  return { calls, exec };
}

function scriptKey(args: string[]): string {
  if (args[0] === "org") return "orgs";
  if (args[0] === "api") return `api:${args[2]}`;
  // `gh repo list [<org>] --limit ...`
  return args[1] === "list" && args[2] !== "--limit" ?
      `org-repos:${args[2]}`
    : "personal";
}

// Fakes throw on anything the route is not supposed to reach, so an accidental
// widening of the dependency surface fails loudly.
function dependencies(
  overrides: Partial<RepositoriesDependencies> = {}
): RepositoriesDependencies {
  return {
    cliExec: () => {
      throw new Error("cliExec not stubbed");
    },
    readInstanceState: () => {
      throw new Error("readInstanceState not stubbed");
    },
    repoMatchesWorkspace: () => {
      throw new Error("repoMatchesWorkspace not stubbed");
    },
    ...overrides
  };
}

type Handler = (
  context: ReturnType<typeof createRequestContext>,
  deps: RepositoriesDependencies
) => Promise<void>;

async function run(
  method: string,
  url: string,
  body: string,
  handler: Handler,
  deps: RepositoriesDependencies
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(method, url, body),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handler(context, deps);
  return recording;
}

const JSON_ONLY = ["Content-Type"];

describe("repositories routes (SU-05)", () => {
  it("declares exactly the three routes it owns", () => {
    const routes = createRepositoriesRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/user-repos",
      "POST /api/repo-branches",
      "POST /api/discover-branches"
    ]);
  });

  it("merges personal and org repositories, personal first, deduped", async () => {
    const cli = cliFake({
      personal: { stdout: "octo/app\nocto/site\n" },
      orgs: { stdout: "acme\nglobex\n" },
      "org-repos:acme": { stdout: "acme/api\nocto/app\n" },
      "org-repos:globex": { stdout: "globex/web\n" }
    });
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.headers).toEqual({ "Content-Type": "application/json" });
    // Personal entries keep their leading position and `octo/app` is not
    // repeated even though the org listing also returned it.
    expect(recording.body).toBe(
      '{"repos":["octo/app","octo/site","acme/api","globex/web"]}'
    );
    // Personal and org listings are issued together, not serially.
    expect(cli.calls.slice(0, 2).map((call) => call.args[0])).toEqual([
      "repo",
      "org"
    ]);
    expect(cli.calls.every((call) => call.timeout === 15000)).toBe(true);
    expect(cli.calls[0].args).toEqual([
      "repo",
      "list",
      "--limit",
      "30",
      "--json",
      "nameWithOwner",
      "--jq",
      ".[].nameWithOwner"
    ]);
    expect(cli.calls[2].args.slice(0, 4)).toEqual([
      "repo",
      "list",
      "acme",
      "--limit"
    ]);
  });

  it("degrades an unauthenticated gh to an empty list rather than an error", async () => {
    const cli = cliFake({
      personal: { error: new Error("gh: not logged in") },
      orgs: { error: new Error("gh: not logged in") }
    });
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.body).toBe('{"repos":[]}');
  });

  it("keeps personal repositories when only the org listing fails", async () => {
    const cli = cliFake({
      personal: { stdout: "octo/app\n" },
      orgs: { error: new Error("no orgs") }
    });
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.body).toBe('{"repos":["octo/app"]}');
  });

  it("treats blank org output as no orgs and skips per-org listing", async () => {
    const cli = cliFake({
      personal: { stdout: "octo/app\n" },
      orgs: { stdout: "   \n" }
    });
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.body).toBe('{"repos":["octo/app"]}');
    expect(cli.calls).toHaveLength(2);
  });

  it("drops a single failing org without losing the others", async () => {
    const cli = cliFake({
      personal: { stdout: "" },
      orgs: { stdout: "acme\nglobex\n" },
      "org-repos:acme": { error: new Error("forbidden") },
      "org-repos:globex": { stdout: "globex/web\n" }
    });
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.body).toBe('{"repos":["globex/web"]}');
  });

  it("answers 200 with an empty list when the whole lookup throws", async () => {
    // The pre-existing success fallback: a throw out of the parallel lookup is
    // reported as an empty picker, not as a 5xx.
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({
        cliExec: () => {
          throw new Error("spawn failed");
        }
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.body).toBe('{"repos":[]}');
  });

  it("lists branch names for a repository", async () => {
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": { stdout: "main\ndev\n" }
    });
    const recording = await run(
      "POST",
      "/api/repo-branches",
      '{"repo":"octo/app"}',
      handleRepoBranches,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.body).toBe('{"branches":["main","dev"]}');
    expect(cli.calls[0].args).toEqual([
      "api",
      "--paginate",
      "/repos/octo/app/branches?per_page=100",
      "--jq",
      ".[].name"
    ]);
  });

  it("answers a missing repo with 200 and no Content-Type at all", async () => {
    // Pre-existing header asymmetry. The success and failure paths both set
    // `Content-Type`; this one never does. Normalizing it would be observable.
    const recording = await run(
      "POST",
      "/api/repo-branches",
      "{}",
      handleRepoBranches,
      dependencies()
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual([]);
    expect(recording.body).toBe('{"branches":[]}');
  });

  it("answers 200 with an empty branch list when gh fails", async () => {
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": { error: new Error("404") }
    });
    const recording = await run(
      "POST",
      "/api/repo-branches",
      '{"repo":"octo/app"}',
      handleRepoBranches,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.body).toBe('{"branches":[]}');
  });

  it("answers a malformed branch-list body with 200 and Content-Type", async () => {
    const recording = await run(
      "POST",
      "/api/repo-branches",
      "not json",
      handleRepoBranches,
      dependencies()
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.body).toBe('{"branches":[]}');
  });

  it("discovers branches and caches them on instance state", async () => {
    const state: CanvasState = {};
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: JSON.stringify([
          { name: "main", commit: { sha: "aaa" } },
          { name: "dev", commit: { sha: "bbb" } }
        ])
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: () => false
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(JSON.parse(recording.body)).toEqual({
      branches: [
        { name: "main", sha: "aaa" },
        { name: "dev", sha: "bbb" }
      ]
    });
    expect(state.branches).toEqual(["main", "dev"]);
    expect(state.branchShas).toEqual({ main: "aaa", dev: "bbb" });
    expect(state.diffTargetRepo).toBe("octo/app");
  });

  it("puts a missing workspace branch at the front with a worktree sha", async () => {
    const state: CanvasState = {
      workspaceBranch: "feature/x",
      workspaceRepo: "octo/app"
    };
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: JSON.stringify([{ name: "main", commit: { sha: "aaa" } }])
      }
    });
    const seen: string[] = [];
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: (_state, repo) => {
          seen.push(repo);
          return true;
        }
      })
    );
    const payload = JSON.parse(recording.body) as BranchResult;
    expect(payload.branches).toEqual([
      { name: "feature/x", sha: "worktree" },
      { name: "main", sha: "aaa" }
    ]);
    expect(payload.workspaceBranch).toBe("feature/x");
    expect(state.branches).toEqual(["feature/x", "main"]);
    expect(state.branchShas).toEqual({ "feature/x": "worktree", main: "aaa" });
    expect(seen).toEqual(["octo/app"]);
  });

  it("does not duplicate a workspace branch the remote already lists", async () => {
    const state: CanvasState = {
      workspaceBranch: "main",
      workspaceRepo: "octo/app"
    };
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: JSON.stringify([{ name: "main", commit: { sha: "aaa" } }])
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: () => true
      })
    );
    const payload = JSON.parse(recording.body) as BranchResult;
    expect(payload.branches).toEqual([{ name: "main", sha: "aaa" }]);
    expect(payload.workspaceBranch).toBe("main");
  });

  it("ignores the workspace branch for a different repository", async () => {
    const state: CanvasState = {
      workspaceBranch: "feature/x",
      workspaceRepo: "octo/other"
    };
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: JSON.stringify([{ name: "main", commit: { sha: "aaa" } }])
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: () => false
      })
    );
    const payload = JSON.parse(recording.body) as BranchResult;
    expect(payload.workspaceBranch).toBeUndefined();
    expect(payload.branches).toEqual([{ name: "main", sha: "aaa" }]);
  });

  it("rebuilds the sha map instead of merging into a stale one", async () => {
    const state: CanvasState = {
      branches: ["old"],
      branchShas: { old: "zzz" },
      diffTargetRepo: "octo/old"
    };
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: JSON.stringify([{ name: "main", commit: { sha: "aaa" } }])
      }
    });
    await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: () => false
      })
    );
    expect(state.branchShas).toEqual({ main: "aaa" });
    expect(state.branches).toEqual(["main"]);
    expect(state.diffTargetRepo).toBe("octo/app");
  });

  it("surfaces a gh failure as a 200 error payload and caches nothing", async () => {
    const state: CanvasState = {};
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        error: new Error("exit 1"),
        stderr: "gh: repository not found"
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: () => false
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"error":"gh: repository not found"}');
    expect(state.branches).toBeUndefined();
    expect(state.diffTargetRepo).toBeUndefined();
  });

  it("falls back to the error message when gh writes nothing to stderr", async () => {
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        error: new Error("spawn ENOENT"),
        stderr: ""
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => ({}),
        repoMatchesWorkspace: () => false
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"error":"spawn ENOENT"}');
  });

  it("reports unparseable branch output as a 200 error payload", async () => {
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": { stdout: "<html>" }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => ({}),
        repoMatchesWorkspace: () => false
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"error":"Failed to parse branch data"}');
  });

  it("treats a non-array branch payload as no branches", async () => {
    const state: CanvasState = {};
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: '{"message":"Not Found"}'
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({
        cliExec: cli.exec,
        readInstanceState: () => state,
        repoMatchesWorkspace: () => false
      })
    );
    expect(recording.body).toBe('{"branches":[]}');
    expect(state.branches).toEqual([]);
    expect(state.branchShas).toEqual({});
  });

  it("answers 503 without Content-Type when the instance has no entry", async () => {
    const cli = cliFake({
      "api:/repos/octo/app/branches?per_page=100": {
        stdout: JSON.stringify([{ name: "main", commit: { sha: "aaa" } }])
      }
    });
    const recording = await run(
      "POST",
      "/api/discover-branches",
      '{"repo":"octo/app"}',
      handleDiscoverBranches,
      dependencies({ cliExec: cli.exec, readInstanceState: () => undefined })
    );
    expect(recording.status).toBe(503);
    expect(recording.headerOrder).toEqual([]);
    expect(recording.body).toBe(
      '{"error":"Canvas server state is unavailable."}'
    );
    // The state lookup happens after the subprocess, so the call still ran.
    expect(cli.calls).toHaveLength(1);
  });

  it("answers a malformed discover body with 400 and Content-Type", async () => {
    const recording = await run(
      "POST",
      "/api/discover-branches",
      "not json",
      handleDiscoverBranches,
      dependencies()
    );
    expect(recording.status).toBe(400);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(JSON.parse(recording.body)).toHaveProperty("error");
  });
});

// Verbatim transcription of the three branches removed from the legacy
// `createLegacyRequestHandler` if-chain (`/api/user-repos` at ~6813,
// `/api/repo-branches` at ~6898 and `/api/discover-branches` at ~7089 before the
// migration). These differential cases keep the compatibility proof without
// duplicating the unit-test request harness, and are deleted with the rest of
// the fallback in the removal slice.
type LegacyCliExec = RepositoriesDependencies["cliExec"];

interface LegacyEntry {
  state: CanvasState;
}

function legacyRepoMatchesWorkspace(state: CanvasState, repo: string): boolean {
  const workspaceRepo = state?.workspaceRepo || "";
  return !!workspaceRepo && repo === workspaceRepo;
}

async function legacyUserRepos(
  res: ServerResponse<IncomingMessage>,
  cliExec: LegacyCliExec
): Promise<void> {
  try {
    const [personalRepos, orgRepos] = await Promise.all([
      new Promise<string[]>((resolve) => {
        cliExec(
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
          { timeout: 15000 },
          (err, stdout) => {
            if (err) {
              resolve([]);
              return;
            }
            resolve(stdout.trim().split("\n").filter(Boolean));
          }
        );
      }),
      new Promise<string[]>((resolve) => {
        cliExec("gh", ["org", "list"], { timeout: 15000 }, (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve([]);
            return;
          }
          const orgs = stdout.trim().split("\n").filter(Boolean);
          const orgPromises = orgs.map(
            (org) =>
              new Promise<string[]>((res2) => {
                cliExec(
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
                  { timeout: 15000 },
                  (err2, stdout2) => {
                    if (err2) {
                      res2([]);
                      return;
                    }
                    res2(stdout2.trim().split("\n").filter(Boolean));
                  }
                );
              })
          );
          Promise.all(orgPromises).then((results) => resolve(results.flat()));
        });
      })
    ]);
    const allRepos = [...new Set([...personalRepos, ...orgRepos])];
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ repos: allRepos }));
  } catch {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ repos: [] }));
  }
}

async function legacyRepoBranches(
  body: string,
  res: ServerResponse<IncomingMessage>,
  cliExec: LegacyCliExec
): Promise<void> {
  try {
    const data = JSON.parse(body) as { repo?: string };
    const repo = data.repo;
    if (!repo) {
      res.writeHead(200);
      res.end(JSON.stringify({ branches: [] }));
      return;
    }
    const result = await new Promise<string[]>((resolve) => {
      cliExec(
        "gh",
        [
          "api",
          "--paginate",
          `/repos/${repo}/branches?per_page=100`,
          "--jq",
          ".[].name"
        ],
        { timeout: 15000 },
        (err, stdout) => {
          if (err) {
            resolve([]);
            return;
          }
          resolve(stdout.trim().split("\n").filter(Boolean));
        }
      );
    });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ branches: result }));
  } catch {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ branches: [] }));
  }
}

function legacyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function legacyOptionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function legacyDiscoverBranches(
  body: string,
  res: ServerResponse<IncomingMessage>,
  cliExec: LegacyCliExec,
  entry: LegacyEntry | undefined
): Promise<void> {
  try {
    const data = JSON.parse(body) as { repo?: string };
    const repo = data.repo || "";
    const result = await new Promise<BranchResult>((resolve) => {
      cliExec(
        "gh",
        ["api", "--paginate", `/repos/${repo}/branches?per_page=100`],
        { timeout: 15000 },
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
                  const branch = legacyRecord(value);
                  return {
                    name: legacyOptionalString(branch.name),
                    sha: legacyOptionalString(legacyRecord(branch.commit).sha)
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
    if (!entry) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Canvas server state is unavailable." }));
      return;
    }
    if (
      entry?.state?.workspaceBranch &&
      legacyRepoMatchesWorkspace(entry.state, repo)
    ) {
      const branches = result.branches || [];
      if (!branches.some((b) => b.name === entry.state.workspaceBranch)) {
        branches.unshift({
          name: entry.state.workspaceBranch,
          sha: "worktree"
        });
      }
      result.branches = branches;
      result.workspaceBranch = entry.state.workspaceBranch;
    }
    if (entry && result.branches) {
      entry.state.branches = result.branches.map((b) => b.name);
      entry.state.branchShas = {};
      for (const b of result.branches) entry.state.branchShas[b.name] = b.sha;
      entry.state.diffTargetRepo = repo;
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    );
  }
}

interface DifferentialCase {
  route: "user-repos" | "repo-branches" | "discover-branches";
  body?: string;
  script?: CliScript;
  throwingCli?: boolean;
  state?: CanvasState;
  missingEntry?: boolean;
}

async function differential(
  input: DifferentialCase
): Promise<
  [Recording, Recording, CanvasState | undefined, CanvasState | undefined]
> {
  const body = input.body ?? "";
  const makeCli = (): LegacyCliExec =>
    input.throwingCli ?
      () => {
        throw new Error("spawn failed");
      }
    : cliFake(input.script ?? {}).exec;

  const legacyState: CanvasState | undefined =
    input.missingEntry ? undefined : structuredClone(input.state ?? {});
  const migratedState: CanvasState | undefined =
    input.missingEntry ? undefined : structuredClone(input.state ?? {});

  const legacyRecorder = recorder();
  if (input.route === "user-repos") {
    await legacyUserRepos(legacyRecorder.response, makeCli());
  } else if (input.route === "repo-branches") {
    await legacyRepoBranches(body, legacyRecorder.response, makeCli());
  } else {
    await legacyDiscoverBranches(
      body,
      legacyRecorder.response,
      makeCli(),
      legacyState ? { state: legacyState } : undefined
    );
  }

  // The migrated handler reaches the same subprocess results and the same state
  // through its three narrow ports, so any divergence is the handler's and not
  // the data's.
  const deps = dependencies({
    cliExec: makeCli(),
    readInstanceState: () => migratedState,
    repoMatchesWorkspace: legacyRepoMatchesWorkspace
  });
  const migrated = await run(
    input.route === "user-repos" ? "GET" : "POST",
    `/api/${input.route}`,
    body,
    input.route === "user-repos" ? handleUserRepos
    : input.route === "repo-branches" ? handleRepoBranches
    : handleDiscoverBranches,
    deps
  );

  return [legacyRecorder.recording, migrated, legacyState, migratedState];
}

const BRANCH_JSON = JSON.stringify([
  { name: "main", commit: { sha: "aaa" } },
  { name: "dev", commit: { sha: "bbb" } }
]);

describe("repositories legacy/migrated differential contract", () => {
  it.each<[string, DifferentialCase]>([
    [
      "merged personal and org listing",
      {
        route: "user-repos",
        script: {
          personal: { stdout: "octo/app\nocto/site\n" },
          orgs: { stdout: "acme\n" },
          "org-repos:acme": { stdout: "acme/api\nocto/app\n" }
        }
      }
    ],
    [
      "fully failed listing",
      {
        route: "user-repos",
        script: {
          personal: { error: new Error("no auth") },
          orgs: { error: new Error("no auth") }
        }
      }
    ],
    [
      "empty org output",
      {
        route: "user-repos",
        script: { personal: { stdout: "octo/app\n" }, orgs: { stdout: "" } }
      }
    ],
    [
      "one failing org",
      {
        route: "user-repos",
        script: {
          personal: { stdout: "" },
          orgs: { stdout: "acme\nglobex\n" },
          "org-repos:acme": { error: new Error("forbidden") },
          "org-repos:globex": { stdout: "globex/web\n" }
        }
      }
    ],
    ["throwing subprocess", { route: "user-repos", throwingCli: true }]
  ])(
    "produces an identical /api/user-repos response for a %s",
    async (_l, c) => {
      const [legacy, migrated] = await differential(c);
      expect(migrated).toEqual(legacy);
    }
  );

  it.each<[string, DifferentialCase]>([
    [
      "known repository",
      {
        route: "repo-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: "main\ndev\n" }
        }
      }
    ],
    ["missing repo", { route: "repo-branches", body: "{}" }],
    ["empty repo string", { route: "repo-branches", body: '{"repo":""}' }],
    ["malformed body", { route: "repo-branches", body: "not json" }],
    ["empty body", { route: "repo-branches", body: "" }],
    ["null body", { route: "repo-branches", body: "null" }],
    [
      "failing gh",
      {
        route: "repo-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": {
            error: new Error("404")
          }
        }
      }
    ],
    [
      "blank gh output",
      {
        route: "repo-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: "  \n" }
        }
      }
    ]
  ])(
    "produces an identical /api/repo-branches response for a %s",
    async (_label, input) => {
      const [legacy, migrated] = await differential(input);
      expect(migrated).toEqual(legacy);
    }
  );

  it.each<[string, DifferentialCase]>([
    [
      "plain discovery",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: BRANCH_JSON }
        }
      }
    ],
    [
      "workspace branch preference",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        state: { workspaceBranch: "feature/x", workspaceRepo: "octo/app" },
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: BRANCH_JSON }
        }
      }
    ],
    [
      "workspace branch already listed",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        state: { workspaceBranch: "main", workspaceRepo: "octo/app" },
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: BRANCH_JSON }
        }
      }
    ],
    [
      "workspace repo mismatch",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        state: { workspaceBranch: "feature/x", workspaceRepo: "octo/other" },
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: BRANCH_JSON }
        }
      }
    ],
    [
      "stale cached state",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        state: {
          branches: ["old"],
          branchShas: { old: "zzz" },
          diffTargetRepo: "octo/old"
        },
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: BRANCH_JSON }
        }
      }
    ],
    [
      "gh failure with stderr",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": {
            error: new Error("exit 1"),
            stderr: "gh: not found"
          }
        }
      }
    ],
    [
      "gh failure without stderr",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": {
            error: new Error("spawn ENOENT")
          }
        }
      }
    ],
    [
      "unparseable output",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: "<html>" }
        }
      }
    ],
    [
      "non-array payload",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        script: {
          "api:/repos/octo/app/branches?per_page=100": {
            stdout: '{"message":"Not Found"}'
          }
        }
      }
    ],
    [
      "missing repo",
      {
        route: "discover-branches",
        body: "{}",
        script: { "api:/repos//branches?per_page=100": { stdout: "[]" } }
      }
    ],
    [
      "missing instance entry",
      {
        route: "discover-branches",
        body: '{"repo":"octo/app"}',
        missingEntry: true,
        script: {
          "api:/repos/octo/app/branches?per_page=100": { stdout: BRANCH_JSON }
        }
      }
    ],
    ["malformed body", { route: "discover-branches", body: "not json" }],
    ["null body", { route: "discover-branches", body: "null" }]
  ])(
    "produces an identical /api/discover-branches response and state for a %s",
    async (_label, input) => {
      const [legacy, migrated, legacyState, migratedState] =
        await differential(input);
      expect(migrated).toEqual(legacy);
      // The cache write is as observable as the response, so compare it too.
      expect(migratedState).toEqual(legacyState);
    }
  );
});
