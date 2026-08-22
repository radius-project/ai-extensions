#!/usr/bin/env node

// Publishes a staged modeling run into `.radius/`, or refuses and writes
// nothing.
//
// Modeling writes its whole output into `.radius/.staging-<runId>/` and this
// script moves it into place as the very last step. It is a script rather than a
// prompt instruction so that "the model was only published because everything
// succeeded" is enforced by code, and cannot be skipped by an agent that decides
// it is close enough.
//
// Two modes:
//
//   --begin [--run-id <id>]   Prepare a run: remove any staging directory left
//                             behind by an interrupted run, ignore
//                             `.radius/.staging-*`, record the fingerprint of
//                             the application model as it is right now, and
//                             print the staging directory to write into.
//
//   (default)                 Publish `--staging <dir>`: check the run is
//                             complete, that its origin record describes the
//                             model it produced, and that `.radius/app.bicep`
//                             is still the file the run started from — then move
//                             the files in, delete the staging directory, and
//                             `git add` what was published. Any refusal leaves
//                             `.radius/` untouched and discards the staged run.
//
// The staging directory lives inside `.radius/` so the publish is a rename
// within one filesystem, which either happens or does not, rather than a
// cross-filesystem copy that can fail halfway.
//
// The rules below MUST stay behavior-compatible with
// packages/core/src/modeling/app-staging.ts, and the hash with
// packages/adapter-canvas/src/app-bicep-hash.ts. They are duplicated here rather
// than imported because this script ships inside the installed plugin, where the
// workspace packages do not exist; promote-app-model.test.ts asserts the copies
// agree.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const STAGING_DIR_PREFIX = ".staging-";
const STAGING_IGNORE_PATTERN = `${STAGING_DIR_PREFIX}*/`;
const STAGING_RUN_RECORD = "run.json";
const REQUIRED_STAGED_FILES = [
  "app.bicep",
  "bicepconfig.json",
  "app.origin.json"
];
const CUSTOM_TYPE_STAGED_FILES = ["custom-types.yaml", "custom-types.tgz"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  return typeof value === "string" && !value.startsWith("--") ?
      value.trim()
    : "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeAppBicep(content) {
  return content
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
}

function hashAppBicep(content) {
  const digest = createHash("sha256")
    .update(normalizeAppBicep(content), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function sanitizeRunId(value) {
  const safe = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+/u, "");
  return safe.slice(0, 64);
}

function stagingDirName(runId) {
  return `${STAGING_DIR_PREFIX}${sanitizeRunId(runId) || "run"}`;
}

function isStagingDirName(name) {
  return (
    typeof name === "string" &&
    name.startsWith(STAGING_DIR_PREFIX) &&
    name.length > STAGING_DIR_PREFIX.length
  );
}

function readFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Fingerprint of a file in `.radius/`, distinguishing the three states the
// publish has to tell apart: absent, readable, and present-but-unreadable.
//
// Collapsing the third into "absent" makes a file that is merely locked by an
// editor compare as changed, so the run is refused with a concurrent-edit
// message about an edit that never happened. The refusal is the safe direction
// either way; this is about the explanation being true.
//
// Binary members are hashed as raw bytes. Reading a `.tgz` as UTF-8 is lossy —
// invalid sequences collapse to U+FFFD, so two different archives can fingerprint
// the same — and normalizing line endings in an archive is meaningless besides.
function fingerprintManagedFile(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "absent", hash: null };
    return { state: "unreadable", hash: null, reason: error.message };
  }
  if (TEXT_MANAGED_FILE.test(file)) {
    return { state: "present", hash: hashAppBicep(bytes.toString("utf8")) };
  }
  return {
    state: "present",
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  };
}

// Which managed files are text, and so are compared with the same normalization
// the origin record uses (line endings and trailing whitespace are checkout
// artifacts, not edits). Everything else is compared byte for byte.
const TEXT_MANAGED_FILE = /\.(bicep|json|yaml)$/u;

function stagedOriginHash(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const hash = parsed.appBicepHash;
  return typeof hash === "string" && hash.trim() ? hash.trim() : null;
}

function requiredStagedFiles(present) {
  const usesCustomType = CUSTOM_TYPE_STAGED_FILES.some((file) =>
    present.has(file)
  );
  return usesCustomType ?
      [...REQUIRED_STAGED_FILES, ...CUSTOM_TYPE_STAGED_FILES]
    : [...REQUIRED_STAGED_FILES];
}

