import { EventEmitter } from "node:events";
import type { RequestListener, Server as HttpServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type {
  CanvasServerDependencies,
  RequestHandlerFactoryInput
} from "./ports.js";
import { createCanvasServer } from "./create-canvas-server.js";

let nextPort = 41000;

class FakeServer extends EventEmitter {
  closeCalls = 0;
  forceCalls = 0;
  private port = 0;

  listen(port: number): this {
    this.port = port || nextPort++;
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close(callback?: () => void): this {
    this.closeCalls += 1;
    queueMicrotask(() => callback?.());
    return this;
  }

  closeAllConnections(): void {
    this.forceCalls += 1;
  }
}

class ManualServer extends FakeServer {
  private listeningCallback: (() => void) | undefined;
  private closeCallback: (() => void) | undefined;

  override listen(port: number): this {
    this.listeningCallback = () => super.listen(port);
    return this;
  }

  override close(callback?: () => void): this {
    this.closeCalls += 1;
    this.closeCallback = callback;
    return this;
  }

  finishListening(): void {
    this.listeningCallback?.();
  }

  finishClosing(): void {
    this.closeCallback?.();
  }
}

function setup() {
  const fakeServers: FakeServer[] = [];
  const handlerInputs: RequestHandlerFactoryInput[] = [];
  let clock = 100;
  const dependencies: CanvasServerDependencies = {
    createHttpServer: (_handler: RequestListener) => {
      const server = new FakeServer();
      fakeServers.push(server);
      return server as unknown as HttpServer;
    },
    createRequestHandler: (input) => {
      handlerInputs.push(input);
      return () => {};
    },
    createState: () => ({}),
    defaultPage: "graph",
    now: () => ++clock,
    preferredPort: async () => 0,
    prepareIdentity: vi.fn()
  };
  return {
    container: createCanvasServer(dependencies),
    dependencies,
    fakeServers,
    handlerInputs
  };
}

describe("createCanvasServer (SU-02)", () => {
  it("creates isolated state, reuses one instance, and preserves its page by default", async () => {
    const { container, dependencies } = setup();

    const first = await container.getOrCreate("panel-a", "planned");
    first.state.contextRepo = "octo/app";
    const reused = await container.getOrCreate("panel-a");
    const isolated = await container.getOrCreate("panel-b");

    expect(reused).toBe(first);
    expect(reused.page).toBe("planned");
    expect(reused.state.contextRepo).toBe("octo/app");
    expect(isolated).not.toBe(first);
    expect(isolated.page).toBe("graph");
    expect(isolated.state).toEqual({});
    expect(dependencies.prepareIdentity).toHaveBeenCalledTimes(2);
    await container.stopAll();
  });

  it("updates the activity clock through the request-handler seam", async () => {
    const { container, handlerInputs } = setup();
    await container.getOrCreate("panel-a");

    expect(container.getLastActivityAt()).toBe(0);
    handlerInputs[0].markActivity();
    expect(container.getLastActivityAt()).toBe(101);
    await container.stopAll();
  });

  it("makes stop and stop-all idempotent", async () => {
    const { container, fakeServers } = setup();
    await container.getOrCreate("panel-a");
    await container.getOrCreate("panel-b");

    await Promise.all([container.stop("panel-a"), container.stop("panel-a")]);
    await container.stop("panel-a");
    expect(fakeServers[0].closeCalls).toBe(1);

    await Promise.all([container.stopAll(), container.stopAll()]);
    await container.stopAll();
    expect(fakeServers[1].closeCalls).toBe(1);
    expect(fakeServers[1].forceCalls).toBe(1);
    expect(container.instances.size).toBe(0);
  });

  it("force-closes a single instance when requested", async () => {
    const { container, fakeServers } = setup();
    await container.getOrCreate("panel-a");

    await container.stop("panel-a", true);

    expect(fakeServers[0].forceCalls).toBe(1);
    expect(fakeServers[0].closeCalls).toBe(1);
    expect(container.instances.has("panel-a")).toBe(false);
  });

  it("waits for a pending stop before reopening the same instance", async () => {
    const firstServer = new ManualServer();
    const secondServer = new FakeServer();
    const servers = [firstServer, secondServer];
    const container = createCanvasServer({
      createHttpServer: () => servers.shift() as unknown as HttpServer,
      createRequestHandler: () => () => {},
      createState: () => ({}),
      defaultPage: "graph",
      now: () => 1,
      preferredPort: async () => 0,
      prepareIdentity: () => {}
    });

    const firstStart = container.getOrCreate("panel");
    const stop = container.stop("panel");
    const reopened = container.getOrCreate("panel", "planned");
    await Promise.resolve();
    firstServer.finishListening();
    const first = await firstStart;
    await Promise.resolve();
    expect(firstServer.closeCalls).toBe(1);
    firstServer.finishClosing();
    await stop;
    const second = await reopened;

    expect(second).not.toBe(first);
    expect(second.page).toBe("planned");
    expect(container.instances.get("panel")).toBe(second);
    await container.stopAll();
  });

  it("makes concurrent stop-all callers await the same pending close", async () => {
    const server = new ManualServer();
    const container = createCanvasServer({
      createHttpServer: () => server as unknown as HttpServer,
      createRequestHandler: () => () => {},
      createState: () => ({}),
      defaultPage: "graph",
      now: () => 1,
      preferredPort: async () => 0,
      prepareIdentity: () => {}
    });
    const start = container.getOrCreate("panel");
    await Promise.resolve();
    server.finishListening();
    await start;

    const firstStopAll = container.stopAll();
    let secondFinished = false;
    const secondStopAll = container.stopAll().then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    server.finishClosing();
    await Promise.all([firstStopAll, secondStopAll]);
    expect(secondFinished).toBe(true);
    expect(server.closeCalls).toBe(1);
  });

  it("signals the stopped hook once per instance, after the entry is gone and the socket is closed", async () => {
    const { container, dependencies, fakeServers } = setup();
    const stopped: string[] = [];
    const observedAtStop: Array<{ instances: number; closeCalls: number }> = [];
    dependencies.onStopped = (instanceId) => {
      stopped.push(instanceId);
      observedAtStop.push({
        instances: container.instances.size,
        closeCalls: fakeServers[0].closeCalls
      });
    };
    await container.getOrCreate("panel-a");

    await Promise.all([container.stop("panel-a"), container.stop("panel-a")]);
    await container.stop("panel-a");

    expect(stopped).toEqual(["panel-a"]);
    expect(observedAtStop).toEqual([{ instances: 0, closeCalls: 1 }]);
  });

  it("still signals the stopped hook when closing the socket throws", async () => {
    const { container, dependencies, fakeServers } = setup();
    const stopped: string[] = [];
    dependencies.onStopped = (instanceId) => stopped.push(instanceId);
    await container.getOrCreate("panel-a");
    fakeServers[0].close = () => {
      throw new Error("close failed");
    };

    await expect(container.stop("panel-a")).resolves.toBeUndefined();

    expect(stopped).toEqual(["panel-a"]);
    expect(container.instances.size).toBe(0);
  });

  it("does not signal a stop for an instance that was never started", async () => {
    const { container, dependencies } = setup();
    const stopped: string[] = [];
    dependencies.onStopped = (instanceId) => stopped.push(instanceId);

    await container.stop("never-started");
    await container.stopAll();

    expect(stopped).toEqual([]);
  });
});

// Fails its first `failures` listen attempts, then binds normally.
class UnbindableServer extends FakeServer {
  constructor(private failures: number) {
    super();
  }

  override listen(port: number): this {
    if (this.failures > 0) {
      this.failures -= 1;
      queueMicrotask(() =>
        this.emit("error", new Error(`bind failed: ${port}`))
      );
      return this;
    }
    return super.listen(port);
  }
}

// `failures[n]` is how many listen attempts the nth created server rejects.
// The preferred port is a fixed non-zero value so the preferred-port error and
// the ephemeral-fallback error are distinguishable by message.
function bindHarness(failures: readonly number[]) {
  const fakeServers: UnbindableServer[] = [];
  let created = 0;
  const dependencies: CanvasServerDependencies = {
    createHttpServer: () => {
      const server = new UnbindableServer(failures[created++] ?? 0);
      fakeServers.push(server);
      return server as unknown as HttpServer;
    },
    createRequestHandler: () => () => {},
    createState: () => ({}),
    defaultPage: "graph",
    now: () => 1,
    preferredPort: async () => 45000,
    prepareIdentity: vi.fn()
  };
  return {
    container: createCanvasServer(dependencies),
    dependencies,
    fakeServers
  };
}

describe("createCanvasServer bind failure (SU-02)", () => {
  it("falls back to an ephemeral port when the preferred port is taken", async () => {
    const { container, fakeServers } = bindHarness([1]);

    const entry = await container.getOrCreate("panel-a");

    // The advisory preferred port failing is not terminal, so the socket that
    // eventually bound must be kept, not closed.
    expect(entry.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(entry.baseUrl).not.toContain("45000");
    expect(fakeServers[0].closeCalls).toBe(0);
    expect(container.instances.size).toBe(1);
  });

  it("releases the socket when the ephemeral fallback also fails to bind", async () => {
    const { container, fakeServers } = bindHarness([2]);

    // The fallback error surfaces, not the preferred-port error it replaced.
    await expect(container.getOrCreate("panel-a")).rejects.toThrow(
      "bind failed: 0"
    );

    // A terminal bind failure never registers the instance, so this close is
    // the only chance to release the handle.
    expect(fakeServers[0].closeCalls).toBe(1);
    expect(fakeServers[0].forceCalls).toBe(1);
    expect(container.instances.size).toBe(0);
  });

  it("lets the same instance id start normally after a terminal bind failure", async () => {
    const { container, fakeServers } = bindHarness([2]);
    await expect(container.getOrCreate("panel-a")).rejects.toThrow(
      "bind failed: 0"
    );

    const entry = await container.getOrCreate("panel-a");

    expect(entry.page).toBe("graph");
    expect(container.instances.get("panel-a")).toBe(entry);
    expect(fakeServers).toHaveLength(2);
    expect(fakeServers[1].closeCalls).toBe(0);
  });
});

describe("createCanvasServer started-hook failure (SU-02)", () => {
  function failingStart() {
    const harness = setup();
    const failure = new Error("started hook exploded");
    const stopped: string[] = [];
    harness.dependencies.onStarted = () => {
      throw failure;
    };
    harness.dependencies.onStopped = (instanceId) => stopped.push(instanceId);
    return { ...harness, failure, stopped };
  }

  it("withdraws the registration and closes the socket when the started hook throws", async () => {
    const { container, fakeServers, stopped } = failingStart();

    await expect(container.getOrCreate("panel-a")).rejects.toThrow(
      "started hook exploded"
    );

    // Registration and the hook succeed or fail together: a live entry whose
    // facade-side setup never ran would be handed to the next caller.
    expect(container.instances.size).toBe(0);
    expect(fakeServers[0].closeCalls).toBe(1);
    expect(fakeServers[0].forceCalls).toBe(1);
    // The facade releases its per-instance state through the stopped hook, so
    // the unwind has to fire it exactly as a real stop would.
    expect(stopped).toEqual(["panel-a"]);
  });

  it("lets the same instance id start successfully after a started-hook failure", async () => {
    const { container, dependencies, fakeServers } = failingStart();
    await expect(container.getOrCreate("panel-a")).rejects.toThrow(
      "started hook exploded"
    );

    // Proves the starting bookkeeping was cleared: a retained pending promise
    // would be re-awaited and would reject again instead of starting.
    dependencies.onStarted = undefined;
    const entry = await container.getOrCreate("panel-a");

    expect(container.instances.get("panel-a")).toBe(entry);
    expect(fakeServers).toHaveLength(2);
    expect(fakeServers[1].closeCalls).toBe(0);
  });

  it("keeps the original hook error when the unwind itself fails", async () => {
    const { container, dependencies } = failingStart();
    dependencies.onStopped = () => {
      throw new Error("cleanup exploded");
    };

    // The caller must learn why startup failed, not how the unwind failed.
    await expect(container.getOrCreate("panel-a")).rejects.toThrow(
      "started hook exploded"
    );
    expect(container.instances.size).toBe(0);
  });

  it("lets a stop racing a started-hook failure resolve without closing twice", async () => {
    const { container, fakeServers, stopped } = failingStart();

    const creating = container.getOrCreate("panel-a");
    const stopping = container.stop("panel-a");

    await expect(creating).rejects.toThrow("started hook exploded");
    // stop() is cleanup, so it must not adopt the failed startup's rejection.
    await expect(stopping).resolves.toBeUndefined();
    expect(container.instances.size).toBe(0);
    expect(fakeServers[0].closeCalls).toBe(1);
    expect(stopped).toEqual(["panel-a"]);
  });

  it("lets a stop-all racing a started-hook failure settle", async () => {
    const { container, fakeServers } = failingStart();

    const creating = container.getOrCreate("panel-a");
    const stoppingAll = container.stopAll();

    await expect(creating).rejects.toThrow("started hook exploded");
    await expect(stoppingAll).resolves.toBeUndefined();
    expect(container.instances.size).toBe(0);
    expect(fakeServers[0].closeCalls).toBe(1);
  });
});
