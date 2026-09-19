import { describe, expect, it } from "vitest";
import {
  createEnvironmentArtifactLedger,
  createEnvironmentOperationControl,
  createEnvironmentOperationDomain,
  environmentOperationIdentity,
  isEnvironmentOperationTerminal
} from "./operation-domain.js";

const NOW = "2026-08-22T00:00:00.000Z";
function harness(
  announce: (operation: object) => boolean | void = () => false
) {
  const hashes: string[] = [];
  const domain = createEnvironmentOperationDomain({
    nowIso: () => NOW,
    sha256: (value) => {
      hashes.push(value);
      return "a".repeat(64);
    },
    redactDiagnostic: (value) => value.replaceAll("sensitive", "[redacted]"),
    announceTerminal: announce
  });
  const operation = {
    operationId: "op-portable",
    state: "running",
    currentStage: "first",
    stages: [
      { id: "first", state: "running" },
      { id: "second", state: "pending" },
      { id: "third", state: "pending" }
    ],
    steps: [] as Array<{ state: string }>,
    setupArtifacts: createEnvironmentArtifactLedger(),
    control: createEnvironmentOperationControl(),
    journey: { notifiedAt: null as string | null },
    providerRecovery: domain.readProviderRecovery(undefined),
    terminal: null as unknown,
    failure: null as unknown,
    endedAt: null as string | null,
    lastActivityAt: null as string | null,
    stopRequested: false
  };
  return { domain, operation, hashes };
}

