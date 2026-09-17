import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  killChildTree,
  RadProcessError,
  spawnRad,
  windowsTaskkillPath
} from "./rad-process.mjs";

let directory: string;
const children: ChildProcess[] = [];
const descendants: number[] = [];
const env =
  process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {};

beforeEach(async () => {
  directory = join(process.cwd(), ".artifacts", `t038-process-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const tree = await readFile(join(directory, "tree.json"), "utf8").catch(
    () => undefined
  );
  if (tree) {
    const parsed: unknown = JSON.parse(tree);
    if (
      parsed &&
      typeof parsed === "object" &&
      "child" in parsed &&
      typeof parsed.child === "number" &&
      !descendants.includes(parsed.child)
    )
      descendants.push(parsed.child);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  for (const pid of descendants.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
  }
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function startChild(detached = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: directory,
    env,
    detached,
    stdio: "ignore"
  });
  children.push(child);
  await once(child, "spawn");
  return child;
}

describe("managed process real OS boundaries", () => {
  it.each([
    [
      { SystemRoot: "C:\\owned", WINDIR: "C:\\other" },
      "C:\\owned\\System32\\taskkill.exe"
    ],
    [{ WINDIR: "C:\\owned" }, "C:\\owned\\System32\\taskkill.exe"],
    [{}, "taskkill"]
  ])(
    "resolves taskkill using explicit Windows roots: %j",
    (source, expected) => {
      expect(windowsTaskkillPath(source)).toBe(expected);
    }
  );

  it("accepts cleanup before a child acquired a PID", async () => {
    await expect(killChildTree(null)).resolves.toBeUndefined();
    await expect(killChildTree(undefined)).resolves.toBeUndefined();
    const child = spawn(join(directory, "missing-executable"), [], {
      cwd: directory,
      env,
      stdio: "ignore"
    });
    const failed = once(child, "error");
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve())
    );
    await expect(killChildTree(child)).resolves.toBeUndefined();
    expect((await failed)[0]).toMatchObject({ code: "ENOENT" });
    await closed;
  });

  it.runIf(process.platform !== "win32").each([true, false])(
    "terminates an owned POSIX child with process-group leadership %s",
    async (detached) => {
      const child = await startChild(detached);
      const pid = child.pid;
      if (pid === undefined) throw new Error("Expected spawned child PID");
      if (detached) expect(() => process.kill(-pid, 0)).not.toThrow();
      else expect(() => process.kill(-pid, 0)).toThrow();
      const closed = once(child, "close");
      await killChildTree(child, "linux");
      expect(await closed).toEqual([null, "SIGKILL"]);
      expect(isRunning(pid)).toBe(false);
    }
  );

  it("falls back to the owned child when the Windows tree tool cannot spawn", async () => {
    const child = await startChild();
    const closed = once(child, "close");
    vi.stubEnv("SystemRoot", join(directory, "absent-system-root"));
    await killChildTree(child, "win32");
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
  });

  it.runIf(process.platform === "win32")(
    "falls back to the owned child when the Windows tree tool exits unsuccessfully",
    async () => {
      const system32 = join(directory, "System32");
      await mkdir(system32);
      // Node rejects taskkill's /pid argument, providing a real unsuccessful tool.
      await copyFile(process.execPath, join(system32, "taskkill.exe"));
      const child = await startChild();
      const closed = once(child, "close");
      vi.stubEnv("SystemRoot", directory);
      await killChildTree(child, "win32");
      await closed;
      expect(child.signalCode).toBe("SIGKILL");
    }
  );

  it.each([32 * 1024 * 1024 - 1, 32 * 1024 * 1024, 33 * 1024 * 1024])(
    "bounds captured stdout and stderr from a real %i-character stream",
    async (size) => {
      const result = await spawnRad(
        process.execPath,
        [
          "-e",
          `
          const { once } = require("node:events");
          (async () => {
            for (const stream of [process.stdout, process.stderr]) {
              for (let remaining = ${size}; remaining > 0;) {
                const length = Math.min(65536, remaining);
                remaining -= length;
                if (!stream.write("x".repeat(length))) await once(stream, "drain");
              }
            }
          })().catch(() => process.exit(1));
        `
        ],
        { cwd: directory, env, inheritEnv: false, timeout: 4000 }
      );
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream.length).toBeGreaterThanOrEqual(
          Math.min(size, 32 * 1024 * 1024)
        );
        // The existing cap admits the final in-flight chunk before discarding later data.
        expect(stream.length).toBeLessThanOrEqual(
          Math.min(size, 32 * 1024 * 1024 + 65536)
        );
        expect(stream).toMatch(/^x+$/);
      }
    }
  );

  it("keeps diagnostics when an isolated executable fails", async () => {
    const controller = new AbortController();
    const result = spawnRad(
      process.execPath,
      [
        "-e",
        "console.log('compile diagnostic');console.error('compiler failed');process.exitCode=19"
      ],
      { cwd: directory, env, inheritEnv: false, signal: controller.signal }
    );
    await expect(result).rejects.toMatchObject({
      name: "RadProcessError",
      message: "rad exited with code 19",
      stdout: "compile diagnostic\n",
      stderr: "compiler failed\n",
      cleanupIncomplete: false
    });
    controller.abort();
  });

  it("keeps cancellation authoritative when spawn failure arrives afterward", async () => {
    const controller = new AbortController();
    const result = spawnRad(join(directory, "missing-executable"), [], {
      cwd: directory,
      env,
      inheritEnv: false,
      signal: controller.signal
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it.runIf(process.platform !== "win32")(
    "reports the terminating signal rather than a successful isolated exit",
    async () => {
      await expect(
        spawnRad(
          process.execPath,
          ["-e", "process.kill(process.pid,'SIGTERM')"],
          {
            cwd: directory,
            env,
            inheritEnv: false
          }
        )
      ).rejects.toMatchObject({
        message: "rad exited with code null (signal SIGTERM)",
        cleanupIncomplete: false
      });
    }
  );

  it.each(["grace", "timeout", "cancellation", "escaped", "legacy"] as const)(
    "preserves %s ownership semantics while a descendant retains pipes",
    async (mode) => {
      const controller = new AbortController();
      const descendantScript = `
        setInterval(()=>{},1000);
        process.send("ready");
      `;
      const pending = spawnRad(
        process.execPath,
        [
          "-e",
          `
          const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
            env: process.env, stdio: ["ignore", process.stdout, process.stderr, "ipc"], detached: ${process.platform === "win32" || mode === "escaped"}
          });
          child.once("message", () => {
            require("node:fs").writeFileSync("tree.json", JSON.stringify({parent:process.pid, child:child.pid}));
            child.disconnect();
            process.stdout.write("parent diagnostic");
            process.exit(0);
          });
        `
        ],
        {
          cwd: directory,
          env,
          inheritEnv: mode === "legacy",
          signal: controller.signal,
          timeout: mode === "timeout" ? 1000 : 4500
        }
      );
      const outcome = pending.catch((error: unknown) => error);
      try {
        await vi.waitFor(async () => {
          const tree: unknown = JSON.parse(
            await readFile(join(directory, "tree.json"), "utf8")
          );
          if (
            !tree ||
            typeof tree !== "object" ||
            !("child" in tree) ||
            typeof tree.child !== "number" ||
            !("parent" in tree) ||
            typeof tree.parent !== "number"
          )
            throw new Error("Expected owned descendant PID");
          if (!descendants.includes(tree.child)) descendants.push(tree.child);
          expect(isRunning(tree.child)).toBe(true);
          expect(isRunning(tree.parent)).toBe(false);
        });
        if (mode === "cancellation") controller.abort();
        const error = await outcome;
        const incomplete = process.platform === "win32" || mode === "escaped";
        if (mode === "legacy") {
          expect(error).toEqual({ stdout: "parent diagnostic", stderr: "" });
          for (const pid of descendants) expect(isRunning(pid)).toBe(true);
        } else if (incomplete) {
          expect(error).toBeInstanceOf(RadProcessError);
          expect(error).toMatchObject({
            cleanupIncomplete: true,
            message: "rad process cleanup did not complete"
          });
          for (const pid of descendants) expect(isRunning(pid)).toBe(true);
        } else {
          expect(error).toMatchObject(
            mode === "cancellation" ?
              { name: "AbortError" }
            : {
                cleanupIncomplete: false,
                message:
                  mode === "timeout" ?
                    "rad timed out after 1000ms"
                  : "rad retained child pipes after exit"
              }
          );
          for (const pid of descendants)
            await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
        }
      } finally {
        controller.abort();
        await outcome;
      }
    }
  );
});
