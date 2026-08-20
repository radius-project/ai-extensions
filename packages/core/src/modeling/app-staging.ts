// Staged modeling runs: what a run must produce before it may be published,
// and what to say when it fails.
//
// Modeling used to write straight into `.radius/`, one file at a time, so a run
// that stopped partway — a schema lookup that failed, a Bicep extension that
// could not be downloaded, a cancelled turn — left half of an application model
// on disk, possibly staged in git, on top of whatever the user had before. A
// repository with a working model could end up with a broken one produced by a
// run that never finished.
//
// A run now writes into `.radius/.staging-<runId>/` and is moved into
// `.radius/` only once it is complete and has compiled. This module owns the
// rules of that move: which files a complete run holds, whether the run may be
// published at all, and the single copy of every sentence the product says about
// a failed run.
//
// The staging directory deliberately lives INSIDE `.radius/`, because the move
// out of it must be a rename within one filesystem — a rename either happens or
// it does not, while a cross-filesystem move is a copy plus a delete that can
// fail halfway. The system temp directory is very often a different volume, so
// the location is bought outright rather than hoped for.
//
// Pure by construction — no filesystem, no `node:` built-ins — because
// `packages/core` is compiled into the browser bundle through its barrel. The
// caller supplies the directory listing, the file contents, and a hasher.

// Directory holding an in-flight run, relative to `.radius/`. The prefix is
// matched to find leftovers, so it must stay a prefix no other `.radius/` entry
// can claim.
export const STAGING_DIR_PREFIX = ".staging-";

// Ignore rule written into `.radius/.gitignore`, so a run interrupted before it
// could clean up cannot leave untracked noise in the user's `git status`.
export const STAGING_IGNORE_PATTERN = `${STAGING_DIR_PREFIX}*/`;

// Files every published run holds.
export const REQUIRED_STAGED_FILES: readonly string[] = [
  "app.bicep",
  "bicepconfig.json",
  "app.origin.json"
];

// Files a run holds only when it generated a custom resource type. Either both
// are present or neither is: a manifest without its published package, or a
// package without the manifest it was built from, is a half-finished run.
export const CUSTOM_TYPE_STAGED_FILES: readonly string[] = [
  "custom-types.yaml",
  "custom-types.tgz"
];

// Bookkeeping the run writes for its own promote step. It stays inside the
// staging directory and is never published, so it is excluded from the file set
// rather than being another required member of it.
export const STAGING_RUN_RECORD = "run.json";

// A run id is interpolated into a directory name, so it is reduced to a bounded
// inert token first. Anything outside the allowed set collapses to a hyphen,
// which keeps a caller-supplied id from introducing a path separator, a
// traversal segment, or a leading dot.
export function sanitizeRunId(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const safe = raw.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+/u, "");
  return safe.slice(0, 64);
}

// Directory name for a run, or a deterministic fallback when the id sanitizes
// away to nothing. A run must always get a directory: refusing here would push
// the run back into writing directly into `.radius/`, which is the failure this
// whole module exists to prevent.
export function stagingDirName(runId: unknown): string {
  return `${STAGING_DIR_PREFIX}${sanitizeRunId(runId) || "run"}`;
}

// Whether a `.radius/` entry name is a staging directory. Used to sweep up
// leftovers at the start of the next run: a run that finished always removed its
// own, so anything still matching belongs to a run that did not.
export function isStagingDirName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.startsWith(STAGING_DIR_PREFIX) &&
    name.length > STAGING_DIR_PREFIX.length
  );
}

// Why a staged run may not be published, or that it may.
export type StagedRunStatus =
  // The staging directory does not hold a complete set of files.
  | "incomplete"
  // No origin record, or one that does not describe the staged `app.bicep`. The
  // record is only written after the Bicep checker passes, so this also means an
  // application model that never compiled can never be published.
  | "unverified"
  // The application model in `.radius/` is no longer the one this run started
  // from, so publishing would overwrite an edit made while the run was going.
  | "concurrent-edit"
  | "ready";

export interface StagedRunEvaluation {
  status: StagedRunStatus;
  // True only for `ready`. Every other status refuses the publish and leaves
  // `.radius/` untouched.
  publishable: boolean;
  // Human-readable statement of the evidence, safe to show the user.
  reason: string;
  // Staged file names to move into `.radius/`, in publish order. Empty unless
  // the run is publishable.
  files: string[];
}

