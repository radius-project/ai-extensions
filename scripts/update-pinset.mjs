#!/usr/bin/env node
// Resolve the Repo Radius pinset from upstream and verify or rewrite it.
//
// The SHAs in radius-core/src/workflows/pinset.ts decide which action code runs
// with a user's cloud credentials, so they are never typed by hand: this script
// resolves them from GitHub and CI re-runs it with --check to fail any pull
// request whose pinset does not match what upstream actually says.
//
//   node scripts/update-pinset.mjs --check          verify the committed pinset
//   node scripts/update-pinset.mjs --ref <ref>      re-pin to a tag/branch/SHA
//
// Reads through `gh api` so it inherits the caller's authentication.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "radius-project/radius";
const PINSET_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "radius-core", "src", "workflows", "pinset.ts");

function gh(apiPath, jq) {
  const args = ["api", apiPath];
  if (jq) args.push("--jq", jq);
  // stderr is piped, not inherited: resolveCommit probes the tags endpoint first
  // and a 404 there is the normal path for a branch or raw SHA.
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Resolve a tag, branch or SHA to the commit it points at.
 *
 * An annotated tag's ref points at a tag object, not a commit, so it has to be
 * dereferenced — otherwise the pin would name an object Actions cannot check
 * out. Falls back to the commits endpoint for a branch or raw SHA.
 */
function resolveCommit(ref) {
  try {
    const raw = gh(`/repos/${REPO}/git/ref/tags/${encodeURIComponent(ref)}`);
    const object = JSON.parse(raw).object;
    if (object.type === "tag") return JSON.parse(gh(`/repos/${REPO}/git/tags/${object.sha}`)).object.sha;
    return object.sha;
  } catch {
    return gh(`/repos/${REPO}/commits/${encodeURIComponent(ref)}`, ".sha");
  }
}

function readPinset() {
  const source = readFileSync(PINSET_PATH, "utf8");
  const sha = /^const RADIUS_SHA = "([0-9a-f]{40})";$/m.exec(source);
  const version = /^const RADIUS_VERSION = "([^"]+)";$/m.exec(source);
  if (!sha || !version) {
    throw new Error(`Could not read RADIUS_SHA / RADIUS_VERSION from ${PINSET_PATH}. Did the generated block move?`);
  }
  const ledger = [...source.matchAll(/\{ version: "([^"]+)", sha: "([0-9a-f]{40})" \}/g)].map((m) => ({
    version: m[1],
    sha: m[2],
  }));
  return { source, sha: sha[1], version: version[1], ledger };
}

/**
 * Verify the committed pinset against upstream.
 *
 * A version label of `main@<short>` names a commit rather than a release, so it
 * is checked against the SHA it claims; anything else is resolved as a tag.
 */
function check() {
  const { sha, version, ledger } = readPinset();
  const problems = [];

  const ref = version.startsWith("main@") ? sha : version;
  let resolved = "";
  try {
    resolved = resolveCommit(ref);
  } catch (e) {
    problems.push(`could not resolve "${ref}" in ${REPO}: ${e.message}`);
  }
  if (resolved && resolved !== sha) {
    problems.push(`RADIUS_SHA is ${sha} but "${version}" resolves to ${resolved}`);
  }
  if (version.startsWith("main@") && !sha.startsWith(version.slice("main@".length))) {
    problems.push(`version label "${version}" does not match RADIUS_SHA ${sha}`);
  }
  if (!ledger.some((e) => e.sha === sha && e.version === version)) {
    problems.push(`the ledger has no { version: "${version}", sha: "${sha}" } entry`);
  }
  const seen = new Set();
  for (const entry of ledger) {
    if (seen.has(entry.sha)) problems.push(`duplicate ledger sha ${entry.sha}`);
    seen.add(entry.sha);
  }

  if (problems.length) {
    console.error("Pinset verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRun `node scripts/update-pinset.mjs --ref <tag-or-branch>` to regenerate it.");
    process.exit(1);
  }
  console.log(`Pinset OK: ${REPO} pinned to ${sha} (${version}), ${ledger.length} ledger entry/entries.`);
}

/** Re-pin to `ref` and append a ledger entry. The ledger is append-only. */
function update(ref) {
  const { source, sha: currentSha, ledger } = readPinset();
  const sha = resolveCommit(ref);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`"${ref}" did not resolve to a commit SHA (got "${sha}").`);
  const version = ref === "main" ? `main@${sha.slice(0, 7)}` : ref;

  if (sha === currentSha) {
    console.log(`Pinset already at ${sha} (${version}); nothing to do.`);
    return;
  }
  if (ledger.some((e) => e.sha === sha)) {
    throw new Error(`${sha} is already in the ledger. The ledger is append-only, so re-pinning to an older entry is not supported.`);
  }

  const entries = [...ledger, { version, sha }]
    .map((e) => `  { version: "${e.version}", sha: "${e.sha}" },`)
    .join("\n");
  const next = source
    .replace(/^const RADIUS_SHA = "[0-9a-f]{40}";$/m, `const RADIUS_SHA = "${sha}";`)
    .replace(/^const RADIUS_VERSION = "[^"]+";$/m, `const RADIUS_VERSION = "${version}";`)
    .replace(
      /^const RADIUS_LEDGER: readonly LedgerEntry\[\] = \[[\s\S]*?^\];$/m,
      `const RADIUS_LEDGER: readonly LedgerEntry[] = [\n${entries}\n];`,
    );
  writeFileSync(PINSET_PATH, next);
  console.log(`Pinned ${REPO} to ${sha} (${version}). Review the diff and add a changeset.`);
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  check();
} else {
  const refIndex = args.indexOf("--ref");
  const ref = refIndex === -1 ? "main" : args[refIndex + 1];
  if (!ref) throw new Error("--ref needs a tag, branch or commit SHA.");
  update(ref);
}
