import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RADIUS_BICEP_CONFIG,
  RADIUS_BICEP_CONFIG_JSON,
  resolveExistingRadBinary,
  buildGraphViaRad,
  normalizeSha256,
  expectedDigest,
  tryAcquireLock,
} from "./rad.mjs";

const RAD = `rad${process.platform === "win32" ? ".exe" : ""}`;

describe("RADIUS_BICEP_CONFIG", () => {
  it("enables the Bicep extensibility experimental feature", () => {
    expect(RADIUS_BICEP_CONFIG.experimentalFeaturesEnabled.extensibility).toBe(true);
  });

  it("registers the radius extension from the ACR biceptypes registry", () => {
    // This is what lets `rad app graph` resolve `extension radius` + `Radius.*`
    // types offline; a wrong value surfaces as BCP204 at compile time.
    expect(RADIUS_BICEP_CONFIG.extensions.radius).toBe("br:biceptypes.azurecr.io/radius:latest");
  });

  it("exposes the config as pretty-printed JSON that round-trips", () => {
    expect(RADIUS_BICEP_CONFIG_JSON).toBe(JSON.stringify(RADIUS_BICEP_CONFIG, null, 2));
    expect(JSON.parse(RADIUS_BICEP_CONFIG_JSON)).toEqual(RADIUS_BICEP_CONFIG);
  });
});

describe("resolveExistingRadBinary", () => {
  let tmp;
  let savedBinaryEnv;
  let savedPathEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-resolve-"));
    savedBinaryEnv = process.env.RADIUS_RAD_BINARY;
    savedPathEnv = process.env.PATH;
    // Start from a clean slate so a rad already installed on this machine's PATH
    // or via RADIUS_RAD_BINARY can't influence the resolution order under test.
    delete process.env.RADIUS_RAD_BINARY;
    process.env.PATH = "";
  });

  afterEach(() => {
    if (savedBinaryEnv === undefined) delete process.env.RADIUS_RAD_BINARY;
    else process.env.RADIUS_RAD_BINARY = savedBinaryEnv;
    if (savedPathEnv === undefined) delete process.env.PATH;
    else process.env.PATH = savedPathEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns RADIUS_RAD_BINARY when it points at an existing file", () => {
    const bin = path.join(tmp, "custom-rad");
    fs.writeFileSync(bin, "");
    process.env.RADIUS_RAD_BINARY = bin;
    expect(resolveExistingRadBinary()).toBe(bin);
  });

  it("ignores RADIUS_RAD_BINARY when the path does not exist and falls through to PATH", () => {
    const pathDir = path.join(tmp, "bin");
    fs.mkdirSync(pathDir);
    const onPath = path.join(pathDir, RAD);
    fs.writeFileSync(onPath, "");
    process.env.RADIUS_RAD_BINARY = path.join(tmp, "does-not-exist");
    process.env.PATH = pathDir;
    expect(resolveExistingRadBinary()).toBe(onPath);
  });

  it("finds rad on PATH when no env override is set", () => {
    const pathDir = path.join(tmp, "bin");
    fs.mkdirSync(pathDir);
    const onPath = path.join(pathDir, RAD);
    fs.writeFileSync(onPath, "");
    process.env.PATH = pathDir;
    expect(resolveExistingRadBinary()).toBe(onPath);
  });

  it("scans every PATH entry and returns the first directory containing rad", () => {
    const empty = path.join(tmp, "empty");
    const real = path.join(tmp, "real");
    fs.mkdirSync(empty);
    fs.mkdirSync(real);
    const onPath = path.join(real, RAD);
    fs.writeFileSync(onPath, "");
    process.env.PATH = [empty, real].join(path.delimiter);
    expect(resolveExistingRadBinary()).toBe(onPath);
  });

  it("prefers RADIUS_RAD_BINARY over a rad found on PATH", () => {
    const envBin = path.join(tmp, "env-rad");
    fs.writeFileSync(envBin, "");
    const pathDir = path.join(tmp, "bin");
    fs.mkdirSync(pathDir);
    fs.writeFileSync(path.join(pathDir, RAD), "");
    process.env.RADIUS_RAD_BINARY = envBin;
    process.env.PATH = pathDir;
    expect(resolveExistingRadBinary()).toBe(envBin);
  });

  it("does not treat a directory named rad on PATH as a usable binary", () => {
    const pathDir = path.join(tmp, "bin");
    fs.mkdirSync(pathDir);
    const dirNamedRad = path.join(pathDir, RAD);
    fs.mkdirSync(dirNamedRad); // a directory, not an executable file
    process.env.PATH = pathDir;
    // Whatever it resolves to (null, or a real ~/.rad/bin install), it must not
    // be the directory that merely shares rad's name.
    expect(resolveExistingRadBinary()).not.toBe(dirNamedRad);
  });
});

