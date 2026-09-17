import { randomUUID } from "node:crypto";
import type { LifecycleResponseFor } from "@radius-project/core/lifecycle";
import {
  canvasResources,
  readCommittedGraphDiff,
  type GraphLifecycleReader
} from "../../runtime/graph-reader.js";
import type {
  CanvasGraphResource,
  CanvasState,
  GraphBuildEvent,
  GraphProgressView,
  GraphProgressRecord,
  GraphView,
  SourceRefContext
} from "../../shared.js";
import type { GraphInstanceEntry } from "./graph-pipeline.js";
import type {
  ResolvedWorkspaceBranch,
  WorkspaceBranchResolution
} from "../../workspace.js";

export type GraphWorkflowOutcome = {
  kind: "json" | "bare";
  status: number;
  payload: Record<string, unknown>;
};
export interface GraphWorkflowRequest {
  instanceId: string;
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
  lifecycle: GraphLifecycleReader | ((entry: TEntry) => GraphLifecycleReader);
  readInstanceEntry(instanceId: string): TEntry | undefined;
  resolveBranchForRequest(
    entry: TEntry,
    repo: string,
    requestedBranch: string,
    followWorkspaceBranch: boolean | undefined
  ): Promise<WorkspaceBranchResolution>;
  commitBranchResolution(
    entry: TEntry,
    repo: string,
    resolution: ResolvedWorkspaceBranch
  ): boolean;
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
  addGraphProgress(
    state: CanvasState,
    generation: number,
    view: GraphProgressView,
    event: Omit<GraphBuildEvent, "sequence">
  ): boolean;
  beginPlannedGraphRequest(state: CanvasState): number;
  isCurrentPlannedGraphRequest(state: CanvasState, generation: number): boolean;
  now(): number;
}

