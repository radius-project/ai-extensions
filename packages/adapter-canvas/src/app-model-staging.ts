// Managed modeling runs: runs that the canvas starts, hands to the agent, and
// publishes itself only while the request that owns the run is still current.
//
// A managed run has the layout of a modeling skill's staged run (see
// `beginRun` in extensions/radius/skills/radius-app-*/scripts/common.mjs), so
// the agent runs the stage's own `check` on it. The skills' `publishRun` never
// publishes a directory named `.staging-managed-*`, so that check validates the
// run and writes its origin record but does not publish it. Only `promote`
// publishes a managed run.
//
// The baseline stays in memory: an edit to the staged `run.json` cannot hide a
// concurrent edit to `.radius/`. Final validation runs the check again on a
// private copy, and `promote` moves that copy into place. Each move is a rename
// inside `.radius/`, and a failed move puts every file back.

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
import { STAGING_DIR_PREFIX } from "@radius-project/core";
import { REQUIRED_STAGED_FILES } from "@radius-project/core/modeling";
import { hashAppBicep } from "./app-bicep-hash.js";
import { errorMessage } from "./runtime/util.js";

const execFileAsync = promisify(execFile);

const MANAGED_RUN_PREFIX = `${STAGING_DIR_PREFIX}managed-`;
const STAGING_IGNORE_PATTERN = `${STAGING_DIR_PREFIX}*/`;
const BACKUP_SUFFIX = ".published-backup";
// The files that `check` writes into the run. Validation lets these change on
// the copy, and requires every other file to stay as staged.
const CHECK_OUTPUTS = new Set([
  "app.origin.json",
  "bicepconfig.json",
  "custom-types.tgz"
]);
// The files that a staged run publishes. The skills' scripts use the same list
// (`PUBLISHED` in common.mjs).
const PUBLISHED_FILES = new Set([
  ...REQUIRED_STAGED_FILES,
  "custom-types.yaml",
  "custom-types.tgz",
  "custom-recipe-pack.bicep"
]);

function isPublishedModelFile(name: string): boolean {
  return (
    PUBLISHED_FILES.has(name) || /^[A-Za-z0-9-]+-recipe\.bicep$/u.test(name)
  );
}

export function isManagedRun(stagingPath: string): boolean {
  return path
    .basename(stagingPath)
    .toLowerCase()
    .startsWith(MANAGED_RUN_PREFIX);
}

export interface ObservedModelFile {
  path:
    | "app.bicep"
    | "app.origin.json"
    | ".radius/app.bicep"
    | ".radius/app.origin.json";
  hash: string | null;
}

export interface CommittedModelIdentity {
  definitionHash: string;
  originHash: string;
}

export interface PromotionGitPorts {
  discoverRepositoryRoot(radiusDir: string): Promise<string>;
  stageFiles(
    repoRoot: string,
    files: readonly string[],
    removed: readonly string[]
  ): Promise<void>;
}

export interface ManagedModelStaging {
  readonly stagingDir: string;
  assertBaseline(): void;
  cancel(): void;
  validate(
    check: (stagingDir: string) => Promise<void>,
    isExitUnconfirmed?: (error: unknown) => boolean
  ): Promise<void>;
  promote(
    prepareCommit: () => Promise<void>,
    beforeCommit: () => void,
    options?: {
      gitPorts?: PromotionGitPorts;
      onFilesystemCommitted?: (identity: CommittedModelIdentity) => void;
    }
  ): Promise<{ published: string[]; gitError: string }>;
}

// A refusal after which the copy may hold the only backups of published files.
class PromotionRecoveryRequired extends Error {}

