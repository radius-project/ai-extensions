import { describe, expect, it } from "vitest";
import {
  computeGraphDiff,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "@radius-project/core";
import {
  createGraphPlanningWorkflows,
  type GraphPlanningWorkflows,
  type GraphWorkflowDependencies,
  type GraphWorkflowOutcome
} from "./graph-workflows.js";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "../../graph-progress-contract.js";
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
import type {
  CanvasGraphResource,
  CanvasState,
  GraphBuildEvent
} from "../../shared.js";

// `record`, `optionalString` and `errorMessage` are module-private in
// `server.ts`, so they are mirrored here verbatim rather than exported solely
// for a test — the same approach `graphs-planning.test.ts` takes with
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
  recipePackThrows?: Error;
  recipeOutputsThrows?: Error;
  selectThrows?: Record<string, Error>;
  // Every path on a branch, keyed by branch. Empty models a tree that could not
  // be read, which is what the default leaves in place.
  branchPaths?: Record<string, string[]>;
  compileThrows?: Record<string, Error>;
  stageLogs?: Record<string, string>;
  compileLogs?: Record<string, string>;
  // Runs after the named stage, so a test can move the world on mid-request.
  afterStage?: () => void;
  afterCompile?: () => void;
}

interface Harness {
  state: CanvasState;
  entry: GraphInstanceEntry;
  dependencies: GraphWorkflowDependencies;
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
  // Everything the workflows sent to the diagnostics sink instead of the canvas.
  loggedErrors: string[];
  workflows: GraphPlanningWorkflows;
  setEntryMissing(missing: boolean): void;
  advanceClock(ms: number): void;
  run(
    workflow: keyof GraphPlanningWorkflows,
    body: string
  ): Promise<GraphWorkflowOutcome>;
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
  // A controllable clock, so a build record's elapsed time is asserted rather
  // than observed. Starts at a non-zero instant so a record that failed to
  // capture a start time is distinguishable from one that started at 0.
  let clockMs = 1_000;
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
  const loggedErrors: string[] = [];

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
    stageArtifacts: ({ branch, log }: StageArtifactsInput) => {
      order.push(`stage:${branch}`);
      const staged = requireScripted(
        harnessScript.staged,
        branch,
        "stageArtifacts"
      );
      const detail = harnessScript.stageLogs?.[branch];
      if (detail) log?.(detail);
      harnessScript.afterStage?.();
      return Promise.resolve(staged);
    },
    compileResources: ({ selection, log }: CompileResourcesInput) => {
      order.push(`compile:${selection.branch}`);
      const failure = harnessScript.compileThrows?.[selection.branch];
      if (failure) return Promise.reject(failure);
      const compiled = requireScripted(
        harnessScript.compiled,
        selection.branch,
        "compileResources"
      );
      const detail = harnessScript.compileLogs?.[selection.branch];
      if (detail) log?.(detail);
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

  const dependencies: GraphWorkflowDependencies = {
    readInstanceEntry: () => (entryMissing ? undefined : entry),
    pipeline,
    triggerAppBicepHandoff: (handoffEntry, repo, branches, page) => {
      handoffs.push({ repo, branches, page, hasEntry: !!handoffEntry });
    },
    listBranchPaths: (_entry, _repo, branch) =>
      Promise.resolve(harnessScript.branchPaths?.[branch] ?? []),
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
      if (harnessScript.recipePackThrows) {
        return Promise.reject(harnessScript.recipePackThrows);
      }
      return Promise.resolve(recipes);
    },
    resolveRecipeOutputs: (resources, packRecipes, provider) => {
      recipeResolutions.push({ resources, recipes: packRecipes, provider });
      if (harnessScript.recipeOutputsThrows) {
        return Promise.reject(harnessScript.recipeOutputsThrows);
      }
      return Promise.resolve(plannedOutputs);
    },
    computeGraphDiff: (baseResources, headResources) =>
      computeGraphDiff(baseResources, headResources) as CanvasGraphResource[],
    record,
    optionalString,
    errorMessage,
    logError: (message) => {
      loggedErrors.push(message);
    },
    now: () => clockMs
  };

  const workflows = createGraphPlanningWorkflows(dependencies);