describe("buildGraphViaRad", () => {
  it("returns an empty array for empty content without invoking rad", async () => {
    // Short-circuits before any spawn/download, so this is safe to run offline.
    expect(await buildGraphViaRad("")).toEqual([]);
  });
});

describe("normalizeSha256", () => {
  it("strips the sha256: prefix and lowercases", () => {
    expect(normalizeSha256("sha256:ABCDEF")).toBe("abcdef");
  });

  it("accepts a bare hex value", () => {
    expect(normalizeSha256("ABCDEF")).toBe("abcdef");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSha256("  sha256:abc123  ")).toBe("abc123");
  });

  it("returns empty string for nullish or empty input", () => {
    expect(normalizeSha256(undefined)).toBe("");
    expect(normalizeSha256(null)).toBe("");
    expect(normalizeSha256("")).toBe("");
  });
});

describe("expectedDigest", () => {
  const ASSET = "rad_linux_amd64";
  const publishedHex = "a".repeat(64);
  const pinnedHex = "b".repeat(64);
  const assets = [{ name: ASSET, digest: `sha256:${publishedHex}` }];
  let savedPin;

  beforeEach(() => {
    savedPin = process.env.RADIUS_RAD_SHA256;
    delete process.env.RADIUS_RAD_SHA256;
  });

  afterEach(() => {
    if (savedPin === undefined) delete process.env.RADIUS_RAD_SHA256;
    else process.env.RADIUS_RAD_SHA256 = savedPin;
  });

  it("uses the GitHub-published asset digest by default", () => {
    expect(expectedDigest(assets, ASSET, "v1.2.3")).toEqual({
      hex: publishedHex,
      source: "GitHub release digest",
    });
  });

  it("prefers an explicit RADIUS_RAD_SHA256 pin over the published digest", () => {
    process.env.RADIUS_RAD_SHA256 = `sha256:${pinnedHex.toUpperCase()}`;
    expect(expectedDigest(assets, ASSET, "v1.2.3")).toEqual({
      hex: pinnedHex,
      source: "RADIUS_RAD_SHA256",
    });
  });

  it("returns null when no pin and no published digest are available", () => {
    // e.g. the matched asset carries no digest field — download proceeds
    // without verification.
    expect(expectedDigest([{ name: ASSET }], ASSET, "v1.2.3")).toBeNull();
  });

  it("returns null when the asset is missing from the release", () => {
    expect(expectedDigest([], ASSET, "v1.2.3")).toBeNull();
  });

  it("still resolves the pin when the asset is missing entirely", () => {
    process.env.RADIUS_RAD_SHA256 = pinnedHex;
    expect(expectedDigest([], ASSET, "v1.2.3")).toEqual({
      hex: pinnedHex,
      source: "RADIUS_RAD_SHA256",
    });
  });
});

describe("tryAcquireLock", () => {
  let tmp;
  let lockPath;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-lock-"));
    lockPath = path.join(tmp, "rad.download.lock");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("acquires a free lock and returns a release function that removes it", () => {
    const release = tryAcquireLock(lockPath);
    expect(typeof release).toBe("function");
    expect(fs.existsSync(lockPath)).toBe(true);
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("writes the owning pid into the lock file", () => {
    const release = tryAcquireLock(lockPath);
    try {
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    } finally {
      release();
    }
  });

  it("returns null when a fresh lock is already held", () => {
    const release = tryAcquireLock(lockPath);
    try {
      expect(tryAcquireLock(lockPath)).toBeNull();
    } finally {
      release();
    }
  });

  it("reaps a stale lock and re-acquires it", () => {
    // Simulate a lock left by a crashed peer: create it, then backdate its mtime
    // well past the staleness threshold (5 minutes).
    fs.writeFileSync(lockPath, "99999");
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, stale, stale);

    const release = tryAcquireLock(lockPath);
    expect(typeof release).toBe("function");
    // The reaped lock is now owned by us (our pid), not the crashed peer.
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("lets a lock be re-acquired after it is released", () => {
    tryAcquireLock(lockPath)();
    const second = tryAcquireLock(lockPath);
    expect(typeof second).toBe("function");
    second();
  });
});
