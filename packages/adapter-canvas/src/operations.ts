// @ts-nocheck
// Canvas adapter — long-running operation registry.
//
// Environment and credential setup used to run entirely inside an awaited POST
// with the browser parked behind a blocking modal, so the only thing the user
// could see was a spinner and one unchanging line of text. This module gives
// that work an addressable identity: a record the server writes to as it goes
// and the panel polls, so the operation survives the user navigating away and
// can be described after the fact.
//
// Design contract: docs/design/2026-08-progress-ux-credentials-environments.md
//
// Three properties matter more than the rest, and each is load-bearing:
//
//   1. The stage/step inventory is DATA. The renderer must never branch on
//      `provider`; a second cloud should be addable by supplying inventory and
//      vocabulary, not by editing the panel.
//   2. Terminal state is explicit and never inferred from the absence of an
//      error. The pull-request path is `action_required` — a correct outcome —
//      and reporting it as a timeout (which is what shipped) is the specific
//      bug this model exists to make unrepresentable.
//   3. Safe structured fields and attacker-influenced raw output are kept in
//      separate places. Everything under `context`, `steps[].label` and
//      `warning` is allowlisted; raw stderr only ever lands in
//      `failure.evidence`, fenced, and never in a label.

import { createHash, randomUUID } from "node:crypto";
import {
  disabledOperationStore,
  PERSISTED_OPERATIONS_VERSION,
  type OperationStore
} from "./operation-store.js";

// Version 2 adds the cooperative control record (stop, attempts, commands,
// outcome history). Version 1 records written by the durable store and the
// server-owned executor still load: `readOperationControl` fills the new fields
// with safe defaults rather than discarding the operation.
export const OPERATION_SCHEMA_VERSION = 2;
export const SUPPORTED_OPERATION_SCHEMA_VERSIONS = Object.freeze([1, 2]);

// `deleted` is written only after a cleanup attempt proved the resource is gone
// (removed by Radius, or already absent). It keeps a rolled-back artifact out of
// the surviving inventory and lets a later resume rebuild it.
export type SetupArtifactPresence =
  "not_started" | "created" | "reused" | "deleted";
export type SetupCommitMode = "not_started" | "default_branch" | "pull_request";
export type SetupCleanupStatus =
  | "not_started"
  | "pending"
  | "running"
  | "succeeded"
  | "succeeded_with_warnings"
  | "not_needed";

export type AzureAppArtifact = {
  state: SetupArtifactPresence;
  appId: string | null;
  displayName: string | null;
  serviceManagementReference: string | null;
};

export type ServicePrincipalArtifact = {
  state: SetupArtifactPresence;
  appId: string | null;
  objectId: string | null;
};

export type FederatedCredentialArtifact = {
  name: string;
  subject: string;
};

export type RoleAssignmentArtifact = {
  role: string;
  scope: string;
  principalObjectId: string | null;
};

export type GitHubEnvironmentArtifact = {
  state: SetupArtifactPresence | "created_candidate";
  repo: string | null;
  name: string | null;
};

export type WorkflowCommitArtifact = {
  path: string;
  branch: string | null;
  mode: Exclude<SetupCommitMode, "not_started">;
};

export type SetupArtifactCommitState = {
  mode: SetupCommitMode;
  branch: string | null;
  baseBranch: string | null;
  pullRequestUrl: string | null;
  workflowFiles: WorkflowCommitArtifact[];
};

export type SetupCleanupArtifactType =
  | "github_environment"
  | "role_assignment"
  | "federated_credential"
  | "service_principal"
  | "azure_app";

export type SetupCleanupOutcome =
  "deleted" | "not_found" | "warning" | "skipped";

// `identity` is the artifact's stable key (an appId, an object id, a
// `repo:name` pair), never the display label. The label is built for a human and
// changes with the resource's display name, so matching a cleanup result to the
// artifact it removed by label silently fails and reports a deleted resource as
// still present. Records written before this field existed fall back to `target`.
export type SetupCleanupResult = {
  attempt: number;
  artifactType: SetupCleanupArtifactType;
  target: string;
  identity?: string | null;
  outcome: SetupCleanupOutcome;
  detail: string | null;
};

export type SetupArtifactCleanupState = {
  state: SetupCleanupStatus;
  ownerAssignment: "not_requested";
  attempts: number;
  results: SetupCleanupResult[];
};

export type SetupArtifactLedger = {
  azureApp: AzureAppArtifact;
  servicePrincipal: ServicePrincipalArtifact;
  federatedCredentials: FederatedCredentialArtifact[];
  roleAssignments: RoleAssignmentArtifact[];
  githubEnvironment: GitHubEnvironmentArtifact;
  commit: SetupArtifactCommitState;
  cleanup: SetupArtifactCleanupState;
};

// ─── Cooperative control record ──────────────────────────────────────────────
// Issue #306 adds customer commands to the durable operation. The commands are
// recorded before Radius acts on them, so a Canvas reload, a duplicate click, or
// an extension restart resolves to the same saved decision instead of starting a
// second mutation. Nothing here holds a secret, a token, or raw command output.

// `continue_setup` and `rollback` are the two first-choice commands a stopped
// operation offers. They are separate kinds rather than a reused retry so the
// saved record says which decision the customer actually made: "continue what I
// stopped" and "repeat the continuation that failed" are different sentences,
// and so are "remove what this attempt created" and "try that removal again".
export type OperationCommandKind =
  | "stop"
  | "resume_input"
  | "continue_setup"
  | "retry_setup"
  | "retry_verification"
  | "rollback"
  | "retry_cleanup";

export type OperationCommandState = "accepted" | "running" | "finished";

export type OperationAttemptKind = "setup" | "verification" | "cleanup";

export type OperationCommandRecord = {
  kind: OperationCommandKind;
  commandId: string;
  attempt: number;
  target: string;
  state: OperationCommandState;
  acceptedAt: string;
  completedAt: string | null;
  outcome: string | null;
};

export type OperationStopRecord = {
  requestedAt: string | null;
  acknowledgedAt: string | null;
  boundary: string | null;
};

export type OperationAttemptCounters = {
  setup: number;
  verification: number;
  cleanup: number;
};

export type OperationOutcomeRecord = {
  kind: OperationAttemptKind;
  attempt: number;
  state: string;
  code: string | null;
  recordedAt: string;
};

export type OperationControlRecord = {
  stop: OperationStopRecord;
  attempts: OperationAttemptCounters;
  commands: OperationCommandRecord[];
  outcomes: OperationOutcomeRecord[];
};

const MAX_RETAINED_COMMANDS = 20;
const MAX_RETAINED_OUTCOMES = 20;

export function createOperationControl(): OperationControlRecord {
  return {
    stop: { requestedAt: null, acknowledgedAt: null, boundary: null },
    attempts: { setup: 1, verification: 0, cleanup: 0 },
    commands: [],
    outcomes: []
  };
}

function isoOrNull(value: any): string | null {
  return typeof value === "string" && value ? value : null;
}

function positiveInt(value: any, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const COMMAND_KINDS = Object.freeze([
  "stop",
  "resume_input",
  "continue_setup",
  "retry_setup",
  "retry_verification",
  "rollback",
  "retry_cleanup"
]);

const FORWARD_COMMAND_KINDS = Object.freeze(["continue_setup", "retry_setup"]);
const CLEANUP_COMMAND_KINDS = Object.freeze(["rollback", "retry_cleanup"]);
const COMMAND_STATES = Object.freeze(["accepted", "running", "finished"]);
const ATTEMPT_KINDS = Object.freeze(["setup", "verification", "cleanup"]);

/**
 * Normalize a persisted control record, filling schema-version-1 gaps.
 *
 * A command whose saved shape cannot be trusted is dropped rather than repaired:
 * a half-read command identity is the one thing that could let a retry run
 * twice, so this fails closed on the individual record instead of the operation.
 *
 * Fields an earlier build wrote and this one no longer keeps — the derived
 * `idempotencyKey` alias and the `idempotency` map beside it — are ignored
 * rather than rejected, so a version 2 record saved before they were dropped
 * still loads without a schema bump.
 */
export function readOperationControl(value: any): OperationControlRecord {
  const control = createOperationControl();
  if (!value || typeof value !== "object") return control;
  const stop = value.stop && typeof value.stop === "object" ? value.stop : {};
  control.stop = {
    requestedAt: isoOrNull(stop.requestedAt),
    acknowledgedAt: isoOrNull(stop.acknowledgedAt),
    boundary: isoOrNull(stop.boundary)
  };
  const attempts =
    value.attempts && typeof value.attempts === "object" ? value.attempts : {};
  control.attempts = {
    setup: positiveInt(attempts.setup, 1),
    verification: positiveInt(attempts.verification, 0),
    cleanup: positiveInt(attempts.cleanup, 0)
  };
  if (Array.isArray(value.commands)) {
    for (const entry of value.commands) {
      if (!entry || typeof entry !== "object") continue;
      if (!COMMAND_KINDS.includes(entry.kind)) continue;
      if (typeof entry.commandId !== "string" || !entry.commandId) continue;
      if (!COMMAND_STATES.includes(entry.state)) continue;
      control.commands.push({
        kind: entry.kind,
        commandId: entry.commandId,
        attempt: positiveInt(entry.attempt, 0),
        target: String(entry.target || "operation"),
        state: entry.state,
        acceptedAt: isoOrNull(entry.acceptedAt) || nowIso(),
        completedAt: isoOrNull(entry.completedAt),
        outcome: isoOrNull(entry.outcome)
      });
    }
  }
  if (Array.isArray(value.outcomes)) {
    for (const entry of value.outcomes) {
      if (!entry || typeof entry !== "object") continue;
      if (!ATTEMPT_KINDS.includes(entry.kind)) continue;
      if (typeof entry.state !== "string" || !entry.state) continue;
      control.outcomes.push({
        kind: entry.kind,
        attempt: positiveInt(entry.attempt, 0),
        state: entry.state,
        code: isoOrNull(entry.code),
        recordedAt: isoOrNull(entry.recordedAt) || nowIso()
      });
    }
  }
  return control;
}

/** The control record, created with safe defaults for a version 1 operation. */
export function getOperationControl(op: any): OperationControlRecord | null {
  if (!op) return null;
  if (!op.control) op.control = createOperationControl();
  return op.control;
}

// Terminal states are enumerated rather than derived. `succeeded_with_warnings`
// exists because the AKS RBAC grant can fail while everything else works, and
// calling that plain "succeeded" is how a user ends up debugging a deploy
// failure whose cause was already known at setup time.
export const TERMINAL_STATES = Object.freeze([
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
]);

export const RUNNING_STATE = "running";
export const INPUT_REQUIRED_STATE = "input_required";

export function isTerminalState(state: any): boolean {
  return TERMINAL_STATES.includes(state);
}

// Stage ids are provider-neutral. What happens inside a stage is not, which is
// exactly why steps are data supplied by the route rather than an interface
// radius-core would have to model for a flow it does not execute.
export const STAGE_AUTHORIZE_IDENTITY = "authorize_identity";
export const STAGE_CONFIGURE_ENVIRONMENT = "configure_environment";
export const STAGE_VERIFY = "verify";

const STAGE_LABELS = {
  [STAGE_AUTHORIZE_IDENTITY]: "Authorize deploy identity",
  [STAGE_CONFIGURE_ENVIRONMENT]: "Configure environment",
  [STAGE_VERIFY]: "Verify credentials"
};

// The canvas `page` enum (extension.ts inputSchema). A resume target is
// client-influenced data that ends up as an argument to a host RPC, so it is
// validated against this list before it can travel.
export const CANVAS_PAGES = Object.freeze([
  "credentials",
  "graph",
  "planned",
  "graph-diff",
  "deployed",
  "environment",
  "deploying"
]);

const STEP_KINDS = Object.freeze([
  "preflight",
  "mutation",
  "observation",
  "warning",
  "prompt"
]);
const STEP_STATES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "warning",
  "failed",
  "skipped"
]);

/**
 * Build the stage inventory for an operation.
 *
 * `authorize_identity` is conditional: a repository that already has working
 * credentials skips it entirely. Presenting a stage that will never run is the
 * checklist-shaped lie the design explicitly rejects, so an omitted stage is
 * absent from the inventory rather than present-and-skipped.
 */
export function buildStages({
  includeIdentity = true,
  includeVerify = true
}: any = {}): any[] {
  const ids = [];
  if (includeIdentity) ids.push(STAGE_AUTHORIZE_IDENTITY);
  ids.push(STAGE_CONFIGURE_ENVIRONMENT);
  if (includeVerify) ids.push(STAGE_VERIFY);
  return ids.map((id) => ({ id, label: STAGE_LABELS[id], state: "pending" }));
}

function nowIso() {
  return new Date().toISOString();
}

export function createSetupArtifactLedger(): SetupArtifactLedger {
  return {
    azureApp: {
      state: "not_started",
      appId: null,
      displayName: null,
      serviceManagementReference: null
    },
    servicePrincipal: {
      state: "not_started",
      appId: null,
      objectId: null
    },
    federatedCredentials: [],
    roleAssignments: [],
    githubEnvironment: {
      state: "not_started",
      repo: null,
      name: null
    },
    commit: {
      mode: "not_started",
      branch: null,
      baseBranch: null,
      pullRequestUrl: null,
      workflowFiles: []
    },
    cleanup: {
      state: "not_started",
      ownerAssignment: "not_requested",
      attempts: 0,
      results: []
    }
  };
}

export function getSetupArtifactLedger(op: any): SetupArtifactLedger | null {
  if (!op) return null;
  if (!op.setupArtifacts) op.setupArtifacts = createSetupArtifactLedger();
  return op.setupArtifacts;
}

/**
 * Validate and normalize a resume target.
 *
 * Returns null when the target cannot be trusted. `page` must be a member of
 * the canvas enum; anything else is dropped rather than sanitized, because a
 * near-miss page name is far more likely to be a bug than a typo worth fixing
 * on the user's behalf.
 */
