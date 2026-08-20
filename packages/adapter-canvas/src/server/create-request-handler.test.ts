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
  it("dispatches a typed route once and delegates method mismatches without reading their body", async () => {
    const typedHandler = vi.fn((context) =>
      context.json(200, { path: context.pathname })
    );
    const route: ServerRoute = {
      method: "POST",
      path: "/api/example",
      match: "exact",
      bodyPolicy: "json",
      mutationPolicy: "legacy-exempt",
      owner: "liveness-source",
      handler: typedHandler
    };
    const handleUnmatchedRequest = vi.fn();
    const markActivity = vi.fn();
    const instances = new Map([["panel", entry()]]);
    const handler = createRequestHandler({
      instanceId: "panel",
      instances,
      routes: [route],
      handleUnmatchedRequest,
      markActivity
    }) as (
      request: IncomingMessage,
      response: ServerResponse<IncomingMessage>
    ) => Promise<void>;

    const typedResponse = responseRecorder();
    await handler(request("/api/example", "POST"), typedResponse.response);
    const unmatchedRequest = request("/api/example", "GET", '{"ignored":true}');
    await handler(unmatchedRequest, responseRecorder().response);

    expect(typedHandler).toHaveBeenCalledTimes(1);
    expect(typedResponse.recorder.status).toBe(200);
    expect(typedResponse.recorder.body).toBe('{"path":"/api/example"}');
    expect(handleUnmatchedRequest).toHaveBeenCalledTimes(1);
    expect(unmatchedRequest.readableDidRead).toBe(false);
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

  it("applies global pre-routing before typed and unmatched handlers", async () => {
    const typedHandler = vi.fn();
    const route: ServerRoute = {
      method: "POST",
      path: "/api/example",
      match: "exact",
      bodyPolicy: "json",
      mutationPolicy: "legacy-exempt",
      owner: "liveness-source",
      handler: typedHandler
    };
    const handleUnmatchedRequest = vi.fn();
    const canvasEntry = entry();
    const instances = new Map([["panel", canvasEntry]]);
    const handler = createRequestHandler({
      instanceId: "panel",
      instances,
      routes: [route],
      handleUnmatchedRequest,
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
    expect(typedHandler).not.toHaveBeenCalled();
    expect(handleUnmatchedRequest).not.toHaveBeenCalled();
    // A rejected cross-site mutation must not mutate instance page state. The
    // legacy dispatcher rejected before reading ?page, so building the request
    // context must stay free of that side effect.
    expect(canvasEntry.page).toBe("graph");
    expect(canvasEntry.state.activeGraphView).toBeUndefined();

    const rejectedUnmatched = responseRecorder();
    await handler(
      request("/api/other", "POST", "", { "sec-fetch-site": "cross-site" }),
      rejectedUnmatched.response
    );
    expect(rejectedUnmatched.recorder.status).toBe(403);
    expect(handleUnmatchedRequest).not.toHaveBeenCalled();

    await handler(
      request("/api/example?page=planned", "POST"),
      responseRecorder().response
    );
    expect(typedHandler).toHaveBeenCalledTimes(1);
    expect(canvasEntry.page).toBe("planned");
    expect(canvasEntry.state.activeGraphView).toBe("planned");
  });

  it("rejects nonce-protected routes centrally before the handler reads the body", async () => {
    const typedHandler = vi.fn();
    const route: ServerRoute = {
      method: "POST",
      path: "/api/protected",
      match: "exact",
      bodyPolicy: "json",
      mutationPolicy: "nonce-required",
      owner: "operations-status",
      handler: typedHandler
    };
    const validateBrowserMutation = vi.fn(() => false);
    const handler = createRequestHandler({
      instanceId: "panel",
      instances: new Map([["panel", entry()]]),
      routes: [route],
      handleUnmatchedRequest: vi.fn(),
      markActivity: vi.fn(),
      validateBrowserMutation
    });
    const protectedRequest = request(
      "/api/protected",
      "POST",
      '{"mustNotBeRead":true}'
    );
    const response = responseRecorder();

    await handler(protectedRequest, response.response);

    expect(response.recorder.status).toBe(403);
    expect(JSON.parse(response.recorder.body)).toEqual({
      error: "This browser mutation request is not trusted.",
      code: "browser-mutation-validation-failed"
    });
    expect(validateBrowserMutation).toHaveBeenCalledTimes(1);
    expect(typedHandler).not.toHaveBeenCalled();
    expect(protectedRequest.readableDidRead).toBe(false);
  });

  it("fails closed when a protected route has no validator", async () => {
    const route: ServerRoute = {
      method: "POST",
      path: "/api/protected",
      match: "exact",
      bodyPolicy: "json",
      mutationPolicy: "nonce-required",
      owner: "operations-status",
      handler: vi.fn()
    };

    const handler = createRequestHandler({
      instanceId: "panel",
      instances: new Map([["panel", entry()]]),
      routes: [route],
      handleUnmatchedRequest: vi.fn(),
      markActivity: vi.fn()
    });
    const response = responseRecorder();

    await handler(request("/api/protected", "POST"), response.response);

    expect(response.recorder.status).toBe(403);
    expect(route.handler).not.toHaveBeenCalled();
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
