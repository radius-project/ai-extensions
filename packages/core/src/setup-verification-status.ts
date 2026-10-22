import { WORKFLOW_READ_LIMITS } from "./workflow-read-policy.js";
import type { WorkflowReadDecision } from "./workflow-read-policy.js";
import type { SetupVerificationObservation } from "./setup-verification-monitor.js";
import { classifyVerifyFailure } from "./verify-failure-classification.js";
import { redactCredentials } from "./credential-redaction.js";
import {
  confirmedWorkflowConclusion,
  type WorkflowRunDetail,
  type WorkflowStep
} from "./workflow-observation.js";

export interface SetupVerificationStatusInput {
  repo: string;
  operationId: string;
  environment?: string;
}

export type SetupVerificationRunDetail = Pick<
  WorkflowRunDetail,
  "status" | "conclusion"
> & { steps?: WorkflowStep[] };

export interface SetupVerificationReadRequest {
  onDecision?: (decision: WorkflowReadDecision) => void;
}

export interface SetupVerificationStatusOperation {
  repo?: unknown;
  environment?: unknown;
  state?: unknown;
  currentStage?: unknown;
  context?: Record<string, unknown> | null;
  verification?: Record<string, unknown> | null;
}

export type SetupVerificationStatus = SetupVerificationObservation &
  Record<string, unknown> & { observationStopped?: boolean };

export interface SetupVerificationStatusPorts<
  Executor extends object,
  Request extends SetupVerificationReadRequest
> {
  prepare(): void;
  getOperation(operationId: string): unknown;
  resolveRunId(
    operation: SetupVerificationStatusOperation | null | undefined
  ): string | number | null;
  getSelectedGitHubExecutor(operationId: string): Executor | null | undefined;
  isSelectedGitHubAuthorizationError(error: unknown): boolean;
  hasCompleteVerificationIdentity(operation: unknown): boolean;
  observe(executor: Executor | undefined, timeout: number): Request | undefined;
  observationStopped(): boolean;
  readLimitReason(
    error: unknown
  ): "timeout" | "output-limit" | "cancelled" | undefined;
  getRunDetail(
    repo: string,
    runId: number | string,
    executor?: Executor,
    request?: Request
  ): Promise<SetupVerificationRunDetail | null>;
  fetchRunLog(
    repo: string,
    runId: number | string,
    executor?: Executor,
    request?: Request
  ): Promise<string | null>;
  extractErrorLines(logText?: string | null, max?: number): string[];
  extractGitHubActionsStepLog(
    logText: string | null | undefined,
    stepName: string
  ): string;
  explainOidcEnterpriseClaim(logText?: string | null): string;
  explainNoSubscriptions(logText?: string | null): string;
  addLegacyStep(operation: unknown, text: string): unknown;
  isTerminalState(state: unknown): boolean;
  finish(operation: unknown, state: unknown, options?: unknown): unknown;
  finishSucceeded(operation: unknown): unknown;
  persistBestEffort(input: {
    operation: unknown;
    persist: () => Promise<void>;
    report?: (diagnostic: { code: string; message: string }) => void;
  }): Promise<boolean>;
  persistOperations(): Promise<void>;
  reportOperationDiagnostic(diagnostic: {
    code: string;
    message: string;
  }): void;
  errorMessage(error: unknown): string;
  redactDiagnostic(value: string): string;
  stageVerify: string;
}

const DIAGNOSTIC_MAX_CHARS = 4000;
const HELP_MAX_CHARS = 1000;
const MISSING_PERMISSIONS_MAX = 8;

