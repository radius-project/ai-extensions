// Node-runtime `rad` CLI graph builder.
//
// Builds modeled application graphs by running the real
// `rad app graph <app.bicep> --include-icons`
// command, which compiles through the extension-managed Bicep CLI and writes
// `app-graph.json` entirely client-side (no Radius control plane). This module
// owns every impure, Node-only step that the pure `@radius-project/core`
// package must not depend on: locating or downloading the static `rad` binary,
// spawning it, and reading its output. The pure conversion into the canvas
// resource shape lives in `applicationGraphToResources` (@radius-project/core).
//
// It is adapter-agnostic: it takes an injected `log` and has no knowledge of
// any specific adapter (canvas, GitHub, etc). Adapters import it from
// `@radius-project/adapter-shared`.
//
// Gotchas honored here:
//   - NEVER use console.log — an adapter's stdout may be a JSON-RPC channel.
//     Use the injected `log` for any user-visible message.
//   - The binaries live in the extension-owned ~/.radius/ai-extensions/bin
//     directory, never relative to import.meta (adapters bundle this file).
//   - Windows: `.exe` suffix, no chmod.
//   - The first resolution per process verifies the installed rad is at least
//     as new as the latest published release and upgrades it if it is older.
//     This is best-effort: any failure (offline, unreadable version) keeps the
//     existing binary. It is skipped entirely via RADIUS_RAD_SKIP_VERSION_CHECK,
//     and a RADIUS_RAD_BINARY override is never replaced.

import { spawn, type ChildProcess } from "node:child_process";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import {
  applicationGraphToResources,
  filterGraphVisualizationResources
} from "@radius-project/core";
import {
  killChildTree,
  managedBicepEnv as processManagedBicepEnv,
  radSpawnOptions,
  RadProcessError,
  spawnRad
} from "./rad-process.mjs";
import type { ProcessResult, SpawnRadOptions } from "./rad-process.mjs";

export { killChildTree, RadProcessError, spawnRad };
export type { ProcessResult, SpawnRadOptions };

// --- Shared named types -----------------------------------------------------
//
// This module's public surface is impure I/O (spawning processes, downloading
// releases, reading/writing files), so the types below name the shapes that
// cross those boundaries: the injected logger, captured process output,
// release/download metadata, and the options objects (including the
// dependency-injection seam `EnsureManagedBicepOptions.run`) adapters and
// tests configure it with.

/**
 * Progress/diagnostic sink every managed-rad operation reports through.
 * NEVER console.log — an adapter's stdout may be a JSON-RPC channel.
 */
export type Logger = (message: string) => void;

interface SpawnManagedRadOptions extends SpawnRadOptions {
  log?: Logger;
}

/**
 * The process-runner signature `ensureManagedBicep`'s `run` DI seam expects.
 * The resolved value is intentionally unobserved by every caller — only a
 * rejection is ever inspected — so it is typed `Promise<unknown>` rather than
 * `Promise<ProcessResult>`, which also lets tests substitute a fake that
 * resolves with whatever placeholder value is convenient.
 */
export type SpawnRadRunner = (
  radPath: string,
  args: string[],
  options: SpawnRadOptions
) => Promise<unknown>;

/** Options for {@link ensureManagedBicep}. */
export interface EnsureManagedBicepOptions {
  log?: Logger;
  timeout?: number;
  bicepPath?: string;
  run?: SpawnRadRunner;
}

/** A GitHub release asset, as returned by the releases API. */
export interface RadReleaseAsset {
  name: string;
  digest?: string;
}

/** The latest-release metadata `ensureRadBinary`/`downloadRad` act on. */
export interface RadReleaseInfo {
  tag: string;
  assets: RadReleaseAsset[];
}

/** The checksum a download must match, and where it came from. */
export interface ExpectedDigest {
  hex: string;
  source: string;
}

/**
 * The effective Bicep config `writeBicepCompileConfig` writes to disk. Every
 * setting beyond `experimentalFeaturesEnabled`/`extensions` (analyzers,
 * formatting, moduleAliases, ...) is repository-owned and passed through
 * untouched — hence the index signature.
 */
export interface BicepCompileConfig extends Record<string, unknown> {
  experimentalFeaturesEnabled: Record<string, unknown> & {
    extensibility: boolean;
  };
  extensions: Record<string, unknown> & { radius: string };
}

/** Options for {@link runRadAppGraph}. */
export interface RunRadAppGraphOptions {
  log?: Logger;
  timeout?: number;
  saveGraphJsonTo?: string;
  /** Platform whose process lifecycle semantics apply; defaults to this host. */
  processPlatform?: NodeJS.Platform;
  /** Poll cadence for completed graph artifacts after a successful exit. */
  artifactPollIntervalMs?: number;
  /** Maximum wait for inherited stdio to close after an authoritative exit. */
  exitCloseGraceMs?: number;
  /**
   * The already-resolved binary to spawn. Callers that read a release from a
   * binary before compiling pass it here so the version they pinned and the
   * process they run are the same binary; omitted, it is resolved here.
   */
  radPath?: string;
}

/** Options for {@link resolveRadiusExtensionRef}. */
export interface ResolveRadiusExtensionRefOptions {
  log?: Logger;
  /** The binary that will run the compile; located on disk when omitted. */
  radPath?: string;
  /** Injected locator so tests need not depend on the machine's install. */
  locateRadBinary?: () => string | null;
  /** Injected version reader so tests need not spawn a real binary. */
  readVersion?: (radPath: string) => Promise<string | null>;
}

/** Options for {@link buildGraphViaRad}. */
export interface BuildGraphViaRadOptions {
  log?: Logger;
  saveGraphJsonTo?: string;
  radArtifactsDir?: string;
  cleanupRadArtifactsDir?: boolean;
}

