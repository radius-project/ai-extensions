import {
  createDeploymentAbandonmentService as createSharedAbandonment,
  validAbandonmentTarget,
  type DeploymentAbandonmentDependencies as SharedDependencies,
  type DeploymentAbandonmentResult
} from "@radius-project/core/github-radius/deployments/deployment-abandonment";
import type { CanvasState } from "../../shared.js";

export type {
  DeploymentAbandonmentResult,
  DeploymentAbandonmentReservation
} from "@radius-project/core/github-radius/deployments/deployment-abandonment";

export interface DeploymentAbandonmentDependencies extends SharedDependencies {
  readInstanceState(instanceId: string): CanvasState | undefined;
}
export interface DeploymentAbandonmentService {
  abandon(input: {
    instanceId: string;
    payload: unknown;
  }): Promise<DeploymentAbandonmentResult>;
}

export function createDeploymentAbandonmentService(
  dependencies: DeploymentAbandonmentDependencies
): DeploymentAbandonmentService {
  if (typeof dependencies.readInstanceState !== "function")
    throw new Error(
      "createDeploymentAbandonmentService is missing required dependencies: readInstanceState"
    );
  const shared = createSharedAbandonment(dependencies);
  return {
    async abandon({ instanceId, payload }) {
      if (!validAbandonmentTarget(payload, dependencies.isValidRepoSlug)) {
        return {
          status: 400,
          body: {
            error:
              "A valid repo, environment, and application are required to stop tracking a deployment."
          }
        };
      }
      const state = dependencies.readInstanceState(instanceId);
      if (!state)
        return {
          status: 503,
          body: { error: "Canvas server state is unavailable." }
        };
      return shared.abandon({ state, payload });
    }
  };
}
