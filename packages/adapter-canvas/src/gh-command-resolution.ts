import { accessSync, constants } from "node:fs";
import { posix, win32 } from "node:path";
import type { GhCommandPresentation } from "./gh-command-display.js";
import { GH_SYSTEM_INSTALL_ALTERNATIVE } from "./gh-command-display.js";

export interface GhCommandResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly canExecute?: (file: string) => boolean;
}

function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return key ? env[key] || "" : "";
}

function pathEntries(value: string, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return value
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

function isCopilotPrivateDirectory(directory: string): boolean {
  return directory
    .split(/[\\/]/)
    .some((segment) => /^copilot-desktop-gh(?:-|$)/i.test(segment));
}

function defaultCanExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveGhCommandPresentation(
  options: GhCommandResolutionOptions = {}
): GhCommandPresentation {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const shell = platform === "win32" ? "powershell" : "posix";
  const executableName = platform === "win32" ? "gh.exe" : "gh";
  const joinPath = platform === "win32" ? win32.join : posix.join;
  const canExecute = options.canExecute || defaultCanExecute;
  const candidates = pathEntries(pathValue(env), platform)
    .map((directory) => ({
      directory,
      file: joinPath(directory, executableName)
    }))
    .filter(({ file }) => canExecute(file));
  if (
    candidates.some(({ directory }) => !isCopilotPrivateDirectory(directory))
  ) {
    return { kind: "bare", shell, installationNote: "" };
  }
  const bundled = candidates.find(({ directory }) =>
    isCopilotPrivateDirectory(directory)
  );
  if (bundled) {
    return {
      kind: "absolute",
      shell,
      executablePath: bundled.file,
      installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
    };
  }
  return {
    kind: "unavailable",
    shell,
    installationNote:
      "GitHub CLI is not available. Install GitHub CLI system-wide, then retry."
  };
}
