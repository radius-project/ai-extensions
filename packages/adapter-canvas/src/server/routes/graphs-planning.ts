import {
  evaluateAppSource,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "@radius-project/core";
import type { DeployStatus } from "@radius-project/core";
import type {
  DeployProgress,
  WorkflowArtifact
} from "../../deploy-artifacts.js";
import { recordGraphBuildEvent } from "../../shared.js";
import { GRAPH_APP_BICEP_TIMEOUT_MESSAGE } from "../../graph-progress-contract.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import type { GraphProgressRecord, GraphProgressView } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { CanvasServerEntry } from "../types.js";

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
  graph(): Promise<{
    graph: unknown | null;
    status: string;
    artifact?: WorkflowArtifact | null;
  }>;
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
  loadModeledGraph(
    instanceId: string,
    repo: string,
    branch: string
  ): Promise<{ status: number; error?: string; retry?: boolean }>;
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
  mergeDeployedGraphMetadata(modeled: unknown[], deployed: unknown): unknown[];
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  applyDeployMessages(
    resources: CanvasGraphResource[],
    messageMap: Map<string, string>
  ): void;
  settleDeployStatuses(
    resources: Array<{ deployStatus?: DeployStatus }>,
    conclusion?: string | null
  ): void;
  errorMessage(error: unknown): string;
  repoMatchesWorkspace(state: CanvasState, repo: string): boolean;
  // Wall clock for the build record's elapsed time.
  now(): number;
}

