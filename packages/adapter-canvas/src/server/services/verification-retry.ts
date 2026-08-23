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

export interface VerificationRetryDependencies {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  registerExecutor(operationId: string, executor: SelectedGhExecutor): void;
  unregisterExecutor(operationId: string): void;
  buildDispatchArgs(input: {
    workflowFile: string;
    targetRepo: string;
    envName: string;
    ref: string;
  }): string[];
  now(): number;
  verifyWorkflowFile: string;
  stageVerify: string;
  addStep(
    operation: VerificationRetryOperation,
    text: string,
    stage?: string
  ): void;
  setCommandState(
    operation: VerificationRetryOperation,
    commandId: string,
    state: "running" | "finished",
    outcome?: string | null
  ): void;
  finish(
    operation: VerificationRetryOperation,
    state: string,
    options: { failure: Record<string, unknown> }
  ): void;
  persist(operation: VerificationRetryOperation): Promise<void>;
  monitor(operationId: string): Promise<void>;
  currentState(operationId: string): string | null;
  isRateLimitError(error: unknown): boolean;
  sleep(milliseconds: number): Promise<void>;
  errorMessage(error: unknown): string;
}

function selectedLogin(operation: VerificationRetryOperation): string {
  return typeof operation.context?.githubLogin === "string" ?
      operation.context.githubLogin.trim()
    : "";
}

function accountLabel(login: string): string {
  return login ? `@${login}` : "the saved GitHub account";
}

function accountGuidance(login: string): string {
  return login ?
      "Re-check that account and try again."
    : "Start a new environment setup after re-checking the GitHub account.";
}

async function failSelectedAccount(
  operation: VerificationRetryOperation,
  commandId: string,
  dependencies: VerificationRetryDependencies,
  login: string,
  detail: string | null
): Promise<void> {
  const account = accountLabel(login);
  const guidance = accountGuidance(login);
  dependencies.addStep(
    operation,
    `❌ Could not use ${account} to retry credential verification.`
  );
  dependencies.setCommandState(
    operation,
    commandId,
    "finished",
    "github-account-unavailable"
  );
  dependencies.finish(operation, "failed_partial", {
    failure: {
      code: "verification-retry-github-account-unavailable",
      stage: dependencies.stageVerify,
      stepSeq: null,
      message: `Radius could not use ${account} to retry credential verification. ${guidance}`,
      classification: "user-fixable",
      evidence: detail
    }
  });
  await dependencies.persist(operation);
}

export interface SelectedVerificationMonitorDependencies {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  registerExecutor(operationId: string, executor: SelectedGhExecutor): void;
  unregisterExecutor(operationId: string): void;
  monitor(operationId: string): Promise<void>;
  accountUnavailable(
    operation: VerificationRetryOperation,
    login: string,
    detail: string
  ): Promise<void>;
  trackingExpired(
    operation: VerificationRetryOperation,
    detail: string
  ): Promise<void>;
  isRateLimitError(error: unknown): boolean;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  errorMessage(error: unknown): string;
}

const SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS = 45 * 60 * 1000;
const SELECTED_EXECUTOR_MAX_RETRY_DELAY_MS = 15_000;

interface SelectedExecutorAcquisitionDependencies {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  isRateLimitError(error: unknown): boolean;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  errorMessage(error: unknown): string;
}

type SelectedExecutorAcquisition =
  | { state: "ready"; executor: SelectedGhExecutor }
  | { state: "unavailable"; detail: string }
  | { state: "expired"; detail: string };

