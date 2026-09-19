import type { DeploymentReservation, DeploymentState } from "./types.js";

export const DEPLOYMENT_MUTATION_LEASE_MS = 30 * 60 * 1000;

export function resolveDeploymentEnvironment(
  state: DeploymentState,
  requested: unknown
): string {
  return (typeof requested === "string" && requested) || state.envName || "";
}

export function activeDeploymentMutation(
  state: DeploymentState,
  now: number
): DeploymentReservation | undefined {
  const current = state.deploymentMutation;
  if (current && current.expiresAt <= now) {
    delete state.deploymentMutation;
    return undefined;
  }
  return current;
}

export function reserveDeploymentMutation(
  state: DeploymentState,
  input: Omit<DeploymentReservation, "expiresAt">,
  now: number
): DeploymentReservation | null {
  if (activeDeploymentMutation(state, now)) return null;
  const reservation = {
    ...input,
    expiresAt: now + DEPLOYMENT_MUTATION_LEASE_MS
  };
  state.deploymentMutation = reservation;
  return reservation;
}

export function releaseDeploymentMutation(
  state: DeploymentState,
  reservation: DeploymentReservation
): void {
  if (state.deploymentMutation === reservation) delete state.deploymentMutation;
}

export function deploymentStatusBlocksMutation(status: unknown): boolean {
  return (
    status === "pending" || status === "in_progress" || status === "deleting"
  );
}

export function localDeploymentBlocksMutation(
  state: DeploymentState,
  now: number
): boolean {
  return (
    state.deployStatus === "in_progress" &&
    (typeof state.deployStartedAt !== "number" ||
      state.deployStartedAt + DEPLOYMENT_MUTATION_LEASE_MS > now)
  );
}
