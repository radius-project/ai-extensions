import type {
  CanvasGraphResource,
  CanvasState,
  GraphView,
  SourceRefContext
} from "../../src/shared.js";
import type { AppBicepSelection } from "../../src/server/routes/graph-pipeline.js";

// A verbatim transcription of the three `graphs-planning` write arms as they
// existed on the legacy `server.ts` if-chain, recovered mechanically from
// `packages/adapter-canvas/src/server.ts` at commit f8757c1~1:
//
//   /api/load-graph     lines 6427-6592
//   /api/plan-graph     lines 6990-7148
//   /api/diff-branches  lines 7150-7295
//
// It exists so `graph-workflows.differential.test.ts` can run the migrated
// workflows and the code they replaced against identical fakes and compare the
// response, the state mutations and the call order. Coverage alone cannot catch
// an omitted state write or a reordered call in a ~470-line transcription; a
// differential oracle can.
//
// Two deliberate deviations, neither of which changes behaviour under test:
//   - the request body arrives as a string rather than being read off a socket,
//     because the body read now belongs to the route adapter and is pinned in
//     `graphs-planning-writes.test.ts`;
//   - `servers`/`github` are passed in rather than closed over.
//
// Nothing else is adapted. This file is frozen: it must not be "improved" to
// match a later refactor, or it stops being an independent oracle.

export interface LegacyEntry {
  state: CanvasState;
}

export interface LegacyResponse {
  setHeader(name: string, value: string): unknown;
  writeHead(status: number): unknown;
  end(value?: string): unknown;
}

export interface LegacyRadArtifacts {
  dir: string;
  remote: boolean;
}

