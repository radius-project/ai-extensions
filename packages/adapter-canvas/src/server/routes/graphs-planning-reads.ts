import type { DeployStatus } from "@radius-project/core";
import type { DeployProgress } from "../../deploy-artifacts.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

// The two read-only halves of the `graphs-planning` family: the progress log the
// page polls, and the deployed-graph projection. They are migrated together
// because they are genuinely coupled — a failed status read inside
// `/api/deployed-graph` appends to the very array `/api/progress` serves — and
// splitting them would put the two ends of that coupling on opposite sides of
// the dispatcher boundary.

// Shaped exactly like the reader `createDeployStatusReader` returns, minus every
// member these routes do not call. Declaring only `graph` and `progress` keeps a
// handler from quietly reaching for `read`, `status`, `sequence` or
// `controlPlaneLog`, none of which the legacy branch touched.
export interface DeployedGraphStatusReader {
  graph(): Promise<{ graph: unknown | null; status: string }>;
  progress(): Promise<DeployProgress | null>;
}

export interface DeployedGraphReaderOptions {
  repo: string;
  environment: string;
  application: string;
  runId: number | string | null;
}

// The instance entry as these routes see it. Only `state` is declared, and it is
// declared optional because the legacy branches read it through `entry?.state?.`.
// The entry indirection is kept rather than flattened to a state reader because
// the two are not equivalent: a missing entry and an entry with empty state must
// stay distinguishable, and `handleDeployedGraph` relies on that distinction
// when it gates its `progressMessages` append on `entry?.state` below. Flattening
// to a `{}` snapshot would make a missing instance silently accumulate messages
// no `/api/progress` reader could ever serve.
export interface DeployedGraphInstanceEntry {
  state?: CanvasState;
}

// Ten narrow function seams for two routes. Nothing is moved: the cached reader
// factory, the status/message map builders and the workspace-repo predicate stay
// in `server.ts`, and the projection helpers stay in `@radius-project/core` and
// `deploy-artifacts.ts`. Every one of them is handed in, so this module owns no
// cache, spawns no process and reads no module-level mutable state.
export interface GraphsPlanningReadsDependencies {
  // Returns undefined when the instance has no entry, which is what the legacy
  // `servers.get(instanceId)` miss meant. The request context's `state` snapshot
  // substitutes `{}` for a missing entry, and the deployed-graph handler must be
  // able to tell the two apart: a missing entry receives no progress message.
  readInstanceEntry(instanceId: string): DeployedGraphInstanceEntry | undefined;
  // The *cached* reader factory, not the raw constructor. Its TTL cache,
  // single-flight de-dup and monotonic sequence guard live in the reader
  // instance, so building a fresh one per request would make all three inert.
  createDeployStatusReader(
    options: DeployedGraphReaderOptions
  ): DeployedGraphStatusReader;
  buildDeployStatusMap(
    progress: DeployProgress | null | undefined
  ): Map<string, DeployStatus>;
  buildDeployMessageMap(
    progress: DeployProgress | null | undefined
  ): Map<string, string>;
  deployStatusKeys(resource: unknown): string[];
  projectDeployedGraph(
    modeled: unknown[],
    statusByKey: Map<string, DeployStatus>
  ): unknown[];
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  applyDeployMessages(
    resources: CanvasGraphResource[],
    messageMap: Map<string, string>
  ): void;
  record(value: unknown): Record<string, unknown>;
  errorMessage(error: unknown): string;
  repoMatchesWorkspace(state: CanvasState, repo: string): boolean;
}

// The progress log the deploying page polls. Read-only and synchronous: the
// messages are appended elsewhere, including by `/api/deployed-graph` below.
export function handleProgress(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningReadsDependencies
): void {
  const { response } = context;
  const entry = dependencies.readInstanceEntry(context.instanceId);
  const messages = entry?.state?.progressMessages || [];
  response.setHeader("Content-Type", "application/json");
  response.writeHead(200);
  response.end(JSON.stringify({ messages }));
}

