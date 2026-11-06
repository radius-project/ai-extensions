import { afterEach, describe, expect, it, vi } from "vitest";
import { setupDevSelfReload, type DevReloadPorts } from "./dev-reload.js";

function createPorts(
  overrides: Partial<DevReloadPorts> = {}
): DevReloadPorts & {
  listener: ((filename: string | Buffer | null) => void) | null;
} {
  const ports: DevReloadPorts & {
    listener: ((filename: string | Buffer | null) => void) | null;
  } = {
    enabled: true,
    extensionPath: "C:\\fixture\\extension.mjs",
    exists: () => true,
    fileSize: () => 10,
    listener: null,
    watchDirectory: (_path, listener) => {
      ports.listener = listener;
      return { unref: vi.fn() };
    },
    isShuttingDown: () => false,
    isDeploying: () => false,
    getLastActivityAt: () => 0,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    log: vi.fn(),
    shutdown: vi.fn(),
    ...overrides
  };
  return ports;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("setupDevSelfReload", () => {
  it.each([
    ["disabled", { enabled: false }],
    ["missing path", { extensionPath: "" }],
    ["missing file", { exists: () => false }]
  ])("does not arm the watcher when %s", (_label, overrides) => {
    const ports = createPorts(overrides);

    setupDevSelfReload(ports);

    expect(ports.listener).toBeNull();
  });

  it("ignores unrelated and unchanged writes, then reloads once after a size change", async () => {
    vi.useFakeTimers();
    let size = 10;
    const clearTimer = vi.fn(clearTimeout);
    const ports = createPorts({
      fileSize: () => size,
      now: () => Date.now(),
      clearTimer
    });
    setupDevSelfReload(ports);

    ports.listener?.("other.mjs");
    await vi.runAllTimersAsync();
    expect(ports.shutdown).not.toHaveBeenCalled();

    ports.listener?.("extension.mjs");
    await vi.advanceTimersByTimeAsync(300);
    expect(ports.shutdown).not.toHaveBeenCalled();

    size = 20;
    ports.listener?.(Buffer.from("extension.mjs"));
    ports.listener?.("extension.mjs");
    await vi.advanceTimersByTimeAsync(550);

    expect(ports.shutdown).toHaveBeenCalledExactlyOnceWith("DEV_RELOAD");
    expect(clearTimer).toHaveBeenCalledTimes(2);

    size = 30;
    ports.listener?.("extension.mjs");
    await vi.runAllTimersAsync();
    expect(ports.shutdown).toHaveBeenCalledOnce();
  });

  it("defers while a deploy is active and coalesces later writes", async () => {
    vi.useFakeTimers();
    let size = 10;
    let deploying = true;
    const ports = createPorts({
      fileSize: () => size,
      isDeploying: () => deploying,
      now: () => Date.now()
    });
    setupDevSelfReload(ports);

    size = 20;
    ports.listener?.("extension.mjs");
    await vi.advanceTimersByTimeAsync(300);
    size = 30;
    ports.listener?.("extension.mjs");
    await vi.advanceTimersByTimeAsync(300);
    expect(ports.shutdown).not.toHaveBeenCalled();

    deploying = false;
    await vi.advanceTimersByTimeAsync(2250);

    expect(ports.shutdown).toHaveBeenCalledExactlyOnceWith("DEV_RELOAD");
    expect(ports.log).toHaveBeenCalledWith(
      expect.stringContaining("deploy in flight")
    );
  });

  it("waits for panel inactivity but does not defer beyond the cap", async () => {
    vi.useFakeTimers();
    let size = 10;
    const ports = createPorts({
      fileSize: () => size,
      getLastActivityAt: () => Date.now(),
      now: () => Date.now()
    });
    setupDevSelfReload(ports);

    size = 20;
    ports.listener?.("extension.mjs");
    await vi.advanceTimersByTimeAsync(60550);

    expect(ports.shutdown).toHaveBeenCalledExactlyOnceWith("DEV_RELOAD");
    expect(ports.log).toHaveBeenCalledWith(
      expect.stringContaining("canvas panel active")
    );
  });

  it("stops a pending reload when shutdown has started", async () => {
    vi.useFakeTimers();
    let size = 10;
    let shuttingDown = false;
    const ports = createPorts({
      fileSize: () => size,
      isShuttingDown: () => shuttingDown,
      now: () => Date.now()
    });
    setupDevSelfReload(ports);

    size = 20;
    ports.listener?.("extension.mjs");
    shuttingDown = true;
    await vi.runAllTimersAsync();

    expect(ports.shutdown).not.toHaveBeenCalled();
  });

  it("stops when shutdown starts after the changed file is read", async () => {
    vi.useFakeTimers();
    let size = 10;
    let checks = 0;
    const ports = createPorts({
      fileSize: () => size,
      isShuttingDown: () => {
        checks += 1;
        return checks > 1;
      },
      now: () => Date.now()
    });
    setupDevSelfReload(ports);

    size = 20;
    ports.listener?.("extension.mjs");
    await vi.runAllTimersAsync();

    expect(ports.shutdown).not.toHaveBeenCalled();
  });

  it("stops when shutdown starts immediately before reload", async () => {
    vi.useFakeTimers();
    let size = 10;
    let checks = 0;
    const ports = createPorts({
      fileSize: () => size,
      isShuttingDown: () => {
        checks += 1;
        return checks === 3;
      },
      now: () => Date.now()
    });
    setupDevSelfReload(ports);

    size = 20;
    ports.listener?.("extension.mjs");
    await vi.runAllTimersAsync();

    expect(ports.shutdown).not.toHaveBeenCalled();
  });

  it("contains watcher, stat, unref, and logging failures", async () => {
    vi.useFakeTimers();
    let statCalls = 0;
    const log = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("armed log failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("setup log failed");
      });
    const ports = createPorts({
      fileSize: () => {
        statCalls += 1;
        if (statCalls === 1) throw new Error("initial stat failed");
        return 20;
      },
      watchDirectory: (_path, listener) => {
        ports.listener = listener;
        return {
          unref() {
            throw new Error("unref failed");
          }
        };
      },
      log
    });

    expect(() => setupDevSelfReload(ports)).not.toThrow();
    ports.listener?.(null);
    await vi.advanceTimersByTimeAsync(550);
    expect(ports.shutdown).toHaveBeenCalledOnce();

    const failed = createPorts({
      watchDirectory: () => {
        throw "watch failed";
      },
      log
    });
    expect(() => setupDevSelfReload(failed)).not.toThrow();

    const failedWithError = createPorts({
      watchDirectory: () => {
        throw new Error("watch failed");
      },
      log: () => {
        throw new Error("failure log failed");
      }
    });
    expect(() => setupDevSelfReload(failedWithError)).not.toThrow();
  });
});
