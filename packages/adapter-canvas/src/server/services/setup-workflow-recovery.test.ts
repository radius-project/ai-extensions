import { describe, expect, it } from "vitest";
import { ProviderMutationRecoveryError as CoreRecoveryError } from "@radius-project/core";
import { createSetupWorkflowRecoveryPort } from "./setup-workflow-recovery.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import {
  prepareProviderMutation,
  providerMutationRecord,
  settleProviderMutation,
  createOperation,
  reconcileRestoredOperation,
  providerRecoveryManualGuidance,
  canStartRollback,
  toPersistedOperation,
  fromPersistedOperation
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
    binding.markRollbackPending();
    expect(binding.find("github_workflow.put", "workflow")?.status).toBe(
      "manual_required"
    );
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

  it.each([null, "GitHub refused the recorded branch deletion."])(
    "blocks rollback from saved non-applied branch deletion evidence %j",
    (evidence) => {
      const operation = createOperation({
        operationId: "op_branch_removal",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      const mutation = prepareProviderMutation(operation, {
        kind: "github_branch.delete",
        target: "fixture/app\0setup-branch\0original-head"
      });
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "not_applied",
        evidence
      );
      operation.providerRecovery.state = "rollback_pending";
      const restored = fromPersistedOperation(toPersistedOperation(operation));
      reconcileRestoredOperation(restored);
      expect(restored).toMatchObject({
        state: "failed_partial",
        requiresDurableRewrite: true,
        failure: { code: "provider-reconciliation-manual-required" }
      });
      expect(providerRecoveryManualGuidance(restored)).toBe(
        evidence ||
          "Radius has not confirmed removal of the recovered setup branch. It will not repeat the delete or remove the remaining setup resources. Review the recorded branch before starting setup again."
      );
      expect(canStartRollback(restored)).toMatchObject({
        ok: false,
        code: "rollback-provider-outcome-unknown"
      });
    }
  );

  it("preserves actionable manual guidance ahead of raw deletion diagnostics", () => {
    const operation = createOperation({
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "fixture/app\0setup-branch\0original-head"
    });
    const deletion = prepareProviderMutation(operation, {
      kind: "github_branch.delete",
      target: "fixture/app\0setup-branch\0original-head"
    });
    settleProviderMutation(
      operation,
      deletion.mutationId,
      "not_applied",
      "HTTP 403"
    );
    const binding = createSetupWorkflowRecoveryPort(operation, async () => {});
    const guidance =
      "Review setup-branch in fixture/app before starting setup again.";
    binding.settleManual(
      "github_branch.create",
      "fixture/app\0setup-branch\0original-head",
      guidance
    );
    expect(operation.providerRecovery.state).toBe("manual_required");
    binding.markRollbackPending();
    expect(operation.providerRecovery.state).toBe("manual_required");
    expect(providerRecoveryManualGuidance(operation)).toBe(guidance);
  });

  it("keeps an older manual blocker without mutation details fail closed", () => {
    const operation = createOperation({
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    operation.providerRecovery.state = "manual_required";
    expect(providerRecoveryManualGuidance(operation)).toBe(
      "Radius could not prove the identity or ownership of a provider resource. Review the operation recovery details before making another attempt."
    );
    const binding = createSetupWorkflowRecoveryPort(operation, async () => {});
    binding.markRollbackPending();
    expect(operation.providerRecovery.state).toBe("manual_required");
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
