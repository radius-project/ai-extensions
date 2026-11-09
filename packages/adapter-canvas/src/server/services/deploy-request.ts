import type {
  DeploymentInvocation,
  DeploymentRuntime
} from "@radius-project/adapter-shared";
import type {
  DeploymentState,
  DeploymentTarget,
  DeploymentStartInput
} from "@radius-project/core";
import type { CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

export interface DeployRequestInstanceEntry {
  state: CanvasState;
}

export interface DeployRequestDependencies {
  runtime: DeploymentRuntime;
  resolveAppFile(
    state: CanvasState,
    repo: string,
    branch: string
  ): Promise<string | null>;
  readInstanceEntry(instanceId: string): DeployRequestInstanceEntry | undefined;
  attach(
    instanceId: string,
    state: CanvasState,
    invocation: DeploymentInvocation<DeploymentState>
  ): void;
  errorMessage(error: unknown): string;
  reportError(error: unknown): void;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** HTTP parsing and view subscription only; the shared runtime admits work. */
export function createDeployRequestService(
  dependencies: DeployRequestDependencies
): DeployRequestService {
  assertDeployDependencies("createDeployRequestService", dependencies, [
    "readInstanceEntry",
    "attach",
    "errorMessage",
    "reportError",
    "resolveAppFile"
  ]);
  if (typeof dependencies.runtime?.start !== "function")
    throw new Error("createDeployRequestService requires runtime.");
  return {
    async deploy({ instanceId, body }) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          throw new Error("Deployment input must be a JSON object.");
        const data = Object.fromEntries(Object.entries(parsed));
        const entry = dependencies.readInstanceEntry(instanceId);
        if (!entry) throw new Error("Canvas server state is unavailable.");
        const state = entry.state;
        for (const key of [
          "targetRepo",
          "environment",
          "branch",
          "provider",
          "appFile",
          "attemptId"
        ])
          if (data[key] !== undefined && typeof data[key] !== "string")
            throw new Error(`${key} must be a string.`);
        const repair = Boolean(data.attemptId);
        const input: DeploymentStartInput = {
          repo:
            optionalString(data.targetRepo) ||
            (repair ? undefined : state.plannedRepo || state.contextRepo),
          environment:
            optionalString(data.environment) ||
            (repair ? undefined : state.envName),
          branch: optionalString(data.branch),
          provider:
            optionalString(data.provider) ||
            (repair ? undefined : state.deployProvider),
          appFile: optionalString(data.appFile),
          attemptId: optionalString(data.attemptId)
        };
        const selectionState = { ...state };
        const selectionKeys = [
          "contextRepo",
          "contextBranch",
          "plannedRepo",
          "plannedBranch",
          "workspaceRepo",
          "workspaceBranch",
          "workspacePath",
          "envName"
        ] as const;
        const result = await dependencies.runtime.start(input, {
          instanceId,
          ...(!repair && !input.appFile ?
            {
              modelSelection: {
                resolve: (target: Readonly<DeploymentTarget>) =>
                  dependencies.resolveAppFile(
                    selectionState,
                    target.repo,
                    target.branch
                  ),
                isCurrent: () =>
                  dependencies.readInstanceEntry(instanceId) === entry &&
                  selectionKeys.every(
                    (key) => state[key] === selectionState[key]
                  )
              }
            }
          : {}),
          workspace:
            state.workspaceRepo && state.workspaceBranch ?
              {
                repo: state.workspaceRepo,
                branch: state.workspaceBranch,
                workspacePath: state.workspacePath
              }
            : undefined,
          resources: state.plannedResources || []
        });
        if (!result.ok)
          return { status: result.status, body: { error: result.error } };
        // Closing/resetting the panel during admission cannot cancel admitted work.
        try {
          if (dependencies.readInstanceEntry(instanceId) === entry)
            dependencies.attach(instanceId, state, result.invocation);
        } catch (error) {
          dependencies.reportError(error);
        }
        return {
          status: 200,
          body: {
            ok: true,
            ...(result.repairAttempt !== undefined ?
              {
                repairAttempt: result.repairAttempt,
                repairAttemptCap: result.repairAttemptCap
              }
            : {})
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