  return {
    state,
    entry,
    dependencies,
    workflows,
    script: harnessScript,
    advanceClock(ms: number) {
      clockMs += ms;
    },
    order,
    handoffs,
    recipePackCalls,
    recipeResolutions,
    recipes,
    plannedOutputs,
    loggedErrors,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    run(workflow, body) {
      return workflows[workflow]({ instanceId: "panel-a", body });
    }
  };
}

function messages(state: CanvasState): string[] {
  return (
    latestProgressRecord(state)?.graphBuildEvents.map(
      (event) => event.detail
    ) ?? []
  );
}

function stages(state: CanvasState): string[] {
  return (latestProgressRecord(state)?.graphBuildEvents ?? []).map(
    (event) => `${event.stage}:${event.state}`
  );
}

function latestProgressRecord(state: CanvasState) {
  return Object.values(state.graphProgressRecords ?? {}).at(-1);
}

function replaceProgressRecord(
  state: CanvasState,
  view: "graph" | "planned" | "diff",
  event: GraphBuildEvent
): void {
  const record = state.graphProgressRecords?.[view];
  if (!record) throw new Error(`Missing ${view} progress record.`);
  record.graphProgressGeneration = 42;
  record.graphBuildEvents = [event];
}

describe("graph planning workflows", () => {
  describe("POST /api/load-graph", () => {
    it("answers 400 with the parse failure for a malformed body", async () => {
      const harness = start();
      const outcome = await harness.run("loadGraph", "{not json");
      expect(outcome.status).toBe(400);
      expect(outcome.kind).toBe("json");
      expect(outcome.payload.error).toContain("JSON");
      expect(harness.loggedErrors).toEqual([]);
    });

    it("answers 503 without a Content-Type when the instance entry is gone", async () => {
      const harness = start();
      harness.setEntryMissing(true);
      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');
      expect(outcome.status).toBe(503);
      expect(outcome.kind).toBe("bare");
      expect(JSON.stringify(outcome.payload)).toBe(
        '{"error":"Canvas server state is unavailable."}'
      );
    });

    it("claims the build generation before rejecting an empty repo", async () => {
      const harness = start();
      harness.state.graphBuildGeneration = 4;
      const outcome = await harness.run("loadGraph", "{}");
      expect(outcome.status).toBe(200);
      expect(JSON.stringify(outcome.payload)).toBe(
        '{"error":"Please select a repository."}'
      );
      // The claim happens first, so an in-flight compile is invalidated even by
      // a request that goes no further than this.
      expect(harness.state.graphBuildGeneration).toBe(5);
      expect(harness.order).toEqual([]);
    });

    it("hands off to the app-bicep skill when the branch has no app.bicep", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });
      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');
      expect(outcome.status).toBe(200);
      expect(outcome.payload).toEqual({
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
        "Checking octo/app for .radius/app.bicep.",
        "No application model exists yet.",
        "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
      ]);
    });

    it("still hands off when the branch tree cannot be read", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) },
        branchPaths: { main: [] }
      });
      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');
      expect(outcome.payload).toMatchObject({ needsAppBicep: true });
      expect(harness.handoffs).toHaveLength(1);
    });

    it("hands off when the branch has a Dockerfile the skill can build from", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) },
        branchPaths: { main: ["README.md", "services/api/Dockerfile"] }
      });
      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');
      expect(outcome.payload).toMatchObject({ needsAppBicep: true });
      expect(harness.handoffs).toHaveLength(1);
    });

    it("refuses instead of handing off when the branch has no Dockerfile", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) },
        branchPaths: {
          main: ["README.md", "src/index.ts", ".devcontainer/Dockerfile"]
        }
      });
      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');
      expect(outcome.status).toBe(200);
      expect(outcome.payload).toEqual({
        error: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
        appBicepUnsupported: true,
        repo: "octo/app",
        branch: "main"
      });
      expect(harness.handoffs).toEqual([]);
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for .radius/app.bicep.",
        "No application model exists yet.",
        "Copilot is creating .radius/app.bicep with the Radius app-bicep skill.",
        UNSUPPORTED_NO_DOCKERFILE_MESSAGE
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
        stageLogs: { "feature/x": "Staged local model artifacts." },
        jsonPath: "/ws/infra/app-graph.json",
        definitionHash: "hash-x"
      });
      harness.state.workspaceBranch = "feature/x";

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(200);
      expect(outcome.kind).toBe("json");
      expect(outcome.payload).toEqual({
        reload: true,
        resources: [{ id: "res-a" }],
        fromWorkspace: true
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
        "Checking octo/app for .radius/app.bicep.",
        "Found the application model.",
        "Staged local model artifacts.",
        "Compiling the application model and building the resource graph.",
        "Built a graph with 1 resource(s).",
        "Laying out and rendering the application graph.",
        "Rendered the application graph."
      ]);
      expect(stages(harness.state)).toEqual([
        "checking_model:running",
        "checking_model:succeeded",
        "building_graph:running",
        "building_graph:running",
        "building_graph:succeeded",
        "rendering_graph:running",
        "rendering_graph:succeeded"
      ]);
    });

    it("reports reload false for an explicit refresh", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });
      const outcome = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","refresh":true}'
      );
      expect(outcome.payload).toEqual({
        reload: false,
        resources: [],
        fromWorkspace: false
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

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      // 409 here is written without a Content-Type, unlike the two post-compile
      // stale exits below.
      expect(outcome.kind).toBe("bare");
      expect(JSON.stringify(outcome.payload)).toBe('{"stale":true}');
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

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(JSON.stringify(outcome.payload)).toBe('{"stale":true}');
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
        graphFromWorkspace: true,
        graphDefinitionHash: "hash-a",
        graphResources: [{ id: "cached" }] as CanvasGraphResource[]
      });

      const outcome = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","refresh":true}'
      );

      expect(outcome.status).toBe(200);
      expect(outcome.payload).toEqual({
        reload: false,
        resources: [{ id: "cached" }],
        fromWorkspace: false,
        cached: true
      });
      // Persisted provenance follows the response, so the next page render
      // cannot contradict what this request just reported.
      expect(harness.state.graphFromWorkspace).toBe(false);
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

      const outcome = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","refresh":true}'
      );

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({ error: "EBUSY" });
      expect(harness.loggedErrors).toEqual([]);
    });

    // Issue #475: the graph pages render a failed load as graph content, so
    // rad's Bicep diagnostics used to appear in the canvas where the
    // application graph belongs.
    it("keeps rad's Bicep validation output out of the response and the progress stages", async () => {
      const radOutput = [
        "rad app graph failed: rad exited with code 1",
        '/tmp/rad-bicep-abc/app.bicep(31,5) : Error BCP035: The specified "object" declaration is missing the following required properties: "application".',
        '/tmp/rad-bicep-abc/app.bicep(42,18) : Error BCP062: The referenced declaration with name "redis" is not valid.',
        "Compiled with radius extension: br:ghcr.io/radius-project/bicep-types-radius:latest"
      ].join("\n");
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: false } },
        compileThrows: { main: new Error(radOutput) }
      });

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({
        error: GRAPH_MODELING_FAILURE_MESSAGE
      });
      expect(messages(harness.state)).not.toContain(radOutput);
      expect(
        messages(harness.state).some((detail) => detail.includes("BCP035"))
      ).toBe(false);
      expect(stages(harness.state).at(-1)).toBe("building_graph:failed");
      expect(harness.state.graphLoaded).toBeUndefined();
      expect(harness.loggedErrors).toEqual([
        `[radius graph] modeling failed: ${radOutput}`
      ]);
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

      const outcome = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","refresh":true}'
      );

      expect(outcome.payload.resources).toEqual([{ id: "fresh" }]);
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

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.kind).toBe("json");
      expect(JSON.stringify(outcome.payload)).toBe('{"stale":true}');
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

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      // "Mapped N resource(s)" is generation-gated and must not appear.
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for .radius/app.bicep.",
        "Found the application model.",
        "Compiling the application model and building the resource graph."
      ]);
    });

    it("does not append modeled events after another workflow owns progress", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterStage: () => {
          replaceProgressRecord(harness.state, "graph", {
            sequence: 1,
            stage: "resolving_recipes",
            state: "running",
            detail: "A replacement modeled request owns the progress stream."
          });
        }
      });

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(messages(harness.state)).toEqual([
        "A replacement modeled request owns the progress stream."
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

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.kind).toBe("json");
      expect(JSON.stringify(outcome.payload)).toBe('{"stale":true}');
      expect(harness.state.graphTargetRepo).toBeUndefined();
    });
  });

  describe("POST /api/plan-graph", () => {
    it("answers 400 for a malformed body and 503 without a Content-Type for a missing entry", async () => {
      const malformed = await start().run("planGraph", "nope");
      expect(malformed.status).toBe(400);

      const harness = start();
      harness.setEntryMissing(true);
      const missing = await harness.run("planGraph", '{"repo":"octo/app"}');
      expect(missing.status).toBe(503);
      expect(missing.kind).toBe("bare");
    });

    it("hands off as the graph page when the branch has no app.bicep", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });

      const outcome = await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(200);
      expect(outcome.payload).toEqual({
        error:
          "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
        needsAppBicep: true,
        repo: "octo/app",
        branch: "main"
      });
      // "graph", not "planned": the handoff key is derived from the page.
      expect(harness.handoffs[0]?.page).toBe("graph");
    });

    it("refuses the plan when the branch has no Dockerfile", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) },
        branchPaths: { main: ["README.md"] }
      });

      const outcome = await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(outcome.payload).toEqual({
        error: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
        appBicepUnsupported: true,
        repo: "octo/app",
        branch: "main"
      });
      expect(harness.handoffs).toEqual([]);
      expect(stages(harness.state)).toContain("creating_model:failed");
    });

    it("resolves recipes for the default provider and records the planned view", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] },
        compileLogs: { main: "Compiled the Radius model." }
      });
      harness.recipes.push({
        resourceType: "Radius.Data/redisCaches",
        concreteResources: [{ type: "Microsoft.Cache/redis" }]
      });
      harness.plannedOutputs.push({ id: "res-a" }, { id: "redis" });

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","environment":"prod"}'
      );

      expect(outcome.status).toBe(200);
      expect(JSON.stringify(outcome.payload)).toBe('{"reload":true}');
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
        "Checking octo/app for .radius/app.bicep.",
        "Found the application model.",
        "Compiling the application model and building the resource graph.",
        "Compiled the Radius model.",
        "Built a graph with 1 resource(s).",
        "Resolving azure recipes for the planned resources.",
        "Resolved 2 planned resource(s).",
        "Laying out and rendering the planned graph.",
        "Rendered the planned graph."
      ]);
      expect(stages(harness.state)).toEqual([
        "checking_model:running",
        "checking_model:succeeded",
        "building_graph:running",
        "building_graph:running",
        "building_graph:succeeded",
        "resolving_recipes:running",
        "resolving_recipes:succeeded",
        "rendering_graph:running",
        "rendering_graph:succeeded"
      ]);
    });

    it("does not append planned events after another workflow owns progress", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          replaceProgressRecord(harness.state, "planned", {
            sequence: 1,
            stage: "resolving_recipes",
            state: "running",
            detail: "A replacement plan owns the progress stream."
          });
        }
      });

      await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(messages(harness.state)).toEqual([
        "A replacement plan owns the progress stream."
      ]);
    });

    it("carries an explicit provider through both recipe seams", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] }
      });

      await harness.run("planGraph", '{"repo":"octo/app","provider":"aws"}');

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
      await harness.run("planGraph", body);
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

      await harness.run("planGraph", '{"repo":"octo/app"}');

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

      await harness.run("planGraph", '{"repo":"octo/app"}');

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

      const outcome = await harness.run("planGraph", "{}");

      expect(outcome.status).toBe(200);
      expect(harness.state.plannedRepo).toBe("");
      expect(messages(harness.state)[0]).toBe(
        "Checking  for .radius/app.bicep."
      );
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

      const outcome = await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.kind).toBe("json");
      expect(JSON.stringify(outcome.payload)).toBe('{"stale":true}');
      expect(harness.state.plannedRepo).toBeUndefined();
      expect(messages(harness.state)).not.toContain(
        "Laying out and rendering the planned graph."
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

      const outcome = await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.kind).toBe("json");
      expect(harness.state.plannedRepo).toBeUndefined();
    });
  });

  describe("POST /api/diff-branches", () => {
    const diffBody = '{"repo":"octo/app","base":"main","head":"feature/x"}';

    it("answers 400 without recording a diff error when the body will not parse", async () => {
      const harness = start();
      const outcome = await harness.run("diffBranches", "{oops");
      expect(outcome.status).toBe(400);
      // No source-ref context was ever prepared, so nothing claims the view.
      expect(harness.state.diffError).toBeUndefined();
    });

    it("answers 503 without a Content-Type when the instance entry is gone", async () => {
      const harness = start();
      harness.setEntryMissing(true);
      const outcome = await harness.run("diffBranches", diffBody);
      expect(outcome.status).toBe(503);
      expect(outcome.kind).toBe("bare");
    });

    it("hands both branches off when neither has an app.bicep", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main", content: null }),
          "feature/x": selectionOf({ branch: "feature/x", content: null })
        }
      });

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(200);
      // No `branch` key, unlike the single-branch routes.
      expect(outcome.payload).toEqual({
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

    it("still hands both branches off when only one side lacks a Dockerfile", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main", content: null }),
          "feature/x": selectionOf({ branch: "feature/x", content: null })
        },
        branchPaths: {
          main: ["README.md"],
          "feature/x": ["README.md", "Dockerfile"]
        }
      });

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.payload).toMatchObject({ needsAppBicep: true });
      expect(harness.handoffs).toHaveLength(1);
    });

    it("refuses the diff when neither branch has a Dockerfile", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main", content: null }),
          "feature/x": selectionOf({ branch: "feature/x", content: null })
        },
        branchPaths: {
          main: ["README.md"],
          "feature/x": ["README.md", "src/index.ts"]
        }
      });

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(200);
      expect(outcome.payload).toEqual({
        error: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
        appBicepUnsupported: true,
        repo: "octo/app"
      });
      expect(harness.handoffs).toEqual([]);
      expect(stages(harness.state)).toEqual([
        "checking_model:running",
        "checking_model:succeeded",
        "creating_model:running",
        "creating_model:failed"
      ]);
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

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(200);
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
      expect(outcome.payload).toEqual({
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
      expect(stages(harness.state)).toEqual([
        "checking_model:running",
        "checking_model:succeeded",
        "building_base_graph:running",
        "building_base_graph:succeeded",
        "building_head_graph:running",
        "building_head_graph:succeeded",
        "comparing_graphs:running",
        "comparing_graphs:succeeded",
        "rendering_graph:running",
        "rendering_graph:succeeded"
      ]);
    });

    it("does not append diff events after another workflow owns progress", async () => {
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
          replaceProgressRecord(harness.state, "diff", {
            sequence: 1,
            stage: "comparing_graphs",
            state: "running",
            detail: "A replacement diff owns the progress stream."
          });
        }
      });

      await harness.run(
        "diffBranches",
        '{"repo":"octo/app","base":"main","head":"feature/x"}'
      );

      expect(messages(harness.state)).toEqual([
        "A replacement diff owns the progress stream."
      ]);
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

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(200);
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

      const outcome = await harness.run(
        "diffBranches",
        '{"base":"main","head":"feature/x"}'
      );

      expect(outcome.status).toBe(200);
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

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(409);
      expect(outcome.kind).toBe("json");
      expect(JSON.stringify(outcome.payload)).toBe('{"stale":true}');
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

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(400);
      expect(outcome.kind).toBe("json");
      expect(outcome.payload).toEqual({
        error: GRAPH_MODELING_FAILURE_MESSAGE
      });
      // The compare page reads `diffError` straight into its markup, so the
      // recorded failure is the same short sentence, not rad's output.
      expect(harness.state.diffError).toBe(GRAPH_MODELING_FAILURE_MESSAGE);
      expect(harness.loggedErrors).toEqual([
        "[radius graph] modeling failed: rad exited 1"
      ]);
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

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(400);
      // The failure belongs to a selection no longer on screen, so it must not
      // paint an error over the newer one.
      expect(harness.state.diffError).toBeUndefined();
    });
  });

  // Every external boundary these workflows reach can fail: model selection and
  // compilation isolate the `rad` binary, and the recipe seams reach GitHub.
  // Each must surface as an explicit 400 carrying the underlying message, with
  // no partially committed state left behind — never a success-shaped fallback.
  describe("external failure contracts", () => {
    const planBody = '{"repo":"octo/app","branch":"main","provider":"azure"}';

    function planHarness(script: Partial<PipelineScript>) {
      return start({
        selections: { main: selectionOf({ branch: "main" }) },
        staged: { main: { dir: "/tmp/stage", remote: true } },
        compiled: { main: [] },
        ...script
      });
    }

    it("surfaces a recipe-pack fetch failure as 400 and commits no planned state", async () => {
      const harness = planHarness({
        recipePackThrows: new Error("recipe pack fetch failed: 502")
      });

      const outcome = await harness.run("planGraph", planBody);

      expect(outcome.status).toBe(400);
      expect(outcome.kind).toBe("json");
      expect(outcome.payload).toEqual({
        error: "recipe pack fetch failed: 502"
      });
      expect(harness.recipePackCalls).toEqual(["azure"]);
      // The resolution stage must never run on a pack that failed to load.
      expect(harness.recipeResolutions).toEqual([]);
      expect(harness.state.plannedRepo).toBeUndefined();
      expect(harness.state.resolvedRecipes).toBeUndefined();
      expect(harness.state.activeGraphView).toBeUndefined();
      expect(harness.loggedErrors).toEqual([]);
      expect(
        harness.state.graphProgressRecords?.planned?.graphBuildEvents.at(-1)
      ).toEqual({
        sequence: 6,
        stage: "resolving_recipes",
        state: "failed",
        detail: "recipe pack fetch failed: 502"
      });
    });

    it("surfaces a recipe-output resolution failure as 400 and commits no planned state", async () => {
      const harness = planHarness({
        recipeOutputsThrows: new Error("recipe outputs unavailable")
      });

      const outcome = await harness.run("planGraph", planBody);

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({ error: "recipe outputs unavailable" });
      expect(harness.recipeResolutions).toHaveLength(1);
      expect(harness.state.plannedRepo).toBeUndefined();
      expect(harness.state.plannedProvider).toBeUndefined();
      expect(harness.state.resolvedRecipes).toBeUndefined();
    });

    it("surfaces a model-selection failure as 400 before any artifact is staged", async () => {
      const harness = planHarness({
        selectThrows: { main: new Error("app.bicep lookup failed") }
      });

      const outcome = await harness.run("planGraph", planBody);

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({ error: "app.bicep lookup failed" });
      expect(harness.order).toEqual(["select:main"]);
      expect(harness.handoffs).toEqual([]);
      expect(harness.state.plannedRepo).toBeUndefined();
      expect(harness.loggedErrors).toEqual([]);
    });

    it("surfaces a compilation failure as 400 after staging and commits no planned state", async () => {
      const harness = planHarness({
        compileThrows: { main: new Error("rad bicep build-graph exited 1") }
      });

      const outcome = await harness.run("planGraph", planBody);

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({
        error: GRAPH_MODELING_FAILURE_MESSAGE
      });
      // rad's Bicep diagnostics are the exact text issue #475 kept out of the
      // graph surface: they survive only in the server log.
      expect(harness.loggedErrors).toEqual([
        "[radius graph] modeling failed: rad bicep build-graph exited 1"
      ]);
      expect(harness.order).toEqual([
        "select:main",
        "stage:main",
        "compile:main"
      ]);
      expect(harness.recipePackCalls).toEqual([]);
      expect(harness.state.plannedRepo).toBeUndefined();
    });

    it("surfaces a non-Error rejection as its string form", async () => {
      const harness = planHarness({
        recipePackThrows: "recipe pack offline" as unknown as Error
      });

      const outcome = await harness.run("planGraph", planBody);

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({ error: "recipe pack offline" });
      expect(harness.loggedErrors).toEqual([]);
    });
  });

  // The build record is what survives the page. A user can leave a graph page
  // mid-build and come back, and the app.bicep wait runs entirely outside the
  // panel, so the server owns when the build started, whether it is still
  // running, and which view it belongs to.
  describe("build record lifecycle", () => {
    function successHarness(): Harness {
      return start({
        selections: { main: selectionOf({}) },
        staged: { main: { dir: "/ws/.radius", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] }
      });
    }

    it("opens a record naming the view and the instant work began", async () => {
      const harness = successHarness();
      harness.advanceClock(4_000);

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(harness.state.graphProgressRecords?.graph?.graphProgressView).toBe(
        "graph"
      );
      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressStartedAtMs
      ).toBe(5_000);
    });

    it("closes the record once the build finishes", async () => {
      const harness = successHarness();

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressActive
      ).toBe(false);
      // The stages stay readable: a page that returns after the build ended
      // should see what happened rather than an empty panel.
      expect(stages(harness.state).length).toBeGreaterThan(0);
    });

    it("closes the record when the build fails", async () => {
      const harness = start({
        selections: { main: selectionOf({}) },
        staged: { main: { dir: "/ws/.radius", remote: false } },
        compileThrows: { main: new Error("the compiler is unavailable") }
      });

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(400);
      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressActive
      ).toBe(false);
    });

    // The wait for Copilot to author .radius/app.bicep genuinely continues off
    // page, so the record stays open and keeps narrating it.
    it("leaves the record open while app.bicep is being authored", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressActive
      ).toBe(true);
      expect(harness.state.graphProgressRecords?.graph?.graphProgressView).toBe(
        "graph"
      );
    });

    // The page polls for the model every few seconds. Each poll used to open a
    // fresh record, which reset the elapsed clock to zero and discarded the
    // stages already reported — the reset a user sees on returning to the page.
    it("continues the open record instead of restarting it on a repeat request", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });

      await harness.run("loadGraph", '{"repo":"octo/app"}');
      const generation =
        harness.state.graphProgressRecords?.graph?.graphProgressGeneration;
      const startedAt =
        harness.state.graphProgressRecords?.graph?.graphProgressStartedAtMs;
      const reported = stages(harness.state);
      harness.advanceClock(10_000);

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressGeneration
      ).toBe(generation);
      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressStartedAtMs
      ).toBe(startedAt);
      expect(stages(harness.state)).toEqual(reported);
    });

    it("closes the model-creation stage when a retry finds app.bicep", async () => {
      const selections = {
        main: selectionOf({ content: null })
      };
      const harness = start({
        selections,
        staged: { main: { dir: "/ws/.radius", remote: false } },
        compiled: { main: [] }
      });
      await harness.run("loadGraph", '{"repo":"octo/app"}');
      selections.main = selectionOf();

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(stages(harness.state)).toContain("creating_model:succeeded");
      const latestByStage = new Map(
        harness.state.graphProgressRecords?.graph?.graphBuildEvents.map(
          (event) => [event.stage, event]
        )
      );
      expect(
        [...latestByStage.values()].map((event) => event.state)
      ).not.toContain("running");
    });

    it("does not let a replaced branch request close the replacement wait", async () => {
      let harness!: Harness;
      let replacement: Promise<GraphWorkflowOutcome> | undefined;
      let replaced = false;
      harness = start({
        selections: {
          main: selectionOf(),
          "feature/x": selectionOf({
            branch: "feature/x",
            content: null
          })
        },
        staged: { main: { dir: "/ws/.radius", remote: false } },
        compiled: { main: [] },
        afterStage: () => {
          if (replaced) return;
          replaced = true;
          replacement = harness.run(
            "loadGraph",
            '{"repo":"octo/app","branch":"feature/x"}'
          );
        }
      });

      const superseded = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","branch":"main"}'
      );
      await replacement;

      expect(superseded.status).toBe(409);
      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressActive
      ).toBe(true);
      expect(
        harness.state.graphProgressRecords?.graph?.graphProgressAwaitingModel
      ).toBe(true);
      expect(harness.state.graphProgressRecords?.graph?.graphProgressKey).toBe(
        JSON.stringify({ repo: "octo/app", branch: "feature/x" })
      );
      expect(stages(harness.state)).toContain("creating_model:running");
    });

    it("keeps an open modeled record when another view starts", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });

      await harness.run("loadGraph", '{"repo":"octo/app"}');
      const graphRecord = harness.state.graphProgressRecords?.graph;
      harness.advanceClock(10_000);

      await harness.run(
        "diffBranches",
        '{"repo":"octo/app","base":"main","head":"main"}'
      );

      expect(harness.state.graphProgressRecords?.graph).toBe(graphRecord);
      expect(graphRecord?.graphProgressActive).toBe(true);
      expect(graphRecord?.graphProgressStartedAtMs).toBe(1_000);
      expect(
        harness.state.graphProgressRecords?.diff?.graphProgressStartedAtMs
      ).toBe(11_000);
    });

    it("names the planned view for a plan request", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });

      await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(
        harness.state.graphProgressRecords?.planned?.graphProgressView
      ).toBe("planned");
    });
  });
});
