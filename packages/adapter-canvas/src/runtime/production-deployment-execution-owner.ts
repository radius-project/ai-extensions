import { randomUUID } from "node:crypto";
import { createWorkflowArtifactReader } from "@radius-project/adapter-shared";
import { createWorkflowObservationScope } from "../server/services/workflow-observation-scope.js";
import { createDeploymentExecutionOwner } from "./deployment-execution-owner.js";

export function createProductionDeploymentExecutionOwner() {
  return createDeploymentExecutionOwner({
    now: () => Date.now(),
    newAttemptId: randomUUID,
    createObservation: (executor) =>
      createWorkflowObservationScope((options) =>
        createWorkflowArtifactReader(
          {
            ...options,
            identity: executor.login,
            allowApplicationFallback: options.allowApplicationFallback ?? true
          },
          (args, commandOptions) => executor.run(args, commandOptions)
        )
      ),
    reportError: (error) =>
      console.error("[radius deployment-owner] Callback failed:", error)
  });
}
