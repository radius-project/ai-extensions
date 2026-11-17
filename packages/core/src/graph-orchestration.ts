import {
  GraphSourceError,
  type GraphSourceRead,
  type PresentGraphSource
} from "./graph-source.js";

export interface StagedGraphArtifacts {
  dir: string;
  owned: boolean;
  fingerprint: string;
  dispose(): Promise<void>;
}

export interface PreparedGraph {
  selection: GraphSourceRead;
  staged?: StagedGraphArtifacts;
}

export interface GraphOperationControl {
  checkCancelled?(): void;
  onPhase?(
    phase: "staging" | "compiling" | "comparing" | "enriching",
    side?: "base" | "head"
  ): void;
}

export interface GraphOrchestrationPorts<Resource, Diff> {
  stage(selection: PresentGraphSource): Promise<StagedGraphArtifacts>;
  compile(
    content: string,
    definitionPath: string,
    options: { radArtifactsDir: string; cleanupRadArtifactsDir: false }
  ): Promise<Resource[]>;
  diff(base: Resource[], head: Resource[]): Diff;
  diagnostic?(message: string): void;
}

export interface GraphEnrichmentPorts<Resource, Recipe, Provider> {
  fetchRecipePack(provider: Provider): Promise<Recipe[]>;
  resolveRecipeOutputs(
    resources: Resource[],
    recipes: Recipe[],
    provider: Provider
  ): Promise<Resource[]>;
}

function validate(selection: GraphSourceRead): void {
  if (selection.status === "unavailable")
    throw new GraphSourceError(
      "unavailable",
      selection.diagnostic,
      selection.source
    );
  if (selection.status === "present" && !selection.content.trim())
    throw new GraphSourceError(
      "empty",
      `The model ${selection.source.definitionPath} is empty.`,
      selection.source
    );
}

export async function prepareGraph(
  selection: GraphSourceRead,
  stage: (selection: PresentGraphSource) => Promise<StagedGraphArtifacts>,
  control: GraphOperationControl = {}
): Promise<PreparedGraph> {
  control.checkCancelled?.();
  validate(selection);
  if (selection.status !== "present") return { selection };
  control.onPhase?.("staging");
  // Return the acquired handle before checking cancellation: its caller owns it.
  return { selection, staged: await stage(selection) };
}

export async function compilePreparedGraph<Resource>(
  prepared: PreparedGraph,
  compile: (
    content: string,
    definitionPath: string,
    options: { radArtifactsDir: string; cleanupRadArtifactsDir: false }
  ) => Promise<Resource[]>,
  control: GraphOperationControl = {}
): Promise<Resource[]> {
  control.checkCancelled?.();
  validate(prepared.selection);
  if (prepared.selection.status !== "present") return [];
  if (!prepared.staged)
    throw new Error("Present graph input has not been staged.");
  control.onPhase?.("compiling");
  const resources = await compile(
    prepared.selection.content,
    prepared.selection.source.definitionPath,
    {
      radArtifactsDir: prepared.staged.dir,
      cleanupRadArtifactsDir: false
    }
  );
  control.checkCancelled?.();
  return resources;
}

export async function enrichPlannedGraph<Resource, Recipe, Provider>(
  resources: Resource[],
  provider: Provider,
  enrichment: GraphEnrichmentPorts<Resource, Recipe, Provider>,
  control: GraphOperationControl = {}
): Promise<{ resources: Resource[]; recipes: Recipe[] }> {
  control.checkCancelled?.();
  control.onPhase?.("enriching");
  const recipes = await enrichment.fetchRecipePack(provider);
  control.checkCancelled?.();
  const enriched = await enrichment.resolveRecipeOutputs(
    resources,
    recipes,
    provider
  );
  control.checkCancelled?.();
  return { resources: enriched, recipes };
}