export function sanitizeResumeTarget(target: any): any {
  if (!target || typeof target !== "object") return null;
  const page = typeof target.page === "string" ? target.page : "";
  if (!CANVAS_PAGES.includes(page)) return null;
  const out = { page };
  if (typeof target.repo === "string" && target.repo) out.repo = target.repo;
  if (typeof target.branch === "string" && target.branch)
    out.branch = target.branch;
  return out;
}

/**
 * Create a new operation record.
 *
 * `journey.origin` is captured here and nowhere else. Once the user has
 * navigated away, where they came from is unrecoverable — which is why this
 * lives in the base contract rather than being retrofitted alongside the
 * cross-page status work.
 */
export function createOperation({
  provider,
  repo,
  environment,
  stages,
  journey,
  operationId,
  startedAt
}: any = {}): any {
  const resumeTarget = sanitizeResumeTarget(journey && journey.resumeTarget);
  return {
    operationId: operationId || `op_${randomUUID()}`,
    schemaVersion: OPERATION_SCHEMA_VERSION,
    provider: provider || "",
    repo: repo || "",
    environment: environment || "",
    startedAt: startedAt || nowIso(),
    lastActivityAt: startedAt || nowIso(),
    endedAt: null,
    state: RUNNING_STATE,
    currentStage: (stages && stages[0] && stages[0].id) || null,
    stages: stages || buildStages(),
    steps: [],
    context: {},
    setupArtifacts: createSetupArtifactLedger(),
    journey: {
      origin: (journey && journey.origin) || null,
      resumeTarget,
      resumeBranch: (journey && journey.resumeBranch) || null,
      resumeReason: (journey && journey.resumeReason) || null,
      notifiedAt: null
    },
    terminal: null,
    failure: null,
    stopRequested: false,
    control: createOperationControl()
  };
}

/** Move the operation to a stage, closing out any earlier one. */
export function enterStage(op: any, stageId: any): any {
  if (!op) return op;
  let seen = false;
  for (const stage of op.stages) {
    if (stage.id === stageId) {
      stage.state = "running";
      seen = true;
    } else if (!seen) {
      // Anything before the stage we are entering is finished. Leave a
      // failed/warning verdict alone — only promote work that is still
      // sitting in pending/running.
      if (stage.state === "pending" || stage.state === "running")
        stage.state = "succeeded";
    }
  }
  if (seen) op.currentStage = stageId;
  op.lastActivityAt = nowIso();
  return op;
}

/** Mark a stage's terminal verdict without moving the cursor. */
export function setStageState(op: any, stageId: any, state: any): any {
  if (!op) return op;
  const stage = op.stages.find((s) => s.id === stageId);
  if (stage) stage.state = state;
  return op;
}

/** Keep a live operation open while the user supplies information needed to continue. */
export function requireInput(
  op: any,
  { code, message, checkpoint = null, metadata = null }: any = {}
): any {
  if (!op || isTerminalState(op.state)) return op;
  const promptCode = code || "input-required";
  op.state = INPUT_REQUIRED_STATE;
  op.inputRequired = {
    code: promptCode,
    message: message || "",
    checkpoint:
      typeof checkpoint === "string" && checkpoint ? checkpoint : promptCode,
    metadata:
      metadata && typeof metadata === "object" ?
        structuredClone(metadata)
      : null,
    requestedAt: nowIso()
  };
  op.lastActivityAt = op.inputRequired.requestedAt;
  return op;
}

/** Clear the prompt marker when a retry presents the requested input. */
export function resumeAfterInput(op: any): any {
  if (
    !op ||
    isTerminalState(op.state) ||
    op.state !== INPUT_REQUIRED_STATE ||
    !op.inputRequired
  )
    return op;
  op.state = RUNNING_STATE;
  op.inputRequired = null;
  op.recoveryState = null;
  op.lastActivityAt = nowIso();
  return op;
}

export function canResumeInput(
  op: any,
  {
    code,
    checkpoint,
    repo,
    environment,
    provider
  }: {
    code?: string;
    checkpoint?: string;
    repo?: string;
    environment?: string;
    provider?: string;
  } = {}
): boolean {
  if (
    !op ||
    isTerminalState(op.state) ||
    op.state !== INPUT_REQUIRED_STATE ||
    !op.inputRequired ||
    op.executionActive ||
    // A stop saved before this answer wins the race. Continuing here would
    // resume an operation the customer already asked Radius to end.
    shouldStop(op)
  )
    return false;
  if (
    !code ||
    !checkpoint ||
    !repo ||
    !environment ||
    !provider ||
    op.inputRequired.code !== code ||
    op.inputRequired.checkpoint !== checkpoint ||
    op.repo !== repo ||
    op.environment !== environment ||
    op.provider !== provider
  )
    return false;
  return true;
}

export function setExecutionActive(op: any, active: boolean): any {
  if (!op || isTerminalState(op.state)) return op;
  op.executionActive = !!active;
  op.lastActivityAt = nowIso();
  return op;
}

/**
 * Append a step.
 *
 * `label` is allowlisted, user-facing copy. Raw command output must never be
 * passed here — it belongs in `failure.evidence`, where it is fenced before it
 * can reach a prompt.
 */
export function addStep(
  op: any,
  {
    stage,
    kind = "observation",
    label,
    state = "succeeded",
    warning = null
  }: any = {}
): any {
  if (!op) return null;
  const step = {
    seq: op.steps.length + 1,
    stage: stage || op.currentStage,
    kind: STEP_KINDS.includes(kind) ? kind : "observation",
    label: String(label == null ? "" : label),
    state: STEP_STATES.includes(state) ? state : "succeeded",
    startedAt: nowIso(),
    endedAt: nowIso()
  };
  if (warning) {
    step.state = "warning";
    step.warning = {
      code: warning.code || "unknown",
      message: warning.message || "",
      impact: warning.impact || "",
      remediationCommand: warning.remediationCommand || "",
      blocksFutureStep: warning.blocksFutureStep || ""
    };
  }
  op.steps.push(step);
  op.lastActivityAt = step.endedAt;
  return step;
}

/**
 * Translate one of the existing `steps.push('…')` strings into a structured step.
 *
 * The setup routes accumulate fifty-odd of these strings. Rather than convert
 * every call site — a large, risky, all-or-nothing diff — this reads the marker
 * the existing code already encodes. That convention predates this module: the
 * routes had been tagging state with a leading glyph and a trailing ellipsis
 * long before anything parsed them, which makes it an interface to adopt rather
 * than prose to replace.
 *
 * The consequence is that the convention is now load-bearing. See the contract
 * documented at each `const steps = []` declaration in `server.ts`; a new step
 * that omits its marker silently lands on the default below.
 */
export function addLegacyStep(op: any, text: any, stage?: any): any {
  const raw = String(text == null ? "" : text);
  let state = "succeeded";
  let kind = "observation";
  if (raw.startsWith("✅")) {
    state = "succeeded";
  } else if (raw.startsWith("⚠️")) {
    state = "warning";
    kind = "warning";
  } else if (raw.startsWith("❌")) {
    state = "failed";
  } else if (raw.startsWith("⏭️")) {
    state = "skipped";
  } else if (raw.startsWith("ℹ️")) {
    state = "succeeded";
  } else if (raw.startsWith("👉")) {
    state = "succeeded";
    kind = "prompt";
  } else if (raw.endsWith("...")) {
    state = "running";
    kind = "mutation";
  }
  const label = raw.replace(/^(✅|⚠️|❌|⏭️|ℹ️|👉)\s*/u, "").trim();
  return addStep(op, { stage, kind, label, state });
}

/** Record allowlisted identity/context. Never accepts raw command output. */
export function setContext(op: any, patch: any): any {
  if (!op || !patch) return op;
  op.context = { ...op.context, ...patch };
  return op;
}

/**
 * Record the resolved cloud context as a discriminated union.
 *
 * Deliberately not a flattened bag: a record that reports a placeholder
 * subscription id as fact is worse than one that omits the field.
 */
export function setCloudContext(op: any, kind: any, fields: any): any {
  if (!op || !kind) return op;
  const clean = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === "") continue;
    clean[k] = v;
  }
  op.context = { ...op.context, cloud: { kind, ...clean } };
  return op;
}

export function recordAzureApp(op: any, patch: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !patch) return op;
  ledger.azureApp = { ...ledger.azureApp, ...patch };
  return op;
}

export function recordServicePrincipal(op: any, patch: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !patch) return op;
  ledger.servicePrincipal = { ...ledger.servicePrincipal, ...patch };
  return op;
}

export function recordCreatedFederatedCredential(op: any, entry: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !entry) return op;
  const next = {
    name: String(entry.name || ""),
    subject: String(entry.subject || "")
  };
  if (!next.name || !next.subject) return op;
  if (
    !ledger.federatedCredentials.some(
      (item) => item.name === next.name && item.subject === next.subject
    )
  ) {
    ledger.federatedCredentials.push(next);
  }
  return op;
}

export function recordCreatedRoleAssignment(op: any, entry: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !entry) return op;
  const next = {
    role: String(entry.role || ""),
    scope: String(entry.scope || ""),
    principalObjectId:
      entry.principalObjectId == null || entry.principalObjectId === "" ?
        null
      : String(entry.principalObjectId)
  };
  if (!next.role || !next.scope) return op;
  if (
    !ledger.roleAssignments.some(
      (item) =>
        item.role === next.role &&
        item.scope === next.scope &&
        item.principalObjectId === next.principalObjectId
    )
  ) {
    ledger.roleAssignments.push(next);
  }
  return op;
}

export function recordGitHubEnvironment(op: any, patch: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !patch) return op;
  ledger.githubEnvironment = { ...ledger.githubEnvironment, ...patch };
  return op;
}

export function recordCommitState(op: any, patch: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !patch) return op;
  ledger.commit = { ...ledger.commit, ...patch };
  if (ledger.commit.branch) {
    ledger.commit.workflowFiles = ledger.commit.workflowFiles.map((file) => ({
      ...file,
      branch: file.branch || ledger.commit.branch
    }));
  }
  return op;
}

export function recordCommittedWorkflowFile(op: any, entry: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !entry) return op;
  const path = String(entry.path || "");
  const mode = entry.mode;
  const branch =
    entry.branch == null || entry.branch === "" ? null : String(entry.branch);
  if (!path || (mode !== "default_branch" && mode !== "pull_request")) {
    return op;
  }
  if (
    !ledger.commit.workflowFiles.some(
      (file) =>
        file.path === path && file.mode === mode && file.branch === branch
    )
  ) {
    ledger.commit.workflowFiles.push({ path, mode, branch });
  }
  if (ledger.commit.mode === "not_started") {
    ledger.commit.mode = mode;
    ledger.commit.branch = branch;
  }
  return op;
}

export function recordCleanupState(op: any, patch: any): any {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || !patch) return op;
  ledger.cleanup = { ...ledger.cleanup, ...patch };
  return op;
}

/**
 * Take a proven-gone artifact out of the ledger.
 *
 * A ledger that still claims to own a resource Radius deleted is the source of
 * two follow-on defects: the partial-state inventory reports it as surviving,
 * and `nextIncompleteSetupStep` skips the step that has to recreate it. Called
 * only for a `deleted` or `not_found` cleanup result, never for a warning — a
 * failed deletion leaves ownership exactly where it was.
 */
export function recordCleanupDeletion(
  op: any,
  {
    artifactType,
    identity
  }: { artifactType: SetupCleanupArtifactType | string; identity?: string }
): boolean {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return false;
  const key = normalizeIdentityPart(identity);
  const matches = (artifact: any): boolean =>
    !key || cleanupArtifactIdentity(artifactType, artifact) === key;
  switch (artifactType) {
    case "azure_app":
      if (ledger.azureApp.state !== "created" || !matches(ledger.azureApp))
        return false;
      ledger.azureApp.state = "deleted";
      return true;
    case "service_principal":
      if (
        ledger.servicePrincipal.state !== "created" ||
        !matches(ledger.servicePrincipal)
      )
        return false;
      ledger.servicePrincipal.state = "deleted";
      return true;
    case "github_environment":
      if (
        ledger.githubEnvironment.state !== "created" ||
        !matches(ledger.githubEnvironment)
      )
        return false;
      ledger.githubEnvironment.state = "deleted";
      return true;
    case "federated_credential": {
      const remaining = ledger.federatedCredentials.filter(
        (entry: any) => !matches(entry)
      );
      if (remaining.length === ledger.federatedCredentials.length) return false;
      ledger.federatedCredentials = remaining;
      return true;
    }
    case "role_assignment": {
      const remaining = ledger.roleAssignments.filter(
        (entry: any) => !matches(entry)
      );
      if (remaining.length === ledger.roleAssignments.length) return false;
      ledger.roleAssignments = remaining;
      return true;
    }
    default:
      return false;
  }
}

function hasTrackedSetupArtifacts(ledger: SetupArtifactLedger | null): boolean {
  if (!ledger) return false;
  return (
    ledger.azureApp.state === "created" ||
    ledger.servicePrincipal.state === "created" ||
    ledger.federatedCredentials.length > 0 ||
    ledger.roleAssignments.length > 0 ||
    ledger.githubEnvironment.state === "created" ||
    ledger.githubEnvironment.state === "created_candidate" ||
    ledger.commit.workflowFiles.length > 0
  );
}

function hasReachedSetupCommitPoint(op: any): boolean {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return false;
  return (
    ledger.commit.mode !== "not_started" ||
    ledger.commit.workflowFiles.length > 0
  );
}

function cleanupResultTarget(result: any): string {
  const target =
    result && typeof result.target === "string" ? result.target : "";
  if (!target) return "";
  return result && result.outcome === "not_found" ?
      `${target} (already absent)`
    : target;
}

function formatAzureAppLabel(app: any): string {
  const name = String((app && app.displayName) || "").trim();
  const appId = String((app && app.appId) || "").trim();
  if (name && appId && name !== appId) return `${name} (${appId})`;
  return name || appId || "App Registration";
}

function formatServicePrincipalLabel(sp: any, ledger: any): string {
  const appLabel = formatAzureAppLabel({
    displayName:
      (ledger && ledger.azureApp && ledger.azureApp.displayName) || "",
    appId:
      (sp && sp.appId) || (ledger && ledger.azureApp && ledger.azureApp.appId)
  });
  return appLabel ? `Service Principal for ${appLabel}` : "Service Principal";
}

