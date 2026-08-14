import type {
  CanvasGraphResource,
  CanvasState,
  GraphView,
  SourceRefContext
} from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { GraphInstanceEntry, GraphPipeline } from "./graph-pipeline.js";

// The three write halves of the `graphs-planning` family. They are migrated
// together because they are one pipeline seen from three angles — see
// `graph-pipeline.ts`, which owns the shared stages so these handlers stay thin
// enough to read as HTTP adapters.
//
// Each route answers a different question about the same model:
//   load-graph    - what does this branch's application look like?
//   plan-graph    - what would it become on a given cloud provider?
//   diff-branches - what changes between two committed branches?

// The stale-race payload every generation guard in this family writes.
const STALE_PAYLOAD = { stale: true } as const;
const MISSING_ENTRY_PAYLOAD = {
  error: "Canvas server state is unavailable."
} as const;
const GENERATING_APP_BICEP_MESSAGE =
  "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.";
const MISSING_APP_BICEP_PROGRESS =
  ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill.";

export interface GraphsPlanningWritesDependencies {
  // Returns undefined when the instance has no entry, which is what the legacy
  // `servers.get(instanceId)` miss meant. The request context's `state` snapshot
  // cannot be used: it substitutes `{}` for a missing entry and so cannot
  // express the 503 these three routes answer.
  readInstanceEntry(instanceId: string): GraphInstanceEntry | undefined;
  pipeline: GraphPipeline;
  triggerAppBicepHandoff(
    entry: GraphInstanceEntry | undefined,
    repo: string,
    branches: string | string[],
    page: string
  ): void;
  prepareSourceRefResources(
    entry: GraphInstanceEntry,
    view: GraphView,
    context: Record<string, unknown>
  ): SourceRefContext;
  setSourceRefResources(
    entry: GraphInstanceEntry,
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

// The legacy branches read the body manually, outside their `try`. That is
// observable: a socket error while reading rejects the handler rather than
// answering 400, and only a *parse* failure becomes 400. Reading the text here
// and parsing inside the `try` reproduces both halves exactly.
function readBody(context: CanvasRequestContext): Promise<string> {
  return context.readTextBody();
}

// 503 without a `Content-Type`, matching legacy. Every other response in this
// family sets the header first, and that asymmetry is pre-existing.
function respondMissingEntry(context: CanvasRequestContext): void {
  context.response.writeHead(503);
  context.response.end(JSON.stringify(MISSING_ENTRY_PAYLOAD));
}

// The modeled application graph for one branch. Carries a generation guard so a
// rapid branch switch cannot let a slow earlier compile overwrite the newer one,
// and a definition-hash cache so an explicit refresh of an unchanged model skips
// the `rad` compile entirely.
export async function handleLoadGraph(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningWritesDependencies
): Promise<void> {
  const { response } = context;
  const { pipeline } = dependencies;
  const body = await readBody(context);
  try {
    const data = JSON.parse(body);
    const repo = data.repo || "";
    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (!entry) {
      respondMissingEntry(context);
      return;
    }
    const state = entry.state;
    const branch = data.branch || dependencies.defaultBranchForState(state);
    // Claiming the generation *before* the empty-repo exit is observable: a
    // request with no repo still invalidates an in-flight compile.
    const requestGeneration = (state.graphBuildGeneration =
      (state.graphBuildGeneration || 0) + 1);
    if (!repo) {
      context.json(200, { error: "Please select a repository." });
      return;
    }
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
      dependencies.triggerAppBicepHandoff(entry, repo, branch, "graph");
      context.json(200, {
        error: GENERATING_APP_BICEP_MESSAGE,
        needsAppBicep: true,
        repo,
        branch
      });
      return;
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
      response.writeHead(409);
      response.end(JSON.stringify(STALE_PAYLOAD));
      return;
    }
    if (
      data.refresh &&
      dependencies.canReuseModeledGraph(state, repo, branch, definitionHash)
    ) {
      // Deliberately *not* best-effort, unlike the stale exit above: a failure
      // here falls into the catch and answers 400. Preserved as-is.
      pipeline.discardStagedArtifacts(staged);
      context.json(200, {
        reload: false,
        resources: state.graphResources,
        cached: true
      });
      return;
    }

    const resources = await pipeline.compileResources({
      selection,
      staged,
      log: addProgress,
      saveGraphJsonTo: graphJsonPath
    });
    addProgress(`Mapped ${resources.length} resource(s) — rendering graph...`);

    if (sourceRefContext) {
      // Always true: `prepareSourceRefResources` returns a non-nullable
      // context. Retained verbatim from legacy because it is an equivalent
      // mutant, so this branch is structurally unreachable in coverage.
      // Re-checked after the compile, which is the slow stage: the generation
      // can have moved on while `rad` was running.
      if (state.graphBuildGeneration !== requestGeneration) {
        context.json(409, STALE_PAYLOAD);
        return;
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
        context.json(409, STALE_PAYLOAD);
        return;
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
    context.json(200, { reload: !data.refresh, resources });
  } catch (e) {
    context.json(400, { error: dependencies.errorMessage(e) });
  }
}

// The planned graph: the modeled application projected through a provider's
// recipe pack, so each abstract Radius resource shows the concrete cloud
// resources its recipe would create.
export async function handlePlanGraph(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningWritesDependencies
): Promise<void> {
  const { pipeline } = dependencies;
  const body = await readBody(context);
  try {
    const data = JSON.parse(body);
    const repo = data.repo || "";
    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (!entry) {
      respondMissingEntry(context);
      return;
    }
    const state = entry.state;
    const branch = data.branch || dependencies.defaultBranchForState(state);
    const provider = data.provider || "azure";
    const planGeneration = dependencies.beginPlannedGraphRequest(state);
    // Persist the selected environment so re-opening (or reloading) the Planned
    // tab re-selects it by default, matching the graph just shown.
    state.plannedEnvironment =
      typeof data.environment === "string" ? data.environment : "";
    const sourceRefContext = dependencies.prepareSourceRefResources(
      entry,
      "planned",
      { repo, branch }
    );

    // Unlike load-graph's, this log is *not* generation-gated: a superseded plan
    // keeps writing progress until it hits the guard below. Preserved verbatim,
    // including the `!state.progressMessages` guard, which never fires because
    // the array is assigned immediately below — an unreachable legacy branch.
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
      // Hands off as the "graph" page, not "planned". Pre-existing, and the
      // handoff key is derived from it, so changing it would re-trigger.
      dependencies.triggerAppBicepHandoff(entry, repo, branch, "graph");
      context.json(200, {
        error: GENERATING_APP_BICEP_MESSAGE,
        needsAppBicep: true,
        repo,
        branch
      });
      return;
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

    // Surface pack recipes we couldn't map to a concrete resource so the gap is
    // visible (rather than silently rendering the abstract type). Empty today
    // for the Azure pack; fires if the pack adds a recipe source the curated map
    // doesn't yet cover.
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
        context.json(409, STALE_PAYLOAD);
        return;
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
        context.json(409, STALE_PAYLOAD);
        return;
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
    context.json(200, { reload: true });
  } catch (e) {
    context.json(400, { error: dependencies.errorMessage(e) });
  }
}

// The branch comparison. Both sides run the full pipeline independently and the
// shared diff algorithm subtracts them, so a branch with no committed app.bicep
// simply contributes nothing (everything on the other side reads as added or
// removed) rather than failing the comparison.
export async function handleDiffBranches(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningWritesDependencies
): Promise<void> {
  const { pipeline } = dependencies;
  const body = await readBody(context);
  // Declared outside the `try` so the catch can tell whether the failure belongs
  // to the selection still on screen before it writes `diffError`.
  let sourceRefContext: SourceRefContext | null = null;
  try {
    const data = JSON.parse(body);
    const repo = data.repo || "";
    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (!entry) {
      respondMissingEntry(context);
      return;
    }
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
    // generation is owned by the Radius app-bicep skill, so branches without one
    // simply contribute nothing to the diff (added/removed).
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
      context.json(200, {
        error: GENERATING_APP_BICEP_MESSAGE,
        needsAppBicep: true,
        repo
      });
      return;
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
        context.json(409, STALE_PAYLOAD);
        return;
      }
      state.diffBaseGenerated = false;
      state.diffHeadGenerated = false;
      state.page = "graphDiff";
      state.activeGraphView = "diff";
      delete state.diffError;
    }

    context.json(200, {
      message: `Comparing ${data.base} → ${data.head}`,
      reload: true
    });
  } catch (e) {
    // The entry is re-read rather than reused: the failure may have happened
    // before one was ever resolved.
    const entry = dependencies.readInstanceEntry(context.instanceId);
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
    context.json(400, { error: dependencies.errorMessage(e) });
  }
}

export function createGraphsPlanningWritesRoutes(
  dependencies: GraphsPlanningWritesDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/load-graph": (context) => handleLoadGraph(context, dependencies),
    "POST /api/plan-graph": (context) => handlePlanGraph(context, dependencies),
    "POST /api/diff-branches": (context) =>
      handleDiffBranches(context, dependencies)
  };
}
