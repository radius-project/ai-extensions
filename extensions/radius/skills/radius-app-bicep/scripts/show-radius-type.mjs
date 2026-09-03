#!/usr/bin/env node

// Resolves predefined Radius resource types for an application-modeling run.
// It asks the extension-managed `rad` binary for the exact Radius commit,
// downloads that release's generated Bicep definitions from a pinned source,
// converts them into compact model-facing schemas, includes exact matching
// definitions from the release-pinned Azure Recipe pack, and wires the matching
// Radius extension into the staged bicepconfig.json.
//
// This is executable code rather than prompt guidance so release selection,
// source confinement, cache safety, schema validation, and staged config
// updates cannot be skipped by an agent. The installed plugin has no workspace
// packages, so its staging constants intentionally mirror core and are guarded
// against drift by the runtime tests.

import {
  managedBicepEnv,
  spawnRad
} from "../../../../../packages/adapter-shared/src/rad-process.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefinitionNotFoundError,
  buildSchema,
  selectResource,
  validateGeneratedIndex,
  validateGeneratedTypes
} from "./radius-type-schema.mjs";

export {
  buildSchema,
  decodePropertyFlags,
  normalizeTypeReference,
  parseIndexReference,
  selectResource
} from "./radius-type-schema.mjs";
import {
  extractRecipeDefinition,
  parseAzureRecipePackPin,
  validateAzureRecipePack
} from "./radius-recipe-pack.mjs";

export {
  extractRecipeDefinition,
  parseAzureRecipePackPin
} from "./radius-recipe-pack.mjs";

const CONTRACT_VERSION = 1;
const GENERATED_ROOT =
  "https://raw.githubusercontent.com/radius-project/radius";
const GENERATED_PATH = "hack/bicep-types-radius/generated";
const RADIUS_DEFAULTS_PATH = "deploy/manifest/defaults.yaml";
const AZURE_RECIPE_PACK_PATH = "recipe-packs/azure/aks-recipepack.bicep";
const MANAGED_RECIPES_CACHE_PATH = "managed-recipes";
// This exact SHA pattern is the safety boundary around the only recursive
// removal below ~/.radius. Never broaden it to accept arbitrary directory names.
const COMMIT_DIRECTORY = /^[0-9a-f]{40}$/iu;
// These copies must stay behavior-compatible with
// packages/core/src/modeling/app-staging.ts. This script cannot import core in
// the installed plugin; the runtime test imports core and guards against drift.
const STAGING_DIR_PREFIX = ".staging-";
const STAGING_RUN_RECORD = "run.json";
// Where this script hands validate-bicep.mjs the one fact about a resolved type
// that the compiled ARM template cannot carry: whether each property is marked
// sensitive. A `@secure()` parameter is only a `securestring` by the time the
// checker sees it, and both `password: securePassword` and
// `password: secret.id` compile, so without the schema flag the checker cannot
// tell an inline sensitive value from a plain Secret resource ID. The checker
// runs offline against the template alone and has no catalog of its own, so the
// flag has to be staged here, where the schemas are already resolved.
//
// The name must stay in step with the copy in validate-bicep.mjs; the
// built-extension smoke test asserts the two packaged scripts agree.
const STAGING_RESOLVED_TYPES = "resolved-types.json";
const RESOLVED_TYPES_CONTRACT_VERSION = 1;
const RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5_000;
const USAGE =
  "Usage: show-radius-type.mjs --staging <directory> Radius.<namespace>/<type>[@<api-version>] [...]";

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
      const value = args[index + 1];
      if (
        stagingDir !== undefined ||
        typeof value !== "string" ||
        value.startsWith("-")
      ) {
        throw usageError();
      }
      stagingDir = value;
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
  const runFile = path.join(stagingDir, STAGING_RUN_RECORD);
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
    !path.basename(stagingDir).startsWith(STAGING_DIR_PREFIX) ||
    path.basename(stagingDir).length === STAGING_DIR_PREFIX.length
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

// Property sensitivity for one resolved type, taken from the schema this script
// already built. Credential inputs live in the properties envelope, which is
// where every Radius type puts them and the only place `validate-bicep.mjs`
// inspects, so the map is one level deep rather than a second copy of the whole
// schema. A discriminated envelope contributes its variants' properties too: a
// property is sensitive when any shape of the envelope marks it sensitive,
// because reporting a property the schema does treat as sensitive would fail a
// model that is correct.
export function propertySensitivity(schema) {
  const envelope = schema.properties;
  const properties = isObject(envelope) ? envelope.properties : undefined;
  if (!isObject(properties)) return {};
  const groups = [properties];
  if (isObject(properties.variants)) {
    groups.push(...Object.values(properties.variants));
  }
  const sensitivity = {};
  for (const group of groups) {
    if (!isObject(group) || !isObject(group.properties)) continue;
    for (const [name, property] of Object.entries(group.properties)) {
      sensitivity[name] =
        sensitivity[name] === true ||
        (isObject(property) && property.sensitive === true);
    }
  }
  return sensitivity;
}

