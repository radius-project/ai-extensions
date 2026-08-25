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
  // The staged run carries no usable record of the run that produced it, so
  // there is no evidence of what `.radius/` looked like when it started. A run
  // that did not go through `--begin` lands here.
  | "unrecorded"
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

// Fingerprints of the files a run may replace, taken when the run started. A
// name maps to null when that file did not exist then, which is as meaningful as
// a hash: a file that appeared during the run is a change too.
export type ManagedFileHashes = Readonly<Record<string, string | null>>;

// What `--begin` recorded about the run. Its absence is never treated as "no
// baseline"; it means the run cannot be published at all.
export interface StagedRunRecord {
  // Fingerprints of every file in `.radius/` this run may overwrite.
  baseline: ManagedFileHashes;
  // How the authoring repair loop has gone so far, when the Bicep checker has
  // run at least once. Absent on a run that has not compiled yet.
  repair?: RepairState;
}

export interface StagedRunInput {
  // Entry names present in the staging directory.
  stagedFiles: ReadonlyArray<unknown> | null | undefined;
  // Staged `app.bicep` text, when it could be read.
  appBicep: string | null | undefined;
  // Staged `app.origin.json` text, when it could be read.
  originText: string | null | undefined;
  // The run record `--begin` wrote, or null when it is missing or unusable.
  record: StagedRunRecord | null | undefined;
  // Current fingerprints of the same files, read at publish time.
  currentHashes: ManagedFileHashes;
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
  // Checked before anything else: without the record there is no evidence of
  // what the run started from, and a publish that cannot see that cannot promise
  // not to destroy it. This is also what makes `--begin` mandatory rather than
  // merely recommended — a directory an agent assembled by hand has no record
  // and is refused.
  if (!input.record) {
    return evaluation("unrecorded", UNRECORDED_RUN_MESSAGE);
  }
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

  // Every file the publish would replace is compared, not just `app.bicep`. A
  // hand-tuned `bicepconfig.json` or custom-type manifest is exactly as much the
  // user's work as the model is, and overwriting one is the same failure.
  const changed = changedManagedFiles(
    input.record.baseline,
    input.currentHashes,
    publishableFiles(input.stagedFiles)
  );
  if (changed.length > 0) {
    return evaluation("concurrent-edit", concurrentEditMessage(changed));
  }

  return evaluation(
    "ready",
    "The modeling run is complete and its application model compiled.",
    publishableFiles(input.stagedFiles)
  );
}

// Managed files whose content on disk differs from what the run started with,
// limited to the ones this run would actually replace. A file the run does not
// publish is not this run's business, even if it changed.
export function changedManagedFiles(
  baseline: ManagedFileHashes,
  current: ManagedFileHashes,
  files: ReadonlyArray<string>
): string[] {
  // Only files the baseline actually covers can be compared. The authored-recipe
  // name is a pattern rather than a fixed name, so a baseline taken before the
  // run may legitimately not mention one; treating "not fingerprinted" as "was
  // absent" would report an untouched file as a concurrent edit and refuse
  // forever, which is exactly the bug this guard exists to prevent.
  return files
    .filter((file) => Object.prototype.hasOwnProperty.call(baseline, file))
    .filter((file) => (baseline[file] ?? null) !== (current[file] ?? null))
    .sort();
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
    .filter(
      (name) => !required.includes(name) && isPublishableExtraArtifact(name)
    )
    .sort();
  return [...required, ...extra];
}

// A custom type brings artifacts beyond the required set — the recipe pack, and
// an authored recipe when no Azure Verified Module fits — and leaving those
// behind would publish a model whose supporting files never arrived.
//
// They are matched by an explicit pattern rather than "everything else in the
// directory". The staging directory is written by an agent, so a note, a
// scratch file, or a credential dropped there must not be published into the
// repository and staged in git on the strength of merely being present.
export function isPublishableExtraArtifact(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (name === "custom-recipe-pack.bicep" ||
      /^[a-z0-9-]+-recipe\.bicep$/u.test(name))
  );
}

// The single user-facing statement for the concurrent-edit refusal. The user's
// own file is the thing being protected, so the message leads with the fact that
// it is untouched.
export const CONCURRENT_EDIT_MESSAGE =
  ".radius/app.bicep changed while modeling was running, so the generated " +
  "model was discarded rather than written over it. Your version of the file " +
  "is intact and nothing was published. Re-run modeling when you are ready to " +
  "replace it.";

// The same statement for whichever files actually changed. `app.bicep` alone
// keeps the exact wording above, since that is the common case and the sentence
// was written for it.
export function concurrentEditMessage(changed: ReadonlyArray<string>): string {
  if (changed.length === 1 && changed[0] === "app.bicep") {
    return CONCURRENT_EDIT_MESSAGE;
  }
  const names = changed.map((file) => `.radius/${file}`).join(", ");
  return (
    `${names} changed while modeling was running, so the generated model was ` +
    "discarded rather than written over it. Your versions of those files are " +
    "intact and nothing was published. Re-run modeling when you are ready to " +
    "replace them."
  );
}

// The single user-facing statement for a staged run with no record of what it
// started from.
export const UNRECORDED_RUN_MESSAGE =
  "This staged modeling run carries no record of the state it started from, " +
  "so publishing it could overwrite work without being able to tell. Nothing " +
  "was published. Start modeling runs with promote-app-model.mjs --begin.";

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