// A custom type brings artifacts beyond the required set — the recipe pack, and
// an authored recipe when no Azure Verified Module fits — and leaving those
// behind would publish a model whose supporting files never arrived.
//
// They are matched by an explicit pattern rather than "everything else in the
// directory". The staging directory is written by an agent, so a note, a scratch
// file, or a credential dropped there must not be published into the repository
// and staged in git on the strength of merely being present.
function isPublishableExtraArtifact(name) {
  return (
    name === "custom-recipe-pack.bicep" ||
    /^[a-z0-9-]+-recipe\.bicep$/u.test(name)
  );
}

function publishableFiles(present, required) {
  const extra = [...present]
    .filter(
      (name) => !required.includes(name) && isPublishableExtraArtifact(name)
    )
    .sort();
  return [...required, ...extra];
}

// Fingerprints of every file this run could replace, so a concurrent edit to any
// of them is detected — not just one to `app.bicep`. A file that does not exist
// is recorded as null, which is as meaningful as a hash: a file that appeared
// during the run is a change too.
function managedFileHashes(radiusDir, files) {
  const hashes = {};
  for (const file of files) {
    const { state, hash } = fingerprintManagedFile(path.join(radiusDir, file));
    // An unreadable file is recorded as its own marker rather than as absent, so
    // the publish can say what actually happened.
    hashes[file] = state === "unreadable" ? "unreadable" : hash;
  }
  return hashes;
}

// The fixed part of what a run could publish. `--begin` runs before the run has
// produced anything, so it cannot know which authored recipes this run will
// write — hence managedFilesFor, which adds whatever is already on disk.
const MANAGED_FILES = [...REQUIRED_STAGED_FILES, ...CUSTOM_TYPE_STAGED_FILES];

// Every file the publish could replace, so the baseline covers exactly the set
// `publishableFiles` is allowed to publish.
//
// The authored-recipe name is a pattern, not a fixed list, so the files already
// in `.radius/` are folded in: a repository whose previous run published
// `postgres-recipe.bicep` must have that file fingerprinted, or the next run
// sees an unfingerprinted file on disk, reads it as having appeared mid-run, and
// refuses forever with a concurrent-edit message naming a file nobody touched.
function managedFilesFor(radiusDir) {
  const existing =
    existsSync(radiusDir) ?
      readdirSync(radiusDir, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && isPublishableExtraArtifact(entry.name)
        )
        .map((entry) => entry.name)
    : [];
  return [...new Set([...MANAGED_FILES, ...existing])].sort();
}

