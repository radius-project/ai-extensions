// Applies pending Changesets releases for one plugin, or for every plugin when
// no --plugin is given, then synchronizes the repository's derived manifests.
//
// changesets/action executes its `script` input directly rather than through a
// shell. Keeping both commands in this executable avoids relying on `&&` being
// interpreted and passes every package name as a distinct argv value.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { listPlugins, repoRoot, requirePlugin } from "./plugins.mjs";

const require = createRequire(import.meta.url);
const CONFIG = ".changeset/config.json";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function versionPlan(plugins, selectedName, snapshot) {
  const selected =
    selectedName === undefined || selectedName === "" ?
      undefined
    : plugins.find((plugin) => plugin.name === selectedName);
  if (selectedName && !selected) {
    throw new Error(`no plugin named "${selectedName}"`);
  }

  return {
    args: ["version", ...(snapshot ? ["--snapshot", snapshot] : [])],
    ignore: plugins
      .filter((plugin) => selected && plugin.name !== selected.name)
      .map((plugin) => plugin.name)
  };
}

// The CLI refuses `--ignore` whenever the config file already defines ignores,
// and this repo permanently ignores its internal packages there. Scope the
// release by extending that list instead, then put the file back so the release
// commit never carries the temporary scope.
function scopeConfig(ignore) {
  const path = join(repoRoot, CONFIG);
  const original = readFileSync(path, "utf8");
  const config = JSON.parse(original);
  const merged = [...new Set([...(config.ignore ?? []), ...ignore])];
  writeFileSync(
    path,
    `${JSON.stringify({ ...config, ignore: merged }, null, 2)}\n`
  );
  return () => writeFileSync(path, original);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) fail(result.error.message);
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const selectedName = option(args, "--plugin");
  const snapshot = option(args, "--snapshot");
  if (args.includes("--snapshot") && !snapshot) {
    fail("--snapshot requires a name");
  }
  if (selectedName !== undefined) requirePlugin(selectedName);

  const plan = versionPlan(listPlugins(), selectedName, snapshot);
  const restore = plan.ignore.length > 0 ? scopeConfig(plan.ignore) : undefined;
  let status;
  try {
    status = run(process.execPath, [
      require.resolve("@changesets/cli/bin.js"),
      ...plan.args
    ]);
  } finally {
    restore?.();
  }
  if (status !== 0) process.exit(status);

  const synced = run(process.execPath, [
    join(repoRoot, "scripts", "version.mjs"),
    "--sync"
  ]);
  if (synced !== 0) process.exit(synced);
}
