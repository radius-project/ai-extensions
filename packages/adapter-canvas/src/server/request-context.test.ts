import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext, syncRequestedPage } from "./request-context.js";
import type { CanvasServerEntry } from "./types.js";

type HttpServer = import("node:http").Server;

function request(url: string | undefined, body = ""): IncomingMessage {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, {
    url,
    method: "GET",
    headers: {}
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

function entry(state: CanvasServerEntry["state"] = {}): CanvasServerEntry {
  return {
    server: {} as HttpServer,
    baseUrl: "http://127.0.0.1:41000",
    url: "http://127.0.0.1:41000/",
    page: "graph",
    state
  };
}

function context(
  url: string | undefined,
  body = "",
  instances: ReadonlyMap<string, CanvasServerEntry> = new Map()
) {
  const { headers, recorder, response } = responseRecorder();
  return {
    headers,
    recorder,
    context: createRequestContext(
      request(url, body),
      response,
      "instance-1",
      instances
    )
  };
}

describe("createRequestContext (SU-02)", () => {
  it("derives the url and pathname from the request target", () => {
    const { context: ctx } = context(
      "/api/deployed-graph?repo=owner%2Fname&page=graph"
    );

    expect(ctx.pathname).toBe("/api/deployed-graph");
    expect(ctx.url.searchParams.get("repo")).toBe("owner/name");
    expect(ctx.url.searchParams.get("page")).toBe("graph");
  });

  it("falls back to the root path when the request carries no url", () => {
    // Node types the field as optional, so the context must not construct
    // `new URL(undefined, ...)` and throw on a request that omits it.
    expect(context(undefined).context.pathname).toBe("/");
    expect(context("").context.pathname).toBe("/");
  });

  it("exposes the instance id and the underlying request and response", () => {
    const { recorder, context: ctx } = context("/");

    expect(ctx.instanceId).toBe("instance-1");
    expect(ctx.request.url).toBe("/");
    expect(ctx.response).toBe(
      recorder as unknown as ServerResponse<IncomingMessage>
    );
  });

  it("resolves state from the entry matching the instance id", () => {
    const state = { activeGraphView: "planned" as const };
    const instances = new Map([
      ["other", entry({ activeGraphView: "graph" })],
      ["instance-1", entry(state)]
    ]);

    // Identity, not equality: handlers mutate instance state in place, so a
    // copy would silently discard every write.
    expect(context("/", "", instances).context.state).toBe(state);
  });

  it("resolves an empty state object when no entry matches the instance id", () => {
    const ctx = context("/", "", new Map([["other", entry()]])).context;

    expect(ctx.state).toEqual({});
    expect(ctx.state).toBeDefined();
  });
});

describe("createRequestContext body reads (SU-02)", () => {
  it("concatenates the request stream into the text body", async () => {
    await expect(
      context("/", '{"repo":"owner/name"}').context.readTextBody()
    ).resolves.toBe('{"repo":"owner/name"}');
  });

  it("memoises the body so a second read does not drain an exhausted stream", async () => {
    const ctx = context("/", "payload").context;

    // The stream can only be consumed once. Without memoisation the second
    // read resolves to "" and every route that reads its body twice breaks.
    await expect(ctx.readTextBody()).resolves.toBe("payload");
    await expect(ctx.readTextBody()).resolves.toBe("payload");
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const ctx = context("/", "payload").context;

    await expect(
      Promise.all([ctx.readTextBody(), ctx.readTextBody()])
    ).resolves.toEqual(["payload", "payload"]);
  });

  it("parses the request body as json", async () => {
    await expect(
      context("/", '{"branch":"main"}').context.readJsonBody()
    ).resolves.toEqual({
      branch: "main"
    });
  });

  it("rejects an empty body when the empty-object allowance is not requested", async () => {
    await expect(context("/").context.readJsonBody()).rejects.toThrow();
    await expect(
      context("/").context.readJsonBody({ emptyObject: false })
    ).rejects.toThrow();
  });

  it("substitutes an empty object for an empty body only when allowed", async () => {
    await expect(
      context("/").context.readJsonBody({ emptyObject: true })
    ).resolves.toEqual({});
  });

  it("parses a present body even when the empty-object allowance is requested", async () => {
    // Pins the `!value &&` conjunction: the allowance applies to an empty body
    // only, and must never discard a body that was actually sent.
    await expect(
      context("/", '{"branch":"main"}').context.readJsonBody({
        emptyObject: true
      })
    ).resolves.toEqual({ branch: "main" });
  });
});

describe("createRequestContext responses (SU-02)", () => {
  it("writes json with the json content type, status and serialised payload", () => {
    const { headers, recorder, context: ctx } = context("/");

    ctx.json(200, { resources: [], mode: "greyed" });

    expect(headers.get("content-type")).toBe("application/json");
    expect(recorder.status).toBe(200);
    expect(recorder.body).toBe('{"resources":[],"mode":"greyed"}');
  });

  it("writes text with the utf-8 text content type, status and raw payload", () => {
    const { headers, recorder, context: ctx } = context("/");

    ctx.text(404, "Not found");

    expect(headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(recorder.status).toBe(404);
    // Raw, not serialised: a text response must not gain JSON quoting.
    expect(recorder.body).toBe("Not found");
  });

  it("applies caller headers alongside the content type", () => {
    const json = context("/");
    json.context.json(200, {}, { "cache-control": "no-store" });
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(json.headers.get("cache-control")).toBe("no-store");

    const text = context("/");
    text.context.text(200, "ok", { "cache-control": "no-store" });
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("cache-control")).toBe("no-store");
  });

  it("lets a caller header override the default content type", () => {
    // Caller headers are applied after the content type, so a route that needs
    // a different type does not have to bypass the context helpers.
    const { headers, context: ctx } = context("/");

    ctx.text(200, "id,name", { "Content-Type": "text/csv" });

    expect(headers.get("content-type")).toBe("text/csv");
  });

  it("writes the status only after the headers are set", () => {
    // writeHead freezes the header set, so a header written afterwards is
    // silently dropped from the response.
    const order: string[] = [];
    const response = {
      setHeader(name: string) {
        order.push(`set:${name.toLowerCase()}`);
        return this;
      },
      writeHead(status: number) {
        order.push(`head:${status}`);
        return this;
      },
      end() {
        order.push("end");
        return this;
      }
    } as unknown as ServerResponse<IncomingMessage>;

    createRequestContext(request("/"), response, "instance-1", new Map()).json(
      201,
      {},
      { "cache-control": "no-store" }
    );

    expect(order).toEqual([
      "set:content-type",
      "set:cache-control",
      "head:201",
      "end"
    ]);
  });
});

describe("syncRequestedPage (SU-02)", () => {
  it("maps the graph page onto the graph view", () => {
    // The dispatcher suite pins "planned", "graphDiff" and an unknown value;
    // the plain "graph" alias is the default page and was never asserted.
    const canvasEntry = entry();

    syncRequestedPage(canvasEntry, "graph");

    expect(canvasEntry.page).toBe("graph");
    expect(canvasEntry.state.activeGraphView).toBe("graph");
  });

  it("maps both graph-diff aliases onto the diff view", () => {
    const hyphenated = entry();
    syncRequestedPage(hyphenated, "graph-diff");
    expect(hyphenated.page).toBe("graph-diff");
    expect(hyphenated.state.activeGraphView).toBe("diff");

    const camelCased = entry();
    syncRequestedPage(camelCased, "graphDiff");
    expect(camelCased.page).toBe("graphDiff");
    expect(camelCased.state.activeGraphView).toBe("diff");
  });

  it("ignores a request that names no page", () => {
    const canvasEntry = entry({ activeGraphView: "planned" });

    syncRequestedPage(canvasEntry, null);
    syncRequestedPage(canvasEntry, "");

    expect(canvasEntry.page).toBe("graph");
    expect(canvasEntry.state.activeGraphView).toBe("planned");
  });

  it("ignores a request for an instance that has no entry", () => {
    // Guards the arm independently of the requested page: a live page value
    // must not make an absent entry throw.
    expect(() => syncRequestedPage(undefined, "graph")).not.toThrow();
  });
});
