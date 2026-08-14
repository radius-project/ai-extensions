import type {
  CanvasGraphResource,
  CanvasState,
  GraphView,
  SourceRefContext
} from "../../shared.js";
import type { GraphInstanceEntry, GraphPipeline } from "./graph-pipeline.js";

// The use-case layer behind the three `graphs-planning` write routes.
//
// `/api/load-graph`, `/api/plan-graph` and `/api/diff-branches` are three views
// of one modeling workflow (see `graph-pipeline.ts` for the shared stages). The
// workflow — generation guards, artifact staging, the reuse cache, recipe
// resolution, graph comparison, progress logging and every state mutation —
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
const MISSING_APP_BICEP_PROGRESS =
  ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill.";

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
    message: string
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

export function createGraphPlanningWorkflows<TEntry extends GraphInstanceEntry>(
  dependencies: GraphWorkflowDependencies<TEntry>
): GraphPlanningWorkflows {
  const { pipeline } = dependencies;

  function appBicepHandoffOutcome(
    entry: TEntry,
    repo: string,
    branch: string
  ): GraphWorkflowOutcome {
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
    try {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      const branch = data.branch || dependencies.defaultBranchForState(state);
      // Claiming the generation *before* the empty-repo exit is observable: a
      // request with no repo still invalidates an in-flight compile.
      const requestGeneration = (state.graphBuildGeneration =
        (state.graphBuildGeneration || 0) + 1);
      if (!repo) return json(200, { error: "Please select a repository." });
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "graph",
        { repo, branch }
      );

      // Every progress line is gated on the generation, so a superseded request
      // stops writing to the log the page is polling.
      const addProgress = (message: string): void => {
        dependencies.addGraphProgress(state, requestGeneration, message);
      };
      state.progressMessages = [];

      addProgress(`Checking ${repo} for existing app.bicep...`);
      const selection = await pipeline.selectAppBicep(entry, repo, branch);
      const content = selection.content;
      if (content) {
        addProgress("Found existing app.bicep — parsing resources...");
      } else {
        addProgress(MISSING_APP_BICEP_PROGRESS);
        return appBicepHandoffOutcome(entry, repo, branch);
      }

      const graphJsonPath = pipeline.graphJsonPathFor(entry, selection);
      const staged = await pipeline.stageArtifacts({
        entry,
        selection,
        repo,
        branch,
        log: addProgress
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

      const resources = await pipeline.compileResources({
        selection,
        staged,
        log: addProgress,
        saveGraphJsonTo: graphJsonPath
      });
      addProgress(
        `Mapped ${resources.length} resource(s) — rendering graph...`
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
      return json(400, { error: dependencies.errorMessage(e) });
    }
  }

  // The planned graph: the modeled application projected through a provider's
  // recipe pack, so each abstract Radius resource shows the concrete cloud
  // resources its recipe would create.
  async function planGraph({
    instanceId,
    body
  }: GraphWorkflowRequest): Promise<GraphWorkflowOutcome> {
    try {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      const branch = data.branch || dependencies.defaultBranchForState(state);
      const provider = data.provider || "azure";
      const planGeneration = dependencies.beginPlannedGraphRequest(state);
      // Persist the selected environment so re-opening (or reloading) the
      // Planned tab re-selects it by default, matching the graph just shown.
      state.plannedEnvironment =
        typeof data.environment === "string" ? data.environment : "";
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "planned",
        { repo, branch }
      );

      // Unlike load-graph's, this log is *not* generation-gated: a superseded
      // plan keeps writing progress until it hits the guard below. Preserved
      // verbatim, including the `!state.progressMessages` guard, which never
      // fires because the array is assigned immediately below — an unreachable
      // legacy branch.
      const addProgress = (message: string): void => {
        if (!state.progressMessages) state.progressMessages = [];
        state.progressMessages.push(message);
      };
      state.progressMessages = [];

      addProgress(`Checking ${repo} for app.bicep...`);
      const selection = await pipeline.selectAppBicep(entry, repo, branch);
      const content = selection.content;
      if (!content) {
        addProgress(MISSING_APP_BICEP_PROGRESS);
        return appBicepHandoffOutcome(entry, repo, branch);
      }
      addProgress("Found app.bicep — parsing resources...");

      const staged = await pipeline.stageArtifacts({
        entry,
        selection,
        repo,
        branch,
        log: addProgress
      });
      const resources = await pipeline.compileResources({
        selection,
        staged,
        log: addProgress
      });
      addProgress(
        `Parsed ${resources.length} resource(s) — resolving ${provider} recipes...`
      );

      // Resolve recipes from the default recipe pack
      // (radius-project/resource-types-contrib).
      let recipes: unknown[] = [];
      addProgress("Fetching the default recipe pack from GitHub...");
      recipes = await dependencies.fetchRecipePack(provider);
      // The `Array.isArray` guard is legacy defence against an untyped pack; the
      // seam is declared `unknown[]`, so its false arm is unreachable here.
      addProgress(
        `Loaded ${
          Array.isArray(recipes) ? recipes.length : 0
        } recipe(s) from the default recipe pack.`
      );

      // Surface pack recipes we couldn't map to a concrete resource so the gap
      // is visible (rather than silently rendering the abstract type). Empty
      // today for the Azure pack; fires if the pack adds a recipe source the
      // curated map doesn't yet cover.
      const unmappedRecipes = recipes.filter((recipe) => {
        const concrete = dependencies.record(recipe).concreteResources;
        return !Array.isArray(concrete) || concrete.length === 0;
      });
      if (unmappedRecipes.length) {
        addProgress(
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
      addProgress("Resolving recipe outputs for planned resources...");
      const plannedResources = pipeline.toCanvasResources(
        await dependencies.resolveRecipeOutputs(resources, recipes, provider)
      );
      addProgress(
        `Planned ${plannedResources.length} resource(s) — rendering graph...`
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
      return json(400, { error: dependencies.errorMessage(e) });
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
    try {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
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
      const [baseSelection, headSelection] = await Promise.all([
        pipeline.selectAppBicep(entry, repo, data.base),
        pipeline.selectAppBicep(entry, repo, data.head)
      ]);

      if (!baseSelection.content && !headSelection.content) {
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

      // Ordering is load-bearing and matches legacy exactly: BOTH sides are
      // staged before EITHER is compiled. Interleaving stage/compile per side
      // would let the base side's staged temp directory be cleaned up before the
      // head side is staged, which is observable in the artifacts on disk.
      // No progress log on either side either: the diff page has no progress
      // panel, and adding one would change what `/api/progress` serves.
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
      const baseResources = await pipeline.compileResources({
        selection: baseSelection,
        staged: baseStaged
      });
      const headResources = await pipeline.compileResources({
        selection: headSelection,
        staged: headStaged
      });

      // Compute diff using the shared algorithm (see computeGraphDiff).
      const diffResources = dependencies.computeGraphDiff(
        baseResources,
        headResources
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
      if (
        entry &&
        dependencies.isCurrentSourceRefToken(
          entry.state,
          "diff",
          sourceRefContext?.token || ""
        )
      ) {
        entry.state.diffError = dependencies.errorMessage(e);
      }
      return json(400, { error: dependencies.errorMessage(e) });
    }
  }

  return { loadGraph, planGraph, diffBranches };
}
