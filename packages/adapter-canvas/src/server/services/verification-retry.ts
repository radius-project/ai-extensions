import type { SelectedGhExecutor } from "../../gh.js";

export interface VerificationRetryOperation {
  operationId: string;
  repo?: unknown;
  environment?: unknown;
  endedAt?: unknown;
  context?: { githubLogin?: unknown };
  verification?: {
    dispatchedAt?: unknown;
    workflow?: unknown;
    ref?: unknown;
    environment?: unknown;
    [key: string]: unknown;
  };
  state?: unknown;
  [key: string]: unknown;
}

function selectedLogin(operation: VerificationRetryOperation): string {
  return typeof operation.context?.githubLogin === "string" ?
      operation.context.githubLogin.trim()
    : "";
}

export interface SelectedVerificationMonitorDependencies {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  registerExecutor(operationId: string, executor: SelectedGhExecutor): void;
  unregisterExecutor(operationId: string): void;
  beforeMonitor?(executor: SelectedGhExecutor): Promise<boolean>;
  monitor(operationId: string): Promise<void>;
  accountUnavailable(
    operation: VerificationRetryOperation,
    login: string,
    detail: string
  ): Promise<void>;
  trackingExpired(
    operation: VerificationRetryOperation,
    expiration: SelectedExecutorAcquisitionExpired
  ): Promise<void>;
  isRateLimitError(error: unknown): boolean;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  errorMessage(error: unknown): string;
}

export const SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS = 45 * 60 * 1000;
export const VERIFICATION_TRACKING_WINDOW_MS = 45 * 60 * 1000;
const SELECTED_EXECUTOR_MAX_RETRY_DELAY_MS = 15_000;
const SELECTED_EXECUTOR_DEADLINE_ELAPSED_DETAIL =
  "The selected GitHub account acquisition deadline elapsed.";

export function verificationTrackingDeadline(
  operation: VerificationRetryOperation,
  now: () => number
): number {
  const persistedDeadline = Number(operation.verification?.trackingDeadline);
  if (Number.isFinite(persistedDeadline) && persistedDeadline > 0) {
    return persistedDeadline;
  }
  const dispatchedAt = Number(operation.verification?.dispatchedAt);
  return Number.isFinite(dispatchedAt) && dispatchedAt > 0 ?
      dispatchedAt + VERIFICATION_TRACKING_WINDOW_MS
    : now() + VERIFICATION_TRACKING_WINDOW_MS;
}

export function verificationAcquisitionDeadline(
  operation: VerificationRetryOperation,
  now: () => number
): number {
  const persistedDeadline = Number(operation.verification?.acquisitionDeadline);
  if (Number.isFinite(persistedDeadline) && persistedDeadline > 0) {
    return persistedDeadline;
  }
  const trackingDeadline = Number(operation.verification?.trackingDeadline);
  if (Number.isFinite(trackingDeadline) && trackingDeadline > 0) {
    return trackingDeadline;
  }
  const dispatchedAt = Number(operation.verification?.dispatchedAt);
  return Number.isFinite(dispatchedAt) && dispatchedAt > 0 ?
      dispatchedAt + SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS
    : now() + SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS;
}

export function shouldReuseVerificationDispatch(input: {
  accountUnavailablePhase: unknown;
  previousStatus: unknown;
}): boolean {
  if (input.accountUnavailablePhase !== "dispatch") {
    return false;
  }
  return (
    input.previousStatus === "prepared" ||
    input.previousStatus === "outcome_unknown" ||
    input.previousStatus === "confirmed"
  );
}

export type VerificationRetryTargetPhase =
  "monitor" | "acquisition" | "dispatch";

export function verificationRetryTargetPhase(
  previousPhase: unknown
): VerificationRetryTargetPhase {
  return previousPhase === "monitor" || previousPhase === "dispatch" ?
      previousPhase
    : "acquisition";
}

export function shouldResumeKnownVerificationRun(input: {
  accountUnavailablePhase: unknown;
  runId: unknown;
}): boolean {
  return Boolean(
    input.accountUnavailablePhase === "monitor" &&
    input.runId != null &&
    String(input.runId)
  );
}

