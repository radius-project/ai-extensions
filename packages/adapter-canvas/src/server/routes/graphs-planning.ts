import {
  canvasResources,
  type GraphLifecycleReader
} from "../../runtime/graph-reader.js";
import type { CanvasState } from "../../shared.js";
import { retainedMonitoring } from "../services/retained-monitoring.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { GraphPlanningWorkflows } from "./graph-workflows.js";

export interface DeployedGraphInstanceEntry {
  state?: CanvasState;
}
export interface GraphsPlanningReadsDependencies {
  readInstanceEntry(instanceId: string): DeployedGraphInstanceEntry | undefined;
  lifecycle(instanceId: string): GraphLifecycleReader;
  now(): number;
}
export interface GraphsPlanningStreamDependencies {
  readInstanceEntry(instanceId: string): DeployedGraphInstanceEntry | undefined;
  workflows: Pick<GraphPlanningWorkflows, "loadGraph">;
}

export async function handleProgress(
  context: CanvasRequestContext,
  deps: GraphsPlanningReadsDependencies
): Promise<void> {
  const state = deps.readInstanceEntry(context.instanceId)?.state;
  const view = context.url.searchParams.get("view");
  const records = state?.graphProgressRecords ?? {};
  const values = Object.values(records);
  const active = values.filter((record) => record.graphProgressActive);
  const record =
    view === "graph" || view === "planned" || view === "diff" ?
      records[view]
    : (active.length ? active : values).sort(
        (a, b) => b.graphProgressStartedAtMs - a.graphProgressStartedAtMs
      )[0];
  context.response.setHeader("Content-Type", "application/json");
  context.response.writeHead(200);
  context.response.end(
    JSON.stringify({
      messages: state?.progressMessages || [],
      ...(record ?
        {
          events: record.graphBuildEvents,
          generation: record.graphProgressGeneration,
          active: record.graphProgressActive,
          view: record.graphProgressView,
          elapsedMs: Math.max(0, deps.now() - record.graphProgressStartedAtMs)
        }
      : {})
    })
  );
}

export async function handleDeployedGraph(
  context: CanvasRequestContext,
  deps: GraphsPlanningReadsDependencies
): Promise<void> {
  const entry = deps.readInstanceEntry(context.instanceId);
  const state = entry?.state;
  const selection = () =>
    JSON.stringify([
      state?.contextRepo,
      state?.deployingRepo,
      state?.plannedRepo,
      state?.graphTargetRepo,
      state?.deployEnvName,
      state?.plannedEnvironment,
      state?.envName,
      state?.deployAppName,
      state?.appName,
      state?.deployRunId,
      state?.deployGeneration
    ]);
  const selectedContext = selection();
  const current = () =>
    deps.readInstanceEntry(context.instanceId)?.state === state &&
    selection() === selectedContext;
  const repo =
    context.url.searchParams.get("repo")?.trim() ||
    state?.contextRepo ||
    state?.deployingRepo ||
    state?.plannedRepo ||
    state?.graphTargetRepo ||
    "";
  const environment =
    context.url.searchParams.get("environment") ||
    state?.deployEnvName ||
    state?.plannedEnvironment ||
    state?.envName ||
    "";
  const application =
    context.url.searchParams.get("application") ||
    state?.deployAppName ||
    (typeof state?.appName === "string" ? state.appName : "");
  if (!repo) {
    context.json(200, {
      resources: [],
      repo: "",
      mode: "greyed",
      deletionInventory: null
    });
    return;
  }
  try {
    const result = await deps.lifecycle(context.instanceId).execute({
      operation: "graph.get",
      target: { repo, environment, application },
      input: { kind: "deployed" }
    });
    if (!current()) {
      context.json(200, { stale: true });
      return;
    }
    if ("error" in result) {
      const monitoring = retainedMonitoring(
        state,
        { repo, environment, application },
        result.error.code
      );
      context.json(200, {
        unavailable: true,
        reason: result.error.code,
        error: result.error.message,
        mode: "unavailable",
        deletionInventory: null,
        ...(monitoring ? { retainedMonitoring: monitoring } : {})
      });
      return;
    }
    if (result.operation !== "graph.get" || result.result.kind !== "deployed")
      throw new Error("Unexpected graph evidence.");
    context.json(200, {
      resources: canvasResources(result.result.graph),
      repo,
      environment,
      application,
      mode: "deployed",
      provenance: result.result.provenance,
      observation: result.result.observation,
      deletionInventory: null
    });
  } catch {
    if (!current()) {
      context.json(200, { stale: true });
      return;
    }
    context.json(200, {
      unavailable: true,
      reason: "RESULT_UNAVAILABLE",
      error: "The deployed observation is unavailable.",
      mode: "unavailable",
      deletionInventory: null
    });
  }
}

export async function handleLoadGraphStream(
  context: CanvasRequestContext,
  deps: GraphsPlanningStreamDependencies
): Promise<void> {
  const { response, url, instanceId } = context;
  if (!deps.readInstanceEntry(instanceId)) {
    response.writeHead(503);
    response.end("Canvas server state is unavailable.");
    return;
  }
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.writeHead(200);
  response.write(
    `event: progress\ndata: ${JSON.stringify({ message: "Reading the authored application graph." })}\n\n`
  );
  let payload: Record<string, unknown>;
  try {
    const outcome = await deps.workflows.loadGraph({
      instanceId,
      body: JSON.stringify({
        repo: url.searchParams.get("repo") || "",
        branch: url.searchParams.get("branch") || "",
        ...(url.searchParams.has("followWorkspaceBranch") ?
          {
            followWorkspaceBranch:
              url.searchParams.get("followWorkspaceBranch") === "true"
          }
        : {}),
        refresh: true
      })
    });
    payload = {
      ...outcome.payload,
      ...(typeof outcome.payload.branch === "string" ?
        { resolvedBranch: outcome.payload.branch }
      : {})
    };
  } catch {
    payload = {
      unavailable: true,
      reason: "RESULT_UNAVAILABLE",
      error: "The graph read could not be completed."
    };
  }
  response.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
  response.end();
}

export function createGraphsPlanningRoutes(
  deps: GraphsPlanningReadsDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/progress": (context) => handleProgress(context, deps),
    "GET /api/deployed-graph": (context) => handleDeployedGraph(context, deps)
  };
}
export function createGraphsPlanningStreamRoutes(
  deps: GraphsPlanningStreamDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/load-graph-stream": (context) =>
      handleLoadGraphStream(context, deps)
  };
}
