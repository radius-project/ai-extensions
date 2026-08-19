import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import {
  resolveWorktreePath,
  parseRepoFromRemote,
  workspaceGraphJsonPath,
  toSafeRepoRelPath,
  isWorkspaceSelection,
  resolveSessionId,
  resolvePersistedSessionId,
  workspaceFileExists,
  workspaceHeadCommit,
  workspaceSourceChangedSince
} from "./workspace.js";

// The SDK sets session.workspacePath to the per-session STATE directory
// (…/session-state/<id>), which is NOT a git checkout. resolveWorktreePath must
// prefer the real worktree from workspace.yaml (git_root/cwd) so worktree file
// reads (e.g. .radius/app.bicep) work without pushing the branch first.
describe("resolveWorktreePath", () => {
  const STATE_DIR = "C:/state/session-state/abc";
  const WORKTREE = "C:/repos/worktrees/app/feature-branch";

  it("prefers the workspace.yaml worktree over the session-state path", async () => {
    const session = { workspacePath: STATE_DIR };
    const metadata = { git_root: WORKTREE, cwd: WORKTREE };
    // Only the real worktree is inside a git work tree.
    const probe = async (p: string) => p === WORKTREE;
    expect(await resolveWorktreePath(session, metadata, probe)).toBe(WORKTREE);
  });

  it("never selects the session-state dir even when it is the only truthy session field", async () => {
    const session = { workspacePath: STATE_DIR };
    const metadata = { cwd: WORKTREE };
    const probe = async (p: string) => p === WORKTREE;
    const resolved = await resolveWorktreePath(session, metadata, probe);
    expect(resolved).toBe(WORKTREE);
    expect(resolved).not.toBe(STATE_DIR);
  });

  it("falls back to session fields when no workspace.yaml metadata exists", async () => {
    const session = { cwd: WORKTREE };
    const probe = async (p: string) => p === WORKTREE;
    expect(await resolveWorktreePath(session, {}, probe)).toBe(WORKTREE);
  });

  it("returns the first candidate when none probe as a work tree", async () => {
    const session = { workspacePath: STATE_DIR };
    const metadata = { git_root: WORKTREE };
    const probe = async () => false;
    // git_root is first in priority order.
    expect(await resolveWorktreePath(session, metadata, probe)).toBe(WORKTREE);
  });

  it("returns empty string when there are no candidates", async () => {
    expect(await resolveWorktreePath({}, {}, async () => false)).toBe("");
  });
});

describe("workspaceGraphJsonPath", () => {
  const WORKTREE = "C:/repos/worktrees/app/feature-branch";
  const state = { workspacePath: WORKTREE };

  it("saves next to .radius/app.bicep", () => {
    const expected = path.resolve(WORKTREE, ".radius/app-graph.json");
    expect(workspaceGraphJsonPath(state, ".radius/app.bicep")).toBe(expected);
  });

  it("saves next to a root app.bicep", () => {
    const expected = path.resolve(WORKTREE, "app-graph.json");
    expect(workspaceGraphJsonPath(state, "app.bicep")).toBe(expected);
  });

  it("returns empty string when there is no workspace or bicep path", () => {
    expect(workspaceGraphJsonPath({}, ".radius/app.bicep")).toBe("");
    expect(workspaceGraphJsonPath(state, "")).toBe("");
  });
});

describe("parseRepoFromRemote", () => {
  it("parses https and ssh remotes to owner/repo", () => {
    expect(parseRepoFromRemote("https://github.com/acme/widgets.git")).toBe(
      "acme/widgets"
    );
    expect(parseRepoFromRemote("git@github.com:acme/widgets.git")).toBe(
      "acme/widgets"
    );
  });

  it("returns empty for non-GitHub or empty remotes", () => {
    expect(parseRepoFromRemote("")).toBe("");
    expect(parseRepoFromRemote("https://example.com/foo/bar.git")).toBe("");
  });
});

// The /api/open-source route and the extension handler both funnel through
// toSafeRepoRelPath, so it is the single security boundary for opening a file in
// the editor canvas. It must behave identically on Windows, macOS and Linux.
describe("toSafeRepoRelPath", () => {
  it("returns a normal repo-relative path unchanged", () => {
    expect(toSafeRepoRelPath("src/persistence/mysql.js")).toBe(
      "src/persistence/mysql.js"
    );
  });

  it("normalizes backslashes to forward slashes (Windows-generated refs)", () => {
    expect(toSafeRepoRelPath("src\\persistence\\mysql.js")).toBe(
      "src/persistence/mysql.js"
    );
  });

  it("neutralizes a single leading slash to repo-root-relative", () => {
    expect(toSafeRepoRelPath("/src/db.js")).toBe("src/db.js");
  });

  it("rejects Windows drive-letter absolute paths on every platform", () => {
    expect(() => toSafeRepoRelPath("C:\\Windows\\win.ini")).toThrow();
    expect(() => toSafeRepoRelPath("C:/Windows/win.ini")).toThrow();
    expect(() => toSafeRepoRelPath("C:config")).toThrow();
  });

  it("rejects UNC paths", () => {
    expect(() => toSafeRepoRelPath("\\\\server\\share\\x")).toThrow();
    expect(() => toSafeRepoRelPath("//server/share/x")).toThrow();
  });

  it("rejects parent traversal, empty, and NUL", () => {
    expect(() => toSafeRepoRelPath("../../etc/passwd")).toThrow();
    expect(() => toSafeRepoRelPath("a/../b")).toThrow();
    expect(() => toSafeRepoRelPath("")).toThrow();
    expect(() => toSafeRepoRelPath("src/db\0.js")).toThrow();
  });
});

