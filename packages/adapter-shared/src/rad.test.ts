import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import {
  RADIUS_EXTENSION_REGISTRY,
  RADIUS_BICEP_EXPERIMENTAL_FEATURES,
  radiusExtensionRefForVersion,
  resolveRadiusExtensionRef,
  MODELED_APP_GRAPH_FLAGS,
  MANAGED_RAD_PATH,
  MANAGED_BICEP_PATH,
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
  ensureManagedBicep,
  managedBicepEnv,
  type SpawnRadOptions,
  type BicepCompileConfig
} from "./rad.js";

const RAD = `rad${process.platform === "win32" ? ".exe" : ""}`;
const BICEP = `bicep${process.platform === "win32" ? ".exe" : ""}`;

interface FakeHttpResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Narrows `options.env.BICEP` to a string, asserting the invariant that
 * `ensureManagedBicep` always calls `run` with a computed BICEP path rather
 * than silently trusting an unchecked cast. */
function requireBicepEnvPath(options: SpawnRadOptions): string {
  const value = options.env?.BICEP;
  if (typeof value !== "string") {
    throw new Error("expected options.env.BICEP to be set to a string path");
  }
  return value;
}

function mockHttpsGet(
  responses: Record<string, FakeHttpResponse>,
  calls: string[]
) {
  const implementation = (
    url: string | URL,
    _options: https.RequestOptions,
    callback?: (res: IncomingMessage) => void
  ) => {
    const key = String(url);
    calls.push(key);
    const response = responses[key];
    if (!response) throw new Error(`Unexpected URL: ${key}`);
    if (!callback) throw new Error("mockHttpsGet requires a callback");

    const req = https.request(url);
    const resp = new IncomingMessage(new Socket());
    resp.statusCode = response.statusCode ?? 200;
    resp.headers = response.headers ?? {};
    process.nextTick(() => {
      callback(resp);
      if (response.body !== undefined) {
        resp.emit("data", Buffer.from(response.body));
      }
      resp.emit("end");
    });
    return req;
  };
  return vi.spyOn(https, "get").mockImplementation(implementation);
}

describe("managed rad platform paths", () => {
  it("uses the platform executable suffix at the stable managed location", () => {
    expect(MANAGED_RAD_PATH).toBe(
      path.join(os.homedir(), ".radius", "ai-extensions", "bin", RAD)
    );
    expect(MANAGED_BICEP_PATH).toBe(
      path.join(os.homedir(), ".radius", "ai-extensions", "bin", BICEP)
    );
  });

  const releaseAssetCases: Array<
    [NodeJS.Platform, NodeJS.Architecture, string]
  > = [
    ["win32", "x64", "rad_windows_amd64.exe"],
    ["win32", "arm64", "rad_windows_amd64.exe"],
    ["darwin", "x64", "rad_darwin_amd64"],
    ["darwin", "arm64", "rad_darwin_arm64"],
    ["linux", "x64", "rad_linux_amd64"],
    ["linux", "arm64", "rad_linux_arm64"],
    ["linux", "arm", "rad_linux_arm"]
  ];
  it.each(releaseAssetCases)(
    "maps %s/%s to %s",
    (platform, architecture, expected) => {
      expect(releaseAsset(platform, architecture)).toBe(expected);
    }
  );

  it("rejects unsupported platform and architecture combinations", () => {
    expect(() => releaseAsset("freebsd", "x64")).toThrow(
      "Unsupported platform"
    );
    expect(() => releaseAsset("linux", "ia32")).toThrow("Unsupported platform");
    expect(() => releaseAsset("win32", "arm")).toThrow("Unsupported platform");
  });
});

