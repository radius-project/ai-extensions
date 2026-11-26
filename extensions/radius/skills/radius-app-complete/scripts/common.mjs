// Helpers that the Radius modeling scripts share: running tools, finding Bicep
// and the Radius CLI, writing bicepconfig.json, the origin record, and the
// staged run that publishes a model. Each skill ships an identical copy.
// Node.js 18 or later.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.platform === "win32" ? ".exe" : "";
// Where the Radius extension for the Copilot app keeps the rad and Bicep
// binaries that it manages. Other agents have no copy there.
const MANAGED_BIN = path.join(os.homedir(), ".radius", "ai-extensions", "bin");

/** Runs a command and returns its exit status and output. Never throws. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
    ...options
  });

  return {
    status: result.error ? -1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? "")
  };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);

    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * The Radius CLI to use: $RADIUS_RAD_BINARY, the copy that the Radius
 * extension manages, or `rad` on PATH.
 */
export function findRad() {
  return (
    [process.env.RADIUS_RAD_BINARY, path.join(MANAGED_BIN, `rad${EXE}`)].find(
      (file) => file && isExecutable(file)
    ) ?? "rad"
  );
}

/**
 * The Bicep CLI to use: $BICEP, the copy that the Radius extension manages,
 * the copy that `rad bicep download` writes, or `bicep` on PATH. When none
 * exists, downloads one with rad. Returns undefined when that fails.
 */
export function findBicep() {
  const downloaded = path.join(os.homedir(), ".rad", "bin", `bicep${EXE}`);
  const found = [
    process.env.BICEP,
    path.join(MANAGED_BIN, `bicep${EXE}`),
    downloaded
  ].find((file) => file && isExecutable(file));

  if (found) return found;

  if (run("bicep", ["--version"]).status === 0) return "bicep";

  run(findRad(), ["bicep", "download"]);

  return isExecutable(downloaded) ? downloaded : undefined;
}

/** The installed rad release as "major.minor", such as "0.62", or undefined. */
function radRelease() {
  const result = run(findRad(), ["version", "--cli", "-o", "json"]);

  try {
    const json = JSON.parse(result.stdout);
    // `--cli` prints the release at the top level; without it, under `cli`.
    const release = json?.release ?? json?.cli?.release;

    return /^\d+\.\d+/.exec(String(release))?.[0];
  } catch {
    return undefined;
  }
}

/** The release commit that the installed rad reports, or undefined. */
export function radCommit() {
  try {
    const version = JSON.parse(
      run(findRad(), ["version", "--cli", "-o", "json"]).stdout || "{}"
    );
    const commit = version.commit ?? version.cli?.commit;

    return /^[0-9a-f]{40}$/.test(String(commit)) ? commit : undefined;
  } catch {
    return undefined;
  }
}

const RADIUS_PIN = /^br:biceptypes\.azurecr\.io\/radius:(\d+(?:\.\d+)*)$/;

/** Whether release `a`, such as "0.62", is newer than release `b`. */
function isNewer(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);

  for (let i = 0; i < Math.max(x.length, y.length); i += 1)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);

  return false;
}

/** The radius extension of the installed rad release, or undefined. */
export function radiusExtensionRef() {
  const release = radRelease();

  return release && `br:biceptypes.azurecr.io/radius:${release}`;
}

/**
 * Makes sure `dir/bicepconfig.json` loads the radius extension of the
 * installed rad release. Writes the file when it is missing, and moves an
 * older release pin forward; it never moves a pin back and leaves any other
 * reference, such as `latest`, alone. Returns a note when it writes, and
 * throws when the file is missing and no rad is installed.
 */
