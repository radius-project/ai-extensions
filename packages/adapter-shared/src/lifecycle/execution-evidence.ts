import Ajv from "ajv";
import {
  lifecycleExecutionSchema,
  lifecycleProgressSchema,
  lifecycleError,
  sameLifecycleData,
  portFailure,
  portSuccess,
  type ExecutionEvidence,
  type ExecutionIdentity,
  type LifecycleExecutionDocument,
  type LifecycleProgressDocument,
  type PortResult
} from "@radius-project/core/lifecycle";

export function createExecutionEvidenceReader() {
  const validate = new Ajv({
    strict: false,
    allErrors: true
  }).compile<LifecycleExecutionDocument>(lifecycleExecutionSchema);
  const validateProgress = new Ajv({
    strict: false,
    allErrors: true
  }).compile<LifecycleProgressDocument>(lifecycleProgressSchema);
  const progressSeen = new Map<string, LifecycleProgressDocument>();
  const latest = new Map<string, LifecycleExecutionDocument>();
  function read(
    text: string,
    identity: ExecutionIdentity,
    channel: "final" | "progress"
  ): PortResult<ExecutionEvidence> {
    if (text.length > 131072) return portFailure("EVIDENCE_MISMATCH");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return portFailure("EVIDENCE_MISMATCH");
    }
    if (
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "executionSchemaVersion") !== 1
    )
      return portFailure("VERSION_UNSUPPORTED");
    if (!validate(value)) return portFailure("EVIDENCE_MISMATCH");
    if (
      value.operationId !== identity.operationId ||
      value.attemptId !== identity.attemptId ||
      value.operation !== identity.operation ||
      value.repo !== identity.target.repo ||
      value.environment !== identity.target.environment ||
      value.application !== identity.target.application ||
      value.expectedCommit !== identity.expectedCommit ||
      value.actualCommit !== identity.expectedCommit ||
      String(value.runId) !== identity.run.runId ||
      value.runAttempt !== identity.run.runAttempt ||
      identity.run.commit !== identity.expectedCommit ||
      identity.run.repo !== identity.target.repo ||
      !Number.isFinite(Date.parse(value.observedAt))
    )
      return portFailure("EVIDENCE_MISMATCH");
    const key = JSON.stringify([
      channel,
      identity.operationId,
      identity.attemptId,
      identity.operation,
      identity.target.repo,
      identity.target.environment,
      identity.target.application,
      identity.expectedCommit,
      identity.run.repo,
      identity.run.workflow,
      identity.run.runId,
      identity.run.runAttempt,
      identity.run.commit
    ]);
    const previous = latest.get(key);
    if (
      previous &&
      (value.sequence < previous.sequence ||
        Date.parse(value.observedAt) < Date.parse(previous.observedAt) ||
        (value.sequence === previous.sequence &&
          !sameLifecycleData(value, previous)))
    )
      return portFailure("EVIDENCE_CONFLICT");
    latest.set(key, value);
    const names = [
      ["restore", "restore"],
      ["commands", "command"],
      ["stateSave", "state-save"],
      ["cleanup", "cleanup"]
    ] as const;
    const failures = names
      .filter(([name]) => value.phases[name].outcome === "failed")
      .map(([, phase]) =>
        lifecycleError("PRECONDITION_FAILED", {
          operationId: identity.operationId,
          diagnostics: [
            {
              message: `${phase} failed for the correlated workflow.`,
              truncated: false
            }
          ]
        })
      );
    // Artifact prose is untrusted. Fixed target/phase diagnostics prevent
    // arbitrary artifact text or credential values crossing this boundary.
    return portSuccess({
      executionSchemaVersion: 1,
      identity,
      actualCommit: value.actualCommit,
      sequence: value.sequence,
      observedAt: value.observedAt,
      phases: [
        {
          phase: "dispatch",
          status: "succeeded",
          exitCode: 0,
          reason: "Exact workflow observed."
        },
        {
          phase: "checkout",
          status: "succeeded",
          exitCode: 0,
          reason: "Checked-out commit matches."
        },
        ...names.map(([name, phase]) => ({
          phase,
          status: value.phases[name].outcome,
          ...(value.phases[name].exitCode === undefined ?
            {}
          : { exitCode: value.phases[name].exitCode }),
          reason: `${phase}: ${value.phases[name].outcome}`
        }))
      ],
      ...(failures[0] ? { primaryFailure: failures[0] } : {}),
      additionalFailures: failures.slice(1),
      diagnostics:
        (
          value.diagnostics?.length ||
          value.primaryFailure ||
          value.additionalFailures?.length
        ) ?
          [
            {
              message:
                "Untrusted artifact diagnostics were withheld; fixed phase diagnostics are shown instead.",
              truncated: true
            }
          ]
        : []
    });
  }
  return {
    read: (text: string, identity: ExecutionIdentity) =>
      read(text, identity, "final"),
    readProgress(
      text: string,
      identity: ExecutionIdentity
    ): PortResult<ExecutionEvidence> {
      if (text.length > 131072) return portFailure("EVIDENCE_MISMATCH");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return portFailure("EVIDENCE_MISMATCH");
      }
      if (
        value &&
        typeof value === "object" &&
        Reflect.get(value, "schemaVersion") !== 2
      )
        return portFailure("VERSION_UNSUPPORTED");
      if (!validateProgress(value)) return portFailure("EVIDENCE_MISMATCH");
      // Resource progress never establishes command or whole-operation success.
      // Its sequence belongs to a different artifact stream from final results.
      const result = read(
        JSON.stringify({
          executionSchemaVersion: 1,
          operationId: value.operationId,
          attemptId: value.attemptId,
          operation: value.operation,
          repo: value.repo,
          environment: value.environment,
          application: value.application,
          expectedCommit: value.expectedCommit,
          actualCommit: value.actualCommit,
          runId: value.runId,
          runAttempt: value.runAttempt,
          sequence: value.sequence,
          observedAt: value.updatedAt,
          phases: Object.fromEntries(
            ["restore", "commands", "stateSave", "cleanup"].map((phase) => [
              phase,
              {
                outcome: "unknown",
                reason: "Resource progress is not final phase evidence."
              }
            ])
          )
        }),
        identity,
        "progress"
      );
      if (result.status !== "ok") return result;
      const key = JSON.stringify([
        value.operationId,
        value.attemptId,
        value.repo,
        value.environment,
        value.application,
        value.expectedCommit,
        value.runId,
        value.runAttempt,
        identity.run.workflow
      ]);
      const previous = progressSeen.get(key);
      if (
        previous &&
        previous.sequence === value.sequence &&
        !sameLifecycleData(previous, value)
      )
        return portFailure("EVIDENCE_CONFLICT");
      progressSeen.set(key, value);
      return result;
    }
  };
}
