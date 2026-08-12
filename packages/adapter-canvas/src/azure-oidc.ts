// Canvas adapter — Azure OIDC auto-setup orchestration helpers.
//
// The `/api/azure-auto-setup` route in server.ts runs `az`/`gh` as child
// processes to bootstrap a federated-identity App Registration so a user's repo
// can deploy to Azure. The pure decisions in that flow — which
// federated-credential `subject`(s) to create, how to build the `az ad app
// create` argv, how to classify an `az` Service Management Reference policy
// failure, and how to validate inputs — live here so they can be unit-tested
// without spawning processes. Actual I/O (spawning `az`/`gh`) stays in
// server.ts; the network reads are injected as a `runner` so this module
// remains testable.

import {
  buildOidcSubject,
  buildFederatedCredentialName
} from "@radius-project/core";
import type { OidcSubjectConfig } from "@radius-project/core";

export interface OidcError extends Error {
  code: string;
}

export interface OwnedAppRegistration {
  appId: string;
  displayName?: string;
  createdDateTime?: string;
}

export interface AppSelectionInput {
  ownedMatches?: readonly OwnedAppRegistration[];
  hasUnownedMatch?: boolean;
  radiusProvenance?: RadiusAppProvenanceInput;
  existingClientId?: string;
  explicitAppId?: string;
  createNew?: boolean;
}

export interface RadiusAppProvenanceInput {
  tags?: Iterable<unknown>;
  repo?: string;
  environment?: string;
}

export interface RadiusAppProvenance {
  managed: boolean;
  repo?: string;
  environment?: string;
  operationId?: string;
}

export interface RadiusAppOwnershipDecision {
  action: "reuse" | "error";
  code?: string;
  reason?: string;
  radiusOrphan?: boolean;
}

export interface FederatedCredential {
  name: string;
  subject: string;
}

export interface DiscoveryData {
  clusters?: unknown[];
  resourceGroups?: unknown[];
  vpcs?: unknown[];
  subnets?: unknown[];
  error?: string;
  errors?: Record<string, string>;
}

export interface GitHubJsonPayload {
  [key: string]: unknown;
  full_name?: string;
  id?: number;
  owner?: { id?: number };
  use_default?: boolean;
  include_claim_keys?: string[];
  use_immutable_subject?: boolean;
  sub_claim_prefix?: string;
}

export interface GitHubJsonResponse {
  ok: boolean;
  status?: number | null;
  json?: GitHubJsonPayload | null;
  stderr?: string;
}

export type GitHubJsonRunner = (apiPath: string) => Promise<GitHubJsonResponse>;

export interface FetchGitHubJsonOptions {
  retries?: number;
  baseDelayMs?: number;
  sleepFn?: (milliseconds: number) => Promise<unknown>;
}

export interface ResolveOidcSubjectInput {
  targetRepo: string;
  envName: string;
  suffix: string;
}

export interface ResolveOidcSubjectResult {
  federatedCredentials: FederatedCredential[];
  fullName: string;
  ownerId: number;
  repoId: number;
  subjectConfig: OidcSubjectConfig;
}

export function findLegacyMutableCredentialName(
  resolved: ResolveOidcSubjectResult,
  suffix: string,
  existingNameToSubject: ReadonlyMap<string, string>
): string | undefined {
  if (
    !resolved.subjectConfig.useDefault ||
    resolved.subjectConfig.useImmutableSubject !== true
  ) {
    return undefined;
  }
  const mutableSubject = buildOidcSubject({
    repoFullName: resolved.fullName,
    ownerId: resolved.ownerId,
    repoId: resolved.repoId,
    suffix,
    subjectConfig: { useDefault: true, useImmutableSubject: false }
  });
  return [...existingNameToSubject.entries()].find(
    ([, subject]) => subject === mutableSubject
  )?.[0];
}

// owner/repo using GitHub's real charset — an owner is 1-39 chars starting
// alphanumeric with internal hyphens; a repo is 1-100 of [A-Za-z0-9._-]. This
// rejects spaces and shell metacharacters (`&`, `?`, ...) that could otherwise
// flow into `az ad app create --display-name` via cmd.exe on Windows.
export const REPO_SLUG_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
// Canonical 8-4-4-4-12 UUID (Service Management Reference / Service Tree ids,
// tenant/subscription/account ids).
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// AKS cluster name: <=63 chars, alphanumeric bookends, internal `-` and `_`.
// Leading char is alphanumeric so it can never be mistaken for a CLI flag.
export const AKS_CLUSTER_NAME_RE =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,61}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
// Resource group name: <=90 chars from Azure's allowed set, but NOT ending in a
// dot (Azure rejects a trailing period). Leading char restricted to alphanumeric.
export const RESOURCE_GROUP_NAME_RE =
  /^[A-Za-z0-9][A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-]$|^[A-Za-z0-9]$/;

