import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultNodeExecutable,
  listNodeVersionDirectories,
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
}

function createDeps(overrides: DepsOverrides = {}): NodeExecutableDependencies {
  const present = new Set(overrides.present ?? []);
  const entries = overrides.entries ?? {};
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
      ((directory: string) => entries[directory] ?? [])
  };
}

describe("resolveNodeExecutable", () => {
  it("prefers the extension's own runtime when it is a real node binary", () => {
    const deps = createDeps({
      execPath: "/usr/local/bin/node",
      env: { PATH: "/usr/bin" },
      present: ["/usr/local/bin/node", "/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps)).toBe("/usr/local/bin/node");
  });

  it("ignores the embedded Copilot runtime, which cannot run a script file", () => {
    const deps = createDeps({
      execPath: "/opt/copilot/copilot",
      env: { PATH: "/usr/bin" },
      present: ["/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps)).toBe("/usr/bin/node");
  });

  it("scans PATH entries in order and skips directories without node", () => {
    const deps = createDeps({
      env: { PATH: "/empty:/tools/bin:/usr/bin" },
      present: ["/tools/bin/node", "/usr/bin/node"]
    });

    expect(resolveNodeExecutable(deps)).toBe("/tools/bin/node");
  });

  it("ignores blank and quoted PATH entries", () => {
    const deps = createDeps({
      env: { PATH: '::  : "/tools/bin" ' },
      present: ["/tools/bin/node"]
    });

    expect(resolveNodeExecutable(deps)).toBe("/tools/bin/node");
  });

  it.each([
    ["homebrew on Apple silicon", "/opt/homebrew/bin/node"],
    ["a volta shim", `${POSIX_HOME}/.volta/bin/node`],
    ["a user-local install", `${POSIX_HOME}/.local/bin/node`],
    ["an n install", `${POSIX_HOME}/n/bin/node`]
  ])("falls back to %s when PATH has no node", (_label, expected) => {
    const deps = createDeps({ platform: "darwin", present: [expected] });

    expect(resolveNodeExecutable(deps)).toBe(expected);
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

    expect(resolveNodeExecutable(deps)).toBe(`${versions}/v24.20.0/bin/node`);
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

    expect(resolveNodeExecutable(deps)).toBe(`${versions}/v24.20.0.1/bin/node`);
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

    expect(resolveNodeExecutable(deps)).toBe(`${versions}/v24.20.0/bin/node`);
  });

  it("honors NVM_DIR when nvm is installed outside the home directory", () => {
    const deps = createDeps({
      env: { NVM_DIR: "/opt/nvm" },
      entries: { "/opt/nvm/versions/node": ["v24.20.0"] },
      present: ["/opt/nvm/versions/node/v24.20.0/bin/node"]
    });

    expect(resolveNodeExecutable(deps)).toBe(
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

    expect(resolveNodeExecutable(deps)).toBe("/usr/bin/node");
  });

  it("returns null when nothing on the machine provides node", () => {
    const deps = createDeps({ env: { PATH: "/usr/bin" } });

    expect(resolveNodeExecutable(deps)).toBeNull();
    expect(deps.pathExists).toHaveBeenCalledWith("/usr/bin/node");
    expect(deps.pathExists).toHaveBeenCalledWith("/opt/homebrew/bin/node");
  });

  describe("on Windows", () => {
    it("looks for node.exe on PATH using the Windows separator", () => {
      const deps = createDeps({
        platform: "win32",
        env: { Path: "C:\\tools;C:\\nodejs" },
        present: ["C:\\nodejs\\node.exe"]
      });

      expect(resolveNodeExecutable(deps)).toBe("C:\\nodejs\\node.exe");
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

      expect(resolveNodeExecutable(deps)).toBe(expected);
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

      expect(resolveNodeExecutable(deps)).toBe(
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

      expect(resolveNodeExecutable(deps)).toBeNull();
    });

    it("accepts the extension runtime named node.exe in any casing", () => {
      const deps = createDeps({
        platform: "win32",
        execPath: "C:\\nodejs\\NODE.EXE",
        present: ["C:\\nodejs\\NODE.EXE"]
      });

      expect(resolveNodeExecutable(deps)).toBe("C:\\nodejs\\NODE.EXE");
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

describe("defaultNodeExecutable", () => {
  it("finds the interpreter this test run is using", () => {
    // Vitest runs under a real node, so the process runtime itself is the
    // highest-precedence candidate and resolves without a filesystem search.
    expect(defaultNodeExecutable()).toBe(process.execPath);
  });
});
