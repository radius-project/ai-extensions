import type { SelectedGhExecutor } from "../../gh.js";
import {
  providerMutationRecord,
  settleProviderMutation
} from "../../operations.js";
import {
  findExactVerificationRun,
  hasPostDispatchVerificationRuns
} from "../../verification-run-identity.js";
import {
  executeRecoverableMutation,
  ProviderMutationRecoveryError,
  providerMutationWillWrite,
  type ProviderMutationCommandResult
} from "./provider-mutation-recovery.js";
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

export async function resolveAcknowledgedVerificationRun(input: {
  operationMarker: string;
  pause(milliseconds: number): Promise<void>;
  discover(): Promise<
    | { state: "applied"; value: string }
    | { state: "manual_required"; guidance: string }
  >;
  actionsUrl: string;
  isAuthorizationError?(error: unknown): boolean;
}): Promise<
  | { state: "applied"; runId: string }
  | { state: "manual_required"; guidance: string }
> {
  if (!input.operationMarker) {
    return {
      state: "manual_required",
      guidance:
        `The installed verification workflow does not expose Radius's operation marker. Check ${input.actionsUrl}; ` +
        "Radius will not guess which run belongs to this retry or dispatch another run."
    };
  }
  await input.pause(5000);
  try {
    const discovered = await input.discover();
    return discovered.state === "applied" ?
        { state: "applied", runId: discovered.value }
      : discovered;
  } catch (error) {
    if (input.isAuthorizationError?.(error)) throw error;
    return {
      state: "manual_required",
      guidance:
        `GitHub accepted verification, but Radius could not confirm the exact marked run. Review ${input.actionsUrl}. ` +
        "Radius will not adopt or redispatch a run."
    };
  }
}

export function parseVerificationBaselineRunId(stdout: string): number | null {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub returned a non-array workflow run list.");
  }
  if (
    parsed.some((run) => {
      if (run === null || typeof run !== "object") return true;
      const id = (run as { databaseId?: unknown }).databaseId;
      return typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0;
    })
  ) {
    throw new Error(
      "GitHub returned a workflow run without a valid databaseId."
    );
  }
  return parsed.reduce<number | null>((latest, run) => {
    const id = (run as { databaseId: number }).databaseId;
    return latest === null || id > latest ? id : latest;
  }, null);
}

function selectedLogin(operation: VerificationRetryOperation): string {
  return typeof operation.context?.githubLogin === "string" ?
      operation.context.githubLogin.trim()
    : "";
}

