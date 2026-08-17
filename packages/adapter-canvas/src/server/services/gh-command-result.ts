import {
  commandTimedOut,
  type CommandFailure
} from "./workflow-credential-fallback.js";

// One normalization of an `execFile` callback into the result shape every `gh`
// caller in the server reads. Extracted because the deploy runner, the
// stdin-fed runner, the deployments dispatcher and the create-environment
// runner all have to agree on three things a credential fallback depends on: a
// nullish exit code is a failure (never 0), stderr is always a string, and a
// child the timeout killed is flagged so nothing re-runs a command whose
// outcome is unknown.

export interface GhCommandExecError extends CommandFailure {
  code?: string | number | null;
}

export interface GhCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  // Present only when the command was terminated rather than answered, so a
  // normal result keeps the shape callers already assert on.
  timedOut?: boolean;
}

export function toGhCommandResult(
  error: GhCommandExecError | null | undefined,
  stdout: string | undefined,
  stderr: string | undefined,
  options: { trimStdout?: boolean } = {}
): GhCommandResult {
  const out = stdout || "";
  const timedOut = commandTimedOut(error);
  return {
    code: error ? error.code || 1 : 0,
    stdout: options.trimStdout ? out.trim() : out,
    stderr: stderr || "",
    ...(timedOut ? { timedOut: true } : {})
  };
}
