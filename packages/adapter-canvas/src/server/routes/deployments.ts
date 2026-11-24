import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { DeploymentAbandonmentService } from "../services/deployment-abandonment.js";
import type { DeployRequestService } from "../services/deploy-request.js";
import type { DeploymentRow } from "../services/deployment-resolver.js";
import { prepareDeploymentCleanup } from "../services/deployment-cleanup-details.js";
import type {
  EnvironmentDeploymentListing,
  ProductionDeploymentPorts
} from "@radius-project/adapter-shared";
import {
  inspectDeploymentListings,
  type ApplicationDefinitionInspection
} from "@radius-project/core/inspection";
import type {
  DeleteConflictProbe,
  DeleteConflictRequest
} from "@radius-project/core";
import { requestApplicationDeletion } from "../services/application-deletion.js";
import type { DeletedDeploymentIdentity } from "../services/deployed-view-state.js";
import { redactGhCredentials } from "../../gh.js";
import { type GhCommandPresentation } from "../../gh-command-display.js";
import {
  projectSafeApplicationGraph,
  type ApplicationDeletionSelection
} from "@radius-project/core";

// What the webview needs to decide whether to keep polling after a failed
// deploy. Shaped to match `deployHandoffStatus` in `server.ts`, which is
// injected rather than moved.
export interface DeployHandoffSummary {
  state: string;
  attempts: number;
  maxAttempts: number;
  pending: boolean;
}

// One row of the deployments listing, as produced by `resolveEnvDeployment`.
export type { DeploymentRow } from "../services/deployment-resolver.js";

export interface DeployListCacheEntry {
  at: number;
  payload: unknown;
}

// The deploy listing cache is injected, not owned here, because the deploy
// dispatch service deletes from the same map through its own
// `invalidateDeployListCache` seam. This family now contains both a reader
// (`list-deployments`) and one of the invalidators (`delete-deployment`), so the
// eviction is a within-slice behavior and is tested directly against a real Map
// rather than assumed.
export interface DeployListCache {
  get(repo: string): DeployListCacheEntry | undefined;
  set(repo: string, entry: DeployListCacheEntry): unknown;
  delete(repo: string): unknown;
}

// `code` is `string | number` because that is what the legacy runner produced:
// a spawn failure surfaces a string errno like "ENOENT", and every comparison
// against it is a `=== 0` / `!== 0` check that treats a string as failure.
export interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  // Set when the runner's timeout killed the child, so the request's outcome is
  // unknown and no credential fallback may re-run it.
  timedOut?: boolean;
}

export interface WorkflowSyncResult {
  created: string[];
  failed: { path: string; branch: string }[];
}

// A timer handle, narrowed to the one method the reservation lease uses. Node's
// `setTimeout` returns a `Timeout`; a test double returns a plain object.
export interface TimerHandle {
  unref?(): void;
}

export interface DeploymentDispatchLease {
  repo: string;
  environment: string;
  kind: "deploy" | "delete" | "abandon";
  expiresAt: number;
  attemptId?: string;
}

// The instance entry, not the request context's `state` snapshot: the repair
// handoff is driven from the entry itself and has to be able to tell a missing
// instance from an instance with empty state, which the snapshot's `{}`
// substitution cannot express.
export interface DeploymentsInstanceEntry {
  state: CanvasState;
}

