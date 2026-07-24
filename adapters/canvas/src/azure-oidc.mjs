// Canvas adapter — Azure OIDC auto-setup orchestration helpers.
//
// The `/api/azure-auto-setup` route in server.mjs runs `az`/`gh` as child
// processes to bootstrap a federated-identity App Registration so a user's repo
// can deploy to Azure. The pure decisions in that flow — which
// federated-credential `subject`(s) to create, how to build the `az ad app
// create` argv, how to classify an `az` Service Management Reference policy
// failure, and how to validate inputs — live here so they can be unit-tested
// without spawning processes. Actual I/O (spawning `az`/`gh`) stays in
// server.mjs; the network reads are injected as a `runner` so this module
// remains testable.

import {
  buildOidcSubject,
  buildFederatedCredentialName,
} from "@radius-project/core";

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
export const AKS_CLUSTER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,61}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
// Resource group name: <=90 chars from Azure's allowed set, but NOT ending in a
// dot (Azure rejects a trailing period). Leading char restricted to alphanumeric.
export const RESOURCE_GROUP_NAME_RE =
  /^[A-Za-z0-9][A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-]$|^[A-Za-z0-9]$/;

// Pin the API version so the OIDC customization payload (which carries
// `use_immutable_subject` / `sub_claim_prefix`) is stable across gh/GitHub
// upgrades.
export const GITHUB_API_VERSION = "2022-11-28";

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function isValidRepoSlug(value) {
  return typeof value === "string" && REPO_SLUG_RE.test(value.trim());
}

export function isAksClusterName(value) {
  return typeof value === "string" && AKS_CLUSTER_NAME_RE.test(value.trim());
}

export function isResourceGroupName(value) {
  return typeof value === "string" && RESOURCE_GROUP_NAME_RE.test(value.trim());
}

/** Attach a machine-readable `code` to an Error for the JSON error response. */
export function oidcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Build the argv for `az ad app create`, adding SMR only when supplied. */
export function buildAppCreateArgs({ appName, serviceManagementReference } = {}) {
  const args = [
    "ad", "app", "create",
    "--display-name", appName,
    "--query", "appId",
    "-o", "tsv",
  ];
  if (serviceManagementReference) {
    // Enterprise Entra tenants enforce a policy requiring every new App
    // Registration to carry a Service Management Reference (for
    // Microsoft-internal tenants this is a Service Tree id GUID).
    args.push("--service-management-reference", serviceManagementReference);
  }
  return args;
}

/**
 * Pure disambiguation for the lookup-then-create idempotency flow. Given the
 * app registrations whose display name matches AND are owned by the signed-in
 * user (plus whether any *unowned* app shares the name), decide whether to
 * reuse an existing app or create a new one.
 *
 * Rules:
 * - 0 owned matches, no unowned match  → create a fresh app.
 * - 0 owned matches, an unowned match  → error `app-registration-not-owned`
 *   (never silently create a duplicate or reuse another user's app in a shared
 *   tenant — FIC/role writes would fail).
 * - exactly 1 owned match              → reuse it.
 * - >1 owned matches                   → prefer the appId equal to the repo's
 *   existing AZURE_CLIENT_ID (if among the owned matches); else the oldest by
 *   createdDateTime for stability. Never picks arbitrarily/first-unsorted.
 *
 * @param {{ownedMatches?: {appId:string,id?:string,createdDateTime?:string}[], hasUnownedMatch?: boolean, existingClientId?: string}} input
 * @returns {{action:'reuse'|'create'|'error', appId?:string, code?:string, reason?:string, duplicates?:boolean}}
 */
export function selectAppRegistration({ ownedMatches = [], hasUnownedMatch = false, existingClientId } = {}) {
  const owned = (Array.isArray(ownedMatches) ? ownedMatches : []).filter((m) => m && m.appId);

  if (owned.length === 0) {
    if (hasUnownedMatch) {
      return {
        action: "error",
        code: "app-registration-not-owned",
        reason:
          "An App Registration with this name already exists but is owned by another user. " +
          "Reusing it would fail (federated-credential and role writes require ownership). " +
          "Coordinate with the owner or rename, then retry.",
      };
    }
    return { action: "create" };
  }

  if (owned.length === 1) {
    return { action: "reuse", appId: owned[0].appId, duplicates: false };
  }

  // More than one owned match — disambiguate deterministically.
  const norm = (v) => String(v || "").trim().toLowerCase();
  if (existingClientId) {
    const preferred = owned.find((m) => norm(m.appId) === norm(existingClientId));
    if (preferred) {
      return {
        action: "reuse",
        appId: preferred.appId,
        duplicates: true,
        reason: "matched the repository's existing AZURE_CLIENT_ID",
      };
    }
  }
  const oldest = [...owned].sort((a, b) => {
    const ta = Date.parse(a.createdDateTime || "");
    const tb = Date.parse(b.createdDateTime || "");
    return (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb);
  })[0];
  return {
    action: "reuse",
    appId: oldest.appId,
    duplicates: true,
    reason: "oldest owned match (duplicate app registrations detected)",
  };
}

