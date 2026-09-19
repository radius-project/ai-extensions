import {
  runEnvironmentOperationWorkflow as runSharedEnvironmentOperationWorkflow,
  type EnvironmentOperationWorkflowDependencies as SharedDependencies,
  type EnvironmentOperationRecord
} from "@radius-project/core/github-radius/environments/environment-operation";
import type { SelectedGhExecutor } from "../../gh.js";
import * as operationDomain from "../../operations.js";

export * from "@radius-project/core/github-radius/environments/environment-operation";

export type EnvironmentOperationWorkflowDependencies = Omit<
  SharedDependencies,
  "operationDomain"
>;

export function runEnvironmentOperationWorkflow(
  operation: EnvironmentOperationRecord,
  executor: SelectedGhExecutor,
  dependencies: EnvironmentOperationWorkflowDependencies
): Promise<{ shouldMonitor: boolean }> {
  return runSharedEnvironmentOperationWorkflow(operation, executor, {
    ...dependencies,
    operationDomain
  });
}
