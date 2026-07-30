// Node-runtime `rad` CLI graph builder.
//
// Builds modeled application graphs by running the real
// `rad app graph <app.bicep> --include-icons`
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
//   - The managed binary lives at a stable path under os.homedir(), never
//     import.meta (adapters bundle this file into a single artifact).
//   - Windows: `.exe` suffix, no chmod.
//   - The first resolution per process verifies the installed rad is at least
//     as new as the latest published release and upgrades it if it is older.
//     This is best-effort: any failure (offline, unreadable version) keeps the
//     existing binary. It is skipped entirely via RADIUS_RAD_SKIP_VERSION_CHECK,
//     and a RADIUS_RAD_BINARY override is never replaced.

import { spawn } from "node:child_process";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationGraphToResources, filterGraphVisualizationResources } from "@radius-project/core";

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const RELEASES_API = "https://api.github.com/repos/radius-project/radius/releases/latest";
// Stable extension-owned location. This intentionally does not use PATH or the
// official ~/.rad/bin install, so automatic updates never replace a user's CLI.
export const MANAGED_RAD_BIN = path.join(os.homedir(), ".radius", "ai-extensions", "bin");
export const MANAGED_RAD_PATH = path.join(MANAGED_RAD_BIN, `rad${EXE}`);

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
export const MODELED_APP_GRAPH_FLAGS = Object.freeze(["--include-icons"]);

// Serializes concurrent ensureRadBinary() callers so only one download runs.
let ensurePromise = null;
let cachedRadPath = null;

function noop() {}

// Maps Node's platform/arch onto the GitHub release asset naming used by rad
// (rad_<os>_<arch>[.exe]).
export function releaseAsset(platform = process.platform, architecture = process.arch) {
  const osName = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
  // Radius currently publishes only an amd64 Windows binary. Windows on ARM64
  // runs it through the OS x64 compatibility layer.
  const arch =
    platform === "win32"
      ? { x64: "amd64", arm64: "amd64" }[architecture]
      : { x64: "amd64", arm64: "arm64", arm: "arm" }[architecture];
  if (!osName || !arch) {
    throw new Error(`Unsupported platform for rad: ${platform}/${architecture}`);
  }
  return `rad_${osName}_${arch}${platform === "win32" ? ".exe" : ""}`;
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
// Longest a waiter blocks for a peer process's in-flight download to publish.
const DOWNLOAD_WAIT_MS = 120000;

/**
 * tryAcquireLock - best-effort cross-process lock via an exclusive file create.
 * Returns a release() function on success, or null if another process holds a
 * fresh lock. A stale lock (mtime older than LOCK_STALE_MS) is reaped and the
 * acquisition retried once. Exported for deterministic unit testing.
 *
 * Correctness does not depend on this lock: it only avoids a redundant ~70MB
 * download when two processes cold-start at the same instant. The atomic
 * temp->rename publish in downloadRad keeps concurrent writers safe on its own.
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

// Terminates rad and any bicep child it spawned. On Windows, `taskkill /t` kills
// the whole process tree; on POSIX, rad is a process-group leader (spawned
// detached), so signalling the group (-pid) stops rad and its children together.
// Best-effort — any failure is swallowed.
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

/**
 * resolveExistingRadBinary - locate a usable `rad` without downloading.
 * Order: RADIUS_RAD_BINARY env -> the stable extension-owned managed path.
 * PATH and the user's official ~/.rad/bin install are deliberately ignored.
 */
export function resolveExistingRadBinary(managedPath = MANAGED_RAD_PATH) {
  const fromEnv = process.env.RADIUS_RAD_BINARY;
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;

  if (isExecutableFile(managedPath)) return managedPath;

  return null;
}

export function parseRadVersionOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const version = parsed && (parsed.version || (parsed.cli && parsed.cli.version));
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * radBinaryVersion - best-effort read of a rad binary's own CLI version by
 * running `rad version --cli --output json` and returning its `version` string
 * (e.g. "v0.44.0", or an edge build like "v0.60.0-rc1-1-gdeadbee"), or null when
 * it can't be determined. `rad version --cli` skips the control-plane check but
 * still shells out to the bicep binary (getCliVersionInfo -> bicep.Version() ->
 * `bicep --version`). A timeout plus process-tree kill is a hard backstop so a
 * wedged rad can never stall binary resolution beyond `timeout`. (If bicep isn't
 * installed, rad returns fast with a "bicep not installed" note and still emits
 * `version`.) Never throws — a null result means "version unknown", which callers
 * treat as "leave the existing binary in place".
 */
export function radBinaryVersion(radPath, { timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // detached: on Windows, spawning rad inside the parent's job/process group
      // can wedge the child so it never exits; giving it its own process group
      // avoids that. The timeout + killChildTree below are the hard backstop.
      // (windowsHide is best-effort: Windows ignores it under detached, so a
      // brief console window may still appear.)
      child = spawn(radPath, ["version", "--cli", "--output", "json"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        detached: true,
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      finish(null);
    }, timeout);

    child.stdout?.on("data", (c) => {
      if (stdout.length < 1024 * 1024) stdout += c.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(parseRadVersionOutput(stdout));
    });
  });
}

