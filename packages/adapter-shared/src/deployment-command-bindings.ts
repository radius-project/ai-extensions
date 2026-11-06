import {
  toGhCommandResult,
  type GhCommandExecError,
  type GhCommandResult
} from "@radius-project/core";

export interface DeploymentCommandOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
}

export type DeploymentCommandExecutor = (
  command: string,
  args: string[],
  options: DeploymentCommandOptions,
  callback: (
    error: GhCommandExecError | null,
    stdout: string,
    stderr: string
  ) => void
) => { stdin?: { end(value?: string): unknown } | null };

/** The executor retains platform routing, credential selection and account isolation. */
export function createDeploymentCommandBindings({
  execute
}: {
  execute: DeploymentCommandExecutor;
}) {
  function runGh(
    args: string[],
    options: { env?: NodeJS.ProcessEnv } = {}
  ): Promise<GhCommandResult> {
    return new Promise((resolve) => {
      execute(
        "gh",
        args,
        { timeout: 30000, ...(options.env ? { env: options.env } : {}) },
        (error, stdout, stderr) =>
          resolve(toGhCommandResult(error, stdout, stderr))
      );
    });
  }

  function runGhWithStdin(
    args: string[],
    stdin: string | undefined,
    options: { env?: NodeJS.ProcessEnv } = {}
  ): Promise<GhCommandResult> {
    return new Promise((resolve) => {
      const child = execute(
        "gh",
        args,
        { timeout: 30000, ...(options.env ? { env: options.env } : {}) },
        (error, stdout, stderr) =>
          resolve(toGhCommandResult(error, stdout, stderr))
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
  }

  function ghOrThrow(args: string[], timeout = 12000): Promise<string> {
    return new Promise((resolve, reject) => {
      execute("gh", args, { timeout }, (error, stdout) => {
        if (error) reject(error);
        else resolve((stdout || "").trim());
      });
    });
  }

  function runCliCommand(
    command: string,
    args: string[],
    timeout = 60000
  ): Promise<GhCommandResult> {
    return new Promise((resolve) => {
      const child = execute(
        command,
        args,
        { timeout },
        (error, stdout, stderr) =>
          resolve(toGhCommandResult(error, stdout, stderr))
      );
      try {
        child.stdin?.end();
      } catch {
        // Closing stdin is best-effort; the command callback remains authoritative.
      }
    });
  }

  return { runGh, runGhWithStdin, ghOrThrow, runCliCommand };
}
