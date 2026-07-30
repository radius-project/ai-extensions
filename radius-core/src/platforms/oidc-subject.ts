// Pure OIDC subject-claim construction for GitHub Actions federated identity.
//
// GitHub's OIDC `sub` claim is NOT always `repo:{owner}/{repo}:{suffix}`.
// Orgs/repos can customize it (GET
// /repos/{owner}/{repo}/actions/oidc/customization/sub -> {use_default,
// include_claim_keys, use_immutable_subject, sub_claim_prefix}; see
// https://docs.github.com/en/rest/actions/oidc), and with GitHub's
// immutable-subject rollout the default itself can become
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
 * - `subClaimPrefix`:    the exact subject prefix GitHub reports (e.g.
 *                        `repo:octo-org@111/octo-repo@222`); preferred verbatim
 *                        for the immutable slug when present.
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
 * GitHub encodes the environment name inside the subject and escapes `:` as
 * `%3A` (an environment name may itself contain a colon). Build the trailing
 * `environment:<name>` claim the same way so the federated-credential subject
 * matches the token GitHub mints.
 *
 * `:` is the ONLY character GitHub percent-escapes in the environment segment of
 * the subject — other characters are passed through verbatim — so a single
 * `:` → `%3A` replacement is complete, not a partial encoding.
 */
export function buildEnvironmentSuffix(envName: string): string {
  const encoded = String(envName ?? "").replace(/:/g, "%3A");
  return `environment:${encoded}`;
}

// Immutable repository slug: prefer GitHub's exact reported prefix; otherwise
// compose it from the canonical login/name and numeric ids.
function immutableSlug(
  owner: string,
  repo: string,
  ownerId: string,
  repoId: string,
  subClaimPrefix?: string,
): string {
  if (subClaimPrefix) {
    // sub_claim_prefix is reported as "repo:{owner}@{oid}/{repo}@{rid}".
    const withoutRepo = subClaimPrefix.replace(/^repo:/, "");
    if (withoutRepo.includes("@")) return withoutRepo;
  }
  return `${owner}@${ownerId}/${repo}@${repoId}`;
}

/**
 * The `include_claim_keys` values buildOidcSubject knows how to translate into a
 * federated-credential subject. Anything outside this set is an org/repo-level
 * subject customization the extension cannot map yet and is reported up front
 * (see the unmapped-key guard in buildOidcSubject). Keep in sync with the switch
 * in buildOidcSubject.
 */
const SUPPORTED_CLAIM_KEYS: ReadonlySet<string> = new Set([
  "repository",
  "repository_id",
  "repository_owner",
  "repository_owner_id",
  "environment",
  "context",
  "repo",
]);

