// Resolves the Node.js runtime the radius-app-bicep skill scripts run under.
//
// The Copilot app embeds its Node runtime inside the `copilot` executable and
// ships no reusable `node` binary, so an agent told to run `node script.mjs`
// from a shell whose PATH has no Node has historically downloaded one. The
// skill therefore never names a bare `node`: it runs the interpreter this
// resolver found, and stops and asks the user when there is none. Resolution is
// read-only — it locates an existing installation and never installs one.
//
// A candidate must also prove it is a usable Node: the scripts use only
// `node:` builtin imports, `import.meta.url`, and logical assignment, so
// MINIMUM_NODE_MAJOR is the oldest release that can run them. An installation
// below it, or a file named `node` that is not Node at all, is rejected here so
// the user is told what was found instead of meeting a parse error mid-run.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MINIMUM_NODE_MAJOR = 18;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

export interface NodeExecutableDependencies {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  // The runtime this extension itself is running under. It is a real `node`
  // only outside the packaged Copilot app, where it is `copilot`.
  execPath: string;
  homeDir: string;
  pathExists(filePath: string): boolean;
  listDirectory(directory: string): readonly string[];
  // Reports what `<candidate> --version` printed, or null when the candidate
  // could not be run or did not answer with a Node version.
  probeVersion(executable: string): string | null;
}

// Why a found installation cannot be used.
export type NodeRejectionReason =
  // Answered as Node, but older than MINIMUM_NODE_MAJOR.
  | "unsupported-version"
  // Exists, but did not answer with a Node version at all.
  | "not-node"
  // Sits at a path that cannot be safely handed to a shell command line.
  | "unsafe-path";

export interface RejectedNodeRuntime {
  executable: string;
  // The reported version, or null when the file did not answer as Node.
  version: string | null;
  reason: NodeRejectionReason;
}

export interface NodeResolution {
  executable: string | null;
  // Installations that were found and refused, so the refusal can say what is
  // on the machine rather than "no Node.js found".
  rejected: readonly RejectedNodeRuntime[];
}

