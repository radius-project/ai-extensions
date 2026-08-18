import { describe, expect, it, vi } from "vitest";
import { createRadiusCanvas } from "./create-radius-canvas.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";
import type { CanvasGraphResource } from "../shared.js";

interface CanvasContext {
  extensionId: string;
  canvasId: string;
  instanceId: string;
  input?: Record<string, unknown>;
}

function ctx(
  instanceId: string,
  input?: Record<string, unknown>
): CanvasContext {
  return {
    extensionId: "plugin:radius",
    canvasId: "radius",
    instanceId,
    input
  };
}

function findAction(
  canvas: ReturnType<typeof createRadiusCanvas>,
  name: string
): { handler: (ctx: CanvasContext) => Promise<any> } {
  const action = canvas.actions.find((a) => a.name === name);
  if (!action) throw new Error(`action ${name} not found`);
  return action as unknown as {
    handler: (ctx: CanvasContext) => Promise<any>;
  };
}

function setup(options?: Parameters<typeof createFakeDependencies>[0]) {
  const fake = createFakeDependencies(options);
  fake.sessionHolder.set(createFakeSession());
  const canvas = createRadiusCanvas(fake.deps);
  return { ...fake, canvas };
}

async function seedGraph(
  deps: ReturnType<typeof setup>["deps"],
  resources: CanvasGraphResource[],
  view: "graph" | "diff" = "graph"
) {
  const entry = await deps.getOrCreateServer(
    "radius-panel",
    view === "diff" ? "graph-diff" : "graph"
  );
  deps.sourceRefs.setSourceRefResources(
    entry,
    view,
    resources,
    view === "diff" ?
      {
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feat"
      }
    : { repo: "acme/widgets", branch: "main" }
  );
  entry.state.activeGraphView = view;
}

// RU-05: get_graph_resources full behavior.
describe("RU-05: get_graph_resources", () => {
  it("reports ready:false before the graph has been built", async () => {
    const { canvas } = setup();
    const result = await findAction(canvas, "get_graph_resources").handler(
      ctx("radius-panel")
    );
    expect(result).toEqual({
      ready: false,
      resources: [],
      message:
        "Graph has not been built yet. Open the graph page and wait for it to load, then try again."
    });
  });

  it("reports unavailable context instead of returning unpinned resources", async () => {
    const { canvas, deps } = setup();
    deps.sourceRefs.getSourceRefResources = vi.fn(() => ({
      ready: true,
      view: "graph",
      resources: [],
      context: undefined
    })) as typeof deps.sourceRefs.getSourceRefResources;

    const result = await findAction(canvas, "get_graph_resources").handler(
      ctx("radius-panel")
    );

    expect(result).toEqual({
      ready: false,
      resources: [],
      message: "Graph context is unavailable."
    });
  });

  it("defaults to missingOnly=true, excluding resources with a codeReference or an applications-family type", async () => {
    const { canvas, deps } = setup();
    await seedGraph(deps, [
      { id: "1", name: "db", type: "Radius.Data/redis" },
      {
        id: "2",
        name: "already-ref",
        type: "Radius.Data/redis",
        codeReference: "src/db.js#L1"
      },
      {
        id: "3",
        name: "app",
        type: "Applications.Core/containers"
      }
    ]);
    const result = await findAction(canvas, "get_graph_resources").handler(
      ctx("radius-panel")
    );
    expect(result.ready).toBe(true);
    expect(result.resources.map((r: { id: string }) => r.id)).toEqual(["1"]);
  });

  it("returns all resources when missingOnly is false", async () => {
    const { canvas, deps } = setup();
    await seedGraph(deps, [
      { id: "1", name: "db", type: "Radius.Data/redis" },
      {
        id: "2",
        name: "ref'd",
        type: "Radius.Data/redis",
        codeReference: "src/db.js#L1"
      }
    ]);
    const result = await findAction(canvas, "get_graph_resources").handler(
      ctx("radius-panel", { missingOnly: false })
    );
    expect(result.resources).toHaveLength(2);
  });

  it("includes the context token/repo/branch so update_source_refs can be pinned to this exact context", async () => {
    const { canvas, deps } = setup();
    await seedGraph(deps, [{ id: "1", name: "db", type: "x" }]);
    const result = await findAction(canvas, "get_graph_resources").handler(
      ctx("radius-panel")
    );
    expect(result.view).toBe("graph");
    expect(typeof result.contextToken).toBe("string");
    expect(result.contextToken.length).toBeGreaterThan(0);
  });
});

