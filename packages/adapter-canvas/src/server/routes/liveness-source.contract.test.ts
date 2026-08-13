import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  handleOpenSource,
  handlePing,
  type LivenessSourceDependencies,
  type OpenSourceInvoker
} from "./liveness-source.js";
import type { CanvasServerEntry } from "../types.js";
import type { CanvasState } from "../../shared.js";

type HttpServer = import("node:http").Server;

// Verbatim transcription of the two branches this slice removed from the legacy
// `createLegacyRequestHandler` if-chain in `src/server.ts` (`/api/ping` at
// ~2311 and `/api/open-source` at ~2420 before the migration). It exists only
// to prove byte-for-byte equivalence while both implementations conceptually
// exist, and is deleted with the rest of the fallback in the removal slice.
interface LegacyWorld {
  instanceId: string;
  openSourceHandler: OpenSourceInvoker | null;
  servers: Map<string, { state: CanvasState }>;
  toSafeRepoRelPath(input: unknown): string;
}

function legacyPing(
  res: ServerResponse<IncomingMessage>,
  world: LegacyWorld
): void {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, instanceId: world.instanceId }));
}

async function legacyOpenSource(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  world: LegacyWorld
): Promise<void> {
  const { instanceId, openSourceHandler, servers } = world;
  let body = "";
  for await (const chunk of req) body += chunk;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  let relPath: string;
  let line: number;
  try {
    const data = JSON.parse(body || "{}");
    relPath = world.toSafeRepoRelPath(data.path);
    const lineRaw = Number.parseInt(data.line, 10);
    line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : 0;
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: "invalid path" }));
    return;
  }
  if (typeof openSourceHandler !== "function") {
    res.writeHead(503);
    res.end(JSON.stringify({ ok: false, error: "unavailable" }));
    return;
  }
  try {
    const entry = servers.get(instanceId);
    await Promise.resolve(
      openSourceHandler({
        path: relPath,
        line,
        instanceId,
        state: entry?.state
      })
    );
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500);
    res.end(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : "failed"
      })
    );
  }
}

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

function request(body: string): IncomingMessage {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, {
    url: "/api/open-source",
    method: "POST",
    headers: {}
  }) as unknown as IncomingMessage;
}

function safePath(input: unknown): string {
  const value = String(input ?? "");
  if (!value || value.includes("..") || value.startsWith("/")) {
    throw new Error("unsafe path");
  }
  return value;
}

const INSTANCE_ID = "panel-a";

function world(
  handler: OpenSourceInvoker | null,
  state: CanvasState
): LegacyWorld {
  return {
    instanceId: INSTANCE_ID,
    openSourceHandler: handler,
    servers: new Map([[INSTANCE_ID, { state }]]),
    toSafeRepoRelPath: safePath
  };
}

function migratedDependencies(legacy: LegacyWorld): LivenessSourceDependencies {
  return {
    getOpenSourceHandler: () => legacy.openSourceHandler,
    readInstanceState: (instanceId) => legacy.servers.get(instanceId)?.state,
    toSafeRepoRelPath: legacy.toSafeRepoRelPath
  };
}

function instances(state: CanvasState): ReadonlyMap<string, CanvasServerEntry> {
  return new Map<string, CanvasServerEntry>([
    [
      INSTANCE_ID,
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

async function differential(
  body: string,
  handler: OpenSourceInvoker | null
): Promise<[Recording, Recording]> {
  const legacyState: CanvasState = { contextRepo: "octo/app" };
  const legacyWorld = world(handler, legacyState);
  const legacyRecorder = recorder();
  await legacyOpenSource(request(body), legacyRecorder.response, legacyWorld);

  const migratedState: CanvasState = { contextRepo: "octo/app" };
  const migratedWorld = world(handler, migratedState);
  const migratedRecorder = recorder();
  const context = createRequestContext(
    request(body),
    migratedRecorder.response,
    INSTANCE_ID,
    instances(migratedState)
  );
  await handleOpenSource(context, migratedDependencies(migratedWorld));

  return [legacyRecorder.recording, migratedRecorder.recording];
}

describe("liveness-source legacy/migrated differential contract", () => {
  it("produces an identical liveness response", () => {
    const legacyRecorder = recorder();
    legacyPing(legacyRecorder.response, world(null, {}));

    const migratedRecorder = recorder();
    handlePing(
      createRequestContext(
        Object.assign(Readable.from([]), {
          url: "/api/ping",
          method: "GET",
          headers: {}
        }) as unknown as IncomingMessage,
        migratedRecorder.response,
        INSTANCE_ID,
        instances({})
      )
    );

    expect(migratedRecorder.recording).toEqual(legacyRecorder.recording);
    expect(migratedRecorder.recording.status).toBe(200);
    expect(migratedRecorder.recording.headerOrder).toEqual([
      "Content-Type",
      "Cache-Control"
    ]);
  });

  it.each([
    ["invalid path", JSON.stringify({ path: "../secrets" }), 400],
    ["malformed body", "{not json", 400],
    ["empty body", "", 400]
  ])("produces an identical %s response", async (_label, body, status) => {
    const [legacy, migrated] = await differential(body, () => undefined);
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(status);
  });

  it("produces an identical unavailable response", async () => {
    const [legacy, migrated] = await differential(
      JSON.stringify({ path: "src/app.ts" }),
      null
    );
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(503);
  });

  it("produces an identical success response and open input", async () => {
    const calls: unknown[] = [];
    const [legacy, migrated] = await differential(
      JSON.stringify({ path: "src/app.ts", line: "12" }),
      (input) => {
        calls.push({ ...input });
        return Promise.resolve();
      }
    );
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(200);
    expect(calls[0]).toEqual(calls[1]);
  });

  it("produces an identical failure response", async () => {
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
