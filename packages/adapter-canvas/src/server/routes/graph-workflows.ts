import {
  evaluateAppSource,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "@radius-project/core";
import { recordGraphBuildEvent } from "../../shared.js";
import { GRAPH_APP_BICEP_TIMEOUT_MS } from "../../graph-progress-contract.js";
import type {
  CanvasGraphResource,
  CanvasState,
  GraphBuildEvent,
  GraphBuildStage,
  GraphProgressRecord,
  GraphProgressView,
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
    view: GraphProgressView,
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
  // Wall clock for the build record's elapsed time.
  now(): number;
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

interface GraphProgressHandle {
  view: GraphProgressView;
  generation: number;
  owner: number;
  record: GraphProgressRecord;
}

function graphProgressRecord(
  state: CanvasState,
  view: GraphProgressView
): GraphProgressRecord | undefined {
  return state.graphProgressRecords?.[view];
}

function beginGraphProgress(
  state: CanvasState,
  view: GraphProgressView,
  key: string,
  nowMs: number
): GraphProgressHandle {
  const existing = graphProgressRecord(state, view);
  // A build that is already in flight for this view is continued rather than
  // restarted. The app.bicep wait re-issues its request every few seconds, and
  // a fresh record each time would reset the elapsed clock and discard the
  // stages already reported — exactly the reset a user sees when they leave the
  // page and come back.
  const continuing =
    existing?.graphProgressActive === true &&
    existing.graphProgressAwaitingModel === true &&
    existing.graphProgressKey === key;
  const record: GraphProgressRecord =
    continuing && existing ? existing : (
      {
        graphBuildEvents: [],
        graphProgressGeneration: (existing?.graphProgressGeneration || 0) + 1,
        graphProgressStartedAtMs: nowMs,
        graphProgressActive: true,
        graphProgressView: view,
        graphProgressKey: key,
        graphProgressOwner: 0,
        graphProgressAwaitingModel: false
      }
    );
  record.graphProgressActive = true;
  record.graphProgressAwaitingModel = false;
  record.graphProgressOwner += 1;
  state.graphProgressRecords ??= {};
  state.graphProgressRecords[view] = record;
  return {
    view,
    generation: record.graphProgressGeneration,
    owner: record.graphProgressOwner,
    record
  };
}

function isCurrentGraphProgress(
  state: CanvasState,
  handle: GraphProgressHandle
): boolean {
  const record = graphProgressRecord(state, handle.view);
  return (
    record?.graphProgressGeneration === handle.generation &&
    record.graphProgressOwner === handle.owner
  );
}

// Close the record so nothing still claims to be in flight. The stages stay
// readable: a page that returns after the build finished sees what happened
// rather than an empty panel.
function endGraphProgress(
  state: CanvasState | undefined,
  handle: GraphProgressHandle | undefined
): void {
  if (!state || !handle) return;
  if (!isCurrentGraphProgress(state, handle)) return;
  const record = graphProgressRecord(state, handle.view);
  if (!record) return;
  record.graphProgressActive = false;
  record.graphProgressAwaitingModel = false;
  delete record.graphProgressDeadlineAtMs;
}

// Close the record for every outcome except the app.bicep handoff. That build
// genuinely continues off-page while Copilot authors the model, so it stays in
// flight and keeps narrating the wait to whichever page is looking.
function settleGraphProgress(
  state: CanvasState,
  handle: GraphProgressHandle | undefined,
  outcome: GraphWorkflowOutcome,
  nowMs: number
): GraphWorkflowOutcome {
  if (!handle || !isCurrentGraphProgress(state, handle)) return outcome;
  const record = graphProgressRecord(state, handle.view);
  if (!record) return outcome;
  if (outcome.payload.needsAppBicep === true) {
    record.graphProgressAwaitingModel = true;
    record.graphProgressDeadlineAtMs ??= nowMs + GRAPH_APP_BICEP_TIMEOUT_MS;
  } else {
    endGraphProgress(state, handle);
  }
  return outcome;
}

function appendGraphEvent(
  state: { graphBuildEvents?: GraphBuildEvent[] },
  stage: GraphBuildStage,
  eventState: GraphBuildEvent["state"],
  detail: string
): void {
  recordGraphBuildEvent(state, { stage, state: eventState, detail });
}

function modelCreationIsRunning(state: {
  graphBuildEvents?: GraphBuildEvent[];
}): boolean {
  const creationEvents = (state.graphBuildEvents || []).filter(
    (event) => event.stage === "creating_model"
  );
  return (
    creationEvents.some((event) => event.state === "running") &&
    !creationEvents.some((event) => event.state !== "running")
  );
}

function failRunningGraphEvent(
  state: CanvasState | undefined,
  handle: GraphProgressHandle | undefined,
  detail: string
): void {
  if (!state || !handle || !isCurrentGraphProgress(state, handle)) {
    return;
  }
  const record = graphProgressRecord(state, handle.view);
  const events = record?.graphBuildEvents;
  const latest = events?.[events.length - 1];
  if (!latest || latest.state !== "running") return;
  if (record) appendGraphEvent(record, latest.stage, "failed", detail);
}

export function createGraphPlanningWorkflows<TEntry extends GraphInstanceEntry>(
  dependencies: GraphWorkflowDependencies<TEntry>
): GraphPlanningWorkflows {
  const { pipeline } = dependencies;

  // Run one workflow and close its build record exactly once, whichever way it
  // ends. Settling at a single point rather than at each `return` is what makes
  // "a record is in flight only while work is actually happening" true by
  // construction — a future early return cannot forget to close it and leave
  // the nav chip claiming a build that ended minutes ago.
  async function settleWorkflow(
    run: () => Promise<GraphWorkflowOutcome>,
    hooks: {
      state: () => CanvasState | undefined;
      progressHandle: () => GraphProgressHandle | undefined;
      onError: (error: string) => void;
    }
  ): Promise<GraphWorkflowOutcome> {
    let outcome: GraphWorkflowOutcome;
    try {
      outcome = await run();
    } catch (e) {
      const error = dependencies.errorMessage(e);
      hooks.onError(error);
      outcome = json(400, { error });
    }
    const state = hooks.state();
    if (state) {
      settleGraphProgress(
        state,
        hooks.progressHandle(),
        outcome,
        dependencies.now()
      );
    }
    return outcome;
  }

  // The app-bicep modeling skill refuses outright — before writing anything —
  // any repository without a Dockerfile, because it builds the application's
  // own image from one. That refusal is delivered to the user in the Copilot
  // conversation and never reaches this server, so handing off regardless would
  // leave the page waiting for a file that is never going to be written.
  // Answering here turns an unbounded wait into an actionable error.
  async function branchRefusalReason(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<string | null> {
    const paths = await dependencies.listBranchPaths(entry, repo, branch);
    return evaluateAppSource(paths).status === "none" ?
        UNSUPPORTED_NO_DOCKERFILE_MESSAGE
      : null;
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
      branchRefusalReason(entry, repo, base),
      branchRefusalReason(entry, repo, head)
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
    const refusal = await branchRefusalReason(entry, repo, branch);
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
    let activeProgressHandle: GraphProgressHandle | undefined;
    const run = async (): Promise<GraphWorkflowOutcome> => {
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
      const progressHandle = beginGraphProgress(
        state,
        "graph",
        JSON.stringify({ repo, branch }),
        dependencies.now()
      );
      activeProgressHandle = progressHandle;

      // Every event is gated on the generation, so a superseded request stops
      // writing to the event stream the page is polling.
      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (!isCurrentGraphProgress(state, progressHandle)) return;
        dependencies.addGraphProgress(state, requestGeneration, "graph", {
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
        if (modelCreationIsRunning(progressHandle.record)) {
          addEvent(
            "creating_model",
            "succeeded",
            "Copilot created .radius/app.bicep."
          );
        }
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
        // Keep persisted provenance in step with what this response reports, so
        // a later page render cannot disagree with the page it just answered.
        state.graphFromWorkspace = selection.fromWorkspace;
        return json(200, {
          reload: false,
          resources: state.graphResources,
          fromWorkspace: selection.fromWorkspace,
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
      addEvent(
        "rendering_graph",
        "succeeded",
        "Rendered the application graph."
      );
      return json(200, {
        reload: !data.refresh,
        resources,
        fromWorkspace: selection.fromWorkspace
      });
    };
    return await settleWorkflow(run, {
      state: () => activeState,
      progressHandle: () => activeProgressHandle,
      onError: (error) => {
        if (activeState?.graphBuildGeneration === activeGeneration) {
          failRunningGraphEvent(activeState, activeProgressHandle, error);
        }
      }
    });
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
    let activeProgressHandle: GraphProgressHandle | undefined;
    const run = async (): Promise<GraphWorkflowOutcome> => {
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
      const progressHandle = beginGraphProgress(
        state,
        "planned",
        JSON.stringify({
          repo,
          branch,
          provider,
          environment: state.plannedEnvironment
        }),
        dependencies.now()
      );
      activeProgressHandle = progressHandle;

      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (
          !isCurrentGraphProgress(state, progressHandle) ||
          !dependencies.isCurrentPlannedGraphRequest(state, planGeneration)
        ) {
          return;
        }
        appendGraphEvent(progressHandle.record, stage, eventState, detail);
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
      if (modelCreationIsRunning(progressHandle.record)) {
        addEvent(
          "creating_model",
          "succeeded",
          "Copilot created .radius/app.bicep."
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
      addEvent(
        "resolving_recipes",
        "running",
        `Resolving ${provider} recipes for the planned resources.`
      );
      const recipes: unknown[] = await dependencies.fetchRecipePack(provider);

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
      addEvent("rendering_graph", "succeeded", "Rendered the planned graph.");
      return json(200, { reload: true });
    };
    return await settleWorkflow(run, {
      state: () => activeState,
      progressHandle: () => activeProgressHandle,
      onError: (error) => {
        if (
          activeState &&
          activeGeneration !== undefined &&
          dependencies.isCurrentPlannedGraphRequest(
            activeState,
            activeGeneration
          )
        ) {
          failRunningGraphEvent(activeState, activeProgressHandle, error);
        }
      }
    });
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
    let activeState: CanvasState | undefined;
    let activeProgressHandle: GraphProgressHandle | undefined;
    const run = async (): Promise<GraphWorkflowOutcome> => {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      activeState = state;
      const progressHandle = beginGraphProgress(
        state,
        "diff",
        JSON.stringify({ repo, base: data.base, head: data.head }),
        dependencies.now()
      );
      activeProgressHandle = progressHandle;
      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (
          !isCurrentGraphProgress(state, progressHandle) ||
          !dependencies.isCurrentSourceRefToken(
            state,
            "diff",
            sourceRefContext?.token || ""
          )
        ) {
          return;
        }
        appendGraphEvent(progressHandle.record, stage, eventState, detail);
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
      if (modelCreationIsRunning(progressHandle.record)) {
        addEvent(
          "creating_model",
          "succeeded",
          "Copilot created .radius/app.bicep."
        );
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
      addEvent("rendering_graph", "succeeded", "Rendered the graph diff.");

      return json(200, {
        message: `Comparing ${data.base} → ${data.head}`,
        reload: true
      });
    };
    return await settleWorkflow(run, {
      state: () => activeState,
      progressHandle: () => activeProgressHandle,
      onError: (error) => {
        // The entry is re-read rather than reused: the failure may have
        // happened before one was ever resolved.
        const entry = dependencies.readInstanceEntry(instanceId);
        if (
          entry &&
          activeProgressHandle !== undefined &&
          isCurrentGraphProgress(entry.state, activeProgressHandle) &&
          dependencies.isCurrentSourceRefToken(
            entry.state,
            "diff",
            sourceRefContext?.token || ""
          )
        ) {
          entry.state.diffError = error;
          failRunningGraphEvent(entry.state, activeProgressHandle, error);
        }
      }
    });
  }

  return { loadGraph, planGraph, diffBranches };
}