/** Options for {@link runRadBicepPublishExtension}. */
export interface RunRadBicepPublishExtensionOptions {
  fromFile: string;
  target: string;
  log?: Logger;
  timeout?: number;
}

/** Options for {@link runRadBicepPublish}. */
export interface RunRadBicepPublishOptions {
  file: string;
  target: string;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  timeout?: number;
}

// Narrows an unknown catch binding to a human-readable message without ever
// assuming it is an Error (a thrown value can be anything in JS/TS).
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

// Pulls the most useful message out of a rejected managed-rad invocation,
// preferring stderr, then stdout (rad prints BCP* errors there), then the
// error's own message.
function radErrorDetail(err: unknown): string {
  if (err instanceof RadProcessError) {
    const stderr = err.stderr.trim();
    const stdout = err.stdout.trim();
    if (stderr || stdout) return stderr || stdout;
  }
  return errorMessage(err) || "unknown error";
}

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const RELEASES_API =
  "https://api.github.com/repos/radius-project/radius/releases/latest";
// Stable extension-owned location. This intentionally does not use PATH or the
// official ~/.rad/bin install, so automatic updates never replace a user's CLI.
export const MANAGED_RAD_BIN = path.join(
  os.homedir(),
  ".radius",
  "ai-extensions",
  "bin"
);
export const MANAGED_RAD_PATH = path.join(MANAGED_RAD_BIN, `rad${EXE}`);
export const MANAGED_BICEP_PATH = path.join(MANAGED_RAD_BIN, `bicep${EXE}`);

export function managedBicepEnv(
  env: NodeJS.ProcessEnv = {},
  bicepPath: string = MANAGED_BICEP_PATH
): NodeJS.ProcessEnv {
  return processManagedBicepEnv(env, bicepPath);
}

// The ACR repository that publishes the Radius Bicep extension: the `Radius.*`
// type index bicep resolves `extension radius` against. `rad app graph` compiles
// Bicep offline, but bicep still needs a bicepconfig.json beside the .bicep
// naming this extension, or compilation fails with `BCP204: Extension "radius"
// is not recognized`. A tag is always appended — see
// {@link radiusExtensionRefForVersion}; this registry is never referenced
// untagged.
export const RADIUS_EXTENSION_REGISTRY = "br:biceptypes.azurecr.io/radius";

// The Bicep settings a Radius compile needs regardless of which extension tag is
// selected. `extensibility` gates the `extension` keyword itself.
export const RADIUS_BICEP_EXPERIMENTAL_FEATURES: Readonly<{
  extensibility: boolean;
}> = Object.freeze({ extensibility: true });
export const MODELED_APP_GRAPH_FLAGS: readonly string[] = Object.freeze([
  "--include-icons"
]);

// Serializes concurrent toolchain preparation so only one download runs.
let ensurePromise: Promise<string> | null = null;
let cachedRadPath: string | null = null;
const ensureBicepPromises = new Map<string, Promise<string>>();

function noop(): void {}

// Maps Node's platform/arch onto the GitHub release asset naming used by rad
// (rad_<os>_<arch>[.exe]).
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: "windows",
  darwin: "darwin",
  linux: "linux"
};
// Radius currently publishes only an amd64 Windows binary. Windows on ARM64
// runs it through the OS x64 compatibility layer.
const WIN_ARCH_ASSETS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: "amd64",
  arm64: "amd64"
};
const POSIX_ARCH_ASSETS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: "amd64",
  arm64: "arm64",
  arm: "arm"
};
export function releaseAsset(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch
): string {
  const osName = OS_NAMES[platform];
  const arch =
    platform === "win32" ?
      WIN_ARCH_ASSETS[architecture]
    : POSIX_ARCH_ASSETS[architecture];
  if (!osName || !arch) {
    throw new Error(
      `Unsupported platform for rad: ${platform}/${architecture}`
    );
  }
  return `rad_${osName}_${arch}${platform === "win32" ? ".exe" : ""}`;
}

function isExecutableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isCompletedBicepFile(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    return (
      stat.isFile() && stat.size > 0 && (IS_WIN || (stat.mode & 0o111) !== 0)
    );
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
export function tryAcquireLock(lockPath: string): (() => void) | null {
  const write = (): (() => void) => {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return () => {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* best-effort */
      }
    };
  };
  try {
    return write();
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
    // Someone holds it. Reap it only if it is stale, then retry the create.
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        return write();
      }
    } catch {
      /* lost the reap/retry race — treat as held */
    }
    return null;
  }
}

// Polls until `file` exists (a peer finished its download) or the timeout
// elapses. Returns whether the file is present at the end.
async function waitForFile(
  file: string,
  timeoutMs: number,
  intervalMs = 500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isExecutableFile(file)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return isExecutableFile(file);
}

type BicepDownloadWaitResult = "complete" | "available" | "timeout";

async function waitForBicepDownload(
  file: string,
  lockPath: string,
  timeoutMs: number,
  intervalMs = 500
): Promise<BicepDownloadWaitResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isExecutableFile(lockPath)) {
      return isCompletedBicepFile(file) ? "complete" : "available";
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return "timeout";
}

/**
 * resolveExistingRadBinary - locate a usable `rad` without downloading.
 * Order: RADIUS_RAD_BINARY env -> the stable extension-owned managed path.
 * PATH and the user's official ~/.rad/bin install are deliberately ignored.
 */
export function resolveExistingRadBinary(
  managedPath: string = MANAGED_RAD_PATH
): string | null {
  const fromEnv = process.env.RADIUS_RAD_BINARY;
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;

  if (isExecutableFile(managedPath)) return managedPath;

  return null;
}

