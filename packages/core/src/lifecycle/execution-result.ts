import type { ExecutionAttempt, OperationRecord } from "./contracts/common.js";
import type {
  ExecutionIdentity,
  ReadonlyData,
  WorkflowObservation
} from "./ports.js";
import { lifecycleError, portFailure, portSuccess } from "./errors.js";
import {
  isTerminalOperation,
  reduceOperation,
  sameLifecycleData
} from "./operations.js";
import { DEPLOYMENT_COMPLETION_PHASES } from "./deployment-policy.js";

export function reduceExecutionObservation(
  operation: ReadonlyData<OperationRecord>,
  identity: ExecutionIdentity,
  observed: WorkflowObservation
) {
  const known = operation.attempts.find(
    (attempt) => attempt.attemptId === identity.attemptId
  );
  if (
    !known ||
    identity.operationId !== operation.operationId ||
    identity.operation !== operation.operation ||
    identity.run.repo !== operation.target.repo ||
    identity.run.commit !== identity.expectedCommit ||
    (known.run !== undefined &&
      (known.run.runId !== identity.run.runId ||
        known.run.runAttempt !== identity.run.runAttempt ||
        known.run.workflow !== identity.run.workflow)) ||
    operation.source?.kind !== "git" ||
    identity.expectedCommit !== operation.source.commit ||
    !sameLifecycleData(identity.target, {
      repo: operation.target.repo,
      environment: operation.target.environment,
      application: operation.target.application
    }) ||
    !sameLifecycleData(identity, observed.identity)
  )
    return portFailure("EVIDENCE_MISMATCH");
  const suppliedEvidence =
    observed.evidence.status === "ok" ? observed.evidence.value : undefined;
  const rejected =
    observed.evidence.status === "failed" ? observed.evidence.error : undefined;
  const invalid =
    suppliedEvidence !== undefined &&
    (!sameLifecycleData(suppliedEvidence.identity, identity) ||
      suppliedEvidence.actualCommit !== identity.expectedCommit);
  const evidence = invalid ? undefined : suppliedEvidence;
  const phases = evidence?.phases ?? known.phases;
  const conflict =
    observed.conclusion === "success" &&
    phases.some(
      (phase) => phase.status === "failed" || phase.status === "cancelled"
    );
  const evidenceError =
    rejected ??
    (invalid ? lifecycleError("EVIDENCE_MISMATCH")
    : conflict ? lifecycleError("EVIDENCE_CONFLICT")
    : undefined);
  const corroborated =
    evidence !== undefined &&
    DEPLOYMENT_COMPLETION_PHASES.every(
      (name) =>
        phases.filter((phase) => phase.phase === name).length === 1 &&
        phases.some(
          (phase) => phase.phase === name && phase.status === "succeeded"
        )
    );
  const observation = {
    ...observed.observation,
    completeness: corroborated ? ("complete" as const) : ("partial" as const),
    ...(invalid || conflict || rejected ?
      {
        quality: "unknown" as const,
        limitation:
          "Execution evidence conflicts or does not match the selected execution."
      }
    : evidence ? {}
    : {
        limitation:
          "Final phase evidence unavailable; workflow conclusion retained."
      })
  };
  if (
    observed.observation.quality === "current" &&
    (operation.error?.code === "DISPATCH_UNCONFIRMED" ||
      (corroborated &&
        operation.error &&
        [
          "EVIDENCE_MISMATCH",
          "EVIDENCE_CONFLICT",
          "RESULT_UNAVAILABLE",
          "VERSION_UNSUPPORTED"
        ].includes(operation.error.code)))
  ) {
    const { error: _previousObservationError, ...confirmed } = operation;
    operation = confirmed;
  }
  const attempt: ReadonlyData<ExecutionAttempt> = {
    ...known,
    run: { ...identity.run, conclusion: observed.conclusion },
    phases,
    observation
  };
  const terminal =
    observed.conclusion === "cancelled" ? "cancelled"
    : ["failure", "timed_out"].includes(observed.conclusion) ? "failed"
    : !conflict && phases.some((phase) => phase.status === "failed") ? "failed"
    : observed.conclusion === "success" && corroborated ? "succeeded"
    : undefined;
  // The independently observed workflow failure remains authoritative even
  // when an artifact is foreign or contradictory.
  const authoritativeAttempt = {
    ...attempt,
    observation:
      ["failure", "timed_out", "cancelled"].includes(observed.conclusion) ?
        { ...observation, quality: observed.observation.quality }
      : observation
  };
  if (terminal) {
    const reduced = reduceOperation(operation, {
      kind: "completed",
      state: terminal,
      attempt: authoritativeAttempt
    });
    if (reduced.status !== "ok") return reduced;
    if (isTerminalOperation(operation)) return portSuccess(reduced.value);
    return portSuccess({
      ...reduced.value,
      result: {
        kind: "execution" as const,
        phases,
        ...(evidence?.primaryFailure ?
          { primaryFailure: evidence.primaryFailure }
        : {}),
        additionalFailures: evidence?.additionalFailures ?? [],
        diagnostics: evidence?.diagnostics ?? []
      },
      ...(evidenceError ? { error: evidenceError }
      : evidence?.primaryFailure ? { error: evidence.primaryFailure }
      : {})
    });
  }
  if (isTerminalOperation(operation))
    return portSuccess({ ...operation, observation });
  return portSuccess({
    ...operation,
    state:
      (
        observed.conclusion === "in_progress" &&
        observed.observation.quality === "current"
      ) ?
        ("running" as const)
      : operation.state,
    observation,
    attempts: operation.attempts.map((entry) =>
      entry.attemptId === attempt.attemptId ? attempt : entry
    ),
    ...(evidenceError ? { error: evidenceError } : {})
  });
}
