// Generation origin record for the skill-authored application model.
//
// `.radius/app.bicep` is written by the radius-app-bicep skill, but the graph
// views only ever asked "does the file exist?" before rendering it. A model that
// was generated from an older commit, or by an older generator, still exists,
// so the graph silently showed a picture of source that has since moved on.
//
// The skill therefore writes a sibling `.radius/app.origin.json` on every
// generation recording what the model was generated FROM. This module owns that
// record's format and the freshness decision made from it. It is pure: callers
// supply the model text, the origin text, the branch head commit, and the current
// generator version, and get back a classification.
//
// Validity is derived from the origin record rather than re-proved by compiling on every
// open. The skill only writes the record after its bundled Bicep checker exits
// clean, so a record whose `appBicepHash` still matches the file on disk is a
// statement that those exact bytes compiled without errors or warnings. When the
// hash does not match (or there is no record at all) the model is simply
// unverified, which this module reports so the caller can route it back through
// the skill instead of rendering a possibly-broken model.

// Repo-relative location of the origin record, next to the model it describes.
export const APP_ORIGIN_REPO_PATH = ".radius/app.origin.json";

// Older layouts keep the model at the repository root, and the record is written
// beside whichever model the generator wrote, so readers must check both.
export const APP_ORIGIN_ROOT_PATH = "app.origin.json";

export interface AppOrigin {
  // ISO-8601 timestamp of the generation that produced the model.
  generatedAt: string;
  // Full commit SHA of the source the model was generated from.
  sourceCommit: string;
  // Version of the generator (the bundled radius-app-bicep skill) that ran.
  // May be empty when the writer could not resolve it; the generator-drift check
  // is skipped then rather than treating "unknown" as a version that differs.
  skillVersion: string;
  // `sha256:<hex>` fingerprint of app.bicep exactly as the generator wrote it.
  // Re-fingerprinting the file on disk and comparing answers two questions at
  // once: whether a human has edited it since, and (because the generator
  // records only after its Bicep checker passes) whether the bytes now on disk
  // are the ones that were proven to compile.
  appBicepHash: string;
}

export type AppModelFreshnessStatus =
  // No model on the branch at all. It has to be generated from scratch.
  | "missing"
  // Model exists but carries no usable origin record, so neither its source revision
  // nor its validity can be established.
  | "unrecorded"
  // Model no longer matches the bytes the recorded generation produced, so a
  // human edited it after generation.
  | "edited"
  // Source moved on since the model was generated.
  | "source-changed"
  // A different generator version produced the model.
  | "generator-changed"
  | "up-to-date";

export interface AppModelFreshness {
  status: AppModelFreshnessStatus;
  // True for every status that warrants regenerating before the model is
  // trusted. `missing` is not stale, since there is nothing to refresh and it
  // has to be generated, so callers can keep the two paths distinct.
  stale: boolean;
  // True when regenerating would destroy content this module cannot prove came
  // from the generator, so the user has to approve the overwrite first.
  requiresConfirmation: boolean;
  // Human-readable statement of the evidence, safe to put in an agent prompt.
  reason: string;
  origin: AppOrigin | null;
}

