// Node-runtime `rad` CLI graph builder.
//
// Builds application graphs by running the real `rad app graph <app.bicep>`
// command, which compiles Bicep with rad's embedded Bicep and writes
// `app-graph.json` entirely client-side (no Radius control plane). This module
// owns every impure, Node-only step that the pure `@radius-project/core`
// package must not depend on: locating or downloading the static `rad` binary,
// spawning it, and reading its output. The pure conversion into the canvas
// resource shape lives in `applicationGraphToResources` (radius-core).
//
// It is adapter-agnostic: it takes an injected `log` and has no knowledge of
// any specific adapter (canvas, GitHub, etc). Adapters import it from
// `@radius-project/shared`.
//
// Gotchas honored here:
//   - NEVER use console.log — an adapter's stdout may be a JSON-RPC channel.
//     Use the injected `log` for any user-visible message.
//   - `rad app graph` commits to a `radius-graph` orphan branch when
//     GITHUB_ACTIONS === "true"; we clear it in the child env so it always
//     writes app-graph.json locally.
//   - Binary paths resolve from os.homedir()/PATH, never import.meta (adapters
//     bundle this file into a single artifact).
//   - Windows: `.exe` suffix, no chmod.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationGraphToResources } from "@radius-project/core";

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const RELEASES_API = "https://api.github.com/repos/radius-project/radius/releases/latest";
const CACHE_ROOT = path.join(os.homedir(), ".radius", "app-graph-bin");

// Serializes concurrent ensureRadBinary() callers so only one download runs.
let ensurePromise = null;
let cachedRadPath = null;

function noop() {}

// Maps Node's platform/arch onto the GitHub release asset naming used by rad
// (rad_<os>_<arch>[.exe]).
function releaseAsset() {
  const osName = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64", arm: "arm" }[process.arch];
  if (!osName || !arch) {
    throw new Error(`Unsupported platform for rad: ${process.platform}/${process.arch}`);
  }
  return `rad_${osName}_${arch}${EXE}`;
}

function isExecutableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Finds `rad[.exe]` on PATH without shelling out.
function findOnPath() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, `rad${EXE}`);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

// Parses a vX.Y.Z(-prerelease) tag into comparable components. Returns null for
// tags that don't look like semver so they can be ignored during selection. The
// optional prerelease suffix is captured so a stable release can be ranked above
// a prerelease that shares the same major.minor.patch.
function parseSemver(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(tag);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] || null };
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  }
  // Equal core version: a stable release outranks a prerelease (v1.0.0 beats
  // v1.0.0-rc1). When both are prereleases, order their identifiers lexically so
  // selection stays deterministic instead of tie-breaking arbitrarily.
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && !b.prerelease) return 0;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

// Returns the highest-versioned cached download under
// ~/.radius/app-graph-bin/<tag>/rad[.exe], comparing tags as semver so that
// e.g. v0.10.0 wins over v0.9.0.
function findInCache() {
  let entries;
  try {
    entries = fs.readdirSync(CACHE_ROOT);
  } catch {
    return null;
  }
  const candidates = [];
  for (const tag of entries) {
    const binary = path.join(CACHE_ROOT, tag, `rad${EXE}`);
    if (!isExecutableFile(binary)) continue;
    candidates.push({ tag, binary, semver: parseSemver(tag) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.semver && b.semver) return compareSemver(a.semver, b.semver);
    if (a.semver) return 1; // prefer parseable semver over junk dirs
    if (b.semver) return -1;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });
  return candidates[candidates.length - 1].binary;
}

/**
 * resolveExistingRadBinary - locate a usable `rad` without downloading.
 * Order: RADIUS_RAD_BINARY env -> PATH -> ~/.rad/bin -> download cache.
 */
export function resolveExistingRadBinary() {
  const fromEnv = process.env.RADIUS_RAD_BINARY;
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;

  const onPath = findOnPath();
  if (onPath) return onPath;

  const radHome = path.join(os.homedir(), ".rad", "bin", `rad${EXE}`);
  if (isExecutableFile(radHome)) return radHome;

  return findInCache();
}

function githubAuthHeaders() {
  // The GitHub Releases API is rate-limited hard for unauthenticated callers,
  // which can make first-run downloads flaky on shared/CI IP addresses. If a
  // token happens to be in the environment, use it to get the authenticated
  // rate limit. No token is required for public release metadata.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "radius-app-graph", ...headers }, timeout: 30000 },
      (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          resp.resume();
          resolve(httpGet(resp.headers.location, headers));
          return;
        }
        if (resp.statusCode !== 200) {
          resp.resume();
          reject(new Error(`GET ${url} failed: HTTP ${resp.statusCode}`));
          return;
        }
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => resolve(Buffer.concat(chunks)));
        resp.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", reject);
  });
}

