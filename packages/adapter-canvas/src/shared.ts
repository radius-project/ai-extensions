// Canvas adapter — shared state + small presentation utilities used by both the
// page renderers and the request/route handlers.
//
// `sharedCredentials` is the adapter's persistent OIDC credential cache, keyed by
// provider; it is loaded once at module init and mutated in place (never
// reassigned by callers), so importers see a live view of the same object.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface CredentialProfile {
  [key: string]: unknown;
  name?: unknown;
  provider?: unknown;
  status?: unknown;
  user?: unknown;
  tenantId?: unknown;
  tenantName?: unknown;
  subscriptionId?: unknown;
  subscriptionName?: unknown;
  accountId?: unknown;
  region?: unknown;
  roleArn?: unknown;
  updatedAt?: unknown;
}

export interface CredentialProfileInput {
  name?: string;
  provider?: string;
  user?: string;
  tenantId?: string;
  tenantName?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  accountId?: string;
  region?: string;
  roleArn?: string;
}

export interface CloudCredential {
  [key: string]: unknown;
  message?: unknown;
  tenantId?: unknown;
  tenantName?: unknown;
  subscriptionId?: unknown;
  subscriptionName?: unknown;
  clientId?: unknown;
  clientName?: unknown;
  accountId?: unknown;
  accountName?: unknown;
  region?: unknown;
}

export interface SharedCredentials {
  [key: string]: unknown;
  azure?: unknown;
  aws?: unknown;
  profiles?: unknown;
}

export interface CanvasGraphConnection {
  [key: string]: unknown;
  id?: string;
  name?: string;
  direction?: string;
  diffStatus?: string;
}

export interface CanvasGraphResource {
  [key: string]: unknown;
  id?: string;
  name?: string;
  type?: string;
  connections?: CanvasGraphConnection[];
  diffStatus?: string;
  codeReference?: string;
  outputResources?: CanvasGraphResource[];
  deployStatus?: "pending" | "in_progress" | "success" | "failed";
  deployMessage?: string;
  portalUrl?: string;
}

export type GraphView = "graph" | "planned" | "diff";

export interface SourceRefContext {
  [key: string]: unknown;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  headBranch?: string;
  view: GraphView;
  token: string;
}

export interface PendingSourceRef {
  contextToken: string;
  id: string;
  codeReference: string;
}

export interface CanvasDeployParams {
  targetRepo?: string;
  environment?: string;
  provider?: string;
  branch?: string;
  appFile?: string;
}

export interface CanvasDeployAttempt extends CanvasDeployParams {
  id: string;
}

export interface CanvasDeployResult {
  error?: string;
  message?: string;
  workflowUrl?: string;
  workflow?: string;
}

export type GraphBuildStage =
  | "checking_model"
  | "creating_model"
  | "building_graph"
  | "building_base_graph"
  | "building_head_graph"
  | "resolving_recipes"
  | "loading_deployment"
  | "comparing_graphs"
  | "rendering_graph";

export type GraphBuildEventState = "running" | "succeeded" | "failed";

export interface GraphBuildEvent {
  sequence: number;
  stage: GraphBuildStage;
  state: GraphBuildEventState;
  detail: string;
}

// Which graph view a build belongs to. The record is view-scoped so a returning
// page only adopts progress that describes the graph it is showing, and so the
// nav chip can link back to the page doing the work.
export type GraphProgressView = "graph" | "planned" | "diff";

// Append one event to the instance's build record.
//
// A build that waits for Copilot to author .radius/app.bicep re-issues its
// request every few seconds, and each attempt replays the stages it already
// reported. Two rules keep that replay out of the record.
//
// A stage never walks backwards: a `running` event for a stage that already
// settled would flip it from done back to running, which reads as a stuck build
// rather than a wait.
//
// A stage never repeats itself verbatim: an event identical to that stage's
// most recent one says nothing the record does not already show, and appending
// it would grow a duplicate tail on the checklist with every poll. A repeat
// that carries new detail is real narration and is kept.
export function recordGraphBuildEvent(
  state: CanvasState,
  event: Omit<GraphBuildEvent, "sequence">
): void {
  if (!state.graphBuildEvents) state.graphBuildEvents = [];
  const events = state.graphBuildEvents;
  const forStage = events.filter((recorded) => recorded.stage === event.stage);
  const settled = forStage.some((recorded) => recorded.state !== "running");
  if (settled && event.state === "running") return;
  const latest = forStage[forStage.length - 1];
  if (
    latest &&
    latest.state === event.state &&
    latest.detail === event.detail
  ) {
    return;
  }
  events.push({ sequence: events.length + 1, ...event });
}

