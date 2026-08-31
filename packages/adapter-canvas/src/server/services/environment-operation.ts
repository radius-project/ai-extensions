import type { SelectedGhExecutor } from "../../gh.js";
import { unresolvedProviderMutations } from "../../operations.js";
import {
  remediationReference,
  type RemediationReference
} from "../../remediation-reference.js";
import {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureCancelled,
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment
} from "./github-environment.js";
import {
  ProviderMutationRecoveryError,
  recordProviderReconciliationFailure
} from "./provider-mutation-recovery.js";
import type { GitHubEnvironmentReadResult } from "./github-environment.js";

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
      providerId: string | null;
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
  guardStopBoundary(
    operation: EnvironmentOperationRecord,
    boundary: string
  ): Promise<boolean>;
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
    patch: {
      state: string;
      origin: string;
      repo: string;
      name: string;
      providerId?: string | null;
    }
  ): void;
  promoteCreatedGitHubEnvironment(
    operation: EnvironmentOperationRecord,
    identity: { repo: string; name: string }
  ): boolean;
  addLegacyStep(operation: EnvironmentOperationRecord, text: string): void;
  persistEnvironmentResolution(
    operation: EnvironmentOperationRecord
  ): Promise<boolean>;
  persistProviderMutation(): Promise<void>;
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

