import { describe, expect, it, vi } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import {
  deterministicProviderUuid,
  executeRecoverableMutation,
  ProviderMutationRecoveryError,
  providerMutationOutcomeUnknown
} from "./provider-mutation-recovery.js";

function command(
  overrides: Partial<{
    code: string | number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> = {}
) {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

describe("provider mutation recovery", () => {
  it("persists intent before mutation and confirmation afterwards", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const events: string[] = [];

    const result = await executeRecoverableMutation({
      operation,
      kind: "github_environment.put",
      target: "octo/app:prod",
      persist: async () => {
        events.push(
          `persist:${operation.providerRecovery.mutations[0]?.status}`
        );
      },
      mutate: async () => {
        events.push("mutate");
        return command({ stdout: '{"name":"prod"}' });
      },
      accept: (value) => JSON.parse(value.stdout) as { name: string },
      reconcile: async () => {
        throw new Error("successful mutations do not need reconciliation");
      }
    });

    expect(result).toEqual({
      state: "applied",
      value: { name: "prod" },
      recovered: false
    });
    expect(events).toEqual(["persist:prepared", "mutate", "persist:confirmed"]);
  });

  it("does not repeat a prepared mutation after restart and adopts provider state", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () => command());
    await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "first" }),
      reconcile: async () => ({ state: "not_applied" })
    });
    operation.providerRecovery.mutations[0].status = "prepared";

    const recovered = await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "unexpected" }),
      reconcile: async () => ({
        state: "applied",
        value: { sha: "adopted" },
        evidence: "Exact content digest matched."
      })
    });

    expect(recovered).toEqual({
      state: "applied",
      value: { sha: "adopted" },
      recovered: true
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("requests automatic rollback after every restarted setup mutation is reconciled", async () => {
    const operation = createOperation({ operationId: "op_test" });
    operation.recoveryState = "provider_reconciliation_pending";
    const mutate = vi.fn(async () => command());
    await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "first" }),
      reconcile: async () => ({ state: "not_applied" })
    });
    operation.providerRecovery.mutations[0].status = "prepared";

    await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "unexpected" }),
      reconcile: async () => ({
        state: "applied",
        value: { sha: "adopted" }
      })
    });

    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(operation.stopRequested).toBe(true);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("adopts a restarted verification dispatch without rolling back", async () => {
    const operation = createOperation({ operationId: "op_test" });
    operation.recoveryState = "provider_reconciliation_pending";
    const mutate = vi.fn(async () => command());
    await executeRecoverableMutation({
      operation,
      kind: "github_workflow.dispatch",
      target: "octo/app:verify.yml:main:prod",
      persist: async () => {},
      mutate,
      accept: () => "41",
      reconcile: async () => ({ state: "not_applied" })
    });
    operation.providerRecovery.mutations[0].status = "prepared";

    await executeRecoverableMutation({
      operation,
      kind: "github_workflow.dispatch",
      target: "octo/app:verify.yml:main:prod",
      persist: async () => {},
      mutate,
      accept: () => "unexpected",
      reconcile: async () => ({ state: "applied", value: "42" })
    });

    expect(operation.providerRecovery.state).toBe("complete");
    expect(operation.stopRequested).toBe(false);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("reconciles a timed-out mutation instead of retrying it", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () =>
      command({ code: 1, timedOut: true, stderr: "terminated" })
    );

    const result = await executeRecoverableMutation({
      operation,
      kind: "verification.dispatch",
      target: "octo/app:main:prod",
      persist: async () => {},
      mutate,
      accept: () => 0,
      reconcile: async () => ({
        state: "applied",
        value: 42,
        evidence: "Run 42 appeared after the saved baseline."
      })
    });

    expect(result).toEqual({ state: "applied", value: 42, recovered: true });
    expect(mutate).toHaveBeenCalledOnce();
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      evidence: "Run 42 appeared after the saved baseline."
    });
  });

  it("durably fails closed when reconciliation cannot prove identity", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const guidance =
      "The workflow path contains different content. Review that exact path before continuing.";

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        persist: async () => {},
        mutate: async () => command({ code: 1, timedOut: true }),
        accept: () => null,
        reconcile: async () => ({ state: "manual_required", guidance })
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProviderMutationRecoveryError>>({
        code: "provider-mutation-manual-required",
        message: guidance
      })
    );
    expect(operation.providerRecovery).toMatchObject({
      state: "manual_required",
      guidance
    });
  });

  it("fails before mutation when journaling intent cannot be persisted", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () => command());

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        persist: async () => {
          throw "disk unavailable";
        },
        mutate,
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-recovery-persistence-failed",
      message: expect.stringContaining("disk unavailable")
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps manual-required conclusions durable", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () => command());
    const input = {
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => null,
      reconcile: async () => ({ state: "not_applied" as const })
    };

    await executeRecoverableMutation(input);
    operation.providerRecovery.mutations[0].status = "manual_required";
    operation.providerRecovery.mutations[0].evidence =
      "Inspect the exact path.";
    await expect(executeRecoverableMutation(input)).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: "Inspect the exact path."
    });

    expect(mutate).toHaveBeenCalledOnce();
  });

  it("keeps rollback pending sticky and starts no later provider write", async () => {
    const operation = createOperation({ operationId: "op_test" });
    operation.providerRecovery.state = "rollback_pending";
    const mutate = vi.fn(async () => command());

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_app_owner.add",
        target: "app:user",
        persist: async () => {},
        mutate,
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-rollback-pending"
    });

    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(operation.providerRecovery.mutations).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("allows rollback to reconcile an existing setup mutation without replaying it", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const prepared = prepareProviderMutation(operation, {
      kind: "azure_federated_credential.create",
      target: "app:dev"
    });
    settleProviderMutation(operation, prepared.mutationId, "outcome_unknown");
    operation.providerRecovery.state = "rollback_pending";
    const mutate = vi.fn(async () => command());

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_federated_credential.create",
        target: "app:dev",
        persist: async () => {},
        mutate,
        accept: () => null,
        reconcile: async () => ({
          state: "applied" as const,
          value: null,
          evidence: "Exact operation provenance matched."
        })
      })
    ).resolves.toEqual({ state: "applied", value: null, recovered: true });
    expect(mutate).not.toHaveBeenCalled();
    expect(operation.providerRecovery.state).toBe("rollback_pending");
  });

  it("classifies only terminated commands as outcome unknown", () => {
    expect(providerMutationOutcomeUnknown(command({ code: 1 }))).toBe(false);
    expect(
      providerMutationOutcomeUnknown(command({ code: 1, timedOut: true }))
    ).toBe(true);
  });

  it("builds stable provider UUIDs with UUID v5 bits", () => {
    const first = deterministicProviderUuid("op_test:role:scope");
    expect(first).toBe(deterministicProviderUuid("op_test:role:scope"));
    expect(first).not.toBe(deterministicProviderUuid("op_test:role:other"));
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