function formatGitHubEnvironmentLabel(env: any): string {
  const repo = String((env && env.repo) || "").trim();
  const name = String((env && env.name) || "").trim();
  if (repo && name) return `${repo}:${name}`;
  return name || repo || "GitHub environment";
}

function formatWorkflowFileLabel(file: any): string {
  const path = String((file && file.path) || "").trim();
  const branch = String((file && file.branch) || "").trim();
  if (!path) return "";
  return branch ? `${path} on ${branch}` : path;
}

// ─── Stable artifact identity ────────────────────────────────────────────────
// A cleanup result and a ledger entry describe the same resource, so matching
// them must not go through the display label: `formatAzureAppLabel` renders
// "radius-store (00000000-…)" while the deletion recorded the bare appId, and a
// deleted App Registration therefore kept appearing in "created". Identity is
// derived from the fields that actually name the resource, and a result written
// before this field existed is still matched through its recorded target.

function normalizeIdentityPart(value: any): string {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase();
}

/** The stable key for one cleanup-capable artifact, or "" when unidentifiable. */
export function cleanupArtifactIdentity(
  artifactType: any,
  artifact: any
): string {
  if (!artifact) return "";
  switch (artifactType) {
    case "azure_app":
      return normalizeIdentityPart(artifact.appId);
    case "service_principal":
      return (
        normalizeIdentityPart(artifact.appId) ||
        normalizeIdentityPart(artifact.objectId)
      );
    case "federated_credential":
      return `${normalizeIdentityPart(artifact.name)}@${normalizeIdentityPart(
        artifact.subject
      )}`;
    case "role_assignment":
      return `${normalizeIdentityPart(artifact.role)}@${normalizeIdentityPart(
        artifact.scope
      )}`;
    case "github_environment":
      return `${normalizeIdentityPart(artifact.repo)}:${normalizeIdentityPart(
        artifact.name
      )}`;
    default:
      return "";
  }
}

/**
 * Every key a cleanup result may legitimately carry for one artifact.
 *
 * The identity is authoritative; the labels are the compatibility path for
 * results persisted before results carried an identity at all.
 */
function artifactMatchKeys(
  artifactType: string,
  identity: string,
  labels: string[]
): Set<string> {
  const keys = new Set<string>();
  if (identity) keys.add(`${artifactType}#${identity}`);
  for (const label of labels) {
    const normalized = normalizeIdentityPart(label);
    if (normalized) keys.add(`${artifactType}#${normalized}`);
  }
  return keys;
}

function cleanupResultMatchKey(result: any): string {
  return cleanupTargetKey(result);
}

/**
 * The stable key that ties a cleanup result, an unresolved target, and a ledger
 * artifact together. Falls back to the recorded label for results written before
 * results carried an identity.
 */
export function cleanupTargetKey(entry: any): string {
  const artifactType = String((entry && entry.artifactType) || "");
  const identity =
    normalizeIdentityPart(entry && entry.identity) ||
    normalizeIdentityPart(entry && entry.target);
  return `${artifactType}#${identity}`;
}

/** Keys of the artifacts a cleanup attempt proved are gone. */
function removedArtifactKeys(results: any[]): Set<string> {
  const removed = new Set<string>();
  for (const result of results) {
    if (result?.outcome !== "deleted" && result?.outcome !== "not_found")
      continue;
    removed.add(cleanupResultMatchKey(result));
    // Old records only carry the display label; index both so either matches.
    const target = normalizeIdentityPart(result?.target);
    if (target) removed.add(`${String(result?.artifactType || "")}#${target}`);
  }
  return removed;
}

function pushRetainedArtifact(list: any[], entry: any): void {
  if (!entry || !entry.target) return;
  if (
    list.some(
      (item) => item.target === entry.target && item.kind === entry.kind
    )
  )
    return;
  list.push(entry);
}

function cleanupAttemptResults(ledger: any): any[] {
  if (!ledger || !Array.isArray(ledger.cleanup && ledger.cleanup.results))
    return [];
  const attempt = Number((ledger.cleanup && ledger.cleanup.attempts) || 0);
  if (!attempt) return [];
  return ledger.cleanup.results.filter(
    (entry: any) => Number(entry && entry.attempt) === attempt
  );
}

export function projectCleanupSummary(op: any): any {
  if (!op) return null;
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return null;
  const failureState = op.state === "failed" || op.state === "failed_partial";
  const cleanupState = ledger.cleanup && ledger.cleanup.state;
  // A stopped or retried operation leaves resources behind exactly as a failure
  // does, and the customer needs the same truthful inventory to decide what to
  // do next. Only an operation with nothing recorded stays silent.
  const reportableState =
    failureState ||
    op.state === "cancelled" ||
    (op.control && op.control.attempts && op.control.attempts.setup > 1);
  if (
    !reportableState &&
    cleanupState === "not_started" &&
    !hasTrackedSetupArtifacts(ledger)
  )
    return null;

  const commitPointReached = hasReachedSetupCommitPoint(op);
  const attemptResults = cleanupAttemptResults(ledger);
  const results = attemptResults.map((entry: any) => ({
    artifactType: entry.artifactType,
    outcome: entry.outcome,
    target: String(entry.target || ""),
    detail:
      entry.detail == null || entry.detail === "" ? null : String(entry.detail)
  }));
  const warnings = [
    ...new Set(
      results
        .filter(
          (entry: any) =>
            (entry.outcome === "warning" || entry.outcome === "skipped") &&
            entry.detail
        )
        .map((entry: any) => entry.detail)
    )
  ];
  const removed = results
    .filter(
      (entry: any) =>
        entry.outcome === "deleted" || entry.outcome === "not_found"
    )
    .map((entry: any) => ({
      artifactType: entry.artifactType,
      outcome: entry.outcome,
      target: cleanupResultTarget(entry)
    }));

  const retained: any[] = [];
  if (ledger.azureApp.state === "reused") {
    pushRetainedArtifact(retained, {
      kind: "azure_app",
      reason: "reused",
      target: formatAzureAppLabel(ledger.azureApp)
    });
  }
  if (ledger.servicePrincipal.state === "reused") {
    pushRetainedArtifact(retained, {
      kind: "service_principal",
      reason: "reused",
      target: formatServicePrincipalLabel(ledger.servicePrincipal, ledger)
    });
  }
  if (ledger.githubEnvironment.state === "reused") {
    pushRetainedArtifact(retained, {
      kind: "github_environment",
      reason: "reused",
      target: formatGitHubEnvironmentLabel(ledger.githubEnvironment)
    });
  }
  if (ledger.githubEnvironment.state === "created_candidate") {
    pushRetainedArtifact(retained, {
      kind: "github_environment",
      reason: "manual_cleanup_required",
      target: formatGitHubEnvironmentLabel(ledger.githubEnvironment)
    });
  }
  ledger.commit.workflowFiles.forEach((entry: any) => {
    pushRetainedArtifact(retained, {
      kind: "workflow_file",
      reason: "retained",
      target: formatWorkflowFileLabel(entry)
    });
  });
  if (commitPointReached) {
    if (ledger.azureApp.state === "created") {
      pushRetainedArtifact(retained, {
        kind: "azure_app",
        reason: "retained",
        target: formatAzureAppLabel(ledger.azureApp)
      });
    }
    if (ledger.servicePrincipal.state === "created") {
      pushRetainedArtifact(retained, {
        kind: "service_principal",
        reason: "retained",
        target: formatServicePrincipalLabel(ledger.servicePrincipal, ledger)
      });
    }
    ledger.federatedCredentials.forEach((entry: any) => {
      pushRetainedArtifact(retained, {
        kind: "federated_credential",
        reason: "retained",
        target: `${String(entry.name || "")} @ ${String(entry.subject || "")}`
      });
    });
    ledger.roleAssignments.forEach((entry: any) => {
      pushRetainedArtifact(retained, {
        kind: "role_assignment",
        reason: "retained",
        target: `${String(entry.role || "")} @ ${String(entry.scope || "")}`
      });
    });
    if (ledger.githubEnvironment.state === "created") {
      pushRetainedArtifact(retained, {
        kind: "github_environment",
        reason: "retained",
        target: formatGitHubEnvironmentLabel(ledger.githubEnvironment)
      });
    }
  }

  const retainedFromAttempt = retained.some(
    (entry) => entry.reason !== "reused"
  );
  const startsCleanly = !retainedFromAttempt && warnings.length === 0;
  const retry =
    retainedFromAttempt ?
      {
        startsCleanly: false,
        state: "reuses_retained_artifacts",
        guidance:
          "Retry will reuse the resources that were already written before the failure."
      }
    : warnings.length > 0 ?
      {
        startsCleanly: false,
        state: "manual_cleanup_advised",
        guidance:
          "Cleanup finished with warnings. Review the guidance below before retrying."
      }
    : {
        startsCleanly: true,
        state: "clean",
        guidance:
          "Cleanup removed the new resources from this attempt. Retry starts cleanly."
      };

  return {
    attempt: Number((ledger.cleanup && ledger.cleanup.attempts) || 0),
    rollbackAttempted:
      results.length > 0 ||
      cleanupState === "running" ||
      cleanupState === "succeeded" ||
      cleanupState === "succeeded_with_warnings",
    rollbackBeforeCommit: !commitPointReached,
    state: cleanupState,
    results,
    removed,
    retained,
    warnings,
    retry,
    ...projectPartialState(op, {
      ledger,
      results,
      attemptResults,
      commitPointReached
    })
  };
}

/**
 * Name what exists after a stop, a failure, or a retry.
 *
 * The groups are disjoint on purpose. A customer reading "created" and
 * "retained" in the same list cannot tell whether Radius intends to reuse the
 * resource or has simply left it behind, and that ambiguity is what turns a
 * partial setup into a manual audit. Only safe labels travel: no secret value,
 * no token, no raw command output, and never the private ledger itself.
 */
function projectPartialState(
  op: any,
  {
    ledger,
    results,
    attemptResults,
    commitPointReached
  }: {
    ledger: any;
    results: any[];
    attemptResults: any[];
    commitPointReached: boolean;
  }
): any {
  const cleaned = results
    .filter(
      (entry: any) =>
        entry.outcome === "deleted" || entry.outcome === "not_found"
    )
    .map((entry: any) => ({
      kind: entry.artifactType,
      target: cleanupResultTarget(entry),
      outcome: entry.outcome
    }));
  // Matched on identity, not on the rendered label. The two differ for every
  // Azure artifact, which is why a removed App Registration used to survive
  // this filter and be reported to the customer as still present.
  const removedKeys = removedArtifactKeys(attemptResults);
  const manualActionRequired = results
    .filter(
      (entry: any) => entry.outcome === "warning" || entry.outcome === "skipped"
    )
    .map((entry: any) => ({
      kind: entry.artifactType,
      target: String(entry.target || ""),
      action:
        entry.detail ||
        "Review this resource in the Azure or GitHub portal and remove it if this setup should be rolled back."
    }));
  if (ledger.githubEnvironment.state === "created_candidate") {
    const target = formatGitHubEnvironmentLabel(ledger.githubEnvironment);
    if (!manualActionRequired.some((entry: any) => entry.target === target)) {
      manualActionRequired.push({
        kind: "github_environment",
        target,
        action:
          "Radius cannot prove it created this GitHub environment, so it was left in place. Delete it yourself if this setup should be rolled back."
      });
    }
  }

  const reused: any[] = [];
  if (ledger.azureApp.state === "reused")
    reused.push({
      kind: "azure_app",
      target: formatAzureAppLabel(ledger.azureApp)
    });
  if (ledger.servicePrincipal.state === "reused")
    reused.push({
      kind: "service_principal",
      target: formatServicePrincipalLabel(ledger.servicePrincipal, ledger)
    });
  if (ledger.githubEnvironment.state === "reused")
    reused.push({
      kind: "github_environment",
      target: formatGitHubEnvironmentLabel(ledger.githubEnvironment)
    });

  const surviving: any[] = [];
  const pushSurviving = (
    kind: string,
    artifact: any,
    target: string,
    extra: any = {}
  ) => {
    surviving.push({
      kind,
      target,
      keys: artifactMatchKeys(kind, cleanupArtifactIdentity(kind, artifact), [
        target
      ]),
      ...extra
    });
  };
  if (ledger.azureApp.state === "created")
    pushSurviving(
      "azure_app",
      ledger.azureApp,
      formatAzureAppLabel(ledger.azureApp)
    );
  if (ledger.servicePrincipal.state === "created")
    pushSurviving(
      "service_principal",
      ledger.servicePrincipal,
      formatServicePrincipalLabel(ledger.servicePrincipal, ledger)
    );
  ledger.federatedCredentials.forEach((entry: any) => {
    pushSurviving(
      "federated_credential",
      entry,
      `${String(entry.name || "")} @ ${String(entry.subject || "")}`
    );
  });
  ledger.roleAssignments.forEach((entry: any) => {
    pushSurviving(
      "role_assignment",
      entry,
      `${String(entry.role || "")} @ ${String(entry.scope || "")}`
    );
  });
  if (ledger.githubEnvironment.state === "created")
    pushSurviving(
      "github_environment",
      ledger.githubEnvironment,
      formatGitHubEnvironmentLabel(ledger.githubEnvironment)
    );
  ledger.commit.workflowFiles.forEach((entry: any) => {
    const target = formatWorkflowFileLabel(entry);
    if (target)
      surviving.push({
        kind: "workflow_file",
        target,
        keys: new Set<string>(),
        keepAlways: true
      });
  });

  // "Reusable" means a forward continuation would reuse it, whichever label
  // that continuation carries: a deliberate stop is continued and a failed
  // continuation is retried, and both walk the same ledger.
  const reusableOnRetry =
    commitPointReached || canRetrySetup(op).ok || canContinueSetup(op).ok;
  const created: any[] = [];
  const retainedGroup: any[] = [];
  for (const entry of surviving) {
    if ([...entry.keys].some((key: string) => removedKeys.has(key))) continue;
    const item = { kind: entry.kind, target: entry.target };
    if (entry.keepAlways || reusableOnRetry) retainedGroup.push(item);
    else created.push(item);
  }

  return {
    created,
    retainedArtifacts: retainedGroup,
    reused,
    cleaned,
    manualActionRequired
  };
}

