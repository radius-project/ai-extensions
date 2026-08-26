#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_VERSION = 1;
const GENERATED_ROOT =
  "https://raw.githubusercontent.com/radius-project/radius";
const GENERATED_PATH = "hack/bicep-types-radius/generated";
const COMMIT_DIRECTORY = /^[0-9a-f]{40}$/iu;
const USAGE =
  "Usage: show-radius-type.mjs --staging <directory> Radius.<namespace>/<type>[@<api-version>] [...]";

class DefinitionNotFoundError extends Error {
  constructor(type) {
    super(
      `Definition for resource type "${type}" was not found in the generated catalog for this Radius release.`
    );
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedEntries(value) {
  return Object.entries(value).sort(([left], [right]) => {
    if (left < right) return -1;
    // Distinct entries from an object cannot have equal keys.
    /* v8 ignore next */
    if (left > right) return 1;
    // This return preserves the comparator contract for that unreachable case.
    /* v8 ignore next */
    return 0;
  });
}

function usageError(text = USAGE) {
  return Object.assign(new Error(text), { exitCode: 2 });
}

function requireObject(value, context) {
  if (!isObject(value)) throw new Error(`${context} must be an object.`);
  return value;
}

export function parseResourceSelector(value) {
  const match =
    /^(Radius(?:\.[A-Za-z][A-Za-z0-9]*)+)\/([A-Za-z][A-Za-z0-9]*)(?:@([A-Za-z0-9][A-Za-z0-9.-]*))?$/u.exec(
      value
    );
  if (match === null || match[1] === "Radius.Resources") {
    throw usageError(
      `Invalid predefined Radius resource selector "${value}". ${USAGE}`
    );
  }
  return {
    type: `${match[1]}/${match[2]}`,
    apiVersion: match[3]
  };
}

function parseArguments(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true };
  }
  let stagingDir;
  const selectors = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--staging") {
      if (stagingDir !== undefined || !args[index + 1]) throw usageError();
      stagingDir = args[index + 1];
      index += 1;
    } else if (arg.startsWith("-")) {
      throw usageError();
    } else {
      selectors.push(parseResourceSelector(arg));
    }
  }
  if (stagingDir === undefined || selectors.length === 0) throw usageError();
  return { help: false, stagingDir, selectors };
}

export function deriveExtensionReference(version) {
  const match =
    /^v?(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      typeof version === "string" ? version.trim() : ""
    );
  if (match === null) {
    throw new Error(`Unsupported Radius version "${version ?? ""}".`);
  }
  return `br:biceptypes.azurecr.io/radius:${match[1]}.${match[2]}`;
}

export function parseRadiusIdentity(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Managed Radius returned invalid version JSON.");
  }
  requireObject(parsed, "Managed Radius version JSON");
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error('Managed Radius version JSON is missing "version".');
  }
  if (typeof parsed.commit !== "string" || parsed.commit.trim() === "") {
    throw new Error('Managed Radius version JSON is missing "commit".');
  }
  const version = parsed.version.trim();
  const commit = parsed.commit.trim();
  if (!/^[0-9a-f]{40}$/iu.test(commit)) {
    throw new Error(
      `Managed Radius commit "${commit}" is not a full 40-character SHA.`
    );
  }
  return {
    commit: commit.toLowerCase(),
    extension: deriveExtensionReference(version)
  };
}

function requirePlainConfigSection(config, name, source) {
  const value = config[name];
  if (value !== undefined && !isObject(value)) {
    throw new Error(`"${name}" in "${source}" must be an object.`);
  }
  return value ?? {};
}

function validateStagingDirectory(input) {
  const stagingDir = path.resolve(input);
  const runFile = path.join(stagingDir, "run.json");
  let staging;
  let run;
  try {
    staging = fs.lstatSync(stagingDir);
    run = fs.lstatSync(runFile);
  } catch {
    throw new Error(`Invalid Radius staging directory "${input}".`);
  }
  if (
    !staging.isDirectory() ||
    staging.isSymbolicLink() ||
    !run.isFile() ||
    run.isSymbolicLink() ||
    !/^\.staging-.+/u.test(path.basename(stagingDir))
  ) {
    throw new Error(`Invalid Radius staging directory "${input}".`);
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(runFile, "utf8"));
  } catch {
    throw new Error(`Invalid Radius staging directory "${input}".`);
  }
  if (
    !isObject(record) ||
    !isObject(record.baseline) ||
    Object.values(record.baseline).some(
      (value) => value !== null && typeof value !== "string"
    )
  ) {
    throw new Error(`Invalid Radius staging directory "${input}".`);
  }
  return stagingDir;
}