// RU-06: update_source_refs validation/stale/update/queue/skip/page/reload.
describe("RU-06: update_source_refs", () => {
  it("errors when contextToken is missing", async () => {
    const { canvas } = setup();
    const result = await findAction(canvas, "update_source_refs").handler(
      ctx("radius-panel", { refs: [{ id: "1", codeReference: "a.js#L1" }] })
    );
    expect(result).toEqual({
      error: "contextToken is required",
      updated: 0,
      queued: 0,
      skipped: 0
    });
  });

  it("errors when refs is missing or empty", async () => {
    const { canvas } = setup();
    const result = await findAction(canvas, "update_source_refs").handler(
      ctx("radius-panel", { contextToken: "tok", refs: [] })
    );
    expect(result.error).toBe("refs array is required");
  });

  it("errors on a stale/unknown contextToken", async () => {
    const { canvas, deps } = setup();
    await seedGraph(deps, [{ id: "1", name: "db", type: "x" }]);
    const result = await findAction(canvas, "update_source_refs").handler(
      ctx("radius-panel", {
        contextToken: "not-a-real-token",
        refs: [{ id: "1", codeReference: "a.js#L1" }]
      })
    );
    expect(result.error).toMatch(/stale or unknown/i);
  });

  it("updates a resource that exists in the current graph, skips one that already has a codeReference, and queues one that isn't in the graph yet", async () => {
    const { canvas, deps } = setup();
    await seedGraph(deps, [
      { id: "1", name: "db", type: "x" },
      {
        id: "2",
        name: "already",
        type: "x",
        codeReference: "old.js#L1"
      }
    ]);
    const { contextToken } = await findAction(
      canvas,
      "get_graph_resources"
    ).handler(ctx("radius-panel"));

    const result = await findAction(canvas, "update_source_refs").handler(
      ctx("radius-panel", {
        contextToken,
        refs: [
          { id: "1", codeReference: "new.js#L5" },
          { id: "2", codeReference: "ignored.js#L1" },
          { id: "3", codeReference: "future.js#L1" }
        ]
      })
    );
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.queued).toBe(1);
    expect(result.message).toContain(
      "Updated 1 resource(s); queued 1; skipped 1."
    );
    // Reflected in the underlying entry state too.
    const entry = deps.servers.get("radius-panel")!;
    expect(
      entry.state.graphResources?.find((r) => r.id === "1")?.codeReference
    ).toBe("new.js#L5");
  });

  it("maps the diff view to the graph-diff page and reloads the same canvas instance", async () => {
    const { canvas, deps } = setup();
    await seedGraph(
      deps,
      [{ id: "1", name: "db", type: "x", diffStatus: "unchanged" }],
      "diff"
    );
    const { contextToken } = await findAction(
      canvas,
      "get_graph_resources"
    ).handler(ctx("radius-panel", { view: "diff" }));

    const result = await findAction(canvas, "update_source_refs").handler(
      ctx("radius-panel", {
        contextToken,
        refs: [{ id: "1", codeReference: "new.js#L5" }]
      })
    );
    expect(result.url).toContain("page=graph-diff");
    const session = deps.session.get();
    expect(session.rpc.canvas.open).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "radius-panel",
        input: { page: "graph-diff" }
      })
    );
  });
});

// RU-13: every page renders, the default page, open()'s returned state/title/URL.
describe("RU-13: canvas open() — every page/default/state/title/URL", () => {
  const pages = [
    "credentials",
    "graph",
    "planned",
    "graph-diff",
    "deployed",
    "environment",
    "deploying"
  ];

  it.each(pages)(
    "opens the %s page with a title and matching url",
    async (page) => {
      const { canvas } = setup();
      const result = await canvas.open(ctx("radius-panel", { page }));
      expect(result.title).toBe("Radius");
      expect(result.url).toContain(`page=${page}`);
    }
  );

  it("defaults to the graph page when no page is given", async () => {
    const { canvas, deps } = setup();
    const result = await canvas.open(ctx("radius-panel"));
    expect(result.url).toContain("page=graph");
    expect(deps.servers.get("radius-panel")!.page).toBe("graph");
  });

  it("sets activeGraphView for graph/planned/graph-diff but leaves it alone for other pages", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("radius-panel", { page: "graph" }));
    expect(deps.servers.get("radius-panel")!.state.activeGraphView).toBe(
      "graph"
    );
    await canvas.open(ctx("radius-panel", { page: "environment" }));
    // Unrelated page: the previously-set graph view is left untouched.
    expect(deps.servers.get("radius-panel")!.state.activeGraphView).toBe(
      "graph"
    );
  });

  it("merges the detected workspace context into the entry state on open", async () => {
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/ws",
        repo: "acme/widgets",
        branch: "trunk"
      }
    });
    await canvas.open(ctx("radius-panel", { page: "graph" }));
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.workspaceRepo).toBe("acme/widgets");
    expect(state.workspaceBranch).toBe("trunk");
  });
});

