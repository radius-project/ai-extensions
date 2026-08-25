import type { SelectedGhExecutor } from "../../gh.js";
import {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureError,
  type EnsuredGitHubEnvironment
} from "./github-environment.js";
import type { GitHubEnvironmentReadResult } from "./github-environment.js";
import { proveGitHubEnvironmentCreated } from "./github-environment-provenance.js";

export interface EnvironmentOperationRecord {
  operationId: string;
  repo: string;
  environment: string;
  provider: string;
  state?: string;
  endedAt?: unknown;
  currentStage?: string | null;
  context?: Record<string, unknown>;
  request?: unknown;
  resumeRequest?: unknown;
  setupArtifacts: {
    githubEnvironment: {
      state: string;
      origin?: string;
      repo: string | null;
      name: string | null;
    };
  };
}

export interface EnvironmentOperationRequest {
  needsAzureCredentials?: unknown;
  azure?: Record<string, unknown>;
  environment?: Record<string, unknown>;
}

export interface EnvironmentOperationWorkflowDependencies {
  preflightRepoAdmin(
    repo: string,
    executor: SelectedGhExecutor
  ): Promise<string>;
  preflightGhcrPackageWriteAccess(executor: SelectedGhExecutor): Promise<
    | { ok: true; credentials?: unknown }
    | {
        ok: false;
        status: number;
        error: string;
        code: string;
        remediation?: unknown;
      }
  >;
  readGitHubJson(
    apiPath: string,
    executor: SelectedGhExecutor
  ): Promise<GitHubEnvironmentReadResult>;
  setCanonicalEnvironment(
    operation: EnvironmentOperationRecord,
    environment: string
  ): void;
  recordGitHubEnvironment(
    operation: EnvironmentOperationRecord,
    patch: { state: string; origin: string; repo: string; name: string }
  ): void;
  promoteCreatedGitHubEnvironment(
    operation: EnvironmentOperationRecord,
    identity: { repo: string; name: string }
  ): boolean;
  addLegacyStep(operation: EnvironmentOperationRecord, text: string): void;
  persistEnvironmentResolution(
    operation: EnvironmentOperationRecord
  ): Promise<boolean>;
  finalizeEnvironmentResolutionFailure(
    operation: EnvironmentOperationRecord,
    input: {
      status: number;
      error: string;
      code: string;
      remediation?: RemediationReference | null;
    },
    executor: SelectedGhExecutor
  ): Promise<void>;
  getOperation(operationId: string): EnvironmentOperationRecord | undefined;
  postInternal(
    pathname: string,
    data: unknown
  ): Promise<Record<string, unknown> | null>;
  now(): number;
}

/**
 * The id and params a remediation can be rebuilt from.
 *
 * Only the reference travels. Rebuilding from the registry at the point of use
 * keeps the rule that a command is never transported as a string, so a record
 * that survived persistence cannot smuggle one in.
 */
export interface RemediationReference {
  id: string;
  params: Record<string, string>;
}

function remediationReference(value: unknown): RemediationReference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { id?: unknown; params?: unknown };
  if (typeof candidate.id !== "string" || candidate.id === "") return null;
  const params: Record<string, string> = {};
  if (candidate.params && typeof candidate.params === "object") {
    for (const [key, raw] of Object.entries(
      candidate.params as Record<string, unknown>
    )) {
      if (typeof raw === "string") params[key] = raw;
    }
  }
  return { id: candidate.id, params };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function requestFrom(
  operation: EnvironmentOperationRecord
): EnvironmentOperationRequest {
  return record(
    operation.request === undefined ?
      operation.resumeRequest
    : operation.request
  );
}

async function failResolution(
  operation: EnvironmentOperationRecord,
  executor: SelectedGhExecutor,
  dependencies: EnvironmentOperationWorkflowDependencies,
  error: unknown
): Promise<{ shouldMonitor: false }> {
  const ensureError =
    error instanceof GitHubEnvironmentEnsureError ? error : null;
  const failure = record(error);
  const message =
    ensureError?.message ||
    (typeof failure.message === "string" && failure.message) ||
    String(error);
  const code =
    ensureError?.code ||
    (typeof failure.code === "string" && failure.code) ||
    "github-environment-resolution-failed";
  const status = typeof failure.status === "number" ? failure.status : 400;
  // Preflights that know a fix hand one over. Read it structurally rather than
  // trusting the shape: `error` here is `unknown`, and most callers have none.
  const remediation = remediationReference(failure.remediation);
  if (ensureError?.createdCandidate) {
    dependencies.recordGitHubEnvironment(operation, {
      state: "created_candidate",
      origin: "unknown",
      repo: ensureError.createdCandidate.repo,
      name: ensureError.createdCandidate.name
    });
  }
  await dependencies.finalizeEnvironmentResolutionFailure(
    operation,
    {
      status,
      error: message,
      code,
      remediation
    },
    executor
  );
  return { shouldMonitor: false };
}

