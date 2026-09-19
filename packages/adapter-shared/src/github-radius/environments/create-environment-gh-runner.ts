import { createHash } from "node:crypto";
import {
  createWorkflowScopeGhRunner as createSharedRunner,
  type WorkflowScopeGhRunnerPorts as SharedPorts,
  type WorkflowScopeGhRunnerTarget
} from "@radius-project/core/github-radius/environments/create-environment-gh-runner";
import type { SelectedGhExecutor } from "@radius-project/core/github-radius/environments/execution-ports";

export * from "@radius-project/core/github-radius/environments/create-environment-gh-runner";
export type WorkflowScopeGhRunnerPorts = Omit<SharedPorts, "hashString">;

export function createWorkflowScopeGhRunner(
  ports: WorkflowScopeGhRunnerPorts,
  target: WorkflowScopeGhRunnerTarget,
  selectedExecutor?: SelectedGhExecutor
) {
  return createSharedRunner(
    {
      ...ports,
      hashString: (value) => createHash("sha256").update(value).digest("hex")
    },
    target,
    selectedExecutor
  );
}
