import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import https from "node:https";
import {
  RADIUS_BICEP_CONFIG,
  RADIUS_BICEP_CONFIG_JSON,
  MODELED_APP_GRAPH_FLAGS,
  MANAGED_RAD_PATH,
  resolveExistingRadBinary,
  buildGraphViaRad,
  writeBicepCompileConfig,
  runRadBicepPublishExtension,
  spawnRad,
  bicepPublishExtensionArgs,
  bicepPublishArgs,
  saveGraphJson,
  normalizeSha256,
  expectedDigest,
  tryAcquireLock,
  parseVersion,
  parseRadVersionOutput,
  compareVersions,
  radBinaryVersion,
  releaseAsset,
  ensureRadBinary,
} from "./rad.mjs";

const RAD = `rad${process.platform === "win32" ? ".exe" : ""}`;

describe("managed rad platform paths", () => {
  it("uses the platform executable suffix at the stable managed location", () => {
    expect(MANAGED_RAD_PATH).toBe(
      path.join(os.homedir(), ".radius", "ai-extensions", "bin", RAD),
    );
  });

  it.each([
    ["win32", "x64", "rad_windows_amd64.exe"],
    ["win32", "arm64", "rad_windows_amd64.exe"],
    ["darwin", "x64", "rad_darwin_amd64"],
    ["darwin", "arm64", "rad_darwin_arm64"],
    ["linux", "x64", "rad_linux_amd64"],
    ["linux", "arm64", "rad_linux_arm64"],
    ["linux", "arm", "rad_linux_arm"],
  ])("maps %s/%s to %s", (platform, architecture, expected) => {
    expect(releaseAsset(platform, architecture)).toBe(expected);
  });

  it("rejects unsupported platform and architecture combinations", () => {
    expect(() => releaseAsset("freebsd", "x64")).toThrow("Unsupported platform");
    expect(() => releaseAsset("linux", "ia32")).toThrow("Unsupported platform");
    expect(() => releaseAsset("win32", "arm")).toThrow("Unsupported platform");
  });
});

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

describe("MODELED_APP_GRAPH_FLAGS", () => {
  it("requests icon metadata without switching to the deployed preview runner", () => {
    expect(MODELED_APP_GRAPH_FLAGS).toEqual(["--include-icons"]);
  });
});

describe("resolveExistingRadBinary", () => {
  let tmp;
  let savedBinaryEnv;
  let managed;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-resolve-"));
    savedBinaryEnv = process.env.RADIUS_RAD_BINARY;
    managed = path.join(tmp, "managed", RAD);
    delete process.env.RADIUS_RAD_BINARY;
  });

  afterEach(() => {
    if (savedBinaryEnv === undefined) delete process.env.RADIUS_RAD_BINARY;
    else process.env.RADIUS_RAD_BINARY = savedBinaryEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns RADIUS_RAD_BINARY when it points at an existing file", () => {
    const bin = path.join(tmp, "custom-rad");
    fs.writeFileSync(bin, "");
    process.env.RADIUS_RAD_BINARY = bin;
    expect(resolveExistingRadBinary(managed)).toBe(bin);
  });

  it("ignores a missing RADIUS_RAD_BINARY and falls through to the managed path", () => {
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "");
    process.env.RADIUS_RAD_BINARY = path.join(tmp, "does-not-exist");
    expect(resolveExistingRadBinary(managed)).toBe(managed);
  });

  it("returns the stable managed binary when no override is set", () => {
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "");
    expect(resolveExistingRadBinary(managed)).toBe(managed);
  });

  it("does not use rad from PATH", () => {
    const pathDir = path.join(tmp, "path-bin");
    fs.mkdirSync(pathDir);
    const onPath = path.join(pathDir, RAD);
    fs.writeFileSync(onPath, "");
    const savedPath = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      expect(resolveExistingRadBinary(managed)).toBeNull();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it("prefers RADIUS_RAD_BINARY over the managed binary", () => {
    const envBin = path.join(tmp, "env-rad");
    fs.writeFileSync(envBin, "");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "");
    process.env.RADIUS_RAD_BINARY = envBin;
    expect(resolveExistingRadBinary(managed)).toBe(envBin);
  });

  it("does not treat a directory at the managed path as a usable binary", () => {
    fs.mkdirSync(managed, { recursive: true });
    expect(resolveExistingRadBinary(managed)).toBeNull();
  });
});