// Parses the numeric major.minor.patch core out of a version string
// ("v1.2.3", "1.2.3-rc1-1-gdeadbee", "1.2.3+build") into [major, minor, patch].
// Any prerelease/build suffix is intentionally ignored — only the core drives
// precedence here. Returns null when the string has no numeric major.minor.patch.
export function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    (value || "").trim(),
  );
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * compareVersions - compare the major.minor.patch core of two rad versions.
 * Returns -1 when a < b, 1 when a > b, and 0 when equal. When either string is
 * unparseable it returns 0, so callers fall back to leaving the current binary
 * in place rather than churning on an unexpected format. Prerelease and build
 * suffixes are intentionally ignored: a developer build with the same core
 * version as the latest release must not be replaced.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
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

async function downloadRad(log, { releaseInfo = null } = {}) {
  const { tag, assets } = releaseInfo || (await latestRelease());
  const asset = releaseAsset();
  const url = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
  const dest = MANAGED_RAD_PATH;
  const expected = expectedDigest(assets, asset, tag);
  fs.mkdirSync(MANAGED_RAD_BIN, { recursive: true });

  // True when the managed binary already exists and its core version is at least
  // the target release — the signal that no (further) download is needed.
  const upToDate = async () => {
    if (!isExecutableFile(dest)) return false;
    const current = await radBinaryVersion(dest);
    return current != null && compareVersions(current, tag) >= 0;
  };
  if (await upToDate()) return dest;

  // Serialize downloads across processes: if a peer is already fetching rad,
  // wait for it to publish instead of racing a second ~70MB pull. The atomic
  // rename below tolerates two writers, so the lock is only an optimization.
  const lockPath = `${dest}.download.lock`;
  const release = tryAcquireLock(lockPath);
  if (!release) {
    log(`Another process is downloading rad ${tag}; waiting...`);
    if ((await waitForFile(dest, DOWNLOAD_WAIT_MS)) && (await upToDate())) return dest;
    // Peer never published a new-enough binary in the window — fetch it
    // ourselves and let the atomic rename settle any tie.
  }

  let tmp = "";
  try {
    if (await upToDate()) return dest; // published while we acquired/waited

    log(`Downloading rad ${tag} (${asset})...`);
    const data = await httpGet(url);
    if (expected) {
      verifyChecksum(data, expected, tag, asset);
    } else {
      log(
        `Warning: rad ${tag} asset ${asset} has no SHA-256 digest available; skipping verification. Set RADIUS_RAD_SHA256 to enforce verification.`,
      );
    }
    tmp = `${dest}.${process.pid}.${crypto.randomUUID()}.download`;
    fs.writeFileSync(tmp, data);
    if (!IS_WIN) fs.chmodSync(tmp, 0o755);
    try {
      // Publish the verified download atomically.
      fs.renameSync(tmp, dest);
      tmp = "";
    } catch (err) {
      // Another writer may have published dest first. Accept a good binary;
      // otherwise surface the error so the previous binary is left untouched.
      if (await upToDate()) return dest;
      throw err;
    }
    log(`Installed rad to ${dest} (${expected ? `verified against ${expected.source}` : "unverified"})`);
    return dest;
  } finally {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    }
    if (release) release();
  }
}

/**
 * reconcileWithLatest - given an already-installed rad, make sure it is at least
 * as new as the latest published release. Returns the path to use: the existing
 * binary when it is up to date (or when the check can't run), or a freshly
 * downloaded latest binary when the existing one is older.
 *
 * Best-effort by design — any failure to reach the releases API or read the
 * local version leaves the existing binary in place, so offline/air-gapped use
 * keeps working. Set RADIUS_RAD_SKIP_VERSION_CHECK to skip the check entirely.
 */
