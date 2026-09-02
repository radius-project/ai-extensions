import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  drainChildStreams,
  radSpawnCommand,
  resolveWindowsLauncherPath,
  spawnRad,
  TERMINATION_WAIT_MS,
  terminateChildTree,
  windowsLauncherFilename
} from "./rad-process.mjs";

const temporaryDirectories: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

// The launchers are compiled build output rather than committed files, so
// resolution is proven against synthetic trees. That keeps these tests running
// on every platform and without a Go toolchain; the real executables are
// exercised by the Windows process integration suite.
function writeLauncher(directory: string, architecture: string): string {
  mkdirSync(directory, { recursive: true });
  const launcher = join(directory, windowsLauncherFilename(architecture));
  writeFileSync(launcher, "MZ");
  return launcher;
}

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
    "resolves the built %s launcher beside the source module",
    (architecture) => {
      const root = temporaryRoot("source-radius-launcher-");
      const moduleFile = join(root, "src", "rad-process.mjs");
      mkdirSync(dirname(moduleFile), { recursive: true });
      writeLauncher(
        join(root, "native", "windows-launcher", "bin"),
        architecture
      );

      expect(
        resolveWindowsLauncherPath(architecture, pathToFileURL(moduleFile).href)
      ).toBe(
        join(
          root,
          "src",
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
    const root = temporaryRoot("packaged-radius-launcher-");
    const nestedModule = join(root, "skills", "app", "scripts", "entry.mjs");
    mkdirSync(dirname(nestedModule), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const packaged = writeLauncher(join(root, "bin"), "x64");

    expect(
      resolveWindowsLauncherPath("x64", pathToFileURL(nestedModule).href)
    ).toBe(packaged);
  });

  it("does not run a launcher planted above the package root", () => {
    // An unbounded walk reaches C:\bin, which standard users can create on a
    // default Windows install, so anyone could plant an executable there and
    // have it run with the extension's privileges. The search stops at the
    // package root, so a launcher outside the installed extension is invisible
    // to it even though the directory layout otherwise matches.
    const outside = temporaryRoot("outside-radius-launcher-");
    const packageRoot = join(outside, "extension");
    const nestedModule = join(
      packageRoot,
      "skills",
      "app",
      "scripts",
      "entry.mjs"
    );
    mkdirSync(dirname(nestedModule), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), "{}");
    writeLauncher(join(outside, "bin"), "x64");

    expect(() =>
      resolveWindowsLauncherPath("x64", pathToFileURL(nestedModule).href)
    ).toThrow(
      'The packaged Windows Radius launcher "windows-radius-launcher-x64.exe" is missing.'
    );
  });

  it("still finds a launcher that sits at the package root itself", () => {
    // The bundled extension.mjs lives beside both package.json and bin, so the
    // package root has to be searched before the walk stops there.
    const root = temporaryRoot("root-radius-launcher-");
    writeFileSync(join(root, "package.json"), "{}");
    const packaged = writeLauncher(join(root, "bin"), "x64");

    expect(
      resolveWindowsLauncherPath(
        "x64",
        pathToFileURL(join(root, "extension.mjs")).href
      )
    ).toBe(packaged);
  });

  it("fails explicitly when no source or packaged launcher exists", () => {
    const root = temporaryRoot("missing-radius-launcher-");
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
    const root = temporaryRoot("routed-radius-launcher-");
    const moduleFile = join(root, "entry.mjs");
    const packaged = writeLauncher(join(root, "bin"), "arm64");

    const command = radSpawnCommand("C:\\managed\\rad.exe", ["version"], {
      platform: "win32",
      architecture: "arm64",
      moduleUrl: pathToFileURL(moduleFile).href
    });

    expect(command.executable).toBe(packaged);
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

describe("Radius child tree termination completion", () => {
  it("resolves only once the child has actually exited", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 60000)"
    ]);
    await new Promise((resolve) => child.once("spawn", resolve));

    await terminateChildTree(child);

    // Cancellation that returned while this was still null would let the caller
    // start the next command, or delete the working directory the tree still
    // holds open, before the tree was gone.
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  });

  it("resolves immediately for a child that already exited", async () => {
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => child.once("exit", resolve));

    const started = Date.now();
    await terminateChildTree(child);

    expect(Date.now() - started).toBeLessThan(TERMINATION_WAIT_MS);
  });

  it("gives up on a child that never exits rather than stranding the caller", async () => {
    // A process that survives termination must not hold cancellation open, so
    // the wait is bounded. The stub never emits "exit".
    const child = Object.assign(new EventEmitter(), {
      pid: 0x7fffffff,
      exitCode: null,
      signalCode: null,
      kill: () => true
    });

    const started = Date.now();
    await terminateChildTree(child as never, 40);

    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("tolerates a child that was never created", async () => {
    await expect(terminateChildTree(null)).resolves.toBeUndefined();
  });
});

describe("Radius child stdio release", () => {
  it("releases the pipes once a cancelled command has drained them", async () => {
    const child = spawn(process.execPath, [
      "-e",
      'process.stdout.write("captured");'
    ]);
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });

    await drainChildStreams(child);

    // Cancellation never reaches finalize(), so without this the pipes and
    // their listeners stay attached for the lifetime of the process.
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    expect(seen).toBe("captured");
  });

  it("waits for the flush instead of cutting output short", async () => {
    // `close` is what says stdout and stderr are complete. A child whose output
    // is still in flight must not have its pipes destroyed before then.
    const child = spawn(process.execPath, [
      "-e",
      'setTimeout(() => process.stdout.write("late"), 120);'
    ]);
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });

    await drainChildStreams(child, 4000);

    expect(seen).toBe("late");
  });

  it("gives up on a pipe that never closes rather than stranding the caller", async () => {
    // A descendant can inherit a pipe and hold it open after the process it
    // belonged to is gone, so the drain is bounded like the termination wait.
    const child = Object.assign(new EventEmitter(), {
      stdout: { readableEnded: false, destroyed: false, destroy: () => {} },
      stderr: { readableEnded: false, destroyed: false, destroy: () => {} },
      removeListener: () => {}
    });

    const started = Date.now();
    await drainChildStreams(child as never, 40);

    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("tolerates a child that was never created", async () => {
    await expect(drainChildStreams(null)).resolves.toBeUndefined();
  });
});
