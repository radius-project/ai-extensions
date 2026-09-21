import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultNodeExecutable,
  createNodeVersionProbe,
  listNodeVersionDirectories,
  MINIMUM_NODE_MAJOR,
  probeNodeVersion,
  resolveNodeExecutable,
  type NodeExecutableDependencies
} from "./node-executable.js";

const POSIX_HOME = "/home/radius";
const WINDOWS_HOME = "C:\\Users\\radius";

interface DepsOverrides extends Omit<
  Partial<NodeExecutableDependencies>,
  "pathExists"
> {
  present?: readonly string[];
  entries?: Readonly<Record<string, readonly string[]>>;
  // Version each candidate reports; anything unlisted answers as a supported
  // release, so a test only spells out the versions it is about.
  versions?: Readonly<Record<string, string | null>>;
}

function createDeps(overrides: DepsOverrides = {}): NodeExecutableDependencies {
  const present = new Set(overrides.present ?? []);
  const entries = overrides.entries ?? {};
  const versions = overrides.versions ?? {};
  return {
    platform: overrides.platform ?? "linux",
    env: overrides.env ?? {},
    execPath: overrides.execPath ?? "/opt/copilot/copilot",
    homeDir:
      overrides.homeDir ??
      (overrides.platform === "win32" ? WINDOWS_HOME : POSIX_HOME),
    pathExists: vi.fn((filePath: string) => present.has(filePath)),
    listDirectory:
      overrides.listDirectory ??
      ((directory: string) => entries[directory] ?? []),
    probeVersion:
      overrides.probeVersion ??
      vi.fn((executable: string) =>
        executable in versions ? versions[executable] : "v24.20.0"
      )
  };
}

