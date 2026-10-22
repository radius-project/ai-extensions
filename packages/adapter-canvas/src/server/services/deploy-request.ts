import {
  createDeploymentController,
  type DeploymentControllerDependencies,
  type DeployRequestData,
  type DeployRequestInstanceEntry
} from "../../runtime/deployment-controller.js";
import type { DeploymentExecution } from "../../runtime/deployment-execution-owner.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

export type {
  DeploymentReservation,
  DeployRepairLoopResolution,
  DeploymentRow,
  DeployRequestData,
  DeployRequestInstanceEntry
} from "../../runtime/deployment-controller.js";

export interface DeployRequestDependencies extends DeploymentControllerDependencies {
  present(instanceId: string, execution: DeploymentExecution): void;
  readInstanceEntry(instanceId: string): DeployRequestInstanceEntry | undefined;
  triggerDeployRepairHandoff(
    entry: DeployRequestInstanceEntry,
    instanceId: string
  ): boolean;
  triggerDeployFailureNotice(
    entry: DeployRequestInstanceEntry,
    instanceId: string
  ): boolean;
}

export interface DeployRequestResult {
  status: number;
  body: unknown;
}

export interface DeployRequestService {
  deploy(input: {
    instanceId: string;
    body: string;
  }): Promise<DeployRequestResult>;
}

export function createDeployRequestService(
  dependencies: DeployRequestDependencies
): DeployRequestService {
  assertDeployDependencies("createDeployRequestService", dependencies, [
    "present",
    "readInstanceEntry",
    "triggerDeployRepairHandoff",
    "triggerDeployFailureNotice"
  ]);
  const controller = createDeploymentController(dependencies);
  return {
    async deploy({ instanceId, body }) {
      try {
        const data = JSON.parse(body) as DeployRequestData;
        if (data === null) throw new Error("Deploy input cannot be null.");
        const panel = dependencies.readInstanceEntry(instanceId);
        if (!panel) throw new Error("Canvas server state is unavailable.");
        const selection = () =>
          JSON.stringify([
            panel.state.plannedRepo,
            panel.state.contextRepo,
            panel.state.plannedBranch,
            panel.state.contextBranch,
            panel.state.graphBranch,
            panel.state.plannedEnvironment,
            panel.state.plannedProvider,
            panel.state.envName,
            panel.state.appFile,
            panel.state.deployAttempt?.id,
            panel.state.deployGeneration
          ]);
        const selected = selection();
        const result = await controller.start({
          data,
          source: panel.state,
          isCurrent: () =>
            dependencies.readInstanceEntry(instanceId) === panel &&
            selection() === selected,
          present: (execution) => dependencies.present(instanceId, execution),
          notifications: [
            (execution) =>
              dependencies.triggerDeployRepairHandoff(execution, instanceId),
            (execution) =>
              dependencies.triggerDeployFailureNotice(execution, instanceId)
          ]
        });
        if (result.kind === "refused")
          return {
            status:
              result.reason === "invalid" ? 400
              : result.reason === "unavailable" ? 503
              : 409,
            body: { error: result.message }
          };
        return {
          status: 200,
          body: {
            ok: true,
            ...(result.repairAttempt === undefined ?
              {}
            : {
                repairAttempt: result.repairAttempt,
                repairAttemptCap: result.repairAttemptCap
              })
          }
        };
      } catch (error) {
        return {
          status: 400,
          body: { error: dependencies.errorMessage(error) }
        };
      }
    }
  };
}