// ─── Retry eligibility ───────────────────────────────────────────────────────
// Each check is a closed list built from the failure codes this code actually
// produces. An unrecognised failure is never classified as retryable: guessing
// costs a duplicated cloud resource, while refusing costs one support message.

const VERIFICATION_RETRY_CLASSIFICATIONS: Record<string, string> = {
  "verify-run-failed": "azure-rbac-propagation",
  "verification-tracking-expired": "verification-tracking-expired",
  // The dispatch call itself failed, so no run was ever created: nothing was
  // verified, nothing was written, and asking GitHub again is the whole fix.
  "verify-dispatch-failed": "verification-dispatch-failed"
};

const VERIFICATION_RETRY_TERMINAL_REASONS: Record<string, string> = {
  "pr-merge-required": "workflow-installation-pending"
};

export function classifyVerificationRetry(op: any): string | null {
  if (!op) return null;
  if (op.state === "action_required") {
    return (
      VERIFICATION_RETRY_TERMINAL_REASONS[String(op.terminal?.reason || "")] ||
      null
    );
  }
  if (op.state === "failed_partial") {
    return (
      VERIFICATION_RETRY_CLASSIFICATIONS[String(op.failure?.code || "")] || null
    );
  }
  return null;
}

function hasCloudIdentityProvenance(op: any, ledger: any): boolean {
  if (op.provider === "azure") {
    return Boolean(ledger.azureApp.appId || ledger.servicePrincipal.appId);
  }
  return Boolean(op.context && op.context.cloud);
}

export function hasVerificationProvenance(op: any): boolean {
  const verification = op?.verification;
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return false;
  return Boolean(
    op.repo &&
    op.environment &&
    typeof verification?.workflow === "string" &&
    verification.workflow &&
    typeof verification?.ref === "string" &&
    verification.ref &&
    typeof verification?.environment === "string" &&
    verification.environment &&
    (ledger.commit.mode !== "not_started" ||
      ledger.commit.workflowFiles.length > 0) &&
    hasCloudIdentityProvenance(op, ledger)
  );
}

export function setupPullRequestUrl(op: any): string | null {
  const ledger = getSetupArtifactLedger(op);
  const fromTerminal =
    typeof op?.terminal?.pullRequestUrl === "string" ?
      op.terminal.pullRequestUrl
    : "";
  const fromLedger =
    typeof ledger?.commit?.pullRequestUrl === "string" ?
      ledger.commit.pullRequestUrl
    : "";
  return fromTerminal || fromLedger || null;
}

export function canRetryVerification(op: any): any {
  if (!op) return { ok: false, code: "unknown-operation" };
  if (!isTerminalState(op.state))
    return { ok: false, code: "operation-active" };
  const classification = classifyVerificationRetry(op);
  if (!classification)
    return { ok: false, code: "verification-retry-not-retryable" };
  if (!hasVerificationProvenance(op))
    return { ok: false, code: "verification-provenance-incomplete" };
  return {
    ok: true,
    code: "verification-retry-allowed",
    classification,
    requiresMergedPullRequest:
      classification === "workflow-installation-pending",
    pullRequestUrl: setupPullRequestUrl(op)
  };
}

/**
 * The reason a setup retry must be refused, or null when ownership is provable.
 *
 * A mutation that may have succeeded before Radius could save its provenance is
 * the one case that must never be retried automatically. Re-running it could
 * create a second App Registration; deleting it could remove one the customer
 * already relies on.
 */
export function ambiguousSetupOwnership(ledger: any): string | null {
  if (!ledger) return "The setup artifact ledger is missing.";
  if (ledger.githubEnvironment.state === "created_candidate")
    return "A GitHub environment may exist without proven ownership.";
  const results =
    Array.isArray(ledger.cleanup?.results) ? ledger.cleanup.results : [];
  const skipped = results.find((entry: any) => entry?.outcome === "skipped");
  if (skipped)
    return (
      skipped.detail ||
      "A recorded resource could not be identified precisely enough to act on."
    );
  return null;
}

export const SETUP_RESUME_STEPS = Object.freeze([
  "azure_app",
  "service_principal",
  "federated_credentials",
  "role_assignments",
  "github_environment",
  "workflow_commit",
  "verification"
]);

/** The first step the ledger does not already prove finished. */
export function nextIncompleteSetupStep(op: any): string {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return "azure_app";
  // A rolled-back artifact is incomplete again: cleanup proved it is gone, so
  // resuming past it would leave the setup permanently missing that resource.
  const present = (state: any) => state === "created" || state === "reused";
  if (op?.provider === "azure") {
    if (!present(ledger.azureApp.state)) return "azure_app";
    if (!present(ledger.servicePrincipal.state)) return "service_principal";
    if (ledger.federatedCredentials.length === 0)
      return "federated_credentials";
    if (ledger.roleAssignments.length === 0) return "role_assignments";
  }
  if (
    !present(ledger.githubEnvironment.state) &&
    ledger.githubEnvironment.state !== "created_candidate"
  )
    return "github_environment";
  if (ledger.commit.workflowFiles.length === 0) return "workflow_commit";
  return "verification";
}

const SETUP_IDENTITY_RESUME_STEPS = Object.freeze([
  "azure_app",
  "service_principal",
  "federated_credentials",
  "role_assignments"
]);

export type SetupContinuationPlan = {
  resumeFrom: string;
  stage: string;
  runIdentity: boolean;
  runEnvironment: boolean;
};

/**
 * Turn a resume point into the work a continuation must actually redo.
 *
 * Retry used to ignore the resume point entirely and re-run the whole route,
 * which both repeated finished Azure mutations and left the record parked on the
 * stage the failure ended in — and that stale stage is what the continuation
 * guard rejected. The plan names one stage and the two route calls it still
 * needs, so the guard sees a record positioned where the work resumes.
 */
export function planSetupContinuation(
  op: any,
  resumeFrom: any
): SetupContinuationPlan {
  const step =
    SETUP_RESUME_STEPS.includes(String(resumeFrom || "")) ?
      String(resumeFrom)
    : SETUP_RESUME_STEPS[0];
  const stages = Array.isArray(op?.stages) ? op.stages : [];
  const hasIdentityStage = stages.some(
    (stage: any) => stage?.id === STAGE_AUTHORIZE_IDENTITY
  );
  // A repository that already had credentials never ran the identity stage, so
  // there is no identity work to resume even when the ledger has no App
  // Registration of its own.
  const runIdentity =
    hasIdentityStage && SETUP_IDENTITY_RESUME_STEPS.includes(step);
  // Only verification can be resumed without re-entering the environment route,
  // and only when the record still names the run to watch. Otherwise the
  // environment route is what installs the workflow and dispatches the run.
  const monitorOnly = step === "verification" && hasVerificationRunToWatch(op);
  const stage =
    runIdentity ? STAGE_AUTHORIZE_IDENTITY
    : monitorOnly ? STAGE_VERIFY
    : STAGE_CONFIGURE_ENVIRONMENT;
  return {
    resumeFrom: step,
    stage,
    runIdentity,
    runEnvironment: !monitorOnly
  };
}

function hasVerificationRunToWatch(op: any): boolean {
  const verification = op?.verification;
  return Boolean(
    verification &&
    Number(verification.dispatchedAt) > 0 &&
    typeof verification.workflow === "string" &&
    verification.workflow &&
    typeof verification.ref === "string" &&
    verification.ref
  );
}

/**
 * Position a reopened setup at the stage its resume point belongs to.
 *
 * Stages before the resume point are settled, the resume stage is entered fresh,
 * and everything after it goes back to pending — otherwise the checklist would
 * still show the failure verdict of a stage the retry is about to redo.
 */
export function applySetupResumePoint(
  op: any,
  resumeFrom: any
): SetupContinuationPlan {
  const plan = planSetupContinuation(op, resumeFrom);
  if (!op) return plan;
  const stages = Array.isArray(op.stages) ? op.stages : [];
  const found = stages.findIndex((stage: any) => stage?.id === plan.stage);
  const index = found >= 0 ? found : 0;
  stages.forEach((stage: any, position: number) => {
    if (position < index) stage.state = "succeeded";
    else stage.state = "pending";
  });
  const target = stages[index]?.id ?? null;
  if (target) enterStage(op, target);
  op.resumeFrom = plan.resumeFrom;
  return { ...plan, stage: target || plan.stage };
}

/**
 * The forward command a terminal record is actually offering.
 *
 * "Continue" and "Retry" describe different customer situations, so the label
 * is decided from the saved record rather than from the word `retry` in the
 * route: a deliberate stop is continued, and only a continuation that started
 * and then failed is retried. A failed rollback leaves the forward path on its
 * first attempt, so it stays a continuation.
 */
export function setupForwardIntent(op: any): "continue" | "retry" | null {
  if (!op || !isTerminalState(op.state)) return null;
  if (op.state === "cancelled") return "continue";
  if (op.state !== "failed_partial" && op.state !== "failed") return null;
  const command = latestCommand(op);
  // The customer's most recent command owns the failure in front of them. After
  // a rollback attempt the forward path has still never been tried.
  if (command && CLEANUP_COMMAND_KINDS.includes(command.kind))
    return "continue";
  if (op.state === "failed") return null;
  return "retry";
}

/**
 * Whether a stopped or partially failed setup may move forward at all.
 *
 * Shared by `canContinueSetup` and `canRetrySetup` so the two labels cannot
 * disagree about safety — only about which sentence the customer is reading.
 */
function setupForwardEligibility(
  op: any,
  {
    intent,
    prefix,
    notAvailableCode
  }: {
    intent: "continue" | "retry";
    prefix: "setup-continue" | "setup-retry";
    notAvailableCode: string;
  }
): any {
  if (!op) return { ok: false, code: "unknown-operation" };
  if (!isTerminalState(op.state))
    return { ok: false, code: "operation-active" };
  if (setupForwardIntent(op) !== intent)
    return { ok: false, code: notAvailableCode };
  const request = op.resumeRequest || op.request;
  if (!request || !request.environment)
    return { ok: false, code: `${prefix}-request-missing` };
  const ledger = getSetupArtifactLedger(op);
  const ambiguous = ambiguousSetupOwnership(ledger);
  if (ambiguous)
    return {
      ok: false,
      code: `${prefix}-ownership-ambiguous`,
      detail: ambiguous
    };
  // A completed rollback removed everything this attempt created on purpose.
  // Offering to walk forward from an emptied ledger would quietly rebuild the
  // resources the customer just asked Radius to remove.
  if (intent === "continue" && rollbackRemovedEverything(op))
    return { ok: false, code: "setup-continue-rolled-back" };
  return {
    ok: true,
    code: `${prefix}-allowed`,
    resumeFrom: nextIncompleteSetupStep(op)
  };
}

/** The first forward action after a deliberate stop or a failed rollback. */
export function canContinueSetup(op: any): any {
  return setupForwardEligibility(op, {
    intent: "continue",
    prefix: "setup-continue",
    notAvailableCode: "setup-continue-not-available"
  });
}

/** The forward action after a continuation attempt failed, or setup was cut off. */
export function canRetrySetup(op: any): any {
  return setupForwardEligibility(op, {
    intent: "retry",
    prefix: "setup-retry",
    // The pre-split refusal code, kept so the existing route message and the
    // panel copy that quotes it do not have to change meaning.
    notAvailableCode: "setup-retry-not-retryable"
  });
}

// ─── Rollback eligibility ────────────────────────────────────────────────────
// Stop and rollback are two decisions, not one. Stop ends the attempt; rollback
// is the separate, confirmed request to remove what the attempt created. The
// selection below is the whole safety boundary: only resources the ledger
// proves this attempt created, only before the workflow commit point, never a
// reused resource and never one identified by display name alone.

/** The order deletions must run in so nothing is removed before its dependents. */
const ROLLBACK_ARTIFACT_ORDER: readonly SetupCleanupArtifactType[] =
  Object.freeze([
    "github_environment",
    "role_assignment",
    "federated_credential",
    "service_principal",
    "azure_app"
  ]);

export type RollbackTarget = {
  artifactType: SetupCleanupArtifactType;
  target: string;
  identity: string | null;
  key: string;
};

function rollbackTarget(
  artifactType: SetupCleanupArtifactType,
  artifact: any,
  target: string
): RollbackTarget {
  const identity = cleanupArtifactIdentity(artifactType, artifact);
  return {
    artifactType,
    target,
    identity: identity || null,
    key: cleanupTargetKey({ artifactType, identity, target })
  };
}

/**
 * Every proven-owned pre-commit artifact the ledger still claims, in the order
 * a rollback must delete them.
 *
 * `created_candidate` is deliberately absent: GitHub's idempotent PUT cannot
 * prove this request created that environment, so it stays a manual action.
 */
export function provenOwnedCleanupTargets(op: any): RollbackTarget[] {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger || hasReachedSetupCommitPoint(op)) return [];
  const targets: RollbackTarget[] = [];
  if (ledger.githubEnvironment.state === "created") {
    targets.push(
      rollbackTarget(
        "github_environment",
        ledger.githubEnvironment,
        formatGitHubEnvironmentLabel(ledger.githubEnvironment)
      )
    );
  }
  for (const entry of [...ledger.roleAssignments].reverse()) {
    targets.push(
      rollbackTarget(
        "role_assignment",
        entry,
        `${String(entry.role || "")} @ ${String(entry.scope || "")}`
      )
    );
  }
  for (const entry of [...ledger.federatedCredentials].reverse()) {
    targets.push(
      rollbackTarget(
        "federated_credential",
        entry,
        `${String(entry.name || "")} @ ${String(entry.subject || "")}`
      )
    );
  }
  if (ledger.servicePrincipal.state === "created") {
    targets.push(
      rollbackTarget(
        "service_principal",
        ledger.servicePrincipal,
        formatServicePrincipalLabel(ledger.servicePrincipal, ledger)
      )
    );
  }
  if (ledger.azureApp.state === "created") {
    targets.push(
      rollbackTarget(
        "azure_app",
        ledger.azureApp,
        formatAzureAppLabel(ledger.azureApp)
      )
    );
  }
  return targets.sort(
    (a, b) =>
      ROLLBACK_ARTIFACT_ORDER.indexOf(a.artifactType) -
      ROLLBACK_ARTIFACT_ORDER.indexOf(b.artifactType)
  );
}

