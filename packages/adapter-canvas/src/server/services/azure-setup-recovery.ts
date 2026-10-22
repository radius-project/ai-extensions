import type { AzureRecoveryPort } from "@radius-project/core";
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
  persist: () => Promise<void>
): AzureRecoveryPort {
  return {
    find: (kind, target) => providerMutationRecord(operation, kind, target),
    willWrite: (kind, target) =>
      providerMutationWillWrite(operation, kind, target),
    unresolved: () => unresolvedProviderMutations(operation),
    execute: (input) =>
      executeRecoverableMutation({ ...input, operation, persist })
  };
}