export function createGraphOrchestrator<Resource, Diff>(
  ports: GraphOrchestrationPorts<Resource, Diff>
) {
  const disposed = new WeakSet<PreparedGraph>();

  function prepare(
    selection: GraphSourceRead,
    control: GraphOperationControl = {}
  ): Promise<PreparedGraph> {
    return prepareGraph(selection, ports.stage.bind(ports), control);
  }

  async function disposePrepared(prepared: PreparedGraph): Promise<void> {
    if (disposed.has(prepared)) return;
    disposed.add(prepared);
    if (!prepared.staged?.owned) return;
    try {
      await prepared.staged.dispose();
    } catch (error) {
      try {
        ports.diagnostic?.(
          `Graph artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } catch {
        // A diagnostic sink must not mask compilation, cancellation, or success.
      }
    }
  }

  function compilePrepared(
    prepared: PreparedGraph,
    control: GraphOperationControl = {}
  ): Promise<Resource[]> {
    return compilePreparedGraph(prepared, ports.compile.bind(ports), control);
  }

  async function authored(
    selection: GraphSourceRead,
    control: GraphOperationControl = {}
  ) {
    const prepared = await prepare(selection, control);
    let resources: Resource[];
    try {
      resources = await compilePrepared(prepared, control);
    } finally {
      await disposePrepared(prepared);
    }
    control.checkCancelled?.();
    return selection.status === "absent" ?
        {
          status: "definition-absent" as const,
          source: selection.source,
          resources
        }
      : { status: "authored" as const, source: selection.source, resources };
  }

  async function compare(
    base: GraphSourceRead,
    head: GraphSourceRead,
    control: GraphOperationControl = {}
  ) {
    const acquired: PreparedGraph[] = [];
    const sideControl = (side: "base" | "head"): GraphOperationControl => ({
      checkCancelled: control.checkCancelled,
      onPhase: (phase) => control.onPhase?.(phase, side)
    });
    let result: Awaited<ReturnType<typeof comparePrepared>>;
    try {
      validate(base);
      validate(head);
      const preparedBase = await prepare(base, sideControl("base"));
      acquired.push(preparedBase);
      const preparedHead = await prepare(head, sideControl("head"));
      acquired.push(preparedHead);
      result = await comparePrepared(preparedBase, preparedHead, control);
    } finally {
      for (const prepared of acquired) await disposePrepared(prepared);
    }
    control.checkCancelled?.();
    return result;
  }

  /** Prepared inputs remain owned by the caller, including cache-hit paths. */
  async function comparePrepared(
    base: PreparedGraph,
    head: PreparedGraph,
    control: GraphOperationControl = {}
  ) {
    for (const prepared of [base, head]) {
      validate(prepared.selection);
      if (prepared.selection.status === "present" && !prepared.staged)
        throw new Error("Present graph input has not been staged.");
    }
    const sideControl = (side: "base" | "head"): GraphOperationControl => ({
      checkCancelled: control.checkCancelled,
      onPhase: (phase) => control.onPhase?.(phase, side)
    });
    const baseResources = await compilePrepared(base, sideControl("base"));
    const headResources = await compilePrepared(head, sideControl("head"));
    if (
      base.selection.status === "absent" &&
      head.selection.status === "absent"
    )
      return {
        status: "definitions-absent" as const,
        base: base.selection.source,
        head: head.selection.source
      };
    control.checkCancelled?.();
    control.onPhase?.("comparing");
    return {
      status: "compared" as const,
      base: base.selection.source,
      head: head.selection.source,
      baseResources,
      headResources,
      diff: ports.diff(baseResources, headResources)
    };
  }

  function enrich<Recipe, Provider>(
    resources: Resource[],
    provider: Provider,
    enrichment: GraphEnrichmentPorts<Resource, Recipe, Provider>,
    control: GraphOperationControl = {}
  ) {
    return enrichPlannedGraph(resources, provider, enrichment, control);
  }

  return {
    prepare,
    compilePrepared,
    disposePrepared,
    authored,
    compare,
    comparePrepared,
    enrich
  };
}
