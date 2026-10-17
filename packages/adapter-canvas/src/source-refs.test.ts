import { describe, expect, it } from "vitest";
import {
  getSourceRefResources,
  prepareSourceRefResources,
  setSourceRefResources,
  updateSourceRefs,
  type SourceRefEntry
} from "./source-refs.js";
import type { CanvasGraphResource } from "./shared.js";

function entry(page = "graph"): SourceRefEntry {
  return { page, state: {} };
}

describe("source-code reference state", () => {
  it("creates natural context tokens for graph, planned, and diff views", () => {
    expect(
      prepareSourceRefResources(entry(), "graph", {
        repo: "acme/app",
        branch: "feature/source-refs"
      }).token
    ).toBe("graph|acme/app|feature/source-refs");
    expect(prepareSourceRefResources(entry(), "planned", {}).token).toBe(
      "planned||"
    );
    expect(
      prepareSourceRefResources(entry(), "diff", {
        repo: "acme/app",
        baseBranch: "main",
        headBranch: "feature/source-refs"
      }).token
    ).toBe("diff|acme/app|main...feature/source-refs");
    expect(prepareSourceRefResources(entry(), "diff", {}).token).toBe(
      "diff||..."
    );
  });

  it("rejects unknown graph views", () => {
    expect(() =>
      prepareSourceRefResources(entry(), "unknown", {
        repo: "acme/app",
        branch: "main"
      })
    ).toThrow("Unknown graph view");
    expect(() =>
      setSourceRefResources(entry(), "unknown", [], {
        repo: "acme/app",
        branch: "main"
      })
    ).toThrow("Unknown graph view");
  });

  it("uses the active graph view instead of a stale modeled graph", () => {
    const state = entry("planned");
    setSourceRefResources(
      state,
      "graph",
      [{ id: "old", type: "Radius.Compute/containers" }],
      {
        repo: "acme/old",
        branch: "main"
      }
    );
    setSourceRefResources(
      state,
      "planned",
      [{ id: "current", type: "Radius.Compute/containers" }],
      {
        repo: "acme/current",
        branch: "feature"
      }
    );
    state.state.activeGraphView = "planned";

    const result = getSourceRefResources(state);

    expect(result.context?.repo).toBe("acme/current");
    expect(result.resources.map((resource) => resource.id)).toEqual([
      "current"
    ]);
  });

  it("selects requested, page, active, and default view fallbacks", () => {
    const state = entry("graph-diff");
    setSourceRefResources(state, "graph", [{ id: "graph" }], {
      repo: "acme/app",
      branch: "main"
    });
    setSourceRefResources(state, "planned", [{ id: "planned" }], {
      repo: "acme/app",
      branch: "feature/source-refs"
    });
    setSourceRefResources(state, "diff", [{ id: "diff" }], {
      repo: "acme/app",
      baseBranch: "main",
      headBranch: "feature/source-refs"
    });

    expect(getSourceRefResources(state).resources[0]?.id).toBe("diff");
    state.page = "graphDiff";
    expect(getSourceRefResources(state).resources[0]?.id).toBe("diff");
    state.page = "graph";
    expect(getSourceRefResources(state).resources[0]?.id).toBe("graph");
    state.page = "other";
    state.state.activeGraphView = "planned";
    expect(getSourceRefResources(state).resources[0]?.id).toBe("planned");
    delete state.state.activeGraphView;
    expect(getSourceRefResources(state).resources[0]?.id).toBe("graph");
    expect(getSourceRefResources(state, "invalid")).toEqual({
      ready: false,
      view: "invalid",
      resources: []
    });
  });

  it("rejects stale context tokens and discards pending refs after a branch change", () => {
    const state = entry();
    setSourceRefResources(state, "graph", [], {
      repo: "acme/app",
      branch: "old"
    });
    const oldToken = getSourceRefResources(state, "graph").context?.token || "";
    expect(
      updateSourceRefs(state, oldToken, [
        { id: "db", codeReference: "src/old-db.js" }
      ]).queued
    ).toBe(1);

    setSourceRefResources(state, "graph", [], {
      repo: "acme/app",
      branch: "new"
    });

    expect(state.state.pendingSourceRefs).toEqual([]);
    expect(
      updateSourceRefs(state, oldToken, [
        { id: "db", codeReference: "src/old-db.js" }
      ]).error
    ).toContain("stale");
  });

  it("preserves current state and unrelated pending refs across context refreshes", () => {
    const state = entry();
    const context = { repo: "acme/app", branch: "main" };
    const current = prepareSourceRefResources(state, "graph", context);
    const resources: CanvasGraphResource[] = [{ id: "current" }];
    state.state.graphResources = resources;
    state.state.pendingSourceRefs = [
      {
        contextToken: current.token,
        id: "current",
        codeReference: "src/current.ts"
      },
      {
        contextToken: "planned|acme/app|feature",
        id: "planned",
        codeReference: "src/planned.ts"
      }
    ];

    prepareSourceRefResources(state, "graph", context);
    expect(state.state.graphResources).toBe(resources);
    expect(state.state.pendingSourceRefs).toHaveLength(2);

    prepareSourceRefResources(state, "graph", {
      repo: "acme/app",
      branch: "feature/source-refs"
    });
    expect(state.state.graphResources).toBeNull();
    expect(state.state.pendingSourceRefs).toEqual([
      {
        contextToken: "planned|acme/app|feature",
        id: "planned",
        codeReference: "src/planned.ts"
      }
    ]);
  });

  it("invalidates stale resources while a replacement graph is building", () => {
    const state = entry();
    setSourceRefResources(state, "graph", [{ id: "old" }], {
      repo: "acme/app",
      branch: "old"
    });

    prepareSourceRefResources(state, "graph", {
      repo: "acme/app",
      branch: "new"
    });

    expect(getSourceRefResources(state, "graph")).toMatchObject({
      ready: false,
      resources: []
    });
  });

  it("rejects results from a stale asynchronous build", () => {
    const state = entry();
    const oldBuild = prepareSourceRefResources(state, "graph", {
      repo: "acme/app",
      branch: "old"
    });
    prepareSourceRefResources(state, "graph", {
      repo: "acme/app",
      branch: "new"
    });

    const committed = setSourceRefResources(
      state,
      "graph",
      [{ id: "old" }],
      { repo: "acme/app", branch: "old" },
      oldBuild.token
    );

    expect(committed).toBe(false);
    expect(getSourceRefResources(state, "graph")).toMatchObject({
      ready: false,
      resources: []
    });
  });

  it("reports missing context and resources as not ready", () => {
    const state = entry();

    expect(getSourceRefResources(state)).toEqual({
      ready: false,
      view: "graph",
      resources: []
    });

    prepareSourceRefResources(state, "diff", {
      repo: "acme/app",
      baseBranch: "main",
      headBranch: "feature/source-refs"
    });
    expect(getSourceRefResources(state, "diff")).toEqual({
      ready: false,
      view: "diff",
      resources: []
    });
  });

  it("matches by stable resource ID when names and types collide", () => {
    const state = entry();
    const resources: CanvasGraphResource[] = [
      { id: "apps/a/db", name: "db", type: "Radius.Data/sqlDatabases" },
      { id: "apps/b/db", name: "db", type: "Radius.Data/sqlDatabases" }
    ];
    setSourceRefResources(state, "graph", resources, {
      repo: "acme/app",
      branch: "main"
    });
    const token = getSourceRefResources(state, "graph").context?.token || "";

    const result = updateSourceRefs(state, token, [
      { id: "apps/b/db", codeReference: "services/b/db.ts#L10" }
    ]);

    expect(result).toMatchObject({ updated: 1, queued: 0, skipped: 0 });
    expect(resources[0].codeReference).toBeUndefined();
    expect(resources[1].codeReference).toBe("services/b/db.ts#L10");
  });

  it("counts each submitted ref once and applies queued refs on rebuild", () => {
    const state = entry();
    const context = { repo: "acme/app", branch: "main" };
    setSourceRefResources(
      state,
      "graph",
      [{ id: "existing", codeReference: "src/existing.ts" }, { id: "ready" }],
      context
    );
    const token = getSourceRefResources(state, "graph").context?.token || "";

    const result = updateSourceRefs(state, token, [
      { id: "existing", codeReference: "src/replacement.ts" },
      { id: "ready", codeReference: "src/ready.ts" },
      { id: "later", codeReference: "src/later.ts" }
    ]);

    expect(result).toMatchObject({ updated: 1, queued: 1, skipped: 1 });

    const rebuilt: CanvasGraphResource[] = [{ id: "later" }];
    setSourceRefResources(state, "graph", rebuilt, context);
    expect(rebuilt[0].codeReference).toBe("src/later.ts");
    expect(state.state.pendingSourceRefs).toEqual([]);
  });

  it("preserves unrelated queued refs and existing code references on rebuild", () => {
    const state = entry();
    const context = { repo: "acme/app", branch: "main" };
    const sourceRefContext = prepareSourceRefResources(state, "graph", context);
    state.state.pendingSourceRefs = [
      {
        contextToken: "planned|acme/app|feature",
        id: "other",
        codeReference: "src/other.ts"
      },
      {
        contextToken: sourceRefContext.token,
        id: "existing",
        codeReference: "src/replacement.ts"
      },
      {
        contextToken: sourceRefContext.token,
        id: "missing",
        codeReference: "src/missing.ts"
      }
    ];
    const resources: CanvasGraphResource[] = [
      { id: "existing", codeReference: "src/original.ts" }
    ];

    expect(setSourceRefResources(state, "graph", resources, context)).toBe(
      true
    );

    expect(resources[0].codeReference).toBe("src/original.ts");
    expect(state.state.pendingSourceRefs).toEqual([
      {
        contextToken: "planned|acme/app|feature",
        id: "other",
        codeReference: "src/other.ts"
      }
    ]);
  });

  it("queues references while resources are unavailable", () => {
    const state = entry();
    const context = prepareSourceRefResources(state, "diff", {
      repo: "acme/app",
      baseBranch: "main",
      headBranch: "feature/source-refs"
    });

    expect(
      updateSourceRefs(state, context.token, [
        { id: "later", codeReference: "src/later.ts" }
      ])
    ).toEqual({
      updated: 0,
      queued: 1,
      skipped: 0,
      view: "diff"
    });
    expect(state.state.pendingSourceRefs).toEqual([
      {
        contextToken: context.token,
        id: "later",
        codeReference: "src/later.ts"
      }
    ]);
  });

  it("returns a deterministic error for unknown context state", () => {
    const state = entry();

    expect(
      updateSourceRefs(state, "graph|acme/app|stale", [
        { id: "one", codeReference: "src/one.ts" },
        { id: "two", codeReference: "src/two.ts" }
      ])
    ).toEqual({
      error: "Graph context is stale or unknown. Fetch graph resources again.",
      updated: 0,
      queued: 0,
      skipped: 2
    });
  });

  it("replaces an already queued reference for the same context and resource", () => {
    const state = entry();
    setSourceRefResources(state, "graph", [], {
      repo: "acme/app",
      branch: "main"
    });
    const token = getSourceRefResources(state, "graph").context?.token || "";

    updateSourceRefs(state, token, [
      { id: "later", codeReference: "src/old.ts" }
    ]);
    const result = updateSourceRefs(state, token, [
      { id: "later", codeReference: "src/new.ts" }
    ]);

    expect(result).toMatchObject({ updated: 0, queued: 1, skipped: 0 });
    expect(state.state.pendingSourceRefs).toEqual([
      {
        contextToken: token,
        id: "later",
        codeReference: "src/new.ts"
      }
    ]);
  });
});