// Graph workflows publish typed events. Keep legacy messages for deployed-graph
// diagnostics until that independent status-read path is migrated.
//
// `generation` identifies which workflow owns the event stream. Polling is
// concurrent with the workflow request itself, so a reader that only saw
// `events` could apply an older in-flight response over a newer snapshot and
// visibly regress the reported stage.
export function handleProgress(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningReadsDependencies
): void {
  const { response, url } = context;
  const entry = dependencies.readInstanceEntry(context.instanceId);
  const state = entry?.state;
  const records = Object.values(state?.graphProgressRecords ?? {});
  for (const record of records) {
    if (
      record.graphProgressActive &&
      record.graphProgressAwaitingModel &&
      typeof record.graphProgressDeadlineAtMs === "number" &&
      dependencies.now() >= record.graphProgressDeadlineAtMs
    ) {
      recordGraphBuildEvent(record, {
        stage: "creating_model",
        state: "failed",
        detail: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
      });
      record.graphProgressActive = false;
      record.graphProgressAwaitingModel = false;
      delete record.graphProgressDeadlineAtMs;
    }
  }
  const requestedView = url.searchParams.get("view");
  const record =
    isGraphProgressView(requestedView) ?
      state?.graphProgressRecords?.[requestedView]
    : latestGraphProgressRecord(records);
  const payload: Record<string, unknown> = {
    messages: state?.progressMessages || []
  };
  if (record) {
    payload.events = record.graphBuildEvents;
    payload.generation = record.graphProgressGeneration;
    // The record's own view of itself: whether work is still in flight, which
    // graph it belongs to, and how long it has been running. A page mounted
    // after the build started — or re-mounted when the user navigates back —
    // adopts these rather than measuring from the moment it happened to load.
    payload.active = record.graphProgressActive;
    payload.view = record.graphProgressView;
    payload.elapsedMs = Math.max(
      0,
      dependencies.now() - record.graphProgressStartedAtMs
    );
  }

  function isGraphProgressView(
    value: string | null
  ): value is GraphProgressView {
    return value === "graph" || value === "planned" || value === "diff";
  }

  function latestGraphProgressRecord(
    records: GraphProgressRecord[]
  ): GraphProgressRecord | undefined {
    const active = records.filter((record) => record.graphProgressActive);
    const candidates = active.length > 0 ? active : records;
    return candidates.reduce<GraphProgressRecord | undefined>(
      (latest, record) =>
        (
          !latest ||
          record.graphProgressStartedAtMs > latest.graphProgressStartedAtMs
        ) ?
          record
        : latest,
      undefined
    );
  }
  response.setHeader("Content-Type", "application/json");
  response.writeHead(200);
  response.end(JSON.stringify(payload));
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
// The deploy monitor seeds status before the artifact read. A validated
// artifact is a newer monotonic snapshot for the same run, so its mentioned
// keys overwrite the seed while omitted resources retain monitor state.
// Topology has one authority: graphResources for the selected repo and branch,
// populated on demand through the graph workflow.
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
  if (entry?.state) entry.state.progressMessages = [];
  const branch =
    state.workspaceBranch && dependencies.repoMatchesWorkspace(state, repo) ?
      state.workspaceBranch
    : state.contextRepo === repo && state.contextBranch ? state.contextBranch
    : state.deployingRepo === repo && state.deployingBranch ?
      state.deployingBranch
    : state.plannedRepo === repo && state.plannedBranch ? state.plannedBranch
    : state.graphTargetRepo === repo && state.graphBranch ? state.graphBranch
    : "main";

  const modeledGraphMatchesSelection =
    state.graphTargetRepo === repo &&
    state.graphBranch === branch &&
    Array.isArray(state.graphResources);
  if (!modeledGraphMatchesSelection) {
    const modeled = await dependencies.loadModeledGraph(
      context.instanceId,
      repo,
      branch
    );
    if (modeled.error) {
      response.writeHead(modeled.status);
      response.end(
        JSON.stringify({ error: modeled.error, retry: modeled.retry === true })
      );
      return;
    }
  }

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

  // In-session monitor data is fresher than artifacts, but only for the exact
  // selection it describes. Empty values remain unconstrained so the first poll
  // can show a deploy before every selector has initialized.
  const exactSelectionPartMatches = (
    session: string,
    selected: string
  ): boolean => !session || !selected || session === selected;
  const namedSelectionPartMatches = (
    session: string,
    selected: string
  ): boolean =>
    !session || !selected || session.toLowerCase() === selected.toLowerCase();
  const sessionRepo = state.deployingRepo || state.contextRepo || "";
  const sessionBranch =
    state.deployingBranch || state.contextBranch || state.graphBranch || "";
  const sessionMatchesSelection =
    exactSelectionPartMatches(sessionRepo, repo) &&
    exactSelectionPartMatches(sessionBranch, branch) &&
    namedSelectionPartMatches(sessionEnv, requestedEnv) &&
    namedSelectionPartMatches(state.deployAppName || "", requestedApp);
  const deploying =
    state.deployStatus === "in_progress" && sessionMatchesSelection;

  const statusByKey = new Map<string, DeployStatus>();
  // Seed the resources the deploy monitor tracks so an empty artifact read keeps
  // their status. A valid artifact later overwrites only the keys it mentions.
  if (sessionMatchesSelection && Array.isArray(state.deployingResources)) {
    for (const resource of state.deployingResources) {
      const status = resource?.deployStatus as DeployStatus | undefined;
      if (!status || status === "pending") continue;
      for (const key of dependencies.deployStatusKeys(resource)) {
        if (!statusByKey.has(key)) statusByKey.set(key, status);
      }
    }
  }

  let publishedGraph: unknown = null;
  let readOk = false;
  let updatedAt: string | null = null;
  let progress: DeployProgress | null = null;
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
    publishedGraph = result.graph;
    readOk = result.status === "ok" || result.status === "stale";
    progress = await reader.progress();
    const artifactRunMismatchesSession =
      sessionMatchesSelection &&
      state.deployRunId != null &&
      progress?.runId != null &&
      String(progress.runId) !== String(state.deployRunId);
    const attemptBoundary = Math.max(
      state.deployStartedAt ?? 0,
      state.deployFinishedAt ?? 0
    );
    const artifactCreatedAt = Date.parse(result.artifact?.created_at ?? "");
    const mismatchedArtifactIsNewer =
      !artifactRunMismatchesSession ||
      (!deploying &&
        attemptBoundary > 0 &&
        Number.isFinite(artifactCreatedAt) &&
        artifactCreatedAt > attemptBoundary);
    const activeArtifactMatchesRun =
      deploying ?
        state.deployRunId != null &&
        progress?.runId != null &&
        String(progress.runId) === String(state.deployRunId)
      : mismatchedArtifactIsNewer;
    if (!activeArtifactMatchesRun) {
      // Run discovery has not completed, or an unscoped read found a previous
      // run. Keep the active monitor state and do not expose stale graph metadata.
      publishedGraph = null;
      readOk = false;
      progress = null;
    } else {
      updatedAt = progress?.updatedAt || null;
      if (progress?.application) resolvedApp = progress.application;
      if (artifactRunMismatchesSession) {
        statusByKey.clear();
      }
      for (const [key, status] of dependencies.buildDeployStatusMap(progress)) {
        statusByKey.set(key, status);
      }
      // Messages have no in-session seed, so first-wins only protects duplicate
      // weaker identity keys within this one snapshot.
      for (const [key, message] of dependencies.buildDeployMessageMap(
        progress
      )) {
        if (!messageByKey.has(key)) messageByKey.set(key, message);
      }
    }
  } catch (e) {
    // A status read failure must not blank the tab: fall through to the seeded
    // statuses and the modeled topology. The message is appended to the same
    // array `/api/progress` serves, which is the one piece of cross-route state
    // this pair shares.
    if (entry?.state) {
      entry.state.progressMessages = [
        `Deployed graph status read failed: ${dependencies.errorMessage(e)}`
      ];
    }
  }
  const hasPublishedGraph =
    publishedGraph != null ||
    (sessionMatchesSelection && state.deployedGraph != null);
  const artifactMatchesSessionRun =
    progress?.runId == null ||
    state.deployRunId == null ||
    String(progress.runId) === String(state.deployRunId);

  const terminalConclusion =
    (
      !deploying &&
      sessionMatchesSelection &&
      artifactMatchesSessionRun &&
      state.deployStatus === "complete"
    ) ?
      "success"
    : (
      !deploying &&
      sessionMatchesSelection &&
      artifactMatchesSessionRun &&
      state.deployStatus === "failed" &&
      state.deployRunId != null &&
      !state.deployErrorKind
    ) ?
      "failure"
    : !deploying && progress?.state === "succeeded" ? "success"
    : !deploying && progress?.state === "failed" ? "failure"
    : null;

  // A deployment is "terminal" when its status is known, which is not the same
  // as having a published graph: the producer only attaches deploy-graph.json to
  // its final upload, so a run can report real per-resource status with no graph
  // at all.
  const mode: "live" | "terminal" | "greyed" =
    deploying ? "live"
    : (
      statusByKey.size > 0 || readOk || hasPublishedGraph || terminalConclusion
    ) ?
      "terminal"
    : "greyed";

  // deploy-graph.json is terminal metadata only. It can be sparse after a failed
  // deployment and does not preserve modeled connections, so it must never
  // replace the selected branch's fixed modeled topology.
  const topology =
    (
      state.graphTargetRepo === repo &&
      state.graphBranch === branch &&
      Array.isArray(state.graphResources)
    ) ?
      state.graphResources
    : [];

  const plannedMetadataMatchesSelection =
    terminalConclusion !== "failure" &&
    !!state.deployProvider &&
    state.plannedProvider === state.deployProvider &&
    state.plannedRepo === repo &&
    state.plannedBranch === branch &&
    (!requestedEnv ||
      (!!state.plannedEnvironment &&
        namedSelectionPartMatches(state.plannedEnvironment, requestedEnv))) &&
    Array.isArray(state.plannedResources);
  const providerResolvedTopology = dependencies.mergeDeployedGraphMetadata(
    topology,
    plannedMetadataMatchesSelection ? state.plannedResources : null
  );
  const deploymentMetadata =
    publishedGraph ??
    (!deploying && sessionMatchesSelection ? state.deployedGraph : null) ??
    null;
  const enrichedTopology = dependencies.mergeDeployedGraphMetadata(
    providerResolvedTopology,
    deploymentMetadata
  );
  const resources = dependencies.canvasGraphResources(
    dependencies.projectDeployedGraph(enrichedTopology, statusByKey)
  );
  // Attach the producer's per-resource message so a red node can explain itself
  // in the popup instead of just being red.
  dependencies.applyDeployMessages(resources, messageByKey);
  if (terminalConclusion) {
    dependencies.settleDeployStatuses(resources, terminalConclusion);
  }
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

