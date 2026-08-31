// Builds the file set a maintainer opens as a manual pull request against
// https://github.com/github/awesome-copilot to list (or refresh) this repo's
// plugin in its external-plugin catalog.
//
// awesome-copilot stores the same entry object twice - once in the marketplace
// catalog it serves and once in `plugins/external.json` - so both are emitted
// under the paths they occupy in that repository, next to the released plugin
// manifest and README a reviewer reads. Only those four files are produced:
// everything else in that repository belongs to its own maintainers.
//
//   .github/plugin/marketplace.json   { "plugins": [ <entry> ] }
//   plugins/external.json             [ <entry> ]
//   plugins/<name>/plugin.json        the released manifest, verbatim
//   plugins/<name>/README.md          the released README, verbatim
//
// The entry's `source.ref` and `source.sha` are BOTH the full 40-character
// commit SHA of the published artifact branch, never a tag or branch name.
// awesome-copilot re-reviews external listings against whatever the locator
// resolves to, and only a commit SHA cannot be repointed later.
//
// Usage:
//   node scripts/awesome-copilot.mjs --out <dir> --sha <40-char-commit>
//     [--plugin <name>]       required once the repo ships more than one
//     [--marketplace <path>]  default .github/plugin/marketplace.json
//     [--plugin-json <path>]  default plugins/<name>/dist/plugin.json
//     [--readme <path>]       default plugins/<name>/dist/README.md
//
// Only the output directory goes to stdout, so callers can do
// `DIR="$(node scripts/awesome-copilot.mjs ...)"`; everything else is stderr.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot, requirePlugin } from "./plugins.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
// Semantic Versioning 2.0.0, matching awesome-copilot's own entry validation.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEYWORD = /^[a-z0-9-]+$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Maps this repository's marketplace entry onto awesome-copilot's external
 * plugin schema. Every field it requires is derived, never re-typed, so a
 * rename or keyword change on `main` cannot silently ship a stale listing.
 */
function buildEntry(marketplace, manifest, name, sha) {
  const entry = marketplace.plugins?.find((p) => p.name === name);
  if (!entry) fail(`no "${name}" plugin entry in the marketplace`);

  const owner = marketplace.owner;
  if (!owner?.name) fail("the marketplace has no owner.name to attribute");
  if (!entry.license) fail(`"${name}" has no license`);
  if (!SEMVER.test(String(entry.version))) {
    fail(`"${name}" version is not semver: ${entry.version}`);
  }
  if (entry.version !== manifest.version) {
    fail(
      `the marketplace publishes ${entry.version} but the plugin manifest ships ${manifest.version}`
    );
  }
  if (!/^https:\/\/github\.com\//.test(String(entry.repository))) {
    fail(`"${name}" repository must be an https github.com URL`);
  }

  const keywords = entry.keywords ?? [];
  if (keywords.length === 0 || keywords.length > 10) {
    fail("awesome-copilot requires between 1 and 10 keywords");
  }
  const malformed = keywords.filter((k) => !KEYWORD.test(String(k)));
  if (malformed.length > 0) {
    fail(`keywords must be lowercase and hyphenated: ${malformed.join(", ")}`);
  }
  const oversized = keywords.filter((keyword) => String(keyword).length > 30);
  if (oversized.length > 0) {
    fail(`keywords must be 30 characters or fewer: ${oversized.join(", ")}`);
  }

  const source = entry.source;
  if (!OWNER_REPO.test(String(source?.repo))) {
    fail(`"${name}" source.repo must be in "owner/repo" form`);
  }
  // awesome-copilot resolves the plugin manifest relative to source.path, so it
  // has to name the directory the manifest sits in rather than the file, and
  // its submission validator rejects absolute, backslash and traversing paths.
  const path = source?.path;
  if (typeof path !== "string" || path.length === 0) {
    fail(`"${name}" source.path is required`);
  }
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.endsWith(".json")
  ) {
    fail(`"${name}" source.path must be a relative plugin directory: ${path}`);
  }

  return {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    author: {
      name: owner.name,
      ...(owner.email ? { email: owner.email } : {})
    },
    repository: entry.repository,
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    license: entry.license,
    keywords: [...keywords],
    source: {
      source: "github",
      repo: source.repo,
      path: source.path,
      ref: sha,
      sha
    }
  };
}

const args = process.argv.slice(2);
const out = option(args, "--out");
const sha = option(args, "--sha");

if (!out) fail("--out <dir> is required");
if (!sha || !COMMIT_SHA.test(sha)) {
  fail(`--sha requires a full 40-character commit SHA, got ${sha ?? ""}`);
}

const plugin = requirePlugin(option(args, "--plugin"));
const marketplacePath = resolve(
  repoRoot,
  option(args, "--marketplace") ?? ".github/plugin/marketplace.json"
);
const manifestPath = resolve(
  repoRoot,
  option(args, "--plugin-json") ?? `${plugin.distDir}/plugin.json`
);
const readmePath = resolve(
  repoRoot,
  option(args, "--readme") ?? `${plugin.distDir}/README.md`
);

const manifest = readJson(manifestPath);
const entry = buildEntry(readJson(marketplacePath), manifest, plugin.name, sha);

const outDir = resolve(repoRoot, out);
const pluginDir = join(outDir, "plugins", plugin.name);

writeJson(join(outDir, ".github", "plugin", "marketplace.json"), {
  plugins: [entry]
});
writeJson(join(outDir, "plugins", "external.json"), [entry]);
mkdirSync(pluginDir, { recursive: true });
copyFileSync(manifestPath, join(pluginDir, "plugin.json"));
copyFileSync(readmePath, join(pluginDir, "README.md"));

console.error(
  `awesome-copilot listing for ${entry.name}@${entry.version} pinned to ${sha}`
);
console.log(outDir);
