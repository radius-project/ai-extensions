// Keeps every version string in the repo derived from one source of truth.
//
// `plugins/radius/package.json` is that source: Changesets owns it (see
// docs/eng/RELEASING.md) and nothing else may be hand-edited. These files are derived:
//
//   plugins/radius/plugin.json        version                     (manifest Copilot reads)
//   .github/plugin/marketplace.json   metadata.version            (catalog version)
//   .github/plugin/marketplace.json   plugins[radius].version
//   .github/plugin/marketplace.json   plugins[radius-edge].version
//
// The catalog on main is the manifest end users add, so both plugin entries are
// derived there. An edge publish then restamps its own entry with the snapshot
// version in its throwaway workspace.
//
// Usage:
//   node scripts/version.mjs                    print the source-of-truth version
//   node scripts/version.mjs --check            fail if a derived file has drifted
//   node scripts/version.mjs --sync             rewrite derived files from the source
//   node scripts/version.mjs --set <version>    write a stable version everywhere
//   node scripts/version.mjs --set <version> --channel edge
//                                                stamp only the edge catalog entry
//   node scripts/version.mjs --release-notes    print the current changelog entry
//   node scripts/version.mjs --compare <version>
//                                                print 1, 0 or -1 for how the
//                                                source version ranks against it
//
// Only the resolved version goes to stdout, so callers can do
// `VERSION="$(node scripts/version.mjs)"`; everything else goes to stderr.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE = "plugins/radius/package.json";
const CHANGELOG = "plugins/radius/CHANGELOG.md";
const PLUGIN_NAME = "radius";
const EDGE_PLUGIN_NAME = "radius-edge";

// CI stamps prerelease versions such as 0.1.0-edge-20260807014054, so this must
// accept the full semver grammar rather than a bare MAJOR.MINOR.PATCH.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function read(file) {
  const absolute = join(repoRoot, file);
  const raw = readFileSync(absolute, "utf8");
  return { file, absolute, raw, json: JSON.parse(raw) };
}

function write(doc) {
  const trailingNewline = doc.raw.endsWith("\n") ? "\n" : "";
  writeFileSync(
    doc.absolute,
    JSON.stringify(doc.json, null, 2) + trailingNewline
  );
}

/**
 * Every place a version is written, as `{ where, get, set }` triples so `--check`
 * and `--sync` cannot disagree about the set of derived files.
 */
function targets(channel = "stable") {
  const pluginManifest = read("plugins/radius/plugin.json");
  const marketplace = read(".github/plugin/marketplace.json");

  const catalogEntry = (name) => {
    const entry = marketplace.json.plugins?.find((p) => p.name === name);
    if (!entry) fail(`no "${name}" plugin entry in ${marketplace.file}`);
    return {
      where: `${marketplace.file}#plugins[${name}].version`,
      doc: marketplace,
      get: () => entry.version,
      set: (v) => (entry.version = v)
    };
  };

  const metadata = {
    where: `${marketplace.file}#metadata.version`,
    doc: marketplace,
    get: () => marketplace.json.metadata?.version,
    set: (v) => (marketplace.json.metadata.version = v)
  };

  // An edge publish owns nothing but its own rolling catalog entry: the plugin
  // manifest and the stable entry keep the released version.
  if (channel === "edge") return [catalogEntry(EDGE_PLUGIN_NAME)];

  return [
    {
      where: `${pluginManifest.file}#version`,
      doc: pluginManifest,
      get: () => pluginManifest.json.version,
      set: (v) => (pluginManifest.json.version = v)
    },
    metadata,
    catalogEntry(PLUGIN_NAME),
    catalogEntry(EDGE_PLUGIN_NAME)
  ];
}

function sourceVersion() {
  const version = read(SOURCE).json.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    fail(
      `${SOURCE}#version is not a semver version: ${JSON.stringify(version)}`
    );
  }
  return version;
}

function releaseNotes(version) {
  let raw;
  try {
    raw = readFileSync(join(repoRoot, CHANGELOG), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${CHANGELOG} does not exist`);
    throw error;
  }

  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) fail(`${CHANGELOG} has no entry for ${version}`);

  const next = lines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line)
  );
  const notes = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  if (!notes) fail(`${CHANGELOG} has an empty entry for ${version}`);
  return notes;
}

// Semver precedence (semver.org rule 11), which shell tooling gets wrong:
// `sort -V` ranks 0.3.0-rc.0 above 0.3.0. Build metadata is ignored, as the
// specification requires.
function precedence(version) {
  const [core, prerelease] = version.split("+")[0].split(/-(.*)/s);
  return {
    core: core.split(".").map(Number),
    prerelease: prerelease ? prerelease.split(".") : []
  };
}

function compare(a, b) {
  const left = precedence(a);
  const right = precedence(b);

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) {
      return left.core[i] > right.core[i] ? 1 : -1;
    }
  }

  // A release outranks any prerelease of the same core version.
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }

  const numeric = /^\d+$/;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === r) continue;
    // A shorter set of identifiers loses when all the earlier ones matched.
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (numeric.test(l) && numeric.test(r)) return +l > +r ? 1 : -1;
    if (numeric.test(l)) return -1;
    if (numeric.test(r)) return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

function apply(version, channel) {
  const touched = new Set();
  for (const target of targets(channel)) {
    target.set(version);
    touched.add(target.doc);
  }
  for (const doc of touched) {
    write(doc);
    console.error(`updated ${doc.file} -> ${version}`);
  }
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const sync = args.includes("--sync");
const printReleaseNotes = args.includes("--release-notes");
const setIndex = args.indexOf("--set");
const explicit = setIndex === -1 ? undefined : args[setIndex + 1];
const compareIndex = args.indexOf("--compare");
const other = compareIndex === -1 ? undefined : args[compareIndex + 1];
const channelIndex = args.indexOf("--channel");
const channel = channelIndex === -1 ? "stable" : args[channelIndex + 1];

if (setIndex !== -1 && (!explicit || !SEMVER.test(explicit))) {
  fail(
    `--set requires a semver version, got ${JSON.stringify(explicit ?? "")}`
  );
}

if (compareIndex !== -1 && (!other || !SEMVER.test(other))) {
  fail(
    `--compare requires a semver version, got ${JSON.stringify(other ?? "")}`
  );
}

if (!["stable", "edge"].includes(channel)) {
  fail(
    `--channel must be "stable" or "edge", got ${JSON.stringify(channel ?? "")}`
  );
}

if (printReleaseNotes) {
  console.log(releaseNotes(sourceVersion()));
} else if (other) {
  console.log(compare(sourceVersion(), other));
} else if (explicit) {
  if (channel === "edge") {
    apply(explicit, channel);
  } else {
    const source = read(SOURCE);
    source.json.version = explicit;
    write(source);
    console.error(`updated ${SOURCE} -> ${explicit}`);
    apply(explicit);
  }
  console.log(explicit);
} else if (sync) {
  const version = sourceVersion();
  apply(version);
  console.log(version);
} else if (check) {
  const version = sourceVersion();
  const drifted = targets().filter((target) => target.get() !== version);
  if (drifted.length > 0) {
    const detail = drifted
      .map((t) => `  ${t.where} = ${JSON.stringify(t.get())}`)
      .join("\n");
    fail(
      `derived versions have drifted from ${SOURCE} (${version}):\n${detail}\n` +
        `run \`pnpm run version:sync\` to repair them.`
    );
  }
  console.error(`version ${version} is consistent across all manifests`);
  console.log(version);
} else {
  console.log(sourceVersion());
}
