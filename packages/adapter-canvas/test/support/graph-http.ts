import { createServer } from "node:http";
import { createCanvasServer } from "../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../src/server/create-request-handler.js";
import {
  createGraphsPlanningRoutes,
  createGraphsPlanningStreamRoutes
} from "../../src/server/routes/graphs-planning.js";
import { createGraphsPlanningWritesRoutes } from "../../src/server/routes/graphs-planning-writes.js";
import { createTestRouteTable } from "./server/route-table.js";
import { graphWorkflowHarness } from "./canonical-graphs.js";

export async function graphHttpHarness() {
  const h = graphWorkflowHarness();
  const deps = {
    readInstanceEntry: h.deps.readInstanceEntry,
    lifecycle: () => h.lifecycle,
    now: () => 1000
  };
  const routes = createTestRouteTable({
    ...createGraphsPlanningRoutes(deps),
    ...createGraphsPlanningStreamRoutes({ ...deps, workflows: h.workflows }),
    ...createGraphsPlanningWritesRoutes({ workflows: h.workflows })
  });
  const container = createCanvasServer({
    createHttpServer: createServer,
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end();
        }
      }),
    createState: () => h.state,
    defaultPage: "graph",
    now: () => 1000,
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });
  try {
    const entry = await container.getOrCreate("graph-test");
    return {
      ...h,
      container,
      url: entry.baseUrl,
      close: () => container.stopAll()
    };
  } catch (error) {
    await container.stopAll();
    throw error;
  }
}