/**
 * Whether a *completed* cleanup attempt has already run against this operation.
 *
 * A cleanup left in `running` on a terminal record was interrupted — the
 * process went away mid-rollback — and nothing owns it: the cleanup retry only
 * accepts a finished attempt that ended with warnings. Counting it as attempted
 * would leave the customer with created resources and no path to remove them,
 * so it is reported as not attempted and the first rollback is offered again.
 * That is safe because the deletion set is re-derived from the ledger, and
 * anything the interrupted attempt proved gone is no longer in it.
 */
function hasAttemptedCleanup(op: any): boolean {
  const cleanup = getSetupArtifactLedger(op)?.cleanup || {};
  if (cleanup.state === "running") return false;
  return (
    Number(cleanup.attempts || 0) > 0 ||
    (Array.isArray(cleanup.results) && cleanup.results.length > 0) ||
    cleanup.state === "succeeded" ||
    cleanup.state === "succeeded_with_warnings"
  );
}

function rollbackRemovedEverything(op: any): boolean {
  return hasAttemptedCleanup(op) && provenOwnedCleanupTargets(op).length === 0;
}

/**
 * A stable identity for the exact set of artifacts one rollback will remove.
 *
 * Derived from saved artifact keys alone, so a duplicate click, a lost
 * response, a reload, and an extension restart all rebuild the same command id
 * instead of scheduling a second cleanup.
 */