export interface DeploymentsDependencies {
  workflowAdmission?: ProductionDeploymentPorts["admission"];
  id(): string;
  ghCommandPresentation?: GhCommandPresentation;
  isValidRepoSlug(value: unknown): boolean;
  readInstanceEntry(instanceId: string): DeploymentsInstanceEntry | undefined;
  triggerDeployRepairHandoff(
    entry: DeploymentsInstanceEntry | undefined,
    instanceId: string
  ): boolean;
  // Informational sibling of triggerDeployRepairHandoff: relays a
  // run-unconfirmed failure to chat without opening a repair loop. Its return is
  // deliberately NOT folded into the `repairing` flag, so an unconfirmed failure
  // never shows the "analyzing and will repair and redeploy" UI note.
  triggerDeployFailureNotice(
    entry: DeploymentsInstanceEntry | undefined,
    instanceId: string
  ): boolean;
  deployHandoffStatus(state: CanvasState): DeployHandoffSummary;
  inspectRepoApplication(
    repo: string,
    branch: string
  ): Promise<ApplicationDefinitionInspection>;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    appName: string
  ): Promise<DeploymentRow | null>;
  listEnvDeployment(
    repo: string,
    environment: string,
    appName: string
  ): Promise<EnvironmentDeploymentListing>;
  // The gh runner that REJECTS on failure, so a GitHub outage surfaces as an
  // error payload rather than as a definitive empty listing.
  ghOrThrow(args: string[]): Promise<string>;
  resetDeploymentViewState(state: CanvasState, attemptId: unknown): void;
  captureDeletedDeployment(
    state: CanvasState,
    target: DeletedDeploymentIdentity & { repo: string }
  ): () => void;
  logError(message: string): void;
  deployListCache: DeployListCache;
  deployListTtlMs: number;
  // Destructive-dispatch seams. Every one is a specific named function rather
  // than a bag of capabilities, so the blast radius of this family stays
  // readable at the composition root.
  activeDeploymentMutation(
    state: CanvasState
  ): DeploymentDispatchLease | undefined;
  reserveDeploymentMutation(
    state: CanvasState,
    reservation: {
      repo: string;
      environment: string;
      kind: "delete";
      untilReleased?: boolean;
    }
  ): DeploymentDispatchLease | null;
  releaseDeploymentMutation(
    state: CanvasState,
    reservation: DeploymentDispatchLease
  ): void;
  deploymentStatusBlocksMutation(status: unknown): boolean;
  localDeploymentBlocksMutation(state: CanvasState): boolean;
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[]
  ): Promise<WorkflowSyncResult>;
  // The application-delete dispatcher plus the provider workflows it `uses:`.
  deleteApplicationWorkflowFiles: readonly string[];
  findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId: number | string | null,
    correlationId?: string
  ): Promise<number | string | null>;
  // Resolves rather than rejects on a non-zero exit, so the handler can inspect
  // stderr and choose the failure message.
  runGh(
    args: string[],
    timeout?: number,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<CommandResult>;
  // Injected so the workflow-scope fallback can be exercised without mutating
  // the real environment.
  readProcessEnv(): NodeJS.ProcessEnv;
  setTimer(callback: () => void, ms: number): TimerHandle;
  // The admission half of POST /api/deploy. Everything that route does beyond
  // reading the body and writing the response lives behind this port, because
  // the deploy is a multi-stage runtime operation rather than an HTTP concern.
  deployRequest: DeployRequestService;
  // GitHub-side cleanup is a separate use case from cloud deletion. The route
  // only parses HTTP input and serializes this service's result.
  abandonment: DeploymentAbandonmentService;
  // Decides whether the last delete of an application failed with the stranded
  // non-terminal-state conflict, which is the only thing that unlocks the
  // force-delete path in the UI.
  probeDeleteConflict(
    request: DeleteConflictRequest,
    instanceId?: string,
    selection?: ApplicationDeletionSelection
  ): Promise<DeleteConflictProbe>;
  // Repair for an AWS deploy that could not sign in. The service decides from
  // this canvas's failed deploy which environment it repairs.
  awsTrustRepair: {
    repair(input: { instanceId: string; generation: number }): Promise<{
      status: number;
      body: Record<string, unknown>;
    }>;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

// The branch the deploy pages resolve `app.bicep` against. The order is
// observable: an explicit page context wins over the last planned branch, which
// wins over the last graph branch, and "main" is only the floor.
function deployContextBranch(
  entry: DeploymentsInstanceEntry | undefined
): string {
  return (
    entry?.state?.contextBranch ||
    entry?.state?.plannedBranch ||
    entry?.state?.graphBranch ||
    "main"
  );
}

// Deploy progress poll. Answers 200 unconditionally — the webview polls this
// every 1.5s and treats a non-200 as a transport failure — and is also where a
// failed deploy is handed to the agent for repair, because every failure path
// converges here.
//
// The projection below uses `||`, not `??`, and that is load-bearing wherever a
// falsy-but-present value is reachable: `deployStatus: ""` must report
// "pending", and `deployStartedAt: 0` must report null. It is provably
// equivalent to `??` for `deployLogs` (never `""`/`0`), `deployLogBase` (`0 ||
// 0` is `0 ?? 0`), `deployedGraph`, `deployAttempt`, `deployRepairing` (`false
// || false`), and `entry?.state || {}` (state is always an object), so mutating
// those four to `??` produces surviving, equivalent mutants.
export function handleDeployStatus(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): void {
  const { response, url } = context;
  const entry = dependencies.readInstanceEntry(context.instanceId);
  const resources =
    entry?.state?.deployingResources || entry?.state?.plannedResources || [];
  const logs = entry?.state?.deployLogs || [];
  const logBase = entry?.state?.deployLogBase || 0;
  const logTotal = logBase + logs.length;
  const status = entry?.state?.deployStatus || "pending";
  const error = entry?.state?.deployError || null;
  const errorKind = entry?.state?.deployErrorKind || null;
  const state = entry?.state;
  const attempt = state?.deployAttempt || null;
  const errorBranch =
    (
      state?.workspaceRepo &&
      state.workspaceBranch &&
      state.workspaceRepo.toLowerCase() ===
        attempt?.targetRepo?.toLowerCase() &&
      state.workspaceBranch === attempt.branch &&
      state.deployErrorBranch === attempt.branch
    ) ?
      state.deployErrorBranch
    : null;
  const errorPaths = entry?.state?.deployErrorPaths || null;
  const startedAt = entry?.state?.deployStartedAt || null;
  const finishedAt = entry?.state?.deployFinishedAt || null;
  let deployedGraph: unknown[] | null = null;
  if (entry?.state?.deployedGraph) {
    try {
      deployedGraph = projectSafeApplicationGraph(
        entry.state.deployedGraph
      ).resources;
    } catch {
      // Legacy in-memory state may predate artifact projection. Fail closed at
      // the HTTP boundary instead of exposing or echoing unsafe graph data.
      deployedGraph = null;
    }
  }
  const deployRunUrl = entry?.state?.deployRunUrl || null;
  // Advanced on every deploy, so an action on a failure names which one.
  const generation = entry?.state?.deployGeneration || 0;
  const active = status === "in_progress";
  // The handoff trigger runs first and short-circuits the rest of the chain, so
  // a freshly-opened repair loop reports `repairing` on the very same poll that
  // opened it rather than one poll later.
  const repairing =
    dependencies.triggerDeployRepairHandoff(entry, context.instanceId) ||
    entry?.state?.deployRepairing ||
    false;
  // Relay a run-unconfirmed failure to chat too. Kept separate from `repairing`
  // above: this failure is reported, not repaired, so it must not light up the
  // "analyzing and will repair and redeploy" UI note.
  dependencies.triggerDeployFailureNotice(entry, context.instanceId);
  const handoff = dependencies.deployHandoffStatus(entry?.state || {});
  response.setHeader("Content-Type", "application/json");
  response.writeHead(200);
  // Incremental log delivery: when the client passes ?since=<absolute line
  // index>, send only the new lines instead of re-serializing the entire
  // (bounded) buffer on every poll. Callers that omit it (e.g. the
  // deployed-graph poller, which only reads resources) get the bounded buffer
  // for backward compatibility. A non-numeric ?since is treated as absent.
  const sinceRaw = url.searchParams.get("since");
  // `=== undefined` here would be equivalent rather than wrong: `parseInt(null)`
  // is already NaN, so an absent parameter lands on the same else branch.
  const since = sinceRaw === null ? NaN : parseInt(sinceRaw, 10);
  if (Number.isFinite(since)) {
    const startIdx = Math.max(0, since - logBase);
    const logsNew = logs.slice(startIdx);
    response.end(
      JSON.stringify({
        resources,
        logsNew,
        logBase,
        logTotal,
        status,
        error,
        errorKind,
        errorBranch,
        errorPaths,
        startedAt,
        finishedAt,
        deployedGraph,
        deployRunUrl,
        attempt,
        generation,
        active,
        repairing,
        handoff
      })
    );
  } else {
    response.end(
      JSON.stringify({
        resources,
        logs,
        logBase,
        logTotal,
        status,
        error,
        errorKind,
        errorBranch,
        errorPaths,
        startedAt,
        finishedAt,
        deployedGraph,
        deployRunUrl,
        attempt,
        generation,
        active,
        repairing,
        handoff
      })
    );
  }
}

// The single Radius application a repo hosts, named by its `app.bicep`. A
// resolution failure still answers 200 with the repo basename plus an `error`
// field, so the picker stays usable while the client can still tell the name
// was guessed. That success fallback is pre-existing and preserved.
export async function handleListApplications(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const { response } = context;
  const repo = context.url.searchParams.get("repo") || "";
  const respond = (payload: unknown): void => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200);
    response.end(JSON.stringify(payload));
  };
  if (!repo) {
    respond({ applications: [] });
    return;
  }
  try {
    // The compatibility response displays a fallback name without asserting
    // that the selected branch contained a usable definition.
    const entry = dependencies.readInstanceEntry(context.instanceId);
    const branch = deployContextBranch(entry);
    const definition = await dependencies.inspectRepoApplication(repo, branch);
    const name =
      definition.kind === "defined" ? definition.name : definition.fallbackName;
    respond({ applications: [{ name }] });
  } catch (e) {
    respond({
      applications: [{ name: repo.split("/").pop() || repo }],
      error: errorMessage(e)
    });
  }
}

