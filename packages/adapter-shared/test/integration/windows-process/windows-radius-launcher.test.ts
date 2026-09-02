import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
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

  it("creates no visible console window for a target or its descendant", async () => {
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const probeSource = join(cwd, "console-probe.cs");
    const probeExecutable = join(cwd, "console-probe.exe");
    const observerSource = join(cwd, "window-observer.cs");
    const observerExecutable = join(cwd, "window-observer.exe");
    const observerReady = join(cwd, "observer.ready");
    const observerStop = join(cwd, "observer.stop");
    const observerResult = join(cwd, "observer.txt");
    const observerCheckpoint = join(cwd, "observer.checkpoint");
    const windowMarker = `radius-launcher-${process.pid}-${Date.now()}`;
    writeFileSync(
      probeSource,
      [
        "using System;",
        "using System.Diagnostics;",
        "using System.Reflection;",
        "using System.Runtime.InteropServices;",
        "using System.Text;",
        "public static class ConsoleProbe {",
        '  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();',
        '  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);',
        '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr handle, byte[] buffer, uint bytes, out uint written, IntPtr overlapped);',
        '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);',
        '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetConsoleTitle(string title);',
        '  [DllImport("user32.dll")] static extern void NotifyWinEvent(uint eventType, IntPtr window, int objectId, int childId);',
        "  static int WriteVisibility() {",
        '    byte[] buffer = Encoding.ASCII.GetBytes(IsWindowVisible(GetConsoleWindow()) ? "1" : "0");',
        "    uint written;",
        "    return WriteFile(GetStdHandle(-11), buffer, (uint)buffer.Length, out written, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();",
        "  }",
        "  public static int Main(string[] args) {",
        "    const uint checkpoint = 0x800D;",
        "    SetConsoleTitle(args[0]);",
        "    int result = WriteVisibility();",
        "    if (result != 0 || args.Length > 1) return result;",
        '    Process child = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, args[0] + " descendant") { UseShellExecute = false });',
        "    child.WaitForExit();",
        "    NotifyWinEvent(checkpoint, GetConsoleWindow(), 42, 0);",
        "    return child.ExitCode;",
        "  }",
        "}"
      ].join("\n")
    );
    writeFileSync(
      observerSource,
      [
        "using System;",
        "using System.Collections.Generic;",
        "using System.Diagnostics;",
        "using System.IO;",
        "using System.Runtime.InteropServices;",
        "using System.Text;",
        "using System.Threading;",
        "public static class WindowObserver {",
        "  delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime);",
        "  struct Point { public int X; public int Y; }",
        "  struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Location; public uint Private; }",
        '  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);',
        '  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);',
        '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);',
        '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);',
        '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder className, int maximum);',
        '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int maximum);',
        '  [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);',
        '  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);',
        '  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);',
        "  static string Describe(IntPtr window) {",
        "    uint processId;",
        "    GetWindowThreadProcessId(window, out processId);",
        '    string processName = "unknown";',
        "    try { processName = Process.GetProcessById((int)processId).ProcessName; } catch { }",
        "    StringBuilder className = new StringBuilder(256);",
        "    GetClassName(window, className, className.Capacity);",
        '    return processName + ":" + className;',
        "  }",
        "  static string WindowTitle(IntPtr window) {",
        "    StringBuilder title = new StringBuilder(512);",
        "    GetWindowText(window, title, title.Capacity);",
        "    return title.ToString();",
        "  }",
        "  static bool IsConsoleHost(IntPtr window) {",
        "    string description = Describe(window);",
        '    return description.StartsWith("WindowsTerminal:", StringComparison.OrdinalIgnoreCase)',
        '      || description.StartsWith("OpenConsole:", StringComparison.OrdinalIgnoreCase)',
        '      || description.StartsWith("conhost:", StringComparison.OrdinalIgnoreCase)',
        '      || description.EndsWith(":ConsoleWindowClass", StringComparison.OrdinalIgnoreCase)',
        '      || description.EndsWith(":CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.OrdinalIgnoreCase);',
        "  }",
        "  public static int Main(string[] args) {",
        "    const uint foreground = 3;",
        "    const uint objectCreate = 0x8000;",
        "    const uint objectShow = 0x8002;",
        "    const uint objectNameChange = 0x800C;",
        "    const uint checkpoint = 0x800D;",
        "    HashSet<string> findings = new HashSet<string>(StringComparer.OrdinalIgnoreCase);",
        "    WinEventDelegate callback = delegate(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime) {",
        "      if (window == IntPtr.Zero) return;",
        '      if (eventType == checkpoint && objectId == 42 && childId == 0) { File.WriteAllText(args[3], "checkpoint"); return; }',
        "      if (objectId != 0 || childId != 0) return;",
        "      if (eventType != foreground && eventType != objectCreate && eventType != objectShow && eventType != objectNameChange) return;",
        "      if (eventType != foreground && !IsWindowVisible(window)) return;",
        "      string title = WindowTitle(window);",
        '      if (IsConsoleHost(window) && title.IndexOf(args[4], StringComparison.OrdinalIgnoreCase) >= 0) findings.Add(Describe(window) + ":" + title);',
        "    };",
        "    IntPtr objectHook = SetWinEventHook(objectCreate, checkpoint, IntPtr.Zero, callback, 0, 0, 0);",
        "    IntPtr foregroundHook = SetWinEventHook(foreground, foreground, IntPtr.Zero, callback, 0, 0, 0);",
        "    if (objectHook == IntPtr.Zero || foregroundHook == IntPtr.Zero) return Marshal.GetLastWin32Error();",
        '    File.WriteAllText(args[0], "ready");',
        "    try {",
        "      Message message;",
        "      while (!File.Exists(args[1])) {",
        "        while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {",
        "          TranslateMessage(ref message);",
        "          DispatchMessage(ref message);",
        "        }",
        "        Thread.Sleep(1);",
        "      }",
        "    } finally {",
        "      UnhookWinEvent(objectHook);",
        "      UnhookWinEvent(foregroundHook);",
        "    }",
        "    File.WriteAllLines(args[2], findings);",
        "    GC.KeepAlive(callback);",
        "    return 0;",
        "  }",
        "}"
      ].join("\n")
    );
    const powershellLiteral = (value: string) =>
      `'${value.replaceAll("'", "''")}'`;
    for (const [source, executable] of [
      [probeSource, probeExecutable],
      [observerSource, observerExecutable]
    ]) {
      execFileSync(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -Path ${powershellLiteral(source)} -OutputAssembly ${powershellLiteral(executable)} -OutputType ConsoleApplication`
        ],
        { windowsHide: true }
      );
    }

    const observer = spawn(
      observerExecutable,
      [
        observerReady,
        observerStop,
        observerResult,
        observerCheckpoint,
        windowMarker
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const observerDone = new Promise<void>((resolve, reject) => {
      observer.once("error", reject);
      observer.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Window observer exited with code ${code}.`));
      });
    });
    const result = await (async () => {
      try {
        await waitUntil(() => existsSync(observerReady));
        const probeResult = await spawnRad(probeExecutable, [windowMarker], {
          cwd,
          timeout: 10_000
        });
        await waitUntil(() => existsSync(observerCheckpoint));
        return probeResult;
      } finally {
        writeFileSync(observerStop, "stop");
        await observerDone;
      }
    })();

    expect(result.stdout).toBe("00");
    expect(readFileSync(observerResult, "utf8")).toBe("");
  }, 15_000);
});
