import type { SelectedGhExecutor } from "../../gh.js";

export interface VerificationRetryOperation {
  operationId: string;
  repo?: unknown;
  environment?: unknown;
  endedAt?: unknown;
  context?: { githubLogin?: unknown };
  verification?: {
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
  errorMessage(error: unknown): string;
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

  let executor: SelectedGhExecutor;
  try {
    executor = await dependencies.createExecutor(login);
  } catch (error) {
    await dependencies.accountUnavailable(
      operation,
      login,
      dependencies.errorMessage(error)
    );
    return;
  }

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

  let executor: SelectedGhExecutor;
  try {
    executor = await dependencies.createExecutor(login);
  } catch (error) {
    await failSelectedAccount(
      operation,
      commandId,
      dependencies,
      login,
      dependencies.errorMessage(error)
    );
    return;
  }

  dependencies.registerExecutor(operation.operationId, executor);
  try {
    const saved = operation.verification || {};
    const dispatchedAt = dependencies.now();
    const dispatch = await executor.run(
      dependencies.buildDispatchArgs({
        workflowFile: String(saved.workflow || dependencies.verifyWorkflowFile),
        targetRepo: String(operation.repo || ""),
        envName: String(saved.environment || operation.environment || ""),
        ref: String(saved.ref || "")
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

    operation.verification = {
      dispatchedAt,
      workflow: String(saved.workflow || dependencies.verifyWorkflowFile),
      ref: String(saved.ref || ""),
      environment: String(saved.environment || operation.environment || ""),
      runId: null,
      runUrl: null
    };
    dependencies.addStep(
      operation,
      "✅ Verify workflow dispatched again.",
      dependencies.stageVerify
    );
    dependencies.setCommandState(operation, commandId, "running");
    await dependencies.persist(operation);
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
