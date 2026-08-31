// Resolves exactly which plugins a Changesets release commit versioned.
//
// A plugin is in the plan only when its package version changed from the first
// parent and the matching CHANGELOG heading was added in that same diff. Old
// changelog entries and incomplete releases from earlier commits therefore
// cannot join an unrelated release.
//
// Usage:
//   node scripts/release-plan.mjs --source <full-commit-sha>
//
// Prints a JSON array of plugin names for a GitHub Actions matrix.

import { spawnSync } from "node:child_process";
import { listPlugins, repoRoot } from "./plugins.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function git(args, { allowMissing = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    if (allowMissing) return undefined;
    fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function jsonAt(commit, path, { allowMissing = false } = {}) {
  const raw = git(["show", `${commit}:${path}`], { allowMissing });
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${path} at ${commit} is not valid JSON: ${error.message}`);
  }
}

const args = process.argv.slice(2);
const requestedSource = option(args, "--source");
if (!requestedSource || !COMMIT_SHA.test(requestedSource)) {
  fail(
    `--source requires a full 40-character commit SHA, got ${JSON.stringify(requestedSource ?? "")}`
  );
}

const source = git(["rev-parse", `${requestedSource}^{commit}`]);
const head = git(["rev-parse", "HEAD^{commit}"]);
if (source !== head) {
  fail(`release source ${source} is not the checked-out commit ${head}`);
}
const base = git(["rev-parse", `${source}^1`]);
const released = [];

for (const plugin of listPlugins()) {
  const current = jsonAt(source, plugin.packageFile);
  const previous = jsonAt(base, plugin.packageFile, { allowMissing: true });
  const version = current?.version;

  if (current?.name !== plugin.name) {
    fail(`${plugin.packageFile} at ${source} must be named "${plugin.name}"`);
  }
  if (typeof version !== "string" || !SEMVER.test(version)) {
    fail(`${plugin.packageFile} at ${source} has an invalid version`);
  }
  if (previous?.version === version) continue;

  const changelogDiff = git([
    "diff",
    "--unified=0",
    "--no-ext-diff",
    base,
    source,
    "--",
    plugin.changelogFile
  ]);
  if (!changelogDiff.split(/\r?\n/).includes(`+## ${version}`)) {
    fail(
      `${plugin.packageFile} changed to ${version}, but ${plugin.changelogFile} did not add "## ${version}"`
    );
  }

  released.push(plugin.name);
}

console.log(JSON.stringify(released));