describe("managed Bicep", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "managed-bicep-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("forces every managed rad environment to the extension-owned Bicep path", () => {
    expect(managedBicepEnv({ TOKEN: "secret", BICEP: "user-bicep" })).toEqual({
      TOKEN: "secret",
      BICEP: MANAGED_BICEP_PATH
    });
  });

  it("downloads Bicep once for concurrent callers and verifies the expected path", async () => {
    const bicepPath = path.join(tmp, "bin", BICEP);
    const calls: Array<{
      radPath: string;
      args: string[];
      options: SpawnRadOptions;
    }> = [];
    let releaseDownload: () => void = () => {
      throw new Error("download release callback was not initialized");
    };
    const downloadBlocked = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const run = vi.fn(
      async (radPath: string, args: string[], options: SpawnRadOptions) => {
        calls.push({ radPath, args, options });
        expect(options.env?.BICEP).toMatch(
          new RegExp(
            `^${bicepPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\..+\\.download$`
          )
        );
        const bicepEnvPath = requireBicepEnvPath(options);
        expect(fs.existsSync(bicepEnvPath)).toBe(true);
        expect(fs.statSync(bicepEnvPath).size).toBe(0);
        expect(fs.existsSync(bicepPath)).toBe(false);
        await downloadBlocked;
        fs.writeFileSync(bicepEnvPath, "bicep");
      }
    );

    const first = ensureManagedBicep("managed-rad", { bicepPath, run });
    const second = ensureManagedBicep("managed-rad", { bicepPath, run });
    expect(run).toHaveBeenCalledTimes(1);
    releaseDownload();

    await expect(Promise.all([first, second])).resolves.toEqual([
      bicepPath,
      bicepPath
    ]);
    expect(calls[0]).toMatchObject({
      radPath: "managed-rad",
      args: ["bicep", "download"],
      options: {
        cwd: path.dirname(bicepPath),
        label: "rad bicep download"
      }
    });
    expect(fs.readFileSync(bicepPath, "utf8")).toBe("bicep");
    expect(fs.readdirSync(path.dirname(bicepPath))).toEqual([BICEP]);
  });

  it("rejects when rad reports success without creating the managed Bicep binary", async () => {
    const bicepPath = path.join(tmp, "bin", BICEP);
    await expect(
      ensureManagedBicep("managed-rad", {
        bicepPath,
        run: vi.fn().mockResolvedValue({})
      })
    ).rejects.toThrow(`without creating ${bicepPath}`);
    expect(fs.existsSync(bicepPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(bicepPath))).toEqual([]);
  });

  it("skips the download when the managed Bicep binary already exists", async () => {
    const bicepPath = path.join(tmp, "bin", BICEP);
    fs.mkdirSync(path.dirname(bicepPath), { recursive: true });
    fs.writeFileSync(bicepPath, "bicep");
    if (process.platform !== "win32") fs.chmodSync(bicepPath, 0o755);
    const run = vi.fn();

    await expect(
      ensureManagedBicep("managed-rad", { bicepPath, run })
    ).resolves.toBe(bicepPath);
    expect(run).not.toHaveBeenCalled();
  });

  it("replaces a partial binary left behind with a stale download lock", async () => {
    const bicepPath = path.join(tmp, "bin", BICEP);
    const lockPath = `${bicepPath}.download.lock`;
    fs.mkdirSync(path.dirname(bicepPath), { recursive: true });
    fs.writeFileSync(bicepPath, "partial");
    fs.writeFileSync(lockPath, "abandoned");
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, stale, stale);
    const run = vi.fn(
      async (_radPath: string, _args: string[], options: SpawnRadOptions) => {
        expect(fs.readFileSync(bicepPath, "utf8")).toBe("partial");
        fs.writeFileSync(requireBicepEnvPath(options), "complete-bicep");
      }
    );

    await expect(
      ensureManagedBicep("managed-rad", { bicepPath, run })
    ).resolves.toBe(bicepPath);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(bicepPath, "utf8")).toBe("complete-bicep");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("takes over when another downloader releases its lock without a binary", async () => {
    const bicepPath = path.join(tmp, "bin", BICEP);
    const lockPath = `${bicepPath}.download.lock`;
    fs.mkdirSync(path.dirname(bicepPath), { recursive: true });
    fs.writeFileSync(lockPath, "peer");
    const run = vi.fn(
      async (_radPath: string, _args: string[], options: SpawnRadOptions) => {
        fs.writeFileSync(requireBicepEnvPath(options), "complete-bicep");
      }
    );
    setTimeout(() => fs.rmSync(lockPath, { force: true }), 20);

    await expect(
      ensureManagedBicep("managed-rad", { bicepPath, run })
    ).resolves.toBe(bicepPath);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("RADIUS_EXTENSION_REGISTRY", () => {
  it("names the ACR repository publishing the Radius Bicep extension", () => {
    // This is what lets `rad app graph` resolve `extension radius` + `Radius.*`
    // types offline; a wrong value surfaces as BCP204 at compile time.
    expect(RADIUS_EXTENSION_REGISTRY).toBe("br:biceptypes.azurecr.io/radius");
  });

  it("carries no tag of its own so a reference is never built untagged", () => {
    expect(RADIUS_EXTENSION_REGISTRY.split("/").pop()).not.toContain(":");
  });
});

describe("RADIUS_BICEP_EXPERIMENTAL_FEATURES", () => {
  it("enables the Bicep extensibility experimental feature", () => {
    expect(RADIUS_BICEP_EXPERIMENTAL_FEATURES.extensibility).toBe(true);
  });

  it("is frozen so a compile cannot mutate the shared defaults", () => {
    expect(Object.isFrozen(RADIUS_BICEP_EXPERIMENTAL_FEATURES)).toBe(true);
  });
});

describe("radiusExtensionRefForVersion", () => {
  it.each([
    ["v0.60.0", "br:biceptypes.azurecr.io/radius:0.60"],
    ["0.60.0", "br:biceptypes.azurecr.io/radius:0.60"],
    ["v0.59.2", "br:biceptypes.azurecr.io/radius:0.59"],
    ["v1.2.3", "br:biceptypes.azurecr.io/radius:1.2"],
    ["v10.20.30", "br:biceptypes.azurecr.io/radius:10.20"]
  ])("maps rad %s to the matching release-channel tag %s", (version, ref) => {
    expect(radiusExtensionRefForVersion(version)).toBe(ref);
  });

  it("pins a release-channel tag for a binary that self-reports a prerelease", () => {
    // Released binaries have been observed self-reporting an rc string, and
    // compareVersions treats a prerelease as its core version so such a binary
    // is never upgraded past it. The channel, not the suffix, identifies the
    // types it compiles against.
    expect(radiusExtensionRefForVersion("v0.60.0-rc1")).toBe(
      "br:biceptypes.azurecr.io/radius:0.60"
    );
    expect(radiusExtensionRefForVersion("v0.60.0-rc1-1-gdeadbee")).toBe(
      "br:biceptypes.azurecr.io/radius:0.60"
    );
  });

  it("ignores a build suffix", () => {
    expect(radiusExtensionRefForVersion("0.60.0+build.7")).toBe(
      "br:biceptypes.azurecr.io/radius:0.60"
    );
  });

  it.each(["latest", "edge"])(
    "never derives the mutable %s tag, which floats off the installed release",
    (version) => {
      // Regression guard for issue #487: `latest` was observed publishing an
      // artifact older than the installed release, so a model compiled against
      // it silently lost schema properties. `edge` is years stale.
      expect(radiusExtensionRefForVersion(version)).toBeNull();
    }
  );

  it.each([
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a non-numeric version", "vX.Y.Z"],
    ["a partial version", "0.60"]
  ])("returns null for %s rather than guessing a tag", (_label, version) => {
    expect(radiusExtensionRefForVersion(version)).toBeNull();
  });
});

describe("resolveRadiusExtensionRef", () => {
  it("derives the reference from the binary that will run the compile", async () => {
    const readVersion = vi.fn().mockResolvedValue("v0.60.0-rc1");
    await expect(
      resolveRadiusExtensionRef({ radPath: "/bin/rad", readVersion })
    ).resolves.toBe("br:biceptypes.azurecr.io/radius:0.60");
    expect(readVersion).toHaveBeenCalledWith("/bin/rad");
  });

  it("returns null and logs when no rad binary can be located", async () => {
    const log = vi.fn();
    const readVersion = vi.fn();
    await expect(
      resolveRadiusExtensionRef({
        log,
        locateRadBinary: () => null,
        readVersion
      })
    ).resolves.toBeNull();
    expect(readVersion).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("Could not locate a rad binary");
  });

  it("locates a binary itself when the caller does not supply one", async () => {
    await expect(
      resolveRadiusExtensionRef({
        locateRadBinary: () => "/located/rad",
        readVersion: async (binary) =>
          binary === "/located/rad" ? "v0.59.0" : null
      })
    ).resolves.toBe("br:biceptypes.azurecr.io/radius:0.59");
  });

  it("returns null and reports the version when it cannot be mapped", async () => {
    const log = vi.fn();
    await expect(
      resolveRadiusExtensionRef({
        log,
        radPath: "/bin/rad",
        readVersion: async () => "not-a-version"
      })
    ).resolves.toBeNull();
    expect(log.mock.calls[0][0]).toContain('it reported "not-a-version"');
  });

  it("returns null without a version fragment when the read yields nothing", async () => {
    const log = vi.fn();
    await expect(
      resolveRadiusExtensionRef({
        log,
        radPath: "/bin/rad",
        readVersion: async () => null
      })
    ).resolves.toBeNull();
    expect(log.mock.calls[0][0]).toContain("/bin/rad");
    expect(log.mock.calls[0][0]).not.toContain("it reported");
  });
});

describe("MODELED_APP_GRAPH_FLAGS", () => {
  it("requests icon metadata without switching to the deployed preview runner", () => {
    expect(MODELED_APP_GRAPH_FLAGS).toEqual(["--include-icons"]);
  });
});

describe("resolveExistingRadBinary", () => {
  let tmp: string;
  let savedBinaryEnv: string | undefined;
  let managed: string;

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
    expect(
      parseRadVersionOutput('{"release":"stable","version":"v0.54.0"}')
    ).toBe("v0.54.0");
  });

  it("also accepts the combined output shape from newer rad releases", () => {
    expect(parseRadVersionOutput('{"cli":{"version":"v0.60.0"}}')).toBe(
      "v0.60.0"
    );
  });

  it("returns null for invalid or versionless output", () => {
    expect(parseRadVersionOutput('{"cli":{}}')).toBeNull();
    expect(parseRadVersionOutput("not-json")).toBeNull();
  });
});

