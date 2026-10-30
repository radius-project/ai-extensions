import { describe, expect, it, vi } from "vitest";
import {
  configureProcessLifecycle,
  warmRadBinary,
  type ProcessLifecyclePorts
} from "./process-lifecycle.js";

function createPorts(
  overrides: Partial<ProcessLifecyclePorts> = {}
): ProcessLifecyclePorts & {
  signals: Map<string, () => void>;
  uncaught: ((error: unknown) => void) | null;
  unhandled: ((reason: unknown) => void) | null;
} {
  const ports: ProcessLifecyclePorts & {
    signals: Map<string, () => void>;
    uncaught: ((error: unknown) => void) | null;
    unhandled: ((reason: unknown) => void) | null;
  } = {
    extension: {
      isShutDown: () => false,
      shutdown: vi.fn(async () => {})
    },
    signals: new Map(),
    uncaught: null,
    unhandled: null,
    onSignal: (signal, handler) => {
      ports.signals.set(signal, handler);
    },
    onUncaughtException: (handler) => {
      ports.uncaught = handler;
    },
    onUnhandledRejection: (handler) => {
      ports.unhandled = handler;
    },
    setTimer: (callback) => {
      callback();
      return {} as NodeJS.Timeout;
    },
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides
  };
  return ports;
}

describe("configureProcessLifecycle", () => {
  it("registers supported signals and shuts down only once", async () => {
    const shutdown = vi.fn(async () => {});
    const ports = createPorts({
      extension: { isShutDown: () => false, shutdown }
    });
    const lifecycle = configureProcessLifecycle(ports);

    expect([...ports.signals.keys()]).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
    ports.signals.get("SIGTERM")?.();
    ports.signals.get("SIGINT")?.();
    await lifecycle.gracefulShutdown("manual");

    expect(shutdown).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(ports.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("ignores unsupported signal registration and reports shutdown state", () => {
    const ports = createPorts({
      extension: {
        isShutDown: () => true,
        shutdown: vi.fn(async () => {})
      },
      onSignal: (signal, handler) => {
        if (signal === "SIGINT") throw new Error("unsupported");
        ports.signals.set(signal, handler);
      }
    });

    const lifecycle = configureProcessLifecycle(ports);

    expect([...ports.signals.keys()]).toEqual(["SIGTERM", "SIGHUP"]);
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  it("logs error, stackless error, and non-error failures without crashing", () => {
    const log = vi.fn();
    const ports = createPorts({ log });
    configureProcessLifecycle(ports);

    const stackless = Object.assign(new Error("stackless"), { stack: "" });
    ports.uncaught?.(new Error("uncaught"));
    ports.uncaught?.(stackless);
    ports.unhandled?.("rejected");

    expect(log.mock.calls.map(([message]) => message).join("\n")).toContain(
      "uncaught"
    );
    expect(log.mock.calls.map(([message]) => message).join("\n")).toContain(
      "stackless"
    );
    expect(log.mock.calls.map(([message]) => message).join("\n")).toContain(
      "rejected"
    );
  });

  it("contains diagnostic logging failures", () => {
    const ports = createPorts({
      log: () => {
        throw new Error("closed stderr");
      }
    });
    configureProcessLifecycle(ports);

    expect(() => ports.uncaught?.(new Error("uncaught"))).not.toThrow();
    expect(() => ports.unhandled?.(new Error("rejected"))).not.toThrow();
  });
});

describe("warmRadBinary", () => {
  it("forwards preparation diagnostics with the Radius prefix", async () => {
    const log = vi.fn();
    const ensure = vi.fn(async ({ log: report }) => {
      report("downloading");
    });

    warmRadBinary(ensure, log);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("[radius] downloading")
    );
  });

  it.each([
    ["error", new Error("offline")],
    ["stackless error", Object.assign(new Error("offline"), { stack: "" })],
    ["string", "offline"]
  ])(
    "logs a %s rejection and contains logging failures",
    async (_name, error) => {
      const log = vi.fn(() => {
        throw new Error("closed stderr");
      });
      const ensure = vi.fn(async ({ log: report }) => {
        report("starting");
        throw error;
      });

      expect(() => warmRadBinary(ensure, log)).not.toThrow();
      await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    }
  );
});
