import type {
  CanvasGraphResource,
  CanvasState,
  GraphBuildEvent,
  GraphBuildStage,
  GraphView,
  SourceRefContext
} from "../../shared.js";
import type { GraphInstanceEntry, GraphPipeline } from "./graph-pipeline.js";

// The use-case layer behind the three `graphs-planning` write routes.
//
// `/api/load-graph`, `/api/plan-graph` and `/api/diff-branches` are three views
// of one modeling workflow (see `graph-pipeline.ts` for the shared stages). The
// workflow — generation guards, artifact staging, the reuse cache, recipe
// resolution, graph comparison, progress events and every state mutation —
// lives here rather than in the route module, so the HTTP layer only parses
// input, invokes a workflow and serializes its result.
//
// Each workflow returns a `GraphWorkflowOutcome` instead of touching a response.
// That keeps the workflow independently testable without an HTTP context, and
// makes the one contract the migration must not break — which responses carry a
// `Content-Type` and which do not — explicit data rather than a side effect.

// The stale-race payload every generation guard in this family answers with.
const STALE_PAYLOAD = { stale: true } as const;
const MISSING_ENTRY_PAYLOAD = {
  error: "Canvas server state is unavailable."
} as const;
const GENERATING_APP_BICEP_MESSAGE =
  "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.";

// `bare` responses are written without a `Content-Type` header, exactly as the
// legacy branches wrote them: the missing-entry 503 on all three routes, and
// load-graph's pre-compile 409. Every other response sets the header first.
// The asymmetry is pre-existing and observable, so it is modeled rather than
// normalized away.
export type GraphWorkflowOutcome =
  | { kind: "json"; status: number; payload: Record<string, unknown> }
  | { kind: "bare"; status: number; payload: Record<string, unknown> };

export interface GraphWorkflowRequest {
  instanceId: string;
  // The raw request body. Parsing happens inside each workflow's `try` because
  // only a *parse* failure answers 400; a failure while reading the body is a
  // transport error the route layer must not convert into a response.
  body: string;
}

export interface GraphPlanningWorkflows {
  loadGraph(request: GraphWorkflowRequest): Promise<GraphWorkflowOutcome>;
  planGraph(request: GraphWorkflowRequest): Promise<GraphWorkflowOutcome>;
  diffBranches(request: GraphWorkflowRequest): Promise<GraphWorkflowOutcome>;
}

export interface GraphWorkflowDependencies<
  TEntry extends GraphInstanceEntry = GraphInstanceEntry
> {
  // Returns undefined when the instance has no entry, which is what the legacy
  // `servers.get(instanceId)` miss meant. A request context's `state` snapshot
  // cannot be used: it substitutes `{}` for a missing entry and so cannot
  // express the 503 these three workflows answer.
  readInstanceEntry(instanceId: string): TEntry | undefined;
  pipeline: GraphPipeline<TEntry>;
  triggerAppBicepHandoff(
    entry: TEntry | undefined,
    repo: string,
    branches: string | string[],
    page: string
  ): void;
  // Every path on a branch, used to answer the one prerequisite the app-bicep
  // modeling skill enforces before it will model anything. Resolves empty when
  // the tree cannot be read.
  listBranchPaths(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<string[]>;
  prepareSourceRefResources(
    entry: TEntry,
    view: GraphView,
    context: Record<string, unknown>
  ): SourceRefContext;
  setSourceRefResources(
    entry: TEntry,
    view: GraphView,
    resources: CanvasGraphResource[],
    context: Record<string, unknown>,
    expectedToken?: string
  ): boolean;
  isCurrentSourceRefToken(
    state: CanvasState,
    view: GraphView,
    token: unknown
  ): boolean;
  defaultBranchForState(state: CanvasState | null | undefined): string;
  canReuseModeledGraph(
    state: CanvasState,
    repo: string,
    branch: string,
    definitionHash: string
  ): boolean;
  addGraphProgress(
    state: CanvasState,
    generation: number,
    event: Omit<GraphBuildEvent, "sequence">
  ): boolean;
  beginPlannedGraphRequest(state: CanvasState): number;
  isCurrentPlannedGraphRequest(state: CanvasState, generation: number): boolean;
  // Both recipe seams arrive with the GitHub client already bound, so this
  // module never holds one.
  fetchRecipePack(provider: string): Promise<unknown[]>;
  resolveRecipeOutputs(
    resources: CanvasGraphResource[],
    recipes: unknown[],
    provider: string
  ): Promise<unknown[]>;
  computeGraphDiff(
    baseResources: CanvasGraphResource[],
    headResources: CanvasGraphResource[]
  ): CanvasGraphResource[];
  record(value: unknown): Record<string, unknown>;
  optionalString(value: unknown): string;
  errorMessage(error: unknown): string;
}

function json(
  status: number,
  payload: Record<string, unknown>
): GraphWorkflowOutcome {
  return { kind: "json", status, payload };
}

function bare(
  status: number,
  payload: Record<string, unknown>
): GraphWorkflowOutcome {
  return { kind: "bare", status, payload };
}

const MISSING_ENTRY_OUTCOME = bare(503, MISSING_ENTRY_PAYLOAD);

// The skill matches `Dockerfile`, `Dockerfile.*` and `*.Dockerfile`
// case-insensitively, anywhere in the repository.
export function isDockerfilePath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^dockerfile(\..+)?$/i.test(name) || /^.+\.dockerfile$/i.test(name);
}

