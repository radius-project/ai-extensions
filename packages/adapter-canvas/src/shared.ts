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
  preferredGitHubLogin?: unknown;
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

export interface CanvasState {
  [key: string]: unknown;
  oidcAzure?: CloudCredential;
  oidcAws?: CloudCredential;
  graphResources?: CanvasGraphResource[] | null;
  graphTargetRepo?: string;
  graphBranch?: string;
  graphFromWorkspace?: boolean;
  graphLoaded?: boolean;
  plannedRepo?: string;
  plannedProvider?: string;
  plannedResources?: CanvasGraphResource[] | null;
  plannedBranch?: string;
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
  deployErrorKind?: string | null;
  deployErrorBranch?: string | null;
  deployRepairing?: boolean;
  deployHandoffState?: string;
  deployHandoffAttempts?: number;
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
const CREDS_FILE = join(__dirname_ext, ".radius-credentials.json");

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

// ── Preferred GitHub identity ────────────────────────────────────────────────
// The account the user explicitly chose for setup to act as (via the Create
// Environment dialog's account switcher). gh accounts are machine-global, so
// this preference is stored machine-wide (not per-repo) and restored at server
// startup — otherwise the in-memory choice dies with the process and the token
// strategy silently reverts to the injected token's account on the next restart.
export function getPreferredGitHubLogin(): string {
  const v = sharedCredentials.preferredGitHubLogin;
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export function setPreferredGitHubLogin(login: unknown): void {
  const next = String(login || "").trim();
  if (next) sharedCredentials.preferredGitHubLogin = next;
  else delete sharedCredentials.preferredGitHubLogin;
  saveCredentials();
}
