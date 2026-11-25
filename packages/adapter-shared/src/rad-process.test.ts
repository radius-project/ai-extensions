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
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    child.emit("close", 0, null);
  });

  it("resolves taskkill from SystemRoot so timeout cleanup survives sanitized PATH", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("PATH", "");
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { killChildTree } = await import("./rad-process.mjs");
    const child = Object.assign(new EventEmitter(), {
      pid: 67890,
      kill: vi.fn(() => true)
    });

    const cleanup = killChildTree(child, "win32");

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "67890", "/t", "/f"],
      { stdio: "ignore", windowsHide: true }
    );
    taskkill.emit("close", 0);
    await expect(cleanup).resolves.toBe(true);
  });

  it("falls back to killing the child when taskkill cannot start", async () => {
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { killChildTree } = await import("./rad-process.mjs");
    const child = {
      pid: 67890,
      kill: vi.fn(() => true)
    };

    const cleanup = killChildTree(child, "win32");
    const settled = vi.fn();
    void cleanup?.then(settled);
    taskkill.emit("error", new Error("taskkill unavailable"));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    taskkill.emit("close", -1);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(cleanup).resolves.toBe(false);
  });

  it("reports unconfirmed tree termination when starting taskkill throws", async () => {
    const spawn = vi.fn(() => {
      throw new Error("taskkill spawn failed");
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    const { killChildTree } = await import("./rad-process.mjs");
    const child = new FakeSpawnedProcess();

    await expect(killChildTree(child, "win32")).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("builds managed environments, errors, paths, and platform spawn options", async () => {
    const {
      managedBicepEnv,
      RadProcessError,
      radSpawnOptions,
      windowsTaskkillPath
    } = await import("./rad-process.mjs");

    expect(managedBicepEnv(undefined, "bicep")).toEqual({ BICEP: "bicep" });
    expect(managedBicepEnv({ EXISTING: "1" }, "custom")).toEqual({
      EXISTING: "1",
      BICEP: "custom"
    });
    expect(windowsTaskkillPath({ WINDIR: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\taskkill.exe"
    );
    expect(windowsTaskkillPath({})).toBe("taskkill");
    expect(radSpawnOptions("win32").detached).toBe(false);
    expect(radSpawnOptions("linux").detached).toBe(true);

    const error = new RadProcessError("failed", "out", "err");
    expect(error).toMatchObject({
      name: "RadProcessError",
      message: "failed",
      stdout: "out",
      stderr: "err"
    });
  });

  it("handles missing children and POSIX process-tree cleanup failures", async () => {
    const { killChildTree } = await import("./rad-process.mjs");
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw new Error("group unavailable");
      });
    const fallback = vi.fn(() => {
      throw new Error("already exited");
    });

    expect(() => killChildTree(null, "linux")).not.toThrow();
    expect(() =>
      killChildTree({ pid: null, kill: fallback }, "linux")
    ).not.toThrow();
    expect(() =>
      killChildTree({ pid: 123, kill: fallback }, "linux")
    ).not.toThrow();
    expect(processKill).toHaveBeenCalledWith(-123, "SIGKILL");
    expect(fallback).not.toHaveBeenCalled();

    expect(() =>
      killChildTree({ pid: 456, kill: fallback }, "linux")
    ).not.toThrow();
    expect(fallback).toHaveBeenCalledWith("SIGKILL");
    processKill.mockRestore();
  });

  it("reports a signaled close with captured output", async () => {
    setProcessPlatform("linux");
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad, RadProcessError } = await import("./rad-process.mjs");

    const result = spawnRad("rad", ["deploy"], { label: "deploy" });
    child.stdout.end("compile output");
    child.stderr.end("failure detail");
    child.emit("close", null, "SIGTERM");

    await expect(result).rejects.toEqual(
      expect.objectContaining({
        name: "RadProcessError",
        message: "deploy exited with code null (signal SIGTERM)",
        stdout: "compile output",
        stderr: "failure detail"
      })
    );
    expect(RadProcessError).toBeDefined();
  });

  it("waits for both the aborted process and Windows tree cleanup", async () => {
    setProcessPlatform("win32");
    const child = new FakeSpawnedProcess();
    const taskkill = new EventEmitter();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(taskkill);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");
    const controller = new AbortController();
    const settled = vi.fn();
    const result = spawnRad("validator", [], {
      label: "validator",
      signal: controller.signal
    }).catch(settled);

    controller.abort();
    child.emit("close", null, "SIGKILL");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    taskkill.emit("close", 0);

    await result;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: "validator was cancelled" })
    );
  });

  it("holds a draining Windows timeout until both taskkill and rad close", async () => {
    setProcessPlatform("win32");
    vi.useFakeTimers();
    const child = new FakeSpawnedProcess();
    const taskkill = new EventEmitter();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(taskkill);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");
    const settled = vi.fn();
    const result = spawnRad("rad", ["bicep", "publish"], {
      timeout: 30,
      drainOnTimeout: true
    }).then(settled, settled);

    await vi.advanceTimersByTimeAsync(30);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");

    await result;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: "rad timed out after 30ms" })
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports unconfirmed Windows exit without signalling an exited rad PID", async () => {
    setProcessPlatform("win32");
    vi.useFakeTimers();
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad, RadProcessExitUnconfirmedError } =
      await import("./rad-process.mjs");
    const onFailure = vi.fn();
    const result = spawnRad("rad", ["bicep", "publish"], {
      timeout: 3_000,
      drainOnTimeout: true
    }).catch(onFailure);

    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(spawn).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(
      expect.any(RadProcessExitUnconfirmedError)
    );
  });

  it.each(["taskkill", "child close"])(
    "bounds Windows cancellation when %s never settles",
    async (pending) => {
      setProcessPlatform("win32");
      vi.useFakeTimers();
      const child = new FakeSpawnedProcess();
      const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
      vi.doMock("node:child_process", () => ({
        spawn: vi.fn().mockReturnValueOnce(child).mockReturnValueOnce(taskkill)
      }));
      const { spawnRad, RadProcessExitUnconfirmedError } =
        await import("./rad-process.mjs");
      const controller = new AbortController();
      const settled = vi.fn();
      const result = spawnRad("validator", [], {
        signal: controller.signal
      }).catch(settled);

      controller.abort();
      child.emit("exit", null, "SIGKILL");
      if (pending === "child close") taskkill.emit("close", 0);
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.any(RadProcessExitUnconfirmedError)
      );
      expect(taskkill.kill).toHaveBeenCalledTimes(
        pending === "taskkill" ? 1 : 0
      );
      if (pending === "taskkill")
        expect(() =>
          taskkill.emit("error", new Error("late cleanup error"))
        ).not.toThrow();
      taskkill.emit("close", 1);
      child.emit("close", null, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([128, null])(
    "rejects a draining Windows timeout when taskkill closes with %s",
    async (code) => {
      setProcessPlatform("win32");
      vi.useFakeTimers();
      const child = new FakeSpawnedProcess();
      child.kill.mockReturnValue(true);
      const taskkill = new EventEmitter();
      const spawn = vi
        .fn()
        .mockReturnValueOnce(child)
        .mockReturnValueOnce(taskkill);
      vi.doMock("node:child_process", () => ({ spawn }));
      const { spawnRad, RadProcessExitUnconfirmedError } =
        await import("./rad-process.mjs");
      const settled = vi.fn();
      const result = spawnRad("rad", ["bicep", "publish"], {
        timeout: 30,
        drainOnTimeout: true
      }).then(settled, settled);

      child.stdout.write("partial output");
      await vi.advanceTimersByTimeAsync(30);
      expect(settled).not.toHaveBeenCalled();
      taskkill.emit("close", code);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      child.emit("error", new Error("failed to signal child"));
      await result;

      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(settled).toHaveBeenCalledWith(
        expect.any(RadProcessExitUnconfirmedError)
      );
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "rad timed out after 30ms. Windows process-tree exit could not be confirmed; do not use the affected target.",
          stdout: "partial output"
        })
      );
    }
  );

  it("detects unconfirmed exit through nested causes without mistaking other failures for it", async () => {
    const { isRadProcessExitUnconfirmed, RadProcessExitUnconfirmedError } =
      await import("./rad-process.mjs");
    const unconfirmed = new RadProcessExitUnconfirmedError("timeout", "", "");
    const wrapped = new Error("publish failed", {
      cause: new Error("publisher failed", { cause: unconfirmed })
    });
    const circular = new Error("unrelated error");
    circular.cause = circular;

    expect(isRadProcessExitUnconfirmed(wrapped)).toBe(true);
    expect(isRadProcessExitUnconfirmed(circular)).toBe(false);
    expect(isRadProcessExitUnconfirmed("timeout")).toBe(false);
  });

  it("drains the child after timeout for an abortable invocation", async () => {
    setProcessPlatform("linux");
    vi.useFakeTimers();
    const child = new FakeSpawnedProcess();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.doMock("node:child_process", () => ({ spawn: () => child }));
    const { spawnRad } = await import("./rad-process.mjs");
    const settled = vi.fn();
    const result = spawnRad("validator", [], {
      label: "validator",
      timeout: 30,
      signal: new AbortController().signal
    }).catch(settled);

    await vi.advanceTimersByTimeAsync(30);
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");

    await result;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: "validator timed out after 30ms" })
    );
  });

  it("does not spawn for a signal already cancelled", async () => {
    const spawn = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");
    const controller = new AbortController();
    const reason = new Error("shutdown already started");
    controller.abort(reason);

    await expect(
      spawnRad("validator", [], { signal: controller.signal })
    ).rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("caps both captured output streams without changing process success", async () => {
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");
    const maxOutput = 32 * 1024 * 1024;
    const cappedChunk = "x".repeat(maxOutput);

    const result = spawnRad("rad", ["version"]);
    child.stdout.emit("data", cappedChunk);
    child.stdout.emit("data", "ignored stdout");
    child.stderr.emit("data", cappedChunk);
    child.stderr.emit("data", "ignored stderr");
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({
      stdout: cappedChunk,
      stderr: cappedChunk
    });
  });

  it("times out, captures diagnostics, and kills the POSIX process group", async () => {
    vi.useFakeTimers();
    setProcessPlatform("linux");
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");

    const result = spawnRad("rad", ["deploy"], {
      timeout: 25,
      label: "deployment"
    });
    child.stdout.write("compile output");
    child.stderr.write("timeout detail");
    const rejection = expect(result).rejects.toMatchObject({
      name: "RadProcessError",
      message: "deployment timed out after 25ms",
      stdout: "compile output",
      stderr: "timeout detail"
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });

  it("cancels the exit grace period when a shorter timeout wins", async () => {
    vi.useFakeTimers();
    setProcessPlatform("linux");
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");

    const result = spawnRad("rad", ["deploy"], { timeout: 25 });
    child.emit("exit", 1, null);
    const rejection = expect(result).rejects.toMatchObject({
      message: "rad timed out after 25ms"
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });

  it("does not settle from the exit grace timer after cancellation", async () => {
    vi.useFakeTimers();
    setProcessPlatform("linux");
    const child = new FakeSpawnedProcess();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.doMock("node:child_process", () => ({ spawn: () => child }));
    const { spawnRad } = await import("./rad-process.mjs");
    const controller = new AbortController();
    const settled = vi.fn();
    const result = spawnRad("validator", [], {
      label: "validator",
      signal: controller.signal
    }).catch(settled);

    child.emit("exit", 1, null);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("close", 1, null);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "validator was cancelled" })
    );
  });

  it("reports a spawn error and cancels an active exit grace period", async () => {
    vi.useFakeTimers();
    setProcessPlatform("linux");
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");

    const result = spawnRad("rad", ["deploy"], { timeout: 5_000 });
    child.stdout.write("partial output");
    child.emit("exit", 1, null);
    child.emit("error", new Error("spawn boundary failed"));

    await expect(result).rejects.toMatchObject({
      name: "RadProcessError",
      message: "spawn boundary failed",
      stdout: "partial output",
      stderr: ""
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processKill).not.toHaveBeenCalled();
  });

  it("ignores a late spawn error after a successful close", async () => {
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");

    const result = spawnRad("rad", ["version"]);
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({ stdout: "", stderr: "" });
    expect(() =>
      child.emit("error", new Error("late spawn error"))
    ).not.toThrow();
  });

  it("finalizes a non-zero exit without a close event after the grace period", async () => {
    vi.useFakeTimers();
    const child = new FakeSpawnedProcess();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnRad } = await import("./rad-process.mjs");

    const result = spawnRad("rad", ["deploy"], {
      timeout: 5_000,
      label: "deployment"
    });
    child.emit("exit", 7, null);
    const rejection = expect(result).rejects.toMatchObject({
      name: "RadProcessError",
      message: "deployment exited with code 7",
      stdout: "",
      stderr: ""
    });

    await vi.advanceTimersByTimeAsync(2_000);

    await rejection;
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