export function appBicepNoDockerfileMessage(
  repo: string,
  branch: string
): string {
  return `${repo} has no Dockerfile on ${branch}, so the Radius app-bicep skill cannot model it: it builds the application image from one. Add a Dockerfile for the application service, then try again.`;
}

function beginGraphProgress(state: CanvasState): number {
  const generation = (state.graphProgressGeneration || 0) + 1;
  state.graphProgressGeneration = generation;
  state.graphBuildEvents = [];
  return generation;
}

function isCurrentGraphProgress(
  state: CanvasState,
  generation: number
): boolean {
  return state.graphProgressGeneration === generation;
}

function appendGraphEvent(
  state: CanvasState,
  stage: GraphBuildStage,
  eventState: GraphBuildEvent["state"],
  detail: string
): void {
  if (!state.graphBuildEvents) state.graphBuildEvents = [];
  state.graphBuildEvents.push({
    sequence: state.graphBuildEvents.length + 1,
    stage,
    state: eventState,
    detail
  });
}

function failRunningGraphEvent(
  state: CanvasState | undefined,
  generation: number | undefined,
  detail: string
): void {
  if (
    !state ||
    generation === undefined ||
    !isCurrentGraphProgress(state, generation)
  ) {
    return;
  }
  const events = state?.graphBuildEvents;
  const latest = events?.[events.length - 1];
  if (!latest || latest.state !== "running") return;
  appendGraphEvent(state, latest.stage, "failed", detail);
}

