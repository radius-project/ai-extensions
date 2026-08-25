import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type {
  EnvironmentActiveDeployment,
  EnvironmentsDependencies,
  EnvironmentVerifyRun
} from "./environments-types.js";

// The `environments` family, minus `POST /api/create-environment`, which is
// large enough to live in its own `create-environment*.ts` seams. The four routes
// here are the environment picker's read surface (`list-environments`,
// `verify-status`), the deploy page's parameter probe (`app-params`), and the
// one destructive route (`delete-environment`). They are migrated together
// because they are the environment lifecycle the picker drives; nothing is
// moved out of `server.ts`, every helper is injected, so this module spawns no
// process, owns no cache, and reads no module-level mutable state.
//
// The dependency seam and supporting types live in `environments-types.ts`;
// they are re-exported here so existing importers keep a single entry point.
export type {
  EnvironmentsInstanceEntry,
  EnvironmentVerifyRun,
  EnvironmentActiveDeployment,
  EnvironmentRunStep,
  EnvironmentRunDetail,
  EnvironmentBicepParam,
  EnvironmentsCliExec,
  EnvironmentsDependencies,
  DeleteOperationRecord,
  DeleteStartResult
} from "./environments-types.js";
import { classifyProvider } from "../../provider-classification.js";
// Parameters for the app.bicep the deploy will run against. Resolves the branch
// the same way the deploy route does (caller's selection, else the repo default)
// and locates `.radius/app.bicep` then `app.bicep`. Every failure degrades to a
// 200 with an empty param list rather than an error status — pre-existing and
// preserved: an unresolvable repo is a normal state for this probe.
export async function handleAppParams(
  context: CanvasRequestContext,
  dependencies: EnvironmentsDependencies
): Promise<void> {
  const { response } = context;
  // `JSON.parse(body)` with no empty-object fallback: a missing body throws into
  // the catch below, which is the legacy behavior. Reading the body manually
  // rather than via `readJsonBody` preserves that on malformed input.
  const body = await context.readTextBody();
  try {
    const data = JSON.parse(body);
    // `||` not `??`: an empty-string repo must fall through to the no-repo
    // guard, not be treated as a real selection.
    const repo = data.repo || "";
    if (!repo) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end(
        JSON.stringify({ error: "No repository specified.", params: [] })
      );
      return;
    }
    let branch = data.branch || "";
    if (!branch) {
      const def = await dependencies
        .runCommand("gh", [
          "repo",
          "view",
          repo,
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name"
        ])
        .catch(() => "");
      branch = (def || "").trim() || "main";
    }
    let source = await dependencies.fetchFileFromRepo(
      repo,
      ".radius/app.bicep",
      branch
    );
    if (!source)
      source = await dependencies.fetchFileFromRepo(repo, "app.bicep", branch);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({
        branch,
        found: !!source,
        params: source ? dependencies.appParams(source) : []
      })
    );
  } catch (e) {
    // The catch answers 200 (not an error status) with an empty param list.
    // Pre-existing success fallback, preserved verbatim.
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({ error: dependencies.errorMessage(e), params: [] })
    );
  }
}

