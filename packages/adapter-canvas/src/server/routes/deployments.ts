import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { DeploymentAbandonmentService } from "../services/deployment-abandonment.js";
import type { DeployRequestService } from "../services/deploy-request.js";
import type { DeploymentRow } from "../services/deployment-resolver.js";
import { shouldRetryWithKeyringCredential } from "../services/workflow-credential-fallback.js";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DELETE_RESOURCE_DISPATCHER_FILE
} from "../../infra.js";
import {
  authorizeRemovedResourceDelete,
  type DeployedResourceIdentity
} from "../services/deployed-inventory.js";
import {
  loadCurrentDeployedModel,
  readCurrentDeployedModel,
  type CurrentDeployedModel,
  type ReloadModeledGraph
} from "../services/current-deployed-model.js";
import type { RepoMatchesWorkspace } from "../services/deployed-graph-branch.js";
import { RESOURCE_DELETING_STATUS } from "../services/deployment-resolver.js";
import {
  classifyLifecycleConclusion,
  lifecycleOutcomeMessage,
  stateSaveFailureWarning,
  type LifecycleOutcome
} from "@radius-project/core";
import {
  describeStateSaveFailure,
  type StateSaveFailure
} from "../../state-save-diagnostics.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";

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
  // `afterRunId` is the run-id baseline captured immediately BEFORE the
  // dispatch and `correlationId` the opaque id this dispatch echoed into the
  // run's display name. Both narrow discovery to the run this call started: the
  // correlation is the exact identity, the baseline is the additional guard
  // that a run created before the dispatch can never be returned.
  findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId: number | string | null,
    afterRunId?: number | string | null,
    correlationId?: string | null
  ): Promise<number | string | null>;
  // The newest run id of one workflow, read just before a dispatch so the
  // discovery below can refuse anything that is not newer. Resolves to null
  // when GitHub cannot answer, which only weakens the guard back to the
  // correlation match — it never invents a baseline.
  latestWorkflowRunId(
    repo: string,
    workflowFile: string
  ): Promise<number | string | null>;
  // A fresh, unguessable id for one delete dispatch. Passed to the dispatcher
  // as `correlation_id`, which the committed workflow echoes into its
  // `run-name:`, so the run this call started can be identified exactly rather
  // than by "newest run in a time window".
  newCorrelationId(): string;
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
  // Exception 7.1: the per-resource delete must be authorized against the
  // branch the canvas currently reads this repository's definition from, which
  // is the same precedence `/api/deployed-graph` uses.
  repoMatchesWorkspace: RepoMatchesWorkspace;
  // Re-reads the modeled application definition for one repository and branch
  // through the same modeled-graph workflow `/api/deployed-graph` uses. The
  // per-resource delete calls it immediately before dispatch so the removal is
  // re-derived from the definition as it stands then, not as it stood when the
  // request arrived.
  reloadModeledGraph: ReloadModeledGraph;
  // Drops every cached deploy-status read for one repository. A delete run
  // republishes the application's inventory, so the next deployed-graph read
  // must go back to GitHub rather than answer from the pre-delete artifact it
  // already downloaded.
  invalidateDeployedGraphCache(repo: string): void;
  // Exception 5.4: the teardown diagnostic for one run attempt, used by the
  // delete-run terminal status the browser polls.
  readStateSaveFailure(
    repo: string,
    runId: string,
    runAttempt: string
  ): Promise<StateSaveFailure | null>;
  // The admission half of POST /api/deploy. Everything that route does beyond
  // reading the body and writing the response lives behind this port, because
  // the deploy is a multi-stage runtime operation rather than an HTTP concern.
  deployRequest: DeployRequestService;
  // GitHub-side cleanup is a separate use case from cloud deletion. The route
  // only parses HTTP input and serializes this service's result.
  abandonment: DeploymentAbandonmentService;
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

