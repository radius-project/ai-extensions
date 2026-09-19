import {
  deleteApplication,
  listApplications,
  listDeployments,
  observeDeployment
} from "@radius-project/core/github-radius/deployments";
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
import { DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE } from "../../infra.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";

export type { DeploymentRow } from "../services/deployment-resolver.js";

export interface DeployHandoffSummary {
  state: string;
  attempts: number;
  maxAttempts: number;
  pending: boolean;
}

export interface DeployListCacheEntry {
  at: number;
  payload: unknown;
}

export interface DeployListCache {
  get(repo: string): DeployListCacheEntry | undefined;
  set(repo: string, entry: DeployListCacheEntry): unknown;
  delete(repo: string): unknown;
}

export interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface WorkflowSyncResult {
  created: string[];
  failed: { path: string; branch: string }[];
}

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
  ghOrThrow(args: string[]): Promise<string>;
  resetDeploymentViewState(state: CanvasState, attemptId: unknown): void;
  deployListCache: DeployListCache;
  deployListTtlMs: number;
  activeDeploymentMutation(
    state: CanvasState
  ): DeploymentDispatchLease | undefined;
  reserveDeploymentMutation(
    state: CanvasState,
    reservation: { repo: string; environment: string; kind: "delete" }
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
  runGh(
    args: string[],
    timeout?: number,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<CommandResult>;
  readProcessEnv(): NodeJS.ProcessEnv;
  setTimer(callback: () => void, ms: number): TimerHandle;
  deployRequest: DeployRequestService;
  abandonment: DeploymentAbandonmentService;
  probeDeleteConflict(
    request: DeleteConflictRequest
  ): Promise<DeleteConflictProbe>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return Object.fromEntries(Object.entries(value));
}

function deployContextBranch(
  entry: DeploymentsInstanceEntry | undefined
): string {
  return (
    entry?.state.contextBranch ||
    entry?.state.plannedBranch ||
    entry?.state.graphBranch ||
    "main"
  );
}

export function observeCanvasDeployment(
  instanceId: string,
  dependencies: Pick<
    DeploymentsDependencies,
    | "readInstanceEntry"
    | "triggerDeployRepairHandoff"
    | "triggerDeployFailureNotice"
    | "deployHandoffStatus"
  >,
  since?: number
) {
  const entry = dependencies.readInstanceEntry(instanceId);
  // Canvas deliberately opts into repair; the shared observation API is pure.
  const repairing =
    dependencies.triggerDeployRepairHandoff(entry, instanceId) ||
    entry?.state.deployRepairing ||
    false;
  dependencies.triggerDeployFailureNotice(entry, instanceId);
  return {
    ...observeDeployment(entry?.state, since),
    repairing,
    handoff: dependencies.deployHandoffStatus(entry?.state || {})
  };
}

export function handleDeployStatus(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): void {
  const raw = context.url.searchParams.get("since");
  const since = raw === null ? undefined : parseInt(raw, 10);
  context.json(
    200,
    observeCanvasDeployment(context.instanceId, dependencies, since)
  );
}

export async function handleListApplications(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const repo = context.url.searchParams.get("repo") || "";
  const respond = (payload: unknown) =>
    context.json(200, payload, { "Cache-Control": "no-store" });
  if (!repo) {
    respond({ applications: [] });
    return;
  }
  try {
    const branch = deployContextBranch(
      dependencies.readInstanceEntry(context.instanceId)
    );
    respond({
      applications: await listApplications({ repo, branch }, dependencies)
    });
  } catch (error) {
    respond({
      applications: [{ name: repo.split("/").pop() || repo }],
      error: errorMessage(error)
    });
  }
}

export async function handleListDeployments(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const repo = context.url.searchParams.get("repo") || "";
  const respond = (payload: unknown) =>
    context.json(200, payload, { "Cache-Control": "no-store" });
  if (!repo) {
    respond({ deployments: [] });
    return;
  }
  const cached =
    context.url.searchParams.get("fresh") === "1" ?
      null
    : dependencies.deployListCache.get(repo);
  if (cached && Date.now() - cached.at < dependencies.deployListTtlMs) {
    respond(cached.payload);
    return;
  }
  try {
    const branch = deployContextBranch(
      dependencies.readInstanceEntry(context.instanceId)
    );
    const payload = {
      deployments: await listDeployments({ repo, branch }, dependencies)
    };
    dependencies.deployListCache.set(repo, { at: Date.now(), payload });
    respond(payload);
  } catch (error) {
    respond({ deployments: [], error: errorMessage(error) });
  }
}

export async function handleDeployReset(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const entry = dependencies.readInstanceEntry(context.instanceId);
  const body = await context.readTextBody();
  let data: Record<string, unknown>;
  try {
    data = body ? record(JSON.parse(body)) : {};
  } catch (error) {
    context.json(400, { error: errorMessage(error) });
    return;
  }
  if (entry) dependencies.resetDeploymentViewState(entry.state, data.attemptId);
  context.json(200, { ok: true });
}

export async function handleDeleteDeployment(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const body = await context.readTextBody();
  try {
    const data = record(JSON.parse(body || "{}"));
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const target = {
      repo: text(data.repo),
      environment: text(data.environment),
      application: text(data.application)
    };
    if (
      !target.repo ||
      !target.environment ||
      !target.application ||
      !dependencies.isValidRepoSlug(target.repo)
    ) {
      context.json(400, {
        error: "A valid repo, environment, and application are required."
      });
      return;
    }
    const entry = dependencies.readInstanceEntry(context.instanceId);
    if (!entry) {
      context.json(503, { error: "Canvas server state is unavailable." });
      return;
    }
    const presentation =
      dependencies.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
    const result = await deleteApplication(
      entry.state,
      target,
      data.force === true,
      {
        ...dependencies,
        workflowFiles: [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE],
        workflowScopeHelp: {
          refreshCommand: displayGhCommand(presentation, [
            "auth",
            "refresh",
            "-h",
            "github.com",
            "-s",
            "workflow"
          ]),
          installationNote: presentation.installationNote
        },
        now: Date.now,
        sleep: (ms) =>
          new Promise((resolve) => {
            dependencies.setTimer(resolve, ms);
          }),
        retainReservation: (release) => {
          dependencies
            .setTimer(release, dependencies.deployListTtlMs * 2)
            .unref?.();
        },
        invalidateDeployListCache: (repo) => {
          dependencies.deployListCache.delete(repo);
        }
      }
    );
    context.json(result.status, result.body);
  } catch (error) {
    context.json(400, { error: errorMessage(error) });
  }
}

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

export async function handleDeploy(
  context: CanvasRequestContext,
  dependencies: DeploymentsDependencies
): Promise<void> {
  const result = await dependencies.deployRequest.deploy({
    instanceId: context.instanceId,
    body: await context.readTextBody()
  });
  context.json(result.status, result.body);
}

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
      generation: state?.deployGeneration || 0,
      runId: runId === null || runId === undefined ? "" : String(runId),
      status: state?.deployStatus || "pending",
      application: state?.deployAppName || "",
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