describe("resolveRadForGraph", () => {
  const RELEASES_API =
    "https://api.github.com/repos/radius-project/radius/releases/latest";
  const savedEnv: Record<string, string | undefined> = {};
  let managedBackup: Buffer | null = null;
  let managedMode: number | null = null;
  let bicepBackup: Buffer | null = null;
  let bicepMode: number | null = null;

  async function primeCachedRadViaEnsure(calls: string[]) {
    vi.resetModules();
    const mod = await import("./rad.js");
    const asset = mod.releaseAsset();
    const tag = "v0.2.0";
    const downloadUrl = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
    mockHttpsGet(
      {
        [RELEASES_API]: {
          body: JSON.stringify({
            tag_name: tag,
            assets: [{ name: asset, digest: "" }]
          })
        },
        [downloadUrl]: {
          body: "#!/usr/bin/env node\nprocess.stdout.write('{}');\n"
        }
      },
      calls
    );
    const resolved = await mod.resolveRadForGraph();
    return { mod, resolved };
  }

  beforeEach(() => {
    savedEnv.RADIUS_RAD_BINARY = process.env.RADIUS_RAD_BINARY;
    savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK =
      process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    if (fs.existsSync(MANAGED_RAD_PATH)) {
      managedBackup = fs.readFileSync(MANAGED_RAD_PATH);
      managedMode = fs.statSync(MANAGED_RAD_PATH).mode;
    } else {
      managedBackup = null;
      managedMode = null;
    }
    if (fs.existsSync(MANAGED_BICEP_PATH)) {
      bicepBackup = fs.readFileSync(MANAGED_BICEP_PATH);
      bicepMode = fs.statSync(MANAGED_BICEP_PATH).mode;
    } else {
      bicepBackup = null;
      bicepMode = null;
    }
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
    fs.mkdirSync(path.dirname(MANAGED_BICEP_PATH), { recursive: true });
    fs.writeFileSync(MANAGED_BICEP_PATH, "bicep");
    if (process.platform !== "win32") fs.chmodSync(MANAGED_BICEP_PATH, 0o755);
  });

  afterEach(() => {
    if (savedEnv.RADIUS_RAD_BINARY === undefined)
      delete process.env.RADIUS_RAD_BINARY;
    else process.env.RADIUS_RAD_BINARY = savedEnv.RADIUS_RAD_BINARY;
    if (savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK === undefined)
      delete process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    else
      process.env.RADIUS_RAD_SKIP_VERSION_CHECK =
        savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK;
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
    if (managedBackup) {
      fs.mkdirSync(path.dirname(MANAGED_RAD_PATH), { recursive: true });
      fs.writeFileSync(MANAGED_RAD_PATH, managedBackup);
      if (managedMode !== null) fs.chmodSync(MANAGED_RAD_PATH, managedMode);
    }
    fs.rmSync(MANAGED_BICEP_PATH, { force: true });
    if (bicepBackup) {
      fs.mkdirSync(path.dirname(MANAGED_BICEP_PATH), { recursive: true });
      fs.writeFileSync(MANAGED_BICEP_PATH, bicepBackup);
      if (bicepMode !== null) fs.chmodSync(MANAGED_BICEP_PATH, bicepMode);
    }
    vi.restoreAllMocks();
  });

  it("uses an on-disk binary as-is when no cached path exists", async () => {
    vi.resetModules();
    const mod = await import("./rad.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-graph-existing-"));
    const override = path.join(tmp, RAD);
    fs.writeFileSync(override, "");
    process.env.RADIUS_RAD_BINARY = override;

    await expect(mod.resolveRadForGraph()).resolves.toBe(override);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("falls back to ensureRadBinary when no cached or on-disk binary exists", async () => {
    delete process.env.RADIUS_RAD_BINARY;
    const calls: string[] = [];
    const { resolved } = await primeCachedRadViaEnsure(calls);

    expect(resolved).toBe(MANAGED_RAD_PATH);
    expect(calls).toContain(RELEASES_API);
  });

  it("prefers the cached ensure result over a later on-disk override", async () => {
    delete process.env.RADIUS_RAD_BINARY;
    const calls: string[] = [];
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

// A failing compile drives the real `rad` binary via RADIUS_RAD_BINARY, so the
// fake `rad` is an executable node shebang script; that only works on POSIX.
const describeBuild = process.platform === "win32" ? describe.skip : describe;
describeBuild(
  "buildGraphViaRad failure surfaces the selected extension",
  () => {
    let ws: string;
    let bin: string;
    let prevBinary: string | undefined;
    beforeEach(() => {
      ws = fs.mkdtempSync(path.join(os.tmpdir(), "rad-fail-ws-"));
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-fail-bin-"));
      bin = path.join(binDir, "rad");
      // Emulate rad rejecting the compile (e.g. BCP204) with a non-zero exit.
      fs.writeFileSync(
        bin,
        `#!/usr/bin/env node\nprocess.stdout.write("BCP204: Extension not recognized");process.exit(1);\n`,
        "utf8"
      );
      fs.chmodSync(bin, 0o755);
      prevBinary = process.env.RADIUS_RAD_BINARY;
      process.env.RADIUS_RAD_BINARY = bin;
    });
    afterEach(() => {
      if (prevBinary === undefined) delete process.env.RADIUS_RAD_BINARY;
      else process.env.RADIUS_RAD_BINARY = prevBinary;
      try {
        fs.rmSync(ws, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(path.dirname(bin), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    it("appends the repository's pinned radius extension to the thrown error even with the default logger", async () => {
      fs.writeFileSync(
        path.join(ws, "bicepconfig.json"),
        JSON.stringify({
          experimentalFeaturesEnabled: { extensibility: true },
          extensions: { radius: "br:biceptypes.azurecr.io/radius:0.48" }
        })
      );
      // No `log` is passed, so the default no-op is used: the extension must still
      // reach the caller through the thrown error (issue #173).
      await expect(
        buildGraphViaRad(
          "resource app 'Radius.Core/applications@2023-10-01-preview' = {}",
          ".radius/app.bicep",
          { radArtifactsDir: ws }
        )
      ).rejects.toThrow(
        /Compiled with radius extension: br:biceptypes\.azurecr\.io\/radius:0\.48/
      );
    }, 20000);
  }
);

describe("writeBicepCompileConfig", () => {
  let dir: string;
  let ws: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-cfg-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rad-ws-"));
  });
  afterEach(() => {
    for (const d of [dir, ws]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function readConfig(): BicepCompileConfig {
    return JSON.parse(
      fs.readFileSync(path.join(dir, "bicepconfig.json"), "utf8")
    );
  }

  // The reference resolveRadiusExtensionRef derives from the installed binary.
  const DERIVED = "br:biceptypes.azurecr.io/radius:0.60";

  it("writes the derived Radius extension when no workspace artifacts dir is given", () => {
    const returned = writeBicepCompileConfig(dir, "", undefined, DERIVED);
    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(DERIVED);
    expect(Object.keys(cfg.extensions)).toEqual(["radius"]);
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
    // The effective config is returned so callers can report the selected
    // extension even with the default no-op logger.
    expect(returned.extensions.radius).toBe(DERIVED);
  });

  it("returns the effective config carrying the repository's pinned radius extension", () => {
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: { radius: "br:biceptypes.azurecr.io/radius:0.48" }
      })
    );
    const returned = writeBicepCompileConfig(dir, ws);
    expect(returned.extensions.radius).toBe(
      "br:biceptypes.azurecr.io/radius:0.48"
    );
  });

  it("merges workspace extension aliases and copies the local custom-types artifact", () => {
    // A generated app declares `extension customTypes` -> ./custom-types.tgz, so
    // the alias must be merged and the tgz copied next to bicepconfig.json in the
    // temp compile dir, otherwise `rad app graph` cannot resolve the extension.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: {
          radius: "br:biceptypes.azurecr.io/radius:latest",
          customTypes: "./custom-types.tgz"
        }
      })
    );
    fs.writeFileSync(path.join(ws, "custom-types.tgz"), "TGZBYTES");

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(
      "br:biceptypes.azurecr.io/radius:latest"
    );
    expect(cfg.extensions.customTypes).toBe("./custom-types.tgz");
    expect(fs.readFileSync(path.join(dir, "custom-types.tgz"), "utf8")).toBe(
      "TGZBYTES"
    );
  });

  it("preserves a pinned extensions.radius reference from the repository config", () => {
    // The canvas must compile against the repository's exact pinned extension,
    // not the base radius:latest, otherwise validation runs against a different
    // contract than the generated app targets.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: { radius: "br:biceptypes.azurecr.io/radius:0.48" }
      })
    );

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe("br:biceptypes.azurecr.io/radius:0.48");
  });

  it("preserves unrelated Bicep settings from the repository config verbatim", () => {
    // The applicable bicepconfig.json may carry settings beyond extensions (e.g.
    // analyzers, formatting); the compile config must keep them so the canvas
    // compiles with the same Bicep behavior the repository configures.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: { radius: "br:biceptypes.azurecr.io/radius:0.48" },
        analyzers: {
          core: {
            enabled: true,
            rules: { "no-unused-params": { level: "warning" } }
          }
        },
        formatting: { indentKind: "space", indentSize: 2 }
      })
    );

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.analyzers).toEqual({
      core: {
        enabled: true,
        rules: { "no-unused-params": { level: "warning" } }
      }
    });
    expect(cfg.formatting).toEqual({ indentKind: "space", indentSize: 2 });
  });

  it("backfills the derived radius alias when the repository config omits it", () => {
    // A repo config might declare only a custom extension; the radius alias must
    // be added so `extension radius` still resolves during compilation.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: { customTypes: "./custom-types.tgz" }
      })
    );
    fs.writeFileSync(path.join(ws, "custom-types.tgz"), "TGZBYTES");

    writeBicepCompileConfig(dir, ws, undefined, DERIVED);

    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(DERIVED);
    expect(cfg.extensions.customTypes).toBe("./custom-types.tgz");
    expect(fs.readFileSync(path.join(dir, "custom-types.tgz"), "utf8")).toBe(
      "TGZBYTES"
    );
  });

  it("keeps extensibility enabled and does not copy OCI (br:) extension refs", () => {
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: false },
        extensions: {
          radius: "br:biceptypes.azurecr.io/radius:latest",
          other: "br:ghcr.io/acme/app/ext:1.0.0"
        }
      })
    );

    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.other).toBe("br:ghcr.io/acme/app/ext:1.0.0");
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
    expect(fs.existsSync(path.join(dir, "ext"))).toBe(false);
  });

  it("preserves a traversing alias but refuses to copy outside the compile dir", () => {
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        extensions: {
          radius: "br:biceptypes.azurecr.io/radius:latest",
          evil: "../../secret.tgz"
        }
      })
    );

    // Must not throw; the alias is kept but the referenced file is never copied.
    writeBicepCompileConfig(dir, ws);

    const cfg = readConfig();
    expect(cfg.extensions.evil).toBe("../../secret.tgz");
    expect(fs.existsSync(path.join(dir, "secret.tgz"))).toBe(false);
  });

  it("falls back to the derived extension when the workspace bicepconfig.json is unreadable", () => {
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), "{ not valid json");
    const log = vi.fn();
    writeBicepCompileConfig(dir, ws, log, DERIVED);
    const cfg = readConfig();
    expect(cfg.extensions.radius).toBe(DERIVED);
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
    expect(log.mock.calls[0][0]).toContain(
      "could not read repository bicepconfig.json"
    );
  });

  it("recovers a resolvable config when array-valued sections make the repo config malformed", () => {
    // A JSON-valid but malformed config could set these to arrays; typeof still
    // reports "object", so the code must reject arrays explicitly, otherwise the
    // forced extensibility flag and radius alias would be written as dropped
    // non-index array properties, breaking `extension radius` resolution.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: [],
        extensions: []
      })
    );
    writeBicepCompileConfig(dir, ws, undefined, DERIVED);
    const cfg = readConfig();
    expect(cfg.experimentalFeaturesEnabled.extensibility).toBe(true);
    expect(cfg.extensions.radius).toBe(DERIVED);
  });

  it("treats a non-object repository config as absent", () => {
    fs.writeFileSync(path.join(ws, "bicepconfig.json"), JSON.stringify([1, 2]));
    writeBicepCompileConfig(dir, ws, undefined, DERIVED);
    expect(readConfig().extensions.radius).toBe(DERIVED);
  });

  it("honors an explicit repository pin of the mutable latest tag", () => {
    // Only *inventing* a floating tag is forbidden. A repository that
    // deliberately tracks an edge/development release still owns that choice.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        extensions: { radius: "br:biceptypes.azurecr.io/radius:latest" }
      })
    );
    writeBicepCompileConfig(dir, ws, undefined, DERIVED);
    expect(readConfig().extensions.radius).toBe(
      "br:biceptypes.azurecr.io/radius:latest"
    );
  });

  it("trims surrounding whitespace from a repository pin", () => {
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({
        extensions: { radius: "  br:biceptypes.azurecr.io/radius:0.48  " }
      })
    );
    writeBicepCompileConfig(dir, ws, undefined, DERIVED);
    expect(readConfig().extensions.radius).toBe(
      "br:biceptypes.azurecr.io/radius:0.48"
    );
  });

  it.each([
    ["an empty", ""],
    ["a whitespace-only", "   "]
  ])(
    "treats %s repository pin as no pin and uses the derived reference",
    (_label, pinned) => {
      // Written through verbatim this would emit an unresolvable
      // `extensions.radius` (BCP204) and be handed to the artifact copier as if
      // it were a local path.
      fs.writeFileSync(
        path.join(ws, "bicepconfig.json"),
        JSON.stringify({ extensions: { radius: pinned } })
      );
      const log = vi.fn();
      writeBicepCompileConfig(dir, ws, log, DERIVED);
      expect(readConfig().extensions.radius).toBe(DERIVED);
      expect(log.mock.calls.map(([m]) => m).join("\n")).not.toContain(
        "extension artifact"
      );
    }
  );

  it("fails closed on a blank repository pin when nothing can be derived", () => {
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({ extensions: { radius: "   " } })
    );
    expect(() => writeBicepCompileConfig(dir, ws, undefined, "")).toThrow(
      /does not pin extensions\.radius/
    );
  });

  it("preserves a blank extension alias without resolving it as an artifact", () => {
    // `path.resolve(root, "")` is the workspace directory itself, so copying it
    // fails with EISDIR and logs a warning naming no artifact at all.
    fs.writeFileSync(
      path.join(ws, "bicepconfig.json"),
      JSON.stringify({ extensions: { radius: DERIVED, customTypes: "" } })
    );
    const log = vi.fn();
    writeBicepCompileConfig(dir, ws, log, DERIVED);
    expect(readConfig().extensions.customTypes).toBe("");
    expect(log.mock.calls.map(([m]) => m).join("\n")).not.toContain(
      "extension artifact"
    );
  });

  describe("fail-closed when no extension reference can be established", () => {
    // Regression guard for issue #487: substituting a floating tag compiles the
    // model against a contract it does not target, so the compile must not run.
    it("throws instead of guessing when there is no repository config", () => {
      expect(() => writeBicepCompileConfig(dir, "", undefined, "")).toThrow(
        /Cannot determine which Radius Bicep extension to compile with/
      );
    });

    it("throws when the repository config omits extensions.radius", () => {
      fs.writeFileSync(
        path.join(ws, "bicepconfig.json"),
        JSON.stringify({ extensions: { customTypes: "./custom-types.tgz" } })
      );
      expect(() => writeBicepCompileConfig(dir, ws, undefined, "")).toThrow(
        /does not pin extensions\.radius/
      );
    });

    it("names the malformed config rather than reporting it as missing", () => {
      // A user whose config is invalid JSON must not be told the file is absent
      // and sent to create a pin they already have. The parse detail only
      // reaches `log`, which defaults to a no-op, so it belongs in the error.
      fs.writeFileSync(path.join(ws, "bicepconfig.json"), "{ not valid json");
      expect(() => writeBicepCompileConfig(dir, ws, undefined, "")).toThrow(
        /the repository bicepconfig\.json could not be read/
      );
      expect(() => writeBicepCompileConfig(dir, ws, undefined, "")).not.toThrow(
        /no applicable repository bicepconfig\.json was found/
      );
    });

    it("names a non-object config root as unreadable", () => {
      fs.writeFileSync(
        path.join(ws, "bicepconfig.json"),
        JSON.stringify([1, 2])
      );
      expect(() => writeBicepCompileConfig(dir, ws, undefined, "")).toThrow(
        /its root is not a JSON object/
      );
    });

    it("treats a whitespace-only reference as absent", () => {
      expect(() => writeBicepCompileConfig(dir, "", undefined, "   ")).toThrow(
        /Cannot determine which Radius Bicep extension/
      );
    });

    it("names an actionable remedy and writes no config file", () => {
      expect(() => writeBicepCompileConfig(dir, "", undefined, "")).toThrow(
        /Pin it by setting "extensions\.radius" in \.radius\/bicepconfig\.json/
      );
      expect(fs.existsSync(path.join(dir, "bicepconfig.json"))).toBe(false);
    });

    it("does not assert a cause it cannot know for the missing reference", () => {
      // The throw also fires when a version was readable but mapped to no
      // release channel, so claiming the binary could not be read would send
      // the user after the wrong problem. The specific cause is logged by
      // resolveRadiusExtensionRef instead.
      expect(() => writeBicepCompileConfig(dir, "", undefined, "")).toThrow(
        /no reference could be derived from the rad release/
      );
      expect(() => writeBicepCompileConfig(dir, "", undefined, "")).not.toThrow(
        /the release of the managed rad binary could not be read/
      );
    });
  });
});