export interface LegacyGraphSeams {
  servers: Map<string, LegacyEntry>;
  github: unknown;
  fetchBicepSelection(
    entry: LegacyEntry | undefined,
    repo: string,
    branch: string
  ): Promise<AppBicepSelection>;
  radArtifactsDirForSelection(request: {
    isLocal: boolean;
    state?: CanvasState;
    github: unknown;
    repo: string;
    branch: string;
    bicepRepoPath: string;
    log?: (message: string) => void;
  }): Promise<LegacyRadArtifacts>;
  buildGraphViaRad(
    content: string,
    definitionFile: string,
    options: {
      log?: (message: string) => void;
      saveGraphJsonTo?: string;
      radArtifactsDir?: string;
      cleanupRadArtifactsDir?: boolean;
    }
  ): Promise<unknown[]>;
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  workspaceGraphJsonPath(state: CanvasState, bicepPath: string): string;
  graphDefinitionHash(content: string, fingerprint: string): string;
  radArtifactsFingerprint(dir?: string): string;
  rmSync(dir: string, options: { recursive: boolean; force: boolean }): void;
  triggerAppBicepHandoff(
    entry: LegacyEntry | undefined,
    repo: string,
    branches: string | string[],
    page: string
  ): void;
  prepareSourceRefResources(
    entry: LegacyEntry,
    view: GraphView,
    context: Record<string, unknown>
  ): SourceRefContext;
  setSourceRefResources(
    entry: LegacyEntry,
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
  fetchRecipePack(github: unknown, provider: string): Promise<unknown[]>;
  resolveRecipeOutputs(
    github: unknown,
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

export async function legacyLoadGraph(
  seams: LegacyGraphSeams,
  res: LegacyResponse,
  instanceId: string,
  body: string
): Promise<void> {
  const {
    servers,
    github,
    fetchBicepSelection,
    radArtifactsDirForSelection,
    buildGraphViaRad,
    canvasGraphResources,
    workspaceGraphJsonPath,
    graphDefinitionHash,
    radArtifactsFingerprint,
    rmSync,
    triggerAppBicepHandoff,
    prepareSourceRefResources,
    setSourceRefResources,
    defaultBranchForState,
    canReuseModeledGraph,
    addGraphProgress,
    errorMessage
  } = seams;
  try {
    const data = JSON.parse(body);
    const repo = data.repo || "";
    const entry = servers.get(instanceId);
    if (!entry) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Canvas server state is unavailable." }));
      return;
    }
    const state = entry.state;
    const branch = data.branch || defaultBranchForState(state);
    const requestGeneration =
      entry ?
        (entry.state.graphBuildGeneration =
          (entry.state.graphBuildGeneration || 0) + 1)
      : 0;
    if (!repo) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ error: "Please select a repository." }));
      return;
    }
    const sourceRefContext =
      entry ?
        prepareSourceRefResources(entry, "graph", { repo, branch })
      : null;

    const addProgress = (msg: string): void => {
      addGraphProgress(state, requestGeneration, msg);
    };
    // Reset progress
    if (entry) entry.state.progressMessages = [];

    addProgress(`Checking ${repo} for existing app.bicep...`);
    const selection = await fetchBicepSelection(entry, repo, branch);
    const content = selection.content;
    if (content) {
      addProgress("Found existing app.bicep — parsing resources...");
    } else {
      addProgress(
        ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill."
      );
      triggerAppBicepHandoff(entry, repo, branch, "graph");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
          needsAppBicep: true,
          repo,
          branch
        })
      );
      return;
    }

    const graphJsonPath =
      entry && selection.fromWorkspace ?
        workspaceGraphJsonPath(entry.state, selection.bicepPath)
      : "";
    const { dir: radArtifactsDir, remote: radArtifactsRemote } =
      await radArtifactsDirForSelection({
        isLocal: !!(entry && selection.fromWorkspace),
        state: entry?.state,
        github,
        repo,
        branch,
        bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
        log: addProgress
      });
    const definitionHash = graphDefinitionHash(
      content,
      radArtifactsFingerprint(radArtifactsDir)
    );
    if (entry && entry.state.graphBuildGeneration !== requestGeneration) {
      if (radArtifactsRemote && radArtifactsDir) {
        try {
          rmSync(radArtifactsDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      res.writeHead(409);
      res.end(JSON.stringify({ stale: true }));
      return;
    }
    if (
      data.refresh &&
      entry &&
      canReuseModeledGraph(entry.state, repo, branch, definitionHash)
    ) {
      if (radArtifactsRemote && radArtifactsDir)
        rmSync(radArtifactsDir, { recursive: true, force: true });
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          reload: false,
          resources: entry.state.graphResources,
          cached: true
        })
      );
      return;
    }

    const resources = canvasGraphResources(
      await buildGraphViaRad(
        content,
        selection.bicepPath || ".radius/app.bicep",
        {
          log: addProgress,
          saveGraphJsonTo: graphJsonPath,
          radArtifactsDir,
          cleanupRadArtifactsDir: radArtifactsRemote
        }
      )
    );
    addProgress(`Mapped ${resources.length} resource(s) — rendering graph...`);

    if (entry && sourceRefContext) {
      if (entry.state.graphBuildGeneration !== requestGeneration) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(409);
        res.end(JSON.stringify({ stale: true }));
        return;
      }
      if (
        !setSourceRefResources(
          entry,
          "graph",
          resources,
          { repo, branch },
          sourceRefContext.token
        )
      ) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(409);
        res.end(JSON.stringify({ stale: true }));
        return;
      }
      entry.state.graphTargetRepo = repo;
      entry.state.graphBranch = branch;
      entry.state.graphFromWorkspace = selection.fromWorkspace;
      entry.state.activeGraphView = "graph";
      entry.state.graphLoaded = true;
      entry.state.graphDefinitionHash = definitionHash;
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ reload: !data.refresh, resources }));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: errorMessage(e) }));
  }
}