// Whether one entry in the staged map is a usable `property -> sensitive`
// record. This is deliberately the same acceptance rule validate-bicep.mjs
// applies when it reads the file back. The two scripts cannot import each other
// in the installed plugin, so the rule is stated twice on purpose, in the same
// way the staging constants above mirror core; a runtime test asserts the two
// ends agree rather than trusting them to drift together.
function isPropertySensitivityEntry(entry) {
  return (
    isObject(entry) &&
    Object.values(entry).every((sensitive) => typeof sensitive === "boolean")
  );
}

// Records what the checker needs about the types this run resolved.
//
// The map is merged rather than replaced. A run may resolve types in more than
// one invocation, and rewriting the file would erase the earlier types, which
// the checker would then read as "never resolved" and report against a model
// that did resolve them.
export async function writeStagedResolvedTypes(stagingInput, resources) {
  if (resources.length === 0) return;
  const stagingDir = validateStagingDirectory(stagingInput);
  const staged = path.join(stagingDir, STAGING_RESOLVED_TYPES);
  let types = {};
  if (fs.existsSync(staged)) {
    let existing;
    try {
      existing = JSON.parse(await fsp.readFile(staged, "utf8"));
    } catch {
      throw new Error(`Could not parse staged resolved types "${staged}".`);
    }
    if (
      !isObject(existing) ||
      existing.contractVersion !== RESOLVED_TYPES_CONTRACT_VERSION ||
      !isObject(existing.types)
    ) {
      throw new Error(
        `Staged resolved types "${staged}" are not a version ${RESOLVED_TYPES_CONTRACT_VERSION} contract.`
      );
    }
    // Every entry being merged forward is validated, not just the envelope. An
    // entry this writer preserved unchecked would be written back out and only
    // rejected later by the checker, which reports against a file the user
    // never authored. Refusing here names the offending type at the step that
    // would have reproduced it. Dropping or repairing the entry instead would
    // be a success-shaped fallback over a file whose contents cannot be
    // trusted.
    for (const [type, entry] of Object.entries(existing.types)) {
      if (!isPropertySensitivityEntry(entry)) {
        throw new Error(
          `Staged resolved types "${staged}" do not map each property of "${type}" to a boolean.`
        );
      }
    }
    types = existing.types;
  }
  for (const resource of resources) {
    types[`${resource.type}@${resource.apiVersion}`] = propertySensitivity(
      resource.schema
    );
  }
  const sorted = {};
  for (const name of Object.keys(types).sort()) sorted[name] = types[name];
  await fsp.writeFile(
    staged,
    `${JSON.stringify({ contractVersion: RESOLVED_TYPES_CONTRACT_VERSION, types: sorted }, null, 2)}\n`
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
  processTimeoutMs = 10_000,
  runRadImpl = spawnRad
} = {}) {
  const binaries = managedBinaries(home);
  const rad =
    isExecutable(env.RADIUS_RAD_BINARY) ? env.RADIUS_RAD_BINARY : binaries.rad;
  if (!isExecutable(rad)) {
    throw new Error(`Extension-managed Radius binary not found at "${rad}".`);
  }
  try {
    const { stdout } = await runRadImpl(
      rad,
      ["version", "--cli", "--output", "json"],
      {
        env: managedBicepEnv(env, binaries.bicep),
        timeout: processTimeoutMs,
        label: "Managed Radius version query"
      }
    );
    return parseRadiusIdentity(stdout);
  } catch (error) {
    const detail = error?.stderr?.trim() || message(error);
    throw new Error(`Managed Radius version query failed: ${detail}`, {
      cause: error
    });
  }
}

function noRetry(text) {
  return Object.assign(new Error(text), { noRetry: true });
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(headers) {
  const value = headers.get("retry-after");
  if (value === null) return RETRY_DELAY_MS;

  const seconds = Number(value);
  const requested =
    Number.isFinite(seconds) && seconds >= 0 ?
      seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(requested)) return RETRY_DELAY_MS;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(RETRY_DELAY_MS, requested));
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

