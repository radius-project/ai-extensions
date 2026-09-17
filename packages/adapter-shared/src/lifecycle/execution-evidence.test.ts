import { describe, expect, it } from "vitest";
import { createExecutionEvidenceReader } from "./execution-evidence.js";
import type {
  ExecutionIdentity,
  LifecycleExecutionDocument
} from "@radius-project/core/lifecycle";
import { lifecycleError } from "@radius-project/core/lifecycle";

const identity: ExecutionIdentity = {
  operationId: "operation-1",
  attemptId: "attempt-1",
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
function document(): LifecycleExecutionDocument {
  return {
    executionSchemaVersion: 1,
    operationId: identity.operationId,
    attemptId: identity.attemptId,
    operation: "deployment.start",
    ...identity.target,
    application: "app",
    expectedCommit: identity.expectedCommit,
    actualCommit: identity.expectedCommit,
    runId: 123,
    runAttempt: 1,
    sequence: 4,
    observedAt: "2026-09-16T00:00:00Z",
    phases: {
      restore: { outcome: "succeeded", exitCode: 0 },
      commands: { outcome: "succeeded", exitCode: 0 },
      stateSave: { outcome: "succeeded", exitCode: 0 },
      cleanup: { outcome: "succeeded", exitCode: 0 }
    }
  };
}

describe("paired canonical progress reader", () => {
  const progress = () => ({
    schemaVersion: 2,
    operationId: identity.operationId,
    attemptId: identity.attemptId,
    operation: identity.operation,
    ...identity.target,
    expectedCommit: identity.expectedCommit,
    actualCommit: identity.expectedCommit,
    runId: 123,
    runAttempt: 1,
    sequence: 100,
    updatedAt: "2026-09-16T00:00:00Z",
    state: "in_progress",
    diagnosticsRedacted: true,
    resources: []
  });
  it("keeps progress incomplete even if the workflow reports success and fences its own sequence", () => {
    const reader = createExecutionEvidenceReader();
    const value = progress();
    expect(reader.readProgress(JSON.stringify(value), identity)).toMatchObject({
      status: "ok",
      value: {
        phases: expect.arrayContaining([
          { phase: "command", status: "unknown", reason: "command: unknown" }
        ])
      }
    });
    expect(
      reader.readProgress(JSON.stringify({ ...value, sequence: 99 }), identity)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_CONFLICT" } });
    expect(reader.read(JSON.stringify(document()), identity)).toMatchObject({
      status: "ok"
    });
  });
  it.each([
    "x".repeat(131073),
    "{",
    "null",
    "false",
    "{}",
    '{"schemaVersion":1}',
    '{"schemaVersion":2}'
  ])(
    "rejects malformed or unsupported progress without fallback (case %#)",
    (text) => {
      expect(
        createExecutionEvidenceReader().readProgress(text, identity)
      ).toMatchObject({ status: "failed" });
    }
  );
  it("rejects foreign progress identities and never accepts unredacted resource prose", () => {
    const value = progress();
    expect(
      createExecutionEvidenceReader().readProgress(
        JSON.stringify({ ...value, attemptId: "other" }),
        identity
      )
    ).toMatchObject({ status: "failed" });
    expect(
      createExecutionEvidenceReader().readProgress(
        JSON.stringify({
          ...value,
          resources: [
            {
              id: "web",
              name: "web",
              type: "container",
              provisioningState: "Succeeded",
              outputResourceIds: [],
              status: "success",
              message: "untrusted diagnostic"
            }
          ]
        }),
        identity
      )
    ).toMatchObject({ status: "failed" });
  });
  it("rejects conflicting progress content at the same sequence but accepts a newer sequence", () => {
    const reader = createExecutionEvidenceReader();
    const value = progress();
    expect(reader.readProgress(JSON.stringify(value), identity).status).toBe(
      "ok"
    );
    expect(reader.readProgress(JSON.stringify(value), identity).status).toBe(
      "ok"
    );
    const changed = {
      ...value,
      resources: [
        {
          id: "web",
          name: "web",
          type: "container",
          provisioningState: "Succeeded",
          outputResourceIds: [],
          status: "success",
          message: "Resource diagnostic withheld."
        }
      ]
    };
    expect(
      reader.readProgress(JSON.stringify(changed), identity)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_CONFLICT" } });
    expect(
      reader.readProgress(
        JSON.stringify({ ...changed, sequence: 101 }),
        identity
      ).status
    ).toBe("ok");
  });
  it("compares equal evidence structurally instead of rejecting different JSON property order", () => {
    const reader = createExecutionEvidenceReader();
    const value = document();
    expect(reader.read(JSON.stringify(value), identity).status).toBe("ok");
    expect(
      reader.read(
        JSON.stringify(Object.fromEntries(Object.entries(value).reverse())),
        identity
      ).status
    ).toBe("ok");
  });
});

describe("strict final execution evidence", () => {
  it.each(["diagnostics", "primary", "secondary"])(
    "discloses withholding untrusted %s prose without echoing it",
    (kind) => {
      const value = document();
      const failure = {
        ...lifecycleError("PRECONDITION_FAILED"),
        message: "untrusted producer prose"
      };
      if (kind === "diagnostics")
        value.diagnostics = [
          { message: "untrusted producer prose", truncated: false }
        ];
      if (kind === "primary") value.primaryFailure = failure;
      if (kind === "secondary") value.additionalFailures = [failure];
      const result = createExecutionEvidenceReader().read(
        JSON.stringify(value),
        identity
      );
      expect(result).toMatchObject({
        status: "ok",
        value: { diagnostics: [{ truncated: true }] }
      });
      expect(JSON.stringify(result)).not.toContain("untrusted producer prose");
    }
  );
  it("accepts the exact tuple and keeps state-save and cleanup failures separate", () => {
    const reader = createExecutionEvidenceReader();
    const value = document();
    value.phases.commands = {
      outcome: "failed",
      exitCode: 17,
      reason: "password=fixture-sensitive-value"
    };
    value.phases.stateSave = { outcome: "failed", exitCode: 9 };
    value.phases.cleanup = { outcome: "failed", exitCode: 5 };
    const result = reader.read(JSON.stringify(value), identity);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        primaryFailure: {
          details: [{ message: "command failed for the correlated workflow." }]
        },
        additionalFailures: [
          {
            details: [
              { message: "state-save failed for the correlated workflow." }
            ]
          },
          {
            details: [
              { message: "cleanup failed for the correlated workflow." }
            ]
          }
        ]
      }
    });
    expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
  });
  it.each([
    ["operationId", "other"],
    ["attemptId", "other"],
    ["operation", "environment.create"],
    ["repo", "other/repo"],
    ["environment", "prod"],
    ["application", "other"],
    ["expectedCommit", "b".repeat(40)],
    ["actualCommit", "b".repeat(40)],
    ["runId", 124],
    ["runAttempt", 2],
    ["runAttempt", 0],
    ["observedAt", "invalid"],
    ["sequence", -1]
  ])("rejects foreign or malformed %s", (field, value) => {
    expect(
      createExecutionEvidenceReader().read(
        JSON.stringify({ ...document(), [field]: value }),
        identity
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  });
  it.each([
    "null",
    "[]",
    "{",
    JSON.stringify({ executionSchemaVersion: 2 }),
    " ".repeat(131073)
  ])("rejects unsupported/malformed bounded JSON", (text) => {
    expect(createExecutionEvidenceReader().read(text, identity).status).toBe(
      "failed"
    );
  });
  it.each(["restore", "commands", "stateSave", "cleanup"] as const)(
    "requires honest phase exits and reasons for %s",
    (phase) => {
      for (const value of [
        { outcome: "succeeded" },
        { outcome: "failed", exitCode: 0 },
        { outcome: "skipped" },
        { outcome: "unknown" },
        { outcome: "succeeded", exitCode: 256 }
      ])
        expect(
          createExecutionEvidenceReader().read(
            JSON.stringify({
              ...document(),
              phases: { ...document().phases, [phase]: value }
            }),
            identity
          ).status
        ).toBe("failed");
    }
  );
  it("fences older, contradictory, and time-regressing evidence within the run", () => {
    const reader = createExecutionEvidenceReader();
    const first = document();
    expect(reader.read(JSON.stringify(first), identity).status).toBe("ok");
    expect(reader.read(JSON.stringify(first), identity).status).toBe("ok");
    for (const next of [
      { ...first, sequence: 3 },
      { ...first, sequence: 5, observedAt: "2026-09-15T00:00:00Z" },
      {
        ...first,
        phases: { ...first.phases, cleanup: { outcome: "failed", exitCode: 3 } }
      }
    ])
      expect(reader.read(JSON.stringify(next), identity)).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_CONFLICT" }
      });
    expect(
      reader.read(JSON.stringify({ ...first, sequence: 5 }), identity).status
    ).toBe("ok");
  });
  it.each(["cancelled", "skipped", "unknown", "not_applicable"] as const)(
    "retains %s rather than manufacturing phase success",
    (outcome) => {
      expect(
        createExecutionEvidenceReader().read(
          JSON.stringify({
            ...document(),
            phases: {
              ...document().phases,
              stateSave: { outcome, reason: "Not observed" }
            }
          }),
          identity
        )
      ).toMatchObject({
        status: "ok",
        value: {
          phases: expect.arrayContaining([
            {
              phase: "state-save",
              status: outcome,
              reason: `state-save: ${outcome}`
            }
          ])
        }
      });
    }
  );
});