describe("portable operation journal", () => {
  it("uses exact operation/kind/target identity and persists an isolated intent", () => {
    const { domain, operation, hashes } = harness();
    const intent = { value: "original" };
    const first = domain.prepareProviderMutation(operation, {
      kind: "provider.put",
      target: "exact",
      providerIdempotencyKey: "key",
      intent
    });
    intent.value = "changed";
    const second = domain.prepareProviderMutation(operation, {
      kind: "provider.put",
      target: "exact"
    });
    expect(hashes).toEqual([
      "op-portable\0provider.put\0exact",
      "op-portable\0provider.put\0exact"
    ]);
    expect(second).toEqual({ ...first, providerId: null });
    expect(operation.providerRecovery.mutations).toHaveLength(1);
    expect(second.intent).toEqual({ value: "original" });
    expect(
      domain.providerMutationRecord(operation, "provider.put", "exact")
    ).toEqual(second);
    expect(
      domain.providerMutationRecord(null, "provider.put", "exact")
    ).toBeNull();
    expect(domain.providerMutationsByKind(operation, "other")).toEqual([]);
    expect(
      domain.unresolvedProviderMutations(operation, ["provider.put"])
    ).toHaveLength(1);
    expect(domain.unresolvedProviderMutations(operation, [])).toEqual([]);
    expect(domain.unresolvedProviderMutations(null)).toEqual([]);
    expect(domain.providerMutationsByKind(null, "provider.put")).toEqual([]);
  });

  it("bounds and redacts diagnostics, keeping the first failure and latest reconciliation", () => {
    const { domain, operation } = harness();
    const mutation = domain.prepareProviderMutation(operation, {
      kind: "provider.put",
      target: "exact"
    });
    expect(
      domain.recordProviderMutationDiagnostics(operation, "missing", {
        initial: "missing"
      })
    ).toBe(false);
    expect(domain.recordProviderMutationDiagnostics(null, "missing", {})).toBe(
      false
    );
    domain.recordProviderMutationDiagnostics(operation, mutation.mutationId, {
      initial: " sensitive ",
      final: "first read"
    });
    domain.recordProviderMutationDiagnostics(operation, mutation.mutationId, {
      initial: "must not overwrite",
      final: "second read"
    });
    domain.recordProviderMutationDiagnostics(operation, mutation.mutationId, {
      initial: "",
      final: null
    });
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      initialDiagnostic: "[redacted]",
      finalDiagnostic: "second read"
    });
    expect(domain.boundedProviderDiagnostic(12)).toBeNull();
    expect(domain.boundedProviderDiagnostic(" \n")).toBeNull();
    expect(domain.boundedProviderDiagnostic("x".repeat(2000))).toHaveLength(
      2000
    );
    expect(domain.boundedProviderDiagnostic("x".repeat(2001))).toBe(
      `${"x".repeat(2000)}...`
    );
  });

  it("normalizes only valid journal records and primitive intent without claiming legacy ownership", () => {
    const { domain } = harness();
    const raw = {
      state: "unrecoverable_legacy",
      guidance: "Review resources",
      mutations: [
        null,
        {},
        { mutationId: "bad", kind: "p", target: "t", status: "invalid" },
        {
          mutationId: "valid",
          kind: "p",
          target: "t",
          status: "confirmed",
          preparedAt: "old",
          updatedAt: "later",
          providerIdempotencyKey: "key",
          providerId: 123,
          createdByOperation: false,
          reconcileAttempts: "2.9",
          intent: {
            a: "a",
            b: 1,
            c: false,
            d: null,
            invalid: {},
            "": "ignored"
          },
          initialDiagnostic: " sensitive ",
          finalDiagnostic: "latest",
          evidence: "proof"
        }
      ]
    };
    expect(domain.readProviderRecovery(raw)).toEqual({
      state: "unrecoverable_legacy",
      guidance: "Review resources",
      mutations: [
        {
          mutationId: "valid",
          kind: "p",
          target: "t",
          status: "confirmed",
          preparedAt: "old",
          updatedAt: "later",
          providerIdempotencyKey: "key",
          providerId: "123",
          createdByOperation: false,
          reconcileAttempts: 2,
          intent: { a: "a", b: 1, c: false, d: null },
          initialDiagnostic: "[redacted]",
          finalDiagnostic: "latest",
          evidence: "proof"
        }
      ]
    });
    expect(raw.mutations).toHaveLength(4);
    expect(
      domain.readProviderRecovery({ state: "invalid", mutations: {} })
    ).toEqual({ state: "idle", guidance: null, mutations: [] });
    expect(domain.readProviderRecovery(1)).toEqual({
      state: "idle",
      guidance: null,
      mutations: []
    });
    const incomplete = domain.readProviderRecovery({
      mutations: [
        {
          mutationId: "m",
          kind: "p",
          target: "t",
          status: "prepared",
          reconcileAttempts: "not-a-number",
          intent: []
        }
      ]
    });
    expect(incomplete.mutations[0]).toEqual({
      mutationId: "m",
      kind: "p",
      target: "t",
      status: "prepared",
      preparedAt: NOW,
      updatedAt: NOW,
      providerIdempotencyKey: null,
      providerId: null,
      intent: {},
      evidence: null
    });
  });

  it.each(["rollback_pending", "unrecoverable_legacy"] as const)(
    "preserves %s when journaling additional work",
    (state) => {
      const { domain, operation } = harness();
      operation.providerRecovery.state = state;
      operation.providerRecovery.guidance = "Retain the recovery decision";
      domain.prepareProviderMutation(operation, {
        kind: "provider.put",
        target: "exact"
      });
      expect(operation.providerRecovery.state).toBe(state);
      expect(operation.providerRecovery.guidance).toBe(
        "Retain the recovery decision"
      );
    }
  );

  it("settles exact ownership atomically and clears identity on a refused mutation", () => {
    const { domain, operation } = harness();
    const mutation = domain.prepareProviderMutation(operation, {
      kind: "provider.put",
      target: "exact"
    });
    expect(
      domain.settleProviderMutation(operation, "missing", "confirmed")
    ).toBe(false);
    expect(domain.settleProviderMutation(null, "missing", "confirmed")).toBe(
      false
    );
    expect(
      Reflect.apply(domain.settleProviderMutation, null, [
        operation,
        mutation.mutationId,
        "invalid"
      ])
    ).toBe(false);
    domain.settleProviderMutation(
      operation,
      mutation.mutationId,
      "confirmed",
      " proof ",
      " id ",
      true
    );
    domain.settleProviderMutation(operation, mutation.mutationId, "confirmed");
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      providerId: "id",
      createdByOperation: true
    });
    domain.settleProviderMutation(
      operation,
      mutation.mutationId,
      "not_applied",
      " "
    );
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      providerId: null,
      evidence: null
    });
    expect(operation.providerRecovery.state).toBe("complete");
    expect(() =>
      domain.prepareProviderMutation(null, { kind: "p", target: "t" })
    ).toThrow("operation is required");
  });

  it("retains manual guidance while other mutations reconcile, including rollback guidance", () => {
    const { domain, operation } = harness();
    const first = domain.prepareProviderMutation(operation, {
      kind: "provider.put",
      target: "exact"
    });
    operation.providerRecovery.mutations.push({
      ...first,
      mutationId: "second",
      status: "outcome_unknown"
    });
    domain.settleProviderMutation(
      operation,
      first.mutationId,
      "manual_required",
      "Review exact identity"
    );
    domain.settleProviderMutation(operation, "second", "confirmed");
    expect(operation.providerRecovery.state).toBe("manual_required");
    expect(domain.providerRecoveryManualGuidance(operation)).toBe(
      "Review exact identity"
    );
    operation.providerRecovery.state = "rollback_pending";
    domain.settleProviderMutation(operation, "second", "outcome_unknown");
    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(domain.providerRecoveryManualGuidance(operation)).toBe(
      "Review exact identity"
    );
    operation.providerRecovery.mutations[0].evidence = null;
    expect(domain.providerRecoveryManualGuidance(operation)).toContain(
      "could not prove the identity"
    );
    expect(domain.providerRecoveryManualGuidance({})).toBeNull();
    operation.providerRecovery.state = "manual_required";
    operation.providerRecovery.mutations = [];
    expect(domain.providerRecoveryManualGuidance(operation)).toContain(
      "could not prove the identity"
    );
  });

  it.each([
    [null, null],
    ["", null],
    ["  identity  ", "identity"],
    [42, "42"],
    [Infinity, null]
  ] as const)(
    "normalizes provider identity %s without guessing",
    (input, expected) => {
      expect(environmentOperationIdentity(input)).toBe(expected);
    }
  );
});

