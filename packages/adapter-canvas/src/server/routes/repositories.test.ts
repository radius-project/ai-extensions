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

// A scripted `cliExec` fake keyed on the *exact* command line. Nothing is
// normalized: a dropped `--paginate`, a swapped `--limit`, a missing `--jq`, or
// one route issuing another route's invocation all miss the script and throw,
// rather than quietly matching a looser key. Every scripted vector also returns
// a distinct, identifiable value, so a handler that calls the right command with
// the wrong arguments cannot pass by accident.
interface CliScript {
  [commandLine: string]: { error?: Error; stdout?: string; stderr?: string };
}

// Exact argv vectors the three routes are allowed to issue.
const ARGV = {
  personal:
    "gh repo list --limit 30 --json nameWithOwner --jq .[].nameWithOwner",
  orgs: "gh org list",
  orgRepos: (org: string) =>
    `gh repo list ${org} --limit 20 --json nameWithOwner --jq .[].nameWithOwner`,
  // `repo-branches` asks for names only; `discover-branches` asks for the full
  // objects. The two differ solely by the trailing `--jq`, so they must stay
  // distinguishable keys.
  branchNames: (repo: string) =>
    `gh api --paginate /repos/${repo}/branches?per_page=100 --jq .[].name`,
  branchObjects: (repo: string) =>
    `gh api --paginate /repos/${repo}/branches?per_page=100`
};

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function cliFake(script: CliScript) {
  const calls: { line: string; timeout: number }[] = [];
  const exec: RepositoriesDependencies["cliExec"] = (
    command,
    args,
    options,
    callback
  ) => {
    const line = commandLine(command, args);
    calls.push({ line, timeout: options.timeout });
    const scripted = script[line];
    if (!scripted) {
      throw new Error(`unscripted cliExec call: ${line}`);
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
      [ARGV.personal]: { stdout: "octo/app\nocto/site\n" },
      [ARGV.orgs]: { stdout: "acme\nglobex\n" },
      [ARGV.orgRepos("acme")]: { stdout: "acme/api\nocto/app\n" },
      [ARGV.orgRepos("globex")]: { stdout: "globex/web\n" }
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
    // repeated even though the org listing also returned it. Each scripted
    // vector returned a distinct value, so this order could not have arisen
    // from the fake collapsing two invocations.
    expect(recording.body).toBe(
      '{"repos":["octo/app","octo/site","acme/api","globex/web"]}'
    );
    // Exact argv, in order: the two top-level listings are issued together, and
    // per-org listings only afterwards.
    expect(cli.calls.map((call) => call.line)).toEqual([
      ARGV.personal,
      ARGV.orgs,
      ARGV.orgRepos("acme"),
      ARGV.orgRepos("globex")
    ]);
    expect(cli.calls.every((call) => call.timeout === 15000)).toBe(true);
  });

  it("degrades an unauthenticated gh to an empty list rather than an error", async () => {
    const cli = cliFake({
      [ARGV.personal]: { error: new Error("gh: not logged in") },
      [ARGV.orgs]: { error: new Error("gh: not logged in") }
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
      [ARGV.personal]: { stdout: "octo/app\n" },
      [ARGV.orgs]: { error: new Error("no orgs") }
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
      [ARGV.personal]: { stdout: "octo/app\n" },
      [ARGV.orgs]: { stdout: "   \n" }
    });
    const recording = await run(
      "GET",
      "/api/user-repos",
      "",
      handleUserRepos,
      dependencies({ cliExec: cli.exec })
    );
    expect(recording.body).toBe('{"repos":["octo/app"]}');
    expect(cli.calls.map((call) => call.line)).toEqual([
      ARGV.personal,
      ARGV.orgs
    ]);
  });

  it("drops a single failing org without losing the others", async () => {
    const cli = cliFake({
      [ARGV.personal]: { stdout: "" },
      [ARGV.orgs]: { stdout: "acme\nglobex\n" },
      [ARGV.orgRepos("acme")]: { error: new Error("forbidden") },
      [ARGV.orgRepos("globex")]: { stdout: "globex/web\n" }
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

  it("rejects a repository listing issued with the wrong arguments", async () => {
    // Guards the fake itself: the script is keyed on the exact command line, so
    // an invocation that swaps a limit or drops a flag is unscripted and throws
    // rather than matching a looser key. Without this, a mutation that swaps two
    // `gh` invocations could pass unnoticed.
    const cli = cliFake({ [ARGV.personal]: { stdout: "octo/app\n" } });
    expect(() =>
      cli.exec(
        "gh",
        ["repo", "list", "--limit", "20", "--json", "nameWithOwner"],
        { timeout: 15000 },
        () => {}
      )
    ).toThrow("unscripted cliExec call");
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
      [ARGV.branchNames("octo/app")]: { stdout: "main\ndev\n" }
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
    expect(cli.calls.map((c) => c.line)).toEqual([
      ARGV.branchNames("octo/app")
    ]);
    expect(cli.calls[0].timeout).toBe(15000);
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
      [ARGV.branchNames("octo/app")]: { error: new Error("404") }
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: { stdout: "<html>" }
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
      [ARGV.branchObjects("octo/app")]: {
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
      [ARGV.branchObjects("octo/app")]: {
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