export function createGraphsPlanningRoutes(
  dependencies: GraphsPlanningReadsDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/progress": (context) => handleProgress(context, dependencies),
    "GET /api/deployed-graph": (context) =>
      handleDeployedGraph(context, dependencies)
  };
}

// ── GET /api/load-graph-stream ──────────────────────────────────────────────
// The Server-Sent-Events sibling of `POST /api/load-graph`: the Graph tab opens
// this stream so the modeling progress log shows up live instead of arriving in
// one lump when the (potentially slow) `rad` compile finishes. It is the first
// streaming route to migrate, so its wire behavior is preserved byte for byte:
// the `event:`/`data:` frames, the blank-line terminators, the three SSE
// headers, the write-then-`end` ordering, and — critically — the fact that the
// 503 no-entry exit answers *before* any SSE header is set and writes a plain
// text body rather than a frame.

// The graph-build entry as this route sees it: the live `CanvasServerEntry`, so
// the entry captured by the 503 guard is the exact object every entry-consuming
// seam operates on. That single-capture matters for fidelity — the legacy branch
// read `servers.get(instanceId)` once and reused that reference for the whole
// stream, so if the instance were deleted mid-compile it still wrote graph
// provenance to the orphaned entry rather than silently no-op'ing. Re-resolving
// by `instanceId` inside each seam would change that observable behavior.

