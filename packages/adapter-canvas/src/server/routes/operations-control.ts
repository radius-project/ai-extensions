import type { CanvasRequestContext } from "../request-context.js";
import {
  templatePathParameters,
  type RouteHandlerRegistry
} from "../route-table.js";
import type { OperationCommandKind } from "../../operations.js";
import type { OperationRecord } from "./operations-status.js";

// Cooperative controls for an environment operation: stop, and the three
// retries (setup continuation, verification, cleanup).
//
// All four share one shape, and the order is the safety property: read the
// saved record, decide from the saved record alone, durably record the command
// before the caller is told it was accepted, and only then schedule work.
// Nothing here deploys the application — that stays a separate customer action.
//
// The handlers stay thin. Eligibility lives in `operations.ts`, the merge proof
// lives in `services/setup-pull-request.ts`, and every seam below is a single
// function so a test fake can throw on anything a given route must not reach.

// Declared alongside the handlers that read their path variables, mirroring the
// resume and abandon routes in `operations-status.ts`, so a template and the
// code that destructures it cannot drift apart.
export const STOP_OPERATION_ROUTE = "/api/operations/:operationId/stop";
export const RETRY_OPERATION_ROUTE =
  "/api/operations/:operationId/retry/:retryKind";

export type OperationRetryKind = "setup" | "verification" | "cleanup";

export type RetryEligibility = {
  ok: boolean;
  code: string;
  detail?: string;
  resumeFrom?: string;
  classification?: string;
  requiresMergedPullRequest?: boolean;
  pullRequestUrl?: string | null;
};

export type StopRequestOutcome =
  | "cancelled"
  | "pending"
  | "already_requested"
  | "already_stopped"
  | "terminal";

export type AcceptedCommand = {
  ok: boolean;
  duplicate: boolean;
  command: { commandId: string } | null;
};

export type RepositoryLockResult =
  { ok: true } | { ok: false; conflict: { operationId: string } };

export interface OperationsControlDependencies {
  // --- registry ---
  get(operationId: string): OperationRecord | null;
  // Takes the repository lock back for a retry of a record that already owns
  // it. A different live attempt wins, which is what keeps a retry from running
  // beside a fresh setup for the same repository.
  acquireForRetry(operation: OperationRecord): RepositoryLockResult;
  persistOperations(): Promise<void>;
  toClientView(operation: OperationRecord): unknown;

  // --- operation model ---
  applyStopRequest(
    operation: OperationRecord,
    options: { announce: boolean }
  ): { outcome: StopRequestOutcome; duplicate: boolean };
  // Announces a terminal record whose announcement was deferred until the
  // durable write succeeded. Announcing a cancellation that a failed write then
  // rolls back would tell the customer their setup ended when it did not.
  announceOperationTerminal(operation: OperationRecord): boolean;
  snapshotRetryState(operation: OperationRecord): unknown;
  rollbackRetryAttempt(operation: OperationRecord, snapshot: unknown): void;
  beginRetryAttempt(
    operation: OperationRecord,
    kind: OperationRetryKind
  ): number;
  acceptCommand(
    operation: OperationRecord,
    input: { kind: OperationCommandKind; attempt: number; target: string }
  ): AcceptedCommand;
  setCommandState(
    operation: OperationRecord,
    commandId: string,
    state: "accepted" | "running" | "finished",
    outcome?: string | null
  ): unknown;
  canRetrySetup(operation: OperationRecord): RetryEligibility;
  canRetryVerification(operation: OperationRecord): RetryEligibility;
  canRetryCleanup(operation: OperationRecord): RetryEligibility;
  applySetupResumePoint(operation: OperationRecord, resumeFrom: unknown): void;
  setStageState(operation: OperationRecord, stage: string, state: string): void;
  enterStage(operation: OperationRecord, stage: string): void;
  finish(
    operation: OperationRecord,
    state: string,
    options: { failure: Record<string, unknown> }
  ): void;
  stageVerify: string;

  // --- external proof ---
  isPullRequestMerged(
    operation: OperationRecord,
    pullRequestUrl: string | null
  ): Promise<boolean>;

