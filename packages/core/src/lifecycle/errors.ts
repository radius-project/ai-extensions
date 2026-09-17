import type { LifecycleError, Observation } from "./contracts/common.js";
import type { LifecycleErrorResponse } from "./contracts/catalog.js";

export type LifecycleErrorCode = LifecycleError["code"];
export type UnavailableCode =
  | "CAPABILITY_UNAVAILABLE"
  | "SOURCE_UNAVAILABLE"
  | "VALIDATION_INCOMPLETE"
  | "OPERATION_UNAVAILABLE"
  | "RESULT_UNAVAILABLE";
export type FailureCode = Exclude<
  LifecycleErrorCode,
  UnavailableCode | "FORBIDDEN"
>;
export type CancellationReason = "request_cancelled" | "session_shutdown";
export type RedactedDiagnostic = NonNullable<LifecycleError["details"]>[number];
/** Supplied only after adapter-owned redaction; these helpers do not sanitize raw logs. */
export type RedactedDiagnostics = readonly Readonly<RedactedDiagnostic>[];
export interface ErrorOptions {
  readonly retryable?: boolean;
  readonly operationId?: string;
  readonly diagnostics?: RedactedDiagnostics;
}
export type AbsenceObservation = Readonly<
  Observation & {
    quality: "current";
    completeness: "complete";
    observedAt: string;
  }
>;
export type UnavailableObservation = Readonly<
  Observation & {
    quality: "stale" | "unknown";
    completeness: "partial" | "unavailable";
  }
>;

export interface PortSuccess<T> {
  readonly status: "ok";
  readonly value: T;
}
export interface PortAbsent {
  readonly status: "absent";
  readonly reason: "not_found";
  readonly observation: AbsenceObservation;
}
export interface PortUnavailable {
  readonly status: "unavailable";
  readonly error: LifecycleError & { code: UnavailableCode };
  readonly observation: UnavailableObservation;
}
export interface PortForbidden {
  readonly status: "forbidden";
  readonly error: LifecycleError & { code: "FORBIDDEN"; retryable: false };
}
export interface PortFailure {
  readonly status: "failed";
  readonly error: LifecycleError & { code: FailureCode };
}
export interface PortCancelled {
  readonly status: "cancelled";
  readonly reason: CancellationReason;
}
export type PortError = PortUnavailable | PortForbidden | PortFailure;
export type PortResult<T> = PortSuccess<T> | PortError | PortCancelled;
export type ReadResult<T> = PortResult<T> | PortAbsent;

const explanations = {
  INVALID_REQUEST: [
    "The request does not match the lifecycle contract.",
    "Correct the request before retrying."
  ],
  VERSION_UNSUPPORTED: [
    "The requested contract version is unsupported.",
    "Use an explicitly supported contract version."
  ],
  FORBIDDEN: [
    "The caller lacks authority for the selected scope.",
    "Obtain authorization through the identity adapter."
  ],
  CAPABILITY_UNAVAILABLE: [
    "The selected context cannot provide this capability.",
    "Inspect the supported capabilities and their limitations."
  ],
  SOURCE_CHANGED: [
    "The selected source no longer matches its expected identity.",
    "Resolve the source again and renew source-dependent approvals."
  ],
  DEFINITION_NOT_FOUND: [
    "The definition was not found in the authorized source.",
    "Select an existing definition or explicitly request authoring."
  ],
  SOURCE_UNAVAILABLE: [
    "The selected source could not be established.",
    "Restore source access before retrying the read."
  ],
  RECIPE_PACK_REQUIRED: [
    "The environment has no suitable registered recipe.",
    "Register an appropriate recipe for the selected resource type."
  ],
  VALIDATION_FAILED: [
    "A required validation check failed.",
    "Correct the required check failures before replacement or deployment."
  ],
  VALIDATION_INCOMPLETE: [
    "Required validation checks could not be completed.",
    "Complete the required checks before replacing the source."
  ],
  ACTION_NOT_OUTSTANDING: [
    "The required action is no longer outstanding.",
    "Read the current operation and respond only to an outstanding action."
  ],
  ACTION_RESPONSE_INVALID: [
    "The response does not match the action or its authorized responder.",
    "Check the action, responder, target and source binding."
  ],
  OPERATION_UNAVAILABLE: [
    "The operation is unavailable from the supported evidence sources.",
    "Check its identity and the current context's observation coverage."
  ],
  DISPATCH_UNCONFIRMED: [
    "The workflow dispatch could not be confirmed.",
    "Reconcile the existing operation; do not dispatch it again."
  ],
  RESULT_UNAVAILABLE: [
    "Detailed execution evidence is unavailable.",
    "Refresh the observation without repeating the mutation."
  ],
  EVIDENCE_MISMATCH: [
    "The evidence does not match the selected execution identity.",
    "Locate evidence for the exact operation, attempt, source and run."
  ],
  EVIDENCE_CONFLICT: [
    "The correlated execution evidence is contradictory.",
    "Reconcile the conflicting evidence without assuming success."
  ],
  PRECONDITION_FAILED: [
    "A required execution precondition was not established.",
    "Re-establish ownership, authorization and current execution preconditions."
  ],
  REPAIR_LIMIT_REACHED: [
    "The declared repair attempt budget is exhausted.",
    "Review the failed operation before authorizing any new work."
  ]
} as const satisfies Record<LifecycleErrorCode, readonly [string, string]>;