/**
 * Pure disambiguation for Step 3b that supports an interactive picker and an
 * explicit opt-in choice, layered on top of `selectAppRegistration`'s heuristic.
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
 * @param {{ownedMatches?: {appId:string,displayName?:string,createdDateTime?:string}[], hasUnownedMatch?: boolean, existingClientId?: string, explicitAppId?: string, createNew?: boolean}} input
 * @returns {{action:'reuse'|'create'|'error'|'needs-selection', appId?:string, code?:string, reason?:string, duplicates?:boolean, candidates?:object[], defaultAppId?:string}}
 */
export function decideAppSelection({
  ownedMatches = [],
  hasUnownedMatch = false,
  existingClientId,
  explicitAppId,
  createNew = false,
} = {}) {
  const owned = (Array.isArray(ownedMatches) ? ownedMatches : []).filter((m) => m && m.appId);
  const norm = (v) => String(v || "").trim().toLowerCase();

  // An explicit picker choice wins — but only if the caller owns it. An
  // explicitAppId not among the owned candidates is unsafe (we can't verify
  // ownership here), so it is an error rather than a silent create/reuse.
  if (explicitAppId && String(explicitAppId).trim()) {
    const picked = owned.find((m) => norm(m.appId) === norm(explicitAppId));
    if (picked) return { action: "reuse", appId: picked.appId };
    return {
      action: "error",
      code: "app-registration-not-owned",
      reason:
        "The selected App Registration is not owned by the signed-in user (or no longer exists). " +
        "Choose an owned application or create a new one.",
    };
  }

  // Explicit "create new" short-circuits the reuse heuristics.
  if (createNew === true) return { action: "create" };

  if (owned.length === 0) {
    if (hasUnownedMatch) {
      return {
        action: "error",
        code: "app-registration-not-owned",
        reason:
          "An App Registration with this name already exists but is owned by another user. " +
          "Reusing it would fail (federated-credential and role writes require ownership). " +
          "Coordinate with the owner or rename, then retry.",
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
    const preferred = owned.find((m) => norm(m.appId) === norm(existingClientId));
    if (preferred) defaultAppId = preferred.appId;
  }
  if (!defaultAppId) {
    const oldest = [...owned].sort((a, b) => {
      const ta = Date.parse(a.createdDateTime || "");
      const tb = Date.parse(b.createdDateTime || "");
      return (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb);
    })[0];
    defaultAppId = oldest.appId;
  }
  return {
    action: "needs-selection",
    candidates: owned.map((m) => ({
      appId: m.appId,
      displayName: m.displayName,
      createdDateTime: m.createdDateTime,
    })),
    defaultAppId,
    reason: "Multiple owned App Registrations match this repository's name.",
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
 * @param {Iterable<string>} subjects
 * @returns {string[]} sorted unique `owner/repo` values
 */
export function parseServedReposFromSubjects(subjects) {
  const repos = new Set();
  for (const s of Array.from(subjects || [])) {
    if (typeof s !== "string") continue;
    const m = /^repo:([^:]+)/.exec(s.trim());
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
 * for the identity-picker rows. Pure; mirrored in the browser as
 * formatServesReposLabelClient (pages.mjs) since that file can't import here.
 *
 * @param {string[]} list
 * @returns {string}
 */
export function formatServesReposLabel(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (list.length <= 3) return "Serves: " + list.join(", ");
  return "Serves: " + list.slice(0, 3).join(", ") + " +" + (list.length - 3) + " more";
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
export function validateAppRegistrationName(name) {
  if (typeof name !== "string") return { ok: false, reason: "Application name must be a string." };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Application name must not be empty." };
  if (trimmed.length > 120) return { ok: false, reason: "Application name must be at most 120 characters." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, reason: "Application name must not contain control characters." };
  if (!APP_NAME_ALLOWED_RE.test(trimmed)) {
    return { ok: false, reason: "Application name may only contain letters, digits, spaces, and - . _ ( )." };
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
export function selectMissingFederatedCredentials(desired = [], existingSubjects = []) {
  const have = new Set(
    Array.from(existingSubjects || [])
      .filter((s) => typeof s === "string")
      .map((s) => s.trim()),
  );
  return (Array.isArray(desired) ? desired : []).filter((f) => f && !have.has(String(f.subject).trim()));
}

/**
 * Pure status string for the Environment page resource-discovery result. The
 * `/api/discover` handler now records per-resource failures on `data.errors`
 * (instead of disguising them as empty arrays), so a real `az`/`aws` failure —
 * e.g. an ARM token not yet silently acquirable on Corpnet — surfaces as
 * "Discovery failed: <stderr>" rather than a misleading "Found 0 …".
 *
 * @param {{clusters?:any[], resourceGroups?:any[], vpcs?:any[], subnets?:any[], error?:string, errors?:Record<string,string>}} data
 * @param {'azure'|'aws'} provider
 * @returns {string}
 */
export function discoverStatusText(data = {}, provider = "azure") {
  const errs = data.errors || {};
  if (provider === "aws") {
    const errMsg = data.error || errs.vpcs || errs.clusters || errs.subnets || "";
    if (errMsg) return "Discovery failed: " + errMsg;
    return `Found ${(data.clusters || []).length} cluster(s), ${(data.vpcs || []).length} VPC(s)`;
  }
  const errMsg = data.error || errs.resourceGroups || errs.clusters || "";
  if (errMsg) return "Discovery failed: " + errMsg;
  return `Found ${(data.clusters || []).length} cluster(s), ${(data.resourceGroups || []).length} resource group(s)`;
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
export function isAzResourceNotFound(stderr) {
  return AZ_NOT_FOUND_RE.test(String(stderr || ""));
}

/**
 * Pure decision for the "existingClientId-first" flow. Before the display-name
 * lookup, we prefer the identity already wired into the repo's AZURE_CLIENT_ID
 * so a repo rename or a hand-made app (whose display name isn't the canonical
 * `radius-deploy-<owner>-<repo>`) is never silently repointed to a name match.
 *
 * @param {{clientId?: string, showStatus?: 'found'|'not-found'|'lookup-failed', owned?: boolean}} input
 *   `showStatus` is the classified result of `az ad app show --id <clientId>`.
 * @returns {{action:'reuse'|'error'|'fallthrough'|'fatal', code?:string}}
 *   - reuse: the wired app exists and is owned — use it directly.
 *   - error `client-id-not-owned`: exists but owned by someone else — do NOT repoint.
 *   - fatal `client-id-lookup-failed`: a real lookup failure (not a not-found).
 *   - fallthrough: no clientId, or a not-found (stale var) — use the name lookup.
 */
export function decideExistingClientId({ clientId, showStatus, owned = false } = {}) {
  if (!clientId || !String(clientId).trim()) return { action: "fallthrough" };
  if (showStatus === "not-found") return { action: "fallthrough" };
  if (showStatus === "lookup-failed") return { action: "fatal", code: "client-id-lookup-failed" };
  if (showStatus === "found") {
    return owned ? { action: "reuse" } : { action: "error", code: "client-id-not-owned" };
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
  "servicetreeinvalid",
];

export function isServiceManagementReferenceError(stderr) {
  const s = (stderr || "").toLowerCase();
  return SERVICE_MANAGEMENT_REFERENCE_ERROR_IDS.some((id) => s.includes(id));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusText(res) {
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
  runner,
  apiPath,
  { retries = 3, baseDelayMs = 300, sleepFn = defaultSleep } = {},
) {
  let last;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    last = await runner(apiPath);
    const status = last?.status;
    const retriable = status === 429 || (status != null && status >= 500) || status == null;
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
 * - DEFAULT (not customized) subject: rather than fail closed on undetermined
 *   immutability, emit BOTH federated credentials — the mutable
 *   `repo:{owner}/{repo}:{suffix}` and the immutable
 *   `repo:{owner}@{ownerId}/{repo}@{repoId}:{suffix}`. GitHub presents exactly
 *   one subject at token time; the matching credential authorizes login and the
 *   other is inert. Azure allows ~20 FICs/app, so two-per-environment is fine.
 * - CUSTOM subject: build the single exact subject from the customization
 *   config (buildOidcSubject fails loud if a repo/repository key needs an
 *   immutability decision it cannot make).
 * - On the customization 200 path, require an explicit boolean `use_default`
 *   and positive numeric owner/repo ids; fail closed on a malformed body.
 *
 * @returns {Promise<{federatedCredentials:{name:string,subject:string}[], fullName:string, ownerId:number, repoId:number, subjectConfig:object}>}
 */
export async function resolveOidcSubject(
  { targetRepo, envName, suffix },
  runner,
  opts = {},
) {
  if (!isValidRepoSlug(targetRepo)) {
    throw oidcError(
      "invalid-repo",
      `Invalid repository "${targetRepo}". Expected "owner/repo".`,
    );
  }

  // 1. Canonical repo metadata (and access proof).
  const repoRes = await fetchGitHubJson(runner, `/repos/${targetRepo}`, opts);
  if (!repoRes?.ok) {
    throw oidcError(
      "repo-access",
      `Could not read repository "${targetRepo}" from GitHub (${statusText(repoRes)}). ` +
        `Verify the repository exists and that you have access, then retry.`,
    );
  }
  const repo = repoRes.json || {};
  const fullName = repo.full_name;
  const ownerId = repo.owner?.id;
  const repoId = repo.id;
  if (
    !fullName ||
    !Number.isFinite(Number(ownerId)) || Number(ownerId) <= 0 ||
    !Number.isFinite(Number(repoId)) || Number(repoId) <= 0
  ) {
    throw oidcError(
      "repo-metadata",
      `GitHub did not return a valid full_name/id/owner.id for "${targetRepo}"; cannot build a reliable OIDC subject.`,
    );
  }

  // 2. OIDC subject customization — only after repo access succeeds.
  const custRes = await fetchGitHubJson(
    runner,
    `/repos/${fullName}/actions/oidc/customization/sub`,
    opts,
  );
  let subjectConfig;
  if (custRes?.ok) {
    const c = custRes.json || {};
    if (typeof c.use_default !== "boolean") {
      throw oidcError(
        "customization-malformed",
        `GitHub's OIDC customization response for "${fullName}" is missing an ` +
          `explicit boolean use_default; refusing to guess the subject.`,
      );
    }
    subjectConfig = {
      useDefault: c.use_default,
      includeClaimKeys: Array.isArray(c.include_claim_keys) ? c.include_claim_keys : [],
    };
    if (typeof c.use_immutable_subject === "boolean") {
      subjectConfig.useImmutableSubject = c.use_immutable_subject;
    }
    if (typeof c.sub_claim_prefix === "string" && c.sub_claim_prefix) {
      subjectConfig.subClaimPrefix = c.sub_claim_prefix;
      if (subjectConfig.useImmutableSubject === undefined) {
        // A prefix containing owner@id/repo@id is the immutable form.
        subjectConfig.useImmutableSubject = c.sub_claim_prefix.includes("@");
      }
    }
  } else if (custRes?.status === 404) {
    // Not opted into a custom subject → default format.
    subjectConfig = { useDefault: true };
  } else {
    throw oidcError(
      "customization-access",
      `Could not read OIDC subject customization for "${fullName}" (${statusText(custRes)}). ` +
        `Refusing to guess the subject; resolve GitHub access and retry.`,
    );
  }

  const commonInput = { repoFullName: fullName, ownerId, repoId, suffix };
  const federatedCredentials = [];

  if (subjectConfig.useDefault) {
    // Emit BOTH default forms so whichever GitHub actually mints matches. This
    // removes the fail-closed dead-end and any user mutable/immutable choice.
    federatedCredentials.push({
      name: buildFederatedCredentialName({ repoFullName: fullName, envName, variant: "mutable" }),
      subject: buildOidcSubject({ ...commonInput, subjectConfig: { useDefault: true, useImmutableSubject: false } }),
    });
    federatedCredentials.push({
      name: buildFederatedCredentialName({ repoFullName: fullName, envName, variant: "immutable" }),
      subject: buildOidcSubject({
        ...commonInput,
        subjectConfig: { useDefault: true, useImmutableSubject: true, subClaimPrefix: subjectConfig.subClaimPrefix },
      }),
    });
  } else {
    // Customized subject: one exact credential. buildOidcSubject throws if a
    // repo/repository key needs an immutability decision it cannot make — that
    // is the one place a clear failure is acceptable.
    federatedCredentials.push({
      name: buildFederatedCredentialName({ repoFullName: fullName, envName }),
      subject: buildOidcSubject({ ...commonInput, subjectConfig }),
    });
  }

  return { federatedCredentials, fullName, ownerId, repoId, subjectConfig };
}
