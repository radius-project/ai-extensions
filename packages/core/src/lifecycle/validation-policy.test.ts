import { describe, expect, it } from "vitest";
import type { ValidationCheck } from "./contracts/common.js";
import {
  createValidationPolicy,
  reduceValidationReport,
  verifyValidationReport
} from "./validation-policy.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
describe("definition validation policy", () => {
  const policy = createValidationPolicy("validation");
  const checks = () =>
    policy.checks.map((check) => ({
      ...check,
      status: "passed" as const,
      reason: "Verified."
    }));
  it.each([
    ["required", "passed", "passed"],
    ["required", "failed", "failed"],
    ["required", "unavailable", "incomplete"],
    ["required", "skipped", "incomplete"],
    ["advisory", "passed", "passed"],
    ["advisory", "failed", "passed"],
    ["advisory", "unavailable", "passed"],
    ["advisory", "skipped", "passed"]
  ] as const)("reduces %s %s to %s", (classification, status, expected) => {
    const input: ValidationCheck[] = checks().map((check) =>
      check.classification === classification ? { ...check, status } : check
    );
    const report = reduceValidationReport(policy, input, {
      sourceFingerprint: fingerprint
    });
    expect(report.status).toBe(expected);
    expect(report.warnings.length > 0).toBe(
      classification === "advisory" && status !== "passed"
    );
  });
  it("fixes required checks before execution and limits authoring applicability", () => {
    const authoring = createValidationPolicy("authoring");
    expect(Object.isFrozen(authoring)).toBe(true);
    expect(Object.isFrozen(authoring.checks)).toBe(true);
    expect(
      authoring.checks.filter((check) => check.classification === "required")
    ).toEqual(
      expect.arrayContaining([
        { checkId: "modelability", classification: "required" },
        { checkId: "staged-artifacts", classification: "required" },
        ...policy.checks.filter((check) => check.classification === "required")
      ])
    );
    expect(
      policy.checks.some((check) => check.checkId === "modelability")
    ).toBe(false);
  });
  it("prioritizes required failures and accounts for omitted checks", () => {
    const input: ValidationCheck[] = [{ ...checks()[0], status: "failed" }];
    expect(
      reduceValidationReport(policy, input, { sourceFingerprint: fingerprint })
        .status
    ).toBe("failed");
    expect(
      reduceValidationReport(policy, [], { sourceFingerprint: fingerprint })
        .status
    ).toBe("incomplete");
  });
  it("rejects check substitution, duplication and classification downgrades", () => {
    for (const input of [
      [...checks(), checks()[0]],
      checks().map((check, index) =>
        index === 0 ? { ...check, classification: "advisory" as const } : check
      ),
      [
        ...checks(),
        {
          checkId: "invented",
          classification: "advisory" as const,
          status: "passed" as const,
          reason: "No."
        }
      ]
    ]) {
      expect(() =>
        reduceValidationReport(policy, input, {
          sourceFingerprint: fingerprint
        })
      ).toThrow();
    }
  });
  it("rejects stale source/proposal evidence and dishonest status or warnings", () => {
    const identity = {
      sourceFingerprint: fingerprint,
      proposalFingerprint: `sha256:${"b".repeat(64)}`
    };
    const report = reduceValidationReport(policy, checks(), identity);
    expect(verifyValidationReport(policy, report, identity).status).toBe("ok");
    for (const invalid of [
      { ...report, sourceFingerprint: identity.proposalFingerprint },
      { ...report, proposalFingerprint: undefined },
      { ...report, status: "failed" as const },
      { ...report, warnings: ["Invented warning"] },
      { ...report, checks: [] },
      {
        ...report,
        checks: report.checks.map((check, index) =>
          index === 1 ? report.checks[0] : check
        )
      },
      { ...report, checks: [...report.checks, report.checks[0]] }
    ])
      expect(verifyValidationReport(policy, invalid, identity).status).toBe(
        "failed"
      );
  });
  it("copies redacted diagnostics and excludes execution-only request fields", () => {
    const identity = {
      sourceFingerprint: fingerprint,
      snapshotRef: "private-owned-ref"
    };
    const diagnostics = [{ message: "Bounded evidence.", truncated: true }];
    const report = reduceValidationReport(
      policy,
      checks(),
      identity,
      diagnostics
    );
    expect(report.diagnostics).toEqual(diagnostics);
    expect(report.diagnostics).not.toBe(diagnostics);
    expect(report).not.toHaveProperty("snapshotRef");
  });
});