// Deletes a GitHub environment, failing closed at every rung: bad input → 400;
// an unconfirmable active-app check → 503 (never delete on an unknown); a
// still-deployed app → 409 pointing at the app-deletion flow; a delete-command
// failure → 500. Only a clean pass reaches the cache invalidation and 200.
export async function handleDeleteEnvironment(
  context: CanvasRequestContext,
  dependencies: EnvironmentsDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    // `body || "{}"`: an empty body parses to `{}` here rather than throwing,
    // unlike `app-params`. Preserved verbatim.
    const data = JSON.parse(body || "{}");
    const repo = (data.repo || "").trim();
    const envName = (data.environment || "").trim();
    if (!repo || !envName) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end(
        JSON.stringify({ error: "repo and environment are required." })
      );
      return;
    }
    // Guard: an environment must not be deleted while an application is still
    // deployed to it (its cloud resources would be orphaned). Require the app
    // deployment to be torn down first and point the client at the app-deletion
    // flow.
    let active: EnvironmentActiveDeployment | null = null;
    try {
      // Resolve the real app name (from app.bicep) so the guard's message,
      // redirect, and delete target the app declared in the bicep rather than
      // the repo basename.
      const delEntry = dependencies.readInstanceEntry(context.instanceId);
      const delBranch =
        delEntry?.state?.contextBranch ||
        delEntry?.state?.plannedBranch ||
        delEntry?.state?.graphBranch ||
        "main";
      const delAppName = await dependencies.resolveRepoAppName(repo, delBranch);
      active = await dependencies.resolveEnvDeployment(
        repo,
        envName,
        delAppName
      );
    } catch (e) {
      // Fail closed: if we can't confirm whether an app is still deployed (e.g.
      // GitHub is unavailable), do NOT delete — that could orphan the
      // application's cloud resources.
      dependencies.logError(
        `[radius delete-environment] active-app check failed for ${repo}/${envName}: ${dependencies.errorMessage(
          e
        )}`
      );
      response.setHeader("Content-Type", "application/json");
      response.writeHead(503);
      response.end(
        JSON.stringify({
          error: `Could not verify whether an application is still deployed to "${envName}" (GitHub API error: ${dependencies.errorMessage(
            e
          )}). The environment was not deleted — please try again.`
        })
      );
      return;
    }
    if (active) {
      const deleting = active.status === "deleting";
      const deleteFailed = active.status === "delete-failed";
      response.setHeader("Content-Type", "application/json");
      response.writeHead(409);
      response.end(
        JSON.stringify({
          error:
            deleting ?
              `Application "${active.app}" is still being deleted from environment "${envName}". Wait for that to finish before deleting the environment.`
            : deleteFailed ?
              `The previous teardown of application "${active.app}" from environment "${envName}" failed. Retry Delete or stop tracking the deployment before deleting the environment.`
            : `Application "${active.app}" is still deployed to environment "${envName}". Delete the application deployment first, then delete the environment.`,
          code: "app-deployed",
          app: active.app,
          environment: envName,
          redirect:
            deleteFailed ?
              `/?page=deployed&application=${encodeURIComponent(
                active.app
              )}&environment=${encodeURIComponent(envName)}`
            : `/?page=deploying&app=${encodeURIComponent(
                active.app
              )}&env=${encodeURIComponent(envName)}`
        })
      );
      return;
    }
    // Deleting an environment is now an async operation (issue #303): it tears
    // down the Radius environment on the cluster, removes the per-environment
    // federated credential, deletes the GitHub environment, and — when the app
    // registration is left unused — prompts before deleting it. The work runs
    // in the background under the same OperationRecord + progress-panel model as
    // environment creation, so the route only starts it and returns 202.
    let target: {
      provider: string;
      clientId: string;
      tenantId: string;
      repoId: number;
    };
    try {
      target = await dependencies.discoverEnvironmentTarget(repo, envName);
    } catch (e) {
      // Fail closed: without the provider/identity we cannot clean up the cloud
      // artifacts, so refuse rather than delete only the GitHub environment and
      // silently orphan the federated credential.
      response.setHeader("Content-Type", "application/json");
      response.writeHead(503);
      response.end(
        JSON.stringify({
          error: `Could not read the configuration for environment "${envName}" (${dependencies.errorMessage(
            e
          )}). The environment was not deleted — please try again.`
        })
      );
      return;
    }
    const provider = target.provider;
    // Radius only supports deleting Azure-backed environments today. Stage 1's
    // Radius-environment teardown dispatches the Azure-only delete workflow, so
    // a non-Azure (e.g. AWS) environment cannot be torn down here and would fail
    // deep in the runner with a generic error. Refuse up front with a clear,
    // provider-specific message so the user knows the environment was left in
    // place and can remove it manually, rather than starting an operation that
    // is guaranteed to fail closed.
    if (provider !== "azure") {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end(
        JSON.stringify({
          error:
            provider === "aws" ?
              `Deleting AWS environments isn't supported yet. "${envName}" was not deleted. Remove its resources in AWS and delete the GitHub environment manually.`
            : `Deleting this environment isn't supported: Radius can only delete Azure-backed environments today. "${envName}" was not deleted.`,
          code: "provider-unsupported"
        })
      );
      return;
    }
    const clientId = target.clientId;
    // Provider is guaranteed "azure" here (every other provider returned above),
    // and an environment is only classified Azure when its canonical
    // AZURE_CLIENT_ID variable is present, so the client id was readable and the
    // Azure credential/app-registration cleanup stages always run. The flag is
    // kept rather than inlined to `true` so the stage set stays explicit at the
    // one place it is decided.
    const includeAzureCleanup = provider === "azure";
    const op = dependencies.createOperation({
      kind: "delete",
      provider,
      repo,
      environment: envName,
      stages: dependencies.buildDeleteStages({ includeAzureCleanup })
    });
    op.request = {
      repo,
      repoId: target.repoId,
      environment: envName,
      provider,
      clientId,
      tenantId: target.tenantId
    };
    const started = dependencies.startOperation(op);
    if (!started.ok) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(409);
      response.end(
        JSON.stringify({
          error: `An operation is already running for ${repo}.`,
          code: "operation-in-progress",
          operationId: started.conflict.operationId
        })
      );
      return;
    }
    try {
      await dependencies.persistOperations();
    } catch (e) {
      dependencies.finish(op, "failed", {
        failure: {
          code: "operation-registration-persist-failed",
          stage: op.currentStage,
          stepSeq: null,
          message: "Radius could not durably register the delete operation.",
          classification: "unknown",
          evidence: dependencies.errorMessage(e)
        }
      });
      response.setHeader("Content-Type", "application/json");
      response.writeHead(500);
      response.end(
        JSON.stringify({
          error:
            "Radius could not durably register the delete operation. Nothing was deleted.",
          code: "operation-registration-persist-failed"
        })
      );
      return;
    }
    const statusUrl = `/api/operations/${encodeURIComponent(op.operationId)}`;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Location", statusUrl);
    response.writeHead(202);
    response.end(
      JSON.stringify({
        operationId: op.operationId,
        statusUrl,
        operation: dependencies.toClientView(op)
      })
    );
    const scheduled = dependencies.scheduleEnvironmentOperation(
      context.instanceId,
      op
    );
    if (!scheduled) {
      dependencies.finish(op, "failed", {
        failure: {
          code: "operation-scheduling-failed",
          stage: op.currentStage,
          stepSeq: null,
          message:
            "Radius accepted the delete operation but could not start any work for it.",
          classification: "unknown",
          evidence: `No server-owned task runner was available for instance ${context.instanceId}.`
        }
      });
      await dependencies.persistOperations().catch(() => {});
    }
  } catch (e) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(400);
    response.end(JSON.stringify({ error: dependencies.errorMessage(e) }));
  }
}

