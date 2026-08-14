import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

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
export interface DeploymentRow {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
}

export interface DeployListCacheEntry {
  at: number;
  payload: unknown;
}

// Only the two operations this family performs on the deploy listing cache.
// Invalidation stays in `server.ts`, which deletes from the same map when a
// deploy or delete is dispatched, so the cache is injected rather than owned
// here.
export interface DeployListCache {
  get(repo: string): DeployListCacheEntry | undefined;
  set(repo: string, entry: DeployListCacheEntry): unknown;
}

// The instance entry, not the request context's `state` snapshot: the repair
// handoff is driven from the entry itself and has to be able to tell a missing
// instance from an instance with empty state, which the snapshot's `{}`
// substitution cannot express.
export interface DeploymentsInstanceEntry {
  state: CanvasState;
}

export interface DeploymentsReadsDependencies {
  readInstanceEntry(instanceId: string): DeploymentsInstanceEntry | undefined;
  triggerDeployRepairHandoff(
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
  dependencies: DeploymentsReadsDependencies
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
  dependencies: DeploymentsReadsDependencies
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
  dependencies: DeploymentsReadsDependencies
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
  // bypasses; the cache is not written on the bypass path either, so a poller
  // never re-primes it.
  const freshDeploys = context.url.searchParams.get("fresh") === "1";
  // The `null` is only a "no cached entry" marker for the guard below, so
  // `undefined` would be an equivalent substitute.
  const cachedDeploys =
    freshDeploys ? null : dependencies.deployListCache.get(repo);
  // The `<` boundary is exact-millisecond and has no behavioral significance;
  // distinguishing it from `<=` would need a clock seam this family does not
  // otherwise require, so that mutant is left alive deliberately.
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
  dependencies: DeploymentsReadsDependencies
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

export function createDeploymentsReadsRoutes(
  dependencies: DeploymentsReadsDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/deploy-status": (context) =>
      handleDeployStatus(context, dependencies),
    "GET /api/list-applications": (context) =>
      handleListApplications(context, dependencies),
    "GET /api/list-deployments": (context) =>
      handleListDeployments(context, dependencies),
    "POST /api/deploy-reset": (context) =>
      handleDeployReset(context, dependencies)
  };
}