export function rollbackArtifactIdentity(targets: RollbackTarget[]): string {
  const keys = targets.map((entry) => entry.key).sort();
  if (keys.length === 0) return "cleanup";
  const digest = createHash("sha256")
    .update(keys.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `cleanup#${digest}`;
}

export function canStartRollback(op: any): any {
  if (!op) return { ok: false, code: "unknown-operation" };
  if (!isTerminalState(op.state))
    return { ok: false, code: "operation-active" };
  // A rollback answers a stopped or partially failed attempt. A succeeded or
  // action_required record describes resources the customer is relying on.
  if (
    op.state !== "cancelled" &&
    op.state !== "failed_partial" &&
    op.state !== "failed"
  )
    return { ok: false, code: "rollback-not-available" };
  if (hasReachedSetupCommitPoint(op))
    return { ok: false, code: "rollback-after-commit" };
  if (hasAttemptedCleanup(op))
    return { ok: false, code: "rollback-already-attempted" };
  // A record with no ledger proves nothing, so it selects nothing and refuses
  // here rather than needing a guard of its own.
  const targets = provenOwnedCleanupTargets(op);
  if (targets.length === 0)
    return { ok: false, code: "rollback-nothing-owned" };
  return {
    ok: true,
    code: "rollback-allowed",
    targets,
    target: rollbackArtifactIdentity(targets)
  };
}

function isProvenOwnedCleanupTarget(ledger: any, result: any): boolean {
  switch (result.artifactType) {
    case "azure_app":
      return ledger.azureApp.state === "created";
    case "service_principal":
      return ledger.servicePrincipal.state === "created";
    case "federated_credential":
      return ledger.federatedCredentials.length > 0;
    case "role_assignment":
      return ledger.roleAssignments.length > 0;
    case "github_environment":
      return ledger.githubEnvironment.state === "created";
    default:
      return false;
  }
}

/**
 * Resources from the latest cleanup attempt that Radius proved it created and
 * still could not remove. A `skipped` result is deliberately excluded: Radius
 * could not identify that target, so retrying it would be a guess.
 *
 * Each entry carries the stable key the retry needs to act on exactly this
 * resource rather than re-deriving a deletion set from the ledger.
 */
export function unresolvedCleanupTargets(op: any): any[] {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return [];
  return cleanupAttemptResults(ledger)
    .filter((entry: any) => entry.outcome === "warning")
    .filter((entry: any) => isProvenOwnedCleanupTarget(ledger, entry))
    .map((entry: any) => ({
      artifactType: entry.artifactType,
      target: String(entry.target || ""),
      identity:
        entry.identity == null || entry.identity === "" ?
          null
        : String(entry.identity),
      key: cleanupTargetKey(entry),
      detail:
        entry.detail == null || entry.detail === "" ?
          null
        : String(entry.detail)
    }));
}

export function canRetryCleanup(op: any): any {
  if (!op) return { ok: false, code: "unknown-operation" };
  if (!isTerminalState(op.state))
    return { ok: false, code: "operation-active" };
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return { ok: false, code: "cleanup-retry-ledger-missing" };
  if (hasReachedSetupCommitPoint(op))
    return { ok: false, code: "cleanup-retry-after-commit" };
  if (ledger.cleanup.state !== "succeeded_with_warnings")
    return { ok: false, code: "cleanup-retry-not-retryable" };
  const targets = unresolvedCleanupTargets(op);
  if (targets.length === 0)
    return { ok: false, code: "cleanup-retry-nothing-unresolved" };
  return { ok: true, code: "cleanup-retry-allowed", targets };
}

// ─── Action projection ───────────────────────────────────────────────────────
// The server decides what a customer may do; the page renders that list. Copying
// eligibility rules into browser code is how the two surfaces drift apart, and a
// Retry button that the server then refuses is worse than no button at all.

// One sentence per classification, so a new retryable failure code cannot ship
// with a description written for a different cause.
const VERIFICATION_RETRY_DESCRIPTIONS: Record<string, string> = {
  "workflow-installation-pending":
    "Merge the setup pull request first. Radius then checks the installed workflows again.",
  "azure-rbac-propagation":
    "Azure role assignments can take a few minutes to propagate. Radius checks the same workflow run identity again.",
  "verification-tracking-expired":
    "Radius stopped following the previous verification run. It starts the same workflow again on the same branch.",
  "verification-dispatch-failed":
    "GitHub refused the request that starts the verification workflow, so nothing ran. Radius asks GitHub to start the same workflow again."
};

const SETUP_STEP_LABELS: Record<string, string> = {
  azure_app: "Create the App Registration",
  service_principal: "Create the Service Principal",
  federated_credentials: "Add the federated credentials",
  role_assignments: "Grant the Azure role assignments",
  github_environment: "Configure the GitHub environment",
  workflow_commit: "Commit the deploy workflows",
  verification: "Verify the credentials"
};

/** The customer-facing name of a resume point. */
export function setupStepLabel(step: any): string {
  return SETUP_STEP_LABELS[String(step || "")] || "the next setup step";
}

/**
 * What a continuation would reuse, and where it would start.
 *
 * Built here rather than in the browser so the sentence beside **Continue
 * setup** comes from the same ledger the continuation will actually walk.
 */
function projectContinuationPreview(op: any, resumeFrom: any): any {
  const ledger = getSetupArtifactLedger(op);
  const reuses: Array<{ kind: string; target: string }> = [];
  if (ledger) {
    const present = (state: any) => state === "created" || state === "reused";
    if (present(ledger.azureApp.state))
      reuses.push({
        kind: "azure_app",
        target: formatAzureAppLabel(ledger.azureApp)
      });
    if (present(ledger.servicePrincipal.state))
      reuses.push({
        kind: "service_principal",
        target: formatServicePrincipalLabel(ledger.servicePrincipal, ledger)
      });
    ledger.federatedCredentials.forEach((entry: any) => {
      reuses.push({
        kind: "federated_credential",
        target: `${String(entry.name || "")} @ ${String(entry.subject || "")}`
      });
    });
    ledger.roleAssignments.forEach((entry: any) => {
      reuses.push({
        kind: "role_assignment",
        target: `${String(entry.role || "")} @ ${String(entry.scope || "")}`
      });
    });
    if (present(ledger.githubEnvironment.state))
      reuses.push({
        kind: "github_environment",
        target: formatGitHubEnvironmentLabel(ledger.githubEnvironment)
      });
  }
  return {
    resumeFrom: String(resumeFrom || ""),
    resumeLabel: setupStepLabel(resumeFrom),
    reuses
  };
}

/**
 * What a rollback will remove, keep, and leave for the customer.
 *
 * The confirmation dialog renders this projection verbatim. Rebuilding it in
 * the browser from the inventory groups would let the dialog promise a deletion
 * the server would then refuse to perform.
 */
function projectRollbackPreview(op: any, targets: RollbackTarget[]): any {
  const summary = projectCleanupSummary(op) || {};
  const removes = targets.map((entry) => ({
    kind: entry.artifactType,
    target: entry.target
  }));
  const removeKeys = new Set(
    removes.map((entry) => `${entry.kind}#${entry.target}`)
  );
  const keeps = [
    ...(summary.reused || []).map((entry: any) => ({
      kind: entry.kind,
      target: entry.target,
      reason: "reused"
    })),
    ...(summary.retainedArtifacts || [])
      .filter((entry: any) => !removeKeys.has(`${entry.kind}#${entry.target}`))
      .map((entry: any) => ({
        kind: entry.kind,
        target: entry.target,
        reason: "retained"
      }))
  ];
  return {
    removes,
    keeps,
    manualActionRequired: (summary.manualActionRequired || []).map(
      (entry: any) => ({
        kind: entry.kind,
        target: entry.target,
        action: entry.action
      })
    )
  };
}

/**
 * Why a path the customer might expect is not on offer.
 *
 * Silence reads as a bug. Every refusal that a customer can reasonably reach
 * gets one sentence naming the constraint that produced it.
 */
const ROLLBACK_UNAVAILABLE_MESSAGES: Record<string, string> = {
  "rollback-nothing-owned":
    "Radius did not create any resources in this attempt, so there is nothing to roll back.",
  "rollback-after-commit":
    "Setup committed workflow files, so Radius retained the environment resources instead of removing them.",
  "rollback-already-attempted":
    "Radius already ran a rollback for this attempt. Anything still listed needs the retry above or a manual removal."
};

const CONTINUE_UNAVAILABLE_MESSAGES: Record<string, string> = {
  "setup-continue-request-missing":
    "Radius no longer holds the environment details needed to continue this setup.",
  "setup-continue-ownership-ambiguous":
    "Radius cannot prove ownership of a remaining resource, so continuing could duplicate it. Remove it manually if needed.",
  "setup-continue-rolled-back":
    "Radius rolled back what this attempt created. Start a new environment setup when you are ready."
};

export function projectActionGuidance(op: any): any[] {
  if (!op || !isTerminalState(op.state)) return [];
  const notes: Array<{ code: string; message: string }> = [];
  const rollback = canStartRollback(op);
  const forward = canContinueSetup(op).ok || canRetrySetup(op).ok;
  if (!rollback.ok && ROLLBACK_UNAVAILABLE_MESSAGES[rollback.code]) {
    notes.push({
      code: rollback.code,
      message: ROLLBACK_UNAVAILABLE_MESSAGES[rollback.code]
    });
  }
  if (!forward) {
    const continuation = canContinueSetup(op);
    if (CONTINUE_UNAVAILABLE_MESSAGES[continuation.code]) {
      notes.push({
        code: continuation.code,
        message: CONTINUE_UNAVAILABLE_MESSAGES[continuation.code]
      });
    }
  }
  return notes;
}

/**
 * The heading and supporting sentence for a state that needs its own screen.
 *
 * A stopped setup is neither a success nor a failure, and a rollback that left
 * something behind is not a failed setup. Each gets the heading that describes
 * what actually happened, projected here so the panel never has to infer it.
 */
export function projectOperationHeadline(op: any): any {
  if (!op) return null;
  const activeCleanup = activeCommandKind(op);
  if (!isTerminalState(op.state)) {
    if (activeCleanup === "rollback" || activeCleanup === "retry_cleanup") {
      return {
        code: "rolling-back",
        title: "Rolling back created resources…",
        message:
          "Radius is removing the resources it proved it created during this attempt."
      };
    }
    if (activeCleanup === "continue_setup") {
      return {
        code: "continuing",
        title: "Continuing setup…",
        message: `Radius resumed from ${setupStepLabel(op.resumeFrom)} and is reusing the resources it already recorded.`
      };
    }
    if (activeCleanup === "retry_setup") {
      return {
        code: "retrying-setup",
        title: "Retrying setup…",
        message: `Radius restarted from ${setupStepLabel(op.resumeFrom)} and is reusing the resources it already recorded.`
      };
    }
    return null;
  }
  const lastCommand = latestCommand(op);
  const cleanupCommand =
    lastCommand && CLEANUP_COMMAND_KINDS.includes(lastCommand.kind);
  if (op.state === "cancelled") {
    if (cleanupCommand) {
      return {
        code: "rollback-complete",
        title: "Rollback complete",
        message:
          "Radius removed the resources it created during this attempt. Anything it reused was left alone."
      };
    }
    return {
      code: "stopped",
      title: "Environment setup stopped",
      message:
        "Radius stopped before the next setup step. Review what exists, then roll it back or continue setup."
    };
  }
  if (op.state === "failed_partial" && cleanupCommand) {
    return {
      code: "rollback-incomplete",
      title: "Rollback finished with items still present",
      message:
        "Radius removed what it could. The resources below are still present and need another attempt or a manual removal."
    };
  }
  if (
    (op.state === "failed_partial" || op.state === "failed") &&
    lastCommand &&
    FORWARD_COMMAND_KINDS.includes(lastCommand.kind)
  ) {
    return {
      code: "continue-failed",
      title: "Setup could not continue",
      message: `Radius stopped at ${setupStepLabel(op.resumeFrom)}. Review what exists, then retry setup or roll back what this attempt created.`
    };
  }
  return null;
}

export function projectOperationActions(op: any): any[] {
  if (!op) return [];
  const base = `/api/operations/${encodeURIComponent(op.operationId)}`;
  const control = op.control || createOperationControl();
  if (!isTerminalState(op.state)) {
    // A confirmed rollback is one cooperative server-owned command: cleanup has
    // no pause control, so offering Stop mid-deletion would promise a boundary
    // that does not exist.
    const active = activeCommandKind(op);
    if (active === "rollback" || active === "retry_cleanup") return [];
    const waitingForInput = op.state === INPUT_REQUIRED_STATE;
    return [
      {
        id: "stop",
        kind: "stop",
        label: "Stop setup",
        tone: "neutral",
        requiresConfirmation: false,
        description:
          waitingForInput ?
            "Radius is waiting for your answer, so it stops immediately."
          : "Radius will finish the current Azure or GitHub step, record what changed, and stop before the next step.",
        method: "POST",
        path: `${base}/stop`,
        pending: Boolean(control.stop.requestedAt)
      }
    ];
  }
  const actions: any[] = [];
  const verification = canRetryVerification(op);
  if (verification.ok) {
    actions.push({
      id: "retry-verification",
      kind: "retry_verification",
      label: "Retry verification",
      tone: "primary",
      requiresConfirmation: false,
      description: VERIFICATION_RETRY_DESCRIPTIONS[verification.classification],
      method: "POST",
      path: `${base}/retry/verification`,
      pending: false,
      classification: verification.classification,
      requiresMergedPullRequest: verification.requiresMergedPullRequest,
      pullRequestUrl: verification.pullRequestUrl
    });
  }
  // Forward first, destructive second, and neither is a default: the customer
  // decides whether to finish creating the environment or abandon it.
  const continuation = canContinueSetup(op);
  if (continuation.ok) {
    actions.push({
      id: "continue-setup",
      kind: "continue_setup",
      label: "Continue setup",
      tone: "primary",
      requiresConfirmation: false,
      description: `Radius continues from ${setupStepLabel(
        continuation.resumeFrom
      )} and reuses the resources it already recorded.`,
      method: "POST",
      path: `${base}/continue`,
      pending: false,
      resumeFrom: continuation.resumeFrom,
      preview: projectContinuationPreview(op, continuation.resumeFrom)
    });
  }
  const setup = canRetrySetup(op);
  if (setup.ok) {
    actions.push({
      id: "retry-setup",
      kind: "retry_setup",
      label: "Retry setup",
      tone: "primary",
      requiresConfirmation: false,
      description: `The last attempt stopped at ${setupStepLabel(
        op.resumeFrom || setup.resumeFrom
      )}. Radius reuses the resources it already recorded and starts again from ${setupStepLabel(
        setup.resumeFrom
      )}.`,
      method: "POST",
      path: `${base}/retry/setup`,
      pending: false,
      resumeFrom: setup.resumeFrom,
      preview: projectContinuationPreview(op, setup.resumeFrom)
    });
  }
  const rollback = canStartRollback(op);
  if (rollback.ok) {
    actions.push({
      id: "rollback",
      kind: "rollback",
      label: "Roll back created resources",
      tone: "danger",
      requiresConfirmation: true,
      confirmTitle: "Roll back resources created by this setup?",
      confirmLabel: "Roll back resources",
      cancelLabel: "Keep resources",
      description:
        "Radius removes only the resources it proved it created before the workflows were committed. This cannot be undone.",
      method: "POST",
      path: `${base}/rollback`,
      pending: false,
      preview: projectRollbackPreview(op, rollback.targets)
    });
  }
  const cleanup = canRetryCleanup(op);
  if (cleanup.ok) {
    actions.push({
      id: "retry-cleanup",
      kind: "retry_cleanup",
      label: "Retry rollback",
      tone: "danger",
      requiresConfirmation: true,
      confirmTitle: "Retry the rollback for the resources still present?",
      confirmLabel: "Retry rollback",
      cancelLabel: "Keep resources",
      description:
        "Radius removes only the resources it proved it created and could not delete on the last attempt.",
      method: "POST",
      path: `${base}/retry/cleanup`,
      pending: false,
      preview: {
        removes: cleanup.targets.map((entry: any) => ({
          kind: entry.artifactType,
          target: entry.target
        })),
        keeps: projectRollbackPreview(op, []).keeps,
        manualActionRequired: projectRollbackPreview(op, [])
          .manualActionRequired
      }
    });
  }
  return actions;
}

/**
 * The automatic transition a non-terminal view is waiting on.
 *
 * Every non-terminal state must either name what happens next or offer an
 * action, so no view can leave a customer watching a spinner with nothing to do.
 */
export function projectNextTransition(op: any): any {
  if (!op || isTerminalState(op.state)) return null;
  const active = activeCommandKind(op);
  // Cleanup owns the record while it runs, and it is the one activity with no
  // action of its own — so it has to name itself or the panel would be silent.
  if (active === "rollback") {
    return {
      code: "rolling-back",
      message: "Rolling back created resources…"
    };
  }
  if (active === "retry_cleanup") {
    return {
      code: "retrying-rollback",
      message: "Retrying the rollback for the resources still present…"
    };
  }
  if (isStopPending(op)) {
    return {
      code: "stopping",
      message: "Stopping after the current step…"
    };
  }
  if (op.state === INPUT_REQUIRED_STATE) {
    return {
      code: "awaiting-input",
      message: "Radius is waiting for your answer before it continues."
    };
  }
  if (active === "continue_setup") {
    return {
      code: "continuing-setup",
      message: `Continuing setup from ${setupStepLabel(op.resumeFrom)}…`
    };
  }
  if (active === "retry_setup") {
    return {
      code: "retrying-setup",
      message: `Retrying setup from ${setupStepLabel(op.resumeFrom)}…`
    };
  }
  if (op.currentStage === STAGE_VERIFY && op.verification?.dispatchedAt) {
    return {
      code: "monitoring-verification",
      message:
        "Radius is following the credential verification run and will report its result here."
    };
  }
  return {
    code: "running",
    message: "Radius is running the next environment setup step."
  };
}

// The announced tier of the notification model.
//
// Reaching a terminal state is the one moment worth telling the user about
// outside our own pages, and `finish` is the only place every terminal state
// passes through — which is why the hook lives here rather than at the six call
// sites in the routes, where it would eventually be forgotten at a seventh.
//
// The listener is injected rather than imported so this module keeps no
// dependency on the host session, and so tests can observe the transition
// without one. It is best-effort by construction: a throw from the listener
// must never turn a completed operation into a failed request.
let terminalListener = null;

/**
 * Register the single listener notified when an operation reaches a terminal
 * state. Passing `null` clears it.
 */
export function onOperationTerminal(fn: any): void {
  terminalListener = typeof fn === "function" ? fn : null;
}

function announceTerminal(op) {
  if (!terminalListener) return;
  try {
    const attempted = terminalListener(op);
    if (attempted !== false) op.journey.notifiedAt = nowIso();
  } catch {
    // Announcing is a courtesy. Losing it is not worth losing the operation.
  }
}

/**
 * Announce a terminal record whose announcement was deferred until it was safe.
 *
 * A route that must save the outcome before anyone hears about it finishes with
 * `announce: false` and calls this once the write succeeded. Announcing twice is
 * impossible: the record carries the timestamp of the announcement it already
 * made.
 */
export function announceOperationTerminal(op: any): boolean {
  if (!op || !isTerminalState(op.state)) return false;
  if (op.journey?.notifiedAt) return false;
  announceTerminal(op);
  return true;
}

/** Finish the operation in an explicit terminal state. */
export function finish(
  op: any,
  state: any,
  { terminal = null, failure = null, announce = true }: any = {}
): any {
  if (!op) return op;
  if (!isTerminalState(state))
    throw new Error(`Unknown terminal state "${state}"`);
  // Terminal states are latched. A route that fails twice on the way out --
  // say a throw inside a catch that already closed the record -- must not
  // announce twice or overwrite the first, more specific, verdict.
  if (isTerminalState(op.state)) return op;
  op.state = state;
  op.endedAt = nowIso();
  if (terminal) op.terminal = terminal;
  if (failure) op.failure = failure;
  for (const stage of op.stages) {
    if (stage.state === "pending") {
      // Never entered, so genuinely skipped whatever the outcome.
      stage.state = "skipped";
    } else if (stage.state === "running") {
      // The stage that was in flight when the operation ended. It must not
      // be left running -- a terminal record showing a spinner is the
      // defect this whole design exists to remove -- but "skipped" would
      // deny work that actually happened. On the pull-request path the
      // environment really is configured; only the merge is outstanding.
      //
      // A route that knows better calls setStageState first, and that
      // verdict survives because only running/pending are touched here.
      stage.state =
        state === "failed" || state === "failed_partial" ?
          "failed"
        : "succeeded";
    }
  }
  const ledger = getSetupArtifactLedger(op);
  if (ledger && ledger.cleanup.state === "not_started") {
    ledger.cleanup.state =
      state === "failed" || state === "failed_partial" ?
        hasTrackedSetupArtifacts(ledger) ? "pending"
        : "not_needed"
      : "not_needed";
  }
  // A terminal record has nothing in flight. The runner that owns a command
  // usually closes it with its own outcome first; a forward continuation ends
  // through the setup executor instead, so the outcome closes it here. Leaving
  // one marked running would let a later duplicate check mistake a finished
  // attempt for work in progress and silently swallow the customer's click.
  const control = getOperationControl(op);
  for (const command of control?.commands ?? []) {
    if (command.state !== "accepted" && command.state !== "running") continue;
    command.state = "finished";
    command.completedAt = nowIso();
    if (command.outcome == null) command.outcome = state;
  }
  if (announce) announceTerminal(op);
  return op;
}

/**
 * Choose between `succeeded` and `succeeded_with_warnings`.
 *
 * A warning that survives to the end of a successful run is the whole reason
 * the second state exists, so this is derived rather than left to each call
 * site to remember.
 */
export function finishSucceeded(op: any, terminal?: any): any {
  const hasWarning = op && op.steps.some((s) => s.state === "warning");
  return finish(op, hasWarning ? "succeeded_with_warnings" : "succeeded", {
    terminal
  });
}

/** True when any step recorded a warning. */
export function hasWarnings(op: any): boolean {
  return !!(op && op.steps.some((s) => s.state === "warning"));
}

/**
 * Cooperative stop. The loop checks this between mutations; it never aborts one.
 *
 * The request is written to the durable control record before any caller is told
 * it was accepted, so a Canvas reload or an extension restart cannot lose the
 * customer's command.
 */
export function requestStop(op: any): boolean {
  if (!op) return false;
  if (isTerminalState(op.state)) return false;
  const control = getOperationControl(op);
  if (!control.stop.requestedAt) {
    control.stop.requestedAt = nowIso();
    op.lastActivityAt = control.stop.requestedAt;
  }
  op.stopRequested = true;
  return true;
}

export function shouldStop(op: any): boolean {
  if (!op || isTerminalState(op.state)) return false;
  return !!(op.stopRequested || op.control?.stop?.requestedAt);
}

/** Whether a stop is recorded but not yet honored at a boundary. */
export function isStopPending(op: any): boolean {
  return shouldStop(op) && !op?.control?.stop?.acknowledgedAt;
}

/**
 * Honor a recorded stop at a named safe boundary.
 *
 * Called only after the current remote mutation finished and its provenance was
 * saved, which is what keeps Stop from ever leaving a half-written resource.
 */
export function stopAtBoundary(
  op: any,
  boundary: any,
  { announce = true }: any = {}
): any {
  if (!op || isTerminalState(op.state)) return op;
  const control = getOperationControl(op);
  const at = nowIso();
  if (!control.stop.requestedAt) control.stop.requestedAt = at;
  control.stop.acknowledgedAt = at;
  control.stop.boundary = String(boundary || "unknown");
  recordAttemptOutcome(op, {
    kind: "setup",
    state: "cancelled",
    code: "operation-stopped"
  });
  return finish(op, "cancelled", {
    announce,
    terminal: {
      reason: "stopped-at-boundary",
      boundary: control.stop.boundary,
      userMessage:
        "Radius finished the step that was already running, recorded what changed, and stopped before the next one."
    }
  });
}

export type StopRequestOutcome =
  | "cancelled"
  | "pending"
  | "already_requested"
  | "already_stopped"
  | "terminal";

/**
 * Apply a customer stop request to the saved record.
 *
 * An operation parked on a prompt has no mutation in flight, so it cancels at
 * once. Anything else records the request and lets the executor stop at its next
 * safe boundary.
 *
 * `announce` is false when the caller must save the record before anyone hears
 * about it. Announcing a cancellation that a failed write then rolls back tells
 * the customer their setup ended when it did not, which is the one lie this
 * whole model exists to prevent — so the caller announces with
 * `announceOperationTerminal` only after the write succeeded.
 */
export function applyStopRequest(
  op: any,
  { announce = true }: { announce?: boolean } = {}
): {
  outcome: StopRequestOutcome;
  duplicate: boolean;
} {
  if (!op) return { outcome: "terminal", duplicate: false };
  const control = getOperationControl(op);
  const duplicate = Boolean(control.stop.requestedAt);
  if (isTerminalState(op.state)) {
    return {
      outcome:
        op.state === "cancelled" && duplicate ? "already_stopped" : "terminal",
      duplicate
    };
  }
  if (op.state === INPUT_REQUIRED_STATE && !op.executionActive) {
    requestStop(op);
    stopAtBoundary(op, "input_prompt", { announce });
    return { outcome: "cancelled", duplicate };
  }
  requestStop(op);
  return { outcome: duplicate ? "already_requested" : "pending", duplicate };
}

// ─── Commands and idempotency ────────────────────────────────────────────────
// The command id is the idempotency identity, and it is built from facts that
// are already saved: the operation id, the command kind, the attempt number, and
// the logical target. No timestamp and no random value, so a restarted executor
// rebuilds exactly the same id and a repeated mutation is recognisable as the
// same one.

export function operationCommandKey({
  operationId,
  kind,
  attempt,
  target = "operation"
}: {
  operationId: string;
  kind: string;
  attempt: number;
  target?: string;
}): string {
  return `${String(operationId || "")}:${String(kind || "")}:${positiveInt(
    attempt,
    0
  )}:${String(target || "operation")}`;
}

export function buildCommandId(input: any): string {
  return operationCommandKey(input);
}

export function findCommand(op: any, commandId: any): any {
  const control = op?.control;
  if (!control || !commandId) return null;
  return (
    control.commands.find((entry: any) => entry.commandId === commandId) || null
  );
}

export function latestCommand(op: any): any {
  const commands = op?.control?.commands;
  if (!Array.isArray(commands) || commands.length === 0) return null;
  return commands[commands.length - 1];
}

/**
 * The command Radius is still working on, if any.
 *
 * A duplicate submission resolves to this record rather than starting a second
 * one, and the panel reads it to name the activity that owns the operation. A
 * terminal record is working on nothing by definition: a command persisted as
 * `running` by a process that then went away must never absorb the customer's
 * next click.
 */
export function findActiveCommand(op: any, kinds?: readonly string[]): any {
  const commands = op?.control?.commands;
  if (!Array.isArray(commands) || isTerminalState(op?.state)) return null;
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = commands[index];
    if (command.state !== "accepted" && command.state !== "running") continue;
    if (kinds && !kinds.includes(command.kind)) continue;
    return command;
  }
  return null;
}