export async function writeStagedBicepConfig(stagingInput, extension) {
  const stagingDir = validateStagingDirectory(stagingInput);
  const staged = path.join(stagingDir, "bicepconfig.json");
  const current = path.join(path.dirname(stagingDir), "bicepconfig.json");
  const source =
    fs.existsSync(staged) ? staged
    : fs.existsSync(current) ? current
    : null;
  let config = {};
  if (source !== null) {
    try {
      config = JSON.parse(await fsp.readFile(source, "utf8"));
    } catch {
      throw new Error(`Could not parse Bicep configuration "${source}".`);
    }
    requireObject(config, `Bicep configuration "${source}"`);
  }

  const experimentalFeaturesEnabled = requirePlainConfigSection(
    config,
    "experimentalFeaturesEnabled",
    source ?? "new Bicep configuration"
  );
  const extensions = requirePlainConfigSection(
    config,
    "extensions",
    source ?? "new Bicep configuration"
  );
  const configuredRadius = extensions.radius;
  if (configuredRadius !== undefined && typeof configuredRadius !== "string") {
    throw new Error(`"extensions.radius" in "${source}" must be a string.`);
  }
  const radius =
    typeof configuredRadius === "string" ? configuredRadius.trim() : "";
  if (radius !== "" && radius !== extension) {
    throw new Error(
      `Configured Radius extension "${radius}" does not match managed Radius extension "${extension}".`
    );
  }

  const output = {
    ...config,
    experimentalFeaturesEnabled: {
      ...experimentalFeaturesEnabled,
      extensibility: true
    },
    extensions: {
      ...extensions,
      radius: radius || extension
    }
  };
  await fsp.writeFile(
    path.join(stagingDir, "bicepconfig.json"),
    `${JSON.stringify(output, null, 2)}\n`
  );
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    return (
      stat.isFile() &&
      (process.platform === "win32" || (stat.mode & 0o111) !== 0)
    );
  } catch {
    return false;
  }
}

function managedBinaries(home = os.homedir()) {
  // A single coverage run cannot execute both operating-system branches.
  /* v8 ignore next */
  const suffix = process.platform === "win32" ? ".exe" : "";
  const directory = path.join(home, ".radius", "ai-extensions", "bin");
  return {
    rad: path.join(directory, `rad${suffix}`),
    bicep: path.join(directory, `bicep${suffix}`)
  };
}

async function queryManagedRadiusIdentity({
  env = process.env,
  home = os.homedir(),
  processTimeoutMs = 10_000
} = {}) {
  const binaries = managedBinaries(home);
  const rad =
    isExecutable(env.RADIUS_RAD_BINARY) ? env.RADIUS_RAD_BINARY : binaries.rad;
  if (!isExecutable(rad)) {
    throw new Error(`Extension-managed Radius binary not found at "${rad}".`);
  }
  try {
    const stdout = execFileSync(rad, ["version", "--cli", "--output", "json"], {
      env: { ...env, BICEP: binaries.bicep },
      timeout: processTimeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: "utf8"
    });
    return parseRadiusIdentity(stdout);
  } catch (error) {
    const detail = error?.stderr?.trim() || message(error);
    throw new Error(`Managed Radius version query failed: ${detail}`, {
      cause: error
    });
  }
}

export function parseIndexReference(reference) {
  const match = /^([A-Za-z0-9._/-]+\/types\.json)#\/(0|[1-9]\d*)$/u.exec(
    reference
  );
  if (match === null) {
    throw new Error(`Generated resource reference "${reference}" is invalid.`);
  }
  const segments = match[1].split("/");
  if (
    match[1].startsWith("/") ||
    match[1].includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`Generated resource reference "${reference}" is unsafe.`);
  }
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) {
    throw new Error(`Generated resource reference "${reference}" is invalid.`);
  }
  return { relativePath: match[1], index };
}

function localIndex(reference, context) {
  const match = /^#\/(0|[1-9]\d*)$/u.exec(reference?.$ref);
  if (!isObject(reference) || !match) {
    throw new Error(`${context} must use a local #/N type reference.`);
  }
  return Number(match[1]);
}

function generatedNode(types, index, context) {
  const node = types[index];
  if (!isObject(node) || typeof node.$type !== "string") {
    throw new Error(
      `${context} references missing generated type node ${index}.`
    );
  }
  return node;
}