function result(
  body: SetupVerificationStatus,
  observationStopped = false
): SetupVerificationStatus {
  return observationStopped ? { ...body, observationStopped: true } : body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOperation(
  value: unknown
): SetupVerificationStatusOperation | undefined {
  if (
    !isRecord(value) ||
    (value.context != null && !isRecord(value.context)) ||
    (value.verification != null && !isRecord(value.verification))
  ) {
    return undefined;
  }
  return value;
}

function savedLogin(
  operation: SetupVerificationStatusOperation | null | undefined
): string {
  const value = operation?.context?.githubLogin;
  return typeof value === "string" ? value.trim() : "";
}

export function isAzureRbacVerificationFailure(
  failedSteps: readonly { name?: string }[],
  log: string,
  noSubscriptionsHelp: string
): boolean {
  if (noSubscriptionsHelp !== "") return true;
  const failedAtAzureAccess = failedSteps.some((step) =>
    /verify.*(?:aks|azure).*access/i.test(String(step.name))
  );
  if (!failedAtAzureAccess) return false;
  return /(?:AuthorizationFailed|\bForbidden\b|does not have authorization|not authorized|insufficient privileges|role assignment|cannot (?:get|list|create|update|patch|delete) resource)/i.test(
    log
  );
}

export async function readSetupVerificationStatus<
  Executor extends object,
  Request extends SetupVerificationReadRequest
>(
  input: SetupVerificationStatusInput,
  dependencies: SetupVerificationStatusPorts<Executor, Request>
): Promise<SetupVerificationStatus> {
  if (typeof dependencies.redactDiagnostic !== "function") {
    throw new Error("Verification diagnostics require a credential redactor.");
  }
  const redact = (value: string) =>
    redactCredentials(dependencies.redactDiagnostic(value));
  const bounded = (value: string) => value.slice(0, DIAGNOSTIC_MAX_CHARS);
  const diagnostic = (value: string) => bounded(redact(value));
  const repo = input.repo;
  const operationId = input.operationId || "";
  if (!repo) {
    return result({ state: "unknown", error: "No repository specified." });
  }

  let verificationRequest:
    | {
        operation: SetupVerificationStatusOperation;
        githubLogin: string;
        runId: string | number;
        dispatchedAt: string;
        dispatchMutationTarget: string;
        retryCommandId: string;
      }
    | undefined;
  const isCurrentVerificationRequest = (): boolean => {
    if (!verificationRequest) return true;
    const current: SetupVerificationStatusOperation | undefined = readOperation(
      dependencies.getOperation(operationId)
    );
    const verification = current?.verification || {};
    return (
      current === verificationRequest.operation &&
      savedLogin(current) === verificationRequest.githubLogin &&
      String(verification.runId || "") === String(verificationRequest.runId) &&
      String(verification.dispatchedAt || "") ===
        verificationRequest.dispatchedAt &&
      String(verification.dispatchMutationTarget || "") ===
        verificationRequest.dispatchMutationTarget &&
      String(verification.retryCommandId || "") ===
        verificationRequest.retryCommandId
    );
  };
  const respondWithCurrentVerification = (): SetupVerificationStatus => {
    const current = readOperation(dependencies.getOperation(operationId));
    return result({
      state: "pending",
      runId: current?.verification?.runId || null
    });
  };

  try {
    dependencies.prepare();
    const verifyOp: SetupVerificationStatusOperation | null | undefined =
      operationId ?
        readOperation(dependencies.getOperation(operationId))
      : null;
    if (
      operationId &&
      (!verifyOp ||
        verifyOp.repo !== repo ||
        verifyOp.environment !== (input.environment || verifyOp.environment))
    ) {
      return result({
        state: "expired",
        terminal: true,
        error: "The verification operation does not match this request."
      });
    }
    const pinnedLogin = savedLogin(verifyOp);
    if (operationId && verifyOp && !pinnedLogin) {
      dependencies.addLegacyStep(
        verifyOp,
        "❌ The saved GitHub account for credential verification is missing."
      );
      dependencies.finish(verifyOp, "failed_partial", {
        failure: {
          code: "verification-retry-github-account-missing",
          stage: verifyOp.currentStage,
          stepSeq: null,
          message:
            "Radius cannot monitor credential verification because this operation does not name the GitHub account that started it. Start a new environment setup after re-checking the account.",
          classification: "user-fixable",
          evidence: null
        }
      });
      await dependencies.persistBestEffort({
        operation: verifyOp,
        persist: dependencies.persistOperations,
        report: dependencies.reportOperationDiagnostic
      });
      return result({
        state: "failed",
        terminal: true,
        code: "verification-retry-github-account-missing",
        runId: verifyOp.verification?.runId || null,
        error:
          "Radius cannot monitor credential verification because this operation does not name the GitHub account that started it."
      });
    }
    if (verifyOp?.verification?.acquisitionPending === true) {
      return result({ state: "pending", runId: null });
    }
    if (verifyOp && !dependencies.hasCompleteVerificationIdentity(verifyOp)) {
      return result({
        state: "expired",
        terminal: true,
        error: "The verification operation has incomplete dispatch identity."
      });
    }
    const selectedExecutor =
      operationId ?
        dependencies.getSelectedGitHubExecutor(operationId) || undefined
      : undefined;
    if (operationId && pinnedLogin && !selectedExecutor) {
      return result({
        state: "pending",
        runId: verifyOp?.verification?.runId || null
      });
    }
    const runId: number | string | null = dependencies.resolveRunId(verifyOp);
    if (!runId) {
      // GitHub's run-list response has no operation-specific dispatch marker.
      // Baseline ID and time can narrow candidates but cannot prove identity, so
      // monitoring must wait for a run ID established by a stronger contract.
      return result({ state: "pending", runId: null });
    }
    if (operationId && verifyOp && selectedExecutor) {
      verificationRequest = {
        operation: verifyOp,
        githubLogin: pinnedLogin,
        runId,
        dispatchedAt: String(verifyOp.verification?.dispatchedAt || ""),
        dispatchMutationTarget: String(
          verifyOp.verification?.dispatchMutationTarget || ""
        ),
        retryCommandId: String(verifyOp.verification?.retryCommandId || "")
      };
    }

    const observation = dependencies.observe(
      selectedExecutor,
      WORKFLOW_READ_LIMITS.verificationMs
    );
    let readNotice: string | null = null;
    if (observation)
      observation.onDecision = (decision) => {
        if (decision.state !== "ready" && decision.reason !== "ineligible")
          readNotice = `Workflow evidence ${decision.state}: ${decision.reason}.`;
      };
    const detail =
      selectedExecutor ?
        await dependencies.getRunDetail(
          repo,
          runId,
          selectedExecutor,
          observation
        )
      : await dependencies.getRunDetail(repo, runId, undefined, observation);
    if (dependencies.observationStopped()) {
      return result(
        { state: "pending", error: "Workflow observation stopped." },
        true
      );
    }
    if (!isCurrentVerificationRequest()) {
      return respondWithCurrentVerification();
    }
    const runUrl = "https://github.com/" + repo + "/actions/runs/" + runId;
    if (!detail) {
      return result({
        state: "pending",
        runId,
        runUrl,
        ...(readNotice ? { activity: readNotice } : {})
      });
    }
    const steps = (detail.steps || []).map((step) => ({
      ...step,
      name: typeof step.name === "string" ? diagnostic(step.name) : undefined
    }));

    if (detail.status !== "completed") {
      // Name what the run is doing right now instead of leaving the caller with
      // nothing but elapsed time. getRunDetail already returns per-step status,
      // so this costs no extra API surface. Its jobs sub-resource 503s
      // intermittently and the fallback deliberately returns no steps, so the
      // activity line has to degrade silently rather than announce its absence.
      const active = steps.find((s) => s.status === "in_progress");
      return result({
        state: "in_progress",
        runId,
        runUrl,
        activity: active ? active.name : readNotice
      });
    }
    const conclusion = confirmedWorkflowConclusion(detail);
    if (!conclusion) {
      return result({
        state: "unknown",
        runId,
        runUrl,
        error:
          "The verification workflow completed without a supported conclusion."
      });
    }
    if (conclusion === "success") {
      if (
        verifyOp &&
        verifyOp.currentStage === dependencies.stageVerify &&
        !dependencies.isTerminalState(verifyOp.state)
      ) {
        dependencies.addLegacyStep(
          verifyOp,
          "✅ Environment created. Deploy your application from the Environments list when ready."
        );
        dependencies.finishSucceeded(verifyOp);
        await dependencies.persistBestEffort({
          operation: verifyOp,
          persist: () => dependencies.persistOperations(),
          report: (diagnostic) =>
            dependencies.reportOperationDiagnostic(diagnostic)
        });
      }
      return result({ state: "success", runId, runUrl });
    }
    // Failed — surface the failing step + a few error lines.
    const failed = steps.filter(
      (s) =>
        s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped"
    );
    let errMsg = `Credential verification failed (${conclusion}).`;
    if (failed.length)
      errMsg += " Failed step: " + failed.map((s) => s.name).join(", ") + ".";
    if (readNotice) errMsg += "\n" + readNotice;
    let log: string | null = null;
    try {
      log =
        selectedExecutor ?
          await dependencies.fetchRunLog(
            repo,
            runId,
            selectedExecutor,
            observation
          )
        : await dependencies.fetchRunLog(repo, runId, undefined, observation);
    } catch (error) {
      const reason = dependencies.readLimitReason(error);
      if (
        reason === "cancelled" ||
        dependencies.isSelectedGitHubAuthorizationError(error)
      )
        throw error;
      errMsg +=
        "\nThe verification log could not be read: " +
        (reason === "timeout" ? "the read timed out."
        : reason === "output-limit" ? "the output limit was exceeded."
        : diagnostic(dependencies.errorMessage(error)));
    }
    if (dependencies.observationStopped()) {
      return result(
        { state: "pending", error: "Workflow observation stopped." },
        true
      );
    }
    if (!isCurrentVerificationRequest()) {
      return respondWithCurrentVerification();
    }
    log = redact(log || "");
    const lines = dependencies.extractErrorLines(log, 8).map(diagnostic);
    if (lines.length) errMsg += "\n" + lines.join("\n");
    const azureLoginLog = dependencies.extractGitHubActionsStepLog(
      log,
      "Azure Login (OIDC)"
    );
    // Distinct failure stages (OIDC enterprise-claim rejection vs. a successful
    // login with no visible subscription — issue #219), so at most one applies;
    // take the first match so the raw-error separator is never emitted twice.
    const oidcHelp = diagnostic(
      dependencies.explainOidcEnterpriseClaim(azureLoginLog)
    );
    const noSubscriptionsHelp =
      oidcHelp === "" ?
        diagnostic(dependencies.explainNoSubscriptions(log))
      : "";
    const failureHelp = (oidcHelp || noSubscriptionsHelp).slice(
      0,
      HELP_MAX_CHARS
    );
    if (failureHelp)
      errMsg = failureHelp + "\n\n\u2014 raw error \u2014\n" + errMsg;
    errMsg = bounded(errMsg);
    const classification = classifyVerifyFailure({
      failedSteps: failed,
      log: log || "",
      oidcHelp,
      noSubscriptionsHelp
    });
    if (
      verifyOp &&
      verifyOp.currentStage === dependencies.stageVerify &&
      !dependencies.isTerminalState(verifyOp.state)
    ) {
      const failedAtAzureAccess = isAzureRbacVerificationFailure(
        failed,
        log || "",
        noSubscriptionsHelp
      );
      // Everything before verification succeeded and still exists, so this is
      // partial rather than total failure. Only a positively identified Azure
      // access failure gets propagation copy; OIDC, workflow, and runner failures
      // retain the generic verification classification.
      dependencies.finish(verifyOp, "failed_partial", {
        failure: {
          code:
            failedAtAzureAccess ?
              "verify-run-rbac-failed"
            : "verify-run-failed",
          stage: dependencies.stageVerify,
          message: bounded(
            "Credential verification failed. " +
              (failed.length ?
                "Failed step: " + failed.map((st) => st.name).join(", ") + "."
              : "")
          ),
          classification: "user-fixable",
          evidence: errMsg
        }
      });
      await dependencies.persistBestEffort({
        operation: verifyOp,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic)
      });
    }
    return result({
      state: "failed",
      runId,
      runUrl,
      error: errMsg,
      category: classification.category,
      ...(classification.component ?
        { component: classification.component }
      : {}),
      ...((
        classification.missingPermissions &&
        classification.missingPermissions.length > 0
      ) ?
        {
          missingPermissions: classification.missingPermissions
            .slice(0, MISSING_PERMISSIONS_MAX)
            .map(diagnostic)
        }
      : {}),
      ...(classification.detail ?
        { detail: diagnostic(classification.detail) }
      : {})
    });
  } catch (e) {
    if (dependencies.observationStopped()) {
      return result(
        { state: "pending", error: "Workflow observation stopped." },
        true
      );
    }
    if (!isCurrentVerificationRequest()) {
      return respondWithCurrentVerification();
    }
    if (
      verificationRequest &&
      !dependencies.isTerminalState(verificationRequest.operation.state) &&
      dependencies.isSelectedGitHubAuthorizationError(e)
    ) {
      const failedOperation = verificationRequest.operation;
      const account = diagnostic(`@${verificationRequest.githubLogin}`);
      const message = bounded(
        `Radius could not use ${account} to monitor credential verification. Re-check that account and retry verification.`
      );
      const evidence = diagnostic(dependencies.errorMessage(e));
      dependencies.addLegacyStep(
        failedOperation,
        `❌ Could not use ${account} to monitor credential verification.`
      );
      failedOperation.verification = {
        ...failedOperation.verification,
        accountUnavailablePhase: "monitor"
      };
      dependencies.finish(failedOperation, "failed_partial", {
        failure: {
          code: "verification-retry-github-account-unavailable",
          stage: dependencies.stageVerify,
          stepSeq: null,
          message,
          classification: "user-fixable",
          evidence
        }
      });
      await dependencies.persistBestEffort({
        operation: failedOperation,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic)
      });
      return result({
        state: "failed",
        terminal: true,
        code: "verification-retry-github-account-unavailable",
        runId: verificationRequest.runId,
        error: message
      });
    }
    return result({
      state: "unknown",
      error: diagnostic(dependencies.errorMessage(e))
    });
  }
}
