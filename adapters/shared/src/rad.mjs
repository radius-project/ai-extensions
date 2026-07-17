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

// A lock older than this is treated as abandoned (owning process crashed) and
// reaped so a dead download can never wedge future ones.
const LOCK_STALE_MS = 5 * 60 * 1000;
// Longest we wait for a peer process's in-flight download to publish the binary
// before giving up and downloading ourselves.
const DOWNLOAD_WAIT_MS = 120000;

/**
 * tryAcquireLock - best-effort cross-process lock via an exclusive file create.
 * Returns a release() function on success, or null if another process holds a
 * fresh lock. A stale lock (mtime older than LOCK_STALE_MS) is reaped and the
 * acquisition retried once. Exported for deterministic unit testing.
 */
export function tryAcquireLock(lockPath) {
  const write = () => {
    const fd = fs.openSync(lockPath, "wx");
    try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    return () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ } };
  };
  try {
    return write();
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    // Someone holds it. Reap it only if it is stale, then retry the create.
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        return write();
      }
    } catch { /* lost the reap/retry race — treat as held */ }
    return null;
  }
}

// Polls until `file` exists (a peer finished its download) or the timeout
// elapses. Returns whether the file is present at the end.
async function waitForFile(file, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isExecutableFile(file)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return isExecutableFile(file);
}

// Terminates rad and its bicep grandchild. On Windows, `taskkill /t` kills the
// whole tree; on POSIX, rad leads its own process group (spawned detached) so a
// negative pid signals every process in that group. Falls back to a direct kill.
function killChildTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (IS_WIN) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* best-effort */ }
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
// When neither is available the download proceeds without verification — many
// upstream releases omit per-asset digests — and a warning is surfaced so
// operators know they can pin RADIUS_RAD_SHA256 for stricter integrity checks.
export function expectedDigest(assets, assetName, tag) {
  const pinned = normalizeSha256(process.env.RADIUS_RAD_SHA256);
  if (pinned) return { hex: pinned, source: "RADIUS_RAD_SHA256" };

  const asset = assets.find((a) => a && a.name === assetName);
  const published = normalizeSha256(asset && asset.digest);
  if (published) return { hex: published, source: "GitHub release digest" };

  // No digest available — allow the download but signal callers to skip
  // verification. Operators who need strict integrity can set RADIUS_RAD_SHA256.
  return null;
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

  const expected = expectedDigest(assets, asset, tag);
  fs.mkdirSync(RAD_HOME_BIN, { recursive: true });

  // Serialize downloads across processes: if a peer is already fetching rad,
  // wait for it to publish the binary instead of racing a second ~70MB pull.
  const lockPath = path.join(RAD_HOME_BIN, `rad${EXE}.download.lock`);
  const release = tryAcquireLock(lockPath);
  if (!release) {
    log(`Another process is downloading rad ${tag}; waiting...`);
    if (await waitForFile(dest, DOWNLOAD_WAIT_MS)) return dest;
    // Peer never finished within the window — fall through and download it
    // ourselves. The atomic rename below tolerates both writers.
  }

  try {
    // A peer may have published dest while we acquired/waited on the lock.
    if (isExecutableFile(dest)) return dest;

    log(`Downloading rad ${tag} (${asset})...`);
    const data = await httpGet(url);
    if (expected) {
      verifyChecksum(data, expected, tag, asset);
    } else {
      log(
        `Warning: rad ${tag} asset ${asset} has no SHA-256 digest available; skipping verification. Set RADIUS_RAD_SHA256 to enforce verification.`,
      );
    }
    const tmp = `${dest}.${process.pid}.download`;
    fs.writeFileSync(tmp, data);
    if (!IS_WIN) fs.chmodSync(tmp, 0o755);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      // Another writer may have created dest already. Accept the existing
      // binary and clean up our temp copy.
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      if (isExecutableFile(dest)) return dest;
      throw err;
    }
    log(`Installed rad to ${dest} (${expected ? `verified against ${expected.source}` : "unverified"})`);
    return dest;
  } finally {
    if (release) release();
  }
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
      // `rad app graph` shells out to bicep as a grandchild. Spawn rad detached
      // on every platform so it leads its own process group:
      //   - Windows: escapes Node's default Job Object, inside which rad/bicep
      //     deadlock at startup (rad produces zero output and never exits, then
      //     surfaces only when the timeout fires).
      //   - POSIX: makes rad a group leader so a timeout can kill the whole
      //     rad+bicep tree via the negative pid (see killChildTree).
      // We keep the child reference (no unref) so Node still awaits it and reads
      // the app-graph.json it wrote.
      const child = spawn(radPath, ["app", "graph", absoluteBicep], {
        cwd,
        // Clear GITHUB_ACTIONS so rad writes app-graph.json locally instead of
        // committing to the radius-graph orphan branch. stdin is ignored so rad
        // never blocks waiting for interactive input.
        env: { ...process.env, GITHUB_ACTIONS: "" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      });

      const MAX = 32 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let graceTimer = null;
      let exited = null;
      child.stdout?.on("data", (c) => { if (stdout.length < MAX) stdout += c.toString(); });
      child.stderr?.on("data", (c) => { if (stderr.length < MAX) stderr += c.toString(); });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        killChildTree(child);
        const err = new Error(`rad app graph timed out after ${timeout}ms`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }, timeout);

      function finalize(code, signal) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
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
      }

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      });

      // Prefer `close`: it fires once the process exited AND all stdio flushed,
      // so stdout/stderr are complete. But rad's bicep grandchild can inherit
      // and hold the pipes open, in which case `close` never fires. So on `exit`
      // (process gone, code known) we start a short grace window for `close`; if
      // it elapses we finalize with whatever output we captured, avoiding a hang.
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        if (settled || graceTimer) return;
        graceTimer = setTimeout(() => finalize(code, signal), 2000);
      });
      child.on("close", (code, signal) => {
        // `exit` fires before `close` and carries the authoritative code, so
        // prefer it when present (close's args can be null if killed via pipe).
        if (exited) finalize(exited.code, exited.signal);
        else finalize(code, signal);
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