describe("parseRadVersionOutput", () => {
  it("reads the top-level version emitted by older rad releases with --cli", () => {
    expect(parseRadVersionOutput('{"release":"stable","version":"v0.54.0"}')).toBe("v0.54.0");
  });

  it("also accepts the combined output shape from newer rad releases", () => {
    expect(parseRadVersionOutput('{"cli":{"version":"v0.60.0"}}')).toBe("v0.60.0");
  });

  it("returns null for invalid or versionless output", () => {
    expect(parseRadVersionOutput('{"cli":{}}')).toBeNull();
    expect(parseRadVersionOutput("not-json")).toBeNull();
  });
});

describe("resolveRadForGraph", () => {
  const RELEASES_API = "https://api.github.com/repos/radius-project/radius/releases/latest";
  const savedEnv = {};
  let managedBackup = null;
  let managedMode = null;

  function mockHttpsGet(responses, calls) {
    return vi.spyOn(https, "get").mockImplementation((url, options, callback) => {
      const key = String(url);
      calls.push(key);
      const response = responses[key];
      if (!response) throw new Error(`Unexpected URL: ${key}`);

      const req = new EventEmitter();
      req.destroy = (err) => { if (err) req.emit("error", err); };
      req.on = req.addListener.bind(req);

      const resp = new EventEmitter();
      resp.statusCode = response.statusCode ?? 200;
      resp.headers = response.headers ?? {};
      resp.resume = () => {};
      process.nextTick(() => {
        callback(resp);
        if (response.body !== undefined) {
          resp.emit("data", Buffer.from(response.body));
        }
        resp.emit("end");
      });
      return req;
    });
  }

  async function primeCachedRadViaEnsure(calls) {
    vi.resetModules();
    const mod = await import("./rad.mjs");
    const asset = mod.releaseAsset();
    const tag = "v0.2.0";
    const downloadUrl = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
    mockHttpsGet({
      [RELEASES_API]: {
        body: JSON.stringify({ tag_name: tag, assets: [{ name: asset, digest: "" }] }),
      },
      [downloadUrl]: {
        body: "#!/usr/bin/env node\nprocess.stdout.write('{}');\n",
      },
    }, calls);
    const resolved = await mod.resolveRadForGraph();
    return { mod, resolved };
  }

  beforeEach(() => {
    savedEnv.RADIUS_RAD_BINARY = process.env.RADIUS_RAD_BINARY;
    savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK = process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    if (fs.existsSync(MANAGED_RAD_PATH)) {
      managedBackup = fs.readFileSync(MANAGED_RAD_PATH);
      managedMode = fs.statSync(MANAGED_RAD_PATH).mode;
    } else {
      managedBackup = null;
      managedMode = null;
    }
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
  });

  afterEach(() => {
    if (savedEnv.RADIUS_RAD_BINARY === undefined) delete process.env.RADIUS_RAD_BINARY;
    else process.env.RADIUS_RAD_BINARY = savedEnv.RADIUS_RAD_BINARY;
    if (savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK === undefined) delete process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    else process.env.RADIUS_RAD_SKIP_VERSION_CHECK = savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK;
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
    if (managedBackup) {
      fs.mkdirSync(path.dirname(MANAGED_RAD_PATH), { recursive: true });
      fs.writeFileSync(MANAGED_RAD_PATH, managedBackup);
      if (managedMode !== null) fs.chmodSync(MANAGED_RAD_PATH, managedMode);
    }
    vi.restoreAllMocks();
  });

  it("uses an on-disk binary as-is when no cached path exists", async () => {
    vi.resetModules();
    const mod = await import("./rad.mjs");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-graph-existing-"));
    const override = path.join(tmp, RAD);
    fs.writeFileSync(override, "");
    process.env.RADIUS_RAD_BINARY = override;

    await expect(mod.resolveRadForGraph()).resolves.toBe(override);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("falls back to ensureRadBinary when no cached or on-disk binary exists", async () => {
    delete process.env.RADIUS_RAD_BINARY;
    const calls = [];
    const { resolved } = await primeCachedRadViaEnsure(calls);

    expect(resolved).toBe(MANAGED_RAD_PATH);
    expect(calls).toContain(RELEASES_API);
  });

  it("prefers the cached ensure result over a later on-disk override", async () => {
    delete process.env.RADIUS_RAD_BINARY;
    const calls = [];
    const { mod, resolved: cached } = await primeCachedRadViaEnsure(calls);
    expect(cached).toBe(MANAGED_RAD_PATH);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-graph-override-"));
    const override = path.join(tmp, RAD);
    fs.writeFileSync(override, "");
    process.env.RADIUS_RAD_BINARY = override;

    await expect(mod.resolveRadForGraph()).resolves.toBe(cached);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("buildGraphViaRad", () => {
  it("returns an empty array for empty content without invoking rad", async () => {
    // Short-circuits before any spawn/download, so this is safe to run offline.
    expect(await buildGraphViaRad("")).toEqual([]);
  });
});

describe("writeBicepCompileConfig", () => {
  let dir;
  let ws;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-cfg-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rad-ws-"));
  });
  afterEach(() => {
    for (const d of [dir, ws]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(dir, "bicepconfig.json"), "utf8"));
  }

  it("writes only the base Radius config when no workspace artifacts dir is given", () => {
    writeBicepCompileConfig(dir, "");
    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(RADIUS_BICEP_CONFIG.extensions.radius);
    expect(Object.keys(cfg.extensions)).toEqual(["radius"]);
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
  });

  it("merges workspace extension aliases and copies the local custom-types artifact", () => {
    // A generated app declares `extension customTypes` -> ./custom-types.tgz, so
    // the alias must be merged and the tgz copied next to bicepconfig.json in the
    // temp compile dir, otherwise `rad app graph` cannot resolve the extension.
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: {
        radius: "br:biceptypes.azurecr.io/radius:latest",
        customTypes: "./custom-types.tgz",
      },
    }));
    fs.writeFileSync(path.join(ws, "custom-types.tgz"), "TGZBYTES");

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe("br:biceptypes.azurecr.io/radius:latest");
    expect(cfg.extensions.customTypes).toBe("./custom-types.tgz");
    expect(fs.readFileSync(path.join(dir, "custom-types.tgz"), "utf8")).toBe("TGZBYTES");
  });

  it("preserves a pinned extensions.radius reference from the repository config", () => {
    // The canvas must compile against the repository's exact pinned extension,
    // not the base radius:latest, otherwise validation runs against a different
    // contract than the generated app targets.
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { radius: "br:biceptypes.azurecr.io/radius:0.48" },
    }));

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe("br:biceptypes.azurecr.io/radius:0.48");
  });

  it("preserves unrelated Bicep settings from the repository config verbatim", () => {
    // The applicable bicepconfig.json may carry settings beyond extensions (e.g.
    // analyzers, formatting); the compile config must keep them so the canvas
    // compiles with the same Bicep behavior the repository configures.
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { radius: "br:biceptypes.azurecr.io/radius:0.48" },
      analyzers: { core: { enabled: true, rules: { "no-unused-params": { level: "warning" } } } },
      formatting: { indentKind: "space", indentSize: 2 },
    }));

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.analyzers).toEqual({ core: { enabled: true, rules: { "no-unused-params": { level: "warning" } } } });
    expect(cfg.formatting).toEqual({ indentKind: "space", indentSize: 2 });
  });

  it("backfills a resolvable radius alias when the repository config omits it", () => {
    // A repo config might declare only a custom extension; the base radius alias
    // must be added so `extension radius` still resolves during compilation.
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { customTypes: "./custom-types.tgz" },
    }));
    fs.writeFileSync(path.join(ws, "custom-types.tgz"), "TGZBYTES");

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(RADIUS_BICEP_CONFIG.extensions.radius);
    expect(cfg.extensions.customTypes).toBe("./custom-types.tgz");
    expect(fs.readFileSync(path.join(dir, "custom-types.tgz"), "utf8")).toBe("TGZBYTES");
  });

  it("keeps extensibility enabled and does not copy OCI (br:) extension refs", () => {
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      experimentalFeaturesEnabled: { extensibility: false },
      extensions: {
        radius: "br:biceptypes.azurecr.io/radius:latest",
        other: "br:ghcr.io/acme/app/ext:1.0.0",
      },
    }));

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.other).toBe("br:ghcr.io/acme/app/ext:1.0.0");
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
    expect(fs.existsSync(path.join(dir, "ext"))).toBe(false);
  });

  it("preserves a traversing alias but refuses to copy outside the compile dir", () => {
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      extensions: {
        radius: "br:biceptypes.azurecr.io/radius:latest",
        evil: "../../secret.tgz",
      },
    }));

    // Must not throw; the alias is kept but the referenced file is never copied.
    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.evil).toBe("../../secret.tgz");
    expect(fs.existsSync(path.join(dir, "secret.tgz"))).toBe(false);
  });

  it("falls back to the base config when the workspace bicepconfig.json is unreadable", () => {
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), "{ not valid json");
    writeBicepCompileConfig(dir, ws);
    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(RADIUS_BICEP_CONFIG.extensions.radius);
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
  });

  it("recovers a resolvable config when array-valued sections make the repo config malformed", () => {
    // A JSON-valid but malformed config could set these to arrays; typeof still
    // reports "object", so the code must reject arrays explicitly, otherwise the
    // forced extensibility flag and radius alias would be written as dropped
    // non-index array properties, breaking `extension radius` resolution.
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
      experimentalFeaturesEnabled: [],
      extensions: [],
    }));
    writeBicepCompileConfig(dir, ws);
    const cfg = readConfig();
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
    expect(cfg.extensions.radius).toBe(RADIUS_BICEP_CONFIG.extensions.radius);
  });
});

