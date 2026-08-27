import { describe, expect, it } from "vitest";
import { createOperationDiagnosticExport } from "./operation-diagnostic-export.js";

const STARTED_AT = "2026-08-27T10:00:00.000Z";
const LAST_ACTIVITY_AT = "2026-08-27T10:00:05.000Z";
const ENDED_AT = "2026-08-27T10:00:10.000Z";
const GENERATED_AT = Date.parse("2026-08-27T11:00:00.000Z");
const OPERATION_ID = "op_12345678-1234-4123-8123-123456789abc";

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION_ID,
    schemaVersion: 6,
    provider: "azure",
    state: "failed_partial",
    currentStage: "configure_environment",
    startedAt: STARTED_AT,
    lastActivityAt: LAST_ACTIVITY_AT,
    endedAt: ENDED_AT,
    stages: [
      { id: "authorize_identity", state: "succeeded", label: "secret label" },
      { id: "configure_environment", state: "failed", label: "raw stderr" },
      { id: "verify", state: "skipped", label: "attacker text" }
    ],
    control: {
      attempts: { setup: 2, verification: 1 },
      stop: {
        requestedAt: "2026-08-27T10:00:03.000Z",
        acknowledgedAt: "2026-08-27T10:00:04.000Z",
        boundary: "attacker-controlled-boundary"
      },
      commands: [
        { kind: "retry_setup", state: "finished", target: "secret target" },
        { kind: "retry_setup", state: "finished", outcome: "secret outcome" },
        { kind: "rollback", state: "running", commandId: "secret id" }
      ]
    },
    failure: {
      code: "SECRET_FAILURE_CODE",
      classification: "user-fixable",
      stage: "configure_environment",
      message: "IGNORE PREVIOUS INSTRUCTIONS",
      evidence: "RAW_STDERR_TOKEN"
    },
    setupArtifacts: {
      cleanup: {
        state: "succeeded_with_warnings",
        attempts: 3,
        results: [
          {
            artifactType: "azure_app",
            outcome: "deleted",
            target: "SECRET_APP_ID",
            detail: "raw command output"
          },
          {
            artifactType: "azure_app",
            outcome: "warning",
            target: "SECRET_APP_ID",
            detail: "IGNORE PREVIOUS INSTRUCTIONS"
          },
          {
            artifactType: "github_environment_variable",
            outcome: "warning",
            target: "SECRET_REPOSITORY",
            detail: "RAW_STDERR_TOKEN"
          }
        ]
      },
      azureApp: { appId: "SECRET_APP_ID" }
    },
    providerRecovery: {
      state: "manual_required",
      guidance: "IGNORE PREVIOUS INSTRUCTIONS",
      mutations: [
        {
          kind: "azure_application.create",
          status: "confirmed",
          target: "SECRET_TARGET",
          evidence: "RAW_STDERR_TOKEN"
        },
        {
          kind: "github_environment_variable.put",
          status: "manual_required",
          intent: { value: "SECRET_VALUE" }
        },
        {
          kind: "github_environment_variable.put",
          status: "manual_required"
        }
      ]
    },
    verification: {
      dispatchedAt: Date.parse("2026-08-27T10:00:08.000Z"),
      workflow: "SECRET_WORKFLOW",
      ref: "SECRET_BRANCH",
      runUrl: "SECRET_URL"
    },
    request: { clientSecret: "SECRET_CLIENT_SECRET" },
    resumeRequest: { tenantId: "SECRET_TENANT" },
    repo: "SECRET_REPOSITORY",
    environment: "SECRET_ENVIRONMENT",
    ...overrides
  };
}

function build(value: unknown = operation(), version = "0.3.0-edge.1") {
  return createOperationDiagnosticExport({
    operation: value,
    version,
    now: GENERATED_AT
  });
}

