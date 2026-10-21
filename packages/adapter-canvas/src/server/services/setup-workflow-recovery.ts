import type { SetupWorkflowRecoveryPort } from "@radius-project/core";
import {
  providerMutationId,
  providerMutationRecord,
  providerMutationsByKind,
  settleProviderMutation,
  unresolvedProviderMutations
} from "../../operations.js";
import {
  executeRecoverableMutation,
  providerMutationWillWrite
} from "./provider-mutation-recovery.js";

export function createSetupWorkflowRecoveryPort(
  operation: object & {
    operationId: string;
    providerRecovery?: { state?: string };
  },
  persist: () => Promise<void>
): SetupWorkflowRecoveryPort {
  return {
    operationId: operation.operationId,
    find: (kind, target) => providerMutationRecord(operation, kind, target),
    byKind: (kind) => providerMutationsByKind(operation, kind),
    unresolved: () => unresolvedProviderMutations(operation),
    willWrite: (kind, target) =>
      providerMutationWillWrite(operation, kind, target),
    execute: (input) =>
      executeRecoverableMutation({ ...input, operation, persist }),
    rollbackPending: () =>
      operation.providerRecovery?.state === "rollback_pending",
    markRollbackPending: () => {
      if (operation.providerRecovery)
        operation.providerRecovery.state = "rollback_pending";
    },
    settleManual: (kind, target, guidance) => {
      settleProviderMutation(
        operation,
        providerMutationId(operation.operationId, kind, target),
        "manual_required",
        guidance
      );
    },
    persist
  };
}