/**
 * Build the federated-credential `subject` string GitHub will actually present.
 *
 * Rules:
 * - default + mutable:   `repo:{owner}/{repo}:{suffix}`
 * - default + immutable: `repo:{owner}@{ownerId}/{repo}@{repoId}:{suffix}`
 * - custom (use_default=false): map each `includeClaimKeys` entry (as azd does)
 *   using the canonical full_name and numeric IDs, joined with ":". For the
 *   `repo`/`repository` keys the immutable slug is used when the config is
 *   immutable.
 *
 * Throws (fail loud) on an unknown/unsupported claim key, on a missing numeric
 * ID that a selected key requires, on a `repo`/`repository` key whose
 * immutability cannot be determined, or on a use_default=false config with no
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
      return `repo:${immutableSlug(owner, repo, oid, rid, subjectConfig.subClaimPrefix)}:${suffix}`;
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

  // Surface EVERY unmapped claim up front (an org can customize several at once,
  // e.g. keep `repository` and add `job_workflow_ref`) so the user isn't sent
  // through fix-one-hit-the-next. Keep SUPPORTED_CLAIM_KEYS in sync with the
  // switch below. See issue #185 for the assisted manual-subject follow-up.
  const unmapped = keys.filter((key) => !SUPPORTED_CLAIM_KEYS.has(key));
  if (unmapped.length > 0) {
    const list = unmapped.map((k) => `"${k}"`).join(", ");
    throw new Error(
      `The OIDC subject for ${canonical} uses claim key(s) ${list} that this ` +
        `extension cannot map to a federated credential yet. These are valid ` +
        `GitHub OIDC claims, set by an organization- or repository-level ` +
        `"customize the subject claims" policy that every repo in the org ` +
        `inherits — not a mistake on your part. Radius refuses to guess a ` +
        `subject here because a wrong one would authorize the wrong workflow. ` +
        `To proceed: reset this repository's OIDC subject-claim customization ` +
        `to GitHub's default for the deploy environment, or track assisted ` +
        `manual-subject entry at ` +
        `https://github.com/radius-project/ai-extensions/issues/185.`,
    );
  }

  // Lazily resolve the immutable slug only when a repo/repository key needs it,
  // so the immutability requirement (and id requirement) is enforced exactly
  // where it matters.
  const slugForRepoKeys = (): string => {
    if (subjectConfig.useImmutableSubject === undefined) {
      throw new Error(
        `OIDC config for ${canonical} customizes the subject with a ` +
          `repository/repo claim, but whether it uses GitHub's immutable ` +
          `subject format could not be determined. Refusing to guess — resolve ` +
          `the customization (so use_immutable_subject / sub_claim_prefix is ` +
          `available) and retry.`,
      );
    }
    if (!subjectConfig.useImmutableSubject) return canonical;
    const oid = requireId(ownerId, "the numeric owner id", canonical);
    const rid = requireId(repoId, "the numeric repository id", canonical);
    return immutableSlug(owner, repo, oid, rid, subjectConfig.subClaimPrefix);
  };

  const parts: string[] = [];
  for (const key of keys) {
    switch (key) {
      case "repository":
        parts.push(`repository:${slugForRepoKeys()}`);
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
      case "environment":
      case "context":
        // GitHub's terms for the dynamic trailing part of the subject; in this
        // product that is always the environment claim carried in `suffix`
        // (already %3A-encoded by buildEnvironmentSuffix).
        parts.push(suffix);
        break;
      case "repo":
        parts.push(`repo:${slugForRepoKeys()}`);
        break;
      default:
        // Unreachable for caller input: the unmapped-key guard above rejects
        // any key outside SUPPORTED_CLAIM_KEYS before the loop. This remains as
        // a defensive internal invariant in case the set and switch drift.
        throw new Error(
          `Internal error: claim key "${key}" for ${canonical} is listed as ` +
            `supported but has no mapping. SUPPORTED_CLAIM_KEYS and the ` +
            `buildOidcSubject switch are out of sync.`,
        );
    }
  }
  return parts.join(":");
}

/**
 * Build a URL-safe, Azure-valid federated-credential name. Azure limits the
 * name to 120 chars and a conservative `[A-Za-z0-9_-]` set; we sanitize the
 * repo/env, join them, and truncate so the value is always accepted.
 */
export function buildFederatedCredentialName(input: {
  repoFullName: string;
  envName: string;
  variant?: string;
}): string {
  const clean = (s: string): string =>
    String(s ?? "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const { owner, repo } = parseOwnerRepo(input.repoFullName);
  const base = ["github", clean(owner), clean(repo), clean(input.envName)]
    .filter(Boolean)
    .join("-");

  const variant = input.variant ? clean(input.variant) : "";
  if (!variant) {
    return base.length > 120 ? base.slice(0, 120).replace(/-+$/, "") : base;
  }

  // Reserve room for the variant so it always survives truncation. Without
  // this, two variants ("mutable"/"immutable") whose shared base exceeds the
  // limit would truncate to the SAME 120-char string, collide on the Azure
  // federated-credential name, and silently drop the second credential
  // (az reports "already exists") — reintroducing the AADSTS700213 mismatch.
  const suffix = `-${variant}`;
  const maxBase = 120 - suffix.length;
  const truncatedBase = base.slice(0, Math.max(0, maxBase)).replace(/-+$/, "");
  return `${truncatedBase}${suffix}`;
}
