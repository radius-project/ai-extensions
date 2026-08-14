import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createLivenessSourceRoutes,
  handleOpenSource,
  handlePing,
  type LivenessSourceDependencies,
  type OpenSourceInvoker,
  type OpenSourceRequest
} from "./liveness-source.js";
import type { CanvasServerEntry } from "../types.js";
import type { CanvasState } from "../../shared.js";

type HttpServer = import("node:http").Server;

interface Recording {
  headers: Record<string, string>;
  headerOrder: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      // Mirrors Node: re-setting a header overwrites it and keeps its position.
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(body = "", method = "POST"): IncomingMessage {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, {
    url: "/api/open-source",
    method,
    headers: {}
  }) as unknown as IncomingMessage;
}

function instances(
  state?: CanvasState
): ReadonlyMap<string, CanvasServerEntry> {
  if (!state) return new Map<string, CanvasServerEntry>();
  return new Map<string, CanvasServerEntry>([
    [
      "panel-a",
      {
        server: {} as HttpServer,
        baseUrl: "http://127.0.0.1:41000",
        url: "http://127.0.0.1:41000/?page=graph",
        page: "graph",
        state
      }
    ]
  ]);
}

// Fakes throw on anything the route is not supposed to reach, so an accidental
// widening of the dependency surface fails loudly.
function dependencies(
  overrides: Partial<LivenessSourceDependencies> = {}
): LivenessSourceDependencies {
  return {
    getOpenSourceHandler: () => {
      throw new Error("getOpenSourceHandler not stubbed");
    },
    readInstanceState: () => {
      throw new Error("readInstanceState not stubbed");
    },
    toSafeRepoRelPath: () => {
      throw new Error("toSafeRepoRelPath not stubbed");
    },
    ...overrides
  };
}

function safePath(input: unknown): string {
  const value = String(input ?? "");
  if (!value || value.includes("..") || value.startsWith("/")) {
    throw new Error("unsafe path");
  }
  return value;
}

// Verbatim transcription of the two branches removed from the former inline
// dispatcher. The differential cases below keep the
// compatibility proof without duplicating the unit-test request harness.
interface LegacyWorld {
  instanceId: string;
  openSourceHandler: OpenSourceInvoker | null;
  servers: Map<string, { state: CanvasState }>;
  toSafeRepoRelPath(input: unknown): string;
}

function legacyPing(
  response: ServerResponse<IncomingMessage>,
  instanceId: string
): void {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(200);
  response.end(JSON.stringify({ ok: true, instanceId }));
}

async function legacyOpenSource(
  incoming: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  world: LegacyWorld
): Promise<void> {
  let body = "";
  for await (const chunk of incoming) body += chunk;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  let relPath: string;
  let line: number;
  try {
    const data = JSON.parse(body || "{}");
    relPath = world.toSafeRepoRelPath(data.path);
    const lineRaw = Number.parseInt(data.line, 10);
    line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : 0;
  } catch {
    response.writeHead(400);
    response.end(JSON.stringify({ ok: false, error: "invalid path" }));
    return;
  }
  if (typeof world.openSourceHandler !== "function") {
    response.writeHead(503);
    response.end(JSON.stringify({ ok: false, error: "unavailable" }));
    return;
  }
  try {
    const entry = world.servers.get(world.instanceId);
    await Promise.resolve(
      world.openSourceHandler({
        path: relPath,
        line,
        instanceId: world.instanceId,
        state: entry?.state
      })
    );
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    response.writeHead(500);
    response.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "failed"
      })
    );
  }
}

async function differential(
  body: string,
  openSourceHandler: OpenSourceInvoker | null
): Promise<[Recording, Recording]> {
  const state: CanvasState = { contextRepo: "octo/app" };
  const world: LegacyWorld = {
    instanceId: "panel-a",
    openSourceHandler,
    servers: new Map([["panel-a", { state }]]),
    toSafeRepoRelPath: safePath
  };
  const legacy = recorder();
  await legacyOpenSource(request(body), legacy.response, world);

  const migrated = recorder();
  await handleOpenSource(
    createRequestContext(
      request(body),
      migrated.response,
      "panel-a",
      instances(state)
    ),
    {
      getOpenSourceHandler: () => world.openSourceHandler,
      readInstanceState: (instanceId) => world.servers.get(instanceId)?.state,
      toSafeRepoRelPath: world.toSafeRepoRelPath
    }
  );
  return [legacy.recording, migrated.recording];
}

async function runOpenSource(
  body: string,
  deps: LivenessSourceDependencies,
  state?: CanvasState
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(body),
    response,
    "panel-a",
    instances(state)
  );
  await handleOpenSource(context, deps);
  return recording;
}

