import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import type { AwsCleanupCluster } from "./aws-cloud-cleanup.js";

// What the AWS Cloud E2E journey's checks share: the AWS CLI port, the clock
// they poll on, and small readers for the CLI's JSON.

export interface AwsJourneyPorts {
  runAws(args: string[]): Promise<AwsCommandResult>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `<name> (<region>)`, how every check names a cluster. */
export function clusterLabel(cluster: AwsCleanupCluster): string {
  return `${cluster.name} (${cluster.region})`;
}