export function parseRadVersionOutput(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const version =
      isPlainObject(parsed) ?
        (parsed.version ??
        (isPlainObject(parsed.cli) ? parsed.cli.version : undefined))
      : undefined;
    return typeof version === "string" && version.trim() ?
        version.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * radBinaryVersion - best-effort read of a rad binary's own CLI version by
 * running `rad version --cli --output json` and returning its `version` string
 * (e.g. "v0.44.0", or an edge build like "v0.60.0-rc1-1-gdeadbee"), or null when
 * it can't be determined. `rad version --cli` skips the control-plane check but
 * still shells out to Bicep (getCliVersionInfo -> bicep.Version() ->
 * `bicep --version`), so BICEP is pinned to the managed path even during version
 * checks. A timeout plus process-tree kill is a hard backstop so a
 * wedged rad can never stall binary resolution beyond `timeout`. (If bicep isn't
 * installed, rad returns fast with a "bicep not installed" note and still emits
 * `version`.) Never throws — a null result means "version unknown", which callers
 * treat as "leave the existing binary in place".
 */
export function radBinaryVersion(
  radPath: string,
  { timeout = 10000 }: { timeout?: number } = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(radPath, ["version", "--cli", "--output", "json"], {
        env: managedBicepEnv(process.env),
        ...radSpawnOptions()
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      finish(null);
    }, timeout);

    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += c.toString();
    });
    child.stderr?.resume();
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
export function parseVersion(
  value: string | null | undefined
): [number, number, number] | null {
  const m =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      (value || "").trim()
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
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined
): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * radiusExtensionRefForVersion - map a rad CLI version to the Radius Bicep
 * extension reference that matches it, e.g. "v0.60.0-rc1" ->
 * "br:biceptypes.azurecr.io/radius:0.60".
 *
 * The registry publishes one `major.minor` release-channel tag per Radius
 * release, so the extension is pinned to the release channel of the very binary
 * that will run the compile. Prerelease and build suffixes are ignored, matching
 * {@link compareVersions}: released binaries have been observed self-reporting a
 * prerelease string (a `v0.60.0-rc1` install serving the 0.60 line), and
 * `reconcileWithLatest` treats such a binary as equal to its release rather than
 * upgrading it, so the channel — not the suffix — is what identifies the types.
 *
 * Known limitation: the `major.minor` channel tag is published at GA, so a
 * genuinely pre-GA binary used during a release-candidate window derives a tag
 * that does not exist yet and the compile fails to restore the extension. That
 * is a development/`RADIUS_RAD_BINARY` scenario, the failure names the exact
 * reference it tried (see `buildGraphViaRad`), and pinning `extensions.radius`
 * in `.radius/bicepconfig.json` overrides it.
 *
 * The mutable `latest` and `edge` tags are deliberately never produced. Both
 * float independently of the installed binary — `latest` has been observed
 * lagging the current release, and `edge` is years stale — so either can
 * silently compile a model against a schema the installed toolchain does not
 * have, dropping valid properties or accepting invalid ones.
 *
 * Returns null when the version has no parseable major.minor.patch core.
 */
export function radiusExtensionRefForVersion(
  version: string | null | undefined
): string | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  return `${RADIUS_EXTENSION_REGISTRY}:${parsed[0]}.${parsed[1]}`;
}

/**
 * resolveRadiusExtensionRef - the Radius Bicep extension reference to compile
 * with when the repository does not pin one itself, derived from the version of
 * the `rad` binary that will run the compile.
 *
 * Reading the version is a local spawn, so this stays correct offline and in
 * air-gapped use: no releases API call is involved. Returns null when no binary
 * can be located or its version is unreadable, which callers treat as "fail
 * closed" rather than substituting a floating tag.
 *
 * `readVersion` is injected so tests can drive the mapping deterministically
 * without spawning a real binary, and `locateRadBinary` so they do not depend on
 * whether the machine happens to have one installed.
 */
export async function resolveRadiusExtensionRef({
  log = noop,
  radPath = "",
  locateRadBinary = () => resolveExistingRadBinary(),
  readVersion = (binary: string) => radBinaryVersion(binary)
}: ResolveRadiusExtensionRefOptions = {}): Promise<string | null> {
  const binary = radPath || locateRadBinary();
  if (!binary) {
    log(
      "Could not locate a rad binary to derive the Radius Bicep extension version from."
    );
    return null;
  }
  const version = await readVersion(binary);
  const ref = radiusExtensionRefForVersion(version);
  if (!ref) {
    const reported = version ? ` (it reported "${version}")` : "";
    log(
      `Could not determine the Radius release of ${binary}${reported}; the Radius Bicep extension cannot be derived from it.`
    );
    return null;
  }
  return ref;
}

