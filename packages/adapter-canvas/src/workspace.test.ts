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
  workspaceBranchForRepo,
  resolveSessionId,
  resolvePersistedSessionId,
  workspaceFileExists,
  hasRadiusApplicationModel,
  fetchWorkspaceTree,
  isWorkspacePath,
  modelingRunLastActivityAtMs,
  workspaceHeadCommit,
  uncommittedGeneratedPaths,
  workspaceSourceChangedSince,
  workspaceModelRecoverable,
  currentWorkspaceBranch,
  resolveGraphBranchForRequest
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

  describe("resolveGraphBranchForRequest", () => {
    const workspaceState = {
      workspacePath: "C:\\worktrees\\app",
      workspaceRepo: "acme/widgets",
      workspaceBranch: "old-name",
      contextRepo: "acme/widgets",
      contextBranch: "old-name",
      contextBranchSource: "workspace" as const
    };

    it("refreshes an implicit workspace selection after its branch is renamed", async () => {
      const state = {
        ...workspaceState,
        graphTargetRepo: "acme/widgets",
        graphBranch: "old-name",
        graphFollowsWorkspaceBranch: true,
        plannedRepo: "acme/widgets",
        plannedBranch: "old-name",
        plannedFollowsWorkspaceBranch: true
      };

      await expect(
        resolveGraphBranchForRequest(
          state,
          "acme/widgets",
          "old-name",
          true,
          async () => "new-name"
        )
      ).resolves.toEqual({
        status: "resolved",
        branch: "new-name",
        followsWorkspaceBranch: true
      });
      expect(state.workspaceBranch).toBe("new-name");
      expect(state.contextBranch).toBe("new-name");
      expect(state.graphBranch).toBe("new-name");
      expect(state.plannedBranch).toBe("new-name");
    });

    it("does not rewrite an explicitly selected branch", async () => {
      const state = {
        ...workspaceState,
        contextBranch: "release",
        contextBranchSource: "explicit" as const
      };
      let reads = 0;

      await expect(
        resolveGraphBranchForRequest(
          state,
          "acme/widgets",
          "release",
          undefined,
          async () => {
            reads++;
            return "new-name";
          }
        )
      ).resolves.toEqual({
        status: "resolved",
        branch: "release",
        followsWorkspaceBranch: false
      });
      expect(reads).toBe(0);
    });

    it("treats a branch-selector change as an explicit selection", async () => {
      let reads = 0;

      await expect(
        resolveGraphBranchForRequest(
          { ...workspaceState },
          "acme/widgets",
          "release",
          undefined,
          async () => {
            reads++;
            return "new-name";
          }
        )
      ).resolves.toEqual({
        status: "resolved",
        branch: "release",
        followsWorkspaceBranch: false
      });
      expect(reads).toBe(0);
    });

    it("preserves explicit intent when the selector returns to the original branch", async () => {
      let reads = 0;

      await expect(
        resolveGraphBranchForRequest(
          { ...workspaceState },
          "acme/widgets",
          "old-name",
          false,
          async () => {
            reads++;
            return "new-name";
          }
        )
      ).resolves.toEqual({
        status: "resolved",
        branch: "old-name",
        followsWorkspaceBranch: false
      });
      expect(reads).toBe(0);
    });

    it("does not use the worktree for another repository", async () => {
      await expect(
        resolveGraphBranchForRequest(
          { ...workspaceState },
          "other/repo",
          "",
          undefined,
          async () => "new-name"
        )
      ).resolves.toEqual({
        status: "resolved",
        branch: "old-name",
        followsWorkspaceBranch: false
      });
    });

    it.each(["", "HEAD"])(
      "reports an unavailable workspace branch for %j",
      async (liveBranch) => {
        await expect(
          resolveGraphBranchForRequest(
            { ...workspaceState },
            "acme/widgets",
            "",
            undefined,
            async () => liveBranch
          )
        ).resolves.toEqual({
          status: "unavailable",
          error:
            "The workspace branch is unavailable. Reopen the Radius canvas after restoring the worktree branch."
        });
      }
    );

    it("reports an unavailable workspace branch when reading the worktree fails", async () => {
      await expect(
        resolveGraphBranchForRequest(
          { ...workspaceState },
          "acme/widgets",
          "",
          true,
          async () => {
            throw new Error("worktree moved");
          }
        )
      ).resolves.toEqual({
        status: "unavailable",
        error:
          "Radius could not read the current workspace branch. Retry after confirming the worktree is available."
      });
    });

    it("preserves explicitly selected graph and planned branches during canonicalization", async () => {
      const state = {
        ...workspaceState,
        graphTargetRepo: "acme/widgets",
        graphBranch: "old-name",
        graphFollowsWorkspaceBranch: false,
        plannedRepo: "acme/widgets",
        plannedBranch: "old-name",
        plannedFollowsWorkspaceBranch: false
      };

      await resolveGraphBranchForRequest(
        state,
        "acme/widgets",
        "old-name",
        true,
        async () => "new-name"
      );

      expect(state.contextBranch).toBe("new-name");
      expect(state.graphBranch).toBe("old-name");
      expect(state.plannedBranch).toBe("old-name");
    });
  });

  describe("currentWorkspaceBranch", () => {
    it("returns empty when no workspace path is available", async () => {
      await expect(currentWorkspaceBranch("")).resolves.toBe("");
    });

    it("reads the checked-out branch from a worktree", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-branch-"));
      try {
        execFileSync(
          "git",
          ["init", "--quiet", "--initial-branch", "live-branch"],
          {
            cwd: dir
          }
        );
        await fs.writeFile(path.join(dir, "README.md"), "fixture\n");
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Radius Test",
            "-c",
            "user.email=radius@example.invalid",
            "add",
            "."
          ],
          { cwd: dir }
        );
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Radius Test",
            "-c",
            "user.email=radius@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture"
          ],
          { cwd: dir }
        );

        await expect(currentWorkspaceBranch(dir)).resolves.toBe("live-branch");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects when git cannot read the workspace branch", async () => {
      await expect(
        currentWorkspaceBranch(path.join(os.tmpdir(), "missing-worktree"))
      ).rejects.toThrow(
        "Radius could not read the current workspace branch. Retry after confirming the worktree is available."
      );
    });
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

