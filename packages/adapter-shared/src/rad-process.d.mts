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
