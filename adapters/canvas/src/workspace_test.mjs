import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveWorktreePath, parseRepoFromRemote, workspaceGraphJsonPath, toSafeRepoRelPath, isWorkspaceSelection } from "./workspace.mjs";

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
        const probe = async (p) => p === WORKTREE;
        expect(await resolveWorktreePath(session, metadata, probe)).toBe(WORKTREE);
    });

    it("never selects the session-state dir even when it is the only truthy session field", async () => {
        const session = { workspacePath: STATE_DIR };
        const metadata = { cwd: WORKTREE };
        const probe = async (p) => p === WORKTREE;
        const resolved = await resolveWorktreePath(session, metadata, probe);
        expect(resolved).toBe(WORKTREE);
        expect(resolved).not.toBe(STATE_DIR);
    });

    it("falls back to session fields when no workspace.yaml metadata exists", async () => {
        const session = { cwd: WORKTREE };
        const probe = async (p) => p === WORKTREE;
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
        expect(parseRepoFromRemote("https://github.com/acme/widgets.git")).toBe("acme/widgets");
        expect(parseRepoFromRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets");
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
        expect(toSafeRepoRelPath("src/persistence/mysql.js")).toBe("src/persistence/mysql.js");
    });

    it("normalizes backslashes to forward slashes (Windows-generated refs)", () => {
        expect(toSafeRepoRelPath("src\\persistence\\mysql.js")).toBe("src/persistence/mysql.js");
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
    const state = { workspacePath: "C:/wt/app", workspaceRepo: "acme/app", workspaceBranch: "feature-x" };

    it("is true for the workspace repo + branch", () => {
        expect(isWorkspaceSelection(state, "acme/app", "feature-x")).toBe(true);
    });

    it("is false for the workspace repo on a DIFFERENT branch", () => {
        expect(isWorkspaceSelection(state, "acme/app", "main")).toBe(false);
    });

    it("is false for a different repo", () => {
        expect(isWorkspaceSelection(state, "acme/other", "feature-x")).toBe(false);
    });

    it("is false when no workspace path is set", () => {
        expect(isWorkspaceSelection({ workspaceRepo: "acme/app", workspaceBranch: "feature-x" }, "acme/app", "feature-x")).toBe(false);
    });
});