async function reconcileWithLatest(existing, log) {
  if (process.env.RADIUS_RAD_SKIP_VERSION_CHECK) return existing;

  let latest;
  try {
    latest = await latestRelease();
  } catch (err) {
    log(`Could not check the latest rad release (${err?.message ?? err}); using the installed binary.`);
    return existing;
  }

  const localVersion = await radBinaryVersion(existing);
  if (!localVersion) {
    log(`Could not determine the version of ${existing}; using it as-is.`);
    return existing;
  }
  if (compareVersions(localVersion, latest.tag) >= 0) {
    return existing; // already equal to or newer than the latest release
  }

  // An explicit override is developer-owned and is never updated in place.
  const overridden =
    process.env.RADIUS_RAD_BINARY &&
    path.resolve(process.env.RADIUS_RAD_BINARY) === path.resolve(existing);
  if (overridden) {
    log(`Warning: RADIUS_RAD_BINARY rad ${localVersion} is older than the latest release ${latest.tag}; using it anyway. Unset RADIUS_RAD_BINARY to auto-upgrade.`);
    return existing;
  }

  log(`Installed rad ${localVersion} is older than the latest release ${latest.tag}; upgrading...`);
  try {
    return await downloadRad(log, { releaseInfo: latest });
  } catch (err) {
    log(`Could not upgrade rad to ${latest.tag} (${err?.message ?? err}); using ${localVersion}.`);
    return existing;
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
      // Only repair permissions on the extension-owned binary. An explicit
      // override is developer-owned and must never be modified.
      const managed =
        !process.env.RADIUS_RAD_BINARY &&
        path.resolve(existing) === path.resolve(MANAGED_RAD_PATH);
      if (!IS_WIN && managed) {
        try { fs.chmodSync(existing, 0o755); } catch { /* best-effort */ }
      }
      // Use the installed rad only if it is at least as new as the latest
      // release; otherwise reconcileWithLatest upgrades it (best-effort).
      cachedRadPath = await reconcileWithLatest(existing, log);
      return cachedRadPath;
    }
    const downloaded = await downloadRad(log);
    cachedRadPath = downloaded;
    return downloaded;
  })();

  ensurePromise.catch(() => {}).finally(() => { ensurePromise = null; });
  return ensurePromise;
}

/**
 * spawnRad - the process-handling core every managed-rad invocation needs:
 * spawn `radPath args`, capture stdout/stderr (capped at 32MB), and resolve
 * { stdout, stderr } on a zero exit or reject (with both streams attached) on a
 * non-zero exit, timeout, or spawn error. rad shells out to bicep as a
 * grandchild, so it spawns detached (rad leads its own process group), kills the
 * whole tree on timeout, and uses an exit/close grace window because that
 * grandchild can inherit and hold the stdio pipes open. `label` only names the
 * command in timeout/exit error messages; `env` is merged over process.env.
 * Exported for tests; managed-binary resolution lives in spawnManagedRad.
 */
