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
});