async function acquireSelectedExecutor(
  login: string,
  deadline: number,
  dependencies: SelectedExecutorAcquisitionDependencies
): Promise<SelectedExecutorAcquisition> {
  let delayMs = 1000;
  let rateLimitDetail =
    "GitHub rate limiting prevented Radius from reacquiring the selected account.";
  while (true) {
    if (dependencies.now() >= deadline) {
      return { state: "expired", detail: rateLimitDetail };
    }
    try {
      const executor = await dependencies.createExecutor(login);
      if (dependencies.now() >= deadline) {
        return { state: "expired", detail: rateLimitDetail };
      }
      return { state: "ready", executor };
    } catch (error) {
      const detail = dependencies.errorMessage(error);
      if (!dependencies.isRateLimitError(error)) {
        return { state: "unavailable", detail };
      }
      rateLimitDetail = detail;
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) {
        return { state: "expired", detail };
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

  const dispatchedAt = Number(operation.verification?.dispatchedAt);
  const deadline =
    Number.isFinite(dispatchedAt) && dispatchedAt > 0 ?
      dispatchedAt + SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS
    : dependencies.now() + SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS;
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
    await dependencies.trackingExpired(operation, acquisition.detail);
    return;
  }
  const executor = acquisition.executor;

  dependencies.registerExecutor(operation.operationId, executor);
  try {
    await dependencies.monitor(operation.operationId);
  } finally {
    dependencies.unregisterExecutor(operation.operationId);
  }
}

export async function runVerificationRetry(
  operation: VerificationRetryOperation,
  commandId: string,
  dependencies: VerificationRetryDependencies
): Promise<void> {
  if (operation.endedAt) return;
  const login = selectedLogin(operation);
  if (!login) {
    await failSelectedAccount(
      operation,
      commandId,
      dependencies,
      "",
      "The operation has no saved GitHub account. Start a new environment setup after re-checking the account."
    );
    return;
  }

  const saved = { ...(operation.verification || {}) };
  let acquisitionDeadline = Number(saved.acquisitionDeadline);
  if (!Number.isFinite(acquisitionDeadline) || acquisitionDeadline <= 0) {
    acquisitionDeadline =
      dependencies.now() + SELECTED_EXECUTOR_ACQUISITION_WINDOW_MS;
    operation.verification = {
      ...saved,
      acquisitionPending: true,
      acquisitionDeadline,
      retryCommandId: commandId
    };
    dependencies.setCommandState(operation, commandId, "running");
    await dependencies.persist(operation);
  }
  const acquisition = await acquireSelectedExecutor(
    login,
    acquisitionDeadline,
    dependencies
  );
  if (acquisition.state === "unavailable") {
    await failSelectedAccount(
      operation,
      commandId,
      dependencies,
      login,
      acquisition.detail
    );
    return;
  }
  if (acquisition.state === "expired") {
    dependencies.addStep(
      operation,
      "❌ GitHub rate limiting prevented the verification retry from starting."
    );
    dependencies.setCommandState(
      operation,
      commandId,
      "finished",
      "tracking-expired"
    );
    dependencies.finish(operation, "failed_partial", {
      failure: {
        code: "verification-tracking-expired",
        stage: dependencies.stageVerify,
        stepSeq: null,
        message:
          "Radius could not start credential verification before the GitHub rate limit retry window expired.",
        classification: "user-fixable",
        evidence: acquisition.detail
      }
    });
    await dependencies.persist(operation);
    return;
  }
  const executor = acquisition.executor;

  dependencies.registerExecutor(operation.operationId, executor);
  try {
    const dispatchedAt = dependencies.now();
    const dispatchIdentity = {
      dispatchedAt,
      workflow: String(saved.workflow || dependencies.verifyWorkflowFile),
      ref: String(saved.ref || ""),
      environment: String(saved.environment || operation.environment || ""),
      runId: null,
      runUrl: null
    };
    operation.verification = {
      ...dispatchIdentity,
      dispatchPending: true,
      retryCommandId: commandId
    };
    await dependencies.persist(operation);
    const dispatch = await executor.run(
      dependencies.buildDispatchArgs({
        workflowFile: dispatchIdentity.workflow,
        targetRepo: String(operation.repo || ""),
        envName: dispatchIdentity.environment,
        ref: dispatchIdentity.ref
      }),
      { timeout: 30000 }
    );
    if (Number(dispatch.code) !== 0) {
      const detail =
        (dispatch.stderr || dispatch.stdout || "").trim() ||
        "The selected GitHub account request failed.";
      dependencies.addStep(
        operation,
        "❌ Could not dispatch the verify workflow again."
      );
      dependencies.setCommandState(
        operation,
        commandId,
        "finished",
        "dispatch-failed"
      );
      dependencies.finish(operation, "failed_partial", {
        failure: {
          code: "verify-dispatch-failed",
          stage: dependencies.stageVerify,
          stepSeq: null,
          message: `Radius could not dispatch the credential verification workflow again as @${login}. Re-check that account and try again.`,
          classification: "user-fixable",
          evidence: detail
        }
      });
      await dependencies.persist(operation);
      return;
    }

    operation.verification = dispatchIdentity;
    dependencies.addStep(
      operation,
      "✅ Verify workflow dispatched again.",
      dependencies.stageVerify
    );
    try {
      await dependencies.persist(operation);
    } catch {
      // The durable pre-dispatch checkpoint still says this dispatch may exist.
      // Keep that same recovery truth in memory and monitor the run instead of
      // letting the outer task replace it with a marker-free generic failure.
      operation.verification = {
        ...dispatchIdentity,
        dispatchPending: true,
        retryCommandId: commandId
      };
    }
    await dependencies.monitor(operation.operationId);
    dependencies.setCommandState(
      operation,
      commandId,
      "finished",
      dependencies.currentState(operation.operationId)
    );
    await dependencies.persist(operation);
  } finally {
    dependencies.unregisterExecutor(operation.operationId);
  }
}