function githubAuthHeaders(): Record<string, string> {
  // The GitHub Releases API is rate-limited hard for unauthenticated callers,
  // which can make first-run downloads flaky on shared/CI IP addresses. If a
  // token happens to be in the environment, use it to get the authenticated
  // rate limit. No token is required for public release metadata.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function httpGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "radius-app-graph", ...headers },
        timeout: 30000
      },
      (resp: IncomingMessage) => {
        if (
          resp.statusCode !== undefined &&
          resp.statusCode >= 300 &&
          resp.statusCode < 400 &&
          resp.headers.location
        ) {
          resp.resume();
          resolve(httpGet(resp.headers.location, headers));
          return;
        }
        if (resp.statusCode !== 200) {
          resp.resume();
          reject(new Error(`GET ${url} failed: HTTP ${resp.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () => resolve(Buffer.concat(chunks)));
        resp.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", reject);
  });
}

async function latestRelease(): Promise<RadReleaseInfo> {
  const body = await httpGet(RELEASES_API, {
    Accept: "application/vnd.github+json",
    ...githubAuthHeaders()
  });
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (!isPlainObject(parsed) || typeof parsed.tag_name !== "string") {
    throw new Error("Could not determine latest rad release tag");
  }
  const assets: RadReleaseAsset[] =
    Array.isArray(parsed.assets) ?
      parsed.assets
        .filter(
          (asset): asset is Record<string, unknown> =>
            isPlainObject(asset) && typeof asset.name === "string"
        )
        .map((asset) => ({
          name: String(asset.name),
          digest: typeof asset.digest === "string" ? asset.digest : undefined
        }))
    : [];
  return { tag: parsed.tag_name, assets };
}

// Normalizes a "sha256:<hex>" or bare-hex value to lowercase hex, or "" if none.
export function normalizeSha256(value: string | null | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
}

// Determines the SHA-256 the download must match. An explicit RADIUS_RAD_SHA256
// pin (raw hex or "sha256:<hex>") always wins so operators can lock to a known
// build; otherwise the digest GitHub publishes for the release asset is used.
// When neither is available the download proceeds without verification — many
// upstream releases omit per-asset digests — and a warning is surfaced so
// operators know they can pin RADIUS_RAD_SHA256 for stricter integrity checks.
export function expectedDigest(
  assets: RadReleaseAsset[],
  assetName: string,
  _tag: string
): ExpectedDigest | null {
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
function verifyChecksum(
  data: Buffer,
  expected: ExpectedDigest,
  tag: string,
  assetName: string
): void {
  const actual = crypto.createHash("sha256").update(data).digest("hex");
  if (actual !== expected.hex) {
    throw new Error(
      `rad ${tag} asset ${assetName} failed SHA-256 verification against ${expected.source}: expected ${expected.hex}, got ${actual}`
    );
  }
}

async function downloadRad(
  log: Logger,
  { releaseInfo = null }: { releaseInfo?: RadReleaseInfo | null } = {}
): Promise<string> {
  const { tag, assets } = releaseInfo || (await latestRelease());
  const asset = releaseAsset();
  const url = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
  const dest = MANAGED_RAD_PATH;
  const expected = expectedDigest(assets, asset, tag);
  fs.mkdirSync(MANAGED_RAD_BIN, { recursive: true });

  // True when the managed binary already exists and its core version is at least
  // the target release — the signal that no (further) download is needed.
  const upToDate = async (): Promise<boolean> => {
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
    if ((await waitForFile(dest, DOWNLOAD_WAIT_MS)) && (await upToDate()))
      return dest;
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
        `Warning: rad ${tag} asset ${asset} has no SHA-256 digest available; skipping verification. Set RADIUS_RAD_SHA256 to enforce verification.`
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
    log(
      `Installed rad to ${dest} (${expected ? `verified against ${expected.source}` : "unverified"})`
    );
    return dest;
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
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
async function reconcileWithLatest(
  existing: string,
  log: Logger
): Promise<string> {
  if (process.env.RADIUS_RAD_SKIP_VERSION_CHECK) return existing;

  let latest: RadReleaseInfo;
  try {
    latest = await latestRelease();
  } catch (err) {
    log(
      `Could not check the latest rad release (${errorMessage(err)}); using the installed binary.`
    );
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
    log(
      `Warning: RADIUS_RAD_BINARY rad ${localVersion} is older than the latest release ${latest.tag}; using it anyway. Unset RADIUS_RAD_BINARY to auto-upgrade.`
    );
    return existing;
  }

  log(
    `Installed rad ${localVersion} is older than the latest release ${latest.tag}; upgrading...`
  );
  try {
    return await downloadRad(log, { releaseInfo: latest });
  } catch (err) {
    log(
      `Could not upgrade rad to ${latest.tag} (${errorMessage(err)}); using ${localVersion}.`
    );
    return existing;
  }
}

/**
 * ensureRadBinary - return a path to a runnable `rad`, downloading it and its
 * paired Bicep CLI into the extension-owned bin directory when needed.
 * Concurrent callers share a single in-flight resolution.
 */
export function ensureRadBinary({
  log = noop
}: { log?: Logger } = {}): Promise<string> {
  if (cachedRadPath && isExecutableFile(cachedRadPath)) {
    const resolvedPath = cachedRadPath;
    return ensureManagedBicep(resolvedPath, { log }).then(() => resolvedPath);
  }
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async (): Promise<string> => {
    const existing = resolveExistingRadBinary();
    if (existing) {
      // Only repair permissions on the extension-owned binary. An explicit
      // override is developer-owned and must never be modified.
      const managed =
        !process.env.RADIUS_RAD_BINARY &&
        path.resolve(existing) === path.resolve(MANAGED_RAD_PATH);
      if (!IS_WIN && managed) {
        try {
          fs.chmodSync(existing, 0o755);
        } catch {
          /* best-effort */
        }
      }
      // Use the installed rad only if it is at least as new as the latest
      // release; otherwise reconcileWithLatest upgrades it (best-effort).
      cachedRadPath = await reconcileWithLatest(existing, log);
      await ensureManagedBicep(cachedRadPath, { log });
      return cachedRadPath;
    }
    const downloaded = await downloadRad(log);
    cachedRadPath = downloaded;
    await ensureManagedBicep(cachedRadPath, { log });
    return downloaded;
  })();

  ensurePromise
    .catch(() => {})
    .finally(() => {
      ensurePromise = null;
    });
  return ensurePromise;
}

/**
 * ensureManagedBicep - install the Bicep CLI beside the extension-managed rad
 * binary using `rad bicep download`. Concurrent callers preparing the same path
 * share one operation, and a successful command is accepted only when it
 * created the expected executable.
 */
export function ensureManagedBicep(
  radPath: string,
  {
    log = noop,
    timeout = 120000,
    bicepPath = MANAGED_BICEP_PATH,
    run = spawnRad
  }: EnsureManagedBicepOptions = {}
): Promise<string> {
  const lockPath = `${bicepPath}.download.lock`;
  if (!isExecutableFile(lockPath) && isCompletedBicepFile(bicepPath)) {
    return Promise.resolve(bicepPath);
  }

  const pending = ensureBicepPromises.get(bicepPath);
  if (pending) return pending;

  const preparation = (async (): Promise<string> => {
    fs.mkdirSync(path.dirname(bicepPath), { recursive: true });
    let lockWasPresent = isExecutableFile(lockPath);
    let release = tryAcquireLock(lockPath);
    while (!release) {
      log("Another process is downloading the managed Bicep CLI; waiting...");
      const result = await waitForBicepDownload(
        bicepPath,
        lockPath,
        DOWNLOAD_WAIT_MS
      );
      if (result === "complete") return bicepPath;
      if (result === "timeout") {
        throw new Error(
          `Timed out waiting for another process to create ${bicepPath}`
        );
      }
      lockWasPresent = false;
      release = tryAcquireLock(lockPath);
    }

    let tmp = "";
    try {
      if (!lockWasPresent && isCompletedBicepFile(bicepPath)) return bicepPath;
      tmp = `${bicepPath}.${process.pid}.${crypto.randomUUID()}.download`;
      // Radius requires a BICEP override to exist before its download command
      // will accept the destination. Download to a unique temporary file so a
      // stale-lock takeover can never expose partial bytes at the managed path.
      fs.closeSync(fs.openSync(tmp, "wx"));
      log(`Downloading Bicep to ${bicepPath}...`);
      await run(radPath, ["bicep", "download"], {
        cwd: path.dirname(bicepPath),
        env: managedBicepEnv({}, tmp),
        timeout,
        label: "rad bicep download"
      });
      if (!IS_WIN && isExecutableFile(tmp)) {
        try {
          fs.chmodSync(tmp, 0o755);
        } catch {
          /* validated below */
        }
      }
      if (!isCompletedBicepFile(tmp)) {
        throw new Error(
          `rad bicep download completed without creating ${bicepPath}`
        );
      }

      if (IS_WIN && isExecutableFile(bicepPath)) {
        fs.rmSync(bicepPath, { force: true });
      }
      fs.renameSync(tmp, bicepPath);
      tmp = "";
      log(`Installed Bicep CLI to ${bicepPath}`);
      return bicepPath;
    } finally {
      if (tmp) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best-effort */
        }
      }
      release();
    }
  })();

  ensureBicepPromises.set(bicepPath, preparation);
  preparation
    .catch(() => {})
    .finally(() => {
      if (ensureBicepPromises.get(bicepPath) === preparation) {
        ensureBicepPromises.delete(bicepPath);
      }
    });
  return preparation;
}

/**
 * spawnManagedRad - resolve `rad` from RADIUS_RAD_BINARY or the extension-owned
 * ~/.radius/ai-extensions/bin/rad[.exe] path (never PATH or ~/.rad/bin), then
 * run it with BICEP pinned to ~/.radius/ai-extensions/bin/bicep[.exe].
 */
async function spawnManagedRad(
  args: string[],
  {
    cwd,
    env = {},
    timeout = 120000,
    label = "rad",
    log = noop
  }: SpawnManagedRadOptions = {}
): Promise<ProcessResult> {
  const radPath = await ensureRadBinary({ log });
  return await spawnRad(radPath, args, {
    cwd,
    env: managedBicepEnv(env),
    timeout,
    label
  });
}

/**
 * Argument builders for the two publish commands. Exported so tests can assert
 * the exact rad CLI invocation without spawning a process.
 */
export function bicepPublishExtensionArgs(
  fromFile: string,
  target: string
): string[] {
  return [
    "bicep",
    "publish-extension",
    "--from-file",
    fromFile,
    "--target",
    target,
    "--force"
  ];
}
export function bicepPublishArgs(file: string, target: string): string[] {
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
export async function runRadBicepPublishExtension({
  fromFile,
  target,
  log = noop,
  timeout = 120000
}: RunRadBicepPublishExtensionOptions): Promise<string> {
  const from = path.resolve(fromFile);
  const to = path.resolve(target);
  try {
    await spawnManagedRad(bicepPublishExtensionArgs(from, to), {
      cwd: path.dirname(to),
      timeout,
      label: "rad bicep publish-extension",
      log
    });
    return to;
  } catch (err) {
    throw new Error(
      `rad bicep publish-extension failed: ${radErrorDetail(err)}`,
      { cause: err }
    );
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
export async function runRadBicepPublish({
  file,
  target,
  env = {},
  log = noop,
  timeout = 120000
}: RunRadBicepPublishOptions): Promise<string> {
  const src = path.resolve(file);
  try {
    await spawnManagedRad(bicepPublishArgs(src, target), {
      cwd: path.dirname(src),
      env,
      timeout,
      label: "rad bicep publish",
      log
    });
    return target;
  } catch (err) {
    throw new Error(`rad bicep publish failed: ${radErrorDetail(err)}`, {
      cause: err
    });
  }
}

/**
 * resolveRadForGraph - resolve a `rad` binary to run `rad app graph` WITHOUT
 * running a fresh version check or download on the hot path. The `rad version --cli`
 * check (and any resulting upgrade) runs in the ensureRadBinary() warm-up on every
 * extension load; a graph build reuses that result rather than repeating it.
 * Resolution order:
 *   1. an in-flight load-time ensureRadBinary(), awaited to completion, else
 *   2. the binary that ensure has already cached, else
 *   3. a binary already present on disk (RADIUS_RAD_BINARY or the managed path),
 *      used as-is with no version check, else
 *   4. as a fallback when nothing is on disk yet, call ensureRadBinary().
 *
 * Step 1 exists for correctness, not speed. The load-time warm-up publishes an
 * upgraded binary by atomically renaming it over the managed path, so a caller
 * that resolved beforehand holds a path whose contents can change underneath it.
 * A graph build that reads a release from the pre-upgrade binary and then
 * executes the post-upgrade one would pin its bicepconfig to one release and
 * compile with another — exactly the schema/toolchain mismatch this module
 * exists to prevent. Waiting for the reconciliation to settle makes the binary
 * stable for the rest of the process: reconciliation runs at most once, so once
 * it has finished nothing replaces the binary again.
 *
 * A failed warm-up is not fatal here — it falls through to whatever is on disk,
 * preserving offline and air-gapped use.
 */
export async function resolveRadForGraph({
  log = noop
}: { log?: Logger } = {}): Promise<string> {
  if (ensurePromise) {
    try {
      return await ensurePromise;
    } catch {
      /* fall through to whatever is already on disk */
    }
  }
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
 *
 * The returned value is the raw, untyped app-graph.json payload: this module
 * only shuttles it to `applicationGraphToResources` (@radius-project/core), which owns
 * its shape.
 */
export async function runRadAppGraph(
  bicepFilePath: string,
  {
    log = noop,
    timeout = 120000,
    saveGraphJsonTo = "",
    radPath: providedRadPath = "",
    processPlatform = process.platform,
    artifactPollIntervalMs = 100,
    exitCloseGraceMs = 2000
  }: RunRadAppGraphOptions = {}
): Promise<unknown> {
  const radPath = providedRadPath || (await resolveRadForGraph({ log }));
  await ensureManagedBicep(radPath, { log, timeout });
  // Resolve to an absolute path: rad runs from a temp cwd, so a relative arg
  // would no longer point at the file.
  const absoluteBicep = path.resolve(bicepFilePath);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rad-graph-"));
  const outFile = path.join(cwd, "app-graph.json");
  try {
    await new Promise<void>((resolve, reject) => {
      // `rad app graph` shells out to bicep as a grandchild and writes
      // app-graph.json into the temp cwd. The child reference is kept (no unref)
      // so Node awaits it and reads the file it wrote. The timeout below is a
      // hard backstop.
      const child = spawn(
        radPath,
        ["app", "graph", absoluteBicep, ...MODELED_APP_GRAPH_FLAGS],
        {
          cwd,
          // Clear GITHUB_ACTIONS so rad writes app-graph.json locally instead of
          // committing to the radius-graph orphan branch. stdin is ignored so rad
          // never blocks waiting for interactive input. Windows remains in the
          // caller's Job Object; POSIX uses a process group for tree cleanup.
          env: { ...process.env, ...managedBicepEnv(), GITHUB_ACTIONS: "" },
          ...radSpawnOptions(processPlatform)
        }
      );

      const MAX = 32 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      let artifactTimer: ReturnType<typeof setInterval> | null = null;
      let exited: {
        code: number | null;
        signal: NodeJS.Signals | null;
      } | null = null;
      child.stdout?.on("data", (c: Buffer) => {
        if (stdout.length < MAX) stdout += c.toString();
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < MAX) stderr += c.toString();
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (artifactTimer) clearInterval(artifactTimer);
        killChildTree(child);
        reject(
          new RadProcessError(
            `rad app graph timed out after ${timeout}ms`,
            stdout,
            stderr
          )
        );
      }, timeout);

      const complete = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        if (artifactTimer) clearInterval(artifactTimer);
        try {
          child.stdout?.destroy();
        } catch {
          /* best-effort */
        }
        try {
          child.stderr?.destroy();
        } catch {
          /* best-effort */
        }
      };

      function finalize(code: number | null, signal: NodeJS.Signals | null) {
        if (settled) return;
        complete();
        if (code === 0) {
          resolve();
        } else {
          // Preserve both streams: rad prints Bicep compile errors (BCP*) to
          // stdout, not stderr, so the error handler below needs stdout too.
          reject(
            new RadProcessError(
              `rad exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
              stdout,
              stderr
            )
          );
        }
      }

      child.on("error", (err) => {
        if (settled) return;
        complete();
        reject(new RadProcessError(err.message, stdout, stderr));
      });

      // Some Windows rad builds exit successfully after writing the graph while
      // a descendant keeps a stdio pipe open. Preserve rad's exit code as the
      // authority: the artifact may shorten that post-exit wait, but it can
      // never turn a still-running or failed command into success. The grace
      // timer below is the bounded fallback; polling avoids paying its full
      // delay and terminates the descendant that kept the pipe open.
      if (processPlatform === "win32") {
        artifactTimer = setInterval(() => {
          if (settled || exited?.code !== 0 || !fs.existsSync(outFile)) {
            return;
          }
          try {
            JSON.parse(fs.readFileSync(outFile, "utf8"));
          } catch {
            return;
          }
          complete();
          killChildTree(child);
          resolve();
        }, artifactPollIntervalMs);
      }

      // Prefer `close`: it fires once the process exited AND all stdio flushed,
      // so stdout/stderr are complete. As a safety net, a short grace window
      // after `exit` (process gone, code known) finalizes with whatever output
      // was captured if `close` is delayed, so the build can never hang.
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        if (settled || graceTimer) return;
        graceTimer = setTimeout(() => finalize(code, signal), exitCloseGraceMs);
      });
      child.on("close", (code, signal) => {
        // `exit` fires before `close` and carries the authoritative code, so
        // prefer it when present (close's args can be null if killed via pipe).
        if (exited) finalize(exited.code, exited.signal);
        else finalize(code, signal);
      });
    });
    const raw = fs.readFileSync(outFile, "utf8");
    if (saveGraphJsonTo) {
      if (path.isAbsolute(saveGraphJsonTo))
        saveGraphJson(saveGraphJsonTo, raw, log);
      else
        log(
          `Warning: saveGraphJsonTo must be an absolute path; ignoring: ${saveGraphJsonTo}`
        );
    }
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`rad app graph failed: ${radErrorDetail(err)}`, {
      cause: err
    });
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * saveGraphJson - persist the raw app-graph.json emitted by `rad app graph` to
 * `destPath`, creating parent directories as needed. Saving is best-effort: a
 * failure is logged via the injected `log` and swallowed so it can never fail an
 * otherwise-successful graph build.
 */