// Current deployment per environment. Unlike list-applications a GitHub failure
// surfaces as an error alongside an empty list (not a silently-empty listing),
// so the client keeps its current view / keeps polling rather than treating an
// incomplete answer as the truth.
export async function handleListDeployments(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const { response } = context;
  const repo = context.url.searchParams.get("repo") || "";
  const respond = (payload: unknown): void => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200);
    response.end(JSON.stringify(payload));
  };
  if (!repo) {
    respond({ deployments: [] });
    return;
  }

  // (A) Serve a fresh cached listing when available. The fan-out below is
  // expensive, so a short TTL keeps re-opens and the workflow poll snappy
  // without showing stale state for long. `?fresh=1` bypasses the cache read so
  // active status pollers (a running deploy/delete) always see live status
  // rather than a value cached before the transition. Only the literal "1"
  // bypasses; the recomputed response is still written back to the cache after
  // the request completes.
  const freshDeploys = context.url.searchParams.get("fresh") === "1";
  // The `null` is only a "no cached entry" marker for the guard below, so
  // `undefined` would be an equivalent substitute.
  const cachedDeploys =
    freshDeploys ? null : dependencies.deployListCache.get(repo);
  // The `<` boundary is exact-millisecond: `<=` differs only for a cache entry
  // written precisely `deployListTtlMs` ago. That mutant is left alive on a
  // functional-risk judgement, not a technical obstacle — it is pinnable with
  // `vi.setSystemTime`, which needs no injected clock and no extra seam, but a
  // 1 ms serving window on a 15 s cache is below the threshold worth a test.
  if (
    cachedDeploys &&
    Date.now() - cachedDeploys.at < dependencies.deployListTtlMs
  ) {
    respond(cachedDeploys.payload);
    return;
  }

  try {
    // Resolve the current deployment per environment from each environment's
    // OWN history (see resolveEnvDeployment). Querying per environment — rather
    // than a single repo-wide, capped page — means a busy environment can never
    // crowd another's latest deploy/delete record out of the results.
    const resolved = await inspectDeploymentListings(
      async () => {
        const names = await dependencies.ghOrThrow([
          "api",
          "--paginate",
          `/repos/${repo}/environments?per_page=100`,
          "--jq",
          ".environments[].name"
        ]);
        return names.split("\n").filter(Boolean);
      },
      (name) => dependencies.listEnvDeployment(repo, name, "")
    );
    const deployments = [];
    const environmentDiagnostics = [];
    for (const { environment, result } of resolved) {
      if (result.status === "rejected") {
        environmentDiagnostics.push({
          environment,
          kind: "error",
          message: redactGhCredentials(
            errorMessage(result.reason),
            dependencies.readProcessEnv()
          )
        });
        continue;
      }
      if (result.value.deployment)
        deployments.push({
          ...result.value.deployment,
          cleanupSelection: result.value.selection
        });
      if (result.value.incomplete)
        environmentDiagnostics.push({
          environment,
          kind: "incomplete",
          message:
            "Only the first 100 deployment records were checked. Load cleanup details to verify older history."
        });
    }
    const payload = {
      deployments,
      ...(environmentDiagnostics.length ? { environmentDiagnostics } : {})
    };
    dependencies.deployListCache.set(repo, { at: Date.now(), payload });
    respond(payload);
  } catch (e) {
    respond({ deployments: [], error: errorMessage(e) });
  }
}