/** The kind of the command currently owning a running operation. */
export function activeCommandKind(op: any): string | null {
  const command = findActiveCommand(op);
  return command ? String(command.kind) : null;
}

/**
 * Record a customer command before Radius acts on it.
 *
 * A repeated submission resolves to the saved command rather than a second one:
 * the identity is derived, so a double click, a lost response, or a reload all
 * produce the same command id.
 */
export function acceptCommand(
  op: any,
  {
    kind,
    attempt,
    target = "operation"
  }: { kind: OperationCommandKind; attempt: number; target?: string }
): { ok: boolean; duplicate: boolean; command: any } {
  const control = getOperationControl(op);
  if (!control) return { ok: false, duplicate: false, command: null };
  const commandId = buildCommandId({
    operationId: op.operationId,
    kind,
    attempt,
    target
  });
  const existing = findCommand(op, commandId);
  if (existing) return { ok: false, duplicate: true, command: existing };
  const command = {
    kind,
    commandId,
    attempt: positiveInt(attempt, 0),
    target: String(target || "operation"),
    state: "accepted" as OperationCommandState,
    acceptedAt: nowIso(),
    completedAt: null,
    outcome: null
  };
  control.commands.push(command);
  if (control.commands.length > MAX_RETAINED_COMMANDS) {
    control.commands.splice(0, control.commands.length - MAX_RETAINED_COMMANDS);
  }
  op.lastActivityAt = command.acceptedAt;
  return { ok: true, duplicate: false, command };
}

export function setCommandState(
  op: any,
  commandId: any,
  state: OperationCommandState,
  outcome: any = null
): any {
  const command = findCommand(op, commandId);
  if (!command || !COMMAND_STATES.includes(state)) return null;
  command.state = state;
  if (state === "finished") command.completedAt = nowIso();
  if (outcome != null) command.outcome = String(outcome);
  return command;
}

export function recordAttemptOutcome(
  op: any,
  {
    kind,
    state,
    code = null
  }: { kind: OperationAttemptKind; state: string; code?: string | null }
): any {
  const control = getOperationControl(op);
  if (!control || !ATTEMPT_KINDS.includes(kind)) return null;
  const entry = {
    kind,
    attempt: positiveInt(control.attempts[kind], 0),
    state: String(state || ""),
    code: code == null || code === "" ? null : String(code),
    recordedAt: nowIso()
  };
  control.outcomes.push(entry);
  if (control.outcomes.length > MAX_RETAINED_OUTCOMES) {
    control.outcomes.splice(0, control.outcomes.length - MAX_RETAINED_OUTCOMES);
  }
  return entry;
}

/**
 * Reopen a closed operation for an allowed continuation.
 *
 * The prior verdict is copied into the immutable outcome history before the
 * record moves back to `running`, so an `action_required` result survives the
 * verification retry that follows a merged pull request.
 */
export function beginRetryAttempt(op: any, kind: OperationAttemptKind): number {
  const control = getOperationControl(op);
  if (!control || !ATTEMPT_KINDS.includes(kind)) return 0;
  recordAttemptOutcome(op, {
    kind,
    state: op.state,
    code: op.failure?.code || op.terminal?.reason || null
  });
  control.attempts[kind] = positiveInt(control.attempts[kind], 0) + 1;
  control.stop = { requestedAt: null, acknowledgedAt: null, boundary: null };
  op.stopRequested = false;
  op.state = RUNNING_STATE;
  op.endedAt = null;
  op.failure = null;
  op.terminal = null;
  op.recoveryState = null;
  if (op.journey) op.journey.notifiedAt = null;
  op.lastActivityAt = nowIso();
  return control.attempts[kind];
}

/** Undo `beginRetryAttempt` when the durable save that must follow it failed. */
export function rollbackRetryAttempt(op: any, snapshot: any): any {
  if (!op || !snapshot) return op;
  op.control = structuredClone(snapshot.control);
  op.state = snapshot.state;
  op.endedAt = snapshot.endedAt;
  op.failure = snapshot.failure;
  op.terminal = snapshot.terminal;
  op.recoveryState = snapshot.recoveryState;
  op.stopRequested = snapshot.stopRequested;
  op.stages = structuredClone(snapshot.stages);
  op.currentStage = snapshot.currentStage;
  op.lastActivityAt = snapshot.lastActivityAt;
  op.executionActive = snapshot.executionActive;
  if (snapshot.resumeFrom === undefined) delete op.resumeFrom;
  else op.resumeFrom = snapshot.resumeFrom;
  if (snapshot.inputRequired === undefined) delete op.inputRequired;
  else op.inputRequired = structuredClone(snapshot.inputRequired);
  // `finish` opens cleanup on the way out, so a rolled-back terminal transition
  // has to put the ledger's cleanup record back too or the next projection
  // reports a rollback that never happened.
  if (snapshot.cleanup !== undefined && op.setupArtifacts) {
    op.setupArtifacts.cleanup = structuredClone(snapshot.cleanup);
  }
  if (op.journey) op.journey.notifiedAt = snapshot.notifiedAt;
  return op;
}

export function snapshotRetryState(op: any): any {
  const ledger = op?.setupArtifacts || null;
  return {
    control: structuredClone(getOperationControl(op)),
    state: op.state,
    endedAt: op.endedAt,
    failure: op.failure ? structuredClone(op.failure) : null,
    terminal: op.terminal ? structuredClone(op.terminal) : null,
    recoveryState: op.recoveryState ?? null,
    stopRequested: Boolean(op.stopRequested),
    stages: structuredClone(op.stages || []),
    currentStage: op.currentStage ?? null,
    lastActivityAt: op.lastActivityAt ?? null,
    executionActive: op.executionActive,
    resumeFrom: op.resumeFrom,
    inputRequired: op.inputRequired,
    cleanup: ledger?.cleanup ? structuredClone(ledger.cleanup) : undefined,
    notifiedAt: op.journey?.notifiedAt ?? null
  };
}

/**
 * A one-line summary for the status chip and the completion announcement.
 *
 * Built only from allowlisted structured fields. Nothing here may interpolate
 * command output, because this string is the one that reaches the persisted
 * session timeline.
 */
export function summarize(op: any): string {
  if (!op) return "";
  const env = op.environment || "environment";
  switch (op.state) {
    case RUNNING_STATE: {
      const active = activeCommandKind(op);
      if (active === "rollback" || active === "retry_cleanup")
        return `Rolling back the resources created for ${env}…`;
      if (isStopPending(op))
        return `Stopping ${env} setup after the current step…`;
      const stage = op.stages.find((s) => s.id === op.currentStage);
      return `Creating ${env} — ${
        stage ? stage.label.toLowerCase() : "working"
      }…`;
    }
    case INPUT_REQUIRED_STATE:
      return (
        (op.inputRequired && op.inputRequired.message) ||
        `Creating ${env} needs information from you.`
      );
    case "succeeded":
      return `Environment "${env}" is ready.`;
    case "succeeded_with_warnings": {
      const n = op.steps.filter((s) => s.state === "warning").length;
      return `Environment "${env}" is ready, with ${n} warning${
        n === 1 ? "" : "s"
      }.`;
    }
    case "action_required":
      return (
        (op.terminal && op.terminal.userMessage) ||
        `Environment "${env}" needs one more step from you.`
      );
    case "failed":
      return `Creating environment "${env}" failed.`;
    case "failed_partial":
      return `Creating environment "${env}" failed partway through — some resources exist.`;
    case "cancelled": {
      const command = latestCommand(op);
      if (command && CLEANUP_COMMAND_KINDS.includes(command.kind))
        return `Rolled back the resources created for "${env}".`;
      return `Creating environment "${env}" was stopped.`;
    }
    default:
      return "";
  }
}

/** The log level the tier-2 announcement should use for a terminal state. */
export function announcementLevel(state: any): string {
  if (
    state === "action_required" ||
    state === "succeeded_with_warnings" ||
    state === "failed_partial"
  )
    return "warning";
  if (state === "failed") return "error";
  return "info";
}

/**
 * The options the tier-2 announcement should pass to `session.log`.
 *
 * The host's log RPC accepts `url` ("a URL the user can open in their browser
 * for more details") and `tip` ("an actionable tip displayed alongside the
 * message") in addition to `level`. The SDK's `session.log` wrapper does not
 * name them in its TypeScript signature, but it spreads its options straight
 * into the RPC, so they reach the host. Building the options here rather than
 * at the call site keeps that knowledge in one place and testable.
 *
 * Two constraints from the protocol shape what this can do:
 *
 * `tip` is honored only on `level: "info"`, which is every state except the
 * three that most want actionable advice. So the tip is reserved for a plain
 * success, where it carries the journey nudge — the next thing to do now that
 * the environment exists — and the more urgent states put their instruction in
 * the message itself, where no level gates it.
 *
 * `url` is a browser URL, so only a genuinely external link belongs in it. A
 * pull request qualifies. The in-canvas resume target does not, and is
 * deliberately left to the status chip.
 */
export function announcementOptions(op: any): any {
  const level = announcementLevel(op && op.state);
  const options = { level };
  const url =
    op && op.terminal && typeof op.terminal.pullRequestUrl === "string" ?
      op.terminal.pullRequestUrl.trim()
    : "";
  if (url) options.url = url;
  if (level === "info") {
    const summary = summarize(op);
    const message =
      op && op.terminal && typeof op.terminal.userMessage === "string" ?
        op.terminal.userMessage.trim()
      : "";
    const tip =
      message.startsWith(summary) ?
        message.slice(summary.length).trim()
      : message;
    if (tip) options.tip = tip;
  }
  return options;
}

// ─── Registry ────────────────────────────────────────────────────────────────
// Keyed by repo, because "one setup at a time per repository" is the invariant
// that actually matters — two concurrent runs would race on the same App
// Registration, federated credentials and environment secrets. Records are held
// after they finish so a user who returns later still finds the outcome; this
// is memory-only and therefore does not survive an extension restart, which the
// error-handling table treats as an expected degradation rather than a bug.

const RETAIN_TERMINAL_MS = 60 * 60 * 1000;
const MAX_RETAINED = 20;

// How long a record may go without progress before it stops counting as
// running. A setup spans two POSTs from the client, so the record deliberately
// outlives the first request in order for the second to adopt it — which means
// a user who abandons the flow between them would otherwise leave a record
// running forever, blocking every retry with a 409 and holding the keepalive
// on indefinitely. Longer than the slowest observed leg, short enough that a
// stuck record clears itself.
const STALE_AFTER_MS = 15 * 60 * 1000;
export const INPUT_STALE_AFTER_MS = 60 * 60 * 1000;
export const VERIFY_STALE_AFTER_MS = 45 * 60 * 1000;

export function hasCompleteVerificationIdentity(op: any): boolean {
  const verification = op?.verification;
  return Boolean(
    op?.currentStage === STAGE_VERIFY &&
    Number.isFinite(Number(verification?.dispatchedAt)) &&
    Number(verification.dispatchedAt) > 0 &&
    typeof verification?.workflow === "string" &&
    verification.workflow &&
    typeof verification?.ref === "string" &&
    verification.ref &&
    typeof verification?.environment === "string" &&
    verification.environment
  );
}

/** Whether a non-terminal record has gone quiet long enough to be abandoned. */
export function isStale(op: any, now = Date.now()): boolean {
  if (!op || isTerminalState(op.state)) return false;
  if (op.state === INPUT_REQUIRED_STATE) {
    return (
      now -
        new Date(op.inputRequired?.requestedAt || op.lastActivityAt).getTime() >
      INPUT_STALE_AFTER_MS
    );
  }
  if (hasCompleteVerificationIdentity(op)) {
    return now - Number(op.verification.dispatchedAt) > VERIFY_STALE_AFTER_MS;
  }
  return (
    now - new Date(op.lastActivityAt || op.startedAt).getTime() > STALE_AFTER_MS
  );
}

/**
 * Give a non-terminal record the outcome its saved state already implies.
 *
 * Two dead ends are closed here. A stop recorded while the executor was still
 * unwinding is honored as soon as the prompt is genuinely idle, because no
 * mutation is ever in flight at a prompt. And filtering a quiet record out of
 * every lookup used to leave the operation neither running nor finished: the
 * customer saw nothing, the repository looked free, and the resources the
 * attempt had already created were described nowhere.
 */
