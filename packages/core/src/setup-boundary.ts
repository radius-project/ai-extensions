export interface SetupCheckpointOperation {
  operationId?: string;
  providerRecovery?: unknown;
}

export type SetupPersistenceResult =
  { outcome: "saved" } | { outcome: "persistence-failed"; error: unknown };

export async function saveSetupOperation(
  persist: () => Promise<void>
): Promise<SetupPersistenceResult> {
  try {
    await persist();
    return { outcome: "saved" };
  } catch (error) {
    return { outcome: "persistence-failed", error };
  }
}

export type SetupCheckpointResult =
  SetupPersistenceResult | { outcome: "rollback-pending" };

export async function saveSetupCheckpoint({
  operation,
  persist
}: {
  operation: SetupCheckpointOperation | null;
  persist(): Promise<void>;
}): Promise<SetupCheckpointResult> {
  const result = await saveSetupOperation(persist);
  if (result.outcome === "persistence-failed") return result;
  // Read the live record after saving: reconciliation may have settled while
  // persistence was in flight. Forward writes must not enlarge a rollback set.
  const recovery = operation?.providerRecovery;
  return (
      typeof recovery === "object" &&
        recovery !== null &&
        "state" in recovery &&
        recovery.state === "rollback_pending"
    ) ?
      { outcome: "rollback-pending" }
    : result;
}

export interface SetupStopPorts {
  isStopRequested(): boolean;
  hasUnsettledMutation(): boolean;
  beforePersist?(): void;
  transitionToStopped(boundary: string): void;
  persist(): Promise<void>;
  publishStopped(): void;
  reportPersistenceFailure(error: unknown): void;
}

export async function honorSetupStop(
  boundary: string,
  ports: SetupStopPorts
): Promise<boolean> {
  if (!ports.isStopRequested()) return true;
  // Stopping cannot strand an unknown write. Its reconciliation owns the
  // operation until the outcome settles or becomes a manual decision.
  if (ports.hasUnsettledMutation()) return true;
  ports.beforePersist?.();
  ports.transitionToStopped(boundary);
  try {
    await ports.persist();
    ports.publishStopped();
  } catch (error) {
    ports.reportPersistenceFailure(error);
  }
  return false;
}
