import { describe, expect, it, vi } from "vitest";
import { createDefinitionValidation } from "./definition-validation.js";
import {
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess
} from "./errors.js";
import type { AuthorizedScope, SourceSnapshot } from "./ports.js";
import { reduceValidationReport } from "./validation-policy.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const target = {
  repo: "owner/repo",
  definition: ".radius/app.bicep",
  source: {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: fingerprint
  }
};
const snapshot: SourceSnapshot = {
  snapshotRef: "snapshot",
  selection: target,
  provenance: {
    repo: target.repo,
    kind: "workspace",
    workspaceRef: "workspace",
    branch: "feature",
    fingerprint,
    resolvedAt: "2026-09-15T00:00:00Z"
  },
  manifest: {
    completeness: "complete",
    definition: target.definition,
    fingerprint,
    inputs: [
      {
        path: target.definition,
        kind: "definition",
        existed: true,
        contentHash: fingerprint
      }
    ]
  }
};
const scope: AuthorizedScope<"definition.validate"> = {
  authorizationRef: "auth",
  principalRef: "principal",
  operation: "definition.validate",
  target
};
function fixture() {
  const signal = { aborted: false, onAbort: () => () => {} };
  const control = { requestId: "request", cancellation: signal };
  const capture = vi.fn(async () =>
    portSuccess({ status: "captured" as const, snapshot })
  );
  const releaseSnapshot = vi.fn(async () =>
    portSuccess({ status: "released" as const })
  );
  const validate = vi.fn<
    import("./definition-ports.js").DefinitionValidationPort["validate"]
  >(async (input) =>
    portSuccess(
      reduceValidationReport(
        input.policy,
        input.policy.checks.map((check) => ({
          ...check,
          status: "passed",
          reason: "Verified."
        })),
        input
      )
    )
  );
  const service = createDefinitionValidation({
    source: { capture, releaseSnapshot },
    validator: { validate },
    clock: { now: () => "2026-09-15T00:00:00Z" }
  });
  return { service, capture, releaseSnapshot, validate, control, signal };
}
describe("agent-independent definition validation", () => {
  it("validates exact owned source without authoring ports and disclaims deployment", async () => {
    const f = fixture();
    const result = await f.service.validate(scope, target, f.control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        report: { status: "passed", sourceFingerprint: fingerprint },
        observation: { limitation: expect.stringContaining("deployment") }
      }
    });
    expect(f.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot,
        sourceFingerprint: fingerprint,
        policy: expect.objectContaining({ purpose: "validation" })
      }),
      f.control
    );
    expect(f.releaseSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });
  it.each(["failed", "unavailable", "skipped"] as const)(
    "returns required %s honestly",
    async (status) => {
      const f = fixture();
      f.validate.mockImplementation(async (input) =>
        portSuccess(
          reduceValidationReport(
            input.policy,
            input.policy.checks.map((check) => ({
              ...check,
              status,
              reason: "Evidence."
            })),
            input
          )
        )
      );
      expect(await f.service.validate(scope, target, f.control)).toMatchObject({
        status: "ok",
        value: {
          report: {
            status: status === "failed" ? "failed" : "incomplete",
            warnings: [expect.any(String)]
          }
        }
      });
    }
  );
  it("rejects wrong source before invoking validator", async () => {
    const f = fixture();
    f.capture.mockResolvedValue(
      portSuccess({
        status: "captured",
        snapshot: {
          ...snapshot,
          provenance: {
            ...snapshot.provenance,
            fingerprint: `sha256:${"b".repeat(64)}`
          }
        }
      })
    );
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      status: "failed",
      error: { code: "EVIDENCE_MISMATCH" }
    });
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.releaseSnapshot).toHaveBeenCalledOnce();
  });
  it("rejects another target and cancelled requests before I/O", async () => {
    const f = fixture();
    expect(
      await f.service.validate(
        { ...scope, target: { ...target, repo: "other/repo" } },
        target,
        f.control
      )
    ).toMatchObject({ status: "forbidden" });
    f.signal.aborted = true;
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      status: "cancelled"
    });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it("preserves absent and unavailable source evidence", async () => {
    const f = fixture();
    f.capture.mockImplementation(async () => {
      throw new Error("Source unavailable");
    });
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      status: "unavailable"
    });
    expect(f.releaseSnapshot).not.toHaveBeenCalled();
    const absent = createDefinitionValidation({
      source: {
        capture: async () =>
          portAbsent({
            quality: "current",
            completeness: "complete",
            evidence: "source",
            observedAt: "2026-09-15T00:00:00Z"
          }),
        releaseSnapshot: f.releaseSnapshot
      },
      validator: { validate: f.validate },
      clock: { now: () => "" }
    });
    expect(await absent.validate(scope, target, f.control)).toMatchObject({
      error: { code: "DEFINITION_NOT_FOUND" }
    });
  });
  it("rejects stale validation and propagates cleanup failure", async () => {
    const f = fixture();
    f.validate.mockImplementation(async (input) =>
      portSuccess(
        reduceValidationReport(
          input.policy,
          input.policy.checks.map((check) => ({
            ...check,
            status: "passed",
            reason: "Verified."
          })),
          { sourceFingerprint: `sha256:${"b".repeat(64)}` }
        )
      )
    );
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      error: { code: "EVIDENCE_MISMATCH" }
    });
    const cleanup = createDefinitionValidation({
      source: {
        capture: f.capture,
        releaseSnapshot: async () => portFailure("PRECONDITION_FAILED")
      },
      validator: { validate: f.validate },
      clock: { now: () => "" }
    });
    expect(await cleanup.validate(scope, target, f.control)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
  });
  it("validates an explicitly pinned remote source without an agent", async () => {
    const f = fixture();
    const remote = {
      ...target,
      source: {
        kind: "git" as const,
        ref: "feature",
        expectedCommit: "c".repeat(40)
      }
    };
    const service = createDefinitionValidation({
      source: {
        capture: async () =>
          portSuccess({
            status: "captured",
            snapshot: {
              ...snapshot,
              selection: remote,
              provenance: {
                repo: remote.repo,
                kind: "git",
                ref: "feature",
                commit: "c".repeat(40),
                fingerprint,
                resolvedAt: "2026-09-15T00:00:00Z"
              }
            }
          }),
        releaseSnapshot: f.releaseSnapshot
      },
      validator: { validate: f.validate },
      clock: { now: () => "2026-09-15T00:00:00Z" }
    });
    expect(
      await service.validate({ ...scope, target: remote }, remote, f.control)
    ).toMatchObject({
      status: "ok",
      value: { provenance: { kind: "git", commit: "c".repeat(40) } }
    });
  });
  it.each(["incomplete", "forbidden", "cancelled"] as const)(
    "preserves %s capture without running checks",
    async (status) => {
      const f = fixture();
      const service = createDefinitionValidation({
        source: {
          capture: async () =>
            status === "incomplete" ?
              portSuccess({
                status: "incomplete",
                manifest: {
                  completeness: "incomplete",
                  definition: target.definition,
                  inputs: [],
                  diagnostics: []
                }
              })
            : status === "forbidden" ? portForbidden()
            : portCancelled("request_cancelled"),
          releaseSnapshot: f.releaseSnapshot
        },
        validator: { validate: f.validate },
        clock: { now: () => "" }
      });
      expect((await service.validate(scope, target, f.control)).status).toBe(
        status === "incomplete" ? "unavailable" : status
      );
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.releaseSnapshot).not.toHaveBeenCalled();
    }
  );
  it.each(["capture", "validator", "throw"] as const)(
    "cleans cancelled %s work",
    async (phase) => {
      const f = fixture();
      if (phase === "capture")
        f.capture.mockImplementation(async () => {
          f.signal.aborted = true;
          return portSuccess({ status: "captured", snapshot });
        });
      else
        f.validate.mockImplementation(async () => {
          f.signal.aborted = true;
          if (phase === "throw") throw new Error("Cancelled");
          return portCancelled("request_cancelled");
        });
      expect(await f.service.validate(scope, target, f.control)).toMatchObject({
        status: "cancelled"
      });
      expect(f.releaseSnapshot).toHaveBeenCalledOnce();
    }
  );
  it("rejects mismatched snapshot selection and malformed public paths", async () => {
    const f = fixture();
    const unsafe = { ...target, definition: "../outside.bicep" };
    expect(
      await f.service.validate({ ...scope, target: unsafe }, unsafe, f.control)
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    f.capture.mockResolvedValue(
      portSuccess({
        status: "captured",
        snapshot: {
          ...snapshot,
          selection: { ...target, definition: "other.bicep" }
        }
      })
    );
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      error: { code: "EVIDENCE_MISMATCH" }
    });
    expect(f.validate).not.toHaveBeenCalled();
  });
  it("propagates validator denial and thrown cleanup failures", async () => {
    const f = fixture();
    f.validate.mockResolvedValue(portForbidden());
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      status: "forbidden"
    });
    f.releaseSnapshot.mockRejectedValue(new Error("Cleanup unavailable"));
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
  });
  it("refuses closed service and incomplete dependency construction", async () => {
    const f = fixture();
    f.service.close();
    expect(await f.service.validate(scope, target, f.control)).toMatchObject({
      status: "cancelled"
    });
    expect(f.capture).not.toHaveBeenCalled();
    const dependencies = {
      source: { capture: f.capture, releaseSnapshot: f.releaseSnapshot },
      validator: { validate: f.validate },
      clock: { now: () => "" }
    };
    Reflect.deleteProperty(dependencies, "clock");
    expect(() => createDefinitionValidation(dependencies)).toThrow();
  });
});
