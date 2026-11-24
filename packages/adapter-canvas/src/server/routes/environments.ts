import { observeVerificationStatus } from "../services/verification-status.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type {
  EnvironmentActiveDeployment,
  EnvironmentsDependencies
} from "./environments-types.js";
import { verificationBypass } from "../services/verification-bypass.js";

// Setup uses direct services rather than this HTTP family. The five
// routes here are the environment picker's read surface (`list-environments`,
// `verify-status`), the deploy page's parameter probe (`app-params`), the
// verify-failure override (`bypass-verification`), and the one destructive
// route (`delete-environment`). They are migrated together because they are the
// environment lifecycle the picker drives; nothing is moved out of `server.ts`,
// every helper is injected, so this module spawns no process, owns no cache, and
// reads no module-level mutable state.
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
import {
  inspectEnvironments,
  type EnvironmentInspectionRead
} from "@radius-project/adapter-shared";

const BROWSER_DIAGNOSTIC_MAX_LENGTH = 2000;

function browserVisibleDiagnostic(
  value: string,
  dependencies: EnvironmentsDependencies
): string {
  const diagnostic = dependencies.redactDiagnostic(value).trim();
  return diagnostic.length > BROWSER_DIAGNOSTIC_MAX_LENGTH ?
      `${diagnostic.slice(0, BROWSER_DIAGNOSTIC_MAX_LENGTH)}...`
    : diagnostic;
}
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
    const existingDelete = dependencies.activeDeleteOperation(repo, envName);
    if (existingDelete) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(409);
      response.end(
        JSON.stringify({
          error: `Deletion is already running for environment "${envName}".`,
          code: "delete-operation-in-progress",
          operationId: existingDelete.operationId,
          operation: dependencies.toClientView(existingDelete)
        })
      );
      return;
    }
    // Guard: an environment must not be deleted while an application is still
    // deployed to it (its cloud resources would be orphaned). Require the app
    // deployment to be torn down first and point the client at the app-deletion
    // flow.
    let active: EnvironmentActiveDeployment | null = null;
    try {
      active = await dependencies.resolveEnvDeployment(repo, envName, "");
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
      if (active.identity?.state !== "known") {
        response.setHeader("Content-Type", "application/json");
        response.writeHead(active.identity?.readFailed ? 503 : 409);
        response.end(
          JSON.stringify({
            error:
              active.identity?.reason ||
              "A deployment exists but its application identity is unavailable. The environment was not deleted.",
            code: "app-identity-unavailable",
            environment: envName
          })
        );
        return;
      }
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
    // federated credential, deletes the GitHub environment and its dedicated
    // GHCR state package, and records that the shared app registration remains.
    // The work runs
    // in the background under the same OperationRecord + progress-panel model as
    // environment creation, so the route only starts it and returns 202.
    let target: {
      provider: string;
      clientId: string;
      tenantId: string;
      repoId: number;
      roleArn?: string;
      trustSubjects?: string[] | null;
      region?: string;
      cluster?: string;
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
    // Radius deletes Azure-backed environments, and AWS-backed ones while the
    // developer-only AWS switch is on. Anything else has no delete workflow, so
    // refuse up front, leaving the environment in place, rather than start an
    // operation that is guaranteed to fail closed deep in the runner.
    if (
      provider !== "azure" &&
      !(provider === "aws" && dependencies.awsEnabled)
    ) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end(
        JSON.stringify({
          error:
            provider === "aws" ?
              `Deleting AWS environments isn't supported yet. "${envName}" was not deleted. Remove its resources in AWS and delete the GitHub environment manually.`
            : `Deleting this environment isn't supported: Radius can only delete ${dependencies.awsEnabled ? "Azure- and AWS-backed" : "Azure-backed"} environments today. "${envName}" was not deleted.`,
          code: "provider-unsupported"
        })
      );
      return;
    }
    const clientId = target.clientId;
    // An environment is only classified Azure when its canonical
    // AZURE_CLIENT_ID variable is present, and AWS when AWS_ROLE_ARN is, so the
    // identity each cleanup stage targets was readable.
    const includeAzureCleanup = provider === "azure";
    const includeAwsCleanup = provider === "aws";
    const op = dependencies.createOperation({
      kind: "delete",
      provider,
      repo,
      environment: envName,
      stages: dependencies.buildDeleteStages({
        includeAzureCleanup,
        includeAwsCleanup
      })
    });
    op.request = {
      repo,
      repoId: target.repoId,
      environment: envName,
      provider,
      clientId,
      tenantId: target.tenantId,
      ...(includeAwsCleanup ?
        {
          roleArn: target.roleArn || "",
          trustSubjects: target.trustSubjects,
          region: target.region || "",
          cluster: target.cluster || ""
        }
      : {})
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

export async function handleBypassVerification(
  context: CanvasRequestContext,
  dependencies: EnvironmentsDependencies
): Promise<void> {
  const scope = dependencies.readInstanceEntry(context.instanceId)?.observation;
  const json = (status: number, payload: unknown): void => {
    context.response.setHeader("Content-Type", "application/json");
    context.response.writeHead(status);
    context.response.end(JSON.stringify(payload));
  };
  const body = await context.readTextBody();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body || "{}");
  } catch (error) {
    json(400, { error: dependencies.errorMessage(error) });
    return;
  }
  const outcome = await verificationBypass(
    {
      data,
      scope,
      isCurrent: () =>
        dependencies.readInstanceEntry(context.instanceId)?.observation ===
        scope
    },
    dependencies
  );
  json(outcome.status, outcome.body);
}

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

  const read = (args: string[]): Promise<EnvironmentInspectionRead> =>
    new Promise((resolve) => {
      dependencies.cliExec(
        "gh",
        args,
        { timeout: 12000 },
        (err, stdout, stderr) => {
          resolve(
            err ?
              { ok: false, error: (stderr || err.message || "").trim() }
            : { ok: true, stdout: (stdout || "").trim() }
          );
        }
      );
    });

  try {
    const listing = await inspectEnvironments(repo, read);
    if (listing.kind === "unavailable") {
      respond({
        environments: [],
        error:
          browserVisibleDiagnostic(listing.error, dependencies) ||
          "Failed to list environments."
      });
      return;
    }
    const managedEnvironments = listing.environments;
    const payload = { environments: managedEnvironments };
    respond(payload);
    cacheListing(payload);
    if (!listing.hadRows) return;
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
    respond({
      environments: [],
      error:
        browserVisibleDiagnostic(dependencies.errorMessage(e), dependencies) ||
        "Failed to list environments."
    });
  }
}

