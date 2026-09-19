export * from "@radius-project/adapter-shared/github-radius/environments/create-environment-workflow-committer";
import {
  createWorkflowFileCommitter as createSharedCommitter,
  recordedSetupBranchCreate as readSharedBranch,
  type WorkflowFileCommitterPorts as SharedPorts,
  type WorkflowFileCommitterTarget
} from "@radius-project/adapter-shared/github-radius/environments/create-environment-workflow-committer";
import * as operationDomain from "../../operations.js";

export type WorkflowFileCommitterPorts = Omit<SharedPorts, "operationDomain">;
export function createWorkflowFileCommitter(
  ports: WorkflowFileCommitterPorts,
  target: WorkflowFileCommitterTarget
) {
  return createSharedCommitter({ ...ports, operationDomain }, target);
}
export function recordedSetupBranchCreate(operation: unknown, repo: string) {
  return readSharedBranch(operation, repo, operationDomain);
}
