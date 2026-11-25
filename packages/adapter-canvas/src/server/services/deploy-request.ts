import type {
  DeploymentInvocation,
  DeploymentRuntime
} from "@radius-project/adapter-shared";
import {
  APP_ORIGIN_REPO_PATH,
  parseAppOrigin,
  stagesBeforeDeploy,
  type DeploymentState,
  type DeploymentStartInput,
  type DeploymentTarget
} from "@radius-project/core";
import type { CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";
import type { PlannedGraphRecoveryService } from "./deploy-planned-graph.js";
import type { DeployModelSource } from "./deploy-model-source.js";
import { hashAppBicep } from "../../app-bicep-hash.js";
import type { RadiusSkillHandoff } from "../../skill.js";
import {
  deployReadinessHandoffMessage,
  type HandoffMessage
} from "../../runtime/hooks.js";

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
  // Starts a modeling skill, and sends its handoff to Copilot. Used when the
  // model must pass more stages before it can deploy.
  skillHandoff: RadiusSkillHandoff;
  sendHandoff(message: HandoffMessage): Promise<void>;
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

const APP_MODEL_PATH = ".radius/app.bicep";

function modelNotReadyMessage(
  stages: ReadonlyArray<"plan" | "complete">,
  provider: string
): string {
  const work =
    stages.includes("plan") ?
      `planning it for ${provider} with the radius-app-plan skill and completing it with the radius-app-complete skill`
    : "completing it with the radius-app-complete skill";
  return `The application model is not ready to deploy, so nothing was deployed. Copilot is ${work}. Select Deploy again when it finishes.`;
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
    "readModelForSelection",
    "skillHandoff",
    "sendHandoff"
  ]);
  if (typeof dependencies.runtime?.start !== "function")
    throw new Error("createDeployRequestService requires runtime.");
  if (typeof dependencies.plannedGraph?.recover !== "function")
    throw new Error(
      "createDeployRequestService requires plannedGraph.recover."
    );

  // The modeling skills write a model in stages, and only a model that passed
  // Stage 3 for the deploy's provider is ready to deploy. A model that a stage
  // recorded but that is not complete is not deployed: Copilot is asked to run
  // the stages it still needs, and the user deploys again afterwards. The check
  // acts only on an origin record that it can read and that matches the model,
  // so a hand-written or hand-edited model deploys as before. The runtime runs
  // it last, on the validated target and the model it selected.
  async function refuseUnfinishedModel(
    entry: DeployRequestInstanceEntry,
    { repo, branch, provider, appFile }: Readonly<DeploymentTarget>
  ): Promise<{ status: 409 | 503; error: string } | undefined> {
    if (appFile !== APP_MODEL_PATH) return undefined;
    const origin = await dependencies.readModelForSelection(
      entry,
      repo,
      branch,
      APP_ORIGIN_REPO_PATH
    );
    if (origin.status !== "available") return undefined;
    const model = await dependencies.readModelForSelection(
      entry,
      repo,
      branch,
      APP_MODEL_PATH
    );
    if (model.status !== "available") return undefined;
    const stages = stagesBeforeDeploy(
      parseAppOrigin(origin.content),
      hashAppBicep(model.content),
      provider
    );
    if (stages.length === 0) return undefined;
    try {
      await dependencies.sendHandoff(
        deployReadinessHandoffMessage({
          repo,
          branch,
          provider,
          steps: stages.map((stage) => {
            const skill =
              stage === "plan" ? "radius-app-plan" : "radius-app-complete";
            return { skill, handoff: dependencies.skillHandoff(skill) };
          })
        })
      );
    } catch (error) {
      return {
        status: 503,
        error: `The application model is not ready to deploy, and Copilot could not be asked to complete it: ${dependencies.errorMessage(error)}`
      };
    }
    return { status: 409, error: modelNotReadyMessage(stages, provider) };
  }

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
          ...(!repair ?
            {
              checkTarget: (target: Readonly<DeploymentTarget>) =>
                refuseUnfinishedModel({ state: selectionState }, target)
            }
          : {}),
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