export function saveGraphJson(
  destPath: string,
  raw: string,
  log: Logger = noop
): void {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, raw);
    log(`Saved application graph JSON to ${destPath}`);
  } catch (err) {
    log(
      `Warning: could not save app-graph.json to ${destPath}: ${errorMessage(err)}`
    );
  }
}

// isOciExtensionRef - true when a bicepconfig extension alias points at an OCI
// registry (br:/oci:) rather than a local artifact file.
function isOciExtensionRef(ref: string): boolean {
  return /^(br|oci):/i.test(ref);
}

// copyLocalExtensionArtifact - copy a local extension artifact (e.g. the
// custom-types .tgz a bicepconfig alias references) from the workspace `.radius/`
// into the compile dir, preserving its relative path so bicep resolves it next
// to bicepconfig.json. Refuses absolute or `..`-escaping references and is
// best-effort: a missing file or copy error is logged and skipped.
function copyLocalExtensionArtifact(
  srcRoot: string,
  destRoot: string,
  ref: string,
  log: Logger = noop
): void {
  try {
    const rel = ref.replace(/^\.[\\/]/, "");
    if (
      path.isAbsolute(rel) ||
      rel.split(/[\\/]/).some((seg) => seg === "..")
    ) {
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
    log(
      `Warning: could not copy extension artifact ${ref}: ${errorMessage(err)}`
    );
  }
}

/**
 * The outcome of looking for the repository's applicable bicepconfig.json.
 * "absent" and "unreadable" are kept distinct so a fail-closed error can name
 * the real cause: telling a user with a malformed config that no config was
 * found would send them to create a pin they already have.
 */
type RepositoryBicepConfig =
  | { kind: "parsed"; config: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

/**
 * readRepositoryBicepConfig - locate and parse the applicable repository
 * bicepconfig.json. Reading is separated from assembly so a fail-closed throw
 * during assembly is never swallowed by this function's parse-error handling.
 */
function readRepositoryBicepConfig(
  radArtifactsDir: string,
  log: Logger
): RepositoryBicepConfig {
  if (!radArtifactsDir) return { kind: "absent" };
  const wsConfigPath = path.join(radArtifactsDir, "bicepconfig.json");
  try {
    if (!fs.existsSync(wsConfigPath)) return { kind: "absent" };
    const parsed: unknown = JSON.parse(fs.readFileSync(wsConfigPath, "utf8"));
    if (isPlainObject(parsed)) return { kind: "parsed", config: parsed };
    return { kind: "unreadable", detail: "its root is not a JSON object" };
  } catch (err) {
    const detail = errorMessage(err);
    log(
      `Warning: could not read repository bicepconfig.json; deriving the Radius extension from the installed rad release instead: ${detail}`
    );
    return { kind: "unreadable", detail };
  }
}

/**
 * requireRadiusExtensionRef - fail closed when no `extensions.radius` reference
 * can be established. Compiling against a guessed floating tag would validate
 * the model against a different contract than it targets, so an actionable
 * error is raised instead. The reason is embedded in the message because
 * callers routinely run with the default no-op logger (issue #173).
 *
 * The message states only what is known here — that no reference was available.
 * Why the derived one is missing (no binary located, an unreadable version, or
 * one that maps to no release channel) is reported by
 * {@link resolveRadiusExtensionRef} through `log`, so this must not assert a
 * single cause on its behalf.
 */
function requireRadiusExtensionRef(ref: string, reason: string): string {
  if (ref) return ref;
  throw new Error(
    `Cannot determine which Radius Bicep extension to compile with: ${reason}, ` +
      "and no reference could be derived from the rad release that would run the " +
      'compile. Pin it by setting "extensions.radius" in .radius/bicepconfig.json ' +
      `(for example "${RADIUS_EXTENSION_REGISTRY}:0.60").`
  );
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
 * `extensibility` is force-enabled and a `radius` alias is backfilled from
 * `radiusExtensionRef` only when the repo config omits it, so `extension radius`
 * always resolves; nothing else in the repo config is rewritten.
 *
 * `radiusExtensionRef` is the reference derived from the rad binary that will
 * run the compile (see {@link resolveRadiusExtensionRef}). It is used only when
 * the repository does not pin one — when no applicable bicepconfig.json exists,
 * it is unreadable, or its `extensions.radius` is absent or blank. When it is
 * empty in one of those cases this throws rather than falling back to a floating
 * tag, so a compile never silently runs against a schema that does not match the
 * toolchain.
 *
 * Returns the effective config object written to disk, so callers can report the
 * selected `extensions.radius` reference (e.g. in a compilation failure) even
 * when `log` is the default no-op.
 */
export function writeBicepCompileConfig(
  dir: string,
  radArtifactsDir: string,
  log: Logger = noop,
  radiusExtensionRef = ""
): BicepCompileConfig {
  const repository = readRepositoryBicepConfig(radArtifactsDir, log);
  const fallbackRef = radiusExtensionRef.trim();
  let config: BicepCompileConfig;

  if (repository.kind === "parsed") {
    const parsed = repository.config;
    // Use the repository config verbatim, then ensure only what a Radius
    // compile requires (extensibility on, a resolvable `radius` alias).
    const experimentalFeaturesEnabled: Record<string, unknown> & {
      extensibility: boolean;
    } = {
      ...(isPlainObject(parsed.experimentalFeaturesEnabled) ?
        parsed.experimentalFeaturesEnabled
      : {}),
      extensibility: true
    };

    const extensionsSource =
      isPlainObject(parsed.extensions) ? parsed.extensions : {};
    // A blank pin is treated as no pin: written through verbatim it would
    // produce an unresolvable `extensions.radius` (BCP204) and send the empty
    // string to the artifact copier below as if it were a local path.
    const pinnedRadius =
      typeof extensionsSource.radius === "string" ?
        extensionsSource.radius.trim()
      : "";
    const radiusRef =
      pinnedRadius ||
      requireRadiusExtensionRef(
        fallbackRef,
        "the repository bicepconfig.json does not pin extensions.radius"
      );
    const extensions: Record<string, unknown> & { radius: string } = {
      ...extensionsSource,
      radius: radiusRef
    };
    for (const ref of Object.values(extensions)) {
      // Blank aliases are preserved in the config but never resolved as local
      // artifacts: `path.resolve(root, "")` is the workspace directory itself,
      // which the copier would report as an unreadable artifact.
      if (typeof ref !== "string" || !ref.trim()) continue;
      if (!isOciExtensionRef(ref))
        copyLocalExtensionArtifact(radArtifactsDir, dir, ref, log);
    }

    config = { ...parsed, experimentalFeaturesEnabled, extensions };
  } else {
    const reason =
      repository.kind === "unreadable" ?
        `the repository bicepconfig.json could not be read (${repository.detail})`
      : "no applicable repository bicepconfig.json was found";
    config = {
      experimentalFeaturesEnabled: { ...RADIUS_BICEP_EXPERIMENTAL_FEATURES },
      extensions: { radius: requireRadiusExtensionRef(fallbackRef, reason) }
    };
  }

  log(`Compiling with radius extension: ${config.extensions.radius}`);
  fs.writeFileSync(
    path.join(dir, "bicepconfig.json"),
    JSON.stringify(config, null, 2)
  );
  return config;
}

/**
 * buildGraphViaRad - the single graph-assembly entry adapters use. Writes the
 * given Bicep content to a temp file, runs `rad app graph`, and converts the
 * result into the canvas resource array. Throws (surfaced to the UI) on failure
 * — there is no JS fallback.
 *
 * The returned array is passed through `filterGraphVisualizationResources`, the
 * shared visualization filter, so implementation-detail resources
 * (containerImages and their ghcr-registry-creds secret) are never rendered in
 * any graph state — modeled, planned, deployed, or diff. This is applied only
 * to the returned array; the raw app-graph.json saved above is left complete.
 */
export async function buildGraphViaRad(
  content: string,
  definitionFile = ".radius/app.bicep",
  {
    log = noop,
    saveGraphJsonTo = "",
    radArtifactsDir = "",
    cleanupRadArtifactsDir = false
  }: BuildGraphViaRadOptions = {}
): Promise<unknown[]> {
  if (!content) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-bicep-"));
  const bicepFile = path.join(dir, "app.bicep");
  try {
    // Resolve the binary up front and reuse it for the compile. resolveRadForGraph
    // waits for any in-flight load-time reconciliation, so the release read here
    // cannot be superseded by an upgrade mid-build, and passing the path to
    // runRadAppGraph keeps the version read and the spawn on one binary.
    const radPath = await resolveRadForGraph({ log });
    const radiusExtensionRef =
      (await resolveRadiusExtensionRef({ log, radPath })) ?? "";
    // Order matters: write bicepconfig.json (and copy any local extension
    // artifacts) before app.bicep so the extensions are in place when rad
    // compiles the Bicep. bicep looks for bicepconfig.json next to the .bicep.
    const config = writeBicepCompileConfig(
      dir,
      radArtifactsDir,
      log,
      radiusExtensionRef
    );
    fs.writeFileSync(bicepFile, content);
    try {
      const appGraph = await runRadAppGraph(bicepFile, {
        log,
        saveGraphJsonTo,
        radPath
      });
      return filterGraphVisualizationResources(
        applicationGraphToResources(appGraph, definitionFile, content)
      );
    } catch (err) {
      // Surface the exact radius extension the compile used so a failure is
      // actionable even when `log` is the default no-op (issue #173): the caller
      // otherwise only sees the raw `rad` output, not which contract was used.
      const radiusExtension = config?.extensions?.radius;
      if (typeof radiusExtension === "string") {
        throw new Error(
          `${errorMessage(err)}\nCompiled with radius extension: ${radiusExtension}`,
          { cause: err }
        );
      }
      throw err;
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (cleanupRadArtifactsDir && radArtifactsDir) {
      try {
        fs.rmSync(radArtifactsDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
