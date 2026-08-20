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
  mkdirSync,
  readFileSync,
  readdirSync,
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

// The application model as it stands in `.radius/`, or null when there is none.
// A model that cannot be read is reported as absent rather than as an error: the
// publish compares this to the same reading taken at the start of the run, so
// "unreadable then, unreadable now" is legitimately unchanged, and "readable
// then, unreadable now" is a change the publish must refuse on.
function currentModelHash(radiusDir) {
  const model = readFile(path.join(radiusDir, "app.bicep"));
  return model && model.trim() ? hashAppBicep(model) : null;
}

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

// Everything the run produced, minus its own bookkeeping. The required set is
// what a run must hold, not the whole of what it may hold — a custom type also
// brings a recipe pack and possibly an authored recipe — and leaving those
// behind would publish a model whose supporting artifacts never arrived.
function publishableFiles(present, required) {
  const extra = [...present]
    .filter((name) => name !== STAGING_RUN_RECORD && !required.includes(name))
    .sort();
  return [...required, ...extra];
}

// Removes every staging directory under `.radius/`. A run that finished always
// removes its own, so anything still here belongs to a run that did not, and is
// not something the user needs: a directory of half-finished files is mostly a
// way to mistake a discarded run for a real application model.
function purgeStagingDirs(radiusDir, keep = null) {
  if (!existsSync(radiusDir)) return [];
  const removed = [];
  for (const entry of readdirSync(radiusDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isStagingDirName(entry.name)) continue;
    if (keep && entry.name === keep) continue;
    rmSync(path.join(radiusDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

// `.radius/.gitignore` rather than the repository root's: the rule is about this
// directory, the directory is created by modeling anyway, and writing here
// cannot disturb an ignore file the user maintains.
//
// This is the one thing a run writes outside its staging directory, so what it
// wrote is recorded and undone if the run is refused. Otherwise a failed run
// would leave `.radius/` different from how it found it, which is the guarantee
// this script exists to provide.
function ensureStagingIgnored(radiusDir) {
  const ignoreFile = path.join(radiusDir, ".gitignore");
  const existing = readFile(ignoreFile);
  const text = existing || "";
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.includes(STAGING_IGNORE_PATTERN)) return "unchanged";
  const body = text && !text.endsWith("\n") ? `${text}\n` : text;
  writeFileSync(ignoreFile, `${body}${STAGING_IGNORE_PATTERN}\n`, "utf8");
  return existing === null ? "created" : "appended";
}

// Undoes ensureStagingIgnored for a run that is being discarded.
function revertStagingIgnore(radiusDir, ignoreWrite) {
  const ignoreFile = path.join(radiusDir, ".gitignore");
  if (ignoreWrite === "created") {
    rmSync(ignoreFile, { force: true });
    return;
  }
  if (ignoreWrite !== "appended") return;
  const text = readFile(ignoreFile);
  if (text === null) return;
  const kept = text
    .split("\n")
    .filter((line) => line.trim() !== STAGING_IGNORE_PATTERN);
  writeFileSync(ignoreFile, kept.join("\n"), "utf8");
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
  return path.resolve(requested || ".radius");
}

// --- begin -----------------------------------------------------------------

function begin() {
  const radiusDir = resolveRadiusDir();
  mkdirSync(radiusDir, { recursive: true });
  purgeStagingDirs(radiusDir);
  const ignoreWrite = ensureStagingIgnored(radiusDir);

  const dirName = stagingDirName(flag("run-id"));
  const stagingDir = path.join(radiusDir, dirName);
  mkdirSync(stagingDir, { recursive: true });

  // The baseline fingerprint travels with the run rather than through the
  // agent, so the concurrent-edit check cannot be defeated by an agent that
  // forgets to pass it along or passes the wrong one.
  const record = {
    runId: dirName.slice(STAGING_DIR_PREFIX.length),
    startedAt: new Date().toISOString(),
    baselineAppBicepHash: currentModelHash(radiusDir),
    ignoreWrite
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
function refuseWith(stagingDir, radiusDir, ignoreWrite) {
  return (message) => {
    rmSync(stagingDir, { recursive: true, force: true });
    revertStagingIgnore(radiusDir, ignoreWrite);
    fail(
      `${message}\n\nNothing was written: .radius/ is exactly as it was before this run, and nothing was staged in git.`
    );
  };
}

// The run's own bookkeeping: the fingerprint of the application model as it was
// when the run started, and what the run wrote to the ignore file. A record that
// is missing or unreadable yields nulls, which makes the concurrent-edit check
// refuse for any repository that had a model — the safe direction.
function readRunRecord(stagingDir) {
  try {
    const parsed = JSON.parse(
      readFile(path.join(stagingDir, STAGING_RUN_RECORD)) || ""
    );
    const baseline = parsed?.baselineAppBicepHash;
    return {
      baseline:
        typeof baseline === "string" && baseline.trim() ?
          baseline.trim()
        : null,
      ignoreWrite:
        typeof parsed?.ignoreWrite === "string" ?
          parsed.ignoreWrite
        : "unchanged"
    };
  } catch {
    return { baseline: null, ignoreWrite: "unchanged" };
  }
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

  const { baseline, ignoreWrite } = readRunRecord(stagingDir);
  const refuse = refuseWith(stagingDir, radiusDir, ignoreWrite);

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

  if (currentModelHash(radiusDir) !== baseline) {
    refuse(
      ".radius/app.bicep changed while modeling was running, so the generated model was discarded rather than written over it. Your version of the file is intact. Re-run modeling when you are ready to replace it."
    );
  }

  // Past this point every check has passed, so the moves happen. Each is a
  // rename inside one directory.
  const files = publishableFiles(present, required);
  for (const file of files) {
    renameSync(path.join(stagingDir, file), path.join(radiusDir, file));
  }
  rmSync(stagingDir, { recursive: true, force: true });

  // Staging in git is the last thing that happens, so a run that failed anywhere
  // above leaves nothing in the index.
  const repoRoot = path.dirname(radiusDir);
  const published = files.map((file) => path.join(radiusDir, file));
  // The ignore rule is part of what modeling produced, so it is staged with the
  // run that wrote it rather than being left as an untracked change.
  const ignoreFile = path.join(radiusDir, ".gitignore");
  const staged =
    existsSync(ignoreFile) ? [...published, ignoreFile] : published;
  const gitError = gitAdd(repoRoot, staged);
  if (gitError) {
    console.error(
      `Published the application model, but could not stage it with git: ${gitError}`
    );
  }
  for (const file of published) console.log(file);
}

if (hasFlag("begin")) {
  begin();
} else {
  publish();
}
