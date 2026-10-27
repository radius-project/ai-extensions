import {
  assertSetupExecutionActive,
  type AzureRecoveryPort
} from "@radius-project/core";
import {
  providerMutationRecord,
  unresolvedProviderMutations
} from "../../operations.js";
import {
  executeRecoverableMutation,
  providerMutationWillWrite
} from "./provider-mutation-recovery.js";

export function createAzureRecoveryPort(
  operation: object & { operationId: string },
  persist: () => Promise<void>,
  isStopped: () => boolean
): AzureRecoveryPort {
  return {
    find: (kind, target) => providerMutationRecord(operation, kind, target),
    willWrite: (kind, target) =>
      providerMutationWillWrite(operation, kind, target),
    unresolved: () => unresolvedProviderMutations(operation),
    execute: (input) =>
      executeRecoverableMutation({
        ...input,
        operation,
        persist,
        assertActive: () => {
          assertSetupExecutionActive(isStopped);
          input.assertActive?.();
        }
      })
  };
}