  // --- server-owned execution ---
  // Each returns whether a runner actually accepted the work. Scheduling is
  // per-instance closure state, so the instance that received the request is
  // passed through and the composition root resolves the right runner; a miss
  // must close the reopened record rather than leave it durably `running` with
  // nothing behind it.
  scheduleSetupContinuation(
    instanceId: string,
    operation: OperationRecord
  ): boolean;
  scheduleVerificationRetry(
    instanceId: string,
    operation: OperationRecord,
    commandId: string
  ): boolean;
  scheduleCleanupRetry(
    instanceId: string,
    operation: OperationRecord,
    commandId: string
  ): boolean;
  errorMessage(error: unknown): string;
}

const RETRY_KINDS: readonly OperationRetryKind[] = [
  "setup",
  "verification",
  "cleanup"
];

const RETRY_COMMAND_KINDS: Readonly<
  Record<OperationRetryKind, OperationCommandKind>
> = {
  setup: "retry_setup",
  verification: "retry_verification",
  cleanup: "retry_cleanup"
};

/**
 * Explain a refused retry in the customer's terms.
 *
 * Each string maps to one closed refusal code so the page never has to guess at
 * a reason, and an unrecognised code degrades to the honest general statement
 * rather than an invented cause.
 */
export function retryRefusalMessage(kind: string, code: string): string {
  const messages: Record<string, string> = {
    "unknown-operation": "Radius has no record of this operation.",
    "operation-active":
      "This setup is still running, so there is nothing to retry yet.",
    "verification-retry-not-retryable":
      "This result is not one Radius can fix by checking credentials again.",
    "verification-provenance-incomplete":
      "Radius did not save enough of the workflow, branch, and identity details to repeat verification safely.",
    "setup-retry-not-retryable":
      "Only a stopped or partially failed setup can be continued.",
    "setup-retry-request-missing":
      "Radius no longer holds the environment details needed to continue this setup.",
    "setup-retry-ownership-ambiguous":
      "Radius cannot prove what it created during this attempt, so continuing could duplicate a resource. Review the listed resources first.",
    "cleanup-retry-not-retryable":
      "The last cleanup attempt did not leave anything Radius can safely retry.",
    "cleanup-retry-after-commit":
      "The workflows were already committed, so these resources are retained on purpose rather than removed.",
    "cleanup-retry-nothing-unresolved":
      "Every resource Radius proved it created has already been removed.",
    "cleanup-retry-ledger-missing":
      "Radius has no record of resources it created for this setup."
  };
  return (
    messages[code] ||
    `Radius cannot retry ${kind} for this operation (${code}).`
  );
}

function isRetryKind(value: string): value is OperationRetryKind {
  return (RETRY_KINDS as readonly string[]).includes(value);
}

/**
 * Percent-decode one path variable.
 *
 * A malformed escape such as `%` is a bad request, not a crash: `decodeURIComponent`
 * throws on it, and letting that throw escape the handler would leave the
 * request hanging with no response at all.
 */
function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function statusUrlFor(operationId: string): string {
  return `/api/operations/${encodeURIComponent(operationId)}`;
}

function sendJson(
  context: CanvasRequestContext,
  status: number,
  payload: Record<string, unknown>
): void {
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  context.response.writeHead(status);
  context.response.end(JSON.stringify(payload));
}

function unknownOperation(context: CanvasRequestContext): void {
  sendJson(context, 404, {
    error: "Unknown operation.",
    code: "unknown-operation"
  });
}

// The declared body policy is `json`, and the client sends `{}`, but no control
// decision is taken from the body: every input is the saved record plus the
// path. The body is still drained so the request is fully consumed before the
// response ends.
async function resolveOperation(
  context: CanvasRequestContext,
  template: string,
  dependencies: Pick<OperationsControlDependencies, "get">
): Promise<{
  operationId: string;
  operation: OperationRecord;
  params: Readonly<Record<string, string>>;
} | null> {
  await context.readTextBody();
  const params = templatePathParameters(template, context.pathname);
  const operationId = params ? decodeSegment(params.operationId) : null;
  const operation = operationId ? dependencies.get(operationId) : null;
  if (!params || !operationId || !operation) {
    unknownOperation(context);
    return null;
  }
  return { operationId, operation, params };
}