function majorVersion(version: string | null): number | null {
  const match = /^v?(\d+)\./u.exec(version?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

// The skill substitutes nodeCommand into a double-quoted argument of a shell
// command line, so a path carrying shell syntax could change that command. Such
// a path is refused rather than escaped: no real installation contains these
// characters, and rewriting one would be a guess about the user's shell.
const POSIX_UNSAFE = /["`$\\]|[\u0000-\u001F]/u;
const WINDOWS_UNSAFE = /["`$%]|[\u0000-\u001F]/u;

function isShellSafePath(
  candidate: string,
  platform: NodeJS.Platform
): boolean {
  return !(platform === "win32" ? WINDOWS_UNSAFE : POSIX_UNSAFE).test(
    candidate
  );
}

function platformPath(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "node.exe" : "node";
}

function isNodeRuntime(execPath: string, platform: NodeJS.Platform): boolean {
  const base = platformPath(platform).basename(execPath);
  return base.toLowerCase() === executableName(platform).toLowerCase();
}

function pathEntries(
  env: NodeExecutableDependencies["env"],
  platform: NodeJS.Platform
): readonly string[] {
  const separator = platform === "win32" ? ";" : ":";
  // Windows environment lookups are case-insensitive; the SDK hands the
  // variables over as an ordinary object, so both spellings are checked.
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
}

// Version directories as laid out by nvm (`v24.20.0`) and nvm-windows
// (`v24.20.0`), newest first. An unreadable or absent directory contributes
// nothing: a missing version manager is not an error.
function versionDirectories(
  deps: NodeExecutableDependencies,
  root: string
): readonly string[] {
  let entries: readonly string[];
  try {
    entries = deps.listDirectory(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^v?\d+(\.\d+)*$/.test(entry))
    .map((entry) => ({
      entry,
      order: entry
        .replace(/^v/, "")
        .split(".")
        .map((part) => Number(part))
    }))
    .sort((left, right) => {
      const length = Math.max(left.order.length, right.order.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (right.order[index] ?? 0) - (left.order[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    })
    .map((candidate) => candidate.entry);
}

function windowsCandidates(
  deps: NodeExecutableDependencies
): readonly string[] {
  const join = path.win32.join;
  const { env, homeDir } = deps;
  const candidates: string[] = [];
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramW6432
  ].filter((root): root is string => !!root);
  for (const root of roots) candidates.push(join(root, "nodejs", "node.exe"));
  if (env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe"));
    candidates.push(join(env.LOCALAPPDATA, "Volta", "bin", "node.exe"));
  }
  candidates.push(join(homeDir, "scoop", "shims", "node.exe"));
  if (env.ChocolateyInstall)
    candidates.push(join(env.ChocolateyInstall, "bin", "node.exe"));
  const nvmRoot = env.NVM_HOME || (env.APPDATA ? join(env.APPDATA, "nvm") : "");
  const versioned =
    nvmRoot ?
      versionDirectories(deps, nvmRoot).map((version) =>
        join(nvmRoot, version, "node.exe")
      )
    : [];
  return [...candidates, ...versioned];
}

function posixCandidates(deps: NodeExecutableDependencies): readonly string[] {
  const join = path.posix.join;
  const { env, homeDir } = deps;
  const nvmRoot = env.NVM_DIR || join(homeDir, ".nvm");
  const nvmVersions = join(nvmRoot, "versions", "node");
  return [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    join(homeDir, ".volta", "bin", "node"),
    join(homeDir, ".local", "bin", "node"),
    join(homeDir, "n", "bin", "node"),
    ...versionDirectories(deps, nvmVersions).map((version) =>
      join(nvmVersions, version, "bin", "node")
    )
  ];
}

/**
 * Returns the first existing Node.js interpreter that is new enough to run the
 * skill scripts, together with every installation that was found and refused.
 * Never downloads or installs anything.
 */
export function resolveNodeExecutable(
  deps: NodeExecutableDependencies
): NodeResolution {
  const { platform } = deps;
  const join = platformPath(platform).join;
  const candidates: string[] = [];
  if (isNodeRuntime(deps.execPath, platform)) candidates.push(deps.execPath);
  for (const directory of pathEntries(deps.env, platform))
    candidates.push(join(directory, executableName(platform)));
  candidates.push(
    ...(platform === "win32" ? windowsCandidates(deps) : posixCandidates(deps))
  );
  const rejected: RejectedNodeRuntime[] = [];
  const probed = new Set<string>();
  for (const candidate of candidates) {
    // A duplicate PATH entry or an install location that repeats a PATH
    // directory would otherwise spawn the same probe twice.
    if (probed.has(candidate)) continue;
    probed.add(candidate);
    // A relative PATH entry is legal but resolves against whatever directory
    // the agent happens to be in, so it can never back the absolute path the
    // handoff promises.
    if (!platformPath(platform).isAbsolute(candidate)) continue;
    if (!deps.pathExists(candidate)) continue;
    if (!isShellSafePath(candidate, platform)) {
      rejected.push({
        executable: candidate,
        version: null,
        reason: "unsafe-path"
      });
      continue;
    }
    const version = deps.probeVersion(candidate);
    const major = majorVersion(version);
    if (major !== null && major >= MINIMUM_NODE_MAJOR)
      return { executable: candidate, rejected };
    rejected.push({
      executable: candidate,
      version,
      reason: major === null ? "not-node" : "unsupported-version"
    });
  }
  return { executable: null, rejected };
}

/**
 * Lists the immediate subdirectories of a version-manager root. An absent or
 * unreadable root simply yields nothing: a machine without that version
 * manager is not an error condition.
 */
export function listNodeVersionDirectories(
  directory: string
): readonly string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Outcome of asking a candidate to print its version. */
export interface VersionProbeResult {
  error?: Error;
  status: number | null;
  stdout: string | null;
}

/**
 * Builds a probe that runs `<executable> --version` and returns what it
 * printed. A candidate that cannot be executed, exits nonzero, or prints
 * nothing is simply not a usable runtime, so failure is a null answer rather
 * than an exception.
 */
export function createNodeVersionProbe(
  runVersionCommand: (executable: string) => VersionProbeResult
): (executable: string) => string | null {
  return (executable) => {
    const result = runVersionCommand(executable);
    if (result.error || result.status !== 0) return null;
    const printed = (result.stdout ?? "").trim();
    return printed === "" ? null : printed;
  };
}

export const probeNodeVersion = createNodeVersionProbe((executable) =>
  spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true
  })
);

export function defaultNodeExecutable(): NodeResolution {
  return resolveNodeExecutable({
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    homeDir: homedir(),
    pathExists: existsSync,
    listDirectory: listNodeVersionDirectories,
    probeVersion: probeNodeVersion
  });
}