// Opt-in end-to-end check that a generated custom-type app actually compiles
// through buildGraphViaRad once its extension is published locally. Needs the
// managed `rad` binary + bundled bicep, so it is skipped unless
// RUN_LIVE_RAD_TESTS is set (e.g. in a scheduled job), never on the offline PR run.
const LIVE_RAD = !!process.env.RUN_LIVE_RAD_TESTS;
describe.skipIf(!LIVE_RAD)("live: custom-type app compiles via buildGraphViaRad (opt-in: RUN_LIVE_RAD_TESTS)", () => {
  it("resolves `extension customTypes` from a locally published tgz", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rad-live-ws-"));
    try {
      const manifest = [
        "namespace: Radius.Resources",
        "types:",
        "  testStores:",
        "    apiVersions:",
        "      '2025-08-01-preview':",
        "        schema:",
        "          type: object",
        "          properties:",
        "            environment:",
        "              type: string",
        "            application:",
        "              type: string",
        "          required:",
        "            - environment",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(ws, "custom-types.yaml"), manifest);
      await runRadBicepPublishExtension({
        fromFile: path.join(ws, "custom-types.yaml"),
        target: path.join(ws, "custom-types.tgz"),
      });
      fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: {
          radius: "br:biceptypes.azurecr.io/radius:latest",
          customTypes: "./custom-types.tgz",
        },
      }));
      const app = [
        "extension radius",
        "extension customTypes",
        "",
        "param environment string",
        "",
        "resource store 'Radius.Resources/testStores@2025-08-01-preview' = {",
        "  name: 'store'",
        "  properties: {",
        "    environment: environment",
        "  }",
        "}",
        "",
      ].join("\n");
      // The assertion that matters: this does not throw. Without the merged
      // config + copied tgz, rad would fail with BCP204 (extension not recognized).
      const resources = await buildGraphViaRad(app, ".radius/app.bicep", { radArtifactsDir: ws });
      expect(Array.isArray(resources)).toBe(true);
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 180000);
});

