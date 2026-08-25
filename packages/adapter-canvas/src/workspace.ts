// Worktree-aware file access for the canvas adapter. The Radius Canvas runs
// inside a Copilot session, so session.workspacePath is the authoritative local
// checkout for generated app model files on the active branch.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IGNORED_SOURCE_DIRS, isStagingDirName } from "@radius-project/core";
import type { CanvasState } from "./shared.js";

export interface CanvasSessionWorkspace {
  cwd?: string;
  workspacePath?: string;
}

export interface WorkspaceMetadata {
  git_root?: string;
  cwd?: string;
  repository?: string;
  branch?: string;
}

export type PathProbe = (candidate: string) => Promise<boolean>;

export interface WorkspaceGitHub {
  getContent(apiPath: string): Promise<string | null>;
  listNames(): Promise<string[]>;
  treePaths(requestedRepo: string): Promise<string[]>;
}

function runGit(
  workspacePath: string | null | undefined,
  args: readonly string[]
): Promise<string> {
  return new Promise((resolve) => {
    if (!workspacePath) {
      resolve("");
      return;
    }
    execFile(
      "git",
      ["-C", workspacePath, ...args],
      { timeout: 5000, encoding: "utf8" },
      (err, stdout) => {
        resolve(err ? "" : stdout.trim());
      }
    );
  });
}

// runGit collapses "git failed" and "git printed nothing" into the same empty
// string, which is fine for a value read but not for a question whose honest
// answer can be "nothing". This variant keeps the two apart.
function runGitResult(
  workspacePath: string | null | undefined,
  args: readonly string[]
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    if (!workspacePath) {
      resolve({ ok: false, stdout: "" });
      return;
    }
    execFile(
      "git",
      ["-C", workspacePath, ...args],
      { timeout: 5000, encoding: "utf8" },
      (err, stdout) => {
        resolve({ ok: !err, stdout: err ? "" : stdout.trim() });
      }
    );
  });
}

export function parseRepoFromRemote(remoteUrl: unknown): string {
  if (typeof remoteUrl !== "string" || !remoteUrl) return "";
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, "") : "";
}