// Untrusted body fields reach a destructive dispatch, so a non-string is an
// absent value rather than something to coerce.
function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// The refusal for a deployment GitHub says is mid-operation. Each blocking
// status gets its own sentence: "still being deployed" is actively misleading
// when what is actually running is a delete or a single-resource cleanup, and
// the user's next action differs in each case.
function blockedDeploymentMessage(status: string, action: string): string {
  if (status === "deleting") return "This deployment is already being deleted.";
  if (status === RESOURCE_DELETING_STATUS) {
    return `A resource of this application is being deleted. Wait for that cleanup to finish before ${action}.`;
  }
  return `This application is still being deployed to the selected environment. Wait for the deployment to finish before ${action}.`;
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
  const stateWarning = entry?.state?.deployStateWarning || null;
  const errorKind = entry?.state?.deployErrorKind || null;
  const errorBranch = entry?.state?.deployErrorBranch || null;
  const errorPaths = entry?.state?.deployErrorPaths || null;
  const startedAt = entry?.state?.deployStartedAt || null;
  const finishedAt = entry?.state?.deployFinishedAt || null;
  const deployedGraph = entry?.state?.deployedGraph || null;
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
        stateWarning,
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
        stateWarning,
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

export type DeleteDispatchResult =
  | { ok: true; runUrl: string; runId: string }
  | { ok: false; status: number; error: string };

// How long discovery keeps looking for the dispatched run. A workflow_dispatch
// is accepted before its run is listable, so a single immediate query would
// usually find nothing — and an empty answer here costs the client the run
// identity it needs to track this exact delete.
const RUN_DISCOVERY_DELAYS = [0, 2000, 4000] as const;

// The delete-workflow dispatch both destructive delete routes share: bring the
// committed workflow files up to date, dispatch the dispatcher with the caller's
// inputs, and resolve the run URL. Extracted rather than copied because the
// refusal messages, the registration-race retry and the workflow-scope fallback
// are safety behavior — a second, drifting copy of them is exactly how a
// destructive path stops failing closed.
async function dispatchDeleteWorkflow(
  dependencies: DeploymentsDependencies,
  options: {
    repo: string;
    environment: string;
    // Which committed dispatcher to run. Deleting an application and deleting
    // one of its resources are different operations with different consequences
    // for the environment's deployment record, so they never share a file.
    workflowFile: string;
    // `key=value` pairs, each passed to `gh workflow run` behind its own `-f`.
    workflowInputs: readonly string[];
    // Re-checked immediately before every `gh workflow run` attempt — including
    // the keyring-credential retry, which is separated from its own first
    // attempt by an awaited dispatch. Everything above this point is awaited
    // work during which the canvas can move to another branch or reload another
    // definition, so an authorization taken before it describes the past. A
    // refusal here means nothing was dispatched.
    authorize?: () => Promise<
      { ok: true } | { ok: false; status: number; error: string }
    >;
  }
): Promise<DeleteDispatchResult> {
  const { repo, environment, workflowFile, workflowInputs } = options;
  // Either an executed command, or the refusal that stopped it from executing.
  // The two are kept apart on purpose: a refusal is not a failed dispatch, and
  // must never be reported as one or retried as one.
  type AuthorizedDispatch =
    | { ok: true; result: CommandResult }
    | { ok: false; status: number; error: string };

  // The ONLY way this function runs `gh`. Authorization is re-taken here rather
  // than by the callers, so no dispatch path — first attempt, registration-race
  // retry, or credential fallback — can reach GitHub with an authorization that
  // was taken before the preceding await.
  const runAuthorized = async (
    args: string[],
    timeout?: number,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<AuthorizedDispatch> => {
    if (options.authorize) {
      const authorized = await options.authorize();
      if (!authorized.ok) return authorized;
    }
    return {
      ok: true,
      result: await dependencies.runGh(args, timeout, extraEnv)
    };
  };

  // Dispatching a workflow requires the `workflow` scope, which an injected
  // GH_TOKEN often lacks. Retry with it stripped ONLY when that fallback is
  // safe: the failure names the missing scope, and the dispatch did not time
  // out (a timed-out dispatch may already have been accepted, and a retry
  // would start a second delete run). The retry is a second dispatch of a
  // destructive operation, so it is re-authorized like any other.
  const ghWorkflow = async (args: string[]): Promise<AuthorizedDispatch> => {
    const first = await runAuthorized(args);
    if (!first.ok || first.result.code === 0) return first;
    const env = dependencies.readProcessEnv();
    const retryAllowed = shouldRetryWithKeyringCredential({
      stderr: first.result.stderr,
      timedOut: first.result.timedOut,
      hasInjectedToken: Boolean(
        env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
      )
    });
    if (!retryAllowed) return first;
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const retry = await runAuthorized(args, 20000, fallbackEnv);
    // A refusal taken while the scope-rejected attempt was in flight is the
    // decision: the definition, branch or inventory moved, so the fallback is
    // reported as the refusal it is and nothing is dispatched a second time.
    if (!retry.ok) return retry;
    return retry.result.code === 0 ? retry : first;
  };

  // Deleting runs `rad app delete` / `rad resource delete` via the committed
  // delete-application.yml workflow. This tears down the Radius resource on the
  // ephemeral control plane while leaving the GitHub Environment (and its
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
    [workflowFile, DELETE_AZURE_FILE]
  );
  // If the sync couldn't commit the dispatcher to the default branch (e.g.
  // it's protected, or the token lacks write access), the dispatch below will
  // 404 on a genuinely-absent workflow. Fail fast with a specific message
  // naming the branch instead of the generic hint.
  const commitFail = sync.failed.find(
    (f) => f.path.split("/").pop() === workflowFile
  );
  if (commitFail) {
    return {
      ok: false,
      status: 400,
      error:
        "Couldn't commit the delete workflow (" +
        workflowFile +
        ') to the "' +
        commitFail.branch +
        '" branch of ' +
        repo +
        ", so there's nothing to dispatch. The branch may be protected" +
        " or your GitHub token may lack write access to " +
        repo +
        "."
    };
  }
  // A just-authored workflow isn't registered by GitHub synchronously, so an
  // immediate workflow_dispatch would 404. When we created it, wait briefly
  // and retry the not-found race a few times (mirroring the create-environment
  // verify dispatch); when it was already present, the single [0]-delay
  // attempt keeps the common path fast.
  const justCreated = sync.created.some(
    (p) => p.split("/").pop() === workflowFile
  );
  const dispatchedAt = Date.now();
  // The identity of THIS dispatch. The dispatcher echoes it into the run's
  // display name, so discovery below can insist on the exact run rather than
  // accepting whatever the workflow started most recently — which, with another
  // environment being deleted at the same time, is how a delete gets linked to
  // a stranger's run.
  const correlationId = dependencies.newCorrelationId();
  // Additional protection: the newest run this workflow already has. Anything
  // not newer than this cannot be the run the dispatch below starts.
  let baselineRunId: number | string | null = null;
  try {
    baselineRunId = await dependencies.latestWorkflowRunId(repo, workflowFile);
  } catch {
    // A baseline that cannot be read narrows nothing, but it invents nothing
    // either: the correlation match below still has to hold.
  }
  const dispatchArgs = [
    "workflow",
    "run",
    workflowFile,
    ...workflowInputs.flatMap((input) => ["-f", input]),
    "-f",
    "correlation_id=" + correlationId,
    "--repo",
    repo
  ];
  let dispatch: CommandResult = { code: 1, stdout: "", stderr: "" };
  const dispatchDelays = justCreated ? [0, 2000, 5000] : [0];
  if (justCreated) await sleep(dependencies, 3000);
  for (const delay of dispatchDelays) {
    // `> 0` vs `> 1` is equivalent over the fixed delay set {0, 2000, 5000}:
    // no member lies between the two thresholds.
    if (delay > 0) await sleep(dependencies, delay);
    const attempt = await ghWorkflow(dispatchArgs);
    // Refused, not failed: the caller reports the refusal verbatim, and the
    // loop stops because there is nothing left to authorize.
    if (!attempt.ok) return attempt;
    dispatch = attempt.result;
    if (dispatch.code === 0) break;
    if (dispatch.timedOut) break;
    // Only the not-found registration race self-resolves; any other failure
    // (scope, Actions disabled, …) won't, so stop retrying.
    if (!/not found|HTTP 404/i.test(dispatch.stderr || "")) break;
  }
  if (dispatch.code !== 0) {
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
    const hint =
      /workflow.{0,20}scope/i.test(de) ?
        refreshCommand ?
          ` Your GitHub token is missing the "workflow" scope. Run \`${refreshCommand}\` in a terminal, then retry.${installation}`
        : ` Your GitHub token is missing the "workflow" scope. ${ghCommandPresentation.installationNote}`
      : " The delete workflow is committed to the default branch" +
        " automatically before dispatch, so a persistent failure usually" +
        " means GitHub Actions is disabled for " +
        repo +
        " or the default branch is protected — check both and retry.";
    return {
      ok: false,
      status: 400,
      error:
        "Failed to start the delete workflow (" +
        workflowFile +
        ") on " +
        repo +
        ". " +
        (de || "The dispatch request failed.") +
        hint
    };
  }

  // Resolve THIS dispatch's run so the client can link to it and track it.
  // Bounded and exact: a run is accepted only when it carries this dispatch's
  // correlation id (and, when the baseline was readable, is newer than every
  // run that already existed). Anything else resolves to no run at all, which
  // the client reports as unknown — never as somebody else's run.
  let runId: number | string | null = null;
  for (const delay of RUN_DISCOVERY_DELAYS) {
    if (delay > 0) await sleep(dependencies, delay);
    runId = await dependencies.findWorkflowRun(
      repo,
      workflowFile,
      dispatchedAt,
      null,
      baselineRunId,
      correlationId
    );
    if (runId) break;
  }
  return {
    ok: true,
    runId: runId ? String(runId) : "",
    runUrl: runId ? "https://github.com/" + repo + "/actions/runs/" + runId : ""
  };
}

// Tears down a deployed application by dispatching the committed
// delete-application workflow. This is the one application-scoped destructive
// route in the family,
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
        error: blockedDeploymentMessage(current.status, "deleting it")
      });
      return;
    }

    const dispatched = await dispatchDeleteWorkflow(dependencies, {
      repo,
      environment,
      workflowFile: DELETE_APP_DISPATCHER_FILE,
      workflowInputs: [
        "environment=" + environment,
        "application=" + application
      ]
    });
    if (!dispatched.ok) {
      releaseReservation();
      respond(dispatched.status, { error: dispatched.error });
      return;
    }
    const runUrl = dispatched.runUrl;
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
    // `runId` is the identity the page polls against: a retried delete must be
    // tracked by the run THIS request started, not by whatever terminal row the
    // previous attempt left in the listing. Empty when the run could not be
    // identified exactly, which the page reports rather than guessing.
    respond(200, { success: true, runUrl, runId: dispatched.runId });
  } catch (e) {
    releaseReservation();
    respond(400, { error: errorMessage(e) });
  }
}

