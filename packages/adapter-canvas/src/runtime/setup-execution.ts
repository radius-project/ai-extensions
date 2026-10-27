import {
  addLegacyStep,
  finish,
  providerRecoveryManualGuidance,
  reconcileRestoredOperation,
  setExecutionActive,
  STAGE_VERIFY,
  unresolvedProviderMutations
} from "../operations.js";
import { planRecoveredSchedule } from "../server/services/recovered-cleanup-command.js";
import type { CleanupCommandKind } from "../server/services/cleanup-commands.js";
import type { EnvironmentExecutionOwner } from "./environment-execution-owner.js";
import { errorMessage } from "./util.js";
import { isSetupExecutionInterrupted } from "@radius-project/core";

export interface SetupExecutionOperation {
  operationId: string;
  repo?: string;
  environment?: string;
  kind?: string;
  endedAt?: unknown;
  currentStage?: string | null;
  steps: Array<{ label?: string }>;
  recoveryState?: string | null;
  providerRecovery?: { state?: string };
  verification?: { retryCommandId?: string | null };
  control?: {
    commands?: Array<{ commandId?: string; kind?: string; state?: string }>;
  };
}

export type SetupExecutionCommand =
  "verification_monitor" | "verification_retry" | CleanupCommandKind;

type TaskScope = Pick<
  ReturnType<EnvironmentExecutionOwner["attach"]>,
  "schedule" | "hasTask" | "scheduleReconciliation" | "claimAutomaticRollback"
>;

export interface SetupExecutionPorts {
  deferAdmissionRecovery(operationId: string, recover: () => void): boolean;
  scope: TaskScope;
  getOperation(operationId: string): SetupExecutionOperation | null | undefined;
  persist(): Promise<void>;
  report(input: { scope: string; operationId: string; message: string }): void;
  isShuttingDown(operationId: string): boolean;
  deferRecovery(callback: () => void): void;
  admitRecoveryRollback(
    operationId: string,
    isCurrent: () => boolean
  ): Promise<void>;
  claimVerificationMonitor(operationId: string): (() => void) | undefined;
  runOperation(operationId: string): Promise<void>;
  runVerificationRetry(operationId: string, commandId: string): Promise<void>;
  runVerificationContinuation(
    operationId: string,
    commandId: string
  ): Promise<void>;
  observeRecoveredVerification(
    operation: SetupExecutionOperation
  ): Promise<void>;
  runCleanup(
    kind: CleanupCommandKind,
    operationId: string,
    commandId: string
  ): Promise<void>;
  recoverBranchDelete(operationId: string): Promise<void>;
  recoverCleanup(operationId: string): Promise<void>;
}

export function reopenProviderReconciliation(operation: unknown): boolean {
  if (!operation || unresolvedProviderMutations(operation).length === 0) {
    return false;
  }
  reconcileRestoredOperation(operation);
  setExecutionActive(operation, false);
  return true;
}