export function createGraphPlanningWorkflows<TEntry extends GraphInstanceEntry>(
  dependencies: GraphWorkflowDependencies<TEntry>
): GraphPlanningWorkflows {
  const { pipeline } = dependencies;

  // The app-bicep modeling skill refuses outright — before writing anything —
  // any repository without a Dockerfile, because it builds the application's
  // own image from one. That refusal is delivered to the user in the Copilot
  // conversation and never reaches this server, so handing off regardless would
  // leave the page waiting for a file that is never going to be written.
  // Answering here turns an unbounded wait into an actionable error.
  async function appBicepRefusalReason(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<string | null> {
    const paths = await dependencies.listBranchPaths(entry, repo, branch);
    // Fail open. An unreadable tree resolves empty, which is not evidence that
    // the repository lacks a Dockerfile, so the handoff still happens and the
    // page falls back to waiting.
    if (paths.length === 0) return null;
    if (paths.some(isDockerfilePath)) return null;
    return appBicepNoDockerfileMessage(repo, branch);
  }

  // The diff spans two branches, so it is only unsupported when neither side
  // could host the skill's output. A single readable Dockerfile-less branch is
  // not enough to refuse.
  async function diffAppBicepRefusalReason(
    entry: TEntry,
    repo: string,
    base: string,
    head: string
  ): Promise<string | null> {
    const [baseReason, headReason] = await Promise.all([
      appBicepRefusalReason(entry, repo, base),
      appBicepRefusalReason(entry, repo, head)
    ]);
    if (!baseReason || !headReason) return null;
    return headReason;
  }

  async function appBicepHandoffOutcome(
    entry: TEntry,
    repo: string,
    branch: string,
    reportRefusal: (detail: string) => void
  ): Promise<GraphWorkflowOutcome> {
    const refusal = await appBicepRefusalReason(entry, repo, branch);
    if (refusal) {
      reportRefusal(refusal);
      return json(200, {
        error: refusal,
        appBicepUnsupported: true,
        repo,
        branch
      });
    }
    // Both single-branch routes hand off as the "graph" page. plan-graph doing
    // so is pre-existing and load-bearing: the handoff dedupe key derives from
    // the page, so changing it here would re-trigger a handoff already made.
    dependencies.triggerAppBicepHandoff(entry, repo, branch, "graph");
    return json(200, {
      error: GENERATING_APP_BICEP_MESSAGE,
      needsAppBicep: true,
      repo,
      branch
    });
  }

  // The modeled application graph for one branch. Carries a generation guard so
  // a rapid branch switch cannot let a slow earlier compile overwrite the newer
  // one, and a definition-hash cache so an explicit refresh of an unchanged
  // model skips the `rad` compile entirely.
  async function loadGraph({
    instanceId,
    body
  }: GraphWorkflowRequest): Promise<GraphWorkflowOutcome> {
    let activeState: CanvasState | undefined;
    let activeGeneration: number | undefined;
    let activeProgressGeneration: number | undefined;
    try {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      activeState = state;
      const branch = data.branch || dependencies.defaultBranchForState(state);
      // Claiming the generation *before* the empty-repo exit is observable: a
      // request with no repo still invalidates an in-flight compile.
      const requestGeneration = (state.graphBuildGeneration =
        (state.graphBuildGeneration || 0) + 1);
      activeGeneration = requestGeneration;
      if (!repo) return json(200, { error: "Please select a repository." });
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "graph",
        { repo, branch }
      );
      const progressGeneration = beginGraphProgress(state);
      activeProgressGeneration = progressGeneration;

      // Every event is gated on the generation, so a superseded request stops
      // writing to the event stream the page is polling.
      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (!isCurrentGraphProgress(state, progressGeneration)) return;
        dependencies.addGraphProgress(state, requestGeneration, {
          stage,
          state: eventState,
          detail
        });
      };
      const addBuildDetail = (detail: string): void => {
        addEvent("building_graph", "running", detail);
      };

      addEvent(
        "checking_model",
        "running",
        `Checking ${repo} for .radius/app.bicep.`
      );
      const selection = await pipeline.selectAppBicep(entry, repo, branch);
      const content = selection.content;
      if (content) {
        addEvent("checking_model", "succeeded", "Found the application model.");
      } else {
        addEvent(
          "checking_model",
          "succeeded",
          "No application model exists yet."
        );
        addEvent(
          "creating_model",
          "running",
          "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
        );
        return await appBicepHandoffOutcome(entry, repo, branch, (detail) =>
          addEvent("creating_model", "failed", detail)
        );
      }

      const graphJsonPath = pipeline.graphJsonPathFor(entry, selection);
      const staged = await pipeline.stageArtifacts({
        entry,
        selection,
        repo,
        branch,
        log: addBuildDetail
      });
      const definitionHash = pipeline.definitionHashFor(selection, staged);
      if (state.graphBuildGeneration !== requestGeneration) {
        // Best-effort: a superseded request must still answer 409 even if the
        // temp directory cannot be removed.
        try {
          pipeline.discardStagedArtifacts(staged);
        } catch {
          /* best-effort */
        }
        return bare(409, STALE_PAYLOAD);
      }
      if (
        data.refresh &&
        dependencies.canReuseModeledGraph(state, repo, branch, definitionHash)
      ) {
        // Deliberately *not* best-effort, unlike the stale exit above: a failure
        // here falls into the catch and answers 400. Preserved as-is.
        pipeline.discardStagedArtifacts(staged);
        return json(200, {
          reload: false,
          resources: state.graphResources,
          cached: true
        });
      }

      addEvent(
        "building_graph",
        "running",
        "Compiling the application model and building the resource graph."
      );
      const resources = await pipeline.compileResources({
        selection,
        staged,
        log: addBuildDetail,
        saveGraphJsonTo: graphJsonPath
      });
      addEvent(
        "building_graph",
        "succeeded",
        `Built a graph with ${resources.length} resource(s).`
      );
      addEvent(
        "rendering_graph",
        "running",
        "Laying out and rendering the application graph."
      );

      if (sourceRefContext) {
        // Always true: `prepareSourceRefResources` returns a non-nullable
        // context. Retained verbatim from legacy because it is an equivalent
        // mutant, so this branch is structurally unreachable in coverage.
        // Re-checked after the compile, which is the slow stage: the generation
        // can have moved on while `rad` was running.
        if (state.graphBuildGeneration !== requestGeneration) {
          return json(409, STALE_PAYLOAD);
        }
        if (
          !dependencies.setSourceRefResources(
            entry,
            "graph",
            resources,
            { repo, branch },
            sourceRefContext.token
          )
        ) {
          return json(409, STALE_PAYLOAD);
        }
        state.graphTargetRepo = repo;
        state.graphBranch = branch;
        // Authoritative provenance: true only when the local workspace actually
        // supplied the app.bicep content (file is on disk).
        state.graphFromWorkspace = selection.fromWorkspace;
        state.activeGraphView = "graph";
        state.graphLoaded = true;
        state.graphDefinitionHash = definitionHash;
      }
      return json(200, { reload: !data.refresh, resources });
    } catch (e) {
      const error = dependencies.errorMessage(e);
      if (activeState?.graphBuildGeneration === activeGeneration) {
        failRunningGraphEvent(activeState, activeProgressGeneration, error);
      }
      return json(400, { error });
    }
  }

  // The planned graph: the modeled application projected through a provider's
  // recipe pack, so each abstract Radius resource shows the concrete cloud
  // resources its recipe would create.
  async function planGraph({
    instanceId,
    body
  }: GraphWorkflowRequest): Promise<GraphWorkflowOutcome> {
    let activeState: CanvasState | undefined;
    let activeGeneration: number | undefined;
    let activeProgressGeneration: number | undefined;
    try {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      activeState = state;
      const branch = data.branch || dependencies.defaultBranchForState(state);
      const provider = data.provider || "azure";
      const planGeneration = dependencies.beginPlannedGraphRequest(state);
      activeGeneration = planGeneration;
      // Persist the selected environment so re-opening (or reloading) the
      // Planned tab re-selects it by default, matching the graph just shown.
      state.plannedEnvironment =
        typeof data.environment === "string" ? data.environment : "";
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "planned",
        { repo, branch }
      );
      const progressGeneration = beginGraphProgress(state);
      activeProgressGeneration = progressGeneration;

      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (
          !isCurrentGraphProgress(state, progressGeneration) ||
          !dependencies.isCurrentPlannedGraphRequest(state, planGeneration)
        ) {
          return;
        }
        appendGraphEvent(state, stage, eventState, detail);
      };
      const addBuildDetail = (detail: string): void => {
        addEvent("building_graph", "running", detail);
      };

      addEvent(
        "checking_model",
        "running",
        `Checking ${repo} for .radius/app.bicep.`
      );
      const selection = await pipeline.selectAppBicep(entry, repo, branch);
      const content = selection.content;
      if (!content) {
        addEvent(
          "checking_model",
          "succeeded",
          "No application model exists yet."
        );
        addEvent(
          "creating_model",
          "running",
          "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
        );
        return await appBicepHandoffOutcome(entry, repo, branch, (detail) =>
          addEvent("creating_model", "failed", detail)
        );
      }
      addEvent("checking_model", "succeeded", "Found the application model.");

      const staged = await pipeline.stageArtifacts({
        entry,
        selection,
        repo,
        branch,
        log: addBuildDetail
      });
      addEvent(
        "building_graph",
        "running",
        "Compiling the application model and building the resource graph."
      );
      const resources = await pipeline.compileResources({
        selection,
        staged,
        log: addBuildDetail
      });
      addEvent(
        "building_graph",
        "succeeded",
        `Built a graph with ${resources.length} resource(s).`
      );

      // Resolve recipes from the default recipe pack
      // (radius-project/resource-types-contrib).
      let recipes: unknown[] = [];
      addEvent(
        "resolving_recipes",
        "running",
        `Resolving ${provider} recipes for the planned resources.`
      );
      recipes = await dependencies.fetchRecipePack(provider);

      // Surface pack recipes we couldn't map to a concrete resource so the gap
      // is visible (rather than silently rendering the abstract type). Empty
      // today for the Azure pack; fires if the pack adds a recipe source the
      // curated map doesn't yet cover.
      const unmappedRecipes = recipes.filter((recipe) => {
        const concrete = dependencies.record(recipe).concreteResources;
        return !Array.isArray(concrete) || concrete.length === 0;
      });
      if (unmappedRecipes.length) {
        addEvent(
          "resolving_recipes",
          "running",
          `Note: ${
            unmappedRecipes.length
          } pack recipe(s) have no concrete-resource mapping yet (${unmappedRecipes
            .map((recipe) =>
              dependencies.optionalString(
                dependencies.record(recipe).resourceType
              )
            )
            .join(", ")}); those nodes show their abstract Radius type.`
        );
      }

      // For each abstract resource, resolve its recipe and concrete outputs.
      const plannedResources = pipeline.toCanvasResources(
        await dependencies.resolveRecipeOutputs(resources, recipes, provider)
      );
      addEvent(
        "resolving_recipes",
        "succeeded",
        `Resolved ${plannedResources.length} planned resource(s).`
      );
      addEvent(
        "rendering_graph",
        "running",
        "Laying out and rendering the planned graph."
      );

      if (sourceRefContext) {
        // Equivalent mutant, as in load-graph: retained verbatim, unreachable.
        if (!dependencies.isCurrentPlannedGraphRequest(state, planGeneration)) {
          return json(409, STALE_PAYLOAD);
        }
        if (
          !dependencies.setSourceRefResources(
            entry,
            "planned",
            plannedResources,
            { repo, branch },
            sourceRefContext.token
          )
        ) {
          return json(409, STALE_PAYLOAD);
        }
        state.plannedRepo = repo;
        state.plannedBranch = branch;
        // Authoritative provenance: true only when the local workspace actually
        // supplied the app.bicep content (file is on disk).
        state.plannedFromWorkspace = selection.fromWorkspace;
        state.plannedProvider = provider;
        state.resolvedRecipes = recipes;
        state.activeGraphView = "planned";
      }
      return json(200, { reload: true });
    } catch (e) {
      const error = dependencies.errorMessage(e);
      if (
        activeState &&
        activeGeneration !== undefined &&
        dependencies.isCurrentPlannedGraphRequest(activeState, activeGeneration)
      ) {
        failRunningGraphEvent(activeState, activeProgressGeneration, error);
      }
      return json(400, { error });
    }
  }

  // The branch comparison. Both sides run the full pipeline independently and
  // the shared diff algorithm subtracts them, so a branch with no committed
  // app.bicep simply contributes nothing (everything on the other side reads as
  // added or removed) rather than failing the comparison.
  async function diffBranches({
    instanceId,
    body
  }: GraphWorkflowRequest): Promise<GraphWorkflowOutcome> {
    // Declared outside the `try` so the catch can tell whether the failure
    // belongs to the selection still on screen before it writes `diffError`.
    let sourceRefContext: SourceRefContext | null = null;
    let activeProgressGeneration: number | undefined;
    try {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      const progressGeneration = beginGraphProgress(state);
      activeProgressGeneration = progressGeneration;
      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (
          !isCurrentGraphProgress(state, progressGeneration) ||
          !dependencies.isCurrentSourceRefToken(
            state,
            "diff",
            sourceRefContext?.token || ""
          )
        ) {
          return;
        }
        appendGraphEvent(state, stage, eventState, detail);
      };
      sourceRefContext = dependencies.prepareSourceRefResources(entry, "diff", {
        repo,
        baseBranch: data.base,
        headBranch: data.head
      });
      state.diffBase = data.base;
      state.diffHead = data.head;
      state.diffTargetRepo = repo;
      delete state.diffError;

      // Fetch the committed/persisted app.bicep on each branch. app.bicep
      // generation is owned by the Radius app-bicep skill, so branches without
      // one simply contribute nothing to the diff (added/removed).
      addEvent(
        "checking_model",
        "running",
        `Checking ${data.base} and ${data.head} for application models.`
      );
      const [baseSelection, headSelection] = await Promise.all([
        pipeline.selectAppBicep(entry, repo, data.base),
        pipeline.selectAppBicep(entry, repo, data.head)
      ]);

      if (!baseSelection.content && !headSelection.content) {
        addEvent(
          "checking_model",
          "succeeded",
          "Neither branch contains an application model."
        );
        addEvent(
          "creating_model",
          "running",
          "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
        );
        const diffRefusal = await diffAppBicepRefusalReason(
          entry,
          repo,
          data.base,
          data.head
        );
        if (diffRefusal) {
          addEvent("creating_model", "failed", diffRefusal);
          return json(200, {
            error: diffRefusal,
            appBicepUnsupported: true,
            repo
          });
        }
        dependencies.triggerAppBicepHandoff(
          entry,
          repo,
          [data.base, data.head],
          "graph-diff"
        );
        // No `branch` key here, unlike the other two routes: the diff spans two.
        return json(200, {
          error: GENERATING_APP_BICEP_MESSAGE,
          needsAppBicep: true,
          repo
        });
      }
      addEvent(
        "checking_model",
        "succeeded",
        "Found application model content to compare."
      );

      // Ordering is load-bearing and matches legacy exactly: BOTH sides are
      // staged before EITHER is compiled. Interleaving stage/compile per side
      // would let the base side's staged temp directory be cleaned up before the
      // head side is staged, which is observable in the artifacts on disk.
      const baseStaged = await pipeline.stageArtifacts({
        entry,
        selection: baseSelection,
        repo,
        branch: data.base
      });
      const headStaged = await pipeline.stageArtifacts({
        entry,
        selection: headSelection,
        repo,
        branch: data.head
      });
      addEvent(
        "building_base_graph",
        "running",
        `Building the graph for ${data.base}.`
      );
      const baseResources = await pipeline.compileResources({
        selection: baseSelection,
        staged: baseStaged
      });
      addEvent(
        "building_base_graph",
        "succeeded",
        `Built ${baseResources.length} resource(s) from ${data.base}.`
      );
      addEvent(
        "building_head_graph",
        "running",
        `Building the graph for ${data.head}.`
      );
      const headResources = await pipeline.compileResources({
        selection: headSelection,
        staged: headStaged
      });
      addEvent(
        "building_head_graph",
        "succeeded",
        `Built ${headResources.length} resource(s) from ${data.head}.`
      );

      // Compute diff using the shared algorithm (see computeGraphDiff).
      addEvent(
        "comparing_graphs",
        "running",
        `Comparing ${data.base} with ${data.head}.`
      );
      const diffResources = dependencies.computeGraphDiff(
        baseResources,
        headResources
      );
      addEvent(
        "comparing_graphs",
        "succeeded",
        `Compared ${diffResources.length} resource(s).`
      );
      addEvent(
        "rendering_graph",
        "running",
        "Laying out and rendering the graph diff."
      );

      if (sourceRefContext) {
        // Equivalent mutant, as in load-graph: retained verbatim, unreachable.
        if (
          !dependencies.setSourceRefResources(
            entry,
            "diff",
            diffResources,
            {
              repo,
              baseBranch: data.base,
              headBranch: data.head
            },
            sourceRefContext.token
          )
        ) {
          return json(409, STALE_PAYLOAD);
        }
        state.diffBaseGenerated = false;
        state.diffHeadGenerated = false;
        state.page = "graphDiff";
        state.activeGraphView = "diff";
        delete state.diffError;
      }

      return json(200, {
        message: `Comparing ${data.base} → ${data.head}`,
        reload: true
      });
    } catch (e) {
      // The entry is re-read rather than reused: the failure may have happened
      // before one was ever resolved.
      const entry = dependencies.readInstanceEntry(instanceId);
      const error = dependencies.errorMessage(e);
      if (
        entry &&
        activeProgressGeneration !== undefined &&
        isCurrentGraphProgress(entry.state, activeProgressGeneration) &&
        dependencies.isCurrentSourceRefToken(
          entry.state,
          "diff",
          sourceRefContext?.token || ""
        )
      ) {
        entry.state.diffError = error;
        failRunningGraphEvent(entry.state, activeProgressGeneration, error);
      }
      return json(400, { error });
    }
  }

  return { loadGraph, planGraph, diffBranches };
}
