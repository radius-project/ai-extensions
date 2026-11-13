import { createHash } from "node:crypto";
import type { DeploymentRecord, DeploymentRow } from "@radius-project/core";

export function cleanupRevision(
  repo: string,
  environment: string,
  runId: number,
  records: readonly DeploymentRecord[]
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        repo.toLowerCase(),
        environment,
        runId,
        records
          .map((record) => [
            record.id,
            record.workflow,
            record.runAttempt,
            record.headSha,
            record.runStatus,
            record.runConclusion
          ])
          .sort((left, right) =>
            String(left[0]).localeCompare(String(right[0]))
          )
      ])
    )
    .digest("hex");
}

/** Under GitHub's 140-character deployment-status description limit. */
export function cleanupMarker(
  recovery: NonNullable<DeploymentRow["recovery"]>
): string {
  return `Radius cleanup v1 run:${recovery.runId} attempt:${recovery.runAttempt} rev:${recovery.revision}`;
}

export function cleanupConfirmation(
  repo: string,
  environment: string,
  runId: number,
  runAttempt: number,
  application: string
): string {
  return application ?
      `${application}/${environment}`
    : `${repo}/run-${runId}@${runAttempt}/${environment}`;
}
