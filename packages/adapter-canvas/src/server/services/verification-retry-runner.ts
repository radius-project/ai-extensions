import type { SelectedGhExecutor } from "../../gh.js";
import {
  providerMutationRecord,
  settleProviderMutation,
  terminalizeProviderManualRequired
} from "../../operations.js";
import {
  ProviderMutationRecoveryError,
  type ProviderMutationCommandResult
} from "./provider-mutation-recovery.js";
import { runVerificationDispatch } from "./verification-dispatch.js";
import {
  acquireSelectedExecutor,
  shouldResumeKnownVerificationRun,
  shouldReuseVerificationDispatch,
  verificationAcquisitionExpiredCopy,
  verificationRetryTargetPhase,
  VERIFICATION_TRACKING_WINDOW_MS,
  type VerificationRetryOperation
} from "./verification-retry.js";

type VerificationRetryFinishOptions =
  { failure: Record<string, unknown> } | { terminal: Record<string, unknown> };

export interface VerificationRetryStopBoundaryInput {
  operation: VerificationRetryOperation;
  boundary: string;
  beforePersist(): void;
}

export interface VerificationRetryRunnerDependencies {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  registerExecutor(operationId: string, executor: SelectedGhExecutor): void;
  unregisterExecutor(operationId: string): void;
  stopBoundary(input: VerificationRetryStopBoundaryInput): Promise<boolean>;
  buildDispatchArgs(input: {
    workflowFile: string;
    targetRepo: string;
    envName: string;
    ref: string;
    operationMarker: string;
  }): string[];
  selectedCommandAuthorizationError(
    executor: SelectedGhExecutor,
    repo: string,
    result: ProviderMutationCommandResult
  ): Promise<Error | null>;
  isAuthorizationError(error: unknown): boolean;
  isRateLimitError(error: unknown): boolean;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
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
    options: VerificationRetryFinishOptions
  ): void;
  persist(operation: VerificationRetryOperation): Promise<boolean>;
  persistJournal(): Promise<void>;
  monitor(operationId: string): Promise<void>;
  currentState(operationId: string): string | null;
  errorMessage(error: unknown): string;
}

function selectedLogin(operation: VerificationRetryOperation): string {
  return typeof operation.context?.githubLogin === "string" ?
      operation.context.githubLogin.trim()
    : "";
}

async function failSelectedAccount(input: {
  operation: VerificationRetryOperation;
  commandId: string;
  login: string;
  evidence: string | null;
  phase: "monitor" | "acquisition" | "dispatch";
  step: string;
  dependencies: VerificationRetryRunnerDependencies;
}): Promise<void> {
  const { operation, commandId, login, evidence, phase, step, dependencies } =
    input;
  dependencies.addStep(operation, step);
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
      message: `Radius could not use @${login} to retry credential verification. Re-check that account and try again.`,
      classification: "user-fixable",
      evidence
    }
  });
  operation.verification = {
    ...(operation.verification || {}),
    accountUnavailablePhase: phase
  };
  await dependencies.persist(operation);
}

async function failPersistence(input: {
  operation: VerificationRetryOperation;
  commandId: string;
  message: string;
  evidence: string | null;
  dependencies: VerificationRetryRunnerDependencies;
}): Promise<void> {
  const { operation, commandId, message, evidence, dependencies } = input;
  dependencies.setCommandState(
    operation,
    commandId,
    "finished",
    "persistence-failed"
  );
  dependencies.finish(operation, "failed_partial", {
    failure: {
      code: "verification-retry-persist-failed",
      stage: dependencies.stageVerify,
      stepSeq: null,
      message,
      classification: "system",
      evidence
    }
  });
  await dependencies.persist(operation);
}

