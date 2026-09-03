import { describe, expect, it, vi } from "vitest";
import {
  RadProcessError,
  stampAppGraphJson
} from "@radius-project/adapter-shared";
import { createRadiusCanvas } from "./create-radius-canvas.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";
import type { CanvasGraphResource } from "../shared.js";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "../graph-progress-contract.js";

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
    expect(state.contextBranchSource).toBe("workspace");
  });

  it("uses an explicit remote branch of the workspace repository", async () => {
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/ws",
        repo: "acme/widgets",
        branch: "feature/x"
      }
    });
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "release"
      })
    );
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.contextRepo).toBe("acme/widgets");
    expect(state.contextBranch).toBe("release");
    expect(state.contextBranchSource).toBe("explicit");
  });

  it("uses an explicit branch with the workspace repository when repo is omitted", async () => {
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/ws",
        repo: "acme/widgets",
        branch: "feature/x"
      }
    });
    await canvas.open(
      ctx("radius-panel", { page: "graph", branch: "release" })
    );
    const state = deps.servers.get("radius-panel")!.state;
    expect(state.contextRepo).toBe("acme/widgets");
    expect(state.contextBranch).toBe("release");
    expect(state.contextBranchSource).toBe("explicit");
  });

  it("preserves explicit branch intent when reopening another page without context input", async () => {
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/ws",
        repo: "acme/widgets",
        branch: "feature/x"
      }
    });
    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: "release"
      })
    );

    await canvas.open(ctx("radius-panel", { page: "planned" }));

    const state = deps.servers.get("radius-panel")!.state;
    expect(state.contextBranch).toBe("release");
    expect(state.contextBranchSource).toBe("explicit");
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
    expect(state.contextBranchSource).toBe("explicit");

    await canvas.open(
      ctx("radius-panel", {
        page: "graph",
        repo: "other/repo",
        branch: "dev"
      })
    );
    state = deps.servers.get("radius-panel")!.state;
    expect(state.contextBranch).toBe("dev");
    expect(state.contextBranchSource).toBe("explicit");
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

  it("auto-compares committed branch graph artifacts without invoking rad", async () => {
    const bicep = "resource db 'Radius.Data/redis@2023-10-01-preview' = {}";
    const graph = stampAppGraphJson(
      '{"resources":[{"id":"1","name":"db","type":"Radius.Data/redis"}]}',
      bicep
    );
    const { canvas, deps } = setup({
      workspaceContext: {
        workspacePath: "/workspace",
        repo: "acme/widgets",
        branch: "work"
      },
      bicepByRepoBranch: {
        "remote:acme/widgets@main": bicep,
        "remote:acme/widgets@feat": bicep
      },
      filesByRepoBranch: {
        "remote:acme/widgets@main:.radius/app-graph.json": graph,
        "remote:acme/widgets@feat:.radius/app-graph.json": graph
      }
    });

    await canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feat"
      })
    );

    expect(deps.servers.get("radius-panel")!.state.diffNoChanges).toBe(true);
    expect(deps.rad.buildGraphViaRad).not.toHaveBeenCalled();
    expect(deps.rad.radArtifactsDirForSelection).not.toHaveBeenCalled();
  });

  it("records a graph-diff failure for the current comparison", async () => {
    const { canvas, deps, sessionHolder } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("rad app graph failed", {
        cause: new RadProcessError(
          "rad exited with code 1",
          "BCP035: invalid model",
          ""
        )
      })
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
      GRAPH_MODELING_FAILURE_MESSAGE
    );
    expect(deps.logError).toHaveBeenCalledWith(
      "[radius graph] modeling failed for acme/widgets@main...feat: BCP035: invalid model"
    );
    expect(deps.servers.get("radius-panel")!.state.diffModelingFailed).toBe(
      true
    );
    const sent = vi.mocked(sessionHolder.get().send).mock.calls[0]?.[0] as {
      prompt: string;
      displayPrompt: string;
    };
    expect(sent.prompt).toContain("BCP035: invalid model");
    expect(sent.prompt).toContain("attempt 1 of 3");
    expect(sent.displayPrompt).not.toContain("BCP035");
  });

  it("preserves the compile failure when the Agent handoff cannot be delivered", async () => {
    const { canvas, deps, sessionHolder } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    vi.mocked(sessionHolder.get().send).mockRejectedValue(
      new Error("session unavailable")
    );
    vi.mocked(deps.rad.buildGraphViaRad).mockRejectedValue(
      new Error("rad app graph failed", {
        cause: new RadProcessError(
          "rad exited with code 1",
          "BCP035: invalid model",
          ""
        )
      })
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
      GRAPH_MODELING_FAILURE_MESSAGE
    );
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining("session unavailable")
    );
  });

  it("preserves a graph-diff toolchain failure without Bicep diagnostics", async () => {
    const { canvas, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new RadProcessError(
        "managed Bicep download failed",
        "",
        "connection refused"
      )
    );
    const entry = await deps.getOrCreateServer("radius-panel", "graph-diff");
    entry.state.diffModelingFailed = true;

    await canvas.open(
      ctx("radius-panel", {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feat"
      })
    );

    expect(deps.servers.get("radius-panel")!.state.diffError).toBe(
      "managed Bicep download failed"
    );
    expect(deps.logError).not.toHaveBeenCalled();
    expect(entry.state.diffModelingFailed).toBeUndefined();
  });

  it("only records a diff error for the CURRENT diff request (stale responses are ignored)", async () => {
    const { canvas, deps, sessionHolder } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}",
        "remote:acme/widgets@other": "resource db {}"
      }
    });
    // First compare fails...
    (
      deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(
      new Error("rad app graph failed", {
        cause: new RadProcessError(
          "rad exited with code 1",
          "BCP035: stale invalid model",
          ""
        )
      })
    );
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
    expect(sessionHolder.get().send).not.toHaveBeenCalled();
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

// RU-16 moved: opening the canvas no longer inspects the application model.
// runtime/app-model-handoff.test.ts owns that behavior now, and the graph
// HTTP routes are what invoke it.

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

  it("rejects a second Radius instance while the existing panel is live", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("panel-a", { page: "graph" }));
    await expect(
      canvas.open(ctx("panel-b", { page: "graph" }))
    ).rejects.toThrow(/panel-a is already open/);
    expect(deps.servers.has("panel-a")).toBe(true);
    expect(deps.servers.has("panel-b")).toBe(false);
  });

  it("allows a new instance after the authoritative panel closes", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("panel-a", { page: "graph" }));
    await canvas.onClose(ctx("panel-a"));

    await canvas.open(ctx("panel-b", { page: "planned" }));
    expect(deps.servers.has("panel-b")).toBe(true);
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

  it("ignores a close notification for a different instance", async () => {
    const { canvas, deps } = setup();
    await canvas.open(ctx("panel-a", { page: "graph" }));
    await canvas.onClose(ctx("panel-b"));
    expect(deps.servers.has("panel-a")).toBe(true);
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

  it("does not defer the live instance for stale work attributed to another id", async () => {
    const { canvas, deps } = setup();
    vi.mocked(deps.operations.hasActiveEnvironmentTasks).mockImplementation(
      (instanceId) => instanceId === "panel-b"
    );
    await canvas.open(ctx("panel-a", { page: "environment" }));
    const panelA = deps.servers.get("panel-a")!;
    const closeSpy = panelA.server.close as unknown as ReturnType<typeof vi.fn>;

    await canvas.onClose(ctx("panel-a"));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(deps.operations.onEnvironmentTasksSettled).not.toHaveBeenCalled();
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
