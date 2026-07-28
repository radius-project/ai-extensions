// Single source of truth for the released plugin version.
//
// The version appears in three tracked manifests that must never drift:
//
//   plugins/radius/plugin.json        the plugin manifest Copilot reads
//   plugins/radius/package.json       the canvas extension package
//   .github/plugin/marketplace.json   the marketplace entry (metadata + plugin)
//
// Usage:
//   node scripts/version.mjs                      print the current version
//   node scripts/version.mjs --check              fail if the manifests disagree
//   node scripts/version.mjs --bump patch         write the next version
//   node scripts/version.mjs --bump minor --dry-run   print it without writing
//
// The resolved version is the only thing written to stdout so callers can do
// `VERSION="$(node scripts/version.mjs --bump patch)"`; everything else goes to
// stderr.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The marketplace lists the single `radius` plugin, hence the fixed index.
const MANIFESTS = [
  { file: "plugins/radius/plugin.json", paths: [["version"]] },
  { file: "plugins/radius/package.json", paths: [["version"]] },
  {
    file: ".github/plugin/marketplace.json",
    paths: [
      ["metadata", "version"],
      ["plugins", 0, "version"],
    ],
  },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const BUMPS = ["major", "minor", "patch"];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function getIn(obj, path) {
  return path.reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function setIn(obj, path, value) {
  const parent = getIn(obj, path.slice(0, -1));
  if (parent == null) fail(`missing path ${path.join(".")}`);
  parent[path.at(-1)] = value;
}

function readManifests() {
  return MANIFESTS.map((manifest) => {
    const absolute = join(repoRoot, manifest.file);
    const raw = readFileSync(absolute, "utf8");
    return { ...manifest, absolute, raw, json: JSON.parse(raw) };
  });
}

/** @returns {string} the version all manifests agree on */
function currentVersion(manifests) {
  const found = manifests.flatMap((manifest) =>
    manifest.paths.map((path) => ({
      where: `${manifest.file}#${path.join(".")}`,
      version: getIn(manifest.json, path),
    })),
  );

  for (const { where, version } of found) {
    if (typeof version !== "string" || !SEMVER.test(version)) {
      fail(`${where} is not a MAJOR.MINOR.PATCH version: ${JSON.stringify(version)}`);
    }
  }

  const distinct = [...new Set(found.map((entry) => entry.version))];
  if (distinct.length > 1) {
    const detail = found.map((entry) => `  ${entry.where} = ${entry.version}`).join("\n");
    fail(`manifest versions disagree:\n${detail}`);
  }

  return distinct[0];
}

function nextVersion(version, bump) {
  const [, major, minor, patch] = version.match(SEMVER).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function write(manifests, version) {
  for (const manifest of manifests) {
    for (const path of manifest.paths) setIn(manifest.json, path, version);
    const trailingNewline = manifest.raw.endsWith("\n") ? "\n" : "";
    writeFileSync(manifest.absolute, JSON.stringify(manifest.json, null, 2) + trailingNewline);
    console.error(`updated ${manifest.file} -> ${version}`);
  }
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const dryRun = args.includes("--dry-run");
const bumpIndex = args.indexOf("--bump");
const bump = bumpIndex === -1 ? undefined : args[bumpIndex + 1];

if (bumpIndex !== -1 && !BUMPS.includes(bump)) {
  fail(`--bump requires one of: ${BUMPS.join(", ")}`);
}

const manifests = readManifests();
const current = currentVersion(manifests);

if (check) {
  console.error(`version ${current} is consistent across ${manifests.length} manifests`);
  console.log(current);
} else if (bump) {
  const next = nextVersion(current, bump);
  if (dryRun) console.error(`dry run: ${current} -> ${next} (${bump})`);
  else write(manifests, next);
  console.log(next);
} else {
  console.log(current);
}
