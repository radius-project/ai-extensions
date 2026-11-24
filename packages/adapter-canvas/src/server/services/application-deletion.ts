import {
  deleteApplication,
  type ApplicationDeletionResult
} from "@radius-project/core";
import { dispatchApplicationDelete } from "@radius-project/adapter-shared";
import type { DeploymentsDependencies } from "../routes/deployments.js";
import { redactGhCredentials } from "../../gh.js";

export type ApplicationDeletionDependencies = Pick<
  DeploymentsDependencies,
  | "id"
  | "ghCommandPresentation"
  | "isValidRepoSlug"
  | "readInstanceEntry"
  | "activeDeploymentMutation"
  | "localDeploymentBlocksMutation"
  | "reserveDeploymentMutation"
  | "releaseDeploymentMutation"
  | "captureDeletedDeployment"
  | "resolveEnvDeployment"
  | "deploymentStatusBlocksMutation"
  | "probeDeleteConflict"
  | "deployListCache"
  | "deployListTtlMs"
  | "ensureWorkflowsCurrent"
  | "deleteApplicationWorkflowFiles"
  | "findWorkflowRun"
  | "runGh"
  | "readProcessEnv"
  | "setTimer"
  | "logError"
>;

export async function requestApplicationDeletion(
  payload: unknown,
  dependencies: ApplicationDeletionDependencies,
  instanceId?: string
): Promise<ApplicationDeletionResult> {
  if (payload === null)
    return {
      status: 400,
      body: { error: "Cannot read properties of null (reading 'repo')" }
    };
  const data: Record<string, unknown> =
    payload && typeof payload === "object" ?
      Object.fromEntries(Object.entries(payload))
    : {};
  const { repo, environment, application, deploymentId, runUrl } = data;
  if (deploymentId !== undefined && typeof deploymentId !== "string")
    return { status: 400, body: { error: "deploymentId must be a string." } };
  if (runUrl !== undefined && typeof runUrl !== "string")
    return { status: 400, body: { error: "runUrl must be a string." } };
  if (
    typeof repo !== "string" ||
    !repo ||
    typeof environment !== "string" ||
    !environment ||
    typeof application !== "string" ||
    !application ||
    !dependencies.isValidRepoSlug(repo)
  )
    return {
      status: 400,
      body: {
        error: "A valid repo, environment, and application are required."
      }
    };
  const entry =
    instanceId === undefined ?
      { state: {} }
    : dependencies.readInstanceEntry(instanceId);
  if (!entry)
    return {
      status: 503,
      body: { error: "Canvas server state is unavailable." }
    };
  const { state } = entry;
  return deleteApplication(
    {
      repo,
      environment,
      application,
      deploymentId,
      runUrl,
      force: data.force === true
    },
    {
      reserve(target) {
        const reserved = dependencies.activeDeploymentMutation(state);
        if (dependencies.localDeploymentBlocksMutation(state) || reserved) {
          const operation = reserved?.kind || "deploy";
          const conflictRepo =
            reserved?.repo ||
            state.deployAttempt?.targetRepo ||
            state.deployingRepo ||
            repo;
          const conflictEnvironment =
            reserved?.environment ||
            state.deployAttempt?.environment ||
            state.envName ||
            environment;
          return {
            error: `A ${operation} operation for ${conflictRepo} in environment ${conflictEnvironment} is already in progress. Wait for it to finish before starting another operation.`
          };
        }
        const lease = dependencies.reserveDeploymentMutation(state, {
          repo: target.repo,
          environment: target.environment,
          kind: "delete"
        });
        if (!lease) {
          const conflict = dependencies.activeDeploymentMutation(state);
          return {
            error:
              conflict ?
                `A ${conflict.kind} operation for ${conflict.repo} in environment ${conflict.environment} is already starting.`
              : "Another deployment operation is already starting."
          };
        }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          dependencies.releaseDeploymentMutation(state, lease);
        };
        return {
          release,
          retain() {
            dependencies
              .setTimer(release, dependencies.deployListTtlMs * 2)
              .unref?.();
          }
        };
      },
      captureAcceptedDeletion: ({ repo, environment, application }) =>
        dependencies.captureDeletedDeployment(state, {
          repo,
          environment,
          application
        }),
      resolveDeployment: ({ repo, environment, application }) =>
        dependencies.resolveEnvDeployment(repo, environment, application),
      statusBlocksMutation: dependencies.deploymentStatusBlocksMutation,
      probeConflict: (target, selection) =>
        dependencies.probeDeleteConflict(
          {
            repo: target.repo,
            environment: target.environment,
            application: target.application
          },
          instanceId,
          selection
        ),
      dispatch: (request) =>
        dispatchApplicationDelete(request, {
          id: dependencies.id,
          now: Date.now,
          ghCommandPresentation: dependencies.ghCommandPresentation,
          ensureWorkflowsCurrent: dependencies.ensureWorkflowsCurrent,
          deleteApplicationWorkflowFiles:
            dependencies.deleteApplicationWorkflowFiles,
          findWorkflowRun: dependencies.findWorkflowRun,
          runGh: dependencies.runGh,
          readProcessEnv: dependencies.readProcessEnv,
          sleep: (ms) =>
            new Promise((resolve) => {
              dependencies.setTimer(() => resolve(), ms);
            })
        }),
      invalidateListing: (repo) => dependencies.deployListCache.delete(repo),
      reportDiscoveryError: (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        dependencies.logError(
          "[radius delete] Dispatch accepted; run URL unavailable: " +
            redactGhCredentials(detail, dependencies.readProcessEnv()).slice(
              0,
              2000
            )
        );
      }
    }
  );
}
