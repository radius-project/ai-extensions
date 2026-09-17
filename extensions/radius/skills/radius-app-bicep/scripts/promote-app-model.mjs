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
//                             behind by an interrupted run, create a staging
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
// The rules below MUST stay behavior-compatible with
// packages/core/src/modeling/app-staging.ts, and the hash with
// packages/adapter-canvas/src/app-bicep-hash.ts. They are duplicated here rather
// than imported because this script ships inside the installed plugin, where the
// workspace packages do not exist; promote-app-model.test.ts asserts the copies
// agree.

import { spawnSync as spawnProcessSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const STAGING_DIR_PREFIX = ".staging-";
const STAGING_IGNORE_PATTERN = `${STAGING_DIR_PREFIX}*/`;
const STAGING_RUN_RECORD = "run.json";
const VALIDATION_SEAL = "validation-seal.json";

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
const REQUIRED_STAGED_FILES = [
  "app.bicep",
  "bicepconfig.json",
  "app.origin.json"
];
const CUSTOM_TYPE_STAGED_FILES = ["custom-types.yaml", "custom-types.tgz"];

function flag(name, args) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return "";
  const value = args[index + 1];
  return typeof value === "string" && !value.startsWith("--") ?
      value.trim()
    : "";
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
  const safe = (typeof value === "string" ? value : "")
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

function isFingerprint(value) {
  return (
    value === null ||
    (typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value))
  );
}

/**
 * The installed CLI and the in-process adapter share one filesystem transaction.
 * Keep its I/O instance-scoped so adapters can provide their filesystem and
 * command boundary without changing the publication rules.
 *
 * @param {PromotionDependencies} dependencies
 */
