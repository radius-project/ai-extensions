import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RadProcessError,
  RadProcessExitUnconfirmedError,
  spawnRad
} from "./rad-process.mjs";
import { resolveExistingRadBinary, resolveRadiusExtensionRef } from "./rad.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const childHarnessPath = fileURLToPath(
  new URL("../test/fixtures/spawn-rad-child.mjs", import.meta.url)
);

interface ProcessTree {
  parentPid: number;
  descendantPid: number;
}

describeWindows("spawnRad Windows process integration", () => {
  let directory = "";
  let radPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "radius spawnRad "));
    radPath = join(directory, "rad.exe");
    await copyFile(process.execPath, radPath);
  });

  afterAll(async () => {
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 50,
        retryDelay: 100
      });
    }
  });

  it("captures both streams after the ignored stdin reaches EOF", async () => {
    const result = await spawnRad(
      radPath,
      [childHarnessPath, "success", "two words", 'say "hello"'],
      { timeout: 5_000 }
    );

    expect(result).toEqual({
      stdout: JSON.stringify(["two words", 'say "hello"']),
      stderr: "fixture stderr"
    });
  });

  it("uses a relative developer override from a different graph working directory", async () => {
    const graphDirectory = join(directory, "graph workspace");
    await mkdir(graphDirectory);
    const previousDirectory = process.cwd();
    const previousOverride = process.env.RADIUS_RAD_BINARY;
    try {
      process.chdir(directory);
      process.env.RADIUS_RAD_BINARY = "rad.exe";
      const selected = resolveExistingRadBinary(
        join(directory, "missing-managed.exe")
      );
      expect(selected).toBe(join(process.cwd(), "rad.exe"));
      await expect(
        resolveRadiusExtensionRef({
          radPath: selected ?? "",
          readVersion: async () => "edge"
        })
      ).resolves.toBe("br:biceptypes.azurecr.io/radius:latest");
      await expect(
        spawnRad(selected ?? "", [childHarnessPath, "success", "two words"], {
          cwd: graphDirectory,
          timeout: 5_000
        })
      ).resolves.toEqual({
        stdout: JSON.stringify(["two words"]),
        stderr: "fixture stderr"
      });
    } finally {
      process.chdir(previousDirectory);
      if (previousOverride === undefined) delete process.env.RADIUS_RAD_BINARY;
      else process.env.RADIUS_RAD_BINARY = previousOverride;
    }
  });

  it("propagates a non-zero exit with both captured streams", async () => {
    const error = await spawnRad(radPath, [childHarnessPath, "failure"], {
      timeout: 5_000,
      label: "managed rad fixture"
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RadProcessError);
    expect(error).toMatchObject({
      message: "managed rad fixture exited with code 23",
      stdout: "fixture stdout",
      stderr: "fixture failure"
    });
  });

  it("drains the timed-out executable and its descendant before settling", async () => {
    const error = await spawnRad(radPath, [childHarnessPath, "process-tree"], {
      timeout: 3_000,
      label: "managed rad fixture",
      drainOnTimeout: true
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RadProcessError);
    expect(error).toMatchObject({
      message: "managed rad fixture timed out after 3000ms",
      stderr: ""
    });

    const processTree = JSON.parse(
      (error as RadProcessError).stdout.trim()
    ) as ProcessTree;
    expect(processTree.parentPid).toBeGreaterThan(0);
    expect(processTree.descendantPid).toBeGreaterThan(0);

    expect(isProcessRunning(processTree.parentPid)).toBe(false);
    expect(isProcessRunning(processTree.descendantPid)).toBe(false);
  }, 15_000);

  it("drains the cancelled executable and its descendant before settling", async () => {
    const ready = join(directory, "validator-ready.json");
    const controller = new AbortController();
    const result = spawnRad(
      radPath,
      [childHarnessPath, "process-tree", ready],
      {
        label: "validator fixture",
        signal: controller.signal,
        timeout: 5000
      }
    ).catch((error: unknown) => error);
    try {
      const { parentPid, descendantPid } = await vi.waitFor(
        async () => JSON.parse(await readFile(ready, "utf8")) as ProcessTree
      );
      expect(isProcessRunning(parentPid)).toBe(true);
      expect(isProcessRunning(descendantPid)).toBe(true);
      controller.abort();
      expect(await result).toMatchObject({
        message: "validator fixture was cancelled"
      });
      expect(isProcessRunning(parentPid)).toBe(false);
      expect(isProcessRunning(descendantPid)).toBe(false);
    } finally {
      controller.abort();
      await result;
    }
  });

  it("reports unconfirmed tree exit if the native taskkill executable cannot start", async () => {
    const result = spawnRad(radPath, [childHarnessPath, "wait"], {
      timeout: 500,
      drainOnTimeout: true
    }).catch((error: unknown) => error);
    vi.stubEnv("SystemRoot", join(directory, "missing-system-root"));
    try {
      const failure = await result;

      expect(failure).toBeInstanceOf(RadProcessExitUnconfirmedError);
      expect(failure).toMatchObject({
        message: expect.stringContaining(
          "Windows process-tree exit could not be confirmed; do not use the affected target."
        )
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects with a RadProcessError when rad.exe cannot be spawned", async () => {
    const error = await spawnRad(join(directory, "missing-rad.exe"), ["x"], {
      timeout: 2_000
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RadProcessError);
    expect(error).toMatchObject({
      stdout: "",
      stderr: ""
    });
    expect((error as RadProcessError).message).toContain("ENOENT");
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
