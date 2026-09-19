export * from "@radius-project/core/github-radius/environments/recovered-branch-delete";
import {
  pendingBranchDelete as pendingSharedDelete,
  reconcileRecoveredBranchDelete as reconcileSharedDelete
} from "@radius-project/core/github-radius/environments/recovered-branch-delete";
import * as operationDomain from "../../operations.js";

export function pendingBranchDelete(operation: unknown) {
  return pendingSharedDelete(operation, operationDomain);
}
export function reconcileRecoveredBranchDelete(
  input: Omit<Parameters<typeof reconcileSharedDelete>[0], "operationDomain">
) {
  return reconcileSharedDelete({ ...input, operationDomain });
}
