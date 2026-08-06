import type {
  CanvasGraphResource,
  CanvasState,
  GraphView,
  SourceRefContext
} from "./shared.js";

export interface SourceRefEntry {
  page?: string;
  state: CanvasState;
}

export interface SourceRefContextInput {
  [key: string]: unknown;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  headBranch?: string;
}

export interface SourceRefUpdate {
  id: string;
  codeReference: string;
}

function isGraphView(view: unknown): view is GraphView {
  return view === "graph" || view === "planned" || view === "diff";
}

function sourceRefToken(
  view: GraphView,
  context: SourceRefContextInput
): string {
  const branch =
    view === "diff" ?
      `${context.baseBranch || ""}...${context.headBranch || ""}`
    : context.branch || "";
  return `${view}|${context.repo || ""}|${branch}`;
}

export function prepareSourceRefResources(
  entry: SourceRefEntry,
  view: unknown,
  context: SourceRefContextInput
): SourceRefContext {
  if (!isGraphView(view)) throw new Error(`Unknown graph view: ${view}`);
  const token = sourceRefToken(view, context);
  if (!entry.state.sourceRefContexts) entry.state.sourceRefContexts = {};
  const previousToken = entry.state.sourceRefContexts[view]?.token;
  entry.state.sourceRefContexts[view] = { ...context, view, token };
  if (previousToken && previousToken !== token) {
    setResources(entry.state, view, null);
    if (Array.isArray(entry.state.pendingSourceRefs)) {
      entry.state.pendingSourceRefs = entry.state.pendingSourceRefs.filter(
        (ref) => ref.contextToken !== previousToken
      );
    }
  }
  return entry.state.sourceRefContexts[view];
}

function setResources(
  state: CanvasState,
  view: GraphView,
  resources: CanvasGraphResource[] | null
): void {
  if (view === "graph") state.graphResources = resources;
  else if (view === "planned") state.plannedResources = resources;
  else state.diffResources = resources;
}

function getResources(
  state: CanvasState,
  view: GraphView
): CanvasGraphResource[] | null | undefined {
  if (view === "graph") return state.graphResources;
  if (view === "planned") return state.plannedResources;
  return state.diffResources;
}

export function setSourceRefResources(
  entry: SourceRefEntry,
  view: unknown,
  resources: CanvasGraphResource[],
  context: SourceRefContextInput,
  expectedToken?: string
): boolean {
  if (!isGraphView(view)) throw new Error(`Unknown graph view: ${view}`);
  const currentToken = entry.state.sourceRefContexts?.[view]?.token;
  if (expectedToken && currentToken !== expectedToken) return false;

  const sourceRefContext = prepareSourceRefResources(entry, view, context);
  setResources(entry.state, view, resources);

  if (!Array.isArray(entry.state.pendingSourceRefs)) return true;
  entry.state.pendingSourceRefs = entry.state.pendingSourceRefs.filter(
    (ref) => {
      if (ref.contextToken !== sourceRefContext.token) return true;
      const resource = resources.find((candidate) => candidate.id === ref.id);
      if (resource && !resource.codeReference)
        resource.codeReference = ref.codeReference;
      return false;
    }
  );
  return true;
}

export function getSourceRefResources(
  entry: SourceRefEntry,
  requestedView?: string
): {
  ready: boolean;
  view: string;
  context?: SourceRefContext;
  resources: CanvasGraphResource[];
} {
  const pageView =
    entry.page === "planned" ? "planned"
    : entry.page === "graph-diff" || entry.page === "graphDiff" ? "diff"
    : entry.page === "graph" ? "graph"
    : null;
  const view =
    requestedView || pageView || entry.state.activeGraphView || "graph";
  if (!isGraphView(view)) return { ready: false, view, resources: [] };
  const context = entry.state.sourceRefContexts?.[view];
  const resources = getResources(entry.state, view);
  if (!context || !Array.isArray(resources)) {
    return { ready: false, view, resources: [] };
  }
  return { ready: true, view, context, resources };
}

export function updateSourceRefs(
  entry: SourceRefEntry,
  contextToken: string,
  refs: readonly SourceRefUpdate[]
): {
  error?: string;
  updated: number;
  queued: number;
  skipped: number;
  view?: GraphView;
} {
  const context = Object.values(entry.state.sourceRefContexts || {}).find(
    (candidate) => candidate.token === contextToken
  );
  if (!context) {
    return {
      error: "Graph context is stale or unknown. Fetch graph resources again.",
      updated: 0,
      queued: 0,
      skipped: refs.length
    };
  }

  const resources = getResources(entry.state, context.view);
  if (!Array.isArray(entry.state.pendingSourceRefs))
    entry.state.pendingSourceRefs = [];
  let updated = 0;
  let queued = 0;
  let skipped = 0;

  for (const ref of refs) {
    const resource =
      Array.isArray(resources) ?
        resources.find((candidate) => candidate.id === ref.id)
      : null;
    if (resource?.codeReference) {
      skipped++;
      continue;
    }
    if (resource) {
      resource.codeReference = ref.codeReference;
      updated++;
      continue;
    }

    const existing = entry.state.pendingSourceRefs.find(
      (candidate) =>
        candidate.contextToken === contextToken && candidate.id === ref.id
    );
    if (existing) existing.codeReference = ref.codeReference;
    else
      entry.state.pendingSourceRefs.push({
        contextToken,
        id: ref.id,
        codeReference: ref.codeReference
      });
    queued++;
  }

  return { updated, queued, skipped, view: context.view };
}