// RU-14: workspace repo/branch resolution, including the different-repo
// fallback and git-remote detection when no repo is supplied at all.
describe("RU-14: workspace repo/branch resolution on open()", () => {
  it("uses the workspace branch when the input repo matches the workspace repo", async () => {
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/ws",
        repo: "acme/widgets",
        branch: "feature/x"
      }
    });
    await canvas.open(
      ctx("radius-panel", { page: "graph", repo: "acme/widgets" })
    );
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.contextRepo).toBe("acme/widgets");
    expect(state.contextBranch).toBe("feature/x");
  });

  it("falls back to the given branch (or main) for a different repo", async () => {
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/ws",
        repo: "acme/widgets",
        branch: "feature/x"
      }
    });
    await canvas.open(
      ctx("radius-panel", { page: "graph", repo: "other/repo" })
    );
    let state = deps.servers.get("radius-panel")!.state;
    expect(state.contextRepo).toBe("other/repo");
    expect(state.contextBranch).toBe("main");

    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "other/repo",
        branch: "dev"
      })
    );
    state = deps.servers.get("radius-panel")!.state;
    expect(state.contextBranch).toBe("dev");
  });

  it("detects the repo from the git remote when no repo is given and none is set yet", async () => {
    const { canvas, deps } = setup({
      workspaceContext: { workspacePath: "/workspace", repo: "", branch: "" }
    });
    (deps.process.execFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stdout: "git@github.com:acme/widgets.git\n",
      stderr: ""
    });
    await canvas.open(ctx("radius-panel", { page: "graph" }));
    expect(deps.process.execFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/workspace", "remote", "get-url", "origin"],
      expect.objectContaining({ timeout: 5000 })
    );
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.contextRepo).toBe("acme/widgets");
  });

  it("does not attempt git-remote detection once a contextRepo is already set", async () => {
    const { canvas, deps } = setup();
    await canvas.open(
      ctx("radius-panel", { page: "graph", repo: "acme/widgets" })
    );
    (deps.process.execFile as ReturnType<typeof vi.fn>).mockClear();
    await canvas.open(ctx("radius-panel", { page: "graph" }));
    expect(deps.process.execFile).not.toHaveBeenCalled();
  });
});

// RU-15: graph/planned bicep resolution + the graph-diff auto-compare preload.
describe("RU-15: graph-diff preload + graph/planned source-ref preparation", () => {
  it("prepares source-ref resources for graph and planned pages using the context repo/branch", async () => {
    const { canvas, deps } = setup();
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "main"
      })
    );
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.sourceRefContexts?.graph).toBeDefined();
    expect(state.sourceRefContexts?.graph?.repo).toBe("acme/widgets");
  });

  it("auto-compares base/head branches on a graph-diff open and reports no changes when identical", async () => {
    const bicep = "resource db 'Radius.Data/redis@2023-10-01-preview' = {}";
    const { canvas, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": bicep,
        "remote:acme/widgets@feat": bicep
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "1", name: "db", type: "Radius.Data/redis" }
    ]);
    const session = deps.session.get();
    session.log = vi.fn(() => {
      throw new Error("log unavailable");
    });
    (
      deps.rad.radArtifactsDirForSelection as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ log }) => {
      log("building graph");
      return { dir: "/workspace/.radius", remote: false };
    });
    await canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feat"
      })
    );
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.diffNoChanges).toBe(true);
    expect(state.diffError).toBeUndefined();
    expect(session.log).toHaveBeenCalledWith("building graph");
  });

  it("records a graph-diff failure for the current comparison", async () => {
    const { canvas, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("graph compilation failed")
    );

    await canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feat"
      })
    );

    expect(deps.servers.get("radius-panel")!.state.diffError).toBe(
      "graph compilation failed"
    );
  });

  it("only records a diff error for the CURRENT diff request (stale responses are ignored)", async () => {
    const { canvas, deps } = setup();
    // First compare fails...
    (
      deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("boom"));
    const firstOpen = canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feat"
      })
    );
    // ...but a second compare (different heads) starts and succeeds before the
    // first one's rejection is observed, changing the live context token.
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockResolvedValue(
      []
    );
    await canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "other"
      })
    );
    await firstOpen;
    // The stale failure must not have clobbered the current (successful) state.
    expect(deps.servers.get("radius-panel")!.state.diffError).toBeUndefined();
  });

  it("does not let a late graph result mutate the same instance after deferred close and reopen", async () => {
    let releaseFirst: (() => void) | undefined;
    let settled: (() => void) | undefined;
    const firstResult = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { canvas, deps } = setup();
    vi.mocked(deps.operations.hasActiveEnvironmentTasks).mockReturnValue(true);
    vi.mocked(deps.operations.onEnvironmentTasksSettled).mockImplementation(
      (_instanceId, listener) => {
        settled = listener;
        return vi.fn();
      }
    );
    const buildGraph = deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>;
    buildGraph
      .mockImplementationOnce(async () => {
        await firstResult;
        return [{ id: "stale", name: "old", type: "old" }];
      })
      .mockResolvedValue([{ id: "current", name: "new", type: "new" }]);

    const firstOpen = canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "old"
      })
    );
    await vi.waitFor(() => expect(buildGraph).toHaveBeenCalledTimes(1));
    const entry = deps.servers.get("radius-panel");
    await canvas.onClose(ctx("radius-panel"));

    await canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "new"
      })
    );
    expect(deps.servers.get("radius-panel")).toBe(entry);
    expect(settled).toBeDefined();
    settled?.();
    releaseFirst?.();
    await firstOpen;

    const state = deps.servers.get("radius-panel")!.state;
    expect(state.diffHead).toBe("new");
    expect(
      state.diffResources?.map((resource) => resource.id) ?? []
    ).not.toContain("stale");
  });
});