async function fetchText(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024,
    sleep = defaultSleep,
    accept = "text/plain"
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
    let delay;
    try {
      const response = await fetchImpl(url, {
        headers: { accept },
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
        if (!error.noRetry) error.retryDelayMs = retryDelay(response.headers);
        throw error;
      }
      return await readBoundedText(response, maxBytes);
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      if (timedOut) {
        throw new Error(`Source request timed out after ${timeoutMs}ms.`, {
          cause: error
        });
      }
      if (attempt === 1 || error?.noRetry === true) throw error;
      delay = error?.retryDelayMs ?? RETRY_DELAY_MS;
    } finally {
      clearTimeout(timer);
    }
    await sleep(delay);
  }
  throw new Error("Source request failed.");
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, {
    ...options,
    accept: "application/json"
  });
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw noRetry("Source returned invalid JSON.");
  }
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

  try {
    const now = new Date();
    await fsp.utimes(path.join(cacheRoot, currentCommit), now, now);
  } catch (error) {
    warn(
      `Warning: could not update the active Radius definition cache: ${message(error)}`
    );
  }

  const candidates = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !COMMIT_DIRECTORY.test(entry.name) ||
      entry.name.toLowerCase() === currentCommit.toLowerCase()
    ) {
      continue;
    }
    try {
      const stat = await fsp.stat(path.join(cacheRoot, entry.name));
      candidates.push({ name: entry.name, modified: stat.mtimeMs });
    } catch (error) {
      warn(
        `Warning: could not inspect Radius definition cache "${entry.name}": ${message(error)}`
      );
    }
  }

  let previous;
  for (const candidate of candidates) {
    if (previous === undefined || candidate.modified > previous.modified) {
      previous = candidate;
    }
  }

  for (const candidate of candidates) {
    if (candidate.name === previous?.name) continue;
    try {
      await fsp.rm(path.join(cacheRoot, candidate.name), {
        recursive: true,
        force: true
      });
    } catch (error) {
      warn(
        `Warning: could not prune stale Radius definition cache "${candidate.name}": ${message(error)}`
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
    sleep = defaultSleep,
    warn = (text) => console.error(text)
  } = {}
) {
  const file = cacheFile(cacheRoot, commit, relativePath);
  if (!skipCache) {
    const cached = await readCache(file, validate);
    if (cached !== undefined) {
      return { value: cached, cached: true, cacheReady: true, file };
    }
  }
  const url = `${GENERATED_ROOT}/${commit}/${GENERATED_PATH}/${relativePath}`;
  const fetched = await fetchJson(url, {
    fetchImpl,
    timeoutMs: fetchTimeoutMs,
    maxBytes: maxResponseBytes,
    sleep
  });
  validate(fetched.value);
  let cacheReady = false;
  try {
    await writeCache(file, fetched.text);
    cacheReady = true;
  } catch (error) {
    warn(`Warning: could not cache Radius definitions: ${message(error)}`);
  }
  return { value: fetched.value, cached: false, cacheReady, file };
}

async function loadCachedText(
  relativePath,
  commit,
  url,
  validate,
  {
    cacheRoot = defaultCacheRoot(),
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = 15_000,
    maxResponseBytes = 5 * 1024 * 1024,
    sleep = defaultSleep,
    warn = (text) => console.error(text)
  } = {}
) {
  const file = cacheFile(cacheRoot, commit, relativePath);
  let validationResult;
  const validateText = (value) => {
    if (typeof value !== "string") {
      throw new Error("Cached managed Recipe source must be text.");
    }
    validationResult = validate(value);
  };
  const cached = await readCache(file, validateText);
  if (cached !== undefined) {
    return { text: cached, validationResult };
  }

  const text = await fetchText(url, {
    fetchImpl,
    timeoutMs: fetchTimeoutMs,
    maxBytes: maxResponseBytes,
    sleep
  });
  validationResult = validate(text);
  try {
    await writeCache(file, JSON.stringify(text));
  } catch (error) {
    warn(
      `Warning: could not cache managed Radius Recipe source: ${message(error)}`
    );
  }
  return { text, validationResult };
}

async function loadManagedAzureRecipePack(releaseCommit, options) {
  const { validationResult: pin } = await loadCachedText(
    `${MANAGED_RECIPES_CACHE_PATH}/defaults.json`,
    releaseCommit,
    `${GENERATED_ROOT}/${releaseCommit}/${RADIUS_DEFAULTS_PATH}`,
    parseAzureRecipePackPin,
    options
  );
  const { text: source } = await loadCachedText(
    `${MANAGED_RECIPES_CACHE_PATH}/azure/${pin.commit}/aks-recipepack.json`,
    releaseCommit,
    `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/${AZURE_RECIPE_PACK_PATH}`,
    validateAzureRecipePack,
    options
  );
  return {
    repository: pin.repository,
    commit: pin.commit,
    path: AZURE_RECIPE_PACK_PATH,
    source
  };
}

export async function resolveRadiusTypes(selectors, options = {}) {
  const parsed = selectors.map((selector) =>
    typeof selector === "string" ? parseResourceSelector(selector) : selector
  );
  const requested = parsed.map(
    (selector) =>
      `${selector.type}${selector.apiVersion ? `@${selector.apiVersion}` : ""}`
  );
  let current = requested.join(", ");
  let stage = "managed Radius identity";
  try {
    const identity = await queryManagedRadiusIdentity(options);

    stage = "generated resource index";
    const index = await loadGeneratedJson(
      "index.json",
      identity.commit,
      validateGeneratedIndex,
      options
    );
    if (index.cacheReady) await pruneCachedCommits(identity.commit, options);
    const loadedTypes = new Map();
    const resources = [];
    const notFound = [];
    const resolvedKeys = new Set();
    const notFoundTypes = new Set();
    for (const selector of parsed) {
      current = `${selector.type}${selector.apiVersion ? `@${selector.apiVersion}` : ""}`;
      stage = "resource selection";
      let selected;
      try {
        selected = selectResource(index.value, selector);
      } catch (error) {
        if (!(error instanceof DefinitionNotFoundError)) throw error;
        if (notFoundTypes.has(selector.type)) continue;
        notFoundTypes.add(selector.type);
        notFound.push({
          type: selector.type,
          message: error.message
        });
        continue;
      }

      const resolvedKey = `${selected.type}@${selected.apiVersion}`;
      if (resolvedKeys.has(resolvedKey)) continue;
      resolvedKeys.add(resolvedKey);

      stage = "generated namespace definitions";
      let types = loadedTypes.get(selected.reference.relativePath);
      if (types === undefined) {
        types = await loadGeneratedJson(
          selected.reference.relativePath,
          identity.commit,
          validateGeneratedTypes,
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
          validateGeneratedTypes,
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

    if (resources.length > 0) {
      try {
        const pack = await loadManagedAzureRecipePack(identity.commit, options);
        for (const resource of resources) {
          try {
            const definition = extractRecipeDefinition(
              pack.source,
              resource.type
            );
            resource.recipe =
              definition === undefined ?
                {
                  status: "notFound",
                  provenance: "managed-release-default",
                  recipePack: "azure",
                  repository: pack.repository,
                  commit: pack.commit,
                  path: pack.path,
                  message: `The managed Azure Recipe pack does not contain a Recipe definition for "${resource.type}".`
                }
              : {
                  status: "available",
                  provenance: "managed-release-default",
                  recipePack: "azure",
                  repository: pack.repository,
                  commit: pack.commit,
                  path: pack.path,
                  definition
                };
          } catch (error) {
            const detail = message(error);
            resource.recipe = {
              status: "unavailable",
              provenance: "managed-release-default",
              recipePack: "azure",
              repository: pack.repository,
              commit: pack.commit,
              path: pack.path,
              message: detail
            };
            const warn = options.warn ?? ((text) => console.error(text));
            warn(
              `Warning: could not resolve the managed Azure Recipe for ${resource.type}: ${detail}`
            );
          }
        }
      } catch (error) {
        const detail = message(error);
        const recipe = {
          status: "unavailable",
          provenance: "managed-release-default",
          recipePack: "azure",
          message: detail
        };
        for (const resource of resources) resource.recipe = recipe;
        const warn = options.warn ?? ((text) => console.error(text));
        warn(
          `Warning: could not resolve the managed Azure Recipe pack: ${detail}`
        );
      }
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
    writeConfig = writeStagedBicepConfig,
    writeResolvedTypes = writeStagedResolvedTypes
  } = {}
) {
  try {
    const parsed = parseArguments(args);
    if (parsed.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const stagingDir = validateStagingDirectory(parsed.stagingDir);
    const contract = await resolve(parsed.selectors, {
      warn: (text) => stderr.write(`${text}\n`)
    });
    const output = `${JSON.stringify({
      contractVersion: contract.contractVersion,
      resources: contract.resources,
      notFound: contract.notFound
    })}\n`;
    await writeConfig(stagingDir, contract.extension);
    await writeResolvedTypes(stagingDir, contract.resources);
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
