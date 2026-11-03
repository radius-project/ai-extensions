import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  createFileOperationStore,
  PERSISTED_OPERATIONS_VERSION
} from "../../operation-store.js";
import {
  assertSetupExecutionActive,
  ProviderMutationRecoveryError as CoreRecoveryError
} from "@radius-project/core";
import { createSetupWorkflowRecoveryPort } from "./setup-workflow-recovery.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import {
  prepareProviderMutation,
  providerMutationRecord,
  settleProviderMutation,
  createOperation,
  createRegistry,
  providerRecoveryManualGuidance,
  canStartRollback,
  toPersistedOperation,
  toClientView
} from "../../operations.js";

describe("Canvas setup workflow recovery binding", () => {
  it.each(["runtime", "call", "neither"])(
    "checks both %s and call-specific assertions after saving intent",
    async (guard) => {
      const operation = { operationId: "composed-workflow" };
      let saved = false;
      const statuses: string[] = [];
      const call = vi.fn(() =>
        assertSetupExecutionActive(() => saved && guard === "call")
      );
      const mutate = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const binding = createSetupWorkflowRecoveryPort(
        operation,
        async () => {
          saved = true;
          statuses.push(
            String(
              providerMutationRecord(operation, "github_workflow.put", "target")
                ?.status
            )
          );
        },
        () => saved && guard === "runtime"
      );
      const pending = binding.execute({
        kind: "github_workflow.put",
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
        expect(statuses).toEqual(["prepared", "confirmed"]);
      } else {
        await expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        expect(mutate).not.toHaveBeenCalled();
        expect(statuses).toEqual(["prepared", "not_applied"]);
      }
      expect(call).toHaveBeenCalledTimes(
        guard === "runtime" ? 1
        : guard === "call" ? 2
        : 3
      );
    }
  );

  it("queries current journal and rollback state instead of taking construction-time snapshots", async () => {
    const operation: {
      operationId: string;
      providerRecovery?: { state?: string };
    } = { operationId: "workflow-recovery" };
    let saves = 0;
    const binding = createSetupWorkflowRecoveryPort(
      operation,
      async () => {
        saves++;
      },
      () => false
    );
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

  it.each([undefined, null, "", "HTTP 403"])(
    "blocks rollback from saved non-applied branch deletion evidence %j",
    async (evidence) => {
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
        evidence ?? null
      );
      operation.providerRecovery.state = "rollback_pending";
      const saved = toPersistedOperation(operation);
      if (evidence === undefined) {
        delete saved.providerRecovery.mutations[0].evidence;
      }
      const directory = await mkdtemp(
        path.join(process.cwd(), ".radius-recovery-guidance-")
      );
      try {
        const store = createFileOperationStore({
          filePath: path.join(directory, "operations.json")
        });
        await store.save({
          schemaVersion: PERSISTED_OPERATIONS_VERSION,
          operations: [saved]
        });
        const guidance =
          "Radius has not confirmed removal of the recovered setup branch. It will not repeat the delete or remove the remaining setup resources. Review the recorded branch before starting setup again." +
          (evidence ? ` Details: ${evidence}` : "");
        for (let restart = 0; restart < 2; restart++) {
          const registry = createRegistry({ store });
          await registry.hydrate();
          const restored = registry.get(operation.operationId);
          expect(restored).toMatchObject({
            state: "failed_partial",
            failure: {
              code: "provider-reconciliation-manual-required",
              message: guidance
            }
          });
          expect(providerRecoveryManualGuidance(restored)).toBe(guidance);
          expect(toClientView(restored)).toMatchObject({
            failure: { message: guidance }
          });
          expect(canStartRollback(restored)).toMatchObject({
            ok: false,
            code: "rollback-provider-outcome-unknown",
            detail: guidance
          });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
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
    const binding = createSetupWorkflowRecoveryPort(
      operation,
      async () => {},
      () => false
    );
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
    const binding = createSetupWorkflowRecoveryPort(
      operation,
      async () => {},
      () => false
    );
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
    const binding = createSetupWorkflowRecoveryPort(
      operation,
      async () => {},
      () => false
    );
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