// Opt-in end-to-end check that a generated custom-type app actually compiles
// through buildGraphViaRad once its extension is published locally. Needs the
// managed `rad` binary + bundled bicep, so it is skipped unless
// RUN_LIVE_RAD_TESTS is set (e.g. in a scheduled job), never on the offline PR run.
const LIVE_RAD = !!process.env.RUN_LIVE_RAD_TESTS;
describe.skipIf(!LIVE_RAD)(
  "live: custom-type app compiles via buildGraphViaRad (opt-in: RUN_LIVE_RAD_TESTS)",
  () => {
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
          ""
        ].join("\n");
        fs.writeFileSync(path.join(ws, "custom-types.yaml"), manifest);
        await runRadBicepPublishExtension({
          fromFile: path.join(ws, "custom-types.yaml"),
          target: path.join(ws, "custom-types.tgz")
        });
        fs.writeFileSync(
          path.join(ws, "bicepconfig.json"),
          JSON.stringify({
            experimentalFeaturesEnabled: { extensibility: true },
            extensions: {
              radius: "br:biceptypes.azurecr.io/radius:latest",
              customTypes: "./custom-types.tgz"
            }
          })
        );
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
          ""
        ].join("\n");
        // The assertion that matters: this does not throw. Without the merged
        // config + copied tgz, rad would fail with BCP204 (extension not recognized).
        const resources = await buildGraphViaRad(app, ".radius/app.bicep", {
          radArtifactsDir: ws
        });
        expect(Array.isArray(resources)).toBe(true);
      } finally {
        try {
          fs.rmSync(ws, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }, 180000);
  }
);