export async function runEnvironmentOperationWorkflow(
  operation: EnvironmentOperationRecord,
  executor: SelectedGhExecutor,
  dependencies: EnvironmentOperationWorkflowDependencies
): Promise<{ shouldMonitor: boolean }> {
  const accessMessage = await dependencies.preflightRepoAdmin(
    operation.repo,
    executor
  );
  if (accessMessage) {
    return failResolution(operation, executor, dependencies, {
      status: 403,
      message: accessMessage,
      code: "repo-admin-required"
    });
  }
  const packageAccess =
    await dependencies.preflightGhcrPackageWriteAccess(executor);
  if (!packageAccess.ok) {
    return failResolution(operation, executor, dependencies, {
      status: packageAccess.status,
      message: packageAccess.error,
      code: packageAccess.code,
      remediation: remediationReference(packageAccess.remediation)
    });
  }

  let ensured: EnsuredGitHubEnvironment;
  try {
    ensured = await ensureGitHubEnvironment({
      repo: operation.repo,
      requestedName: operation.environment,
      readGitHubJson: (apiPath) =>
        dependencies.readGitHubJson(apiPath, executor),
      runGh: (args) => executor.run(args),
      now: dependencies.now
    });
  } catch (error) {
    return failResolution(operation, executor, dependencies, error);
  }

  const requestedName = operation.environment;
  dependencies.setCanonicalEnvironment(operation, ensured.name);
  dependencies.recordGitHubEnvironment(operation, {
    state: ensured.state,
    origin: ensured.state === "reused" ? "pre_existing" : "unknown",
    repo: operation.repo,
    name: ensured.name
  });
  if (ensured.state === "created_candidate" && ensured.creationEvidence) {
    const proof = proveGitHubEnvironmentCreated({
      preflight: ensured.state,
      putResponseBody: ensured.creationEvidence.putResponseBody,
      putStartedAtMs: ensured.creationEvidence.putStartedAtMs
    });
    if (
      proof.proven &&
      dependencies.promoteCreatedGitHubEnvironment(operation, {
        repo: operation.repo,
        name: ensured.name
      })
    ) {
      dependencies.addLegacyStep(
        operation,
        `✅ GitHub environment "${ensured.name}" created by this setup — Radius owns it and can remove it.`
      );
    } else if (!proof.proven) {
      dependencies.addLegacyStep(
        operation,
        `ℹ️ Radius left GitHub environment "${ensured.name}" outside its cleanup scope. ${proof.detail}`
      );
    }
  }
  if (requestedName === ensured.name) {
    dependencies.addLegacyStep(
      operation,
      `✅ GitHub environment "${ensured.name}" resolved.`
    );
  } else {
    dependencies.addLegacyStep(
      operation,
      `✅ GitHub resolved requested environment "${requestedName}" as "${ensured.name}".`
    );
  }
  if (!(await dependencies.persistEnvironmentResolution(operation))) {
    return { shouldMonitor: false };
  }

  const request = requestFrom(operation);
  let setupResult: Record<string, unknown> | null = null;
  if (operation.provider === "azure" && request.needsAzureCredentials) {
    setupResult = await dependencies.postInternal("/api/azure-auto-setup", {
      ...record(request.azure),
      repo: operation.repo,
      environment: ensured.name,
      operationEnvironment: operation.environment,
      operationId: operation.operationId
    });
    if (setupResult?.inputRequired || operation.state === "input_required") {
      return { shouldMonitor: false };
    }
  }
  const current = dependencies.getOperation(operation.operationId);
  if (!current || current.state === "input_required" || current.endedAt) {
    return { shouldMonitor: false };
  }
  const environmentRequest = record(request.environment);
  await dependencies.postInternal("/api/create-environment", {
    ...environmentRequest,
    repo: operation.repo,
    environment: ensured.name,
    operationEnvironment: operation.environment,
    provider: operation.provider,
    operationId: operation.operationId,
    clientId:
      (typeof setupResult?.clientId === "string" && setupResult.clientId) ||
      (typeof environmentRequest.clientId === "string" &&
        environmentRequest.clientId) ||
      ""
  });
  return { shouldMonitor: true };
}
