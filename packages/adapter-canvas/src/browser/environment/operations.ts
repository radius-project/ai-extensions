// Canvas adapter — browser behavior for environment setup operations: progress
// checklist, elapsed time, failure cards, resume, and terminal state.
//
// This is the importable translation of the legacy inline script that used to
// live at pages/environment/client-operations.ts. It owns the progress panel's
// DOM and the single poll/elapsed-timer pair that drives it, and it exposes a
// narrow dependency contract for the pieces that still live in sibling,
// not-yet-extracted modules (the SMR and app-selection modals, and the
// landing's success/warning/error/action-required banners).

import { setChildren } from "../dom.js";
import { createCommandAction } from "../command-action.js";
import type { CommandActionHandle } from "../command-action.js";
import type { RemediationView } from "@radius-project/core/remediations";
import {
  BARE_GH_COMMAND_PRESENTATION,
  presentedRemediationView,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import { beginEntry } from "../lifecycle.js";
import { formatElapsed, stageGlyph } from "../progress-format.js";
import {
  isRecord,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  readStringArray
} from "../json.js";
import type { ElementSpec } from "../dom.js";
import type { ScopeTimer } from "../lifecycle.js";
import type {
  AbortHandle,
  BrowserContext,
  DomElement,
  DomEventListener,
  DomInputElement,
  HttpRequestInit,
  HttpResponse
} from "../ports.js";

interface CommandButton {
  readonly element: DomInputElement;
  readonly listener: DomEventListener;
}

export const ENVIRONMENT_OPERATIONS_ENTRY_KEY = "environment-operations";
export const OPERATIONS_PATH = "/api/operations";
export const VERIFY_STATUS_PATH = "/api/verify-status";
export const DEPLOY_BUTTON_ID = "deploy-btn";
export const NEW_ENVIRONMENT_BUTTON_ID = "new-env-btn";
export const ERROR_BANNER_ID = "env-error-banner";
export const DEPLOY_BUTTON_IDLE_LABEL = "Create Environment";

export const PROGRESS_IDS = {
  panel: "env-progress-panel",
  title: "env-progress-title",
  headlineNote: "env-progress-headline-note",
  activity: "env-progress-activity",
  elapsed: "env-progress-elapsed",
  stages: "env-progress-stages",
  steps: "env-progress-steps",
  details: "env-progress-details",
  diagnostics: "env-progress-diagnostics",
  actions: "env-progress-actions",
  bottomButtons: "env-progress-bottom-buttons",
  dismiss: "env-progress-dismiss",
  failureCard: "env-progress-failure",
  failureTitle: "env-progress-failure-title",
  failureMessage: "env-progress-failure-message",
  failureCommand: "env-progress-failure-command",
  cleanupStatus: "env-progress-cleanup-status",
  retry: "env-progress-retry",
  cleanupWarningsList: "env-progress-cleanup-warnings",
  cleanupWarningsBlock: "env-progress-cleanup-warnings-block",
  partialState: "env-progress-state",
  stateCreatedList: "env-progress-state-created",
  stateCreatedBlock: "env-progress-state-created-block",
  stateRetainedList: "env-progress-state-retained",
  stateRetainedBlock: "env-progress-state-retained-block",
  stateReusedList: "env-progress-state-reused",
  stateReusedBlock: "env-progress-state-reused-block",
  stateCleanedList: "env-progress-state-cleaned",
  stateCleanedBlock: "env-progress-state-cleaned-block",
  stateManualList: "env-progress-state-manual",
  stateManualBlock: "env-progress-state-manual-block",
  commands: "env-progress-commands",
  commandButtons: "env-progress-command-buttons",
  commandDescriptions: "env-progress-command-descriptions",
  commandNote: "env-progress-command-note",
  commandGuidance: "env-progress-command-guidance",
  commandStatus: "env-progress-command-status",
  commandError: "env-progress-command-error"
} as const;

export const DIAGNOSTIC_IDS = {
  open: "env-progress-diagnostics-open",
  modal: "env-diagnostics-modal",
  title: "env-diagnostics-title",
  includeIdentifiers: "env-diagnostics-include-identifiers",
  preview: "env-diagnostics-preview",
  repository: "env-diagnostics-repository",
  branch: "env-diagnostics-branch",
  environment: "env-diagnostics-environment",
  githubLogin: "env-diagnostics-github-login",
  reviewBlock: "env-diagnostics-review-block",
  reviewedIdentifiers: "env-diagnostics-reviewed-identifiers",
  status: "env-diagnostics-status",
  error: "env-diagnostics-error",
  cancel: "env-diagnostics-cancel",
  download: "env-diagnostics-download"
} as const;

export const ROLLBACK_IDS = {
  modal: "env-rollback-modal",
  title: "env-rollback-title",
  intro: "env-rollback-intro",
  removeList: "env-rollback-remove",
  removeBlock: "env-rollback-remove-block",
  keepList: "env-rollback-keep",
  keepBlock: "env-rollback-keep-block",
  manualList: "env-rollback-manual",
  manualBlock: "env-rollback-manual-block",
  cancel: "env-rollback-cancel",
  confirm: "env-rollback-confirm"
} as const;

// Partial-state groups stay separate rather than merging into one list: a
// customer cannot act on "some resources exist" and can act on "Radius created
// this and kept it so a retry can reuse it".
const PARTIAL_STATE_GROUPS = [
  {
    group: "created",
    list: PROGRESS_IDS.stateCreatedList,
    block: PROGRESS_IDS.stateCreatedBlock
  },
  {
    group: "retainedArtifacts",
    list: PROGRESS_IDS.stateRetainedList,
    block: PROGRESS_IDS.stateRetainedBlock
  },
  {
    group: "reused",
    list: PROGRESS_IDS.stateReusedList,
    block: PROGRESS_IDS.stateReusedBlock
  },
  {
    group: "cleaned",
    list: PROGRESS_IDS.stateCleanedList,
    block: PROGRESS_IDS.stateCleanedBlock
  }
] as const;

const COMMAND_TONE_CLASS: Readonly<Record<string, string>> = {
  primary: "rad-btn rad-btn--primary",
  danger: "rad-btn rad-btn--danger",
  neutral: "rad-btn rad-btn--secondary"
};
const COMMAND_BUTTON_CLASS = "rad-btn rad-btn--secondary";
const COMMAND_REFUSED_MESSAGE = "Radius could not accept that request.";
const COMMAND_UNREACHABLE_MESSAGE =
  "Radius could not reach the setup service. Try again.";
const STOPPING_MESSAGE = "Stopping after the current step…";
const COMMAND_ACCEPTED_MESSAGE = "Radius accepted the request…";
const ROLLBACK_UNAVAILABLE_MESSAGE =
  "Radius could not open the rollback confirmation.";
const DEFAULT_FAILURE_TITLE = "Setup didn’t finish";
const DEFAULT_ROLLBACK_TITLE = "Roll back resources created by this setup?";
const DEFAULT_ROLLBACK_CONFIRM = "Roll back resources";
const DEFAULT_ROLLBACK_CANCEL = "Keep resources";
const DIAGNOSTIC_FILENAME = "radius-environment-operation-diagnostics.json";
const CANCELLED_ACTIVITY_MESSAGE = "Environment setup cancelled.";
// Commands that delete. Accepting one supersedes the failure the landing is
// still reporting, so the banner comes down and the environment table is
// refreshed as soon as the server takes the request.
const CLEANING_COMMAND_KINDS: ReadonlySet<string> = new Set([
  "rollback",
  "retry_cleanup",
  "exit_setup"
]);

// A command's own sentence. Stop, rollback, and the two forward continuations
// are different promises, so none of them borrows another's wording.
const COMMAND_STATUS_TEXT: Readonly<Record<string, string>> = {
  stop: STOPPING_MESSAGE,
  rollback: "Rollback started. Removing the resources Radius created…",
  retry_cleanup:
    "Rollback retry started. Removing the resources still present…",
  continue_setup: "Continuing setup…",
  retry_setup: "Retrying setup…",
  exit_setup: "Closing this setup and removing the resources Radius created…"
};

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
]);

// The server's own name for a rollback that ran to completion. The record is
// `cancelled` like a plain stop, but the customer already got the outcome they
// asked for, so it is acknowledged rather than decided on again.
const ROLLBACK_COMPLETE_CODE = "rollback-complete";

// The server's own name for a setup the customer left. The record keeps the
// verdict it ended with, so this code — not the terminal state — is what says
// the customer is done with it and the panel has nothing left to report.
const SETUP_EXITED_CODE = "setup-exited";

// Only a non-terminal record is doing work, and only work in progress may
// animate. A finished operation that keeps spinning claims Radius is still
// acting on the customer's cloud account when it is not.
const PANEL_ACTIVE_CLASS = "env-progress--active";

const VERIFY_TRACKING_WINDOW_MS = 45 * 60 * 1000;
const POLL_RETRY_MS = 1500;
const POLL_ERROR_RETRY_MS = 3000;

export type TerminalState =
  | "succeeded"
  | "succeeded_with_warnings"
  | "action_required"
  | "failed"
  | "failed_partial"
  | "cancelled";

export interface OperationStageOrStep {
  readonly state: string;
  readonly label: string;
}

export interface OperationFailure {
  readonly message: string;
  /**
   * The command that repairs this failure, when the registry will build one.
   *
   * Rebuilt here from the persisted id and params rather than transported as a
   * string, so a stored record cannot introduce a command of its own.
   */
  readonly remediation: RemediationView | null;
}

export interface OperationCleanupEntry {
  readonly target: string;
  /** The server's sentence about why this entry is in its group, if any. */
  readonly detail: string;
}

export interface OperationManualAction {
  readonly target: string;
  readonly action: string;
}

export interface OperationCleanupRetry {
  readonly startsCleanly: boolean;
  readonly guidance: string;
}

export interface OperationCleanup {
  readonly state: string;
  readonly rollbackBeforeCommit: boolean | undefined;
  readonly retry: OperationCleanupRetry;
  readonly warnings: readonly string[];
  readonly created: readonly OperationCleanupEntry[];
  readonly retainedArtifacts: readonly OperationCleanupEntry[];
  readonly reused: readonly OperationCleanupEntry[];
  readonly cleaned: readonly OperationCleanupEntry[];
  readonly manualActionRequired: readonly OperationManualAction[];
}

/**
 * One control the server says is allowed right now. Eligibility is never
 * re-derived in the browser: a button the server then refuses is worse than no
 * button at all.
 */
export interface OperationAction {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly path: string;
  readonly pending: boolean;
  readonly tone: string;
  // Where the panel puts the control. The command row holds the decisions about
  // the setup itself; the bottom row, below the details disclosure, holds the
  // one that leaves it. An unrecognised placement falls back to the row, so a
  // future action can never disappear from the panel.
  readonly placement: OperationActionPlacement;
  readonly requiresConfirmation: boolean;
  readonly confirmTitle: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly preview: OperationActionPreview | null;
}

