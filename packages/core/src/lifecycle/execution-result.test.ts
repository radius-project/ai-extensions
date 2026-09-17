import { expect, it } from "vitest";
import { reduceOperation } from "./operations.js";
import type { ExecutionAttempt, OperationRecord } from "./contracts/common.js";
import { reduceExecutionObservation } from "./execution-result.js";
import {
  lifecycleError,
  portFailure,
  portSuccess,
  portUnavailable
} from "./errors.js";
import type { ExecutionIdentity, WorkflowObservation } from "./ports.js";

function evidenceFixture() {
  const identity: ExecutionIdentity = {
    operationId: "op",
    attemptId: "attempt",
    operation: "deployment.start",
    target: { repo: "owner/repo", environment: "dev", application: "app" },
    expectedCommit: "a".repeat(40),
    run: {
      repo: "owner/repo",
      workflow: ".github/workflows/run-rad-commands.yml",
      runId: "123",
      runAttempt: 1,
      commit: "a".repeat(40)
    }
  };
  const observation = {
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "workflow" as const
  };
  const phases = (
    [
      "dispatch",
      "checkout",
      "restore",
      "command",
      "state-save",
      "cleanup"
    ] as const
  ).map((phase) => ({
    phase,
    status: "succeeded" as const,
    exitCode: 0,
    reason: "Verified final evidence"
  }));
  const evidence = {
    executionSchemaVersion: 1 as const,
    identity,
    actualCommit: identity.expectedCommit,
    sequence: 5,
    observedAt: "2026-09-16T00:00:00Z",
    phases,
    additionalFailures: [],
    diagnostics: []
  };
  const operation: OperationRecord = {
    operationId: identity.operationId,
    operation: "deployment.start",
    target: identity.target,
    source: {
      kind: "git",
      repo: identity.target.repo,
      ref: "feature",
      commit: identity.expectedCommit,
      fingerprint: `sha256:${"b".repeat(64)}`,
      resolvedAt: evidence.observedAt
    },
    state: "queued",
    observation,
    actions: [],
    attempts: [
      {
        operationId: identity.operationId,
        attemptId: identity.attemptId,
        expectedCommit: identity.expectedCommit,
        phases: [],
        observation
      }
    ]
  };
  return { identity, observation, evidence, operation };
}

it("retains known state-save and cleanup outcomes when cancellation has no new final artifact", () => {
  const f = evidenceFixture();
  const phases = [
    {
      phase: "state-save" as const,
      status: "failed" as const,
      exitCode: 1,
      reason: "Known state save failure."
    },
    {
      phase: "cleanup" as const,
      status: "succeeded" as const,
      exitCode: 0,
      reason: "Owned cleanup completed."
    }
  ];
  const operation = {
    ...f.operation,
    attempts: f.operation.attempts.map((attempt) => ({ ...attempt, phases }))
  };
  expect(
    reduceExecutionObservation(operation, f.identity, {
      identity: f.identity,
      conclusion: "cancelled",
      observation: f.observation,
      evidence: portUnavailable("RESULT_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "workflow"
      })
    })
  ).toMatchObject({
    status: "ok",
    value: {
      state: "cancelled",
      attempts: [{ phases }],
      result: { kind: "execution", phases }
    }
  });
});

