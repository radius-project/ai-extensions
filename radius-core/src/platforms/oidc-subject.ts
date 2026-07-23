// Pure OIDC subject-claim construction for GitHub Actions federated identity.
//
// GitHub's OIDC `sub` claim is NOT always `repo:{owner}/{repo}:{suffix}`.
// Orgs/repos can customize it (GET
// /repos/{owner}/{repo}/actions/oidc/customization/sub -> {use_default,
// include_claim_keys}), and as of GitHub's July 2026 immutable-subject rollout
// the default itself can become
// `repo:{owner}@{ownerId}/{repo}@{repoId}:{suffix}`. A subject that doesn't
// match what GitHub actually mints fails deploy-time Azure login with
// `AADSTS700213: No matching federated identity record found`.
//
// This module is PURE (no I/O): all inputs — canonical full_name, numeric IDs,
// and the customization config — must be pre-fetched by the caller. The mapping
// mirrors the azd CLI (Azure/azure-dev cli/azd/pkg/tools/github/oidc.go
// BuildOIDCSubject); the immutable-default form is layered on top per GitHub's
// immutable-subject docs. Unknown claim keys FAIL LOUD so the extension is
// updated rather than silently emitting a wrong subject.

/**
 * Models GitHub's OIDC subject customization for a repository.
 *
 * - `useDefault`:        the repo uses GitHub's default subject format.
 * - `includeClaimKeys`:  when `useDefault` is false, the ordered claim keys that
 *                        compose the custom subject.
 * - `useImmutableSubject`: the default (or org template) uses the immutable
 *                        `owner@<ownerId>/repo@<repoId>` form.
 * - `subClaimPrefix`:    optional prefix GitHub reports for the subject; carried
 *                        for completeness/debugging (not required to build the
 *                        subject when the flags above are set).
 */
export interface OidcSubjectConfig {
  useDefault: boolean;
  includeClaimKeys?: string[];
  useImmutableSubject?: boolean;
  subClaimPrefix?: string;
}

export interface BuildOidcSubjectInput {
  /** Canonical repository full name from the API ("owner/repo"), not user casing. */
  repoFullName: string;
  /** Numeric repository owner id (GitHub `owner.id`). */
  ownerId?: number | string;
  /** Numeric repository id (GitHub `id`). */
  repoId?: number | string;
  /** Trailing subject part, e.g. "environment:production" or "ref:refs/heads/main". */
  suffix: string;
  /** Customization config for the repo; when omitted the default format is used. */
  subjectConfig?: OidcSubjectConfig | null;
}

function parseOwnerRepo(repoFullName: string): { owner: string; repo: string } {
  const value = (repoFullName || "").trim();
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repository full name: expected "owner/repo", got "${repoFullName}".`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

function requireId(
  value: number | string | undefined,
  label: string,
  repoFullName: string,
): string {
  if (value === undefined || value === null || `${value}`.trim() === "") {
    throw new Error(
      `OIDC subject for ${repoFullName} requires ${label}, but it was not provided.`,
    );
  }
  return `${value}`.trim();
}

/**
 * Build the federated-credential `subject` string GitHub will actually present.
 *
 * Rules:
 * - default + mutable:   `repo:{owner}/{repo}:{suffix}`
 * - default + immutable: `repo:{owner}@{ownerId}/{repo}@{repoId}:{suffix}`
 * - custom (use_default=false): map each `includeClaimKeys` entry (as azd does)
 *   using the canonical full_name and numeric IDs, joined with ":".
 *
 * Throws (fail loud) on an unknown/unsupported claim key, on a missing numeric
 * ID that a selected key requires, or on a use_default=false config with no
 * claim keys.
 */
export function buildOidcSubject(input: BuildOidcSubjectInput): string {
  const { repoFullName, ownerId, repoId, suffix, subjectConfig } = input;
  const { owner, repo } = parseOwnerRepo(repoFullName);
  const canonical = `${owner}/${repo}`;

  if (!subjectConfig || subjectConfig.useDefault) {
    if (subjectConfig?.useImmutableSubject) {
      const oid = requireId(ownerId, "the numeric owner id", canonical);
      const rid = requireId(repoId, "the numeric repository id", canonical);
      return `repo:${owner}@${oid}/${repo}@${rid}:${suffix}`;
    }
    return `repo:${canonical}:${suffix}`;
  }

  const keys = subjectConfig.includeClaimKeys ?? [];
  if (keys.length === 0) {
    throw new Error(
      `OIDC config for ${canonical} has use_default=false but no claim keys ` +
        `(include_claim_keys is empty).`,
    );
  }

  const parts: string[] = [];
  for (const key of keys) {
    switch (key) {
      case "repository":
        parts.push(`repository:${canonical}`);
        break;
      case "repository_id":
        parts.push(`repository_id:${requireId(repoId, "the numeric repository id", canonical)}`);
        break;
      case "repository_owner":
        parts.push(`repository_owner:${owner}`);
        break;
      case "repository_owner_id":
        parts.push(`repository_owner_id:${requireId(ownerId, "the numeric owner id", canonical)}`);
        break;
      case "context":
        // GitHub's term for the dynamic trailing part of the subject
        // (e.g. "environment:prod" or "ref:refs/heads/main"): our suffix.
        parts.push(suffix);
        break;
      case "repo":
        parts.push(`repo:${canonical}`);
        break;
      default:
        throw new Error(
          `Unsupported OIDC claim key "${key}" in the subject template for ` +
            `${canonical}. The Radius extension needs to be updated to map ` +
            `this claim before a federated credential can be created safely.`,
        );
    }
  }
  return parts.join(":");
}
