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

async function pathExists(candidate) {
    try {
        await fs.access(candidate);
        return true;
    } catch {
        return false;
    }
}

function sessionWorkspaceFile(home, sessionId) {
    return path.join(home, ".copilot", "session-state", sessionId, "workspace.yaml");
}

// Resolve this session's id robustly. COPILOT_AGENT_SESSION_ID is checked before
// SESSION_ID, but the former is sometimes a W3C traceparent
// ("00-<trace>-<span>-00") rather than a session UUID. A traceparent yields a
// bogus session-state/<id> path whose workspace.yaml does not exist, which
// previously produced empty metadata (and, downstream, an empty workspaceRepo /
// workspaceBranch and a broken worktree fallback). We therefore try each
// candidate in priority order and pick the first whose workspace.yaml actually
// exists on disk. When none exists we fall back to the first non-empty candidate
// so callers that only need a stable id (e.g. port hashing) still get one.
export async function resolveSessionId(
    env = process.env,
    home = env.USERPROFILE || os.homedir(),
    exists = pathExists,
) {
    const candidates = [env.COPILOT_AGENT_SESSION_ID, env.SESSION_ID].filter(Boolean);
    if (home) {
        for (const id of candidates) {
            if (await exists(sessionWorkspaceFile(home, id))) return id;
        }
    }
    return candidates[0] || "";
}

async function readSessionWorkspaceMetadata() {
    const home = process.env.USERPROFILE || os.homedir();
    if (!home) return {};
    const sessionId = await resolveSessionId(process.env, home);
    if (!sessionId) return {};
    try {
        return parseWorkspaceYaml(await fs.readFile(sessionWorkspaceFile(home, sessionId), "utf8"));
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
// write a workspace.yaml. We pick the first candidate that probe reports is
// inside a git work tree; if none probe as a work tree, we fall back to the
// first candidate (to preserve legacy behavior when git probing is
// unavailable).
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

// Returns true when the given branch matches the workspace branch. Fail-closed:
// BOTH the workspace branch and the queried branch must be set and strictly
// equal. An empty/unspecified branch never matches — a graph whose branch could
// not be resolved is treated as remote (GitHub links) rather than wrongly
// opening a local worktree file. (The old permissive "empty arg means match"
// shortcut let a remote-branch graph be misread as local, rendering bare
// source paths with no https://github.com/ prefix.)
function branchMatches(state, branch) {
    const workspaceBranch = state?.workspaceBranch || "";
    return !!workspaceBranch && branch === workspaceBranch;
}

// Returns true when the given repo matches the workspace repo. Fail-closed like
// branchMatches: an empty/unspecified repo never matches.
function repoMatches(state, repo) {
    const workspaceRepo = state?.workspaceRepo || "";
    return !!workspaceRepo && repo === workspaceRepo;
}

export function isWorkspaceSelection(state, repo, branch) {
    return !!state?.workspacePath && repoMatches(state, repo) && branchMatches(state, branch);
}

export function defaultBranchForState(state) {
    return state?.contextBranch || state?.workspaceBranch || "main";
}

// Validate and normalize a repo-relative path that arrived from the webview
// before it is used to open a file in the editor canvas. Returns a forward-slash,
// repo-relative path, or throws on anything that is not safely repo-relative.
// OS-independent by design (pure string checks, no process.platform): it rejects
// Windows drive ("C:\\x", "C:/x", "C:x") and UNC ("\\\\srv", "//srv") forms plus
// parent traversal ("..") and NUL on EVERY platform, and neutralizes leading
// slashes to repo-root-relative. A path with no ".." always resolves inside the
// repo root, so a Windows-style absolute path is rejected even on macOS/Linux.
export function toSafeRepoRelPath(input) {
    const raw = String(input == null ? "" : input);
    if (!raw || raw.indexOf("\0") !== -1) throw new Error("invalid path");
    if (/^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw)) {
        throw new Error("absolute path not allowed");
    }
    const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || rel.split("/").some((seg) => seg === "..")) {
        throw new Error("invalid path");
    }
    return rel;
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

// True when a repo-relative path resolves to an existing entry inside the given
// workspace checkout. Used to decide whether an "open in editor canvas" can
// actually succeed (the editor open silently no-ops for a file that isn't on the
// worktree) before falling back to a GitHub URL. Returns false on any
// resolution/traversal error or when either argument is missing.
export async function workspaceFileExists(workspacePath, repoPath) {
    if (!workspacePath || !repoPath) return false;
    try {
        return await pathExists(safeWorkspacePath(workspacePath, repoPath));
    } catch {
        return false;
    }
}

// Candidate locations for a workspace app.bicep, in priority order. The graph
// JSON is saved next to whichever one is actually found.
const WORKSPACE_BICEP_PATHS = [".radius/app.bicep", "app.bicep"];

// Reads the workspace app.bicep and reports which repo-relative path it came
// from, so callers can persist sibling artifacts (e.g. app-graph.json) next to
// the exact file that was graphed. Returns null when the selection is not the
// local workspace or no app.bicep exists.
export async function resolveWorkspaceBicep(state, repo, branch) {
    if (!isWorkspaceSelection(state, repo, branch)) return null;
    for (const repoPath of WORKSPACE_BICEP_PATHS) {
        const content = await readWorkspaceFile(state.workspacePath, repoPath);
        if (content) return { content, repoPath };
    }
    return null;
}

export async function fetchWorkspaceBicep(state, repo, branch) {
    const found = await resolveWorkspaceBicep(state, repo, branch);
    return found ? found.content : null;
}

export async function fetchWorkspaceFile(state, repo, branch, repoPath) {
    if (!isWorkspaceSelection(state, repo, branch)) return null;
    return await readWorkspaceFile(state.workspacePath, repoPath);
}

// Absolute path to the app-graph.json that should sit next to the given
// repo-relative app.bicep path inside the local workspace (e.g.
// `.radius/app.bicep` -> `.radius/app-graph.json`, root `app.bicep` ->
// `app-graph.json`). Returns "" when there is no workspace or the path escapes.
export function workspaceGraphJsonPath(state, bicepRepoPath) {
    if (!state?.workspacePath || !bicepRepoPath) return "";
    const normalized = bicepRepoPath.replace(/\\/g, "/");
    const dir = path.posix.dirname(normalized);
    const rel = dir && dir !== "." ? `${dir}/app-graph.json` : "app-graph.json";
    try {
        return safeWorkspacePath(state.workspacePath, rel);
    } catch {
        return "";
    }
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