function parseWorkspaceYaml(content: unknown): WorkspaceMetadata {
  const result: Record<string, string> = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    git_root: result.git_root,
    cwd: result.cwd,
    repository: result.repository,
    branch: result.branch
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function sessionWorkspaceFile(home: string, sessionId: string): string {
  return path.join(
    home,
    ".copilot",
    "session-state",
    sessionId,
    "workspace.yaml"
  );
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
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = env.USERPROFILE || os.homedir(),
  exists: PathProbe = pathExists
): Promise<string> {
  const candidates = [env.COPILOT_AGENT_SESSION_ID, env.SESSION_ID].filter(
    (value): value is string => Boolean(value)
  );
  if (home) {
    for (const id of candidates) {
      if (await exists(sessionWorkspaceFile(home, id))) return id;
    }
  }
  return candidates[0] || "";
}

export async function resolvePersistedSessionId(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = env.USERPROFILE || os.homedir(),
  exists: PathProbe = pathExists
): Promise<string> {
  if (!home) return "";
  const candidates = [env.COPILOT_AGENT_SESSION_ID, env.SESSION_ID].filter(
    (value): value is string => Boolean(value)
  );
  for (const id of candidates) {
    if (await exists(sessionWorkspaceFile(home, id))) return id;
  }
  return "";
}

async function readSessionWorkspaceMetadata(): Promise<WorkspaceMetadata> {
  const home = process.env.USERPROFILE || os.homedir();
  if (!home) return {};
  const sessionId = await resolveSessionId(process.env, home);
  if (!sessionId) return {};
  try {
    return parseWorkspaceYaml(
      await fs.readFile(sessionWorkspaceFile(home, sessionId), "utf8")
    );
  } catch {
    return {};
  }
}

// The default git-worktree probe: returns true when `candidate` is inside a git
// work tree. Injectable in tests so resolveWorktreePath stays a pure function.
async function isInsideWorkTree(candidate: string): Promise<boolean> {
  return (
    (await runGit(candidate, ["rev-parse", "--is-inside-work-tree"])) === "true"
  );
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
export async function resolveWorktreePath(
  session: CanvasSessionWorkspace,
  metadata: WorkspaceMetadata,
  probe: PathProbe = isInsideWorkTree
): Promise<string> {
  const candidates = [
    metadata?.git_root,
    metadata?.cwd,
    session?.cwd,
    session?.workspacePath
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate;
  }
  return candidates[0] || "";
}

export async function detectWorkspaceContext(
  session: CanvasSessionWorkspace
): Promise<{ workspacePath: string; repo: string; branch: string }> {
  const metadata = await readSessionWorkspaceMetadata();
  const workspacePath = await resolveWorktreePath(session, metadata);
  if (!workspacePath) return { workspacePath: "", repo: "", branch: "" };

  const [branch, remoteUrl] = await Promise.all([
    runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(workspacePath, ["remote", "get-url", "origin"])
  ]);

  return {
    workspacePath,
    repo: parseRepoFromRemote(remoteUrl) || metadata.repository || "",
    branch: branch || metadata.branch || ""
  };
}

// Returns true when the given branch matches the workspace branch. Fail-closed:
// BOTH the workspace branch and the queried branch must be set and strictly
// equal. An empty/unspecified branch never matches — a graph whose branch could
// not be resolved is treated as remote (GitHub links) rather than wrongly
// opening a local worktree file. (The old permissive "empty arg means match"
// shortcut let a remote-branch graph be misread as local, rendering bare
// source paths with no https://github.com/ prefix.)
function branchMatches(
  state: CanvasState | null | undefined,
  branch: string | null | undefined
): boolean {
  const workspaceBranch = state?.workspaceBranch || "";
  return !!workspaceBranch && branch === workspaceBranch;
}

// Returns true when the given repo matches the workspace repo. Fail-closed like
// branchMatches: an empty/unspecified repo never matches.
function repoMatches(
  state: CanvasState | null | undefined,
  repo: string | null | undefined
): boolean {
  const workspaceRepo = state?.workspaceRepo || "";
  return !!workspaceRepo && repo === workspaceRepo;
}

export function isWorkspaceSelection(
  state: CanvasState | null | undefined,
  repo: string | null | undefined,
  branch: string | null | undefined
): boolean {
  return (
    !!state?.workspacePath &&
    repoMatches(state, repo) &&
    branchMatches(state, branch)
  );
}

export function defaultBranchForState(
  state: CanvasState | null | undefined
): string {
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
export function toSafeRepoRelPath(input: unknown): string {
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

// Whether a caller-supplied path denotes the worktree or something inside it.
//
// Used to decide whether a worktree listing is evidence about the target a
// caller named. A subdirectory qualifies: if the whole worktree contains no
// Dockerfile, neither does any directory within it, so the listing answers the
// question for a subdirectory too.
//
// Resolves both sides before comparing, so `..` cannot walk out and a sibling
// whose name merely starts with the root (`/workspace-other` against
// `/workspace`) is not mistaken for a child.
export function isWorkspacePath(
  workspacePath: string | null | undefined,
  candidate: string | null | undefined
): boolean {
  if (!workspacePath || !candidate) return false;
  // Accept either separator on either side: the value reaches us as
  // agent-authored text, and forward slashes resolve correctly on Windows too.
  const toSlashes = (value: string) => value.replace(/\\/g, "/");
  try {
    const root = path.resolve(toSlashes(workspacePath));
    const resolved = path.resolve(toSlashes(candidate));
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

function safeWorkspacePath(
  workspacePath: string | null | undefined,
  repoPath: string | null | undefined
): string {
  if (!workspacePath || !repoPath) return "";
  const normalizedRel = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const resolvedRoot = path.resolve(workspacePath);
  const resolved = path.resolve(resolvedRoot, normalizedRel);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Path escapes workspace: ${repoPath}`);
  }
  return resolved;
}

export async function readWorkspaceFile(
  workspacePath: string | null | undefined,
  repoPath: string | null | undefined
): Promise<string | null> {
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
export async function workspaceFileExists(
  workspacePath: string | null | undefined,
  repoPath: string | null | undefined
): Promise<boolean> {
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

// A root app.bicep is a common Azure convention, so its filename alone cannot
// activate Radius. Accept the current extension declaration or either supported
// Radius application resource type used by legacy models.
function isLegacyRadiusAppModel(content: string): boolean {
  return (
    /^\s*extension\s+radius\b/im.test(content) ||
    /^\s*resource\s+\w+\s+['"](?:Radius|Applications)\.Core\/applications@/im.test(
      content
    )
  );
}

// The newest filesystem activity from a modeling run in the workspace checkout.
//
// A run creates `.radius/.staging-<runId>/` before it writes anything and
// removes it when it finishes. A cancelled or crashed run can leave that
// directory behind, so presence alone is not liveness: use the newest mtime from
// the directory or one of its direct staged artifacts.
//
// Any read failure answers null. This decides whether to keep waiting, so an
// unreadable `.radius/` must let the wait end rather than renew it forever.
export async function modelingRunLastActivityAtMs(
  workspacePath: string | null | undefined
): Promise<number | null> {
  if (!workspacePath) return null;
  try {
    const dir = safeWorkspacePath(workspacePath, ".radius");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const stagingDirs = entries.filter(
      (entry) => entry.isDirectory() && isStagingDirName(entry.name)
    );
    const activityTimes = await Promise.all(
      stagingDirs.map(async (entry): Promise<number | null> => {
        const stagingDir = path.join(dir, entry.name);
        try {
          const [stagingStat, stagedEntries] = await Promise.all([
            fs.stat(stagingDir),
            fs.readdir(stagingDir, { withFileTypes: true })
          ]);
          const stagedStats = await Promise.all(
            stagedEntries
              .filter((stagedEntry) => !stagedEntry.isSymbolicLink())
              .map(async (stagedEntry) => {
                try {
                  return await fs.stat(path.join(stagingDir, stagedEntry.name));
                } catch {
                  return null;
                }
              })
          );
          return Math.max(
            stagingStat.mtimeMs,
            ...stagedStats.flatMap((stat) => (stat ? [stat.mtimeMs] : []))
          );
        } catch {
          // The run may have published between listing `.radius/` and probing
          // its staging directory. That completed run is no longer activity.
          return null;
        }
      })
    );
    const observed = activityTimes.filter(
      (activityAtMs): activityAtMs is number => activityAtMs !== null
    );
    return observed.length > 0 ? Math.max(...observed) : null;
  } catch {
    return null;
  }
}

export async function hasRadiusApplicationModel(
  workspacePath: string | null | undefined
): Promise<boolean> {
  // `.radius` is Radius-owned, so any non-empty model is an activation signal
  // even before it compiles. The ambiguous root filename must prove it is Radius.
  const radiusModel = await readWorkspaceFile(
    workspacePath,
    WORKSPACE_BICEP_PATHS[0]
  );
  if (radiusModel?.trim()) return true;

  const legacyModel = await readWorkspaceFile(
    workspacePath,
    WORKSPACE_BICEP_PATHS[1]
  );
  return legacyModel ? isLegacyRadiusAppModel(legacyModel) : false;
}

// Reads the workspace app.bicep and reports which repo-relative path it came
// from, so callers can persist sibling artifacts (e.g. app-graph.json) next to
// the exact file that was graphed. Returns null when the selection is not the
// local workspace or no app.bicep exists.
export async function resolveWorkspaceBicep(
  state: CanvasState,
  repo: string | null | undefined,
  branch: string | null | undefined
): Promise<{ content: string; repoPath: string } | null> {
  if (!isWorkspaceSelection(state, repo, branch)) return null;
  for (const repoPath of WORKSPACE_BICEP_PATHS) {
    const content = await readWorkspaceFile(state.workspacePath, repoPath);
    if (content) return { content, repoPath };
  }
  return null;
}

export async function fetchWorkspaceBicep(
  state: CanvasState,
  repo: string | null | undefined,
  branch: string | null | undefined
): Promise<string | null> {
  const found = await resolveWorkspaceBicep(state, repo, branch);
  return found ? found.content : null;
}

export async function fetchWorkspaceFile(
  state: CanvasState,
  repo: string | null | undefined,
  branch: string | null | undefined,
  repoPath: string
): Promise<string | null> {
  if (!isWorkspaceSelection(state, repo, branch)) return null;
  return await readWorkspaceFile(state.workspacePath, repoPath);
}

// Commit the working tree is currently on. Used to tell whether a generated
// application model still describes the branch's source. Resolves "" when there
// is no workspace, no git, or no commit yet. Callers must treat that as "the
// source revision is unknown" rather than as drift.
export async function workspaceHeadCommit(
  workspacePath: string | null | undefined
): Promise<string> {
  return await runGit(workspacePath, ["rev-parse", "HEAD"]);
}

// Paths the generator owns: the `.radius` directory, and the root-level app
// model and origin record that an older layout keeps beside it. Changes confined
// to these are not application-source changes, so committing a regenerated model
// does not read as a reason to regenerate it again.
const GENERATED_PATHS = [".radius", "app.bicep", "app.origin.json"];

// Whether application source changed between `sinceCommit` and the current
// working tree, ignoring paths the generator owns. This includes committed,
// staged, unstaged, and untracked source so a model cannot be reported current
// merely because newer work has not been committed yet.
//
// The exclusion is the point: committing a freshly generated model advances HEAD
// past the commit that model recorded, so a plain commit comparison would make
// every committed model instantly stale, regenerate it, and stale it again on
// the next commit. Only .radius/ changed in that commit, so this reports false.
export async function workspaceSourceChangedSince(
  workspacePath: string | null | undefined,
  sinceCommit: string | null | undefined
): Promise<boolean | undefined> {
  if (!workspacePath || !sinceCommit) return undefined;
  const result = await runGitResult(workspacePath, [
    "diff",
    "--name-only",
    sinceCommit,
    "--",
    ".",
    ...GENERATED_PATHS.map((path) => `:(exclude)${path}`)
  ]);
  if (!result.ok) return undefined;
  const untracked = await runGitResult(workspacePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ...GENERATED_PATHS.map((path) => `:(exclude)${path}`)
  ]);
  if (!untracked.ok) return undefined;
  return result.stdout.length > 0 || untracked.stdout.length > 0;
}

// Whether the existing app model could be recovered if we overwrote it.
//
// Regeneration writes the working tree and never commits, so for a file that is
// tracked and clean the overwrite is an ordinary uncommitted diff the user can
// inspect and undo with `git checkout --`. Nothing is lost. For a file that is
// untracked, or that already carries uncommitted changes, no copy exists
// anywhere and the overwrite is permanent.
//
// This is the question worth asking before replacing a model we cannot prove we
// generated. "Was it edited" is unanswerable without an origin record, but "can
// they get it back" is answerable, and it is the one that decides whether
// regenerating can do harm.
//
// `git status --porcelain` prints nothing for a tracked, unmodified path, `??`
// for an untracked one, and a status code for a modified one. The caller only
// reaches here for a model it already read, so empty output means tracked and
// clean rather than absent. Returns undefined when git cannot answer, which
// callers must treat as "not shown to be recoverable" rather than as safe.
//
// `--ignored` is load-bearing. Without it an untracked model that a gitignore
// rule matches prints nothing at all, which is indistinguishable from tracked
// and clean, so the file git has never seen would read as safe to overwrite.
// That is the exact case this guard exists to catch. With the flag it prints
// `!!` instead. A model that is force-added and committed is no longer ignored,
// so this does not manufacture a prompt for one that is genuinely recoverable.
//
// Both supported model paths are asked about at once, since the caller does not
// track which layout the model came from. A stray untracked file at the other
// path makes this report false, which errs toward asking rather than replacing.
export async function workspaceModelRecoverable(
  workspacePath: string | null | undefined
): Promise<boolean | undefined> {
  if (!workspacePath) return undefined;
  const result = await runGitResult(workspacePath, [
    "status",
    "--porcelain",
    "--ignored",
    "--",
    ...WORKSPACE_BICEP_PATHS
  ]);
  if (!result.ok) return undefined;
  return result.stdout.length === 0;
}

// Absolute path to the app-graph.json that should sit next to the given
// repo-relative app.bicep path inside the local workspace (e.g.
// `.radius/app.bicep` -> `.radius/app-graph.json`, root `app.bicep` ->
// `app-graph.json`). Returns "" when there is no workspace or the path escapes.
export function workspaceGraphJsonPath(
  state: CanvasState,
  bicepRepoPath: string | null | undefined
): string {
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

// Absolute path to the workspace directory that holds app.bicep and its local
// extension artifacts (the repo's `.radius/`, or the app.bicep dir), derived
// from the modeled bicep path. Used so a local graph compile can pick up the
// repo's effective bicepconfig.json and locally published custom-type
// extensions. Returns "" when there is no local workspace path; confined to the
// workspace root via safeWorkspacePath.
export function workspaceRadArtifactsDir(
  state: CanvasState,
  bicepRepoPath: string | null | undefined
): string {
  if (!state?.workspacePath || !bicepRepoPath) return "";
  const normalized = bicepRepoPath.replace(/\\/g, "/");
  const dir = path.posix.dirname(normalized);
  const rel = dir && dir !== "." ? dir : ".";
  try {
    return safeWorkspacePath(state.workspacePath, rel);
  } catch {
    return "";
  }
}

async function walkWorkspace(
  workspacePath: string,
  dir = "",
  results: string[] = []
): Promise<string[]> {
  const absoluteDir = safeWorkspacePath(workspacePath, dir || ".");
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".radius") {
      if (entry.isDirectory() && entry.name !== ".github") continue;
    }
    if (entry.isDirectory() && IGNORED_SOURCE_DIRS.has(entry.name)) continue;

    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkWorkspace(workspacePath, rel, results);
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results;
}

export async function fetchWorkspaceTree(
  state: CanvasState,
  repo: string | null | undefined,
  branch: string | null | undefined
): Promise<string[] | null> {
  if (!isWorkspaceSelection(state, repo, branch)) return null;
  try {
    return await walkWorkspace(state.workspacePath || "");
  } catch {
    return null;
  }
}

function contentPathFromApiPath(apiPath: string, repo: string): string {
  const url = new URL(apiPath, "https://api.github.local");
  const marker = `/repos/${repo}/contents/`;
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex === -1) return "";
  return decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
}

export function createWorkspaceGitHub(
  state: CanvasState,
  repo: string,
  branch: string
): WorkspaceGitHub {
  return {
    getContent: async (apiPath) => {
      const repoPath = contentPathFromApiPath(apiPath, repo);
      if (!repoPath) return null;
      return await fetchWorkspaceFile(state, repo, branch, repoPath);
    },
    listNames: async () => [],
    treePaths: async (requestedRepo) => {
      if (requestedRepo !== repo) return [];
      return (await fetchWorkspaceTree(state, repo, branch)) || [];
    }
  };
}