// Deletes ONE deployed resource the current application definition no longer
// declares — exception 7.1. Deployment is incremental, so removing a resource
// from `app.bicep` leaves it running; this is how the user reclaims it.
//
// Fails closed at every step. The client's claim about what is orphaned is
// never trusted: the request must carry the exact revision of the deployed
// inventory `/api/deployed-graph` last derived on this instance for this
// repository, branch, environment and application, AND the removal is
// re-derived from the definition as it stands at dispatch time. A resource put
// back into `app.bicep`, a branch switch, a redeploy, or a stale page all
// refuse rather than dispatch.
export async function handleDeleteResource(
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
    const data = record(JSON.parse(body || "{}"));
    const repo = optionalText(data.repo);
    const environment = optionalText(data.environment);
    const application = optionalText(data.application);
    const resourceName = optionalText(data.resourceName);
    const resourceType = optionalText(data.resourceType);
    const revision = optionalText(data.revision);
    if (
      !repo ||
      !environment ||
      !application ||
      !resourceName ||
      !resourceType ||
      !revision ||
      !dependencies.isValidRepoSlug(repo)
    ) {
      respond(400, {
        error:
          "A valid repo, environment, application, resource name, resource type, and deployed-graph revision are required."
      });
      return;
    }

    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (!entry) {
      respond(503, { error: "Canvas server state is unavailable." });
      return;
    }

    // Identity: re-derived here, now, from the branch the canvas currently
    // reads this repository's definition from. This first pass refuses a stale
    // confirmation before anything is reserved or dispatched; the SECOND pass,
    // below, is the one that decides, because everything between the two is
    // awaited work the canvas can move underneath.
    const identity = {
      repo,
      environment,
      application,
      resourceName,
      resourceType,
      revision
    };
    const confirmedDeployed = (): readonly DeployedResourceIdentity[] =>
      entry.state.deployedInventory?.resources ?? [];
    const authorizeAgainst = (current: CurrentDeployedModel) =>
      authorizeRemovedResourceDelete({
        inventory: entry.state.deployedInventory,
        currentBranch: current.branch,
        currentModeled: current.modeled,
        currentRevision: current.revision,
        request: identity
      });
    const authorization = authorizeAgainst(
      readCurrentDeployedModel({
        state: entry.state,
        repo,
        environment,
        application,
        deployed: confirmedDeployed(),
        repoMatchesWorkspace: dependencies.repoMatchesWorkspace
      })
    );
    if (!authorization.ok) {
      respond(authorization.status, { error: authorization.error });
      return;
    }
    const removed = authorization.resource;

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

    // Backstop with GitHub's persisted state too, which covers an operation
    // started from another canvas instance or browser session.
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
        error: blockedDeploymentMessage(
          current.status,
          "deleting one of its resources"
        )
      });
      return;
    }

    // A single-resource cleanup runs its OWN dispatcher. Sharing the
    // application dispatcher would make its successful GitHub deployment record
    // indistinguishable from a whole-application teardown, and the application
    // would silently vanish from the Deployments list.
    const dispatched = await dispatchDeleteWorkflow(dependencies, {
      repo,
      environment,
      workflowFile: DELETE_RESOURCE_DISPATCHER_FILE,
      workflowInputs: [
        "environment=" + environment,
        "application=" + application,
        "resource_name=" + removed.name,
        "radius_resource_type=" + removed.type
      ],
      // The decisive authorization. It runs after the deployment-state read and
      // the workflow sync — every await above — and reloads the definition from
      // the branch the canvas reads RIGHT NOW rather than trusting the modeled
      // graph this request started with. A branch switch, a re-modeled
      // definition, a newer deployed inventory, or a definition that cannot be
      // loaded at all all refuse here, with nothing dispatched.
      authorize: async () => {
        const current = await loadCurrentDeployedModel(
          {
            readInstanceEntry: dependencies.readInstanceEntry,
            repoMatchesWorkspace: dependencies.repoMatchesWorkspace,
            reloadModeledGraph: dependencies.reloadModeledGraph
          },
          {
            instanceId: context.instanceId,
            repo,
            environment,
            application,
            deployed: confirmedDeployed()
          }
        );
        if (!current.ok) {
          return {
            ok: false,
            status: current.status,
            error: `${current.error} Nothing was deleted; reload the deployed graph and try again.`
          };
        }
        const reauthorized = authorizeAgainst(current.model);
        return reauthorized.ok ? { ok: true } : reauthorized;
      }
    });
    if (!dispatched.ok) {
      releaseReservation();
      respond(dispatched.status, { error: dispatched.error });
      return;
    }
    const reservationTimer = dependencies.setTimer(
      releaseReservation,
      dependencies.deployListTtlMs * 2
    );
    reservationTimer.unref?.();
    dependencies.deployListCache.delete(repo);
    respond(200, {
      success: true,
      runUrl: dispatched.runUrl,
      runId: dispatched.runId,
      resource: { name: removed.name, type: removed.type }
    });
  } catch (e) {
    releaseReservation();
    respond(400, { error: errorMessage(e) });
  }
}

