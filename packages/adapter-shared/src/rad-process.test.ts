import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdio?: string[];
  windowsHide?: boolean;
  detached?: boolean;
}

class FakeSpawnedProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  readonly kill = vi.fn();
}

describe("rad process spawn policy", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    vi.unstubAllEnvs();
    restoreProcessPlatform();
  });

  it("passes the Windows managed rad spawn contract to child_process.spawn", async () => {
    setProcessPlatform("win32");
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(
      (_file: string, _args: string[], _options: SpawnOptions) => child
    );
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");

    const result = spawnRad("C:\\tools\\rad.exe", ["version"], {
      cwd: "C:\\workspace",
      env: { RADIUS_TEST_ENV: "1" },
      timeout: 5_000
    });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      "C:\\tools\\rad.exe",
      ["version"],
      expect.objectContaining({
        cwd: "C:\\workspace",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: false
      })
    );
    expect(spawn.mock.calls[0]?.[2].env).toMatchObject({
      RADIUS_TEST_ENV: "1"
    });

    child.stdout.end("version stdout");
    child.stderr.end("version stderr");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({
      stdout: "version stdout",
      stderr: "version stderr"
    });
  });

  it("resolves taskkill from SystemRoot so timeout cleanup survives sanitized PATH", async () => {
    setProcessPlatform("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("PATH", "");
    const spawn = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn }));
    const { killChildTree } = await import("./rad-process.mjs");
    const child = Object.assign(new EventEmitter(), {
      pid: 67890,
      kill: vi.fn(() => true)
    });

    killChildTree(child);

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "67890", "/t", "/f"],
      { stdio: "ignore", windowsHide: true }
    );
  });
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
}

function restoreProcessPlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}
