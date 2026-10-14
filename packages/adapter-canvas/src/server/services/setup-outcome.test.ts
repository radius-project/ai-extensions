import { describe, expect, it, vi } from "vitest";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import {
  copySetupRequest,
  setupHandlerFailure,
  setupStageResult,
  type SetupOutcome
} from "./setup-outcome.js";

describe("setup coordinator boundary compatibility", () => {
  it.each([
    [
      "completed",
      200,
      { clientId: "client" },
      { kind: "completed", clientId: "client" }
    ],
    ["completed", 200, {}, { kind: "completed", clientId: undefined }],
    [
      "stopped",
      200,
      { cancelled: true, clientId: "ignored" },
      { kind: "completed", clientId: undefined }
    ],
    [
      "input-required",
      400,
      { inputRequired: true },
      { kind: "input-required", clientId: undefined }
    ],
    [
      "input-required",
      409,
      { inputRequired: true, clientId: "client" },
      { kind: "input-required", clientId: "client" }
    ],
    [
      "reconciling",
      202,
      { message: "Still reconciling." },
      { kind: "reconciling", message: "Still reconciling." }
    ],
    ["reconciling", 202, {}, { kind: "reconciling", message: undefined }]
  ] satisfies Array<
    [SetupOutcome["kind"], number, Record<string, unknown>, unknown]
  >)(
    "maps %s HTTP %s without changing the core stage contract",
    (kind, status, body, expected) => {
      expect(setupStageResult({ kind, status, body })).toEqual(expected);
    }
  );

  it.each([
    ["failed", 400, "public failure"],
    ["failed", 500, ""],
    ["refused", 409, "operation does not match"],
    ["refused", 403, undefined]
  ] satisfies Array<[SetupOutcome["kind"], number, string | undefined]>)(
    "recreates a plain Error for %s HTTP %s, never a provider exception",
    (kind, status, error) => {
      let failure: unknown;
      try {
        setupStageResult({ kind, status, body: { error } });
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.constructor).toBe(Error);
      expect(failure).not.toBeInstanceOf(ProviderMutationRecoveryError);
      expect(failure).toMatchObject({
        message: error || `Request failed with HTTP ${status}.`
      });
    }
  );

  it("copies nested request values and omits undefined exactly like JSON transport", () => {
    const request = {
      absent: undefined,
      empty: "",
      nested: { absent: undefined, values: [undefined, "original"] }
    };
    const copied = copySetupRequest(request);
    expect(copied).toEqual({
      empty: "",
      nested: { values: [null, "original"] }
    });
    expect(copied.nested).not.toBe(request.nested);
    request.nested.values[1] = "changed";
    expect(copied).toEqual({
      empty: "",
      nested: { values: [null, "original"] }
    });
    expect(() => copySetupRequest({ value: 1n })).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => copySetupRequest(cycle)).toThrow(TypeError);
  });

  it.each([new Error("private detail"), "private detail"])(
    "keeps unexpected failure diagnostics private: %s",
    (error) => {
      const report = vi.fn();
      const outcome = setupHandlerFailure(error, report);
      expect(report).toHaveBeenCalledExactlyOnceWith({
        code: "setup-handler-failed",
        message: "private detail"
      });
      expect(outcome).toEqual({
        kind: "failed",
        status: 500,
        body: {
          error:
            "Setup could not finish reporting its outcome. Inspect the operation before retrying.",
          code: "setup-handler-failed"
        }
      });
      expect(() => setupStageResult(outcome)).toThrow(
        outcome.body.error as string
      );
    }
  );

  it("still returns the public failure if the diagnostic sink rejects", () => {
    const outcome = setupHandlerFailure(new Error("private"), () => {
      throw new Error("diagnostic sink unavailable");
    });
    expect(outcome.status).toBe(500);
    expect(outcome.body.code).toBe("setup-handler-failed");
    expect(() => setupStageResult(outcome)).toThrow(
      "Setup could not finish reporting its outcome."
    );
  });
});
