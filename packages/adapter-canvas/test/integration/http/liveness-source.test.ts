import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createLivenessSourceRoutes } from "../../../src/server/routes/liveness-source.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasState } from "../../../src/shared.js";
import type { OpenSourceRequest } from "../../../src/server/routes/liveness-source.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

function safePath(input: unknown): string {
  const value = String(input ?? "");
  if (!value || value.includes("..") || value.startsWith("/")) {
    throw new Error("unsafe path");
  }
  return value;
}

interface Harness {
  opens: OpenSourceRequest[];
  setOpenSource(handler: ((input: OpenSourceRequest) => unknown) | null): void;
  stateFor(instanceId: string): CanvasState | undefined;
}

function start(): Harness {
  const opens: OpenSourceRequest[] = [];
  let openSource: ((input: OpenSourceRequest) => unknown) | null = null;
  let instanceStates: ReadonlyMap<string, { state: CanvasState }> = new Map();

  const routes = createTestRouteTable(
    createLivenessSourceRoutes({
      // Read through a getter so a handler registered after the server exists
      // is still honored, exactly as the SDK entry does in production.
      getOpenSourceHandler: () => openSource,
      readInstanceState: (instanceId) => instanceStates.get(instanceId)?.state,
      toSafeRepoRelPath: safePath
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) => {
      instanceStates = instances;
      return createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        legacyFallback: (_request, response) => {
          response.writeHead(418);
          response.end("legacy");
        }
      });
    },
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    opens,
    setOpenSource(handler) {
      openSource =
        handler === null ? null : (
          (input) => {
            opens.push(input);
            return handler(input);
          }
        );
    },
    stateFor: (instanceId) => instanceStates.get(instanceId)?.state
  };
}

describe("liveness-source real-loopback HIT (RF-01)", () => {
  it("serves the liveness probe and the source-open contract over a real socket", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const ping = await fetch(`${entry.baseUrl}/api/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get("content-type")).toBe("application/json");
    expect(ping.headers.get("cache-control")).toBe("no-store");
    expect(await ping.text()).toBe('{"ok":true,"instanceId":"panel-a"}');

    // `ANY` really means any method on the wire, not just GET.
    const pingPost = await fetch(`${entry.baseUrl}/api/ping`, {
      method: "POST"
    });
    expect(pingPost.status).toBe(200);
    expect(await pingPost.text()).toBe('{"ok":true,"instanceId":"panel-a"}');

    const unavailable = await fetch(`${entry.baseUrl}/api/open-source`, {
      method: "POST",
      body: JSON.stringify({ path: "src/app.ts" })
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.text()).toBe('{"ok":false,"error":"unavailable"}');

    harness.setOpenSource(() => Promise.resolve());
    entry.state.contextRepo = "octo/app";

    const invalid = await fetch(`${entry.baseUrl}/api/open-source`, {
      method: "POST",
      body: JSON.stringify({ path: "../../etc/passwd" })
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toBe("application/json");
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(await invalid.text()).toBe('{"ok":false,"error":"invalid path"}');

    const opened = await fetch(`${entry.baseUrl}/api/open-source`, {
      method: "POST",
      body: JSON.stringify({ path: "src/app.ts", line: "42" })
    });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('{"ok":true}');
    expect(harness.opens).toEqual([
      {
        path: "src/app.ts",
        line: 42,
        instanceId: "panel-a",
        state: entry.state
      }
    ]);

    harness.setOpenSource(() => {
      throw new Error("editor canvas unavailable");
    });
    const failed = await fetch(`${entry.baseUrl}/api/open-source`, {
      method: "POST",
      body: JSON.stringify({ path: "src/app.ts" })
    });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe(
      '{"ok":false,"error":"editor canvas unavailable"}'
    );

    // Unmigrated routes still reach the fallback.
    const residual = await fetch(`${entry.baseUrl}/api/list-environments`);
    expect(residual.status).toBe(418);
  });

  it("keeps liveness responses scoped to the instance that served them", async () => {
    start();
    const first = await container!.getOrCreate("panel-a");
    const second = await container!.getOrCreate("panel-b");
    expect(second.baseUrl).not.toBe(first.baseUrl);

    expect(await (await fetch(`${first.baseUrl}/api/ping`)).text()).toBe(
      '{"ok":true,"instanceId":"panel-a"}'
    );
    expect(await (await fetch(`${second.baseUrl}/api/ping`)).text()).toBe(
      '{"ok":true,"instanceId":"panel-b"}'
    );
  });
});