async function latestReleaseTag() {
  const body = await httpGet(RELEASES_API, {
    Accept: "application/vnd.github+json",
    ...githubAuthHeaders(),
  });
  const parsed = JSON.parse(body.toString("utf8"));
  if (!parsed || !parsed.tag_name) {
    throw new Error("Could not determine latest rad release tag");
  }
  return parsed.tag_name;
}

// Verifies a downloaded rad binary against an optional pinned SHA-256 supplied
// via RADIUS_RAD_SHA256 (raw hex or "sha256:<hex>"). No env var means no pin, so
// behavior is unchanged for callers that don't opt in; a mismatch aborts the
// install so a corrupted or tampered download is never cached or executed.
function verifyChecksum(data, tag) {
  const pinned = (process.env.RADIUS_RAD_SHA256 || "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!pinned) return;
  const actual = crypto.createHash("sha256").update(data).digest("hex");
  if (actual !== pinned) {
    throw new Error(
      `rad ${tag} download failed SHA-256 verification: expected ${pinned}, got ${actual}`,
    );
  }
}

async function downloadRad(log) {
  const tag = await latestReleaseTag();
  const asset = releaseAsset();
  const url = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
  const destDir = path.join(CACHE_ROOT, tag);
  const dest = path.join(destDir, `rad${EXE}`);
  if (isExecutableFile(dest)) return dest;

  log(`Downloading rad ${tag} (${asset})...`);
  fs.mkdirSync(destDir, { recursive: true });
  const data = await httpGet(url);
  verifyChecksum(data, tag);
  const tmp = `${dest}.${process.pid}.download`;
  fs.writeFileSync(tmp, data);
  if (!IS_WIN) fs.chmodSync(tmp, 0o755);
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    // Another process may have won the race and created dest already. Accept
    // the existing binary and clean up our temp copy.
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    if (isExecutableFile(dest)) return dest;
    throw err;
  }
  log(`Installed rad to ${dest}`);
  return dest;
}

/**
 * ensureRadBinary - return a path to a runnable `rad`, downloading once if none
 * is already installed. Concurrent callers share a single in-flight resolution.
 */
export function ensureRadBinary({ log = noop } = {}) {
  if (cachedRadPath && isExecutableFile(cachedRadPath)) {
    return Promise.resolve(cachedRadPath);
  }
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const existing = resolveExistingRadBinary();
    if (existing) {
      // Packaging or a partial extract may drop the exec bit — restore it.
      if (!IS_WIN) {
        try { fs.chmodSync(existing, 0o755); } catch { /* best-effort */ }
      }
      cachedRadPath = existing;
      return existing;
    }
    const downloaded = await downloadRad(log);
    cachedRadPath = downloaded;
    return downloaded;
  })();

  ensurePromise.catch(() => {}).finally(() => { ensurePromise = null; });
  return ensurePromise;
}

/**
 * runRadAppGraph - run `rad app graph <file>.bicep` in a throwaway working dir
 * and return the parsed app-graph.json it writes there.
 */
export async function runRadAppGraph(bicepFilePath, { log = noop, timeout = 120000 } = {}) {
  const radPath = await ensureRadBinary({ log });
  // Resolve to an absolute path: rad runs from a temp cwd, so a relative arg
  // would no longer point at the file.
  const absoluteBicep = path.resolve(bicepFilePath);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rad-graph-"));
  try {
    await execFileAsync(radPath, ["app", "graph", absoluteBicep], {
      cwd,
      // Clear GITHUB_ACTIONS so rad writes app-graph.json locally instead of
      // committing to the radius-graph orphan branch.
      env: { ...process.env, GITHUB_ACTIONS: "" },
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    const outFile = path.join(cwd, "app-graph.json");
    const raw = fs.readFileSync(outFile, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const stderr = (err && err.stderr ? String(err.stderr) : "").trim();
    const detail = stderr || (err && err.message) || "unknown error";
    throw new Error(`rad app graph failed: ${detail}`);
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * buildGraphViaRad - the single graph-assembly entry adapters use. Writes the
 * given Bicep content to a temp file, runs `rad app graph`, and converts the
 * result into the canvas resource array. Throws (surfaced to the UI) on failure
 * — there is no JS fallback.
 */
export async function buildGraphViaRad(content, definitionFile = ".radius/app.bicep", { log = noop } = {}) {
  if (!content) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-bicep-"));
  const bicepFile = path.join(dir, "app.bicep");
  try {
    fs.writeFileSync(bicepFile, content);
    const appGraph = await runRadAppGraph(bicepFile, { log });
    return applicationGraphToResources(appGraph, definitionFile);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
