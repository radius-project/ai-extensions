export type SetupCommandAdmissionResult =
  | { state: "conflict"; operationId: string }
  | { state: "duplicate"; commandId: string }
  | { state: "persist-failed"; error: unknown }
  | { state: "unscheduled" }
  | { state: "stopped" }
  | { state: "stale" }
  | { state: "accepted"; commandId: string; attempt: number };

export interface SetupCommandAdmissionPorts {
  isCurrent(): boolean;
  unwindStale(): Promise<void>;
  isStopped?(): boolean;
  acquire(): { ok: true } | { ok: false; operationId: string };
  begin(): { ok: boolean; commandId: string; attempt: number };
  restore(): void;
  prepare(commandId: string): void;
  persist(): Promise<void>;
  running(commandId: string): void;
  schedule(commandId: string): boolean;
  publish(result: SetupCommandAdmissionResult): void;
  unscheduled(commandId: string): void;
  reportPersistenceFailure(error: unknown): void;
}

/** Admit one ledger-derived command, preserving the durable scheduling boundary. */
export async function admitSetupCommand(
  schedulerMiss: "close-operation" | "restore-terminal",
  ports: SetupCommandAdmissionPorts
): Promise<void> {
  const refuseStale = async () => {
    try {
      await ports.unwindStale();
      ports.publish({ state: "stale" });
    } catch (error) {
      ports.reportPersistenceFailure(error);
      ports.publish({ state: "persist-failed", error });
    }
  };
  if (!ports.isCurrent()) {
    await refuseStale();
    return;
  }
  if (ports.isStopped?.()) {
    ports.publish({ state: "stopped" });
    return;
  }
  const lock = ports.acquire();
  if (!lock.ok) {
    ports.publish({ state: "conflict", operationId: lock.operationId });
    return;
  }
  const command = ports.begin();
  if (!command.ok) {
    ports.restore();
    ports.publish({ state: "duplicate", commandId: command.commandId });
    return;
  }
  ports.prepare(command.commandId);
  try {
    await ports.persist();
  } catch (error) {
    if (!ports.isCurrent()) {
      await refuseStale();
      return;
    }
    ports.restore();
    ports.publish({ state: "persist-failed", error });
    return;
  }
  if (!ports.isCurrent()) {
    await refuseStale();
    return;
  }
  if (ports.isStopped?.()) {
    ports.publish({ state: "stopped" });
    return;
  }
  ports.running(command.commandId);
  const accept = () =>
    ports.publish({
      state: "accepted",
      commandId: command.commandId,
      attempt: command.attempt
    });
  const persistRecovery = async () => {
    try {
      await ports.persist();
    } catch (error) {
      ports.reportPersistenceFailure(error);
    }
  };
  if (schedulerMiss === "restore-terminal") {
    if (!ports.schedule(command.commandId)) {
      ports.restore();
      ports.publish({ state: "unscheduled" });
      await persistRecovery();
      return;
    }
    accept();
    return;
  }
  // Retry callers retain their accepted response even if the runner is missing;
  // the saved operation then records the scheduling failure.
  accept();
  if (ports.schedule(command.commandId)) return;
  ports.unscheduled(command.commandId);
  await persistRecovery();
}