// The GitHub environment variables that hold what the creation form asks for,
// mapped to the form's own field names. Everything else the environment stores
// is either derived from the credential profile or internal Radius state.
const AZURE_CONFIG_VARIABLES = {
  resourceGroup: "AZURE_RESOURCE_GROUP",
  cluster: "AZURE_AKS_CLUSTER_NAME",
  namespace: "RADIUS_NAMESPACE"
} as const;
const AWS_CONFIG_VARIABLES = {
  cluster: "AWS_EKS_CLUSTER_NAME",
  namespace: "RADIUS_NAMESPACE",
  vpcId: "RADIUS_VPC_ID",
  subnetIds: "RADIUS_SUBNET_IDS"
} as const;

// Overlays a synthetic "deleting" status onto the environment named by an
// in-progress delete operation, leaving every other environment untouched.
// Applied at response time (never cached) so the marker appears the instant a
// deletion starts and clears the instant it reaches a terminal state. Returns a
// shallow copy so the cached listing keeps the environments' real statuses for
// when the deletion finishes or fails. `deleting` is not a status the
// verify-credentials lookup can ever produce, so it never collides with a real
// value.
export function overlayDeletingStatus(
  payload: unknown,
  deletingEnvironment: string
): unknown {
  if (
    deletingEnvironment === "" ||
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { environments?: unknown }).environments)
  ) {
    return payload;
  }
  const source = payload as {
    environments: unknown[];
    [key: string]: unknown;
  };
  return {
    ...source,
    environments: source.environments.map((environment) => {
      if (
        environment !== null &&
        typeof environment === "object" &&
        (environment as { name?: unknown }).name === deletingEnvironment
      ) {
        return {
          ...(environment as Record<string, unknown>),
          status: "deleting"
        };
      }
      return environment;
    })
  };
}

