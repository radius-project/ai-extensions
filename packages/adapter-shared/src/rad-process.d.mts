// Hand-written declarations for rad-process.mjs. `allowJs` is off and this
// package's tsconfig only includes `src/**/*.ts`, so tsc cannot verify this file
// against the implementation — keep the two in sync by hand when either changes.

export interface RadSpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: true;
  detached: boolean;
}

export interface ChildProcessLike {
  pid?: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface SpawnRadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  label?: string;
  /** Cancellation and timeout drain before rejection when a signal is supplied. */
  signal?: AbortSignal;
  /**
   * Drain before rejecting on timeout, even without a signal. On Windows,
   * cancellation or a draining timeout rejects with
   * RadProcessExitUnconfirmedError if tree exit is unconfirmed.
   */
  drainOnTimeout?: boolean;
}

// bicepPath is required: this low-level helper has no default, so omitting it
// would set BICEP to undefined. The rad.ts wrapper supplies MANAGED_BICEP_PATH.
export function managedBicepEnv(
  env: NodeJS.ProcessEnv | undefined,
  bicepPath: string
): NodeJS.ProcessEnv;

export class RadProcessError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, stdout: string, stderr: string);
}

export class RadProcessExitUnconfirmedError extends RadProcessError {}

/** Detects an unconfirmed exit through Error.cause wrappers. */
export function isRadProcessExitUnconfirmed(error: unknown): boolean;

export function windowsTaskkillPath(env?: NodeJS.ProcessEnv): string;

/** A Windows cleanup resolves false if taskkill could not confirm tree exit. */
export function killChildTree(
  child: ChildProcessLike | null | undefined,
  platform?: NodeJS.Platform
): Promise<boolean> | undefined;

export function radSpawnOptions(platform?: NodeJS.Platform): RadSpawnOptions;

export function spawnRad(
  radPath: string,
  args: string[],
  options?: SpawnRadOptions
): Promise<ProcessResult>;
