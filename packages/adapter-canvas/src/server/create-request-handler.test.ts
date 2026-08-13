import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createRequestHandler } from "./create-request-handler.js";
import { createRequestContext, syncRequestedPage } from "./request-context.js";
import type { ServerRoute } from "./route-table.js";
import type { CanvasServerEntry } from "./types.js";

function request(
  url: string,
  method = "GET",
  body = "",
  headers: Record<string, string> = {}
): IncomingMessage {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, {
    url,
    method,
    headers
  }) as unknown as IncomingMessage;
}

function responseRecorder() {
  const headers = new Map<string, string>();
  const recorder = {
    body: "",
    status: 0,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    writeHead(status: number) {
      this.status = status;
      return this;
    },
    end(value = "") {
      this.body += value;
      return this;
    }
  };
  return {
    headers,
    recorder,
    response: recorder as unknown as ServerResponse<IncomingMessage>
  };
}

function entry(): CanvasServerEntry {
  return {
    server: {} as HttpServer,
    baseUrl: "http://127.0.0.1:41000",
    url: "http://127.0.0.1:41000/?page=graph",
    page: "graph",
    state: {}
  };
}

type HttpServer = import("node:http").Server;

describe("createRequestHandler (SU-03)", () => {
  it("dispatches a migrated route once and leaves method mismatches on the legacy fallback", async () => {
    const migrated = vi.fn((context) =>
      context.json(200, { path: context.pathname })
    );
    const route: ServerRoute = {
      method: "POST",
      path: "/api/example",
      match: "exact",
      bodyPolicy: "json",
      owner: "liveness-source",
      migration: "migrated",
      handler: migrated
    };
    const legacyFallback = vi.fn();
    const markActivity = vi.fn();
    const instances = new Map([["panel", entry()]]);
    const handler = createRequestHandler({
      instanceId: "panel",
      instances,
      routes: [route],
      legacyFallback,
      markActivity
    }) as (
      request: IncomingMessage,
      response: ServerResponse<IncomingMessage>
    ) => Promise<void>;

    const migratedResponse = responseRecorder();
    await handler(request("/api/example", "POST"), migratedResponse.response);
    await handler(request("/api/example", "GET"), responseRecorder().response);

    expect(migrated).toHaveBeenCalledTimes(1);
    expect(migratedResponse.recorder.status).toBe(200);
    expect(migratedResponse.recorder.body).toBe('{"path":"/api/example"}');
    expect(legacyFallback).toHaveBeenCalledTimes(1);
    expect(markActivity).toHaveBeenCalledTimes(2);
  });

  it("provides cached text, explicit empty-object parsing, malformed-body errors, and JSON serialization", async () => {
    const jsonResponse = responseRecorder();
    const context = createRequestContext(
      request("/api/example", "POST", '{"ok":true}'),
      jsonResponse.response,
      "panel",
      new Map([["panel", entry()]])
    );

    await expect(context.readJsonBody()).resolves.toEqual({ ok: true });
    await expect(context.readTextBody()).resolves.toBe('{"ok":true}');
    context.json(201, { saved: true }, { "Cache-Control": "no-store" });
    expect(jsonResponse.recorder.status).toBe(201);
    expect(jsonResponse.headers.get("content-type")).toBe("application/json");
    expect(jsonResponse.headers.get("cache-control")).toBe("no-store");

    const empty = createRequestContext(
      request("/api/example", "POST"),
      responseRecorder().response,
      "panel",
      new Map()
    );
    await expect(empty.readJsonBody({ emptyObject: true })).resolves.toEqual(
      {}
    );

    const malformed = createRequestContext(
      request("/api/example", "POST", "{"),
      responseRecorder().response,
      "panel",
      new Map()
    );
    await expect(malformed.readJsonBody()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("applies global pre-routing before migrated handlers and the legacy fallback", async () => {
    const migrated = vi.fn();
    const route: ServerRoute = {
      method: "POST",
      path: "/api/example",
      match: "exact",
      bodyPolicy: "json",
      owner: "liveness-source",
      migration: "migrated",
      handler: migrated
    };
    const legacyFallback = vi.fn();
    const canvasEntry = entry();
    const instances = new Map([["panel", canvasEntry]]);
    const handler = createRequestHandler({
      instanceId: "panel",
      instances,
      routes: [route],
      legacyFallback,
      markActivity: vi.fn(),
      preRoute: (context) => {
        if (context.request.headers["sec-fetch-site"] === "cross-site") {
          context.json(403, { code: "cross-site-forbidden" });
          return true;
        }
        syncRequestedPage(
          instances.get(context.instanceId),
          context.url.searchParams.get("page")
        );
        return false;
      }
    }) as (
      request: IncomingMessage,
      response: ServerResponse<IncomingMessage>
    ) => Promise<void>;

    const rejected = responseRecorder();
    await handler(
      request("/api/example?page=planned", "POST", "", {
        "sec-fetch-site": "cross-site"
      }),
      rejected.response
    );
    expect(rejected.recorder.status).toBe(403);
    expect(migrated).not.toHaveBeenCalled();
    expect(legacyFallback).not.toHaveBeenCalled();
    // A rejected cross-site mutation must not mutate instance page state. The
    // legacy dispatcher rejected before reading ?page, so building the request
    // context must stay free of that side effect.
    expect(canvasEntry.page).toBe("graph");
    expect(canvasEntry.state.activeGraphView).toBeUndefined();

    const rejectedLegacy = responseRecorder();
    await handler(
      request("/api/other", "POST", "", { "sec-fetch-site": "cross-site" }),
      rejectedLegacy.response
    );
    expect(rejectedLegacy.recorder.status).toBe(403);
    expect(legacyFallback).not.toHaveBeenCalled();

    await handler(
      request("/api/example?page=planned", "POST"),
      responseRecorder().response
    );
    expect(migrated).toHaveBeenCalledTimes(1);
    expect(canvasEntry.page).toBe("planned");
    expect(canvasEntry.state.activeGraphView).toBe("planned");
  });

  it("preserves page aliases and active-view updates without normalizing unknown pages", () => {
    const canvasEntry = entry();

    syncRequestedPage(canvasEntry, "planned");
    expect(canvasEntry.page).toBe("planned");
    expect(canvasEntry.state.activeGraphView).toBe("planned");

    syncRequestedPage(canvasEntry, "graphDiff");
    expect(canvasEntry.page).toBe("graphDiff");
    expect(canvasEntry.state.activeGraphView).toBe("diff");

    syncRequestedPage(canvasEntry, "unknown");
    expect(canvasEntry.page).toBe("unknown");
    expect(canvasEntry.state.activeGraphView).toBe("diff");
  });
});
