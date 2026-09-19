export const DEFAULT_APP_BICEP_PATH = ".radius/app.bicep";

/** The caller authorizes workspace access; a committed source never reads it. */
export type GraphSource =
  | { kind: "workspace"; repo: string; branch: string; workspacePath: string }
  | { kind: "committed"; repo: string; ref: string };

export interface GraphDefinition {
  content: string | null;
  bicepPath: string;
}

export interface GraphArtifacts {
  dir: string;
  remote: boolean;
}

export interface GraphCompileOptions {
  log?: (message: string) => void;
  saveGraphJsonTo?: string;
  radArtifactsDir?: string;
  cleanupRadArtifactsDir?: boolean;
}

export interface GraphProgress {
  stage: "staging" | "building" | "comparing" | "planning";
  status: "running" | "succeeded";
  source?: GraphSource;
  resourceCount?: number;
}

export interface GraphExecution {
  isCurrent?: () => boolean;
  progress?: (event: GraphProgress) => void;
  log?: (message: string) => void;
}

export type GraphResult<Resource> =
  | { kind: "completed"; resources: Resource[] }
  | { kind: "missing-definition" }
  | { kind: "stale" };

export interface GraphPipelinePorts<Resource> {
  readDefinition(source: GraphSource): Promise<GraphDefinition>;
  stageArtifacts(
    source: GraphSource,
    definition: GraphDefinition,
    log?: (message: string) => void
  ): Promise<GraphArtifacts>;
  buildGraphViaRad(
    content: string,
    definitionFile: string,
    options: GraphCompileOptions
  ): Promise<unknown[]>;
  normalizeResources(values: unknown[]): Resource[];
  graphDefinitionHash(content: string, artifactsFingerprint: string): string;
  radArtifactsFingerprint(dir?: string): string;
  removeDirectory(dir: string): void;
  computeDiff(base: Resource[], head: Resource[]): Resource[];
}

export interface SelectedGraph {
  source: GraphSource;
  definition: GraphDefinition;
}

export interface PreparedGraph extends SelectedGraph {
  artifacts: GraphArtifacts;
}

export interface GraphReader<Resource> {
  select(source: GraphSource): Promise<SelectedGraph>;
  prepare(
    selected: SelectedGraph,
    execution?: GraphExecution
  ): Promise<PreparedGraph>;
  compile(
    prepared: PreparedGraph,
    execution?: GraphExecution,
    saveGraphJsonTo?: string
  ): Promise<Resource[]>;
  discard(artifacts: GraphArtifacts): void;
  buildSelected(
    selected: SelectedGraph,
    execution?: GraphExecution,
    saveGraphJsonTo?: string
  ): Promise<GraphResult<Resource>>;
  compareSelected(
    base: SelectedGraph,
    head: SelectedGraph,
    execution?: GraphExecution
  ): Promise<GraphResult<Resource>>;
  read(
    source: GraphSource,
    execution?: GraphExecution,
    saveGraphJsonTo?: string
  ): Promise<GraphResult<Resource>>;
  compare(
    base: Extract<GraphSource, { kind: "committed" }>,
    head: Extract<GraphSource, { kind: "committed" }>,
    execution?: GraphExecution
  ): Promise<GraphResult<Resource>>;
  definitionHash(prepared: PreparedGraph): string;
  modelRevision(definition: GraphDefinition): string;
}

export interface GraphComparisonPorts<Resource> {
  stage(selected: SelectedGraph): Promise<GraphArtifacts>;
  compile(
    selected: SelectedGraph,
    artifacts: GraphArtifacts
  ): Promise<Resource[]>;
  discard(artifacts: GraphArtifacts): void;
  computeDiff(base: Resource[], head: Resource[]): Resource[];
}

interface GraphPrimaryFailure {
  error: unknown;
}