export async function legacyPlanGraph(
  seams: LegacyGraphSeams,
  res: LegacyResponse,
  instanceId: string,
  body: string
): Promise<void> {
  const {
    servers,
    github,
    fetchBicepSelection,
    radArtifactsDirForSelection,
    buildGraphViaRad,
    canvasGraphResources,
    triggerAppBicepHandoff,
    prepareSourceRefResources,
    setSourceRefResources,
    defaultBranchForState,
    beginPlannedGraphRequest,
    isCurrentPlannedGraphRequest,
    fetchRecipePack,
    resolveRecipeOutputs,
    record,
    optionalString,
    errorMessage
  } = seams;
  try {
    const data = JSON.parse(body);
    const repo = data.repo || "";
    const entry = servers.get(instanceId);
    if (!entry) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Canvas server state is unavailable." }));
      return;
    }
    const branch = data.branch || defaultBranchForState(entry.state);
    const provider = data.provider || "azure";
    const planGeneration = beginPlannedGraphRequest(entry.state);
    entry.state.plannedEnvironment =
      typeof data.environment === "string" ? data.environment : "";
    const sourceRefContext =
      entry ?
        prepareSourceRefResources(entry, "planned", { repo, branch })
      : null;

    const addProgress = (msg: string): void => {
      if (entry) {
        if (!entry.state.progressMessages) entry.state.progressMessages = [];
        entry.state.progressMessages.push(msg);
      }
    };
    if (entry) entry.state.progressMessages = [];

    addProgress(`Checking ${repo} for app.bicep...`);
    const selection = await fetchBicepSelection(entry, repo, branch);
    const content = selection.content;
    if (!content) {
      addProgress(
        ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill."
      );
      triggerAppBicepHandoff(entry, repo, branch, "graph");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
          needsAppBicep: true,
          repo,
          branch
        })
      );
      return;
    }
    addProgress("Found app.bicep — parsing resources...");

    const { dir: radArtifactsDir, remote: radArtifactsRemote } =
      await radArtifactsDirForSelection({
        isLocal: !!(entry && selection.fromWorkspace),
        state: entry?.state,
        github,
        repo,
        branch,
        bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
        log: addProgress
      });
    const resources = canvasGraphResources(
      await buildGraphViaRad(
        content,
        selection.bicepPath || ".radius/app.bicep",
        {
          log: addProgress,
          radArtifactsDir,
          cleanupRadArtifactsDir: radArtifactsRemote
        }
      )
    );
    addProgress(
      `Parsed ${resources.length} resource(s) — resolving ${provider} recipes...`
    );

    let recipes: unknown[] = [];
    addProgress("Fetching the default recipe pack from GitHub...");
    recipes = await fetchRecipePack(github, provider);
    addProgress(
      `Loaded ${
        Array.isArray(recipes) ? recipes.length : 0
      } recipe(s) from the default recipe pack.`
    );

    const unmappedRecipes = recipes.filter((recipe) => {
      const concrete = record(recipe).concreteResources;
      return !Array.isArray(concrete) || concrete.length === 0;
    });
    if (unmappedRecipes.length) {
      addProgress(
        `Note: ${
          unmappedRecipes.length
        } pack recipe(s) have no concrete-resource mapping yet (${unmappedRecipes
          .map((recipe) => optionalString(record(recipe).resourceType))
          .join(", ")}); those nodes show their abstract Radius type.`
      );
    }

    addProgress("Resolving recipe outputs for planned resources...");
    const plannedResources = canvasGraphResources(
      await resolveRecipeOutputs(github, resources, recipes, provider)
    );
    addProgress(
      `Planned ${plannedResources.length} resource(s) — rendering graph...`
    );

    if (entry && sourceRefContext) {
      if (!isCurrentPlannedGraphRequest(entry.state, planGeneration)) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(409);
        res.end(JSON.stringify({ stale: true }));
        return;
      }
      if (
        !setSourceRefResources(
          entry,
          "planned",
          plannedResources,
          { repo, branch },
          sourceRefContext.token
        )
      ) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(409);
        res.end(JSON.stringify({ stale: true }));
        return;
      }
      entry.state.plannedRepo = repo;
      entry.state.plannedBranch = branch;
      entry.state.plannedFromWorkspace = selection.fromWorkspace;
      entry.state.plannedProvider = provider;
      entry.state.resolvedRecipes = recipes;
      entry.state.activeGraphView = "planned";
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ reload: true }));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: errorMessage(e) }));
  }
}