function referencedNode(types, reference, context) {
  const index = localIndex(reference, context);
  return { index, node: generatedNode(types, index, context) };
}

function validateIndex(index) {
  requireObject(index, "Generated index");
  requireObject(index.resources, "Generated index resources");
}

function validateTypes(types) {
  if (!Array.isArray(types)) {
    throw new Error("Generated types file must contain a JSON array.");
  }
}

export function selectResource(index, selector) {
  validateIndex(index);
  const prefix = `${selector.type}@`;
  const availableApiVersions = Object.keys(index.resources)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();

  let apiVersion = selector.apiVersion;
  if (apiVersion === undefined) {
    if (availableApiVersions.length === 0) {
      throw new DefinitionNotFoundError(selector.type);
    }
    if (availableApiVersions.length > 1) {
      throw new Error(
        `Resource type "${selector.type}" has multiple API versions: ${availableApiVersions.join(
          ", "
        )}. Rerun with an exact @<api-version>.`
      );
    }
    [apiVersion] = availableApiVersions;
  }

  const key = `${selector.type}@${apiVersion}`;
  const entry = index.resources[key];
  if (!isObject(entry)) {
    const available =
      availableApiVersions.length > 0 ?
        ` Available versions: ${availableApiVersions.join(", ")}.`
      : "";
    throw new Error(`Resource type "${key}" is unavailable.${available}`);
  }
  return {
    type: selector.type,
    apiVersion,
    reference: parseIndexReference(entry.$ref)
  };
}

export function decodePropertyFlags(flags, context = "property") {
  if (!Number.isSafeInteger(flags) || flags < 0) {
    throw new Error(
      `${context} contains unsupported property flags "${flags}".`
    );
  }
  const result = {
    required: (flags & 1) !== 0,
    readable: (flags & 4) === 0,
    writable: (flags & 2) === 0
  };
  return result;
}

function normalizeProperty(property, types, active, context) {
  requireObject(property, context);
  const flags = decodePropertyFlags(property.flags, context);
  const schema = normalizeTypeReference(property.type, types, active, context);
  if (!flags.readable) schema.writeOnly = true;
  if (!flags.writable) schema.readOnly = true;
  return { required: flags.required, schema };
}

function normalizeProperties(properties, types, active, context) {
  requireObject(properties, context);
  const result = { properties: {}, required: [] };
  for (const [name, property] of sortedEntries(properties)) {
    const normalized = normalizeProperty(
      property,
      types,
      active,
      `${context}.${name}`
    );
    result.properties[name] = normalized.schema;
    if (normalized.required) result.required.push(name);
  }
  return result;
}

function objectSchema(normalized, additionalProperties, sensitive = false) {
  const result = { type: "object" };
  if (normalized.required.length > 0) result.required = normalized.required;
  result.properties = normalized.properties;
  result.additionalProperties = additionalProperties;
  if (sensitive) result.sensitive = true;
  return result;
}

function normalizeObject(node, types, active, context) {
  return objectSchema(
    normalizeProperties(
      node.properties,
      types,
      active,
      `${context}.properties`
    ),
    node.additionalProperties === undefined ?
      false
    : normalizeTypeReference(
        node.additionalProperties,
        types,
        active,
        `${context}.additionalProperties`
      ),
    node.sensitive === true
  );
}

function mergeObjectSchemas(base, variant, context) {
  const properties = {};
  const names = [
    ...new Set([
      ...Object.keys(base.properties),
      ...Object.keys(variant.properties)
    ])
  ].sort();
  for (const name of names) {
    if (
      base.properties[name] !== undefined &&
      variant.properties[name] !== undefined &&
      JSON.stringify(base.properties[name]) !==
        JSON.stringify(variant.properties[name])
    ) {
      throw new Error(`${context} redefines property "${name}" incompatibly.`);
    }
    properties[name] = variant.properties[name] ?? base.properties[name];
  }
  const result = { ...variant, properties };
  const required = [
    ...new Set([...(base.required ?? []), ...(variant.required ?? [])])
  ].sort();
  if (required.length > 0) result.required = required;
  return result;
}