// Pin the API version so the OIDC customization payload (which carries
// `use_immutable_subject` / `sub_claim_prefix`) is stable across gh/GitHub
// upgrades.
export const GITHUB_API_VERSION = "2022-11-28";
export const RADIUS_MANAGED_APP_TAG = "radius-managed";
export const RADIUS_REPO_APP_TAG_PREFIX = "radius-repo:";
export const RADIUS_ENVIRONMENT_APP_TAG_PREFIX = "radius-environment:";
export const RADIUS_OPERATION_APP_TAG_PREFIX = "radius-operation:";

export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function isValidRepoSlug(value: unknown): boolean {
  return typeof value === "string" && REPO_SLUG_RE.test(value.trim());
}

export function isAksClusterName(value: unknown): boolean {
  return typeof value === "string" && AKS_CLUSTER_NAME_RE.test(value.trim());
}

export function isResourceGroupName(value: unknown): boolean {
  return typeof value === "string" && RESOURCE_GROUP_NAME_RE.test(value.trim());
}

/** Attach a machine-readable `code` to an Error for the JSON error response. */
export function oidcError(code: string, message: string): OidcError {
  return Object.assign(new Error(message), { code });
}

function uniqueTrimmedStrings(values: Iterable<unknown> = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of Array.from(values || [])) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Build the argv for `az ad app create`, adding SMR only when supplied. */
export function buildAppCreateArgs({
  appName,
  serviceManagementReference
}: {
  appName?: string;
  serviceManagementReference?: string;
} = {}): Array<string | undefined> {
  const args = [
    "ad",
    "app",
    "create",
    "--display-name",
    appName,
    "--query",
    "appId",
    "-o",
    "tsv"
  ];
  if (serviceManagementReference) {
    // Enterprise Entra tenants enforce a policy requiring every new App
    // Registration to carry a Service Management Reference (for
    // Microsoft-internal tenants this is a Service Tree id GUID).
    args.push("--service-management-reference", serviceManagementReference);
  }
  return args;
}

/** Build the argv for `az ad app owner add`. */
export function buildAppOwnerAddArgs({
  appId,
  ownerObjectId
}: {
  appId: string;
  ownerObjectId: string;
}): string[] {
  return [
    "ad",
    "app",
    "owner",
    "add",
    "--id",
    appId,
    "--owner-object-id",
    ownerObjectId
  ];
}

/** Build the argv for `az ad app owner list`, returning owner object ids as TSV. */
export function buildAppOwnerListArgs({ appId }: { appId: string }): string[] {
  return [
    "ad",
    "app",
    "owner",
    "list",
    "--id",
    appId,
    "--query",
    "[].id",
    "-o",
    "tsv"
  ];
}

// Creating an app commonly auto-assigns the creator as owner. The explicit
// post-create owner add can therefore legitimately report "already exists"; that
// is benign only when the later owner-list verification confirms the user.
const APP_OWNER_ALREADY_ASSIGNED_RE =
  /added object references already exist|object reference already exists/i;

export function isAppOwnerAlreadyAssignedError(stderr: unknown): boolean {
  return APP_OWNER_ALREADY_ASSIGNED_RE.test(String(stderr || ""));
}

export function parseDirectoryObjectIds(stdout: unknown): string[] {
  return uniqueTrimmedStrings(String(stdout || "").split(/\s+/)).map((value) =>
    value.toLowerCase()
  );
}

export function buildRadiusAppProvenanceTags({
  repo,
  environment,
  operationId
}: {
  repo?: string;
  environment?: string;
  operationId?: string;
}): string[] {
  return uniqueTrimmedStrings([
    RADIUS_MANAGED_APP_TAG,
    repo ? `${RADIUS_REPO_APP_TAG_PREFIX}${repo}` : "",
    environment ? `${RADIUS_ENVIRONMENT_APP_TAG_PREFIX}${environment}` : "",
    operationId ? `${RADIUS_OPERATION_APP_TAG_PREFIX}${operationId}` : ""
  ]);
}

