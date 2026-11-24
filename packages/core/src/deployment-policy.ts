import { needsWorkflowScope } from "./setup-workflow-scope.js";
import type { DeploymentErrorKind, DeploymentState } from "./deployment.js";

export const DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE =
  "GitHub reported that the deploy workflow completed, but its outcome could not be confirmed.";

export const DEPLOY_HANDOFF_MAX_ATTEMPTS = 3;
export const DEPLOY_HANDOFF_RETRY_DELAY_MS = 2000;
export const DEPLOY_REPAIR_ATTEMPT_CAP = 5;

export const DEPLOYMENT_MONITOR_LIMITS = {
  statusPollMs: 15000,
  discoveryAttempts: 24,
  runPollAttempts: 240,
  pollIntervalMs: 5000,
  heartbeatMs: 30000,
  pendingFallbackMs: 25000
} as const;

export function shouldRetryWithKeyringCredential(input: {
  stderr?: string;
  timedOut?: boolean;
  hasInjectedToken: boolean;
}): boolean {
  return (
    input.hasInjectedToken &&
    !input.timedOut &&
    needsWorkflowScope(input.stderr)
  );
}

export function classifyDeployDispatchFailure(
  stderr: string
): DeploymentErrorKind {
  return (
      /no ref found|could not resolve|no commit found for the ref/i.test(
        stderr || ""
      )
    ) ?
      "branch-not-pushed"
    : "run-unconfirmed";
}

export function deploymentHandoffEligible(state: DeploymentState): boolean {
  return (
    state.deployStatus === "failed" &&
    !state.deployErrorKind &&
    !state.deployRepairing &&
    state.deployHandoffState !== "pending" &&
    state.deployHandoffState !== "failed"
  );
}

export function deploymentNoticeEligible(state: DeploymentState): boolean {
  return (
    state.deployStatus === "failed" &&
    state.deployErrorKind === "run-unconfirmed" &&
    state.deployNoticeState !== "pending" &&
    state.deployNoticeState !== "delivered" &&
    state.deployNoticeState !== "failed"
  );
}

export interface DeploymentRepairDecision {
  repairLoop: boolean;
  attemptId: string;
  repairAttempt: number;
  error?: string;
}

/** Explicit attempt admission intentionally differs from automatic handoff eligibility. */
export function resolveDeployRepairLoop(
  state: DeploymentState,
  requestedAttemptId: unknown
): DeploymentRepairDecision {
  const requested =
    typeof requestedAttemptId === "string" ? requestedAttemptId : "";
  const refused = (error: string): DeploymentRepairDecision => ({
    repairLoop: false,
    attemptId: "",
    repairAttempt: 0,
    error
  });
  if (!requested) return { repairLoop: false, attemptId: "", repairAttempt: 0 };
  if (state.deployAttempt?.id !== requested) {
    return refused(
      `Deploy attempt "${requested}" is no longer the current attempt for this session, so nothing was deployed. A newer deploy has replaced it; ask the user which deploy to repair.`
    );
  }
  const status = state.deployStatus || "";
  if (status !== "failed") {
    return refused(
      status === "in_progress" ?
        `Deploy attempt "${requested}" is still running, so nothing was deployed. Poll the radius_deploy_status tool until it reports success or failed before redeploying.`
      : `Deploy attempt "${requested}" is not in a failed state, so there is nothing to repair and nothing was deployed. Its repair loop is over. To deploy again, call radius_deploy without an attemptId to start a new deploy.`
    );
  }
  if (state.deployErrorKind === "run-unconfirmed") {
    const runUrl = state.deployRunUrl || "";
    return refused(
      `Deploy attempt "${requested}" never confirmed what happened to its workflow, so a run may still be in flight and nothing was deployed. Redeploying now could start a second run against the same target.${runUrl ? ` Check the run at ${runUrl}` : " Check the repository's Actions tab"} and tell the user what it shows. To deploy again afterwards, call radius_deploy without an attemptId — this attempt cannot be repaired, because its outcome will never be confirmed.`
    );
  }
  const repairAttempt = (state.deployRepairAttempts || 0) + 1;
  if (repairAttempt > DEPLOY_REPAIR_ATTEMPT_CAP) {
    return refused(
      `This repair loop has already used its ${DEPLOY_REPAIR_ATTEMPT_CAP} automatic repair attempts, so nothing was deployed. Stop retrying: report the remaining failure and what you tried to the user, and let them decide whether to deploy again.`
    );
  }
  return { repairLoop: true, attemptId: requested, repairAttempt };
}