function normalizeDiscriminatedObject(node, types, active, context) {
  if (typeof node.discriminator !== "string" || node.discriminator === "") {
    throw new Error(`${context}.discriminator must be a nonempty string.`);
  }
  const base = objectSchema(
    normalizeProperties(
      node.baseProperties,
      types,
      active,
      `${context}.baseProperties`
    ),
    false
  );
  const variants = {};
  for (const [name, reference] of sortedEntries(
    requireObject(node.elements, `${context}.elements`)
  )) {
    const variant = normalizeTypeReference(
      reference,
      types,
      active,
      `${context}.elements.${name}`
    );
    if (variant.type !== "object") {
      throw new Error(`${context}.elements.${name} must resolve to an object.`);
    }
    variants[name] = mergeObjectSchemas(
      base,
      variant,
      `${context}.elements.${name}`
    );
  }
  return { ...base, discriminator: node.discriminator, variants };
}

function literalUnion(node, types, context) {
  if (!Array.isArray(node.elements) || node.elements.length === 0) {
    throw new Error(`${context}.elements must be a nonempty array.`);
  }
  const literals = node.elements.map((reference, index) =>
    referencedNode(types, reference, `${context}.elements[${index}]`)
  );
  if (literals.some(({ node: item }) => item.$type !== "StringLiteralType")) {
    return null;
  }
  const result = {
    type: "string",
    enum: [...new Set(literals.map(({ node: item }) => item.value))].sort()
  };
  for (const { node: item } of literals) {
    if (typeof item.value !== "string") {
      throw new Error(`${context} contains a non-string literal.`);
    }
    if (item.sensitive === true) result.sensitive = true;
  }
  return result;
}

function normalizeTypeNode(node, types, active, context) {
  switch (node.$type) {
    case "AnyType":
      return { type: "any" };
    case "NullType":
      return { type: "null" };
    case "BooleanType":
      return { type: "boolean" };
    case "IntegerType": {
      const result = { type: "integer" };
      if (node.minValue !== undefined) result.minimum = node.minValue;
      if (node.maxValue !== undefined) result.maximum = node.maxValue;
      return result;
    }
    case "StringType": {
      const result = { type: "string" };
      if (node.minLength !== undefined) result.minLength = node.minLength;
      if (node.maxLength !== undefined) result.maxLength = node.maxLength;
      if (node.pattern !== undefined) result.pattern = node.pattern;
      if (node.sensitive === true) result.sensitive = true;
      return result;
    }
    case "StringLiteralType": {
      if (typeof node.value !== "string") {
        throw new Error(`${context}.value must be a string.`);
      }
      const result = { type: "string", const: node.value };
      if (node.sensitive === true) result.sensitive = true;
      return result;
    }
    case "ArrayType": {
      const result = {
        type: "array",
        items: normalizeTypeReference(
          node.itemType,
          types,
          active,
          `${context}.itemType`
        )
      };
      if (node.minLength !== undefined) result.minItems = node.minLength;
      if (node.maxLength !== undefined) result.maxItems = node.maxLength;
      return result;
    }
    case "ObjectType":
      return normalizeObject(node, types, active, context);
    case "DiscriminatedObjectType":
      return normalizeDiscriminatedObject(node, types, active, context);
    case "UnionType": {
      const literals = literalUnion(node, types, context);
      if (literals !== null) return literals;
      return {
        oneOf: node.elements.map((reference, index) =>
          normalizeTypeReference(
            reference,
            types,
            active,
            `${context}.elements[${index}]`
          )
        )
      };
    }
    default:
      throw new Error(
        `${context} uses unsupported generated type kind "${node.$type}".`
      );
  }
}

export function normalizeTypeReference(
  reference,
  types,
  active = new Set(),
  context = "type"
) {
  const index = localIndex(reference, context);
  if (active.has(index)) {
    throw new Error(
      `${context} contains a recursive type cycle at node ${index}.`
    );
  }
  const node = generatedNode(types, index, context);
  active.add(index);
  try {
    return normalizeTypeNode(node, types, active, `generated type ${index}`);
  } finally {
    active.delete(index);
  }
}

function sameReference(left, right) {
  return (
    isObject(left) &&
    isObject(right) &&
    Object.keys(left).length === 1 &&
    Object.keys(right).length === 1 &&
    left.$ref === right.$ref
  );
}

