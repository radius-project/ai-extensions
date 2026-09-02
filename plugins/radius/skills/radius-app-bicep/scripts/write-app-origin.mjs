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

// The version is RECEIVED, never worked out here, and that is the whole point.
//
// `skillVersion` exists so the canvas can later ask "did the generator change
// since this model was made?", which is only a meaningful question if the value
// recorded here is the same value the canvas resolves for itself. The canvas
// reads the package manifest sitting beside the bundle it loaded, and passes the
// result to the agent through the radius_generate_app handoff, which is what
// substitutes --skill-version. So the flag carries the one authoritative answer,
// and this script's job is to write it down unchanged.
//
// This script used to fall back to the manifest three directories above itself
// when the flag was absent. That reads a real version — just not necessarily the
// running one. Two copies of the plugin can be installed at once (an
// extensions-directory copy and an installed-plugins copy), the two directory
// layouts are identical, and the agent can easily load SKILL.md from one while
// the canvas runs the other. The fallback then stamped copy B's version into a
// record the canvas compared against copy A's, the model was reported as
// generator-changed on every graph open, and regenerating reproduced the same
// mismatched pair — an endless, expensive no-op (#694).
//
// So an absent or unsubstituted flag records "" instead. Blank is a designed
// value here, not a failure: the reader treats an empty skillVersion as "not
// known" and skips the generator-drift check entirely, exactly as it does when
// the canvas cannot resolve its own version. Recording nothing costs the drift
// check for that one model; recording a guess costs the user a regeneration loop
// they cannot escape or diagnose. Refusing to write the record at all would be
// worse still: the model would then read as unverified on every graph open.
const requested = flag("skill-version");
const placeholderPassed = requested === PLACEHOLDER;
const skillVersion = placeholderPassed ? "" : requested;
if (!skillVersion) {
  // Not a failure, so the record is still written and the run still succeeds.
  // But a blank version silently switches the generator-drift check off for
  // this model, so say which of the two causes produced it. They need
  // different fixes: an unsubstituted placeholder means the caller passed the
  // prompt's literal text instead of a version, while a missing flag usually
  // means an older SKILL.md or a hand-run command that never passed one.
  const consequence =
    "the origin record leaves the generator version unknown, so later freshness checks will skip the generator comparison for this model.";
  console.error(
    placeholderPassed ?
      `warning: --skill-version was given the literal ${PLACEHOLDER}, which is the prompt's placeholder rather than a version, so ${consequence}`
    : `warning: no --skill-version value was supplied, so ${consequence}`
  );
}

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
