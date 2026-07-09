import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RADIUS_BICEP_CONFIG,
  RADIUS_BICEP_CONFIG_JSON,
  resolveExistingRadBinary,
  buildGraphViaRad,
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
