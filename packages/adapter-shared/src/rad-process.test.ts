import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  radSpawnCommand,
  resolveWindowsLauncherPath,
  spawnRad,
  windowsLauncherFilename
} from "./rad-process.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows Radius launcher selection", () => {
  it.each([
    ["x64", "windows-radius-launcher-x64.exe"],
    ["arm64", "windows-radius-launcher-arm64.exe"]
  ])("maps Node architecture %s to %s", (architecture, expected) => {
    expect(windowsLauncherFilename(architecture)).toBe(expected);
  });

  it("rejects unsupported Windows architectures", () => {
    expect(() => windowsLauncherFilename("ia32")).toThrow(
      'Managed Radius does not support Windows architecture "ia32".'
    );
  });

  it.each(["x64", "arm64"])(
    "resolves the committed %s launcher from the source module",
    (architecture) => {
      expect(resolveWindowsLauncherPath(architecture)).toBe(
        join(
          sourceDirectory,
          "..",
          "native",
          "windows-launcher",
          "bin",
          windowsLauncherFilename(architecture)
        )
      );
    }
  );

  it("resolves a packaged launcher from an ancestor bin directory", () => {
    const root = mkdtempSync(join(tmpdir(), "packaged-radius-launcher-"));
    temporaryDirectories.push(root);
    const nestedModule = join(root, "skills", "app", "scripts", "entry.mjs");
    const packagedBin = join(root, "bin");
    mkdirSync(dirname(nestedModule), { recursive: true });
    mkdirSync(packagedBin);
    const source = resolveWindowsLauncherPath("x64");
    const packaged = join(packagedBin, windowsLauncherFilename("x64"));
    copyFileSync(source, packaged);

    expect(
      resolveWindowsLauncherPath("x64", pathToFileURL(nestedModule).href)
    ).toBe(packaged);
  });

  it("fails explicitly when no source or packaged launcher exists", () => {
    const root = mkdtempSync(join(tmpdir(), "missing-radius-launcher-"));
    temporaryDirectories.push(root);
    const moduleUrl = pathToFileURL(join(root, "entry.mjs")).href;

    expect(() => resolveWindowsLauncherPath("x64", moduleUrl)).toThrow(
      'The packaged Windows Radius launcher "windows-radius-launcher-x64.exe" is missing.'
    );
  });

  it("leaves POSIX execution unchanged", () => {
    expect(
      radSpawnCommand("/managed/rad", ["version"], { platform: "linux" })
    ).toEqual({
      executable: "/managed/rad",
      args: ["version"]
    });
  });

  it("routes Windows execution through the architecture-matched launcher", () => {
    const command = radSpawnCommand("C:\\managed\\rad.exe", ["version"], {
      platform: "win32",
      architecture: "arm64"
    });

    expect(command.executable).toBe(resolveWindowsLauncherPath("arm64"));
    expect(command.args).toEqual([
      String(process.pid),
      "C:\\managed\\rad.exe",
      "version"
    ]);
  });
});

describe("spawnRad cancellation", () => {
  it("rejects without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      spawnRad("does-not-exist", [], {
        label: "Managed Radius test",
        signal: controller.signal
      })
    ).rejects.toMatchObject({
      message: "Managed Radius test aborted",
      stdout: "",
      stderr: ""
    });
  });

  it("terminates and rejects a running command when aborted", async () => {
    const controller = new AbortController();
    const run = spawnRad(
      process.execPath,
      ["-e", 'process.stdout.write("started");setInterval(() => {}, 60000);'],
      {
        label: "Managed Radius test",
        signal: controller.signal,
        timeout: 5000
      }
    );
    setTimeout(() => controller.abort(), 500);

    await expect(run).rejects.toMatchObject({
      message: "Managed Radius test aborted",
      stdout: "started",
      stderr: ""
    });
  });
});
