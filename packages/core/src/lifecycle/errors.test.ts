import { describe, expect, expectTypeOf, it } from "vitest";
import {
  lifecycleErrorSchema,
  type LifecycleError
} from "./contracts/common.js";
import {
  lifecycleError,
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  toLifecycleErrorResponse,
  type AbsenceObservation,
  type FailureCode,
  type ReadResult,
  type RedactedDiagnostics,
  type UnavailableCode,
  type UnavailableObservation
} from "./errors.js";
import type {
  GraphCompilationInput,
  IncompleteInputManifest,
  SourceAccessPort,
  SourceSelection,
  WorkflowIntent
} from "./ports.js";

const observedAt = "2026-09-15T22:00:00Z";
const absentObservation = {
  quality: "current",
  completeness: "complete",
  evidence: "source",
  observedAt
} satisfies AbsenceObservation;
const unavailableObservation = {
  quality: "unknown",
  completeness: "unavailable",
  evidence: "workflow",
  limitation: "Evidence could not be refreshed"
} satisfies UnavailableObservation;

describe("lifecycle failure helpers", () => {
  it.each(lifecycleErrorSchema.properties.code.enum)(
    "provides a safe actionable message for %s with retries disabled by default",
    (code) => {
      const error = lifecycleError(code);
      expect(error).toEqual({
        code,
        message: expect.any(String),
        retryable: false,
        nextAction: expect.any(String)
      });
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.nextAction?.length).toBeGreaterThan(0);
      expect(error.message.length).toBeLessThanOrEqual(4096);
      expect(JSON.parse(JSON.stringify(error))).toEqual(error);
    }
  );

  it("preserves explicit safe read retries without implying mutation retry", () => {
    expect(
      portUnavailable("RESULT_UNAVAILABLE", unavailableObservation, {
        retryable: true,
        operationId: "operation-1"
      })
    ).toEqual({
      status: "unavailable",
      observation: unavailableObservation,
      error: {
        code: "RESULT_UNAVAILABLE",
        message: "Detailed execution evidence is unavailable.",
        retryable: true,
        operationId: "operation-1",
        nextAction: "Refresh the observation without repeating the mutation."
      }
    });
    expect(portFailure("DISPATCH_UNCONFIRMED").error.retryable).toBe(false);
    expect(portFailure("DISPATCH_UNCONFIRMED").error.nextAction).toBe(
      "Reconcile the existing operation; do not dispatch it again."
    );
  });

  it("keeps confirmed absence, unavailable evidence, forbidden access and empty success distinct", () => {
    const results: ReadResult<string[]>[] = [
      portSuccess([]),
      portAbsent(absentObservation),
      portUnavailable("SOURCE_UNAVAILABLE", unavailableObservation),
      portForbidden(),
      portFailure("SOURCE_CHANGED"),
      portCancelled("request_cancelled")
    ];
    expect(results.map((result) => result.status)).toEqual([
      "ok",
      "absent",
      "unavailable",
      "forbidden",
      "failed",
      "cancelled"
    ]);
    expect(portSuccess([])).toEqual({ status: "ok", value: [] });
    expect(portAbsent(absentObservation)).toEqual({
      status: "absent",
      reason: "not_found",
      observation: absentObservation
    });
    expect(portForbidden().error).toMatchObject({
      code: "FORBIDDEN",
      retryable: false
    });
    expect(portCancelled("session_shutdown")).toEqual({
      status: "cancelled",
      reason: "session_shutdown"
    });
    expect(portSuccess(undefined)).toEqual({ status: "ok", value: undefined });
  });

  it("copies redacted diagnostics and bounds both count and message length with truncation disclosed", () => {
    const diagnostics: RedactedDiagnostics = [
      {
        message: "A redacted compiler diagnostic",
        truncated: false,
        classification: "compiler.failure",
        location: ".radius/app.bicep"
      }
    ];
    const error = lifecycleError("VALIDATION_FAILED", {
      operationId: "operation-1",
      diagnostics,
      retryable: false
    });
    expect(error.details).toEqual(diagnostics);
    expect(error.details).not.toBe(diagnostics);
    expect(error.details?.[0]).not.toBe(diagnostics[0]);
    expect(
      lifecycleError("VALIDATION_FAILED", { diagnostics: [] }).details
    ).toEqual([]);
    const boundary = lifecycleError("VALIDATION_FAILED", {
      diagnostics: Array.from({ length: 100 }, () => ({
        message: "x".repeat(4096),
        truncated: false
      }))
    });
    expect(boundary.details).toHaveLength(100);
    expect(boundary.details?.every((detail) => !detail.truncated)).toBe(true);
    const overflow = lifecycleError("VALIDATION_FAILED", {
      diagnostics: Array.from({ length: 101 }, () => ({
        message: "x".repeat(4097),
        truncated: false
      }))
    });
    expect(overflow.details).toHaveLength(100);
    expect(
      overflow.details?.every(
        (detail) => detail.message.length === 4096 && detail.truncated
      )
    ).toBe(true);
    const countOnly = lifecycleError("VALIDATION_FAILED", {
      diagnostics: Array.from({ length: 101 }, () => ({
        message: "short",
        truncated: false
      }))
    });
    expect(
      countOnly.details?.filter((detail) => detail.truncated)
    ).toHaveLength(1);
    expect(countOnly.details?.[99].truncated).toBe(true);
    expect(
      lifecycleError("VALIDATION_FAILED", {
        diagnostics: [{ message: "Already truncated", truncated: true }]
      }).details?.[0].truncated
    ).toBe(true);
  });

  it("projects only declared safe diagnostic fields, never an external error or its stack", () => {
    const diagnostic = {
      message: "Redacted",
      truncated: false,
      rawError: new Error("must not escape"),
      rawResponse: "untrusted provider response"
    };
    const error = lifecycleError("EVIDENCE_CONFLICT", {
      diagnostics: [diagnostic]
    });
    expect(error.details).toEqual([{ message: "Redacted", truncated: false }]);
    expect(error).not.toHaveProperty("stack");
  });

  it("produces independent versioned failure envelopes without dropping the primary failure", () => {
    const failure = portFailure("PRECONDITION_FAILED", {
      operationId: "operation-1",
      diagnostics: [{ message: "Cleanup also failed", truncated: false }]
    });
    const response = toLifecycleErrorResponse("request-1", failure);
    expect(response).toEqual({
      apiVersion: "github-radius/v1",
      requestId: "request-1",
      error: failure.error
    });
    expect(response.error).not.toBe(failure.error);
    expect(response.error.details).not.toBe(failure.error.details);
    expect(response.error.code).toBe("PRECONDITION_FAILED");
    expect(
      toLifecycleErrorResponse(
        "request-2",
        portForbidden({ operationId: "operation-2" })
      ).error
    ).toMatchObject({
      code: "FORBIDDEN",
      operationId: "operation-2",
      retryable: false
    });
    expect(
      toLifecycleErrorResponse(
        "request-3",
        portUnavailable("RESULT_UNAVAILABLE", unavailableObservation)
      ).error.code
    ).toBe("RESULT_UNAVAILABLE");
    const adapterFailure = {
      status: "failed",
      error: {
        code: "EVIDENCE_CONFLICT",
        message: "Redacted conflict explanation",
        retryable: false,
        rawError: new Error("must not escape")
      }
    } as const;
    expect(toLifecycleErrorResponse("request-4", adapterFailure).error).toEqual(
      {
        code: "EVIDENCE_CONFLICT",
        message: "Redacted conflict explanation",
        retryable: false
      }
    );
  });

  it("copies observations so adapter mutation cannot rewrite an already returned result", () => {
    const absent = portAbsent(absentObservation);
    const unavailable = portUnavailable(
      "SOURCE_UNAVAILABLE",
      unavailableObservation
    );
    expect(absent.observation).toEqual(absentObservation);
    expect(absent.observation).not.toBe(absentObservation);
    expect(unavailable.observation).toEqual(unavailableObservation);
    expect(unavailable.observation).not.toBe(unavailableObservation);
    const absentWithExtras = {
      ...absentObservation,
      limitation: "Definition not found",
      rawError: new Error("not public")
    };
    expect(portAbsent(absentWithExtras).observation).toEqual({
      ...absentObservation,
      limitation: "Definition not found"
    });
    const stale = {
      quality: "stale",
      completeness: "partial",
      evidence: "artifact",
      observedAt
    } as const;
    expect(portUnavailable("RESULT_UNAVAILABLE", stale).observation).toEqual(
      stale
    );
  });

  it("keeps outcome classifications exhaustive and unavailable facts out of confirmed absence types", () => {
    expectTypeOf<FailureCode>().not.toMatchTypeOf<UnavailableCode>();
    expectTypeOf<"FORBIDDEN">().not.toMatchTypeOf<
      FailureCode | UnavailableCode
    >();
    expectTypeOf<AbsenceObservation["quality"]>().toEqualTypeOf<"current">();
    expectTypeOf<UnavailableObservation["quality"]>().toEqualTypeOf<
      "stale" | "unknown"
    >();
    expectTypeOf<
      ReturnType<typeof lifecycleError>
    >().toEqualTypeOf<LifecycleError>();
    expectTypeOf<IncompleteInputManifest>().not.toHaveProperty("fingerprint");
    expectTypeOf<GraphCompilationInput>().not.toHaveProperty("scope");
    expectTypeOf<GraphCompilationInput>().not.toHaveProperty("caller");
    expectTypeOf<
      Parameters<SourceAccessPort["capture"]>[1]
    >().toEqualTypeOf<SourceSelection>();
    expectTypeOf<
      Extract<WorkflowIntent, { operation: "application.delete" }>["target"]
    >().toMatchTypeOf<
      Readonly<{ repo: string; environment: string; application: string }>
    >();
  });
});