for (const quality of ["current", "stale", "unknown"] as const) {
  for (const conclusion of [
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "in_progress",
    "queued",
    "unknown"
  ] as const) {
    it.each([
      "complete",
      "missing",
      "mismatch",
      "phase-failed",
      "skipped"
    ] as const)(
      `${quality} ${conclusion} keeps %s phase evidence separate from conclusion`,
      (kind) => {
        const f = evidenceFixture();
        const evidence: WorkflowObservation["evidence"] =
          kind === "missing" ?
            portUnavailable("RESULT_UNAVAILABLE", {
              quality: "unknown",
              completeness: "unavailable",
              evidence: "workflow"
            })
          : kind === "mismatch" ? portFailure("EVIDENCE_MISMATCH")
          : portSuccess({
              ...f.evidence,
              phases:
                kind === "complete" ?
                  f.evidence.phases
                : f.evidence.phases.map((phase) =>
                    phase.phase === "state-save" ?
                      {
                        phase: phase.phase,
                        status:
                          kind === "skipped" ?
                            ("skipped" as const)
                          : ("failed" as const),
                        reason: "Required phase unavailable",
                        ...(kind === "skipped" ? {} : { exitCode: 7 })
                      }
                    : phase
                  )
            });
        const result = reduceExecutionObservation(f.operation, f.identity, {
          identity: f.identity,
          conclusion,
          evidence,
          observation: { ...f.observation, quality }
        });
        const expected =
          quality !== "current" ? "queued"
          : conclusion === "cancelled" ? "cancelled"
          : conclusion === "failure" || conclusion === "timed_out" ? "failed"
          : conclusion === "success" && kind === "complete" ? "succeeded"
          : kind === "phase-failed" && conclusion !== "success" ? "failed"
          : conclusion === "in_progress" ? "running"
          : "queued";
        // Non-current conclusive evidence cannot advance execution state.
        const state =
          (
            quality !== "current" &&
            (conclusion === "failure" ||
              conclusion === "cancelled" ||
              conclusion === "timed_out" ||
              kind === "phase-failed")
          ) ?
            "queued"
          : expected;
        expect(result).toMatchObject({ status: "ok", value: { state } });
        if (
          quality === "current" &&
          conclusion === "success" &&
          kind === "phase-failed"
        )
          expect(result).toMatchObject({
            value: {
              error: { code: "EVIDENCE_CONFLICT" },
              observation: { quality: "unknown" }
            }
          });
      }
    );
  }
}

it("rejects foreign source, target, operation, attempt and known run identities", () => {
  const f = evidenceFixture();
  const identities: ExecutionIdentity[] = [
    { ...f.identity, operationId: "foreign" },
    { ...f.identity, attemptId: "foreign" },
    { ...f.identity, expectedCommit: "c".repeat(40) },
    { ...f.identity, target: { ...f.identity.target, application: "foreign" } },
    { ...f.identity, run: { ...f.identity.run, repo: "other/repo" } },
    { ...f.identity, run: { ...f.identity.run, commit: "c".repeat(40) } }
  ];
  for (const identity of identities)
    expect(
      reduceExecutionObservation(f.operation, identity, {
        identity,
        conclusion: "success",
        evidence: portSuccess(f.evidence),
        observation: f.observation
      })
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  const operation = {
    ...f.operation,
    attempts: [
      {
        ...f.operation.attempts[0],
        run: { ...f.identity.run, conclusion: "in_progress" as const }
      }
    ]
  };
  for (const run of [
    { ...f.identity.run, runId: "456" },
    { ...f.identity.run, runAttempt: 2 },
    { ...f.identity.run, workflow: "other.yml" }
  ])
    expect(
      reduceExecutionObservation(
        operation,
        { ...f.identity, run },
        {
          identity: { ...f.identity, run },
          conclusion: "success",
          evidence: portSuccess(f.evidence),
          observation: f.observation
        }
      )
    ).toMatchObject({ status: "failed" });
});

it("clears superseded observation errors only after current matching final evidence", () => {
  const f = evidenceFixture();
  for (const code of [
    "DISPATCH_UNCONFIRMED",
    "EVIDENCE_MISMATCH",
    "EVIDENCE_CONFLICT",
    "RESULT_UNAVAILABLE",
    "VERSION_UNSUPPORTED"
  ] as const) {
    const result = reduceExecutionObservation(
      { ...f.operation, error: lifecycleError(code) },
      f.identity,
      {
        identity: f.identity,
        conclusion: "success",
        evidence: portSuccess(f.evidence),
        observation: f.observation
      }
    );
    expect(result).toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
    if (result.status === "ok") expect(result.value.error).toBeUndefined();
  }
});

it("rejects corrupt recorded attempt provenance and retains unrelated attempt observations", () => {
  const f = evidenceFixture();
  const observed = {
    identity: f.identity,
    conclusion: "success" as const,
    evidence: portSuccess(f.evidence),
    observation: f.observation
  };
  expect(
    reduceExecutionObservation(
      { ...f.operation, source: undefined },
      f.identity,
      observed
    )
  ).toMatchObject({ status: "failed" });
  expect(
    reduceExecutionObservation(
      {
        ...f.operation,
        attempts: [
          { ...f.operation.attempts[0], expectedCommit: "b".repeat(40) }
        ]
      },
      f.identity,
      observed
    )
  ).toMatchObject({ status: "failed" });
  const previous = { ...f.operation.attempts[0], attemptId: "previous" };
  expect(
    reduceExecutionObservation(
      { ...f.operation, attempts: [previous, ...f.operation.attempts] },
      f.identity,
      {
        ...observed,
        conclusion: "in_progress"
      }
    )
  ).toMatchObject({
    status: "ok",
    value: { attempts: [previous, expect.anything()] }
  });
  expect(
    reduceExecutionObservation(
      { ...f.operation, attempts: [previous, ...f.operation.attempts] },
      f.identity,
      observed
    )
  ).toMatchObject({
    status: "ok",
    value: { state: "succeeded", attempts: [previous, expect.anything()] }
  });
});

it("does not project diagnostics from a foreign successful evidence envelope", () => {
  const f = evidenceFixture();
  const result = reduceExecutionObservation(f.operation, f.identity, {
    identity: f.identity,
    conclusion: "failure",
    observation: f.observation,
    evidence: portSuccess({
      ...f.evidence,
      identity: { ...f.identity, attemptId: "foreign" },
      primaryFailure: {
        ...lifecycleError("PRECONDITION_FAILED"),
        message: "foreign detail"
      },
      diagnostics: [{ message: "foreign detail", truncated: false }]
    })
  });
  expect(result).toMatchObject({
    status: "ok",
    value: { state: "failed", error: { code: "EVIDENCE_MISMATCH" } }
  });
  expect(JSON.stringify(result)).not.toContain("foreign detail");
});

it("withholds foreign evidence during an unresolved workflow and preserves a matched primary failure", () => {
  const f = evidenceFixture();
  const foreign = reduceExecutionObservation(f.operation, f.identity, {
    identity: f.identity,
    conclusion: "unknown",
    observation: f.observation,
    evidence: portSuccess({ ...f.evidence, actualCommit: "c".repeat(40) })
  });
  expect(foreign).toMatchObject({
    status: "ok",
    value: { state: "queued", error: { code: "EVIDENCE_MISMATCH" } }
  });
  const primaryFailure = lifecycleError("PRECONDITION_FAILED");
  expect(
    reduceExecutionObservation(f.operation, f.identity, {
      identity: f.identity,
      conclusion: "failure",
      observation: f.observation,
      evidence: portSuccess({ ...f.evidence, primaryFailure })
    })
  ).toMatchObject({
    status: "ok",
    value: {
      state: "failed",
      error: primaryFailure,
      result: { primaryFailure }
    }
  });
});

it("retains independently confirmed failure with foreign artifacts and terminal state on later missing evidence", () => {
  const f = evidenceFixture();
  const failure = reduceExecutionObservation(f.operation, f.identity, {
    identity: f.identity,
    conclusion: "failure",
    evidence: portSuccess({ ...f.evidence, actualCommit: "c".repeat(40) }),
    observation: f.observation
  });
  expect(failure).toMatchObject({
    status: "ok",
    value: {
      state: "failed",
      error: { code: "EVIDENCE_MISMATCH" },
      result: { phases: [] }
    }
  });
  if (failure.status !== "ok") throw new Error("No failure record");
  expect(
    reduceExecutionObservation(failure.value, f.identity, {
      identity: f.identity,
      conclusion: "unknown",
      evidence: portUnavailable("RESULT_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "workflow"
      }),
      observation: { ...f.observation, quality: "stale" }
    })
  ).toMatchObject({ status: "ok", value: { state: "failed" } });
});