export async function legacyDiffBranches(
  seams: LegacyGraphSeams,
  res: LegacyResponse,
  instanceId: string,
  body: string
): Promise<void> {
  const {
    servers,
    github,
    fetchBicepSelection,
    radArtifactsDirForSelection,
    buildGraphViaRad,
    canvasGraphResources,
    triggerAppBicepHandoff,
    prepareSourceRefResources,
    setSourceRefResources,
    isCurrentSourceRefToken,
    computeGraphDiff,
    errorMessage
  } = seams;
  let sourceRefContext: SourceRefContext | null = null;
  try {
    const data = JSON.parse(body);
    const repo = data.repo || "";
    const entry = servers.get(instanceId);
    if (!entry) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Canvas server state is unavailable." }));
      return;
    }
    sourceRefContext = prepareSourceRefResources(entry, "diff", {
      repo,
      baseBranch: data.base,
      headBranch: data.head
    });
    entry.state.diffBase = data.base;
    entry.state.diffHead = data.head;
    entry.state.diffTargetRepo = repo;
    delete entry.state.diffError;

    const [baseSelection, headSelection] = await Promise.all([
      fetchBicepSelection(entry, repo, data.base),
      fetchBicepSelection(entry, repo, data.head)
    ]);

    if (!baseSelection.content && !headSelection.content) {
      triggerAppBicepHandoff(entry, repo, [data.base, data.head], "graph-diff");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
          needsAppBicep: true,
          repo
        })
      );
      return;
    }

    const { dir: baseRadArtifactsDir, remote: baseRadArtifactsRemote } =
      await radArtifactsDirForSelection({
        isLocal: !!(entry && baseSelection.fromWorkspace),
        state: entry?.state,
        github,
        repo,
        branch: data.base,
        bicepRepoPath: baseSelection.bicepPath || ".radius/app.bicep"
      });
    const { dir: headRadArtifactsDir, remote: headRadArtifactsRemote } =
      await radArtifactsDirForSelection({
        isLocal: !!(entry && headSelection.fromWorkspace),
        state: entry?.state,
        github,
        repo,
        branch: data.head,
        bicepRepoPath: headSelection.bicepPath || ".radius/app.bicep"
      });
    const baseResources = canvasGraphResources(
      await buildGraphViaRad(
        baseSelection.content || "",
        baseSelection.bicepPath || ".radius/app.bicep",
        {
          radArtifactsDir: baseRadArtifactsDir,
          cleanupRadArtifactsDir: baseRadArtifactsRemote
        }
      )
    );
    const headResources = canvasGraphResources(
      await buildGraphViaRad(
        headSelection.content || "",
        headSelection.bicepPath || ".radius/app.bicep",
        {
          radArtifactsDir: headRadArtifactsDir,
          cleanupRadArtifactsDir: headRadArtifactsRemote
        }
      )
    );

    const diffResources = computeGraphDiff(baseResources, headResources);

    if (entry && sourceRefContext) {
      if (
        !setSourceRefResources(
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
        res.setHeader("Content-Type", "application/json");
        res.writeHead(409);
        res.end(JSON.stringify({ stale: true }));
        return;
      }
      entry.state.diffBaseGenerated = false;
      entry.state.diffHeadGenerated = false;
      entry.state.page = "graphDiff";
      entry.state.activeGraphView = "diff";
      delete entry.state.diffError;
    }

    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        message: `Comparing ${data.base} → ${data.head}`,
        reload: true
      })
    );
  } catch (e) {
    const entry = servers.get(instanceId);
    if (
      entry &&
      isCurrentSourceRefToken(
        entry.state,
        "diff",
        sourceRefContext?.token || ""
      )
    ) {
      entry.state.diffError = errorMessage(e);
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: errorMessage(e) }));
  }
}