// Provenance controls whether a graph node opens the local file (editor canvas)
// or a GitHub URL. It must be true ONLY for this session's own worktree branch.
describe("isWorkspaceSelection", () => {
  const state = {
    workspacePath: "C:/wt/app",
    workspaceRepo: "acme/app",
    workspaceBranch: "feature-x"
  };

  it("is true for the workspace repo + branch", () => {
    expect(isWorkspaceSelection(state, "acme/app", "feature-x")).toBe(true);
  });

  it("is false for the workspace repo on a DIFFERENT branch", () => {
    expect(isWorkspaceSelection(state, "acme/app", "main")).toBe(false);
  });

  it("is false for a different repo", () => {
    expect(isWorkspaceSelection(state, "acme/other", "feature-x")).toBe(false);
  });

  it("is false for an empty/unspecified branch (fail-closed)", () => {
    expect(isWorkspaceSelection(state, "acme/app", "")).toBe(false);
    expect(isWorkspaceSelection(state, "acme/app", undefined)).toBe(false);
  });

  it("is false for an empty/unspecified repo (fail-closed)", () => {
    expect(isWorkspaceSelection(state, "", "feature-x")).toBe(false);
    expect(isWorkspaceSelection(state, undefined, "feature-x")).toBe(false);
  });

  it("is false when no workspace path is set", () => {
    expect(
      isWorkspaceSelection(
        { workspaceRepo: "acme/app", workspaceBranch: "feature-x" },
        "acme/app",
        "feature-x"
      )
    ).toBe(false);
  });
});

// COPILOT_AGENT_SESSION_ID is sometimes a W3C traceparent ("00-<trace>-<span>-00")
// instead of a session UUID. That value builds a bogus session-state path whose
// workspace.yaml does not exist, so resolveSessionId must skip it and fall
// through to SESSION_ID (whose workspace.yaml is real). Otherwise the canvas
// reads empty metadata and loses its workspace repo/branch.
describe("resolveSessionId", () => {
  const HOME = "C:/Users/dev";
  const REAL_ID = "e40edfce-64f9-4717-8296-96fea82c4760";
  const TRACEPARENT = "00-29c84416000000000000000000000000-0000000000000000-00";
  const yamlFor = (id: string) =>
    `${HOME}/.copilot/session-state/${id}/workspace.yaml`.replace(
      /\//g,
      path.sep
    );

  const existsFor = (validId: string) => async (candidate: string) =>
    path.normalize(candidate) === path.normalize(yamlFor(validId));

  it("skips a traceparent COPILOT_AGENT_SESSION_ID and uses SESSION_ID when its workspace.yaml exists", async () => {
    const env = { COPILOT_AGENT_SESSION_ID: TRACEPARENT, SESSION_ID: REAL_ID };
    expect(await resolveSessionId(env, HOME, existsFor(REAL_ID))).toBe(REAL_ID);
  });

  describe("resolvePersistedSessionId", () => {
    const HOME = "C:/Users/dev";
    const REAL_ID = "e40edfce-64f9-4717-8296-96fea82c4760";
    const TRACEPARENT =
      "00-29c84416000000000000000000000000-0000000000000000-00";
    const yamlFor = (id: string) =>
      `${HOME}/.copilot/session-state/${id}/workspace.yaml`.replace(
        /\//g,
        path.sep
      );
    const existsFor = (validId: string) => async (candidate: string) =>
      path.normalize(candidate) === path.normalize(yamlFor(validId));

    it("uses the first candidate with a real session workspace", async () => {
      const env = {
        COPILOT_AGENT_SESSION_ID: TRACEPARENT,
        SESSION_ID: REAL_ID
      };
      expect(
        await resolvePersistedSessionId(env, HOME, existsFor(REAL_ID))
      ).toBe(REAL_ID);
    });

    it("does not use an unverified traceparent as persistent storage identity", async () => {
      const env = { COPILOT_AGENT_SESSION_ID: TRACEPARENT };
      expect(
        await resolvePersistedSessionId(env, HOME, async () => false)
      ).toBe("");
    });

    it("returns no persistent identity when no session directory matches", async () => {
      const env = { SESSION_ID: REAL_ID };
      expect(
        await resolvePersistedSessionId(env, HOME, async () => false)
      ).toBe("");
    });
  });

  it("prefers COPILOT_AGENT_SESSION_ID when its own workspace.yaml exists", async () => {
    const env = { COPILOT_AGENT_SESSION_ID: REAL_ID, SESSION_ID: "other" };
    expect(await resolveSessionId(env, HOME, existsFor(REAL_ID))).toBe(REAL_ID);
  });

  it("falls back to the first candidate when no workspace.yaml exists", async () => {
    const env = { COPILOT_AGENT_SESSION_ID: TRACEPARENT, SESSION_ID: REAL_ID };
    expect(await resolveSessionId(env, HOME, async () => false)).toBe(
      TRACEPARENT
    );
  });

  it("returns empty string when no candidate env vars are set", async () => {
    expect(await resolveSessionId({}, HOME, async () => false)).toBe("");
  });
});