export async function runVerificationRetry(
  operation: VerificationRetryOperation,
  commandId: string,
  dependencies: VerificationRetryRunnerDependencies
): Promise<void> {
  if (operation.endedAt) return;
  const login = selectedLogin(operation);
  if (!login) {
    dependencies.addStep(
      operation,
      "❌ The saved GitHub account for this verification retry is missing."
    );
    dependencies.setCommandState(
      operation,
      commandId,
      "finished",
      "github-account-missing"
    );
    dependencies.finish(operation, "failed_partial", {
      failure: {
        code: "verification-retry-github-account-missing",
        stage: dependencies.stageVerify,
        stepSeq: null,
        message:
          "Radius cannot retry credential verification because this operation does not name the GitHub account that started it.",
        classification: "user-fixable",
        evidence: null
      }
    });
    await dependencies.persist(operation);
    return;
  }

  const stopBoundary = (boundary: string) =>
    dependencies.stopBoundary({
      operation,
      boundary,
      beforePersist: () =>
        dependencies.setCommandState(
          operation,
          commandId,
          "finished",
          "cancelled"
        )
    });

  const savedBeforeAcquisition = { ...(operation.verification || {}) };
  const retryTargetPhase = verificationRetryTargetPhase(
    savedBeforeAcquisition.accountUnavailablePhase
  );
  let acquisitionDeadline = Number(savedBeforeAcquisition.acquisitionDeadline);
  if (!Number.isFinite(acquisitionDeadline) || acquisitionDeadline <= 0) {
    acquisitionDeadline = dependencies.now() + VERIFICATION_TRACKING_WINDOW_MS;
    operation.verification = {
      ...savedBeforeAcquisition,
      acquisitionPending: true,
      acquisitionDeadline,
      retryCommandId: commandId
    };
    dependencies.setCommandState(operation, commandId, "running");
    if (!(await dependencies.persist(operation))) {
      await failPersistence({
        operation,
        commandId,
        message:
          "Radius could not save the verification retry deadline, so it did not contact GitHub.",
        evidence: null,
        dependencies
      });
      return;
    }
  }

  const acquisition = await acquireSelectedExecutor(
    login,
    acquisitionDeadline,
    dependencies
  );
  if (acquisition.state === "unavailable") {
    await failSelectedAccount({
      operation,
      commandId,
      login,
      evidence: acquisition.detail,
      phase: retryTargetPhase,
      step: `❌ Could not use @${login} to retry credential verification.`,
      dependencies
    });
    return;
  }
  if (acquisition.state === "expired") {
    const copy = verificationAcquisitionExpiredCopy("start", acquisition);
    dependencies.addStep(operation, copy.step);
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
        message: copy.message,
        classification: "user-fixable",
        evidence: acquisition.detail
      }
    });
    operation.verification = {
      ...(operation.verification || {}),
      accountUnavailablePhase: retryTargetPhase
    };
    await dependencies.persist(operation);
    return;
  }

  const executor = acquisition.executor;
  dependencies.registerExecutor(operation.operationId, executor);
  try {
    const saved = operation.verification || {};
    const resumeKnownRun = shouldResumeKnownVerificationRun({
      accountUnavailablePhase: saved.accountUnavailablePhase,
      runId: saved.runId
    });
    if (resumeKnownRun) {
      const trackingDeadline =
        dependencies.now() + VERIFICATION_TRACKING_WINDOW_MS;
      operation.verification = {
        ...saved,
        acquisitionPending: false,
        acquisitionDeadline: trackingDeadline,
        trackingDeadline,
        accountUnavailablePhase: null,
        retryCommandId: commandId
      };
      dependencies.setCommandState(operation, commandId, "running");
      if (!(await dependencies.persist(operation))) {
        operation.verification = {
          ...saved,
          acquisitionPending: true,
          retryCommandId: commandId
        };
        await failPersistence({
          operation,
          commandId,
          message:
            "Radius could not save the verification monitoring retry, so it did not contact GitHub.",
          evidence: null,
          dependencies
        });
        return;
      }
      if (!(await stopBoundary("after-verification-retry-dispatch"))) return;
      await dependencies.monitor(operation.operationId);
      dependencies.setCommandState(
        operation,
        commandId,
        "finished",
        dependencies.currentState(operation.operationId)
      );
      await dependencies.persist(operation);
      return;
    }

    const repo = String(operation.repo || "");
    const workflow = String(saved.workflow || dependencies.verifyWorkflowFile);
    const ref = String(saved.ref || "");
    const environment = String(
      saved.environment || operation.environment || ""
    );
    const operationMarker =
      typeof saved.operationMarker === "string" ? saved.operationMarker : "";
    const previousMutationTarget =
      typeof saved.dispatchMutationTarget === "string" ?
        saved.dispatchMutationTarget
      : "";
    const previousDispatchMutation =
      previousMutationTarget ?
        providerMutationRecord(
          operation,
          "github_workflow.dispatch_retry",
          previousMutationTarget
        )
      : null;
    const reusePreviousMutation =
      previousMutationTarget &&
      shouldReuseVerificationDispatch({
        accountUnavailablePhase: saved.accountUnavailablePhase,
        previousStatus: previousDispatchMutation?.status,
        runId: saved.runId
      });
    const mutationTarget =
      reusePreviousMutation ?
        previousMutationTarget
      : `${repo}:${workflow}:${ref}:${environment}:${commandId}`;
    const trackingDeadline =
      dependencies.now() + VERIFICATION_TRACKING_WINDOW_MS;

    let dispatch;
    let providerRequestStarted = false;
    try {
      dispatch = await runVerificationDispatch({
        operation,
        kind: "github_workflow.dispatch_retry",
        target: mutationTarget,
        repo,
        workflowPath: `.github/workflows/${workflow}`,
        workflowFile: workflow,
        environment,
        ref,
        operationMarker,
        allowRegistrationRetry: false,
        ports: {
          runGh: async (args) => {
            const result = await executor.run(args, { timeout: 30000 });
            if (Number(result.code) !== 0) {
              const authorizationError =
                await dependencies.selectedCommandAuthorizationError(
                  executor,
                  repo,
                  result
                );
              if (authorizationError) throw authorizationError;
            }
            return result;
          },
          sendDispatch: () => {
            providerRequestStarted = true;
            return executor.run(
              dependencies.buildDispatchArgs({
                workflowFile: workflow,
                targetRepo: repo,
                envName: environment,
                ref,
                operationMarker
              }),
              { timeout: 30000 }
            );
          },
          persist: dependencies.persistJournal,
          stopBoundary,
          applyIdentity: (identity, run) => {
            operation.verification = {
              acquisitionDeadline: trackingDeadline,
              trackingDeadline,
              dispatchedAt: identity.dispatchedAt,
              dispatchMutationTarget: mutationTarget,
              accountUnavailablePhase: null,
              workflow,
              ref: identity.ref,
              environment: identity.environment,
              event: "workflow_dispatch",
              operationMarker: identity.operationMarker,
              baselineRunId: identity.baselineRunId,
              runId: run?.runId ?? null,
              runUrl: run?.runUrl ?? null
            };
          },
          terminalizeManualRequired: (guidance) => {
            dependencies.addStep(operation, `⚠️ ${guidance}`);
            dependencies.setCommandState(
              operation,
              commandId,
              "finished",
              "manual-required"
            );
            terminalizeProviderManualRequired(operation, guidance);
          },
          now: dependencies.now,
          sleep: dependencies.sleep
        }
      });
    } catch (error) {
      if (
        error instanceof ProviderMutationRecoveryError &&
        error.code === "provider-mutation-recovery-persistence-failed"
      ) {
        const dispatchMayExist = providerRequestStarted;
        const mutation = providerMutationRecord(
          operation,
          "github_workflow.dispatch_retry",
          mutationTarget
        );
        if (mutation?.status === "manual_required") {
          const guidance =
            mutation.evidence ||
            "Radius could not prove which verification run belongs to this retry.";
          dependencies.addStep(operation, `⚠️ ${guidance}`);
          dependencies.setCommandState(
            operation,
            commandId,
            "finished",
            "manual-required"
          );
          dependencies.finish(operation, "failed_partial", {
            failure: {
              code: "provider-mutation-manual-required",
              stage: dependencies.stageVerify,
              stepSeq: null,
              message: guidance,
              classification: "user-fixable",
              evidence: dependencies.errorMessage(error)
            }
          });
          operation.verification = {
            ...(operation.verification || {}),
            accountUnavailablePhase: "dispatch"
          };
          await dependencies.persist(operation);
          return;
        }
        if (!dispatchMayExist && mutation?.status === "prepared") {
          settleProviderMutation(
            operation,
            mutation.mutationId,
            "not_applied",
            "Radius did not send the verification dispatch because its journal could not be saved."
          );
        }
        dependencies.addStep(
          operation,
          "❌ Could not save the verification dispatch recovery record."
        );
        dependencies.setCommandState(
          operation,
          commandId,
          "finished",
          "persistence-failed"
        );
        dependencies.finish(operation, "failed_partial", {
          failure: {
            code: "verification-retry-persist-failed",
            stage: dependencies.stageVerify,
            stepSeq: null,
            message:
              "Radius could not save the verification dispatch recovery record. Retry after operation storage is available.",
            classification: "system",
            evidence: dependencies.errorMessage(error)
          }
        });
        operation.verification = {
          ...(operation.verification || {}),
          accountUnavailablePhase: dispatchMayExist ? "dispatch" : "acquisition"
        };
        await dependencies.persist(operation);
        return;
      }
      if (!dependencies.isAuthorizationError(error)) throw error;
      await failSelectedAccount({
        operation,
        commandId,
        login,
        evidence: dependencies.errorMessage(error),
        phase: "dispatch",
        step: `❌ Could not use @${login} to read verification runs.`,
        dependencies
      });
      return;
    }

    if (dispatch.state === "cancelled") return;
    if (dispatch.state === "baseline_failed") {
      dependencies.setCommandState(
        operation,
        commandId,
        "finished",
        "baseline-failed"
      );
      dependencies.finish(operation, "failed_partial", {
        failure: {
          code: "verify-dispatch-baseline-failed",
          stage: dependencies.stageVerify,
          stepSeq: null,
          message:
            dispatch.unreadable ?
              "Radius could not establish a readable workflow-run baseline, so it did not dispatch verification."
            : "Radius could not establish a workflow-run baseline, so it did not dispatch verification.",
          classification: "user-fixable",
          evidence: dispatch.detail
        }
      });
      operation.verification = {
        ...(operation.verification || {}),
        accountUnavailablePhase: "dispatch"
      };
      await dependencies.persist(operation);
      return;
    }
    if (dispatch.state === "manual_required") {
      return;
    }
    if (dispatch.state === "rejected") {
      const authorizationError =
        await dependencies.selectedCommandAuthorizationError(
          executor,
          repo,
          dispatch.result
        );
      if (authorizationError) {
        await failSelectedAccount({
          operation,
          commandId,
          login,
          evidence: dependencies.errorMessage(authorizationError),
          phase: "dispatch",
          step: `❌ Could not use @${login} to dispatch verification.`,
          dependencies
        });
        return;
      }
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
          message:
            "Radius could not dispatch the credential verification workflow again.",
          classification: "user-fixable",
          evidence: dispatch.detail
        }
      });
      operation.verification = {
        ...(operation.verification || {}),
        accountUnavailablePhase: "dispatch"
      };
      await dependencies.persist(operation);
      return;
    }

    dependencies.addStep(
      operation,
      "✅ Verify workflow dispatched again.",
      dependencies.stageVerify
    );
    dependencies.setCommandState(operation, commandId, "running");
    await dependencies.persist(operation);
    if (!(await stopBoundary("after-verification-retry-dispatch"))) return;
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