// The terminal outcome of one delete run, so the page that dispatched it can
// stop guessing. Read-only and bounded: the browser polls it a fixed number of
// times and reports a timeout of its own rather than polling forever.
//
// Answers a 200 for an in-flight run and for a terminal one alike; a non-200 is
// reserved for a request the server refuses to interpret at all.
export async function handleDeleteRunStatus(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const { url } = context;
  const repo = (url.searchParams.get("repo") || "").trim();
  const runId = (url.searchParams.get("runId") || "").trim();
  if (!repo || !dependencies.isValidRepoSlug(repo) || !/^\d+$/.test(runId)) {
    context.json(400, {
      error: "A valid repo and numeric runId are required."
    });
    return;
  }
  let status: string;
  let conclusion: string;
  let runAttempt: string;
  try {
    const raw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/actions/runs/${runId}`,
      "--jq",
      '(.status // "") + "\\t" + (.conclusion // "") + "\\t" + ((.run_attempt // 1) | tostring)'
    ]);
    [status = "", conclusion = "", runAttempt = ""] = raw.trim().split("\t");
  } catch (error) {
    // A read failure is not an outcome. The browser keeps polling within its
    // own bound and reports "could not be confirmed" if it never resolves.
    context.json(200, {
      state: "unknown",
      outcome: null,
      conclusion: "",
      error: errorMessage(error),
      stateWarning: null,
      runUrl: `https://github.com/${repo}/actions/runs/${runId}`
    });
    return;
  }
  const completed = status.trim() === "completed";
  const outcome: LifecycleOutcome | null =
    completed ? classifyLifecycleConclusion(conclusion) : null;
  let stateWarning: string | null = null;
  if (completed) {
    // The run is over, so whatever the canvas cached about this repository's
    // deployed state predates it. A successful resource delete republishes the
    // application's inventory from the live control plane, and the page reloads
    // the deployed graph as soon as it reads this answer — dropping the cached
    // reader and the session's own snapshot here is what makes that reload read
    // the new inventory instead of replaying the pre-delete one.
    dependencies.invalidateDeployedGraphCache(repo);
    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (entry?.state && entry.state.deployedGraphRepo === repo) {
      entry.state.deployedGraph = null;
    }
    if (entry?.state?.deployedInventory?.repo === repo) {
      entry.state.deployedInventory = null;
    }
    let failure: StateSaveFailure | null;
    try {
      failure = await dependencies.readStateSaveFailure(
        repo,
        runId,
        runAttempt.trim()
      );
    } catch {
      failure = null;
    }
    if (failure) {
      stateWarning = stateSaveFailureWarning(
        "deletion",
        describeStateSaveFailure(failure)
      );
    }
  }
  context.json(
    200,
    {
      state: completed ? "completed" : status.trim() || "unknown",
      outcome,
      outcomeMessage:
        outcome ? lifecycleOutcomeMessage("deletion", outcome) : null,
      conclusion: conclusion.trim(),
      stateWarning,
      runUrl: `https://github.com/${repo}/actions/runs/${runId}`
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
      // Exception 5.4: an orphan warning must reach the chip even on a run that
      // otherwise succeeded, so it is reported independently of `error`.
      stateWarning: state?.deployStateWarning || "",
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
    "POST /api/deploy": (context) => handleDeploy(context, dependencies),
    "POST /api/deploy-reset": (context) =>
      handleDeployReset(context, dependencies),
    "POST /api/delete-deployment": (context) =>
      handleDeleteDeployment(context, dependencies),
    "POST /api/delete-resource": (context) =>
      handleDeleteResource(context, dependencies),
    "GET /api/delete-run-status": (context) =>
      handleDeleteRunStatus(context, dependencies),
    "POST /api/abandon-deployment": (context) =>
      handleAbandonDeployment(context, dependencies)
  };
}