function json(
  status: number,
  payload: Record<string, unknown>
): GraphWorkflowOutcome {
  return { kind: "json", status, payload };
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createGraphPlanningWorkflows<TEntry extends GraphInstanceEntry>(
  deps: GraphWorkflowDependencies<TEntry>
): GraphPlanningWorkflows {
  if (
    typeof deps.lifecycle !== "function" &&
    (typeof deps.lifecycle?.execute !== "function" ||
      typeof deps.lifecycle.resolveCommittedSource !== "function")
  )
    throw new Error("Graph workflows require a canonical lifecycle reader.");
  async function read(
    request: GraphWorkflowRequest,
    view: GraphView
  ): Promise<GraphWorkflowOutcome> {
    const entry = deps.readInstanceEntry(request.instanceId);
    if (!entry)
      return {
        kind: "bare",
        status: 503,
        payload: { error: "Canvas server state is unavailable." }
      };
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      return json(400, { error: "Invalid JSON request." });
    }
    if (!record(body)) return json(400, { error: "Invalid graph request." });
    const repo = text(body.repo);
    const base = text(body.base);
    const head = text(body.head);
    const environment = text(body.environment);
    if (
      !repo ||
      (view === "diff" && (!base || !head)) ||
      (view === "planned" && !environment)
    )
      return json(400, {
        error: "Repository and the selected graph context are required."
      });
    const state = entry.state;
    const generation =
      view === "planned" ? deps.beginPlannedGraphRequest(state) : undefined;
    // Every request owns its context, even when repository and branch repeat.
    const context: Record<string, unknown> = {
      repo,
      branch: text(body.branch),
      baseBranch: base,
      headBranch: head,
      environment,
      requestId: randomUUID()
    };
    const token = deps.prepareSourceRefResources(entry, view, context).token;
    state.graphProgressRecords ??= {};
    const progressGeneration =
      (state.graphProgressRecords[view]?.graphProgressGeneration ?? 0) + 1;
    const progress: GraphProgressRecord = (state.graphProgressRecords[view] = {
      graphBuildEvents: [],
      graphProgressGeneration: progressGeneration,
      graphProgressStartedAtMs: deps.now(),
      graphProgressActive: true,
      graphProgressView: view,
      graphProgressKey: token,
      graphProgressOwner: progressGeneration,
      graphProgressAwaitingModel: false,
      graphProgressRepo: repo,
      graphProgressBranches:
        view === "diff" ? [base, head] : [text(body.branch)]
    });
    deps.addGraphProgress(state, progressGeneration, view, {
      stage: "building_graph",
      state: "running",
      detail: "Reading canonical graph evidence without changing source."
    });
    const contextRepo = state.contextRepo;
    const contextBranch = state.contextBranch;
    const current = () =>
      deps.readInstanceEntry(request.instanceId)?.state === state &&
      state.contextRepo === contextRepo &&
      state.contextBranch === contextBranch &&
      deps.isCurrentSourceRefToken(state, view, token) &&
      (generation === undefined ||
        deps.isCurrentPlannedGraphRequest(state, generation));
    const unavailable = (reason: string, message: string, source?: string) => {
      if (!current()) return json(409, { stale: true });
      if (view === "graph") delete state.graphResources;
      else if (view === "planned") delete state.plannedResources;
      else delete state.diffResources;
      state.graphReadEvidence ??= {};
      const evidence = {
        unavailable: true as const,
        reason,
        message,
        ...(source ? { source } : {})
      };
      state.graphReadEvidence[view] = evidence;
      deps.addGraphProgress(state, progressGeneration, view, {
        stage: "building_graph",
        state: "failed",
        detail: `${reason}: ${message}`
      });
      // Observed absence is a readable empty state, not a fabricated graph.
      // Unavailable/failed reads retain the legacy external-failure status.
      const status =
        reason === "DEFINITION_NOT_FOUND" ? 200
        : reason === "SOURCE_CHANGED" ? 409
        : 400;
      return json(status, { ...evidence, error: `${reason}: ${message}` });
    };
    try {
      const lifecycle =
        typeof deps.lifecycle === "function" ?
          deps.lifecycle(entry)
        : deps.lifecycle;
      if (view === "diff") {
        const result = await readCommittedGraphDiff(
          lifecycle,
          repo,
          base,
          head,
          text(body.definition) || undefined
        );
        if (!current()) return json(409, { stale: true });
        if (result.status !== "ok")
          return unavailable(result.error.code, result.error.message);
        if (result.value.status === "unavailable")
          return unavailable(
            result.value.reason,
            result.value.message,
            result.value.source
          );
        const resources = canvasResources(result.value.graph);
        context.provenance = {
          base: result.value.base,
          head: result.value.head
        };
        deps.setSourceRefResources(entry, view, resources, context, token);
        state.diffTargetRepo = repo;
        state.diffBase = base;
        state.diffHead = head;
        state.graphReadEvidence ??= {};
        state.graphReadEvidence.diff = {
          unavailable: false,
          result: result.value
        };
        return json(200, {
          message: `Comparing ${base} → ${head}`,
          resources,
          provenance: context.provenance
        });
      }
      const resolution = await deps.resolveBranchForRequest(
        entry,
        repo,
        text(body.branch),
        typeof body.followWorkspaceBranch === "boolean" ?
          body.followWorkspaceBranch
        : undefined
      );
      if (!current()) return json(409, { stale: true });
      if (resolution.status !== "resolved") {
        unavailable("SOURCE_UNAVAILABLE", resolution.error);
        return json(409, {
          error: resolution.error,
          workspaceBranchUnavailable: true,
          repo
        });
      }
      const branch = resolution.branch;
      // Only an attached workspace selection may omit source. Explicit remote
      // branches are resolved to commits before invoking the same graph service.
      const workspace =
        !!state.workspacePath &&
        repo === (state.workspaceRepo || state.contextRepo) &&
        (body.followWorkspaceBranch === true ||
          branch === (state.workspaceBranch || state.contextBranch));
      let source;
      if (!workspace) {
        const resolved = await lifecycle.resolveCommittedSource(repo, branch);
        if (!current()) return json(409, { stale: true });
        if (resolved.status !== "ok")
          return unavailable(
            "SOURCE_UNAVAILABLE",
            "The selected committed source is unavailable."
          );
        source = resolved.value;
      }
      const response = await lifecycle.execute({
        operation: "graph.get",
        target: {
          repo,
          definition: text(body.definition) || ".radius/app.bicep",
          ...(source ? { source } : {}),
          ...(view === "planned" ? { environment } : {})
        },
        input: { kind: view === "planned" ? "planned" : "authored" }
      });
      if (!current()) return json(409, { stale: true });
      if ("error" in response)
        return unavailable(response.error.code, response.error.message);
      if (
        response.operation !== "graph.get" ||
        response.result.kind !== (view === "planned" ? "planned" : "authored")
      )
        return unavailable(
          "EVIDENCE_MISMATCH",
          "The graph result does not match the requested view."
        );
      if (!deps.commitBranchResolution(entry, repo, resolution))
        return json(409, { stale: true });
      const result: LifecycleResponseFor<"graph.get">["result"] =
        response.result;
      const resources = canvasResources(result.graph);
      context.branch = branch;
      context.provenance = result.provenance;
      deps.setSourceRefResources(entry, view, resources, context, token);
      state.graphReadEvidence ??= {};
      state.graphReadEvidence[view] = { unavailable: false, result };
      if (view === "graph") {
        state.graphTargetRepo = repo;
        state.graphBranch = branch;
        state.graphLoaded = true;
        state.graphFromWorkspace = result.provenance.kind === "workspace";
        state.graphModelRevision =
          result.provenance.kind === "workspace" ?
            result.provenance.fingerprint
          : undefined;
        state.graphFollowsWorkspaceBranch = resolution.followsWorkspaceBranch;
      } else {
        state.plannedRepo = repo;
        state.plannedBranch = branch;
        state.plannedEnvironment = environment;
        state.plannedFromWorkspace = result.provenance.kind === "workspace";
        state.plannedFollowsWorkspaceBranch = resolution.followsWorkspaceBranch;
      }
      return json(200, {
        resources,
        branch,
        resolvedBranch: branch,
        followsWorkspaceBranch: resolution.followsWorkspaceBranch,
        fromWorkspace: result.provenance.kind === "workspace",
        provenance: result.provenance,
        observation: result.observation,
        ...(result.kind === "planned" ? { enrichment: result.enrichment } : {})
      });
    } catch {
      return unavailable(
        "RESULT_UNAVAILABLE",
        "The graph read could not be completed."
      );
    } finally {
      if (state.graphProgressRecords?.[view] === progress) {
        progress.graphProgressActive = false;
        if (current() && state.graphReadEvidence?.[view]?.unavailable === false)
          deps.addGraphProgress(state, progressGeneration, view, {
            stage: "building_graph",
            state: "succeeded",
            detail: "Canonical graph evidence is ready."
          });
      }
    }
  }
  return {
    loadGraph: (request) => read(request, "graph"),
    planGraph: (request) => read(request, "planned"),
    diffBranches: (request) => read(request, "diff")
  };
}
