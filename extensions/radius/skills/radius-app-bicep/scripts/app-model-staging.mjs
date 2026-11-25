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
//   --begin [--run-id <id>]   Prepare a run: create a private staging
//                             directory that hides itself from git, record the
//                             fingerprint of the application model as it is
//                             right now, and print the directory to write into.
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
// Git index failures are reported separately after promotion has committed.
//
// The rules below MUST stay behavior-compatible with
// packages/core/src/modeling/app-staging.ts, and the hash with
// packages/adapter-canvas/src/app-bicep-hash.ts. They are duplicated here rather
// than imported because this script ships inside the installed plugin, where the
// workspace packages do not exist; promote-app-model.test.ts asserts the copies
// agree.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STAGING_DIR_PREFIX = ".staging-";
const MANAGED_RUN_PREFIX = `${STAGING_DIR_PREFIX}managed-`;
const STAGING_IGNORE_PATTERN = `${STAGING_DIR_PREFIX}*/`;
const STAGING_RUN_RECORD = "run.json";

// A staging directory hides itself from git the moment it exists, by carrying
// its own ignore file that excludes everything in it — including the ignore
// file itself.
//
// This is what `.radius/.gitignore` cannot do. That rule is only written when a
// run publishes (see ensureStagingIgnored), so until some run succeeds there is
// no rule, and an interrupted run leaves an untracked directory a bulk
// `git add -A` will happily commit. Agents commit on the user's behalf, so
// "it is only untracked noise in `git status`" is not the whole cost.
//
// Writing it here rather than into `.radius/.gitignore` at `--begin` is what
// keeps the byte-identical guarantee intact: it lives INSIDE the directory the
// failure paths already delete, so no failure path has to remember to undo it.
const STAGING_SELF_IGNORE_FILE = ".gitignore";
const STAGING_SELF_IGNORE = "*\n";
const PUBLISHED_BACKUP_SUFFIX = ".published-backup";
const REQUIRED_STAGED_FILES = [
  "app.bicep",
  "bicepconfig.json",
  "app.origin.json"
];
const CUSTOM_TYPE_STAGED_FILES = ["custom-types.yaml", "custom-types.tgz"];

function fail(message) {
  throw new RefusedPromotion(message);
}

class RefusedPromotion extends Error {}

class PromotionRecoveryRequired extends RefusedPromotion {}

