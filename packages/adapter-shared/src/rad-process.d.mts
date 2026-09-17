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
  inheritEnv?: boolean;
  signal?: AbortSignal;
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
  readonly cleanupIncomplete: boolean;
  constructor(
    message: string,
    stdout: string,
    stderr: string,
    cleanupIncomplete?: boolean
  );
}

export function windowsTaskkillPath(env?: NodeJS.ProcessEnv): string;

export function killChildTree(
  child: ChildProcessLike | null | undefined,
  platform?: NodeJS.Platform
): Promise<void>;

export function radSpawnOptions(platform?: NodeJS.Platform): RadSpawnOptions;

export function spawnRad(
  radPath: string,
  args: string[],
  options?: SpawnRadOptions
): Promise<ProcessResult>;