export interface StagedRunInput {
  // Entry names present in the staging directory.
  stagedFiles: ReadonlyArray<unknown> | null | undefined;
  // Staged `app.bicep` text, when it could be read.
  appBicep: string | null | undefined;
  // Staged `app.origin.json` text, when it could be read.
  originText: string | null | undefined;
  // Current `.radius/app.bicep` text, or null when there is no model on disk.
  currentModel?: string | null;
  // Fingerprint of `.radius/app.bicep` taken when the run started, or null when
  // there was no model then.
  baselineHash?: string | null;
  // Fingerprints a model the same way the origin writer did. Injected because
  // this package cannot import `node:crypto` (see app-origin.ts).
  hashAppBicep(content: string): string;
}

function evaluation(
  status: StagedRunStatus,
  reason: string,
  files: string[] = []
): StagedRunEvaluation {
  return { status, publishable: status === "ready", reason, files };
}

// The files a run must hold, given what it actually produced. The custom-type
// pair is required as a pair as soon as either half appears.
export function requiredStagedFiles(
  stagedFiles: ReadonlyArray<unknown> | null | undefined
): string[] {
  const present = new Set(
    (Array.isArray(stagedFiles) ? stagedFiles : []).filter(
      (name): name is string => typeof name === "string"
    )
  );
  const usesCustomType = CUSTOM_TYPE_STAGED_FILES.some((file) =>
    present.has(file)
  );
  return usesCustomType ?
      [...REQUIRED_STAGED_FILES, ...CUSTOM_TYPE_STAGED_FILES]
    : [...REQUIRED_STAGED_FILES];
}

// Decides whether a staged run may be published, applying the three checks in
// the order the design fixes them: completeness, then a matching origin record,
// then that the model on disk is still the one the run started from.
//
// Every refusal is total. There is no partial publish, because a partial publish
// is precisely the damage this replaces.
export function evaluateStagedRun(input: StagedRunInput): StagedRunEvaluation {
  const required = requiredStagedFiles(input.stagedFiles);
  const present = new Set(
    (Array.isArray(input.stagedFiles) ? input.stagedFiles : []).filter(
      (name): name is string => typeof name === "string"
    )
  );
  const missing = required.filter((file) => !present.has(file));
  if (missing.length > 0) {
    return evaluation(
      "incomplete",
      `The modeling run did not produce a complete set of files (missing ${missing.join(", ")}), so nothing was published.`
    );
  }

  const model = typeof input.appBicep === "string" ? input.appBicep : "";
  if (!model.trim()) {
    return evaluation(
      "incomplete",
      "The staged application model is empty, so nothing was published."
    );
  }

  const origin = parseStagedOriginHash(input.originText);
  if (!origin) {
    return evaluation(
      "unverified",
      "The modeling run produced no usable origin record, so it cannot be shown to have compiled and nothing was published."
    );
  }
  if (origin !== input.hashAppBicep(model)) {
    return evaluation(
      "unverified",
      "The origin record does not describe the application model the run produced, so the published bytes would not be the ones the Bicep checker passed. Nothing was published."
    );
  }

  const currentHash =
    typeof input.currentModel === "string" && input.currentModel.trim() ?
      input.hashAppBicep(input.currentModel)
    : null;
  const baseline =
    typeof input.baselineHash === "string" && input.baselineHash.trim() ?
      input.baselineHash.trim()
    : null;
  if (currentHash !== baseline) {
    return evaluation("concurrent-edit", CONCURRENT_EDIT_MESSAGE);
  }

  return evaluation(
    "ready",
    "The modeling run is complete and its application model compiled.",
    publishableFiles(input.stagedFiles)
  );
}

// Everything the run produced, in a stable order, minus its own bookkeeping.
// The required set is what a run must hold; it is not the whole of what a run
// may hold — a custom type also brings a recipe pack and possibly an authored
// recipe — and leaving those behind would publish an application model whose
// supporting artifacts never arrived.
export function publishableFiles(
  stagedFiles: ReadonlyArray<unknown> | null | undefined
): string[] {
  const names = (Array.isArray(stagedFiles) ? stagedFiles : []).filter(
    (name): name is string => typeof name === "string"
  );
  const required = requiredStagedFiles(names);
  const extra = [...new Set(names)]
    .filter((name) => name !== STAGING_RUN_RECORD && !required.includes(name))
    .sort();
  return [...required, ...extra];
}