// RU-16: missing-bicep handoff dedupe + nonblocking behavior.
describe("RU-16: missing app.bicep handoff on open()", () => {
  it("hands off to the agent exactly once for the same repo+branch, and again for a different target", async () => {
    const { canvas, deps } = setup();
    const session = deps.session.get();
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "main"
      })
    );
    expect(session.send).toHaveBeenCalledTimes(1);

    // Re-opening the SAME target does not re-send.
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "main"
      })
    );
    expect(session.send).toHaveBeenCalledTimes(1);

    // A different branch is a different target: sends again.
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "other"
      })
    );
    expect(session.send).toHaveBeenCalledTimes(2);
  });

  it("does not hand off when app.bicep already exists on the branch", async () => {
    const { canvas, deps } = setup({
      bicepByRepoBranch: { "remote:acme/widgets@main": "resource db {}" }
    });
    const session = deps.session.get();
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "main"
      })
    );
    expect(session.send).not.toHaveBeenCalled();
  });

  it("hands off when checking app.bicep fails", async () => {
    const { canvas, deps } = setup();
    const session = deps.session.get();
    (
      deps.core.fetchBicepFromRepo as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("contents unavailable"));

    await expect(
      canvas.open(
        ctx("radius-panel", {
          page: "graph",
          repo: "other/repo",
          branch: "main"
        })
      )
    ).resolves.toMatchObject({ title: "Radius" });

    expect(session.send).toHaveBeenCalledOnce();
  });

  it("never blocks or fails canvas open when session.send throws", async () => {
    const { canvas, deps } = setup();
    const session = deps.session.get();
    (session.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("host unavailable")
    );
    await expect(
      canvas.open(
        ctx("radius-panel", {
          page: "graph",
          repo: "acme/widgets",
          branch: "main"
        })
      )
    ).resolves.toMatchObject({ title: "Radius" });
  });

  it("does not hand off on non-graph pages", async () => {
    const { canvas, deps } = setup();
    const session = deps.session.get();
    await canvas.open(
      ctx("radius-panel", { page: "environment", repo: "acme/widgets" })
    );
    expect(session.send).not.toHaveBeenCalled();
  });
});

// RU-17: same-instance reuse vs. distinct instances.
describe("RU-17: canvas instance reuse", () => {
  it("reuses the same server entry for the same instanceId across pages", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("radius-panel", { page: "graph" }));
    const first = deps.servers.get("radius-panel");
    await canvas.open(ctx("radius-panel", { page: "planned" }));
    const second = deps.servers.get("radius-panel");
    expect(second).toBe(first);
    expect(second!.page).toBe("planned");
  });

  it("creates distinct entries for distinct instanceIds", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("panel-a", { page: "graph" }));
    await canvas.open(ctx("panel-b", { page: "graph" }));
    expect(deps.servers.get("panel-a")).not.toBe(deps.servers.get("panel-b"));
    expect(deps.servers.size).toBe(2);
  });
});

