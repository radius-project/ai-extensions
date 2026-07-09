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

import { spawn } from "node:child_process";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationGraphToResources } from "@radius-project/core";

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const RELEASES_API = "https://api.github.com/repos/radius-project/radius/releases/latest";
// Single install + lookup location for rad, shared with the official rad CLI and
// `rad bicep download` (which drops bicep.exe here too). Downloads land here so
// there is exactly one place to look for the binary — no separate app-graph
// cache directory to keep in sync.
const RAD_HOME_BIN = path.join(os.homedir(), ".rad", "bin");

// Bicep config that registers the Radius extension. `rad app graph` compiles
// Bicep offline, but bicep still needs this file beside the .bicep to resolve
// `extension radius` + `Radius.*` types — it tells bicep where to pull the
// extension from (downloaded once from the ACR registry, like the bicep/rad
// binaries). Without it, compilation fails with `BCP204: Extension "radius" is
// not recognized`. This is the single source of truth reused by adapters that
// commit the same file into a repo's `.radius/` directory.
export const RADIUS_BICEP_CONFIG = {
  experimentalFeaturesEnabled: { extensibility: true },
  extensions: { radius: "br:biceptypes.azurecr.io/radius:latest" },
};
export const RADIUS_BICEP_CONFIG_JSON = JSON.stringify(RADIUS_BICEP_CONFIG, null, 2);

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

/**
 * resolveExistingRadBinary - locate a usable `rad` without downloading.
 * Order: RADIUS_RAD_BINARY env -> PATH -> ~/.rad/bin (the single install
 * location, also where a first-run download lands).
 */
export function resolveExistingRadBinary() {
  const fromEnv = process.env.RADIUS_RAD_BINARY;
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;

  const onPath = findOnPath();
  if (onPath) return onPath;

  const radHome = path.join(RAD_HOME_BIN, `rad${EXE}`);
  if (isExecutableFile(radHome)) return radHome;

  return null;
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

async function latestRelease() {
  const body = await httpGet(RELEASES_API, {
    Accept: "application/vnd.github+json",
    ...githubAuthHeaders(),
  });
  const parsed = JSON.parse(body.toString("utf8"));
  if (!parsed || !parsed.tag_name) {
    throw new Error("Could not determine latest rad release tag");
  }
  return { tag: parsed.tag_name, assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
}

// Normalizes a "sha256:<hex>" or bare-hex value to lowercase hex, or "" if none.
export function normalizeSha256(value) {
  return (value || "").trim().toLowerCase().replace(/^sha256:/, "");
}

// Determines the SHA-256 the download must match. An explicit RADIUS_RAD_SHA256
// pin (raw hex or "sha256:<hex>") always wins so operators can lock to a known
// build; otherwise the digest GitHub publishes for the release asset is used.
// Enforced by default: if neither is available we fail closed rather than run an
// unverified binary. Set RADIUS_RAD_SHA256 to override in that rare case.
export function expectedDigest(assets, assetName, tag) {
  const pinned = normalizeSha256(process.env.RADIUS_RAD_SHA256);
  if (pinned) return { hex: pinned, source: "RADIUS_RAD_SHA256" };

  const asset = assets.find((a) => a && a.name === assetName);
  const published = normalizeSha256(asset && asset.digest);
  if (published) return { hex: published, source: "GitHub release digest" };

  throw new Error(
    `rad ${tag} asset ${assetName} has no published SHA-256 digest; set RADIUS_RAD_SHA256 to install`,
  );
}

// Verifies downloaded bytes against the expected SHA-256 before the binary is
// ever cached or executed. A mismatch aborts the install so a corrupted or
// tampered download is never trusted.
function verifyChecksum(data, expected, tag, assetName) {
  const actual = crypto.createHash("sha256").update(data).digest("hex");
  if (actual !== expected.hex) {
    throw new Error(
      `rad ${tag} asset ${assetName} failed SHA-256 verification against ${expected.source}: expected ${expected.hex}, got ${actual}`,
    );
  }
}

async function downloadRad(log) {
  const { tag, assets } = await latestRelease();
  const asset = releaseAsset();
  const url = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
  // Install into the same ~/.rad/bin the official rad CLI uses, so resolution
  // and download share one location.
  const dest = path.join(RAD_HOME_BIN, `rad${EXE}`);
  if (isExecutableFile(dest)) return dest;

  // Resolve the expected digest before downloading so an unverifiable asset
  // fails fast without fetching ~70MB of binary we could never trust.
  const expected = expectedDigest(assets, asset, tag);

  log(`Downloading rad ${tag} (${asset})...`);
  fs.mkdirSync(RAD_HOME_BIN, { recursive: true });
  const data = await httpGet(url);
  verifyChecksum(data, expected, tag, asset);
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
  log(`Installed rad to ${dest} (verified against ${expected.source})`);
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
    await new Promise((resolve, reject) => {
      // `rad app graph` shells out to bicep as a grandchild. On Windows, Node
      // places spawned children in a Job Object by default; rad/bicep deadlock
      // at startup inside that job (rad produces zero output and never exits,
      // then surfaces as an opaque "Command failed" only when the timeout fires).
      // `detached: true` gives rad its own process group outside Node's job
      // object, which lets it (and its bicep grandchild) run to completion. We
      // keep the child reference (no unref) and settle on the `exit` event so we
      // still await it and read the app-graph.json it wrote.
      const child = spawn(radPath, ["app", "graph", absoluteBicep], {
        cwd,
        // Clear GITHUB_ACTIONS so rad writes app-graph.json locally instead of
        // committing to the radius-graph orphan branch. stdin is ignored so rad
        // never blocks waiting for interactive input.
        env: { ...process.env, GITHUB_ACTIONS: "" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Escape Node's Windows Job Object to avoid the rad/bicep startup hang.
        detached: process.platform === "win32",
      });

      const MAX = 32 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (c) => { if (stdout.length < MAX) stdout += c.toString(); });
      child.stderr?.on("data", (c) => { if (stderr.length < MAX) stderr += c.toString(); });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* best-effort */ }
        const err = new Error(`rad app graph timed out after ${timeout}ms`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }, timeout);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Detach from the (possibly grandchild-held) pipes so this process does
        // not stay alive waiting on them.
        try { child.stdout?.destroy(); } catch { /* best-effort */ }
        try { child.stderr?.destroy(); } catch { /* best-effort */ }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          // Preserve both streams: rad prints Bicep compile errors (BCP*) to
          // stdout, not stderr, so the error handler below needs stdout too.
          const err = new Error(
            `rad exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
          );
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        }
      });
    });
    const outFile = path.join(cwd, "app-graph.json");
    const raw = fs.readFileSync(outFile, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const stderr = (err && err.stderr ? String(err.stderr) : "").trim();
    const stdout = (err && err.stdout ? String(err.stdout) : "").trim();
    const detail = stderr || stdout || (err && err.message) || "unknown error";
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
  const configFile = path.join(dir, "bicepconfig.json");
  const bicepFile = path.join(dir, "app.bicep");
  try {
    // Order matters: write bicepconfig.json before app.bicep so the Radius
    // extension registry is in place when rad compiles the Bicep. bicep looks
    // for bicepconfig.json in the same directory as the .bicep file.
    fs.writeFileSync(configFile, RADIUS_BICEP_CONFIG_JSON);
    fs.writeFileSync(bicepFile, content);
    const appGraph = await runRadAppGraph(bicepFile, { log });
    return applicationGraphToResources(appGraph, definitionFile);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
