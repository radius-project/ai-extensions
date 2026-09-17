import { expect, it } from "vitest";
import { graphHttpHarness } from "../../support/graph-http.js";
import { authoredResponse } from "../../support/canonical-graphs.js";

it.each(["load-graph", "plan-graph", "diff-branches"])(
  "preserves %s method ownership, malformed JSON and missing-state headers",
  async (route) => {
    const h = await graphHttpHarness();
    try {
      expect((await fetch(`${h.url}/api/${route}`)).status).toBe(404);
      const invalid = await fetch(`${h.url}/api/${route}`, {
        method: "POST",
        body: "{"
      });
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("content-type")).toContain("application/json");
      h.remove();
      const missing = await fetch(`${h.url}/api/${route}`, {
        method: "POST",
        body: "{}"
      });
      expect(missing.status).toBe(503);
      expect(missing.headers.get("content-type")).toBeNull();
      expect(h.lifecycle.execute).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  }
);
it("serializes successful canonical graph resources and provenance without publishing", async () => {
  const h = await graphHttpHarness();
  h.lifecycle.execute.mockResolvedValue(authoredResponse());
  try {
    const response = await fetch(`${h.url}/api/load-graph`, {
      method: "POST",
      body: JSON.stringify({ repo: "owner/repo", branch: "feature" })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resources: [{ id: "cache" }],
      provenance: { commit: "a".repeat(40) }
    });
    expect(h.lifecycle.resolveCommittedSource).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