// The environment picker's listing. Repo-scoped, short-TTL cached, and filtered
// to environments this extension created (tagged RADIUS_MANAGED). Status comes
// from the verify-credentials workflow only, not app deployments. Every response
// carries `Content-Type` then `Cache-Control: no-store` (header order is
// observable), and only successful listings are cached so a failure can recover
// on retry. An in-progress delete is overlaid live (never cached) so the UI
// fails closed on the environment being torn down.
export async function handleListEnvironments(
  context: CanvasRequestContext,
  dependencies: EnvironmentsDependencies
): Promise<void> {
  const { response, url } = context;
  const repo = url.searchParams.get("repo") || "";
  const deletingEnvironment =
    repo ? dependencies.activeDeleteEnvironment(repo) : "";
  const respond = (payload: unknown): void => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200);
    response.end(
      JSON.stringify(overlayDeletingStatus(payload, deletingEnvironment))
    );
  };
  if (!repo) {
    respond({ environments: [] });
    return;
  }

  const cached = dependencies.envListCacheGet(repo);
  if (cached && dependencies.now() - cached.at < dependencies.envListTtlMs) {
    respond(cached.payload);
    return;
  }

  // The generation this listing is being assembled against. Anything that
  // removes an environment — the delete route, or a rollback or exit that
  // deletes the one this setup created — invalidates the repo's listing, and
  // that invalidation must survive a listing that started before it. Caching
  // such a payload would put the removed environment back in front of the
  // customer for a whole TTL, which is exactly what a completed rollback
  // promised it would not do.
  const generation = dependencies.envListCacheGeneration(repo);
  const cacheListing = (payload: unknown): void => {
    if (dependencies.envListCacheGeneration(repo) !== generation) return;
    dependencies.envListCacheSet(repo, { at: dependencies.now(), payload });
  };

  const gh = (args: string[], timeout = 12000): Promise<string> =>
    new Promise<string>((resolve) => {
      dependencies.cliExec("gh", args, { timeout }, (err, stdout) => {
        if (err) {
          resolve("");
          return;
        }
        resolve((stdout || "").trim());
      });
    });
  const ghResult = (
    args: string[],
    timeout = 12000
  ): Promise<{ ok: boolean; stdout: string }> =>
    new Promise((resolve) => {
      dependencies.cliExec("gh", args, { timeout }, (err, stdout) => {
        resolve({
          ok: !err,
          stdout: err ? "" : (stdout || "").trim()
        });
      });
    });

  try {
    // 1) List environment names + ids for the repo. Kick off the
    //    verify-credentials workflow-runs fetch in parallel — it's independent
    //    of the names, so there's no reason to wait.
    const verifyRunsPromise = ghResult([
      "api",
      `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
      "--jq",
      '.workflow_runs[] | (.id|tostring) + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
    ]);
    const namesRes = await new Promise<{ error?: string; stdout?: string }>(
      (resolve) => {
        dependencies.cliExec(
          "gh",
          [
            "api",
            "--paginate",
            `/repos/${repo}/environments?per_page=100`,
            "--jq",
            '.environments[] | (.id|tostring) + "\\t" + .name'
          ],
          { timeout: 12000 },
          (err, stdout, stderr) => {
            if (err) {
              resolve({
                error:
                  (stderr || err.message || "").trim() ||
                  "Failed to list environments."
              });
              return;
            }
            resolve({ stdout: (stdout || "").trim() });
          }
        );
      }
    );
    // Surface a genuine API/auth/permission failure instead of silently
    // reporting "no environments" (which hides real problems). Failures are not
    // cached so a retry can recover.
    if (namesRes.error) {
      respond({ environments: [], error: namesRes.error });
      return;
    }
    const namesRaw = namesRes.stdout || "";
    const rows =
      namesRaw ?
        namesRaw
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const tab = l.indexOf("\t");
            return tab === -1 ?
                { id: "", name: l }
              : { id: l.slice(0, tab), name: l.slice(tab + 1) };
          })
      : [];
    if (rows.length === 0) {
      const payload = { environments: [] };
      respond(payload);
      cacheListing(payload);
      return;
    }

    // Index the pre-fetched verify runs by run id. The environment status is
    // derived from these (not from app deployments): an environment is
    // "Success" only once it exists AND its verify-credentials workflow passed.
    const verifyRunsResult = await verifyRunsPromise;
    const verifyRunsRaw = verifyRunsResult.stdout;
    const verifyRuns = new Map<string, EnvironmentVerifyRun>();
    if (verifyRunsRaw) {
      for (const line of verifyRunsRaw.split("\n").filter(Boolean)) {
        const [rid, rstatus, rconclusion] = line.split("\t");
        verifyRuns.set(rid, { status: rstatus, conclusion: rconclusion });
      }
    }
    // Map a verify run's outcome to an environment status.
    const verifyStatusOf = (run?: EnvironmentVerifyRun): string | null => {
      if (!run) return null;
      if (run.status !== "completed") return "pending"; // queued / in_progress
      if (run.conclusion === "success") return "success";
      return "failed"; // failure / cancelled / timed_out / etc.
    };

    // 2) For each environment, derive provider (from stored variables) and a
    //    status from the verify-credentials workflow. Both the verify and deploy
    //    workflows create deployments to the same environment, so we walk this
    //    env's deployments newest-first until we find one created by a
    //    verify-credentials run.
    const environments = await Promise.all(
      rows.map(async ({ id, name }) => {
        // The variables (provider) and deployments (status) lookups are
        // independent, so fire them together.
        const [varsRaw, depIdsRaw] = await Promise.all([
          gh([
            "api",
            `/repos/${repo}/environments/${encodeURIComponent(
              name
            )}/variables?per_page=100`,
            "--jq",
            '.variables[] | .name + "\\t" + (.value // "")'
          ]),
          gh([
            "api",
            `/repos/${repo}/deployments?environment=${encodeURIComponent(
              name
            )}&per_page=10`,
            "--jq",
            ".[].id"
          ])
        ]);
        // Parse the "name<TAB>value" variable lines into a map. Only surface
        // environments created by this extension (tagged with a RADIUS_MANAGED
        // variable at creation time); anything without it was created outside
        // Radius and is filtered out below.
        const vars: Record<string, string> = {};
        for (const line of varsRaw ? varsRaw.split("\n").filter(Boolean) : []) {
          const tab = line.indexOf("\t");
          if (tab === -1) {
            vars[line] = "";
            continue;
          }
          vars[line.slice(0, tab)] = line.slice(tab + 1);
        }
        if (!("RADIUS_MANAGED" in vars)) return null;

        let provider: string = classifyProvider(vars);

        const credentialProfile = vars.RADIUS_CREDENTIAL_PROFILE || "";

        // A successful verification lookup plus existing deployments proves
        // this is an established environment even when the verification
        // deployment itself has aged out of the bounded history. Lookup
        // failures and environments with no deployments fail closed as pending.
        const depIds = depIdsRaw ? depIdsRaw.split("\n").filter(Boolean) : [];
        let status =
          verifyRunsResult.ok && depIds.length > 0 ? "unknown" : "pending";
        if (verifyRunsResult.ok && verifyRuns.size > 0) {
          // Resolve every deployment's originating-run URL in parallel
          // (deployments come back newest-first), then pick the newest one
          // created by a verify-credentials run. Doing this serially was the
          // main source of latency for this endpoint.
          const logResults = await Promise.all(
            depIds.map((depId) =>
              ghResult([
                "api",
                `/repos/${repo}/deployments/${depId}/statuses?per_page=1`,
                "--jq",
                '.[0].log_url // .[0].target_url // ""'
              ])
            )
          );
          if (logResults.some((result) => !result.ok)) {
            status = "pending";
          } else {
            for (const { stdout: logUrl } of logResults) {
              const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
              if (!m) continue;
              const run = verifyRuns.get(m[1]);
              if (run) {
                status = verifyStatusOf(run) || status;
                break;
              }
            }
          }
        }

        const webUrl =
          id ?
            `https://github.com/${repo}/settings/environments/${id}/edit`
          : `https://github.com/${repo}/settings/environments`;
        // The environment's own configuration, so Edit can reopen the creation
        // form on what this environment actually holds instead of sending the
        // user to GitHub's settings page. Only the fields the form asks for:
        // identity and subscription come from the credential profile, and no
        // secret is stored as a variable in the first place.
        const config: Record<string, string> = {};
        for (const [key, variable] of Object.entries(
          provider === "aws" ? AWS_CONFIG_VARIABLES : AZURE_CONFIG_VARIABLES
        )) {
          const value = vars[variable];
          if (value) config[key] = value;
        }
        return { name, provider, status, webUrl, credentialProfile, config };
      })
    );

    const managedEnvironments = environments.filter(
      (environment): environment is NonNullable<typeof environment> =>
        environment !== null
    );
    respond({ environments: managedEnvironments });
    cacheListing({ environments: managedEnvironments });
    // Background self-heal: update any committed workflow files that have
    // drifted from the upstream Radius templates. Also target the session
    // worktree branch (when it's this repo's) so a worktree-consistent deploy
    // runs the up-to-date workflows, not just the default branch.
    // Fire-and-forget so it never blocks.
    const syncEntry = dependencies.readInstanceEntry(context.instanceId);
    const workingBranch =
      (
        syncEntry?.state?.workspaceBranch &&
        dependencies.repoMatchesWorkspace(syncEntry.state, repo)
      ) ?
        syncEntry.state.workspaceBranch
      : "";
    dependencies.kickoffWorkflowSync(repo, managedEnvironments, workingBranch);
  } catch (e) {
    respond({ environments: [], error: dependencies.errorMessage(e) });
  }
}