export type OperationActionPlacement = "row" | "bottom";

/** A resource named in a destructive command's server-built preview. */
export interface OperationPreviewEntry {
  readonly kind: string;
  readonly target: string;
  readonly action: string;
}

export interface OperationRollbackPreview {
  readonly type: "rollback";
  readonly removes: readonly OperationPreviewEntry[];
  readonly keeps: readonly OperationPreviewEntry[];
  readonly manualActionRequired: readonly OperationPreviewEntry[];
}

export interface OperationContinuationPreview {
  readonly type: "continuation";
  readonly resumeFrom: string;
  readonly resumeLabel: string;
  readonly reuses: readonly OperationPreviewEntry[];
}

export type OperationActionPreview =
  OperationRollbackPreview | OperationContinuationPreview;

/** Why a path the customer might expect is not on offer. */
export interface OperationGuidanceNote {
  readonly code: string;
  readonly message: string;
}

/**
 * The heading and supporting sentence for a state that needs its own screen —
 * a stop, a rollback in progress, or a rollback that left something behind.
 */
export interface OperationHeadline {
  readonly code: string;
  readonly title: string;
  readonly message: string;
}

/** The automatic move a non-terminal record is waiting on. */
export interface OperationNextTransition {
  readonly code: string;
  readonly message: string;
}

export interface AppPickerCandidate {
  readonly appId: string;
  readonly displayName?: string;
  readonly createdDateTime?: string;
  readonly servesRepos?: readonly string[];
}

export interface AppPickerRequest {
  readonly title: string;
  readonly intro: string;
  readonly candidates: readonly AppPickerCandidate[];
  readonly defaultAppId?: string;
  readonly allowCreateNew: boolean;
}

export interface AppPickerChoice {
  readonly appId?: string;
  readonly createNew?: boolean;
}

export interface OperationInputPrompt {
  readonly requestedAt: string;
  readonly code: string;
  readonly checkpoint: unknown;
  readonly candidates: readonly AppPickerCandidate[];
  readonly defaultAppId: string;
}

interface DiagnosticContext {
  readonly repository: string | null;
  readonly branch: string | null;
  readonly environment: string | null;
  readonly githubLogin: string | null;
  readonly omittedFieldCount: number;
}

interface DiagnosticContextPreview {
  readonly identifiers: DiagnosticContext;
  readonly fingerprint: string;
}

export type OperationTerminalPayload = Readonly<Record<string, unknown>>;

export interface OperationRecord {
  readonly operationId: string;
  readonly environment: string;
  readonly provider: string;
  readonly state: string;
  readonly terminalState: TerminalState | null;
  readonly summary: string;
  readonly currentStage: string;
  readonly stages: readonly OperationStageOrStep[];
  readonly steps: readonly OperationStageOrStep[];
  readonly failure: OperationFailure | null;
  readonly cleanup: OperationCleanup;
  readonly actions: readonly OperationAction[];
  readonly guidance: readonly OperationGuidanceNote[];
  readonly headline: OperationHeadline | null;
  readonly activeCommandKind: string;
  readonly nextTransition: OperationNextTransition | null;
  readonly verification: { readonly dispatchedAt: number | null } | null;
  readonly inputRequired: OperationInputPrompt | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly terminal: OperationTerminalPayload | null;
}

export interface VerifyStatus {
  readonly state: string;
  readonly terminal: boolean;
  readonly error: string;
  readonly runUrl: string;
  readonly activity: string;
}

export interface EnvironmentOperationsDeps {
  showSuccessBanner(provider: string, environment: string): void;
  showActionRequired(
    provider: string,
    environment: string,
    pullRequestUrl: string,
    terminal: OperationTerminalPayload | null
  ): void;
  showSetupWarnings(warnings: readonly string[]): void;
  showError(message: string): void;
  reloadEnvironmentsTable(): void;
  resetSubmitButton?(): void;
  promptServiceManagementReference(): Promise<string>;
  promptAppSelection(request: AppPickerRequest): Promise<AppPickerChoice>;
  prefersReducedMotion?(): boolean;
}

export interface EnvironmentOperationsOptions {
  readonly repo: string;
  readonly mutationNonce?: string;
  readonly ghCommandPresentation?: GhCommandPresentation;
  readonly deps: EnvironmentOperationsDeps;
}

export interface EnvironmentOperationsController {
  renderProgress(op: OperationRecord | null): void;
  stopProgress(): void;
  hideProgress(): void;
  focusPanel(): void;
  syncFailureOperation(data: unknown): Promise<boolean>;
  trackProgress(
    environment: string,
    provider: string,
    onTerminal?: (op: OperationRecord) => void
  ): void;
  resumeProgress(): void;
  applyTerminal(op: OperationRecord): void;
  teardown(): void;
}

function parseStageList(value: unknown): OperationStageOrStep[] {
  if (!Array.isArray(value)) return [];
  const list: OperationStageOrStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    list.push({
      state: readString(entry, "state"),
      label: readString(entry, "label")
    });
  }
  return list;
}

function parseFailure(
  value: unknown,
  ghCommandPresentation: GhCommandPresentation
): OperationFailure | null {
  if (!isRecord(value)) return null;
  return {
    message: readString(value, "message"),
    remediation: parseFailureRemediation(
      value["remediation"],
      ghCommandPresentation
    )
  };
}

function parseFailureRemediation(
  value: unknown,
  ghCommandPresentation: GhCommandPresentation
): RemediationView | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const rawParams = value["params"];
  const params: Record<string, string> = {};
  if (isRecord(rawParams)) {
    for (const [key, raw] of Object.entries(rawParams)) {
      if (typeof raw === "string") params[key] = raw;
    }
  }
  // A refused build still yields a view -- an unknown id and refused params both
  // come back unrunnable -- so `runnable` is the single gate. An unrunnable one
  // must fall back to the prose, never to an empty callout.
  const view = presentedRemediationView(id, params, ghCommandPresentation);
  return view.runnable ? view : null;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  const raw = record[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function parseCleanupEntries(value: unknown): OperationCleanupEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: OperationCleanupEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const target = readString(entry, "target");
    if (target !== "")
      entries.push({ target, detail: readString(entry, "detail") });
  }
  return entries;
}

function parseCleanupRetry(value: unknown): OperationCleanupRetry {
  const record = isRecord(value) ? value : {};
  return {
    startsCleanly: readBoolean(record, "startsCleanly"),
    guidance: readString(record, "guidance")
  };
}

const EMPTY_CLEANUP: OperationCleanup = {
  state: "",
  rollbackBeforeCommit: undefined,
  retry: { startsCleanly: false, guidance: "" },
  warnings: [],
  created: [],
  retainedArtifacts: [],
  reused: [],
  cleaned: [],
  manualActionRequired: []
};

function parseManualActions(value: unknown): OperationManualAction[] {
  if (!Array.isArray(value)) return [];
  const entries: OperationManualAction[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const target = readString(entry, "target");
    if (target === "") continue;
    entries.push({ target, action: readString(entry, "action") });
  }
  return entries;
}

function parseCleanup(value: unknown): OperationCleanup {
  if (!isRecord(value)) return EMPTY_CLEANUP;
  return {
    state: readString(value, "state"),
    rollbackBeforeCommit: readOptionalBoolean(value, "rollbackBeforeCommit"),
    retry: parseCleanupRetry(value["retry"]),
    warnings: readStringArray(value, "warnings").filter(
      (entry) => entry !== ""
    ),
    created: parseCleanupEntries(value["created"]),
    retainedArtifacts: parseCleanupEntries(value["retainedArtifacts"]),
    reused: parseCleanupEntries(value["reused"]),
    cleaned: parseCleanupEntries(value["cleaned"]),
    manualActionRequired: parseManualActions(value["manualActionRequired"])
  };
}

function parsePreviewEntries(value: unknown): OperationPreviewEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: OperationPreviewEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const target = readString(entry, "target");
    if (target === "") continue;
    entries.push({
      kind: readString(entry, "kind"),
      target,
      action: readString(entry, "action")
    });
  }
  return entries;
}

function parsePreview(
  value: unknown,
  actionKind: string
): OperationActionPreview | null {
  if (!isRecord(value)) return null;
  if (actionKind === "continue_setup" || actionKind === "retry_setup") {
    return {
      type: "continuation",
      resumeFrom: readString(value, "resumeFrom"),
      resumeLabel: readString(value, "resumeLabel"),
      reuses: parsePreviewEntries(value["reuses"])
    };
  }
  if (
    actionKind !== "rollback" &&
    actionKind !== "retry_cleanup" &&
    actionKind !== "exit_setup"
  ) {
    return null;
  }
  return {
    type: "rollback",
    removes: parsePreviewEntries(value["removes"]),
    keeps: parsePreviewEntries(value["keeps"]),
    manualActionRequired: parsePreviewEntries(value["manualActionRequired"])
  };
}

function parseActions(value: unknown): OperationAction[] {
  if (!Array.isArray(value)) return [];
  const actions: OperationAction[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = readString(entry, "path");
    // A control with no path has nothing to submit, so it is dropped rather
    // than rendered as a button that can only fail.
    if (path === "") continue;
    const kind = readString(entry, "kind");
    actions.push({
      id: readString(entry, "id"),
      kind,
      label: readString(entry, "label"),
      description: readString(entry, "description"),
      path,
      pending: readBoolean(entry, "pending"),
      tone: readString(entry, "tone"),
      placement: readString(entry, "placement") === "bottom" ? "bottom" : "row",
      requiresConfirmation: readBoolean(entry, "requiresConfirmation"),
      confirmTitle: readString(entry, "confirmTitle"),
      confirmLabel: readString(entry, "confirmLabel"),
      cancelLabel: readString(entry, "cancelLabel"),
      preview: parsePreview(entry["preview"], kind)
    });
  }
  return actions;
}

function parseGuidance(value: unknown): OperationGuidanceNote[] {
  if (!Array.isArray(value)) return [];
  const notes: OperationGuidanceNote[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const message = readString(entry, "message");
    if (message === "") continue;
    notes.push({ code: readString(entry, "code"), message });
  }
  return notes;
}

function parseHeadline(value: unknown): OperationHeadline | null {
  if (!isRecord(value)) return null;
  return {
    code: readString(value, "code"),
    title: readString(value, "title"),
    message: readString(value, "message")
  };
}

function parseNextTransition(value: unknown): OperationNextTransition | null {
  if (!isRecord(value)) return null;
  return {
    code: readString(value, "code"),
    message: readString(value, "message")
  };
}

function parseVerification(
  value: unknown
): { dispatchedAt: number | null } | null {
  if (!isRecord(value)) return null;
  return { dispatchedAt: readNumber(value, "dispatchedAt") };
}

