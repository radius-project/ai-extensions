import { createServer } from "node:http";
import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createGraphPlanningWorkflows } from "../../../src/server/routes/graph-workflows.js";
import { createGraphsPlanningWritesRoutes } from "../../../src/server/routes/graphs-planning-writes.js";
import { createGraphsPlanningStreamRoutes } from "../../../src/server/routes/graphs-planning.js";
import { createLivenessSourceRoutes } from "../../../src/server/routes/liveness-source.js";
import { readWorkspaceGraphRevision } from "../../../src/runtime/graph-reader.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "../../../src/source-refs.js";
import {
  commitWorkspaceBranchResolution,
  resolveGraphBranchForRequest
} from "../../../src/workspace.js";
import {
  addGraphProgress,
  beginPlannedGraphRequest,
  isCurrentPlannedGraphRequest,
  isCurrentSourceRefToken
} from "../../../src/server.js";
import type { CanvasState } from "../../../src/shared.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  createGraphBoundaryFixture,
  graphBranch,
  graphDefinition,
  graphInputs
} from "../../support/lifecycle-graphs.js";

const registeredEnvironment: Parameters<typeof createGraphBoundaryFixture>[0] =
  {
    registrations: async (_scope, target) => {
      if (target.repo !== "owner/repo" || target.environment !== "dev")
        throw new Error("Unmodeled registration target");
      return portSuccess({
        target,
        provider: "azure",
        recipes: [],
        observation: {
          quality: "current",
          completeness: "complete",
          evidence: "radius",
          observedAt: "2026-09-15T22:00:00Z"
        }
      });
    }
  };

