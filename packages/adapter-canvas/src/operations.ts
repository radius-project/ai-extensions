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

import { randomUUID } from "node:crypto";
import {
  disabledOperationStore,
  PERSISTED_OPERATIONS_VERSION,
  type OperationStore
} from "./operation-store.js";

export const OPERATION_SCHEMA_VERSION = 1;

export type SetupArtifactPresence = "not_started" | "created" | "reused";
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

export type SetupArtifactCleanupState = {
  state: SetupCleanupStatus;
  ownerAssignment: "not_requested";
  attempts: number;
  results: Array<{
    attempt: number;
    artifactType:
      | "github_environment"
      | "role_assignment"
      | "federated_credential"
      | "service_principal"
      | "azure_app";
    target: string;
    outcome: "deleted" | "not_found" | "warning" | "skipped";
    detail: string | null;
  }>;
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
    stopRequested: false
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
export function requireInput(op: any, { code, message }: any = {}): any {
  if (!op || isTerminalState(op.state)) return op;
  op.inputRequired = {
    code: code || "input-required",
    message: message || "",
    requestedAt: nowIso()
  };
  op.lastActivityAt = op.inputRequired.requestedAt;
  return op;
}

/** Clear the prompt marker when a retry presents the requested input. */
export function resumeAfterInput(op: any): any {
  if (!op || isTerminalState(op.state)) return op;
  op.inputRequired = null;
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
  if (!failureState && cleanupState === "not_started") return null;

  const commitPointReached = hasReachedSetupCommitPoint(op);
  const results = cleanupAttemptResults(ledger).map((entry: any) => ({
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
    retry
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

/** Finish the operation in an explicit terminal state. */
export function finish(
  op: any,
  state: any,
  { terminal = null, failure = null }: any = {}
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
  announceTerminal(op);
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

/** Cooperative stop. The loop checks this between mutations; it never aborts one. */
export function requestStop(op: any): boolean {
  if (!op) return false;
  if (isTerminalState(op.state)) return false;
  op.stopRequested = true;
  return true;
}

export function shouldStop(op: any): boolean {
  return !!(op && op.stopRequested && !isTerminalState(op.state));
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
      const stage = op.stages.find((s) => s.id === op.currentStage);
      return `Creating ${env} — ${
        stage ? stage.label.toLowerCase() : "working"
      }…`;
    }
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
    case "cancelled":
      return `Creating environment "${env}" was stopped.`;
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

/** Whether a non-terminal record has gone quiet long enough to be abandoned. */
export function isStale(op: any, now = Date.now()): boolean {
  if (!op || isTerminalState(op.state)) return false;
  if (
    op.recoveryState === "waiting_input" ||
    op.recoveryState === "verification_pending"
  )
    return false;
  return (
    now - new Date(op.lastActivityAt || op.startedAt).getTime() > STALE_AFTER_MS
  );
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
  "verification"
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
    if (key === "failure") continue;
    if (op[key] !== undefined) record[key] = structuredClone(op[key]);
  }
  record.failure = persistedFailure(op.failure);
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

export function fromPersistedOperation(value: any): any {
  const op = toPersistedOperation(value);
  if (!Array.isArray(op.stages) || !Array.isArray(op.steps)) {
    throw new Error("Invalid persisted operation stages or steps.");
  }
  if (op.verification?.runId != null) {
    op.verification.runId = String(op.verification.runId);
  }
  return op;
}

export function reconcileRestoredOperation(op: any): any {
  if (!op || isTerminalState(op.state)) return op;
  if (op.inputRequired) {
    op.recoveryState = "waiting_input";
    return op;
  }
  if (op.currentStage === STAGE_VERIFY && op.verification?.dispatchedAt) {
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
      if (rejected > 0) await store.save(snapshot());
      return restored;
    },
    async persist() {
      await store.save(snapshot());
    },
    report(diagnostic) {
      store.report?.(diagnostic);
    },
    snapshot,
    /** The operation still running for a repo, if any. */
    running(repo) {
      for (const op of byId.values()) {
        if (op.repo === repo && !isTerminalState(op.state) && !isStale(op))
          return op;
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
        if (!isTerminalState(op.state)) {
          // A stale record is one nobody is driving any more. Showing
          // it would be worse than showing nothing: a spinner that can
          // never resolve is exactly the thing this work set out to
          // remove.
          if (isStale(op)) continue;
          return op;
        }
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
        if (!isTerminalState(op.state)) {
          if (isStale(op)) continue;
          return op;
        }
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
      return op && !isStale(op) ? op : null;
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
      for (const op of byId.values())
        if (!isTerminalState(op.state) && !isStale(op)) return true;
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
  return operations.anyRunning();
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
    inputRequired: op.inputRequired || null,
    summary: summarize(op),
    terminalState: isTerminalState(op.state) ? op.state : null,
    hasWarnings: hasWarnings(op),
    cleanup,
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
