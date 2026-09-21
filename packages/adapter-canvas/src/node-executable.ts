// Resolves the Node.js runtime the radius-app-bicep skill scripts run under.
//
// The Copilot app embeds its Node runtime inside the `copilot` executable and
// ships no reusable `node` binary, so an agent told to run `node script.mjs`
// from a shell whose PATH has no Node has historically downloaded one. The
// skill therefore never names a bare `node`: it runs the interpreter this
// resolver found, and stops and asks the user when there is none. Resolution is
// read-only — it locates an existing installation and never installs one.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface NodeExecutableDependencies {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  // The runtime this extension itself is running under. It is a real `node`
  // only outside the packaged Copilot app, where it is `copilot`.
  execPath: string;
  homeDir: string;
  pathExists(filePath: string): boolean;
  listDirectory(directory: string): readonly string[];
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
 * Returns the absolute path of an existing Node.js interpreter, or `null` when
 * the machine has none that this process can see. Never downloads or installs
 * anything.
 */
export function resolveNodeExecutable(
  deps: NodeExecutableDependencies
): string | null {
  const { platform } = deps;
  const join = platformPath(platform).join;
  const candidates: string[] = [];
  if (isNodeRuntime(deps.execPath, platform)) candidates.push(deps.execPath);
  for (const directory of pathEntries(deps.env, platform))
    candidates.push(join(directory, executableName(platform)));
  candidates.push(
    ...(platform === "win32" ? windowsCandidates(deps) : posixCandidates(deps))
  );
  return candidates.find((candidate) => deps.pathExists(candidate)) ?? null;
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

export function defaultNodeExecutable(): string | null {
  return resolveNodeExecutable({
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    homeDir: homedir(),
    pathExists: existsSync,
    listDirectory: listNodeVersionDirectories
  });
}