it.each(["failure", "cancelled", "timed_out"] as const)(
  "retains authoritative workflow %s when final phase evidence is missing",
  (conclusion) => {
    const attempt: ExecutionAttempt = {
      operationId: "op",
      attemptId: "attempt",
      expectedCommit: "a".repeat(40),
      phases: [],
      observation: {
        quality: "current",
        completeness: "unavailable",
        evidence: "workflow",
        limitation: "Final artifact unavailable"
      }
    };
    const operation: OperationRecord = {
      operationId: "op",
      operation: "deployment.start",
      target: { repo: "owner/repo", environment: "dev", application: "app" },
      state: "queued",
      observation: attempt.observation,
      attempts: [attempt],
      actions: []
    };
    expect(
      reduceOperation(operation, {
        kind: "completed",
        state: conclusion === "cancelled" ? "cancelled" : "failed",
        attempt: {
          ...attempt,
          run: {
            repo: "owner/repo",
            workflow: ".github/workflows/run-rad-commands.yml",
            runId: "123",
            runAttempt: 1,
            commit: "a".repeat(40),
            conclusion
          }
        }
      })
    ).toMatchObject({
      status: "ok",
      value: {
        state: conclusion === "cancelled" ? "cancelled" : "failed",
        observation: { completeness: "unavailable" }
      }
    });
  }
);