export async function handleCleanupDetails(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await context.readTextBody());
  } catch {
    context.json(400, { error: "Invalid cleanup request." });
    return;
  }
  const result = await prepareDeploymentCleanup(payload, dependencies);
  context.json(result.status, result.body, { "Cache-Control": "no-store" });
}

// Clears the client-visible remains of a finished deploy attempt. Declared with
// body policy `none` even though it is a POST that reads a body: the body is
// optional, and an absent one is not an error.
export async function handleDeployReset(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const { response } = context;
  // Read before the body, as legacy did: the entry lookup must not observe an
  // instance that was torn down while the body was still streaming in.
  const entry = dependencies.readInstanceEntry(context.instanceId);
  const body = await context.readTextBody();
  let data: Record<string, unknown>;
  try {
    // An empty body means "reset unconditionally"; a malformed one is a 400.
    // `record` flattens any non-object JSON (null, a scalar, an array) to `{}`,
    // so those reach `resetDeploymentViewState` with an undefined attemptId.
    data = body ? record(JSON.parse(body)) : {};
  } catch (error) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(400);
    response.end(JSON.stringify({ error: errorMessage(error) }));
    return;
  }
  if (entry) {
    dependencies.resetDeploymentViewState(entry.state, data.attemptId);
  }
  response.setHeader("Content-Type", "application/json");
  response.writeHead(200);
  response.end(JSON.stringify({ ok: true }));
}