// The single user-facing statement for the concurrent-edit refusal. The user's
// own file is the thing being protected, so the message leads with the fact that
// it is untouched.
export const CONCURRENT_EDIT_MESSAGE =
  ".radius/app.bicep changed while modeling was running, so the generated " +
  "model was discarded rather than written over it. Your version of the file " +
  "is intact and nothing was published. Re-run modeling when you are ready to " +
  "replace it.";

// Reads only the field the publish check needs from an origin record. This is a
// deliberately narrow reader rather than a call into parseAppOrigin: the promote
// script re-implements it, and the smaller the contract the two copies share,
// the less there is to drift.
function parseStagedOriginHash(text: unknown): string | null {
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
  const hash = (parsed as Record<string, unknown>).appBicepHash;
  return typeof hash === "string" && hash.trim() ? hash.trim() : null;
}

// ---------------------------------------------------------------------------
// Reporting a failed run
// ---------------------------------------------------------------------------

// Whether re-running the same modeling run could plausibly succeed.
export type ModelingFailureKind =
  // A network, registry, or download failure: the same run may well work.
  | "transient"
  // Something about the repository or the target that a second identical run
  // would hit again.
  | "permanent"
  // Not classifiable from the evidence available.
  | "unknown";

// Phrases that identify a failure as worth retrying. Matched against the failure
// text case-insensitively. Kept narrow on purpose: offering a retry for a
// permanent failure wastes the user's time and teaches them to ignore the offer.
const TRANSIENT_MARKERS: readonly string[] = [
  "etimedout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "socket hang up",
  "timed out",
  "timeout",
  "network",
  "temporarily unavailable",
  "service unavailable",
  "too many requests",
  "rate limit",
  "connection reset",
  "download failed",
  "failed to download",
  "unexpected end of",
  "502",
  "503",
  "504"
];

// Phrases that identify a failure as one the same run would hit again.
const PERMANENT_MARKERS: readonly string[] = [
  "no dockerfile",
  "could not find a dockerfile",
  "not supported",
  "unsupported",
  "no radius type",
  "cannot be provisioned",
  "could not identify an application",
  "no runnable",
  "cannot be resolved to a runnable"
];

function includesAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

// Classifies a modeling failure from its message. Permanent markers are checked
// first: a permanent failure whose text happens to mention a timeout is still
// permanent, and wrongly offering a retry is the worse of the two mistakes.
export function classifyModelingFailure(message: unknown): ModelingFailureKind {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (!text.trim()) return "unknown";
  if (includesAny(text, PERMANENT_MARKERS)) return "permanent";
  if (includesAny(text, TRANSIENT_MARKERS)) return "transient";
  return "unknown";
}

export interface ModelingFailureInput {
  // What the run was doing when it failed, in user-facing words
  // (e.g. "resolving the Radius schemas").
  stage?: string | null;
  // The underlying failure text.
  message: string;
  // Overrides the classification derived from the message, for a caller that
  // knows better than the text does.
  kind?: ModelingFailureKind;
}

// The single user-facing report for a failed modeling run.
//
// Every failed run says the same three things in the same order: what failed,
// that nothing was written, and whether trying again is worth it. The "nothing
// was written" sentence is the point of the whole feature, so it is stated
// plainly and unconditionally rather than being left for the user to infer.
export function modelingFailureReport(input: ModelingFailureInput): string {
  const message = String(input.message ?? "").trim() || "Modeling failed.";
  const kind = input.kind ?? classifyModelingFailure(message);
  const stage = String(input.stage ?? "").trim();
  const lines = [
    stage ?
      `Modeling failed while ${stage}: ${message}`
    : `Modeling failed: ${message}`,
    "",
    "Nothing was written. The generated files were discarded, `.radius/` is exactly as it was before this run, and nothing was staged in git, so any application model you already had is intact."
  ];
  if (kind === "transient") {
    lines.push(
      "",
      "This looks like a temporary failure, so running modeling again may well succeed. Would you like me to try again?"
    );
  } else if (kind === "permanent") {
    lines.push(
      "",
      "Running modeling again would fail the same way, so this needs to be resolved before it is worth another attempt."
    );
  } else {
    lines.push(
      "",
      "I cannot tell from this failure whether another attempt would behave differently, so tell me if you would like me to try again."
    );
  }
  return lines.join("\n");
}