describe("resolveNodeExecutable", () => {
  it("prefers the extension's own runtime when it is a real node binary", () => {
    const deps = createDeps({
      execPath: "/usr/local/bin/node",
      env: { PATH: "/usr/bin" },
      present: ["/usr/local/bin/node", "/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps).executable).toBe("/usr/local/bin/node");
  });

  it("ignores the embedded Copilot runtime, which cannot run a script file", () => {
    const deps = createDeps({
      execPath: "/opt/copilot/copilot",
      env: { PATH: "/usr/bin" },
      present: ["/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps).executable).toBe("/usr/bin/node");
  });

  it("scans PATH entries in order and skips directories without node", () => {
    const deps = createDeps({
      env: { PATH: "/empty:/tools/bin:/usr/bin" },
      present: ["/tools/bin/node", "/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps).executable).toBe("/tools/bin/node");
  });

  it("ignores blank and quoted PATH entries", () => {
    const deps = createDeps({
      env: { PATH: '::  : "/tools/bin" ' },
      present: ["/tools/bin/node"]
    });

    expect(resolveNodeExecutable(deps).executable).toBe("/tools/bin/node");
  });

  it.each([
    ["homebrew on Apple silicon", "/opt/homebrew/bin/node"],
    ["a volta shim", `${POSIX_HOME}/.volta/bin/node`],
    ["a user-local install", `${POSIX_HOME}/.local/bin/node`],
    ["an n install", `${POSIX_HOME}/n/bin/node`]
  ])("falls back to %s when PATH has no node", (_label, expected) => {
    const deps = createDeps({ platform: "darwin", present: [expected] });

    expect(resolveNodeExecutable(deps).executable).toBe(expected);
  });

  it("uses the newest nvm version directory", () => {
    const versions = `${POSIX_HOME}/.nvm/versions/node`;
    const deps = createDeps({
      entries: { [versions]: ["v18.20.4", "v24.9.0", "v24.20.0", "iojs"] },
      present: [
        `${versions}/v24.20.0/bin/node`,
        `${versions}/v24.9.0/bin/node`,
        `${versions}/v18.20.4/bin/node`
      ]
    });

    expect(resolveNodeExecutable(deps).executable).toBe(
      `${versions}/v24.20.0/bin/node`
    );
  });

  it.each([
    ["a shorter version listed first", ["v24.20", "v24.20.0.1"]],
    ["a shorter version listed last", ["v24.20.0.1", "v24.20"]]
  ])("orders %s by its numeric segments", (_label, entries) => {
    const versions = `${POSIX_HOME}/.nvm/versions/node`;
    const deps = createDeps({
      entries: { [versions]: entries },
      present: [
        `${versions}/v24.20/bin/node`,
        `${versions}/v24.20.0.1/bin/node`
      ]
    });

    expect(resolveNodeExecutable(deps).executable).toBe(
      `${versions}/v24.20.0.1/bin/node`
    );
  });

  it("keeps the listed order for version directories that compare equal", () => {
    const versions = `${POSIX_HOME}/.nvm/versions/node`;
    const deps = createDeps({
      entries: { [versions]: ["v24.20.0", "v24.20.0.0", "v20.11.1"] },
      present: [
        `${versions}/v24.20.0/bin/node`,
        `${versions}/v24.20.0.0/bin/node`
      ]
    });

    expect(resolveNodeExecutable(deps).executable).toBe(
      `${versions}/v24.20.0/bin/node`
    );
  });

  it("honors NVM_DIR when nvm is installed outside the home directory", () => {
    const deps = createDeps({
      env: { NVM_DIR: "/opt/nvm" },
      entries: { "/opt/nvm/versions/node": ["v24.20.0"] },
      present: ["/opt/nvm/versions/node/v24.20.0/bin/node"]
    });

    expect(resolveNodeExecutable(deps).executable).toBe(
      "/opt/nvm/versions/node/v24.20.0/bin/node"
    );
  });

  it("treats an unreadable version directory as no candidates", () => {
    const deps = createDeps({
      listDirectory: () => {
        throw new Error("EACCES");
      },
      present: ["/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps).executable).toBe("/usr/bin/node");
  });

  it("returns null when nothing on the machine provides node", () => {
    const deps = createDeps({ env: { PATH: "/usr/bin" } });

    expect(resolveNodeExecutable(deps).executable).toBeNull();
    expect(deps.pathExists).toHaveBeenCalledWith("/usr/bin/node");
    expect(deps.pathExists).toHaveBeenCalledWith("/opt/homebrew/bin/node");
  });

  describe("version gate", () => {
    it("skips an installation older than the supported minimum", () => {
      const deps = createDeps({
        env: { PATH: "/old/bin:/new/bin" },
        present: ["/old/bin/node", "/new/bin/node"],
        versions: { "/old/bin/node": "v16.20.2" }
      });

      expect(resolveNodeExecutable(deps).executable).toBe("/new/bin/node");
    });

    it.each([
      ["the oldest supported release", `v${MINIMUM_NODE_MAJOR}.0.0`],
      ["a current release", "v24.20.0"],
      ["a version printed without the v prefix", "22.14.0"]
    ])("accepts %s", (_label, version) => {
      const deps = createDeps({
        env: { PATH: "/usr/bin" },
        present: ["/usr/bin/node"],
        versions: { "/usr/bin/node": version }
      });

      expect(resolveNodeExecutable(deps).executable).toBe("/usr/bin/node");
    });

    it.each([
      [
        "one major below the minimum",
        `v${MINIMUM_NODE_MAJOR - 1}.20.2`,
        "unsupported-version"
      ],
      ["a file that is not node", "GNU coreutils 9.1", "not-node"],
      ["a candidate that could not be run", null, "not-node"]
    ])("refuses %s and reports what it found", (_label, version, reason) => {
      const deps = createDeps({
        env: { PATH: "/usr/bin" },
        present: ["/usr/bin/node"],
        versions: { "/usr/bin/node": version }
      });

      expect(resolveNodeExecutable(deps)).toEqual({
        executable: null,
        rejected: [{ executable: "/usr/bin/node", version, reason }]
      });
    });

    it("reports every refused installation in probe order", () => {
      const deps = createDeps({
        env: { PATH: "/first/bin:/second/bin" },
        present: ["/first/bin/node", "/second/bin/node"],
        versions: {
          "/first/bin/node": "v14.21.3",
          "/second/bin/node": "v16.20.2"
        }
      });

      expect(resolveNodeExecutable(deps).rejected).toEqual([
        {
          executable: "/first/bin/node",
          version: "v14.21.3",
          reason: "unsupported-version"
        },
        {
          executable: "/second/bin/node",
          version: "v16.20.2",
          reason: "unsupported-version"
        }
      ]);
    });

    it("keeps the refused installations found before a usable one", () => {
      const deps = createDeps({
        env: { PATH: "/old/bin:/new/bin" },
        present: ["/old/bin/node", "/new/bin/node"],
        versions: { "/old/bin/node": "v16.20.2" }
      });

      expect(resolveNodeExecutable(deps).rejected).toEqual([
        {
          executable: "/old/bin/node",
          version: "v16.20.2",
          reason: "unsupported-version"
        }
      ]);
    });

    it("probes a repeated candidate only once", () => {
      const deps = createDeps({
        env: { PATH: "/usr/bin:/usr/bin" },
        present: ["/usr/bin/node"],
        versions: { "/usr/bin/node": "v16.20.2" }
      });

      const resolution = resolveNodeExecutable(deps);

      expect(deps.probeVersion).toHaveBeenCalledTimes(1);
      expect(resolution.rejected).toHaveLength(1);
    });
  });

  describe("path safety", () => {
    it("ignores a relative PATH entry", () => {
      const deps = createDeps({
        env: { PATH: "tools:../bin:/usr/bin" },
        present: ["tools/node", "../bin/node", "/usr/bin/node"]
      });

      expect(resolveNodeExecutable(deps)).toEqual({
        executable: "/usr/bin/node",
        rejected: []
      });
      expect(deps.probeVersion).toHaveBeenCalledTimes(1);
    });

    it("ignores a relative PATH entry on Windows", () => {
      const deps = createDeps({
        platform: "win32",
        env: { PATH: "tools;C:\\Program Files\\nodejs" },
        present: ["tools\\node.exe", "C:\\Program Files\\nodejs\\node.exe"]
      });

      expect(resolveNodeExecutable(deps).executable).toBe(
        "C:\\Program Files\\nodejs\\node.exe"
      );
    });

    it.each([
      ["a command substitution", "/opt/$(whoami)/bin/node"],
      ["a backquote", "/opt/`id`/bin/node"],
      ["an embedded double quote", '/opt/we"ird/bin/node'],
      ["a backslash escape", "/opt/we\\ird/bin/node"],
      ["a control character", "/opt/we\u0007ird/bin/node"]
    ])("refuses a path containing %s without running it", (_label, unsafe) => {
      const deps = createDeps({
        env: { PATH: `${path.posix.dirname(unsafe)}:/usr/bin` },
        present: [unsafe]
      });

      expect(resolveNodeExecutable(deps)).toEqual({
        executable: null,
        rejected: [{ executable: unsafe, version: null, reason: "unsafe-path" }]
      });
      expect(deps.probeVersion).not.toHaveBeenCalled();
    });

    it("refuses a Windows path that cmd would expand", () => {
      const deps = createDeps({
        platform: "win32",
        env: { PATH: "C:\\%USERNAME%\\nodejs" },
        present: ["C:\\%USERNAME%\\nodejs\\node.exe"]
      });

      expect(resolveNodeExecutable(deps).rejected).toEqual([
        {
          executable: "C:\\%USERNAME%\\nodejs\\node.exe",
          version: null,
          reason: "unsafe-path"
        }
      ]);
    });

    it("keeps a Windows path whose only backslashes are separators", () => {
      const deps = createDeps({
        platform: "win32",
        env: { PATH: "C:\\Program Files\\nodejs" },
        present: ["C:\\Program Files\\nodejs\\node.exe"]
      });

      expect(resolveNodeExecutable(deps).executable).toBe(
        "C:\\Program Files\\nodejs\\node.exe"
      );
    });

    it("continues past an unsafe path to a usable installation", () => {
      const deps = createDeps({
        env: { PATH: "/opt/$(id)/bin:/usr/bin" },
        present: ["/opt/$(id)/bin/node", "/usr/bin/node"]
      });

      expect(resolveNodeExecutable(deps).executable).toBe("/usr/bin/node");
    });
  });

  describe("on Windows", () => {
    it("looks for node.exe on PATH using the Windows separator", () => {
      const deps = createDeps({
        platform: "win32",
        env: { Path: "C:\\tools;C:\\nodejs" },
        present: ["C:\\nodejs\\node.exe"]
      });

      expect(resolveNodeExecutable(deps).executable).toBe(
        "C:\\nodejs\\node.exe"
      );
    });

    it.each([
      [
        "Program Files",
        { ProgramFiles: "C:\\Program Files" },
        "C:\\Program Files\\nodejs\\node.exe"
      ],
      [
        "the 32-bit Program Files",
        { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        "C:\\Program Files (x86)\\nodejs\\node.exe"
      ],
      [
        "a per-user install",
        { LOCALAPPDATA: "C:\\Users\\radius\\AppData\\Local" },
        "C:\\Users\\radius\\AppData\\Local\\Programs\\nodejs\\node.exe"
      ],
      [
        "a volta shim",
        { LOCALAPPDATA: "C:\\Users\\radius\\AppData\\Local" },
        "C:\\Users\\radius\\AppData\\Local\\Volta\\bin\\node.exe"
      ],
      [
        "chocolatey",
        { ChocolateyInstall: "C:\\ProgramData\\chocolatey" },
        "C:\\ProgramData\\chocolatey\\bin\\node.exe"
      ],
      ["scoop", {}, "C:\\Users\\radius\\scoop\\shims\\node.exe"]
    ])("finds an installation under %s", (_label, env, expected) => {
      const deps = createDeps({
        platform: "win32",
        env,
        present: [expected]
      });

      expect(resolveNodeExecutable(deps).executable).toBe(expected);
    });

    it("uses the newest nvm-windows version directory", () => {
      const deps = createDeps({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\radius\\AppData\\Roaming" },
        entries: {
          "C:\\Users\\radius\\AppData\\Roaming\\nvm": ["v20.11.1", "v24.20.0"]
        },
        present: [
          "C:\\Users\\radius\\AppData\\Roaming\\nvm\\v24.20.0\\node.exe",
          "C:\\Users\\radius\\AppData\\Roaming\\nvm\\v20.11.1\\node.exe"
        ]
      });

      expect(resolveNodeExecutable(deps).executable).toBe(
        "C:\\Users\\radius\\AppData\\Roaming\\nvm\\v24.20.0\\node.exe"
      );
    });

    it("skips the nvm probe entirely when no nvm root is configured", () => {
      const deps = createDeps({
        platform: "win32",
        listDirectory: () => {
          throw new Error("listDirectory must not be called");
        }
      });

      expect(resolveNodeExecutable(deps).executable).toBeNull();
    });

    it("accepts the extension runtime named node.exe in any casing", () => {
      const deps = createDeps({
        platform: "win32",
        execPath: "C:\\nodejs\\NODE.EXE",
        present: ["C:\\nodejs\\NODE.EXE"]
      });

      expect(resolveNodeExecutable(deps).executable).toBe(
        "C:\\nodejs\\NODE.EXE"
      );
    });
  });
});

describe("listNodeVersionDirectories", () => {
  it("lists only subdirectories of a version-manager root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "radius-node-versions-"));
    try {
      await mkdir(path.join(root, "v24.20.0"));
      await mkdir(path.join(root, "v18.20.4"));
      await writeFile(path.join(root, "alias"), "default");

      expect([...listNodeVersionDirectories(root)].sort()).toEqual([
        "v18.20.4",
        "v24.20.0"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for a root that does not exist", () => {
    expect(
      listNodeVersionDirectories(
        path.join(tmpdir(), "radius-node-versions-missing")
      )
    ).toEqual([]);
  });
});

describe("probeNodeVersion", () => {
  it("reports the version a real interpreter prints", () => {
    expect(probeNodeVersion(process.execPath)).toBe(process.version);
  });

  it("returns null for a path that cannot be executed", () => {
    expect(
      probeNodeVersion(path.join(tmpdir(), "radius-not-an-executable"))
    ).toBeNull();
  });

  it.each([
    [
      "the command could not be started",
      { error: new Error("ENOENT"), status: null, stdout: null }
    ],
    ["the command exited nonzero", { status: 1, stdout: "" }],
    ["the command produced no output stream", { status: 0, stdout: null }],
    ["the command printed only whitespace", { status: 0, stdout: "  \n" }]
  ])("returns null when %s", (_label, result) => {
    const probe = createNodeVersionProbe(() => result);

    expect(probe("/usr/bin/node")).toBeNull();
  });

  it("trims the version the command printed", () => {
    const probe = createNodeVersionProbe(() => ({
      status: 0,
      stdout: "v24.20.0\n"
    }));

    expect(probe("/usr/bin/node")).toBe("v24.20.0");
  });

  it("returns null when the command fails", () => {
    // `node --version` on a directory exits nonzero rather than printing a
    // version, which is exactly the shape a non-Node candidate produces.
    expect(probeNodeVersion(tmpdir())).toBeNull();
  });
});

describe("defaultNodeExecutable", () => {
  it("finds the interpreter this test run is using", () => {
    // Vitest runs under a real node, so the process runtime itself is the
    // highest-precedence candidate and resolves without a filesystem search.
    expect(defaultNodeExecutable().executable).toBe(process.execPath);
  });
});
