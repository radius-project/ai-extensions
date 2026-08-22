import { describe, expect, it } from "vitest";
import { buildStages, createOperation, requestStop } from "../../operations.js";
import { honorStopBoundary } from "./operation-stop-boundary.js";

function operation() {
  return createOperation({
    provider: "azure",
    repo: "octo/app",
    environment: "dev",
    stages: buildStages()
  });
}

describe("honorStopBoundary", () => {
  it("does not persist when no Stop is pending", async () => {
    const target = operation();
    let persisted = 0;

    expect(
      await honorStopBoundary({
        operation: target,
        boundary: "before-write",
        persist: async () => {
          persisted += 1;
        }
      })
    ).toBe(true);
    expect(persisted).toBe(0);
    expect(target.state).toBe("running");
  });

  it("closes command state before persisting a stopped operation", async () => {
    const target = operation();
    requestStop(target);
    const events: string[] = [];

    expect(
      await honorStopBoundary({
        operation: target,
        boundary: "after-write",
        beforePersist: () => events.push("command-finished"),
        persist: async () => {
          events.push("persist");
        }
      })
    ).toBe(false);

    expect(events).toEqual(["command-finished", "persist"]);
    expect(target.state).toBe("cancelled");
    expect(target.control.stop.boundary).toBe("after-write");
  });

  it("reports a failed terminal save without starting more work", async () => {
    const target = operation();
    requestStop(target);
    const diagnostics: Array<{ code: string; message: string }> = [];

    expect(
      await honorStopBoundary({
        operation: target,
        boundary: "after-write",
        persist: async () => {
          throw new Error("disk full");
        },
        report: (diagnostic) => diagnostics.push(diagnostic)
      })
    ).toBe(false);

    expect(diagnostics).toEqual([
      {
        code: "operation-store-write-failed",
        message: `Could not persist setup operation ${target.operationId}: disk full`
      }
    ]);
    expect(target.state).toBe("cancelled");
    expect(target.journey.notifiedAt).toBeNull();
  });

  it("reports a non-Error save rejection for an operation without an id", async () => {
    const target = operation();
    target.operationId = "";
    requestStop(target);
    const diagnostics: Array<{ code: string; message: string }> = [];

    await honorStopBoundary({
      operation: target,
      boundary: "after-write",
      persist: async () => Promise.reject("offline"),
      report: (diagnostic) => diagnostics.push(diagnostic)
    });

    expect(diagnostics[0].message).toBe(
      "Could not persist setup operation unknown: offline"
    );
  });
});
