// Worktree-aware file access for the canvas adapter. The Radius Canvas runs
// inside a Copilot session, so session.workspacePath is the authoritative local
// checkout for generated app model files on the active branch.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const IGNORED_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".venv",
    "venv",
]);

function runGit(workspacePath, args) {
    return new Promise((resolve) => {
        if (!workspacePath) { resolve(""); return; }
        execFile("git", ["-C", workspacePath, ...args], { timeout: 5000 }, (err, stdout) => {
            resolve(err ? "" : stdout.trim());
        });
    });
}

export function parseRepoFromRemote(remoteUrl) {
    if (!remoteUrl) return "";
    const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+)(?:\.git)?$/i);
    return match ? match[1].replace(/\.git$/i, "") : "";
}

function parseWorkspaceYaml(content) {
    const result = {};
    for (const line of String(content || "").split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!match) continue;
        result[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
    return result;
}

async function readSessionWorkspaceMetadata() {
    const sessionId = process.env.COPILOT_AGENT_SESSION_ID || process.env.SESSION_ID || "";
    if (!sessionId) return {};
    const home = process.env.USERPROFILE || os.homedir();
    if (!home) return {};
    const workspaceFile = path.join(home, ".copilot", "session-state", sessionId, "workspace.yaml");
    try {
        return parseWorkspaceYaml(await fs.readFile(workspaceFile, "utf8"));
    } catch {
        return {};
    }
}

// The default git-worktree probe: returns true when `candidate` is inside a git
// work tree. Injectable in tests so resolveWorktreePath stays a pure function.
async function isInsideWorkTree(candidate) {
    return (await runGit(candidate, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

// Resolve the git worktree checkout for this session. The SDK's
// session.workspacePath is the per-session STATE directory
// (…/session-state/<id>), NOT the git checkout, so it must never win over the
// real worktree path. The app writes the authoritative checkout to
// workspace.yaml (git_root/cwd), so those are preferred; session.cwd /
// session.workspacePath remain as last-resort fallbacks for hosts that don't
// write a workspace.yaml. We pick the first candidate that is actually inside a
// git work tree, so a non-repo path (like the state dir) never disables
// worktree file access — which would silently force every read to GitHub and
// require the branch to be pushed first.
export async function resolveWorktreePath(session, metadata, probe = isInsideWorkTree) {
    const candidates = [
        metadata?.git_root,
        metadata?.cwd,
        session?.cwd,
        session?.workspacePath,
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (await probe(candidate)) return candidate;
    }
    return candidates[0] || "";
}

export async function detectWorkspaceContext(session) {
    const metadata = await readSessionWorkspaceMetadata();
    const workspacePath = await resolveWorktreePath(session, metadata);
    if (!workspacePath) return { workspacePath: "", repo: "", branch: "" };

    const [branch, remoteUrl] = await Promise.all([
        runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
        runGit(workspacePath, ["remote", "get-url", "origin"]),
    ]);

    return {
        workspacePath,
        repo: parseRepoFromRemote(remoteUrl) || metadata.repository || "",
        branch: branch || metadata.branch || "",
    };
}

// Returns true when the given branch matches the workspace branch.
// Requires workspaceBranch to be set on state; returns false when no workspace
// branch is available. A falsy branch arg means "unspecified" and matches
// whatever workspaceBranch is set to (caller defaults to workspaceBranch).
function branchMatches(state, branch) {
    const workspaceBranch = state?.workspaceBranch || "";
    return !!workspaceBranch && (!branch || branch === workspaceBranch);
}

// Returns true when the given repo matches the workspace repo.
// Requires workspaceRepo to be set on state; returns false when no workspace
// repo is available. A falsy repo arg means "unspecified" and matches
// whatever workspaceRepo is set to (caller defaults to workspaceRepo).
function repoMatches(state, repo) {
    const workspaceRepo = state?.workspaceRepo || "";
    return !!workspaceRepo && (!repo || repo === workspaceRepo);
}

export function isWorkspaceSelection(state, repo, branch) {
    return !!state?.workspacePath && repoMatches(state, repo) && branchMatches(state, branch);
}

export function defaultBranchForState(state) {
    return state?.contextBranch || state?.workspaceBranch || "main";
}

function safeWorkspacePath(workspacePath, repoPath) {
    if (!workspacePath || !repoPath) return "";
    const normalizedRel = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const resolvedRoot = path.resolve(workspacePath);
    const resolved = path.resolve(resolvedRoot, normalizedRel);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Path escapes workspace: ${repoPath}`);
    }
    return resolved;
}

export async function readWorkspaceFile(workspacePath, repoPath) {
    try {
        const filePath = safeWorkspacePath(workspacePath, repoPath);
        return await fs.readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

export async function fetchWorkspaceBicep(state, repo, branch) {
    if (!isWorkspaceSelection(state, repo, branch)) return null;
    return await readWorkspaceFile(state.workspacePath, ".radius/app.bicep")
        || await readWorkspaceFile(state.workspacePath, "app.bicep");
}

export async function fetchWorkspaceFile(state, repo, branch, repoPath) {
    if (!isWorkspaceSelection(state, repo, branch)) return null;
    return await readWorkspaceFile(state.workspacePath, repoPath);
}

async function walkWorkspace(workspacePath, dir = "", results = []) {
    const absoluteDir = safeWorkspacePath(workspacePath, dir || ".");
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".radius") {
            if (entry.isDirectory() && entry.name !== ".github") continue;
        }
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await walkWorkspace(workspacePath, rel, results);
        } else if (entry.isFile()) {
            results.push(rel);
        }
    }
    return results;
}

export async function fetchWorkspaceTree(state, repo, branch) {
    if (!isWorkspaceSelection(state, repo, branch)) return null;
    try {
        return await walkWorkspace(state.workspacePath);
    } catch {
        return null;
    }
}

function contentPathFromApiPath(apiPath, repo) {
    const url = new URL(apiPath, "https://api.github.local");
    const marker = `/repos/${repo}/contents/`;
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex === -1) return "";
    return decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
}

export function createWorkspaceGitHub(state, repo, branch) {
    return {
        getContent: async (apiPath) => {
            const repoPath = contentPathFromApiPath(apiPath, repo);
            if (!repoPath) return null;
            return await fetchWorkspaceFile(state, repo, branch, repoPath);
        },
        listNames: async () => [],
        treePaths: async (requestedRepo) => {
            if (requestedRepo !== repo) return [];
            return await fetchWorkspaceTree(state, repo, branch) || [];
        },
    };
}
