import { describe, expect, it } from "vitest";
import { ProviderMutationRecoveryError as CoreRecoveryError } from "@radius-project/core";
import { createSetupWorkflowRecoveryPort } from "./setup-workflow-recovery.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import {
  prepareProviderMutation,
  providerMutationRecord,
  settleProviderMutation
} from "../../operations.js";

describe("Canvas setup workflow recovery binding", () => {
  it("queries current journal and rollback state instead of taking construction-time snapshots", async () => {
    const operation: {
      operationId: string;
      providerRecovery?: { state?: string };
    } = { operationId: "workflow-recovery" };
    let saves = 0;
    const binding = createSetupWorkflowRecoveryPort(operation, async () => {
      saves++;
    });
    binding.markRollbackPending();
    expect(binding.rollbackPending()).toBe(false);
    expect(binding.willWrite("github_workflow.put", "workflow")).toBe(true);
    const mutation = prepareProviderMutation(operation, {
      kind: "github_workflow.put",
      target: "workflow"
    });
    expect(binding.find("github_workflow.put", "workflow")).toMatchObject(
      mutation
    );
    expect(binding.byKind("github_workflow.put")).toMatchObject([mutation]);
    expect(binding.unresolved()).toMatchObject([mutation]);
    expect(binding.willWrite("github_workflow.put", "workflow")).toBe(false);
    binding.markRollbackPending();
    expect(binding.rollbackPending()).toBe(true);
    binding.settleManual(
      "github_workflow.put",
      "workflow",
      "Inspect the recorded branch."
    );
    expect(binding.find("github_workflow.put", "workflow")).toMatchObject({
      status: "manual_required",
      evidence: "Inspect the recorded branch."
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "confirmed",
      "Exact recorded identity."
    );
    expect(binding.unresolved()).toEqual([]);
    await binding.persist();
    expect(saves).toBe(1);
  });

  it("retains the original recovery exception and performs one readback without a blind retry", async () => {
    expect(CoreRecoveryError).toBe(ProviderMutationRecoveryError);
    const operation = { operationId: "workflow-recovery" };
    prepareProviderMutation(operation, {
      kind: "github_workflow.put",
      target: "workflow"
    });
    const binding = createSetupWorkflowRecoveryPort(operation, async () => {});
    let reads = 0;
    await expect(
      binding.execute({
        kind: "github_workflow.put",
        target: "workflow",
        mutate: async () => {
          throw new Error("Must not repeat an ambiguous write.");
        },
        accept: () => {
          throw new Error("Must reconcile the recorded write.");
        },
        reconcile: async () => {
          reads++;
          throw new Error("GitHub is temporarily unreadable.");
        }
      })
    ).rejects.toBeInstanceOf(CoreRecoveryError);
    expect(reads).toBe(1);
    expect(
      providerMutationRecord(operation, "github_workflow.put", "workflow")
    ).toMatchObject({ status: "outcome_unknown", reconcileAttempts: 1 });
  });
});
