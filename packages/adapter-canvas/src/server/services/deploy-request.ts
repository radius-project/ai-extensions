import {
  createDeployRequestService as createSharedRequest,
  assertDeployRequestPorts,
  type DeployRequestDependencies as SharedDependencies,
  type DeployRequestInstanceEntry,
  type DeployRequestResult
} from "@radius-project/core/github-radius/deployments/deploy-request";
import type { DeploymentState } from "@radius-project/core/github-radius/deployments/types";
import { redactGhCredentials } from "../../gh.js";

export type {
  DeployRequestData,
  DeployRequestInstanceEntry,
  DeployRepairLoopResolution,
  DeployRequestResult,
  DeploymentReservation,
  DeploymentRow
} from "@radius-project/core/github-radius/deployments/deploy-request";

export interface DeployRequestDependencies extends Omit<
  SharedDependencies,
  "onSettled" | "redactDiagnostics"
> {
  readInstanceEntry(instanceId: string): DeployRequestInstanceEntry | undefined;
  resolveDeploymentEnvironment(
    state: DeploymentState,
    requested: unknown
  ): string;
  triggerDeployRepairHandoff(
    entry: DeployRequestInstanceEntry,
    instanceId: string
  ): boolean;
  triggerDeployFailureNotice(
    entry: DeployRequestInstanceEntry,
    instanceId: string
  ): boolean;
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
  for (const name of [
    "readInstanceEntry",
    "resolveDeploymentEnvironment",
    "triggerDeployRepairHandoff",
    "triggerDeployFailureNotice"
  ] as const) {
    if (typeof dependencies[name] !== "function")
      throw new Error(
        `createDeployRequestService is missing required dependencies: ${name}`
      );
  }
  // Validate shared ports when constructing, before serving any requests.
  assertDeployRequestPorts({
    ...dependencies,
    redactDiagnostics: redactGhCredentials
  });
  return {
    async deploy({ instanceId, body }) {
      try {
        const data: unknown = JSON.parse(body);
        if (data === null)
          throw new Error(
            "Cannot read properties of null (reading 'attemptId')"
          );
        if (typeof data !== "object" || Array.isArray(data))
          throw new Error("A deployment request object is required.");
        const entry = dependencies.readInstanceEntry(instanceId);
        if (!entry) throw new Error("Canvas server state is unavailable.");
        const fields = Object.fromEntries(Object.entries(data));
        const repair = dependencies.resolveDeployRepairLoop(
          entry.state,
          fields.attemptId
        );
        if (repair.error) return { status: 409, body: { error: repair.error } };
        const text = (value: unknown): string =>
          typeof value === "string" ? value : "";
        const repo =
          text(fields.targetRepo) ||
          entry.state.plannedRepo ||
          entry.state.contextRepo ||
          "";
        const service = createSharedRequest({
          ...dependencies,
          redactDiagnostics: redactGhCredentials,
          onSettled(settled) {
            dependencies.triggerDeployRepairHandoff(settled, instanceId);
            dependencies.triggerDeployFailureNotice(settled, instanceId);
          }
        });
        return await service.deploy({
          state: entry.state,
          target: {
            repo,
            environment: dependencies.resolveDeploymentEnvironment(
              entry.state,
              fields.environment
            ),
            provider: text(fields.provider)
          },
          source: {
            repo,
            branch: text(fields.branch),
            appFile: text(fields.appFile)
          },
          attemptId: fields.attemptId
        });
      } catch (error) {
        return {
          status: 400,
          body: { error: dependencies.errorMessage(error) }
        };
      }
    }
  };
}
