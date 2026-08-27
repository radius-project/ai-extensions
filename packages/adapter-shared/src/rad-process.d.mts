// Hand-written declarations for rad-process.mjs. `allowJs` is off and this
// package's tsconfig only includes `src/**/*.ts`, so tsc cannot verify this file
// against the implementation — keep the two in sync by hand when either changes.

import type { ChildProcess } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface SpawnRadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  label?: string;
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

export function killChildTree(child: ChildProcess | null | undefined): void;

export function spawnRad(
  radPath: string,
  args: string[],
  options?: SpawnRadOptions
): Promise<ProcessResult>;
