import {
  buildCommandId,
  getOperationControl,
  type WorkflowCancellationTarget
} from "../../operations.js";
import type { OperationRecord } from "../routes/operations-status.js";
import { requireVerificationWorkflowIdentity } from "./verification-workflow-cancellation.js";

export type { WorkflowCancellationTarget } from "../../operations.js";

export interface WorkflowCancellationResult {
  target: WorkflowCancellationTarget;
  state: "inactive" | "cancelling" | "unknown";
  issued: boolean;
}

export interface WorkflowCancellationAuthority {
  assertCurrent(): void;
  issued(): void;
}

export class WorkflowCancellationRefusal extends Error {
  constructor(
    readonly code: "operation-context-changed" | "operation-shutting-down"
  ) {
    super(
      code === "operation-shutting-down" ?
        "The session is shutting down. No workflow cancellation was issued."
      : "The confirmed workflow target changed. No workflow cancellation was issued."
    );
  }
}

export function captureWorkflowCancellationTarget(
  operation: OperationRecord
): WorkflowCancellationTarget {
  const identity = requireVerificationWorkflowIdentity(operation);
  const context = operation.context;
  const login =
    (
      context &&
      typeof context === "object" &&
      "githubLogin" in context &&
      typeof context.githubLogin === "string"
    ) ?
      context.githubLogin.trim()
    : "";
  if (!login)
    throw new Error(
      "The interrupted setup does not record its selected GitHub account."
    );
  if (typeof operation.environment !== "string" || !operation.environment)
    throw new Error("The interrupted setup does not record its environment.");
  const control = getOperationControl(operation);
  const attempts = (control?.commands ?? [])
    .filter(
      (command) =>
        command.kind === "cancel_workflow" && command.target === identity.runId
    )
    .map((command) => command.attempt);
  const cancellationAttempt = attempts.length ? Math.max(...attempts) + 1 : 0;
  return Object.freeze({
    ...identity,
    operationId: operation.operationId,
    environment: operation.environment,
    login,
    verificationAttempt: control?.attempts.verification ?? 0,
    cancellationAttempt,
    commandId: buildCommandId({
      operationId: operation.operationId,
      kind: "cancel_workflow",
      attempt: cancellationAttempt,
      target: identity.runId
    })
  });
}

export function matchesWorkflowCancellationTarget(
  operation: OperationRecord,
  target: WorkflowCancellationTarget
): boolean {
  try {
    const current = captureWorkflowCancellationTarget(operation);
    return (
      current.operationId === target.operationId &&
      current.repo === target.repo &&
      current.environment === target.environment &&
      current.login === target.login &&
      current.runId === target.runId &&
      current.verificationAttempt === target.verificationAttempt
    );
  } catch {
    return false;
  }
}
