// The seam between the cloud fixture and the outside world.
//
// Nothing in `test/e2e-cloud/` calls `execFile` directly. Every `az`, `gh`, and
// `git` invocation goes through a port, so each branch of the fixture — a
// missing resource, a failed command, malformed output, a partially built
// fixture — is provable on a machine with no Azure or GitHub credentials at
// all. The real run passes `createNodeCloudFixturePorts()`; this is not a
// test-only hook.
//
// The result shape and the "resolve for a non-zero exit rather than reject"
// contract match the `runAz` convention the product already uses (see
// `src/server.ts` and `src/server/routes/azure-discovery.ts`), so a reader
// moving between production and fixture code meets one convention, not two.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactCredentials } from "../../../src/credential-redaction.js";
import { cliExec } from "../../../src/gh.js";

export interface CloudCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the external CLIs the fixture depends on.
 *
 * Implementations resolve with the exit code instead of rejecting, because a
 * non-zero exit is frequently the answer the fixture wants: `gh api` returning
 * 404 for an environment is how `assertCleanSlate` proves the environment is
 * absent.
 */
export interface CloudCommandPort {
  runAz(args: readonly string[]): Promise<CloudCommandResult>;
  runGh(args: readonly string[]): Promise<CloudCommandResult>;
  runGit(args: readonly string[], cwd: string): Promise<CloudCommandResult>;
}

export interface CloudFixturePorts {
  readonly commands: CloudCommandPort;
  /** Returns an absolute directory the fixture may clone into and later delete. */
  readonly makeWorkspaceDir: (prefix: string) => Promise<string>;
  readonly removeDir: (dir: string) => Promise<void>;
  /** Injected so eventual-consistency polling is deterministic under test. */
  readonly wait: (milliseconds: number) => Promise<void>;
  /** Injected so the resource group's `creationTime` tag is assertable. */
  readonly now: () => Date;
  /** Injected so per-run resource names are deterministic under test. */
  readonly newUniqueId: () => string;
}

const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// Delegates to the product's own CLI launcher rather than calling `execFile`
// again here. `cliExec` already solves the Windows problems this would
// otherwise rediscover: `gh` ships as `gh.exe` and is invoked directly so an
// `&` in an API query string is never treated as shell syntax, while `az`
// ships as a `.cmd` shim that Node refuses to spawn without a shell, so it is
// routed through `cmd.exe` with one verbatim, individually quoted command line.
// Shell execution is never enabled, and arguments keep their boundaries.
function runTool(
  tool: string,
  args: readonly string[],
  cwd?: string,
  normalize: (
    error: {
      code?: string | number | null;
      message?: string;
    } | null,
    stdout: string | undefined,
    stderr: string | undefined
  ) => CloudCommandResult = normalizeCommandResult
): Promise<CloudCommandResult> {
  return new Promise((resolve) => {
    const child = cliExec(
      tool,
      [...args],
      {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, stdout, stderr) => resolve(normalize(error, stdout, stderr))
    );
    // Nothing the fixture runs reads stdin, and an inherited stdin would let a
    // credential prompt hang the run instead of failing it.
    child.stdin?.end();
  });
}

export function redactAzureCredentials(
  value: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return redactCredentials(value, [
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    env.ARM_ACCESS_TOKEN,
    env.ARM_CLIENT_SECRET,
    env.ARM_OIDC_TOKEN,
    env.AZURE_ACCESS_TOKEN,
    env.AZURE_CLIENT_SECRET,
    env.AZURE_FEDERATED_TOKEN,
    env.AZURE_PASSWORD
  ]);
}

export function normalizeAzureCommandResult(
  error: {
    code?: string | number | null;
    message?: string;
  } | null,
  stdout: string | undefined,
  stderr: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): CloudCommandResult {
  const result = normalizeCommandResult(error, stdout, stderr);
  return {
    ...result,
    stdout: redactAzureCredentials(result.stdout, env),
    stderr: redactAzureCredentials(result.stderr, env)
  };
}