/** Build the argv for a Graph PATCH that updates application tags by appId. */
export function buildAppTagPatchArgs({
  appId,
  tags
}: {
  appId: string;
  tags: Iterable<unknown>;
}): string[] {
  return [
    "rest",
    "--method",
    "PATCH",
    "--url",
    `https://graph.microsoft.com/v1.0/applications(appId='${appId}')`,
    "--body",
    JSON.stringify({ tags: uniqueTrimmedStrings(tags) })
  ];
}

/** Build the argv for `az ad app show`, reading only tags. */
export function buildAppTagShowArgs({ appId }: { appId: string }): string[] {
  return ["ad", "app", "show", "--id", appId, "--query", "tags", "-o", "json"];
}

export function parseAppTags(stdout: unknown): string[] | null {
  try {
    const parsed = JSON.parse(String(stdout || "null"));
    if (!Array.isArray(parsed)) return null;
    return uniqueTrimmedStrings(parsed);
  } catch {
    return null;
  }
}

/**
 * Parse Radius provenance tags into a structured object that can drive reuse
 * and manual-cleanup guidance without mutating anything.
 */
export function parseRadiusAppProvenanceTags(
  tags: Iterable<unknown> = []
): RadiusAppProvenance {
  const parsed = uniqueTrimmedStrings(tags);
  const out: RadiusAppProvenance = { managed: false };
  for (const tag of parsed) {
    if (tag === RADIUS_MANAGED_APP_TAG) {
      out.managed = true;
      continue;
    }
    if (tag.startsWith(RADIUS_REPO_APP_TAG_PREFIX)) {
      out.repo = tag.slice(RADIUS_REPO_APP_TAG_PREFIX.length);
      continue;
    }
    if (tag.startsWith(RADIUS_ENVIRONMENT_APP_TAG_PREFIX)) {
      out.environment = tag.slice(RADIUS_ENVIRONMENT_APP_TAG_PREFIX.length);
      continue;
    }
    if (tag.startsWith(RADIUS_OPERATION_APP_TAG_PREFIX)) {
      out.operationId = tag.slice(RADIUS_OPERATION_APP_TAG_PREFIX.length);
    }
  }
  return out;
}

/**
 * Pure ownership classification for the Radius-tagged-app reuse path.
 *
 * - Owned apps always reuse, regardless of any Radius tags.
 * - Radius-tagged repo/environment matches that the signed-in user does not
 *   own get a dedicated orphaning message with manual cleanup guidance.
 * - Everything else falls back to the precise "signed-in user is not listed as
 *   an owner" message.
 */
export function decideRadiusAppOwnership({
  ownedBySignedInUser,
  radiusProvenance
}: {
  ownedBySignedInUser: boolean;
  radiusProvenance?: RadiusAppProvenanceInput;
}): RadiusAppOwnershipDecision {
  if (ownedBySignedInUser) return { action: "reuse" };

  const provenance = parseRadiusAppProvenanceTags(radiusProvenance?.tags || []);
  const expectedRepo = String(radiusProvenance?.repo || "")
    .trim()
    .toLowerCase();
  const expectedEnvironment = String(radiusProvenance?.environment || "")
    .trim()
    .toLowerCase();
  const repoMatches =
    !!provenance.repo &&
    !!expectedRepo &&
    provenance.repo.trim().toLowerCase() === expectedRepo;
  const environmentMatches =
    !!provenance.environment &&
    !!expectedEnvironment &&
    provenance.environment.trim().toLowerCase() === expectedEnvironment;

  if (provenance.managed && repoMatches && environmentMatches) {
    return {
      action: "error",
      code: "app-registration-radius-orphaned",
      reason:
        "A Radius-tagged App Registration already exists for this repository/environment, but the current signed-in user is not listed as one of its owners. " +
        "It may be a leftover from a previous Radius setup that was orphaned. Ask an administrator or current owner to review the owners and Radius tags and clean it up manually if needed. " +
        "This flow will not reclaim, delete, or add owners.",
      radiusOrphan: true
    };
  }

  return {
    action: "error",
    code: "app-registration-not-owned",
    reason:
      "The current signed-in user is not listed as one of this App Registration's owners. " +
      "Setup will not reuse it. " +
      "Choose an owned application or create a new one."
  };
}

export function missingRequiredAppTags(
  actualTags: Iterable<unknown> = [],
  requiredTags: Iterable<unknown> = []
): string[] {
  const have = new Set(uniqueTrimmedStrings(actualTags));
  return uniqueTrimmedStrings(requiredTags).filter((tag) => !have.has(tag));
}

