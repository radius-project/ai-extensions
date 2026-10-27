import { errorMessage } from "./util.js";

export interface EnvironmentExecutionClock {
  deferTask(): Promise<void>;
  microtask(callback: () => void): void;
  reconciliationTimer(callback: () => void): () => void;
}

interface EnvironmentTask {
  run(): Promise<void>;
  cancelled?(): void;
  failed(error: unknown): Promise<void>;
  settling(): void;
  settled(): void;
}

interface TaskRecord {
  operationId: string;
  instanceId: string | undefined;
  generation: number;
  promise: Promise<void>;
}

const productionClock: EnvironmentExecutionClock = {
  deferTask: () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    }),
  microtask: (callback) => queueMicrotask(callback),
  reconciliationTimer: (callback) => {
    const timer = setTimeout(callback, 5000);
    timer.unref?.();
    return () => clearTimeout(timer);
  }
};

export function createEnvironmentExecutionOwner(
  clock: EnvironmentExecutionClock = productionClock
) {
  const blockedAdmissions = new Set<string>();
  const admissions = new Map<
    string,
    {
      started: boolean;
      blocked: boolean;
      recovery: Set<(operationId: string) => void>;
    }
  >();
  const activeTasks = new Map<string | undefined, Set<Promise<void>>>();
  const activeRecords = new Set<TaskRecord>();
  const settledListeners = new Map<string | undefined, Set<() => void>>();
  const deletionSettledListeners = new Map<
    string | undefined,
    Set<() => void>
  >();
  const activeDeletions = new Set<Promise<void>>();
  const shuttingDownInstances = new Set<string | undefined>();
  const sharedTasks = new Map<string, TaskRecord>();
  const currentAttachments = new Map<string | undefined, number>();
  const automaticRollbacks = new Map<string, symbol>();
  const verificationMonitors = new Map<string, symbol>();
  const reconciliationTimers = new Map<string, { cancel: () => void }>();
  const shutdownListeners = new Set<{ listener: () => void }>();
  let shuttingDown = false;
  let generation = 0;

  function hasActiveEnvironmentTasks(instanceId: string | undefined): boolean {
    return (activeTasks.get(instanceId)?.size || 0) > 0;
  }

  function hasActiveDeletionTasks(instanceId: string | undefined): boolean {
    return [...(activeTasks.get(instanceId) || [])].some((task) =>
      activeDeletions.has(task)
    );
  }

  function notifyShutdown(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      console.error(
        `[radius] setup shutdown callback failed: ${errorMessage(error)}`
      );
    }
  }

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of reconciliationTimers.values())
      notifyShutdown(timer.cancel);
    reconciliationTimers.clear();
    for (const { listener } of shutdownListeners) notifyShutdown(listener);
    shutdownListeners.clear();
  }

  function onShutdown(listener: () => void): () => void {
    const registration = { listener };
    if (shuttingDown) notifyShutdown(listener);
    else shutdownListeners.add(registration);
    return () => {
      shutdownListeners.delete(registration);
    };
  }

  function claim(
    claims: Map<string, symbol>,
    operationId: string
  ): (() => void) | undefined {
    if (claims.has(operationId)) return undefined;
    const registration = Symbol(operationId);
    claims.set(operationId, registration);
    return () => {
      if (claims.get(operationId) === registration) claims.delete(operationId);
    };
  }

  function notify(listener: () => void): void {
    try {
      listener();
    } catch {
      // Preserve settlement even when one close consumer fails.
    }
  }

  function onEnvironmentTasksSettled(
    instanceId: string | undefined,
    listener: () => void,
    registry = settledListeners,
    isActive = hasActiveEnvironmentTasks
  ): () => void {
    let listeners = registry.get(instanceId);
    if (!listeners) {
      listeners = new Set();
      registry.set(instanceId, listeners);
    }
    listeners.add(listener);
    let listening = true;
    const stop = () => {
      if (!listening) return;
      listening = false;
      listeners.delete(listener);
      if (listeners.size === 0) registry.delete(instanceId);
    };
    if (!isActive(instanceId)) {
      clock.microtask(() => {
        if (!listening || isActive(instanceId)) return;
        notify(listener);
      });
    }
    return stop;
  }

  function attachScope(instanceId?: string, tasks = sharedTasks) {
    const attachmentGeneration = ++generation;
    if (tasks === sharedTasks) {
      currentAttachments.set(instanceId, attachmentGeneration);
    }
    const scopeIdentity =
      instanceId === undefined ? "scope=runtime" : `instanceId=${instanceId}`;
    function reportFinalizationError(
      operationId: string,
      error: unknown
    ): void {
      console.error(
        `[radius] environment task finalization failed (operationId=${operationId}, ${scopeIdentity}): ${errorMessage(error)}`
      );
    }

    return {
      instanceId,
      generation: attachmentGeneration,
      isCurrent: () =>
        currentAttachments.get(instanceId) === attachmentGeneration,
      detach: () => {
        if (currentAttachments.get(instanceId) === attachmentGeneration) {
          currentAttachments.delete(instanceId);
        }
      },
      hasActiveTasks: () => hasActiveEnvironmentTasks(instanceId),
      onTasksSettled: (listener: () => void) =>
        onEnvironmentTasksSettled(instanceId, listener),
      isShuttingDown: () =>
        shuttingDown ||
        (tasks !== sharedTasks && shuttingDownInstances.has(instanceId)),
      markShuttingDown: () => {
        if (tasks === sharedTasks) shutdown();
        else shuttingDownInstances.add(instanceId);
      },
      hasTask: (operationId: string) => tasks.has(operationId),
      schedule(operationId: string, task: EnvironmentTask): void {
        if (shuttingDown && tasks === sharedTasks) {
          throw new Error("Setup execution is shutting down.");
        }
        const admission = admissions.get(operationId);
        if (admission) admission.started = true;
        let instanceTasks = activeTasks.get(instanceId);
        if (!instanceTasks) {
          instanceTasks = new Set();
          activeTasks.set(instanceId, instanceTasks);
        }
        const timer = reconciliationTimers.get(operationId);
        if (timer) {
          reconciliationTimers.delete(operationId);
          timer.cancel();
        }
        const prior = tasks.get(operationId)?.promise;
        const running = (prior || Promise.resolve())
          .catch(() => {})
          .then(() => clock.deferTask())
          .then(() => {
            if (shuttingDown && tasks === sharedTasks) {
              task.cancelled?.();
              return;
            }
            return task.run();
          })
          .catch(task.failed)
          .finally(() => {
            if (tasks.get(operationId) === record) {
              try {
                task.settling();
              } catch (error) {
                reportFinalizationError(operationId, error);
              }
              if (tasks.get(operationId) === record) tasks.delete(operationId);
            }
            const active = activeTasks.get(instanceId);
            activeRecords.delete(record);
            active?.delete(running);
            const deletionSettled = activeDeletions.delete(running);
            if (active?.size === 0) {
              activeTasks.delete(instanceId);
              for (const listener of [
                ...(settledListeners.get(instanceId) || [])
              ]) {
                if (hasActiveEnvironmentTasks(instanceId)) break;
                notify(listener);
              }
            }
            if (deletionSettled && !hasActiveDeletionTasks(instanceId)) {
              for (const listener of [
                ...(deletionSettledListeners.get(instanceId) || [])
              ]) {
                if (hasActiveDeletionTasks(instanceId)) break;
                notify(listener);
              }
            }
            if (!tasks.has(operationId)) {
              try {
                task.settled();
              } catch (error) {
                reportFinalizationError(operationId, error);
              }
            }
          });
        const record: TaskRecord = {
          operationId,
          instanceId,
          generation: attachmentGeneration,
          promise: running
        };
        tasks.set(operationId, record);
        activeRecords.add(record);
        instanceTasks.add(running);
        if (tasks !== sharedTasks) activeDeletions.add(running);
        void running.catch((error: unknown) => {
          reportFinalizationError(operationId, error);
        });
      },
      scheduleReconciliation(operationId: string, callback: () => void): void {
        if (shuttingDown) return;
        if (reconciliationTimers.has(operationId)) return;
        const registration = {
          cancel: clock.reconciliationTimer(() => {
            if (reconciliationTimers.get(operationId) !== registration) return;
            reconciliationTimers.delete(operationId);
            callback();
          })
        };
        reconciliationTimers.set(operationId, registration);
      },
      claimAutomaticRollback: (operationId: string) =>
        claim(automaticRollbacks, operationId)
    };
  }

  return {
    claimAdmission(operationId: string) {
      if (admissions.has(operationId) || blockedAdmissions.has(operationId))
        return null;
      const hadTask = [...activeRecords].some(
        (record) => record.operationId === operationId
      );
      const admission = {
        started: false,
        blocked: false,
        recovery: new Set<(operationId: string) => void>()
      };
      admissions.set(operationId, admission);
      return {
        hadTask,
        canRestore: (options?: { allowPreexistingTask: boolean }) =>
          admissions.get(operationId) === admission &&
          !admission.started &&
          (!hadTask || options?.allowPreexistingTask === true),
        blockRecovery: () => {
          admission.blocked = true;
        },
        release: () => {
          if (admissions.get(operationId) !== admission) return;
          if (admission.blocked) {
            admissions.delete(operationId);
            blockedAdmissions.add(operationId);
            admission.recovery.clear();
            return;
          }
          admissions.delete(operationId);
          for (const recover of admission.recovery) {
            clock.microtask(() => recover(operationId));
          }
        }
      };
    },
    deferAdmissionRecovery(
      operationId: string,
      recover: (operationId: string) => void
    ): boolean {
      if (blockedAdmissions.has(operationId)) return true;
      const admission = admissions.get(operationId);
      if (!admission) return false;
      if (!admission.blocked) admission.recovery.add(recover);
      return true;
    },
    attach: (instanceId: string) => attachScope(instanceId),
    attachDeletion: (instanceId: string) => attachScope(instanceId, new Map()),
    attachRuntime: () => attachScope(),
    shutdown,
    onShutdown,
    hasActiveDeletionTasks,
    onDeletionTasksSettled: (instanceId: string, listener: () => void) =>
      onEnvironmentTasksSettled(
        instanceId,
        listener,
        deletionSettledListeners,
        hasActiveDeletionTasks
      ),
    hasActiveEnvironmentTasks,
    onEnvironmentTasksSettled,
    markEnvironmentInstanceShuttingDown(instanceId: string): void {
      shuttingDownInstances.add(instanceId);
    },
    markEnvironmentInstanceStarted(instanceId: string): void {
      shuttingDownInstances.delete(instanceId);
    },
    isShuttingDown: (instanceId?: string) =>
      shuttingDown || shuttingDownInstances.has(instanceId),
    claimVerificationMonitor: (operationId: string) =>
      claim(verificationMonitors, operationId)
  };
}

export type EnvironmentExecutionOwner = ReturnType<
  typeof createEnvironmentExecutionOwner
>;