/**
 * Normalizes an `execFile` callback into a `CloudCommandResult`.
 *
 * A process killed by a signal or a timeout reports a string `code` such as
 * `ETIMEDOUT`, which would read as `NaN` and compare falsely against zero. Any
 * failure that cannot be expressed as a non-zero number becomes exit code 1, so
 * a caller can never mistake a killed command for a successful one.
 */
export function normalizeCommandResult(
  error: {
    code?: string | number | null;
    message?: string;
  } | null,
  stdout: string | undefined,
  stderr: string | undefined
): CloudCommandResult {
  const normalizedStdout = stdout || "";
  const normalizedStderr = stderr || "";
  return {
    code: error ? Number(error.code ?? 1) || 1 : 0,
    stdout: normalizedStdout,
    stderr:
      !normalizedStdout && !normalizedStderr ?
        error?.message || ""
      : normalizedStderr
  };
}

/**
 * Whether a failed `gh api` call carries GitHub CLI's HTTP 404 diagnostic.
 *
 * A bare "Not Found" is not enough: DNS, configuration, and wrapper failures
 * can contain those words without proving that GitHub answered for the
 * requested resource. Successful commands cannot report absence either, even
 * when their response body happens to mention an earlier HTTP 404.
 */
export function isGitHubApiNotFound(result: CloudCommandResult): boolean {
  if (result.code === 0) return false;
  return `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .some((line) =>
      /^(?:gh:\s.*\(HTTP 404\)|HTTP 404(?::.*)?)$/i.test(line.trim())
    );
}

/**
 * The production wiring. Deliberately branch-free: it holds no fixture logic,
 * so the code a credentialed run exercises but this suite cannot is as small as
 * it can be made.
 */
export function createNodeCloudFixturePorts(): CloudFixturePorts {
  return {
    commands: {
      runAz: (args) =>
        runTool("az", args, undefined, normalizeAzureCommandResult),
      runGh: (args) => runTool("gh", args),
      runGit: (args, cwd) => runTool("git", args, cwd)
    },
    makeWorkspaceDir: (prefix) =>
      fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`)),
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
    newUniqueId: () => randomUUID()
  };
}

/** Raised when an external command the fixture depends on did not succeed. */
export class CloudCommandError extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(context: string, result: CloudCommandResult) {
    const detail = (result.stderr || result.stdout).trim();
    super(
      `${context} failed with exit code ${result.code}` +
        (detail ? `: ${detail}` : ".")
    );
    this.name = "CloudCommandError";
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/**
 * Turns a non-zero exit into an error carrying the command's own diagnostics.
 *
 * Without this, a failed `az` call reads as empty output, and an empty output
 * reads as "the artifact is absent" — which is exactly how a clean-slate check
 * would report a clean slate it never actually established.
 */
export function expectSuccess(
  result: CloudCommandResult,
  context: string
): CloudCommandResult {
  if (result.code !== 0) throw new CloudCommandError(context, result);
  return result;
}

/**
 * Parses a successful command's stdout as a JSON array.
 *
 * Malformed output and a non-array payload are hard failures for the same
 * reason: silently treating either as "no results" converts an unreadable
 * answer into a false negative.
 */
export function parseJsonArray(
  result: CloudCommandResult,
  context: string
): unknown[] {
  expectSuccess(result, context);
  const text = result.stdout.trim();
  // `az --query` prints nothing at all when it filters everything out, so an
  // empty body is a genuine empty result rather than a parse failure.
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${context} returned output that is not valid JSON: ${describeError(error)}`,
      { cause: error }
    );
  }
  if (!Array.isArray(parsed))
    throw new Error(
      `${context} returned ${describeJsonKind(parsed)} where a JSON array was expected.`
    );
  return parsed;
}

function describeJsonKind(value: unknown): string {
  if (value === null) return "null";
  return `a JSON ${typeof value}`;
}

/**
 * Renders any thrown value as a message.
 *
 * Aggregated teardown and reclamation reports must not lose a rejection just
 * because it was not an `Error`.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
