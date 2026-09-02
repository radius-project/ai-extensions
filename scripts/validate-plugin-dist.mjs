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
const MANIFEST_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
// Publish jobs run without installed packages, so evaluate the fetched schema
// here and reject future keywords rather than silently skipping a new contract.
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "items"
]);
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const CANVAS_KEYWORD = "canvas";
const CANVAS_LOGO = "assets/preview.png";
const CANVAS_ENTRY_POINT = "extension.mjs";
const CANVAS_COMPATIBILITY_ENTRY_POINT = "extensions/extension.mjs";

class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${errorMessage(error)}`);
  }
}

function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchManifestSchema() {
  let response;
  try {
    response = await fetch(MANIFEST_SCHEMA_URL, {
      headers: { accept: "application/schema+json, application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    fail(
      `Agent Plugins schema could not be fetched from ${MANIFEST_SCHEMA_URL}: ${errorMessage(error)}`
    );
  }

  if (!response.ok) {
    fail(`Agent Plugins schema request failed with HTTP ${response.status}`);
  }

  let schema;
  try {
    schema = await response.json();
  } catch (error) {
    fail(`Agent Plugins schema is not readable JSON: ${errorMessage(error)}`);
  }
  if (!isJsonObject(schema)) {
    fail("Agent Plugins schema must be a JSON object");
  }
  if (schema.$id !== MANIFEST_SCHEMA_URL) {
    fail(`Agent Plugins schema has unexpected $id: ${String(schema.$id)}`);
  }
  return schema;
}

function childLocation(location, property) {
  return `${location}${location.includes("#") ? "." : "#"}${property}`;
}

function findUnsupportedSchemaKeyword(schema, location = "schema") {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      return `${location}.${keyword}`;
    }
  }

  for (const [property, propertySchema] of Object.entries(
    schema.properties ?? {}
  )) {
    const unsupported = findUnsupportedSchemaKeyword(
      propertySchema,
      `${location}.properties.${property}`
    );
    if (unsupported !== undefined) return unsupported;
  }

  if (isJsonObject(schema.additionalProperties)) {
    const unsupported = findUnsupportedSchemaKeyword(
      schema.additionalProperties,
      `${location}.additionalProperties`
    );
    if (unsupported !== undefined) return unsupported;
  }
  if (isJsonObject(schema.items)) {
    return findUnsupportedSchemaKeyword(schema.items, `${location}.items`);
  }
  return undefined;
}

function matchesSchemaType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isJsonObject(value);
  return typeof value === type;
}

function schemaTypeDescription(type) {
  return `${type === "array" || type === "object" ? "an" : "a"} ${type}`;
}

function validateSchema(value, schema, location) {
  if (schema.type !== undefined && !matchesSchemaType(value, schema.type)) {
    return `${location} must be ${schemaTypeDescription(schema.type)}`;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    return `${location} must be ${schema.const}`;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return `${location} must contain at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return `${location} must contain at most ${schema.maxLength} characters`;
    }
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern).test(value)
    ) {
      return `${location} does not match the required pattern`;
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const error = validateSchema(item, schema.items, `${location}[${index}]`);
      if (error !== undefined) return error;
    }
  }

  if (isJsonObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        return `${childLocation(location, required)} is required`;
      }
    }

    const properties = schema.properties ?? {};
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, property)) continue;
      const error = validateSchema(
        value[property],
        propertySchema,
        childLocation(location, property)
      );
      if (error !== undefined) return error;
    }

    const additional = Object.keys(value).filter(
      (property) => !Object.hasOwn(properties, property)
    );
    if (schema.additionalProperties === false && additional.length > 0) {
      return `${location} declares unknown fields: ${additional.join(", ")}`;
    }
    if (isJsonObject(schema.additionalProperties)) {
      for (const property of additional) {
        const error = validateSchema(
          value[property],
          schema.additionalProperties,
          childLocation(location, property)
        );
        if (error !== undefined) return error;
      }
    }
  }

  return undefined;
}

function isReverseDomainNamespace(namespace) {
  const labels = namespace.split(".");
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label));
}

function isCanvasPlugin(manifest) {
  return (
    Array.isArray(manifest.keywords) &&
    manifest.keywords.some(
      (keyword) => String(keyword).trim().toLowerCase() === CANVAS_KEYWORD
    )
  );
}

function requireCanvasContract(dist, manifest) {
  if (manifest.logo !== CANVAS_LOGO) {
    fail(
      `plugin.json#logo must be ${JSON.stringify(CANVAS_LOGO)} for a plugin keyworded "${CANVAS_KEYWORD}"`
    );
  }
  if (manifest.extensions !== "extensions") {
    fail('published canvas plugin.json#extensions must be "extensions"');
  }
  requirePath(dist, manifest.logo, "plugin.json#logo", "file");
  requirePath(dist, CANVAS_ENTRY_POINT, "canvas entry point", "file");
  requirePath(
    dist,
    CANVAS_COMPATIBILITY_ENTRY_POINT,
    "Awesome Copilot canvas entry point",
    "file"
  );
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

async function main() {
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

  if (!isJsonObject(packageJson)) {
    fail("package.json must be a JSON object");
  }
  const manifestSchema = await fetchManifestSchema();
  const unsupportedSchemaKeyword = findUnsupportedSchemaKeyword(manifestSchema);
  if (unsupportedSchemaKeyword !== undefined) {
    fail(
      `Agent Plugins schema uses an unsupported keyword: ${unsupportedSchemaKeyword}`
    );
  }
  const canvas = isJsonObject(manifest) && isCanvasPlugin(manifest);
  const portable = canvas ? { ...manifest } : manifest;
  if (canvas) {
    delete portable.logo;
    delete portable.extensions;
  }
  const manifestError = validateSchema(portable, manifestSchema, "plugin.json");
  if (manifestError !== undefined) fail(manifestError);
  if (canvas) requireCanvasContract(dist, manifest);

  if (packageJson.name !== plugin.name || manifest.name !== plugin.name) {
    fail(`dist manifests must both be named "${plugin.name}"`);
  }
  if (isJsonObject(manifest.extensions)) {
    for (const namespace of Object.keys(manifest.extensions)) {
      if (!isReverseDomainNamespace(namespace)) {
        fail(
          `plugin.json#extensions key must be a reverse-domain namespace: ${namespace}`
        );
      }
    }
  }
  if (
    typeof packageJson.version !== "string" ||
    !SEMVER.test(packageJson.version) ||
    manifest.version !== packageJson.version
  ) {
    fail(
      "dist package.json and plugin.json must carry the same semver version"
    );
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
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Failure)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
