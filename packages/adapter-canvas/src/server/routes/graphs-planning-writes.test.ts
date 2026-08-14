import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { computeGraphDiff } from "@radius-project/core";
import { createRequestContext } from "../request-context.js";
import {
  createGraphsPlanningWritesRoutes,
  handleDiffBranches,
  handleLoadGraph,
  handlePlanGraph,
  type GraphsPlanningWritesDependencies
} from "./graphs-planning-writes.js";
import type {
  AppBicepSelection,
  CompileResourcesInput,
  GraphInstanceEntry,
  GraphPipeline,
  StageArtifactsInput,
  StagedRadArtifacts
} from "./graph-pipeline.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "../../source-refs.js";
import { defaultBranchForState } from "../../workspace.js";
import {
  addGraphProgress,
  beginPlannedGraphRequest,
  canReuseModeledGraph,
  isCurrentPlannedGraphRequest,
  isCurrentSourceRefToken
} from "../../server.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";

// `record`, `optionalString` and `errorMessage` are module-private in
// `server.ts`, so they are mirrored here verbatim rather than exported solely
// for a test — the same approach `graphs-planning-reads.test.ts` takes with
// `legacyErrorMessage`. They are pure, so a copy is a faithful injection.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface Recording {
  headers: Record<string, string>;
  headerOrder: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(body: string): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url: "/api/load-graph",
    method: "POST",
    headers: {}
  }) as unknown as IncomingMessage;
}

interface HandoffCall {
  repo: string;
  branches: string | string[];
  page: string;
  hasEntry: boolean;
}

interface PipelineScript {
  // Keyed by branch so a two-branch diff can script each side independently.
  selections: Record<string, AppBicepSelection>;
  staged: Record<string, StagedRadArtifacts>;
  compiled: Record<string, CanvasGraphResource[]>;
  jsonPath: string;
  definitionHash: string;
  discardThrows?: Error;
  selectThrows?: Record<string, Error>;
  compileThrows?: Record<string, Error>;
  // Runs after the named stage, so a test can move the world on mid-request.
  afterStage?: () => void;
  afterCompile?: () => void;
}

interface Harness {
  state: CanvasState;
  entry: GraphInstanceEntry;
  dependencies: GraphsPlanningWritesDependencies;
  script: PipelineScript;
  order: string[];
  handoffs: HandoffCall[];
  recipePackCalls: string[];
  recipeResolutions: Array<{
    resources: CanvasGraphResource[];
    recipes: unknown[];
    provider: string;
  }>;
  recipes: unknown[];
  plannedOutputs: unknown[];
  setEntryMissing(missing: boolean): void;
  run(
    handler: (
      context: ReturnType<typeof createRequestContext>,
      dependencies: GraphsPlanningWritesDependencies
    ) => Promise<void>,
    body: string
  ): Promise<Recording>;
}

function selectionOf(
  overrides: Partial<AppBicepSelection> = {}
): AppBicepSelection {
  return {
    content: "resource app 'Radius.Compute/containers' = {}",
    fromWorkspace: false,
    branch: "main",
    bicepPath: "",
    ...overrides
  };
}