// workspaceFileExists gates the "open in editor canvas" path: canvas.open silently
// no-ops for a file that isn't checked out here, so a false result is what lets the
// webview fall back to a GitHub URL instead of dead-clicking.
describe("workspaceFileExists", () => {
  it("is true for a file that exists on the worktree and false for a missing one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-wt-"));
    try {
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "main.go"), "package main\n");
      expect(await workspaceFileExists(dir, "src/main.go")).toBe(true);
      expect(await workspaceFileExists(dir, "src\\main.go")).toBe(true);
      expect(await workspaceFileExists(dir, "src/missing.go")).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is false for a traversal path or when either argument is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-wt-"));
    try {
      expect(await workspaceFileExists(dir, "../outside.txt")).toBe(false);
      expect(await workspaceFileExists("", "src/main.go")).toBe(false);
      expect(await workspaceFileExists(dir, "")).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// The origin record records the commit a model was generated from, and this
// is the other half of that comparison. An unresolvable commit must read as
// "unknown" ("") rather than as drift, because drift triggers a regeneration
// that overwrites the user's model.
describe("workspaceHeadCommit", () => {
  it("resolves the commit the worktree is on", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-head-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir });
      git("init", "--quiet", "--initial-branch", "main");
      git("config", "user.email", "radius@example.invalid");
      git("config", "user.name", "Radius Test");
      await fs.writeFile(path.join(dir, "file.txt"), "content\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "first");
      const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
        .toString()
        .trim();

      expect(await workspaceHeadCommit(dir)).toBe(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves empty for a directory that is not a checkout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-head-"));
    try {
      expect(await workspaceHeadCommit(dir)).toBe("");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["an empty path", ""],
    ["a null path", null],
    ["an undefined path", undefined]
  ])("resolves empty for %s", async (_label, value) => {
    expect(await workspaceHeadCommit(value)).toBe("");
  });
});

// The freshness check hinges on this: committing a generated model advances HEAD
// past the commit that model recorded, so a plain commit comparison would mark
// every committed model stale forever. Only changes OUTSIDE .radius/ count.
describe("workspaceSourceChangedSince", () => {
  async function checkout(): Promise<{ dir: string; first: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-drift-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "radius@example.invalid");
    git("config", "user.name", "Radius Test");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(1)\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "source");
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
      .toString()
      .trim();
    return { dir, first };
  }

  const commitAll = (dir: string, message: string) => {
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: dir });
  };

  it("is false when the only later commit touched the model directory", async () => {
    const { dir, first } = await checkout();
    try {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".radius", "app.bicep"),
        "resource {}\n"
      );
      await fs.writeFile(path.join(dir, ".radius", "app.origin.json"), "{}\n");
      commitAll(dir, "add model");

      expect(await workspaceSourceChangedSince(dir, first)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is true when application source changed after the recorded commit", async () => {
    const { dir, first } = await checkout();
    try {
      await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(2)\n");
      commitAll(dir, "change source");

      expect(await workspaceSourceChangedSince(dir, first)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is true when a source change rides along with a model change", async () => {
    const { dir, first } = await checkout();
    try {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".radius", "app.bicep"),
        "resource {}\n"
      );
      await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(3)\n");
      commitAll(dir, "model and source");

      expect(await workspaceSourceChangedSince(dir, first)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is false when nothing was committed after the recorded commit", async () => {
    const { dir, first } = await checkout();
    try {
      expect(await workspaceSourceChangedSince(dir, first)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is undefined when git cannot answer, so the caller falls back", async () => {
    const { dir } = await checkout();
    try {
      expect(
        await workspaceSourceChangedSince(dir, "0".repeat(40))
      ).toBeUndefined();
      expect(await workspaceSourceChangedSince("", "abc")).toBeUndefined();
      expect(await workspaceSourceChangedSince(dir, "")).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
