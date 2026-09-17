import { expect, it, vi } from "vitest";
import { graphRouteContext } from "../../../test/support/graph-route.js";
import { handleLoadGraphStream } from "./graphs-planning.js";
import type { GraphPlanningWorkflows } from "./graph-workflows.js";

it("forwards selected branch context and serializes the canonical terminal result", async () => {
  const h = graphRouteContext(
    "/api/load-graph-stream?repo=owner/repo&branch=feature&followWorkspaceBranch=true"
  );
  const loadGraph = vi.fn<GraphPlanningWorkflows["loadGraph"]>(async () => ({
    kind: "json",
    status: 200,
    payload: { branch: "feature", resources: [] }
  }));
  try {
    await handleLoadGraphStream(h.context, {
      readInstanceEntry: () => ({ state: {} }),
      workflows: { loadGraph }
    });
    expect(JSON.parse(loadGraph.mock.calls[0][0].body)).toEqual({
      repo: "owner/repo",
      branch: "feature",
      followWorkspaceBranch: true,
      refresh: true
    });
    expect(h.response.getHeader("Content-Type")).toBe("text/event-stream");
    expect(h.body()).toContain('"resolvedBranch":"feature"');
    expect(h.end).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
  }
});
it("emits one terminal unavailable frame if the workflow rejects after headers", async () => {
  const h = graphRouteContext("/api/load-graph-stream");
  try {
    await handleLoadGraphStream(h.context, {
      readInstanceEntry: () => ({ state: {} }),
      workflows: {
        loadGraph: async () => {
          throw new Error("private diagnostic");
        }
      }
    });
    expect(h.body()).toContain("event: done\ndata: ");
    expect(h.body()).toContain('"unavailable":true');
    expect(h.body()).not.toContain("private diagnostic");
    expect(h.end).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
  }
});
it("rejects an absent instance without opening a stream or calling a workflow", async () => {
  const h = graphRouteContext("/api/load-graph-stream");
  const loadGraph = vi.fn<GraphPlanningWorkflows["loadGraph"]>(async () => {
    throw new Error("unexpected");
  });
  try {
    await handleLoadGraphStream(h.context, {
      readInstanceEntry: () => undefined,
      workflows: { loadGraph }
    });
    expect(h.response.statusCode).toBe(503);
    expect(h.response.getHeader("Content-Type")).toBeUndefined();
    expect(loadGraph).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
  }
});