describe("bicep publish arg builders", () => {
  it("builds publish-extension args with --force", () => {
    expect(bicepPublishExtensionArgs("/a/from.yaml", "/a/out.tgz")).toEqual(
      ["bicep", "publish-extension", "--from-file", "/a/from.yaml", "--target", "/a/out.tgz", "--force"],
    );
  });
  it("builds publish args (no --force, auth flows through env)", () => {
    expect(bicepPublishArgs("/a/recipe.bicep", "br:ghcr.io/acme/app/r:1.0.0")).toEqual(
      ["bicep", "publish", "--file", "/a/recipe.bicep", "--target", "br:ghcr.io/acme/app/r:1.0.0"],
    );
  });
});

// spawnRad drives a real child process, so the fake `rad` is an executable
// shebang script; that only works on POSIX. Skip (don't drop) on Windows.
const describeSpawn = process.platform === "win32" ? describe.skip : describe;
describeSpawn("spawnRad", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawnrad-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  function fakeRad(body) {
    const p = path.join(dir, "rad");
    fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, "utf8");
    fs.chmodSync(p, 0o755);
    return p;
  }

  it("resolves with stdout/stderr on a zero exit", async () => {
    const bin = fakeRad(`process.stdout.write("out");process.stderr.write("err");process.exit(0);`);
    const { stdout, stderr } = await spawnRad(bin, ["x"], { timeout: 5000 });
    expect(stdout).toBe("out");
    expect(stderr).toBe("err");
  });

  it("rejects with the exit code and both streams on a non-zero exit", async () => {
    // rad prints BCP* compile errors to stdout, so stdout must survive on the error.
    const bin = fakeRad(`process.stdout.write("BCP204 boom");process.exit(3);`);
    await expect(spawnRad(bin, ["x"], { timeout: 5000, label: "rad bicep publish" })).rejects.toMatchObject({
      message: expect.stringContaining("rad bicep publish exited with code 3"),
      stdout: "BCP204 boom",
    });
  });

  it("rejects with a timeout when the process does not exit", async () => {
    const bin = fakeRad(`setTimeout(() => {}, 60000);`);
    await expect(spawnRad(bin, ["x"], { timeout: 300, label: "rad bicep publish" })).rejects.toThrow(
      /timed out after 300ms/,
    );
  }, 10000);

  it("rejects when the binary cannot be spawned", async () => {
    await expect(spawnRad(path.join(dir, "does-not-exist"), ["x"], { timeout: 2000 })).rejects.toBeInstanceOf(Error);
  });
});

