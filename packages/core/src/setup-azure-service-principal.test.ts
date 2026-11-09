import { describe, expect, it, vi } from "vitest";
import { assertSetupExecutionActive } from "./setup-recovery-error.js";
import { ensureAzureServicePrincipal } from "./setup-azure-service-principal.js";
import type {
  AzureMutationRecord,
  AzureRecoveryPort
} from "./setup-azure-recovery.js";
import { command } from "../test/support/azure-setup.js";

const proceed = async () => true;
const sleep = async () => {};
function recovery(record: AzureMutationRecord | null): AzureRecoveryPort {
  return {
    assertActive: () => {},
    find: () => record,
    willWrite: () => true,
    unresolved: () => [],
    execute: async () => {
      throw new Error("Unexpected mutation");
    }
  };
}

describe("ensureAzureServicePrincipal", () => {
  it.each(["before", "empty", "failed", "positive"] as const)(
    "guards the first lookup at %s without discarding positive issued evidence",
    async (boundary) => {
      let stopped = boundary === "before";
      const port = recovery(null);
      port.assertActive = () => assertSetupExecutionActive(() => stopped);
      const read = vi.fn(async () => {
        stopped = true;
        return boundary === "failed" ?
            command("", 1, "Request_ResourceNotFound")
          : command(boundary === "positive" ? "object-id" : "");
      });
      const pending = ensureAzureServicePrincipal(
        "app",
        read,
        port,
        proceed,
        sleep
      );
      if (boundary === "positive")
        await expect(pending).resolves.toMatchObject({
          state: "reused",
          objectId: "object-id"
        });
      else
        await expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
      expect(read).toHaveBeenCalledTimes(boundary === "before" ? 0 : 1);
    }
  );

  it("fails closed when a precheck has neither status nor diagnostics", async () => {
    expect(
      await ensureAzureServicePrincipal(
        "app-id",
        async () => ({}),
        undefined,
        proceed,
        sleep
      )
    ).toEqual({
      ok: false,
      stderr: "Failed to look up the Service Principal before creation."
    });
  });

  it("does not treat a missing create status and empty reread as success", async () => {
    let calls = 0;
    expect(
      await ensureAzureServicePrincipal(
        "app-id",
        async () =>
          ++calls === 1 ? command("", 1, "Request_ResourceNotFound") : {},
        undefined,
        proceed,
        sleep
      )
    ).toEqual({
      ok: false,
      stderr: "Could not create or find the Service Principal."
    });
    expect(calls).toBe(3);
  });

  it.each([undefined, "preserved reconciliation diagnostic"])(
    "preserves a command-less reconciliation refusal (%s)",
    async (diagnostic) => {
      const port = recovery(null);
      port.execute = async () => ({ state: "not_applied", diagnostic });
      expect(
        await ensureAzureServicePrincipal(
          "app-id",
          async () => command("", 1, "Request_ResourceNotFound"),
          port,
          proceed,
          sleep
        )
      ).toEqual({
        ok: false,
        stderr: diagnostic || "Could not create or find the Service Principal."
      });
    }
  );
  it.each([
    ['{"id":42}', "42"],
    ['{"id":" object-id "}', "object-id"],
    ['{"id":" "}', null],
    ['{"id":null}', null],
    ["{}", null],
    ["{", null]
  ])(
    "preserves the original acknowledgement identity normalization for %s",
    async (stdout, objectId) => {
      expect(
        await ensureAzureServicePrincipal(
          "application",
          async (args) =>
            args[2] === "show" ?
              command("", 1, "Request_ResourceNotFound")
            : command(stdout),
          undefined,
          proceed,
          sleep
        )
      ).toEqual({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId
      });
    }
  );
  it.each([
    [null, "reused", "pre_existing"],
    [
      {
        kind: "azure_service_principal.create",
        status: "not_applied",
        evidence: null
      },
      "reused",
      "pre_existing"
    ],
    [
      {
        kind: "azure_service_principal.create",
        status: "confirmed",
        providerId: "object-id",
        evidence: null
      },
      "created",
      "this_operation"
    ],
    [
      {
        kind: "azure_service_principal.create",
        status: "confirmed",
        providerId: "old-object-id",
        evidence: null
      },
      "created_candidate",
      "unknown"
    ],
    [
      {
        kind: "azure_service_principal.create",
        status: "confirmed",
        evidence: null
      },
      "created_candidate",
      "unknown"
    ]
  ] as const)(
    "classifies the immutable provider identity from %j",
    async (record, state, origin) => {
      const port = recovery(record);
      const calls: string[][] = [];
      expect(
        await ensureAzureServicePrincipal(
          "app-id",
          async (args) => {
            calls.push(args);
            return command("object-id");
          },
          port,
          proceed,
          sleep
        )
      ).toEqual({ ok: true, state, origin, objectId: "object-id" });
      expect(calls).toEqual([
        ["ad", "sp", "show", "--id", "app-id", "--query", "id", "-o", "tsv"]
      ]);
    }
  );

  it.each([null, "original journal evidence"])(
    "preserves manual recovery evidence %j",
    async (evidence) => {
      expect(
        await ensureAzureServicePrincipal(
          "app-id",
          async () => command("object-id"),
          recovery({
            kind: "azure_service_principal.create",
            status: "manual_required",
            evidence
          }),
          proceed,
          sleep
        )
      ).toEqual({
        ok: false,
        stderr:
          evidence ||
          "Radius cannot prove who created the Service Principal for application app-id."
      });
    }
  );

  it.each([
    [command(""), "The Service Principal lookup returned an empty object id."],
    [command("", 1, "AuthorizationFailed"), "AuthorizationFailed"],
    [
      { ...command("", 0, "read timeout"), timedOut: true },
      "ETIMEDOUT: Service Principal lookup timed out. read timeout"
    ]
  ])("fails closed on an unreadable precheck", async (response, stderr) => {
    expect(
      await ensureAzureServicePrincipal(
        "app-id",
        async () => response,
        undefined,
        proceed,
        sleep
      )
    ).toEqual({ ok: false, stderr });
  });

  it("returns the unchanged recovery error object rather than a failure result", async () => {
    const original = new Error("outcome unknown");
    const port = recovery(null);
    port.execute = async () => {
      throw original;
    };
    await expect(
      ensureAzureServicePrincipal(
        "app-id",
        async () => command("", 1, "Request_ResourceNotFound"),
        port,
        proceed,
        sleep
      )
    ).rejects.toBe(original);
  });

  it("performs exactly six propagation reads without retrying a write", async () => {
    const port = recovery({
      kind: "azure_service_principal.create",
      status: "prepared",
      evidence: null
    });
    const calls: string[][] = [];
    const delays: number[] = [];
    port.willWrite = () => false;
    port.execute = async (input) => {
      await input.reconcile();
      throw new Error("reconciliation must fail");
    };
    await expect(
      ensureAzureServicePrincipal(
        "app-id",
        async (args) => {
          calls.push(args);
          return command("", 1, "Request_ResourceNotFound");
        },
        port,
        proceed,
        async (delay) => {
          delays.push(delay);
        }
      )
    ).rejects.toThrow("Request_ResourceNotFound");
    expect(calls).toHaveLength(7);
    expect(calls.every((args) => args[2] === "show")).toBe(true);
    expect(delays).toEqual([2000, 4000, 6000, 8000, 10000]);
  });

  it("does not create after a stop boundary refusal", async () => {
    expect(
      await ensureAzureServicePrincipal(
        "app-id",
        async () => command("", 1, "Request_ResourceNotFound"),
        undefined,
        async () => false,
        sleep
      )
    ).toEqual({ ok: false, stopped: true });
  });
});
