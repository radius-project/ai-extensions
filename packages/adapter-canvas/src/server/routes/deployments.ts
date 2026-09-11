import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { DeploymentAbandonmentService } from "../services/deployment-abandonment.js";
import type { DeployRequestService } from "../services/deploy-request.js";
import type { DeploymentRow } from "../services/deployment-resolver.js";
import type {
  DeleteConflictProbe,
  DeleteConflictRequest
} from "../services/delete-conflict.js";
import { shouldRetryWithKeyringCredential } from "../services/workflow-credential-fallback.js";
import { discardDeployedApplicationState } from "../services/deployed-view-state.js";
import { DELETE_FAILED_STATUS } from "../services/delete-conflict.js";
import { DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE } from "../../infra.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import { projectSafeApplicationGraph } from "@radius-project/core";

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
  resolveRepoAppName(repo: string, branch: string): Promise<string>;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    appName: string
  ): Promise<DeploymentRow | null>;
  // The gh runner that REJECTS on failure, so a GitHub outage surfaces as an
  // error payload rather than as a definitive empty listing.
  ghOrThrow(args: string[]): Promise<string>;
  resetDeploymentViewState(state: CanvasState, attemptId: unknown): void;
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
  findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId: number | string | null
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
    request: DeleteConflictRequest
  ): Promise<DeleteConflictProbe>;
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