function actionsUrl(repo: string, workflow: string): string {
  return (
    `https://github.com/${repo}/actions/workflows/` +
    encodeURIComponent(workflow)
  );
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
    const verificationActionsUrl = actionsUrl(repo, workflow);
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
    const existingMutation = providerMutationRecord(
      operation,
      "github_workflow.dispatch_retry",
      mutationTarget
    );
    const existingDispatchMayExist =
      existingMutation?.status === "prepared" ||
      existingMutation?.status === "outcome_unknown" ||
      (existingMutation?.status === "confirmed" &&
        (saved.runId == null || !String(saved.runId)));
    const replayRejectedMutation = existingMutation?.status === "not_applied";
    const dispatchedAt =
      (
        existingMutation &&
        !replayRejectedMutation &&
        Number.isFinite(Number(saved.dispatchedAt))
      ) ?
        Number(saved.dispatchedAt)
      : dependencies.now();
    const trackingDeadline =
      dependencies.now() + VERIFICATION_TRACKING_WINDOW_MS;
    let baselineRunId =
      (
        existingMutation &&
        !replayRejectedMutation &&
        Number.isFinite(Number(saved.baselineRunId))
      ) ?
        Number(saved.baselineRunId)
      : null;

    if (!existingMutation || replayRejectedMutation) {
      const baseline = await executor.run(
        [
          "run",
          "list",
          "--workflow=" + workflow,
          "--limit",
          "10",
          "--json",
          "databaseId",
          "--repo",
          repo
        ],
        { timeout: 30000 }
      );
      if (Number(baseline.code) !== 0) {
        const authorizationError =
          await dependencies.selectedCommandAuthorizationError(
            executor,
            repo,
            baseline
          );
        if (authorizationError) {
          await failSelectedAccount({
            operation,
            commandId,
            login,
            evidence: dependencies.errorMessage(authorizationError),
            phase: "dispatch",
            step: `❌ Could not use @${login} to read verification runs.`,
            dependencies
          });
          return;
        }
        const detail =
          (baseline.stderr || baseline.stdout || "").trim() ||
          "The GitHub CLI request failed.";
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
              "Radius could not establish a workflow-run baseline, so it did not dispatch verification.",
            classification: "user-fixable",
            evidence: detail
          }
        });
        operation.verification = {
          ...(operation.verification || {}),
          accountUnavailablePhase: "dispatch"
        };
        await dependencies.persist(operation);
        return;
      }
      try {
        baselineRunId = parseVerificationBaselineRunId(baseline.stdout);
      } catch (error) {
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
              "Radius could not establish a readable workflow-run baseline, so it did not dispatch verification.",
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
    }

    operation.verification = {
      acquisitionDeadline: trackingDeadline,
      trackingDeadline,
      dispatchedAt,
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: null,
      workflow,
      ref,
      environment,
      event: "workflow_dispatch",
      operationMarker: operationMarker || null,
      baselineRunId,
      runId: null,
      runUrl: null
    };

    if (
      providerMutationWillWrite(
        operation,
        "github_workflow.dispatch_retry",
        mutationTarget
      ) &&
      !(await stopBoundary("before-verification-retry-dispatch-attempt"))
    ) {
      return;
    }

    const discoverAcceptedRun = async () => {
      const listed = await executor.run(
        [
          "run",
          "list",
          "--workflow=" + workflow,
          "--limit",
          "10",
          "--json",
          "databaseId,createdAt,displayTitle,event,headBranch",
          "--repo",
          repo
        ],
        { timeout: 30000 }
      );
      if (Number(listed.code) !== 0) {
        const authorizationError =
          await dependencies.selectedCommandAuthorizationError(
            executor,
            repo,
            listed
          );
        if (authorizationError) throw authorizationError;
        throw new Error(
          listed.stderr ||
            listed.stdout ||
            "GitHub workflow runs could not be read."
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(listed.stdout);
      } catch {
        throw new Error("GitHub returned an unreadable workflow run list.");
      }
      if (!operationMarker) {
        return {
          state: "manual_required" as const,
          guidance:
            `The installed verification workflow does not expose Radius's operation marker. Check ${verificationActionsUrl}; ` +
            "Radius will not guess which run belongs to this retry or dispatch another run."
        };
      }
      const exact = findExactVerificationRun(parsed, {
        baselineRunId,
        dispatchedAt,
        ref,
        environment,
        operationMarker
      });
      if (exact.state === "applied") {
        return {
          state: "applied" as const,
          value: exact.runId,
          evidence:
            "The workflow, ref, environment, event, and operation-specific run title matched exactly."
        };
      }
      if (exact.state === "ambiguous") {
        return {
          state: "manual_required" as const,
          guidance:
            `Multiple verification retry runs carry this operation's exact marker. Check ${verificationActionsUrl}; ` +
            "Radius will not choose one or dispatch another run."
        };
      }
      if (
        hasPostDispatchVerificationRuns(parsed, baselineRunId, dispatchedAt)
      ) {
        return {
          state: "manual_required" as const,
          guidance:
            "GitHub exposed one or more new verification retry runs, but none " +
            "matches this operation's exact workflow/ref/environment/event marker. " +
            `Check ${verificationActionsUrl}; Radius will not adopt or redispatch a run.`
        };
      }
      throw new Error(
        "GitHub has not exposed the accepted verification retry run yet."
      );
    };

    let dispatch;
    let providerRequestStarted = false;
    try {
      dispatch = await executeRecoverableMutation({
        operation,
        kind: "github_workflow.dispatch_retry",
        target: mutationTarget,
        providerIdempotencyKey: operationMarker || null,
        persist: dependencies.persistJournal,
        beforeMutation: () =>
          stopBoundary("before-verification-retry-dispatch-attempt"),
        mutate: () => {
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
        accept: () => "",
        reconcile: discoverAcceptedRun,
        rethrowReconciliationError: dependencies.isAuthorizationError
      });
    } catch (error) {
      if (
        error instanceof ProviderMutationRecoveryError &&
        error.code === "provider-mutation-recovery-persistence-failed"
      ) {
        const dispatchMayExist =
          providerRequestStarted || existingDispatchMayExist;
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
    if (dispatch.state === "not_applied") {
      const rejected = dispatch.result;
      const authorizationError =
        rejected ?
          await dependencies.selectedCommandAuthorizationError(
            executor,
            repo,
            rejected
          )
        : null;
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
      const detail =
        (rejected?.stderr || rejected?.stdout || "").trim() ||
        "The GitHub CLI request failed.";
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
          evidence: detail
        }
      });
      operation.verification = {
        ...(operation.verification || {}),
        accountUnavailablePhase: "dispatch"
      };
      await dependencies.persist(operation);
      return;
    }

    let acceptedRunId =
      dispatch.state === "applied" && dispatch.recovered ?
        String(dispatch.value)
      : null;
    let verificationManualGuidance = "";
    if (!acceptedRunId) {
      let adoption;
      try {
        adoption = await resolveAcknowledgedVerificationRun({
          operationMarker,
          pause: dependencies.sleep,
          discover: discoverAcceptedRun,
          actionsUrl: verificationActionsUrl,
          isAuthorizationError: dependencies.isAuthorizationError
        });
      } catch (error) {
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
      if (adoption.state === "applied") {
        acceptedRunId = adoption.runId;
      } else {
        verificationManualGuidance = adoption.guidance;
      }
    }

    operation.verification = {
      acquisitionDeadline: trackingDeadline,
      trackingDeadline,
      dispatchedAt,
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: null,
      workflow,
      ref,
      environment,
      event: "workflow_dispatch",
      operationMarker: operationMarker || null,
      baselineRunId,
      runId: acceptedRunId,
      runUrl:
        acceptedRunId ?
          `https://github.com/${repo}/actions/runs/${acceptedRunId}`
        : null
    };
    dependencies.addStep(
      operation,
      "✅ Verify workflow dispatched again.",
      dependencies.stageVerify
    );
    if (!operation.verification.runId) {
      operation.verification.runUrl = verificationActionsUrl;
      dependencies.setCommandState(
        operation,
        commandId,
        "finished",
        "action_required"
      );
      dependencies.finish(operation, "action_required", {
        terminal: {
          reason: "verification-run-manual",
          userMessage: verificationManualGuidance
        }
      });
      await dependencies.persist(operation);
      return;
    }
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
