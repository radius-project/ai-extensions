import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createLivenessSourceRoutes,
  handleOpenSource,
  handlePing,
  PING_MODEL_REVISION_BUDGET_MS,
  type LivenessSourceDependencies,
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

function request(
  body = "",
  method = "POST",
  headers: Readonly<Record<string, string>> = {},
  url = "/api/open-source"
): IncomingMessage {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, {
    url,
    method,
    headers
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
    getWorkspaceModelRevision: () =>
      Promise.reject(new Error("getWorkspaceModelRevision not stubbed")),
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

async function runPing(deps: LivenessSourceDependencies): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request("", "GET", { "x-radius-workspace-model": "1" }, "/api/ping"),
    response,
    "panel-a",
    instances()
  );
  await handlePing(context, deps);
  return recording;
}

describe("liveness-source routes (SU-04)", () => {
  it("declares exactly the two routes it owns", () => {
    const routes = createLivenessSourceRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "ANY /api/ping",
      "POST /api/open-source"
    ]);
  });

  it("returns the current workspace model revision without caching", async () => {
    const recording = await runPing(
      dependencies({
        getWorkspaceModelRevision: () => Promise.resolve("model-b"),
        readInstanceState: () => ({ graphModelRevision: "model-a" })
      })
    );

    expect(recording).toEqual({
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json"
      },
      headerOrder: ["Content-Type", "Cache-Control"],
      status: 200,
      body: '{"ok":true,"instanceId":"panel-a","workspaceModelRevision":"model-b","workspaceModelChanged":true}'
    });
  });

  it("omits the revision for a non-workspace selection", async () => {
    const recording = await runPing(
      dependencies({
        getWorkspaceModelRevision: () => Promise.resolve(null),
        readInstanceState: () => undefined
      })
    );

    expect(recording.body).toBe('{"ok":true,"instanceId":"panel-a"}');
  });

  it("reports an unchanged rendered workspace model", async () => {
    const recording = await runPing(
      dependencies({
        getWorkspaceModelRevision: () => Promise.resolve("model-a"),
        readInstanceState: () => ({ graphModelRevision: "model-a" })
      })
    );

    expect(JSON.parse(recording.body)).toMatchObject({
      workspaceModelRevision: "model-a",
      workspaceModelChanged: false
    });
  });

  it("still answers liveness when the workspace model revision read fails", async () => {
    const recording = await runPing(
      dependencies({
        getWorkspaceModelRevision: () =>
          Promise.reject(new Error("workspace unavailable")),
        readInstanceState: () => ({ graphModelRevision: "model-a" })
      })
    );

    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"ok":true,"instanceId":"panel-a"}');
  });

  it("answers liveness without the revision when the workspace read runs long", async () => {
    vi.useFakeTimers();
    try {
      const recording = recorder();
      const context = createRequestContext(
        request("", "GET", { "x-radius-workspace-model": "1" }, "/api/ping"),
        recording.response,
        "panel-a",
        instances()
      );
      const pending = handlePing(
        context,
        dependencies({
          getWorkspaceModelRevision: () => new Promise<string>(() => {}),
          readInstanceState: () => ({ graphModelRevision: "model-a" })
        })
      );

      await vi.advanceTimersByTimeAsync(PING_MODEL_REVISION_BUDGET_MS);
      await pending;

      expect(recording.recording.status).toBe(200);
      expect(recording.recording.body).toBe(
        '{"ok":true,"instanceId":"panel-a"}'
      );
    } finally {
      vi.useRealTimers();
    }
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