describe("portable operation lifecycle", () => {
  it("moves stages without overwriting prior failures and updates only live activity", () => {
    const { domain, operation } = harness();
    operation.stages[0].state = "failed";
    domain.enterStage(operation, "second");
    expect(operation.stages.map((stage) => stage.state)).toEqual([
      "failed",
      "running",
      "pending"
    ]);
    domain.enterStage(operation, "third");
    expect(operation.stages.map((stage) => stage.state)).toEqual([
      "failed",
      "succeeded",
      "running"
    ]);
    domain.setStageState(operation, "third", "warning");
    domain.setStageState(operation, "missing", "failed");
    domain.enterStage(operation, "missing");
    expect(operation.currentStage).toBe("third");
    domain.touchOperation(operation, "later");
    expect(operation.lastActivityAt).toBe("later");
    operation.state = "failed";
    domain.touchOperation(operation);
    expect(operation.lastActivityAt).toBe("later");
    expect(domain.enterStage(null, "x")).toBeNull();
    expect(domain.setStageState(null, "x", "failed")).toBeNull();
    expect(domain.touchOperation(null)).toBeNull();
    expect(() => domain.enterStage({}, "x")).toThrow();
  });

  it("records structured warnings and chooses warning-aware success", () => {
    const { domain, operation } = harness();
    expect(
      domain.addStep(operation, {
        label: "Read provider",
        kind: "invalid",
        state: "invalid"
      })
    ).toMatchObject({
      seq: 1,
      stage: "first",
      kind: "observation",
      state: "succeeded",
      label: "Read provider",
      startedAt: NOW,
      endedAt: NOW
    });
    domain.addStep(operation, {
      stage: "second",
      warning: {
        code: "retained",
        message: "Retained",
        impact: "Review",
        remediationCommand: "show",
        blocksFutureStep: "deploy"
      }
    });
    expect(domain.hasWarnings(operation)).toBe(true);
    domain.finishSucceeded(operation, "Done with retained identity");
    expect(operation.state).toBe("succeeded_with_warnings");
    expect(operation.terminal).toBe("Done with retained identity");
    expect(domain.addStep(null, {})).toBeNull();
    expect(domain.addStep({ steps: [] }, { warning: {} })).toMatchObject({
      label: "",
      state: "warning",
      warning: { code: "unknown", message: "" }
    });
    expect(domain.hasWarnings(null)).toBe(false);
  });

  it.each([
    "succeeded",
    "succeeded_with_warnings",
    "action_required",
    "failed",
    "failed_partial",
    "cancelled"
  ])("latches %s, closes pending commands, and selects cleanup", (state) => {
    const { domain, operation } = harness();
    operation.setupArtifacts.azureApp.state = "created";
    operation.control.commands = [
      { state: "accepted", outcome: null },
      { state: "running", outcome: "specific" },
      { state: "finished" }
    ];
    domain.finish(operation, state, {
      terminal: { reason: "initial" },
      failure: { code: "reason" },
      announce: false
    });
    const snapshot = structuredClone(operation);
    domain.finish(operation, "failed", {
      terminal: { reason: "must-not-overwrite" }
    });
    expect(operation).toEqual(snapshot);
    expect(operation.control.commands).toEqual([
      { state: "finished", outcome: state, completedAt: NOW },
      { state: "finished", outcome: "specific", completedAt: NOW },
      { state: "finished" }
    ]);
    expect(operation.setupArtifacts.cleanup.state).toBe(
      state.startsWith("failed") ? "pending" : "not_needed"
    );
    expect(operation.stages[0].state).toBe(
      state.startsWith("failed") ? "failed" : "succeeded"
    );
    expect(operation.stages[1].state).toBe("skipped");
    expect(isEnvironmentOperationTerminal(state)).toBe(true);
    expect(domain.requestStop(operation)).toBe(false);
    expect(domain.shouldStop(operation)).toBe(false);
  });

  it.each([
    "servicePrincipal-created",
    "servicePrincipal-candidate",
    "credential",
    "role",
    "github-created",
    "github-candidate",
    "variable",
    "workflow"
  ])("retains cleanup work for tracked %s artifacts", (kind) => {
    const { domain, operation } = harness();
    const ledger = operation.setupArtifacts;
    if (kind === "servicePrincipal-created")
      ledger.servicePrincipal.state = "created";
    if (kind === "servicePrincipal-candidate")
      ledger.servicePrincipal.state = "created_candidate";
    if (kind === "credential") ledger.federatedCredentials.push({});
    if (kind === "role") ledger.roleAssignments.push({});
    if (kind === "github-created") ledger.githubEnvironment.state = "created";
    if (kind === "github-candidate")
      ledger.githubEnvironment.state = "created_candidate";
    if (kind === "variable")
      ledger.githubEnvironmentVariables.push(
        { state: "pre_existing" },
        { state: "created" }
      );
    if (kind === "workflow") ledger.commit.workflowFiles.push({});
    domain.finish(operation, "failed");
    expect(ledger.cleanup.state).toBe("pending");
  });

  it("creates the absent control/ledger, preserves cleanup already underway, and rejects invalid terminal state", () => {
    const { domain, operation } = harness();
    const bare = { stages: [], steps: [] };
    domain.finishSucceeded(bare);
    expect(bare).toMatchObject({
      state: "succeeded",
      setupArtifacts: { cleanup: { state: "not_needed" } },
      control: { commands: [] }
    });
    operation.setupArtifacts.cleanup.state = "in_progress";
    domain.finish(operation, "failed");
    expect(operation.setupArtifacts.cleanup.state).toBe("in_progress");
    const untracked = harness().operation;
    domain.finish(untracked, "failed");
    expect(untracked.setupArtifacts.cleanup.state).toBe("not_needed");
    expect(() => domain.finish({}, "running")).toThrow(
      'Unknown terminal state "running"'
    );
    expect(domain.finish(null, "failed")).toBeNull();
    expect(isEnvironmentOperationTerminal({})).toBe(false);
  });

  it("keeps a durable stop and preserves the first timestamp across repeated requests", () => {
    const { domain } = harness();
    const operation = {};
    expect(domain.requestStop(operation)).toBe(true);
    expect(domain.requestStop(operation)).toBe(true);
    expect(operation).toMatchObject({
      stopRequested: true,
      control: { stop: { requestedAt: NOW } }
    });
    expect(domain.shouldStop(operation)).toBe(true);
    expect(domain.shouldStop({ control: { stop: { requestedAt: NOW } } })).toBe(
      true
    );
    expect(domain.shouldStop({})).toBe(false);
    expect(domain.requestStop(null)).toBe(false);
    expect(domain.shouldStop(null)).toBe(false);
  });

  it("terminalizes manual recovery without replacing an earlier terminal result", () => {
    const { domain, operation } = harness();
    operation.stages[2].state = "succeeded";
    domain.terminalizeProviderManualRequired(
      operation,
      "Check exact ownership"
    );
    expect(operation.stages[2].state).toBe("succeeded");
    expect(operation).toMatchObject({
      state: "failed_partial",
      endedAt: NOW,
      recoveryState: "manual_required",
      failure: {
        code: "provider-reconciliation-manual-required",
        message: "Check exact ownership"
      }
    });
    const snapshot = structuredClone(operation);
    domain.terminalizeProviderManualRequired(operation, "Must not replace");
    expect(operation).toEqual(snapshot);
    domain.terminalizeProviderManualRequired(null, "ignored");
    const bare = {};
    domain.terminalizeProviderManualRequired(bare, "review");
    expect(bare).toMatchObject({ state: "failed_partial" });
  });

  it.each(["delivered", "no-listener", "throws"] as const)(
    "treats %s terminal notification as an isolated host concern",
    (outcome) => {
      const calls: object[] = [];
      const { domain, operation } = harness((op) => {
        calls.push(op);
        if (outcome === "throws") throw new Error("host unavailable");
        return outcome === "delivered";
      });
      domain.finishSucceeded(operation);
      expect(operation.state).toBe("succeeded");
      expect(calls).toEqual([operation]);
      expect(operation.journey.notifiedAt).toBe(
        outcome === "delivered" ? NOW : null
      );
      if (outcome === "delivered") {
        const bare = { stages: [], steps: [] };
        domain.finishSucceeded(bare);
        expect(bare).toMatchObject({ journey: { notifiedAt: NOW } });
      }
    }
  );
});