// Removes every staging directory under `.radius/`. A run that finished always
// removes its own, so anything still here belongs to a run that did not, and is
// not something the user needs: a directory of half-finished files is mostly a
// way to mistake a discarded run for a real application model.
// Runs are given unique directory names so two of them cannot collide, so the
// sweep leaves recently-started ones alone rather than immediately undoing that.
// A directory this young belongs to a run that is plausibly still working; an
// older one belongs to a run that was interrupted, since a run that finished
// always removes its own.
const STAGING_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function purgeStagingDirs(radiusDir, staleAfterMs = STAGING_STALE_AFTER_MS) {
  const now = Date.now();
  if (!existsSync(radiusDir)) return [];
  const removed = [];
  for (const entry of readdirSync(radiusDir, { withFileTypes: true })) {
    // `isDirectory()` on a Dirent is already an lstat, so a symlink named
    // `.staging-*` is skipped rather than followed and deleted through.
    if (!entry.isDirectory() || !isStagingDirName(entry.name)) continue;
    const dir = path.join(radiusDir, entry.name);
    let startedAt;
    try {
      startedAt = lstatSync(dir).mtimeMs;
    } catch {
      // Unreadable: treat it as old enough to sweep rather than keeping it
      // forever on the strength of a stat that did not work.
      startedAt = 0;
    }
    if (startedAt && now - startedAt < staleAfterMs) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

// Adds the staging-directory ignore rule to `.radius/.gitignore`, at PUBLISH
// time.
//
// `.radius/.gitignore` rather than the repository root's: the rule is about this
// directory, the directory is created by modeling anyway, and writing here
// cannot disturb an ignore file the user maintains.
//
// It is deliberately NOT written when the run starts. A run that fails must
// leave `.radius/` byte-identical, and a file written at `--begin` would have to
// be un-written on every failure path — including the ones where the run record
// is gone and there is nothing left to say what to restore. Writing it only on
// the path that already modifies `.radius/` means a failed run has nothing
// outside its staging directory to undo, so the guarantee holds by construction
// rather than by a revert that has to be correct.
//
// The cost is that a run interrupted mid-flight leaves its staging directory
// untracked until the next run sweeps it up. That is visible in `git status` and
// harmless, which is a better trade than a revert that can get it wrong.
//
// Returns true when the file was written, so only a rule this run added is
// staged in git.
function ensureStagingIgnored(radiusDir) {
  const ignoreFile = path.join(radiusDir, ".gitignore");
  const existing = readFile(ignoreFile);
  const text = existing || "";
  if (text.split("\n").some((line) => line.trim() === STAGING_IGNORE_PATTERN)) {
    return false;
  }
  const body = text && !text.endsWith("\n") ? `${text}\n` : text;
  writeFileSync(ignoreFile, `${body}${STAGING_IGNORE_PATTERN}\n`, "utf8");
  return true;
}

// The repository root, asked of git rather than assumed to be `.radius/`'s
// parent. `resolveRadiusDir` canonicalizes through realpath, so a symlinked
// `.radius` would otherwise put the parent of the REAL location here, which may
// be outside the repository entirely.
function repositoryRoot(radiusDir) {
  const result = spawnSync(
    "git",
    ["-C", radiusDir, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true
    }
  );
  if (result.error || result.status !== 0) return path.dirname(radiusDir);
  return (result.stdout || "").trim() || path.dirname(radiusDir);
}

function gitAdd(repoRoot, files) {
  const result = spawnSync("git", ["-C", repoRoot, "add", "--", ...files], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return (result.stderr || result.error?.message || "git add failed").trim();
  }
  return "";
}

function resolveRadiusDir() {
  const requested = flag("radius-dir");
  const resolved = path.resolve(requested || ".radius");
  // Canonicalized so the confinement below compares real paths. A symlinked
  // `.radius` would otherwise let every later path check pass while the writes
  // landed somewhere else entirely.
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

// True when the path exists and is a real directory rather than a symlink to
// one. Used for both the staging directory and the leftovers sweep: a symlink
// named `.staging-*` is never something this script created, so it is never
// followed, written through, or published from.
function isRealDirectory(target) {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

// --- begin -----------------------------------------------------------------

function begin() {
  const radiusDir = resolveRadiusDir();
  mkdirSync(radiusDir, { recursive: true });
  // `--stale-after-ms` exists so the sweep can be exercised deterministically
  // instead of by waiting hours; runs use the default.
  const requestedStaleAfter = flag("stale-after-ms");
  const staleAfter = requestedStaleAfter ? Number(requestedStaleAfter) : NaN;
  purgeStagingDirs(
    radiusDir,
    Number.isFinite(staleAfter) && staleAfter >= 0 ?
      staleAfter
    : STAGING_STALE_AFTER_MS
  );

  // A unique id by default: two runs sharing `.staging-run` would sweep each
  // other away, and the sweep cannot tell a live run from an abandoned one.
  const dirName = stagingDirName(
    flag("run-id") || `${Date.now().toString(36)}-${process.pid.toString(36)}`
  );
  const stagingDir = path.join(radiusDir, dirName);
  if (existsSync(stagingDir) && !isRealDirectory(stagingDir)) {
    fail(
      `Cannot stage a modeling run at ${stagingDir}: it exists and is not a real directory. Remove it and start the run again.`
    );
  }
  mkdirSync(stagingDir, { recursive: true });

  // The baseline fingerprint travels with the run rather than through the
  // agent, so the concurrent-edit check cannot be defeated by an agent that
  // forgets to pass it along or passes the wrong one.
  const record = {
    version: 1,
    runId: dirName.slice(STAGING_DIR_PREFIX.length),
    startedAt: new Date().toISOString(),
    baseline: managedFileHashes(radiusDir, managedFilesFor(radiusDir))
  };
  writeFileSync(
    path.join(stagingDir, STAGING_RUN_RECORD),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
  console.log(stagingDir);
}

// --- publish ---------------------------------------------------------------

// Every refusal discards the staged run. It is never kept for inspection: what
// the user needs in order to act is in the failure message, and keeping it would
// leave the product with two places an application model might live.
function refuseWith(stagingDir) {
  return (message) => {
    // Best-effort: if the staging directory cannot be removed, the run is still
    // refused and the user still needs to be told so in the words below. Dying
    // here would replace the explanation with a stack trace while still exiting
    // non-zero, which reads as "refused, nothing written" either way.
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `Note: the staged run at ${stagingDir} could not be removed (${error.message}). It is ignored by git and the next modeling run will clear it.`
      );
    }
    fail(
      `${message}\n\nNothing was written: .radius/ is exactly as it was before this run, and nothing was staged in git.`
    );
  };
}

// The run's own bookkeeping, written by `--begin`: fingerprints of every file in
// `.radius/` this run may replace, and what the run wrote to the ignore file.
//
// Returns null for anything unusable. That is not a missing baseline that
// defaults to "nothing was there" — it refuses the publish outright, which is
// what makes `--begin` mandatory rather than merely recommended. A staging
// directory an agent assembled by hand has no record, so it cannot be published.
function readRunRecord(stagingDir) {
  let parsed;
  try {
    parsed = JSON.parse(
      readFile(path.join(stagingDir, STAGING_RUN_RECORD)) || ""
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const baseline = parsed.baseline;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    return null;
  }
  for (const value of Object.values(baseline)) {
    if (value !== null && typeof value !== "string") return null;
  }
  return { baseline };
}

// Managed files whose content differs from what the run started with, limited to
// the ones this run would actually replace. Every file the publish overwrites is
// compared, not just `app.bicep`: a hand-tuned `bicepconfig.json` or custom-type
// manifest is exactly as much the user's work as the model is.
function changedManagedFiles(baseline, radiusDir, files) {
  // Only files the baseline actually covers can be compared. One it does not
  // cover carries no evidence either way, and treating "not fingerprinted" as
  // "was absent" would report an untouched file as a concurrent edit.
  const comparable = files.filter((file) =>
    Object.prototype.hasOwnProperty.call(baseline, file)
  );
  const current = managedFileHashes(radiusDir, comparable);
  return comparable
    .filter((file) => (baseline[file] ?? null) !== (current[file] ?? null))
    .sort();
}

function unreadableFileMessage(files) {
  const names = files.map((file) => `.radius/${file}`).join(", ");
  return `${names} could not be read, so this run could not establish whether publishing would overwrite a change. Nothing was published. Close anything holding the file open, or check its permissions, then run modeling again.`;
}

function concurrentEditMessage(changed) {
  const names = changed.map((file) => `.radius/${file}`).join(", ");
  const plural = changed.length === 1 ? "" : "s";
  return `${names} changed while modeling was running, so the generated model was discarded rather than written over it. Your version${plural} of ${changed.length === 1 ? "that file is" : "those files are"} intact. Re-run modeling when you are ready to replace ${changed.length === 1 ? "it" : "them"}.`;
}

function publish() {
  const radiusDir = resolveRadiusDir();
  const requested = flag("staging");
  if (!requested) {
    fail(
      "A staging directory is required: pass --staging <dir> naming the directory this run wrote into."
    );
  }
  const stagingDir = path.resolve(requested);
  const parent = path.dirname(stagingDir);
  if (parent !== radiusDir || !isStagingDirName(path.basename(stagingDir))) {
    fail(
      `The staging directory must be a ${STAGING_DIR_PREFIX}* directory directly inside ${radiusDir}. Received: ${requested}`
    );
  }
  if (!existsSync(stagingDir)) {
    fail(
      `No staged modeling run at ${stagingDir}. Start a run with --begin, write into the directory it prints, and pass that directory here.`
    );
  }

  if (!isRealDirectory(stagingDir)) {
    fail(
      `The staged modeling run at ${stagingDir} is not a real directory, so it was not published.`
    );
  }

  const record = readRunRecord(stagingDir);
  const refuse = refuseWith(stagingDir);
  // Checked before anything else: without the record there is no evidence of
  // what `.radius/` held when the run started, and a publish that cannot see
  // that cannot promise not to destroy it.
  if (!record) {
    refuse(
      "This staged modeling run carries no record of the state it started from, so publishing it could overwrite work without being able to tell. Start modeling runs with promote-app-model.mjs --begin."
    );
  }

  const present = new Set(
    readdirSync(stagingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  );
  const required = requiredStagedFiles(present);
  const missing = required.filter((file) => !present.has(file));
  if (missing.length > 0) {
    refuse(
      `The modeling run did not produce a complete set of files (missing ${missing.join(", ")}), so nothing was published.`
    );
  }

  const model = readFile(path.join(stagingDir, "app.bicep"));
  if (!model || !model.trim()) {
    refuse("The staged application model is empty, so nothing was published.");
  }

  const recorded = stagedOriginHash(
    readFile(path.join(stagingDir, "app.origin.json"))
  );
  if (!recorded) {
    refuse(
      "The modeling run produced no usable origin record, so it cannot be shown to have compiled and nothing was published."
    );
  }
  if (recorded !== hashAppBicep(model)) {
    refuse(
      "The origin record does not describe the application model the run produced, so the published bytes would not be the ones the Bicep checker passed. Nothing was published."
    );
  }

  const files = publishableFiles(present, required);
  const changed = changedManagedFiles(record.baseline, radiusDir, files);
  const unreadable = changed.filter(
    (file) =>
      managedFileHashes(radiusDir, [file])[file] === "unreadable" ||
      record.baseline[file] === "unreadable"
  );
  if (unreadable.length > 0) {
    refuse(unreadableFileMessage(unreadable));
  }
  if (changed.length > 0) {
    refuse(concurrentEditMessage(changed));
  }

  // Preflight: every destination is checked before ANY of them is replaced.
  // Each rename is atomic on its own, but the set of them is not, so a
  // destination that cannot be written — a directory in the way, a symlink, a
  // read-only file — must be found now rather than after half the files have
  // already moved.
  for (const file of files) {
    const destination = path.join(radiusDir, file);
    if (existsSync(destination) && !lstatSync(destination).isFile()) {
      refuse(
        `Cannot publish ${file}: ${destination} exists and is not a regular file, so this run was discarded rather than half-published.`
      );
    }
  }

  // Past this point every check has passed, so the moves happen. Each is a
  // rename inside one directory.
  //
  // The individual renames are atomic; the SET of them is not. So the file being
  // replaced is moved aside first, and if any rename fails the ones already done
  // are put back. That leaves the repository as it was rather than half
  // published, which is the whole point of the exercise.
  // An entry is recorded for EVERY destination the loop touches, including the
  // ones that did not exist before. A first-ever run creates `app.bicep` fresh,
  // so without an entry for it a later failure would leave it published by a run
  // that was refused — the common case, not an exotic one.
  const moves = [];
  try {
    for (const file of files) {
      const destination = path.join(radiusDir, file);
      const existed = existsSync(destination);
      const backup =
        existed ? path.join(stagingDir, `${file}.published-backup`) : null;
      if (existed) renameSync(destination, backup);
      const entry = { destination, backup, published: false };
      moves.push(entry);
      renameSync(path.join(stagingDir, file), destination);
      entry.published = true;
    }
  } catch (error) {
    for (const entry of moves.reverse()) {
      // Remove what this run put there, then restore what it displaced. A
      // destination with no backup simply did not exist before, so removing it
      // is the whole of the undo.
      if (entry.published) rmSync(entry.destination, { force: true });
      if (entry.backup) renameSync(entry.backup, entry.destination);
    }
    refuse(
      `Publishing the application model failed partway (${error.message}), so every file was put back as it was.`
    );
  }
  rmSync(stagingDir, { recursive: true, force: true });
  const wroteIgnore = ensureStagingIgnored(radiusDir);

  // Staging in git is the last thing that happens, so a run that failed anywhere
  // above leaves nothing in the index.
  const repoRoot = repositoryRoot(radiusDir);
  const published = files.map((file) => path.join(radiusDir, file));
  // The ignore rule is staged only when THIS run wrote it. A `.gitignore` that
  // was already there may hold unrelated changes of the user's, and staging
  // those on their behalf is not this script's business.
  const staged =
    wroteIgnore ?
      [...published, path.join(radiusDir, ".gitignore")]
    : published;
  const gitError = gitAdd(repoRoot, staged);
  for (const file of published) console.log(file);
  if (gitError) {
    // The model IS published, so this is not a failure of the publish and the
    // staged run must not be resurrected. It is still not success: the caller
    // has to tell the user the files are on disk but not staged, so it gets its
    // own exit code rather than being buried in a warning on a zero exit.
    console.error(
      `Published the application model, but could not stage it with git: ${gitError}. Report that the files were written but NOT staged; the user can stage them themselves.`
    );
    process.exit(2);
  }
}

// --- abort -----------------------------------------------------------------

// Discards a run that failed partway. The skill calls this instead of deleting
// the staging directory itself, so the ignore-file write is undone too and the
// repository is left exactly as the run found it.
function abort() {
  const radiusDir = resolveRadiusDir();
  const requested = flag("staging");
  if (!requested) {
    fail(
      "A staging directory is required: pass --staging <dir> naming the directory this run wrote into."
    );
  }
  const stagingDir = path.resolve(requested);
  if (
    path.dirname(stagingDir) !== radiusDir ||
    !isStagingDirName(path.basename(stagingDir))
  ) {
    fail(
      `The staging directory must be a ${STAGING_DIR_PREFIX}* directory directly inside ${radiusDir}. Received: ${requested}`
    );
  }
  rmSync(stagingDir, { recursive: true, force: true });
  console.log(
    "Discarded the staged modeling run. Nothing was written: .radius/ is exactly as it was before this run, and nothing was staged in git."
  );
}

if (hasFlag("begin")) {
  begin();
} else if (hasFlag("abort")) {
  abort();
} else {
  publish();
}
