#!/usr/bin/env node

// Resolves predefined Radius resource types for an application-modeling run.
// It asks the extension-managed `rad` binary for the exact Radius commit,
// downloads that release's generated Bicep definitions from a pinned source,
// converts them into compact model-facing schemas, and wires the matching
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

const CONTRACT_VERSION = 1;
const GENERATED_ROOT =
  "https://raw.githubusercontent.com/radius-project/radius";
const GENERATED_PATH = "hack/bicep-types-radius/generated";
// This exact SHA pattern is the safety boundary around the only recursive
// removal below ~/.radius. Never broaden it to accept arbitrary directory names.
const COMMIT_DIRECTORY = /^[0-9a-f]{40}$/iu;
// These copies must stay behavior-compatible with
// packages/core/src/modeling/app-staging.ts. This script cannot import core in
// the installed plugin; the runtime test imports core and guards against drift.
const STAGING_DIR_PREFIX = ".staging-";
const STAGING_RUN_RECORD = "run.json";
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

export async function fetchJson(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024,
    sleep = defaultSleep
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
        if (!error.noRetry) error.retryDelayMs = retryDelay(response.headers);
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
