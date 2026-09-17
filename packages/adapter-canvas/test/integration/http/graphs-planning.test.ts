import { expect, it } from "vitest";
import { graphHttpHarness } from "../../support/graph-http.js";
import {
  authoredResponse,
  graphFailure
} from "../../support/canonical-graphs.js";

it("never infers a deployed graph from authored resources when deployed evidence is unavailable", async () => {
  const h = await graphHttpHarness();
  h.state.graphResources = [{ id: "authored-only" }];
  h.lifecycle.execute.mockResolvedValue(graphFailure());
  try {
    const response = await fetch(
      `${h.url}/api/deployed-graph?repo=owner/repo&environment=dev&application=app`
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      unavailable: true,
      reason: "RESULT_UNAVAILABLE",
      mode: "unavailable",
      deletionInventory: null
    });
    expect(h.lifecycle.execute).toHaveBeenCalledWith({
      operation: "graph.get",
      target: { repo: "owner/repo", environment: "dev", application: "app" },
      input: { kind: "deployed" }
    });
  } finally {
    await h.close();
  }
});
it("serializes a real deployed-kind result with its observation without relabeling authored evidence", async () => {
  const h = await graphHttpHarness();
  h.lifecycle.execute.mockResolvedValue({
    ...authoredResponse(),
    result: {
      ...authoredResponse().result,
      kind: "deployed",
      target: { repo: "owner/repo", environment: "dev", application: "app" }
    }
  });
  try {
    const response = await fetch(
      `${h.url}/api/deployed-graph?repo=owner/repo&environment=dev&application=app`
    );
    expect(await response.json()).toMatchObject({
      mode: "deployed",
      resources: [{ id: "cache" }],
      observation: { observedAt: "2026-09-15T00:00:00Z" }
    });
    const progress = await fetch(`${h.url}/api/progress`);
    expect(progress.status).toBe(200);
    expect(progress.headers.get("content-type")).toBe("application/json");
    expect(await progress.json()).toHaveProperty("messages");
  } finally {
    await h.close();
  }
});