// The dispatch retry uses the same injected timer as the reservation lease, so a
// test can drive both without real delays.
function sleep(
  dependencies: DeploymentsDependencies,
  ms: number
): Promise<void> {
  return new Promise((resolve) => {
    dependencies.setTimer(() => resolve(), ms);
  });
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
  const errorBranch = entry?.state?.deployErrorBranch || null;
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
  const attempt = entry?.state?.deployAttempt || null;
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
    // The application name is defined in the repo's app.bicep (a repo hosts a
    // single Radius application in this model). Shared with the
    // deployments/env-deletion paths via resolveRepoAppName.
    const entry = dependencies.readInstanceEntry(context.instanceId);
    const branch = deployContextBranch(entry);
    const appName = await dependencies.resolveRepoAppName(repo, branch);
    respond({ applications: [{ name: appName }] });
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
    const envNamesRaw = await dependencies.ghOrThrow([
      "api",
      "--paginate",
      `/repos/${repo}/environments?per_page=100`,
      "--jq",
      ".environments[].name"
    ]);
    const envNames =
      envNamesRaw ? [...new Set(envNamesRaw.split("\n").filter(Boolean))] : [];
    // Resolve the real app name once (from app.bicep) so every row targets the
    // app declared in the bicep, not the repo basename.
    const listEntry = dependencies.readInstanceEntry(context.instanceId);
    const listBranch = deployContextBranch(listEntry);
    const listAppName = await dependencies.resolveRepoAppName(repo, listBranch);
    const resolved = await Promise.all(
      envNames.map((name) =>
        dependencies.resolveEnvDeployment(repo, name, listAppName)
      )
    );
    const payload = { deployments: resolved.filter(Boolean) };
    dependencies.deployListCache.set(repo, { at: Date.now(), payload });
    respond(payload);
  } catch (e) {
    respond({ deployments: [], error: errorMessage(e) });
  }
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
  const { response } = context;
  const body = await context.readTextBody();
  const respond = (code: number, payload: unknown): void => {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(code);
    response.end(JSON.stringify(payload));
  };
  let reservation: DeploymentDispatchLease | null = null;
  let reservationOwner: CanvasState | null = null;
  const releaseReservation = (): void => {
    if (reservation && reservationOwner)
      dependencies.releaseDeploymentMutation(reservationOwner, reservation);
    reservation = null;
    reservationOwner = null;
  };
  try {
    const data = JSON.parse(body || "{}");
    // `||` here is equivalent to `??`: every falsy value fails the `!repo`
    // guard below either way, so those three mutants survive provably.
    const repo = data.repo || "";
    const environment = data.environment || "";
    const application = data.application || "";
    // Forcing is destructive beyond an ordinary delete — it removes records
    // whose external resources may still exist — so only the exact boolean
    // `true` enables it. A truthy string from a hand-made request does not.
    const force = record(data).force === true;
    if (
      !repo ||
      !environment ||
      !application ||
      !dependencies.isValidRepoSlug(repo)
    ) {
      respond(400, {
        error: "A valid repo, environment, and application are required."
      });
      return;
    }

    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (!entry) {
      respond(503, { error: "Canvas server state is unavailable." });
      return;
    }
    const attempt = entry.state.deployAttempt;
    const activeRepo = attempt?.targetRepo || entry.state.deployingRepo || "";
    const activeEnvironment = attempt?.environment || entry.state.envName || "";
    const reserved = dependencies.activeDeploymentMutation(entry.state);
    if (dependencies.localDeploymentBlocksMutation(entry.state) || reserved) {
      const operation = reserved?.kind || "deploy";
      const conflictRepo = reserved?.repo || activeRepo || repo;
      const conflictEnvironment =
        reserved?.environment || activeEnvironment || environment;
      respond(409, {
        error: `A ${operation} operation for ${conflictRepo} in environment ${conflictEnvironment} is already in progress. Wait for it to finish before starting another operation.`
      });
      return;
    }

    reservationOwner = entry.state;
    reservation = dependencies.reserveDeploymentMutation(entry.state, {
      repo,
      environment,
      kind: "delete"
    });
    if (!reservation) {
      const conflict = dependencies.activeDeploymentMutation(entry.state);
      respond(409, {
        error:
          conflict ?
            `A ${conflict.kind} operation for ${conflict.repo} in environment ${conflict.environment} is already starting.`
          : "Another deployment operation is already starting."
      });
      return;
    }

    // Backstop the UI with GitHub's persisted state too. This covers a
    // deployment started from another canvas instance or browser session.
    let current: DeploymentRow | null;
    try {
      current = await dependencies.resolveEnvDeployment(
        repo,
        environment,
        application
      );
    } catch {
      releaseReservation();
      respond(503, {
        error:
          "Could not verify the current deployment state. Check your GitHub connection and try again."
      });
      return;
    }
    if (
      current &&
      dependencies.deploymentStatusBlocksMutation(current.status)
    ) {
      releaseReservation();
      respond(409, {
        error:
          current.status === "deleting" ?
            "This deployment is already being deleted."
          : "This application is still being deployed to the selected environment. Wait for the deployment to finish before deleting it."
      });
      return;
    }
    // Forcing removes control-plane records whose external resources may still
    // exist, so it is not an alternative way to run a first delete: it is only
    // reachable as a retry of a delete GitHub already recorded as failed.
    if (force && current?.status !== DELETE_FAILED_STATUS) {
      releaseReservation();
      respond(409, {
        error:
          "A delete can only be forced after a previous delete of this application failed. Run the delete normally first."
      });
      return;
    }
    // `delete-failed` alone is not proof: a delete can fail for credential,
    // network or workflow-configuration reasons that forcing cannot fix and
    // must not paper over. Forcing is only for a resource stranded in a
    // non-terminal provisioning state, so re-read the failed run's artifact
    // here rather than trusting the client's probe, which may be stale or
    // absent entirely. Fails closed: anything but a proven conflict refuses.
    if (force) {
      let proof: DeleteConflictProbe;
      try {
        proof = await dependencies.probeDeleteConflict({
          repo,
          environment,
          application
        });
      } catch (error) {
        releaseReservation();
        respond(503, {
          error: `The previous delete failure could not be verified, so this delete was not forced: ${errorMessage(error)}`
        });
        return;
      }
      if (proof.state !== "conflict") {
        releaseReservation();
        respond(409, {
          error:
            proof.state === "clear" ?
              "The previous delete did not fail because a resource was stuck in a non-terminal state, so forcing would not help. Run the delete normally and address the reported failure."
            : `The previous delete failure could not be verified, so this delete was not forced: ${proof.detail}`
        });
        return;
      }
    }

    // Dispatching a workflow requires the `workflow` scope, which an injected
    // GH_TOKEN often lacks. Retry with it stripped ONLY when that fallback is
    // safe: the failure names the missing scope, and the dispatch did not time
    // out (a timed-out dispatch may already have been accepted, and a retry
    // would start a second delete run).
    const ghWorkflow = async (args: string[]): Promise<CommandResult> => {
      const first = await dependencies.runGh(args);
      if (first.code === 0) return first;
      const env = dependencies.readProcessEnv();
      const retryAllowed = shouldRetryWithKeyringCredential({
        stderr: first.stderr,
        timedOut: first.timedOut,
        hasInjectedToken: Boolean(
          env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
        )
      });
      if (!retryAllowed) return first;
      const fallbackEnv = { ...env };
      delete fallbackEnv.GH_TOKEN;
      delete fallbackEnv.GITHUB_TOKEN;
      const retry = await dependencies.runGh(args, 20000, fallbackEnv);
      return retry.code === 0 ? retry : first;
    };

    // Deleting a deployment runs `rad app delete` via the committed
    // delete-application.yml workflow. This tears down the Radius application on
    // the ephemeral control plane while leaving the GitHub Environment (and its
    // credentials) intact.
    //
    // Ensure the delete workflow files are in sync with upstream before
    // dispatching, so the run never executes a drifted copy — and author them if
    // they're missing (the #273 case). Delete workflow content is
    // provider-agnostic, and workflow_dispatch runs from the default branch, so
    // provider/workingBranch aren't needed.
    const sync = await dependencies.ensureWorkflowsCurrent(
      repo,
      environment,
      "",
      [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE]
    );
    // If the sync couldn't commit the dispatcher to the default branch (e.g.
    // it's protected, or the token lacks write access), the dispatch below will
    // 404 on a genuinely-absent workflow. Fail fast with a specific message
    // naming the branch instead of the generic hint.
    const commitFail = sync.failed.find(
      (f) => f.path.split("/").pop() === DELETE_APP_DISPATCHER_FILE
    );
    if (commitFail) {
      releaseReservation();
      respond(400, {
        error:
          "Couldn't commit the delete workflow (" +
          DELETE_APP_DISPATCHER_FILE +
          ') to the "' +
          commitFail.branch +
          '" branch of ' +
          repo +
          ", so there's nothing to dispatch. The branch may be protected" +
          " or your GitHub token may lack write access to " +
          repo +
          "."
      });
      return;
    }
    // A just-authored workflow isn't registered by GitHub synchronously, so an
    // immediate workflow_dispatch would 404. When we created it, wait briefly
    // and retry the not-found race a few times (mirroring the create-environment
    // verify dispatch); when it was already present, the single [0]-delay
    // attempt keeps the common path fast.
    const justCreated = sync.created.some(
      (p) => p.split("/").pop() === DELETE_APP_DISPATCHER_FILE
    );
    const dispatchedAt = Date.now();
    const dispatchArgs = [
      "workflow",
      "run",
      DELETE_APP_DISPATCHER_FILE,
      "-f",
      "environment=" + environment,
      "-f",
      "application=" + application,
      ...(force ? ["-f", "force=true"] : []),
      "--repo",
      repo
    ];
    let dispatch: CommandResult = { code: 1, stdout: "", stderr: "" };
    // A `force` dispatch also has to survive the *input-schema* race: the
    // dispatcher that was just committed or updated declares the `force` input,
    // but GitHub answers 422 "unexpected inputs" until it has re-read the file
    // from the default branch. Give that the same bounded retry the
    // not-yet-registered workflow gets, rather than reporting a failure the
    // user cannot act on.
    const dispatchDelays = justCreated || force ? [0, 2000, 5000] : [0];
    if (justCreated) await sleep(dependencies, 3000);
    for (const delay of dispatchDelays) {
      // `> 0` vs `> 1` is equivalent over the fixed delay set {0, 2000, 5000}:
      // no member lies between the two thresholds.
      if (delay > 0) await sleep(dependencies, delay);
      dispatch = await ghWorkflow(dispatchArgs);
      if (dispatch.code === 0) break;
      if (dispatch.timedOut) break;
      // Only the not-found registration race and the unexpected-input race
      // self-resolve; any other failure (scope, Actions disabled, …) won't, so
      // stop retrying.
      if (
        !/not found|HTTP 404/i.test(dispatch.stderr || "") &&
        !(force && /unexpected inputs?|HTTP 422/i.test(dispatch.stderr || ""))
      ) {
        break;
      }
    }
    if (dispatch.code !== 0) {
      releaseReservation();
      const de = (dispatch.stderr || "").trim();
      // `{0,20}` vs `{1,20}` differs only for the literal "workflowscope" with
      // no separator, which no real `gh` diagnostic emits; left alive.
      const ghCommandPresentation =
        dependencies.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
      const refreshCommand = displayGhCommand(ghCommandPresentation, [
        "auth",
        "refresh",
        "-h",
        "github.com",
        "-s",
        "workflow"
      ]);
      const installation =
        ghCommandPresentation.installationNote ?
          ` ${ghCommandPresentation.installationNote}`
        : "";
      // An exhausted unexpected-input retry is a stale dispatcher, not a
      // permissions or Actions problem, so it says so instead of sending the
      // user to check settings that are already correct.
      const staleForceInput = force && /unexpected inputs?|HTTP 422/i.test(de);
      const hint =
        staleForceInput ?
          " GitHub is still rejecting the `force` input, which means the copy" +
          " of " +
          DELETE_APP_DISPATCHER_FILE +
          " on the default branch of " +
          repo +
          " has not picked up that input yet. It is committed automatically," +
          " so wait a moment and retry the forced delete."
        : /workflow.{0,20}scope/i.test(de) ?
          refreshCommand ?
            ` Your GitHub token is missing the "workflow" scope. Run \`${refreshCommand}\` in a terminal, then retry.${installation}`
          : ` Your GitHub token is missing the "workflow" scope. ${ghCommandPresentation.installationNote}`
        : " The delete workflow is committed to the default branch" +
          " automatically before dispatch, so a persistent failure usually" +
          " means GitHub Actions is disabled for " +
          repo +
          " or the default branch is protected — check both and retry.";
      respond(400, {
        error:
          "Failed to start the delete workflow (" +
          DELETE_APP_DISPATCHER_FILE +
          ") on " +
          repo +
          ". " +
          (de || "The dispatch request failed.") +
          hint
      });
      return;
    }

    // Best-effort: resolve the dispatched run's URL so the client can link to it
    // in GitHub.
    let runUrl = "";
    const runId = await dependencies.findWorkflowRun(
      repo,
      DELETE_APP_DISPATCHER_FILE,
      dispatchedAt,
      null
    );
    if (runId) runUrl = "https://github.com/" + repo + "/actions/runs/" + runId;
    // A workflow run can become discoverable before it creates its GitHub
    // deployment record. Retain a short lease in either case to close that
    // publication gap; after it expires, resolveEnvDeployment is the durable
    // cross-instance guard.
    const reservationTimer = dependencies.setTimer(
      releaseReservation,
      dependencies.deployListTtlMs * 2
    );
    reservationTimer.unref?.();
    // A delete is now in flight, so the cached listing is stale — drop it so the
    // next poll reflects the "Deleting…" state immediately.
    dependencies.deployListCache.delete(repo);
    // The delete run removes the deploy-status artifact for exactly this
    // environment and application, which is what stops other sessions rendering
    // the deleted deployment. This session also holds its own copy of that
    // deploy, so retire it here or the Deployed view keeps showing "Last
    // deployment" from state no artifact read can override.
    discardDeployedApplicationState(entry.state, { environment, application });
    respond(200, { success: true, runUrl, forced: force });
  } catch (e) {
    releaseReservation();
    respond(400, { error: errorMessage(e) });
  }
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
    probe = await dependencies.probeDeleteConflict({
      repo,
      environment,
      application
    });
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
    "GET /api/deploy-notification": (context) =>
      handleDeployNotification(context, dependencies),
    "GET /api/list-applications": (context) =>
      handleListApplications(context, dependencies),
    "GET /api/list-deployments": (context) =>
      handleListDeployments(context, dependencies),
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
