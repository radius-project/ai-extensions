import { describe, expect, it } from "vitest";
import {
  findExactVerificationRun,
  hasPostDispatchVerificationRuns,
  hasVerificationOperationMarker,
  verificationRunTitle
} from "./verification-run-identity.js";
import {
  createOperation,
  fromPersistedOperation,
  toPersistedOperation
} from "./operations.js";

const identity = {
  baselineRunId: 40,
  dispatchedAt: Date.parse("2026-08-22T00:00:00Z"),
  ref: "main",
  environment: "dev",
  operationMarker: "op_verify",
  event: "workflow_dispatch" as const
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 41,
    createdAt: "2026-08-22T00:00:01Z",
    displayTitle: verificationRunTitle("dev", "op_verify"),
    event: "workflow_dispatch",
    headBranch: "main",
    ...overrides
  };
}

describe("verification run identity", () => {
  it("adopts only the exact marked workflow dispatch", () => {
    expect(findExactVerificationRun([run()], identity)).toEqual({
      state: "applied",
      runId: "41"
    });
  });

  it("adopts an exact push run only when push is expected", () => {
    expect(
      findExactVerificationRun([run({ event: "push" })], {
        ...identity,
        event: "push"
      })
    ).toEqual({ state: "applied", runId: "41" });
  });

  it.each([
    ["marker", { displayTitle: verificationRunTitle("dev", "op_other") }],
    [
      "environment",
      { displayTitle: verificationRunTitle("prod", "op_verify") }
    ],
    ["event", { event: "push" }],
    ["ref", { headBranch: "feature" }],
    ["baseline", { databaseId: 40 }],
    ["time", { createdAt: "2026-08-21T23:00:00Z" }]
  ])("rejects a run with the wrong %s", (_label, mismatch) => {
    expect(findExactVerificationRun([run(mismatch)], identity)).toEqual({
      state: "not_found"
    });
  });

  it("fails closed when multiple runs carry the exact marker", () => {
    expect(
      findExactVerificationRun([run(), run({ databaseId: 42 })], identity)
    ).toEqual({ state: "ambiguous" });
  });

  it("ignores malformed run metadata", () => {
    expect(
      findExactVerificationRun(
        [
          null,
          {},
          run({ databaseId: "not-a-number" }),
          run({ createdAt: "not-a-date" })
        ],
        identity
      )
    ).toEqual({ state: "not_found" });
    expect(findExactVerificationRun({}, identity)).toEqual({
      state: "not_found"
    });
  });

  it("detects new unmatched runs without treating baseline runs as candidates", () => {
    expect(
      hasPostDispatchVerificationRuns(
        [
          run({ databaseId: 40 }),
          run({ databaseId: 41, displayTitle: "unrelated" })
        ],
        40,
        identity.dispatchedAt
      )
    ).toBe(true);
    expect(
      hasPostDispatchVerificationRuns(
        [run({ databaseId: 40 })],
        40,
        identity.dispatchedAt
      )
    ).toBe(false);
    expect(
      hasPostDispatchVerificationRuns(
        [null, {}, { databaseId: "invalid", createdAt: "not-a-date" }],
        40,
        identity.dispatchedAt
      )
    ).toBe(false);
    expect(hasPostDispatchVerificationRuns({}, 40, identity.dispatchedAt)).toBe(
      false
    );
  });

  it("detects whether the installed workflow exposes the marker contract", () => {
    expect(
      hasVerificationOperationMarker(`
on:
  workflow_dispatch:
    inputs:
      radius_operation:
run-name: Radius verify \${{ inputs.radius_operation }}
`)
    ).toBe(true);
    expect(hasVerificationOperationMarker("on: workflow_dispatch")).toBe(false);
  });
});

describe("the pre-dispatch verification record", () => {
  // A retry writes its verification record, saves it, and only then asks GitHub
  // to start the run. A restart in that window must still be able to recognise
  // the run the dispatch produced, which it can only do if the marker and event
  // it sent were durable before the request went out.
  function preDispatchRetryRecord() {
    const operation = createOperation({
      operationId: "op_verify",
      provider: "azure",
      repo: "octo/app",
      environment: "dev"
    });
    operation.verification = {
      dispatchedAt: identity.dispatchedAt,
      workflow: "radius-verify-credentials.yml",
      ref: identity.ref,
      environment: identity.environment,
      event: "workflow_dispatch",
      operationMarker: identity.operationMarker,
      baselineRunId: identity.baselineRunId,
      runId: null,
      runUrl: null
    };
    return operation;
  }

  it("keeps the marker and event through a restart taken before the dispatch", () => {
    const restored = fromPersistedOperation(
      toPersistedOperation(preDispatchRetryRecord())
    );

    expect(restored.verification).toMatchObject({
      event: "workflow_dispatch",
      operationMarker: "op_verify",
      baselineRunId: 40,
      runId: null
    });
  });

  it("adopts the exact run a lost dispatch started, after that restart", () => {
    const restored = fromPersistedOperation(
      toPersistedOperation(preDispatchRetryRecord())
    );
    const saved = restored.verification;

    expect(
      findExactVerificationRun([run(), run({ databaseId: 39 })], {
        baselineRunId: saved.baselineRunId,
        dispatchedAt: saved.dispatchedAt,
        ref: saved.ref,
        environment: saved.environment,
        operationMarker: saved.operationMarker,
        event: "workflow_dispatch"
      })
    ).toEqual({ state: "applied", runId: "41" });
  });

  it("cannot claim the run when the marker was not journaled before the dispatch", () => {
    const operation = preDispatchRetryRecord();
    // The defect this guards: a pre-dispatch record written without the marker.
    delete operation.verification.operationMarker;
    delete operation.verification.event;
    const saved = fromPersistedOperation(
      toPersistedOperation(operation)
    ).verification;

    expect(saved.operationMarker).toBeUndefined();
    expect(
      findExactVerificationRun([run()], {
        baselineRunId: saved.baselineRunId,
        dispatchedAt: saved.dispatchedAt,
        ref: saved.ref,
        environment: saved.environment,
        operationMarker: saved.operationMarker || "",
        event: "workflow_dispatch"
      })
    ).toEqual({ state: "not_found" });
  });
});
