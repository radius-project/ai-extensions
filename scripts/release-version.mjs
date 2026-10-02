// Versions plugins by default, or npm libraries with --libraries. Neither scope
// consumes the other's queued notes. Plugin versions synchronize manifests.
//
// changesets/action executes its `script` input directly rather than through a
// shell. Keeping both commands in this executable avoids relying on `&&` being
// interpreted and passes every package name as a distinct argv value.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "./module-entry.mjs";
import { listPlugins, repoRoot, requirePlugin } from "./plugins.mjs";
import { libraryNames } from "./libraries.mjs";

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

export function versionPlan(
  plugins,
  selectedName,
  snapshot,
  { libraries = [], scope = "plugins" } = {}
) {
  if (scope === "libraries" && selectedName) {
    throw new Error("--libraries cannot be combined with --plugin");
  }
  if (scope === "libraries" && libraries.length === 0) {
    throw new Error("no public npm libraries were discovered");
  }
  const selected =
    selectedName === undefined || selectedName === "" ?
      undefined
    : plugins.find((plugin) => plugin.name === selectedName);
  if (selectedName && !selected) {
    throw new Error(`no plugin named "${selectedName}"`);
  }

  return {
    args: ["version", ...(snapshot ? ["--snapshot", snapshot] : [])],
    ignore:
      scope === "libraries" ?
        plugins.map((plugin) => plugin.name)
      : [
          ...plugins
            .filter((plugin) => selected && plugin.name !== selected.name)
            .map((plugin) => plugin.name),
          ...libraries
        ]
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
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  const selectedName = option(args, "--plugin");
  const snapshot = option(args, "--snapshot");
  if (args.includes("--libraries") && args.includes("--plugin")) {
    fail("--libraries cannot be combined with --plugin");
  }
  if (args.includes("--snapshot") && !snapshot) {
    fail("--snapshot requires a name");
  }
  if (selectedName !== undefined) requirePlugin(selectedName);

  const libraryScope = args.includes("--libraries");
  let plan;
  try {
    plan = versionPlan(listPlugins(), selectedName, snapshot, {
      libraries: libraryNames(),
      scope: libraryScope ? "libraries" : "plugins"
    });
  } catch (error) {
    fail(error.message);
  }
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

  if (!libraryScope) {
    const synced = run(process.execPath, [
      join(repoRoot, "scripts", "version.mjs"),
      "--sync"
    ]);
    if (synced !== 0) process.exit(synced);
  }
}