// Tears down a deployed application by dispatching the committed
// delete-application workflow. This is the one destructive route in the family,
// so every refusal path below is load-bearing: it fails closed, and a request
// that legacy refused must still be refused with the same status and message.
//
// Declared `bodyPolicy: "json"`, but dispatch does not parse anything —
// `bodyPolicy` is unenforced metadata today — so the body is read and parsed
// here exactly as legacy did.
export async function handleDeleteDeployment(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const body = await context.readTextBody();
  let result: Awaited<ReturnType<typeof requestApplicationDeletion>>;
  try {
    const payload: unknown = JSON.parse(body || "{}");
    result = await requestApplicationDeletion(
      payload,
      dependencies,
      context.instanceId
    );
  } catch (error) {
    context.json(400, { error: errorMessage(error) });
    return;
  }
  if ("dispatchUnconfirmed" in result && result.dispatchUnconfirmed) {
    context.json(result.status, {
      error:
        "GitHub may have accepted the delete workflow. Check Actions before trying again."
    });
    return;
  }
  context.json(result.status, result.body);
}

// Reports whether the last delete of an application failed with the stranded
// non-terminal-state conflict, so the page can offer the force-delete
// confirmation instead of the ordinary one. Read-only: it dispatches nothing
// and is safe to call on every delete click.
export async function handleDeleteConflict(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const repo = context.url.searchParams.get("repo") || "";
  const environment = context.url.searchParams.get("environment") || "";
  const application = context.url.searchParams.get("application") || "";
  if (
    !repo ||
    !environment ||
    !application ||
    !dependencies.isValidRepoSlug(repo)
  ) {
    context.json(400, {
      error: "A valid repo, environment, and application are required."
    });
    return;
  }
  let probe: DeleteConflictProbe;
  try {
    probe = await dependencies.probeDeleteConflict(
      {
        repo,
        environment,
        application
      },
      context.instanceId
    );
  } catch (error) {
    // Never fail the click: an unreadable probe simply leaves the ordinary
    // delete path in place.
    context.json(
      200,
      {
        conflict: false,
        resourceState: "",
        forced: false,
        detail: errorMessage(error)
      },
      { "Cache-Control": "no-store" }
    );
    return;
  }
  context.json(
    200,
    {
      conflict: probe.state === "conflict",
      resourceState: probe.state === "conflict" ? probe.resourceState : "",
      forced: probe.state === "conflict" ? probe.forced : false,
      detail: probe.state === "unknown" ? probe.detail : ""
    },
    { "Cache-Control": "no-store" }
  );
}

export async function handleAbandonDeployment(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const body = await context.readTextBody();
  let payload: unknown;
  try {
    payload = JSON.parse(body || "{}");
  } catch (error) {
    context.json(400, { error: errorMessage(error) });
    return;
  }
  const result = await dependencies.abandonment.abandon({
    instanceId: context.instanceId,
    payload
  });
  context.json(result.status, result.body);
}

