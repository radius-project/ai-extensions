import type { ValidationCheck, ValidationReport } from "./contracts/common.js";
import { portFailure, portSuccess, type PortResult } from "./errors.js";
import { sameLifecycleData } from "./operations.js";
import type { ReadonlyData } from "./ports.js";

export interface ValidationPolicy {
  readonly version: "github-radius/validation/v1";
  readonly purpose: "validation" | "authoring";
  readonly provider?: "azure" | "aws";
  readonly checks: readonly Readonly<
    Pick<ValidationCheck, "checkId" | "classification">
  >[];
}
export interface ValidationIdentity {
  readonly sourceFingerprint: string;
  readonly proposalFingerprint?: string;
}

export function createValidationPolicy(
  purpose: ValidationPolicy["purpose"],
  provider?: ValidationPolicy["provider"]
): ValidationPolicy {
  const required = [
    "path-input-closure",
    "bicep-compile",
    "type-compatibility",
    "secret-safety",
    "runtime-contract",
    "reference-consistency",
    "recipe-constraints",
    ...(purpose === "authoring" ? ["modelability", "staged-artifacts"] : [])
  ];
  return Object.freeze({
    version: "github-radius/validation/v1",
    purpose,
    ...(provider ? { provider } : {}),
    checks: Object.freeze([
      ...required.map((checkId) =>
        Object.freeze({ checkId, classification: "required" as const })
      ),
      Object.freeze({
        checkId: "descriptive-enrichment",
        classification: "advisory" as const
      })
    ])
  });
}

export function reduceValidationReport(
  policy: ValidationPolicy,
  outcomes: readonly ReadonlyData<ValidationCheck>[],
  identity: ValidationIdentity,
  diagnostics: ReadonlyData<ValidationReport["diagnostics"]> = []
): ValidationReport {
  const received = new Map<string, ReadonlyData<ValidationCheck>>();
  for (const check of outcomes) {
    if (
      received.has(check.checkId) ||
      !policy.checks.some(
        (declared) =>
          declared.checkId === check.checkId &&
          declared.classification === check.classification
      )
    )
      throw new Error("Validation outcomes must match the predeclared policy.");
    received.set(check.checkId, check);
  }
  const checks: ValidationCheck[] = policy.checks.map((declared) => ({
    ...(received.get(declared.checkId) ?? {
      ...declared,
      status: "unavailable",
      reason: "The declared check did not return evidence."
    })
  }));
  const required = checks.filter(
    (check) => check.classification === "required"
  );
  return {
    sourceFingerprint: identity.sourceFingerprint,
    ...(identity.proposalFingerprint ?
      { proposalFingerprint: identity.proposalFingerprint }
    : {}),
    status:
      required.some((check) => check.status === "failed") ? "failed"
      : required.some((check) => check.status !== "passed") ? "incomplete"
      : "passed",
    checks,
    warnings: checks
      .filter(
        (check) =>
          check.classification === "advisory" && check.status !== "passed"
      )
      .map((check) => `${check.checkId}: ${check.reason}`),
    diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic }))
  };
}

export function verifyValidationReport(
  policy: ValidationPolicy,
  report: ReadonlyData<ValidationReport>,
  identity: ValidationIdentity
): PortResult<ValidationReport> {
  if (
    report.sourceFingerprint !== identity.sourceFingerprint ||
    report.proposalFingerprint !== identity.proposalFingerprint ||
    report.checks.length !== policy.checks.length
  )
    return portFailure("EVIDENCE_MISMATCH");
  try {
    const reduced = reduceValidationReport(
      policy,
      report.checks,
      identity,
      report.diagnostics
    );
    if (
      reduced.status !== report.status ||
      !sameLifecycleData(reduced.warnings, report.warnings)
    )
      return portFailure("EVIDENCE_MISMATCH");
    return portSuccess(reduced);
  } catch {
    return portFailure("EVIDENCE_MISMATCH");
  }
}
