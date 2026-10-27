import { describe, expect, it, vi } from "vitest";
import {
  assertSetupExecutionActive,
  ensureAzureServicePrincipal
} from "@radius-project/core";
import { createAzureRecoveryPort } from "./azure-setup-recovery.js";
import {
  prepareProviderMutation,
  providerMutationRecord
} from "../../operations.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";

describe("Canvas Azure recovery binding", () => {
  it.each([
    "azure_application.create",
    "azure_service_principal.create",
    "azure_federated_credential.create",
    "azure_role_assignment.create"
  ])(
    "persists an unsent %s as not applied when shutdown wins the prepared save",
    async (kind) => {
      const operation = { operationId: "held-azure" };
      let stopped = false;
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prepared = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const saved: string[] = [];
      const binding = createAzureRecoveryPort(
        operation,
        async () => {
          const status = providerMutationRecord(
            operation,
            kind,
            "target"
          )?.status;
          saved.push(String(status));
          if (status === "prepared") {
            entered();
            await gate;
          }
        },
        () => stopped
      );
      const mutate = vi.fn(async () => ({ code: 0, stdout: "id", stderr: "" }));
      const confirmed = vi.fn();
      const pending = binding.execute({
        kind,
        target: "target",
        mutate,
        accept: () => "id",
        onConfirmed: confirmed,
        reconcile: async () => {
          throw new Error("Unsent writes must not reconcile");
        }
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      await prepared;
      stopped = true;
      release();
      await rejected;
      expect(saved).toEqual(["prepared", "not_applied"]);
      expect(mutate).not.toHaveBeenCalled();
      expect(confirmed).not.toHaveBeenCalled();
    }
  );

  it.each(["runtime", "call", "neither"])(
    "preserves the %s assertion with call-specific inputs",
    async (guard) => {
      const operation = { operationId: "composed-azure" };
      const call = vi.fn(() =>
        assertSetupExecutionActive(() => guard === "call")
      );
      const mutate = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const pending = createAzureRecoveryPort(
        operation,
        async () => {},
        () => guard === "runtime"
      ).execute({
        kind: "azure_application.create",
        target: "target",
        assertActive: call,
        mutate,
        accept: () => "id",
        reconcile: async () => {
          throw new Error("Unexpected reconciliation");
        }
      });
      if (guard === "neither") {
        await expect(pending).resolves.toMatchObject({
          state: "applied",
          value: "id"
        });
        expect(mutate).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        expect(mutate).not.toHaveBeenCalled();
      }
      expect(call).toHaveBeenCalledTimes(
        guard === "runtime" ? 0
        : guard === "call" ? 1
        : 3
      );
    }
  );

  it("preserves recovery error identity and increments reconciliation exactly once", async () => {
    const operation = { operationId: "principal-recovery" };
    prepareProviderMutation(operation, {
      kind: "azure_service_principal.create",
      target: "application"
    });
    const binding = createAzureRecoveryPort(
      operation,
      async () => {},
      () => false
    );
    let original: unknown;
    const recovery = {
      ...binding,
      execute: async <T>(input: Parameters<typeof binding.execute<T>>[0]) => {
        try {
          return await binding.execute(input);
        } catch (error) {
          original = error;
          throw error;
        }
      }
    };
    let received: unknown;
    try {
      await ensureAzureServicePrincipal(
        "application",
        async () => ({
          code: 1,
          stdout: "",
          stderr: "Request_ResourceNotFound"
        }),
        recovery,
        async () => true,
        async () => {}
      );
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(ProviderMutationRecoveryError);
    expect(received).toBe(original);
    expect(
      providerMutationRecord(
        operation,
        "azure_service_principal.create",
        "application"
      )
    ).toMatchObject({ status: "outcome_unknown", reconcileAttempts: 1 });
    expect(binding.unresolved()).toHaveLength(1);
  });
});
