import { afterEach, describe, expect, it, vi } from "vitest";
import { configureProcessLifecycle } from "../../../src/runtime/process-lifecycle.js";
import { createFakeServerEntry } from "../../support/runtime/fakes.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("process lifecycle runtime integration", () => {
  it("routes duplicate signals through one runtime shutdown before exiting with its result", async () => {
    vi.useFakeTimers();
    const harness = await createRuntimeSdkHarness();
    const closeSession = vi.fn();
    harness.session.close = closeSession;
    await harness.host.open("signal-panel-a", { page: "graph" });
    const first = harness.servers.get("signal-panel-a");
    if (!first) throw new Error("Runtime did not open the panel");
    const second = createFakeServerEntry("signal-panel-b", "environment");
    harness.servers.set("signal-panel-b", second);

    const signalHandlers = new Map<string, () => void>();
    const exit = vi.fn();
    const shutdown = vi.spyOn(harness.extension, "shutdown");
    configureProcessLifecycle({
      extension: harness.extension,
      onSignal: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      onUncaughtException: () => {},
      onUnhandledRejection: () => {},
      setTimer: setTimeout,
      exit,
      log: vi.fn()
    });

    const terminate = signalHandlers.get("SIGTERM");
    const interrupt = signalHandlers.get("SIGINT");
    if (!terminate || !interrupt)
      throw new Error("Lifecycle did not register shutdown signals");

    terminate();
    interrupt();
    expect(shutdown).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    const stopping = shutdown.mock.results[0]?.value;
    if (!stopping) throw new Error("Signal did not start runtime shutdown");
    await stopping;
    await vi.advanceTimersByTimeAsync(50);

    expect(first.server.close).toHaveBeenCalledOnce();
    expect(second.server.close).toHaveBeenCalledOnce();
    expect(harness.servers.size).toBe(0);
    expect(closeSession).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
