import type { CanvasState } from "../../shared.js";
import { cleanupMarker } from "@radius-project/adapter-shared";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";
import { matchesDeployedApplicationState } from "./deployed-view-state.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  type DeploymentRow
} from "./deployment-resolver.js";
import { deploymentRunId, redactCredentials } from "@radius-project/core";

export interface DeploymentAbandonmentReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete" | "abandon";
  expiresAt: number;
  attemptId?: string;
}

export interface DeploymentAbandonmentDependencies {
  ghCommandPresentation?: GhCommandPresentation;
  isValidRepoSlug(value: unknown): boolean;
  readInstanceState(instanceId: string): CanvasState | undefined;
  activeDeploymentMutation(
    state: CanvasState
  ): DeploymentAbandonmentReservation | undefined;
  localDeploymentBlocksMutation(state: CanvasState): boolean;
  reserveDeploymentMutation(
    state: CanvasState,
    reservation: {
      repo: string;
      environment: string;
      kind: "abandon";
    }
  ): DeploymentAbandonmentReservation | null;
  releaseDeploymentMutation(
    state: CanvasState,
    reservation: DeploymentAbandonmentReservation
  ): void;
  deploymentStatusBlocksMutation(status: unknown): boolean;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    application: string
  ): Promise<DeploymentRow | null>;
  ghOrThrow(args: string[]): Promise<string>;
  invalidateDeployListCache(repo: string): void;
}

export type DeploymentAbandonmentResult =
  | { status: 200; body: { outcome: "abandoned" } }
  | { status: 400 | 409 | 502 | 503; body: { error: string } };

export interface DeploymentAbandonmentService {
  abandon(input: {
    instanceId: string;
    payload: unknown;
  }): Promise<DeploymentAbandonmentResult>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeploymentAbandonmentDependencies)[] =
  [
    "isValidRepoSlug",
    "readInstanceState",
    "activeDeploymentMutation",
    "localDeploymentBlocksMutation",
    "reserveDeploymentMutation",
    "releaseDeploymentMutation",
    "deploymentStatusBlocksMutation",
    "resolveEnvDeployment",
    "ghOrThrow",
    "invalidateDeployListCache"
  ];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function operationDescription(
  reservation: DeploymentAbandonmentReservation
): string {
  const operation =
    reservation.kind === "abandon" ? "An abandonment" : `A ${reservation.kind}`;
  return `${operation} operation for ${reservation.repo} in environment ${reservation.environment}`;
}

function captureMatchingDeployAttempt(
  state: CanvasState,
  repo: string,
  environment: string,
  application: string,
  runId?: number
): () => void {
  const captured = { ...state };
  const attempt = captured.deployAttempt;
  const attemptIdentity = {
    id: attempt?.id,
    repo: attempt?.targetRepo,
    environment: attempt?.environment
  };
  const matches =
    (runId === undefined ||
      deploymentRunId(repo, captured.deployRunUrl || "") === runId) &&
    attempt?.targetRepo?.toLowerCase() === repo.toLowerCase() &&
    matchesDeployedApplicationState(
      {
        deployEnvName: attempt.environment,
        deployAppName: captured.deployAppName
      },
      { environment, application }
    );
  const identityKeys = [
    "deployAttempt",
    "deployGeneration",
    "deployAppName",
    "deployRunId",
    "deployRunUrl",
    "deployStatus",
    "deployedGraph",
    "deployingResources"
  ] as const;
  return () => {
    if (
      !matches ||
      identityKeys.some((key) => state[key] !== captured[key]) ||
      state.deployAttempt?.id !== attemptIdentity.id ||
      state.deployAttempt?.targetRepo !== attemptIdentity.repo ||
      state.deployAttempt?.environment !== attemptIdentity.environment
    )
      return;
    delete state.deployAttempt;
    delete state.deployResult;
    delete state.deployStatus;
    delete state.deployError;
    delete state.deployErrorKind;
    delete state.deployErrorBranch;
    delete state.deployStartedAt;
    delete state.deployFinishedAt;
    delete state.deployLogs;
    delete state.deployLogBase;
    delete state.deployRunId;
    delete state.deployRunUrl;
    delete state.deployRepairing;
    delete state.deployHandoffState;
    delete state.deployHandoffAttempts;
    delete state.deployNoticeState;
    delete state.deployNoticeAttempts;
    delete state.deployRepairAttempts;
  };
}

function isGitHubScopeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /HTTP 403|forbidden|resource not accessible|scope/i.test(message);
}

export function createDeploymentAbandonmentService(
  dependencies: DeploymentAbandonmentDependencies
): DeploymentAbandonmentService {
  assertDeployDependencies(
    "createDeploymentAbandonmentService",
    dependencies,
    REQUIRED_DEPENDENCIES
  );

  return {
    async abandon({ instanceId, payload }) {
      const data = record(payload);
      const repo = typeof data.repo === "string" ? data.repo.trim() : "";
      const environment =
        typeof data.environment === "string" ? data.environment.trim() : "";
      const application =
        typeof data.application === "string" ? data.application.trim() : "";
      const runScoped = data.revision !== undefined;
      if (
        !repo ||
        !environment ||
        (!application && !runScoped) ||
        !dependencies.isValidRepoSlug(repo)
      ) {
        return {
          status: 400,
          body: {
            error:
              "A valid repo, environment, and application are required to stop tracking a deployment."
          }
        };
      }

      const state = dependencies.readInstanceState(instanceId);
      if (!state) {
        return {
          status: 503,
          body: { error: "Canvas server state is unavailable." }
        };
      }
      const active = dependencies.activeDeploymentMutation(state);
      if (dependencies.localDeploymentBlocksMutation(state) || active) {
        const conflict =
          active ?
            operationDescription(active)
          : `A deploy operation for ${repo} in environment ${environment}`;
        return {
          status: 409,
          body: {
            error: `${conflict} is already in progress. Wait for it to finish before stopping deployment tracking.`
          }
        };
      }

      const reservation = dependencies.reserveDeploymentMutation(state, {
        repo,
        environment,
        kind: "abandon"
      });
      if (!reservation) {
        const conflict = dependencies.activeDeploymentMutation(state);
        return {
          status: 409,
          body: {
            error:
              conflict ?
                `${operationDescription(conflict)} is already starting.`
              : "Another deployment operation is already starting."
          }
        };
      }

      const retireCapturedAttempt = captureMatchingDeployAttempt(
        state,
        repo,
        environment,
        application,
        typeof data.runId === "number" ? data.runId : undefined
      );
      try {
        let current: DeploymentRow | null;
        try {
          current = await dependencies.resolveEnvDeployment(
            repo,
            environment,
            application
          );
        } catch {
          return {
            status: 503,
            body: {
              error:
                "Could not verify the current deployment state. Check your GitHub connection and try again."
            }
          };
        }
        if (!current || !current.deploymentId) {
          return {
            status: 409,
            body: {
              error: "No failed teardown is available to stop tracking."
            }
          };
        }
        if (runScoped) {
          const recovery = current.recovery;
          if (
            !recovery ||
            !recovery.canMarkCleanupComplete ||
            data.revision !== recovery.revision ||
            data.runId !== recovery.runId ||
            data.runAttempt !== recovery.runAttempt ||
            data.deploymentId !== current.deploymentId ||
            data.runUrl !== current.runUrl
          ) {
            return {
              status: 409,
              body: {
                error:
                  "The recovery target changed or cannot be verified. Refresh the listing. Tracking was not changed."
              }
            };
          }
          if (
            typeof data.confirmation !== "string" ||
            data.confirmation.trim() !== recovery.confirmation ||
            application !== current.app
          ) {
            return {
              status: 400,
              body: {
                error:
                  "Type the exact cleanup confirmation for this recorded run. Canvas does not verify or perform external cleanup."
              }
            };
          }
          const marker = cleanupMarker(recovery);
          try {
            for (const id of recovery.deploymentIds) {
              const description = await dependencies.ghOrThrow([
                "api",
                `/repos/${repo}/deployments/${encodeURIComponent(id)}/statuses?per_page=1`,
                "--jq",
                '.[0].description // ""'
              ]);
              if (description === marker) continue;
              await dependencies.ghOrThrow([
                "api",
                "--method",
                "POST",
                `/repos/${repo}/deployments/${encodeURIComponent(id)}/statuses`,
                "-f",
                "state=inactive",
                "-F",
                "auto_inactive=false",
                "-f",
                `description=${marker}`,
                "-f",
                `log_url=${current.runUrl}`
              ]);
            }
            const next = await dependencies.resolveEnvDeployment(
              repo,
              environment,
              application
            );
            dependencies.invalidateDeployListCache(repo);
            if (next?.recovery?.runId === recovery.runId)
              return {
                status: 502,
                body: {
                  error:
                    "The cleanup markers could not be verified for every record of this run. Tracking remains effective; refresh and retry."
                }
              };
          } catch (error) {
            dependencies.invalidateDeployListCache(repo);
            return {
              status: 502,
              body: {
                error: redactCredentials(
                  `Could not verify all cleanup markers on GitHub. Tracking may remain effective; refresh and retry. Cloud resources were not changed. ${error instanceof Error ? error.message : String(error)}`
                )
              }
            };
          }
          retireCapturedAttempt();
          return { status: 200, body: { outcome: "abandoned" } };
        }
        if (current.recovery)
          return {
            status: 409,
            body: {
              error:
                "Refresh the deployment listing and confirm cleanup for the exact recorded run."
            }
          };
        const identityRefusal = deploymentIdentityRefusal(current, application);
        if (identityRefusal)
          return {
            status: identityRefusal.status,
            body: { error: identityRefusal.error }
          };
        if (dependencies.deploymentStatusBlocksMutation(current.status)) {
          return {
            status: 409,
            body: {
              error:
                current.status === "deleting" ?
                  "This deployment is being deleted and cannot be removed from tracking."
                : "This application is still being deployed. Wait for it to finish before stopping deployment tracking."
            }
          };
        }
        if (current.status !== "delete-failed") {
          return {
            status: 409,
            body: {
              error: "Only a failed teardown can be removed from tracking."
            }
          };
        }

        const args = [
          "api",
          "--method",
          "POST",
          `/repos/${repo}/deployments/${encodeURIComponent(
            current.deploymentId
          )}/statuses`,
          "-f",
          "state=inactive",
          "-f",
          `description=${ABANDONED_DEPLOYMENT_DESCRIPTION}`
        ];
        if (current.runUrl) args.push("-f", `log_url=${current.runUrl}`);
        try {
          await dependencies.ghOrThrow(args);
        } catch (error) {
          const ghCommandPresentation =
            dependencies.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
          const refreshCommand = displayGhCommand(ghCommandPresentation, [
            "auth",
            "refresh",
            "-h",
            "github.com",
            "-s",
            "repo"
          ]);
          const installation =
            ghCommandPresentation.installationNote ?
              ` ${ghCommandPresentation.installationNote}`
            : "";
          return {
            status: 502,
            body: {
              error:
                isGitHubScopeFailure(error) ?
                  refreshCommand ?
                    `Could not stop tracking the deployment on GitHub because the active GitHub token lacks permission to update deployments. Run \`${refreshCommand}\` in a terminal, then retry.${installation} Cloud resources were not changed.`
                  : `Could not stop tracking the deployment on GitHub because the active GitHub token lacks permission to update deployments. ${ghCommandPresentation.installationNote} Cloud resources were not changed.`
                : "Could not stop tracking the deployment on GitHub. Cloud resources were not changed."
            }
          };
        }

        retireCapturedAttempt();
        dependencies.invalidateDeployListCache(repo);
        return { status: 200, body: { outcome: "abandoned" } };
      } finally {
        dependencies.releaseDeploymentMutation(state, reservation);
      }
    }
  };
}
import { deploymentIdentityRefusal } from "@radius-project/core";
