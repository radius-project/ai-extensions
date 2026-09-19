import type { OperationDomain, ProviderMutationRecord } from "../operations.js";

export interface EnvironmentOperationDomainPorts {
  nowIso(): string;
  sha256(value: string): string;
  redactDiagnostic(value: string): string;
  /** Return false when no notification was delivered. Notification failure is nonfatal. */
  announceTerminal(operation: object): boolean | void;
}

const TERMINAL_STATES = [
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
];
const MUTATION_STATUSES = [
  "prepared",
  "confirmed",
  "not_applied",
  "outcome_unknown",
  "manual_required"
] as const;
const RECOVERY_STATES = [
  "idle",
  "reconciling",
  "rollback_pending",
  "manual_required",
  "unrecoverable_legacy",
  "complete"
] as const;
const STEP_KINDS = [
  "preflight",
  "mutation",
  "observation",
  "warning",
  "prompt"
];
const STEP_STATES = [
  "pending",
  "running",
  "succeeded",
  "warning",
  "failed",
  "skipped"
];
export const PROVIDER_DIAGNOSTIC_MAX_LENGTH = 2000;

interface RecoveryRecord {
  state: (typeof RECOVERY_STATES)[number];
  guidance: string | null;
  mutations: ProviderMutationRecord[];
}
interface Step {
  state: string;
}
interface MutableOperation {
  operationId?: string;
  state?: string;
  providerRecovery?: unknown;
  lastActivityAt?: string;
  endedAt?: string;
  executionActive?: boolean;
  recoveryState?: string;
  currentStage?: string | null;
  stages: Array<{ id: string; state: string }>;
  steps: Step[];
  terminal?: unknown;
  failure?: unknown;
  stopRequested?: boolean;
  setupArtifacts?: ReturnType<typeof createEnvironmentArtifactLedger>;
  control?: {
    stop: {
      requestedAt: string | null;
      acknowledgedAt: string | null;
      boundary: string | null;
    };
    commands: Array<{ state: string; completedAt?: string; outcome?: unknown }>;
  };
  journey?: { notifiedAt?: string | null };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ?
      (value as Record<string, unknown>)
    : {};
}
function operation(value: unknown): MutableOperation | null {
  return value && typeof value === "object" ?
      (value as MutableOperation)
    : null;
}
function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
export function environmentOperationIdentity(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function isEnvironmentOperationTerminal(state: unknown): boolean {
  return typeof state === "string" && TERMINAL_STATES.includes(state);
}
export function createEnvironmentOperationControl() {
  return {
    stop: {
      requestedAt: null as string | null,
      acknowledgedAt: null as string | null,
      boundary: null as string | null
    },
    attempts: { setup: 1, verification: 0, cleanup: 0, deletion: 0 },
    commands: [] as Array<{
      state: string;
      completedAt?: string;
      outcome?: unknown;
    }>,
    outcomes: [] as unknown[]
  };
}
export function createEnvironmentArtifactLedger() {
  return {
    azureApp: {
      state: "not_started",
      origin: "unknown",
      appId: null as string | null,
      displayName: null as string | null,
      serviceManagementReference: null as string | null
    },
    servicePrincipal: {
      state: "not_started",
      origin: "unknown",
      appId: null as string | null,
      objectId: null as string | null
    },
    federatedCredentials: [] as unknown[],
    roleAssignments: [] as unknown[],
    githubEnvironment: {
      state: "not_started",
      origin: "unknown",
      repo: null as string | null,
      name: null as string | null,
      providerId: null as string | null
    },
    githubEnvironmentVariables: [] as Array<{ state: string }>,
    commit: {
      mode: "not_started",
      branch: null as string | null,
      baseBranch: null as string | null,
      pullRequestUrl: null as string | null,
      headSha: null as string | null,
      workflowFiles: [] as unknown[]
    },
    cleanup: {
      state: "not_started",
      ownerAssignment: "not_requested",
      attempts: 0,
      results: [] as unknown[]
    }
  };
}

function hasTrackedArtifacts(
  ledger: ReturnType<typeof createEnvironmentArtifactLedger>
): boolean {
  return (
    ledger.azureApp.state === "created" ||
    ledger.servicePrincipal.state === "created" ||
    ledger.servicePrincipal.state === "created_candidate" ||
    ledger.federatedCredentials.length > 0 ||
    ledger.roleAssignments.length > 0 ||
    ledger.githubEnvironment.state === "created" ||
    ledger.githubEnvironment.state === "created_candidate" ||
    ledger.githubEnvironmentVariables.some(
      (entry) => entry.state === "created"
    ) ||
    ledger.commit.workflowFiles.length > 0
  );
}

/** Shared journal and lifecycle transitions; persistence stays at explicit coordinator checkpoints. */
export function createEnvironmentOperationDomain(
  ports: EnvironmentOperationDomainPorts
) {
  function boundedProviderDiagnostic(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const diagnostic = ports.redactDiagnostic(value).trim();
    if (!diagnostic) return null;
    return diagnostic.length > PROVIDER_DIAGNOSTIC_MAX_LENGTH ?
        `${diagnostic.slice(0, PROVIDER_DIAGNOSTIC_MAX_LENGTH)}...`
      : diagnostic;
  }
  function readProviderRecovery(value: unknown): RecoveryRecord {
    const source = record(value);
    const mutations: ProviderMutationRecord[] = [];
    for (const raw of Array.isArray(source.mutations) ? source.mutations : []) {
      const entry = record(raw);
      const status = MUTATION_STATUSES.find(
        (candidate) => candidate === entry.status
      );
      if (
        !nonemptyString(entry.mutationId) ||
        !nonemptyString(entry.kind) ||
        !nonemptyString(entry.target) ||
        !status
      )
        continue;
      const intent: Record<string, string | number | boolean | null> = {};
      for (const [key, field] of Object.entries(record(entry.intent))) {
        if (
          key &&
          (typeof field === "string" ||
            typeof field === "number" ||
            typeof field === "boolean" ||
            field === null)
        )
          intent[key] = field;
      }
      const initialDiagnostic = boundedProviderDiagnostic(
        entry.initialDiagnostic
      );
      const finalDiagnostic = boundedProviderDiagnostic(entry.finalDiagnostic);
      const attempts = Number(entry.reconcileAttempts);
      mutations.push({
        mutationId: String(entry.mutationId),
        kind: String(entry.kind),
        target: String(entry.target),
        status,
        preparedAt: nonemptyString(entry.preparedAt) || ports.nowIso(),
        updatedAt: nonemptyString(entry.updatedAt) || ports.nowIso(),
        providerIdempotencyKey: nonemptyString(entry.providerIdempotencyKey),
        providerId: environmentOperationIdentity(entry.providerId),
        ...(typeof entry.createdByOperation === "boolean" ?
          { createdByOperation: entry.createdByOperation }
        : {}),
        ...(entry.intent && typeof entry.intent === "object" ? { intent } : {}),
        ...(Number.isFinite(attempts) && attempts > 0 ?
          { reconcileAttempts: Math.floor(attempts) }
        : {}),
        ...(initialDiagnostic ? { initialDiagnostic } : {}),
        ...(finalDiagnostic ? { finalDiagnostic } : {}),
        evidence: nonemptyString(entry.evidence)
      });
    }
    return {
      state: RECOVERY_STATES.find((state) => state === source.state) ?? "idle",
      guidance: nonemptyString(source.guidance),
      mutations
    };
  }
  const domain: OperationDomain = {
    providerMutationId: (operationId, kind, target) =>
      `pm_${ports.sha256(`${operationId}\0${kind}\0${target}`).slice(0, 32)}`,
    prepareProviderMutation(
      value,
      { kind, target, providerIdempotencyKey = null, intent = null }
    ) {
      const op = operation(value);
      if (!op)
        throw new Error(
          "An operation is required to prepare a provider mutation."
        );
      const recovery = readProviderRecovery(op.providerRecovery);
      const mutationId = domain.providerMutationId(
        String(op.operationId),
        kind,
        target
      );
      const existing = recovery.mutations.find(
        (entry) => entry.mutationId === mutationId
      );
      if (existing) {
        op.providerRecovery = recovery;
        return existing;
      }
      const timestamp = ports.nowIso();
      const mutation: ProviderMutationRecord = {
        mutationId,
        kind,
        target,
        status: "prepared",
        preparedAt: timestamp,
        updatedAt: timestamp,
        providerIdempotencyKey: nonemptyString(providerIdempotencyKey),
        ...(intent ? { intent: structuredClone(intent) } : {}),
        evidence: null
      };
      if (
        recovery.state !== "rollback_pending" &&
        recovery.state !== "unrecoverable_legacy"
      ) {
        recovery.state = "reconciling";
        recovery.guidance = null;
      }
      recovery.mutations.push(mutation);
      op.providerRecovery = recovery;
      op.lastActivityAt = timestamp;
      return mutation;
    },
    settleProviderMutation(
      value,
      mutationId,
      status,
      evidence = null,
      providerId = null,
      createdByOperation
    ) {
      if (!MUTATION_STATUSES.includes(status)) return false;
      const op = operation(value);
      const recovery = readProviderRecovery(op?.providerRecovery);
      const mutation = recovery.mutations.find(
        (entry) => entry.mutationId === mutationId
      );
      if (!op || !mutation) return false;
      const rollbackPending = recovery.state === "rollback_pending";
      mutation.status = status;
      mutation.updatedAt = ports.nowIso();
      const settledId = environmentOperationIdentity(providerId);
      if (settledId) mutation.providerId = settledId;
      else if (status !== "confirmed") mutation.providerId = null;
      if (typeof createdByOperation === "boolean")
        mutation.createdByOperation = createdByOperation;
      mutation.evidence =
        typeof evidence === "string" && evidence.trim() ?
          evidence.trim()
        : null;
      if (rollbackPending) {
        recovery.state = "rollback_pending";
        recovery.guidance = null;
      } else if (status === "manual_required") {
        recovery.state = "manual_required";
        recovery.guidance = mutation.evidence;
      } else if (
        recovery.mutations.some(
          (entry) =>
            entry.status === "prepared" || entry.status === "outcome_unknown"
        )
      )
        recovery.state = "reconciling";
      else if (
        recovery.mutations.some((entry) => entry.status === "manual_required")
      )
        recovery.state = "manual_required";
      else {
        recovery.state = "complete";
        recovery.guidance = null;
      }
      op.providerRecovery = recovery;
      op.lastActivityAt = mutation.updatedAt;
      return true;
    },
    providerMutationRecord(value, kind, target) {
      const op = operation(value);
      if (!op?.operationId) return null;
      const mutationId = domain.providerMutationId(
        op.operationId,
        kind,
        target
      );
      return (
        readProviderRecovery(op.providerRecovery).mutations.find(
          (entry) => entry.mutationId === mutationId
        ) || null
      );
    },
    providerMutationsByKind: (value, kind) =>
      readProviderRecovery(operation(value)?.providerRecovery).mutations.filter(
        (entry) => entry.kind === kind
      ),
    unresolvedProviderMutations(value, kinds) {
      const wanted = kinds ? new Set(kinds) : null;
      return readProviderRecovery(
        operation(value)?.providerRecovery
      ).mutations.filter(
        (entry) =>
          (entry.status === "prepared" || entry.status === "outcome_unknown") &&
          (!wanted || wanted.has(entry.kind))
      );
    },
    recordProviderMutationDiagnostics(value, mutationId, diagnostics) {
      const op = operation(value);
      const recovery = readProviderRecovery(op?.providerRecovery);
      const mutation = recovery.mutations.find(
        (entry) => entry.mutationId === mutationId
      );
      if (!op || !mutation) return false;
      const initial = boundedProviderDiagnostic(diagnostics.initial);
      if (initial && !mutation.initialDiagnostic)
        mutation.initialDiagnostic = initial;
      const final = boundedProviderDiagnostic(diagnostics.final);
      if (final) mutation.finalDiagnostic = final;
      op.providerRecovery = recovery;
      return true;
    },
    terminalizeProviderManualRequired(value, guidance) {
      const op = operation(value);
      if (!op || isEnvironmentOperationTerminal(op.state)) return;
      const now = ports.nowIso();
      Object.assign(op, {
        state: "failed_partial",
        endedAt: now,
        lastActivityAt: now,
        executionActive: false,
        failure: {
          code: "provider-reconciliation-manual-required",
          stage: op.currentStage,
          stepSeq: null,
          message: guidance,
          classification: "user-fixable",
          evidence: null
        },
        recoveryState: "manual_required"
      });
      for (const stage of op.stages || []) {
        if (stage.state === "running") stage.state = "failed";
        else if (stage.state === "pending") stage.state = "skipped";
      }
    },
    enterStage(value, stageId) {
      const op = operation(value);
      if (!op) return value;
      let seen = false;
      for (const stage of op.stages) {
        if (stage.id === stageId) {
          stage.state = "running";
          seen = true;
        } else if (
          !seen &&
          (stage.state === "pending" || stage.state === "running")
        )
          stage.state = "succeeded";
      }
      if (seen) op.currentStage = stageId;
      op.lastActivityAt = ports.nowIso();
      return op;
    },
    setStageState(value, stageId, state) {
      const op = operation(value);
      const stage = op?.stages.find((entry) => entry.id === stageId);
      if (stage) stage.state = state;
      return value;
    },
    touchOperation(value, now = ports.nowIso()) {
      const op = operation(value);
      if (op && !isEnvironmentOperationTerminal(op.state))
        op.lastActivityAt = now;
      return value;
    },
    addStep(
      value,
      {
        stage,
        kind = "observation",
        label,
        state = "succeeded",
        warning = null
      } = {}
    ) {
      const op = operation(value);
      if (!op) return null;
      const steps = op.steps;
      const step = {
        seq: steps.length + 1,
        stage: stage || op.currentStage,
        kind: STEP_KINDS.includes(kind) ? kind : "observation",
        label: String(label == null ? "" : label),
        state:
          warning ? "warning"
          : STEP_STATES.includes(state) ? state
          : "succeeded",
        startedAt: ports.nowIso(),
        endedAt: ports.nowIso(),
        ...(warning ?
          {
            warning: {
              code: warning.code || "unknown",
              message: warning.message || "",
              impact: warning.impact || "",
              remediationCommand: warning.remediationCommand || "",
              blocksFutureStep: warning.blocksFutureStep || ""
            }
          }
        : {})
      };
      steps.push(step);
      op.lastActivityAt = step.endedAt;
      return step;
    },
    finish(
      value,
      state,
      { terminal = null, failure = null, announce = true } = {}
    ) {
      const op = operation(value);
      if (!op) return value;
      if (!isEnvironmentOperationTerminal(state))
        throw new Error(`Unknown terminal state "${state}"`);
      if (isEnvironmentOperationTerminal(op.state)) return op;
      op.state = state;
      op.endedAt = ports.nowIso();
      if (terminal) op.terminal = terminal;
      if (failure) op.failure = failure;
      const failed = state === "failed" || state === "failed_partial";
      for (const stage of op.stages) {
        if (stage.state === "pending") stage.state = "skipped";
        else if (stage.state === "running")
          stage.state = failed ? "failed" : "succeeded";
      }
      const ledger =
        op.setupArtifacts ??
        (op.setupArtifacts = createEnvironmentArtifactLedger());
      if (ledger.cleanup.state === "not_started")
        ledger.cleanup.state =
          failed && hasTrackedArtifacts(ledger) ? "pending" : "not_needed";
      const control =
        op.control ?? (op.control = createEnvironmentOperationControl());
      for (const command of control.commands) {
        if (command.state !== "accepted" && command.state !== "running")
          continue;
        command.state = "finished";
        command.completedAt = ports.nowIso();
        if (command.outcome == null) command.outcome = state;
      }
      if (announce) {
        try {
          if (ports.announceTerminal(op) !== false) {
            if (!op.journey) op.journey = {};
            op.journey.notifiedAt = ports.nowIso();
          }
        } catch {
          // Notification failure must not erase a durable terminal outcome.
        }
      }
      return op;
    },
    finishSucceeded(value, terminal) {
      return domain.finish(
        value,
        domain.hasWarnings(value) ? "succeeded_with_warnings" : "succeeded",
        {
          terminal
        }
      );
    },
    hasWarnings: (value) =>
      Boolean(operation(value)?.steps.some((step) => step.state === "warning")),
    requestStop(value) {
      const op = operation(value);
      if (!op || isEnvironmentOperationTerminal(op.state)) return false;
      const control =
        op.control ?? (op.control = createEnvironmentOperationControl());
      if (!control.stop.requestedAt) {
        control.stop.requestedAt = ports.nowIso();
        op.lastActivityAt = control.stop.requestedAt;
      }
      op.stopRequested = true;
      return true;
    },
    shouldStop(value) {
      const op = operation(value);
      return Boolean(
        op &&
        !isEnvironmentOperationTerminal(op.state) &&
        (op.stopRequested || op.control?.stop?.requestedAt)
      );
    }
  };
  return {
    ...domain,
    boundedProviderDiagnostic,
    readProviderRecovery,
    providerRecoveryManualGuidance(value: unknown): string | null {
      const recovery = readProviderRecovery(operation(value)?.providerRecovery);
      const manual = recovery.mutations.find(
        (entry) => entry.status === "manual_required"
      );
      if (recovery.state !== "manual_required" && !manual) return null;
      return (
        recovery.guidance ||
        manual?.evidence ||
        "Radius could not prove the identity or ownership of a provider resource. Review the operation recovery details before making another attempt."
      );
    }
  };
}
