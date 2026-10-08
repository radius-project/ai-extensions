import { execFile } from "node:child_process";
import type { CommandResult } from "./journey.ts";

/**
 * Runs a command with an argv array and no shell, so values are never parsed
 * by a shell. A non-zero exit code is returned, not thrown.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 120_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(
            new Error(`Could not run ${command}: ${error.message}`, {
              cause: error
            })
          );
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        });
      }
    );
  });
}

/** Runs a command and throws with its output when it fails. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  return result.stdout.trim();
}