export function buildSchema(types, rootIndex) {
  validateTypes(types);
  const root = generatedNode(types, rootIndex, "resource root");
  if (root.$type !== "ResourceType") {
    throw new Error(
      `Generated resource root ${rootIndex} is not ResourceType.`
    );
  }
  const bodyRef = referencedNode(types, root.body, "generated resource body");
  const body = bodyRef.node;
  if (body.$type !== "ObjectType") {
    throw new Error("Generated resource body must resolve to ObjectType.");
  }
  requireObject(body.properties, "Generated resource body properties");

  let nestedProperties = {};
  const propertiesEnvelope = body.properties.properties;
  if (propertiesEnvelope !== undefined) {
    const nested = referencedNode(
      types,
      propertiesEnvelope.type,
      "generated resource properties envelope"
    ).node;
    if (nested.$type !== "ObjectType") {
      throw new Error(
        "Generated properties envelope must resolve to ObjectType."
      );
    }
    nestedProperties = requireObject(
      nested.properties,
      "Generated nested resource properties"
    );
  }

  const normalized = { properties: {}, required: [] };
  const active = new Set([rootIndex, bodyRef.index]);
  for (const [name, property] of sortedEntries(body.properties)) {
    requireObject(property, `Generated resource body property "${name}"`);
    const flags = decodePropertyFlags(
      property.flags,
      `Generated resource body property "${name}"`
    );
    // Radius repeats read-only properties at the body root when the same type
    // already appears in the properties envelope. Omit only those exact mirrors
    // so the model sees one output path without hiding anything it can author.
    if (
      name !== "properties" &&
      !flags.writable &&
      isObject(nestedProperties[name]) &&
      sameReference(property.type, nestedProperties[name].type)
    ) {
      continue;
    }
    const propertySchema = normalizeProperty(
      property,
      types,
      active,
      `Generated resource body property "${name}"`
    );
    normalized.properties[name] = propertySchema.schema;
    if (propertySchema.required) normalized.required.push(name);
  }

  return objectSchema(
    normalized,
    body.additionalProperties === undefined ?
      false
    : normalizeTypeReference(
        body.additionalProperties,
        types,
        active,
        "generated resource body additionalProperties"
      ),
    body.sensitive === true
  );
}

function noRetry(text) {
  return Object.assign(new Error(text), { noRetry: true });
}