// The app.bicep selection `fetchBicepSelection` returns, narrowed to the members
// this route reads. A null `content` is the "no app.bicep on this branch" signal
// that triggers the generation handoff.
export interface LoadGraphStreamBicepSelection {
  content: string | null;
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
}

export interface LoadGraphStreamRadArtifacts {
  dir: string;
  remote: boolean;
}

export interface LoadGraphStreamRadArtifactsOptions {
  isLocal: boolean;
  state: CanvasState | undefined;
  repo: string;
  branch: string;
  bicepRepoPath: string;
  log: (message: string) => void;
}

export interface LoadGraphStreamBuildOptions {
  log: (message: string) => void;
  saveGraphJsonTo: string;
  radArtifactsDir: string;
  cleanupRadArtifactsDir: boolean;
}

// The source-ref bookkeeping token this route prepares before the compile and
// checks after it, so a newer request for a different repo/branch wins. Only the
// `token` is read by this route; the rest of the context stays opaque.
export interface LoadGraphStreamSourceRefContext {
  token: string;
}

// Eleven narrow function seams for one route. Nothing is moved: the bicep
// fetch, the rad-artifacts resolver, the graph compiler, the source-ref
// prepare/commit pair, the app.bicep handoff, the workspace-path deriver, the
// branch defaulter, the canvas normalizer and the error formatter all stay where
// they are defined and are handed in. The entry-consuming seams take the live
// entry the handler captured, not an `instanceId`, so all of them see the same
// object the 503 guard checked. `github` is bound into
// `radArtifactsDirForSelection` at the composition root rather than surfaced
// here, so this module spawns no process and reads no module-level mutable
// state.
export interface GraphsPlanningStreamDependencies {
  // Returns undefined when the instance has no entry, which is what the legacy
  // `servers.get(instanceId)` miss meant and what drives the 503 exit. The
  // request context's `state` snapshot cannot express it: it substitutes `{}`
  // for a missing entry.
  readInstanceEntry(instanceId: string): CanvasServerEntry | undefined;
  defaultBranchForState(state: CanvasState | undefined): string;
  // Prepares the source-ref context for the entry and returns its token.
  prepareSourceRef(
    entry: CanvasServerEntry,
    context: { repo: string; branch: string }
  ): LoadGraphStreamSourceRefContext;
  // Commits the modeled resources against `expectedToken`; returns false when a
  // newer request has superseded this one, exactly like the legacy
  // `setSourceRefResources` guard.
  commitSourceRef(
    entry: CanvasServerEntry,
    resources: CanvasGraphResource[],
    context: { repo: string; branch: string },
    expectedToken: string
  ): boolean;
  triggerAppBicepHandoff(
    entry: CanvasServerEntry,
    repo: string,
    branch: string
  ): void;
  fetchBicepSelection(
    entry: CanvasServerEntry,
    repo: string,
    branch: string
  ): Promise<LoadGraphStreamBicepSelection>;
  listBranchPaths(
    entry: CanvasServerEntry,
    repo: string,
    branch: string
  ): Promise<string[]>;
  workspaceGraphJsonPath(state: CanvasState, bicepRepoPath: string): string;
  radArtifactsDirForSelection(
    options: LoadGraphStreamRadArtifactsOptions
  ): Promise<LoadGraphStreamRadArtifacts>;
  buildGraphViaRad(
    content: string,
    bicepPath: string,
    options: LoadGraphStreamBuildOptions
  ): Promise<unknown[]>;
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  errorMessage(error: unknown): string;
}