/**
 * Record a customer stop request.
 *
 * An operation parked on a prompt has nothing in flight, so it cancels at once;
 * anything else records the request and lets the executor stop at its next safe
 * boundary. Either way the request is durable before the caller hears that it
 * was accepted, so a canvas reload or an extension restart cannot lose it.
 */
export async function handleStopOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  const resolved = await resolveOperation(
    context,
    STOP_OPERATION_ROUTE,
    dependencies
  );
  if (!resolved) return;
  const { operationId, operation } = resolved;

  const snapshot = dependencies.snapshotRetryState(operation);
  // Announcing is deferred until the write lands: a cancellation that a failed
  // write rolls back must never be reported as an ended setup.
  const result = dependencies.applyStopRequest(operation, { announce: false });
  if (result.outcome === "terminal") {
    sendJson(context, 409, {
      error:
        "This operation already finished, so there is nothing left to stop.",
      code: "operation-already-terminal",
      operationId,
      operation: dependencies.toClientView(operation)
    });
    return;
  }
  if (result.outcome === "already_stopped") {
    sendJson(context, 200, {
      operationId,
      code: "operation-stopped",
      statusUrl: statusUrlFor(operationId),
      operation: dependencies.toClientView(operation)
    });
    return;
  }
  try {
    await dependencies.persistOperations();
  } catch (error) {
    // The stop was never durable, so the in-memory record goes back exactly as
    // it was rather than reporting a command Radius would forget on restart.
    dependencies.rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 500, {
      error:
        "Radius could not save the stop request, so nothing was stopped. Try again.",
      code: "operation-stop-persist-failed",
      operationId,
      detail: dependencies.errorMessage(error)
    });
    return;
  }
  if (result.outcome === "cancelled") {
    dependencies.announceOperationTerminal(operation);
  }
  sendJson(context, result.outcome === "cancelled" ? 200 : 202, {
    operationId,
    code:
      result.outcome === "cancelled" ?
        "operation-stopped"
      : "operation-stop-pending",
    statusUrl: statusUrlFor(operationId),
    operation: dependencies.toClientView(operation)
  });
}

function eligibilityFor(
  kind: OperationRetryKind,
  operation: OperationRecord,
  dependencies: OperationsControlDependencies
): RetryEligibility {
  if (kind === "setup") return dependencies.canRetrySetup(operation);
  if (kind === "verification")
    return dependencies.canRetryVerification(operation);
  return dependencies.canRetryCleanup(operation);
}

function scheduleRetry(
  kind: OperationRetryKind,
  context: CanvasRequestContext,
  operation: OperationRecord,
  commandId: string,
  dependencies: OperationsControlDependencies
): boolean {
  if (kind === "cleanup")
    return dependencies.scheduleCleanupRetry(
      context.instanceId,
      operation,
      commandId
    );
  if (kind === "verification")
    return dependencies.scheduleVerificationRetry(
      context.instanceId,
      operation,
      commandId
    );
  return dependencies.scheduleSetupContinuation(context.instanceId, operation);
}

/**
 * Reopen a closed operation for one allowed continuation.
 *
 * The three kinds differ only in what they may resume: a setup continues from
 * the first step its artifact ledger does not already prove finished, a
 * verification repeats the exact workflow identity Radius saved, and a cleanup
 * removes only the resources Radius proved it created and could not delete.
 */
