// Canvas adapter — Azure OIDC auto-setup orchestration helpers.
//
// The `/api/azure-auto-setup` route in server.mjs runs `az`/`gh` as child
// processes to bootstrap a federated-identity App Registration so a user's repo
// can deploy to Azure. The pure decisions in that flow — how to construct the
// federated-credential `subject`, how to build the `az ad app create` argv, how
// to classify an `az` Service-Tree policy failure, and how to validate inputs —
// live here so they can be unit-tested without spawning processes. Actual I/O
// (spawning `az`/`gh`) stays in server.mjs; the network reads are injected as a
// `runner` so this module remains testable.

import { buildOidcSubject } from "@radius-project/core";

// owner/repo, exactly two non-empty, slash-free segments.
export const REPO_SLUG_RE = /^[^/]+\/[^/]+$/;
// Canonical 8-4-4-4-12 UUID (Service Tree ids, tenant/subscription ids).
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Azure resource-group / cluster names: conservative allow-list that also
// rejects leading '-' so a value can never be mistaken for a CLI flag in argv.
export const AZURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/;

// Pin the API version so the OIDC customization payload (which now carries
// `use_immutable_subject` / `sub_claim_prefix`) is stable across gh/GitHub
// upgrades.
export const GITHUB_API_VERSION = "2022-11-28";

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function isValidRepoSlug(value) {
  return typeof value === "string" && REPO_SLUG_RE.test(value.trim());
}

export function isAzureName(value) {
  return typeof value === "string" && AZURE_NAME_RE.test(value.trim());
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
    // Registration to carry a Service Tree id (serviceManagementReference).
    args.push("--service-management-reference", serviceManagementReference);
  }
  return args;
}

// Known Entra error identifiers for a missing/invalid Service Tree id. Matched
// case-insensitively against `az` stderr so we can turn an opaque failure into
// actionable guidance.
export const SERVICE_TREE_ERROR_IDS = [
  "servicemanagementreference",
  "servicetreenullvalueprovided",
  "servicetreeinvalid",
];

export function isServiceTreeError(stderr) {
  const s = (stderr || "").toLowerCase();
  return SERVICE_TREE_ERROR_IDS.some((id) => s.includes(id));
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
 * Resolve the exact federated-credential `subject` GitHub will present for a
 * repo + suffix (e.g. "environment:dev"), by reading the canonical repo and its
 * OIDC subject customization from GitHub.
 *
 * Design-review requirements enforced here:
 * - Read /repos/{repo} FIRST (proves access + gives canonical full_name and
 *   numeric ids); only then read the customization endpoint.
 * - Treat ONLY an explicit 404 from the customization endpoint as "not opted
 *   into a custom subject" (default format). Any other non-OK status is a hard,
 *   actionable failure — never silently default.
 * - Determine immutable-vs-mutable default from the API
 *   (use_immutable_subject / sub_claim_prefix). If it cannot be determined,
 *   FAIL CLOSED rather than writing a possibly-wrong subject. Callers may pass
 *   `immutableOverride` (boolean) to assert the format deliberately.
 *
 * @returns {Promise<{subject:string, fullName:string, ownerId:number, repoId:number, subjectConfig:object}>}
 */
export async function resolveOidcSubject(
  { targetRepo, suffix, immutableOverride },
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
  if (!fullName || ownerId == null || repoId == null) {
    throw oidcError(
      "repo-metadata",
      `GitHub did not return full_name/id/owner.id for "${targetRepo}"; cannot build a reliable OIDC subject.`,
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
    subjectConfig = {
      useDefault: c.use_default !== false,
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

  // 3. For the default format, immutability must be known. Fail closed if not.
  if (subjectConfig.useDefault) {
    if (typeof immutableOverride === "boolean") {
      subjectConfig.useImmutableSubject = immutableOverride;
    }
    if (subjectConfig.useImmutableSubject === undefined) {
      throw oidcError(
        "immutable-unknown",
        `Could not determine whether "${fullName}" uses GitHub's immutable OIDC subject format. ` +
          `Writing a federated credential now risks a deploy-time AADSTS700213 mismatch. ` +
          `Opt in or preview the subject via the OIDC customization API (so sub_claim_prefix is available), ` +
          `or re-run with the immutable-subject setting specified.`,
      );
    }
  }

  const subject = buildOidcSubject({
    repoFullName: fullName,
    ownerId,
    repoId,
    suffix,
    subjectConfig,
  });
  return { subject, fullName, ownerId, repoId, subjectConfig };
}
