// The Repo Radius pinset — the frontend's statement of exactly which upstream
// action code it requires.
//
// The workflows this extension commits into a user's repository run with
// `id-token: write` and exchange that token for cloud credentials, so whoever
// controls the action code they resolve to controls the user's cloud account for
// the duration of the run. Pinning every `uses:` to an immutable commit SHA is
// what makes a run reproducible and closes the mutable-ref substitution hole.
//
// SHAs here are resolved from upstream by `scripts/update-pinset.mjs` and
// verified in CI — never hand-edited. See
// docs/design/2026-07-repo-radius-workflow-pinning.md.

/** One immutable upstream reference the frontend requires. */
export interface ActionPin {
  /** `owner/repo` of the action or template source. */
  repo: string;
  /**
   * Sub-path within the repo. `""` makes the entry repo-wide: it matches every
   * `uses:` under that repo, which is how a monorepo hosting several composite
   * actions at one ref is pinned with a single entry.
   */
  path: string;
  /** Human-readable label recorded as the trailing `# comment` on a pin. */
  version: string;
  /** Full 40-character lowercase hex commit SHA. */
  sha: string;
}

/** One shipped pin, used to order two SHAs of the same repo. */
export interface LedgerEntry {
  version: string;
  sha: string;
}

export interface Pinset {
  /** Keyed by `owner/repo` (repo-wide) or `owner/repo/path` (exact). */
  actions: Readonly<Record<string, ActionPin>>;
  /**
   * The ref the workflow TEMPLATES themselves are fetched from. Pinned for the
   * same reason as the actions: a workflow whose actions are pinned but whose
   * body comes from a moving branch is still not reproducible.
   */
  templateSource: ActionPin;
  /**
   * Per-repo history of shipped SHAs, oldest first. Commit SHAs have no
   * intrinsic order, so this is the only thing that can decide whether a
   * committed pin is older or newer than the required one.
   */
  ledger: Readonly<Record<string, readonly LedgerEntry[]>>;
}

export const RADIUS_WORKFLOW_REPO = "radius-project/radius";
export const RADIUS_WORKFLOW_DIR = ".github/extension";

// --- generated: do not edit by hand (scripts/update-pinset.mjs) --------------
// The workflow templates and all six composite actions
// (setup-control-plane, restore-state, apply-custom-recipe-packs,
// run-rad-commands, teardown, delete-resource) live at one ref in
// radius-project/radius, so a single repo-wide entry pins them all.
//
// The label is `main@<short>` rather than a release tag because no tagged
// Radius release yet contains the delete templates; it becomes a `vX.Y.Z` once
// one does.
const RADIUS_SHA = "ddbf34398c1f8b362b72080f62f7a454813923de";
const RADIUS_VERSION = "main@ddbf343";

const RADIUS_LEDGER: readonly LedgerEntry[] = [
  { version: "main@ddbf343", sha: "ddbf34398c1f8b362b72080f62f7a454813923de" },
];
// --- end generated ----------------------------------------------------------

/**
 * Development-only override. Points every radius-project/radius reference at
 * another ref so unreleased upstream work can be exercised without cutting a
 * release. Replaces the former per-workflow `RADIUS_DELETE_REF`.
 *
 * The value need not be a SHA — a branch name works — so this is emphatically
 * not a supported production path; the compiled-in default above is the only
 * value CI verifies.
 */
const OVERRIDE_REF = (process.env.RADIUS_PINSET_REF || "").trim();

function radiusPin(path: string): ActionPin {
  return {
    repo: RADIUS_WORKFLOW_REPO,
    path,
    version: OVERRIDE_REF ? `override:${OVERRIDE_REF}` : RADIUS_VERSION,
    sha: OVERRIDE_REF || RADIUS_SHA,
  };
}

export const REPO_RADIUS_PINSET: Pinset = Object.freeze({
  actions: Object.freeze({
    [RADIUS_WORKFLOW_REPO]: radiusPin(""),
  }),
  templateSource: radiusPin(RADIUS_WORKFLOW_DIR),
  ledger: Object.freeze({
    [RADIUS_WORKFLOW_REPO]: RADIUS_LEDGER,
  }),
});

/**
 * Find the pin that governs `owner/repo[/path]`, preferring an exact path entry
 * over the repo-wide one. Returns undefined for references the extension does
 * not manage (`actions/checkout`, `azure/login`, …) — those are upstream's to
 * pin, not ours to rewrite.
 */
export function resolvePin(
  pinset: Pinset,
  repo: string,
  path: string,
): ActionPin | undefined {
  if (path) {
    const exact = pinset.actions[`${repo}/${path}`];
    if (exact) return exact;
  }
  return pinset.actions[repo];
}

/** Position of `sha` in a repo's ledger, or -1 when it was never shipped. */
export function ledgerIndex(pinset: Pinset, repo: string, sha: string): number {
  const entries = pinset.ledger[repo];
  if (!entries) return -1;
  return entries.findIndex((entry) => entry.sha === sha);
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^[\w.@+-]{1,64}$/;

/** True when `ref` is a full commit SHA, i.e. an immutable reference. */
export function isCommitSha(ref: string): boolean {
  return SHA_PATTERN.test(ref);
}

/**
 * Assert the compiled-in pinset is well-formed. Called by tests and by the CI
 * verification step; a malformed pin must never reach a user's repository.
 * Skipped for the development override, which is allowed to name a branch.
 */
export function validatePinset(pinset: Pinset): string[] {
  const problems: string[] = [];
  const check = (label: string, pin: ActionPin): void => {
    if (!pin.repo.includes("/")) problems.push(`${label}: repo "${pin.repo}" is not owner/repo`);
    if (!VERSION_PATTERN.test(pin.version)) problems.push(`${label}: version "${pin.version}" is not a safe label`);
    if (!isCommitSha(pin.sha)) problems.push(`${label}: sha "${pin.sha}" is not a 40-character hex commit SHA`);
    if (ledgerIndex(pinset, pin.repo, pin.sha) === -1) {
      problems.push(`${label}: sha "${pin.sha}" is missing from the ${pin.repo} ledger`);
    }
  };
  for (const [key, pin] of Object.entries(pinset.actions)) check(`actions["${key}"]`, pin);
  check("templateSource", pinset.templateSource);
  for (const [repo, entries] of Object.entries(pinset.ledger)) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isCommitSha(entry.sha)) problems.push(`ledger["${repo}"]: sha "${entry.sha}" is not a commit SHA`);
      if (seen.has(entry.sha)) problems.push(`ledger["${repo}"]: duplicate sha "${entry.sha}"`);
      seen.add(entry.sha);
    }
  }
  return problems;
}

/** True when the pinset in effect came from the development override. */
export function isPinsetOverridden(): boolean {
  return OVERRIDE_REF !== "";
}
