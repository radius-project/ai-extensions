import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  applicationGraphToResources,
  computeGraphDiff,
  projectSafeApplicationGraph
} from "@radius-project/core";
import { RadProcessError } from "@radius-project/adapter-shared";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createGraphsPlanningWritesRoutes } from "../../../src/server/routes/graphs-planning-writes.js";
import { createGraphPlanningWorkflows } from "../../../src/server/routes/graph-workflows.js";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "../../../src/graph-progress-contract.js";
import type {
  AppBicepSelection,
  GraphPipeline
} from "../../../src/server/routes/graph-pipeline.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "../../../src/source-refs.js";
import { defaultBranchForState } from "../../../src/workspace.js";
import {
  addGraphProgress,
  beginPlannedGraphRequest,
  canReuseModeledGraph,
  isCurrentPlannedGraphRequest,
  isCurrentSourceRefToken
} from "../../../src/server.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;
// Everything the workflows sent to the server log instead of the canvas.
let loggedErrors: string[] = [];

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
  loggedErrors = [];
});

interface PipelineScript {
  selections: Record<string, AppBicepSelection>;
  compiled: Record<string, CanvasGraphResource[]>;
  compileThrows?: unknown;
  branchPaths?: string[];
  afterCompile?: () => void;
}

interface Harness {
  state: CanvasState;
  script: PipelineScript;
  setEntryMissing(missing: boolean): void;
  advanceClock(ms: number): void;
}

function selectionOf(
  branch: string,
  content: string | null
): AppBicepSelection {
  return { content, fromWorkspace: false, branch, bicepPath: "" };
}