// Starts a deploy. The adapter is deliberately thin: the body is read exactly
// once, handed to the admission service, and its result is serialized verbatim.
// Every refusal, reservation, attempt-identity and background-monitor concern
// belongs to that service, because none of it is an HTTP decision.
export async function handleDeploy(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const body = await context.readTextBody();
  const result = await dependencies.deployRequest.deploy({
    instanceId: context.instanceId,
    body
  });
  context.json(result.status, result.body);
}

// Adds back the trust subjects the failed AWS deploy's role is missing. The
// failed deploy names the environment; the body only names which deploy the
// panel showed, so a stale panel cannot repair a newer failure.
export async function handleRepairAwsTrust(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const body = await context.readTextBody();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const generation =
    typeof parsed === "object" && parsed !== null && "generation" in parsed ?
      parsed.generation
    : undefined;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) {
    context.json(400, {
      code: "repair-request-invalid",
      error:
        "Repair needs the deploy the panel shows, as an integer generation. Reload the page and try again."
    });
    return;
  }
  const result = await dependencies.awsTrustRepair.repair({
    instanceId: context.instanceId,
    generation
  });
  context.json(result.status, result.body);
}

// The ambient deploy chip's read-only source. Deliberately NOT served from
// `/api/deploy-status`: that route drives the repair handoff and the failure
// notice as a side effect of being polled, and the chip polls from every page
// in the canvas. Reusing it would let a graph page open a repair loop simply by
// being open. This handler only reads state, and reports the few fields a
// notification needs rather than the resource list and log buffer.
export function handleDeployNotification(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): void {
  const state = dependencies.readInstanceEntry(context.instanceId)?.state;
  const runId = state?.deployRunId;
  context.json(
    200,
    {
      attemptId: state?.deployAttempt?.id || "",
      // Advanced by `beginDeployAttempt` on every deploy invocation, so two
      // pre-dispatch failures inside one repair loop — which share an attempt
      // id, have no run, and never update the finish time — are still distinct
      // notifications rather than one the user already dismissed.
      generation: state?.deployGeneration || 0,
      // Part of the notification's outcome identity: a repair loop reuses its
      // attempt id across redeploys, so the run is what separates one outcome
      // from the next. Reset to null at attempt start, so a dispatch that never
      // reached GitHub reports "" rather than the previous run.
      runId: runId === null || runId === undefined ? "" : String(runId),
      status: state?.deployStatus || "pending",
      application: state?.deployAppName || "",
      // The attempt records the environment atomically when the deploy opens,
      // whereas `deployEnvName` is only written later, during dispatch. Reading
      // the attempt first stops a deploy that failed preflight from being
      // reported against the *previous* deploy's environment.
      environment:
        state?.deployAttempt?.environment || state?.deployEnvName || "",
      error: state?.deployError || "",
      runUrl: state?.deployRunUrl || "",
      repairing: state?.deployRepairing || false,
      finishedAt: state?.deployFinishedAt || 0
    },
    { "Cache-Control": "no-store" }
  );
}

export function createDeploymentsRoutes(
  dependencies: DeploymentsDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/deploy-status": (context) =>
      handleDeployStatus(context, dependencies),
    "POST /api/deploy/repair-aws-trust": (context) =>
      handleRepairAwsTrust(context, dependencies),
    "GET /api/deploy-notification": (context) =>
      handleDeployNotification(context, dependencies),
    "GET /api/list-applications": (context) =>
      handleListApplications(context, dependencies),
    "GET /api/list-deployments": (context) =>
      handleListDeployments(context, dependencies),
    "POST /api/deployment-cleanup-details": (context) =>
      handleCleanupDetails(context, dependencies),
    "GET /api/delete-conflict": (context) =>
      handleDeleteConflict(context, dependencies),
    "POST /api/deploy": (context) => handleDeploy(context, dependencies),
    "POST /api/deploy-reset": (context) =>
      handleDeployReset(context, dependencies),
    "POST /api/delete-deployment": (context) =>
      handleDeleteDeployment(context, dependencies),
    "POST /api/abandon-deployment": (context) =>
      handleAbandonDeployment(context, dependencies)
  };
}