function copyDiagnostics(
  diagnostics: RedactedDiagnostics
): RedactedDiagnostic[] {
  return diagnostics.slice(0, 100).map((diagnostic, index) => ({
    message: diagnostic.message.slice(0, 4096),
    truncated:
      diagnostic.truncated ||
      diagnostic.message.length > 4096 ||
      (diagnostics.length > 100 && index === 99),
    ...(diagnostic.classification === undefined ?
      {}
    : { classification: diagnostic.classification }),
    ...(diagnostic.location === undefined ?
      {}
    : { location: diagnostic.location })
  }));
}

function copyError(error: LifecycleError): LifecycleError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.operationId === undefined ?
      {}
    : { operationId: error.operationId }),
    ...(error.details === undefined ?
      {}
    : { details: copyDiagnostics(error.details) }),
    ...(error.nextAction === undefined ? {} : { nextAction: error.nextAction })
  };
}

export function lifecycleError(
  code: LifecycleErrorCode,
  options: ErrorOptions = {}
): LifecycleError {
  const [message, nextAction] = explanations[code];
  return {
    code,
    message,
    nextAction,
    retryable: options.retryable ?? false,
    ...(options.operationId === undefined ?
      {}
    : { operationId: options.operationId }),
    ...(options.diagnostics === undefined ?
      {}
    : { details: copyDiagnostics(options.diagnostics) })
  };
}

export function portSuccess<T>(value: T): PortSuccess<T> {
  return { status: "ok", value };
}

export function portAbsent(observation: AbsenceObservation): PortAbsent {
  return {
    status: "absent",
    reason: "not_found",
    observation: {
      quality: observation.quality,
      completeness: observation.completeness,
      evidence: observation.evidence,
      observedAt: observation.observedAt,
      ...(observation.limitation === undefined ?
        {}
      : { limitation: observation.limitation })
    }
  };
}

export function portUnavailable(
  code: UnavailableCode,
  observation: UnavailableObservation,
  options: ErrorOptions = {}
): PortUnavailable {
  return {
    status: "unavailable",
    observation: {
      quality: observation.quality,
      completeness: observation.completeness,
      evidence: observation.evidence,
      ...(observation.observedAt === undefined ?
        {}
      : { observedAt: observation.observedAt }),
      ...(observation.limitation === undefined ?
        {}
      : { limitation: observation.limitation })
    },
    error: { ...lifecycleError(code, options), code }
  };
}

export function portForbidden(
  options: Omit<ErrorOptions, "retryable"> = {}
): PortForbidden {
  return {
    status: "forbidden",
    error: {
      ...lifecycleError("FORBIDDEN", options),
      code: "FORBIDDEN",
      retryable: false
    }
  };
}

export function portFailure(
  code: FailureCode,
  options: ErrorOptions = {}
): PortFailure {
  return {
    status: "failed",
    error: { ...lifecycleError(code, options), code }
  };
}

export function portCancelled(reason: CancellationReason): PortCancelled {
  return { status: "cancelled", reason };
}

export function toLifecycleErrorResponse(
  requestId: string,
  failure: PortError
): LifecycleErrorResponse {
  return {
    apiVersion: "github-radius/v1",
    requestId,
    error: copyError(failure.error)
  };
}