/** Build the argv for `az ad app delete`. */
export function buildAppDeleteArgs({ appId }: { appId: string }): string[] {
  return ["ad", "app", "delete", "--id", appId];
}

/**
 * Pure disambiguation for Step 3b that supports an interactive picker and an
 * explicit opt-in choice, using the same lookup-then-create ownership heuristic
 * as the zero-click default.
 *
 * The App Registration is a per-repo CI/CD deploy identity. The zero-click
 * default stays per-repo, but:
 * - a user can explicitly pick an owned app (`explicitAppId`) — including one
 *   that does NOT match the repo-derived name, enabling deliberate cross-repo
 *   shared identity;
 * - a user can force creating a fresh app (`createNew`);
 * - when >1 owned name-matches exist and the user hasn't chosen, we return
 *   `needs-selection` so the caller can prompt (never silently consolidate).
 *
 * @param {{ownedMatches?: {appId:string,displayName?:string,createdDateTime?:string}[], hasUnownedMatch?: boolean, radiusProvenance?: {tags?: Iterable<unknown>, repo?: string, environment?: string}, existingClientId?: string, explicitAppId?: string, createNew?: boolean}} input
 * @returns {{action:'reuse'|'create'|'error'|'needs-selection', appId?:string, code?:string, reason?:string, duplicates?:boolean, candidates?:object[], defaultAppId?:string}}
 */
export function decideAppSelection({
  ownedMatches = [],
  hasUnownedMatch = false,
  radiusProvenance,
  existingClientId,
  explicitAppId,
  createNew = false
}: AppSelectionInput = {}): {
  action: "reuse" | "create" | "error" | "needs-selection";
  appId?: string;
  code?: string;
  reason?: string;
  duplicates?: boolean;
  radiusOrphan?: boolean;
  candidates?: OwnedAppRegistration[];
  defaultAppId?: string;
} {
  const owned = (Array.isArray(ownedMatches) ? ownedMatches : []).filter(
    (m) => m && m.appId
  );
  const norm = (v: unknown) =>
    String(v || "")
      .trim()
      .toLowerCase();

  // An explicit picker choice wins — but only if the caller owns it. An
  // explicitAppId not among the owned candidates is unsafe (we can't verify
  // ownership here), so it is an error rather than a silent create/reuse.
  if (explicitAppId && String(explicitAppId).trim()) {
    const picked = owned.find((m) => norm(m.appId) === norm(explicitAppId));
    if (picked) return { action: "reuse", appId: picked.appId };
    const decision = decideRadiusAppOwnership({
      ownedBySignedInUser: false,
      radiusProvenance
    });
    return {
      action: "error",
      code: decision.code,
      reason: decision.reason,
      radiusOrphan: decision.radiusOrphan
    };
  }

  // Explicit "create new" short-circuits the reuse heuristics.
  if (createNew === true) return { action: "create" };

  if (owned.length === 0) {
    if (hasUnownedMatch) {
      const decision = decideRadiusAppOwnership({
        ownedBySignedInUser: false,
        radiusProvenance
      });
      return {
        action: "error",
        code: decision.code,
        reason: decision.reason,
        radiusOrphan: decision.radiusOrphan
      };
    }
    return { action: "create" };
  }

  if (owned.length === 1) {
    return { action: "reuse", appId: owned[0].appId, duplicates: false };
  }

  // >1 owned matches and no explicit choice — compute the heuristic default the
  // picker should preselect, but defer to the user.
  let defaultAppId;
  if (existingClientId) {
    const preferred = owned.find(
      (m) => norm(m.appId) === norm(existingClientId)
    );
    if (preferred) defaultAppId = preferred.appId;
  }
  if (!defaultAppId) {
    const oldest = [...owned].sort((a, b) => {
      const ta = Date.parse(a.createdDateTime || "");
      const tb = Date.parse(b.createdDateTime || "");
      return (
        (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb)
      );
    })[0];
    defaultAppId = oldest.appId;
  }
  return {
    action: "needs-selection",
    candidates: owned.map((m) => ({
      appId: m.appId,
      displayName: m.displayName,
      createdDateTime: m.createdDateTime
    })),
    defaultAppId,
    reason: "Multiple owned App Registrations match this repository's name."
  };
}

