import { errorMessage } from "./util.js";

export interface EnvironmentExecutionClock {
  deferTask(): Promise<void>;
  microtask(callback: () => void): void;
  reconciliationTimer(callback: () => void): unknown;
}

interface EnvironmentTask {
  run(): Promise<void>;
  failed(error: unknown): Promise<void>;
  settling(): void;
  settled(): void;
}

interface TaskRecord {
  operationId: string;
  instanceId: string;
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
    return timer;
  }
};

/**
 * Runtime bookkeeping, with the existing inner scopes retained. Attachments
 * keep their original transport closures; a generation is provenance, not a
 * new cancellation fence or a cross-panel operation lock.
 */
export function createEnvironmentExecutionOwner(
  clock: EnvironmentExecutionClock = productionClock
) {
  const activeTasks = new Map<string, Set<string>>();
  const settledListeners = new Map<string, Set<() => void>>();
  const shuttingDownInstances = new Set<string>();
  const verificationMonitors = new Set<string>();
  const blockedAdmissions = new Set<string>();
  const attachments = new Map<string, number>();
  const admissions = new Map<
    string,
    { started: boolean; blocked: boolean; recovery: Set<() => void> }
  >();
  let generation = 0;

  function hasActiveEnvironmentTasks(instanceId: string): boolean {
    return (activeTasks.get(instanceId)?.size || 0) > 0;
  }

  function notify(listener: () => void): void {
    try {
      listener();
    } catch {
      // Preserve settlement even when one close consumer fails.
    }
  }

  function onEnvironmentTasksSettled(
    instanceId: string,
    listener: () => void
  ): () => void {
    let listeners = settledListeners.get(instanceId);
    if (!listeners) {
      listeners = new Set();
      settledListeners.set(instanceId, listeners);
    }
    listeners.add(listener);
    let listening = true;
    const stop = () => {
      if (!listening) return;
      listening = false;
      listeners.delete(listener);
      if (listeners.size === 0) settledListeners.delete(instanceId);
    };
    if (!hasActiveEnvironmentTasks(instanceId)) {
      clock.microtask(() => {
        if (!listening || hasActiveEnvironmentTasks(instanceId)) return;
        notify(listener);
      });
    }
    return stop;
  }

  function attach(instanceId: string) {
    const attachmentGeneration = ++generation;
    attachments.set(instanceId, attachmentGeneration);
    const tasks = new Map<string, TaskRecord>();
    const automaticRollbacks = new Set<string>();
    const reconciliationTimers = new Map<string, unknown>();

    return {
      instanceId,
      generation: attachmentGeneration,
      isCurrent: () => attachments.get(instanceId) === attachmentGeneration,
      hasTask: (operationId: string) => tasks.has(operationId),
      schedule(operationId: string, task: EnvironmentTask): void {
        const admission = admissions.get(operationId);
        if (admission) admission.started = true;
        let instanceTasks = activeTasks.get(instanceId);
        if (!instanceTasks) {
          instanceTasks = new Set();
          activeTasks.set(instanceId, instanceTasks);
        }
        instanceTasks.add(operationId);
        const prior = tasks.get(operationId)?.promise;
        const running = (prior || Promise.resolve())
          .catch(() => {})
          .then(() => clock.deferTask())
          .then(task.run)
          .catch(task.failed)
          .finally(() => {
            if (tasks.get(operationId)?.promise !== running) return;
            task.settling();
            tasks.delete(operationId);
            // Queries deliberately retain instance-ID aggregation, including
            // the existing operation-set semantics on same-ID replacement.
            const active = activeTasks.get(instanceId);
            active?.delete(operationId);
            if (active?.size === 0) {
              activeTasks.delete(instanceId);
              for (const listener of settledListeners.get(instanceId) || []) {
                notify(listener);
              }
            }
            task.settled();
          });
        tasks.set(operationId, {
          operationId,
          instanceId,
          generation: attachmentGeneration,
          promise: running
        });
        void running.catch((error: unknown) => {
          console.error(
            `[radius] environment task finalization failed (operationId=${operationId}, instanceId=${instanceId}): ${errorMessage(error)}`
          );
        });
      },
      scheduleReconciliation(operationId: string, callback: () => void): void {
        if (reconciliationTimers.has(operationId)) return;
        const timer = clock.reconciliationTimer(() => {
          reconciliationTimers.delete(operationId);
          callback();
        });
        reconciliationTimers.set(operationId, timer);
      },
      claimAutomaticRollback(operationId: string): boolean {
        if (automaticRollbacks.has(operationId)) return false;
        automaticRollbacks.add(operationId);
        return true;
      },
      releaseAutomaticRollback(operationId: string): void {
        automaticRollbacks.delete(operationId);
      }
    };
  }

  return {
    attach,
    claimAdmission(operationId: string) {
      if (admissions.has(operationId) || blockedAdmissions.has(operationId))
        return null;
      const admission = {
        started: [...activeTasks.values()].some((tasks) =>
          tasks.has(operationId)
        ),
        blocked: false,
        recovery: new Set<() => void>()
      };
      admissions.set(operationId, admission);
      return {
        canRestore: () =>
          admissions.get(operationId) === admission && !admission.started,
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
          for (const recover of admission.recovery) clock.microtask(recover);
        }
      };
    },
    deferAdmissionRecovery(operationId: string, recover: () => void): boolean {
      if (blockedAdmissions.has(operationId)) return true;
      const admission = admissions.get(operationId);
      if (!admission) return false;
      if (!admission.blocked) admission.recovery.add(recover);
      return true;
    },
    hasActiveEnvironmentTasks,
    onEnvironmentTasksSettled,
    markEnvironmentInstanceShuttingDown(instanceId: string): void {
      shuttingDownInstances.add(instanceId);
    },
    markEnvironmentInstanceStarted(instanceId: string): void {
      shuttingDownInstances.delete(instanceId);
    },
    isShuttingDown: (instanceId: string) =>
      shuttingDownInstances.has(instanceId),
    claimVerificationMonitor(operationId: string): boolean {
      if (verificationMonitors.has(operationId)) return false;
      verificationMonitors.add(operationId);
      return true;
    },
    releaseVerificationMonitor(operationId: string): void {
      verificationMonitors.delete(operationId);
    }
  };
}

export type EnvironmentExecutionOwner = ReturnType<
  typeof createEnvironmentExecutionOwner
>;
