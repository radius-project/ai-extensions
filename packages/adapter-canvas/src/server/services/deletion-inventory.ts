import type { DeployProgress } from "../../deploy-artifacts.js";

export interface DeletionInventory {
  application: string;
  environment: string;
  resources: Array<{ name: string; type: string }>;
}

export interface DeletionInventorySnapshot {
  status: string;
  progressRevalidated?: boolean;
  progress: DeployProgress | null;
}

export function deletionInventoryFromSnapshot(
  snapshot: DeletionInventorySnapshot,
  application: string,
  environment: string,
  expectedRunId: number | string | null
): DeletionInventory | null {
  const progress = snapshot.progress;
  if (
    (snapshot.status !== "ok" &&
      !(
        snapshot.status === "stale" && snapshot.progressRevalidated === true
      )) ||
    !progress ||
    !application ||
    !environment ||
    progress.application.toLowerCase() !== application.toLowerCase() ||
    progress.environment.toLowerCase() !== environment.toLowerCase() ||
    !progress.runId ||
    (expectedRunId !== null &&
      String(progress.runId) !== String(expectedRunId)) ||
    (progress.state !== "succeeded" && progress.state !== "failed")
  ) {
    return null;
  }

  // Live polls are incomplete while provisioning continues. Terminal reports
  // come from resource-list, not app graph, but their producer also uses [] on
  // list failure. Without a success marker an empty report is unknown.
  if (
    progress.resources.length === 0 ||
    progress.resources.some(
      (resource) => !resource.name.trim() || !resource.type.trim()
    )
  ) {
    return null;
  }
  return {
    application: progress.application,
    environment: progress.environment,
    resources: progress.resources.map(({ name, type }) => ({ name, type }))
  };
}