describe("saveGraphJson", () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-save-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("writes the raw bytes verbatim, creating parent directories", () => {
    const dest = path.join(tmp, ".radius", "app-graph.json");
    const raw = '{"resources":[{"id":"a"}]}';
    saveGraphJson(dest, raw);
    expect(fs.readFileSync(dest, "utf8")).toBe(raw);
  });

  it("logs and swallows errors instead of throwing", () => {
    // A directory where the file should go makes writeFileSync fail.
    const dest = path.join(tmp, "collide");
    fs.mkdirSync(dest);
    const messages = [];
    expect(() => saveGraphJson(dest, "{}", (m) => messages.push(m))).not.toThrow();
    expect(messages.some((m) => m.includes("could not save"))).toBe(true);
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

  it("writes the current pid into the lock file", () => {
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

describe("parseVersion", () => {
  it("parses a plain v-prefixed release into its numeric core", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("accepts a bare (unprefixed) version", () => {
    expect(parseVersion("0.44.0")).toEqual([0, 44, 0]);
  });

  it("ignores a prerelease/git-describe suffix", () => {
    expect(parseVersion("v0.60.0-rc1-1-gdeadbee")).toEqual([0, 60, 0]);
  });

  it("ignores build metadata after a +", () => {
    expect(parseVersion("1.2.3+build.7")).toEqual([1, 2, 3]);
  });

  it("returns null for anything without a numeric major.minor.patch", () => {
    expect(parseVersion("edge")).toBeNull();
    expect(parseVersion("v1.2")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe("compareVersions", () => {
  it("treats identical versions (with or without the v prefix) as equal", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("v0.44.0", "v0.45.0")).toBe(-1);
    expect(compareVersions("v0.45.0", "v0.44.0")).toBe(1);
    expect(compareVersions("v1.0.0", "v0.99.99")).toBe(1);
    expect(compareVersions("v1.2.3", "v1.2.4")).toBe(-1);
  });

  it("preserves a developer build with the same core as the latest release", () => {
    expect(compareVersions("v0.60.0-rc1-1-gdeadbee", "v0.60.0")).toBe(0);
    expect(compareVersions("v0.60.0", "v0.60.0-rc1-1-gdeadbee")).toBe(0);
  });

  it("lets a newer core beat a release regardless of its development suffix", () => {
    expect(compareVersions("v0.60.0-rc1-1-gdeadbee", "v0.48.0")).toBe(1);
  });

  it("returns 0 when either version is unparseable so callers don't churn", () => {
    expect(compareVersions("edge", "v1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "not-a-version")).toBe(0);
  });
});

describe("radBinaryVersion", () => {
  it("resolves to null (never throws) when the binary path does not exist", async () => {
    const missing = path.join(os.tmpdir(), "definitely-not-rad", `rad-${Date.now()}`);
    await expect(radBinaryVersion(missing, { timeout: 2000 })).resolves.toBeNull();
  });
});

// These reconciliation tests write executable shebang scripts and spawn them as
// a fake `rad`, which only works on POSIX. Skip (don't silently drop) on Windows
// so the suite still registers tests rather than erroring as empty.
const describeReconcile = process.platform === "win32" ? describe.skip : describe;
describeReconcile("ensureRadBinary version reconciliation", () => {
  const RELEASES_API = "https://api.github.com/repos/radius-project/radius/releases/latest";
  const savedEnv = {};
  let managedBackup = null;
  let managedMode = null;

  function writeFakeRad(dest, version) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      `#!/usr/bin/env node
if (process.argv.includes("version")) {
  process.stdout.write(JSON.stringify({ version: "${version}" }));
}
`,
      "utf8",
    );
    fs.chmodSync(dest, 0o755);
  }

  function mockHttpsGet(responses, calls) {
    return vi.spyOn(https, "get").mockImplementation((url, options, callback) => {
      const key = String(url);
      calls.push(key);
      const response = responses[key];
      if (!response) throw new Error(`Unexpected URL: ${key}`);

      const req = new EventEmitter();
      req.destroy = (err) => { if (err) req.emit("error", err); };
      req.on = req.addListener.bind(req);

      const resp = new EventEmitter();
      resp.statusCode = response.statusCode ?? 200;
      resp.headers = response.headers ?? {};
      resp.resume = () => {};
      process.nextTick(() => {
        callback(resp);
        if (response.body !== undefined) {
          resp.emit("data", Buffer.from(response.body));
        }
        resp.emit("end");
      });
      return req;
    });
  }

  beforeEach(() => {
    savedEnv.RADIUS_RAD_BINARY = process.env.RADIUS_RAD_BINARY;
    savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK = process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    if (fs.existsSync(MANAGED_RAD_PATH)) {
      managedBackup = fs.readFileSync(MANAGED_RAD_PATH);
      managedMode = fs.statSync(MANAGED_RAD_PATH).mode;
    } else {
      managedBackup = null;
      managedMode = null;
    }
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
  });

  afterEach(() => {
    if (savedEnv.RADIUS_RAD_BINARY === undefined) delete process.env.RADIUS_RAD_BINARY;
    else process.env.RADIUS_RAD_BINARY = savedEnv.RADIUS_RAD_BINARY;
    if (savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK === undefined) delete process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    else process.env.RADIUS_RAD_SKIP_VERSION_CHECK = savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK;

    fs.rmSync(MANAGED_RAD_PATH, { force: true });
    if (managedBackup) {
      fs.mkdirSync(path.dirname(MANAGED_RAD_PATH), { recursive: true });
      fs.writeFileSync(MANAGED_RAD_PATH, managedBackup);
      if (managedMode !== null) fs.chmodSync(MANAGED_RAD_PATH, managedMode);
    }
    vi.restoreAllMocks();
  });

  it("upgrades an older managed binary to the latest release", async () => {
    writeFakeRad(MANAGED_RAD_PATH, "v0.1.0");
    const asset = releaseAsset();
    const tag = "v0.2.0";
    const downloadUrl = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
    const calls = [];
    mockHttpsGet({
      [RELEASES_API]: {
        body: JSON.stringify({ tag_name: tag, assets: [{ name: asset, digest: "" }] }),
      },
      [downloadUrl]: {
        body: "#!/usr/bin/env node\nprocess.stdout.write('{}');\n",
      },
    }, calls);

    const logs = [];
    const resolved = await ensureRadBinary({ log: (m) => logs.push(m) });

    expect(resolved).toBe(MANAGED_RAD_PATH);
    expect(calls).toContain(RELEASES_API);
    expect(calls).toContain(downloadUrl);
    expect(logs.some((m) => m.includes("upgrading"))).toBe(true);
  });

  it("warns but does not download when RADIUS_RAD_BINARY is older", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-override-"));
    const override = path.join(tmp, "rad");
    writeFakeRad(override, "v0.1.0");
    process.env.RADIUS_RAD_BINARY = override;

    const asset = releaseAsset();
    const tag = "v0.2.0";
    const downloadUrl = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
    const calls = [];
    mockHttpsGet({
      [RELEASES_API]: {
        body: JSON.stringify({ tag_name: tag, assets: [{ name: asset, digest: "" }] }),
      },
    }, calls);

    const logs = [];
    const resolved = await ensureRadBinary({ log: (m) => logs.push(m) });

    expect(resolved).toBe(override);
    expect(calls).toEqual([RELEASES_API]);
    expect(calls).not.toContain(downloadUrl);
    expect(logs.some((m) => m.includes("RADIUS_RAD_BINARY") && m.includes("using it anyway"))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("skips the version check network call when RADIUS_RAD_SKIP_VERSION_CHECK is set", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-skip-check-"));
    const override = path.join(tmp, "rad");
    writeFakeRad(override, "v0.1.0");
    process.env.RADIUS_RAD_BINARY = override;
    process.env.RADIUS_RAD_SKIP_VERSION_CHECK = "1";

    const calls = [];
    mockHttpsGet({}, calls);
    const resolved = await ensureRadBinary();

    expect(resolved).toBe(override);
    expect(calls).toEqual([]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
