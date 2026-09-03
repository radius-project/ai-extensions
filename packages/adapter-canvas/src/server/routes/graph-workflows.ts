import {
  evaluateAppSource,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "@radius-project/core";
import {
  expireGraphProgressWait,
  recordGraphBuildEvent
} from "../../shared.js";
import { evaluateAppBicepWait } from "../../graph-progress-contract.js";
import {
  asGraphModelingFailure,
  GraphModelingFailure
} from "../../graph-modeling-failure.js";
import type {
  GraphRepairAttempt,
  GraphRepairRequest
} from "../../graph-model-repair.js";
import type {
  CanvasGraphResource,
  CanvasState,
  GraphBuildEvent,
  GraphBuildStage,
  GraphProgressRecord,
  GraphProgressView,
  GraphView,
  SourceRefContext
} from "../../shared.js";
import type { GraphInstanceEntry, GraphPipeline } from "./graph-pipeline.js";
import type {
  ResolvedWorkspaceBranch,
  WorkspaceBranchResolution
} from "../../workspace.js";
import {
  appModelAuthoringFailure,
  clearAppModelAuthoringFailure
} from "../../app-model-authoring-failure.js";

// The use-case layer behind the three `graphs-planning` write routes.
//
// `/api/load-graph`, `/api/plan-graph` and `/api/diff-branches` are three views
// of one modeling workflow (see `graph-pipeline.ts` for the shared stages). The
// workflow — generation guards, artifact staging, the reuse cache, recipe
// resolution, graph comparison, progress events and every state mutation —
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
  pipeline: GraphPipeline<TEntry>;
  triggerAppBicepHandoff(
    entry: TEntry | undefined,
    repo: string,
    branches: string | string[],
    page: string,
    progressView: GraphProgressView
  ): void;
  triggerGraphRepairHandoff(
    entry: TEntry,
    request: GraphRepairRequest
  ): GraphRepairAttempt;
  clearGraphRepairAttempt(entry: TEntry, view: GraphProgressView): void;
  // Every path on a branch, used to answer the one prerequisite the app-bicep
  // modeling skill enforces before it will model anything. Resolves empty when
  // the tree cannot be read.
  listBranchPaths(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<string[]>;
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
  canReuseModeledGraph(
    state: CanvasState,
    repo: string,
    branch: string,
    definitionHash: string
  ): boolean;
  addGraphProgress(
    state: CanvasState,
    generation: number,
    view: GraphProgressView,
    event: Omit<GraphBuildEvent, "sequence">
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
  // Newest filesystem activity from a modeling run in this instance's
  // workspace, scoped to the given repository and branches so unrelated
  // local modeling activity does not extend waits for a different target.
  // Read only while a request is answering `needsAppBicep`.
  observeModelingRun(
    state: CanvasState,
    repo: string,
    branches: string[]
  ): Promise<number | null>;
  record(value: unknown): Record<string, unknown>;
  optionalString(value: unknown): string;
  errorMessage(error: unknown): string;
  // Server-side diagnostics sink. Modeling failures are reported to the canvas
  // as one sentence, so this is the only place their detail survives.
  logError(message: string): void;
  // Wall clock for the build record's elapsed time.
  now(): number;
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

function withResolvedBranch(
  outcome: GraphWorkflowOutcome,
  resolvedBranch: string | undefined
): GraphWorkflowOutcome {
  return resolvedBranch ?
      {
        ...outcome,
        payload: { ...outcome.payload, resolvedBranch }
      }
    : outcome;
}

const MISSING_ENTRY_OUTCOME = bare(503, MISSING_ENTRY_PAYLOAD);

interface GraphProgressHandle {
  view: GraphProgressView;
  generation: number;
  owner: number;
  record: GraphProgressRecord;
}

function graphProgressRecord(
  state: CanvasState,
  view: GraphProgressView
): GraphProgressRecord | undefined {
  return state.graphProgressRecords?.[view];
}

function beginGraphProgress(
  state: CanvasState,
  view: GraphProgressView,
  key: string,
  target: { repo: string; branches: string[] },
  nowMs: number,
  restartExpired: boolean
): GraphProgressHandle {
  const existing = graphProgressRecord(state, view);
  // A build that is already in flight for this view is continued rather than
  // restarted. The app.bicep wait re-issues its request every few seconds, and
  // a fresh record each time would reset the elapsed clock and discard the
  // stages already reported — exactly the reset a user sees when they leave the
  // page and come back.
  const sameKey = existing?.graphProgressKey === key;
  const continuing =
    sameKey &&
    !(
      restartExpired &&
      typeof existing.graphProgressWaitExpiredMessage === "string"
    ) &&
    ((existing.graphProgressActive === true &&
      existing.graphProgressAwaitingModel === true) ||
      typeof existing.graphProgressWaitExpiredMessage === "string");
  const record: GraphProgressRecord =
    continuing && existing ? existing : (
      {
        graphBuildEvents: [],
        graphProgressGeneration: (existing?.graphProgressGeneration || 0) + 1,
        graphProgressStartedAtMs: nowMs,
        graphProgressActive: true,
        graphProgressView: view,
        graphProgressKey: key,
        graphProgressRepo: target.repo,
        graphProgressBranches: target.branches,
        graphProgressOwner: 0,
        graphProgressAwaitingModel: false
      }
    );
  record.graphProgressActive = true;
  record.graphProgressAwaitingModel = false;
  record.graphProgressRepo = target.repo;
  record.graphProgressBranches = target.branches;
  record.graphProgressOwner += 1;
  state.graphProgressRecords ??= {};
  state.graphProgressRecords[view] = record;
  return {
    view,
    generation: record.graphProgressGeneration,
    owner: record.graphProgressOwner,
    record
  };
}

function isCurrentGraphProgress(
  state: CanvasState,
  handle: GraphProgressHandle
): boolean {
  const record = graphProgressRecord(state, handle.view);
  return (
    record?.graphProgressGeneration === handle.generation &&
    record.graphProgressOwner === handle.owner
  );
}

// Close the record so nothing still claims to be in flight. The stages stay
// readable: a page that returns after the build finished sees what happened
// rather than an empty panel.
function endGraphProgress(
  state: CanvasState | undefined,
  handle: GraphProgressHandle | undefined
): void {
  if (!state || !handle) return;
  if (!isCurrentGraphProgress(state, handle)) return;
  const record = graphProgressRecord(state, handle.view);
  if (!record) return;
  record.graphProgressActive = false;
  record.graphProgressAwaitingModel = false;
  delete record.graphProgressWaitStartedAtMs;
  delete record.graphProgressLastActivityAtMs;
  delete record.graphProgressWaitExpiredMessage;
}

// Close the record for every outcome except the app.bicep handoff. That build
// genuinely continues off-page while Copilot authors the model, so it stays in
// flight and keeps narrating the wait to whichever page is looking.
//
// The wait is also decided here, because this is the one place every graph
// route's `needsAppBicep` answer passes through. An expired wait is converted
// into an ordinary error outcome: `needsAppBicep` is dropped, so a page that
// only knows to retry while it is set stops retrying without needing its own
// clock, and the pages that never retried still report the failure.
function settleGraphProgress(
  state: CanvasState,
  handle: GraphProgressHandle | undefined,
  outcome: GraphWorkflowOutcome,
  nowMs: number,
  modelingActivityAtMs: number | null
): GraphWorkflowOutcome {
  if (!handle || !isCurrentGraphProgress(state, handle)) return outcome;
  const record = graphProgressRecord(state, handle.view);
  if (!record) return outcome;
  if (outcome.payload.needsAppBicep !== true) {
    endGraphProgress(state, handle);
    return outcome;
  }
  const expiredMessage = record.graphProgressWaitExpiredMessage;
  if (expiredMessage) {
    expireGraphProgressWait(record, expiredMessage);
    return appBicepWaitExpiredOutcome(outcome, expiredMessage);
  }
  record.graphProgressAwaitingModel = true;
  record.graphProgressWaitStartedAtMs ??= nowMs;
  if (modelingActivityAtMs !== null) {
    const lastActivityAtMs = record.graphProgressLastActivityAtMs;
    record.graphProgressLastActivityAtMs =
      lastActivityAtMs === undefined ? modelingActivityAtMs : (
        Math.max(lastActivityAtMs, modelingActivityAtMs)
      );
  }
  const wait = evaluateAppBicepWait({
    nowMs,
    waitStartedAtMs: record.graphProgressWaitStartedAtMs,
    lastActivityAtMs: record.graphProgressLastActivityAtMs ?? null
  });
  if (wait.status === "waiting") return outcome;
  expireGraphProgressWait(record, wait.message);
  return appBicepWaitExpiredOutcome(outcome, wait.message);
}

function appBicepWaitExpiredOutcome(
  outcome: GraphWorkflowOutcome,
  message: string
): GraphWorkflowOutcome {
  const payload: Record<string, unknown> = {
    ...outcome.payload,
    error: message,
    appBicepWaitExpired: true
  };
  delete payload.needsAppBicep;
  return { kind: outcome.kind, status: outcome.status, payload };
}

function appendGraphEvent(
  state: { graphBuildEvents?: GraphBuildEvent[] },
  stage: GraphBuildStage,
  eventState: GraphBuildEvent["state"],
  detail: string
): void {
  recordGraphBuildEvent(state, { stage, state: eventState, detail });
}

function modelCreationIsRunning(state: {
  graphBuildEvents?: GraphBuildEvent[];
}): boolean {
  const creationEvents = (state.graphBuildEvents || []).filter(
    (event) => event.stage === "creating_model"
  );
  return (
    creationEvents.some((event) => event.state === "running") &&
    !creationEvents.some((event) => event.state !== "running")
  );
}

function failRunningGraphEvent(
  state: CanvasState | undefined,
  handle: GraphProgressHandle | undefined,
  detail: string
): void {
  if (!state || !handle || !isCurrentGraphProgress(state, handle)) {
    return;
  }
  const record = graphProgressRecord(state, handle.view);
  const events = record?.graphBuildEvents;
  const latest = events?.[events.length - 1];
  if (!latest || latest.state !== "running") return;
  if (record) appendGraphEvent(record, latest.stage, "failed", detail);
}

export function createGraphPlanningWorkflows<TEntry extends GraphInstanceEntry>(
  dependencies: GraphWorkflowDependencies<TEntry>
): GraphPlanningWorkflows {
  const { pipeline } = dependencies;

  // Run one workflow and close its build record exactly once, whichever way it
  // ends. Settling at a single point rather than at each `return` is what makes
  // "a record is in flight only while work is actually happening" true by
  // construction — a future early return cannot forget to close it and leave
  // the nav chip claiming a build that ended minutes ago.
  async function settleWorkflow(
    run: () => Promise<GraphWorkflowOutcome>,
    hooks: {
      state: () => CanvasState | undefined;
      progressHandle: () => GraphProgressHandle | undefined;
      onError: (error: string) => void;
      repair: () =>
        | { entry: TEntry; request: Omit<GraphRepairRequest, "diagnostic"> }
        | undefined;
      shouldRepair: () => boolean;
      // The repo and branches the workflow is modeling, so the liveness probe
      // only reports activity relevant to this target.
      modelingTarget: () => { repo: string; branches: string[] };
    }
  ): Promise<GraphWorkflowOutcome> {
    let outcome: GraphWorkflowOutcome;
    try {
      outcome = await run();
    } catch (e) {
      const error = dependencies.errorMessage(e);
      hooks.onError(error);
      const repair = hooks.repair();
      if (e instanceof GraphModelingFailure && repair && hooks.shouldRepair()) {
        const attempt = dependencies.triggerGraphRepairHandoff(repair.entry, {
          ...repair.request,
          diagnostic: e.diagnostic
        });
        outcome = json(400, {
          error,
          modelingFailed: true,
          ...attempt
        });
      } else {
        outcome = json(400, { error });
      }
    }

    const state = hooks.state();
    if (!state) return outcome;
    // Only an answer that asks the page to keep waiting needs the liveness
    // probe, so the ordinary success and failure paths pay nothing for it.
    const target = hooks.modelingTarget();
    const modelingActivityAtMs =
      outcome.payload.needsAppBicep === true ?
        await dependencies.observeModelingRun(
          state,
          target.repo,
          target.branches
        )
      : null;
    return settleGraphProgress(
      state,
      hooks.progressHandle(),
      outcome,
      dependencies.now(),
      modelingActivityAtMs
    );
  }

  async function compileResources(
    input: Parameters<GraphPipeline<TEntry>["compileResources"]>[0],
    context: { repo: string; branch: string }
  ): ReturnType<GraphPipeline<TEntry>["compileResources"]> {
    try {
      return await pipeline.compileResources(input);
    } catch (error) {
      const failure = asGraphModelingFailure(error);
      if (!(failure instanceof GraphModelingFailure)) throw error;
      dependencies.logError(
        `[radius graph] modeling failed for ${context.repo}@${context.branch}: ${failure.diagnostic}`
      );
      throw failure;
    }
  }

  // The app-bicep modeling skill refuses outright — before writing anything —
  // any repository without a Dockerfile, because it builds the application's
  // own image from one. That refusal is delivered to the user in the Copilot
  // conversation and never reaches this server, so handing off regardless would
  // leave the page waiting for a file that is never going to be written.
  // Answering here turns an unbounded wait into an actionable error.
  async function branchRefusalReason(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<string | null> {
    const paths = await dependencies.listBranchPaths(entry, repo, branch);
    return evaluateAppSource(paths).status === "none" ?
        UNSUPPORTED_NO_DOCKERFILE_MESSAGE
      : null;
  }

  // The diff spans two branches, so it is only unsupported when neither side
  // could host the skill's output. A single readable Dockerfile-less branch is
  // not enough to refuse.
  async function diffAppBicepRefusalReason(
    entry: TEntry,
    repo: string,
    base: string,
    head: string
  ): Promise<string | null> {
    const [baseReason, headReason] = await Promise.all([
      branchRefusalReason(entry, repo, base),
      branchRefusalReason(entry, repo, head)
    ]);
    if (!baseReason || !headReason) return null;
    return headReason;
  }

  async function appBicepHandoffOutcome(
    entry: TEntry,
    repo: string,
    branch: string,
    progressView: Extract<GraphProgressView, "graph" | "planned">,
    reportRefusal: (detail: string) => void,
    retryAuthoring: boolean,
    isCurrent?: () => boolean
  ): Promise<GraphWorkflowOutcome> {
    if (isCurrent && !isCurrent()) return json(409, STALE_PAYLOAD);
    if (retryAuthoring) {
      clearAppModelAuthoringFailure(entry.state, repo, branch);
    }
    const authoringFailure = appModelAuthoringFailure(
      entry.state,
      repo,
      branch
    );
    if (authoringFailure) {
      const detail = `Application model generation stopped: ${authoringFailure.error} Fix the reported issue, then refresh the Radius Canvas to try modeling again.`;
      reportRefusal(detail);
      return json(200, {
        error: detail,
        modelingFailed: true,
        appModelAuthoringFailed: true,
        repo,
        branch
      });
    }
    const refusal = await branchRefusalReason(entry, repo, branch);
    if (isCurrent && !isCurrent()) return json(409, STALE_PAYLOAD);
    if (refusal) {
      reportRefusal(refusal);
      return json(200, {
        error: refusal,
        appBicepUnsupported: true,
        repo,
        branch
      });
    }
    // Both single-branch routes hand off as the "graph" page. The runtime's
    // dedupe key no longer derives from the page, but the page still names the
    // view in the prompt, and the graph view is the one the user is told to
    // reopen from either route.
    dependencies.triggerAppBicepHandoff(
      entry,
      repo,
      branch,
      "graph",
      progressView
    );
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
    let activeState: CanvasState | undefined;
    let activeRepair:
      { entry: TEntry; repo: string; branch: string } | undefined;
    let activeGeneration: number | undefined;
    let activeProgressHandle: GraphProgressHandle | undefined;
    let activeSourceToken: string | undefined;
    const run = async (): Promise<GraphWorkflowOutcome> => {
      const data = dependencies.record(JSON.parse(body));
      const repo = dependencies.optionalString(data.repo);
      const requestedBranch = dependencies.optionalString(data.branch);
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      activeState = state;
      // Claim the request before resolving the live branch so arrival order,
      // rather than subprocess completion order, owns supersession.
      const requestGeneration = (state.graphBuildGeneration =
        (state.graphBuildGeneration || 0) + 1);
      activeGeneration = requestGeneration;
      const branchResolution = await dependencies.resolveBranchForRequest(
        entry,
        repo,
        requestedBranch,
        typeof data.followWorkspaceBranch === "boolean" ?
          data.followWorkspaceBranch
        : undefined
      );
      if (state.graphBuildGeneration !== requestGeneration) {
        return json(409, STALE_PAYLOAD);
      }
      if (branchResolution.status === "unavailable") {
        return json(409, {
          error: branchResolution.error,
          workspaceBranchUnavailable: true,
          repo
        });
      }
      if (!dependencies.commitBranchResolution(entry, repo, branchResolution)) {
        return json(409, STALE_PAYLOAD);
      }
      const branch = branchResolution.branch;
      const resolvedBranch =
        requestedBranch && requestedBranch !== branch ? branch : undefined;
      activeRepair = { entry, repo, branch };
      if (!repo) return json(200, { error: "Please select a repository." });
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "graph",
        { repo, branch }
      );
      activeSourceToken = sourceRefContext.token;
      const progressHandle = beginGraphProgress(
        state,
        "graph",
        JSON.stringify({ repo, branch }),
        { repo, branches: [branch] },
        dependencies.now(),
        data.restartWait === true
      );
      activeProgressHandle = progressHandle;

      // Every event is gated on the generation, so a superseded request stops
      // writing to the event stream the page is polling.
      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (!isCurrentGraphProgress(state, progressHandle)) return;
        dependencies.addGraphProgress(state, requestGeneration, "graph", {
          stage,
          state: eventState,
          detail
        });
      };
      const addBuildDetail = (detail: string): void => {
        addEvent("building_graph", "running", detail);
      };

      addEvent(
        "checking_model",
        "running",
        `Checking ${repo} for .radius/app.bicep.`
      );
      const selection = await pipeline.selectAppBicep(entry, repo, branch);
      const content = selection.content;
      if (content) {
        clearAppModelAuthoringFailure(state, repo, branch);
        if (modelCreationIsRunning(progressHandle.record)) {
          addEvent(
            "creating_model",
            "succeeded",
            "Copilot created .radius/app.bicep."
          );
        }
        addEvent("checking_model", "succeeded", "Found the application model.");
        // A model that exists can still no longer describe its source. The
        // runtime classifies it and decides whether that is worth a refresh, the
        // user's agreement, or only a note; the graph itself still renders.
        dependencies.triggerAppBicepHandoff(
          entry,
          repo,
          branch,
          "graph",
          "graph"
        );
      } else {
        addEvent(
          "checking_model",
          "succeeded",
          "No application model exists yet."
        );
        addEvent(
          "creating_model",
          "running",
          "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
        );
        const outcome = await appBicepHandoffOutcome(
          entry,
          repo,
          branch,
          "graph",
          (detail) => addEvent("creating_model", "failed", detail),
          data.restartWait === true
        );
        return withResolvedBranch(outcome, resolvedBranch);
      }

      const graphJsonPath = pipeline.graphJsonPathFor(entry, selection);
      const staged = await pipeline.stageArtifacts({
        entry,
        selection,
        repo,
        branch,
        log: addBuildDetail
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
        // Keep persisted provenance in step with what this response reports, so
        // a later page render cannot disagree with the page it just answered.
        state.graphFollowsWorkspaceBranch =
          branchResolution.followsWorkspaceBranch;
        state.graphFromWorkspace = selection.fromWorkspace;
        return withResolvedBranch(
          json(200, {
            reload: false,
            resources: state.graphResources,
            fromWorkspace: selection.fromWorkspace,
            cached: true
          }),
          resolvedBranch
        );
      }

      addEvent(
        "building_graph",
        "running",
        "Compiling the application model and building the resource graph."
      );
      const resources = await compileResources(
        {
          selection,
          staged,
          log: addBuildDetail,
          saveGraphJsonTo: graphJsonPath
        },
        { repo, branch }
      );
      addEvent(
        "building_graph",
        "succeeded",
        `Built a graph with ${resources.length} resource(s).`
      );
      addEvent(
        "rendering_graph",
        "running",
        "Laying out and rendering the application graph."
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
        state.graphFollowsWorkspaceBranch =
          branchResolution.followsWorkspaceBranch === true;
        // Authoritative provenance: true only when the local workspace actually
        // supplied the app.bicep content (file is on disk).
        state.graphFromWorkspace = selection.fromWorkspace;
        state.activeGraphView = "graph";
        state.graphLoaded = true;
        state.graphDefinitionHash = definitionHash;
      }
      addEvent(
        "rendering_graph",
        "succeeded",
        "Rendered the application graph."
      );
      dependencies.clearGraphRepairAttempt(entry, "graph");
      return withResolvedBranch(
        json(200, {
          reload: !data.refresh,
          resources,
          fromWorkspace: selection.fromWorkspace
        }),
        resolvedBranch
      );
    };
    return await settleWorkflow(run, {
      state: () => activeState,
      progressHandle: () => activeProgressHandle,
      onError: (error) => {
        if (activeState?.graphBuildGeneration === activeGeneration) {
          failRunningGraphEvent(activeState, activeProgressHandle, error);
        }
      },
      repair: () =>
        activeRepair ?
          {
            entry: activeRepair.entry,
            request: {
              view: "graph",
              repo: activeRepair.repo,
              branches: [activeRepair.branch]
            }
          }
        : undefined,
      shouldRepair: () =>
        activeState !== undefined &&
        activeState.graphBuildGeneration === activeGeneration &&
        activeSourceToken !== undefined &&
        dependencies.isCurrentSourceRefToken(
          activeState,
          "graph",
          activeSourceToken
        ),
      modelingTarget: () => ({
        repo: activeRepair?.repo || "",
        branches: activeRepair ? [activeRepair.branch] : []
      })
    });
  }

  // The planned graph: the modeled application projected through a provider's
  // recipe pack, so each abstract Radius resource shows the concrete cloud
  // resources its recipe would create.
  async function planGraph({
    instanceId,
    body
  }: GraphWorkflowRequest): Promise<GraphWorkflowOutcome> {
    let activeState: CanvasState | undefined;
    let activeRepair:
      { entry: TEntry; repo: string; branch: string } | undefined;
    let activeGeneration: number | undefined;
    let activeProgressHandle: GraphProgressHandle | undefined;
    let activeSourceToken: string | undefined;
    const run = async (): Promise<GraphWorkflowOutcome> => {
      const data = dependencies.record(JSON.parse(body));
      const repo = dependencies.optionalString(data.repo);
      const requestedBranch = dependencies.optionalString(data.branch);
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      activeState = state;
      const previousPlannedResources = state.plannedResources;
      const previousPlanSelection = {
        repo: state.plannedRepo,
        branch: state.plannedBranch,
        provider: state.plannedProvider,
        environment: state.plannedEnvironment
      };
      const planGeneration = dependencies.beginPlannedGraphRequest(state);
      activeGeneration = planGeneration;
      const branchResolution = await dependencies.resolveBranchForRequest(
        entry,
        repo,
        requestedBranch,
        typeof data.followWorkspaceBranch === "boolean" ?
          data.followWorkspaceBranch
        : undefined
      );
      if (!dependencies.isCurrentPlannedGraphRequest(state, planGeneration)) {
        return json(409, STALE_PAYLOAD);
      }
      if (branchResolution.status === "unavailable") {
        return json(409, {
          error: branchResolution.error,
          workspaceBranchUnavailable: true,
          repo
        });
      }
      if (!dependencies.commitBranchResolution(entry, repo, branchResolution)) {
        return json(409, STALE_PAYLOAD);
      }
      const branch = branchResolution.branch;
      const resolvedBranch =
        requestedBranch && requestedBranch !== branch ? branch : undefined;
      activeRepair = { entry, repo, branch };
      const provider = dependencies.optionalString(data.provider) || "azure";
      // Persist the selected environment so re-opening (or reloading) the
      // Planned tab re-selects it by default, matching the graph just shown.
      if (typeof data.environment === "string" && data.environment) {
        state.plannedEnvironment = data.environment;
      } else if (data.refresh !== true) {
        state.plannedEnvironment = "";
      }
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "planned",
        { repo, branch }
      );
      activeSourceToken = sourceRefContext.token;
      const progressHandle = beginGraphProgress(
        state,
        "planned",
        JSON.stringify({
          repo,
          branch,
          provider,
          environment: state.plannedEnvironment
        }),
        { repo, branches: [branch] },
        dependencies.now(),
        data.restartWait === true
      );
      activeProgressHandle = progressHandle;
      const isCurrentPlan = (): boolean =>
        dependencies.isCurrentPlannedGraphRequest(state, planGeneration);

      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (
          !isCurrentGraphProgress(state, progressHandle) ||
          !isCurrentPlan()
        ) {
          return;
        }
        appendGraphEvent(progressHandle.record, stage, eventState, detail);
      };
      const addBuildDetail = (detail: string): void => {
        addEvent("building_graph", "running", detail);
      };

      addEvent(
        "checking_model",
        "running",
        `Checking ${repo} for .radius/app.bicep.`
      );
      const selection = await pipeline.selectAppBicep(entry, repo, branch);
      if (!isCurrentPlan()) return json(409, STALE_PAYLOAD);
      const content = selection.content;
      if (!content) {
        addEvent(
          "checking_model",
          "succeeded",
          "No application model exists yet."
        );
        addEvent(
          "creating_model",
          "running",
          "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
        );
        const outcome = await appBicepHandoffOutcome(
          entry,
          repo,
          branch,
          "planned",
          (detail) => addEvent("creating_model", "failed", detail),
          data.restartWait === true,
          isCurrentPlan
        );
        return withResolvedBranch(outcome, resolvedBranch);
      }
      clearAppModelAuthoringFailure(state, repo, branch);
      if (modelCreationIsRunning(progressHandle.record)) {
        addEvent(
          "creating_model",
          "succeeded",
          "Copilot created .radius/app.bicep."
        );
      }
      addEvent("checking_model", "succeeded", "Found the application model.");
      // Same freshness reconcile as load-graph: the planned view renders from
      // the same model, so a drift it can see must not go unreported merely
      // because the user reached it from a different tab.
      dependencies.triggerAppBicepHandoff(
        entry,
        repo,
        branch,
        "graph",
        "planned"
      );

      const graphJsonPath = pipeline.graphJsonPathFor(entry, selection);
      const staged = await pipeline.stageArtifacts({
        entry,
        selection,
        repo,
        branch,
        log: addBuildDetail,
        preferGraphArtifact: true
      });
      const definitionHash = pipeline.definitionHashFor(
        selection,
        staged,
        true
      );
      if (!isCurrentPlan()) {
        try {
          pipeline.discardStagedArtifacts(staged);
        } catch {
          /* best-effort */
        }
        return json(409, STALE_PAYLOAD);
      }
      const canReusePlannedGraph =
        data.refresh === true &&
        Array.isArray(previousPlannedResources) &&
        previousPlanSelection.repo === repo &&
        previousPlanSelection.branch === branch &&
        previousPlanSelection.provider === provider &&
        previousPlanSelection.environment === state.plannedEnvironment &&
        state.plannedDefinitionHash === definitionHash;
      if (canReusePlannedGraph) {
        pipeline.discardStagedArtifacts(staged);
        state.plannedResources = previousPlannedResources;
        state.plannedFollowsWorkspaceBranch =
          branchResolution.followsWorkspaceBranch;
        return withResolvedBranch(
          json(200, {
            reload: false,
            refreshed: true
          }),
          resolvedBranch
        );
      }
      addEvent(
        "building_graph",
        "running",
        pipeline.canUseGraphArtifact(selection) ?
          "Loading the selected branch's app-graph.json."
        : "Compiling the application model and building the resource graph."
      );
      const resources = await compileResources(
        {
          selection,
          staged,
          log: addBuildDetail,
          saveGraphJsonTo: graphJsonPath,
          preferGraphArtifact: true
        },
        { repo, branch }
      );
      addEvent(
        "building_graph",
        "succeeded",
        `Built a graph with ${resources.length} resource(s).`
      );

      // Resolve recipes from the default recipe pack
      // (radius-project/resource-types-contrib).
      addEvent(
        "resolving_recipes",
        "running",
        `Resolving ${provider} recipes for the planned resources.`
      );
      const recipes: unknown[] = await dependencies.fetchRecipePack(provider);

      // Surface pack recipes we couldn't map to a concrete resource so the gap
      // is visible (rather than silently rendering the abstract type). Empty
      // today for the Azure pack; fires if the pack adds a recipe source the
      // curated map doesn't yet cover.
      const unmappedRecipes = recipes.filter((recipe) => {
        const concrete = dependencies.record(recipe).concreteResources;
        return !Array.isArray(concrete) || concrete.length === 0;
      });
      if (unmappedRecipes.length) {
        addEvent(
          "resolving_recipes",
          "running",
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
      const plannedResources = pipeline.toCanvasResources(
        await dependencies.resolveRecipeOutputs(resources, recipes, provider)
      );
      addEvent(
        "resolving_recipes",
        "succeeded",
        `Resolved ${plannedResources.length} planned resource(s).`
      );
      addEvent(
        "rendering_graph",
        "running",
        "Laying out and rendering the planned graph."
      );

      if (sourceRefContext) {
        // Equivalent mutant, as in load-graph: retained verbatim, unreachable.
        if (!isCurrentPlan()) {
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
        state.plannedFollowsWorkspaceBranch =
          branchResolution.followsWorkspaceBranch === true;
        // Authoritative provenance: true only when the local workspace actually
        // supplied the app.bicep content (file is on disk).
        state.plannedFromWorkspace = selection.fromWorkspace;
        state.plannedProvider = provider;
        state.plannedDefinitionHash = definitionHash;
        state.resolvedRecipes = recipes;
        state.activeGraphView = "planned";
      }
      addEvent("rendering_graph", "succeeded", "Rendered the planned graph.");
      dependencies.clearGraphRepairAttempt(entry, "planned");
      const resourcesChanged =
        JSON.stringify(previousPlannedResources) !==
        JSON.stringify(plannedResources);
      const selectionChanged =
        previousPlanSelection.repo !== repo ||
        previousPlanSelection.branch !== branch ||
        previousPlanSelection.provider !== provider ||
        previousPlanSelection.environment !== state.plannedEnvironment;
      const refreshed =
        data.refresh === true && !resourcesChanged && !selectionChanged;
      return withResolvedBranch(
        json(200, {
          reload: !refreshed,
          ...(refreshed ? { refreshed: true } : {})
        }),
        resolvedBranch
      );
    };
    return await settleWorkflow(run, {
      state: () => activeState,
      progressHandle: () => activeProgressHandle,
      onError: (error) => {
        if (
          activeState &&
          activeGeneration !== undefined &&
          dependencies.isCurrentPlannedGraphRequest(
            activeState,
            activeGeneration
          )
        ) {
          failRunningGraphEvent(activeState, activeProgressHandle, error);
        }
      },
      repair: () =>
        activeRepair ?
          {
            entry: activeRepair.entry,
            request: {
              view: "planned",
              repo: activeRepair.repo,
              branches: [activeRepair.branch]
            }
          }
        : undefined,
      shouldRepair: () =>
        activeState !== undefined &&
        activeGeneration !== undefined &&
        dependencies.isCurrentPlannedGraphRequest(
          activeState,
          activeGeneration
        ) &&
        activeSourceToken !== undefined &&
        dependencies.isCurrentSourceRefToken(
          activeState,
          "planned",
          activeSourceToken
        ),
      modelingTarget: () => ({
        repo: activeRepair?.repo || "",
        branches: activeRepair ? [activeRepair.branch] : []
      })
    });
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
    let activeState: CanvasState | undefined;
    let activeRepair:
      { entry: TEntry; repo: string; base: string; head: string } | undefined;
    let activeProgressHandle: GraphProgressHandle | undefined;
    const run = async (): Promise<GraphWorkflowOutcome> => {
      const data = JSON.parse(body);
      const repo = data.repo || "";
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return MISSING_ENTRY_OUTCOME;
      const state = entry.state;
      activeState = state;
      const previousDiffResources = state.diffResources;
      const previousDiffSelection = {
        repo: state.diffTargetRepo,
        base: state.diffBase,
        head: state.diffHead
      };
      activeRepair = {
        entry,
        repo,
        base: data.base,
        head: data.head
      };
      const progressHandle = beginGraphProgress(
        state,
        "diff",
        JSON.stringify({ repo, base: data.base, head: data.head }),
        { repo, branches: [data.base, data.head] },
        dependencies.now(),
        data.restartWait === true
      );
      activeProgressHandle = progressHandle;
      const addEvent = (
        stage: GraphBuildStage,
        eventState: GraphBuildEvent["state"],
        detail: string
      ): void => {
        if (
          !isCurrentGraphProgress(state, progressHandle) ||
          !dependencies.isCurrentSourceRefToken(
            state,
            "diff",
            sourceRefContext?.token || ""
          )
        ) {
          return;
        }
        appendGraphEvent(progressHandle.record, stage, eventState, detail);
      };
      sourceRefContext = dependencies.prepareSourceRefResources(entry, "diff", {
        repo,
        baseBranch: data.base,
        headBranch: data.head
      });
      state.diffBase = data.base;
      state.diffHead = data.head;
      state.diffTargetRepo = repo;
      delete state.diffError;
      delete state.diffModelingFailed;

      // Fetch the committed/persisted app.bicep on each branch. app.bicep
      // generation is owned by the Radius app-bicep skill, so branches without
      // one simply contribute nothing to the diff (added/removed).
      addEvent(
        "checking_model",
        "running",
        `Checking ${data.base} and ${data.head} for application models.`
      );
      const [baseSelection, headSelection] = await Promise.all([
        pipeline.selectAppBicep(entry, repo, data.base),
        pipeline.selectAppBicep(entry, repo, data.head)
      ]);

      if (!baseSelection.content && !headSelection.content) {
        addEvent(
          "checking_model",
          "succeeded",
          "Neither branch contains an application model."
        );
        addEvent(
          "creating_model",
          "running",
          "Copilot is creating .radius/app.bicep with the Radius app-bicep skill."
        );
        const diffRefusal = await diffAppBicepRefusalReason(
          entry,
          repo,
          data.base,
          data.head
        );
        if (diffRefusal) {
          addEvent("creating_model", "failed", diffRefusal);
          return json(200, {
            error: diffRefusal,
            appBicepUnsupported: true,
            repo
          });
        }
        dependencies.triggerAppBicepHandoff(
          entry,
          repo,
          [data.base, data.head],
          "graph-diff",
          "diff"
        );
        // No `branch` key here, unlike the other two routes: the diff spans two.
        return json(200, {
          error: GENERATING_APP_BICEP_MESSAGE,
          needsAppBicep: true,
          repo
        });
      }
      if (modelCreationIsRunning(progressHandle.record)) {
        addEvent(
          "creating_model",
          "succeeded",
          "Copilot created .radius/app.bicep."
        );
      }
      addEvent(
        "checking_model",
        "succeeded",
        "Found application model content to compare."
      );
      // Reported for both branches even when only one carries a model: the
      // runtime classifies each side and stays silent about the missing one,
      // which the diff renders as an added or removed application.
      dependencies.triggerAppBicepHandoff(
        entry,
        repo,
        [data.base, data.head],
        "graph-diff",
        "diff"
      );

      // Ordering is load-bearing and matches legacy exactly: BOTH sides are
      // staged before EITHER is compiled. Interleaving stage/compile per side
      // would let the base side's staged temp directory be cleaned up before the
      // head side is staged, which is observable in the artifacts on disk.
      const baseStaged = await pipeline.stageArtifacts({
        entry,
        selection: baseSelection,
        repo,
        branch: data.base,
        preferGraphArtifact: true
      });
      const headStaged = await pipeline.stageArtifacts({
        entry,
        selection: headSelection,
        repo,
        branch: data.head,
        preferGraphArtifact: true
      });
      const baseGraphJsonPath = pipeline.graphJsonPathFor(entry, baseSelection);
      const headGraphJsonPath = pipeline.graphJsonPathFor(entry, headSelection);
      addEvent(
        "building_base_graph",
        "running",
        `Building the graph for ${data.base}.`
      );
      const baseResources = await compileResources(
        {
          selection: baseSelection,
          staged: baseStaged,
          saveGraphJsonTo: baseGraphJsonPath,
          preferGraphArtifact: true
        },
        { repo, branch: data.base }
      );
      addEvent(
        "building_base_graph",
        "succeeded",
        `Built ${baseResources.length} resource(s) from ${data.base}.`
      );
      addEvent(
        "building_head_graph",
        "running",
        `Building the graph for ${data.head}.`
      );
      const headResources = await compileResources(
        {
          selection: headSelection,
          staged: headStaged,
          saveGraphJsonTo: headGraphJsonPath,
          preferGraphArtifact: true
        },
        { repo, branch: data.head }
      );
      addEvent(
        "building_head_graph",
        "succeeded",
        `Built ${headResources.length} resource(s) from ${data.head}.`
      );

      // Compute diff using the shared algorithm (see computeGraphDiff).
      addEvent(
        "comparing_graphs",
        "running",
        `Comparing ${data.base} with ${data.head}.`
      );
      const diffResources = dependencies.computeGraphDiff(
        baseResources,
        headResources
      );
      addEvent(
        "comparing_graphs",
        "succeeded",
        `Compared ${diffResources.length} resource(s).`
      );
      addEvent(
        "rendering_graph",
        "running",
        "Laying out and rendering the graph diff."
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
      addEvent("rendering_graph", "succeeded", "Rendered the graph diff.");
      dependencies.clearGraphRepairAttempt(entry, "diff");

      const resourcesChanged =
        JSON.stringify(previousDiffResources) !== JSON.stringify(diffResources);
      const selectionChanged =
        previousDiffSelection.repo !== repo ||
        previousDiffSelection.base !== data.base ||
        previousDiffSelection.head !== data.head;
      const refreshed =
        data.refresh === true && !resourcesChanged && !selectionChanged;
      return json(200, {
        message: `Comparing ${data.base} → ${data.head}`,
        reload: !refreshed,
        ...(refreshed ? { refreshed: true } : {})
      });
    };
    return await settleWorkflow(run, {
      state: () => activeState,
      progressHandle: () => activeProgressHandle,
      onError: (error) => {
        // The entry is re-read rather than reused: the failure may have
        // happened before one was ever resolved.
        const entry = dependencies.readInstanceEntry(instanceId);
        if (
          entry &&
          activeProgressHandle !== undefined &&
          isCurrentGraphProgress(entry.state, activeProgressHandle) &&
          dependencies.isCurrentSourceRefToken(
            entry.state,
            "diff",
            sourceRefContext?.token || ""
          )
        ) {
          entry.state.diffError = error;
          failRunningGraphEvent(entry.state, activeProgressHandle, error);
        }
      },
      repair: () =>
        activeRepair ?
          {
            entry: activeRepair.entry,
            request: {
              view: "diff",
              repo: activeRepair.repo,
              branches: [activeRepair.base, activeRepair.head]
            }
          }
        : undefined,
      shouldRepair: () => {
        const entry = dependencies.readInstanceEntry(instanceId);
        return (
          entry !== undefined &&
          activeProgressHandle !== undefined &&
          isCurrentGraphProgress(entry.state, activeProgressHandle) &&
          dependencies.isCurrentSourceRefToken(
            entry.state,
            "diff",
            sourceRefContext?.token || ""
          )
        );
      },
      modelingTarget: () => ({
        repo: activeRepair?.repo || "",
        branches: activeRepair ? [activeRepair.base, activeRepair.head] : []
      })
    });
  }

  return { loadGraph, planGraph, diffBranches };
}