// The Deployed view is a projection: a fixed topology (the modeled application)
// painted with a per-resource status that is resolved separately. Keeping them
// independent means the graph renders before any status is known and never
// changes shape when a deploy starts or ends.
//
//   live     - a deploy is in flight for this selection.
//   terminal - a deployment's status is known.
//   greyed   - nothing is known; every node renders pending.
//
// Four ordering-precedence chains are load-bearing and preserved verbatim: the
// repo fallback chain, the topology fallback chain, the mode ladder, and the
// first-wins seeding of the status and message maps. The seeding order matters
// most — the deploy monitor's own resources are seeded BEFORE the artifact read,
// so a terminal deploy keeps its colors even when the read comes back empty.
export async function handleDeployedGraph(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningReadsDependencies
): Promise<void> {
  const { response, url } = context;
  const entry = dependencies.readInstanceEntry(context.instanceId);
  const repo =
    (url.searchParams.get("repo") || "").trim() ||
    entry?.state?.contextRepo ||
    entry?.state?.deployingRepo ||
    entry?.state?.plannedRepo ||
    entry?.state?.graphTargetRepo ||
    "";
  // Set before the empty-repo branch, so both exits carry it.
  response.setHeader("Content-Type", "application/json");
  if (!repo) {
    response.writeHead(200);
    response.end(JSON.stringify({ resources: [], repo: "", mode: "greyed" }));
    return;
  }
  const state = entry?.state || {};
  const branch =
    state.workspaceBranch && dependencies.repoMatchesWorkspace(state, repo) ?
      state.workspaceBranch
    : "main";

  // The page's selectors are authoritative: the user can pick an environment
  // other than the one this session last deployed to, and the graph must follow
  // the selection rather than silently rendering another environment's deploy
  // under the selected environment's label.
  const sessionEnv = state.deployEnvName || state.envName || "";
  const requestedEnv =
    (url.searchParams.get("environment") || "").trim() || sessionEnv;
  const requestedApp =
    (url.searchParams.get("application") || "").trim() ||
    state.deployAppName ||
    "";

  // This session's own deploy status only describes the environment it deployed
  // to, so it is used only when the selection matches. An empty side on either
  // end means "unconstrained" and matches, which is what makes the very first
  // poll — before any environment is chosen — show the session's own deploy.
  // `!requestedEnv` is redundant by construction — `requestedEnv` falls back to
  // `sessionEnv`, so an empty `requestedEnv` implies an empty `sessionEnv` — but
  // it is kept because legacy has it and removing it would be a rewrite, not a
  // migration. Mutation testing confirms it as an equivalent mutant.
  const sessionMatchesSelection =
    !requestedEnv ||
    !sessionEnv ||
    requestedEnv.toLowerCase() === sessionEnv.toLowerCase();
  const deploying =
    state.deployStatus === "in_progress" && sessionMatchesSelection;

  const statusByKey = new Map<string, DeployStatus>();
  // The resources the deploy monitor tracks are the freshest status this process
  // has, both during a run and after it settles. Seed from them first so a
  // terminal deploy keeps its colors even when the artifact read comes back
  // empty — repainting a just-deployed app as pending would reproduce the very
  // bug this transport replaced.
  if (sessionMatchesSelection && Array.isArray(state.deployingResources)) {
    for (const resource of state.deployingResources) {
      const status = resource?.deployStatus as DeployStatus | undefined;
      if (!status || status === "pending") continue;
      for (const key of dependencies.deployStatusKeys(resource)) {
        if (!statusByKey.has(key)) statusByKey.set(key, status);
      }
    }
  }

  let graph: unknown = null;
  let readOk = false;
  let updatedAt: string | null = null;
  // The app selector is a hint, not a hard filter: the reader falls back to an
  // env-only match when the selected app has no artifact yet (the app name can
  // itself be a guess from the repo short name). Surface the app it actually
  // resolved so the page can say which one is on screen rather than mislabeling
  // another app's status under the selected name.
  let resolvedApp: string | null = requestedApp || null;
  const messageByKey = new Map<string, string>();
  try {
    const reader = dependencies.createDeployStatusReader({
      repo,
      environment: requestedEnv,
      application: requestedApp,
      // While a deploy is in flight, scope to its run so a previous
      // deployment's newest-repo-wide artifact can't overwrite the live
      // topology/status. The in-flight run hasn't uploaded yet, so this read is
      // empty and the seeded live statuses stand. `??` rather than `||`: a run
      // id of 0 is a real id and must not fall through to null.
      runId: deploying ? (state.deployRunId ?? null) : null
    });
    const result = await reader.graph();
    graph = result.graph;
    readOk = result.status === "ok" || result.status === "stale";
    const progress = await reader.progress();
    updatedAt = progress?.updatedAt || null;
    if (progress?.application) resolvedApp = progress.application;
    for (const [key, status] of dependencies.buildDeployStatusMap(progress)) {
      if (!statusByKey.has(key)) statusByKey.set(key, status);
    }
    // The first-wins guard is load-bearing above, where `statusByKey` arrives
    // pre-seeded. Here `messageByKey` is only ever filled from this one Map, so
    // the guard is unreachable — an equivalent mutant, preserved verbatim.
    for (const [key, message] of dependencies.buildDeployMessageMap(progress)) {
      if (!messageByKey.has(key)) messageByKey.set(key, message);
    }
  } catch (e) {
    // A status read failure must not blank the tab: fall through to the seeded
    // statuses and the modeled topology. The message is appended to the same
    // array `/api/progress` serves, which is the one piece of cross-route state
    // this pair shares.
    if (entry?.state) {
      if (!entry.state.progressMessages) entry.state.progressMessages = [];
      entry.state.progressMessages.push(
        `Deployed graph status read failed: ${dependencies.errorMessage(e)}`
      );
    }
  }
  if (!graph && sessionMatchesSelection && state.deployedGraph)
    graph = state.deployedGraph;

  // A deployment is "terminal" when its status is known, which is not the same
  // as having a published graph: the producer only attaches deploy-graph.json to
  // its final upload, so a run can report real per-resource status with no graph
  // at all.
  const mode: "live" | "terminal" | "greyed" =
    deploying ? "live"
    : statusByKey.size > 0 || readOk || graph ? "terminal"
    : "greyed";

  // Topology: prefer the graph the deploy actually published (it reflects what
  // is running), falling back to the modeled resources so the skeleton renders
  // before anything has ever been deployed.
  const graphRecord = dependencies.record(graph);
  let topology: unknown[] =
    Array.isArray(graph) ? graph
    : Array.isArray(graphRecord.resources) ? graphRecord.resources
    : [];
  if (topology.length === 0) {
    topology =
      (sessionMatchesSelection ? state.deployingResources : null) ||
      state.plannedResources ||
      state.graphResources ||
      [];
  }

  const resources = dependencies.canvasGraphResources(
    dependencies.projectDeployedGraph(topology, statusByKey)
  );
  // Attach the producer's per-resource message so a red node can explain itself
  // in the popup instead of just being red.
  dependencies.applyDeployMessages(resources, messageByKey);
  response.writeHead(200);
  response.end(
    JSON.stringify({
      resources,
      repo,
      branch,
      mode,
      updatedAt,
      application: resolvedApp
    })
  );
}

export function createGraphsPlanningReadsRoutes(
  dependencies: GraphsPlanningReadsDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/progress": (context) => handleProgress(context, dependencies),
    "GET /api/deployed-graph": (context) =>
      handleDeployedGraph(context, dependencies)
  };
}