describe("bicep publish arg builders", () => {
  it("builds publish-extension args with --force", () => {
    expect(bicepPublishExtensionArgs("/a/from.yaml", "/a/out.tgz")).toEqual([
      "bicep",
      "publish-extension",
      "--from-file",
      "/a/from.yaml",
      "--target",
      "/a/out.tgz",
      "--force"
    ]);
  });
  it("builds publish args (no --force, auth flows through env)", () => {
    expect(
      bicepPublishArgs("/a/recipe.bicep", "br:ghcr.io/acme/app/r:1.0.0")
    ).toEqual([
      "bicep",
      "publish",
      "--file",
      "/a/recipe.bicep",
      "--target",
      "br:ghcr.io/acme/app/r:1.0.0"
    ]);
  });
});

// spawnRad drives a real child process, so the fake `rad` is an executable
// shebang script; that only works on POSIX. Skip (don't drop) on Windows.
const describeSpawn = process.platform === "win32" ? describe.skip : describe;
describeSpawn("spawnRad", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawnrad-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function fakeRad(body: string): string {
    const p = path.join(dir, "rad");
    fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, "utf8");
    fs.chmodSync(p, 0o755);
    return p;
  }

  it("resolves with stdout/stderr on a zero exit", async () => {
    const bin = fakeRad(
      `process.stdout.write("out");process.stderr.write("err");process.exit(0);`
    );
    const { stdout, stderr } = await spawnRad(bin, ["x"], { timeout: 5000 });
    expect(stdout).toBe("out");
    expect(stderr).toBe("err");
  });

  it("rejects with the exit code and both streams on a non-zero exit", async () => {
    // rad prints BCP* compile errors to stdout, so stdout must survive on the error.
    const bin = fakeRad(`process.stdout.write("BCP204 boom");process.exit(3);`);
    await expect(
      spawnRad(bin, ["x"], { timeout: 5000, label: "rad bicep publish" })
    ).rejects.toMatchObject({
      message: expect.stringContaining("rad bicep publish exited with code 3"),
      stdout: "BCP204 boom"
    });
  });

  it("rejects with a timeout when the process does not exit", async () => {
    const bin = fakeRad(`setTimeout(() => {}, 60000);`);
    await expect(
      spawnRad(bin, ["x"], { timeout: 300, label: "rad bicep publish" })
    ).rejects.toThrow(/timed out after 300ms/);
  }, 10000);

  it("rejects when the binary cannot be spawned", async () => {
    await expect(
      spawnRad(path.join(dir, "does-not-exist"), ["x"], { timeout: 2000 })
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("saveGraphJson", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-save-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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
    const messages: string[] = [];
    expect(() =>
      saveGraphJson(dest, "{}", (m) => messages.push(m))
    ).not.toThrow();
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
  let savedPin: string | undefined;

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
      source: "GitHub release digest"
    });
  });

  it("prefers an explicit RADIUS_RAD_SHA256 pin over the published digest", () => {
    process.env.RADIUS_RAD_SHA256 = `sha256:${pinnedHex.toUpperCase()}`;
    expect(expectedDigest(assets, ASSET, "v1.2.3")).toEqual({
      hex: pinnedHex,
      source: "RADIUS_RAD_SHA256"
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
      source: "RADIUS_RAD_SHA256"
    });
  });
});