export interface CanvasState {
  [key: string]: unknown;
  graphResources?: CanvasGraphResource[] | null;
  graphTargetRepo?: string;
  graphBranch?: string;
  graphFromWorkspace?: boolean;
  graphLoaded?: boolean;
  graphBuildEvents?: GraphBuildEvent[];
  graphProgressGeneration?: number;
  // When the current build record started, whether it is still in flight, and
  // which view it belongs to. The server owns these so the elapsed clock and
  // the reported stages survive the user navigating away and back — the page
  // that started the build is no longer the only thing that knows about it.
  graphProgressStartedAtMs?: number;
  graphProgressActive?: boolean;
  graphProgressView?: GraphProgressView;
  graphProgressKey?: string;
  graphProgressOwner?: number;
  graphProgressAwaitingModel?: boolean;
  graphProgressDeadlineAtMs?: number;
  plannedRepo?: string;
  plannedProvider?: string;
  plannedResources?: CanvasGraphResource[] | null;
  plannedBranch?: string;
  plannedEnvironment?: string;
  plannedRequestGeneration?: number;
  plannedFromWorkspace?: boolean;
  deployProvider?: string;
  diffResources?: CanvasGraphResource[] | null;
  diffBase?: string;
  diffHead?: string;
  diffTargetRepo?: string;
  diffError?: string;
  branches?: string[];
  branchShas?: Record<string, string>;
  contextRepo?: string;
  contextBranch?: string;
  workspacePath?: string;
  workspaceRepo?: string;
  workspaceBranch?: string;
  targetRepo?: string;
  envName?: string;
  appFile?: string;
  existingEnvs?: string[];
  activeSubtab?: string;
  deployResult?: CanvasDeployResult;
  deployingRepo?: string;
  deployingBranch?: string;
  deployingProvider?: string;
  deployingResources?: CanvasGraphResource[] | null;
  deployParams?: CanvasDeployParams;
  deployAttempt?: CanvasDeployAttempt;
  deploymentMutation?: {
    repo: string;
    environment: string;
    kind: "deploy" | "delete";
    expiresAt: number;
    attemptId?: string;
  };
  deployStartedAt?: number;
  deployFinishedAt?: number;
  deployLogs?: string[];
  deployLogBase?: number;
  deployStatus?: string;
  deployError?: string | null;
  activeGraphView?: GraphView;
  sourceRefContexts?: Partial<Record<GraphView, SourceRefContext>>;
  pendingSourceRefs?: PendingSourceRef[];
  page?: string;
  graphDefinitionHash?: string;
  graphBuildGeneration?: number;
  progressMessages?: string[];
  appBicepHandoffKey?: string;
  deployEnvName?: string;
  deployAppName?: string;
  deployDispatchedAt?: number;
  deployRunId?: string | number | null;
  deployRunUrl?: string | null;
  deployErrorKind?: DeployErrorKind | null;
  deployErrorBranch?: string | null;
  deployRepairing?: boolean;
  deployHandoffState?: string;
  deployHandoffAttempts?: number;
  // Delivery state for the informational failure notice (separate from the
  // repair handoff above). A "run-unconfirmed" failure is never auto-repaired,
  // so it does not open a repair loop; instead this tracks a one-shot report to
  // chat so the agent can tell the user what happened. Kept on its own fields so
  // the notice can never be confused with, or suppress, a repair handoff.
  deployNoticeState?: string;
  deployNoticeAttempts?: number;
  // Redeploys the agent has made inside the current repair loop. Bounds the
  // automatic repair cycle server-side; reset whenever a deploy opens a new
  // attempt rather than continuing one.
  deployRepairAttempts?: number;
  verifyRunId?: string | number | null;
  verifyRunUrl?: string;
  deployedGraph?: CanvasGraphResource[] | null;
  deployedGraphRepo?: string;
  resolvedRecipes?: unknown[];
  diffBaseGenerated?: boolean;
  diffHeadGenerated?: boolean;
}