// The pipeline is faked because every one of its stages isolates a real binary
// or the network; it throws on any unscripted branch so a handler that reaches
// for a side the scenario did not model fails loudly. Every *pure* seam below is
// the real production function, imported and injected exactly as `server.ts`
// injects it, so the state machines these routes drive (source-ref tokens,
// generation guards, the reuse predicate) are the real ones.
function start(script: Partial<PipelineScript> = {}): Harness {
  const state: CanvasState = {};
  const entry: GraphInstanceEntry = { state };
  let entryMissing = false;
  const order: string[] = [];
  const handoffs: HandoffCall[] = [];
  const recipePackCalls: string[] = [];
  const recipeResolutions: Harness["recipeResolutions"] = [];
  const harnessScript: PipelineScript = {
    selections: {},
    staged: {},
    compiled: {},
    jsonPath: "",
    definitionHash: "hash-a",
    ...script
  };
  const recipes: unknown[] = [];
  const plannedOutputs: unknown[] = [];

  function requireScripted<T>(
    table: Record<string, T>,
    key: string,
    stage: string
  ): T {
    const value = table[key];
    if (!value) throw new Error(`unscripted ${stage} for branch: ${key}`);
    return value;
  }

  const pipeline: GraphPipeline = {
    selectAppBicep: (_entry, _repo, branch) => {
      order.push(`select:${branch}`);
      const failure = harnessScript.selectThrows?.[branch];
      if (failure) return Promise.reject(failure);
      return Promise.resolve(
        requireScripted(harnessScript.selections, branch, "selectAppBicep")
      );
    },
    bicepPathOf: (selection) => selection.bicepPath || ".radius/app.bicep",
    stageArtifacts: ({ branch }: StageArtifactsInput) => {
      order.push(`stage:${branch}`);
      const staged = requireScripted(
        harnessScript.staged,
        branch,
        "stageArtifacts"
      );
      harnessScript.afterStage?.();
      return Promise.resolve(staged);
    },
    compileResources: ({ selection }: CompileResourcesInput) => {
      order.push(`compile:${selection.branch}`);
      const failure = harnessScript.compileThrows?.[selection.branch];
      if (failure) return Promise.reject(failure);
      const compiled = requireScripted(
        harnessScript.compiled,
        selection.branch,
        "compileResources"
      );
      harnessScript.afterCompile?.();
      return Promise.resolve(compiled);
    },
    toCanvasResources: (values) => values as CanvasGraphResource[],
    graphJsonPathFor: () => harnessScript.jsonPath,
    definitionHashFor: () => harnessScript.definitionHash,
    discardStagedArtifacts: (staged) => {
      order.push(`discard:${staged.dir}`);
      if (harnessScript.discardThrows) throw harnessScript.discardThrows;
    }
  };

  const dependencies: GraphsPlanningWritesDependencies = {
    readInstanceEntry: () => (entryMissing ? undefined : entry),
    pipeline,
    triggerAppBicepHandoff: (handoffEntry, repo, branches, page) => {
      handoffs.push({ repo, branches, page, hasEntry: !!handoffEntry });
    },
    prepareSourceRefResources,
    setSourceRefResources,
    isCurrentSourceRefToken,
    defaultBranchForState,
    canReuseModeledGraph,
    addGraphProgress,
    beginPlannedGraphRequest,
    isCurrentPlannedGraphRequest,
    fetchRecipePack: (provider) => {
      recipePackCalls.push(provider);
      return Promise.resolve(recipes);
    },
    resolveRecipeOutputs: (resources, packRecipes, provider) => {
      recipeResolutions.push({ resources, recipes: packRecipes, provider });
      return Promise.resolve(plannedOutputs);
    },
    computeGraphDiff: (baseResources, headResources) =>
      computeGraphDiff(baseResources, headResources) as CanvasGraphResource[],
    record,
    optionalString,
    errorMessage
  };

  return {
    state,
    entry,
    dependencies,
    script: harnessScript,
    order,
    handoffs,
    recipePackCalls,
    recipeResolutions,
    recipes,
    plannedOutputs,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    async run(handler, body) {
      const { recording, response } = recorder();
      const context = createRequestContext(
        request(body),
        response,
        "panel-a",
        new Map()
      );
      await handler(context, dependencies);
      return recording;
    }
  };
}

function messages(state: CanvasState): string[] {
  return state.progressMessages || [];
}