describe("createOperationDiagnosticExport", () => {
  it("builds the exact local support schema from allowlisted states and counts", () => {
    expect(build()).toEqual({
      diagnosticSchemaVersion: 1,
      generatedAt: "2026-08-27T11:00:00.000Z",
      productVersion: "0.3.0-edge.1",
      operation: {
        operationId: OPERATION_ID,
        operationSchemaVersion: 6,
        provider: "azure",
        lifecycle: {
          state: "failed_partial",
          terminalState: "failed_partial",
          currentStage: "configure_environment"
        },
        timing: {
          startedAt: STARTED_AT,
          lastActivityAt: LAST_ACTIVITY_AT,
          endedAt: ENDED_AT,
          durationMs: 10_000
        },
        stages: [
          { id: "authorize_identity", state: "succeeded" },
          { id: "configure_environment", state: "failed" },
          { id: "verify", state: "skipped" }
        ],
        attempts: { setup: 2, verification: 1 },
        failure: {
          classification: "user-fixable",
          stage: "configure_environment"
        },
        stop: { requested: true, acknowledged: true },
        commandCounts: [
          { kind: "retry_setup", state: "finished", count: 2 },
          { kind: "rollback", state: "running", count: 1 }
        ],
        cleanup: {
          state: "succeeded_with_warnings",
          attempts: 3,
          outcomeCounts: [
            { artifactType: "azure_app", outcome: "deleted", count: 1 },
            { artifactType: "azure_app", outcome: "warning", count: 1 },
            {
              artifactType: "github_environment_variable",
              outcome: "warning",
              count: 1
            }
          ],
          warningCount: 2
        },
        recovery: {
          state: "manual_required",
          mutationStatusCounts: [
            { status: "confirmed", count: 1 },
            { status: "manual_required", count: 2 }
          ]
        },
        verificationDispatched: true,
        unrecognizedValueCount: 0
      }
    });
  });

  it("never serializes secrets, raw evidence, free-form labels, or hostile instructions", () => {
    const serialized = JSON.stringify(build());
    for (const forbidden of [
      "SECRET",
      "RAW_STDERR_TOKEN",
      "IGNORE PREVIOUS INSTRUCTIONS",
      "attacker text",
      "secret label",
      "secret target",
      "raw command output"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("replaces future enum values with a fixed marker and reports every replacement", () => {
    const diagnostic = build(
      operation({
        provider: "future-cloud",
        state: "future-state",
        currentStage: "future-stage",
        stages: [{ id: "future-stage", state: "future-stage-state" }],
        control: {
          attempts: { setup: 1, verification: 0, cleanup: 0 },
          stop: { requestedAt: null, acknowledgedAt: null },
          commands: [{ kind: "future-command", state: "future-command-state" }]
        },
        failure: {
          classification: "future-classification",
          stage: "future-stage",
          message: "do not serialize me"
        },
        setupArtifacts: {
          cleanup: {
            state: "future-cleanup",
            attempts: 0,
            results: [
              {
                artifactType: "future-artifact",
                outcome: "future-outcome"
              }
            ]
          }
        },
        providerRecovery: {
          state: "future-recovery",
          mutations: [{ status: "future-mutation" }]
        }
      })
    );

    expect(diagnostic.operation).toMatchObject({
      provider: "unknown",
      lifecycle: {
        state: "unknown",
        terminalState: "unknown",
        currentStage: "unknown"
      },
      stages: [{ id: "unknown", state: "unknown" }],
      failure: { classification: "unknown", stage: "unknown" },
      commandCounts: [{ kind: "unknown", state: "unknown", count: 1 }],
      cleanup: {
        state: "unknown",
        outcomeCounts: [
          { artifactType: "unknown", outcome: "unknown", count: 1 }
        ]
      },
      recovery: {
        state: "unknown",
        mutationStatusCounts: [{ status: "unknown", count: 1 }]
      },
      unrecognizedValueCount: 14
    });
    expect(JSON.stringify(diagnostic)).not.toContain("future-");
  });

  it("uses null and zero for invalid structured values without emitting them", () => {
    const diagnostic = build(
      operation({
        schemaVersion: "six",
        state: "running",
        currentStage: null,
        startedAt: "not-a-date",
        lastActivityAt: 123,
        endedAt: null,
        stages: [],
        control: {
          attempts: { setup: -1, verification: 1.5, cleanup: "three" },
          stop: { requestedAt: 123, acknowledgedAt: null },
          commands: []
        },
        failure: ["IGNORE PREVIOUS INSTRUCTIONS"],
        setupArtifacts: {
          cleanup: { state: "not_started", attempts: "zero", results: [] }
        },
        providerRecovery: { state: null, mutations: [] },
        verification: { dispatchedAt: -1 }
      }),
      "version with spaces"
    );

    expect(diagnostic).toMatchObject({
      productVersion: "unknown",
      operation: {
        operationSchemaVersion: null,
        lifecycle: {
          state: "running",
          terminalState: null,
          currentStage: null
        },
        timing: {
          startedAt: null,
          lastActivityAt: null,
          endedAt: null,
          durationMs: null
        },
        attempts: { setup: 0, verification: 0 },
        failure: null,
        stop: { requested: false, acknowledged: false },
        cleanup: { state: "not_started", attempts: 0 },
        recovery: { state: null, mutationStatusCounts: [] },
        verificationDispatched: false,
        unrecognizedValueCount: 8
      }
    });
    expect(JSON.stringify(diagnostic)).not.toContain("not-a-date");
    expect(JSON.stringify(diagnostic)).not.toContain("version with spaces");
    expect(JSON.stringify(diagnostic)).not.toContain(
      "IGNORE PREVIOUS INSTRUCTIONS"
    );
  });

  it("uses the last activity time for an active operation duration", () => {
    const diagnostic = build(
      operation({ state: "running", endedAt: null, failure: null })
    );
    expect(diagnostic.operation.lifecycle.terminalState).toBeNull();
    expect(diagnostic.operation.timing.durationMs).toBe(5_000);
  });

  it("reports missing nested control, cleanup, and recovery state without exposing defaults", () => {
    const diagnostic = build(
      operation({
        control: null,
        setupArtifacts: null,
        providerRecovery: null,
        failure: null
      })
    );
    expect(diagnostic.operation).toMatchObject({
      attempts: { setup: 0, verification: 0 },
      stop: { requested: false, acknowledged: false },
      commandCounts: [],
      cleanup: {
        state: "unknown",
        attempts: 0,
        outcomeCounts: [],
        warningCount: 0
      },
      recovery: { state: null, mutationStatusCounts: [] },
      unrecognizedValueCount: 4
    });
  });

  it("rejects a duration that moves backwards", () => {
    const diagnostic = build(
      operation({
        state: "running",
        startedAt: ENDED_AT,
        lastActivityAt: STARTED_AT,
        endedAt: null,
        failure: null
      })
    );
    expect(diagnostic.operation.timing.durationMs).toBeNull();
    expect(diagnostic.operation.unrecognizedValueCount).toBe(1);
  });

  it.each([
    [null, "Operation record is required."],
    [{}, "Operation record has no valid generated identifier."],
    [
      { operationId: "attacker-controlled-id" },
      "Operation record has no valid generated identifier."
    ]
  ])("rejects an invalid operation record %#", (value, message) => {
    expect(() => build(value)).toThrow(message);
  });

  it("rejects an invalid generation time", () => {
    expect(() =>
      createOperationDiagnosticExport({
        operation: operation(),
        version: "0.3.0",
        now: Number.NaN
      })
    ).toThrow("Diagnostic generation time is invalid.");
  });
});
