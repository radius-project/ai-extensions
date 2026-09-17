import { expect, it } from "vitest";
import { graphHttpHarness } from "../../support/graph-http.js";
import {
  authoredResponse,
  graphFailure
} from "../../support/canonical-graphs.js";

it.each([
  "available",
  "unavailable",
  "external-failure",
  "superseded"
] as const)(
  "ends %s graph streams exactly once with retained framing",
  async (status) => {
    const h = await graphHttpHarness();
    h.lifecycle.execute.mockResolvedValue(
      status === "available" ? authoredResponse() : (
        graphFailure(
          status === "unavailable" ? "DEFINITION_NOT_FOUND" : "FORBIDDEN"
        )
      )
    );
    if (status === "superseded")
      h.lifecycle.execute.mockImplementation(async () => {
        h.state.contextBranch = "changed";
        return authoredResponse();
      });
    try {
      const response = await fetch(
        `${h.url}/api/load-graph-stream?repo=owner/repo&branch=feature`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("connection")).toBe("keep-alive");
      const frames = (await response.text()).trim().split("\n\n");
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatch(/^event: progress\ndata: /);
      expect(frames[1]).toMatch(/^event: done\ndata: /);
      expect(JSON.parse(frames[1].split("data: ")[1])).toMatchObject(
        status === "available" ?
          { resources: [{ id: "cache" }], resolvedBranch: "feature" }
        : status === "superseded" ? { stale: true }
        : {
            unavailable: true,
            reason:
              status === "unavailable" ? "DEFINITION_NOT_FOUND" : "FORBIDDEN"
          }
      );
    } finally {
      await h.close();
    }
  }
);
it("keeps the missing-instance plain-text 503 before stream headers", async () => {
  const h = await graphHttpHarness();
  h.remove();
  try {
    const response = await fetch(
      `${h.url}/api/load-graph-stream?repo=owner/repo`
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("Canvas server state is unavailable.");
  } finally {
    await h.close();
  }
});
