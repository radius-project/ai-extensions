import { describe, expect, it } from "vitest";
import {
  persistBestEffort,
  persistMutationCheckpoint
} from "./setup-checkpoint.js";

describe("Canvas setup checkpoint projection", () => {
  it("does not finalize a successful checkpoint", async () => {
    await expect(
      persistMutationCheckpoint({
        operation: { operationId: "op_setup" },
        persist: async () => {},
        fail: async () => {
          throw new Error("unexpected finalization");
        }
      })
    ).resolves.toBe(true);
  });

  it.each([
    [null, new Error("disk full"), "unknown", "disk full"],
    [{ operationId: "" }, "offline", "unknown", "offline"],
    [null, null, "unknown", "null"],
    [null, undefined, "unknown", "undefined"],
    [null, 0, "unknown", "0"],
    [null, false, "unknown", "false"],
    [null, Symbol("offline"), "unknown", "Symbol(offline)"],
    [null, { message: "offline" }, "unknown", "[object Object]"],
    [null, { toString: () => "offline" }, "unknown", "offline"],
    [
      { operationId: "op_setup" },
      new Error("read only"),
      "op_setup",
      "read only"
    ]
  ] as const)(
    "reports a failed checkpoint before the existing HTTP failure",
    async (operation, error, id, detail) => {
      const events: unknown[] = [];
      await expect(
        persistMutationCheckpoint({
          operation,
          persist: async () => {
            throw error;
          },
          report: (diagnostic) => events.push(diagnostic),
          fail: async (...args) => {
            events.push(args);
          }
        })
      ).resolves.toBe(false);
      expect(events).toEqual([
        {
          code: "operation-store-write-failed",
          message: `Could not persist setup operation ${id}: ${detail}`
        },
        [
          500,
          "Radius changed no further cloud resources because it could not save the setup recovery record.",
          "operation-persistence-failed"
        ]
      ]);
    }
  );

  it("projects a saved rollback decision to the existing conflict response", async () => {
    const failures: unknown[] = [];
    await expect(
      persistMutationCheckpoint({
        operation: { providerRecovery: { state: "rollback_pending" } },
        persist: async () => {},
        fail: async (...args) => {
          failures.push(args);
        }
      })
    ).resolves.toBe(false);
    expect(failures).toEqual([
      [
        409,
        "Radius reconciled the interrupted provider request and must delete the setup resources before making any further provider changes.",
        "provider-rollback-pending"
      ]
    ]);
  });

  it("propagates failure finalization errors", async () => {
    const error = new Error("finalization failed");
    await expect(
      persistMutationCheckpoint({
        operation: null,
        persist: async () => {
          throw new Error("disk full");
        },
        fail: async () => {
          throw error;
        }
      })
    ).rejects.toBe(error);
  });

  it("returns the explicit best-effort save result and reports failures", async () => {
    const diagnostics: unknown[] = [];
    await expect(
      persistBestEffort({ operation: null, persist: async () => {} })
    ).resolves.toBe(true);
    await expect(
      persistBestEffort({
        operation: { operationId: "op_setup" },
        persist: async () => {
          throw new Error("disk full");
        },
        report: (diagnostic) => diagnostics.push(diagnostic)
      })
    ).resolves.toBe(false);
    expect(diagnostics).toEqual([
      {
        code: "operation-store-write-failed",
        message: "Could not persist setup operation op_setup: disk full"
      }
    ]);
  });

  it("does not require a diagnostic subscriber", async () => {
    await expect(
      persistBestEffort({
        operation: null,
        persist: async () => {
          throw "offline";
        }
      })
    ).resolves.toBe(false);
  });
});