function fail(message: string): never {
  throw new Error(message);
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// Reads a regular file without following a symlink. Returns null when nothing
// is there, and throws when the entry cannot be read or is not a regular file,
// so an unreadable file is never mistaken for an absent one.
function readStableRegularFile(
  file: string
): { bytes: Buffer; mode: number } | null {
  let fd: number;
  try {
    // Windows has no O_NOFOLLOW or O_NONBLOCK, and a bitwise OR reads the
    // missing constant as 0.
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    // Without O_NOFOLLOW, a dangling link can also fail with ENOENT.
    if (
      Reflect.get(Object(error), "code") === "ENOENT" &&
      !lstatSync(file, { throwIfNoEntry: false })
    ) {
      return null;
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const entry = lstatSync(file, { bigint: true, throwIfNoEntry: false });
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

// The published files in `dir`, sorted by name.
function readPublished(dir: string): [string, Buffer][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isPublishedModelFile)
    .sort()
    .flatMap((name): [string, Buffer][] => {
      const file = readStableRegularFile(path.join(dir, name));
      return file ? [[name, file.bytes]] : [];
    });
}

function hashes(files: readonly [string, Buffer][]): Map<string, string> {
  return new Map(files.map(([name, bytes]) => [name, sha256(bytes)]));
}

function digest(files: readonly [string, Buffer][]): string {
  return JSON.stringify([...hashes(files)]);
}

function isRealDirectory(target: string): boolean {
  return !!lstatSync(target, { throwIfNoEntry: false })?.isDirectory();
}

function directoryIdentity(target: string): string | null {
  const entry = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  return entry?.isDirectory() ? `${entry.dev}:${entry.ino}` : null;
}

// Adds the staging ignore rule to `.radius/.gitignore` when a run publishes, as
// the skills' scripts do. Returns true when it wrote the file, so only a rule
// that this run added is staged in git.
function ensureStagingIgnored(radiusDir: string, workDir: string): boolean {
  const ignoreFile = path.join(radiusDir, ".gitignore");
  const existing = readStableRegularFile(ignoreFile);
  const text = existing?.bytes.toString("utf8") ?? "";
  if (text.split("\n").some((line) => line.trim() === STAGING_IGNORE_PATTERN))
    return false;
  const body = text && !text.endsWith("\n") ? `${text}\n` : text;
  const pending = path.join(workDir, ".radius-gitignore.pending");
  const fd = openSync(pending, "wx", existing ? 0o600 : undefined);
  try {
    writeFileSync(fd, `${body}${STAGING_IGNORE_PATTERN}\n`, "utf8");
    // Creation applies the process umask, so restore the original mode.
    if (existing) fchmodSync(fd, existing.mode & 0o7777);
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
} as const;

const git: PromotionGitPorts = {
  async discoverRepositoryRoot(radiusDir) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", radiusDir, "rev-parse", "--show-toplevel"],
      gitOptions
    );
    return stdout.trim();
  },
  // -f, because the model needs every file even when the repository ignores
  // its kind, such as *.tgz.
  async stageFiles(repoRoot, files, removed) {
    await execFileAsync(
      "git",
      ["-C", repoRoot, "add", "-f", "--", ...files],
      gitOptions
    );
    if (removed.length > 0) {
      await execFileAsync(
        "git",
        [
          "-C",
          repoRoot,
          "rm",
          "-q",
          "--cached",
          "--ignore-unmatch",
          "--",
          ...removed
        ],
        gitOptions
      );
    }
  }
};

function gitDiagnostic(error: unknown): string {
  const stderr: unknown = Reflect.get(Object(error), "stderr");
  return typeof stderr === "string" && stderr.trim() ?
      stderr.trim()
    : errorMessage(error);
}

// The model hash in an origin record, or undefined when it has none.
function recordedModelHash(origin: Buffer): unknown {
  try {
    return Reflect.get(
      Object(JSON.parse(origin.toString("utf8"))),
      "appBicepHash"
    );
  } catch {
    return undefined;
  }
}

// Moves the checked copy's published files into `.radius/` and removes the
// published files that the run deleted. When a move fails, puts every file
// back; when that also fails, keeps the backups in the copy.
function commitPromotion(
  radiusDir: string,
  copyDir: string,
  files: readonly string[],
  baseline: ReadonlyMap<string, string>
) {
  const removed = [...baseline.keys()].filter((name) => !files.includes(name));
  const moves: {
    destination: string;
    backup: string | null;
    published: boolean;
  }[] = [];
  let wroteIgnore = false;
  try {
    for (const name of [...files, ...removed]) {
      const destination = path.join(radiusDir, name);
      const backup =
        existsSync(destination) ?
          path.join(copyDir, `${name}${BACKUP_SUFFIX}`)
        : null;
      if (backup) renameSync(destination, backup);
      const entry = { destination, backup, published: false };
      moves.push(entry);
      if (files.includes(name)) {
        renameSync(path.join(copyDir, name), destination);
        entry.published = true;
      }
    }
    wroteIgnore = ensureStagingIgnored(radiusDir, copyDir);
  } catch (error) {
    const rollbackErrors: Error[] = [];
    for (const entry of moves.reverse()) {
      try {
        if (entry.published) rmSync(entry.destination, { force: true });
        if (entry.backup) renameSync(entry.backup, entry.destination);
      } catch (rollbackError) {
        rollbackErrors.push(
          new Error(`${entry.destination}: ${errorMessage(rollbackError)}`, {
            cause: rollbackError
          })
        );
      }
    }
    const message = errorMessage(error);
    if (rollbackErrors.length > 0) {
      throw new PromotionRecoveryRequired(
        `Publishing the application model failed (${message}) and rollback was incomplete: ${rollbackErrors.map(({ message }) => message).join("; ")}. Recovery files remain at ${copyDir}. Review and restore the backups before retrying modeling.`,
        {
          cause: new AggregateError(rollbackErrors, "Model rollback failed", {
            cause: error
          })
        }
      );
    }
    fail(
      `Publishing the application model failed partway (${message}), so every file was put back as it was. Nothing was written: .radius/ is as it was.`
    );
  }
  const published = files.map((name) => path.join(radiusDir, name));
  return {
    published,
    staged:
      wroteIgnore ?
        [...published, path.join(radiusDir, ".gitignore")]
      : published,
    removed: removed.map((name) => path.join(radiusDir, name))
  };
}

// Starts a managed run in `.radius/.staging-managed-<id>/`. `observed` holds
// the model files and hashes that the canvas read before it decided to start
// the run; the run refuses to start or publish when one of them changed.
export function beginManagedRun(
  workspaceRoot: string,
  observed: readonly ObservedModelFile[] = []
): ManagedModelStaging {
  const root = realpathSync(workspaceRoot);
  const radiusDir = path.join(root, ".radius");
  if (
    lstatSync(radiusDir, { throwIfNoEntry: false }) &&
    !isRealDirectory(radiusDir)
  ) {
    fail(`Managed modeling requires a real .radius directory in ${root}.`);
  }
  function assertObservedBaseline() {
    for (const { path: relative, hash } of observed) {
      const file = readStableRegularFile(path.join(root, relative));
      if ((file ? sha256(file.bytes) : null) !== hash) {
        fail(`Managed model files changed while modeling: ${relative}.`);
      }
    }
  }
  assertObservedBaseline();

  let start: [string, Buffer][];
  try {
    start = readPublished(radiusDir);
  } catch (error) {
    throw new Error(
      `Cannot read the published model in ${radiusDir}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  const baseline = hashes(start);
  const startModel = start.find(([name]) => name === "app.bicep")?.[1];
  const record = `${JSON.stringify(
    {
      version: 1,
      startedAt: new Date().toISOString(),
      baseline: Object.fromEntries(baseline)
    },
    null,
    2
  )}\n`;
  // Writes the bookkeeping of a run, so the stage's check accepts `dir`.
  function writeRun(dir: string, files: readonly [string, Buffer][]) {
    // Hides the run from git before it holds any model file.
    writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx" });
    writeFileSync(path.join(dir, "run.json"), record, { flag: "wx" });
    if (startModel)
      writeFileSync(path.join(dir, "start.bicep"), startModel, { flag: "wx" });
    for (const [name, bytes] of files)
      writeFileSync(path.join(dir, name), bytes, { flag: "wx" });
  }

  mkdirSync(radiusDir, { recursive: true });
  const stagingDir = path.join(
    radiusDir,
    `${MANAGED_RUN_PREFIX}${randomUUID()}`
  );
  mkdirSync(stagingDir);
  try {
    writeRun(stagingDir, start);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  const radiusIdentity = directoryIdentity(radiusDir);
  const stagingIdentity = directoryIdentity(stagingDir);
  let finished = false;
  let validating = false;
  let validated:
    | {
        dir: string;
        identity: string | null;
        staged: string;
        checked: string;
        files: string[];
        committed: CommittedModelIdentity;
      }
    | undefined;

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

  function assertBaseline() {
    assertActive();
    assertObservedBaseline();
    let current: Map<string, string>;
    try {
      current = hashes(readPublished(radiusDir));
    } catch (error) {
      throw new Error(
        `Cannot verify the managed model baseline: ${errorMessage(error)}`,
        { cause: error }
      );
    }
    const changed = [...new Set([...baseline.keys(), ...current.keys()])]
      .filter((name) => baseline.get(name) !== current.get(name))
      .sort();
    if (changed.length > 0) {
      fail(
        `Managed model files changed while modeling: ${changed.join(", ")}.`
      );
    }
  }

  function removeDir(dir: string, identity: string | null) {
    if (identity && directoryIdentity(dir) === identity) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    stagingDir,
    assertBaseline,
    cancel() {
      finished = true;
      if (validated) removeDir(validated.dir, validated.identity);
    },
    async validate(check, isExitUnconfirmed) {
      assertActive();
      if (validating || validated)
        fail("This run has already started final validation.");
      const staged = readPublished(stagingDir);
      if (!staged.some(([name]) => name === "app.bicep")) {
        fail(
          `The managed modeling run has no model at ${path.join(stagingDir, "app.bicep")}.`
        );
      }
      const dir = path.join(
        radiusDir,
        `${MANAGED_RUN_PREFIX}validation-${randomUUID()}`
      );
      mkdirSync(dir, { mode: 0o700 });
      const identity = directoryIdentity(dir);
      validating = true;
      let retain = false;
      try {
        // The copy gets the run's own bookkeeping, not the staged copy of it.
        writeRun(dir, staged);
        await check(dir);
        assertActive();
        const checked = readPublished(dir);
        const inputs = (files: readonly [string, Buffer][]) =>
          digest(files.filter(([name]) => !CHECK_OUTPUTS.has(name)));
        if (
          directoryIdentity(dir) !== identity ||
          inputs(checked) !== inputs(staged) ||
          digest(readPublished(stagingDir)) !== digest(staged)
        ) {
          fail("Staged artifacts changed while Radius was validating them.");
        }
        const byName = new Map(checked);
        const missing = REQUIRED_STAGED_FILES.filter(
          (name) => !byName.has(name)
        );
        if (missing.length > 0) {
          fail(
            `The checked run is missing ${missing.join(", ")}, so nothing was published.`
          );
        }
        const definition = byName.get("app.bicep");
        const origin = byName.get("app.origin.json");
        if (
          !definition ||
          !origin ||
          recordedModelHash(origin) !==
            hashAppBicep(definition.toString("utf8"))
        ) {
          fail(
            "The origin record does not describe the checked model, so nothing was published."
          );
        }
        validated = {
          dir,
          identity,
          staged: digest(staged),
          checked: digest(checked),
          files: checked.map(([name]) => name),
          committed: {
            definitionHash: sha256(definition),
            originHash: sha256(origin)
          }
        };
      } catch (error) {
        retain = !!isExitUnconfirmed?.(error);
        if (retain) {
          throw new Error(
            `${errorMessage(error)} Validation cleanup is incomplete; the ignored copy remains at ${dir}.`,
            { cause: error }
          );
        }
        throw error;
      } finally {
        validating = false;
        if (!retain && !validated) removeDir(dir, identity);
      }
    },
    async promote(prepareCommit, beforeCommit, options = {}) {
      assertActive();
      const copy = validated;
      if (!copy)
        fail(
          "Radius cannot promote artifacts that have not passed validation."
        );
      validated = undefined;
      const gitPorts = options.gitPorts ?? git;
      let retainForRecovery = false;
      try {
        let repoRoot = "";
        let gitError = "";
        try {
          repoRoot = await gitPorts.discoverRepositoryRoot(radiusDir);
        } catch (error) {
          gitError = gitDiagnostic(error);
        }
        await prepareCommit();
        // Admission and the filesystem commit stay in one synchronous turn.
        assertActive();
        beforeCommit();
        assertBaseline();
        finished = true;
        if (
          directoryIdentity(copy.dir) !== copy.identity ||
          digest(readPublished(copy.dir)) !== copy.checked ||
          digest(readPublished(stagingDir)) !== copy.staged
        ) {
          fail("Radius cannot promote artifacts that changed afterward.");
        }
        const { published, staged, removed } = commitPromotion(
          radiusDir,
          copy.dir,
          copy.files,
          baseline
        );
        options.onFilesystemCommitted?.(copy.committed);
        for (const [dir, identity] of [
          [stagingDir, stagingIdentity],
          [copy.dir, copy.identity]
        ] as const) {
          try {
            removeDir(dir, identity);
          } catch (error) {
            console.error(
              `The model was written, but ${dir} could not be removed (${errorMessage(error)}).`
            );
          }
        }
        if (!gitError) {
          try {
            await gitPorts.stageFiles(repoRoot, staged, removed);
          } catch (error) {
            gitError = gitDiagnostic(error);
          }
        }
        return { published, gitError };
      } catch (error) {
        retainForRecovery = error instanceof PromotionRecoveryRequired;
        throw error;
      } finally {
        if (!retainForRecovery)
          try {
            removeDir(copy.dir, copy.identity);
          } catch (error) {
            console.error(
              `${copy.dir} could not be removed (${errorMessage(error)}).`
            );
          }
      }
    }
  };
}
