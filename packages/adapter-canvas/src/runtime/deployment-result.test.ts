import { describe, expect, it } from "vitest";
import { deploymentStartResult } from "./deployment-result.js";

describe("deployment admission presentation", () => {
  it.each([null, undefined, "", [], "started"])(
    "rejects an invalid coordinator response: %s",
    (body) => {
      expect(() => deploymentStartResult({ status: 200, body })).toThrow(
        "invalid result"
      );
    }
  );

  it.each([{}, { ok: false }, { ok: "true" }])(
    "does not infer admission from a success status: %j",
    (body) => {
      expect(() => deploymentStartResult({ status: 200, body })).toThrow(
        "did not confirm admission"
      );
    }
  );

  it.each([199, 300, 409, 500])("reports a refused status: %s", (status) => {
    expect(deploymentStartResult({ status, body: {} })).toEqual({
      kind: "failed",
      error: `Deployment request failed (${status}).`
    });
  });

  it.each([200, 299])("accepts explicit admission at status %s", (status) => {
    expect(deploymentStartResult({ status, body: { ok: true } })).toEqual({
      kind: "started"
    });
  });

  it("preserves actionable errors rather than reporting admission", () => {
    expect(
      deploymentStartResult({
        status: 200,
        body: { ok: true, error: "This attempt was replaced." }
      })
    ).toEqual({ kind: "failed", error: "This attempt was replaced." });
    expect(
      deploymentStartResult({ status: 503, body: { error: { message: "x" } } })
    ).toEqual({ kind: "failed", error: "Deployment request failed (503)." });
  });

  it("passes numeric repair budget fields and omits malformed fields", () => {
    expect(
      deploymentStartResult({
        status: 200,
        body: { ok: true, repairAttempt: 2, repairAttemptCap: 5 }
      })
    ).toEqual({ kind: "started", repairAttempt: 2, repairAttemptCap: 5 });
    expect(
      deploymentStartResult({
        status: 200,
        body: { ok: true, repairAttempt: "2", repairAttemptCap: null }
      })
    ).toEqual({ kind: "started" });
  });
});