/**
 * Parse the set of `owner/repo` slugs a federated-credential set already serves,
 * from its subject strings. GitHub OIDC subjects look like
 * `repo:owner/repo:ref:refs/heads/main`, `repo:owner/repo:environment:prod`,
 * `repo:owner/repo:pull_request`, and the immutable form
 * `repo:owner@<ownerId>/repo@<repoId>:environment:prod`. We extract the
 * `owner/repo` segment (stripping any `@<id>` immutable suffixes) so a picker
 * can show which repos an app already serves.
 *
 * A repo that uses OIDC subject customization (use_default=false with the
 * `repository` claim key) instead begins the subject with `repository:` — e.g.
 * `repository:owner/repo:environment:prod` — which `buildOidcSubject` emits for
 * exactly that case. Both the default `repo:` and the customized `repository:`
 * prefixes carry the `owner/repo` slug, so we accept either. Note the trailing
 * `:` in the alternation is required, so this deliberately does NOT match the
 * `repository_id:`/`repository_owner:` claim keys (which carry an id/owner, not
 * a full slug).
 *
 * @param {Iterable<string>} subjects
 * @returns {string[]} sorted unique `owner/repo` values
 */
export function parseServedReposFromSubjects(
  subjects: Iterable<unknown> = []
): string[] {
  const repos = new Set<string>();
  for (const s of Array.from(subjects || [])) {
    if (typeof s !== "string") continue;
    const m = /^(?:repo|repository):([^:]+)/.exec(s.trim());
    if (!m) continue;
    const slug = m[1];
    const parts = slug.split("/");
    if (parts.length !== 2) continue;
    // Strip the immutable `@<numericId>` suffix from each segment if present.
    const owner = parts[0].replace(/@\d+$/, "");
    const repo = parts[1].replace(/@\d+$/, "");
    if (owner && repo) repos.add(`${owner}/${repo}`);
  }
  return [...repos].sort();
}

/**
 * Short human label summarizing the repos an App Registration already serves,
 * for the identity-picker rows. Pure and self-contained so it can be serialized
 * into the browser bundle via .toString() (see pages.ts) — the client runs this
 * exact function rather than a hand-copied twin.
 *
 * @param {string[]} list
 * @returns {string}
 */
export function formatServesReposLabel(
  list: readonly string[] | null | undefined
): string {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (list.length <= 3) return "Serves: " + list.join(", ");
  return (
    "Serves: " +
    list.slice(0, 3).join(", ") +
    " +" +
    (list.length - 3) +
    " more"
  );
}

// Entra display names allow a broad set; we restrict to a safe, human-typable
// subset (letters, digits, space, and - . _ ( )) and Entra's 120-char limit,
// rejecting control characters. This is also passed to `az ad app create
// --display-name`, so keeping it tight avoids surprising shell/Graph behavior.
const APP_NAME_ALLOWED_RE = /^[A-Za-z0-9 ._()-]+$/;

/**
 * @param {string} name
 * @returns {{ok:true, name:string} | {ok:false, reason:string}}
 */