async function readBoundedText(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw noRetry(`Response exceeded ${maxBytes} bytes.`);
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw noRetry(`Response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function fetchJson(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024
  } = {}
) {
  const source = new URL(url);
  if (
    source.protocol !== "https:" ||
    source.hostname !== "raw.githubusercontent.com"
  ) {
    throw new Error(`Refusing unsupported source URL "${url}".`);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal
      });
      if (response.redirected) {
        throw noRetry("Source request redirected unexpectedly.");
      }
      if (!response.ok) {
        const error = new Error(
          `Source request failed with HTTP ${response.status}.`
        );
        error.noRetry = !(
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        );
        throw error;
      }
      const text = await readBoundedText(response, maxBytes);
      try {
        return { value: JSON.parse(text), text };
      } catch {
        throw noRetry("Source returned invalid JSON.");
      }
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const resolved =
        timedOut ?
          new Error(`Source request timed out after ${timeoutMs}ms.`)
        : error;
      if (attempt === 1 || error?.noRetry === true) throw resolved;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Source request failed.");
}

function defaultCacheRoot(home = os.homedir()) {
  return path.join(
    home,
    ".radius",
    "ai-extensions",
    "cache",
    "radius-resource-types",
    "v1"
  );
}

function cacheFile(cacheRoot, commit, relativePath) {
  return path.join(cacheRoot, commit, ...relativePath.split("/"));
}

async function pruneCachedCommits(
  currentCommit,
  { cacheRoot = defaultCacheRoot(), warn = (text) => console.error(text) } = {}
) {
  let entries;
  try {
    entries = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    warn(
      `Warning: could not inspect Radius definition cache: ${message(error)}`
    );
    return;
  }

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !COMMIT_DIRECTORY.test(entry.name) ||
      entry.name.toLowerCase() === currentCommit.toLowerCase()
    ) {
      continue;
    }
    try {
      await fsp.rm(path.join(cacheRoot, entry.name), {
        recursive: true,
        force: true
      });
    } catch (error) {
      warn(
        `Warning: could not prune stale Radius definition cache "${entry.name}": ${message(error)}`
      );
    }
  }
}

async function unlink(file) {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readCache(file, validate) {
  try {
    const value = JSON.parse(await fsp.readFile(file, "utf8"));
    validate(value);
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") await unlink(file).catch(() => {});
    return undefined;
  }
}

async function writeCache(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    await fsp.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await fsp.rename(temporary, file);
  } finally {
    await unlink(temporary).catch(
      // This requires the temporary file to become unremovable concurrently.
      /* v8 ignore next */
      () => {}
    );
  }
}

async function loadGeneratedJson(
  relativePath,
  commit,
  validate,
  {
    cacheRoot = defaultCacheRoot(),
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = 15_000,
    maxResponseBytes = 5 * 1024 * 1024,
    skipCache = false,
    warn = (text) => console.error(text)
  } = {}
) {
  const file = cacheFile(cacheRoot, commit, relativePath);
  if (!skipCache) {
    const cached = await readCache(file, validate);
    if (cached !== undefined) return { value: cached, cached: true, file };
  }
  const url = `${GENERATED_ROOT}/${commit}/${GENERATED_PATH}/${relativePath}`;
  const fetched = await fetchJson(url, {
    fetchImpl,
    timeoutMs: fetchTimeoutMs,
    maxBytes: maxResponseBytes
  });
  validate(fetched.value);
  try {
    await writeCache(file, fetched.text);
  } catch (error) {
    warn(`Warning: could not cache Radius definitions: ${message(error)}`);
  }
  return { value: fetched.value, cached: false, file };
}

export async function resolveRadiusTypes(selectors, options = {}) {
  const parsed = [
    ...new Map(
      selectors.map((selector) => {
        const parsedSelector =
          typeof selector === "string" ?
            parseResourceSelector(selector)
          : selector;
        return [
          `${parsedSelector.type}@${parsedSelector.apiVersion ?? ""}`,
          parsedSelector
        ];
      })
    ).values()
  ];
  const requested = parsed.map(
    (selector) =>
      `${selector.type}${selector.apiVersion ? `@${selector.apiVersion}` : ""}`
  );
  let current = requested.join(", ");
  let stage = "managed Radius identity";
  try {
    const identity =
      options.identity ?
        parseRadiusIdentity(JSON.stringify(options.identity))
      : await queryManagedRadiusIdentity(options);

    await pruneCachedCommits(identity.commit, options);

    stage = "generated resource index";
    const index = await loadGeneratedJson(
      "index.json",
      identity.commit,
      validateIndex,
      options
    );
    const loadedTypes = new Map();
    const resources = [];
    const notFound = [];
    for (const selector of parsed) {
      current = `${selector.type}${selector.apiVersion ? `@${selector.apiVersion}` : ""}`;
      stage = "resource selection";
      let selected;
      try {
        selected = selectResource(index.value, selector);
      } catch (error) {
        if (!(error instanceof DefinitionNotFoundError)) throw error;
        notFound.push({
          type: selector.type,
          message: error.message
        });
        continue;
      }

      stage = "generated namespace definitions";
      let types = loadedTypes.get(selected.reference.relativePath);
      if (types === undefined) {
        types = await loadGeneratedJson(
          selected.reference.relativePath,
          identity.commit,
          validateTypes,
          options
        );
        loadedTypes.set(selected.reference.relativePath, types);
      }

      stage = "generated resource contract";
      let schema;
      try {
        schema = buildSchema(types.value, selected.reference.index);
      } catch (error) {
        if (!types.cached) throw error;
        await unlink(types.file).catch(
          // This requires a valid cached file to become unremovable concurrently.
          /* v8 ignore next */
          () => {}
        );
        types = await loadGeneratedJson(
          selected.reference.relativePath,
          identity.commit,
          validateTypes,
          { ...options, skipCache: true }
        );
        loadedTypes.set(selected.reference.relativePath, types);
        schema = buildSchema(types.value, selected.reference.index);
      }

      resources.push({
        type: selected.type,
        apiVersion: selected.apiVersion,
        schema
      });
    }

    return {
      contractVersion: CONTRACT_VERSION,
      extension: identity.extension,
      resources,
      notFound
    };
  } catch (error) {
    throw new Error(
      `Could not resolve "${current}" during ${stage}: ${message(error)}`,
      { cause: error }
    );
  }
}

export async function main(
  args = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    resolve = resolveRadiusTypes,
    writeConfig = writeStagedBicepConfig
  } = {}
) {
  try {
    const parsed = parseArguments(args);
    if (parsed.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const stagingDir = validateStagingDirectory(parsed.stagingDir);
    const contract = await resolve(parsed.selectors);
    const output = `${JSON.stringify({
      contractVersion: contract.contractVersion,
      resources: contract.resources,
      notFound: contract.notFound
    })}\n`;
    if (contract.notFound.length > 0) {
      stdout.write(output);
      return 1;
    }
    await writeConfig(stagingDir, contract.extension);
    stdout.write(output);
    return 0;
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return error?.exitCode === 2 ? 2 : 1;
  }
}

// Direct execution is verified in a child process, whose V8 data Vitest cannot merge.
/* v8 ignore next 7 */
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