// Why a deploy failed, in the one dimension the repair guard cares about:
// "branch-not-pushed", "run-unconfirmed" and "oidc-subject-missing" all mean an
// automatic repair must not redeploy, so these strings are matched across
// server, tests and client. A union rather than string makes a typo in any of
// them a compile error instead of a guard that silently never fires.
export type DeployErrorKind =
  "branch-not-pushed" | "run-unconfirmed" | "oidc-subject-missing";

export function escapeHtml(str: unknown): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloudCredential(value: unknown): CloudCredential {
  return isRecord(value) ? value : {};
}

const __dirname_ext =
  typeof import.meta.url !== "undefined" ?
    dirname(fileURLToPath(import.meta.url))
  : ".";

export function resolveCredentialsFilePath(
  environment: NodeJS.ProcessEnv = process.env,
  moduleDirectory = __dirname_ext
): string {
  const configured = environment.RADIUS_CREDENTIALS_FILE?.trim();
  return configured || join(moduleDirectory, ".radius-credentials.json");
}

const CREDS_FILE = resolveCredentialsFilePath();

export let sharedCredentials: SharedCredentials = {};
try {
  const stored: unknown = JSON.parse(readFileSync(CREDS_FILE, "utf8"));
  if (isRecord(stored)) sharedCredentials = stored;
} catch {}

export function saveCredentials(): void {
  try {
    writeFileSync(CREDS_FILE, JSON.stringify(sharedCredentials, null, 2));
  } catch {}
}

// ── Credential profiles ──────────────────────────────────────────────────────
// Reusable per-repo credential profiles backing the Environments → Credentials
// tab. Each profile captures a verified cloud account (provider + tenant/
// subscription or AWS account/region) that environment creation then references.
// Persisted alongside the OIDC cache in `.radius-credentials.json` under a
// `profiles` map keyed by "owner/repo".
function profilesRoot(): Record<string, unknown> {
  const profiles = sharedCredentials.profiles;
  if (isRecord(profiles)) return profiles;
  const empty: Record<string, unknown> = {};
  sharedCredentials.profiles = empty;
  return empty;
}

export function listCredentialProfiles(repo: string): CredentialProfile[] {
  const root = profilesRoot();
  const list = root[repo];
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

// Upsert a profile by name (case-insensitive) for a repo, then persist.
export function saveCredentialProfile(
  repo: string,
  profile: CredentialProfileInput | null | undefined
): CredentialProfile | null {
  if (!repo || !profile) return null;
  // Trim first so a whitespace-only name (e.g. "   ") is rejected rather than
  // persisted as an empty-string profile name.
  const name = String(profile.name || "").trim();
  if (!name) return null;
  const root = profilesRoot();
  const list = listCredentialProfiles(repo);
  root[repo] = list;
  const entry: CredentialProfile = {
    name,
    provider: profile.provider === "aws" ? "aws" : "azure",
    status: "verified",
    user: profile.user || "",
    tenantId: profile.tenantId || "",
    tenantName: profile.tenantName || "",
    subscriptionId: profile.subscriptionId || "",
    subscriptionName: profile.subscriptionName || "",
    accountId: profile.accountId || "",
    region: profile.region || "",
    roleArn: profile.roleArn || "",
    updatedAt: new Date().toISOString()
  };
  const idx = list.findIndex(
    (p) => String(p.name).toLowerCase() === name.toLowerCase()
  );
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  saveCredentials();
  return entry;
}

export function deleteCredentialProfile(repo: string, name: unknown): boolean {
  const root = profilesRoot();
  const list = root[repo];
  if (!Array.isArray(list)) return false;
  const lower = String(name || "").toLowerCase();
  const next = list.filter((p) => String(p.name).toLowerCase() !== lower);
  root[repo] = next;
  saveCredentials();
  return next.length !== list.length;
}