export function validateAppRegistrationName(
  name: unknown
): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof name !== "string")
    return { ok: false, reason: "Application name must be a string." };
  const trimmed = name.trim();
  if (trimmed.length === 0)
    return { ok: false, reason: "Application name must not be empty." };
  if (trimmed.length > 120)
    return {
      ok: false,
      reason: "Application name must be at most 120 characters."
    };
  if (/[\u0000-\u001f\u007f]/.test(trimmed))
    return {
      ok: false,
      reason: "Application name must not contain control characters."
    };
  if (!APP_NAME_ALLOWED_RE.test(trimmed)) {
    return {
      ok: false,
      reason:
        "Application name may only contain letters, digits, spaces, and - . _ ( )."
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * Pure idempotency filter for federated credentials: return only the desired
 * FICs whose SUBJECT is not already present on the app. Matching is by subject
 * (not name) because the subject is the identity GitHub presents at token time,
 * and it keeps us under Azure's ~20-FIC/app cap on reruns.
 *
 * @param {{name:string,subject:string}[]} desired
 * @param {Iterable<string>} existingSubjects
 * @returns {{name:string,subject:string}[]}
 */
export function selectMissingFederatedCredentials(
  desired: readonly FederatedCredential[] = [],
  existingSubjects: Iterable<unknown> = []
): FederatedCredential[] {
  const have = new Set(
    Array.from(existingSubjects || [])
      .filter((s) => typeof s === "string")
      .map((s) => s.trim())
  );
  return (Array.isArray(desired) ? desired : []).filter(
    (f) => f && !have.has(String(f.subject).trim())
  );
}

/**
 * Pure status string for the Environment page resource-discovery result. The
 * `/api/discover` handler now records per-resource failures on `data.errors`
 * (instead of disguising them as empty arrays), so a real `az`/`aws` failure —
 * e.g. an ARM token not yet silently acquirable on Corpnet — surfaces as
 * "Discovery failed: <stderr>" rather than a misleading "Found 0 …". Pure and
 * self-contained so it is serialized into the browser bundle via .toString()
 * (see pages.ts `discoverResources`) — the client runs this exact function.
 *
 * @param {{clusters?:unknown[], resourceGroups?:unknown[], vpcs?:unknown[], subnets?:unknown[], error?:string, errors?:Record<string,string>}} data
 * @param {'azure'|'aws'} provider
 * @returns {string}
 */
export function discoverStatusText(
  data: DiscoveryData = {},
  provider: "azure" | "aws" = "azure"
): string {
  const errs = data.errors || {};
  if (provider === "aws") {
    const errMsg =
      data.error || errs.vpcs || errs.clusters || errs.subnets || "";
    if (errMsg) return "Discovery failed: " + errMsg;
    return `Found ${(data.clusters || []).length} cluster(s), ${
      (data.vpcs || []).length
    } VPC(s)`;
  }
  const errMsg = data.error || errs.resourceGroups || errs.clusters || "";
  if (errMsg) return "Discovery failed: " + errMsg;
  return `Found ${(data.clusters || []).length} cluster(s), ${
    (data.resourceGroups || []).length
  } resource group(s)`;
}

// Classify an `az ad app show --id <appId>` stderr as a genuine Graph
// "resource not found" (the id is stale/deleted — expected, non-fatal
// fallthrough) versus ANY other failure (auth / Conditional Access / expired
// token / permission / throttling / malformed id — must be fatal, fail closed).
//
// Match ONLY the canonical Microsoft Graph 404 markers `az ad app show`
// surfaces: the `Request_ResourceNotFound` error code and the exact phrase
// "does not exist or one of its queried reference-property objects are not
// present." A broad /not found/ would also match AADSTS auth errors (e.g.
// "resource principal ... was not found"), MSAL token-cache messages, and
// interactive-auth text — misclassifying an auth failure as "stale" and
// letting Step 3b create a duplicate app (the tenant-sprawl bug this prevents).
const AZ_NOT_FOUND_RE =
  /Request_ResourceNotFound|does not exist or one of its queried reference-property objects are not present/i;

/**
 * @param {string} stderr
 * @returns {boolean}
 */
export function isAzResourceNotFound(stderr: unknown): boolean {
  return AZ_NOT_FOUND_RE.test(String(stderr || ""));
}

/**
 * Pure decision for the "existingClientId-first" flow. Before the display-name
 * lookup, we prefer the identity already wired into the repo's AZURE_CLIENT_ID
 * so a repo rename or a hand-made app (whose display name isn't the canonical
 * `radius-deploy-<owner>-<repo>`) is never silently repointed to a name match.
 *
 * @param {{clientId?: string, showStatus?: 'found'|'not-found'|'lookup-failed', owned?: boolean, radiusProvenance?: {tags?: Iterable<unknown>, repo?: string, environment?: string}}} input
 *   `showStatus` is the classified result of `az ad app show --id <clientId>`.
 * @returns {{action:'reuse'|'error'|'fallthrough'|'fatal', code?:string, reason?:string, radiusOrphan?:boolean}}
 *   - reuse: the wired app exists and is owned — use it directly.
 *   - error: exists but the current signed-in user is not listed as an owner — do NOT repoint.
 *   - fatal `client-id-lookup-failed`: a real lookup failure (not a not-found).
 *   - fallthrough: no clientId, or a not-found (stale var) — use the name lookup.
 */
export function decideExistingClientId({
  clientId,
  showStatus,
  owned = false,
  radiusProvenance
}: {
  clientId?: string;
  showStatus?: string;
  owned?: boolean;
  radiusProvenance?: RadiusAppProvenanceInput;
} = {}): {
  action: "reuse" | "error" | "fallthrough" | "fatal";
  code?: string;
  reason?: string;
  radiusOrphan?: boolean;
} {
  if (!clientId || !String(clientId).trim()) return { action: "fallthrough" };
  if (showStatus === "not-found") return { action: "fallthrough" };
  if (showStatus === "lookup-failed")
    return { action: "fatal", code: "client-id-lookup-failed" };
  if (showStatus === "found") {
    if (owned) return { action: "reuse" };
    const decision = decideRadiusAppOwnership({
      ownedBySignedInUser: false,
      radiusProvenance
    });
    return {
      action: "error",
      code: decision.code,
      reason: decision.reason,
      radiusOrphan: decision.radiusOrphan
    };
  }
  // Unknown status — be conservative and treat as a lookup failure.
  return { action: "fatal", code: "client-id-lookup-failed" };
}

// Reference. These substrings are the real error identifiers and are matched
// case-insensitively against `az` stderr so we can turn an opaque failure into
// actionable guidance (and a machine-readable code the UI can react to).
export const SERVICE_MANAGEMENT_REFERENCE_ERROR_IDS = [
  "servicemanagementreference",
  "servicetreenullvalueprovided",
  "servicetreeinvalid"
];

export function isServiceManagementReferenceError(stderr: unknown): boolean {
  const s = String(stderr || "").toLowerCase();
  return SERVICE_MANAGEMENT_REFERENCE_ERROR_IDS.some((id) => s.includes(id));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function statusText(res: GitHubJsonResponse | undefined): string {
  if (res && res.status != null) return `HTTP ${res.status}`;
  return (res && res.stderr) || "request failed";
}

/**
 * Fetch a GitHub JSON resource through an injected `runner`, retrying idempotent
 * GETs on 429/5xx and transport errors with linear backoff.
 *
 * `runner(apiPath)` must resolve `{ ok, status, json, stderr }` and never reject.
 */
export async function fetchGitHubJson(
  runner: GitHubJsonRunner,
  apiPath: string,
  {
    retries = 3,
    baseDelayMs = 300,
    sleepFn = defaultSleep
  }: FetchGitHubJsonOptions = {}
): Promise<GitHubJsonResponse | undefined> {
  let last: GitHubJsonResponse | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    last = await runner(apiPath);
    const status = last?.status;
    const retriable =
      status === 429 || (status != null && status >= 500) || status == null;
    if (last?.ok || !retriable || attempt === retries) return last;
    await sleepFn(baseDelayMs * attempt);
  }
  return last;
}

/**
 * Resolve the federated-credential(s) to create so a repo's GitHub Actions OIDC
 * token can log into Azure, by reading the canonical repo and its OIDC subject
 * customization from GitHub.
 *
 * Design decisions enforced here:
 * - Read /repos/{repo} FIRST (proves access + gives canonical full_name and
 *   numeric ids); only then read the customization endpoint.
 * - Treat ONLY an explicit 404 from the customization endpoint as "not opted
 *   into a custom subject" (default format). Any other non-OK status is a hard,
 *   actionable failure — never silently default.
 * - DEFAULT (not customized) subject: emit only the immutable credential when
 *   GitHub explicitly reports immutable subjects. Otherwise emit both forms.
 *   `use_immutable_subject=false` is an opt-out setting and does not prove the
 *   effective format for repositories covered by GitHub's immutable-default
 *   rollout, so the compatibility hedge remains for false/absent signals.
 * - CUSTOM subject: build the single exact subject from the customization
 *   config (buildOidcSubject fails loud if a repo/repository key needs an
 *   immutability decision it cannot make).
 * - On the customization 200 path, require an explicit boolean `use_default`
 *   and positive numeric owner/repo ids; fail closed on a malformed body.
 *
 * @returns {Promise<{federatedCredentials:{name:string,subject:string}[], fullName:string, ownerId:number, repoId:number, subjectConfig:object}>}
 */
export async function resolveOidcSubject(
  { targetRepo, envName, suffix }: ResolveOidcSubjectInput,
  runner: GitHubJsonRunner,
  opts: FetchGitHubJsonOptions = {}
): Promise<ResolveOidcSubjectResult> {
  if (!isValidRepoSlug(targetRepo)) {
    throw oidcError(
      "invalid-repo",
      `Invalid repository "${targetRepo}". Expected "owner/repo".`
    );
  }

  // 1. Canonical repo metadata (and access proof).
  const repoRes = await fetchGitHubJson(runner, `/repos/${targetRepo}`, opts);
  if (!repoRes?.ok) {
    throw oidcError(
      "repo-access",
      `Could not read repository "${targetRepo}" from GitHub (${statusText(
        repoRes
      )}). ` +
        `Verify the repository exists and that you have access, then retry.`
    );
  }
  const repo = repoRes.json || {};
  const fullName = repo.full_name;
  const ownerId = Number(repo.owner?.id);
  const repoId = Number(repo.id);
  if (
    !fullName ||
    !Number.isFinite(Number(ownerId)) ||
    Number(ownerId) <= 0 ||
    !Number.isFinite(Number(repoId)) ||
    Number(repoId) <= 0
  ) {
    throw oidcError(
      "repo-metadata",
      `GitHub did not return a valid full_name/id/owner.id for "${targetRepo}"; cannot build a reliable OIDC subject.`
    );
  }

  // 2. OIDC subject customization — only after repo access succeeds.
  // Response schema (REST API version 2026-03-10):
  // https://docs.github.com/en/rest/actions/oidc — GET .../actions/oidc/customization/sub
  // returns { use_default (bool, required), include_claim_keys (string[]),
  // use_immutable_subject (bool), sub_claim_prefix (string) }. The latter two
  // arrived with GitHub's immutable-subject rollout and are absent on older GHES,
  // so both are read defensively below (a missing field is not an error).
  const custRes = await fetchGitHubJson(
    runner,
    `/repos/${fullName}/actions/oidc/customization/sub`,
    opts
  );
  let subjectConfig: OidcSubjectConfig;
  if (custRes?.ok) {
    const c = custRes.json || {};
    if (typeof c.use_default !== "boolean") {
      throw oidcError(
        "customization-malformed",
        `GitHub's OIDC customization response for "${fullName}" is missing an ` +
          `explicit boolean use_default; refusing to guess the subject.`
      );
    }
    subjectConfig = {
      useDefault: c.use_default,
      includeClaimKeys: Array.isArray(c.include_claim_keys)
        ? c.include_claim_keys
        : []
    };
    if (typeof c.use_immutable_subject === "boolean") {
      subjectConfig.useImmutableSubject = c.use_immutable_subject;
    }
    if (typeof c.sub_claim_prefix === "string" && c.sub_claim_prefix) {
      subjectConfig.subClaimPrefix = c.sub_claim_prefix;
      if (subjectConfig.useImmutableSubject === undefined) {
        const [owner, repoName] = fullName.split("/");
        const prefixSlug = c.sub_claim_prefix.replace(/^repo:/, "");
        const expectedImmutableSlug = `${owner}@${ownerId}/${repoName}@${repoId}`;
        if (prefixSlug === expectedImmutableSlug) {
          subjectConfig.useImmutableSubject = true;
        } else if (!prefixSlug.includes("@")) {
          // GitHub logins and repository names cannot contain "@", so a
          // name-only prefix is provably mutable even when the boolean is absent.
          subjectConfig.useImmutableSubject = false;
        }
      }
    }
  } else if (custRes?.status === 404) {
    // Not opted into a custom subject → default format.
    subjectConfig = { useDefault: true };
  } else {
    throw oidcError(
      "customization-access",
      `Could not read OIDC subject customization for "${fullName}" (${statusText(
        custRes
      )}). ` + `Refusing to guess the subject; resolve GitHub access and retry.`
    );
  }

  const commonInput = { repoFullName: fullName, ownerId, repoId, suffix };
  const federatedCredentials: FederatedCredential[] = [];

  if (subjectConfig.useDefault) {
    // An explicit/proven immutable result is security-sensitive: retaining the
    // mutable name-based trust would permit namespace recycling. All other
    // states remain dual because GitHub's rollout can enforce immutable defaults
    // independently of the repository opt-in setting.
    if (subjectConfig.useImmutableSubject !== true) {
      federatedCredentials.push({
        name: buildFederatedCredentialName({
          repoFullName: fullName,
          envName,
          variant: "mutable"
        }),
        subject: buildOidcSubject({
          ...commonInput,
          subjectConfig: { useDefault: true, useImmutableSubject: false }
        })
      });
    }
    federatedCredentials.push({
      name: buildFederatedCredentialName({
        repoFullName: fullName,
        envName,
        variant: "immutable"
      }),
      subject: buildOidcSubject({
        ...commonInput,
        subjectConfig: {
          useDefault: true,
          useImmutableSubject: true,
          ...(subjectConfig.useImmutableSubject === true
            ? { subClaimPrefix: subjectConfig.subClaimPrefix }
            : {})
        }
      })
    });
  } else {
    // Customized subject: one exact credential. buildOidcSubject throws if a
    // repo/repository key needs an immutability decision it cannot make — that
    // is the one place a clear failure is acceptable.
    federatedCredentials.push({
      name: buildFederatedCredentialName({ repoFullName: fullName, envName }),
      subject: buildOidcSubject({ ...commonInput, subjectConfig })
    });
  }

  return { federatedCredentials, fullName, ownerId, repoId, subjectConfig };
}
