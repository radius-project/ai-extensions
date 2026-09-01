import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RadProcessError,
  resolveWindowsLauncherPath,
  spawnRad
} from "../../../src/rad-process.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeout = 5000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met before the deadline.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describeWindows("Windows Radius process launcher", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "windows-radius-launcher-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("preserves arguments, cwd, environment, stdout, and stderr", async () => {
    const args = [
      "plain",
      "space separated",
      "",
      'embedded"quote',
      "trailing\\",
      "\u2603"
    ];
    const script = [
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(), env: process.env.RADIUS_LAUNCHER_TEST }));",
      'process.stderr.write("diagnostic");'
    ].join("");

    const result = await spawnRad(process.execPath, ["-e", script, ...args], {
      cwd,
      env: { RADIUS_LAUNCHER_TEST: "present" },
      timeout: 5000
    });

    expect(JSON.parse(result.stdout)).toEqual({
      args,
      cwd,
      env: "present"
    });
    expect(result.stderr).toBe("diagnostic");
  });

  it("returns the target's exact non-zero exit status and output", async () => {
    await expect(
      spawnRad(
        process.execPath,
        [
          "-e",
          'process.stdout.write("out");process.stderr.write("err");process.exit(37);'
        ],
        { label: "rad test", timeout: 5000 }
      )
    ).rejects.toMatchObject({
      message: "rad test exited with code 37",
      stdout: "out",
      stderr: "err"
    });
  });

  it("surfaces a missing target executable", async () => {
    await expect(
      spawnRad(join(cwd, "missing-rad.exe"), [], { timeout: 5000 })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/exited with code 125$/),
      stderr: expect.stringContaining("CreateProcessW")
    });
  });

  it("kills descendants when the target exits successfully", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "child.unref();"
    ].join("");

    const result = await spawnRad(process.execPath, ["-e", script], {
      timeout: 5000
    });

    const descendantPID = Number(result.stdout);
    expect(descendantPID).toBeGreaterThan(0);
    await waitUntil(() => !isProcessAlive(descendantPID));
  });

  it("kills the target tree when the Node parent exits", async () => {
    const pidFile = join(cwd, "target.pid");
    const targetScript = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 60000);"
    ].join("");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      `spawn(${JSON.stringify(resolveWindowsLauncherPath())}, [String(process.pid), process.execPath, "-e", ${JSON.stringify(targetScript)}], { detached: true, stdio: "ignore", windowsHide: true });`,
      "setInterval(() => {}, 60000);"
    ].join("");
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: "ignore",
      windowsHide: true
    });

    try {
      let targetPID = 0;
      await waitUntil(() => {
        if (!existsSync(pidFile)) return false;
        targetPID = Number(readFileSync(pidFile, "utf8"));
        return targetPID > 0;
      });
      expect(targetPID).toBeGreaterThan(0);
      expect(isProcessAlive(targetPID)).toBe(true);

      parent.kill();
      await waitUntil(() => !isProcessAlive(targetPID));
    } finally {
      if (parent.exitCode === null) parent.kill();
    }
  });

  it("kills the complete descendant tree on timeout", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setInterval(() => {}, 60000);"
    ].join("");

    let error: unknown;
    try {
      await spawnRad(process.execPath, ["-e", script], {
        label: "rad timeout test",
        timeout: 500
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RadProcessError);
    expect(error).toMatchObject({
      message: "rad timeout test timed out after 500ms"
    });
    const descendantPID = Number((error as RadProcessError).stdout);
    expect(descendantPID).toBeGreaterThan(0);
    await waitUntil(() => !isProcessAlive(descendantPID));
  });

  it("kills the complete descendant tree on cancellation", async () => {
    const controller = new AbortController();
    const script = [
      'const { spawn } = require("node:child_process");',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setInterval(() => {}, 60000);"
    ].join("");
    const run = spawnRad(process.execPath, ["-e", script], {
      label: "rad cancellation test",
      signal: controller.signal,
      timeout: 5000
    });
    setTimeout(() => controller.abort(), 500);

    let error: unknown;
    try {
      await run;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RadProcessError);
    expect(error).toMatchObject({
      message: "rad cancellation test aborted"
    });
    const descendantPID = Number((error as RadProcessError).stdout);
    expect(descendantPID).toBeGreaterThan(0);
    await waitUntil(() => !isProcessAlive(descendantPID));
  });

  it("creates no console window for a console-subsystem target", async () => {
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const probe = [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }';",
      "[Console]::Out.Write([ConsoleProbe]::GetConsoleWindow().ToInt64())"
    ].join(" ");

    const result = await spawnRad(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe],
      { timeout: 10_000 }
    );

    expect(result.stdout).toBe("0");
  });
});
