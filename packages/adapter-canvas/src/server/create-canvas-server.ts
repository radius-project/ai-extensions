import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { CanvasServerDependencies } from "./ports.js";
import type { CanvasServerEntry } from "./types.js";

export interface CanvasServerContainer {
  readonly instances: Map<string, CanvasServerEntry>;
  getLastActivityAt(): number;
  getOrCreate(instanceId: string, page?: string): Promise<CanvasServerEntry>;
  stop(instanceId: string): Promise<void>;
  stopAll(): Promise<void>;
}

const REQUIRED_DEPENDENCIES = [
  "createHttpServer",
  "createRequestHandler",
  "createState",
  "defaultPage",
  "now",
  "preferredPort",
  "prepareIdentity"
] as const;

function validateDependencies(dependencies: CanvasServerDependencies): void {
  for (const name of REQUIRED_DEPENDENCIES) {
    const value = dependencies[name];
    if (
      value === undefined ||
      value === null ||
      (name !== "defaultPage" && typeof value !== "function") ||
      (name === "defaultPage" &&
        (typeof value !== "string" || value.length === 0))
    ) {
      throw new Error(`Missing canvas server dependency: ${name}`);
    }
  }
}

function listenOn(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function boundPort(server: HttpServer): number {
  const address = server.address();
  return typeof address === "object" && address ?
      (address as AddressInfo).port
    : 0;
}

function closeServer(server: HttpServer, force: boolean): Promise<void> {
  if (force) server.closeAllConnections?.();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export function createCanvasServer(
  dependencies: CanvasServerDependencies
): CanvasServerContainer {
  validateDependencies(dependencies);
  const instances = new Map<string, CanvasServerEntry>();
  const starting = new Map<string, Promise<CanvasServerEntry>>();
  const stopping = new Map<string, Promise<void>>();
  let lastActivityAt = 0;

  const markActivity = () => {
    lastActivityAt = dependencies.now();
  };

  async function start(
    instanceId: string,
    page: string
  ): Promise<CanvasServerEntry> {
    const handler = dependencies.createRequestHandler({
      instanceId,
      instances,
      markActivity
    });
    dependencies.prepareIdentity();
    const state = dependencies.createState();
    const server = dependencies.createHttpServer(handler);
    const preferredPort = await dependencies.preferredPort(instanceId);
    try {
      await listenOn(server, preferredPort);
    } catch {
      await listenOn(server, 0);
    }
    const port = boundPort(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const entry: CanvasServerEntry = {
      server,
      baseUrl,
      url: `${baseUrl}/?page=${page}`,
      page,
      state
    };
    instances.set(instanceId, entry);
    return entry;
  }

  async function getOrCreate(
    instanceId: string,
    page?: string
  ): Promise<CanvasServerEntry> {
    const pendingStop = stopping.get(instanceId);
    if (pendingStop) {
      await pendingStop;
      return await getOrCreate(instanceId, page);
    }
    const existing = instances.get(instanceId);
    if (existing) {
      if (page && existing.page !== page) {
        existing.page = page;
        existing.url = `${existing.baseUrl}/?page=${page}`;
      }
      return existing;
    }
    const pending = starting.get(instanceId);
    if (pending) {
      const entry = await pending;
      const stopAfterStart = stopping.get(instanceId);
      if (stopAfterStart) {
        await stopAfterStart;
        return await getOrCreate(instanceId, page);
      }
      if (page && entry.page !== page) {
        entry.page = page;
        entry.url = `${entry.baseUrl}/?page=${page}`;
      }
      return entry;
    }
    const created = start(
      instanceId,
      page === undefined ? dependencies.defaultPage : page
    );
    starting.set(instanceId, created);
    try {
      return await created;
    } finally {
      starting.delete(instanceId);
    }
  }

  function stop(instanceId: string, force = false): Promise<void> {
    const pending = stopping.get(instanceId);
    if (pending) return pending;
    const work = (async () => {
      const startingEntry = starting.get(instanceId);
      if (startingEntry) await startingEntry;
      const entry = instances.get(instanceId);
      if (!entry) return;
      instances.delete(instanceId);
      await closeServer(entry.server, force);
    })();
    stopping.set(instanceId, work);
    void work.then(
      () => stopping.delete(instanceId),
      () => stopping.delete(instanceId)
    );
    return work;
  }

  return {
    instances,
    getLastActivityAt: () => lastActivityAt,
    getOrCreate,
    stop: (instanceId) => stop(instanceId),
    async stopAll() {
      const ids = [...new Set([...instances.keys(), ...starting.keys()])];
      const requestedStops = ids.map((id) => stop(id, true));
      await Promise.all([...requestedStops, ...stopping.values()]);
    }
  };
}
