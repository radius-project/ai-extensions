// Validates the generic artifact contract every plugin must satisfy before its
// dist can be attested, tagged, or pushed.
//
// Usage:
//   node scripts/validate-plugin-dist.mjs --plugin <name>
//     [--version <semver>] [--source <full-sha>]

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { repoRoot, requirePlugin } from "./plugins.mjs";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA = /^[0-9a-f]{40}$/;
// Agent Plugins 1.0.0 (https://agent-plugins.org) closes the manifest: only
// these fields may appear, components load from fixed locations rather than
// manifest paths, and client data belongs under a reverse-domain namespace.
const MANIFEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions"
]);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
}

function requirePath(root, declared, label, type) {
  if (typeof declared !== "string" || declared.length === 0) {
    fail(`${label} must be a non-empty relative path`);
  }
  if (isAbsolute(declared)) fail(`${label} must stay inside the plugin dist`);

  const target = resolve(root, declared);
  const within = relative(root, target);
  if (within.startsWith("..") || isAbsolute(within)) {
    fail(`${label} escapes the plugin dist: ${declared}`);
  }

  let stats;
  try {
    stats = statSync(target);
  } catch {
    fail(`${label} does not exist: ${declared}`);
  }
  if (type === "file" && !stats.isFile()) fail(`${label} must be a file`);
  if (type === "directory" && !stats.isDirectory()) {
    fail(`${label} must be a directory`);
  }
}

function rejectSymlinks(directory, root = directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) {
      fail(`plugin dist contains a symlink: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) rejectSymlinks(path, root);
  }
}

const args = process.argv.slice(2);
const plugin = requirePlugin(option(args, "--plugin"));
const expectedVersion = option(args, "--version");
const expectedSource = option(args, "--source");
if (expectedSource !== undefined && !SHA.test(expectedSource)) {
  fail("--source must be a full lowercase commit SHA");
}
const dist = resolve(repoRoot, plugin.distDir);
// Checked before anything reads through it: every path check below follows a
// symlinked dist root and would validate files outside the plugin tree.
if (lstatSync(dist).isSymbolicLink()) {
  fail(`plugin dist must be a directory, not a symlink: ${plugin.distDir}`);
}
const packageJson = readJson(resolve(dist, "package.json"), "package.json");
const manifest = readJson(resolve(dist, "plugin.json"), "plugin.json");

if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
  fail("package.json must be a JSON object");
}
if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
  fail("plugin.json must be a JSON object");
}
if (packageJson.name !== plugin.name || manifest.name !== plugin.name) {
  fail(`dist manifests must both be named "${plugin.name}"`);
}
if (manifest.$schema !== MANIFEST_SCHEMA) {
  fail(`plugin.json#$schema must be ${MANIFEST_SCHEMA}`);
}
const unknownFields = Object.keys(manifest).filter(
  (field) => !MANIFEST_FIELDS.has(field)
);
if (unknownFields.length > 0) {
  fail(`plugin.json declares unknown fields: ${unknownFields.join(", ")}`);
}
if (manifest.extensions !== undefined) {
  if (
    typeof manifest.extensions !== "object" ||
    manifest.extensions === null ||
    Array.isArray(manifest.extensions)
  ) {
    fail("plugin.json#extensions must be an object keyed by extension namespace");
  }
  for (const [namespace, value] of Object.entries(manifest.extensions)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`plugin.json#extensions.${namespace} must be an object`);
    }
  }
}
if (
  typeof packageJson.version !== "string" ||
  !SEMVER.test(packageJson.version) ||
  manifest.version !== packageJson.version
) {
  fail("dist package.json and plugin.json must carry the same semver version");
}
if (expectedVersion && packageJson.version !== expectedVersion) {
  fail(`dist version is ${packageJson.version}, expected ${expectedVersion}`);
}
if (
  typeof packageJson.radiusSourceRef !== "string" ||
  !SHA.test(packageJson.radiusSourceRef)
) {
  fail("dist package.json must carry a full radiusSourceRef commit SHA");
}
if (expectedSource && packageJson.radiusSourceRef !== expectedSource) {
  fail(
    `dist source ref is ${packageJson.radiusSourceRef}, expected ${expectedSource}`
  );
}

requirePath(dist, "README.md", "README.md", "file");
if (statSync(resolve(dist, "README.md")).size === 0) {
  fail("README.md must not be empty");
}
requirePath(dist, "LICENSE", "LICENSE", "file");
if (statSync(resolve(dist, "LICENSE")).size === 0) {
  fail("LICENSE must not be empty");
}
requirePath(dist, "workflows", "workflows", "directory");
// Fixed component location: clients discover skills from here, not from a
// manifest path.
requirePath(dist, "skills", "skills", "directory");
if (packageJson.main !== undefined) {
  requirePath(dist, packageJson.main, "package.json#main", "file");
}

rejectSymlinks(dist);
console.log(`${plugin.name}@${packageJson.version}`);
