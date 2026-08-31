// Keeps every version string in the repo derived from one source of truth per
// plugin.
//
// `plugins/<name>/package.json` is that source: Changesets owns it (see
// docs/eng/RELEASING.md) and nothing else may be hand-edited. These files are
// derived:
//
//   plugins/<name>/plugin.json      version                 (manifest Copilot reads)
//   .github/plugin/marketplace.json plugins[<name>].version (catalog entry)
//
// The shared marketplace metadata.version is managed independently and plugin
// version commands preserve it.
//
// The catalog on main is the manifest end users add. Each plugin entry's source
// ref selects that plugin's default channel: `<name>@edge` now, and
// `<name>@latest` after its stable launch. Edge publishes retarget and restamp
// their throwaway catalog copy so the generated edge branch remains
// independently installable after that switch.
//
// Plugins version and release independently, so every per-plugin command takes
// `--plugin <name>`; it may be omitted only while the repo ships exactly one.
//
// Usage:
//   node scripts/version.mjs [--plugin <name>]  print the source-of-truth version
//   node scripts/version.mjs --check            fail if a derived file has drifted
//   node scripts/version.mjs --sync             rewrite derived files from the sources
//   node scripts/version.mjs --set <version> [--plugin <name>]
//                                                write a stable version everywhere
//   node scripts/version.mjs --set <version> [--plugin <name>] --channel edge
//                                                retarget and stamp the generated
//                                                edge catalog entry
//   node scripts/version.mjs --release-notes [--plugin <name>]
//                                                print the current changelog entry
//   node scripts/version.mjs --compare <version> [--plugin <name>]
//                                                print 1, 0 or -1 for how the
//                                                source version ranks against it
//
// Only the resolved version goes to stdout, so callers can do
// `VERSION="$(node scripts/version.mjs)"`; everything else goes to stderr.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPlugins, repoRoot, requirePlugin } from "./plugins.mjs";

const MARKETPLACE = ".github/plugin/marketplace.json";

// CI stamps prerelease versions such as 0.1.0-edge-0b33186, so this must
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

function sourceVersion(plugin) {
  const version = read(plugin.packageFile).json.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    fail(
      `${plugin.packageFile}#version is not a semver version: ${JSON.stringify(version)}`
    );
  }
  return version;
}

function catalogEntry(marketplace, name, publishedRef) {
  const entry = marketplace.json.plugins?.find((p) => p.name === name);
  if (!entry) fail(`no "${name}" plugin entry in ${marketplace.file}`);
  if (publishedRef && (!entry.source || typeof entry.source !== "object")) {
    fail(
      `"${name}" needs an object source for a channel publish in ${marketplace.file}`
    );
  }
  return {
    where: `${marketplace.file}#plugins[${name}].version`,
    doc: marketplace,
    get: () => entry.version,
    set: (v) => {
      entry.version = v;
      if (publishedRef) entry.source.ref = publishedRef;
    }
  };
}

/**
 * Every place a version is derived, as `{ where, doc, get, set, expected }`
 * records so `--check` and `--sync` cannot disagree about the set of files.
 * Covers all plugins at once, because they share one catalog.
 */
function derivedTargets() {
  const plugins = listPlugins();
  const marketplace = read(MARKETPLACE);
  const targets = [];
  const versions = new Map(
    plugins.map((plugin) => [plugin.name, sourceVersion(plugin)])
  );

  for (const plugin of plugins) {
    const expected = versions.get(plugin.name);
    const manifest = read(plugin.manifestFile);
    targets.push({
      where: `${manifest.file}#version`,
      doc: manifest,
      expected,
      get: () => manifest.json.version,
      set: (v) => (manifest.json.version = v)
    });
    targets.push({ ...catalogEntry(marketplace, plugin.name), expected });
  }

  return targets;
}

// An edge publish owns only the active catalog entry for the plugin it ships;
// all plugin manifests and shared marketplace metadata remain untouched.
function edgeTargets(plugin, version) {
  const marketplace = read(MARKETPLACE);
  return [
    {
      ...catalogEntry(marketplace, plugin.name, `${plugin.name}@edge`),
      expected: version
    }
  ];
}

function releaseNotes(plugin, version) {
  let raw;
  try {
    raw = readFileSync(join(repoRoot, plugin.changelogFile), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT")
      fail(`${plugin.changelogFile} does not exist`);
    throw error;
  }

  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) fail(`${plugin.changelogFile} has no entry for ${version}`);

  const next = lines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line)
  );
  const notes = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  if (!notes) fail(`${plugin.changelogFile} has an empty entry for ${version}`);
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

function apply(targets) {
  const touched = new Set();
  for (const target of targets) {
    target.set(target.expected);
    touched.add(target.doc);
  }
  for (const doc of touched) {
    write(doc);
    console.error(`updated ${doc.file}`);
  }
}

// `--check` and `--sync` span every plugin, so they only echo a version when
// one plugin is unambiguously meant; stdout stays a single version or nothing.
function reportedVersion(name) {
  if (name === undefined && listPlugins().length !== 1) return undefined;
  return sourceVersion(requirePlugin(name));
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
const pluginIndex = args.indexOf("--plugin");
const pluginName = pluginIndex === -1 ? undefined : args[pluginIndex + 1];

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
  const plugin = requirePlugin(pluginName);
  console.log(releaseNotes(plugin, sourceVersion(plugin)));
} else if (other) {
  console.log(compare(sourceVersion(requirePlugin(pluginName)), other));
} else if (explicit) {
  const plugin = requirePlugin(pluginName);
  if (channel === "edge") {
    apply(edgeTargets(plugin, explicit));
  } else {
    const source = read(plugin.packageFile);
    source.json.version = explicit;
    write(source);
    console.error(`updated ${plugin.packageFile} -> ${explicit}`);
    apply(derivedTargets());
  }
  console.log(explicit);
} else if (sync) {
  apply(derivedTargets());
  const version = reportedVersion(pluginName);
  if (version) console.log(version);
} else if (check) {
  const drifted = derivedTargets().filter(
    (target) => target.get() !== target.expected
  );
  if (drifted.length > 0) {
    const detail = drifted
      .map(
        (t) =>
          `  ${t.where} = ${JSON.stringify(t.get())}, expected ${JSON.stringify(t.expected)}`
      )
      .join("\n");
    fail(
      `derived versions have drifted from the plugin manifests:\n${detail}\n` +
        `run \`pnpm run version:sync\` to repair them.`
    );
  }
  console.error("every derived version is consistent");
  const version = reportedVersion(pluginName);
  if (version) console.log(version);
} else {
  console.log(sourceVersion(requirePlugin(pluginName)));
}
