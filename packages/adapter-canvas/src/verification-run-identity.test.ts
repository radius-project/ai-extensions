import { describe, expect, it } from "vitest";
import {
  findExactVerificationRun,
  hasPostDispatchVerificationRuns,
  hasVerificationOperationMarker,
  verificationRunTitle
} from "./verification-run-identity.js";

const identity = {
  baselineRunId: 40,
  dispatchedAt: Date.parse("2026-08-22T00:00:00Z"),
  ref: "main",
  environment: "dev",
  operationMarker: "op_verify"
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
