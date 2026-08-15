import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { computeGraphDiff } from "@radius-project/core";
import { createRequestContext } from "../request-context.js";
import {
  handleDiffBranches,
  handleLoadGraph,
  handlePlanGraph
} from "./graphs-planning-writes.js";
import { createGraphPlanningWorkflows } from "./graph-workflows.js";
import {
  createGraphPipeline,
  type AppBicepSelection,
  type GraphInstanceEntry
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
import {
  legacyDiffBranches,
  legacyLoadGraph,
  legacyPlanGraph,
  type LegacyEntry,
  type LegacyGraphSeams,
  type LegacyRadArtifacts
} from "../../../test/fixtures/legacy-graph-planning-arms.js";

// Legacy-versus-migrated differential coverage.
//
// `graph-workflows.test.ts` pins each rung of the migrated implementation, but a
// green rung suite cannot prove that a ~470-line transcription kept every state
// write, every call, and every header. Those three things are exactly what a
// transcription loses silently, and the arms it replaced were deleted in the
// same change, so nothing else compares them.
//
// Each scenario therefore runs twice against two *independent* worlds built from
// the same seam fakes: once through the deleted arm (transcribed in
// `test/fixtures/legacy-graph-planning-arms.ts` from commit f8757c1~1) and once
// through the real production stack — the route adapter over the real workflow
// service over the real pipeline. Then it asserts the two agree on the wire
// response (status, header order, body bytes), the complete resulting state, the
// full seam call order, and the handoffs raised.
//
// The fakes are deliberately at *legacy* granularity (`fetchBicepSelection`,
// `radArtifactsDirForSelection`, `buildGraphViaRad`, ...). If the oracle were
// driven through `GraphPipeline` it would inherit the decomposition under test
// and prove nothing about it.

interface Recording {
  headerOrder: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = { headerOrder: [], status: 0, body: "" };
  const seen = new Set<string>();
  const target = {
    setHeader(name: string) {
      if (!seen.has(name)) {
        seen.add(name);
        recording.headerOrder.push(name);
      }
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
  return { recording, target };
}

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

interface World {
  state: CanvasState;
  entry: LegacyEntry & GraphInstanceEntry;
  order: string[];
  handoffs: HandoffCall[];
  recording: Recording;
  response: ServerResponse<IncomingMessage>;
  seams: LegacyGraphSeams;
}

interface Script {
  selections: Record<string, AppBicepSelection>;
  staged: Record<string, LegacyRadArtifacts>;
  compiled: Record<string, CanvasGraphResource[]>;
  jsonPath?: string;
  definitionHash?: string;
  fingerprint?: string;
  recipes?: unknown[];
  plannedOutputs?: unknown[];
  entryMissing?: boolean;
  selectThrows?: Record<string, Error>;
  compileThrows?: Record<string, Error>;
  removeThrows?: Error;
  recipePackThrows?: Error;
  recipeOutputsThrows?: Error;
  seedState?: (state: CanvasState) => void;
  afterStage?: (world: World) => void;
  afterCompile?: (world: World) => void;
}

const GITHUB_SENTINEL = { client: "github" };

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

// Builds one isolated world. Both sides of a differential get their own, so
// their state objects and call logs can be compared rather than shared.
function makeWorld(script: Script): World {
  const state: CanvasState = {};
  script.seedState?.(state);
  const entry = { state } as LegacyEntry & GraphInstanceEntry;
  const servers = new Map<string, LegacyEntry>();
  if (!script.entryMissing) servers.set("panel-a", entry);
  const order: string[] = [];
  const handoffs: HandoffCall[] = [];
  const { recording, target } = recorder();

  function requireScripted<T>(
    table: Record<string, T>,
    key: string,
    stage: string
  ): T {
    const value = table[key];
    if (!value) throw new Error(`unscripted ${stage} for branch: ${key}`);
    return value;
  }

  const world = {
    state,
    entry,
    order,
    handoffs,
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  } as World;

  world.seams = {
    servers,
    github: GITHUB_SENTINEL,
    fetchBicepSelection: (_entry, _repo, branch) => {
      order.push(`select:${branch}`);
      const failure = script.selectThrows?.[branch];
      if (failure) return Promise.reject(failure);
      return Promise.resolve(
        requireScripted(script.selections, branch, "fetchBicepSelection")
      );
    },
    radArtifactsDirForSelection: (request) => {
      // Asserting `github` here proves the composition root still binds the
      // client into the staging seam rather than the pipeline holding one.
      if (request.github !== GITHUB_SENTINEL) {
        throw new Error("staging seam lost its github client");
      }
      order.push(
        `stage:${request.branch}:local=${request.isLocal}:path=${request.bicepRepoPath}`
      );
      const staged = requireScripted(
        script.staged,
        request.branch,
        "radArtifactsDirForSelection"
      );
      script.afterStage?.(world);
      return Promise.resolve(staged);
    },
    buildGraphViaRad: (content, definitionFile, options) => {
      const branch = Object.keys(script.selections).find(
        (key) => script.selections[key]?.content === content
      );
      order.push(
        `compile:${branch}:file=${definitionFile}:json=${
          options.saveGraphJsonTo || ""
        }:dir=${options.radArtifactsDir || ""}:cleanup=${!!options.cleanupRadArtifactsDir}`
      );
      const failure = branch ? script.compileThrows?.[branch] : undefined;
      if (failure) return Promise.reject(failure);
      const compiled = requireScripted(
        script.compiled,
        branch || "",
        "buildGraphViaRad"
      );
      script.afterCompile?.(world);
      return Promise.resolve(compiled);
    },
    canvasGraphResources: (values) => values as CanvasGraphResource[],
    workspaceGraphJsonPath: (_state, bicepPath) => {
      order.push(`jsonPath:${bicepPath}`);
      return script.jsonPath || "";
    },
    graphDefinitionHash: (_content, fingerprint) => {
      order.push(`hash:${fingerprint}`);
      return script.definitionHash || "hash-a";
    },
    radArtifactsFingerprint: (dir) => {
      order.push(`fingerprint:${dir || ""}`);
      return script.fingerprint || "fp-a";
    },
    rmSync: (dir) => {
      order.push(`remove:${dir}`);
      if (script.removeThrows) throw script.removeThrows;
    },
    triggerAppBicepHandoff: (handoffEntry, repo, branches, page) => {
      order.push(`handoff:${page}`);
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
    fetchRecipePack: (github, provider) => {
      if (github !== GITHUB_SENTINEL) {
        throw new Error("recipe pack seam lost its github client");
      }
      order.push(`recipePack:${provider}`);
      if (script.recipePackThrows)
        return Promise.reject(script.recipePackThrows);
      return Promise.resolve(script.recipes || []);
    },
    resolveRecipeOutputs: (github, resources, recipes, provider) => {
      if (github !== GITHUB_SENTINEL) {
        throw new Error("recipe outputs seam lost its github client");
      }
      order.push(
        `recipeOutputs:${provider}:resources=${resources.length}:recipes=${recipes.length}`
      );
      if (script.recipeOutputsThrows) {
        return Promise.reject(script.recipeOutputsThrows);
      }
      return Promise.resolve(script.plannedOutputs || []);
    },
    computeGraphDiff: (baseResources, headResources) =>
      computeGraphDiff(baseResources, headResources) as CanvasGraphResource[],
    record,
    optionalString,
    errorMessage
  };

  return world;
}

type WorkflowName = "loadGraph" | "planGraph" | "diffBranches";

function runLegacy(
  world: World,
  workflow: WorkflowName,
  body: string
): Promise<void> {
  const arm =
    workflow === "loadGraph" ? legacyLoadGraph
    : workflow === "planGraph" ? legacyPlanGraph
    : legacyDiffBranches;
  return arm(world.seams, world.response, "panel-a", body);
}

// The migrated side runs the production composition: the same seams wired into
// the real pipeline, the real workflow service, and the real route adapter.
function runMigrated(
  world: World,
  workflow: WorkflowName,
  body: string
): Promise<void> {
  const seams = world.seams;
  const pipeline = createGraphPipeline({
    fetchBicepSelection: (entry, repo, branch) =>
      seams.fetchBicepSelection(entry, repo, branch),
    resolveRadArtifactsDir: (request) =>
      seams.radArtifactsDirForSelection({
        ...request,
        github: seams.github
      }),
    buildGraphViaRad: (content, definitionFile, options) =>
      seams.buildGraphViaRad(content, definitionFile, options),
    canvasGraphResources: (values) => seams.canvasGraphResources(values),
    workspaceGraphJsonPath: (state, bicepPath) =>
      seams.workspaceGraphJsonPath(state, bicepPath || ""),
    graphDefinitionHash: (content, fingerprint) =>
      seams.graphDefinitionHash(content, fingerprint),
    radArtifactsFingerprint: (dir) => seams.radArtifactsFingerprint(dir),
    removeDirectory: (dir) =>
      seams.rmSync(dir, { recursive: true, force: true })
  });
  const workflows = createGraphPlanningWorkflows({
    readInstanceEntry: (instanceId) =>
      seams.servers.get(instanceId) as GraphInstanceEntry | undefined,
    pipeline,
    triggerAppBicepHandoff: (entry, repo, branches, page) =>
      seams.triggerAppBicepHandoff(entry, repo, branches, page),
    prepareSourceRefResources: seams.prepareSourceRefResources,
    setSourceRefResources: seams.setSourceRefResources,
    isCurrentSourceRefToken: seams.isCurrentSourceRefToken,
    defaultBranchForState: seams.defaultBranchForState,
    canReuseModeledGraph: seams.canReuseModeledGraph,
    addGraphProgress: seams.addGraphProgress,
    beginPlannedGraphRequest: seams.beginPlannedGraphRequest,
    isCurrentPlannedGraphRequest: seams.isCurrentPlannedGraphRequest,
    fetchRecipePack: (provider) =>
      seams.fetchRecipePack(seams.github, provider),
    resolveRecipeOutputs: (resources, recipes, provider) =>
      seams.resolveRecipeOutputs(seams.github, resources, recipes, provider),
    computeGraphDiff: seams.computeGraphDiff,
    record: seams.record,
    optionalString: seams.optionalString,
    errorMessage: seams.errorMessage
  });
  const dependencies = { workflows };
  const request = Object.assign(Readable.from(body ? [body] : []), {
    url: `/api/${workflow}`,
    method: "POST",
    headers: {}
  }) as unknown as IncomingMessage;
  const context = createRequestContext(
    request,
    world.response,
    "panel-a",
    new Map()
  );
  const handler =
    workflow === "loadGraph" ? handleLoadGraph
    : workflow === "planGraph" ? handlePlanGraph
    : handleDiffBranches;
  return handler(context, dependencies);
}

interface Scenario {
  name: string;
  workflow: WorkflowName;
  body: string;
  script: Script;
  // Every scenario states the response it expects, so a differential that
  // agrees only because both sides broke identically still fails.
  expect: { status: number; headerOrder: string[] };
}

const HAPPY_LOAD: Script = {
  selections: { main: selectionOf({ branch: "main" }) },
  staged: { main: { dir: "/tmp/stage-main", remote: true } },
  compiled: { main: [{ id: "app", name: "app" } as CanvasGraphResource] }
};

const scenarios: Scenario[] = [
  {
    name: "load-graph models a branch and commits graph state",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: HAPPY_LOAD,
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph writes app-graph.json back for a workspace selection",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      selections: {
        main: selectionOf({
          branch: "main",
          fromWorkspace: true,
          bicepPath: "infra/app.bicep"
        })
      },
      jsonPath: "/ws/infra/app-graph.json"
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph refuses an empty repo before doing any work",
    workflow: "loadGraph",
    body: '{"repo":""}',
    script: { selections: {}, staged: {}, compiled: {} },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph hands off when the branch has no app.bicep",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      selections: { main: selectionOf({ branch: "main", content: null }) },
      staged: {},
      compiled: {}
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph reuses a cached graph on refresh and discards the staged dir",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main","refresh":true}',
    script: {
      ...HAPPY_LOAD,
      seedState: (state) => {
        state.graphTargetRepo = "octo/app";
        state.graphBranch = "main";
        state.graphLoaded = true;
        state.graphDefinitionHash = "hash-a";
        state.graphResources = [
          { id: "cached", name: "cached" } as CanvasGraphResource
        ];
      }
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph answers a bare 409 when a newer build claimed the generation",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      afterStage: (world) => {
        world.state.graphBuildGeneration =
          (world.state.graphBuildGeneration || 0) + 1;
      }
    },
    expect: { status: 409, headerOrder: [] }
  },
  {
    name: "load-graph answers a 409 with Content-Type when the race is lost after compiling",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      afterCompile: (world) => {
        world.state.graphBuildGeneration =
          (world.state.graphBuildGeneration || 0) + 1;
      }
    },
    expect: { status: 409, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph answers 503 without a Content-Type when the instance is gone",
    workflow: "loadGraph",
    body: '{"repo":"octo/app"}',
    script: {
      selections: {},
      staged: {},
      compiled: {},
      entryMissing: true
    },
    expect: { status: 503, headerOrder: [] }
  },
  {
    name: "load-graph answers 400 for a malformed body",
    workflow: "loadGraph",
    body: "{not json",
    script: { selections: {}, staged: {}, compiled: {} },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph propagates a model-selection failure",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      selectThrows: { main: new Error("app.bicep lookup failed") }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph propagates a compilation failure",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      compileThrows: { main: new Error("rad bicep build-graph exited 1") }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "load-graph surfaces a cleanup failure from the reuse path",
    workflow: "loadGraph",
    body: '{"repo":"octo/app","branch":"main","refresh":true}',
    script: {
      ...HAPPY_LOAD,
      removeThrows: new Error("EBUSY: staged artifacts are locked"),
      seedState: (state) => {
        state.graphTargetRepo = "octo/app";
        state.graphBranch = "main";
        state.graphLoaded = true;
        state.graphDefinitionHash = "hash-a";
        state.graphResources = [];
      }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph resolves recipes and commits planned state",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main","provider":"azure","environment":"dev"}',
    script: {
      ...HAPPY_LOAD,
      recipes: [
        { resourceType: "Radius.Data/redisCaches", concreteResources: ["a"] }
      ],
      plannedOutputs: [{ id: "planned", name: "planned" }]
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph notes pack recipes with no concrete mapping",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main","provider":"aws"}',
    script: {
      ...HAPPY_LOAD,
      recipes: [
        { resourceType: "Radius.Data/redisCaches", concreteResources: [] },
        { resourceType: "Radius.Security/secrets" }
      ],
      plannedOutputs: []
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph hands off when the branch has no app.bicep",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      selections: { main: selectionOf({ branch: "main", content: null }) },
      staged: {},
      compiled: {}
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph answers 503 without a Content-Type when the instance is gone",
    workflow: "planGraph",
    body: '{"repo":"octo/app"}',
    script: { selections: {}, staged: {}, compiled: {}, entryMissing: true },
    expect: { status: 503, headerOrder: [] }
  },
  {
    name: "plan-graph answers 409 when a newer plan claimed the generation",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      recipes: [],
      plannedOutputs: [],
      afterCompile: (world) => {
        beginPlannedGraphRequest(world.state);
      }
    },
    expect: { status: 409, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph propagates a recipe-pack failure",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      recipePackThrows: new Error("recipe pack fetch failed: 502")
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph propagates a recipe-output resolution failure",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      recipes: [],
      recipeOutputsThrows: new Error("recipe outputs unavailable")
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "plan-graph propagates a compilation failure",
    workflow: "planGraph",
    body: '{"repo":"octo/app","branch":"main"}',
    script: {
      ...HAPPY_LOAD,
      compileThrows: { main: new Error("rad bicep build-graph exited 1") }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "diff-branches compares two committed branches",
    workflow: "diffBranches",
    body: '{"repo":"octo/app","base":"main","head":"feature"}',
    script: {
      selections: {
        main: selectionOf({ branch: "main", content: "resource base = {}" }),
        feature: selectionOf({
          branch: "feature",
          content: "resource head = {}"
        })
      },
      staged: {
        main: { dir: "/tmp/stage-base", remote: true },
        feature: { dir: "/tmp/stage-head", remote: false }
      },
      compiled: {
        main: [{ id: "a", name: "a" } as CanvasGraphResource],
        feature: [
          { id: "a", name: "a" } as CanvasGraphResource,
          { id: "b", name: "b" } as CanvasGraphResource
        ]
      }
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "diff-branches hands off when neither branch has an app.bicep",
    workflow: "diffBranches",
    body: '{"repo":"octo/app","base":"main","head":"feature"}',
    script: {
      selections: {
        main: selectionOf({ branch: "main", content: null }),
        feature: selectionOf({ branch: "feature", content: null })
      },
      staged: {},
      compiled: {}
    },
    expect: { status: 200, headerOrder: ["Content-Type"] }
  },
  {
    name: "diff-branches answers 503 without a Content-Type when the instance is gone",
    workflow: "diffBranches",
    body: '{"repo":"octo/app","base":"main","head":"feature"}',
    script: { selections: {}, staged: {}, compiled: {}, entryMissing: true },
    expect: { status: 503, headerOrder: [] }
  },
  {
    name: "diff-branches records diffError for a compilation failure it still owns",
    workflow: "diffBranches",
    body: '{"repo":"octo/app","base":"main","head":"feature"}',
    script: {
      selections: {
        main: selectionOf({ branch: "main", content: "resource base = {}" }),
        feature: selectionOf({
          branch: "feature",
          content: "resource head = {}"
        })
      },
      staged: {
        main: { dir: "/tmp/stage-base", remote: true },
        feature: { dir: "/tmp/stage-head", remote: false }
      },
      compiled: {},
      compileThrows: { main: new Error("rad bicep build-graph exited 1") }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "diff-branches withholds diffError once a newer diff owns the view",
    workflow: "diffBranches",
    body: '{"repo":"octo/app","base":"main","head":"feature"}',
    script: {
      selections: {
        main: selectionOf({ branch: "main", content: "resource base = {}" }),
        feature: selectionOf({
          branch: "feature",
          content: "resource head = {}"
        })
      },
      staged: {
        main: { dir: "/tmp/stage-base", remote: true },
        feature: { dir: "/tmp/stage-head", remote: false }
      },
      compiled: {},
      compileThrows: { main: new Error("rad bicep build-graph exited 1") },
      afterStage: (world) => {
        prepareSourceRefResources(world.entry, "diff", {
          repo: "octo/other",
          baseBranch: "release",
          headBranch: "hotfix"
        });
      }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "diff-branches propagates a model-selection failure",
    workflow: "diffBranches",
    body: '{"repo":"octo/app","base":"main","head":"feature"}',
    script: {
      selections: {
        feature: selectionOf({ branch: "feature", content: "resource h = {}" })
      },
      staged: {},
      compiled: {},
      selectThrows: { main: new Error("base branch lookup failed") }
    },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  },
  {
    name: "diff-branches answers 400 for a malformed body",
    workflow: "diffBranches",
    body: "",
    script: { selections: {}, staged: {}, compiled: {} },
    expect: { status: 400, headerOrder: ["Content-Type"] }
  }
];

describe("graphs-planning writes: legacy versus migrated", () => {
  it.each(scenarios)("$name", async (scenario) => {
    const legacy = makeWorld(scenario.script);
    const migrated = makeWorld(scenario.script);

    await runLegacy(legacy, scenario.workflow, scenario.body);
    await runMigrated(migrated, scenario.workflow, scenario.body);

    expect(legacy.recording.status).toBe(scenario.expect.status);
    expect(legacy.recording.headerOrder).toEqual(scenario.expect.headerOrder);

    expect(migrated.recording).toEqual(legacy.recording);
    expect(migrated.state).toEqual(legacy.state);
    expect(migrated.order).toEqual(legacy.order);
    expect(migrated.handoffs).toEqual(legacy.handoffs);
  });

  it("fails the differential when the migrated stack drops a state write", async () => {
    // Proves the comparison above actually discriminates: a single missing state
    // write is enough to break it. Without this, a differential that compared
    // two identical-by-construction worlds would pass vacuously.
    const legacy = makeWorld(HAPPY_LOAD);
    const migrated = makeWorld(HAPPY_LOAD);
    await runLegacy(legacy, "loadGraph", '{"repo":"octo/app","branch":"main"}');
    await runMigrated(
      migrated,
      "loadGraph",
      '{"repo":"octo/app","branch":"main"}'
    );
    expect(migrated.state).toEqual(legacy.state);

    delete migrated.state.graphDefinitionHash;
    expect(migrated.state).not.toEqual(legacy.state);
  });
});
