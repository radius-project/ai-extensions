import { describe, expect, it } from "vitest";
import { ensureAzureServicePrincipal } from "@radius-project/core";
import { createAzureRecoveryPort } from "./azure-setup-recovery.js";
import {
  prepareProviderMutation,
  providerMutationRecord
} from "../../operations.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";

describe("Canvas Azure recovery binding", () => {
  it("preserves recovery error identity and increments reconciliation exactly once", async () => {
    const operation = { operationId: "principal-recovery" };
    prepareProviderMutation(operation, {
      kind: "azure_service_principal.create",
      target: "application"
    });
    const binding = createAzureRecoveryPort(operation, async () => {});
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
