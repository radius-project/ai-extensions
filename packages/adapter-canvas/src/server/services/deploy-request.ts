import type {
  DeploymentInvocation,
  DeploymentRuntime
} from "@radius-project/adapter-shared";
import type {
  DeploymentState,
  DeploymentStartInput
} from "@radius-project/core";
import type { CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";
import type { PlannedGraphRecoveryService } from "./deploy-planned-graph.js";
import type { DeployModelSource } from "./deploy-model-source.js";

export interface DeployRequestInstanceEntry {
  state: CanvasState;
}

export interface DeployRequestDependencies {
  runtime: DeploymentRuntime;
  plannedGraph: PlannedGraphRecoveryService;
  readModelForSelection(
    entry: DeployRequestInstanceEntry,
    repo: string,
    branch: string,
    appFile: string
  ): Promise<DeployModelSource>;
  readInstanceEntry(instanceId: string): DeployRequestInstanceEntry | undefined;
  readDeploymentDefaults(
    state: CanvasState
  ): Pick<CanvasState, "envName" | "deployProvider">;
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
    "readDeploymentDefaults",
    "attach",
    "errorMessage",
    "reportError",
    "readModelForSelection"
  ]);
  if (typeof dependencies.runtime?.start !== "function")
    throw new Error("createDeployRequestService requires runtime.");
  if (typeof dependencies.plannedGraph?.recover !== "function")
    throw new Error(
      "createDeployRequestService requires plannedGraph.recover."
    );
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
        if (Object.hasOwn(data, "appFile") && !data.appFile)
          throw new Error(
            "appFile must be a non-empty repository-relative model path."
          );
        const repair = Boolean(data.attemptId);
        const defaults = dependencies.readDeploymentDefaults(state);
        const contextRepo = state.contextRepo || state.plannedRepo;
        const inheritsContext =
          !data.targetRepo ||
          optionalString(data.targetRepo)?.toLowerCase() ===
            contextRepo?.toLowerCase();
        const input: DeploymentStartInput = {
          repo:
            optionalString(data.targetRepo) ||
            (repair ? undefined : contextRepo),
          environment:
            optionalString(data.environment) ||
            (repair || !inheritsContext ? undefined : defaults.envName),
          branch: optionalString(data.branch),
          provider:
            optionalString(data.provider) ||
            (repair || !inheritsContext ? undefined : defaults.deployProvider),
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
          plannedGraph: {
            recover: ({ entry: owned, repo, branch, provider, appFile, log }) =>
              dependencies.plannedGraph.recover({
                entry: {
                  state: {
                    workspaceRepo: selectionState.workspaceRepo,
                    workspaceBranch: selectionState.workspaceBranch,
                    workspacePath: selectionState.workspacePath,
                    deployParams: owned.state.deployParams,
                    deployRepairing: owned.state.deployRepairing
                  }
                },
                repo,
                branch,
                provider,
                appFile,
                log
              })
          },
          ...(!repair && !input.appFile ?
            {
              modelSelection: {
                resolve: async (target) => {
                  const selected = await dependencies.readModelForSelection(
                    { state: selectionState },
                    target.repo,
                    target.branch,
                    ".radius/app.bicep"
                  );
                  if (selected.status === "unavailable")
                    throw new Error(selected.error);
                  return selected.status === "available" && selected.content ?
                      ".radius/app.bicep"
                    : "app.bicep";
                },
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
          resources:
            (
              !repair &&
              !input.appFile &&
              (!state.plannedRepo ||
                state.plannedRepo.toLowerCase() === input.repo?.toLowerCase())
            ) ?
              state.plannedResources || []
            : []
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
