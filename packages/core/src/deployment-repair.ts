export const DEPLOY_REPAIR_ATTEMPT_CAP = 5;
export const DEPLOY_HANDOFF_MAX_ATTEMPTS = 3;
export const DEPLOY_HANDOFF_RETRY_DELAY_MS = 2000;

export interface DeploymentRepairState {
  deployAttempt?: { id: string };
  deployGeneration?: number;
  deployStatus?: string;
  deployErrorKind?: string | null;
  deployRunUrl?: string | null;
  deployRepairAttempts?: number;
  deployRepairing?: boolean;
  deployHandoffState?: string;
  deployHandoffAttempts?: number;
}

export interface DeploymentRepairResolution {
  repairLoop: boolean;
  attemptId: string;
  repairAttempt: number;
  error?: string;
}

const NONREPAIRABLE_KINDS = new Set([
  "branch-not-pushed",
  "dispatch-refused",
  "oidc-subject-missing",
  "oidc-subject-case-mismatch",
  "cloud-auth-drift",
  "run-unconfirmed"
]);

export function resolveDeploymentRepairLoop(
  state: DeploymentRepairState,
  requestedAttemptId: unknown
): DeploymentRepairResolution {
  const requested =
    typeof requestedAttemptId === "string" ? requestedAttemptId : "";
  const refuse = (error: string): DeploymentRepairResolution => ({
    repairLoop: false,
    attemptId: "",
    repairAttempt: 0,
    error
  });
  if (!requested) return { repairLoop: false, attemptId: "", repairAttempt: 0 };
  if ((state.deployAttempt?.id || "") !== requested) {
    return refuse(
      `Deploy attempt "${requested}" is no longer the current attempt for this canvas session, so nothing was deployed. A newer deploy has replaced it; ask the user which deploy to repair.`
    );
  }
  const status = state.deployStatus || "";
  if (status !== "failed") {
    return refuse(
      status === "in_progress" ?
        `Deploy attempt "${requested}" is still running, so nothing was deployed. Poll the radius_deploy_status tool until it reports success or failed before redeploying.`
      : `Deploy attempt "${requested}" is not in a failed state, so there is nothing to repair and nothing was deployed. Its repair loop is over. To deploy again, call radius_deploy without an attemptId to start a new deploy.`
    );
  }
  if (state.deployErrorKind === "dispatch-refused") {
    return refuse(
      `Deploy attempt "${requested}" was refused without starting a workflow. No new workflow was started. Report the refusal to the user; do not repair the model or automatically redeploy. Once the blocker is resolved, the user can request a fresh deploy without an attemptId.`
    );
  }
  if (state.deployErrorKind === "run-unconfirmed") {
    const runUrl = state.deployRunUrl || "";
    return refuse(
      `Deploy attempt "${requested}" never confirmed what happened to its workflow, so a run may still be in flight and nothing was deployed. Redeploying now could start a second run against the same target.${runUrl ? ` Check the run at ${runUrl}` : " Check the repository's Actions tab"} and tell the user what it shows. To deploy again afterwards, call radius_deploy without an attemptId — this attempt cannot be repaired, because its outcome will never be confirmed.`
    );
  }
  if (NONREPAIRABLE_KINDS.has(state.deployErrorKind || "")) {
    return refuse(
      `Deploy attempt "${requested}" requires branch or cloud identity correction, not model repair. Nothing was deployed. Report the existing deployment error to the user; after resolving it, request a fresh deploy without an attemptId.`
    );
  }
  const repairAttempt = (state.deployRepairAttempts || 0) + 1;
  if (repairAttempt > DEPLOY_REPAIR_ATTEMPT_CAP) {
    return refuse(
      `This repair loop has already used its ${DEPLOY_REPAIR_ATTEMPT_CAP} automatic repair attempts, so nothing was deployed. Stop retrying: report the remaining failure and what you tried to the user, and let them decide whether to deploy again from the canvas.`
    );
  }
  return { repairLoop: true, attemptId: requested, repairAttempt };
}

export interface DeploymentRepairClaim {
  readonly attemptId: string;
  readonly generation: number;
  readonly deliveryAttempt: number;
}

export function claimDeploymentRepairHandoff(
  state: DeploymentRepairState
): DeploymentRepairClaim | undefined {
  if (
    state.deployStatus !== "failed" ||
    NONREPAIRABLE_KINDS.has(state.deployErrorKind || "") ||
    state.deployRepairing ||
    state.deployHandoffState === "pending" ||
    state.deployHandoffState === "failed" ||
    (state.deployHandoffAttempts || 0) >= DEPLOY_HANDOFF_MAX_ATTEMPTS
  )
    return undefined;
  const claim = Object.freeze({
    attemptId: state.deployAttempt?.id || "",
    generation: state.deployGeneration || 0,
    deliveryAttempt: (state.deployHandoffAttempts || 0) + 1
  });
  state.deployHandoffState = "pending";
  state.deployHandoffAttempts = claim.deliveryAttempt;
  return claim;
}

export function settleDeploymentRepairHandoff(
  state: DeploymentRepairState,
  claim: DeploymentRepairClaim,
  delivered: boolean
): "stale" | "delivered" | "failed" | "retryable" {
  if (
    (state.deployAttempt?.id || "") !== claim.attemptId ||
    (state.deployGeneration || 0) !== claim.generation ||
    state.deployHandoffState !== "pending" ||
    state.deployHandoffAttempts !== claim.deliveryAttempt
  )
    return "stale";
  const result =
    delivered ? "delivered"
    : claim.deliveryAttempt >= DEPLOY_HANDOFF_MAX_ATTEMPTS ? "failed"
    : "retryable";
  state.deployHandoffState = result;
  state.deployRepairing = delivered;
  return result;
}
