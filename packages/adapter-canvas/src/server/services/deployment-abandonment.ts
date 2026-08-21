import type { CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  type DeploymentRow
} from "./deployment-resolver.js";

export interface DeploymentAbandonmentReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete" | "abandon";
  expiresAt: number;
  attemptId?: string;
}

export interface DeploymentAbandonmentDependencies {
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

function retireMatchingDeployAttempt(
  state: CanvasState,
  repo: string,
  environment: string
): void {
  const attempt = state.deployAttempt;
  if (
    !attempt ||
    attempt.targetRepo !== repo ||
    attempt.environment !== environment
  ) {
    return;
  }
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
      if (
        !repo ||
        !environment ||
        !application ||
        !dependencies.isValidRepoSlug(repo)
      ) {
        return {
          status: 400,
          body: {
            error:
              "A valid repo, environment, and application are required to abandon deployment tracking."
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
            error: `${conflict} is already in progress. Wait for it to finish before abandoning deployment tracking.`
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
            body: { error: "No failed deployment is available to abandon." }
          };
        }
        if (dependencies.deploymentStatusBlocksMutation(current.status)) {
          return {
            status: 409,
            body: {
              error:
                current.status === "deleting" ?
                  "This deployment is being deleted and cannot be abandoned."
                : "This application is still being deployed. Wait for it to finish before abandoning deployment tracking."
            }
          };
        }
        if (current.status !== "failed") {
          return {
            status: 409,
            body: { error: "Only a failed deployment can be abandoned." }
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
          return {
            status: 502,
            body: {
              error:
                isGitHubScopeFailure(error) ?
                  "Could not abandon deployment tracking on GitHub because the active GitHub token lacks permission to update deployments. Run `gh auth refresh -h github.com -s repo` in a terminal, then retry. Cloud resources were not changed."
                : "Could not abandon deployment tracking on GitHub. Cloud resources were not changed."
            }
          };
        }

        retireMatchingDeployAttempt(state, repo, environment);
        dependencies.invalidateDeployListCache(repo);
        return { status: 200, body: { outcome: "abandoned" } };
      } finally {
        dependencies.releaseDeploymentMutation(state, reservation);
      }
    }
  };
}
