import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RadProcessError, spawnRad } from "./rad-process.mjs";

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

  it("kills the timed-out executable and its descendant process", async () => {
    const error = await spawnRad(radPath, [childHarnessPath, "process-tree"], {
      timeout: 3_000,
      label: "managed rad fixture"
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

    await waitForProcessesToExit([
      processTree.parentPid,
      processTree.descendantPid
    ]);
  }, 15_000);

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

async function waitForProcessesToExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (pids.some(isProcessRunning)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed-out process tree is still running: ${pids}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
