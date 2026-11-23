import type {
  DeployProgress,
  WorkflowArtifact
} from "../deploy-artifact-evidence.js";
import type { WorkflowReadContext } from "../workflow-read-policy.js";
import type { DeployStatus } from "../graph/index.js";
import {
  deletionInventoryFromSnapshot,
  type DeletionInventory,
  type DeletionInventorySnapshot
} from "./resource-inventory.js";

type RunId = number | string;

export interface DeploymentInspectionReader {
  graph(context?: WorkflowReadContext): Promise<{
    graph: unknown | null;
    status: string;
    artifact?: WorkflowArtifact | null;
  }>;
  progress(context?: WorkflowReadContext): Promise<DeployProgress | null>;
  read(context?: WorkflowReadContext): Promise<DeletionInventorySnapshot>;
}

export interface DeploymentRunSnapshot {
  readonly matchesSelection: boolean;
  readonly active: boolean;
  readonly id: RunId | null | undefined;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly unconfirmed: boolean;
}

export interface DeploymentGraphObservation {
  graph: unknown;
  progress: DeployProgress | null;
  artifactRunId: RunId | null;
  readOk: boolean;
  newerRun: boolean;
  inventory: DeletionInventory | null;
}

export async function inspectDeploymentGraph(input: {
  run: DeploymentRunSnapshot;
  openReader(runId: RunId | null): DeploymentInspectionReader;
  context?: WorkflowReadContext;
  assertObserving(): void;
  acceptProgress(progress: DeployProgress | null): void;
  inventorySelection: Readonly<{ application: string; environment: string }>;
  inventoryIsCurrent(): boolean;
}): Promise<
  | { kind: "observed"; observation: DeploymentGraphObservation }
  | {
      kind: "read-failed";
      observation: DeploymentGraphObservation;
      error: unknown;
    }
> {
  const { run } = input;
  const observation: DeploymentGraphObservation = {
    graph: null,
    progress: null,
    artifactRunId: null,
    readOk: false,
    newerRun: false,
    inventory: null
  };
  try {
    const reader = input.openReader(run.active ? (run.id ?? null) : null);
    const result = await reader.graph(input.context);
    input.assertObserving();
    observation.graph = result.graph;
    observation.readOk = result.status === "ok" || result.status === "stale";
    const progress = await reader.progress(input.context);
    input.assertObserving();
    const artifactRunId =
      progress?.runId ?? result.artifact?.workflow_run?.id ?? null;
    const mismatched =
      run.matchesSelection &&
      run.id != null &&
      artifactRunId != null &&
      String(run.id) !== String(artifactRunId);
    const boundary = Math.max(run.startedAt ?? 0, run.finishedAt ?? 0);
    const createdAt = Date.parse(result.artifact?.created_at ?? "");
    const newerRun =
      mismatched &&
      !run.active &&
      boundary > 0 &&
      Number.isFinite(createdAt) &&
      createdAt > boundary;
    const needsIdentity =
      run.matchesSelection &&
      run.id != null &&
      run.unconfirmed &&
      (progress?.state === "failed" || progress?.state === "succeeded");
    const accepted =
      run.active ?
        run.id != null &&
        artifactRunId != null &&
        String(run.id) === String(artifactRunId)
      : (!mismatched || newerRun) && (!needsIdentity || artifactRunId != null);
    if (!accepted) {
      observation.graph = null;
      observation.readOk = false;
      return { kind: "observed", observation };
    }

    observation.progress = progress;
    observation.artifactRunId = artifactRunId;
    observation.newerRun = newerRun;
    input.acceptProgress(progress);
    const snapshot = await reader.read(input.context);
    input.assertObserving();
    if (!run.active && input.inventoryIsCurrent()) {
      const { application, environment } = input.inventorySelection;
      observation.inventory = deletionInventoryFromSnapshot(
        snapshot,
        application,
        environment,
        run.matchesSelection ? (run.id ?? null) : null
      );
    }
    return { kind: "observed", observation };
  } catch (error) {
    return { kind: "read-failed", observation, error };
  }
}

export function projectInspectedTopology(
  topology: unknown[],
  metadata: Readonly<{
    planned: unknown;
    deployment: unknown;
    monitor: unknown;
  }>,
  statusByKey: Map<string, DeployStatus>,
  projection: DeploymentTopologyProjection
): unknown[] {
  const planned = projection.mergeDeployedGraphMetadata(
    topology,
    metadata.planned
  );
  const deployed = projection.mergeDeployedGraphMetadata(
    planned,
    metadata.deployment
  );
  const displayed = projection.mergeDeployedGraphDisplayMetadata(
    deployed,
    metadata.monitor
  );
  return projection.projectDeployedGraph(displayed, statusByKey);
}

interface DeploymentTopologyProjection {
  mergeDeployedGraphMetadata(modeled: unknown[], deployed: unknown): unknown[];
  mergeDeployedGraphDisplayMetadata(
    modeled: unknown[],
    display: unknown
  ): unknown[];
  projectDeployedGraph(
    modeled: unknown[],
    statusByKey: Map<string, DeployStatus>
  ): unknown[];
}