export function reconcileOperationLifecycle(op: any, now = Date.now()): any {
  if (!op || isTerminalState(op.state)) return op;
  if (
    op.state === INPUT_REQUIRED_STATE &&
    !op.executionActive &&
    shouldStop(op)
  ) {
    return stopAtBoundary(op, "input_prompt");
  }
  if (!isStale(op, now)) return op;
  if (shouldStop(op)) return stopAtBoundary(op, "stale_reconciliation");
  if (op.state === INPUT_REQUIRED_STATE) {
    return finish(op, "failed_partial", {
      failure: {
        code: "operation-input-expired",
        stage: op.currentStage,
        stepSeq: null,
        message:
          "Environment setup timed out while waiting for required information.",
        classification: "user-fixable",
        evidence: null
      }
    });
  }
  return finish(op, "failed_partial", {
    failure: {
      code: "operation-stalled",
      stage: op.currentStage,
      stepSeq: null,
      message:
        "Radius stopped hearing from this environment setup before it finished. Resources it already created were retained so you can retry or clean them up.",
      classification: "user-fixable",
      evidence: null
    }
  });
}

const PERSISTED_OPERATION_KEYS = new Set([
  "operationId",
  "schemaVersion",
  "provider",
  "repo",
  "environment",
  "startedAt",
  "lastActivityAt",
  "endedAt",
  "state",
  "currentStage",
  "stages",
  "steps",
  "context",
  "setupArtifacts",
  "journey",
  "terminal",
  "failure",
  "inputRequired",
  "resumeRequest",
  "resumeFrom",
  "verification",
  "control"
]);

function persistedFailure(failure: any): any {
  if (!failure) return null;
  return {
    code: String(failure.code || ""),
    stage: failure.stage == null ? null : String(failure.stage),
    stepSeq:
      Number.isFinite(Number(failure.stepSeq)) ? Number(failure.stepSeq) : null,
    message: String(failure.message || ""),
    classification: String(failure.classification || "")
  };
}

export function toPersistedOperation(op: any): any {
  if (!op || typeof op !== "object") {
    throw new Error("Operation record is required.");
  }
  const record: any = {};
  for (const key of PERSISTED_OPERATION_KEYS) {
    if (key === "failure" || key === "control") continue;
    if (op[key] !== undefined) record[key] = structuredClone(op[key]);
  }
  record.failure = persistedFailure(op.failure);
  record.control = readOperationControl(op.control);
  if (
    typeof record.operationId !== "string" ||
    !record.operationId.startsWith("op_") ||
    typeof record.repo !== "string" ||
    typeof record.state !== "string" ||
    record.schemaVersion !== OPERATION_SCHEMA_VERSION
  ) {
    throw new Error("Invalid operation record.");
  }
  return record;
}

/**
 * Read a saved operation, upgrading a schema-version-1 record in place.
 *
 * Issues #304 and #305 shipped version 1 records. Discarding them would strand
 * a customer mid-setup with resources already created, so the missing control
 * fields are filled with safe defaults instead.
 */
export function fromPersistedOperation(value: any): any {
  if (!value || typeof value !== "object") {
    throw new Error("Operation record is required.");
  }
  const record: any = {};
  for (const key of PERSISTED_OPERATION_KEYS) {
    if (key === "failure" || key === "control") continue;
    if (value[key] !== undefined) record[key] = structuredClone(value[key]);
  }
  record.failure = persistedFailure(value.failure);
  if (
    typeof record.operationId !== "string" ||
    !record.operationId.startsWith("op_") ||
    typeof record.repo !== "string" ||
    typeof record.state !== "string" ||
    !SUPPORTED_OPERATION_SCHEMA_VERSIONS.includes(record.schemaVersion)
  ) {
    throw new Error("Invalid operation record.");
  }
  if (!Array.isArray(record.stages) || !Array.isArray(record.steps)) {
    throw new Error("Invalid persisted operation stages or steps.");
  }
  record.control = readOperationControl(value.control);
  record.stopRequested = Boolean(record.control.stop.requestedAt);
  record.schemaVersion = OPERATION_SCHEMA_VERSION;
  if (record.verification?.runId != null) {
    record.verification.runId = String(record.verification.runId);
  }
  return record;
}

export function reconcileRestoredOperation(op: any): any {
  if (!op || isTerminalState(op.state)) return op;
  // A stop the customer already paid for outlives the process that was going to
  // honor it. Nothing is mid-flight after a restart, so the boundary is here.
  if (shouldStop(op)) {
    stopAtBoundary(op, "restart_recovery");
    op.recoveryState = "stopped";
    return op;
  }
  if (op.inputRequired) {
    if (op.resumeRequest) {
      op.state = INPUT_REQUIRED_STATE;
      op.recoveryState = "waiting_input";
      return op;
    }
  }
  if (hasCompleteVerificationIdentity(op)) {
    op.recoveryState = "verification_pending";
    return op;
  }
  const now = nowIso();
  op.state = "failed_partial";
  op.endedAt = now;
  op.lastActivityAt = now;
  op.failure = {
    code: "operation-interrupted",
    stage: op.currentStage,
    stepSeq: null,
    message:
      "The Radius extension restarted before this operation reached a durable terminal state. Existing resources were retained for a safe retry.",
    classification: "user-fixable"
  };
  const ledger = getSetupArtifactLedger(op);
  if (ledger) ledger.cleanup.state = "not_needed";
  for (const stage of op.stages || []) {
    if (stage.state === "running") stage.state = "failed";
    else if (stage.state === "pending") stage.state = "skipped";
  }
  op.recoveryState = "interrupted";
  return op;
}

export function createRegistry({
  store = disabledOperationStore(),
  clock = () => Date.now()
}: {
  store?: OperationStore;
  clock?: () => number;
} = {}): any {
  /** @type {Map<string, object>} */
  const byId = new Map();

  function prune() {
    const now = clock();
    const terminal = [];
    for (const [id, op] of byId) {
      if (!isTerminalState(op.state)) continue;
      const age = now - new Date(op.endedAt || op.startedAt).getTime();
      if (age > RETAIN_TERMINAL_MS) {
        byId.delete(id);
        continue;
      }
      terminal.push(op);
    }
    if (terminal.length > MAX_RETAINED) {
      terminal
        .sort(
          (a, b) =>
            new Date(a.endedAt || a.startedAt) -
            new Date(b.endedAt || b.startedAt)
        )
        .slice(0, terminal.length - MAX_RETAINED)
        .forEach((op) => byId.delete(op.operationId));
    }
  }

  function snapshot() {
    prune();
    return {
      schemaVersion: PERSISTED_OPERATIONS_VERSION,
      operations: [...byId.values()].map(toPersistedOperation)
    };
  }

  return {
    async hydrate() {
      const envelope = await store.load();
      if (!envelope) return [];
      const restored = [];
      let rejected = 0;
      for (const [index, value] of envelope.operations.entries()) {
        try {
          const op = reconcileRestoredOperation(fromPersistedOperation(value));
          byId.set(op.operationId, op);
          restored.push(op);
        } catch (error) {
          rejected += 1;
          const operationId =
            (
              value &&
              typeof value === "object" &&
              typeof value.operationId === "string"
            ) ?
              ` (${value.operationId})`
            : "";
          store.report?.({
            code: "operation-store-invalid-record",
            message: `Skipped invalid persisted operation at index ${index}${operationId}: ${String(error)}`
          });
        }
      }
      prune();
      // Rewrite only after every record has been inspected. This removes rejected
      // records without allowing one bad entry to brick every future startup.
      if (rejected > 0) {
        try {
          await store.save(snapshot());
        } catch (error) {
          store.report?.({
            code: "operation-store-cleanup-write-failed",
            message: `Restored valid operations but could not rewrite the cleaned operation store: ${String(error)}`
          });
        }
      }
      return restored;
    },
    async persist() {
      await store.save(snapshot());
    },
    report(diagnostic) {
      store.report?.(diagnostic);
    },
    snapshot,
    /**
     * The operation holding this repository's lock, if any.
     *
     * "One setup at a time per repository" is the invariant that keeps two
     * attempts from racing on the same App Registration and environment
     * secrets. A record that has gone quiet is settled here rather than
     * skipped, so the lock is released by a real terminal result.
     */
    running(repo) {
      for (const op of byId.values()) {
        reconcileOperationLifecycle(op, clock());
        if (op.repo === repo && !isTerminalState(op.state)) return op;
      }
      return null;
    },
    /**
     * The record a returning user should be shown for a repo: whatever is
     * running, else the most recent terminal record they have not yet seen.
     */
    latest(repo) {
      let best = null;
      for (const op of byId.values()) {
        if (op.repo !== repo) continue;
        reconcileOperationLifecycle(op, clock());
        if (!isTerminalState(op.state)) return op;
        if (
          !best ||
          new Date(op.endedAt || op.startedAt) >
            new Date(best.endedAt || best.startedAt)
        )
          best = op;
      }
      return best;
    },
    /**
     * The record to show a caller that has no repo in hand.
     *
     * The status chip in the top navigation is the reason this exists: it
     * renders on every page, and only the environments and deployments
     * pages know which repository they are looking at. A canvas instance is
     * scoped to one workspace, so "the operation that matters right now" is
     * a well-defined thing to ask for without naming a repo.
     */
    latestAny() {
      let best = null;
      for (const op of byId.values()) {
        reconcileOperationLifecycle(op, clock());
        if (!isTerminalState(op.state)) return op;
        if (
          !best ||
          new Date(op.endedAt || op.startedAt) >
            new Date(best.endedAt || best.startedAt)
        )
          best = op;
      }
      return best;
    },
    get(operationId) {
      const op = byId.get(operationId) || null;
      reconcileOperationLifecycle(op, clock());
      return op;
    },
    /**
     * Register a new operation, refusing when one is already running for
     * the same repo. The caller decides what to do with the conflict; the
     * registry's job is only to make the collision impossible to miss.
     */
    start(op) {
      const existing = this.running(op.repo);
      if (existing) return { ok: false, conflict: existing };
      prune();
      byId.set(op.operationId, op);
      return { ok: true, operation: op };
    },
    /**
     * Take the repository lock back for an accepted retry of an operation
     * that already owns the record. Another live attempt wins the conflict.
     */
    acquireForRetry(op) {
      const existing = this.running(op.repo);
      if (existing && existing.operationId !== op.operationId)
        return { ok: false, conflict: existing };
      byId.set(op.operationId, op);
      return { ok: true, operation: op };
    },
    /** Adopt a record that was created elsewhere (tests, agent tool). */
    put(op) {
      byId.set(op.operationId, op);
      return op;
    },
    delete(operationId) {
      return byId.delete(operationId);
    },
    all() {
      return [...byId.values()];
    },
    size() {
      return byId.size;
    },
    anyRunning() {
      for (const op of byId.values()) {
        reconcileOperationLifecycle(op, clock());
        if (!isTerminalState(op.state)) return true;
      }
      return false;
    },
    anyExecuting() {
      for (const op of byId.values()) {
        reconcileOperationLifecycle(op, clock());
        if (
          !isTerminalState(op.state) &&
          op.state === RUNNING_STATE &&
          (op.executionActive === true ||
            (op.currentStage === STAGE_VERIFY &&
              !!op.verification?.dispatchedAt))
        )
          return true;
      }
      return false;
    },
    clear() {
      byId.clear();
    }
  };
}

// The process-wide registry the routes and the keepalive share.
export let operations = createRegistry();

export async function configureOperationStore(
  store: OperationStore
): Promise<void> {
  const existing = operations.all();
  const registry = createRegistry({ store });
  await registry.hydrate();
  for (const op of existing) {
    if (!registry.get(op.operationId)) registry.put(op);
  }
  operations = registry;
}

export async function persistOperations(): Promise<void> {
  await operations.persist();
}

/**
 * Whether any setup operation is in flight.
 *
 * The keepalive uses this. Today setup runs inside an awaited POST while the
 * modal polls /api/ping every 5s, so the host connection stays warm by
 * accident; moving the work to a background operation removes that accident,
 * which is why this predicate has to exist before the panel ships.
 */
export function setupInFlight(): boolean {
  return operations.anyExecuting();
}

/**
 * Project a record for the webview.
 *
 * `failure.evidence` is attacker-influenced (a dependency's build log can carry
 * instruction-shaped text) and is stripped here. The panel renders structured
 * fields; evidence travels only on the diagnostic path, fenced.
 */
export function toClientView(op: any): any {
  if (!op) return null;
  const cleanup = projectCleanupSummary(op);
  const control = op.control || createOperationControl();
  const command = latestCommand(op);
  return {
    operationId: op.operationId,
    schemaVersion: op.schemaVersion,
    provider: op.provider,
    repo: op.repo,
    environment: op.environment,
    startedAt: op.startedAt,
    lastActivityAt: op.lastActivityAt,
    endedAt: op.endedAt,
    state: op.state,
    currentStage: op.currentStage,
    stages: op.stages,
    steps: op.steps,
    context: op.context,
    journey: op.journey,
    terminal: op.terminal,
    verification:
      typeof op.verification?.dispatchedAt === "number" ?
        { dispatchedAt: op.verification.dispatchedAt }
      : null,
    inputRequired: op.inputRequired || null,
    summary: summarize(op),
    terminalState: isTerminalState(op.state) ? op.state : null,
    hasWarnings: hasWarnings(op),
    cleanup,
    stop: {
      requested: Boolean(control.stop.requestedAt),
      requestedAt: control.stop.requestedAt,
      acknowledgedAt: control.stop.acknowledgedAt,
      boundary: control.stop.boundary
    },
    attempts: { ...control.attempts },
    // Only the command's identity and state travel to the browser.
    command:
      command ?
        {
          kind: command.kind,
          commandId: command.commandId,
          attempt: command.attempt,
          state: command.state,
          acceptedAt: command.acceptedAt,
          completedAt: command.completedAt,
          outcome: command.outcome
        }
      : null,
    outcomes: control.outcomes.map((entry: any) => ({
      kind: entry.kind,
      attempt: entry.attempt,
      state: entry.state,
      code: entry.code,
      recordedAt: entry.recordedAt
    })),
    actions: projectOperationActions(op),
    guidance: projectActionGuidance(op),
    headline: projectOperationHeadline(op),
    activeCommandKind: activeCommandKind(op),
    nextTransition: projectNextTransition(op),
    failure:
      op.failure ?
        {
          code: op.failure.code,
          stage: op.failure.stage,
          stepSeq: op.failure.stepSeq,
          message: op.failure.message,
          classification: op.failure.classification
        }
      : null
  };
}
