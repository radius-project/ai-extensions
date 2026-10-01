// Machine-local cache of compiled application graphs.
//
// `rad app graph` writes `app-graph.json` into a throwaway working directory,
// so every graph render used to recompile the model. This cache keeps the
// safety-projected graph that a successful compile produced, keyed by every
// input that can change the compiler's output, so a later render of the same
// definition skips the compile.
//
// Only this module writes entries, into a per-user directory. Graph files that
// sit in a repository or workspace are never read here: anyone who can push to
// a branch can write those, and the graph diff shown to reviewers must come
// from compiling the model, not from a file the branch author controls.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GRAPH_CACHE_FORMAT = 1;
export const GRAPH_CACHE_MAX_ENTRIES = 64;
// Set to a directory to relocate the cache, or to `off` to disable it.
export const GRAPH_CACHE_DIR_ENV = "RADIUS_GRAPH_CACHE_DIR";

const KEY_PATTERN = /^[0-9a-f]{64}$/u;
const ENTRY_SUFFIX = ".json";
const TEMP_SUFFIX = ".tmp";
const STALE_TEMP_MS = 10 * 60 * 1000;

type Logger = (message: string) => void;

export interface GraphCacheKeyInput {
  // Directory holding exactly the files the compiler reads: app.bicep,
  // bicepconfig.json, and any local extension artifacts it references.
  compileDir: string;
  radPath: string;
  bicepPath: string;
  flags: readonly string[];
}

export type CachedApplicationGraph = Record<string, unknown>;

function noop(): void {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * graphCacheDir - the cache directory, or null when the cache is disabled.
 * Resolved on every call so a changed home directory or override applies.
 */
export function graphCacheDir(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const override = env[GRAPH_CACHE_DIR_ENV]?.trim();
  if (override?.toLowerCase() === "off") return null;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".radius", "ai-extensions", "graph-cache");
}

// A binary's identity for cache purposes. An upgrade replaces the file, which
// changes its size or modification time, so entries from the old toolchain
// stop matching without spawning the binary to ask for its version.
function binaryIdentity(file: string): string {
  const resolved = path.resolve(file);
  try {
    const stat = fs.statSync(resolved);
    return `${resolved}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return `${resolved}|missing`;
  }
}

function compileInputs(root: string, relative = ""): string[] {
  const files: string[] = [];
  const entries = fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) =>
      a.name < b.name ? -1
      : a.name > b.name ? 1
      : 0
    );
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...compileInputs(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * graphCacheKey - SHA-256 over every input that can change `rad app graph`
 * output: the cache format, the rad and Bicep binaries, the CLI flags, and each
 * file in the compile directory. The effective bicepconfig.json already names
 * the Radius extension derived from the rad release, so the key tracks it too.
 * CRLF line endings in app.bicep are normalized, so a Windows checkout and the
 * LF blob on GitHub share one entry.
 */
export function graphCacheKey({
  compileDir,
  radPath,
  bicepPath,
  flags
}: GraphCacheKeyInput): string {
  const hash = createHash("sha256");
  // Length-prefixed fields keep adjacent values from running together.
  const field = (value: string | Buffer) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  field(`radius-graph-cache/v${GRAPH_CACHE_FORMAT}`);
  field(binaryIdentity(radPath));
  field(binaryIdentity(bicepPath));
  field(flags.join("\0"));
  for (const file of compileInputs(compileDir)) {
    field(file);
    const bytes = fs.readFileSync(path.join(compileDir, file));
    field(
      file === "app.bicep" ?
        Buffer.from(bytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8")
      : bytes
    );
  }
  return hash.digest("hex");
}

function entryPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}${ENTRY_SUFFIX}`);
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * readCachedGraph - the cached graph for `key`, or null on a miss. A corrupt
 * or mismatched entry is deleted and reported as a miss, so the caller simply
 * compiles again. A hit refreshes the entry's modification time, which pruning
 * uses as its recency order.
 */
export function readCachedGraph(
  cacheDir: string | null,
  key: string,
  log: Logger = noop
): CachedApplicationGraph | null {
  if (!cacheDir || !KEY_PATTERN.test(key)) return null;
  const file = entryPath(cacheDir, key);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const graph = isRecord(parsed) ? parsed.graph : null;
  if (
    !isRecord(parsed) ||
    parsed.format !== GRAPH_CACHE_FORMAT ||
    parsed.key !== key ||
    !isRecord(graph) ||
    !Array.isArray(graph.resources) ||
    !graph.resources.every(isRecord)
  ) {
    log(`Discarding an unreadable cached application graph: ${file}`);
    removeQuietly(file);
    return null;
  }
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    /* recency is advisory */
  }
  return graph;
}

/**
 * pruneGraphCache - keep the `maxEntries` most recently used entries and drop
 * temporary files abandoned by an interrupted write. Best-effort.
 */
export function pruneGraphCache(
  cacheDir: string,
  maxEntries = GRAPH_CACHE_MAX_ENTRIES,
  nowMs = Date.now()
): void {
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  const entries: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const file = path.join(cacheDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (name.endsWith(TEMP_SUFFIX)) {
      if (nowMs - mtimeMs > STALE_TEMP_MS) removeQuietly(file);
    } else if (
      name.endsWith(ENTRY_SUFFIX) &&
      KEY_PATTERN.test(name.slice(0, -ENTRY_SUFFIX.length))
    ) {
      entries.push({ file, mtimeMs });
    }
  }
  entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(maxEntries)
    .forEach((entry) => removeQuietly(entry.file));
}

/**
 * writeCachedGraph - store a compiled, safety-projected graph under `key`.
 * The entry is written to a temporary file and renamed into place, so a
 * concurrent reader sees either the old entry or the complete new one. A
 * failure is logged and never fails the graph build that produced the graph.
 */
export function writeCachedGraph(
  cacheDir: string | null,
  key: string,
  graph: object,
  log: Logger = noop,
  maxEntries = GRAPH_CACHE_MAX_ENTRIES
): void {
  if (!cacheDir || !KEY_PATTERN.test(key)) return;
  const temp = path.join(cacheDir, `${key}.${randomUUID()}${TEMP_SUFFIX}`);
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temp,
      JSON.stringify({ format: GRAPH_CACHE_FORMAT, key, graph }),
      { mode: 0o600 }
    );
    fs.renameSync(temp, entryPath(cacheDir, key));
  } catch (error) {
    removeQuietly(temp);
    log(
      `Warning: could not cache the application graph in ${cacheDir}: ${errorMessage(error)}`
    );
    return;
  }
  pruneGraphCache(cacheDir, maxEntries);
}