export interface SelectedExecutorAcquisitionDependencies {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  isRateLimitError(error: unknown): boolean;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  errorMessage(error: unknown): string;
}

export type SelectedExecutorAcquisition =
  | { state: "ready"; executor: SelectedGhExecutor }
  | { state: "unavailable"; detail: string }
  | SelectedExecutorAcquisitionExpired;

export interface SelectedExecutorAcquisitionExpired {
  state: "expired";
  cause: "deadline_elapsed" | "rate_limited";
  detail: string;
}

export function verificationAcquisitionExpiredCopy(
  action: "start" | "resume",
  expiration: SelectedExecutorAcquisitionExpired
): { step: string; message: string } {
  if (expiration.cause === "rate_limited") {
    return action === "start" ?
        {
          step: "❌ GitHub rate limiting prevented the verification retry from starting.",
          message:
            "Radius could not start credential verification before the GitHub rate-limit acquisition window expired."
        }
      : {
          step: "❌ GitHub rate limiting prevented credential verification from resuming.",
          message:
            "Radius could not resume credential verification before the GitHub rate-limit acquisition window expired."
        };
  }
  return action === "start" ?
      {
        step: "❌ The selected GitHub account acquisition deadline elapsed before verification could start.",
        message:
          "Radius could not start credential verification before the selected GitHub account acquisition deadline elapsed."
      }
    : {
        step: "❌ The selected GitHub account acquisition deadline elapsed before verification could resume.",
        message:
          "Radius could not resume credential verification before the selected GitHub account acquisition deadline elapsed."
      };
}

export async function acquireSelectedExecutor(
  login: string,
  deadline: number,
  dependencies: SelectedExecutorAcquisitionDependencies
): Promise<SelectedExecutorAcquisition> {
  let delayMs = 1000;
  let expirationDetail = SELECTED_EXECUTOR_DEADLINE_ELAPSED_DETAIL;
  let expirationCause: SelectedExecutorAcquisitionExpired["cause"] =
    "deadline_elapsed";
  while (true) {
    if (dependencies.now() >= deadline) {
      return {
        state: "expired",
        cause: expirationCause,
        detail: expirationDetail
      };
    }
    try {
      const executor = await dependencies.createExecutor(login);
      if (dependencies.now() >= deadline) {
        return {
          state: "expired",
          cause: expirationCause,
          detail: expirationDetail
        };
      }
      return { state: "ready", executor };
    } catch (error) {
      const detail = dependencies.errorMessage(error);
      if (!dependencies.isRateLimitError(error)) {
        return { state: "unavailable", detail };
      }
      expirationDetail = detail;
      expirationCause = "rate_limited";
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) {
        return { state: "expired", cause: expirationCause, detail };
      }
      await dependencies.sleep(Math.min(delayMs, remainingMs));
      delayMs = Math.min(
        Math.ceil(delayMs * 1.5),
        SELECTED_EXECUTOR_MAX_RETRY_DELAY_MS
      );
    }
  }
}

export async function monitorVerificationWithSelectedAccount(
  operation: VerificationRetryOperation,
  dependencies: SelectedVerificationMonitorDependencies
): Promise<void> {
  const login = selectedLogin(operation);
  if (!login) {
    await dependencies.accountUnavailable(
      operation,
      "",
      "The operation has no saved GitHub account."
    );
    return;
  }

  const deadline = verificationAcquisitionDeadline(operation, dependencies.now);
  const acquisition = await acquireSelectedExecutor(
    login,
    deadline,
    dependencies
  );
  if (acquisition.state === "unavailable") {
    await dependencies.accountUnavailable(operation, login, acquisition.detail);
    return;
  }
  if (acquisition.state === "expired") {
    await dependencies.trackingExpired(operation, acquisition);
    return;
  }
  const executor = acquisition.executor;

  dependencies.registerExecutor(operation.operationId, executor);
  try {
    if (
      dependencies.beforeMonitor &&
      !(await dependencies.beforeMonitor(executor))
    ) {
      return;
    }
    await dependencies.monitor(operation.operationId);
  } finally {
    dependencies.unregisterExecutor(operation.operationId);
  }
}