function cleanupGraphArtifacts(
  staged: GraphArtifacts[],
  discard: (artifacts: GraphArtifacts) => void,
  primary: GraphPrimaryFailure | undefined
): void {
  const failures: unknown[] = [];
  for (const artifacts of staged) {
    try {
      discard(artifacts);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  if (primary) {
    const detail =
      primary.error instanceof Error ?
        primary.error.message
      : String(primary.error);
    throw new AggregateError(
      [primary.error, ...failures],
      `${detail} Graph artifact cleanup also failed.`,
      { cause: primary.error }
    );
  }
  throw new AggregateError(failures, "Graph artifact cleanup failed.");
}

/**
 * Cleanup failures reject with AggregateError, even after a completed or stale
 * result. If execution also failed, its original rejection is the cause and
 * first errors entry; subsequent entries retain each cleanup rejection.
 */
export async function compareSelectedGraphs<Resource>(
  base: SelectedGraph,
  head: SelectedGraph,
  ports: GraphComparisonPorts<Resource>,
  execution: GraphExecution = {}
): Promise<GraphResult<Resource>> {
  const current = (): boolean => execution.isCurrent?.() ?? true;
  if (!current()) return { kind: "stale" };
  if (base.definition.content === null && head.definition.content === null) {
    return { kind: "missing-definition" };
  }
  const staged: GraphArtifacts[] = [];
  let primary: GraphPrimaryFailure | undefined;
  try {
    const baseArtifacts = await ports.stage(base);
    staged.push(baseArtifacts);
    const headArtifacts = await ports.stage(head);
    staged.push(headArtifacts);
    if (!current()) return { kind: "stale" };
    const compile = async (
      selected: SelectedGraph,
      artifacts: GraphArtifacts
    ): Promise<Resource[]> => {
      execution.progress?.({
        stage: "building",
        status: "running",
        source: selected.source
      });
      const resources =
        selected.definition.content === null ?
          []
        : await ports.compile(selected, artifacts);
      execution.progress?.({
        stage: "building",
        status: "succeeded",
        source: selected.source,
        resourceCount: resources.length
      });
      return resources;
    };
    const baseResources = await compile(base, baseArtifacts);
    if (!current()) return { kind: "stale" };
    const headResources = await compile(head, headArtifacts);
    if (!current()) return { kind: "stale" };
    execution.progress?.({ stage: "comparing", status: "running" });
    const resources = ports.computeDiff(baseResources, headResources);
    execution.progress?.({
      stage: "comparing",
      status: "succeeded",
      resourceCount: resources.length
    });
    return { kind: "completed", resources };
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    cleanupGraphArtifacts(staged, ports.discard, primary);
  }
}

export function graphDefinitionPath(definition: GraphDefinition): string {
  return definition.bicepPath || DEFAULT_APP_BICEP_PATH;
}

export async function compileGraphDefinition<Resource>(
  definition: GraphDefinition,
  options: GraphCompileOptions,
  ports: Pick<
    GraphPipelinePorts<Resource>,
    "buildGraphViaRad" | "normalizeResources"
  >
): Promise<Resource[]> {
  return ports.normalizeResources(
    await ports.buildGraphViaRad(
      definition.content ?? "",
      graphDefinitionPath(definition),
      options
    )
  );
}

/**
 * Source/build/comparison only. No authoring, publication or agent interaction
 * is implied by reading a graph, including when its definition is absent.
 * Owned artifact cleanup uses the same AggregateError contract as comparison.
 */
export function createGraphReader<Resource>(
  ports: GraphPipelinePorts<Resource>
): GraphReader<Resource> {
  const current = (execution: GraphExecution): boolean =>
    execution.isCurrent?.() ?? true;

  function discard(artifacts: GraphArtifacts): void {
    if (artifacts.remote && artifacts.dir) ports.removeDirectory(artifacts.dir);
  }

  async function select(source: GraphSource): Promise<SelectedGraph> {
    return { source, definition: await ports.readDefinition(source) };
  }

  async function prepare(
    selected: SelectedGraph,
    execution: GraphExecution = {}
  ): Promise<PreparedGraph> {
    execution.progress?.({
      stage: "staging",
      status: "running",
      source: selected.source
    });
    const artifacts = await ports.stageArtifacts(
      selected.source,
      selected.definition,
      execution.log
    );
    return { ...selected, artifacts };
  }

  async function compile(
    prepared: PreparedGraph,
    execution: GraphExecution = {},
    saveGraphJsonTo?: string
  ): Promise<Resource[]> {
    if (prepared.definition.content === null) return [];
    execution.progress?.({
      stage: "building",
      status: "running",
      source: prepared.source
    });
    const resources = await compileGraphDefinition(
      prepared.definition,
      {
        log: execution.log,
        saveGraphJsonTo,
        radArtifactsDir: prepared.artifacts.dir,
        cleanupRadArtifactsDir: false
      },
      ports
    );
    execution.progress?.({
      stage: "building",
      status: "succeeded",
      source: prepared.source,
      resourceCount: resources.length
    });
    return resources;
  }

  async function buildSelected(
    selected: SelectedGraph,
    execution: GraphExecution = {},
    saveGraphJsonTo?: string
  ): Promise<GraphResult<Resource>> {
    if (!current(execution)) return { kind: "stale" };
    if (selected.definition.content === null)
      return { kind: "missing-definition" };
    const prepared: PreparedGraph[] = [];
    let primary: GraphPrimaryFailure | undefined;
    try {
      const item = await prepare(selected, execution);
      prepared.push(item);
      if (!current(execution)) return { kind: "stale" };
      const resources = await compile(item, execution, saveGraphJsonTo);
      return current(execution) ?
          { kind: "completed", resources }
        : { kind: "stale" };
    } catch (error) {
      primary = { error };
      throw error;
    } finally {
      cleanupGraphArtifacts(
        prepared.map((item) => item.artifacts),
        discard,
        primary
      );
    }
  }

  async function compareSelected(
    base: SelectedGraph,
    head: SelectedGraph,
    execution: GraphExecution = {}
  ): Promise<GraphResult<Resource>> {
    return compareSelectedGraphs(
      base,
      head,
      {
        stage: (selected) =>
          ports.stageArtifacts(
            selected.source,
            selected.definition,
            execution.log
          ),
        compile: (selected, artifacts) =>
          compile({ ...selected, artifacts }, { log: execution.log }),
        discard,
        computeDiff: ports.computeDiff
      },
      execution
    );
  }

  return {
    select,
    prepare,
    compile,
    discard,
    buildSelected,
    compareSelected,
    async read(
      source: GraphSource,
      execution: GraphExecution = {},
      saveGraphJsonTo?: string
    ): Promise<GraphResult<Resource>> {
      return buildSelected(await select(source), execution, saveGraphJsonTo);
    },
    async compare(
      base: Extract<GraphSource, { kind: "committed" }>,
      head: Extract<GraphSource, { kind: "committed" }>,
      execution: GraphExecution = {}
    ): Promise<GraphResult<Resource>> {
      const [baseSelected, headSelected] = await Promise.all([
        select(base),
        select(head)
      ]);
      return compareSelected(baseSelected, headSelected, execution);
    },
    definitionHash(prepared: PreparedGraph): string {
      return ports.graphDefinitionHash(
        prepared.definition.content ?? "",
        ports.radArtifactsFingerprint(prepared.artifacts.dir)
      );
    },
    modelRevision(definition: GraphDefinition): string {
      return ports.graphDefinitionHash(definition.content ?? "", "");
    }
  };
}

export async function planGraphResources<Resource>(
  resources: Resource[],
  provider: string,
  ports: {
    fetchRecipePack(provider: string): Promise<unknown[]>;
    resolveRecipeOutputs(
      resources: Resource[],
      recipes: unknown[],
      provider: string
    ): Promise<unknown[]>;
    normalizeResources(values: unknown[]): Resource[];
  },
  onRecipes?: (recipes: unknown[]) => void
): Promise<Resource[]> {
  const recipes = await ports.fetchRecipePack(provider);
  onRecipes?.(recipes);
  return ports.normalizeResources(
    await ports.resolveRecipeOutputs(resources, recipes, provider)
  );
}