// Only the pipeline is faked: every one of its stages shells out to `rad` or
// reaches GitHub. Each stage throws on an unscripted branch, so a handler that
// compiles a side the scenario did not model fails loudly instead of silently
// producing an empty graph. Every pure seam is the real production function.
function start(script: Partial<PipelineScript> = {}): Harness {
  const state: CanvasState = {};
  let entryMissing = false;
  let nowMs = 1_000;
  const active: PipelineScript = {
    selections: {},
    compiled: {},
    ...script
  };

  function scripted<T>(
    table: Record<string, T>,
    branch: string,
    stage: string
  ) {
    const value = table[branch];
    if (!value) throw new Error(`unscripted ${stage} for branch: ${branch}`);
    return value;
  }

  const pipeline: GraphPipeline = {
    selectAppBicep: (_entry, _repo, branch) =>
      Promise.resolve(scripted(active.selections, branch, "selectAppBicep")),
    bicepPathOf: (selection) => selection.bicepPath || ".radius/app.bicep",
    stageArtifacts: () => Promise.resolve({ dir: "", remote: false }),
    compileResources: ({ selection }) => {
      if (active.compileThrows) return Promise.reject(active.compileThrows);
      const compiled = scripted(
        active.compiled,
        selection.branch,
        "compileResources"
      );
      active.afterCompile?.();
      return Promise.resolve(compiled);
    },
    toCanvasResources: (values) => values as CanvasGraphResource[],
    graphJsonPathFor: () => "",
    definitionHashFor: () => "hash-a",
    discardStagedArtifacts: () => {}
  };

  const routes = createTestRouteTable(
    createGraphsPlanningWritesRoutes({
      // The real workflow service, so this suite still exercises the whole
      // stack from the socket down to the state machine.
      workflows: createGraphPlanningWorkflows({
        readInstanceEntry: () => (entryMissing ? undefined : { state }),
        pipeline,
        triggerAppBicepHandoff: () => {},
        observeModelingRun: () => Promise.resolve(null),
        triggerGraphRepairHandoff: () => ({
          attempt: 1,
          maxAttempts: 3,
          repairing: true,
          repairExhausted: false
        }),
        clearGraphRepairAttempt: () => {},
        listBranchPaths: () => Promise.resolve(active.branchPaths ?? []),
        prepareSourceRefResources,
        setSourceRefResources,
        isCurrentSourceRefToken,
        defaultBranchForState,
        canReuseModeledGraph,
        addGraphProgress,
        beginPlannedGraphRequest,
        isCurrentPlannedGraphRequest,
        fetchRecipePack: () => Promise.resolve([]),
        resolveRecipeOutputs: (resources) => Promise.resolve(resources),
        computeGraphDiff: (baseResources, headResources) =>
          computeGraphDiff(
            baseResources,
            headResources
          ) as CanvasGraphResource[],
        record: (value) => {
          if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
          ) {
            return {};
          }
          return Object.fromEntries(Object.entries(value));
        },
        optionalString: (value) => (typeof value === "string" ? value : ""),
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error),
        logError: (message) => {
          loggedErrors.push(message);
        },
        now: () => nowMs
      })
    })
  );

  container = createCanvasServer({
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
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    state,
    script: active,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    advanceClock(ms) {
      nowMs += ms;
    }
  };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("graphs-planning writes real-loopback HIT", () => {
  it("serves the modeled graph and its state transition over a real socket", async () => {
    const harness = start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compiled: { main: [{ id: "res-a", name: "api" } as CanvasGraphResource] }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"reload":true,"resources":[{"id":"res-a","name":"api"}],"fromWorkspace":false}'
    );
    expect(harness.state.graphLoaded).toBe(true);
    expect(harness.state.graphTargetRepo).toBe("octo/app");
  });

  it("does not expose rejected icon entries in the modeled graph response", async () => {
    const sentinel = "fixture-private-field";
    const iconHash = `sha256:${"a".repeat(64)}`;
    const projected = projectSafeApplicationGraph({
      resources: [
        {
          id: "res-a",
          name: "api",
          type: "Radius.Compute/containers",
          diffHash: `sha256:${"b".repeat(64)}`,
          iconHash
        }
      ],
      icons: {
        [iconHash]: "<svg>safe</svg>",
        "not-a-hash": sentinel,
        [`sha256:${"c".repeat(64)}`]: sentinel
      }
    });
    start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compiled: {
        main: applicationGraphToResources(projected) as CanvasGraphResource[]
      }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<svg>safe</svg>");
    expect(body).not.toContain(sentinel);
    expect(body).not.toContain("not-a-hash");
  });

  it("answers the app-bicep handoff payload when the branch has no model", async () => {
    start({ selections: { main: selectionOf("main", null) } });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      error:
        "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
      needsAppBicep: true,
      repo: "octo/app",
      branch: "main"
    });
  });

  it("answers 503 with no Content-Type when the instance entry is gone", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/plan-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(503);
    // The header's absence is observable on the wire, not merely in a recorder.
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe(
      '{"error":"Canvas server state is unavailable."}'
    );
  });

  it("answers 400 for a malformed body on every write route", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    for (const path of [
      "/api/load-graph",
      "/api/plan-graph",
      "/api/diff-branches"
    ]) {
      const response = await post(entry.baseUrl, path, "{not json");
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(((await response.json()) as { error: string }).error).toContain(
        "JSON"
      );
    }
    expect(loggedErrors).toEqual([]);
  });

  it("keeps app.bicep validation diagnostics out of the graph response", async () => {
    const harness = start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compileThrows: new Error("rad app graph failed", {
        cause: new RadProcessError(
          "rad exited with code 1",
          "Error BCP035: missing required property",
          ""
        )
      })
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: GRAPH_MODELING_FAILURE_MESSAGE,
      modelingFailed: true,
      attempt: 1,
      maxAttempts: 3,
      repairing: true,
      repairExhausted: false
    });
    expect(harness.state.graphLoaded).toBeUndefined();
    expect(loggedErrors).toEqual([
      "[radius graph] modeling failed for octo/app@main: Error BCP035: missing required property"
    ]);
  });

  it("plans the graph through the recipe pack over a real socket", async () => {
    const harness = start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compiled: { main: [{ id: "res-a", name: "api" } as CanvasGraphResource] }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/plan-graph",
      '{"repo":"octo/app","environment":"prod"}'
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"reload":true}');
    expect(harness.state.plannedProvider).toBe("azure");
    expect(harness.state.plannedEnvironment).toBe("prod");
    expect(harness.state.activeGraphView).toBe("planned");
  });

  it("compares two branches over a real socket", async () => {
    const harness = start({
      selections: {
        main: selectionOf("main", "resource app = {}"),
        "feature/x": selectionOf("feature/x", "resource app = {}")
      },
      compiled: {
        main: [{ id: "res-a", name: "api" } as CanvasGraphResource],
        "feature/x": [
          { id: "res-a", name: "api" } as CanvasGraphResource,
          { id: "res-b", name: "cache" } as CanvasGraphResource
        ]
      }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/diff-branches",
      '{"repo":"octo/app","base":"main","head":"feature/x"}'
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '{"message":"Comparing main → feature/x","reload":true}'
    );
    expect(harness.state.page).toBe("graphDiff");
    expect(harness.state.diffResources).toHaveLength(2);
  });

  it("refuses a comparison whose selection moved on, with 409", async () => {
    const harness = start({
      selections: {
        main: selectionOf("main", "resource app = {}"),
        "feature/x": selectionOf("feature/x", "resource app = {}")
      },
      compiled: { main: [], "feature/x": [] }
    });
    harness.script.afterCompile = () => {
      prepareSourceRefResources({ state: harness.state }, "diff", {
        repo: "octo/app",
        baseBranch: "main",
        headBranch: "other"
      });
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/diff-branches",
      '{"repo":"octo/app","base":"main","head":"feature/x"}'
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe('{"stale":true}');
    expect(harness.state.page).toBeUndefined();
  });

  it.each([["/api/load-graph"], ["/api/plan-graph"], ["/api/diff-branches"]])(
    "delegates unmatched GET %s",
    async (path) => {
      start();
      const entry = await container!.getOrCreate("panel-a");
      // Only POST is declared, so the method flip must not reach the new handler.
      const response = await fetch(`${entry.baseUrl}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("unmatched");
    }
  );
});
