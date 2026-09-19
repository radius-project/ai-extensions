export const DEPLOYMENT_HANDOFF_MAX_ATTEMPTS = 3;
export const DEPLOYMENT_HANDOFF_RETRY_DELAY_MS = 2000;

export interface DeploymentAttempt {
  id: string;
  targetRepo?: string;
  environment?: string;
  branch?: string;
  provider?: string;
  appFile?: string;
}

export interface DeploymentRepairState {
  deployStatus?: string;
  deployGeneration?: number;
  deployError?: string | null;
  deployErrorKind?: string | null;
  deployErrorBranch?: string | null;
  deployErrorPaths?: string | null;
  deployRunUrl?: string | null;
  deployRunId?: string | number | null;
  deployedGraph?: unknown;
  deployedGraphRepo?: string;
  deployRepairing?: boolean;
  deployHandoffState?: string;
  deployHandoffAttempts?: number;
  deployNoticeState?: string;
  deployNoticeAttempts?: number;
  deployRepairAttempts?: number;
  deployingBranch?: string;
  deployAttempt?: DeploymentAttempt;
}

export interface BeginDeploymentInput {
  repo: string;
  branch: string;
  provider: string;
  environment: string;
  appFile: string;
  repairLoop: boolean;
  attemptId?: string;
}

export interface DeploymentRepairResolution {
  repairLoop: boolean;
  attemptId: string;
  repairAttempt: number;
  error?: string;
}

export function resolveDeploymentRepair(
  state: DeploymentRepairState,
  requestedAttemptId: unknown,
  attemptCap: number
): DeploymentRepairResolution {
  const requested =
    typeof requestedAttemptId === "string" ? requestedAttemptId : "";
  const refused = (error: string): DeploymentRepairResolution => ({
    repairLoop: false,
    attemptId: "",
    repairAttempt: 0,
    error
  });
  if (!requested) return { repairLoop: false, attemptId: "", repairAttempt: 0 };
  if ((state.deployAttempt?.id || "") !== requested) {
    return refused(
      `Deploy attempt "${requested}" is no longer the current attempt for this canvas session, so nothing was deployed. A newer deploy has replaced it; ask the user which deploy to repair.`
    );
  }
  if (state.deployStatus !== "failed") {
    return refused(
      state.deployStatus === "in_progress" ?
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
  if (repairAttempt > attemptCap) {
    return refused(
      `This repair loop has already used its ${attemptCap} automatic repair attempts, so nothing was deployed. Stop retrying: report the remaining failure and what you tried to the user, and let them decide whether to deploy again from the canvas.`
    );
  }
  return { repairLoop: true, attemptId: requested, repairAttempt };
}

export function beginDeploymentAttempt(
  state: DeploymentRepairState,
  input: BeginDeploymentInput,
  createAttemptId: () => string
): void {
  state.deployStatus = "in_progress";
  state.deployGeneration = (state.deployGeneration || 0) + 1;
  state.deployError = null;
  state.deployErrorKind = null;
  state.deployErrorBranch = null;
  state.deployErrorPaths = null;
  state.deployRunUrl = null;
  state.deployRunId = null;
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
    id: (input.repairLoop && input.attemptId) || createAttemptId(),
    targetRepo: input.repo,
    environment: input.environment,
    branch: input.branch,
    provider: input.provider,
    appFile: input.appFile
  };
}

export interface DeploymentInteraction {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  attemptId: string;
}

export interface DeploymentInteractionPorts {
  deliver(input: DeploymentInteraction): unknown;
  scheduleRetry(callback: () => void, delayMs: number): void;
  reportError(error: unknown): void;
}

const NON_REPAIRABLE_FAILURES = new Set([
  "branch-not-pushed",
  "oidc-subject-missing",
  "oidc-subject-case-mismatch",
  "cloud-auth-drift",
  "run-unconfirmed"
]);

function requestInteraction(
  kind: "repair" | "notice",
  state: DeploymentRepairState,
  repo: string,
  ports: DeploymentInteractionPorts
): boolean {
  if (state.deployStatus !== "failed") return false;
  if (
    kind === "repair" ?
      NON_REPAIRABLE_FAILURES.has(state.deployErrorKind || "") ||
      state.deployRepairing
    : state.deployErrorKind !== "run-unconfirmed"
  )
    return false;
  const stateKey =
    kind === "repair" ? "deployHandoffState" : "deployNoticeState";
  const attemptsKey =
    kind === "repair" ? "deployHandoffAttempts" : "deployNoticeAttempts";
  if (
    state[stateKey] === "pending" ||
    state[stateKey] === "failed" ||
    (kind === "notice" && state[stateKey] === "delivered")
  )
    return false;

  const attemptId = state.deployAttempt?.id || "";
  state[stateKey] = "pending";
  const deliveryAttempt = (state[attemptsKey] || 0) + 1;
  state[attemptsKey] = deliveryAttempt;
  const ownsAttempt = () => (state.deployAttempt?.id || "") === attemptId;
  const delivered = () => {
    if (!ownsAttempt()) return;
    state[stateKey] = "delivered";
    if (kind === "repair") state.deployRepairing = true;
  };
  const failed = (error: unknown) => {
    ports.reportError(error);
    if (!ownsAttempt()) return;
    if (kind === "repair") state.deployRepairing = false;
    const exhausted = deliveryAttempt >= DEPLOYMENT_HANDOFF_MAX_ATTEMPTS;
    state[stateKey] = exhausted ? "failed" : "retryable";
    if (exhausted) return;
    ports.scheduleRetry(() => {
      if (ownsAttempt()) requestInteraction(kind, state, repo, ports);
    }, DEPLOYMENT_HANDOFF_RETRY_DELAY_MS);
  };
  try {
    Promise.resolve(
      ports.deliver({
        repo,
        branch: state.deployingBranch || "",
        error: state.deployError || "",
        deployRunUrl: state.deployRunUrl || "",
        attemptId
      })
    ).then(delivered, failed);
  } catch (error) {
    failed(error);
    return false;
  }
  return true;
}

export function requestDeploymentRepair(
  state: DeploymentRepairState,
  repo: string,
  ports: DeploymentInteractionPorts
): boolean {
  return requestInteraction("repair", state, repo, ports);
}

export function reportUnconfirmedDeployment(
  state: DeploymentRepairState,
  repo: string,
  ports: DeploymentInteractionPorts
): boolean {
  return requestInteraction("notice", state, repo, ports);
}

export function deploymentHandoffStatus(state: DeploymentRepairState) {
  const handoffState = state.deployHandoffState || "idle";
  return {
    state: handoffState,
    attempts: state.deployHandoffAttempts || 0,
    maxAttempts: DEPLOYMENT_HANDOFF_MAX_ATTEMPTS,
    pending: handoffState === "pending" || handoffState === "retryable"
  };
}