describe("graphs-planning write routes", () => {
  describe("POST /api/load-graph", () => {
    it("answers 400 with the parse failure for a malformed body", async () => {
      const harness = start();
      const recording = await harness.run(handleLoadGraph, "{not json");
      expect(recording.status).toBe(400);
      expect(recording.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(recording.body).error).toContain("JSON");
    });

    it("answers 503 without a Content-Type when the instance entry is gone", async () => {
      const harness = start();
      harness.setEntryMissing(true);
      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );
      expect(recording.status).toBe(503);
      expect(recording.headerOrder).toEqual([]);
      expect(recording.body).toBe(
        '{"error":"Canvas server state is unavailable."}'
      );
    });

    it("claims the build generation before rejecting an empty repo", async () => {
      const harness = start();
      harness.state.graphBuildGeneration = 4;
      const recording = await harness.run(handleLoadGraph, "{}");
      expect(recording.status).toBe(200);
      expect(recording.body).toBe('{"error":"Please select a repository."}');
      // The claim happens first, so an in-flight compile is invalidated even by
      // a request that goes no further than this.
      expect(harness.state.graphBuildGeneration).toBe(5);
      expect(harness.order).toEqual([]);
    });

    it("hands off to the app-bicep skill when the branch has no app.bicep", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });
      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );
      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body)).toEqual({
        error:
          "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
        needsAppBicep: true,
        repo: "octo/app",
        branch: "main"
      });
      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: "main",
          page: "graph",
          hasEntry: true
        }
      ]);
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for existing app.bicep...",
        ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill."
      ]);
    });

    it("defaults the branch from state and compiles the workspace selection", async () => {
      const harness = start({
        selections: {
          "feature/x": selectionOf({
            branch: "feature/x",
            fromWorkspace: true,
            bicepPath: "infra/app.bicep"
          })
        },
        staged: { "feature/x": { dir: "/ws/.radius", remote: false } },
        compiled: { "feature/x": [{ id: "res-a" } as CanvasGraphResource] },
        jsonPath: "/ws/infra/app-graph.json",
        definitionHash: "hash-x"
      });
      harness.state.workspaceBranch = "feature/x";

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(200);
      expect(recording.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(recording.body)).toEqual({
        reload: true,
        resources: [{ id: "res-a" }]
      });
      expect(harness.order).toEqual([
        "select:feature/x",
        "stage:feature/x",
        "compile:feature/x"
      ]);
      expect(harness.state).toMatchObject({
        graphTargetRepo: "octo/app",
        graphBranch: "feature/x",
        graphFromWorkspace: true,
        activeGraphView: "graph",
        graphLoaded: true,
        graphDefinitionHash: "hash-x"
      });
      expect(harness.state.graphResources).toEqual([{ id: "res-a" }]);
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for existing app.bicep...",
        "Found existing app.bicep — parsing resources...",
        "Mapped 1 resource(s) — rendering graph..."
      ]);
    });

    it("reports reload false for an explicit refresh", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });
      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app","refresh":true}'
      );
      expect(JSON.parse(recording.body)).toEqual({
        reload: false,
        resources: []
      });
    });

    it("abandons a superseded request after staging and discards best-effort", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: true } },
        afterStage: () => {
          // A newer request claims the generation while this one was staging.
          harness.state.graphBuildGeneration =
            (harness.state.graphBuildGeneration || 0) + 1;
        }
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(409);
      // 409 here is written without a Content-Type, unlike the two post-compile
      // stale exits below.
      expect(recording.headerOrder).toEqual([]);
      expect(recording.body).toBe('{"stale":true}');
      expect(harness.order).toEqual([
        "select:main",
        "stage:main",
        "discard:/tmp/staged"
      ]);
    });

    it("still answers 409 when discarding the staged artifacts fails", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: true } },
        discardThrows: new Error("EBUSY"),
        afterStage: () => {
          harness.state.graphBuildGeneration = 99;
        }
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(409);
      expect(recording.body).toBe('{"stale":true}');
    });

    it("serves the cached graph on a refresh of an unchanged model", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: true } },
        definitionHash: "hash-a"
      });
      Object.assign(harness.state, {
        graphLoaded: true,
        graphTargetRepo: "octo/app",
        graphBranch: "main",
        graphDefinitionHash: "hash-a",
        graphResources: [{ id: "cached" }] as CanvasGraphResource[]
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app","refresh":true}'
      );

      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body)).toEqual({
        reload: false,
        resources: [{ id: "cached" }],
        cached: true
      });
      // The compile is skipped entirely, which is the point of the cache.
      expect(harness.order).toEqual([
        "select:main",
        "stage:main",
        "discard:/tmp/staged"
      ]);
    });

    it("surfaces a discard failure on the cache path as 400, unlike the stale path", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: true } },
        definitionHash: "hash-a",
        discardThrows: new Error("EBUSY")
      });
      Object.assign(harness.state, {
        graphLoaded: true,
        graphTargetRepo: "octo/app",
        graphBranch: "main",
        graphDefinitionHash: "hash-a",
        graphResources: [] as CanvasGraphResource[]
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app","refresh":true}'
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body)).toEqual({ error: "EBUSY" });
    });

    it("does not reuse a cached graph when the definition hash moved", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "fresh" } as CanvasGraphResource] },
        definitionHash: "hash-b"
      });
      Object.assign(harness.state, {
        graphLoaded: true,
        graphTargetRepo: "octo/app",
        graphBranch: "main",
        graphDefinitionHash: "hash-a",
        graphResources: [{ id: "cached" }] as CanvasGraphResource[]
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app","refresh":true}'
      );

      expect(JSON.parse(recording.body).resources).toEqual([{ id: "fresh" }]);
      expect(harness.order).toContain("compile:main");
    });

    it("abandons a request superseded during the compile, with a Content-Type", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          harness.state.graphBuildGeneration = 42;
        }
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(409);
      expect(recording.headerOrder).toEqual(["Content-Type"]);
      expect(recording.body).toBe('{"stale":true}');
      expect(harness.state.graphLoaded).toBeUndefined();
    });

    it("stops writing progress once a newer request claims the generation", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          harness.state.graphBuildGeneration = 42;
        }
      });

      await harness.run(handleLoadGraph, '{"repo":"octo/app"}');

      // "Mapped N resource(s)" is generation-gated and must not appear.
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for existing app.bicep...",
        "Found existing app.bicep — parsing resources..."
      ]);
    });

    it("answers 409 when the source-ref selection changed under the request", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          // A different selection takes the graph view's token, so the write
          // must be refused even though the generation still matches.
          prepareSourceRefResources(harness.entry, "graph", {
            repo: "octo/other",
            branch: "main"
          });
        }
      });

      const recording = await harness.run(
        handleLoadGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(409);
      expect(recording.headerOrder).toEqual(["Content-Type"]);
      expect(recording.body).toBe('{"stale":true}');
      expect(harness.state.graphTargetRepo).toBeUndefined();
    });
  });

  describe("POST /api/plan-graph", () => {
    it("answers 400 for a malformed body and 503 without a Content-Type for a missing entry", async () => {
      const malformed = await start().run(handlePlanGraph, "nope");
      expect(malformed.status).toBe(400);

      const harness = start();
      harness.setEntryMissing(true);
      const missing = await harness.run(handlePlanGraph, '{"repo":"octo/app"}');
      expect(missing.status).toBe(503);
      expect(missing.headerOrder).toEqual([]);
    });

    it("hands off as the graph page when the branch has no app.bicep", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });

      const recording = await harness.run(
        handlePlanGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body)).toEqual({
        error:
          "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
        needsAppBicep: true,
        repo: "octo/app",
        branch: "main"
      });
      // "graph", not "planned": the handoff key is derived from the page.
      expect(harness.handoffs[0]?.page).toBe("graph");
    });

    it("resolves recipes for the default provider and records the planned view", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] }
      });
      harness.recipes.push({
        resourceType: "Radius.Data/redisCaches",
        concreteResources: [{ type: "Microsoft.Cache/redis" }]
      });
      harness.plannedOutputs.push({ id: "res-a" }, { id: "redis" });

      const recording = await harness.run(
        handlePlanGraph,
        '{"repo":"octo/app","environment":"prod"}'
      );

      expect(recording.status).toBe(200);
      expect(recording.body).toBe('{"reload":true}');
      expect(harness.recipePackCalls).toEqual(["azure"]);
      expect(harness.recipeResolutions).toEqual([
        {
          resources: [{ id: "res-a" }],
          recipes: harness.recipes,
          provider: "azure"
        }
      ]);
      expect(harness.state).toMatchObject({
        plannedRepo: "octo/app",
        plannedBranch: "main",
        plannedFromWorkspace: false,
        plannedProvider: "azure",
        plannedEnvironment: "prod",
        activeGraphView: "planned"
      });
      expect(harness.state.resolvedRecipes).toBe(harness.recipes);
      expect(harness.state.plannedResources).toEqual([
        { id: "res-a" },
        { id: "redis" }
      ]);
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for app.bicep...",
        "Found app.bicep — parsing resources...",
        "Parsed 1 resource(s) — resolving azure recipes...",
        "Fetching the default recipe pack from GitHub...",
        "Loaded 1 recipe(s) from the default recipe pack.",
        "Resolving recipe outputs for planned resources...",
        "Planned 2 resource(s) — rendering graph..."
      ]);
    });

    it("carries an explicit provider through both recipe seams", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });

      await harness.run(
        handlePlanGraph,
        '{"repo":"octo/app","provider":"aws"}'
      );

      expect(harness.recipePackCalls).toEqual(["aws"]);
      expect(harness.recipeResolutions[0]?.provider).toBe("aws");
      expect(harness.state.plannedProvider).toBe("aws");
    });

    it.each([
      ["a non-string environment", '{"repo":"octo/app","environment":7}'],
      ["an absent environment", '{"repo":"octo/app"}']
    ])("stores an empty planned environment for %s", async (_label, body) => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });
      await harness.run(handlePlanGraph, body);
      expect(harness.state.plannedEnvironment).toBe("");
    });

    it("names the pack recipes it could not map to a concrete resource", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });
      harness.recipes.push(
        { resourceType: "Radius.Data/redisCaches", concreteResources: [] },
        { resourceType: "Radius.Security/secrets" },
        {
          resourceType: "Radius.Compute/containers",
          concreteResources: [{ type: "Microsoft.App/containerApps" }]
        }
      );

      await harness.run(handlePlanGraph, '{"repo":"octo/app"}');

      expect(messages(harness.state)).toContain(
        "Note: 2 pack recipe(s) have no concrete-resource mapping yet " +
          "(Radius.Data/redisCaches, Radius.Security/secrets); those nodes " +
          "show their abstract Radius type."
      );
    });

    it("stays quiet when every pack recipe maps to a concrete resource", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });
      harness.recipes.push({
        resourceType: "Radius.Compute/containers",
        concreteResources: [{ type: "Microsoft.App/containerApps" }]
      });

      await harness.run(handlePlanGraph, '{"repo":"octo/app"}');

      expect(
        messages(harness.state).some((message) => message.startsWith("Note:"))
      ).toBe(false);
    });

    it("treats a missing repo as empty and plans nothing for it", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });

      const recording = await harness.run(handlePlanGraph, "{}");

      expect(recording.status).toBe(200);
      expect(harness.state.plannedRepo).toBe("");
      expect(messages(harness.state)[0]).toBe("Checking  for app.bicep...");
    });

    it("abandons a superseded plan with a Content-Type and keeps no planned state", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          // A newer plan request claims the plan generation.
          beginPlannedGraphRequest(harness.state);
        }
      });

      const recording = await harness.run(
        handlePlanGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(409);
      expect(recording.headerOrder).toEqual(["Content-Type"]);
      expect(recording.body).toBe('{"stale":true}');
      expect(harness.state.plannedRepo).toBeUndefined();
      // Unlike load-graph's, this progress log is not generation-gated, so the
      // superseded request's final message is still there.
      expect(messages(harness.state)).toContain(
        "Planned 0 resource(s) — rendering graph..."
      );
    });

    it("answers 409 when the planned selection changed under the request", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          prepareSourceRefResources(harness.entry, "planned", {
            repo: "octo/other",
            branch: "main"
          });
        }
      });

      const recording = await harness.run(
        handlePlanGraph,
        '{"repo":"octo/app"}'
      );

      expect(recording.status).toBe(409);
      expect(recording.headerOrder).toEqual(["Content-Type"]);
      expect(harness.state.plannedRepo).toBeUndefined();
    });
  });

  describe("POST /api/diff-branches", () => {
    const diffBody = '{"repo":"octo/app","base":"main","head":"feature/x"}';

    it("answers 400 without recording a diff error when the body will not parse", async () => {
      const harness = start();
      const recording = await harness.run(handleDiffBranches, "{oops");
      expect(recording.status).toBe(400);
      // No source-ref context was ever prepared, so nothing claims the view.
      expect(harness.state.diffError).toBeUndefined();
    });

    it("answers 503 without a Content-Type when the instance entry is gone", async () => {
      const harness = start();
      harness.setEntryMissing(true);
      const recording = await harness.run(handleDiffBranches, diffBody);
      expect(recording.status).toBe(503);
      expect(recording.headerOrder).toEqual([]);
    });

    it("hands both branches off when neither has an app.bicep", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main", content: null }),
          "feature/x": selectionOf({ branch: "feature/x", content: null })
        }
      });

      const recording = await harness.run(handleDiffBranches, diffBody);

      expect(recording.status).toBe(200);
      // No `branch` key, unlike the single-branch routes.
      expect(JSON.parse(recording.body)).toEqual({
        error:
          "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
        needsAppBicep: true,
        repo: "octo/app"
      });
      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: ["main", "feature/x"],
          page: "graph-diff",
          hasEntry: true
        }
      ]);
      expect(harness.order).toEqual(["select:main", "select:feature/x"]);
    });

    it("stages both branches before compiling either", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "/tmp/base", remote: true },
          "feature/x": { dir: "/tmp/head", remote: true }
        },
        compiled: {
          main: [{ id: "res-a", name: "api" } as CanvasGraphResource],
          "feature/x": [
            { id: "res-a", name: "api" } as CanvasGraphResource,
            { id: "res-b", name: "cache" } as CanvasGraphResource
          ]
        }
      });

      const recording = await harness.run(handleDiffBranches, diffBody);

      expect(recording.status).toBe(200);
      // Interleaving stage/compile per side would clean the base temp directory
      // up before the head side is staged, so the order itself is pinned.
      expect(harness.order).toEqual([
        "select:main",
        "select:feature/x",
        "stage:main",
        "stage:feature/x",
        "compile:main",
        "compile:feature/x"
      ]);
      expect(JSON.parse(recording.body)).toEqual({
        message: "Comparing main → feature/x",
        reload: true
      });
      expect(harness.state).toMatchObject({
        diffBase: "main",
        diffHead: "feature/x",
        diffTargetRepo: "octo/app",
        diffBaseGenerated: false,
        diffHeadGenerated: false,
        page: "graphDiff",
        activeGraphView: "diff"
      });
      // The real diff algorithm ran: the head-only resource is tagged added.
      const diffed = harness.state.diffResources || [];
      expect(diffed).toHaveLength(2);
      expect(
        diffed.find((resource) => resource.id === "res-b")?.diffStatus
      ).toBe("added");
    });

    it("still compares when only one branch carries an app.bicep", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main", content: null }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compiled: {
          main: [],
          "feature/x": [{ id: "res-b", name: "cache" } as CanvasGraphResource]
        }
      });

      const recording = await harness.run(handleDiffBranches, diffBody);

      expect(recording.status).toBe(200);
      expect(harness.handoffs).toEqual([]);
      expect(harness.state.diffResources).toHaveLength(1);
    });

    it("compares two branches of an unnamed repo as an empty repo", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compiled: { main: [], "feature/x": [] }
      });

      const recording = await harness.run(
        handleDiffBranches,
        '{"base":"main","head":"feature/x"}'
      );

      expect(recording.status).toBe(200);
      expect(harness.state.diffTargetRepo).toBe("");
    });

    it("answers 409 when the diff selection changed under the request", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compiled: { main: [], "feature/x": [] },
        afterCompile: () => {
          prepareSourceRefResources(harness.entry, "diff", {
            repo: "octo/app",
            baseBranch: "main",
            headBranch: "other"
          });
        }
      });

      const recording = await harness.run(handleDiffBranches, diffBody);

      expect(recording.status).toBe(409);
      expect(recording.headerOrder).toEqual(["Content-Type"]);
      expect(recording.body).toBe('{"stale":true}');
      expect(harness.state.page).toBeUndefined();
    });

    it("records the failure on the state when the selection is still on screen", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compileThrows: { main: new Error("rad exited 1") }
      });

      const recording = await harness.run(handleDiffBranches, diffBody);

      expect(recording.status).toBe(400);
      expect(recording.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(recording.body)).toEqual({ error: "rad exited 1" });
      expect(harness.state.diffError).toBe("rad exited 1");
    });

    it("leaves the diff error alone when a newer selection already replaced it", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compileThrows: { main: new Error("rad exited 1") },
        afterStage: () => {
          // Only fires once both sides have staged; harmless to run twice.
          prepareSourceRefResources(harness.entry, "diff", {
            repo: "octo/app",
            baseBranch: "main",
            headBranch: "other"
          });
        }
      });

      const recording = await harness.run(handleDiffBranches, diffBody);

      expect(recording.status).toBe(400);
      // The failure belongs to a selection no longer on screen, so it must not
      // paint an error over the newer one.
      expect(harness.state.diffError).toBeUndefined();
    });
  });

  describe("route registry", () => {
    it("registers exactly the three write routes", () => {
      const routes = createGraphsPlanningWritesRoutes(start().dependencies);
      expect(Object.keys(routes).sort()).toEqual([
        "POST /api/diff-branches",
        "POST /api/load-graph",
        "POST /api/plan-graph"
      ]);
    });

    it.each([
      ["POST /api/load-graph", '{"repo":"octo/app"}'],
      ["POST /api/plan-graph", '{"repo":"octo/app"}'],
      [
        "POST /api/diff-branches",
        '{"repo":"octo/app","base":"main","head":"main"}'
      ]
    ])("dispatches %s to its handler", async (key, body) => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });
      const routes = createGraphsPlanningWritesRoutes(harness.dependencies);
      const { recording, response } = recorder();
      await routes[key]?.(
        createRequestContext(request(body), response, "panel-a", new Map())
      );
      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body).needsAppBicep).toBe(true);
    });
  });
});
