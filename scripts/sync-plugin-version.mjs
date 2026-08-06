#!/usr/bin/env node
// Changesets owns the version in plugins/radius/package.json (see the fixed group
// in .changeset/config.json). Every other manifest naming the shipped plugin
// version is derived from it here, so exactly one file is the source of truth.
import { readFileSync, writeFileSync } from "node:fs";

const repoRoot = new URL("../", import.meta.url);
const SOURCE = "plugins/radius/package.json";
// Every "version" key in these files refers to the shipped plugin.
const TARGETS = [
  "plugins/radius/plugin.json",
  ".github/plugin/marketplace.json"
];
const VERSION_KEY = /("version"\s*:\s*")([^"]*)(")/g;

const pathFor = (file) => new URL(file, repoRoot);
const read = (file) => readFileSync(pathFor(file), "utf8");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const { version } = JSON.parse(read(SOURCE));
if (!/^\d+\.\d+\.\d+/.test(version)) {
  fail(`${SOURCE} has no usable version: ${JSON.stringify(version)}`);
}

const check = process.argv.includes("--check");
const drifted = [];

for (const file of TARGETS) {
  const before = read(file);
  if (!before.match(VERSION_KEY)) {
    fail(`${file} has no "version" key to sync — update ${SOURCE}'s targets.`);
  }
  const after = before.replace(VERSION_KEY, `$1${version}$3`);
  if (after === before) continue;
  if (check) drifted.push(file);
  else writeFileSync(pathFor(file), after);
}

if (drifted.length) {
  fail(
    `Version drift against ${SOURCE} (${version}):\n` +
      drifted.map((file) => `  ${file}`).join("\n") +
      "\nRun `pnpm run version:sync` to fix."
  );
}

console.log(
  check ?
    `[version] ${TARGETS.length} manifests match ${version}`
  : `[version] synced ${TARGETS.length} manifests to ${version}`
);