async function start(
  options: Parameters<typeof createGraphBoundaryFixture>[0] = {}
) {
  const fixture = await createGraphBoundaryFixture(options);
  let stop: (() => Promise<void>) | undefined;
  try {
    const state: CanvasState = {
      workspacePath: fixture.workspace,
      contextRepo: "owner/repo",
      contextBranch: graphBranch
    };
    // This is the proposed read-only overload of the real workflow factory.
    // No legacy pipeline, default recipes, repair or authoring port is supplied.
    const workflows = createGraphPlanningWorkflows({
      lifecycle: fixture.binding,
      readInstanceEntry: () => ({ state }),
      resolveBranchForRequest: (entry, repo, requested, follow) =>
        resolveGraphBranchForRequest(
          entry.state,
          repo,
          requested,
          follow,
          async () => graphBranch
        ),
      commitBranchResolution: (entry, repo, resolution) =>
        commitWorkspaceBranchResolution(entry.state, repo, resolution),
      prepareSourceRefResources,
      setSourceRefResources,
      isCurrentSourceRefToken,
      addGraphProgress,
      beginPlannedGraphRequest,
      isCurrentPlannedGraphRequest,
      now: () => 1_000
    });
    const routes = createTestRouteTable({
      ...createGraphsPlanningWritesRoutes({ workflows }),
      ...createGraphsPlanningStreamRoutes({
        readInstanceEntry: () => ({ state }),
        workflows
      }),
      ...createLivenessSourceRoutes({
        readInstanceState: () => state,
        getWorkspaceModelRevision: () =>
          readWorkspaceGraphRevision({
            state,
            graphLifecycle: fixture.binding
          }),
        getOpenSourceHandler: () => null,
        toSafeRepoRelPath: () => {
          throw new Error("Unexpected source opening");
        }
      })
    });
    const container = createCanvasServer({
      createHttpServer: (handler) => createServer(handler),
      createRequestHandler: ({ instanceId, instances, markActivity }) =>
        createRequestHandler({
          instanceId,
          instances,
          routes,
          markActivity,
          handleUnmatchedRequest: (_request, response) => {
            response.writeHead(404);
            response.end("unmatched");
          }
        }),
      createState: () => state,
      defaultPage: "graph",
      now: () => 1_000,
      preferredPort: async () => 0,
      prepareIdentity: () => {}
    });
    stop = () => container.stopAll();
    const entry = await container.getOrCreate("graph-contract");
    expect(entry.server.address()).toMatchObject({ address: "127.0.0.1" });
    return {
      fixture,
      state,
      entry,
      post(path: string, body: unknown) {
        return fetch(`${entry.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      },
      async close() {
        await container.stopAll();
        await fixture.close();
        expect(container.instances.size).toBe(0);
      }
    };
  } catch (error) {
    await stop?.();
    await fixture.close();
    throw error;
  }
}

it("loads current uncommitted worktree inputs over the retained POST route and invalidates supporting-file-only graph cache entries", async () => {
  const harness = await start();
  try {
    const request = { repo: "owner/repo", followWorkspaceBranch: true };
    const response = await harness.post("/api/load-graph", request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const first: unknown = await response.json();
    expect(first).toMatchObject({
      fromWorkspace: true,
      resources: [
        expect.objectContaining({
          id: "cache",
          definitionFile: graphDefinition
        })
      ]
    });
    expect(harness.state.graphBranch).toBe(graphBranch);
    expect(harness.fixture.compiled[0]?.inputs).toEqual(
      graphInputs("uncommitted")
    );
    await harness.fixture.replaceWorkspaceInputs("http-supporting-change");
    const changed = await harness.post("/api/load-graph", {
      ...request,
      refresh: true
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).not.toEqual(first);
    expect(harness.fixture.runGraph).toHaveBeenCalledTimes(2);
    expect(harness.fixture.compiled[1]?.inputs).toEqual(
      graphInputs("http-supporting-change")
    );
    expect(harness.fixture.calls).toEqual([]);
    await harness.fixture.expectUnchanged("http-supporting-change");
  } finally {
    await harness.close();
  }
});

it("reports independently changed supporting bytes through heartbeat without recompiling or resetting the rendered fingerprint", async () => {
  const h = await start();
  const ping = async () =>
    (
      await fetch(`${h.entry.baseUrl}/api/ping`, {
        headers: { "X-Radius-Workspace-Model": "1" }
      })
    ).json();
  try {
    const first = await h.post("/api/load-graph", {
      repo: "owner/repo",
      followWorkspaceBranch: true
    });
    expect(first.status).toBe(200);
    const baseline = h.state.graphModelRevision;
    expect(baseline).toMatch(/^sha256:/);
    expect(await ping()).toMatchObject({
      workspaceModelChanged: false,
      workspaceModelRevision: baseline
    });
    await h.fixture.replaceWorkspaceInputs("independent-supporting-edit");
    expect(await ping()).toMatchObject({ workspaceModelChanged: true });
    expect(h.state.graphModelRevision).toBe(baseline);
    expect(h.fixture.runGraph).toHaveBeenCalledTimes(1);
    await h.post("/api/load-graph", {
      repo: "owner/repo",
      followWorkspaceBranch: true
    });
    expect(await ping()).toMatchObject({
      workspaceModelChanged: false,
      workspaceModelRevision: h.state.graphModelRevision
    });
    expect(h.fixture.runGraph).toHaveBeenCalledTimes(2);
    await h.fixture.expectUnchanged("independent-supporting-edit");
  } finally {
    await h.close();
  }
});

it("compares separately pinned committed refs over HTTP even when the head branch equals the attached worktree", async () => {
  const harness = await start();
  try {
    const response = await harness.post("/api/diff-branches", {
      repo: "owner/repo",
      base: "main",
      head: graphBranch
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      message: `Comparing main → ${graphBranch}`
    });
    expect(harness.state.diffResources).toEqual([
      expect.objectContaining({ id: "cache", diffStatus: "modified" })
    ]);
    expect(harness.fixture.compiled.map((entry) => entry.inputs)).toEqual(
      expect.arrayContaining([
        graphInputs("committed-base"),
        graphInputs("committed-head")
      ])
    );
    expect(harness.fixture.git).not.toHaveBeenCalled();
    for (const [ref, commit] of [
      ["main", "a".repeat(40)],
      [graphBranch, "b".repeat(40)]
    ])
      expect(harness.fixture.authorizations).toContainEqual(
        expect.objectContaining({
          operation: "graph.diff",
          target: {
            repo: "owner/repo",
            definition: graphDefinition,
            source: { kind: "git", ref, expectedCommit: commit }
          }
        })
      );
    await harness.fixture.expectUnchanged();
  } finally {
    await harness.close();
  }
});

it.each([
  ["missing", "DEFINITION_NOT_FOUND"],
  ["forbidden", "FORBIDDEN"],
  ["network", "RESULT_UNAVAILABLE"],
  ["malformed", "RESULT_UNAVAILABLE"]
] as const)(
  "serializes a %s base as unavailable rather than an empty graph, authoring handoff or successful diff",
  async (baseMode, reason) => {
    const harness = await start({ baseMode });
    try {
      const response = await harness.post("/api/diff-branches", {
        repo: "owner/repo",
        base: "main",
        head: graphBranch
      });
      expect(response.status).toBe(baseMode === "missing" ? 200 : 400);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      const result: unknown = await response.json();
      expect(result).toMatchObject({
        unavailable: true,
        source: "base",
        reason
      });
      expect(result).not.toHaveProperty("needsAppBicep");
      expect(result).not.toHaveProperty("repairing");
      expect(result).not.toHaveProperty("resources");
      expect(harness.state.diffResources).toBeUndefined();
      expect(
        harness.fixture.calls.some((args) =>
          args.some((arg) => arg.includes("/git/trees/"))
        )
      ).toBe(true);
      await harness.fixture.expectUnchanged();
    } finally {
      await harness.close();
    }
  }
);

it("returns explicit unavailable planned evidence through the actual production registration adapter instead of provider-default outputs", async () => {
  const harness = await start();
  try {
    const response = await harness.post("/api/plan-graph", {
      repo: "owner/repo",
      branch: graphBranch,
      environment: "dev",
      provider: "azure",
      followWorkspaceBranch: true
    });
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      unavailable: true,
      reason: "RESULT_UNAVAILABLE"
    });
    expect(body).not.toHaveProperty("resources");
    expect(body).not.toHaveProperty("needsAppBicep");
    expect(harness.state.plannedResources).toBeUndefined();
    await harness.fixture.expectUnchanged();
  } finally {
    await harness.close();
  }
});

it.each(["/api/load-graph", "/api/plan-graph", "/api/diff-branches"])(
  "preserves external compiler failures as 400 at the real %s HTTP adapter boundary",
  async (path) => {
    const h = await start(registeredEnvironment);
    h.fixture.runGraph.mockRejectedValue(new Error("private compiler stderr"));
    try {
      const response = await h.post(path, {
        repo: "owner/repo",
        branch: graphBranch,
        followWorkspaceBranch: true,
        base: "main",
        head: graphBranch,
        environment: "dev"
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        unavailable: true,
        reason: "RESULT_UNAVAILABLE"
      });
      expect(JSON.stringify(body)).not.toContain("private compiler stderr");
      expect(body).not.toHaveProperty("resources");
      expect(h.fixture.runGraph).toHaveBeenCalled();
      await h.fixture.expectUnchanged();
    } finally {
      await h.close();
    }
  }
);

it.each(["/api/load-graph", "/api/plan-graph", "/api/diff-branches"])(
  "retains 409 when the source selection changes during real %s compilation",
  async (path) => {
    const h = await start(registeredEnvironment);
    const compile = h.fixture.runGraph.getMockImplementation();
    if (!compile) {
      await h.close();
      throw new Error("Missing compiler boundary");
    }
    let release: () => void = () => {
      throw new Error("Gate not initialized");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {
      throw new Error("Signal not initialized");
    };
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.fixture.runGraph.mockImplementation(async (...args) => {
      entered();
      await gate;
      return compile(...args);
    });
    const pending = h.post(path, {
      repo: "owner/repo",
      branch: graphBranch,
      followWorkspaceBranch: true,
      base: "main",
      head: graphBranch,
      environment: "dev"
    });
    try {
      await started;
      h.state.contextBranch = "new-selection";
      release();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(await response.json()).toEqual({ stale: true });
      expect(h.state.graphResources).toBeUndefined();
      expect(h.state.plannedResources).toBe(
        path === "/api/plan-graph" ? null : undefined
      );
      expect(h.state.diffResources).toBeUndefined();
      await h.fixture.expectUnchanged();
    } finally {
      release();
      await pending;
      await h.close();
    }
  }
);

it("preserves SSE headers and exactly one terminal outcome after a real compiler failure", async () => {
  const h = await start();
  h.fixture.runGraph.mockRejectedValue(new Error("private compiler stderr"));
  try {
    const response = await fetch(
      `${h.entry.baseUrl}/api/load-graph-stream?repo=owner/repo&followWorkspaceBranch=true`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    const frames = (await response.text()).trim().split("\n\n");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatch(/^event: progress\ndata: /);
    expect(frames[1]).toMatch(/^event: done\ndata: /);
    expect(JSON.parse(frames[1].split("data: ")[1])).toMatchObject({
      unavailable: true,
      reason: "RESULT_UNAVAILABLE"
    });
    expect(frames.join()).not.toContain("private compiler stderr");
    expect(h.fixture.runGraph).toHaveBeenCalledOnce();
    await h.fixture.expectUnchanged();
  } finally {
    await h.close();
  }
});

it.each(["/api/load-graph", "/api/plan-graph", "/api/diff-branches"])(
  "keeps malformed JSON at the %s HTTP boundary without compiling or writing source",
  async (path) => {
    const harness = await start();
    try {
      const response = await fetch(`${harness.entry.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );

      expect(await response.json()).toHaveProperty("error");
      expect(harness.fixture.runGraph).not.toHaveBeenCalled();
      expect(harness.fixture.calls).toEqual([]);
      expect(harness.fixture.writes).toEqual([]);
      await harness.fixture.expectUnchanged();
    } finally {
      await harness.close();
    }
  }
);