// The graph diff renders two branches at once, so it needs the workspace branch
// itself rather than a yes/no answer for one branch.
describe("workspaceBranchForRepo", () => {
  const state = {
    workspacePath: "C:/wt/app",
    workspaceRepo: "acme/app",
    workspaceBranch: "feature-x"
  };

  it("returns the checked-out branch for the workspace repo", () => {
    expect(workspaceBranchForRepo(state, "acme/app")).toBe("feature-x");
  });

  it("is empty for a different repo", () => {
    expect(workspaceBranchForRepo(state, "acme/other")).toBe("");
  });

  it("is empty for an empty/unspecified repo (fail-closed)", () => {
    expect(workspaceBranchForRepo(state, "")).toBe("");
    expect(workspaceBranchForRepo(state, undefined)).toBe("");
  });

  it("is empty when no workspace path is set", () => {
    expect(
      workspaceBranchForRepo(
        { workspaceRepo: "acme/app", workspaceBranch: "feature-x" },
        "acme/app"
      )
    ).toBe("");
  });

  it("is empty when the workspace branch is unknown", () => {
    expect(
      workspaceBranchForRepo(
        { workspacePath: "C:/wt/app", workspaceRepo: "acme/app" },
        "acme/app"
      )
    ).toBe("");
  });

  it("is empty for missing state", () => {
    expect(workspaceBranchForRepo(null, "acme/app")).toBe("");
    expect(workspaceBranchForRepo(undefined, "acme/app")).toBe("");
  });

  it("agrees with isWorkspaceSelection for every branch it is asked about", () => {
    for (const branch of ["feature-x", "main", ""]) {
      expect(isWorkspaceSelection(state, "acme/app", branch)).toBe(
        !!workspaceBranchForRepo(state, "acme/app") &&
          workspaceBranchForRepo(state, "acme/app") === branch
      );
    }
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

describe("modelingRunLastActivityAtMs", () => {
  async function workspaceDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "radius-staging-"));
  }

  it("reports when a staging directory was created", async () => {
    const dir = await workspaceDir();
    try {
      const staging = path.join(dir, ".radius", ".staging-run-7");
      await fs.mkdir(staging, {
        recursive: true
      });
      const expected = (await fs.stat(staging)).mtimeMs;
      expect(await modelingRunLastActivityAtMs(dir)).toBe(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the newest staged artifact activity", async () => {
    const dir = await workspaceDir();
    try {
      const staging = path.join(dir, ".radius", ".staging-run-7");
      const appBicep = path.join(staging, "app.bicep");
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(appBicep, "// model\n");
      await fs.utimes(staging, new Date(1_000), new Date(1_000));
      await fs.utimes(appBicep, new Date(2_000), new Date(2_000));
      const expected = (await fs.stat(appBicep)).mtimeMs;

      expect(await modelingRunLastActivityAtMs(dir)).toBe(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the newest activity across concurrent staging directories", async () => {
    const dir = await workspaceDir();
    try {
      const older = path.join(dir, ".radius", ".staging-run-7");
      const newer = path.join(dir, ".radius", ".staging-run-8");
      await fs.mkdir(older, { recursive: true });
      await fs.mkdir(newer, { recursive: true });
      await fs.utimes(older, new Date(1_000), new Date(1_000));
      await fs.utimes(newer, new Date(2_000), new Date(2_000));
      const expected = (await fs.stat(newer)).mtimeMs;

      expect(await modelingRunLastActivityAtMs(dir)).toBe(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports no activity once the run removes its staging directory", async () => {
    const dir = await workspaceDir();
    try {
      const staging = path.join(dir, ".radius", ".staging-run-7");
      await fs.mkdir(staging, { recursive: true });
      await fs.rm(staging, { recursive: true, force: true });
      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "// model\n");
      expect(await modelingRunLastActivityAtMs(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Only a directory counts. A file whose name happens to match is not a run,
  // and treating it as one would keep the graph waiting indefinitely.
  it("ignores a non-directory entry and a bare prefix", async () => {
    const dir = await workspaceDir();
    try {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radius", ".staging-x"), "");
      await fs.mkdir(path.join(dir, ".radius", ".staging"), {
        recursive: true
      });
      expect(await modelingRunLastActivityAtMs(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Answering null is what lets an unreadable workspace end the wait rather
  // than renew it forever.
  it("reports no activity with no .radius directory, no workspace, or an unreadable one", async () => {
    const dir = await workspaceDir();
    try {
      expect(await modelingRunLastActivityAtMs(dir)).toBeNull();
      expect(await modelingRunLastActivityAtMs("")).toBeNull();
      expect(await modelingRunLastActivityAtMs(null)).toBeNull();
      expect(await modelingRunLastActivityAtMs(undefined)).toBeNull();
      await fs.writeFile(path.join(dir, ".radius"), "not a directory");
      expect(await modelingRunLastActivityAtMs(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hasRadiusApplicationModel", () => {
  async function workspace(
    files: Record<string, string>
  ): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radius-enabled-"));
    for (const [repoPath, content] of Object.entries(files)) {
      const filePath = path.join(dir, ...repoPath.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
    return {
      dir,
      cleanup: () => fs.rm(dir, { recursive: true, force: true })
    };
  }

  it("recognizes a non-empty .radius/app.bicep without repository metadata or a Git remote", async () => {
    const testWorkspace = await workspace({
      ".radius/app.bicep": "resource app {}\n"
    });
    try {
      expect(await hasRadiusApplicationModel(testWorkspace.dir)).toBe(true);
    } finally {
      await testWorkspace.cleanup();
    }
  });

  it.each([
    ["the radius extension", "extension radius\n"],
    [
      "the current Radius application type",
      "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n"
    ],
    [
      "the legacy Radius application type",
      "resource app 'Applications.Core/applications@2023-10-01-preview' = {}\n"
    ]
  ])("recognizes a root app.bicep containing %s", async (_label, content) => {
    const testWorkspace = await workspace({ "app.bicep": content });
    try {
      expect(await hasRadiusApplicationModel(testWorkspace.dir)).toBe(true);
    } finally {
      await testWorkspace.cleanup();
    }
  });

  it("rejects a generic Azure root app.bicep", async () => {
    const testWorkspace = await workspace({
      "app.bicep":
        "resource site 'Microsoft.Web/sites@2024-04-01' = { name: 'web' }\n"
    });
    try {
      expect(await hasRadiusApplicationModel(testWorkspace.dir)).toBe(false);
    } finally {
      await testWorkspace.cleanup();
    }
  });

  it("rejects empty and missing application models", async () => {
    const emptyWorkspace = await workspace({
      ".radius/app.bicep": " \n",
      "app.bicep": ""
    });
    const missingWorkspace = await workspace({});
    try {
      expect(await hasRadiusApplicationModel(emptyWorkspace.dir)).toBe(false);
      expect(await hasRadiusApplicationModel(missingWorkspace.dir)).toBe(false);
      expect(await hasRadiusApplicationModel("")).toBe(false);
    } finally {
      await Promise.all([emptyWorkspace.cleanup(), missingWorkspace.cleanup()]);
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

  it.each([
    ["unstaged", false],
    ["staged", true]
  ])("is true for %s tracked source changes", async (_label, staged) => {
    const { dir, first } = await checkout();
    try {
      await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(4)\n");
      if (staged) execFileSync("git", ["add", "src/app.js"], { cwd: dir });

      expect(await workspaceSourceChangedSince(dir, first)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is true for untracked source and ignores untracked generated files", async () => {
    const { dir, first } = await checkout();
    try {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".radius", "app.bicep"),
        "resource {}\n"
      );
      expect(await workspaceSourceChangedSince(dir, first)).toBe(false);

      await fs.writeFile(path.join(dir, "src", "new.js"), "export {};\n");
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

// A branch push publishes commits, not the working tree, so this decides whether
// the canvas offers a bare push or a commit-then-push. Reporting a clean
// worktree when the model is uncommitted produces exactly the reported bug: a
// pushed branch the deploy workflow cannot read the model from.
describe("uncommittedGeneratedPaths", () => {
  async function checkout(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-pending-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "radius@example.invalid");
    git("config", "user.name", "Radius Test");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(1)\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "source");
    return dir;
  }

  async function withCheckout(
    run: (dir: string) => Promise<void>
  ): Promise<void> {
    const dir = await checkout();
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("is empty when no generated files exist", async () => {
    await withCheckout(async (dir) => {
      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);
    });
  });

  it("reports an untracked model directory", async () => {
    await withCheckout(async (dir) => {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".radius", "app.bicep"),
        "resource {}\n"
      );

      expect(await uncommittedGeneratedPaths(dir)).toEqual([".radius"]);
    });
  });

  it("reports every pending generated root in allowlist order", async () => {
    await withCheckout(async (dir) => {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "a\n");
      await fs.writeFile(path.join(dir, "app.origin.json"), "{}\n");
      await fs.writeFile(path.join(dir, "app.bicep"), "b\n");

      expect(await uncommittedGeneratedPaths(dir)).toEqual([
        ".radius",
        "app.bicep",
        "app.origin.json"
      ]);
    });
  });

  it("reports a staged generated file", async () => {
    await withCheckout(async (dir) => {
      await fs.writeFile(path.join(dir, "app.bicep"), "a\n");
      execFileSync("git", ["add", "app.bicep"], { cwd: dir });

      expect(await uncommittedGeneratedPaths(dir)).toEqual(["app.bicep"]);
    });
  });

  it("reports an unstaged edit to a committed generated file", async () => {
    await withCheckout(async (dir) => {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "a\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "--quiet", "-m", "model"], { cwd: dir });
      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);

      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "b\n");
      expect(await uncommittedGeneratedPaths(dir)).toEqual([".radius"]);
    });
  });

  it("ignores uncommitted application source", async () => {
    await withCheckout(async (dir) => {
      await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(2)\n");
      await fs.writeFile(path.join(dir, "src", "new.js"), "export {};\n");

      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);
    });
  });

  it("does not match a path that merely shares a prefix", async () => {
    await withCheckout(async (dir) => {
      await fs.writeFile(path.join(dir, "app.biceps"), "not the model\n");
      await fs.mkdir(path.join(dir, ".radiusx"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radiusx", "x"), "x\n");

      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);
    });
  });

  it("is empty when there is no workspace or no git", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "rad-nogit-"));
    try {
      expect(await uncommittedGeneratedPaths("")).toEqual([]);
      expect(await uncommittedGeneratedPaths(null)).toEqual([]);
      expect(await uncommittedGeneratedPaths(undefined)).toEqual([]);
      expect(await uncommittedGeneratedPaths(bare)).toEqual([]);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});

// The walker prunes directories using the skip list that packages/core owns, so
// that a vendored Dockerfile is ignored identically here and on the remote tree
// listing, which prunes nothing of its own. A regression in that shared list
// would silently make one of the two paths see files the other does not.
describe("fetchWorkspaceTree", () => {
  const state = {
    workspacePath: "",
    workspaceRepo: "acme/widgets",
    workspaceBranch: "main",
    contextRepo: "acme/widgets",
    contextBranch: "main"
  };

  it("lists application files and prunes vendored and generated directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-tree-"));
    try {
      await fs.mkdir(path.join(dir, "services", "api"), { recursive: true });
      await fs.mkdir(path.join(dir, "node_modules", "pkg"), {
        recursive: true
      });
      await fs.mkdir(path.join(dir, "dist"), { recursive: true });
      await fs.mkdir(path.join(dir, ".cache"), { recursive: true });
      await fs.writeFile(path.join(dir, ".cache", "Dockerfile"), "FROM x\n");
      await fs.writeFile(path.join(dir, ".env"), "TOKEN=x\n");
      await fs.writeFile(path.join(dir, "Dockerfile"), "FROM scratch\n");
      await fs.writeFile(
        path.join(dir, "services", "api", "main.go"),
        "package main\n"
      );
      await fs.writeFile(
        path.join(dir, "node_modules", "pkg", "Dockerfile"),
        "FROM scratch\n"
      );
      await fs.writeFile(path.join(dir, "dist", "bundle.js"), "//\n");

      const paths = await fetchWorkspaceTree(
        { ...state, workspacePath: dir },
        "acme/widgets",
        "main"
      );

      expect(paths?.sort()).toEqual([
        ".env",
        "Dockerfile",
        "services/api/main.go"
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a selection that is not the worktree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-tree-"));
    try {
      expect(
        await fetchWorkspaceTree(
          { ...state, workspacePath: dir },
          "acme/widgets",
          "feat"
        )
      ).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null rather than an empty listing when the worktree cannot be walked", async () => {
    expect(
      await fetchWorkspaceTree(
        { ...state, workspacePath: path.join(os.tmpdir(), "rad-tree-absent") },
        "acme/widgets",
        "main"
      )
    ).toBeNull();
  });
});

// Decides whether a worktree listing is evidence about a caller-named target.
// A prefix match would wrongly claim a sibling directory, and an unresolved
// compare would let `..` walk out of the tree, so both are covered directly.
describe("isWorkspacePath", () => {
  const root = path.resolve("/workspace");

  it.each([
    ["the root itself", root],
    ["a trailing slash", `${root}/`],
    ["a dot form", `${root}/.`],
    ["a subdirectory", path.join(root, "services", "api")],
    ["a redundant traversal that stays inside", `${root}/services/../services`]
  ])("accepts %s", (_label: string, candidate: string) => {
    expect(isWorkspacePath(root, candidate)).toBe(true);
  });

  it.each([
    ["a sibling sharing the root's prefix", `${root}-other`],
    ["a traversal that escapes", `${root}/../elsewhere`],
    ["an unrelated absolute path", path.resolve("/somewhere/else")],
    ["the parent directory", path.dirname(root)]
  ])("rejects %s", (_label: string, candidate: string) => {
    expect(isWorkspacePath(root, candidate)).toBe(false);
  });

  it("rejects when either side is missing", () => {
    expect(isWorkspacePath("", root)).toBe(false);
    expect(isWorkspacePath(root, "")).toBe(false);
    expect(isWorkspacePath(null, undefined)).toBe(false);
  });

  it("accepts either separator, since the value arrives as agent-authored text", () => {
    expect(isWorkspacePath("/workspace", "\\workspace\\services")).toBe(true);
  });
});

// Decides whether replacing a model with no origin record can destroy anything.
// Regeneration writes the working tree only, so a committed, unmodified model
// survives the overwrite as an undoable diff, while an untracked or already
// modified one exists nowhere else.
describe("workspaceModelRecoverable", () => {
  async function repo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-recover-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "radius@example.invalid");
    git("config", "user.name", "Radius Test");
    await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
    return dir;
  }

  const write = (dir: string, body: string) =>
    fs.writeFile(path.join(dir, ".radius", "app.bicep"), body);

  const commitAll = (dir: string) => {
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "-m", "model"], { cwd: dir });
  };

  it("is true for a committed, unmodified model", async () => {
    const dir = await repo();
    try {
      await write(dir, "resource db {}\n");
      commitAll(dir);

      expect(await workspaceModelRecoverable(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is false for a model with uncommitted changes", async () => {
    const dir = await repo();
    try {
      await write(dir, "resource db {}\n");
      commitAll(dir);
      await write(dir, "resource db {}\n// hand edit\n");

      expect(await workspaceModelRecoverable(dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Without --ignored an ignored model prints nothing, which is what a tracked,
  // clean file prints, so the file git has never seen would read as safe to
  // replace. That is the silent overwrite this whole check exists to prevent.
  it("is false for a model hidden by gitignore", async () => {
    const dir = await repo();
    try {
      await write(dir, "resource db {}\n");
      await fs.writeFile(path.join(dir, ".gitignore"), ".radius/\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: dir });
      execFileSync("git", ["commit", "--quiet", "-m", "ignore"], { cwd: dir });

      expect(await workspaceModelRecoverable(dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // The mirror of the case above: once the model is committed it is no longer
  // ignored, so --ignored must not manufacture a prompt for a recoverable file.
  it("is true for a committed model inside an ignored directory", async () => {
    const dir = await repo();
    try {
      await write(dir, "resource db {}\n");
      await fs.writeFile(path.join(dir, ".gitignore"), ".radius/\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: dir });
      execFileSync("git", ["add", "-f", ".radius/app.bicep"], { cwd: dir });
      execFileSync("git", ["commit", "--quiet", "-m", "model"], { cwd: dir });

      expect(await workspaceModelRecoverable(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is false for a model git has never seen", async () => {
    const dir = await repo();
    try {
      await write(dir, "resource db {}\n");

      expect(await workspaceModelRecoverable(dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is undefined when there is no workspace or no git", async () => {
    expect(await workspaceModelRecoverable(null)).toBeUndefined();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-nogit-"));
    try {
      expect(await workspaceModelRecoverable(dir)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