export function spawnRad(radPath, args, { cwd, env = {}, timeout = 120000, label = "rad", log = noop } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(radPath, args, {
      cwd,
      env: { ...process.env, ...env },
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
      const err = new Error(`${label} timed out after ${timeout}ms`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeout);

    function finalize(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      try { child.stdout?.destroy(); } catch { /* best-effort */ }
      try { child.stderr?.destroy(); } catch { /* best-effort */ }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // rad prints Bicep compile errors (BCP*) to stdout, not stderr, so keep
        // both streams on the error for callers to surface.
        const err = new Error(`${label} exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
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

    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => finalize(code, signal), 2000);
    });
    child.on("close", (code, signal) => {
      if (exited) finalize(exited.code, exited.signal);
      else finalize(code, signal);
    });
  });
}

/**
 * spawnManagedRad - resolve the managed `rad` binary (ensureRadBinary; never
 * PATH/.rad/bin, honoring #170) and run it via spawnRad, merging `env` over
 * process.env. runRadAppGraph predates this helper and keeps its own inline
 * spawn to avoid churn in that heavily tested path.
 */
async function spawnManagedRad(args, { cwd, env = {}, timeout = 120000, label = "rad", log = noop } = {}) {
  const radPath = await ensureRadBinary({ log });
  return await spawnRad(radPath, args, { cwd, env, timeout, label, log });
}

/**
 * Argument builders for the two publish commands. Exported so tests can assert
 * the exact rad CLI invocation without spawning a process.
 */
export function bicepPublishExtensionArgs(fromFile, target) {
  return ["bicep", "publish-extension", "--from-file", fromFile, "--target", target, "--force"];
}
export function bicepPublishArgs(file, target) {
  return ["bicep", "publish", "--file", file, "--target", target];
}

/**
 * runRadBicepPublishExtension - compile a resource-type manifest into a local
 * Bicep extension via the managed rad binary:
 *   rad bicep publish-extension --from-file <manifest> --target <target> --force
 * `target` is a local file path (a .tgz), so this needs no registry auth.
 * Returns the resolved target path on success; throws with rad's output on
 * failure.
 */
export async function runRadBicepPublishExtension({ fromFile, target, log = noop, timeout = 120000 } = {}) {
  const from = path.resolve(fromFile);
  const to = path.resolve(target);
  try {
    await spawnManagedRad(
      bicepPublishExtensionArgs(from, to),
      { cwd: path.dirname(to), timeout, label: "rad bicep publish-extension", log },
    );
    return to;
  } catch (err) {
    throw new Error(`rad bicep publish-extension failed: ${radErrorDetail(err)}`);
  }
}

/**
 * runRadBicepPublish - publish a Bicep file to an OCI registry via the managed
 * rad binary:
 *   rad bicep publish --file <file> --target <br:HOST/PATH:TAG>
 * Publishing to a registry requires the process environment to already be
 * authenticated for that registry; the caller passes that auth through `env`
 * (for example the GHCR credentials the extension already manages). Returns the
 * target reference on success; throws with rad's output on failure.
 */
export async function runRadBicepPublish({ file, target, env = {}, log = noop, timeout = 120000 } = {}) {
  const src = path.resolve(file);
  try {
    await spawnManagedRad(
      bicepPublishArgs(src, target),
      { cwd: path.dirname(src), env, timeout, label: "rad bicep publish", log },
    );
    return target;
  } catch (err) {
    throw new Error(`rad bicep publish failed: ${radErrorDetail(err)}`);
  }
}

/**
 * radErrorDetail - pull the most useful message out of a rejected spawnManagedRad
 * error, preferring stderr, then stdout (rad prints BCP* errors there), then the
 * error message.
 */
function radErrorDetail(err) {
  const stderr = (err && err.stderr ? String(err.stderr) : "").trim();
  const stdout = (err && err.stdout ? String(err.stdout) : "").trim();
  return stderr || stdout || (err && err.message) || "unknown error";
}

/**
 * resolveRadForGraph - resolve a `rad` binary to run `rad app graph` WITHOUT
 * running the version check or a download on the hot path. The `rad version --cli`
 * check (and any resulting upgrade) runs in the ensureRadBinary() warm-up on every
 * extension load; a graph build reuses that result rather than repeating it.
 * Resolution order:
 *   1. the binary the load-time ensureRadBinary() has already cached, else
 *   2. a binary already present on disk (RADIUS_RAD_BINARY or the managed path),
 *      used as-is with no version check, else
 *   3. as a fallback when the cache is empty and nothing is on disk yet (e.g. the
 *      load-time ensure has not finished resolving), call ensureRadBinary(),
 *      reusing the in-flight load-time ensure if one is running.
 */
export async function resolveRadForGraph({ log = noop } = {}) {
  if (cachedRadPath && isExecutableFile(cachedRadPath)) return cachedRadPath;
  const existing = resolveExistingRadBinary();
  if (existing) return existing;
  return ensureRadBinary({ log });
}

/**
 * runRadAppGraph - run
 * `rad app graph <file>.bicep --include-icons` in a throwaway working dir and
 * return the parsed app-graph.json it writes there. The modeled command must not
 * use `--preview`, which switches rad to the deployed-application API path.
 *
 * When `saveGraphJsonTo` is an absolute path, the raw app-graph.json produced by
 * the rad CLI is also copied there (parent directories created as needed) so the
 * generated graph is persisted alongside the app.bicep it was built from. A
 * failure to save is logged but never fails the graph build.
 */
export async function runRadAppGraph(bicepFilePath, { log = noop, timeout = 120000, saveGraphJsonTo = "" } = {}) {
  const radPath = await resolveRadForGraph({ log });
  // Resolve to an absolute path: rad runs from a temp cwd, so a relative arg
  // would no longer point at the file.
  const absoluteBicep = path.resolve(bicepFilePath);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rad-graph-"));
  try {
    await new Promise((resolve, reject) => {
      // `rad app graph` shells out to bicep as a grandchild and writes
      // app-graph.json into the temp cwd. The child reference is kept (no unref)
      // so Node awaits it and reads the file it wrote. The timeout below is a
      // hard backstop.
      const child = spawn(radPath, ["app", "graph", absoluteBicep, ...MODELED_APP_GRAPH_FLAGS], {
        cwd,
        // Clear GITHUB_ACTIONS so rad writes app-graph.json locally instead of
        // committing to the radius-graph orphan branch. stdin is ignored so rad
        // never blocks waiting for interactive input. detached: on Windows,
        // running rad inside the parent's job/process group can wedge it so it
        // never exits; its own process group avoids that (timeout + killChildTree
        // back it up). windowsHide is best-effort under detached.
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
      // so stdout/stderr are complete. As a safety net, a short grace window
      // after `exit` (process gone, code known) finalizes with whatever output
      // was captured if `close` is delayed, so the build can never hang.
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
if (saveGraphJsonTo) {
  if (path.isAbsolute(saveGraphJsonTo)) saveGraphJson(saveGraphJsonTo, raw, log);
  else log(`Warning: saveGraphJsonTo must be an absolute path; ignoring: ${saveGraphJsonTo}`);
}
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
 * saveGraphJson - persist the raw app-graph.json emitted by `rad app graph` to
 * `destPath`, creating parent directories as needed. Saving is best-effort: a
 * failure is logged via the injected `log` and swallowed so it can never fail an
 * otherwise-successful graph build.
 */
export function saveGraphJson(destPath, raw, log = noop) {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, raw);
    log(`Saved application graph JSON to ${destPath}`);
  } catch (err) {
    log(`Warning: could not save app-graph.json to ${destPath}: ${String(err?.message ?? err)}`);
  }
}

// isOciExtensionRef - true when a bicepconfig extension alias points at an OCI
// registry (br:/oci:) rather than a local artifact file.
function isOciExtensionRef(ref) {
  return /^(br|oci):/i.test(ref);
}

// copyLocalExtensionArtifact - copy a local extension artifact (e.g. the
// custom-types .tgz a bicepconfig alias references) from the workspace `.radius/`
// into the compile dir, preserving its relative path so bicep resolves it next
// to bicepconfig.json. Refuses absolute or `..`-escaping references and is
// best-effort: a missing file or copy error is logged and skipped.
function copyLocalExtensionArtifact(srcRoot, destRoot, ref, log = noop) {
  try {
    const rel = ref.replace(/^\.[\\/]/, "");
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === "..")) {
      log(`Warning: skipping non-local extension artifact reference: ${ref}`);
      return;
    }
    const src = path.resolve(srcRoot, rel);
    const dest = path.resolve(destRoot, rel);
    if (!fs.existsSync(src)) {
      log(`Warning: extension artifact not found, skipping copy: ${src}`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (err) {
    log(`Warning: could not copy extension artifact ${ref}: ${String(err?.message ?? err)}`);
  }
}

/**
 * writeBicepCompileConfig - populate a temp compile dir with the effective
 * bicepconfig.json (and any local extension artifacts) a modeled app needs.
 *
 * When `radArtifactsDir` (a workspace or staged `.radius/`) has its own
 * bicepconfig.json, that file is used verbatim as the compile config so the
 * canvas compiles against the repository's exact configured contract: its
 * pinned `extensions.radius` reference, every additional extension alias (e.g.
 * a locally published `customTypes` -> ./custom-types.tgz), and every other
 * Bicep setting (analyzers, formatting, moduleAliases, cloud, ...) are all
 * preserved. Every extension alias pointing at a local file (not a `br:`/`oci:`
 * ref) is copied into `dir` preserving its relative path so bicep resolves it.
 * `extensibility` is force-enabled and a `radius` alias is backfilled from the
 * base only when the repo config omits it, so `extension radius` always
 * resolves; nothing else in the repo config is rewritten.
 *
 * The base RADIUS_BICEP_CONFIG is used only as a fallback when no applicable
 * repository bicepconfig.json exists or it is unreadable — that base still
 * compiles apps that only use `extension radius`. A missing/unreadable workspace
 * config is logged and skipped.
 */
export function writeBicepCompileConfig(dir, radArtifactsDir, log = noop) {
  let config = null;
  if (radArtifactsDir) {
    try {
      const wsConfigPath = path.join(radArtifactsDir, "bicepconfig.json");
      if (fs.existsSync(wsConfigPath)) {
        const ws = JSON.parse(fs.readFileSync(wsConfigPath, "utf8"));
        if (ws && typeof ws === "object" && !Array.isArray(ws)) {
          // Use the repository config verbatim, then ensure only what a Radius
          // compile requires (extensibility on, a resolvable `radius` alias).
          config = ws;
          if (typeof config.experimentalFeaturesEnabled !== "object" || config.experimentalFeaturesEnabled === null) {
            config.experimentalFeaturesEnabled = {};
          }
          config.experimentalFeaturesEnabled.extensibility = true;
          if (typeof config.extensions !== "object" || config.extensions === null) {
            config.extensions = {};
          }
          if (typeof config.extensions.radius !== "string") {
            config.extensions.radius = RADIUS_BICEP_CONFIG.extensions.radius;
          }
          for (const ref of Object.values(config.extensions)) {
            if (typeof ref !== "string") continue;
            if (!isOciExtensionRef(ref)) copyLocalExtensionArtifact(radArtifactsDir, dir, ref, log);
          }
        }
      }
    } catch (err) {
      log(`Warning: could not read repository bicepconfig.json; using the base Radius config: ${String(err?.message ?? err)}`);
      config = null;
    }
  }
  if (!config) {
    config = {
      experimentalFeaturesEnabled: { ...RADIUS_BICEP_CONFIG.experimentalFeaturesEnabled },
      extensions: { ...RADIUS_BICEP_CONFIG.extensions },
    };
  }
  log(`Compiling with radius extension: ${config.extensions.radius}`);
  fs.writeFileSync(path.join(dir, "bicepconfig.json"), JSON.stringify(config, null, 2));
}

/**
 * buildGraphViaRad - the single graph-assembly entry adapters use. Writes the
 * given Bicep content to a temp file, runs `rad app graph`, and converts the
 * result into the canvas resource array. Throws (surfaced to the UI) on failure
 * — there is no JS fallback.
 *
 * `saveGraphJsonTo`, when set to an absolute path, persists the raw
 * app-graph.json produced by the rad CLI to that location (e.g. the workspace's
 * `.radius/app-graph.json`, next to the app.bicep it was built from).
 *
 * `radArtifactsDir`, when set to a workspace `.radius/` directory, makes the
 * compile use that repository's applicable bicepconfig.json verbatim — its
 * pinned `extensions.radius` reference, additional extension aliases, local
 * extension artifacts (see writeBicepCompileConfig), and other Bicep settings —
 * so the canvas compiles against the repository's exact configured contract;
 * otherwise the base Radius config is used. When `cleanupRadArtifactsDir` is
 * true (e.g. a temp dir staged from a committed branch), `radArtifactsDir` is
 * removed after the compile.
 *
 * The returned array is passed through `filterGraphVisualizationResources`, the
 * shared visualization filter, so implementation-detail resources
 * (containerImages and their ghcr-registry-creds secret) are never rendered in
 * any graph state — modeled, planned, deployed, or diff. This is applied only
 * to the returned array; the raw app-graph.json saved above is left complete.
 */
export async function buildGraphViaRad(content, definitionFile = ".radius/app.bicep", { log = noop, saveGraphJsonTo = "", radArtifactsDir = "", cleanupRadArtifactsDir = false } = {}) {
  if (!content) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-bicep-"));
  const bicepFile = path.join(dir, "app.bicep");
  try {
    // Order matters: write bicepconfig.json (and copy any local extension
    // artifacts) before app.bicep so the extensions are in place when rad
    // compiles the Bicep. bicep looks for bicepconfig.json next to the .bicep.
    writeBicepCompileConfig(dir, radArtifactsDir, log);
    fs.writeFileSync(bicepFile, content);
    const appGraph = await runRadAppGraph(bicepFile, { log, saveGraphJsonTo });
    return filterGraphVisualizationResources(applicationGraphToResources(appGraph, definitionFile, content));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (cleanupRadArtifactsDir && radArtifactsDir) {
      try { fs.rmSync(radArtifactsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