export type { RemediationReference } from "../../remediation-reference.js";

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
  const unresolvedMutation = unresolvedProviderMutations(operation)[0];
  if (unresolvedMutation) {
    return recordProviderReconciliationFailure(
      operation,
      unresolvedMutation,
      dependencies.persistProviderMutation,
      error
    );
  }
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
  const outstandingProviderMutation =
    unresolvedProviderMutations(operation)[0] ?? null;
  const reconcilingProviderMutation = outstandingProviderMutation !== null;
  if (!reconcilingProviderMutation) {
    if (
      !(await dependencies.guardStopBoundary(
        operation,
        "before-github-environment"
      ))
    ) {
      return { shouldMonitor: false };
    }
    const accessMessage = await dependencies.preflightRepoAdmin(
      operation.repo,
      executor
    );
    if (accessMessage) {
      if (
        !(await dependencies.guardStopBoundary(
          operation,
          "before-setup-failure-cleanup"
        ))
      ) {
        return { shouldMonitor: false };
      }
      return failResolution(operation, executor, dependencies, {
        status: 403,
        message: accessMessage,
        code: "repo-admin-required"
      });
    }
    const packageAccess =
      await dependencies.preflightGhcrPackageWriteAccess(executor);
    if (!packageAccess.ok) {
      if (
        !(await dependencies.guardStopBoundary(
          operation,
          "before-setup-failure-cleanup"
        ))
      ) {
        return { shouldMonitor: false };
      }
      return failResolution(operation, executor, dependencies, {
        status: packageAccess.status,
        message: packageAccess.error,
        code: packageAccess.code,
        remediation: remediationReference(packageAccess.remediation)
      });
    }
  }

  const recordedCanonicalEnvironment =
    typeof operation.context?.canonicalEnvironment === "string" ?
      operation.context.canonicalEnvironment
    : operation.environment;
  let ensured =
    reconcilingProviderMutation ?
      readEnsuredGitHubEnvironment(
        operation,
        operation.repo,
        recordedCanonicalEnvironment
      )
    : null;
  if (!ensured) {
    try {
      ensured = await ensureGitHubEnvironment({
        repo: operation.repo,
        requestedName: operation.environment,
        readGitHubJson: (apiPath) =>
          dependencies.readGitHubJson(apiPath, executor),
        runGh: (args) => executor.run(args),
        now: dependencies.now,
        mutationRecovery: {
          operation,
          persist: dependencies.persistProviderMutation
        },
        beforeCreate: () =>
          dependencies.guardStopBoundary(
            operation,
            "before-github-environment-create"
          )
      });
    } catch (error) {
      if (error instanceof GitHubEnvironmentEnsureCancelled) {
        return { shouldMonitor: false };
      }
      if (error instanceof ProviderMutationRecoveryError) {
        throw error;
      }
      if (
        error instanceof GitHubEnvironmentEnsureError &&
        error.createdCandidate
      ) {
        dependencies.recordGitHubEnvironment(operation, {
          state: "created_candidate",
          origin: "unknown",
          repo: error.createdCandidate.repo,
          name: error.createdCandidate.name
        });
      }
      if (
        !(await dependencies.guardStopBoundary(
          operation,
          "after-github-environment-attempt"
        ))
      ) {
        return { shouldMonitor: false };
      }
      return failResolution(operation, executor, dependencies, error);
    }
  }

  const requestedName = operation.environment;
  dependencies.setCanonicalEnvironment(operation, ensured.name);
  dependencies.recordGitHubEnvironment(operation, {
    state: ensured.state,
    origin: ensured.state === "reused" ? "pre_existing" : "unknown",
    repo: operation.repo,
    name: ensured.name,
    // GitHub's own id for the environment, so a rollback can tell what this
    // request wrote from a replacement the customer created under the same
    // name. Without it the cleanup gate has nothing to match and refuses.
    providerId: ensured.providerId
  });
  // The proof is settled inside `ensureGitHubEnvironment` rather than derived
  // here, because a reconciled mutation proves ownership from the re-read body
  // against the journalled start time and this call site has neither.
  if (
    ensured.creationProof?.proven &&
    dependencies.promoteCreatedGitHubEnvironment(operation, {
      repo: operation.repo,
      name: ensured.name
    })
  ) {
    dependencies.addLegacyStep(
      operation,
      `✅ GitHub environment "${ensured.name}" created by this setup — Radius owns it and can remove it.`
    );
  } else if (
    ensured.state === "created_candidate" &&
    ensured.creationProof &&
    !ensured.creationProof.proven
  ) {
    dependencies.addLegacyStep(
      operation,
      `ℹ️ Radius left GitHub environment "${ensured.name}" outside its cleanup scope. ${ensured.creationProof.detail}`
    );
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
  if (
    !(await dependencies.guardStopBoundary(
      operation,
      "after-github-environment"
    ))
  ) {
    return { shouldMonitor: false };
  }

  const request = requestFrom(operation);
  const postInternal = async (
    pathname: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> => {
    try {
      return await dependencies.postInternal(pathname, data);
    } catch (error) {
      if (outstandingProviderMutation) {
        const live = unresolvedProviderMutations(operation).find(
          (mutation) =>
            mutation.mutationId === outstandingProviderMutation.mutationId
        );
        if (live) {
          return recordProviderReconciliationFailure(
            operation,
            live,
            dependencies.persistProviderMutation,
            error
          );
        }
      }
      throw error;
    }
  };
  let setupResult: Record<string, unknown> | null = null;
  const reconcilingAzureMutation =
    outstandingProviderMutation?.kind.startsWith("azure_") === true;
  if (
    operation.provider === "azure" &&
    request.needsAzureCredentials &&
    (!reconcilingProviderMutation || reconcilingAzureMutation)
  ) {
    setupResult = await postInternal("/api/azure-auto-setup", {
      ...record(request.azure),
      repo: operation.repo,
      environment: ensured.name,
      operationEnvironment: operation.environment,
      operationId: operation.operationId
    });
    if (setupResult?.reconciling) {
      throw new ProviderMutationRecoveryError(
        String(
          setupResult.message ||
            "Azure setup is reconciling an uncertain provider mutation."
        ),
        "provider-mutation-outcome-unknown"
      );
    }
    if (setupResult?.inputRequired || operation.state === "input_required") {
      return { shouldMonitor: false };
    }
  }
  const current = dependencies.getOperation(operation.operationId);
  if (!current || current.state === "input_required" || current.endedAt) {
    return { shouldMonitor: false };
  }
  const environmentRequest = record(request.environment);
  const environmentResult = await postInternal("/api/create-environment", {
    ...environmentRequest,
    repo: operation.repo,
    environment: ensured.name,
    operationEnvironment: operation.environment,
    provider: operation.provider,
    operationId: operation.operationId,
    clientId:
      (typeof setupResult?.clientId === "string" && setupResult.clientId) ||
      (typeof operation.context?.clientId === "string" &&
        operation.context.clientId) ||
      (typeof environmentRequest.clientId === "string" &&
        environmentRequest.clientId) ||
      ""
  });
  if (environmentResult?.reconciling) {
    throw new ProviderMutationRecoveryError(
      String(
        environmentResult.message ||
          "Environment setup is reconciling an uncertain provider mutation."
      ),
      "provider-mutation-outcome-unknown"
    );
  }
  return { shouldMonitor: true };
}
