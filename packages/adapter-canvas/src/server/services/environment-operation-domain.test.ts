import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentOperationDomain } from "@radius-project/core/github-radius/environments/operation-domain";
import type { OperationDomain } from "@radius-project/core/github-radius/environments";
import * as legacy from "../../operations.js";
import { redactGhCredentials } from "../../gh.js";

const NOW = "2026-08-22T00:00:00.000Z";
const shared = createEnvironmentOperationDomain({
  nowIso: () => NOW,
  sha256: (value) => createHash("sha256").update(value).digest("hex"),
  redactDiagnostic: redactGhCredentials,
  announceTerminal: () => false
});

afterEach(() => {
  vi.useRealTimers();
});

describe("portable environment operation policy parity", () => {
  describe.each([
    ["Canvas", legacy],
    ["independent caller", shared]
  ] as const)("%s mutation contract", (_name, domain) => {
    function operation() {
      return legacy.createOperation({
        operationId: "contract",
        provider: "azure",
        repo: "octo/app",
        environment: "dev"
      });
    }

    it("rejects unknown mutation identities and diagnostics without changing state", () => {
      const op = operation();
      const before = structuredClone(op);
      expect(domain.settleProviderMutation(op, "missing", "confirmed")).toBe(
        false
      );
      expect(
        domain.recordProviderMutationDiagnostics(op, "missing", {
          initial: "unmatched response"
        })
      ).toBe(false);
      expect(op).toEqual(before);
    });

    it("rejects invalid persisted status values without changing a prepared mutation", () => {
      const op = operation();
      const mutation = domain.prepareProviderMutation(op, {
        kind: "provider.put",
        target: "resource"
      });
      const before = structuredClone(op);
      expect(
        Reflect.apply(domain.settleProviderMutation, domain, [
          op,
          mutation.mutationId,
          "unrecognized-status"
        ])
      ).toBe(false);
      expect(op).toEqual(before);
    });

    it("retains legacy quarantine and stable journal identities across repeated preparation", () => {
      const op = operation();
      op.providerRecovery.state = "unrecoverable_legacy";
      op.providerRecovery.guidance = "Review historical resources";
      const input = { kind: "provider.put", target: "resource" };
      const first = domain.prepareProviderMutation(op, input);
      const repeated = domain.prepareProviderMutation(op, input);
      expect(first.mutationId).toBe(
        `pm_${createHash("sha256")
          .update("contract\0provider.put\0resource")
          .digest("hex")
          .slice(0, 32)}`
      );
      expect(repeated.mutationId).toBe(first.mutationId);
      expect(op.providerRecovery).toMatchObject({
        state: "unrecoverable_legacy",
        guidance: "Review historical resources",
        mutations: [expect.objectContaining({ mutationId: first.mutationId })]
      });
    });

    it.each([null, undefined])("preserves a nullish operation (%s)", (op) => {
      expect(domain.touchOperation(op)).toBe(op);
      expect(domain.enterStage(op, "stage")).toBe(op);
      expect(domain.setStageState(op, "stage", "succeeded")).toBe(op);
      expect(domain.finish(op, "succeeded")).toBe(op);
    });
  });

  it.each([
    "confirmed",
    "not_applied",
    "outcome_unknown",
    "manual_required"
  ] as const)(
    "preserves persisted journal and immutable identities for %s",
    (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const before = legacy.createOperation({
        operationId: "op-parity",
        provider: "azure",
        repo: "octo/app",
        environment: "dev"
      });
      const old = structuredClone(before);
      const portable = structuredClone(before);
      for (const [domain, operation] of [
        [legacy, old],
        [shared, portable]
      ] as const) {
        const mutation = domain.prepareProviderMutation(operation, {
          kind: "azure_application.create",
          target: "octo/app:dev",
          providerIdempotencyKey: "operation-key",
          intent: { repoId: 5, owned: true, absent: null }
        });
        domain.recordProviderMutationDiagnostics(
          operation,
          mutation.mutationId,
          { initial: "request timed out", final: "exact identity checked" }
        );
        domain.settleProviderMutation(
          operation,
          mutation.mutationId,
          status,
          " exact evidence ",
          " provider-id ",
          true
        );
      }
      expect(portable).toEqual(old);
      expect(
        shared.providerMutationRecord(
          portable,
          "azure_application.create",
          "octo/app:dev"
        )
      ).toEqual(
        legacy.providerMutationRecord(
          old,
          "azure_application.create",
          "octo/app:dev"
        )
      );
    }
  );

  it.each([
    "succeeded",
    "succeeded_with_warnings",
    "action_required",
    "failed",
    "failed_partial",
    "cancelled"
  ])(
    "preserves stop, stage, command, cleanup and terminal-latch semantics for %s",
    (terminalState) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const before = legacy.createOperation({
        operationId: "op-parity",
        provider: "azure",
        repo: "octo/app",
        environment: "dev"
      });
      before.setupArtifacts.azureApp.state = "created";
      before.control.commands = [
        { state: "accepted", commandId: "c-1", outcome: null }
      ];
      const old = structuredClone(before);
      const portable = structuredClone(before);
      const run = (domain: OperationDomain, target: object) => {
        domain.enterStage(target, legacy.STAGE_CONFIGURE_ENVIRONMENT);
        domain.addStep(target, {
          label: "A bounded warning",
          warning: { code: "retained", message: "Customer identity retained" }
        });
        domain.requestStop(target);
        domain.touchOperation(target);
        domain.finish(target, terminalState, {
          terminal: { reason: "done" },
          announce: false
        });
        domain.finish(target, "failed", {
          terminal: { reason: "must-not-overwrite" }
        });
      };
      run(legacy, old);
      run(shared, portable);
      expect(portable).toEqual(old);
      expect(shared.shouldStop(portable)).toBe(legacy.shouldStop(old));
    }
  );

  it("preserves legacy record normalization without inventing ownership", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const input = {
      operationId: "op-legacy",
      providerRecovery: {
        state: "unrecoverable_legacy",
        guidance: "Review historical resources",
        mutations: [
          null,
          { kind: "bad" },
          {
            mutationId: "old",
            kind: "provider.put",
            target: "resource",
            status: "prepared",
            providerId: 17,
            reconcileAttempts: "2.9",
            intent: { ok: true, unsupported: {}, null: null, "": "discard" },
            initialDiagnostic: ` ${"x".repeat(2100)} `,
            createdByOperation: false
          }
        ]
      }
    };
    const old = structuredClone(input);
    const portable = structuredClone(input);
    legacy.prepareProviderMutation(old, { kind: "other.put", target: "other" });
    shared.prepareProviderMutation(portable, {
      kind: "other.put",
      target: "other"
    });
    expect(portable).toEqual(old);
  });
});