// --- Repair budget ---------------------------------------------------------
//
// Authoring compiles the generated model and repairs what the checker rejects.
// That loop used to have no attempt limit and no defined way to give up, so a
// model that could not be made to compile was repaired until the agent ran out
// of context. A compile error the skill cannot resolve is usually a real signal
// — a schema that moved, a type the configured extension does not have — so
// stopping and reporting it is more useful than another attempt.
//
// The bound is enforced by the checker rather than by prose, because prose only
// binds an agent that is already following it, and the agent that loops is the
// one that is not. The count lives in the staging run record, whose lifetime is
// exactly one modeling run: a counter that outlived the run would refuse a
// legitimate fresh run because of a stuck one last week.

// Repairs allowed per modeling run, on top of the run's first compile. The
// first compile is what reveals the problem, so charging the budget for it
// would leave one fewer chance to fix it than the number says.
//
// Deliberately the same quantity as DEPLOY_REPAIR_ATTEMPT_CAP, which allows
// this many repair-and-redeploy cycles after the initial failed deploy: both
// count repair cycles after the first failure, so the product has one answer to
// "how many times do we retry a repair on app.bicep". Not to be confused with
// DEPLOY_HANDOFF_MAX_ATTEMPTS, which counts deliveries of the handoff message
// rather than repairs.
export const REPAIR_ATTEMPT_BUDGET = 5;

// Compiles a run may perform: the first, plus one per allowed repair.
export const REPAIR_COMPILE_LIMIT = REPAIR_ATTEMPT_BUDGET + 1;

// What the checker has recorded about this run's compiles.
export interface RepairState {
  // Compiles already performed, including the ones that passed.
  attempts: number;
  // Fingerprint of the last failing compiler output, or null when the last
  // compile did not fail.
  fingerprint: string | null;
}

export type RepairVerdict =
  // The compile may proceed.
  | "allowed"
  // The budget is spent; the checker refuses to compile at all.
  | "exhausted";

export interface RepairDecision {
  verdict: RepairVerdict;
  // True only for `allowed`.
  allowed: boolean;
  // Attempt this compile would be, 1-based. Equals the budget + 1 when spent.
  attempt: number;
  // What to tell the agent, or empty when there is nothing to say.
  reason: string;
}

// A run record whose repair field is missing or unusable reads as "no compiles
// yet" rather than being rejected. Unlike the baseline, an unreadable counter
// cannot destroy anything: the worst case is one extra compile, which is a much
// better failure than refusing to compile a run that is fine.
export function parseRepairState(value: unknown): RepairState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { attempts: 0, fingerprint: null };
  }
  const record = value as Record<string, unknown>;
  const attempts = record.attempts;
  const fingerprint = record.fingerprint;
  // The two fields are read as one fact, not two. A fingerprint only means
  // "what the previous attempt failed with", so without a usable count there is
  // no previous attempt for it to describe, and keeping it would report the
  // first compile of the run as a repeat — telling the agent its last fix was
  // wrong when it has not made one yet.
  if (
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts <= 0
  ) {
    return { attempts: 0, fingerprint: null };
  }
  return {
    attempts,
    fingerprint:
      typeof fingerprint === "string" && fingerprint.trim() ?
        fingerprint.trim()
      : null
  };
}

// Whether the checker may compile again, given what this run has already done.
export function evaluateRepairAttempt(state: RepairState): RepairDecision {
  const attempt = state.attempts + 1;
  if (state.attempts >= REPAIR_COMPILE_LIMIT) {
    return {
      verdict: "exhausted",
      allowed: false,
      attempt,
      reason: repairBudgetSpentMessage(state.attempts)
    };
  }
  return { verdict: "allowed", allowed: true, attempt, reason: "" };
}

// The run record's repair field after a compile that produced `fingerprint`
// (null when it passed).
export function nextRepairState(
  state: RepairState,
  fingerprint: string | null
): RepairState {
  return { attempts: state.attempts + 1, fingerprint };
}

// Whether this failure is the one the previous compile already reported. The
// agent has to remember that across turns and the checker does not, so the
// checker is the better place to notice it.
export function isRepeatedFailure(
  state: RepairState,
  fingerprint: string | null
): boolean {
  return fingerprint !== null && state.fingerprint === fingerprint;
}

// Reduces compiler output to what is the same failure said twice. Line and
// column numbers shift as the model is edited, absolute paths differ between
// machines, and diagnostics do not come back in a stable order, so all three are
// normalized away; what remains is the set of messages.
export function fingerprintCompilerOutput(output: unknown): string {
  const text = typeof output === "string" ? output : "";
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/\r/gu, "")
        // "path/app.bicep:12:5:" and "line 12:" carry a position that moves
        // whenever anything above the error is edited.
        .replace(/:\d+(?::\d+)?(?=:)/gu, ":")
        .replace(/\bline \d+\b/gu, "line")
        .replace(/\s+/gu, " ")
        .trim()
    )
    .filter((line) => line !== "");
  if (lines.length === 0) return "";
  return [...new Set(lines)].sort().join("\n");
}

// What the checker says when it refuses to compile again.
export function repairBudgetSpentMessage(attempts: number): string {
  return (
    `The application model was compiled ${attempts} times in this modeling run and still does not build, ` +
    `so the repair budget of ${REPAIR_ATTEMPT_BUDGET} is spent and it was not compiled again. ` +
    "Stop repairing: do not write the origin record and do not publish the run. " +
    "Report to the user which resource and property the compiler rejected, quote the last compiler output verbatim, " +
    "and say that no application definition was written."
  );
}

// What the checker says when the same failure comes back.
export const REPEATED_FAILURE_MESSAGE =
  "This is the same compiler failure as the previous attempt, so the last fix " +
  "did not address it. Make a materially different fix rather than varying one " +
  "that has already failed, or use the remaining budget to establish why the " +
  "schema cannot express what the source needs.";
