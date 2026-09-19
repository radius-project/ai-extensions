export * from "@radius-project/adapter-shared/github-radius/environments/create-environment-gh-runner";
import {
  createWorkflowScopeGhRunner as createSharedRunner,
  type WorkflowScopeGhRunnerPorts as SharedPorts,
  type WorkflowScopeGhRunnerTarget
} from "@radius-project/adapter-shared/github-radius/environments/create-environment-gh-runner";
import type { SelectedGhExecutor } from "../../gh.js";
import * as operationDomain from "../../operations.js";

export type WorkflowScopeGhRunnerPorts = Omit<SharedPorts, "operationDomain">;
export function createWorkflowScopeGhRunner(
  ports: WorkflowScopeGhRunnerPorts,
  target: WorkflowScopeGhRunnerTarget,
  executor?: SelectedGhExecutor
) {
  return createSharedRunner({ ...ports, operationDomain }, target, executor);
}