export async function handleRetryOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  const resolved = await resolveOperation(
    context,
    RETRY_OPERATION_ROUTE,
    dependencies
  );
  if (!resolved) return;
  const { operationId, operation, params } = resolved;
  const requestedKind = decodeSegment(params.retryKind) ?? "";
  if (!isRetryKind(requestedKind)) {
    sendJson(context, 400, {
      error: `Radius does not support a "${requestedKind}" retry.`,
      code: "unsupported-retry",
      operationId
    });
    return;
  }
  const kind: OperationRetryKind = requestedKind;

  const eligibility = eligibilityFor(kind, operation, dependencies);
  if (!eligibility.ok) {
    sendJson(context, 409, {
      error: retryRefusalMessage(kind, eligibility.code),
      code: eligibility.code,
      operationId,
      ...(eligibility.detail ? { detail: eligibility.detail } : {}),
      operation: dependencies.toClientView(operation)
    });
    return;
  }
  if (kind === "verification" && eligibility.requiresMergedPullRequest) {
    const pullRequestUrl = eligibility.pullRequestUrl ?? null;
    const merged = await dependencies.isPullRequestMerged(
      operation,
      pullRequestUrl
    );
    if (!merged) {
      sendJson(context, 409, {
        error:
          "The setup pull request has not merged yet, so the verification workflow is not installed on the target branch.",
        code: "verification-retry-pull-request-open",
        operationId,
        pullRequestUrl,
        operation: dependencies.toClientView(operation)
      });
      return;
    }
    // The merge check is the one await between deciding and acting, so the
    // verdict is re-read rather than assumed to have survived it.
    if (!dependencies.canRetryVerification(operation).ok) {
      sendJson(context, 409, {
        error:
          "This operation changed while Radius checked the setup pull request. Refresh the operation before retrying.",
        code: "operation-active",
        operationId,
        operation: dependencies.toClientView(operation)
      });
      return;
    }
  }

  const lock = dependencies.acquireForRetry(operation);
  if (!lock.ok) {
    sendJson(context, 409, {
      error: `Another setup is already running for ${String(operation.repo ?? "")}.`,
      code: "operation-in-progress",
      operationId: lock.conflict.operationId
    });
    return;
  }

  const snapshot = dependencies.snapshotRetryState(operation);
  const attempt = dependencies.beginRetryAttempt(operation, kind);
  const accepted = dependencies.acceptCommand(operation, {
    kind: RETRY_COMMAND_KINDS[kind],
    attempt,
    target: kind
  });
  if (!accepted.ok || !accepted.command) {
    // The identity is derived from saved facts, so a double click, a lost
    // response, or a reload all resolve to the command already in flight.
    dependencies.rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 202, {
      operationId,
      statusUrl: statusUrlFor(operationId),
      commandId: accepted.command?.commandId || null,
      duplicate: true
    });
    return;
  }
  const commandId = accepted.command.commandId;
  if (kind === "verification") {
    dependencies.setStageState(operation, dependencies.stageVerify, "pending");
    dependencies.enterStage(operation, dependencies.stageVerify);
  } else if (kind === "setup") {
    dependencies.applySetupResumePoint(operation, eligibility.resumeFrom);
  }
  try {
    await dependencies.persistOperations();
  } catch (error) {
    dependencies.rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 500, {
      error:
        "Radius could not save the retry request, so no work was started. Try again.",
      code: "operation-retry-persist-failed",
      operationId,
      detail: dependencies.errorMessage(error)
    });
    return;
  }
  dependencies.setCommandState(operation, commandId, "running");
  sendJson(context, 202, {
    operationId,
    statusUrl: statusUrlFor(operationId),
    commandId,
    attempt,
    operation: dependencies.toClientView(operation)
  });

  const scheduled = scheduleRetry(
    kind,
    context,
    operation,
    commandId,
    dependencies
  );
  if (scheduled) return;
  // No runner accepted the work, so nothing will advance the record this
  // request just reopened. The 202 is already on the wire and cannot be
  // recalled, but leaving the operation `running` would hold the repository
  // lock and keep the panel spinning until the record went stale.
  dependencies.setCommandState(operation, commandId, "finished", "unscheduled");
  dependencies.finish(operation, "failed", {
    failure: {
      code: "operation-scheduling-failed",
      stage: operation.currentStage,
      stepSeq: null,
      message: `Radius accepted the ${kind} retry but could not start any work for it.`,
      classification: "unknown",
      evidence: `No server-owned task runner was available for instance ${context.instanceId}.`
    }
  });
  try {
    await dependencies.persistOperations();
  } catch (error) {
    // Best-effort: the in-memory record is already terminal, so polling
    // reflects the failure even if this durable write does not land.
    dependencies.errorMessage(error);
  }
}

export function createOperationsControlRoutes(
  dependencies: OperationsControlDependencies
): RouteHandlerRegistry {
  return {
    [`POST ${STOP_OPERATION_ROUTE}`]: (context) =>
      handleStopOperation(context, dependencies),
    [`POST ${RETRY_OPERATION_ROUTE}`]: (context) =>
      handleRetryOperation(context, dependencies)
  };
}
