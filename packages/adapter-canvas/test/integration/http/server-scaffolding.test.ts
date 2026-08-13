import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { syncRequestedPage } from "../../../src/server/request-context.js";
import { SERVER_ROUTE_TABLE } from "../../../src/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

describe("server scaffolding real-loopback HIT", () => {
  it("binds an OS-assigned loopback port and preserves facade lifecycle behavior", async () => {
    let clock = 1000;
    container = createCanvasServer({
      createHttpServer: (handler) => createServer(handler),
      createRequestHandler: ({ instanceId, instances, markActivity }) =>
        createRequestHandler({
          instanceId,
          instances,
          routes: SERVER_ROUTE_TABLE,
          markActivity,
          preRoute: (context) => {
            syncRequestedPage(
              instances.get(context.instanceId),
              context.url.searchParams.get("page")
            );
            return false;
          },
          legacyFallback: (_request, response) => {
            const entry = instances.get(instanceId);
            response.setHeader("Content-Type", "application/json");
            response.writeHead(200);
            response.end(
              JSON.stringify({
                instanceId,
                page: entry?.page,
                state: entry?.state
              })
            );
          }
        }),
      createState: () => ({}),
      defaultPage: "graph",
      now: () => ++clock,
      preferredPort: async () => 0,
      prepareIdentity: () => {}
    });

    const first = await container.getOrCreate("panel-a");
    const firstUrl = new URL(first.baseUrl);
    expect(firstUrl.hostname).toBe("127.0.0.1");
    expect(Number(firstUrl.port)).toBeGreaterThan(0);
    expect(first.url).toBe(`${first.baseUrl}/?page=graph`);
    expect(first.state).toEqual({});

    const defaultResponse = await fetch(first.baseUrl);
    expect(await defaultResponse.json()).toEqual({
      instanceId: "panel-a",
      page: "graph",
      state: {}
    });
    expect(container.getLastActivityAt()).toBe(1001);

    const plannedResponse = await fetch(`${first.baseUrl}/?page=planned`);
    expect(await plannedResponse.json()).toEqual({
      instanceId: "panel-a",
      page: "planned",
      state: { activeGraphView: "planned" }
    });

    first.state.contextRepo = "octo/app";
    const reused = await container.getOrCreate("panel-a");
    const isolated = await container.getOrCreate("panel-b");
    expect(reused).toBe(first);
    expect(reused.page).toBe("planned");
    expect(reused.state.contextRepo).toBe("octo/app");
    expect(isolated.baseUrl).not.toBe(first.baseUrl);
    expect(isolated.state).toEqual({});

    await Promise.all([container.stop("panel-a"), container.stop("panel-a")]);
    await container.stop("panel-a");
    expect(container.instances.has("panel-a")).toBe(false);

    await Promise.all([container.stopAll(), container.stopAll()]);
    await container.stopAll();
    expect(container.instances.size).toBe(0);
  });
});
