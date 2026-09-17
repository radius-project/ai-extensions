import { expect, it } from "vitest";
import { graphRouteContext } from "../../../test/support/graph-route.js";
import { handleProgress } from "./graphs-planning.js";
import type { GraphProgressRecord, GraphProgressView } from "../../shared.js";

function progress(
  view: GraphProgressView,
  started: number,
  active: boolean
): GraphProgressRecord {
  return {
    graphProgressView: view,
    graphProgressStartedAtMs: started,
    graphProgressActive: active,
    graphProgressGeneration: started,
    graphBuildEvents: [],
    graphProgressKey: view,
    graphProgressOwner: started,
    graphProgressAwaitingModel: false
  };
}

it.each([
  ["", "planned"],
  ["?view=unknown", "planned"],
  ["?view=graph", "graph"],
  ["?view=planned", "planned"],
  ["?view=diff", "diff"]
] as const)(
  "selects progress %s by explicit view or newest active read",
  async (query, expected) => {
    const h = graphRouteContext(`/api/progress${query}`);
    const records = {
      graph: progress("graph", 100, true),
      planned: progress("planned", 200, true),
      diff: progress("diff", 300, false)
    };
    try {
      await handleProgress(h.context, {
        readInstanceEntry: () => ({
          state: {
            progressMessages: ["retained message"],
            graphProgressRecords: records
          }
        }),
        lifecycle: () => {
          throw new Error("Progress must not invoke lifecycle reads");
        },
        now: () => 1000
      });
      expect(h.response.statusCode).toBe(200);
      expect(h.response.getHeader("Content-Type")).toBe("application/json");
      const record = records[expected];
      expect(JSON.parse(h.body())).toEqual({
        messages: ["retained message"],
        events: [],
        generation: record.graphProgressGeneration,
        active: record.graphProgressActive,
        view: expected,
        elapsedMs: 1000 - record.graphProgressStartedAtMs
      });
    } finally {
      h.close();
    }
  }
);
it("selects the latest completed read and never reports negative elapsed time", async () => {
  const h = graphRouteContext("/api/progress");
  const records = {
    graph: progress("graph", 2000, false),
    planned: progress("planned", 1500, false)
  };
  try {
    await handleProgress(h.context, {
      readInstanceEntry: () => ({ state: { graphProgressRecords: records } }),
      lifecycle: () => {
        throw new Error("Progress must not invoke lifecycle reads");
      },
      now: () => 1000
    });
    expect(JSON.parse(h.body())).toMatchObject({
      view: "graph",
      active: false,
      elapsedMs: 0
    });
  } finally {
    h.close();
  }
});