// The progress log the Graph tab streams while `rad` models the app. The
// observable contract preserved verbatim from the legacy arm:
//   * The no-entry exit answers 503 with a plain-text body and NO SSE header —
//     it precedes `setHeader`, so a missing instance never gets an event-stream.
//   * The three SSE headers and `writeHead(200)` are written before any frame.
//   * `progress` frames are `event: progress\ndata: <json>\n\n`; the terminal
//     `done` frame is `event: done\ndata: <json>\n\n` immediately followed by
//     `end()`. Every early exit routes through `sendDone`, so the stream always
//     terminates with exactly one `done` frame and one `end`.
//   * `||` (not `??`) throughout: an empty `repo`/`branch` string must fall
//     through to its default, which `??` would not do.
export async function handleLoadGraphStream(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningStreamDependencies
): Promise<void> {
  const { response, url, instanceId } = context;
  const repo = url.searchParams.get("repo") || "";
  const entry = dependencies.readInstanceEntry(instanceId);
  if (!entry) {
    response.writeHead(503);
    response.end("Canvas server state is unavailable.");
    return;
  }
  const branch =
    url.searchParams.get("branch") ||
    dependencies.defaultBranchForState(entry.state);
  const sourceRefContext = dependencies.prepareSourceRef(entry, {
    repo,
    branch
  });

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.writeHead(200);

  const sendProgress = (message: string): void => {
    response.write(`event: progress\ndata: ${JSON.stringify({ message })}\n\n`);
  };
  const sendDone = (data: unknown): void => {
    response.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  };

  if (!repo) {
    sendDone({ error: "Please select a repository." });
    return;
  }

  try {
    sendProgress(`Checking ${repo} for existing app.bicep...`);
    const selection = await dependencies.fetchBicepSelection(
      entry,
      repo,
      branch
    );
    const content = selection.content;

    if (content) {
      sendProgress("Found existing app.bicep — parsing resources...");
    } else {
      const source = evaluateAppSource(
        await dependencies.listBranchPaths(entry, repo, branch)
      );
      if (source.status === "none") {
        sendDone({
          error: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
          appBicepUnsupported: true,
          repo,
          branch
        });
        return;
      }
      dependencies.triggerAppBicepHandoff(entry, repo, branch);
      sendDone({
        error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
        needsAppBicep: true,
        repo,
        branch
      });
      return;
    }

    const graphJsonPath =
      selection.fromWorkspace ?
        dependencies.workspaceGraphJsonPath(entry.state, selection.bicepPath)
      : "";
    const { dir: radArtifactsDir, remote: radArtifactsRemote } =
      await dependencies.radArtifactsDirForSelection({
        isLocal: selection.fromWorkspace,
        state: entry.state,
        repo,
        branch,
        bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
        log: sendProgress
      });
    const resources = dependencies.canvasGraphResources(
      await dependencies.buildGraphViaRad(
        content,
        selection.bicepPath || ".radius/app.bicep",
        {
          log: sendProgress,
          saveGraphJsonTo: graphJsonPath,
          radArtifactsDir,
          cleanupRadArtifactsDir: radArtifactsRemote
        }
      )
    );
    sendProgress(`Mapped ${resources.length} resource(s) — rendering graph...`);

    if (
      !dependencies.commitSourceRef(
        entry,
        resources,
        { repo, branch },
        sourceRefContext.token
      )
    ) {
      sendDone({ stale: true });
      return;
    }
    entry.state.graphTargetRepo = repo;
    entry.state.graphBranch = branch;
    // Authoritative provenance: true only when the local workspace actually
    // supplied the app.bicep content (file is on disk).
    entry.state.graphFromWorkspace = selection.fromWorkspace;
    entry.state.activeGraphView = "graph";

    sendDone({ reload: true });
  } catch (e) {
    sendDone({ error: dependencies.errorMessage(e) });
  }
}

export function createGraphsPlanningStreamRoutes(
  dependencies: GraphsPlanningStreamDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/load-graph-stream": (context) =>
      handleLoadGraphStream(context, dependencies)
  };
}
