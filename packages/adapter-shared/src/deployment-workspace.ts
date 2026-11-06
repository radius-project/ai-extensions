import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GENERATED_MODEL_PATHS } from "@radius-project/core";

export function toSafeRepoRelPath(input: unknown): string {
  const raw = String(input == null ? "" : input);
  if (!raw || raw.indexOf("\0") !== -1) throw new Error("invalid path");
  if (/^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw))
    throw new Error("absolute path not allowed");
  const relative = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative || relative.split("/").some((segment) => segment === ".."))
    throw new Error("invalid path");
  return relative;
}

export function safeWorkspacePath(
  workspacePath: string | null | undefined,
  repoPath: string | null | undefined
): string {
  if (!workspacePath || !repoPath) return "";
  const normalized = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error(`Path escapes workspace: ${repoPath}`);
  return resolved;
}

export async function readWorkspaceFile(
  workspacePath: string | null | undefined,
  repoPath: string | null | undefined
): Promise<string | null> {
  try {
    return await fs.readFile(
      safeWorkspacePath(workspacePath, repoPath),
      "utf8"
    );
  } catch {
    // Retain the existing optional workspace read and remote-source fallback.
    return null;
  }
}

export function runWorkspaceGit(
  workspacePath: string | null | undefined,
  args: readonly string[],
  trimOutput = true,
  maxBuffer = 1024 * 1024
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    if (!workspacePath) {
      resolve({ ok: false, stdout: "" });
      return;
    }
    execFile(
      "git",
      ["-C", workspacePath, ...args],
      {
        timeout: 5000,
        encoding: "utf8",
        maxBuffer
      },
      (error, stdout) =>
        resolve({
          ok: !error,
          stdout:
            error ? ""
            : trimOutput ? stdout.trim()
            : stdout
        })
    );
  });
}

export async function uncommittedGeneratedPaths(
  workspacePath: string | null | undefined
): Promise<readonly string[]> {
  const pending: string[] = [];
  for (const generated of GENERATED_MODEL_PATHS) {
    // Per-path queries avoid parsing significant porcelain leading whitespace.
    const result = await runWorkspaceGit(workspacePath, [
      "status",
      "--porcelain",
      "-uall",
      "--",
      generated
    ]);
    if (result.ok && result.stdout) pending.push(generated);
  }
  return pending;
}