export function createSetupExecution(ports: SetupExecutionPorts) {
  for (const name of [
    "deferAdmissionRecovery",
    "getOperation",
    "persist",
    "report",
    "isShuttingDown",
    "deferRecovery",
    "admitRecoveryRollback",
    "claimVerificationMonitor",
    "runOperation",
    "runVerificationRetry",
    "runVerificationContinuation",
    "observeRecoveredVerification",
    "runCleanup",
    "recoverBranchDelete",
    "recoverCleanup"
  ] as const) {
    if (typeof ports[name] !== "function") {
      throw new Error(`Missing setup execution dependency: ${name}`);
    }
  }
  for (const name of [
    "schedule",
    "hasTask",
    "scheduleReconciliation",
    "claimAutomaticRollback"
  ] as const) {
    if (typeof ports.scope?.[name] !== "function") {
      throw new Error(`Missing setup execution dependency: scope.${name}`);
    }
  }

  async function persistTaskState(operationId: string): Promise<void> {
    try {
      await ports.persist();
    } catch (error) {
      ports.report({
        scope: "setup-task-persistence",
        operationId,
        message: errorMessage(error)
      });
    }
  }

  function schedule(
    operationId: string,
    task: () => Promise<void>,
    cancelled?: () => void
  ): boolean {
    if (ports.isShuttingDown(operationId)) return false;
    let reconciliationNeeded = false;
    const op = ports.getOperation(operationId);
    const isCurrent = () =>
      op != null && ports.getOperation(operationId) === op;
    if (op) setExecutionActive(op, true);
    ports.scope.schedule(operationId, {
      run: task,
      cancelled,
      failed: async (error) => {
        if (!isCurrent()) return;
        const current = ports.getOperation(operationId);
        if (isSetupExecutionInterrupted(error)) return;
        if (ports.isShuttingDown(operationId)) {
          ports.report({
            scope: "setup-task-shutdown",
            operationId,
            message: errorMessage(error)
          });
          return;
        }
        if (current && reopenProviderReconciliation(current)) {
          if (
            !current.steps.some(
              (step) =>
                step.label ===
                "⏳ A provider step's outcome could not be confirmed. Radius is reconciling it without repeating the mutation."
            )
          ) {
            addLegacyStep(
              current,
              "⏳ A provider step's outcome could not be confirmed. Radius is reconciling it without repeating the mutation."
            );
          }
          reconciliationNeeded = true;
          await persistTaskState(operationId);
          return;
        }
        if (current && !current.endedAt) {
          finish(current, "failed", {
            failure: {
              code: "server-owned-task-failed",
              stage: current.currentStage,
              stepSeq: null,
              message: errorMessage(error),
              classification: "unknown",
              evidence: error instanceof Error ? error.stack || null : null
            }
          });
          await persistTaskState(operationId);
        }
      },
      settling: () => {
        if (!isCurrent()) return;
        const current = op;
        if (current && !current.endedAt) setExecutionActive(current, false);
      },
      settled: () => {
        if (!isCurrent() || ports.isShuttingDown(operationId)) return;
        const current = op;
        if (
          current?.endedAt &&
          current.providerRecovery?.state === "rollback_pending" &&
          !providerRecoveryManualGuidance(current)
        ) {
          scheduleAutomaticRecoveryRollback(operationId);
        } else if (
          reconciliationNeeded &&
          current &&
          !current.endedAt &&
          unresolvedProviderMutations(current).length > 0
        ) {
          scheduleProviderReconciliation(operationId);
        }
      }
    });
    return true;
  }

  function scheduleProviderReconciliation(operationId: string): void {
    ports.scope.scheduleReconciliation(operationId, () => {
      if (ports.isShuttingDown(operationId)) return;
      const operation = ports.getOperation(operationId);
      if (
        !operation ||
        operation.endedAt ||
        unresolvedProviderMutations(operation).length === 0
      ) {
        return;
      }
      scheduleRecoveredProviderMutation(operation);
    });
  }

  function scheduleAutomaticRecoveryRollback(operationId: string): void {
    const release = ports.scope.claimAutomaticRollback(operationId);
    if (!release) return;
    const operation = ports.getOperation(operationId);
    const repo = operation?.repo;
    const environment = operation?.environment;
    ports.deferRecovery(() => {
      if (ports.isShuttingDown(operationId)) {
        release();
        return;
      }
      void ports
        .admitRecoveryRollback(
          operationId,
          () =>
            operation != null &&
            ports.getOperation(operationId) === operation &&
            operation.operationId === operationId &&
            operation.repo === repo &&
            operation.environment === environment
        )
        .catch((error: unknown) => {
          ports.report({
            scope: "provider-recovery-auto-rollback",
            operationId,
            message: errorMessage(error)
          });
        })
        .finally(release);
    });
  }

  function scheduleRecoveredProviderMutation(
    operation: SetupExecutionOperation
  ): void {
    const next = planRecoveredSchedule(operation);
    const operationId = operation.operationId;
    if (next.kind === "branch_delete") {
      schedule(operationId, () => ports.recoverBranchDelete(operationId));
    } else if (next.kind === "cleanup") {
      schedule(operationId, () => ports.recoverCleanup(operationId));
    } else if (next.kind === "verification_retry") {
      schedule(operationId, () =>
        ports.runVerificationRetry(operationId, next.commandId)
      );
    } else {
      scheduleEnvironmentOperation(operation);
    }
  }

  function recoverOperation(operation: SetupExecutionOperation): void {
    const operationId = operation.operationId;
    if (
      ports.deferAdmissionRecovery(operationId, () => {
        const current = ports.getOperation(operationId);
        if (current) recoverOperation(current);
      })
    )
      return;
    if (
      ports.isShuttingDown(operation.operationId) ||
      operation.kind === "delete" ||
      ports.scope.hasTask(operation.operationId)
    )
      return;
    if (
      operation.endedAt &&
      operation.providerRecovery?.state === "rollback_pending" &&
      !providerRecoveryManualGuidance(operation)
    ) {
      scheduleAutomaticRecoveryRollback(operation.operationId);
      return;
    }
    if (
      operation.recoveryState === "provider_reconciliation_pending" &&
      !operation.endedAt
    ) {
      scheduleRecoveredProviderMutation(operation);
      return;
    }
    if (
      (operation.recoveryState !== "verification_pending" &&
        operation.recoveryState !== "verification_acquisition_pending") ||
      operation.currentStage !== STAGE_VERIFY ||
      operation.endedAt
    ) {
      return;
    }
    const release = ports.claimVerificationMonitor(operation.operationId);
    if (!release) return;
    schedule(
      operation.operationId,
      async () => {
        try {
          if (operation.recoveryState === "verification_acquisition_pending") {
            await ports.runVerificationRetry(
              operation.operationId,
              String(operation.verification?.retryCommandId || "")
            );
          } else {
            await ports.observeRecoveredVerification(operation);
          }
        } finally {
          release();
        }
      },
      release
    );
  }

  function scheduleEnvironmentOperation(operation: {
    operationId: string;
  }): boolean {
    return schedule(operation.operationId, () =>
      ports.runOperation(operation.operationId)
    );
  }

  function scheduleCommandTask(
    kind: SetupExecutionCommand,
    operation: { operationId: string },
    commandId: string
  ): boolean {
    return schedule(operation.operationId, () =>
      kind === "verification_monitor" ?
        ports.runVerificationContinuation(operation.operationId, commandId)
      : kind === "verification_retry" ?
        ports.runVerificationRetry(operation.operationId, commandId)
      : ports.runCleanup(kind, operation.operationId, commandId)
    );
  }

  return {
    recoverOperation,
    scheduleEnvironmentOperation,
    scheduleCommandTask
  };
}