export function ensureBicepConfig(dir) {
  const file = path.join(dir, "bicepconfig.json");
  const ref = radiusExtensionRef();

  if (fs.existsSync(file)) {
    let config;

    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    const pinned = RADIUS_PIN.exec(String(config?.extensions?.radius))?.[1];
    const release = RADIUS_PIN.exec(String(ref))?.[1];

    if (!pinned || !release || !isNewer(release, pinned)) return undefined;
    config.extensions.radius = ref;
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

    return `Moved the radius extension in ${file} from ${pinned} to ${release}, the installed Radius release.`;
  }

  if (!ref)
    throw new Error(
      `${file} is missing, and no Radius CLI was found, so the radius extension version is unknown. Install the Radius CLI, or write bicepconfig.json yourself.`
    );
  const config = {
    experimentalFeaturesEnabled: { extensibility: true },
    extensions: { radius: ref }
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

  return `Wrote ${file} for the ${ref} extension.`;
}

/**
 * Compiles `dir/custom-types.yaml`, the schema of the app's custom resource
 * types, into the local Bicep extension `dir/custom-types.tgz`, and points the
 * `customTypes` extension in bicepconfig.json at it. When the schema does not
 * exist, removes both. Returns a problem, or undefined.
 */
export function buildCustomTypes(dir) {
  const schema = path.join(dir, "custom-types.yaml");
  const extension = path.join(dir, "custom-types.tgz");
  const configFile = path.join(dir, "bicepconfig.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const alias = "./custom-types.tgz";
  const exists = fs.existsSync(schema);

  if (exists) {
    const built = run(
      findRad(),
      [
        "bicep",
        "publish-extension",
        "--from-file",
        schema,
        "--target",
        extension,
        "--force"
      ],
      { cwd: dir }
    );

    if (built.status !== 0)
      return `custom-types.yaml does not compile into a Bicep extension: ${(built.stderr || built.stdout).trim()} Fix: correct custom-types.yaml.`;
  } else fs.rmSync(extension, { force: true });

  if (exists !== (config.extensions?.customTypes === alias)) {
    config.extensions = { ...config.extensions, customTypes: alias };
    if (!exists) delete config.extensions.customTypes;
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }

  return undefined;
}

/** The hash that the origin record keeps of a model. Tools compare it to tell whether the model changed. */
export function hashModel(text) {
  const normalized = text
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();

  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/** The Radius version that bicepconfig.json in `dir` pins, or "" when it pins none. */
function pinnedRadiusVersion(dir) {
  try {
    const pin = JSON.parse(
      fs.readFileSync(path.join(dir, "bicepconfig.json"), "utf8")
    )?.extensions?.radius;

    return (
      /^br:biceptypes\.azurecr\.io\/radius:([0-9A-Za-z][0-9A-Za-z._-]*)$/.exec(
        String(pin).trim()
      )?.[1] ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * Writes `app.origin.json` beside the model after a stage's check passes. It
 * records the source commit, the Radius version that bicepconfig.json pins,
 * the hash of the model, and the stage, so a tool such as the Radius canvas
 * can tell a current model from a stale or hand-edited one.
 *
 * `start` is the model that a later stage began from. When the existing record
 * describes that model, its source commit is kept: the model still comes from
 * that commit. Returns a note for the check's output.
 */
export function writeOrigin(file, { stage, provider, start } = {}) {
  const dir = path.dirname(file);
  const target = path.join(dir, "app.origin.json");
  let previous;

  try {
    previous = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    previous = undefined;
  }
  const keep =
    start !== undefined &&
    typeof previous?.sourceCommit === "string" &&
    previous.appBicepHash === hashModel(start);
  const head = run("git", ["-C", dir, "rev-parse", "HEAD"]);
  const sourceCommit =
    keep ? previous.sourceCommit
    : head.status === 0 ? head.stdout.trim()
    : "";

  if (!sourceCommit)
    return `${target} was not written, because ${dir} is not in a git checkout with a commit.`;
  const origin = {
    generatedAt: new Date().toISOString(),
    sourceCommit,
    radiusVersion: pinnedRadiusVersion(dir),
    appBicepHash: hashModel(fs.readFileSync(file, "utf8")),
    stage,
    ...((provider ?? previous?.provider) ?
      { provider: provider ?? previous.provider }
    : {})
  };
  fs.writeFileSync(target, `${JSON.stringify(origin, null, 2)}\n`);

  return `Recorded the source commit and the ${stage} stage in app.origin.json.`;
}

// A stage never writes into .radius/ directly. `begin` copies the published
// files into a staging directory, the agent edits the copy, and a passing check
// moves the files into .radius/. A run that fails or stops leaves .radius/ as
// it was. The Radius canvas reads `.radius/.staging-*` as a run in progress.
const STAGING_PREFIX = ".staging-";
const PUBLISHED = [
  "app.bicep",
  "bicepconfig.json",
  "app.origin.json",
  "custom-types.yaml",
  "custom-types.tgz",
  "custom-recipe-pack.bicep"
];

/** Whether a file in .radius/ belongs to the published model. */
function isPublished(name) {
  return PUBLISHED.includes(name) || /^[A-Za-z0-9-]+-recipe\.bicep$/.test(name);
}

function fileHashes(dir) {
  const hashes = {};

  for (const name of fs.readdirSync(dir).filter(isPublished).sort())
    hashes[name] = createHash("sha256")
      .update(fs.readFileSync(path.join(dir, name)))
      .digest("hex");

  return hashes;
}

/**
 * Starts a run: makes `.radius/.staging-<id>/` with a copy of the published
 * files, and `start.bicep`, the model that the run starts from. Returns the
 * staging directory.
 */
export function beginRun(radiusDir = path.resolve(".radius")) {
  fs.mkdirSync(radiusDir, { recursive: true });
  const dir = path.join(radiusDir, `${STAGING_PREFIX}${randomUUID()}`);

  fs.mkdirSync(dir);
  // Hides the run from git from the start, so a stopped run is never committed.
  fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
  const baseline = fileHashes(radiusDir);

  for (const name of Object.keys(baseline))
    fs.copyFileSync(path.join(radiusDir, name), path.join(dir, name));

  if (baseline["app.bicep"])
    fs.copyFileSync(path.join(dir, "app.bicep"), path.join(dir, "start.bicep"));
  fs.writeFileSync(
    path.join(dir, "run.json"),
    `${JSON.stringify({ version: 1, startedAt: new Date().toISOString(), baseline }, null, 2)}\n`
  );

  return dir;
}

/**
 * The staging directory that `arg` names, or undefined when it is not one that
 * `beginRun` made.
 */
export function runDir(arg) {
  const dir = path.resolve(
    arg && path.basename(arg) === "app.bicep" ? path.dirname(arg) : (arg ?? "")
  );

  return (
      path.basename(dir).startsWith(STAGING_PREFIX) &&
        fs.existsSync(path.join(dir, "run.json"))
    ) ?
      dir
    : undefined;
}

/** Deletes a run and writes nothing. */
export function abortRun(dir) {
  fs.rmSync(dir, { recursive: true, force: true });

  return `Deleted ${dir}. Nothing was written: .radius/ is as it was before the run.`;
}

/**
 * Moves the run's files into .radius/, removes the published files that the
 * run deleted, deletes the run, and stages the files in git. Refuses, and
 * deletes the run, when a published file changed after `begin`. When a move
 * fails, puts every file back, keeps the run, and refuses. Returns
 * `{ ok, published, message }`.
 *
 * A tool that starts a run itself, such as the Radius canvas, names it
 * `.staging-managed-<id>` and publishes it itself. This function then changes
 * nothing. The name decides, because an agent can edit the run's files.
 */
export function publishRun(dir) {
  const radiusDir = path.dirname(dir);

  if (path.basename(dir).toLowerCase().startsWith(`${STAGING_PREFIX}managed-`))
    return {
      ok: true,
      published: false,
      message: `Did not publish ${dir}, because the tool that started the run publishes it.`
    };
  const { baseline } = JSON.parse(
    fs.readFileSync(path.join(dir, "run.json"), "utf8")
  );
  const now = fileHashes(radiusDir);
  const changed = [
    ...new Set([...Object.keys(baseline), ...Object.keys(now)])
  ].filter((name) => baseline[name] !== now[name]);

  if (changed.length > 0) {
    abortRun(dir);

    return {
      ok: false,
      published: false,
      message: `${changed.map((name) => `.radius/${name}`).join(", ")} changed while this run was working, so the run was deleted and nothing was written. Edit only the files in the staging directory. Next: run begin again.`
    };
  }
  const staged = fs.readdirSync(dir).filter(isPublished);
  const deleted = Object.keys(baseline).filter((n) => !staged.includes(n));
  // The published files that the run replaces or deletes wait here, so that a
  // failed move can put them back.
  const previous = path.join(dir, ".previous");
  const moves = [];

  const move = (from, to) => {
    fs.renameSync(from, to);
    moves.push([from, to]);
  };

  fs.mkdirSync(previous, { recursive: true });

  try {
    for (const name of [...staged, ...deleted]) {
      const target = path.join(radiusDir, name);

      if (fs.existsSync(target)) move(target, path.join(previous, name));

      if (staged.includes(name)) move(path.join(dir, name), target);
    }
  } catch (error) {
    const stuck = [];

    for (const [from, to] of moves.reverse())
      try {
        fs.renameSync(to, from);
      } catch {
        stuck.push(from);
      }

    return {
      ok: false,
      published: false,
      message:
        stuck.length === 0 ?
          `Could not publish into ${radiusDir}: ${error.message} Nothing was written: .radius/ is as it was. Fix the cause, then run check again with the same staging directory.`
        : `Could not publish into ${radiusDir}: ${error.message} These files could not be put back: ${stuck.join(", ")}. Their previous versions are in ${previous}.`
    };
  }
  const ignore = path.join(radiusDir, ".gitignore");
  const rules = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const ignoreRule = `${STAGING_PREFIX}*/`;
  const addRule = !rules.split(/\r?\n/).includes(ignoreRule);

  if (addRule)
    fs.writeFileSync(
      ignore,
      `${rules}${rules && !rules.endsWith("\n") ? "\n" : ""}${ignoreRule}\n`
    );
  abortRun(dir);
  // -f, because the model needs every file even when the repository ignores
  // its kind, such as *.tgz.
  const added = run("git", [
    "-C",
    radiusDir,
    "add",
    "-f",
    "--",
    ...(addRule ? [".gitignore"] : []),
    ...staged
  ]);

  if (deleted.length > 0)
    run("git", [
      "-C",
      radiusDir,
      "rm",
      "-q",
      "--cached",
      "--ignore-unmatch",
      "--",
      ...deleted
    ]);

  return {
    ok: true,
    published: true,
    message: `Published ${staged.join(", ")} in ${radiusDir}${added.status === 0 ? " and staged them in git" : `, but git did not stage them: ${(added.stderr || added.stdout).trim()}`}.`
  };
}