class IncompletePromotionRollback extends PromotionRecoveryRequired {
  constructor(stagingDir, promotionError, rollbackErrors) {
    super(
      `Publishing the application model failed (${promotionError.message}) and rollback was incomplete: ${rollbackErrors.map((error) => error.message).join("; ")}. Recovery files remain at ${stagingDir}. Review and restore the backups before retrying modeling.`,
      {
        cause: new AggregateError(rollbackErrors, "Model rollback failed", {
          cause: promotionError
        })
      }
    );
  }
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
    const regular = readStableRegularFile(file);
    if (!regular) return { state: "absent", hash: null };
    bytes = regular.bytes;
  } catch (error) {
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
export function isPublishableExtraArtifact(name) {
  return (
    name === "custom-recipe-pack.bicep" ||
    /^(?:[a-z0-9-]+|[a-z][A-Za-z0-9]*)-recipe\.bicep$/u.test(name)
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
        .filter((entry) => isPublishableExtraArtifact(entry.name))
        .map((entry) => entry.name)
    : [];
  return [...new Set([...MANAGED_FILES, ...existing])].sort();
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
// Interrupted runs are already ignored by their own ignore file
// (see STAGING_SELF_IGNORE).
//
// Returns true when the file was written, so only a rule this run added is
// staged in git.
function readStableRegularFile(file) {
  let fd;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    // On platforms without O_NOFOLLOW, a dangling link can also produce ENOENT.
    if (
      error.code === "ENOENT" &&
      !lstatSync(file, { throwIfNoEntry: false })
    ) {
      return null;
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const entry = lstatSync(file, {
      bigint: true,
      throwIfNoEntry: false
    });
    if (
      !opened.isFile() ||
      !entry?.isFile() ||
      entry.dev !== opened.dev ||
      entry.ino !== opened.ino
    ) {
      fail(`${file} is not a stable regular file.`);
    }
    return { bytes: readFileSync(fd), mode: Number(opened.mode) };
  } finally {
    closeSync(fd);
  }
}

function readStagingIgnoreFile(ignoreFile) {
  const file = readStableRegularFile(ignoreFile);
  return file ?
      { text: file.bytes.toString("utf8"), mode: file.mode }
    : { text: "" };
}

function ensureStagingIgnored(radiusDir, stagingDir) {
  const ignoreFile = path.join(radiusDir, ".gitignore");
  const { text, mode } = readStagingIgnoreFile(ignoreFile);
  if (text.split("\n").some((line) => line.trim() === STAGING_IGNORE_PATTERN)) {
    return false;
  }
  const body = text && !text.endsWith("\n") ? `${text}\n` : text;
  const pending = path.join(stagingDir, ".radius-gitignore.pending");
  const fd = openSync(pending, "wx", mode === undefined ? undefined : 0o600);
  try {
    writeFileSync(fd, `${body}${STAGING_IGNORE_PATTERN}\n`, "utf8");
    // Creation applies the process umask; restore the original mode on the
    // inode we opened before installing it at the destination.
    if (mode !== undefined) fchmodSync(fd, mode & 0o7777);
  } finally {
    closeSync(fd);
  }
  renameSync(pending, ignoreFile);
  return true;
}

const gitOptions = {
  encoding: "utf8",
  timeout: 15_000,
  windowsHide: true
};

const git = {
  async discoverRepositoryRoot(radiusDir) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", radiusDir, "rev-parse", "--show-toplevel"],
      gitOptions
    );
    return stdout.trim();
  },
  async stageFiles(repoRoot, files) {
    await execFileAsync(
      "git",
      ["-C", repoRoot, "add", "--", ...files],
      gitOptions
    );
  }
};

function gitDiagnostic(error, fallback) {
  const stderr = error?.stderr;
  const message = error instanceof Error ? error.message : error;
  return (
    (typeof stderr === "string" && stderr.trim()) ||
    (typeof message === "string" && message.trim()) ||
    fallback
  );
}

function resolveRadiusDir(requested) {
  const resolved = path.resolve(requested || ".radius");
  // Canonicalized so the confinement below compares real paths. A symlinked
  // `.radius` would otherwise let every later path check pass while the writes
  // landed somewhere else entirely.
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

// True when the path exists and is a real directory rather than a symlink to
// one. A symlink
// named `.staging-*` is never something this script created, so it is never
// followed, written through, or published from.
function isRealDirectory(target) {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function directoryIdentity(target) {
  const entry = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  return entry?.isDirectory() ? `${entry.dev}:${entry.ino}` : null;
}

// --- begin -----------------------------------------------------------------

function begin(radiusDir, dirName) {
  mkdirSync(radiusDir, { recursive: true });
  // Age cannot prove that another session has finished writing.
  const stagingDir = path.join(radiusDir, dirName);
  try {
    mkdirSync(stagingDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    fail(
      `Modeling staging path ${stagingDir} already exists. Start a new run with a different ID.`
    );
  }
  // Written before anything else the run produces, so there is no window in
  // which the directory holds model files git can see.
  writeFileSync(
    path.join(stagingDir, STAGING_SELF_IGNORE_FILE),
    STAGING_SELF_IGNORE,
    "utf8"
  );

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
  return { stagingDir, baseline: record.baseline };
}

// A live runtime holds this handle; run.json is not authorization.
const hashModelBytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function beginManagedRun(workspaceRoot, observed = []) {
  const root = realpathSync(workspaceRoot);
  const radiusDir = path.join(root, ".radius");
  if (
    lstatSync(radiusDir, { throwIfNoEntry: false }) &&
    !isRealDirectory(radiusDir)
  ) {
    fail(`Managed modeling requires a real .radius directory in ${root}.`);
  }
  const observedPaths = new Set([
    "app.bicep",
    "app.origin.json",
    ".radius/app.bicep",
    ".radius/app.origin.json"
  ]);
  function assertObservedBaseline() {
    for (const { path: relative, hash } of observed) {
      if (!observedPaths.has(relative))
        fail("Unexpected managed model baseline path.");
      const file = readStableRegularFile(path.join(root, relative));
      if ((file ? hashModelBytes(file.bytes) : null) !== hash) {
        fail(`Managed model files changed while modeling: ${relative}.`);
      }
    }
  }
  assertObservedBaseline();
  const { stagingDir, baseline } = begin(
    radiusDir,
    `${MANAGED_RUN_PREFIX}${randomUUID()}`
  );
  const radiusIdentity = directoryIdentity(radiusDir);
  const stagingIdentity = directoryIdentity(stagingDir);
  function assertActive() {
    if (finished) fail("This managed modeling run is no longer active.");
    if (
      !radiusIdentity ||
      directoryIdentity(radiusDir) !== radiusIdentity ||
      !stagingIdentity ||
      directoryIdentity(stagingDir) !== stagingIdentity
    ) {
      fail(
        "The modeling staging directory or its parent changed while modeling was running."
      );
    }
  }
  let finished = false;
  let validating = false;
  let validatedCopy;
  function snapshot(dir) {
    const present = new Set(readdirSync(dir));
    const files = publishableFiles(present, requiredStagedFiles(present));
    files.push(STAGING_RUN_RECORD);
    if (present.has("resolved-types.json")) files.push("resolved-types.json");
    return files.map((name) => {
      const file = path.join(dir, name);
      const entry = readStableRegularFile(file);
      if (!entry) fail(`The managed modeling run is missing ${file}.`);
      return [name, entry.bytes];
    });
  }
  function digest(files) {
    return JSON.stringify(
      files.map(([name, bytes]) => [name, hashModelBytes(bytes)])
    );
  }
  function removeCopy(copy, identity) {
    if (identity && directoryIdentity(copy) === identity) {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  return {
    stagingDir,
    assertBaseline() {
      assertActive();
      assertObservedBaseline();
      const unreadable = Object.keys(baseline).filter(
        (file) => baseline[file] === "unreadable"
      );
      if (unreadable.length > 0) {
        fail(
          `Cannot verify the managed model baseline: ${unreadable.join(", ")}.`
        );
      }
      const files = [
        ...new Set([...Object.keys(baseline), ...managedFilesFor(radiusDir)])
      ];
      const changed = changedManagedFiles(baseline, radiusDir, files, true);
      if (changed.length > 0) {
        fail(
          `Managed model files changed while modeling: ${changed.join(", ")}.`
        );
      }
    },
    artifact(name, required) {
      assertActive();
      if (!/^[a-z0-9][a-z0-9.-]*$/iu.test(name)) {
        fail("A managed artifact must be a direct staging file.");
      }
      const file = path.join(stagingDir, name);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat ? !stat.isFile() || stat.nlink !== 1 : required) {
        fail(`Expected a regular managed staging file at ${file}.`);
      }
      return file;
    },
    cancel() {
      finished = true;
      if (validatedCopy) removeCopy(validatedCopy.dir, validatedCopy.identity);
    },
    async validate(check, isExitUnconfirmed) {
      assertActive();
      if (validating || validatedCopy)
        fail("This run has already started final validation.");
      const files = snapshot(stagingDir);
      const expected = digest(files);
      const dir = path.join(
        radiusDir,
        `${MANAGED_RUN_PREFIX}validation-${randomUUID()}`
      );
      mkdirSync(dir, { mode: 0o700 });
      const identity = directoryIdentity(dir);
      validating = true;
      let retain = false;
      try {
        writeFileSync(
          path.join(dir, STAGING_SELF_IGNORE_FILE),
          STAGING_SELF_IGNORE,
          { flag: "wx" }
        );
        for (const [name, bytes] of files) {
          writeFileSync(path.join(dir, name), bytes, { flag: "wx" });
        }
        await check(path.join(dir, "app.bicep"));
        assertActive();
        if (
          directoryIdentity(dir) !== identity ||
          digest(snapshot(dir)) !== expected ||
          digest(snapshot(stagingDir)) !== expected
        ) {
          fail("Staged artifacts changed while Radius was validating them.");
        }
        const byName = new Map(files);
        validatedCopy = {
          dir,
          identity,
          expected,
          committed: {
            definitionHash: hashModelBytes(byName.get("app.bicep")),
            originHash: hashModelBytes(byName.get("app.origin.json"))
          }
        };
      } catch (error) {
        retain = Boolean(isExitUnconfirmed?.(error));
        if (retain) {
          throw new Error(
            `${error.message} Validation cleanup is incomplete; the ignored copy remains at ${dir}.`,
            { cause: error }
          );
        }
        throw error;
      } finally {
        validating = false;
        if (!retain && !validatedCopy) removeCopy(dir, identity);
      }
    },
    async promote(prepareCommit, beforeCommit, options = {}) {
      assertActive();
      const copy = validatedCopy;
      if (!copy)
        fail(
          "Radius cannot promote artifacts that have not passed validation."
        );
      validatedCopy = undefined;
      let retainForRecovery = false;
      try {
        return await publish(radiusDir, copy.dir, {
          ...options,
          managedBaseline: baseline,
          prepareCommit,
          beforeCommit() {
            assertActive();
            beforeCommit();
            assertObservedBaseline();
            finished = true;
            if (
              directoryIdentity(copy.dir) !== copy.identity ||
              digest(snapshot(copy.dir)) !== copy.expected ||
              digest(snapshot(stagingDir)) !== copy.expected
            ) {
              fail("Radius cannot promote artifacts that changed afterward.");
            }
          },
          onFilesystemCommitted() {
            options.onFilesystemCommitted?.(copy.committed);
            try {
              removeCopy(stagingDir, stagingIdentity);
            } catch (error) {
              console.error(
                `The model was written, but ${stagingDir} could not be removed (${error.message}).`
              );
            }
          }
        });
      } catch (error) {
        retainForRecovery = error instanceof PromotionRecoveryRequired;
        throw error;
      } finally {
        if (!retainForRecovery) {
          try {
            removeCopy(copy.dir, copy.identity);
          } catch (error) {
            console.error(
              `The ignored validation copy at ${copy.dir} could not be removed (${error.message}).`
            );
          }
        }
      }
    }
  };
}

// --- publish ---------------------------------------------------------------

// Refusals before a write or after a complete rollback discard the staged run.
// An incomplete rollback retains it because it may hold the only backups.
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
        `Note: the staged run at ${stagingDir} could not be removed (${error.message}). It is ignored by git; remove it only after confirming the run has stopped.`
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
function changedManagedFiles(baseline, radiusDir, files, managed) {
  // Only files the baseline actually covers can be compared. One it does not
  // cover carries no evidence either way, and treating "not fingerprinted" as
  // "was absent" would report an untouched file as a concurrent edit.
  const comparable = files.filter(
    (file) => managed || Object.prototype.hasOwnProperty.call(baseline, file)
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

function resolveStagingDirectory(radiusDir, requested, managedBaseline) {
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

  if (isManagedRun(stagingDir) && !managedBaseline) {
    fail(
      "Only the runtime that started this managed modeling run can promote it."
    );
  }
  return stagingDir;
}

function assertNoRecoveryBackups(stagingDir) {
  if (
    readdirSync(stagingDir).some((name) =>
      name.endsWith(PUBLISHED_BACKUP_SUFFIX)
    )
  ) {
    throw new PromotionRecoveryRequired(
      `Recovery files remain at ${stagingDir}. Review and restore the backups before retrying modeling.`
    );
  }
}

async function publish(
  radiusDir,
  requested,
  {
    gitPorts = git,
    managedBaseline,
    prepareCommit,
    beforeCommit,
    onFilesystemCommitted
  } = {}
) {
  const stagingDir = resolveStagingDirectory(
    radiusDir,
    requested,
    managedBaseline
  );
  const stagingIdentity = directoryIdentity(stagingDir);
  const radiusIdentity = directoryIdentity(radiusDir);
  let repoRoot;
  let gitError = "";
  try {
    repoRoot = await gitPorts.discoverRepositoryRoot(radiusDir);
    if (!path.isAbsolute(repoRoot))
      fail("Git did not identify a repository root.");
  } catch (error) {
    gitError = gitDiagnostic(error, "Git repository discovery failed");
  }

  if (prepareCommit) await prepareCommit();
  if (
    !stagingIdentity ||
    !radiusIdentity ||
    directoryIdentity(stagingDir) !== stagingIdentity ||
    directoryIdentity(radiusDir) !== radiusIdentity
  ) {
    fail(
      "The modeling staging directory or its parent changed before promotion."
    );
  }
  // Admission and the filesystem transaction stay in the same synchronous turn.
  beforeCommit?.();
  const { published, staged } = commitPromotion(
    radiusDir,
    stagingDir,
    managedBaseline
  );
  onFilesystemCommitted?.();
  if (!gitError) {
    try {
      await gitPorts.stageFiles(repoRoot, staged);
    } catch (error) {
      gitError = gitDiagnostic(error, "git add failed");
    }
  }
  return { published, gitError };
}

function commitPromotion(radiusDir, stagingDir, managedBaseline) {
  assertNoRecoveryBackups(stagingDir);
  const record =
    managedBaseline ? { baseline: managedBaseline } : readRunRecord(stagingDir);
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
  const changed = changedManagedFiles(
    record.baseline,
    radiusDir,
    files,
    Boolean(managedBaseline)
  );
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
  let wroteIgnore;
  try {
    for (const file of files) {
      const destination = path.join(radiusDir, file);
      const existed = existsSync(destination);
      const backup =
        existed ?
          path.join(stagingDir, `${file}${PUBLISHED_BACKUP_SUFFIX}`)
        : null;
      if (existed) renameSync(destination, backup);
      const entry = { destination, backup, published: false };
      moves.push(entry);
      renameSync(path.join(stagingDir, file), destination);
      entry.published = true;
    }
    wroteIgnore = ensureStagingIgnored(radiusDir, stagingDir);
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of moves.reverse()) {
      // Remove what this run put there, then restore what it displaced. A
      // destination with no backup simply did not exist before, so removing it
      // is the whole of the undo.
      try {
        if (entry.published) rmSync(entry.destination, { force: true });
        if (entry.backup) renameSync(entry.backup, entry.destination);
      } catch (rollbackError) {
        rollbackErrors.push(
          new Error(`${entry.destination}: ${rollbackError.message}`, {
            cause: rollbackError
          })
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new IncompletePromotionRollback(stagingDir, error, rollbackErrors);
    }
    refuse(
      `Publishing the application model failed partway (${error.message}), so every file was put back as it was.`
    );
  }
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `Note: the model was promoted, but the staging directory at ${stagingDir} could not be removed (${error.message}).`
    );
  }

  const published = files.map((file) => path.join(radiusDir, file));
  // The ignore rule is staged only when THIS run wrote it. A `.gitignore` that
  // was already there may hold unrelated changes of the user's, and staging
  // those on their behalf is not this script's business.
  const staged =
    wroteIgnore ?
      [...published, path.join(radiusDir, ".gitignore")]
    : published;
  return { published, staged };
}

// --- abort -----------------------------------------------------------------

// Discards a run that failed partway. The skill calls this instead of deleting
// the staging directory itself, so the ignore-file write is undone too and the
// repository is left exactly as the run found it.
function abort(radiusDir, requested) {
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
  if (isManagedRun(stagingDir)) {
    fail(
      "Only the runtime that started this managed modeling run can cancel it."
    );
  }
  if (lstatSync(stagingDir, { throwIfNoEntry: false })?.isDirectory()) {
    assertNoRecoveryBackups(stagingDir);
  }
  rmSync(stagingDir, { recursive: true, force: true });
  console.log(
    "Discarded the staged modeling run. Nothing was written: .radius/ is exactly as it was before this run, and nothing was staged in git."
  );
}

export async function runPromotionCli() {
  try {
    const radiusDir = resolveRadiusDir(flag("radius-dir"));
    if (hasFlag("begin")) {
      const dirName = stagingDirName(flag("run-id") || randomUUID());
      if (isManagedRun(dirName)) {
        fail(
          "Staging IDs starting with managed- are reserved for the runtime."
        );
      }
      console.log(begin(radiusDir, dirName).stagingDir);
    } else if (hasFlag("abort")) {
      abort(radiusDir, flag("staging"));
    } else {
      const { published, gitError } = await publish(radiusDir, flag("staging"));
      for (const file of published) console.log(file);
      if (gitError) {
        console.error(
          `Published the application model, but could not stage it with git: ${gitError}. Report that the files were written but NOT staged; the user can stage them themselves.`
        );
        process.exitCode = 2;
      }
    }
  } catch (error) {
    if (!(error instanceof RefusedPromotion)) throw error;
    console.error(error.message);
    process.exitCode = error instanceof PromotionRecoveryRequired ? 3 : 1;
  }
}

export function isManagedRun(stagingPath) {
  return path
    .basename(stagingPath)
    .toLowerCase()
    .startsWith(MANAGED_RUN_PREFIX);
}