describe("tryAcquireLock", () => {
  let tmp: string;
  let lockPath: string;

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
    release?.();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("writes the current pid into the lock file", () => {
    const release = tryAcquireLock(lockPath);
    try {
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    } finally {
      release?.();
    }
  });

  it("returns null when a fresh lock is already held", () => {
    const release = tryAcquireLock(lockPath);
    try {
      expect(tryAcquireLock(lockPath)).toBeNull();
    } finally {
      release?.();
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
    release?.();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("lets a lock be re-acquired after it is released", () => {
    tryAcquireLock(lockPath)?.();
    const second = tryAcquireLock(lockPath);
    expect(typeof second).toBe("function");
    second?.();
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
    const missing = path.join(
      os.tmpdir(),
      "definitely-not-rad",
      `rad-${Date.now()}`
    );
    await expect(
      radBinaryVersion(missing, { timeout: 2000 })
    ).resolves.toBeNull();
  });
});

// These reconciliation tests write executable shebang scripts and spawn them as
// a fake `rad`, which only works on POSIX. Skip (don't silently drop) on Windows
// so the suite still registers tests rather than erroring as empty.
const describeReconcile =
  process.platform === "win32" ? describe.skip : describe;
describeReconcile("ensureRadBinary version reconciliation", () => {
  const RELEASES_API =
    "https://api.github.com/repos/radius-project/radius/releases/latest";
  const savedEnv: Record<string, string | undefined> = {};
  let managedBackup: Buffer | null = null;
  let managedMode: number | null = null;
  let bicepBackup: Buffer | null = null;
  let bicepMode: number | null = null;

  function writeFakeRad(dest: string, version: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      `#!/usr/bin/env node
if (process.argv.includes("version")) {
  process.stdout.write(JSON.stringify({ version: "${version}" }));
}
`,
      "utf8"
    );
    fs.chmodSync(dest, 0o755);
  }

  beforeEach(() => {
    savedEnv.RADIUS_RAD_BINARY = process.env.RADIUS_RAD_BINARY;
    savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK =
      process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    if (fs.existsSync(MANAGED_RAD_PATH)) {
      managedBackup = fs.readFileSync(MANAGED_RAD_PATH);
      managedMode = fs.statSync(MANAGED_RAD_PATH).mode;
    } else {
      managedBackup = null;
      managedMode = null;
    }
    if (fs.existsSync(MANAGED_BICEP_PATH)) {
      bicepBackup = fs.readFileSync(MANAGED_BICEP_PATH);
      bicepMode = fs.statSync(MANAGED_BICEP_PATH).mode;
    } else {
      bicepBackup = null;
      bicepMode = null;
    }
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
    fs.mkdirSync(path.dirname(MANAGED_BICEP_PATH), { recursive: true });
    fs.writeFileSync(MANAGED_BICEP_PATH, "bicep");
    if (process.platform !== "win32") fs.chmodSync(MANAGED_BICEP_PATH, 0o755);
  });

  afterEach(() => {
    if (savedEnv.RADIUS_RAD_BINARY === undefined)
      delete process.env.RADIUS_RAD_BINARY;
    else process.env.RADIUS_RAD_BINARY = savedEnv.RADIUS_RAD_BINARY;
    if (savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK === undefined)
      delete process.env.RADIUS_RAD_SKIP_VERSION_CHECK;
    else
      process.env.RADIUS_RAD_SKIP_VERSION_CHECK =
        savedEnv.RADIUS_RAD_SKIP_VERSION_CHECK;
    fs.rmSync(MANAGED_RAD_PATH, { force: true });
    if (managedBackup) {
      fs.mkdirSync(path.dirname(MANAGED_RAD_PATH), { recursive: true });
      fs.writeFileSync(MANAGED_RAD_PATH, managedBackup);
      if (managedMode !== null) fs.chmodSync(MANAGED_RAD_PATH, managedMode);
    }
    fs.rmSync(MANAGED_BICEP_PATH, { force: true });
    if (bicepBackup) {
      fs.mkdirSync(path.dirname(MANAGED_BICEP_PATH), { recursive: true });
      fs.writeFileSync(MANAGED_BICEP_PATH, bicepBackup);
      if (bicepMode !== null) fs.chmodSync(MANAGED_BICEP_PATH, bicepMode);
    }
    vi.restoreAllMocks();
  });

  it("upgrades an older managed binary to the latest release", async () => {
    delete process.env.RADIUS_RAD_BINARY;
    writeFakeRad(MANAGED_RAD_PATH, "v0.1.0");

    const asset = releaseAsset();
    const tag = "v0.2.0";
    const downloadUrl = `https://github.com/radius-project/radius/releases/download/${tag}/${asset}`;
    const calls: string[] = [];
    mockHttpsGet(
      {
        [RELEASES_API]: {
          body: JSON.stringify({
            tag_name: tag,
            assets: [{ name: asset, digest: "" }]
          })
        },
        [downloadUrl]: {
          body: `#!/usr/bin/env node
if (process.argv.includes("version")) {
  process.stdout.write(JSON.stringify({ version: "${tag}" }));
}
`
        }
      },
      calls
    );

    const logs: string[] = [];
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
    const calls: string[] = [];
    mockHttpsGet(
      {
        [RELEASES_API]: {
          body: JSON.stringify({
            tag_name: tag,
            assets: [{ name: asset, digest: "" }]
          })
        }
      },
      calls
    );

    const logs: string[] = [];
    const resolved = await ensureRadBinary({ log: (m) => logs.push(m) });

    expect(resolved).toBe(override);
    expect(calls).toEqual([RELEASES_API]);
    expect(calls).not.toContain(downloadUrl);
    expect(
      logs.some(
        (m) => m.includes("RADIUS_RAD_BINARY") && m.includes("using it anyway")
      )
    ).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("skips the version check network call when RADIUS_RAD_SKIP_VERSION_CHECK is set", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rad-skip-check-"));
    const override = path.join(tmp, "rad");
    writeFakeRad(override, "v0.1.0");
    process.env.RADIUS_RAD_BINARY = override;
    process.env.RADIUS_RAD_SKIP_VERSION_CHECK = "1";

    const calls: string[] = [];
    mockHttpsGet({}, calls);
    const resolved = await ensureRadBinary();

    expect(resolved).toBe(override);
    expect(calls).toEqual([]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
