#!/usr/bin/env node

// Writes .radius/app.origin.json, the origin record that records what the
// application model was generated FROM.
//
// The Radius canvas reads this record before rendering a graph so it can tell a
// current model from one whose source has moved on, whose generator has been
// upgraded, or that a human edited after generation. Without it the canvas can
// only ask "does app.bicep exist?", which silently renders stale models.
//
// Run this only after the Bicep checker exits clean: the recorded appBicepHash is
// what later lets the canvas treat the file as known-valid without recompiling
// it on every open.
//
// The normalization and hash below MUST stay byte-compatible with the
// extension's own copies: normalizeAppBicep in
// packages/core/src/modeling/app-origin.ts, and hashAppBicep in
// packages/adapter-canvas/src/app-bicep-hash.ts. (The hash lives in the adapter
// because core is compiled into the browser bundle and cannot import
// node:crypto.) They are duplicated here rather than imported because this
// script ships inside the installed plugin, where the workspace packages do not
// exist; app-origin-writer.test.ts asserts the two implementations agree.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  return typeof value === "string" && !value.startsWith("--") ?
      value.trim()
    : "";
}

function positional() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      i += 1;
      continue;
    }
    return arg;
  }
  return "";
}

function normalizeAppBicep(content) {
  return content
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
}

function hashAppBicep(content) {
  const digest = createHash("sha256")
    .update(normalizeAppBicep(content), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function headCommit(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) return "";
  return (result.stdout || "").trim();
}

const PLACEHOLDER = "<loaded-skill-version>";

// The skill prompt normally substitutes the running bundle's version into
// --skill-version. But SKILL.md is also loadable directly as a plugin skill, in
// which case the placeholder arrives unsubstituted. Recording that literal
// would make every later freshness check see a version that can never match and
// report the model as generator-changed forever. So treat the placeholder as
// absent and read the version from the plugin manifest instead.
//
// The manifest is addressed exactly, not searched for by walking up: this script
// always sits at <plugin>/skills/radius-app-bicep/scripts/, and an open-ended
// walk could climb out of the plugin entirely and adopt an unrelated
// package.json's version.
function manifestVersion() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const manifest = path.resolve(scriptDir, "../../../package.json");
  try {
    const version = JSON.parse(readFileSync(manifest, "utf8"))?.version;
    return typeof version === "string" ? version.trim() : "";
  } catch {
    return "";
  }
}

const requested = flag("skill-version");
// An unresolvable version is a missing fact, not a failure. Recording it empty
// lets the reader skip the generator-drift check; refusing to write it would make
// the model read as unverified and prompt the user on every single graph open.
const skillVersion =
  requested && requested !== PLACEHOLDER ? requested : manifestVersion();

const app = path.resolve(positional() || ".radius/app.bicep");
let model = "";
try {
  model = readFileSync(app, "utf8");
} catch (error) {
  fail(`Cannot read the application model at ${app}: ${error.message}`);
}

const commit = headCommit(path.dirname(app));
if (!commit) {
  fail(
    `Cannot resolve the source commit for ${app}. The origin record holds the commit the model was generated from, so it is not written without one. Run this inside the repository's git checkout.`
  );
}

// Fixed key order, two-space indent, trailing newline: the record is machine
// written and machine read, so regenerating an unchanged model must not show up
// as a diff.
const origin = {
  generatedAt: flag("generated-at") || new Date().toISOString(),
  sourceCommit: commit,
  skillVersion,
  appBicepHash: hashAppBicep(model)
};

const target = path.join(path.dirname(app), "app.origin.json");
try {
  writeFileSync(target, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
} catch (error) {
  fail(`Cannot write the origin record to ${target}: ${error.message}`);
}

console.log(target);