// Polls the credential-verification workflow run for a repo/operation and maps
// its outcome to a UI state. When an operation id is supplied it must match the
// tracked operation's repo/environment and carry a complete dispatch identity,
// or the poll is rejected as expired. Responses use `Cache-Control: no-store`;
// the state field carries the verdict, except physical stop returns 503.
export async function handleVerifyStatus(
  context: CanvasRequestContext,
  dependencies: EnvironmentsDependencies
): Promise<void> {
  const outcome = await observeVerificationStatus(
    {
      repo: context.url.searchParams.get("repo") || "",
      operationId: context.url.searchParams.get("operationId") || "",
      environment: context.url.searchParams.get("environment") || "",
      compatibility: () => {
        const entry = dependencies.readInstanceEntry(context.instanceId);
        return {
          observation: entry?.observation,
          runId: entry?.state?.verifyRunId
        };
      }
    },
    dependencies
  );
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  context.response.writeHead(outcome.status);
  context.response.end(JSON.stringify(outcome.body));
}

export function createEnvironmentsRoutes(
  dependencies: EnvironmentsDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/app-params": (context) => handleAppParams(context, dependencies),
    "POST /api/delete-environment": (context) =>
      handleDeleteEnvironment(context, dependencies),
    "POST /api/bypass-verification": (context) =>
      handleBypassVerification(context, dependencies),
    "GET /api/list-environments": (context) =>
      handleListEnvironments(context, dependencies),
    "GET /api/verify-status": (context) =>
      handleVerifyStatus(context, dependencies)
  };
}