function parseDiagnosticContext(
  value: unknown
): DiagnosticContextPreview | null {
  if (!isRecord(value)) return null;
  const identifiers = readRecord(value, "contextualIdentifiers");
  if (!identifiers) return null;
  const fingerprint = readString(value, "contextFingerprint");
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) return null;
  const optional = (key: string): string | null => {
    const value = readString(identifiers, key);
    return value === "" ? null : value;
  };
  return {
    identifiers: {
      repository: optional("repository"),
      branch: optional("branch"),
      environment: optional("environment"),
      githubLogin: optional("githubLogin"),
      omittedFieldCount: readNumber(identifiers, "omittedFieldCount") ?? 0
    },
    fingerprint
  };
}

function parseAppCandidates(value: unknown): AppPickerCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: AppPickerCandidate[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const appId = readString(entry, "appId");
    if (appId === "") continue;
    const displayName = readString(entry, "displayName");
    const createdDateTime = readString(entry, "createdDateTime");
    const servesRepos = readStringArray(entry, "servesRepos");
    candidates.push({
      appId,
      displayName: displayName === "" ? undefined : displayName,
      createdDateTime: createdDateTime === "" ? undefined : createdDateTime,
      servesRepos: servesRepos.length === 0 ? undefined : servesRepos
    });
  }
  return candidates;
}

function parseInputPrompt(value: unknown): OperationInputPrompt | null {
  if (!isRecord(value)) return null;
  const code = readString(value, "code");
  if (code === "") return null;
  const metadata = readRecord(value, "metadata");
  return {
    requestedAt: readString(value, "requestedAt"),
    code,
    checkpoint: value["checkpoint"],
    candidates: parseAppCandidates(
      metadata ? metadata["candidates"] : undefined
    ),
    defaultAppId: metadata ? readString(metadata, "defaultAppId") : ""
  };
}

function parseTerminalState(value: string): TerminalState | null {
  return TERMINAL_STATES.has(value) ? (value as TerminalState) : null;
}

function parseOperationRecord(
  raw: Record<string, unknown>,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): OperationRecord | null {
  const operationId = readString(raw, "operationId");
  if (operationId === "") return null;
  const endedAt = readString(raw, "endedAt");
  return {
    operationId,
    environment: readString(raw, "environment"),
    provider: readString(raw, "provider"),
    state: readString(raw, "state"),
    terminalState: parseTerminalState(readString(raw, "terminalState")),
    summary: readString(raw, "summary"),
    currentStage: readString(raw, "currentStage"),
    stages: parseStageList(raw["stages"]),
    steps: parseStageList(raw["steps"]),
    failure: parseFailure(raw["failure"], ghCommandPresentation),
    cleanup: parseCleanup(raw["cleanup"]),
    actions: parseActions(raw["actions"]),
    guidance: parseGuidance(raw["guidance"]),
    headline: parseHeadline(raw["headline"]),
    activeCommandKind: readString(raw, "activeCommandKind"),
    nextTransition: parseNextTransition(raw["nextTransition"]),
    verification: parseVerification(raw["verification"]),
    inputRequired: parseInputPrompt(raw["inputRequired"]),
    startedAt: readString(raw, "startedAt"),
    endedAt: endedAt === "" ? null : endedAt,
    terminal: readRecord(raw, "terminal")
  };
}

/**
 * Validate an `/api/operations*` envelope. Fails closed to `null` (treated by
 * callers the same as "no operation yet") whenever the payload is not an
 * object, has no `operation` member, or the operation has no non-empty
 * `operationId` — the one field this module trusts as the operation's
 * identity across polls, resumes, and page navigation.
 */
export function parseOperationResponse(
  payload: unknown,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): OperationRecord | null {
  const raw = readRecord(payload, "operation");
  return raw ? parseOperationRecord(raw, ghCommandPresentation) : null;
}

/**
 * Validate an `error.operation` payload returned by a failed resume request.
 * Unlike {@link parseOperationResponse} the record is not wrapped in an
 * envelope, so this reads the record directly.
 */
export function parseVerifyStatus(payload: unknown): VerifyStatus {
  return {
    state: readString(payload, "state"),
    terminal: readBoolean(payload, "terminal"),
    error: readString(payload, "error"),
    runUrl: readString(payload, "runUrl"),
    activity: readString(payload, "activity")
  };
}

function isOperationInputExpired(
  operation: unknown
): operation is Record<string, unknown> {
  const failure = readRecord(operation, "failure");
  return (
    failure !== null &&
    readString(failure, "code") === "operation-input-expired"
  );
}

function isAbandonError(error: unknown): boolean {
  return isRecord(error) && readBoolean(error, "abandonOperation");
}

/** Thrown when a resume POST fails; carries enough of the server's response
 * for the caller to decide whether to re-prompt or keep retrying. */
export class OperationResumeError extends Error {
  readonly retryPrompt: boolean;
  readonly operation: unknown;

  constructor(message: string, retryPrompt: boolean, operation: unknown) {
    super(message);
    this.name = "OperationResumeError";
    this.retryPrompt = retryPrompt;
    this.operation = operation;
  }
}

function parseResumeFailure(payload: unknown): OperationResumeError {
  const message =
    readString(payload, "error") ||
    readString(payload, "message") ||
    "Unable to resume environment setup.";
  const code = readString(payload, "code");
  const retryPrompt = code !== "operation-input-expired";
  const operation = isRecord(payload) ? payload["operation"] : undefined;
  return new OperationResumeError(message, retryPrompt, operation);
}

function stageSpec(stage: OperationStageOrStep): ElementSpec {
  const glyph = stageGlyph(stage.state);
  return {
    tag: "li",
    className: `env-progress__stage env-progress__stage--${stage.state}`,
    children: [
      {
        tag: "span",
        className: "env-progress__glyph",
        attrs: { "aria-hidden": "true" },
        text: glyph
      },
      { tag: "span", text: `${stage.label} — ${stage.state}` }
    ]
  };
}

function stepSpec(step: OperationStageOrStep): ElementSpec {
  const glyph = stageGlyph(step.state, "·");
  return {
    tag: "li",
    className: `env-progress__step env-progress__step--${step.state}`,
    text: `${glyph} ${step.label}`
  };
}

/**
 * Name a resource in the customer's terms rather than the ledger's. The kind
 * is a closed server vocabulary; anything unrecognised degrades to the honest
 * generic noun instead of leaking an internal identifier, and the target is
 * always kept so the entry stays identifiable.
 */
export function previewResourceLabel(entry: OperationPreviewEntry): string {
  const labels: Readonly<Record<string, string>> = {
    azure_app: "App Registration",
    service_principal: "Service Principal",
    federated_credential: "Federated credential",
    role_assignment: "Role assignment",
    github_environment: "GitHub environment",
    workflow_file: "Workflow file"
  };
  return `${labels[entry.kind] ?? "Resource"}: ${entry.target}`;
}

/**
 * The same name, followed by the server's sentence about it when there is one.
 *
 * Used for every list whose entries need a reason as well as a name. "Radius
 * will keep — App Registration: radius-deploy-octo-app" is the line a customer
 * reads as a bug when they watched Radius create that App Registration, so the
 * reason travels with it rather than being left to the reader.
 */
export function previewEntryLabel(entry: OperationPreviewEntry): string {
  const label = previewResourceLabel(entry);
  return entry.action === "" ? label : `${label} — ${entry.action}`;
}

function commandStatusText(action: OperationAction): string {
  return COMMAND_STATUS_TEXT[action.kind] ?? COMMAND_ACCEPTED_MESSAGE;
}

/** A setup that reached the environment the customer asked for. */
function isSuccessfulSetup(op: OperationRecord | null): boolean {
  return (
    op !== null &&
    (op.terminalState === "succeeded" ||
      op.terminalState === "succeeded_with_warnings")
  );
}

/**
 * A rollback that ran to completion. The record is `cancelled`, the same
 * terminal state a plain stop reaches, so the server's headline is what tells
 * the two apart: a stop leaves resources to decide about, a completed rollback
 * already removed them.
 */
function isCompletedRollback(op: OperationRecord | null): boolean {
  return (
    op !== null &&
    op.terminalState === "cancelled" &&
    op.headline !== null &&
    op.headline.code === ROLLBACK_COMPLETE_CODE
  );
}

/**
 * An outcome the customer only has to acknowledge. There is no resource
 * decision left, so the panel closes on a single OK instead of offering the
 * exit the customer of a stopped or failed attempt still needs.
 */
function isAcknowledgedOutcome(op: OperationRecord | null): boolean {
  return isSuccessfulSetup(op) || isCompletedRollback(op);
}

/**
 * A setup the customer closed through the exit command.
 *
 * The server removed what it could prove it created and recorded the decision
 * durably, so the panel stops rendering the record entirely: re-showing it after
 * a reload would put an abandoned attempt back on the page the customer just
 * cleared.
 */
function isExitedSetup(op: OperationRecord | null): boolean {
  return (
    op !== null &&
    op.headline !== null &&
    op.headline.code === SETUP_EXITED_CODE
  );
}

function operationsByRepoUrl(repo: string): string {
  return `${OPERATIONS_PATH}?repo=${encodeURIComponent(repo)}`;
}

function operationUrl(operationId: string): string {
  return `${OPERATIONS_PATH}/${encodeURIComponent(operationId)}`;
}

function diagnosticUrl(
  operationId: string,
  identifiers?: "preview" | "include",
  contextFingerprint?: string
): string {
  const base = `${operationUrl(operationId)}/diagnostics`;
  if (!identifiers) return base;
  return (
    `${base}?identifiers=${identifiers}` +
    (contextFingerprint ?
      `&contextFingerprint=${encodeURIComponent(contextFingerprint)}`
    : "")
  );
}

function resumeUrl(operationId: string, code: string): string {
  return `${operationUrl(operationId)}/resume/${encodeURIComponent(code)}`;
}

/**
 * Cancel an operation through the durable stop command. Stop is recorded
 * before the server answers, so a canvas reload cannot lose the cancellation
 * the way the fire-and-forget abandon route could.
 */
function stopUrl(operationId: string): string {
  return `${operationUrl(operationId)}/stop`;
}

function verifyStatusUrl(
  repo: string,
  environment: string,
  operationId: string
): string {
  return (
    `${VERIFY_STATUS_PATH}?repo=${encodeURIComponent(repo)}` +
    `&environment=${encodeURIComponent(environment)}` +
    `&operationId=${encodeURIComponent(operationId)}`
  );
}

/**
 * Create the environment operations controller. Returns `null` when the
 * progress panel is not present in the DOM (nothing to drive) or another
 * instance already owns this entry key, matching the return contract of the
 * other browser entry points in this package.
 */
