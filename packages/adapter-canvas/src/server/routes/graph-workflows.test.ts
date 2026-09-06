import { describe, expect, it, vi } from "vitest";
import { RadProcessError } from "@radius-project/adapter-shared";
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
import type { WorkspaceBranchResolution } from "../../workspace.js";
import { defaultBranchForState } from "../../workspace.js";
import {
  GRAPH_APP_BICEP_IDLE_TIMEOUT_MS,
  GRAPH_APP_BICEP_MAX_WAIT_MESSAGE,
  GRAPH_APP_BICEP_MAX_WAIT_MS,
  GRAPH_APP_BICEP_TIMEOUT_MESSAGE
} from "../../graph-progress-contract.js";
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
  GraphBuildEvent,
  GraphProgressView
} from "../../shared.js";
import { expireGraphProgressWait } from "../../shared.js";

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

function validationFailure(detail: string): Error {
  return new Error("rad app graph failed", {
    cause: new RadProcessError("rad exited with code 1", detail, "")
  });
}

interface HandoffCall {
  repo: string;
  branches: string | string[];
  page: string;
  progressView: GraphProgressView;
  hasEntry: boolean;
}

interface PipelineScript {
  // Keyed by branch so a two-branch diff can script each side independently.
  selections: Record<string, AppBicepSelection>;
  staged: Record<string, StagedRadArtifacts>;
  compiled: Record<string, CanvasGraphResource[]>;
  jsonPath: string;
  definitionHash: string;
  modelRevision: string;
  discardThrows?: Error;
  recipePackThrows?: Error;
  recipeOutputsThrows?: Error;
  selectThrows?: Record<string, Error>;
  // Every path on a branch, keyed by branch. Empty models a tree that could not
  // be read, which is what the default leaves in place.
  branchPaths?: Record<string, string[]>;
  afterListBranchPaths?: () => void;
  compileThrows?: Record<string, Error>;
  stageLogs?: Record<string, string>;
  compileLogs?: Record<string, string>;
  // Newest activity from a modeling run. Read only while an answer is asking
  // the page to keep waiting for the model.
  modelingActivityAtMs?: number;
  observeModelingRun?: () => Promise<number | null>;
  branchResolution?:
    WorkspaceBranchResolution | (() => Promise<WorkspaceBranchResolution>);
  commitBranchResolution?: boolean;
  // Runs after the named stage, so a test can move the world on mid-request.
  afterSelect?: () => void;
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
  // How many times an answer asked the workspace whether a modeling run is in
  // flight. Kept out of `order` so it cannot perturb stage-ordering assertions.
  modelingObservations: {
    count: number;
    lastRepo?: string;
    lastBranches?: string[];
  };
  // Everything the workflows sent to the diagnostics sink instead of the canvas.
  loggedErrors: string[];
  branchCommits: string[];
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
  const modelingObservations: Harness["modelingObservations"] = { count: 0 };
  const handoffs: HandoffCall[] = [];
  const recipePackCalls: string[] = [];
  const recipeResolutions: Harness["recipeResolutions"] = [];
  const harnessScript: PipelineScript = {
    selections: {},
    staged: {},
    compiled: {},
    jsonPath: "",
    definitionHash: "hash-a",
    // Deliberately distinct from the definition hash: the model revision tracks
    // model content alone, so a test cannot pass by conflating the two.
    modelRevision: "model-a",
    ...script
  };
  const recipes: unknown[] = [];
  const plannedOutputs: unknown[] = [];
  const loggedErrors: string[] = [];
  const branchCommits: string[] = [];

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
      const selection = requireScripted(
        harnessScript.selections,
        branch,
        "selectAppBicep"
      );
      harnessScript.afterSelect?.();
      return Promise.resolve(selection);
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
    modelRevisionFor: () => harnessScript.modelRevision,
    discardStagedArtifacts: (staged) => {
      order.push(`discard:${staged.dir}`);
      if (harnessScript.discardThrows) throw harnessScript.discardThrows;
    }
  };

  const dependencies: GraphWorkflowDependencies = {
    readInstanceEntry: () => (entryMissing ? undefined : entry),
    resolveBranchForRequest: (_entry, _repo, requestedBranch) => {
      const resolution = harnessScript.branchResolution;
      return typeof resolution === "function" ? resolution() : (
          Promise.resolve(
            resolution ?? {
              status: "resolved",
              branch: requestedBranch || defaultBranchForState(state),
              followsWorkspaceBranch: false
            }
          )
        );
    },
    commitBranchResolution: (_entry, _repo, resolution) => {
      branchCommits.push(resolution.branch);
      return harnessScript.commitBranchResolution ?? true;
    },
    pipeline,
    triggerAppBicepHandoff: (
      handoffEntry,
      repo,
      branches,
      page,
      progressView
    ) => {
      handoffs.push({
        repo,
        branches,
        page,
        progressView,
        hasEntry: !!handoffEntry
      });
    },
    triggerGraphRepairHandoff: () => ({
      attempt: 1,
      maxAttempts: 3,
      repairing: true,
      repairExhausted: false
    }),
    clearGraphRepairAttempt: () => {},
    listBranchPaths: (_entry, _repo, branch) => {
      const paths = harnessScript.branchPaths?.[branch] ?? [];
      harnessScript.afterListBranchPaths?.();
      return Promise.resolve(paths);
    },
    observeModelingRun: (_state, repo, branches) => {
      modelingObservations.count++;
      modelingObservations.lastRepo = repo;
      modelingObservations.lastBranches = branches;
      return (
        harnessScript.observeModelingRun?.() ??
        Promise.resolve(harnessScript.modelingActivityAtMs ?? null)
      );
    },
    prepareSourceRefResources,
    setSourceRefResources,
    isCurrentSourceRefToken,
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
    modelingObservations,
    loggedErrors,
    branchCommits,
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
  it.each(["loadGraph", "planGraph"] as const)(
    "reports an unavailable workspace branch without model lookup or handoff in %s",
    async (workflow) => {
      const harness = start({
        branchResolution: {
          status: "unavailable",
          error: "The workspace branch is unavailable."
        }
      });

      const outcome = await harness.run(workflow, '{"repo":"octo/app"}');

      expect(outcome).toEqual({
        kind: "json",
        status: 409,
        payload: {
          error: "The workspace branch is unavailable.",
          workspaceBranchUnavailable: true,
          repo: "octo/app"
        }
      });
      expect(harness.order).toEqual([]);
      expect(harness.handoffs).toEqual([]);
    }
  );

  it.each(["loadGraph", "planGraph"] as const)(
    "rejects a canonical branch commit superseded during resolution in %s",
    async (workflow) => {
      const harness = start({ commitBranchResolution: false });

      const outcome = await harness.run(workflow, '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.payload).toEqual({ stale: true });
      expect(harness.branchCommits).toEqual(["main"]);
      expect(harness.order).toEqual([]);
      expect(harness.handoffs).toEqual([]);
    }
  );

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

    it("fails closed when repository and branch fields are not strings", async () => {
      const harness = start();

      const outcome = await harness.run(
        "loadGraph",
        '{"repo":{"owner":"octo"},"branch":{"name":"feature"}}'
      );

      expect(outcome.status).toBe(200);
      expect(outcome.payload).toEqual({
        error: "Please select a repository."
      });
      expect(harness.branchCommits).toEqual(["main"]);
      expect(harness.order).toEqual([]);
      expect(harness.handoffs).toEqual([]);
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
          progressView: "graph",
          hasEntry: true
        }
      ]);
      expect(messages(harness.state)).toEqual([
        "Checking octo/app for .radius/app.bicep.",
        "No application model exists yet.",
        "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
      ]);
    });

    it("surfaces a reported permanent authoring failure without requesting modeling again", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "The configured Recipe rejects the required credential shape."
        }
      };
      harness.state.appModelAttemptTokens = {
        "octo/app::main": "attempt-1"
      };

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.payload).toEqual({
        error:
          "Application model generation stopped: The configured Recipe rejects the required credential shape. Fix the reported issue, then refresh the Radius Canvas to try modeling again.",
        modelingFailed: true,
        appModelAuthoringFailed: true,
        repo: "octo/app",
        branch: "main"
      });
      expect(harness.handoffs).toEqual([]);
      expect(messages(harness.state).at(-1)).toContain(
        "Application model generation stopped"
      );
    });

    it("clears a permanent authoring failure and requests a new attempt on explicit refresh", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "The configured Recipe rejects the required credential shape."
        }
      };
      harness.state.appModelAttemptTokens = {
        "octo/app::main": "attempt-1"
      };

      const outcome = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","restartWait":true}'
      );

      expect(outcome.payload).toMatchObject({ needsAppBicep: true });
      expect(outcome.payload.modelingFailed).toBeUndefined();
      expect(harness.state.appModelFailures).toEqual({});
      expect(harness.state.appModelAttemptTokens).toEqual({});
      expect(harness.handoffs).toHaveLength(1);
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

    it("reports a rendered model so drift is still noticed after it exists", async () => {
      const harness = start({ selections: { main: selectionOf() } });
      harness.state.appModelAttemptTokens = {
        "octo/app::main": "attempt-1"
      };
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "stale failure"
        }
      };

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(harness.state.appModelAttemptTokens).toEqual({});
      expect(harness.state.appModelFailures).toEqual({});
      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: "main",
          page: "graph",
          progressView: "graph",
          hasEntry: true
        }
      ]);
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

    describe("the app.bicep wait", () => {
      // The regression this replaced: a flat wall clock cut off a run that was
      // still working and reported the repository as unmodelable.
      it("keeps asking the page to wait while a modeling run stays alive", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) },
          modelingActivityAtMs: 1_000
        });

        await harness.run("loadGraph", '{"repo":"octo/app"}');
        harness.advanceClock(GRAPH_APP_BICEP_IDLE_TIMEOUT_MS * 4);
        harness.script.modelingActivityAtMs =
          1_000 + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS * 4;
        const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

        expect(outcome.payload).toMatchObject({ needsAppBicep: true });
        expect(outcome.payload.appBicepWaitExpired).toBeUndefined();
        expect(harness.modelingObservations.count).toBe(2);
      });

      it("ends the wait when no modeling run is ever observed", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) }
        });

        await harness.run("loadGraph", '{"repo":"octo/app"}');
        harness.advanceClock(GRAPH_APP_BICEP_IDLE_TIMEOUT_MS);
        const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

        // `needsAppBicep` is dropped, which is what stops a page that only
        // knows to retry while it is set.
        expect(outcome.payload.needsAppBicep).toBeUndefined();
        expect(outcome.payload).toMatchObject({
          error: GRAPH_APP_BICEP_TIMEOUT_MESSAGE,
          appBicepWaitExpired: true,
          repo: "octo/app",
          branch: "main"
        });
        expect(messages(harness.state).at(-1)).toBe(
          GRAPH_APP_BICEP_TIMEOUT_MESSAGE
        );
        expect(
          harness.state.graphProgressRecords?.graph?.graphProgressActive
        ).toBe(false);
      });

      it("does not cut off an observed run when staging remains unchanged", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) },
          modelingActivityAtMs: 1_000
        });

        await harness.run("loadGraph", '{"repo":"octo/app"}');
        harness.advanceClock(GRAPH_APP_BICEP_IDLE_TIMEOUT_MS);
        const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

        expect(outcome.payload).toMatchObject({ needsAppBicep: true });
        expect(outcome.payload.appBicepWaitExpired).toBeUndefined();
      });

      it("keeps an observed run until the hard ceiling", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) },
          modelingActivityAtMs: 999
        });

        await harness.run("loadGraph", '{"repo":"octo/app"}');
        harness.advanceClock(GRAPH_APP_BICEP_MAX_WAIT_MS);
        const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

        expect(outcome.payload).toMatchObject({
          error: GRAPH_APP_BICEP_MAX_WAIT_MESSAGE,
          appBicepWaitExpired: true
        });
      });

      // A continuously active run can still wedge, so the hard ceiling remains
      // the final bound.
      it("ends a continuously active wait at the ceiling", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) },
          modelingActivityAtMs: 1_000
        });

        await harness.run("loadGraph", '{"repo":"octo/app"}');
        harness.advanceClock(GRAPH_APP_BICEP_MAX_WAIT_MS);
        const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

        expect(outcome.payload).toMatchObject({
          error: GRAPH_APP_BICEP_MAX_WAIT_MESSAGE,
          appBicepWaitExpired: true
        });
      });

      it("returns a retained expiry instead of restarting the wait", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) }
        });
        await harness.run("loadGraph", '{"repo":"octo/app"}');
        const record = harness.state.graphProgressRecords?.graph;
        if (!record) throw new Error("expected graph progress record");
        const generation = record?.graphProgressGeneration;
        const startedAtMs = record?.graphProgressStartedAtMs;
        expireGraphProgressWait(record, GRAPH_APP_BICEP_TIMEOUT_MESSAGE);

        const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

        expect(outcome.payload).toMatchObject({
          error: GRAPH_APP_BICEP_TIMEOUT_MESSAGE,
          appBicepWaitExpired: true
        });
        expect(harness.state.graphProgressRecords?.graph).toMatchObject({
          graphProgressGeneration: generation,
          graphProgressStartedAtMs: startedAtMs,
          graphProgressActive: false,
          graphProgressWaitExpiredMessage: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
        });
      });

      it("starts a new wait when a fresh page explicitly retries an expired key", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) }
        });
        await harness.run("loadGraph", '{"repo":"octo/app"}');
        const record = harness.state.graphProgressRecords?.graph;
        if (!record) throw new Error("expected graph progress record");
        const generation = record.graphProgressGeneration;
        expireGraphProgressWait(record, GRAPH_APP_BICEP_TIMEOUT_MESSAGE);

        const outcome = await harness.run(
          "loadGraph",
          '{"repo":"octo/app","restartWait":true}'
        );

        expect(outcome.payload).toMatchObject({ needsAppBicep: true });
        expect(harness.state.graphProgressRecords?.graph).toMatchObject({
          graphProgressGeneration: generation + 1,
          graphProgressActive: true
        });
        expect(
          harness.state.graphProgressRecords?.graph
            ?.graphProgressWaitExpiredMessage
        ).toBeUndefined();
      });

      it("honors an expiry recorded while the activity probe is in flight", async () => {
        const harness = start({
          selections: { main: selectionOf({ content: null }) }
        });
        await harness.run("loadGraph", '{"repo":"octo/app"}');
        let releaseObservation!: (value: number | null) => void;
        let markObservationStarted!: () => void;
        const observationStarted = new Promise<void>((resolve) => {
          markObservationStarted = resolve;
        });
        harness.script.observeModelingRun = () => {
          markObservationStarted();
          return new Promise<number | null>((resolve) => {
            releaseObservation = resolve;
          });
        };

        const pending = harness.run("loadGraph", '{"repo":"octo/app"}');
        await observationStarted;
        const record = harness.state.graphProgressRecords?.graph;
        if (!record) throw new Error("expected graph progress record");
        expireGraphProgressWait(record, GRAPH_APP_BICEP_TIMEOUT_MESSAGE);
        releaseObservation(null);
        const outcome = await pending;

        expect(outcome.payload).toMatchObject({
          error: GRAPH_APP_BICEP_TIMEOUT_MESSAGE,
          appBicepWaitExpired: true
        });
        expect(record).toMatchObject({
          graphProgressActive: false,
          graphProgressWaitExpiredMessage: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
        });
      });

      // The probe reads the filesystem, so an answer that is not asking the
      // page to wait must not pay for it.
      it("only probes for a modeling run while an answer asks the page to wait", async () => {
        const harness = start({ selections: { main: selectionOf() } });

        await harness.run("loadGraph", '{"repo":"octo/app"}');

        expect(harness.modelingObservations.count).toBe(0);
      });

      it("passes the workflow repo and branch to the modeling run probe", async () => {
        const harness = start({
          selections: { develop: selectionOf({ content: null }) }
        });

        await harness.run(
          "loadGraph",
          '{"repo":"octo/infra","branch":"develop"}'
        );

        expect(harness.modelingObservations.count).toBeGreaterThan(0);
        expect(harness.modelingObservations.lastRepo).toBe("octo/infra");
        expect(harness.modelingObservations.lastBranches).toEqual(["develop"]);
      });
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
        definitionHash: "hash-x",
        modelRevision: "model-x"
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
        graphDefinitionHash: "hash-x",
        graphModelRevision: "model-x"
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
        graphFollowsWorkspaceBranch: true,
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
      expect(harness.state.graphFollowsWorkspaceBranch).toBe(false);
      expect(harness.state.graphFromWorkspace).toBe(false);
      expect(harness.state.graphModelRevision).toBe("model-a");
      // The cache hit turns on the definition hash, but the revision it records
      // is the model-content one, not that hash.
      expect(harness.state.graphDefinitionHash).toBe("hash-a");
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
        compileThrows: { main: validationFailure(radOutput) }
      });
      const repair = vi.spyOn(
        harness.dependencies,
        "triggerGraphRepairHandoff"
      );

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({
        error: `${GRAPH_MODELING_FAILURE_MESSAGE} app.bicep line 31: The specified "object" declaration is missing the following required properties: "application".`,
        modelingFailed: true,
        attempt: 1,
        maxAttempts: 3,
        repairing: true,
        repairExhausted: false
      });
      expect(messages(harness.state)).not.toContain(radOutput);
      expect(
        messages(harness.state).some((detail) => detail.includes("BCP035"))
      ).toBe(false);
      expect(stages(harness.state).at(-1)).toBe("building_graph:failed");
      expect(harness.state.graphLoaded).toBeUndefined();
      expect(harness.loggedErrors).toEqual([
        `[radius graph] modeling failed for octo/app@main: ${radOutput}`
      ]);
      expect(repair).toHaveBeenCalledWith(harness.entry, {
        view: "graph",
        repo: "octo/app",
        branches: ["main"],
        diagnostic: radOutput
      });
    });

    it("does not repair a modeled failure after its source selection changes", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: false } },
        compileThrows: {
          main: validationFailure("BCP035: stale invalid model")
        },
        afterStage: () => {
          prepareSourceRefResources(harness.entry, "graph", {
            repo: "octo/other",
            branch: "main"
          });
        }
      });
      const repair = vi.spyOn(
        harness.dependencies,
        "triggerGraphRepairHandoff"
      );

      await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(repair).not.toHaveBeenCalled();
    });

    it("preserves a graph toolchain failure that has no Bicep diagnostic", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: false } },
        compileThrows: {
          main: new RadProcessError(
            "managed Bicep download failed",
            "",
            "connection refused"
          )
        }
      });

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.payload).toEqual({
        error: "managed Bicep download failed"
      });
      expect(harness.loggedErrors).toEqual([]);
    });

    it("preserves BCP204 extension failures without starting model repair", async () => {
      const processError = new RadProcessError(
        "rad exited with code 1",
        'Error BCP204: Extension "radius" is not recognized.',
        ""
      );
      const error = new Error(
        "rad app graph failed\nCompiled with radius extension: br:example/radius:1.0",
        { cause: processError }
      );
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: false } },
        compileThrows: { main: error }
      });
      const repair = vi.spyOn(
        harness.dependencies,
        "triggerGraphRepairHandoff"
      );

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.payload).toEqual({ error: error.message });
      expect(repair).not.toHaveBeenCalled();
      expect(harness.loggedErrors).toEqual([]);
    });

    it("repairs a rad-level model failure without a BCP code", async () => {
      const diagnostic = 'resource type "Applications.Db/redis" not recognized';
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: false } },
        compileThrows: {
          main: validationFailure(diagnostic)
        }
      });
      const repair = vi.spyOn(
        harness.dependencies,
        "triggerGraphRepairHandoff"
      );

      const outcome = await harness.run("loadGraph", '{"repo":"octo/app"}');

      expect(outcome.payload).toMatchObject({
        error: GRAPH_MODELING_FAILURE_MESSAGE,
        modelingFailed: true
      });
      expect(repair).toHaveBeenCalledWith(harness.entry, {
        view: "graph",
        repo: "octo/app",
        branches: ["main"],
        diagnostic
      });
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

    it("uses arrival order when branch resolution completes out of order", async () => {
      let releaseFirst!: () => void;
      const firstResolution = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let resolutionCount = 0;
      const harness = start({
        branchResolution: async () => {
          resolutionCount++;
          const requestNumber = resolutionCount;
          if (requestNumber === 1) await firstResolution;
          return {
            status: "resolved",
            branch: requestNumber === 1 ? "old" : "new",
            followsWorkspaceBranch: false
          };
        },
        selections: {
          old: selectionOf({ content: null }),
          new: selectionOf({ branch: "new" })
        },
        staged: { new: { dir: "", remote: false } },
        compiled: { new: [] }
      });

      const first = harness.run("loadGraph", '{"repo":"octo/app"}');
      await vi.waitFor(() =>
        expect(harness.state.graphBuildGeneration).toBe(1)
      );
      const second = harness.run("loadGraph", '{"repo":"octo/app"}');
      await vi.waitFor(() => expect(resolutionCount).toBe(2));
      const secondOutcome = await second;
      releaseFirst();
      const firstOutcome = await first;

      expect(secondOutcome.status).toBe(200);
      expect(firstOutcome.payload).toEqual({ stale: true });
      expect(harness.state.graphBuildGeneration).toBe(2);
      expect(harness.handoffs.map((handoff) => handoff.branches)).toEqual([
        "new"
      ]);
      expect(harness.branchCommits).toEqual(["new"]);
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
      // "graph", not "planned": the prompt names the view the user is told to
      // reopen, and both single-branch routes point at the graph.
      expect(harness.handoffs[0]?.page).toBe("graph");
    });

    it("defaults non-string branch and provider fields before model selection", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] }
      });
      harness.recipes.push({
        resourceType: "Radius.Data/redisCaches",
        concreteResources: [{ type: "Microsoft.Cache/redis" }]
      });
      harness.plannedOutputs.push({ id: "res-a" });

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","branch":{"name":"feature"},"provider":{"name":"aws"}}'
      );

      expect(outcome.status).toBe(200);
      expect(harness.state.plannedProvider).toBe("azure");
      expect(harness.state.plannedBranch).toBe("main");
      expect(harness.recipePackCalls).toEqual(["azure"]);
      expect(harness.branchCommits).toEqual(["main"]);
    });

    it("clears a permanent authoring failure before an explicit planned refresh", async () => {
      const harness = start({
        selections: { main: selectionOf({ content: null }) }
      });
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "Recipe conflict"
        }
      };
      harness.state.appModelAttemptTokens = {
        "octo/app::main": "attempt-1"
      };

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","restartWait":true}'
      );

      expect(outcome.payload).toMatchObject({ needsAppBicep: true });
      expect(harness.state.appModelFailures).toEqual({});
      expect(harness.handoffs).toHaveLength(1);
    });

    it("does not hand off a missing model after a newer plan supersedes it", async () => {
      let harness!: Harness;
      harness = start({
        selections: { main: selectionOf({ content: null }) },
        afterSelect: () => {
          beginPlannedGraphRequest(harness.state);
        }
      });

      const outcome = await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.payload).toEqual({ stale: true });
      expect(harness.handoffs).toEqual([]);
    });

    it("does not leak a canonical branch from a stale response into later requests", async () => {
      let canonicalized!: Harness;
      canonicalized = start({
        branchResolution: {
          status: "resolved",
          branch: "new-name",
          followsWorkspaceBranch: true,
          workspaceSnapshot: {
            workspaceBranch: "old-name",
            contextBranch: "old-name"
          }
        },
        selections: { "new-name": selectionOf({ content: null }) },
        branchPaths: { "new-name": ["Dockerfile"] },
        afterListBranchPaths: () => {
          beginPlannedGraphRequest(canonicalized.state);
        }
      });

      const first = await canonicalized.run(
        "planGraph",
        '{"repo":"octo/app","branch":"old-name","followWorkspaceBranch":true}'
      );

      expect(first.payload).toEqual({
        stale: true,
        resolvedBranch: "new-name"
      });

      let later!: Harness;
      later = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [] },
        afterCompile: () => {
          later.state.graphBuildGeneration =
            (later.state.graphBuildGeneration || 0) + 1;
        }
      });

      const second = await later.run("loadGraph", '{"repo":"octo/app"}');

      expect(second.payload).toEqual({ stale: true });
    });

    it("does not hand off when superseded while inspecting a missing model's branch", async () => {
      let harness!: Harness;
      harness = start({
        selections: { main: selectionOf({ content: null }) },
        branchPaths: { main: ["Dockerfile"] },
        afterListBranchPaths: () => {
          beginPlannedGraphRequest(harness.state);
        }
      });

      const outcome = await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(outcome.status).toBe(409);
      expect(outcome.payload).toEqual({ stale: true });
      expect(harness.handoffs).toEqual([]);
    });

    it("reports a rendered plan's model so drift is still noticed after it exists", async () => {
      const harness = start({ selections: { main: selectionOf() } });
      harness.state.appModelAttemptTokens = {
        "octo/app::main": "attempt-1"
      };
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "stale failure"
        }
      };

      await harness.run("planGraph", '{"repo":"octo/app"}');

      expect(harness.state.appModelAttemptTokens).toEqual({});
      expect(harness.state.appModelFailures).toEqual({});
      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: "main",
          page: "graph",
          progressView: "planned",
          hasEntry: true
        }
      ]);
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

    it("reconciles unchanged preloaded resources without requesting a reload", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] }
      });
      harness.plannedOutputs.push({ id: "res-a" });
      harness.state.plannedResources = [{ id: "res-a" }];
      harness.state.plannedRepo = "octo/app";
      harness.state.plannedBranch = "main";
      harness.state.plannedFollowsWorkspaceBranch = true;
      harness.state.plannedProvider = "azure";
      harness.state.plannedEnvironment = "";
      harness.state.plannedDefinitionHash = "hash-a";

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","refresh":true}'
      );

      expect(outcome.payload).toEqual({
        reload: false,
        refreshed: true
      });
      expect(harness.handoffs).toHaveLength(1);
      expect(harness.state.plannedFollowsWorkspaceBranch).toBe(false);
      expect(harness.order).toEqual(["select:main", "stage:main", "discard:"]);
      expect(harness.recipePackCalls).toEqual([]);
    });

    it("does not restore cached planned resources after a newer plan supersedes staging", async () => {
      let harness!: Harness;
      harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: true } },
        discardThrows: new Error("EBUSY"),
        afterStage: () => {
          beginPlannedGraphRequest(harness.state);
        }
      });
      Object.assign(harness.state, {
        plannedResources: [{ id: "cached" }],
        plannedRepo: "octo/app",
        plannedBranch: "main",
        plannedProvider: "azure",
        plannedEnvironment: "",
        plannedDefinitionHash: "hash-a"
      });

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","refresh":true}'
      );

      expect(outcome.status).toBe(409);
      expect(outcome.payload).toEqual({ stale: true });
      expect(harness.state.plannedResources).toBeNull();
      expect(harness.order).toEqual([
        "select:main",
        "stage:main",
        "discard:/tmp/staged"
      ]);
    });

    it("preserves the persisted environment when freshness reconciliation has no loaded selector", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } }
      });
      harness.state.plannedResources = [{ id: "res-a" }];
      harness.state.plannedRepo = "octo/app";
      harness.state.plannedBranch = "main";
      harness.state.plannedProvider = "azure";
      harness.state.plannedEnvironment = "prod";
      harness.state.plannedDefinitionHash = "hash-a";

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","refresh":true}'
      );

      expect(outcome.payload).toEqual({ reload: false, refreshed: true });
      expect(harness.state.plannedEnvironment).toBe("prod");
      expect(harness.state.plannedResources).toEqual([{ id: "res-a" }]);
    });

    it("rebuilds cached planned resources when the model definition changes", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] },
        definitionHash: "hash-new"
      });
      harness.plannedOutputs.push({ id: "res-a" });
      Object.assign(harness.state, {
        plannedResources: [{ id: "res-a" }],
        plannedRepo: "octo/app",
        plannedBranch: "main",
        plannedProvider: "azure",
        plannedEnvironment: "prod",
        plannedDefinitionHash: "hash-old"
      });

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","environment":"prod","refresh":true}'
      );

      expect(outcome.payload).toEqual({ reload: false, refreshed: true });
      expect(harness.order).toContain("compile:main");
      expect(harness.recipePackCalls).toEqual(["azure"]);
      expect(harness.state.plannedDefinitionHash).toBe("hash-new");
    });

    it("surfaces cleanup failures from the cached planned fast path", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "/tmp/staged", remote: true } },
        discardThrows: new Error("EBUSY")
      });
      Object.assign(harness.state, {
        plannedResources: [{ id: "res-a" }],
        plannedRepo: "octo/app",
        plannedBranch: "main",
        plannedProvider: "azure",
        plannedEnvironment: "prod",
        plannedDefinitionHash: "hash-a"
      });

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","environment":"prod","refresh":true}'
      );

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({ error: "EBUSY" });
      expect(harness.order).toEqual([
        "select:main",
        "stage:main",
        "discard:/tmp/staged"
      ]);
    });

    it("reloads unchanged resources when the planned selection changes", async () => {
      const harness = start({
        selections: { main: selectionOf() },
        staged: { main: { dir: "", remote: false } },
        compiled: { main: [{ id: "res-a" } as CanvasGraphResource] }
      });
      harness.plannedOutputs.push({ id: "res-a" });
      harness.state.plannedResources = [{ id: "res-a" }];
      harness.state.plannedRepo = "octo/app";
      harness.state.plannedBranch = "main";
      harness.state.plannedProvider = "azure";
      harness.state.plannedEnvironment = "dev";

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","environment":"prod","refresh":true}'
      );

      expect(outcome.payload).toEqual({ reload: true });
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

    it("does not repair a planned failure after its source selection changes", async () => {
      const harness = start({
        selections: { main: selectionOf({ branch: "main" }) },
        staged: { main: { dir: "/tmp/stage", remote: true } },
        compileThrows: {
          main: validationFailure("BCP035: stale invalid plan")
        },
        afterStage: () => {
          prepareSourceRefResources(harness.entry, "planned", {
            repo: "octo/other",
            branch: "main"
          });
        }
      });
      const repair = vi.spyOn(
        harness.dependencies,
        "triggerGraphRepairHandoff"
      );

      await harness.run(
        "planGraph",
        '{"repo":"octo/app","branch":"main","provider":"azure"}'
      );

      expect(repair).not.toHaveBeenCalled();
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
          progressView: "diff",
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

    it("reconciles an unchanged preloaded diff without requesting a reload", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compiled: {
          main: [{ id: "shared" } as CanvasGraphResource],
          "feature/x": [{ id: "shared" } as CanvasGraphResource]
        }
      });
      await harness.run(
        "diffBranches",
        '{"repo":"octo/app","base":"main","head":"feature/x"}'
      );

      const outcome = await harness.run(
        "diffBranches",
        '{"repo":"octo/app","base":"main","head":"feature/x","refresh":true}'
      );

      expect(outcome.payload).toEqual({
        message: "Comparing main → feature/x",
        reload: false,
        refreshed: true
      });
      expect(harness.handoffs).toHaveLength(2);
    });

    it("reloads unchanged resources when the diff selection changes", async () => {
      const harness = start({
        selections: {
          main: selectionOf({ branch: "main" }),
          "feature/x": selectionOf({ branch: "feature/x" })
        },
        staged: {
          main: { dir: "", remote: false },
          "feature/x": { dir: "", remote: false }
        },
        compiled: {
          main: [{ id: "shared" } as CanvasGraphResource],
          "feature/x": [{ id: "shared" } as CanvasGraphResource]
        }
      });
      await harness.run(
        "diffBranches",
        '{"repo":"octo/app","base":"main","head":"feature/x"}'
      );
      harness.state.diffHead = "old-feature";

      const outcome = await harness.run(
        "diffBranches",
        '{"repo":"octo/app","base":"main","head":"feature/x","refresh":true}'
      );

      expect(outcome.payload).toEqual({
        message: "Comparing main → feature/x",
        reload: true
      });
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
      // Reported for both branches: the runtime classifies each side and stays
      // silent about the one the diff renders as an added application.
      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: ["main", "feature/x"],
          page: "graph-diff",
          progressView: "diff",
          hasEntry: true
        }
      ]);
      expect(harness.state.diffResources).toHaveLength(1);
    });

    it("reports a rendered diff's models so drift on either branch is still noticed", async () => {
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

      await harness.run("diffBranches", diffBody);

      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: ["main", "feature/x"],
          page: "graph-diff",
          progressView: "diff",
          hasEntry: true
        }
      ]);
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
        compileThrows: { main: validationFailure("BCP035: invalid model") }
      });

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(400);
      expect(outcome.kind).toBe("json");
      expect(outcome.payload).toEqual({
        error: GRAPH_MODELING_FAILURE_MESSAGE,
        modelingFailed: true,
        attempt: 1,
        maxAttempts: 3,
        repairing: true,
        repairExhausted: false
      });
      // The compare page reads `diffError` straight into its markup, so the
      // recorded failure is the same short sentence, not rad's output.
      expect(harness.state.diffError).toBe(GRAPH_MODELING_FAILURE_MESSAGE);
      expect(harness.loggedErrors).toEqual([
        "[radius graph] modeling failed for octo/app@main: BCP035: invalid model"
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
        compileThrows: {
          main: validationFailure("BCP035: stale invalid model")
        },
        afterStage: () => {
          // Only fires once both sides have staged; harmless to run twice.
          prepareSourceRefResources(harness.entry, "diff", {
            repo: "octo/app",
            baseBranch: "main",
            headBranch: "other"
          });
        }
      });
      const repair = vi.spyOn(
        harness.dependencies,
        "triggerGraphRepairHandoff"
      );

      const outcome = await harness.run("diffBranches", diffBody);

      expect(outcome.status).toBe(400);
      // The failure belongs to a selection no longer on screen, so it must not
      // paint an error over the newer one.
      expect(harness.state.diffError).toBeUndefined();
      expect(repair).not.toHaveBeenCalled();
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
      expect(harness.loggedErrors).toEqual([]);
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
    });

    it("returns a renamed workspace branch before the missing-model retry", async () => {
      const harness = start({
        branchResolution: {
          status: "resolved",
          branch: "new-name",
          followsWorkspaceBranch: false
        },
        selections: { "new-name": selectionOf({ content: null }) }
      });

      const outcome = await harness.run(
        "loadGraph",
        '{"repo":"octo/app","branch":"old-name","followWorkspaceBranch":true}'
      );

      expect(outcome.payload).toMatchObject({
        needsAppBicep: true,
        branch: "new-name",
        resolvedBranch: "new-name"
      });
      expect(harness.handoffs).toEqual([
        {
          repo: "octo/app",
          branches: "new-name",
          page: "graph",
          progressView: "graph",
          hasEntry: true
        }
      ]);
    });

    it("returns a renamed workspace branch before a planned-model retry", async () => {
      const harness = start({
        branchResolution: {
          status: "resolved",
          branch: "new-name",
          followsWorkspaceBranch: false
        },
        selections: { "new-name": selectionOf({ content: null }) }
      });

      const outcome = await harness.run(
        "planGraph",
        '{"repo":"octo/app","branch":"old-name","followWorkspaceBranch":true}'
      );

      expect(outcome.payload).toMatchObject({
        needsAppBicep: true,
        branch: "new-name",
        resolvedBranch: "new-name"
      });
      expect(harness.handoffs.at(-1)).toMatchObject({
        repo: "octo/app",
        branches: "new-name",
        progressView: "planned"
      });
    });

    it("surfaces a compilation failure as 400 after staging and commits no planned state", async () => {
      const harness = planHarness({
        compileThrows: {
          main: validationFailure("BCP035: invalid model")
        }
      });

      const outcome = await harness.run("planGraph", planBody);

      expect(outcome.status).toBe(400);
      expect(outcome.payload).toEqual({
        error: GRAPH_MODELING_FAILURE_MESSAGE,
        modelingFailed: true,
        attempt: 1,
        maxAttempts: 3,
        repairing: true,
        repairExhausted: false
      });
      // rad's Bicep diagnostics are the exact text issue #475 kept out of the
      // graph surface: they survive only in the server log.
      expect(harness.loggedErrors).toEqual([
        "[radius graph] modeling failed for octo/app@main: BCP035: invalid model"
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
