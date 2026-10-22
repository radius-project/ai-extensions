import type { CanvasState } from "../shared.js";

export const DEPLOYMENT_MUTATION_LEASE_MS = 30 * 60 * 1000;

export interface DeployAttemptInput {
  repo: string;
  branch: string;
  provider: string;
  environment: string;
  appFile: string;
  repairLoop: boolean;
  attemptId?: string;
}

export function beginDeployAttempt(
  state: CanvasState,
  input: DeployAttemptInput
): void {
  state.deployStatus = "in_progress";
  // Repair invocations keep their attempt ID but must invalidate delayed
  // notifications from the preceding invocation, including pre-dispatch failures.
  state.deployGeneration = (state.deployGeneration || 0) + 1;
  state.deployError = null;
  state.deployErrorKind = null;
  state.deployErrorBranch = null;
  state.deployErrorPaths = null;
  state.deployRunUrl = null;
  state.deployRunId = null;
  delete state.deployDispatchReference;
  delete state.deployDispatchEvidence;
  state.deployedGraph = null;
  state.deployedGraphRepo = undefined;
  state.deployRepairing = input.repairLoop;
  state.deployHandoffState = input.repairLoop ? "delivered" : "idle";
  state.deployHandoffAttempts =
    input.repairLoop ? state.deployHandoffAttempts || 0 : 0;
  state.deployNoticeState = "idle";
  state.deployNoticeAttempts = 0;
  state.deployRepairAttempts =
    input.repairLoop ? (state.deployRepairAttempts || 0) + 1 : 0;
  state.deployingBranch = input.branch;
  state.deployAttempt = {
    id:
      (input.repairLoop && input.attemptId) ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    targetRepo: input.repo,
    environment: input.environment,
    branch: input.branch,
    provider: input.provider,
    appFile: input.appFile
  };
}

export function deploymentStatusBlocksMutation(status: unknown): boolean {
  return (
    status === "pending" || status === "in_progress" || status === "deleting"
  );
}

export function localDeploymentBlocksMutation(
  state: CanvasState,
  now = Date.now()
): boolean {
  if (state.deployStatus !== "in_progress") return false;
  return (
    typeof state.deployStartedAt !== "number" ||
    state.deployStartedAt + DEPLOYMENT_MUTATION_LEASE_MS > now
  );
}

export function resolveDeploymentEnvironment(
  state: CanvasState,
  requestedEnvironment: unknown
): string {
  return (
    (typeof requestedEnvironment === "string" && requestedEnvironment) ||
    (typeof state.envName === "string" && state.envName) ||
    ""
  );
}