export function initializeEnvironmentOperations(
  context: BrowserContext,
  options: EnvironmentOperationsOptions
): EnvironmentOperationsController | null {
  const dom = context.dom;
  const parseResponse = (payload: unknown): OperationRecord | null =>
    parseOperationResponse(payload, options.ghCommandPresentation);
  const maybePanel = dom.byId(PROGRESS_IDS.panel);
  if (!maybePanel) return null;
  // Rebound to a variable whose declared type already excludes `null`: the
  // nested function declarations below are hoisted, so TypeScript cannot
  // carry a narrowing of `maybePanel` into their bodies — only the static
  // type of the binding they close over.
  const panel: DomElement = maybePanel;
  const claimedScope = beginEntry(context, ENVIRONMENT_OPERATIONS_ENTRY_KEY);
  if (!claimedScope) return null;
  const scope = claimedScope;

  const { repo, deps } = options;

  let verifyActivity = "";
  let progressTimer: ScopeTimer | null = null;
  let elapsedTimer: ScopeTimer | null = null;
  let activeAbort: AbortHandle | null = null;
  const stepsElement = dom.byId(PROGRESS_IDS.steps);
  const detailsElement = dom.byId(PROGRESS_IDS.details);
  let followStepTail = true;
  let renderedOperationId = "";
  // Bumped at the start of every resumeProgress()/trackProgress() call. Async
  // work captures the value at its start and checks it before touching the
  // DOM or scheduling more work, so a response that outlives its session
  // (superseded by a newer track/resume call, or by teardown) is discarded
  // instead of overwriting state that belongs to a newer operation.
  let session = 0;

  function abortInFlight(): void {
    activeAbort?.abort();
    activeAbort = null;
  }

  scope.onTeardown(() => abortInFlight());

  if (stepsElement) {
    scope.on(stepsElement, "scroll", () => {
      followStepTail = dom.isScrolledToEnd(stepsElement);
    });
    if (detailsElement) {
      scope.on(detailsElement, "toggle", () => {
        if (detailsElement.getAttribute("open") !== null && followStepTail) {
          dom.scrollToEnd(stepsElement);
        }
      });
    }
  }

  function fetchTracked(
    url: string,
    init?: Omit<HttpRequestInit, "signal">
  ): Promise<HttpResponse> {
    const abort = context.net.createAbort();
    activeAbort = abort;
    return context.net
      .fetch(url, abort ? { ...init, signal: abort.signal } : init)
      .finally(() => {
        if (activeAbort === abort) activeAbort = null;
      });
  }

  /**
   * Drive the spinner from one fact: whether Radius is still working. Nothing
   * is polling once progress stops, so the animation stops with it rather than
   * outliving the work it describes.
   */
  function setPanelActive(active: boolean): void {
    panel.classList.toggle(PANEL_ACTIVE_CLASS, active);
  }

  function stopProgress(): void {
    verifyActivity = "";
    abortInFlight();
    setPanelActive(false);
    if (progressTimer !== null) {
      scope.cancel(progressTimer);
      progressTimer = null;
    }
    if (elapsedTimer !== null) {
      scope.cancel(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function hideProgress(): void {
    stopProgress();
    panel.style.display = "none";
  }

  function setFailureList(
    items: readonly string[],
    listEl: DomElement | null,
    blockEl: DomElement | null
  ): void {
    if (!listEl || !blockEl) return;
    if (items.length === 0) {
      setChildren(dom, listEl, []);
      blockEl.style.display = "none";
      return;
    }
    setChildren(
      dom,
      listEl,
      items.map((item) => ({ tag: "li", text: item }))
    );
    blockEl.style.display = "";
  }

  // The failure card is re-rendered on every poll, so the callout it hosts is
  // torn down and rebuilt with it rather than accumulating listeners.
  let failureAction: CommandActionHandle | null = null;

  function renderFailureCommand(remediation: RemediationView | null): void {
    failureAction?.dispose();
    failureAction = null;
    const host = dom.byId(PROGRESS_IDS.failureCommand);
    if (!host) return;
    host.replaceChildren();
    if (!remediation) {
      host.style.display = "none";
      return;
    }
    host.style.display = "";
    failureAction = createCommandAction(context, {
      host,
      remediation,
      mutationNonce: options.mutationNonce || "",
      idPrefix: "env-progress-failure-command"
    });
  }

  scope.onTeardown(() => {
    failureAction?.dispose();
    failureAction = null;
  });

  function renderFailureCard(op: OperationRecord | null): void {
    const card = dom.byId(PROGRESS_IDS.failureCard);
    const messageEl = dom.byId(PROGRESS_IDS.failureMessage);
    const cleanupEl = dom.byId(PROGRESS_IDS.cleanupStatus);
    const retryEl = dom.byId(PROGRESS_IDS.retry);
    if (!card || !messageEl || !cleanupEl || !retryEl) return;
    if (
      op === null ||
      (op.terminalState !== "failed" && op.terminalState !== "failed_partial")
    ) {
      // Clear the card as well as hiding it. A continuation reuses the same
      // panel, and a stale failure that reappears the next time the card is
      // shown would describe an attempt the customer already moved past.
      card.style.display = "none";
      messageEl.textContent = "";
      cleanupEl.textContent = "";
      retryEl.textContent = "";
      renderFailureCommand(null);
      setFailureList(
        [],
        dom.byId(PROGRESS_IDS.cleanupWarningsList),
        dom.byId(PROGRESS_IDS.cleanupWarningsBlock)
      );
      return;
    }

    const cleanup = op.cleanup;
    const cleanupStatus =
      cleanup.state === "running" ? "Cleanup is still running."
      : cleanup.state === "pending" ? "Cleanup has not started yet."
      : cleanup.rollbackBeforeCommit === false ?
        "Cleanup stopped at the commit point, so reusable artifacts were left in place."
      : cleanup.state === "succeeded_with_warnings" ?
        "Cleanup finished with warnings."
      : cleanup.state === "succeeded" ? "Cleanup finished."
      : "Cleanup was not needed.";

    messageEl.textContent =
      op.failure && op.failure.message !== "" ?
        op.failure.message
      : "The setup request failed.";
    renderFailureCommand(op.failure?.remediation ?? null);
    // The card names the outcome the customer actually reached. A rollback
    // that left resources behind is not a setup that failed to finish.
    const titleEl = dom.byId(PROGRESS_IDS.failureTitle);
    if (titleEl) {
      titleEl.textContent = op.headline?.title || DEFAULT_FAILURE_TITLE;
    }
    cleanupEl.textContent = cleanupStatus;
    retryEl.textContent =
      cleanup.retry.guidance !== "" ?
        `Retry starts cleanly: ${cleanup.retry.startsCleanly ? "Yes" : "No"}. ${cleanup.retry.guidance}`
      : "";
    // Only the warnings live on the card. What exists after the attempt is the
    // disjoint inventory below, which says whether Radius intends to reuse a
    // resource or has left it behind — a distinction a second flat list of the
    // same targets can only blur.
    setFailureList(
      cleanup.warnings,
      dom.byId(PROGRESS_IDS.cleanupWarningsList),
      dom.byId(PROGRESS_IDS.cleanupWarningsBlock)
    );
    card.style.display = "";
  }

  // ---------------- Partial state and operation commands ----------------

  let commandInFlight = false;
  let commandOperationId = "";
  // Command buttons are rebuilt on every render, so their listeners are
  // tracked separately from the entry scope and released before each rebuild.
  // Registering them on the scope would grow its registry once per poll.
  let commandButtons: CommandButton[] = [];

  function releaseCommandButtons(): void {
    for (const entry of commandButtons.splice(0)) {
      entry.element.removeEventListener("click", entry.listener);
    }
  }

  scope.onTeardown(releaseCommandButtons);

  function setStateList(
    items: readonly string[],
    listId: string,
    blockId: string
  ): boolean {
    const listEl = dom.byId(listId);
    const blockEl = dom.byId(blockId);
    if (!listEl || !blockEl) return false;
    if (items.length === 0) {
      setChildren(dom, listEl, []);
      blockEl.style.display = "none";
      return false;
    }
    // Server-built safe labels, but still built as text nodes: a display name
    // is customer data and is never ours to trust as markup.
    setChildren(
      dom,
      listEl,
      items.map((item) => ({ tag: "li", text: item }))
    );
    blockEl.style.display = "";
    return true;
  }

  function renderPartialState(op: OperationRecord | null): void {
    const statePanel = dom.byId(PROGRESS_IDS.partialState);
    if (!statePanel) return;
    // The inventory is for a terminal decision — continue or roll back. While
    // work is still running (including a rollback that is still deleting) it
    // is a moving list the customer cannot act on, and once the attempt
    // succeeded or the rollback finished there is no decision left to make.
    if (op === null || op.terminalState === null || isAcknowledgedOutcome(op)) {
      statePanel.style.display = "none";
      return;
    }
    const cleanup = op.cleanup;
    const shown = [
      ...PARTIAL_STATE_GROUPS.map((entry) =>
        setStateList(
          cleanup[entry.group].map((item) =>
            item.detail === "" ? item.target : `${item.target} — ${item.detail}`
          ),
          entry.list,
          entry.block
        )
      ),
      setStateList(
        cleanup.manualActionRequired.map((entry) =>
          entry.action === "" ?
            entry.target
          : `${entry.target} — ${entry.action}`
        ),
        PROGRESS_IDS.stateManualList,
        PROGRESS_IDS.stateManualBlock
      )
    ].some(Boolean);
    statePanel.style.display = shown ? "" : "none";
  }

  function setCommandBusy(busy: boolean): void {
    commandInFlight = busy;
    const container = dom.byId(PROGRESS_IDS.commands);
    if (container) container.setAttribute("aria-busy", busy ? "true" : "false");
    for (const entry of commandButtons) entry.element.disabled = busy;
  }

  function setCommandStatus(message: string): void {
    const el = dom.byId(PROGRESS_IDS.commandStatus);
    if (el && el.textContent !== message) el.textContent = message;
  }

  function setCommandError(message: string): void {
    const el = dom.byId(PROGRESS_IDS.commandError);
    if (el) el.textContent = message;
  }

  /**
   * Take down the landing's setup-failure banner.
   *
   * The banner states that environment setup failed. Once a rollback is under
   * way that sentence is about a decision the customer has already moved past,
   * and leaving it above a panel reporting a completed rollback tells them
   * their environment is both broken and cleaned up.
   */
  function hideErrorBanner(): void {
    const banner = dom.byId(ERROR_BANNER_ID);
    if (banner) banner.style.display = "none";
  }

  // ---------------- Diagnostic snapshot review ----------------

  let diagnosticOperationId = "";
  let diagnosticReturnFocus: DomElement | null = null;
  let diagnosticKeydownBound = false;
  let diagnosticContextReady = false;
  let diagnosticContextFingerprint = "";
  let diagnosticPreviewGeneration = 0;
  let diagnosticPreviewAbort: AbortHandle | null = null;
  let diagnosticDownloadGeneration = 0;
  let diagnosticDownloadAbort: AbortHandle | null = null;
  let diagnosticDownloadBusy = false;

  function setDiagnosticStatus(message: string): void {
    const status = dom.byId(DIAGNOSTIC_IDS.status);
    if (status) status.textContent = message;
  }

  function setDiagnosticError(message: string): void {
    const error = dom.byId(DIAGNOSTIC_IDS.error);
    if (error) error.textContent = message;
  }

  function setDiagnosticDownload(url: string): void {
    const download = dom.byId(DIAGNOSTIC_IDS.download);
    if (!download) return;
    if (url === "") {
      download.removeAttribute("href");
      download.setAttribute("aria-disabled", "true");
      return;
    }
    download.setAttribute("href", url);
    download.setAttribute("aria-disabled", "false");
  }

  function diagnosticFocusable(dialog: DomElement): readonly DomElement[] {
    return dom.all(
      dialog,
      "button:not([disabled]), input:not([disabled]), a[href]"
    );
  }

  const diagnosticKeydown: DomEventListener = (event) => {
    const dialog = dom.byId(DIAGNOSTIC_IDS.modal);
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDiagnosticDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = diagnosticFocusable(dialog);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = context.focus.active();
    if (event.shiftKey === true && (active === first || active === null)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (event.shiftKey !== true && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function bindDiagnosticKeydown(): void {
    if (diagnosticKeydownBound) return;
    dom.document.addEventListener("keydown", diagnosticKeydown);
    diagnosticKeydownBound = true;
  }

  function unbindDiagnosticKeydown(): void {
    if (!diagnosticKeydownBound) return;
    dom.document.removeEventListener("keydown", diagnosticKeydown);
    diagnosticKeydownBound = false;
  }

  function abortDiagnosticPreview(): void {
    diagnosticPreviewGeneration += 1;
    diagnosticPreviewAbort?.abort();
    diagnosticPreviewAbort = null;
  }

  function abortDiagnosticDownload(): void {
    diagnosticDownloadGeneration += 1;
    diagnosticDownloadAbort?.abort();
    diagnosticDownloadAbort = null;
    diagnosticDownloadBusy = false;
  }

  function dismissDiagnosticDialog(): void {
    const dialog = dom.byId(DIAGNOSTIC_IDS.modal);
    if (dialog) dialog.style.display = "none";
    abortDiagnosticPreview();
    abortDiagnosticDownload();
    unbindDiagnosticKeydown();
    diagnosticContextReady = false;
    diagnosticContextFingerprint = "";
  }

  function closeDiagnosticDialog(): void {
    dismissDiagnosticDialog();
    const trigger = diagnosticReturnFocus;
    diagnosticReturnFocus = null;
    context.focus.focus(trigger);
  }

  function renderDiagnosticContext(identifiers: DiagnosticContext): void {
    const values: ReadonlyArray<readonly [string, string | null]> = [
      [DIAGNOSTIC_IDS.repository, identifiers.repository],
      [DIAGNOSTIC_IDS.branch, identifiers.branch],
      [DIAGNOSTIC_IDS.environment, identifiers.environment],
      [DIAGNOSTIC_IDS.githubLogin, identifiers.githubLogin]
    ];
    for (const [id, value] of values) {
      const element = dom.byId(id);
      if (element) element.textContent = value ?? "Not available";
    }
    setDiagnosticStatus(
      identifiers.omittedFieldCount === 0 ?
        "Review the identifiers, then confirm that you reviewed them."
      : `${identifiers.omittedFieldCount} contextual identifier${
          identifiers.omittedFieldCount === 1 ? " is" : "s are"
        } unavailable. Review the remaining values before downloading.`
    );
  }

  function refreshDiagnosticDownload(): void {
    const include = dom.inputById(DIAGNOSTIC_IDS.includeIdentifiers);
    const reviewed = dom.inputById(DIAGNOSTIC_IDS.reviewedIdentifiers);
    if (diagnosticOperationId === "") {
      setDiagnosticDownload("");
      return;
    }
    if (include?.checked !== true) {
      setDiagnosticDownload(diagnosticUrl(diagnosticOperationId));
      return;
    }
    if (diagnosticDownloadBusy) {
      setDiagnosticDownload("");
      return;
    }
    setDiagnosticDownload(
      diagnosticContextReady && reviewed?.checked === true ?
        diagnosticUrl(
          diagnosticOperationId,
          "include",
          diagnosticContextFingerprint
        )
      : ""
    );
  }

  function loadDiagnosticContext(): void {
    const preview = dom.byId(DIAGNOSTIC_IDS.preview);
    const reviewed = dom.inputById(DIAGNOSTIC_IDS.reviewedIdentifiers);
    if (preview) preview.style.display = "";
    if (reviewed) reviewed.checked = false;
    diagnosticContextReady = false;
    diagnosticContextFingerprint = "";
    refreshDiagnosticDownload();
    setDiagnosticError("");
    setDiagnosticStatus("Loading contextual identifiers…");
    abortDiagnosticPreview();
    const generation = diagnosticPreviewGeneration;
    const abort = context.net.createAbort();
    diagnosticPreviewAbort = abort;
    void context.net
      .fetch(
        diagnosticUrl(diagnosticOperationId, "preview"),
        abort ?
          { cache: "no-store", signal: abort.signal }
        : { cache: "no-store" }
      )
      .then((response) => {
        if (!response.ok) throw new Error("preview request failed");
        return response.json();
      })
      .then((payload) => {
        if (generation !== diagnosticPreviewGeneration) return;
        const preview = parseDiagnosticContext(payload);
        if (!preview) throw new Error("preview response was invalid");
        diagnosticContextReady = true;
        diagnosticContextFingerprint = preview.fingerprint;
        renderDiagnosticContext(preview.identifiers);
        refreshDiagnosticDownload();
      })
      .catch((error: unknown) => {
        if (generation !== diagnosticPreviewGeneration) return;
        context.logger.error(
          "Radius could not preview diagnostic identifiers.",
          error
        );
        setDiagnosticStatus("");
        setDiagnosticError(
          "Radius could not load the contextual identifiers. Download the support-safe snapshot or try again."
        );
      })
      .finally(() => {
        if (diagnosticPreviewAbort === abort) diagnosticPreviewAbort = null;
      });
  }

  function handleDiagnosticIdentifierChoice(): void {
    const include = dom.inputById(DIAGNOSTIC_IDS.includeIdentifiers);
    const preview = dom.byId(DIAGNOSTIC_IDS.preview);
    const reviewed = dom.inputById(DIAGNOSTIC_IDS.reviewedIdentifiers);
    if (include?.checked === true) {
      loadDiagnosticContext();
      return;
    }
    abortDiagnosticPreview();
    abortDiagnosticDownload();
    diagnosticContextReady = false;
    diagnosticContextFingerprint = "";
    if (preview) preview.style.display = "none";
    if (reviewed) reviewed.checked = false;
    setDiagnosticStatus("");
    setDiagnosticError("");
    refreshDiagnosticDownload();
  }

  function openDiagnosticDialog(): void {
    const dialog = dom.byId(DIAGNOSTIC_IDS.modal);
    const trigger = dom.byId(DIAGNOSTIC_IDS.open);
    if (!dialog || !trigger || diagnosticOperationId === "") return;
    diagnosticReturnFocus = trigger;
    const include = dom.inputById(DIAGNOSTIC_IDS.includeIdentifiers);
    const reviewed = dom.inputById(DIAGNOSTIC_IDS.reviewedIdentifiers);
    const preview = dom.byId(DIAGNOSTIC_IDS.preview);
    if (include) include.checked = false;
    if (reviewed) reviewed.checked = false;
    if (preview) preview.style.display = "none";
    diagnosticContextReady = false;
    diagnosticContextFingerprint = "";
    setDiagnosticStatus("");
    setDiagnosticError("");
    refreshDiagnosticDownload();
    dialog.style.display = "flex";
    bindDiagnosticKeydown();
    dom.byId(DIAGNOSTIC_IDS.title)?.focus();
  }

  function handleDiagnosticDownload(
    download: DomElement,
    event: Parameters<DomEventListener>[0]
  ): void {
    if (diagnosticDownloadBusy) {
      event.preventDefault();
      return;
    }
    const url = download.getAttribute("href");
    if (url === null) {
      event.preventDefault();
      setDiagnosticError(
        "Review the contextual identifiers before downloading this snapshot."
      );
      dom.inputById(DIAGNOSTIC_IDS.reviewedIdentifiers)?.focus();
      return;
    }
    const include = dom.inputById(DIAGNOSTIC_IDS.includeIdentifiers);
    if (include?.checked === true) {
      event.preventDefault();
      abortDiagnosticDownload();
      diagnosticDownloadBusy = true;
      refreshDiagnosticDownload();
      setDiagnosticError("");
      setDiagnosticStatus("Confirming the reviewed identifiers…");
      const generation = diagnosticDownloadGeneration;
      const abort = context.net.createAbort();
      diagnosticDownloadAbort = abort;
      void context.net
        .fetch(
          url,
          abort ?
            { cache: "no-store", signal: abort.signal }
          : { cache: "no-store" }
        )
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(
              response.status === 409 ? "context-changed" : "download-failed"
            );
          }
          const text = await response.text();
          if (generation !== diagnosticDownloadGeneration) return;
          if (
            !context.download.save(
              text,
              "application/json",
              DIAGNOSTIC_FILENAME
            )
          ) {
            throw new Error("download-unavailable");
          }
        })
        .then(() => {
          if (generation !== diagnosticDownloadGeneration) return;
          setDiagnosticStatus("Diagnostic snapshot download started.");
        })
        .catch((error: unknown) => {
          if (generation !== diagnosticDownloadGeneration) return;
          const code = error instanceof Error ? error.message : "";
          if (code === "context-changed") {
            const reviewed = dom.inputById(DIAGNOSTIC_IDS.reviewedIdentifiers);
            if (reviewed) reviewed.checked = false;
            diagnosticContextReady = false;
            diagnosticContextFingerprint = "";
            loadDiagnosticContext();
            setDiagnosticError(
              "The contextual identifiers changed. Review the updated values before downloading."
            );
            return;
          }
          context.logger.error(
            "Radius could not download contextual diagnostics.",
            error
          );
          setDiagnosticStatus("");
          setDiagnosticError(
            code === "download-unavailable" ?
              "This host could not save the contextual diagnostic snapshot."
            : "Radius could not download the contextual diagnostic snapshot. Try again."
          );
        })
        .finally(() => {
          if (generation !== diagnosticDownloadGeneration) return;
          diagnosticDownloadAbort = null;
          diagnosticDownloadBusy = false;
          refreshDiagnosticDownload();
        });
      return;
    }
    setDiagnosticError("");
    setDiagnosticStatus("Diagnostic snapshot download started.");
  }

  const diagnosticOpen = dom.byId(DIAGNOSTIC_IDS.open);
  if (diagnosticOpen) scope.on(diagnosticOpen, "click", openDiagnosticDialog);
  const diagnosticInclude = dom.byId(DIAGNOSTIC_IDS.includeIdentifiers);
  if (diagnosticInclude)
    scope.on(diagnosticInclude, "change", handleDiagnosticIdentifierChoice);
  const diagnosticReviewed = dom.byId(DIAGNOSTIC_IDS.reviewedIdentifiers);
  if (diagnosticReviewed)
    scope.on(diagnosticReviewed, "change", refreshDiagnosticDownload);
  const diagnosticCancel = dom.byId(DIAGNOSTIC_IDS.cancel);
  if (diagnosticCancel)
    scope.on(diagnosticCancel, "click", closeDiagnosticDialog);
  const diagnosticDownload = dom.byId(DIAGNOSTIC_IDS.download);
  if (diagnosticDownload)
    scope.on(diagnosticDownload, "click", (event) =>
      handleDiagnosticDownload(diagnosticDownload, event)
    );
  scope.onTeardown(() => {
    dismissDiagnosticDialog();
    diagnosticReturnFocus = null;
  });

  // ---------------- Rollback confirmation ----------------
  //
  // Removing cloud resources cannot be undone, so the destructive command is
  // confirmed first against the server's own preview. The dialog never rebuilds
  // that list: it renders exactly what the operation record projected, and the
  // server re-derives the deletion set again before it acts.

  let rollbackPending: {
    readonly action: OperationAction;
    readonly op: OperationRecord;
  } | null = null;
  let rollbackReturnFocus: DomElement | null = null;
  let rollbackKeydownBound = false;

  function setRollbackList(
    items: readonly string[],
    listId: string,
    blockId: string
  ): void {
    setStateList(items, listId, blockId);
  }

  function rollbackFocusable(dialog: DomElement): readonly DomElement[] {
    return dom.all(dialog, "button:not([disabled])");
  }

  // Focus stays inside the dialog while it is open. A Tab that escapes to the
  // page behind a modal leaves a keyboard user operating controls they cannot
  // see, which is the specific failure the trap exists to prevent.
  const rollbackKeydown: DomEventListener = (event) => {
    const dialog = dom.byId(ROLLBACK_IDS.modal);
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeRollbackDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = rollbackFocusable(dialog);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = context.focus.active();
    if (event.shiftKey === true && (active === first || active === null)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (event.shiftKey !== true && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function bindRollbackKeydown(): void {
    if (rollbackKeydownBound) return;
    dom.document.addEventListener("keydown", rollbackKeydown);
    rollbackKeydownBound = true;
  }

  function unbindRollbackKeydown(): void {
    if (!rollbackKeydownBound) return;
    dom.document.removeEventListener("keydown", rollbackKeydown);
    rollbackKeydownBound = false;
  }

  scope.onTeardown(unbindRollbackKeydown);

  function openRollbackDialog(
    action: OperationAction,
    op: OperationRecord,
    trigger: DomElement
  ): void {
    const dialog = dom.byId(ROLLBACK_IDS.modal);
    if (!dialog) {
      // No dialog markup means no confirmation, and an unconfirmed destructive
      // command is worse than no command at all.
      setCommandError(ROLLBACK_UNAVAILABLE_MESSAGE);
      return;
    }
    rollbackPending = { action, op };
    rollbackReturnFocus = trigger;
    const preview = action.preview?.type === "rollback" ? action.preview : null;
    const titleEl = dom.byId(ROLLBACK_IDS.title);
    if (titleEl) {
      titleEl.textContent = action.confirmTitle || DEFAULT_ROLLBACK_TITLE;
    }
    const introEl = dom.byId(ROLLBACK_IDS.intro);
    if (introEl) introEl.textContent = action.description;
    setRollbackList(
      (preview?.removes ?? []).map(previewResourceLabel),
      ROLLBACK_IDS.removeList,
      ROLLBACK_IDS.removeBlock
    );
    setRollbackList(
      (preview?.keeps ?? []).map(previewEntryLabel),
      ROLLBACK_IDS.keepList,
      ROLLBACK_IDS.keepBlock
    );
    setRollbackList(
      (preview?.manualActionRequired ?? []).map(previewEntryLabel),
      ROLLBACK_IDS.manualList,
      ROLLBACK_IDS.manualBlock
    );
    const confirm = dom.inputById(ROLLBACK_IDS.confirm);
    if (confirm) {
      confirm.disabled = false;
      confirm.textContent = action.confirmLabel || DEFAULT_ROLLBACK_CONFIRM;
    }
    const cancel = dom.byId(ROLLBACK_IDS.cancel);
    if (cancel) {
      cancel.textContent = action.cancelLabel || DEFAULT_ROLLBACK_CANCEL;
    }
    dialog.style.display = "flex";
    bindRollbackKeydown();
    titleEl?.focus();
  }

  function dismissRollbackDialog(): void {
    const dialog = dom.byId(ROLLBACK_IDS.modal);
    if (dialog) dialog.style.display = "none";
    unbindRollbackKeydown();
    rollbackPending = null;
  }

  function closeRollbackDialog(): void {
    dismissRollbackDialog();
    const trigger = rollbackReturnFocus;
    rollbackReturnFocus = null;
    // Focus returns to the control that opened the dialog, so cancelling puts
    // a keyboard user back exactly where they were.
    context.focus.focus(trigger);
  }

  function confirmRollback(): void {
    const pending = rollbackPending;
    if (!pending) return;
    // Disabled before the request goes out: a second confirmation would be a
    // second delete request against the same ledger.
    const confirm = dom.inputById(ROLLBACK_IDS.confirm);
    if (confirm) confirm.disabled = true;
    dismissRollbackDialog();
    rollbackReturnFocus = null;
    // The control that opened the dialog may be replaced by the command response,
    // so confirmation returns to the stable panel heading rather than leaving
    // focus on a button inside the now-hidden dialog.
    focusPanel();
    sendCommand(pending.action, pending.op);
  }

  const rollbackCancel = dom.byId(ROLLBACK_IDS.cancel);
  if (rollbackCancel) scope.on(rollbackCancel, "click", closeRollbackDialog);
  const rollbackConfirm = dom.byId(ROLLBACK_IDS.confirm);
  if (rollbackConfirm) scope.on(rollbackConfirm, "click", confirmRollback);

  function pollOperation(operationId: string): void {
    void fetchTracked(operationUrl(operationId), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const op = parseResponse(payload);
        if (op) renderProgress(op);
      })
      .catch(() => {
        /* the poller keeps the panel current */
      });
  }

  /**
   * Route a pressed control. A destructive command is confirmed against the
   * server's own preview first; everything else goes straight out.
   */
  function submitCommand(
    action: OperationAction,
    op: OperationRecord,
    trigger: DomElement
  ): void {
    if (commandInFlight) return;
    if (action.requiresConfirmation) {
      openRollbackDialog(action, op, trigger);
      return;
    }
    sendCommand(action, op);
  }

  function sendCommand(action: OperationAction, op: OperationRecord): void {
    if (commandInFlight) return;
    const commandSession = session;
    const commandIsActive = (): boolean =>
      scope.active && commandSession === session;
    setCommandError("");
    setCommandBusy(true);
    setCommandStatus(commandStatusText(action));
    void fetchTracked(action.path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Mutation-Nonce": options.mutationNonce || ""
      },
      body: "{}"
    })
      .then((response) =>
        response
          .json()
          .catch(() => ({}))
          .then((payload) => ({ ok: response.ok, payload }))
      )
      .then((result) => {
        if (!commandIsActive()) return;
        setCommandBusy(false);
        const updated = parseResponse(result.payload);
        if (!result.ok) {
          setCommandStatus("");
          setCommandError(
            readString(result.payload, "error") || COMMAND_REFUSED_MESSAGE
          );
          if (updated) renderProgress(updated);
          focusPanel();
          return;
        }
        if (updated) renderProgress(updated);
        // A cleaning command that the server accepted supersedes the failure
        // the page is still reporting: the banner comes down now rather than
        // when the rollback ends, and the listing is refreshed because the
        // resources behind those rows are already being removed.
        if (CLEANING_COMMAND_KINDS.has(action.kind)) {
          hideErrorBanner();
          deps.reloadEnvironmentsTable();
        }
        // Keep following the same operation. A command that reopened the
        // record rejoins the poller; one that closed it reports its terminal
        // result.
        if (updated && updated.terminalState !== null) {
          stopProgress();
          applyTerminal(updated);
          return;
        }
        if (repo !== "") {
          trackProgress(op.environment, op.provider, applyTerminal);
          return;
        }
        pollOperation(op.operationId);
      })
      .catch(() => {
        if (!commandIsActive()) return;
        setCommandBusy(false);
        setCommandStatus("");
        setCommandError(COMMAND_UNREACHABLE_MESSAGE);
      });
  }

  /**
   * Why a path the customer might expect is missing. Silence reads as a bug,
   * so every refusal a customer can reach gets a sentence.
   */
  function renderCommandGuidance(op: OperationRecord | null): boolean {
    const list = dom.byId(PROGRESS_IDS.commandGuidance);
    if (!list) return false;
    const notes =
      (
        op?.terminalState === "succeeded" ||
        op?.terminalState === "succeeded_with_warnings"
      ) ?
        []
      : (op?.guidance ?? []);
    if (notes.length === 0) {
      setChildren(dom, list, []);
      list.style.display = "none";
      return false;
    }
    setChildren(
      dom,
      list,
      notes.map((note) => ({ tag: "li", text: note.message }))
    );
    list.style.display = "";
    return true;
  }

  /** Build one server-projected control and track it for the next rebuild. */
  function createCommandButton(
    action: OperationAction,
    record: OperationRecord
  ): DomInputElement {
    const element = dom.createElement("button") as DomInputElement;
    element.setAttribute("type", "button");
    element.id = `env-progress-command-${action.id}`;
    element.className = COMMAND_TONE_CLASS[action.tone] ?? COMMAND_BUTTON_CLASS;
    element.textContent = action.label === "" ? "Continue" : action.label;
    element.disabled = commandInFlight || action.pending;
    if (action.description !== "") {
      element.setAttribute("title", action.description);
      const descriptionId = `${element.id}-description`;
      element.setAttribute("aria-describedby", descriptionId);
      const description = dom.createElement("span");
      description.id = descriptionId;
      description.className = "env-progress__command-description";
      description.textContent = action.description;
      dom.byId(PROGRESS_IDS.commandDescriptions)?.appendChild(description);
    }
    if (action.requiresConfirmation) {
      element.setAttribute("aria-haspopup", "dialog");
    }
    const listener = (): void => submitCommand(action, record, element);
    element.addEventListener("click", listener);
    commandButtons.push({ element, listener });
    return element;
  }

  /**
   * The bottom row, below the details disclosure.
   *
   * It holds the way out of the panel — today the server-projected **Exit
   * setup** — beside the acknowledgement an already-settled outcome closes on.
   * Leaving is a command Radius acts on, so it is rendered from the record like
   * every other control rather than being a local dismissal.
   */
  function renderBottomActions(op: OperationRecord | null): void {
    const actionsEl = dom.byId(PROGRESS_IDS.actions);
    const bottomEl = dom.byId(PROGRESS_IDS.bottomButtons);
    const dismissEl = dom.byId(PROGRESS_IDS.dismiss);
    if (bottomEl) bottomEl.replaceChildren();
    const acknowledged = isAcknowledgedOutcome(op);
    if (dismissEl) {
      dismissEl.textContent = acknowledged ? "OK" : "Dismiss";
      dismissEl.style.display = acknowledged ? "" : "none";
    }
    const bottomActions =
      op === null || acknowledged ?
        []
      : op.actions.filter((action) => action.placement === "bottom");
    if (bottomEl && op !== null) {
      for (const action of bottomActions) {
        bottomEl.appendChild(createCommandButton(action, op));
      }
    }
    if (actionsEl) {
      actionsEl.style.display =
        acknowledged || bottomActions.length > 0 ? "flex" : "none";
    }
  }

  function renderCommands(op: OperationRecord | null): void {
    const container = dom.byId(PROGRESS_IDS.commands);
    const buttons = dom.byId(PROGRESS_IDS.commandButtons);
    const note = dom.byId(PROGRESS_IDS.commandNote);
    const descriptions = dom.byId(PROGRESS_IDS.commandDescriptions);
    if (!container || !buttons || !note) return;
    descriptions?.replaceChildren();
    const actions = op?.actions ?? [];
    const rowActions = actions.filter(
      (action) => action.placement !== "bottom"
    );
    if (op !== null && op.operationId !== commandOperationId) {
      commandOperationId = op.operationId;
      setCommandError("");
      setCommandStatus("");
    }
    if (op !== null && op.terminalState !== null) {
      setCommandBusy(false);
      setCommandStatus("");
    }
    const activeCommand = context.focus.active();
    const focusedCommandId =
      commandButtons.find((entry) => entry.element === activeCommand)?.element
        .id ?? "";
    releaseCommandButtons();
    buttons.replaceChildren();
    const hasGuidance = renderCommandGuidance(op);
    renderBottomActions(op);
    const restoreCommandFocus = (): void => {
      if (focusedCommandId === "") return;
      const replacement = commandButtons.find(
        (entry) => entry.element.id === focusedCommandId
      )?.element;
      if (replacement && !replacement.disabled) {
        replacement.focus();
        return;
      }
      const fallback =
        container.style.display === "none" ?
          (dom.byId(PROGRESS_IDS.title) ?? panel)
        : container;
      fallback.setAttribute("tabindex", "-1");
      context.focus.focus(fallback);
    };
    if (op === null || rowActions.length === 0) {
      // A record with no command still has something to say: cleanup running
      // under its own command, or a state whose next move is automatic.
      const transitionMessage =
        op?.terminalState === null ? (op?.nextTransition?.message ?? "") : "";
      if (op?.nextTransition) note.textContent = transitionMessage;
      else if (!hasGuidance) note.textContent = "";
      container.style.display =
        hasGuidance || op?.nextTransition || op?.terminalState !== null ?
          ""
        : "none";
      restoreCommandFocus();
      return;
    }
    const record = op;
    for (const action of rowActions) {
      buttons.appendChild(createCommandButton(action, record));
    }
    const transition = record.nextTransition?.message ?? "";
    note.textContent = transition;
    if (rowActions.some((action) => action.kind === "stop" && action.pending)) {
      setCommandStatus(STOPPING_MESSAGE);
    }
    container.style.display = "";
    restoreCommandFocus();
  }

  /**
   * The heading line. A stop, a running rollback, and a rollback that left
   * something behind each need their own words; a plain setup keeps its
   * summary.
   */
  function renderHeadline(op: OperationRecord | null): void {
    const headline = op?.headline ?? null;
    const titleEl = dom.byId(PROGRESS_IDS.title);
    if (titleEl) titleEl.textContent = headline?.title || op?.summary || "";
    const noteEl = dom.byId(PROGRESS_IDS.headlineNote);
    if (!noteEl) return;
    const message = headline?.message ?? "";
    noteEl.textContent = message;
    noteEl.style.display = message === "" ? "none" : "";
  }

  function renderDiagnostics(op: OperationRecord | null): boolean {
    const container = dom.byId(PROGRESS_IDS.diagnostics);
    const open = dom.byId(DIAGNOSTIC_IDS.open);
    if (!container || !open) return false;
    const available =
      op !== null &&
      !isExitedSetup(op) &&
      (op.terminalState !== null ||
        op.state === "input_required" ||
        op.actions.some(
          (action) => action.kind === "stop" && action.pending === true
        ));
    if (!available) {
      if (diagnosticOperationId !== "") {
        dismissDiagnosticDialog();
        diagnosticReturnFocus = null;
      }
      diagnosticOperationId = "";
      container.style.display = "none";
      return false;
    }
    if (
      diagnosticOperationId !== "" &&
      diagnosticOperationId !== op.operationId
    ) {
      dismissDiagnosticDialog();
      diagnosticReturnFocus = null;
    }
    diagnosticOperationId = op.operationId;
    container.style.display = "flex";
    return true;
  }

  function renderProgress(op: OperationRecord | null): void {
    const hasDiagnostics = renderDiagnostics(op);
    // An exited setup renders as nothing at all. The record survives for the
    // history, but the customer closed it, and a poll or a page reload that put
    // the panel back would undo the one thing Exit setup promised.
    if (op === null || isExitedSetup(op)) {
      panel.style.display = "none";
      setPanelActive(false);
      renderFailureCard(null);
      renderPartialState(null);
      renderCommands(null);
      renderHeadline(null);
      return;
    }
    if (renderedOperationId !== op.operationId) {
      renderedOperationId = op.operationId;
      followStepTail = true;
    }
    panel.style.display = "";
    setPanelActive(op.terminalState === null);
    const done =
      op.terminalState === "succeeded" ||
      op.terminalState === "succeeded_with_warnings" ||
      op.terminalState === "action_required";
    const failed =
      op.terminalState === "failed" || op.terminalState === "failed_partial";
    panel.classList.toggle("env-progress--done", done);
    panel.classList.toggle("env-progress--failed", failed);
    // A rollback in progress is not a setup in progress, and the spinner has
    // to say so without relying on colour alone.
    panel.classList.toggle(
      "env-progress--cleaning",
      CLEANING_COMMAND_KINDS.has(op.activeCommandKind)
    );

    renderHeadline(op);

    // The current step doubles as the activity line. When the record has
    // nothing to say we clear it rather than substitute filler.
    let activity = "";
    for (let index = op.steps.length - 1; index >= 0; index -= 1) {
      if (op.steps[index].state === "running") {
        activity = op.steps[index].label;
        break;
      }
    }
    if (activity === "" && op.steps.length > 0) {
      activity = op.steps[op.steps.length - 1].label;
    }
    if (
      op.currentStage === "verify" &&
      verifyActivity !== "" &&
      op.terminalState === null
    ) {
      activity = `Verifying credentials — ${verifyActivity}`;
    }
    if (op.failure && op.failure.message !== "") activity = op.failure.message;
    const activityEl = dom.byId(PROGRESS_IDS.activity);
    if (activityEl) activityEl.textContent = activity;

    const stagesEl = dom.byId(PROGRESS_IDS.stages);
    if (stagesEl) setChildren(dom, stagesEl, op.stages.map(stageSpec));
    if (stepsElement) {
      setChildren(dom, stepsElement, op.steps.map(stepSpec));
      if (followStepTail) dom.scrollToEnd(stepsElement);
    }

    renderFailureCard(op);
    renderPartialState(op);
    renderCommands(op);

    if (detailsElement) {
      detailsElement.style.display =
        op.steps.length > 0 || hasDiagnostics ? "" : "none";
    }
  }

  function focusPanel(): void {
    // The original called `panel.focus({ preventScroll: true })` with a
    // fallback to plain `focus()`; `DomElement.focus()` in this package's
    // browser port takes no options, so the plain call is the only one
    // available here.
    panel.focus();
    const reduceMotion = deps.prefersReducedMotion?.() ?? false;
    panel.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start"
    });
  }

  function resetSubmitButton(): void {
    if (deps.resetSubmitButton) {
      deps.resetSubmitButton();
      return;
    }
    const button = dom.inputById(DEPLOY_BUTTON_ID);
    if (button) {
      button.textContent = DEPLOY_BUTTON_IDLE_LABEL;
      button.disabled = false;
    }
  }

  function syncFailureOperation(data: unknown): Promise<boolean> {
    const operationId = readString(data, "operationId");
    if (operationId === "") return Promise.resolve(false);
    return fetchTracked(operationUrl(operationId))
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const op = parseResponse(payload);
        if (!op) return false;
        renderProgress(op);
        focusPanel();
        const detailsEl = dom.byId(PROGRESS_IDS.details);
        if (
          detailsEl &&
          (op.terminalState === "failed" ||
            op.terminalState === "failed_partial")
        ) {
          detailsEl.setAttribute("open", "");
        }
        hideErrorBanner();
        return true;
      })
      .catch(() => false);
  }

  function applyTerminal(op: OperationRecord): void {
    // Every branch below describes a finished operation, so the spinner stops
    // here too — applyTerminal is reachable without a preceding render (an
    // expired input prompt resolves straight to its terminal record).
    setPanelActive(false);
    resetSubmitButton();
    // A setup the customer exited has no outcome to announce: the panel closes,
    // the failure banner it replaced comes down, and the table is reloaded
    // because the server has just finished removing what this attempt created.
    if (isExitedSetup(op)) {
      context.focus.focus(dom.byId(NEW_ENVIRONMENT_BUTTON_ID));
      hideProgress();
      hideErrorBanner();
      deps.reloadEnvironmentsTable();
      return;
    }
    const warnings = op.steps
      .filter((step) => step.state === "warning")
      .map((step) => `⚠️ ${step.label}`);
    if (op.terminalState === "action_required") {
      deps.showSetupWarnings(warnings);
      const pullRequestUrl = readString(op.terminal, "pullRequestUrl");
      deps.showActionRequired(
        op.provider,
        op.environment,
        pullRequestUrl,
        op.terminal
      );
    } else if (
      op.terminalState === "succeeded" ||
      op.terminalState === "succeeded_with_warnings"
    ) {
      deps.showSuccessBanner(op.provider, op.environment);
      deps.showSetupWarnings(warnings);
    } else if (op.terminalState === "cancelled") {
      panel.classList.remove(
        "env-progress--done",
        "env-progress--failed",
        "env-progress--cleaning"
      );
      // A stop or a completed rollback is the outcome the page now reports, so
      // any setup-failure banner that preceded it stays down.
      hideErrorBanner();
      const cancelledActivity = dom.byId(PROGRESS_IDS.activity);
      // Stopped and rolled-back are different outcomes, and the server names
      // which one this is. Only fall back when it does not.
      if (cancelledActivity) {
        cancelledActivity.textContent =
          op.headline?.message || CANCELLED_ACTIVITY_MESSAGE;
      }
      deps.showSetupWarnings(warnings);
    } else if (
      op.terminalState === "failed_partial" &&
      op.headline !== null &&
      op.headline.code === "rollback-incomplete"
    ) {
      // A rollback that left something behind is not a failed setup, so it
      // does not get the failure banner that would tell the customer their
      // environment creation broke — and it takes down the one the failed
      // setup already raised.
      panel.classList.remove("env-progress--done", "env-progress--cleaning");
      panel.classList.add("env-progress--failed");
      hideErrorBanner();
      const partialActivity = dom.byId(PROGRESS_IDS.activity);
      if (partialActivity) partialActivity.textContent = op.headline.message;
      deps.showSetupWarnings(warnings);
    } else {
      const message = `Environment setup failed: ${op.failure && op.failure.message !== "" ? op.failure.message : "unknown error"}`;
      panel.classList.remove("env-progress--done");
      panel.classList.add("env-progress--failed");
      const activityEl = dom.byId(PROGRESS_IDS.activity);
      if (activityEl) activityEl.textContent = message;
      deps.showError(message);
    }
    deps.reloadEnvironmentsTable();
  }

  function trackProgress(
    environment: string,
    provider: string,
    onTerminal: (op: OperationRecord) => void = applyTerminal
  ): void {
    stopProgress();
    session += 1;
    const mySession = session;
    setCommandBusy(false);
    let startedAtMs = context.clock.now();
    let observedOperation = false;
    let operationId = "";
    let verifyDispatchedAtMs = 0;
    let promptingRequestedAt = "";
    const elapsedEl = dom.byId(PROGRESS_IDS.elapsed);

    function active(): boolean {
      return scope.active && mySession === session;
    }

    elapsedTimer = scope.every(1000, () => {
      if (elapsedEl)
        elapsedEl.textContent = formatElapsed(
          context.clock.now() - startedAtMs
        );
    });

    function scheduleTick(delayMs: number): void {
      if (!active()) return;
      progressTimer = scope.after(delayMs, tick);
    }

    function pollVerifyStatus(): void {
      void fetchTracked(verifyStatusUrl(repo, environment, operationId))
        .then((response) => response.json())
        .then((payload) => {
          if (!active()) return;
          const v = parseVerifyStatus(payload);
          if (v.state === "expired" || v.terminal) {
            resetSubmitButton();
            stopProgress();
            const expiredActivity = dom.byId(PROGRESS_IDS.activity);
            if (expiredActivity) {
              expiredActivity.textContent =
                v.error !== "" ?
                  v.error
                : "Credential verification is no longer being tracked.";
            }
            return;
          }
          if (
            verifyDispatchedAtMs &&
            context.clock.now() - verifyDispatchedAtMs >
              VERIFY_TRACKING_WINDOW_MS
          ) {
            resetSubmitButton();
            stopProgress();
            const timedOutActivity = dom.byId(PROGRESS_IDS.activity);
            if (timedOutActivity) {
              timedOutActivity.textContent =
                "Credential verification exceeded its tracking window. Check the GitHub Actions run before retrying.";
            }
            return;
          }
          if (v.state === "success") {
            resetSubmitButton();
            hideProgress();
            deps.showSuccessBanner(provider || "azure", environment);
            deps.reloadEnvironmentsTable();
            return;
          }
          if (v.state === "failed") {
            resetSubmitButton();
            stopProgress();
            panel.style.display = "block";
            panel.classList.remove("env-progress--done");
            panel.classList.add("env-progress--failed");
            const activityEl = dom.byId(PROGRESS_IDS.activity);
            if (activityEl)
              activityEl.textContent =
                `Credential verification failed. ${v.error}` +
                (v.runUrl === "" ? "" : ` View the run: ${v.runUrl}`);
            return;
          }
          if (v.activity !== "") verifyActivity = v.activity;
          scheduleTick(POLL_RETRY_MS);
        })
        .catch(() => {
          if (!active()) return;
          scheduleTick(POLL_ERROR_RETRY_MS);
        });
    }

    function resumeInputPrompt(prompt: OperationInputPrompt): boolean {
      let answer: Promise<Record<string, unknown>> | undefined;
      if (prompt.code === "service-management-reference-required") {
        answer = deps
          .promptServiceManagementReference()
          .then((smr) => ({ serviceManagementReference: smr }));
      } else if (prompt.code === "app-selection-required") {
        answer = deps
          .promptAppSelection({
            title: "Choose a deploy identity",
            intro:
              "You own more than one App Registration matching this repository. Choose which identity to use for GitHub Actions deployments, or create a new one.",
            candidates: prompt.candidates,
            defaultAppId:
              prompt.defaultAppId === "" ? undefined : prompt.defaultAppId,
            allowCreateNew: true
          })
          .then((choice) =>
            choice.createNew ? { createNew: true } : { appId: choice.appId }
          );
      }
      if (!answer) return false;

      void answer
        .then((values) => {
          if (!active()) return null;
          const body = {
            ...values,
            checkpoint: prompt.checkpoint,
            repo,
            environment,
            provider
          };
          return fetchTracked(resumeUrl(operationId, prompt.code), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Radius-Mutation-Nonce": options.mutationNonce || ""
            },
            body: JSON.stringify(body)
          }).then((response) => {
            if (response.ok) return response;
            return response
              .json()
              .catch(() => ({}))
              .then((failurePayload) => {
                throw parseResumeFailure(failurePayload);
              });
          });
        })
        .then(
          () => {
            if (!active()) return;
            scheduleTick(0);
          },
          (error: unknown) => {
            if (!active()) return;
            if (isAbandonError(error)) {
              void fetchTracked(stopUrl(operationId), {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Radius-Mutation-Nonce": options.mutationNonce || ""
                },
                body: "{}"
              })
                .then((response) => {
                  if (!response.ok) {
                    promptingRequestedAt = "";
                    throw new Error("Unable to cancel environment setup.");
                  }
                  focusPanel();
                  scheduleTick(0);
                })
                .catch(() => {
                  scheduleTick(POLL_RETRY_MS);
                });
              return;
            }
            if (
              error instanceof OperationResumeError &&
              isOperationInputExpired(error.operation)
            ) {
              stopProgress();
              const expired = parseOperationRecord(
                error.operation,
                options.ghCommandPresentation
              );
              if (expired) onTerminal(expired);
              return;
            }
            if (error instanceof OperationResumeError && error.retryPrompt) {
              promptingRequestedAt = "";
            }
            scheduleTick(POLL_RETRY_MS);
          }
        );
      return true;
    }

    function tick(): void {
      void fetchTracked(operationsByRepoUrl(repo))
        .then((response) => response.json())
        .then((payload) => {
          if (!active()) return;
          const op = parseResponse(payload);
          // The registry retains the latest terminal operation for this
          // repository. During the short gap before a new POST registers,
          // that record belongs to the previous environment and must not
          // replace the optimistic panel for the setup just requested.
          if (
            !observedOperation &&
            op &&
            (op.environment !== environment || op.terminalState !== null)
          ) {
            scheduleTick(POLL_RETRY_MS);
            return;
          }
          if (!op) {
            // A just-started setup has not necessarily reached the server
            // operation registry yet. Verification status is historical and
            // can still report the previous successful run for this
            // environment name, so only use it for restart recovery after
            // this poller has first observed the current operation.
            if (!observedOperation) {
              scheduleTick(POLL_RETRY_MS);
              return;
            }
            // Verification is tracked separately from the process-local
            // operation registry. If the extension restarts after dispatch,
            // the record can disappear while the Actions run still reaches a
            // terminal result.
            if (!environment) {
              scheduleTick(POLL_RETRY_MS);
              return;
            }
            pollVerifyStatus();
            return;
          }
          observedOperation = true;
          operationId = op.operationId;
          if (op.verification && op.verification.dispatchedAt !== null) {
            verifyDispatchedAtMs = op.verification.dispatchedAt;
          }
          const parsedStart = Date.parse(op.startedAt);
          if (Number.isFinite(parsedStart)) startedAtMs = parsedStart;
          if (elapsedEl) {
            const parsedEnd = op.endedAt ? Date.parse(op.endedAt) : NaN;
            const referenceMs =
              Number.isFinite(parsedEnd) ? parsedEnd : context.clock.now();
            elapsedEl.textContent = formatElapsed(referenceMs - startedAtMs);
          }
          renderProgress(op);
          if (op.terminalState !== null) {
            stopProgress();
            onTerminal(op);
            return;
          }
          if (
            op.state === "input_required" &&
            op.inputRequired &&
            op.inputRequired.requestedAt !== promptingRequestedAt
          ) {
            promptingRequestedAt = op.inputRequired.requestedAt;
            if (resumeInputPrompt(op.inputRequired)) return;
          }
          scheduleTick(POLL_RETRY_MS);
        })
        .catch(() => {
          // A dropped poll is routine — the server respawns after an idle
          // reap and the next tick reconnects. Never surface it as failure.
          if (!active()) return;
          scheduleTick(POLL_ERROR_RETRY_MS);
        });
    }

    tick();
  }

  // On load, rejoin an operation that is already running for this repo. This
  // is what makes navigating away safe: the user can leave the page mid-setup
  // and find the same panel, with the same history, when they come back.
  function resumeProgress(): void {
    if (!repo) return;
    session += 1;
    const mySession = session;
    setCommandBusy(false);
    void fetchTracked(operationsByRepoUrl(repo))
      .then((response) => response.json())
      .then((payload) => {
        if (!scope.active || mySession !== session) return;
        const op = parseResponse(payload);
        if (!op) return;
        // A closed record is rebuilt too: its stop, retry, and partial-state
        // controls come from the saved operation, so a reload after a failure
        // still offers the same actions.
        renderProgress(op);
        if (op.terminalState !== null) return;
        trackProgress(op.environment, op.provider, applyTerminal);
      })
      .catch(() => {
        /* nothing to resume */
      });
  }

  const dismissEl = dom.byId(PROGRESS_IDS.dismiss);
  if (dismissEl) {
    scope.on(dismissEl, "click", () => {
      hideProgress();
    });
  }

  return {
    renderProgress,
    stopProgress,
    hideProgress,
    focusPanel,
    syncFailureOperation,
    trackProgress,
    resumeProgress,
    applyTerminal,
    teardown() {
      scope.teardown();
    }
  };
}