function createPromotionOperations(dependencies) {
  const {
    existsSync = fs.existsSync,
    lstatSync = fs.lstatSync,
    mkdirSync = fs.mkdirSync,
    readFileSync = fs.readFileSync,
    readdirSync = fs.readdirSync,
    renameSync = fs.renameSync,
    rmSync = fs.rmSync,
    writeFileSync = fs.writeFileSync,
    spawnSync = spawnProcessSync
  } = dependencies;

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
  // Every input and output uses exact bytes. Normalized origin hashes establish
  // model identity, but cannot prove which bytes the validator checked.
  function fingerprintManagedFile(file) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return { state: "absent", hash: null };
      return { state: "unreadable", hash: null, reason: error.message };
    }
    return {
      state: "present",
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    };
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
      const { state, hash } = fingerprintManagedFile(
        path.join(radiusDir, file)
      );
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

  function hasRecoveryFiles(directory) {
    return (
      existsSync(directory) &&
      readdirSync(directory).some((name) => name.endsWith(".published-backup"))
    );
  }

  function purgeStagingDirs(radiusDir, staleAfterMs = STAGING_STALE_AFTER_MS) {
    const now = Date.now();
    if (!existsSync(radiusDir)) return [];
    const removed = [];
    for (const entry of readdirSync(radiusDir, { withFileTypes: true })) {
      // `isDirectory()` on a Dirent is already an lstat, so a symlink named
      // `.staging-*` is skipped rather than followed and deleted through.
      if (!entry.isDirectory() || !isStagingDirName(entry.name)) continue;
      const dir = path.join(radiusDir, entry.name);
      if (hasRecoveryFiles(dir)) {
        continue;
      }
      let startedAt;
      try {
        startedAt = lstatSync(dir).mtimeMs;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
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
  // The cost used to be that a run interrupted mid-flight left its staging
  // directory untracked until the next run swept it up. That is now covered from
  // the moment the directory is created, by the ignore file the directory carries
  // itself (see STAGING_SELF_IGNORE), so this rule is belt-and-braces for the
  // repository rather than the only thing standing between an interrupted run and
  // a bulk `git add`.
  //
  // Returns true when the file was written, so only a rule this run added is
  // staged in git.
  function ensureStagingIgnored(radiusDir) {
    const ignoreFile = path.join(radiusDir, ".gitignore");
    const existing = readFile(ignoreFile);
    const text = existing || "";
    if (
      text.split("\n").some((line) => line.trim() === STAGING_IGNORE_PATTERN)
    ) {
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
    return path.resolve(
      (result.stdout || "").trim() || path.dirname(radiusDir)
    );
  }

  function gitAdd(repoRoot, files) {
    const result = spawnSync("git", ["-C", repoRoot, "add", "--", ...files], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return (
        result.stderr ||
        result.error?.message ||
        "git add failed"
      ).trim();
    }
    return "";
  }

  function assertSafePath(target, directory = false) {
    if (/^(?:\\\\|\/\/)/u.test(target))
      throw new Error(`UNC promotion paths are not supported: ${target}`);
    if (
      /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(target) ||
      /^[A-Za-z]:(?![\\/])/u.test(target)
    )
      throw new Error(`Unsafe promotion path: ${target}`);
    const absolute = path.resolve(target);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep)) {
      if (!part) continue;
      if (part.includes(":") || /[. ]$/u.test(part)) {
        throw new Error(`Unsafe promotion path: ${target}`);
      }
      cursor = path.join(cursor, part);
      let stat;
      try {
        stat = lstatSync(cursor);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
        (cursor !== absolute && !stat.isDirectory()) ||
        (cursor === absolute && !directory && !stat.isFile()) ||
        (cursor === absolute && directory && !stat.isDirectory())
      ) {
        throw new Error(
          `Unsafe promotion path (linked or not a regular file/directory): ${target}`
        );
      }
    }
  }

  function exactHash(file) {
    assertSafePath(file);
    const fingerprint = fingerprintManagedFile(file);
    if (fingerprint.state === "unreadable") {
      throw new Error(
        `Cannot read promotion input ${file}: ${fingerprint.reason}`
      );
    }
    return fingerprint.hash;
  }

  function workspaceSnapshot(root) {
    const snapshot = Object.create(null);
    function visit(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name === ".git" ||
          entry.name === "node_modules" ||
          isStagingDirName(entry.name)
        )
          continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else {
          const key = path.relative(root, file).split(path.sep).join("/");
          if (entry.isFile() && lstatSync(file).nlink === 1) {
            const fingerprint = fingerprintManagedFile(file);
            snapshot[key] =
              fingerprint.state === "unreadable" ?
                "unreadable"
              : fingerprint.hash;
          } else snapshot[key] = "unsafe";
        }
      }
    }
    visit(root);
    return snapshot;
  }

  function effectiveInputs(root, radiusDir, stagingDir) {
    const inputs = new Set();
    const visited = new Set();
    function resolveInput(parent, reference) {
      if (
        !reference ||
        reference.includes("${") ||
        reference.includes("\\") ||
        reference.includes(":") ||
        path.posix.isAbsolute(reference)
      )
        throw new Error(`Unsupported effective input reference: ${reference}`);
      const file = path.resolve(parent, reference);
      const key = path.relative(root, file).split(path.sep).join("/");
      if (key === ".." || key.startsWith("../") || path.isAbsolute(key)) {
        throw new Error(`Effective input escapes the workspace: ${reference}`);
      }
      return file;
    }
    function visit(file) {
      const key = path.relative(root, file).split(path.sep).join("/");
      inputs.add(key);
      if (visited.has(key)) return;
      visited.add(key);
      const staged =
        stagingDir && path.dirname(file) === radiusDir ?
          path.join(stagingDir, path.basename(file))
        : undefined;
      const actual = staged && existsSync(staged) ? staged : file;
      assertSafePath(actual);
      if (!existsSync(actual)) return;
      if (!file.endsWith(".bicep") && !file.endsWith("bicepconfig.json"))
        return;
      const text = readFileSync(actual, "utf8");
      if (file.endsWith("bicepconfig.json")) {
        const config = JSON.parse(text);
        for (const source of Object.values(config.extensions ?? {})) {
          const reference =
            typeof source === "string" ? source : source?.source;
          if (typeof reference !== "string") {
            throw new Error("An extension has no supported source reference.");
          }
          if (!reference.startsWith("br:")) {
            visit(resolveInput(path.dirname(file), reference));
          }
        }
        return;
      }
      const clean = text
        .replace(/\/\*[\s\S]*?\*\//gu, " ")
        .replace(/\/\/[^\n]*/gu, "");
      if (/\b(import|using|loadDirectoryFileInfo)\b/u.test(clean)) {
        throw new Error(
          "Unsupported effective input closure; publication refused."
        );
      }
      const references = [
        ...clean.matchAll(
          /\bmodule\s+\w+\s+'([^']+)'|\bload(?:TextContent|JsonContent|YamlContent|FileAsBase64)\s*\(\s*'([^']+)'|\bextension\s+'([^']+)'/gu
        )
      ];
      const expected = [
        ...clean.matchAll(
          /\bmodule\s+|\bload(?:TextContent|JsonContent|YamlContent|FileAsBase64)\s*\(|\bextension\s+'/gu
        )
      ].length;
      if (references.length !== expected) {
        throw new Error(
          "Dynamic effective input closure; publication refused."
        );
      }
      for (const match of references) {
        const reference = match[1] ?? match[2] ?? match[3];
        if (reference.startsWith("br:")) continue;
        visit(resolveInput(path.dirname(file), reference));
      }
    }
    visit(path.join(radiusDir, "app.bicep"));
    for (const file of managedFilesFor(radiusDir))
      visit(path.join(radiusDir, file));
    if (stagingDir) {
      for (const file of publishableFiles(
        new Set(readdirSync(stagingDir)),
        REQUIRED_STAGED_FILES
      ))
        visit(path.join(radiusDir, file));
    }
    // Include absent nearer configurations: adding one changes compiler behavior.
    let directory = radiusDir;
    while (true) {
      visit(path.join(directory, "bicepconfig.json"));
      if (directory === root) break;
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new Error("Radius directory is outside the workspace.");
      directory = parent;
    }
    return [...inputs].sort();
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

  /**
   * @param {{radiusDir: string, runId?: string, staleAfterMs?: number}} options
   * @returns {string}
   */
  function beginStagedRun({ radiusDir, runId = "", staleAfterMs }) {
    assertSafePath(radiusDir, true);
    radiusDir = path.resolve(radiusDir);
    assertSafePath(radiusDir, true);
    mkdirSync(radiusDir, { recursive: true });
    // `--stale-after-ms` exists so the sweep can be exercised deterministically
    // instead of by waiting hours; runs use the default.
    const staleAfter = staleAfterMs ?? NaN;
    purgeStagingDirs(
      radiusDir,
      Number.isFinite(staleAfter) && staleAfter >= 0 ?
        staleAfter
      : STAGING_STALE_AFTER_MS
    );
    const root = repositoryRoot(radiusDir);
    const sourceBaseline = workspaceSnapshot(root);
    const inputFiles = effectiveInputs(root, radiusDir);
    for (const file of inputFiles) {
      sourceBaseline[file] = exactHash(path.resolve(root, file));
    }

    // A unique id by default: two runs sharing `.staging-run` would sweep each
    // other away, and the sweep cannot tell a live run from an abandoned one.
    const dirName = stagingDirName(
      runId || `${Date.now().toString(36)}-${process.pid.toString(36)}`
    );
    const stagingDir = path.join(radiusDir, dirName);
    if (existsSync(stagingDir)) {
      throw new Error(
        `Cannot stage a modeling run at ${stagingDir}: it already exists.`
      );
    }
    mkdirSync(stagingDir, { recursive: true });
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
      version: 2,
      runId: dirName.slice(STAGING_DIR_PREFIX.length),
      startedAt: new Date().toISOString(),
      baseline: managedFileHashes(radiusDir, managedFilesFor(radiusDir)),
      sourceBaseline,
      inputFiles
    };
    writeFileSync(
      path.join(stagingDir, STAGING_RUN_RECORD),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
    return stagingDir;
  }

  // --- publish ---------------------------------------------------------------

  // Every refusal discards the staged run. It is never kept for inspection: what
  // the user needs in order to act is in the failure message, and keeping it would
  // leave the product with two places an application model might live.
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
    return parsed;
  }

  // Managed files whose content differs from what the run started with, limited to
  // the ones this run would actually replace. Every file the publish overwrites is
  // compared, not just `app.bicep`: a hand-tuned `bicepconfig.json` or custom-type
  // manifest is exactly as much the user's work as the model is.
  function changedManagedFiles(baseline, radiusDir, files) {
    // Only files the baseline actually covers can be compared. One it does not
    // cover carries no evidence either way, and treating "not fingerprinted" as
    // "was absent" would report an untouched file as a concurrent edit.
    const comparable = [...new Set([...Object.keys(baseline), ...files])];
    const current = managedFileHashes(radiusDir, comparable);
    return comparable
      .filter(
        (file) =>
          (!Object.prototype.hasOwnProperty.call(baseline, file) &&
            current[file] !== null) ||
          baseline[file] === "unreadable" ||
          current[file] === "unreadable" ||
          (baseline[file] ?? null) !== (current[file] ?? null)
      )
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

  async function verifyStagedRun(options, sealing = false) {
    const radiusDir = path.resolve(options.radiusDir);
    const stagingDir = path.resolve(options.stagingDir);
    if (
      path.dirname(stagingDir) !== radiusDir ||
      !isStagingDirName(path.basename(stagingDir))
    )
      throw new Error("Invalid staged validation location.");
    assertSafePath(stagingDir, true);
    const record = readRunRecord(stagingDir);
    if (
      !record ||
      record.version !== 2 ||
      record.runId !==
        path.basename(stagingDir).slice(STAGING_DIR_PREFIX.length) ||
      !record.sourceBaseline ||
      typeof record.sourceBaseline !== "object" ||
      Array.isArray(record.sourceBaseline) ||
      !Array.isArray(record.inputFiles) ||
      record.inputFiles.some(
        (file) =>
          typeof file !== "string" ||
          !Object.hasOwn(record.sourceBaseline, file) ||
          !isFingerprint(record.sourceBaseline[file])
      )
    )
      throw new Error(
        "A complete original run record from --begin is required."
      );
    const runHash = exactHash(path.join(stagingDir, STAGING_RUN_RECORD));
    if (
      !sealing &&
      !existsSync(path.join(stagingDir, VALIDATION_SEAL)) &&
      record.legacyValidationSealed !== true
    )
      return verifyStagedRun(options, true);
    let seal;
    if (!sealing) {
      assertSafePath(path.join(stagingDir, VALIDATION_SEAL));
      try {
        seal = JSON.parse(
          readFile(path.join(stagingDir, VALIDATION_SEAL)) || ""
        );
      } catch {
        throw new Error(
          "Run --seal after writing app.origin.json and before --staging."
        );
      }
      if (seal?.version !== 1 || seal.runHash !== runHash || !seal.outputs)
        throw new Error(
          "The sealed validation record or original run record changed."
        );
      const names = publishableFiles(
        new Set(readdirSync(stagingDir)),
        requiredStagedFiles(new Set(readdirSync(stagingDir)))
      );
      if (
        Object.keys(seal.outputs).length !== names.length ||
        names.some(
          (name) =>
            exactHash(path.join(stagingDir, name)) !== seal.outputs[name]
        )
      )
        throw new Error(
          "The staged outputs changed after successful validation."
        );
    }
    if (
      !Number.isInteger(record.repair?.attempts) ||
      record.repair.attempts < 1 ||
      record.repair.attempts > 6 ||
      record.repair.fingerprint !== null
    )
      throw new Error(
        "A successful agent compile within the repair budget is required before sealing."
      );
    const present = new Set(readdirSync(stagingDir));
    const names = publishableFiles(present, requiredStagedFiles(present));
    const outputs = Object.fromEntries(
      names.map((name) => [name, exactHash(path.join(stagingDir, name))])
    );
    if (
      Object.values(outputs).some((value) => value === null) ||
      stagedOriginHash(readFile(path.join(stagingDir, "app.origin.json"))) !==
        hashAppBicep(readFileSync(path.join(stagingDir, "app.bicep"), "utf8"))
    )
      throw new Error(
        "The staged origin record does not describe the complete proposal."
      );
    const root = repositoryRoot(radiusDir);
    const originalInputs = new Set([
      ...record.inputFiles,
      ...Object.keys(record.sourceBaseline).filter((file) =>
        isFingerprint(record.sourceBaseline[file])
      ),
      ...effectiveInputs(root, radiusDir)
    ]);
    function originalPath(file) {
      const absolute = path.resolve(root, file);
      const relative = path.relative(root, absolute);
      if (
        path.isAbsolute(file) ||
        path.win32.isAbsolute(file) ||
        file.includes("\\") ||
        file.includes(":") ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      )
        throw new Error(`Unsafe effective input path: ${file}`);
      return absolute;
    }
    const originalHashes = Object.fromEntries(
      [...originalInputs].map((file) => [file, exactHash(originalPath(file))])
    );
    for (const [file, value] of Object.entries(originalHashes))
      if ((record.sourceBaseline[file] ?? null) !== value)
        throw new Error(
          `Original effective input ${file} changed since --begin.`
        );
    const inputs = new Set([
      ...effectiveInputs(root, radiusDir, stagingDir),
      ...names.map((name) => `.radius/${name}`),
      ".radius/resolved-types.json"
    ]);
    const inputHashes = {};
    const captured = new Map();
    for (const file of inputs) {
      const original = originalPath(file);
      const name = path.basename(original);
      const staged = path.join(stagingDir, name);
      const actual =
        path.dirname(original) === radiusDir && existsSync(staged) ?
          staged
        : original;
      const value = exactHash(actual);
      inputHashes[file] = value;
      if (
        !(
          path.dirname(original) === radiusDir &&
          (names.includes(name) || name === "resolved-types.json")
        ) &&
        (record.sourceBaseline[file] ?? null) !== value
      )
        throw new Error(`Effective input ${file} changed since --begin.`);
      if (value !== null) {
        const bytes = readFileSync(actual);
        if (
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== value
        )
          throw new Error(`Effective input ${file} changed during capture.`);
        captured.set(file, { actual, bytes, hash: value });
      }
    }
    if (
      seal &&
      (!seal.inputs ||
        Object.keys(seal.inputs).length !== inputs.size ||
        [...inputs].some((file) => seal.inputs[file] !== inputHashes[file]))
    )
      throw new Error("The validation inputs changed after sealing.");
    const { verifyLegacyDefinition } = await import("./validate-bicep.mjs");
    const binaryDir = path.join(
      os.homedir(),
      ".radius",
      "ai-extensions",
      "bin"
    );
    const executable = (name) =>
      path.join(binaryDir, process.platform === "win32" ? `${name}.exe` : name);
    const verificationDir = path.join(
      stagingDir,
      `verification-${randomUUID()}`
    );
    mkdirSync(verificationDir, { mode: 0o700 });
    try {
      for (const [file, { bytes }] of captured) {
        const destination = path.join(verificationDir, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
      }
      if (
        verifyLegacyDefinition(
          path.join(verificationDir, ".radius", "app.bicep"),
          options.bicepPath || executable("bicep")
        ) !== 0
      )
        throw new Error(
          "Legacy compiler/static validation failed; nothing was published."
        );
    } finally {
      rmSync(verificationDir, { recursive: true, force: true });
    }
    const evidence = {
      outputs,
      originalInputs: [...originalInputs],
      originalHashes,
      inputHashes
    };
    if (exactHash(path.join(stagingDir, STAGING_RUN_RECORD)) !== runHash)
      throw new Error("The original run record changed during validation.");
    for (const [file, value] of Object.entries(evidence.outputs)) {
      if (exactHash(path.join(stagingDir, file)) !== value)
        throw new Error(`Validated output ${file} changed during validation.`);
    }
    for (const [file, { actual, hash }] of captured)
      if (exactHash(actual) !== hash)
        throw new Error(
          `Validation input ${file} changed during verification.`
        );
    for (const [file, value] of Object.entries(originalHashes))
      if (exactHash(originalPath(file)) !== value)
        throw new Error(`Original input ${file} changed during verification.`);
    const finalPresent = new Set(readdirSync(stagingDir));
    const finalNames = publishableFiles(
      finalPresent,
      requiredStagedFiles(finalPresent)
    );
    if (
      finalNames.length !== names.length ||
      finalNames.some((name) => !names.includes(name))
    )
      throw new Error("The staged output set changed during verification.");
    if (sealing) {
      assertSafePath(path.join(stagingDir, VALIDATION_SEAL));
      if (record.legacyValidationSealed !== true)
        writeFileSync(
          path.join(stagingDir, STAGING_RUN_RECORD),
          `${JSON.stringify({ ...record, legacyValidationSealed: true }, null, 2)}\n`,
          "utf8"
        );
      writeFileSync(
        path.join(stagingDir, VALIDATION_SEAL),
        `${JSON.stringify({
          version: 1,
          runHash: exactHash(path.join(stagingDir, STAGING_RUN_RECORD)),
          outputs,
          inputs: inputHashes
        })}\n`,
        "utf8"
      );
    }
    return evidence;
  }

  async function publish(options) {
    if (options.signal?.aborted) {
      throw Object.assign(
        new Error("Promotion cancelled before replacement."),
        {
          code: "PROMOTION_CANCELLED"
        }
      );
    }
    assertSafePath(options.radiusDir, true);
    const radiusDir = path.resolve(options.radiusDir);
    assertSafePath(radiusDir, true);
    const requested = options.stagingDir;
    if (!requested) {
      throw new Error(
        "A staging directory is required: pass --staging <dir> naming the directory this run wrote into."
      );
    }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(requested)) {
      throw new Error(
        "The staging directory must not contain traversal segments."
      );
    }
    const stagingDir = path.resolve(requested);
    const parent = path.dirname(stagingDir);
    if (parent !== radiusDir || !isStagingDirName(path.basename(stagingDir))) {
      throw new Error(
        `The staging directory must be a ${STAGING_DIR_PREFIX}* directory directly inside ${radiusDir}. Received: ${requested}`
      );
    }
    if (!existsSync(stagingDir)) {
      throw new Error(
        `No staged modeling run at ${stagingDir}. Start a run with --begin, write into the directory it prints, and pass that directory here.`
      );
    }

    if (!isRealDirectory(stagingDir)) {
      throw new Error(
        `The staged modeling run at ${stagingDir} is not a real directory, so it was not published.`
      );
    }

    assertSafePath(stagingDir, true);
    const record = options.record ?? readRunRecord(stagingDir);
    const refuse = (message) => {
      throw new Error(message);
    };
    // Checked before anything else: without the record there is no evidence of
    // what `.radius/` held when the run started, and a publish that cannot see
    // that cannot promise not to destroy it.
    if (!record) {
      refuse(
        "This staged modeling run carries no record of the state it started from, so publishing it could overwrite work without being able to tell. Start modeling runs with promote-app-model.mjs --begin."
      );
    }
    if (
      !record.baseline ||
      typeof record.baseline !== "object" ||
      Array.isArray(record.baseline) ||
      Object.keys(record.baseline).some(
        (file) => /[\\/:]/u.test(file) || /[. ]$/u.test(file)
      ) ||
      Object.values(record.baseline).some(
        (value) => value !== "unreadable" && !isFingerprint(value)
      )
    )
      refuse(
        "The run has an unsafe managed-file baseline. Nothing was published."
      );

    const present = new Set(
      readdirSync(stagingDir, { withFileTypes: true }).map(
        (entry) => entry.name
      )
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
      refuse(
        "The staged application model is empty, so nothing was published."
      );
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
    const evidence =
      options.verifyValidation ? await verifyStagedRun(options) : undefined;
    const validated =
      evidence?.outputs ?? options.validatedOutputs ?? record.validatedOutputs;
    if (
      !validated ||
      Object.keys(validated).length !== files.length ||
      files.some(
        (file) =>
          typeof validated[file] !== "string" ||
          !validated[file] ||
          exactHash(path.join(stagingDir, file)) !== validated[file]
      )
    )
      refuse(
        "The staged output bytes do not match a complete successful validation record. Nothing was published."
      );
    const root = repositoryRoot(radiusDir);
    const originalInputs = record.inputFiles;
    const originalSnapshot = record.sourceBaseline;
    if (
      !originalSnapshot ||
      typeof originalSnapshot !== "object" ||
      Array.isArray(originalSnapshot) ||
      !Array.isArray(originalInputs) ||
      originalInputs.some(
        (file) =>
          typeof file !== "string" ||
          !Object.prototype.hasOwnProperty.call(originalSnapshot, file) ||
          !isFingerprint(originalSnapshot[file])
      )
    )
      refuse(
        "The run has no complete original effective-input baseline. Nothing was published."
      );
    const checkInputs = (published = new Set()) => {
      const paths = new Set([
        ...originalInputs,
        ...(evidence?.originalInputs ?? []),
        ...Object.keys(evidence?.inputHashes ?? {}),
        ...effectiveInputs(root, radiusDir),
        ...effectiveInputs(root, radiusDir, stagingDir)
      ]);
      for (const file of paths) {
        const input = path.resolve(root, file);
        const relative = path.relative(root, input);
        if (
          path.isAbsolute(file) ||
          path.win32.isAbsolute(file) ||
          file.includes("\\") ||
          file.includes(":") ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`)
        )
          refuse(`Unsafe effective input path: ${file}`);
        const current = exactHash(input);
        const expected =
          published.has(input) ?
            validated[path.basename(input)]
          : (originalSnapshot[file] ?? null);
        if (expected !== current) {
          refuse(
            `Effective input ${file} changed while modeling was running; your files are intact.`
          );
        }
      }
    };
    checkInputs();
    await options.checkInputs?.();
    if (options.signal?.aborted) {
      throw Object.assign(
        new Error("Promotion cancelled before replacement."),
        {
          code: "PROMOTION_CANCELLED"
        }
      );
    }
    checkInputs();
    for (const file of files) {
      if (exactHash(path.join(stagingDir, file)) !== validated[file]) {
        refuse(`The validated output ${file} changed before replacement.`);
      }
    }
    exactHash(path.join(radiusDir, ".gitignore"));
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
      assertSafePath(destination);
      const backup = path.join(stagingDir, `${file}.published-backup`);
      assertSafePath(backup);
      if (existsSync(backup)) {
        throw Object.assign(
          new Error(
            `Recovery path already exists for ${file}; staging was retained and nothing was published.`
          ),
          { retainStaging: true }
        );
      }
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
    const promotedFiles = new Set();
    const rename = renameSync;
    const remove = rmSync;
    try {
      for (const file of files) {
        await options.checkInputs?.([...promotedFiles]);
        checkInputs(promotedFiles);
        for (const pending of files) {
          const destination = path.join(radiusDir, pending);
          const published = promotedFiles.has(destination);
          if (
            !published &&
            exactHash(path.join(stagingDir, pending)) !== validated[pending]
          ) {
            throw new Error(
              `The validated output ${pending} changed before replacement.`
            );
          }
          const expected =
            published ? validated[pending] : (record.baseline[pending] ?? null);
          if (exactHash(destination) !== expected) {
            throw new Error(
              `The destination ${pending} changed before replacement.`
            );
          }
        }
        const destination = path.join(radiusDir, file);
        const existed = existsSync(destination);
        const backup =
          existed ? path.join(stagingDir, `${file}.published-backup`) : null;
        assertSafePath(destination);
        assertSafePath(path.join(stagingDir, file));
        if (backup) {
          assertSafePath(backup);
          if (existsSync(backup)) {
            throw new Error(`Recovery path already exists for ${file}.`);
          }
        }
        if (exactHash(path.join(stagingDir, file)) !== validated[file]) {
          throw new Error(
            `The validated output ${file} changed before replacement.`
          );
        }
        if (options.signal?.aborted)
          throw Object.assign(
            new Error("Promotion cancelled during replacement."),
            {
              code: "PROMOTION_CANCELLED"
            }
          );
        if (existed) rename(destination, backup);
        const entry = { destination, backup, published: false };
        moves.push(entry);
        rename(path.join(stagingDir, file), destination);
        entry.published = true;
        promotedFiles.add(destination);
      }
      checkInputs(promotedFiles);
      for (const file of files) {
        if (exactHash(path.join(radiusDir, file)) !== validated[file]) {
          throw new Error(
            `The published output ${file} changed during replacement.`
          );
        }
      }
      if (options.signal?.aborted)
        throw Object.assign(
          new Error("Promotion cancelled during replacement."),
          { code: "PROMOTION_CANCELLED" }
        );
    } catch (error) {
      const rollbackErrors = [];
      for (const entry of moves.reverse()) {
        // Remove what this run put there, then restore what it displaced. A
        // destination with no backup simply did not exist before, so removing it
        // is the whole of the undo.
        try {
          if (entry.published) {
            const file = path.basename(entry.destination);
            if (exactHash(entry.destination) !== validated[file]) {
              throw new Error(
                `Concurrent edit at ${entry.destination}; preserved it and its backup.`,
                { cause: error }
              );
            }
            remove(entry.destination, { force: true });
          }
          if (entry.backup) {
            if (exactHash(entry.destination) !== null) {
              throw new Error(
                `Concurrent edit at ${entry.destination}; preserved it and its backup.`,
                { cause: error }
              );
            }
            rename(entry.backup, entry.destination);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError.message);
        }
      }
      throw Object.assign(
        new Error(
          `Publishing the application model failed partway (${error.message}). ${
            rollbackErrors.length ?
              `Rollback failed: ${rollbackErrors.join("; ")}. Recovery files were retained.`
            : "Every file was put back as it was."
          }`,
          { cause: error }
        ),
        {
          rollback: rollbackErrors.length ? "failed" : "restored",
          code: rollbackErrors.length ? "PROMOTION_ROLLBACK_FAILED" : error.code
        }
      );
    }
    let wroteIgnore;
    try {
      remove(stagingDir, { recursive: true, force: true });
      assertSafePath(path.join(radiusDir, ".gitignore"));
      wroteIgnore = ensureStagingIgnored(radiusDir);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Application files were published, but finalization failed: ${error.message}. Files were not staged in git.`,
          { cause: error }
        ),
        { published: true }
      );
    }

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
    const gitError =
      options.stageInGit === false ? "" : gitAdd(repoRoot, staged);
    return { status: "promoted", files: published, gitError };
  }

  /**
   * Supply validation-owned hashes, never hashes recomputed merely to authorize
   * publication. Adapters can pass their private record instead of agent-writable
   * run.json. sourceBaseline/inputFiles use repository-relative slash paths;
   * baseline/validatedOutputs use output names. Consumed runs refuse without
   * writing; operation replay belongs to the caller. Failed rollback and
   * retainStaging errors preserve recovery files.
   *
   * @param {{
   *   radiusDir: string,
   *   stagingDir: string,
   *   record?: {
   *     baseline: Readonly<Record<string, string | null>>,
   *     sourceBaseline: Readonly<Record<string, string | null>>,
   *     inputFiles: readonly string[],
   *     validatedOutputs?: Readonly<Record<string, string | null>>
   *   },
   *   validatedOutputs?: Readonly<Record<string, string | null>>,
   *   checkInputs?: (published?: readonly string[]) => Promise<void>,
   *   signal?: AbortSignal,
   *   stageInGit?: boolean,
   *   verifyValidation?: boolean,
   *   bicepPath?: string,
   *   radPath?: string
   * }} options
   * @returns {Promise<{status: string, files: string[], gitError: string}>}
   */
  async function promoteStagedRun(options) {
    if (
      !options ||
      typeof options.radiusDir !== "string" ||
      typeof options.stagingDir !== "string"
    )
      throw new TypeError("Promotion requires radiusDir and stagingDir paths.");
    try {
      return await publish(options);
    } catch (error) {
      const stagingDir = path.resolve(options.stagingDir);
      const radiusDir = path.resolve(options.radiusDir);
      if (
        error.rollback !== "failed" &&
        !error.published &&
        !error.retainStaging &&
        !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(options.stagingDir) &&
        path.dirname(stagingDir) === radiusDir &&
        isStagingDirName(path.basename(stagingDir))
      ) {
        try {
          assertSafePath(stagingDir, true);
          if (hasRecoveryFiles(stagingDir)) {
            error.retainStaging = true;
            error.message += " Recovery files were retained.";
          } else {
            rmSync(stagingDir, {
              recursive: true,
              force: true
            });
          }
        } catch (cleanupError) {
          error.cleanupFailed = true;
          error.message += ` Cleanup failed: ${cleanupError.message}`;
        }
      }
      if (!error.rollback && !error.published) {
        error.message +=
          "\n\nNothing was written to managed outputs or staged in git.";
      }
      throw error;
    }
  }

  // --- abort -----------------------------------------------------------------

  // Discards a run that failed partway. The skill calls this instead of deleting
  // the staging directory itself, so the ignore-file write is undone too and the
  // repository is left exactly as the run found it.
  function abortStagedRun({ radiusDir, stagingDir: requested }) {
    assertSafePath(radiusDir, true);
    radiusDir = path.resolve(radiusDir);
    assertSafePath(radiusDir, true);
    if (!requested) {
      throw new Error(
        "A staging directory is required: pass --staging <dir> naming the directory this run wrote into."
      );
    }
    const stagingDir = path.resolve(requested);
    if (
      path.dirname(stagingDir) !== radiusDir ||
      !isStagingDirName(path.basename(stagingDir))
    ) {
      throw new Error(
        `The staging directory must be a ${STAGING_DIR_PREFIX}* directory directly inside ${radiusDir}. Received: ${requested}`
      );
    }
    assertSafePath(requested, true);
    if (hasRecoveryFiles(stagingDir)) {
      throw new Error(
        "Recovery files were retained; resolve the interrupted publication before discarding this run."
      );
    }
    rmSync(stagingDir, { recursive: true, force: true });
  }

  async function runPromotionCommand(args, output) {
    try {
      const radiusDir = flag("radius-dir", args) || ".radius";
      if (args.includes("--begin")) {
        const requestedStaleAfter = flag("stale-after-ms", args);
        output.log(
          beginStagedRun({
            radiusDir,
            runId: flag("run-id", args),
            staleAfterMs:
              requestedStaleAfter ? Number(requestedStaleAfter) : undefined
          })
        );
      } else if (args.includes("--abort")) {
        abortStagedRun({ radiusDir, stagingDir: flag("staging", args) });
        output.log(
          "Discarded the staged modeling run. Nothing was written to managed outputs or staged in git."
        );
      } else if (args.includes("--seal")) {
        await verifyStagedRun(
          {
            radiusDir,
            stagingDir: flag("staging", args),
            bicepPath: flag("bicep", args),
            radPath: flag("rad", args)
          },
          true
        );
        output.log(
          "Sealed the exact validated staged outputs. Nothing was published."
        );
      } else {
        const options = {
          radiusDir,
          stagingDir: flag("staging", args),
          verifyValidation: true,
          bicepPath: flag("bicep", args),
          radPath: flag("rad", args)
        };
        const result = await promoteStagedRun(options);
        for (const file of result.files) output.log(file);
        if (result.gitError) {
          output.error(
            `Published the application model, but could not stage it with git: ${result.gitError}. Files were written but NOT staged.`
          );
          return 2;
        }
      }
      return 0;
    } catch (error) {
      output.error(error.message);
      return error.published ? 2 : 1;
    }
  }

  return {
    beginStagedRun,
    promoteStagedRun,
    abortStagedRun,
    runPromotionCommand
  };
}

/**
 * @typedef {Partial<Pick<typeof fs,
 *   "existsSync" | "lstatSync" | "mkdirSync" | "readFileSync" |
 *   "readdirSync" | "renameSync" | "rmSync" | "writeFileSync"
 * >> & {spawnSync?: typeof spawnProcessSync}} PromotionDependencies
 */

/** @param {Parameters<ReturnType<typeof createPromotionOperations>["beginStagedRun"]>[0]} options
 * @param {PromotionDependencies} dependencies */
export function beginStagedRun(options, dependencies = {}) {
  return createPromotionOperations(dependencies).beginStagedRun(options);
}

/** @param {Parameters<ReturnType<typeof createPromotionOperations>["promoteStagedRun"]>[0]} options
 * @param {PromotionDependencies} dependencies */
export function promoteStagedRun(options, dependencies = {}) {
  return createPromotionOperations(dependencies).promoteStagedRun(options);
}

/** @param {{radiusDir: string, stagingDir: string}} options
 * @param {PromotionDependencies} dependencies */
export function abortStagedRun(options, dependencies = {}) {
  return createPromotionOperations(dependencies).abortStagedRun(options);
}

/** @param {string[]} args
 * @param {Pick<Console, "log" | "error">} output
 * @param {PromotionDependencies} dependencies */
export function runPromotionCommand(args, output = console, dependencies = {}) {
  return createPromotionOperations(dependencies).runPromotionCommand(
    args,
    output
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = await runPromotionCommand(process.argv.slice(2));
}