// RU-18 (canvas half): onClose closes exactly once per instance.
describe("RU-18: onClose closes the underlying server exactly once", () => {
  it("closes the server on first onClose and is a no-op on a duplicate call", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("radius-panel", { page: "graph" }));
    const entry = deps.servers.get("radius-panel")!;
    const closeSpy = entry.server.close as unknown as ReturnType<typeof vi.fn>;

    await canvas.onClose(ctx("radius-panel"));
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(deps.servers.has("radius-panel")).toBe(false);

    // Second onClose for the same (now-removed) instance must not close again.
    await canvas.onClose(ctx("radius-panel"));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closing one instance does not affect another", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("panel-a", { page: "graph" }));
    await canvas.open(ctx("panel-b", { page: "graph" }));
    await canvas.onClose(ctx("panel-a"));
    expect(deps.servers.has("panel-a")).toBe(false);
    expect(deps.servers.has("panel-b")).toBe(true);
  });

  it("defers close until the last server-owned environment task settles", async () => {
    const { canvas, deps } = setup();
    let settled: (() => void) | undefined;
    vi.mocked(deps.operations.hasActiveEnvironmentTasks).mockReturnValue(true);
    vi.mocked(deps.operations.onEnvironmentTasksSettled).mockImplementation(
      (_instanceId, listener) => {
        settled = listener;
        return vi.fn();
      }
    );
    await canvas.open(ctx("radius-panel", { page: "environment" }));
    const entry = deps.servers.get("radius-panel")!;
    const closeSpy = entry.server.close as unknown as ReturnType<typeof vi.fn>;

    await canvas.onClose(ctx("radius-panel"));
    expect(deps.operations.hasActiveEnvironmentTasks).toHaveBeenCalledWith(
      "radius-panel"
    );
    expect(deps.operations.onEnvironmentTasksSettled).toHaveBeenCalledWith(
      "radius-panel",
      expect.any(Function)
    );
    expect(closeSpy).not.toHaveBeenCalled();
    expect(deps.servers.has("radius-panel")).toBe(true);

    settled?.();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(deps.servers.has("radius-panel")).toBe(false);
  });

  it("cancels a deferred close when the same instance reopens", async () => {
    const { canvas, deps } = setup();
    let settled: (() => void) | undefined;
    vi.mocked(deps.operations.hasActiveEnvironmentTasks).mockReturnValue(true);
    vi.mocked(deps.operations.onEnvironmentTasksSettled).mockImplementation(
      (_instanceId, listener) => {
        settled = listener;
        return vi.fn();
      }
    );
    await canvas.open(ctx("radius-panel", { page: "environment" }));
    const entry = deps.servers.get("radius-panel")!;
    const closeSpy = entry.server.close as unknown as ReturnType<typeof vi.fn>;

    await canvas.onClose(ctx("radius-panel"));
    await canvas.open(ctx("radius-panel", { page: "environment" }));
    settled?.();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(deps.servers.get("radius-panel")).toBe(entry);
  });

  it("does not defer one instance for another instance's active work", async () => {
    const { canvas, deps } = setup();
    vi.mocked(deps.operations.hasActiveEnvironmentTasks).mockImplementation(
      (instanceId) => instanceId === "panel-b"
    );
    await canvas.open(ctx("panel-a", { page: "environment" }));
    await canvas.open(ctx("panel-b", { page: "environment" }));
    const panelA = deps.servers.get("panel-a")!;
    const closeSpy = panelA.server.close as unknown as ReturnType<typeof vi.fn>;

    await canvas.onClose(ctx("panel-a"));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(deps.operations.onEnvironmentTasksSettled).not.toHaveBeenCalled();
    expect(deps.servers.has("panel-b")).toBe(true);
  });

  it("force-closes a deferred server after the supported operation lifetime", async () => {
    vi.useFakeTimers();
    try {
      const { canvas, deps } = setup();
      const stopListening = vi.fn();
      vi.mocked(deps.operations.hasActiveEnvironmentTasks).mockReturnValue(
        true
      );
      vi.mocked(deps.operations.onEnvironmentTasksSettled).mockReturnValue(
        stopListening
      );
      await canvas.open(ctx("radius-panel", { page: "environment" }));
      const entry = deps.servers.get("radius-panel")!;
      const closeSpy = entry.server.close as unknown as ReturnType<
        typeof vi.fn
      >;

      await canvas.onClose(ctx("radius-panel"));
      await vi.advanceTimersByTimeAsync(46 * 60 * 1000);

      expect(stopListening).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(deps.servers.has("radius-panel")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