export interface AppModelFreshnessInput {
  // The model text on the target branch, or null/empty when there is none.
  model: string | null | undefined;
  // Raw `.radius/app.origin.json` text on the target branch, when present.
  originText: string | null | undefined;
  // Head commit of the target branch. Empty when it could not be resolved.
  headCommit?: string | null;
  // Whether the application source actually changed between the recorded commit
  // and the branch head, ignoring the model's own directory. Supplied by callers
  // that can answer it (the local worktree), and left undefined by callers that
  // cannot. A plain head-commit comparison is the fallback then.
  //
  // This exists because head equality alone is not a usable freshness test: the
  // act of committing a freshly generated model advances the head past the
  // commit that model recorded, so every committed model would immediately
  // report itself stale, regenerate, and be stale again on the next commit.
  sourceChanged?: boolean;
  // Current generator version. Empty when it could not be resolved.
  generatorVersion?: string | null;
  // Fingerprints the model the same way the writer did. Injected because this
  // package must stay free of Node built-ins (see normalizeAppBicep).
  hashAppBicep(content: string): string;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Line endings and trailing whitespace are checkout artifacts (a CRLF clone of
// an LF-committed model is not a hand edit), so they are normalized away before
// hashing. Everything else is significant.
//
// The hash itself is NOT computed here. This package is compiled into the
// browser bundle through its barrel, so it cannot import `node:crypto`; the
// caller injects a hasher built on whatever primitive its runtime provides.
export function normalizeAppBicep(content: string): string {
  return content
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
}

// Parses an origin record, returning null for anything this module cannot trust:
// malformed JSON, a non-object, or a missing/blank `generatedAt`,
// `sourceCommit`, or `appBicepHash`. Those three are load-bearing: without any
// one of them the record cannot answer the question it exists to answer.
// `skillVersion` is allowed to be blank: an unresolvable generator version is a
// missing fact, and the writer recording it as such is better than refusing to
// record it at all, which would report every generated model as unverified.
export function parseAppOrigin(text: unknown): AppOrigin | null {
  if (typeof text !== "string" || !text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const fields = parsed as Record<string, unknown>;
  const origin: AppOrigin = {
    generatedAt: optionalString(fields.generatedAt),
    sourceCommit: optionalString(fields.sourceCommit),
    skillVersion: optionalString(fields.skillVersion),
    appBicepHash: optionalString(fields.appBicepHash)
  };
  if (!origin.generatedAt || !origin.sourceCommit || !origin.appBicepHash) {
    return null;
  }
  return origin;
}

// Canonical serialization: fixed key order, two-space indent, trailing newline.
// The record is machine-written and machine-read, so a stable byte layout keeps
// a regeneration from showing up as a diff when nothing actually changed.
export function serializeAppOrigin(origin: AppOrigin): string {
  return `${JSON.stringify(
    {
      generatedAt: origin.generatedAt,
      sourceCommit: origin.sourceCommit,
      skillVersion: origin.skillVersion,
      appBicepHash: origin.appBicepHash
    },
    null,
    2
  )}\n`;
}

function freshness(
  status: AppModelFreshnessStatus,
  reason: string,
  origin: AppOrigin | null,
  requiresConfirmation = false
): AppModelFreshness {
  return {
    status,
    stale: status !== "up-to-date" && status !== "missing",
    requiresConfirmation,
    reason,
    origin
  };
}

// Classifies the model on a branch. Unknown facts fail OPEN (reported as
// up-to-date) rather than triggering a refresh: regeneration overwrites the
// user's model, so it must be driven by positive evidence of staleness, never by
// our own inability to resolve a commit or a version.
export function evaluateAppModelFreshness(
  input: AppModelFreshnessInput
): AppModelFreshness {
  const model = typeof input.model === "string" ? input.model : "";
  if (!model.trim()) {
    return freshness("missing", "No application model exists yet.", null);
  }

  const origin = parseAppOrigin(input.originText);
  if (!origin) {
    return freshness(
      "unrecorded",
      `The model has no usable ${APP_ORIGIN_REPO_PATH} origin record, so the source revision it was generated from and whether it still compiles cannot be established.`,
      null,
      true
    );
  }

  if (origin.appBicepHash !== input.hashAppBicep(model)) {
    return freshness(
      "edited",
      `The model no longer matches the content recorded in ${APP_ORIGIN_REPO_PATH}, so it was edited after it was generated.`,
      origin,
      true
    );
  }

  const headCommit = optionalString(input.headCommit);
  // A caller that could inspect the source answers directly; otherwise fall back
  // to head equality, which is coarse but is all a remote branch can offer.
  const sourceMoved =
    input.sourceChanged ??
    (headCommit ? headCommit !== origin.sourceCommit : false);
  if (sourceMoved) {
    return freshness(
      "source-changed",
      `The model was generated from commit ${origin.sourceCommit}, but the source has changed since${headCommit ? ` (the branch is now at ${headCommit})` : ""}, so it may no longer describe the current source.`,
      origin
    );
  }

  const generatorVersion = optionalString(input.generatorVersion);
  if (
    generatorVersion &&
    origin.skillVersion &&
    generatorVersion !== origin.skillVersion
  ) {
    return freshness(
      "generator-changed",
      `The model was generated by radius-app-bicep ${origin.skillVersion}, but ${generatorVersion} is installed now.`,
      origin
    );
  }

  return freshness(
    "up-to-date",
    `The model is current with commit ${origin.sourceCommit}.`,
    origin
  );
}
