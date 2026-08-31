// Applies pending Changesets releases for one plugin, or for every plugin when
// no --plugin is given, then synchronizes the repository's derived manifests.
//
// changesets/action executes its `script` input directly rather than through a
// shell. Keeping both commands in this executable avoids relying on `&&` being
// interpreted and passes every package name as a distinct argv value.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { listPlugins, repoRoot, requirePlugin } from "./plugins.mjs";

const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function changesetVersionArgs(plugins, selectedName, snapshot) {
  const selected =
    selectedName === undefined || selectedName === "" ?
      undefined
    : plugins.find((plugin) => plugin.name === selectedName);
  if (selectedName && !selected) {
    throw new Error(`no plugin named "${selectedName}"`);
  }

  return [
    "version",
    ...(snapshot ? ["--snapshot", snapshot] : []),
    ...plugins
      .filter((plugin) => selected && plugin.name !== selected.name)
      .flatMap((plugin) => ["--ignore", plugin.name])
  ];
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const selectedName = option(args, "--plugin");
  const snapshot = option(args, "--snapshot");
  if (args.includes("--snapshot") && !snapshot) {
    fail("--snapshot requires a name");
  }
  if (selectedName !== undefined) requirePlugin(selectedName);

  const changesetsCli = require.resolve("@changesets/cli/bin.js");
  run(process.execPath, [
    changesetsCli,
    ...changesetVersionArgs(listPlugins(), selectedName, snapshot)
  ]);
  run(process.execPath, [join(repoRoot, "scripts", "version.mjs"), "--sync"]);
}