// Polls the credential-verification workflow run for a repo/operation and maps
// its outcome to a UI state. When an operation id is supplied it must match the
// tracked operation's repo/environment and carry a complete dispatch identity,
// or the poll is rejected as expired. Every response is 200 with
// `Cache-Control: no-store`; the state field carries the verdict.
export function isAzureRbacVerificationFailure(
  failedSteps: readonly { name?: string }[],
  log: string,
  noSubscriptionsHelp: string
): boolean {
  if (noSubscriptionsHelp !== "") return true;
  const failedAtAzureAccess = failedSteps.some((step) =>
    /verify.*(?:aks|azure).*access/i.test(String(step.name))
  );
  if (!failedAtAzureAccess) return false;
  return /(?:AuthorizationFailed|\bForbidden\b|does not have authorization|not authorized|insufficient privileges|role assignment|cannot (?:get|list|create|update|patch|delete) resource)/i.test(
    log
  );
}

export async function handleVerifyStatus(
  context: CanvasRequestContext,
  dependencies: EnvironmentsDependencies
): Promise<void> {
  const { response, url } = context;
  const repo = url.searchParams.get("repo") || "";
  const operationId = url.searchParams.get("operationId") || "";
  const respond = (payload: unknown): void => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200);
    response.end(JSON.stringify(payload));
  };
  if (!repo) {
    respond({ state: "unknown", error: "No repository specified." });
    return;
  }

  try {
    const entry = dependencies.readInstanceEntry(context.instanceId);
    const verifyOp: any =
      operationId ? dependencies.getOperation(operationId) : null;
    if (
      operationId &&
      (!verifyOp ||
        verifyOp.repo !== repo ||
        verifyOp.environment !==
          (url.searchParams.get("environment") || verifyOp.environment))
    ) {
      respond({
        state: "expired",
        terminal: true,
        error: "The verification operation does not match this request."
      });
      return;
    }
    if (verifyOp && !dependencies.hasCompleteVerificationIdentity(verifyOp)) {
      respond({
        state: "expired",
        terminal: true,
        error: "The verification operation has incomplete dispatch identity."
      });
      return;
    }
    const selectedExecutor =
      operationId ?
        dependencies.getSelectedGitHubExecutor(operationId) || undefined
      : undefined;
    const pinnedLogin =
      typeof verifyOp?.context?.githubLogin === "string" ?
        verifyOp.context.githubLogin.trim()
      : "";
    if (operationId && pinnedLogin && !selectedExecutor) {
      respond({
        state: "pending",
        runId: verifyOp?.verification?.runId || null
      });
      return;
    }
    const runId: number | string | null =
      verifyOp?.verification?.runId || entry?.state?.verifyRunId || null;
    if (!runId) {
      // GitHub's run-list response has no operation-specific dispatch marker.
      // Baseline ID and time can narrow candidates but cannot prove identity, so
      // monitoring must wait for a run ID established by a stronger contract.
      respond({ state: "pending", runId: null });
      return;
    }

    const detail =
      selectedExecutor ?
        await dependencies.getRunDetail(repo, runId, selectedExecutor)
      : await dependencies.getRunDetail(repo, runId);
    const runUrl = "https://github.com/" + repo + "/actions/runs/" + runId;
    if (!detail) {
      respond({ state: "pending", runId, runUrl });
      return;
    }

    if (detail.status !== "completed") {
      // Name what the run is doing right now instead of leaving the caller with
      // nothing but elapsed time. getRunDetail already returns per-step status,
      // so this costs no extra API surface. Its jobs sub-resource 503s
      // intermittently and the fallback deliberately returns no steps, so the
      // activity line has to degrade silently rather than announce its absence.
      const active = (detail.steps || []).find(
        (s) => s.status === "in_progress"
      );
      respond({
        state: "in_progress",
        runId,
        runUrl,
        activity: active ? active.name : null
      });
      return;
    }
    if (detail.conclusion === "success") {
      if (
        verifyOp &&
        verifyOp.currentStage === dependencies.stageVerify &&
        !dependencies.isTerminalState(verifyOp.state)
      ) {
        dependencies.addLegacyStep(
          verifyOp,
          "✅ Environment created. Deploy your application from the Environments list when ready."
        );
        dependencies.finishSucceeded(verifyOp);
        await dependencies.persistBestEffort({
          operation: verifyOp,
          persist: () => dependencies.persistOperations(),
          report: (diagnostic) =>
            dependencies.reportOperationDiagnostic(diagnostic)
        });
      }
      respond({ state: "success", runId, runUrl });
      return;
    }
    // Failed — surface the failing step + a few error lines.
    const failed = (detail.steps || []).filter(
      (s) =>
        s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped"
    );
    let errMsg =
      "Credential verification failed" +
      (detail.conclusion ? " (" + detail.conclusion + ")" : "") +
      ".";
    if (failed.length)
      errMsg += " Failed step: " + failed.map((s) => s.name).join(", ") + ".";
    const log =
      selectedExecutor ?
        await dependencies.fetchRunLog(repo, runId, selectedExecutor)
      : await dependencies.fetchRunLog(repo, runId);
    const lines = dependencies.extractErrorLines(log, 8);
    if (lines.length) errMsg += "\n" + lines.join("\n");
    const azureLoginLog = dependencies.extractGitHubActionsStepLog(
      log,
      "Azure Login (OIDC)"
    );
    // Distinct failure stages (OIDC enterprise-claim rejection vs. a successful
    // login with no visible subscription — issue #219), so at most one applies;
    // take the first match so the raw-error separator is never emitted twice.
    const oidcHelp = dependencies.explainOidcEnterpriseClaim(azureLoginLog);
    const noSubscriptionsHelp =
      oidcHelp === "" ? dependencies.explainNoSubscriptions(log) : "";
    const failureHelp = oidcHelp || noSubscriptionsHelp;
    if (failureHelp)
      errMsg = failureHelp + "\n\n\u2014 raw error \u2014\n" + errMsg;
    if (verifyOp && verifyOp.currentStage === dependencies.stageVerify) {
      const failedAtAzureAccess = isAzureRbacVerificationFailure(
        failed,
        log || "",
        noSubscriptionsHelp
      );
      // Everything before verification succeeded and still exists, so this is
      // partial rather than total failure. Only a positively identified Azure
      // access failure gets propagation copy; OIDC, workflow, and runner failures
      // retain the generic verification classification.
      dependencies.finish(verifyOp, "failed_partial", {
        failure: {
          code:
            failedAtAzureAccess ?
              "verify-run-rbac-failed"
            : "verify-run-failed",
          stage: dependencies.stageVerify,
          message:
            "Credential verification failed. " +
            (failed.length ?
              "Failed step: " + failed.map((st) => st.name).join(", ") + "."
            : ""),
          classification: "user-fixable",
          evidence: errMsg
        }
      });
      await dependencies.persistBestEffort({
        operation: verifyOp,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic)
      });
    }
    respond({ state: "failed", runId, runUrl, error: errMsg });
  } catch (e) {
    respond({ state: "unknown", error: dependencies.errorMessage(e) });
  }
}

export function createEnvironmentsRoutes(
  dependencies: EnvironmentsDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/app-params": (context) => handleAppParams(context, dependencies),
    "POST /api/delete-environment": (context) =>
      handleDeleteEnvironment(context, dependencies),
    "GET /api/list-environments": (context) =>
      handleListEnvironments(context, dependencies),
    "GET /api/verify-status": (context) =>
      handleVerifyStatus(context, dependencies)
  };
}