describe("liveness-source routes (SU-04)", () => {
  it("declares exactly the two routes it owns", () => {
    const routes = createLivenessSourceRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "ANY /api/ping",
      "POST /api/open-source"
    ]);
    expect(routes["ANY /api/ping"]).toBe(handlePing);
  });

  it("rejects an unsafe path before consulting the open handler", async () => {
    const recording = await runOpenSource(
      JSON.stringify({ path: "../../etc/passwd" }),
      dependencies({ toSafeRepoRelPath: safePath })
    );
    expect(recording.status).toBe(400);
  });

  it("opens the safe path with per-instance state and returns 200", async () => {
    const calls: OpenSourceRequest[] = [];
    const state: CanvasState = { contextRepo: "octo/app" };
    const recording = await runOpenSource(
      JSON.stringify({ path: "src/app.ts", line: "42" }),
      dependencies({
        toSafeRepoRelPath: safePath,
        getOpenSourceHandler: () => (input) => {
          calls.push(input);
          return Promise.resolve();
        },
        readInstanceState: (instanceId) =>
          instanceId === "panel-a" ? state : undefined
      }),
      state
    );
    expect(recording.status).toBe(200);
    expect(calls).toEqual([
      { path: "src/app.ts", line: 42, instanceId: "panel-a", state }
    ]);
  });

  it("coerces missing, non-numeric, zero, and negative lines to 0", async () => {
    const seen: number[] = [];
    const deps = dependencies({
      toSafeRepoRelPath: safePath,
      getOpenSourceHandler: () => (input) => {
        seen.push(input.line);
      },
      readInstanceState: () => undefined
    });
    for (const line of [undefined, "abc", 0, -3, "7x"]) {
      const recording = await runOpenSource(
        JSON.stringify({ path: "src/app.ts", line }),
        deps
      );
      expect(recording.status).toBe(200);
    }
    // "7x" still parses to 7 because the legacy branch used Number.parseInt.
    expect(seen).toEqual([0, 0, 0, 0, 7]);
  });

  it("falls back to `failed` when the thrown value is not an Error", async () => {
    const recording = await runOpenSource(
      JSON.stringify({ path: "src/app.ts" }),
      dependencies({
        toSafeRepoRelPath: safePath,
        getOpenSourceHandler: () => () => Promise.reject("nope"),
        readInstanceState: () => undefined
      })
    );
    expect(recording.status).toBe(500);
    expect(recording.body).toBe('{"ok":false,"error":"failed"}');
  });

  it("reads the registered handler per request rather than snapshotting it", async () => {
    let registered: ((input: OpenSourceRequest) => unknown) | null = null;
    const deps = dependencies({
      toSafeRepoRelPath: safePath,
      getOpenSourceHandler: () => registered,
      readInstanceState: () => undefined
    });
    const routes = createLivenessSourceRoutes(deps);
    const body = JSON.stringify({ path: "src/app.ts" });

    const before = await runOpenSource(body, deps);
    expect(before.status).toBe(503);

    registered = () => undefined;
    const after = await runOpenSource(body, deps);
    expect(after.status).toBe(200);
    expect(routes["POST /api/open-source"]).toBeTypeOf("function");
  });
});

describe("liveness-source legacy/migrated differential contract", () => {
  it("produces an identical liveness response", () => {
    const legacy = recorder();
    legacyPing(legacy.response, "panel-a");

    const migrated = recorder();
    handlePing(
      createRequestContext(
        request("", "GET"),
        migrated.response,
        "panel-a",
        instances()
      )
    );

    expect(migrated.recording).toEqual(legacy.recording);
    expect(migrated.recording.headerOrder).toEqual([
      "Content-Type",
      "Cache-Control"
    ]);
  });

  it.each([
    ["invalid path", JSON.stringify({ path: "../secrets" }), 400],
    ["malformed body", "{not json", 400],
    ["unavailable handler", JSON.stringify({ path: "src/app.ts" }), 503]
  ])("produces an identical %s response", async (_label, body, status) => {
    const handler = status === 503 ? null : () => undefined;
    const [legacy, migrated] = await differential(body, handler);
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(status);
  });

  it("produces identical success output and open input", async () => {
    const calls: OpenSourceRequest[] = [];
    const [legacy, migrated] = await differential(
      JSON.stringify({ path: "src/app.ts", line: "12" }),
      (input) => {
        calls.push({ ...input });
      }
    );
    expect(migrated).toEqual(legacy);
    expect(calls[0]).toEqual(calls[1]);
  });

  it("produces an identical surfaced failure", async () => {
    const [legacy, migrated] = await differential(
      JSON.stringify({ path: "src/app.ts" }),
      () => {
        throw new Error("open failed");
      }
    );
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(500);
  });
});
