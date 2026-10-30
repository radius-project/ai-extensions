import {
  runSetupCoordinator,
  type SetupCoordinatorPorts
} from "@radius-project/core";
import type { SelectedGhExecutor } from "../../gh.js";
import { unresolvedProviderMutations } from "../../operations.js";
import {
  remediationReference,
  type RemediationReference
} from "../../remediation-reference.js";
import {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment
} from "./github-environment.js";
import {
  ProviderMutationRecoveryError,
  recordProviderReconciliationFailure
} from "./provider-mutation-recovery.js";
import type { GitHubEnvironmentReadResult } from "./github-environment.js";
import {
  copySetupRequest,
  setupStageResult,
  type SetupServices
} from "./setup-outcome.js";

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
  setupServices: SetupServices;
  // AWS only: prepare the deploy identity under `Authorize deploy identity`
  // and answer the role ARN the GitHub environment records.
  setupAwsDeployIdentity(
    operation: EnvironmentOperationRecord,
    request: Record<string, unknown>,
    executor: SelectedGhExecutor
  ): Promise<
    | { ok: true; roleArn: string; subjects: readonly string[] }
    | { ok: false; status: number; error: string; code: string }
    | { ok: false; stopped: true }
  >;
  instanceId: string;
  now(): number;
}

export type { RemediationReference } from "../../remediation-reference.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
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

// Why an AWS setup cannot reuse this GitHub environment, or null when it can.
// The deploy workflow checks Azure first, so an AWS setup on top of Azure
// variables would keep deploying to Azure. Fails closed when the variables
// cannot be read.
export async function awsEnvironmentConflict(
  repo: string,
  environment: string,
  executor: SelectedGhExecutor,
  dependencies: Pick<EnvironmentOperationWorkflowDependencies, "readGitHubJson">
): Promise<{ status: number; message: string; code: string } | null> {
  const result = await dependencies.readGitHubJson(
    `/repos/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
    executor
  );
  if (!result.ok) {
    return {
      status: 502,
      message: `Radius could not read the variables of GitHub environment "${environment}" to confirm it is not set up for Azure. Nothing was changed in AWS. Retry setup.`,
      code: "github-environment-variables-unreadable"
    };
  }
  const variables = record(result.json).variables;
  const names =
    Array.isArray(variables) ?
      variables.map((variable) => record(variable).name)
    : [];
  if (!names.includes("AZURE_CLIENT_ID")) return null;
  return {
    status: 409,
    message: `GitHub environment "${environment}" is already set up for Azure. Radius did not change it or anything in AWS. Choose a different environment name, or delete the Azure environment first.`,
    code: "github-environment-provider-conflict"
  };
}

export function createSetupCoordinatorPorts(
  operation: EnvironmentOperationRecord,
  executor: SelectedGhExecutor,
  dependencies: EnvironmentOperationWorkflowDependencies
): SetupCoordinatorPorts {
  let preflightFailure: unknown;
  return {
    operation: () => operation,
    currentOperation: () => dependencies.getOperation(operation.operationId),
    unresolved: () => unresolvedProviderMutations(operation),
    preflightRepository: async () => {
      const message = await dependencies.preflightRepoAdmin(
        operation.repo,
        executor
      );
      if (!message) return true;
      preflightFailure = {
        status: 403,
        message,
        code: "repo-admin-required"
      };
      return false;
    },
    preflightPackages: async () => {
      const result =
        await dependencies.preflightGhcrPackageWriteAccess(executor);
      if (result.ok) return true;
      preflightFailure = {
        status: result.status,
        message: result.error,
        code: result.code,
        remediation: remediationReference(result.remediation)
      };
      return false;
    },
    stopBoundary: (boundary) =>
      dependencies.guardStopBoundary(operation, boundary),
    readEnsuredEnvironment: (name) =>
      readEnsuredGitHubEnvironment(operation, operation.repo, name),
    ensureEnvironment: (beforeCreate) =>
      ensureGitHubEnvironment({
        repo: operation.repo,
        requestedName: operation.environment,
        readGitHubJson: (path) => dependencies.readGitHubJson(path, executor),
        runGh: (args) => executor.run(args),
        now: dependencies.now,
        mutationRecovery: {
          operation,
          persist: dependencies.persistProviderMutation
        },
        beforeCreate
      }),
    setCanonicalEnvironment: (name) =>
      dependencies.setCanonicalEnvironment(operation, name),
    recordEnvironment: (patch) =>
      dependencies.recordGitHubEnvironment(operation, patch),
    promoteCreatedEnvironment: (identity) =>
      dependencies.promoteCreatedGitHubEnvironment(operation, identity),
    report: (event) => {
      switch (event.kind) {
        case "environment-owned":
          dependencies.addLegacyStep(
            operation,
            `✅ GitHub environment "${event.name}" created by this setup — Radius owns it and can remove it.`
          );
          return;
        case "environment-unowned":
          dependencies.addLegacyStep(
            operation,
            `ℹ️ Radius left GitHub environment "${event.name}" outside its cleanup scope. ${event.detail}`
          );
          return;
        case "environment-resolved":
          dependencies.addLegacyStep(
            operation,
            `✅ GitHub environment "${event.name}" resolved.`
          );
          return;
        case "environment-canonicalized":
          dependencies.addLegacyStep(
            operation,
            `✅ GitHub resolved requested environment "${event.requestedName}" as "${event.name}".`
          );
          return;
      }
    },
    checkpoint: () => dependencies.persistEnvironmentResolution(operation),
    finalizeFailure: async (failure) => {
      await failResolution(
        operation,
        executor,
        dependencies,
        "error" in failure ? failure.error : preflightFailure
      );
    },
    reconcileFailure: (mutationId, error) => {
      const live = unresolvedProviderMutations(operation).find(
        (mutation) => mutation.mutationId === mutationId
      );
      if (!live) throw error;
      return recordProviderReconciliationFailure(
        operation,
        live,
        dependencies.persistProviderMutation,
        error
      );
    },
    authorizeAzure: async (request) =>
      setupStageResult(
        await dependencies.setupServices.authorizeAzure(
          copySetupRequest(request)
        )
      ),
    authorizeAws: async ({ reused, ...request }) => {
      const conflict =
        reused ?
          await awsEnvironmentConflict(
            operation.repo,
            request.environment,
            executor,
            dependencies
          )
        : null;
      if (conflict) return { kind: "failed", error: conflict };
      const result = await dependencies.setupAwsDeployIdentity(
        operation,
        request,
        executor
      );
      if ("stopped" in result) return { kind: "stopped" };
      return result.ok ?
          {
            kind: "completed",
            roleArn: result.roleArn,
            trustSubjects: result.subjects
          }
        : {
            kind: "failed",
            error: {
              status: result.status,
              message: result.error,
              code: result.code
            }
          };
    },
    configureEnvironment: async (request) =>
      setupStageResult(
        await dependencies.setupServices.configureEnvironment(
          copySetupRequest(request),
          dependencies.instanceId
        )
      ),
    raiseReconciling: (stage, message) => {
      throw new ProviderMutationRecoveryError(
        String(
          message ||
            (stage === "azure" ?
              "Azure setup is reconciling an uncertain provider mutation."
            : "Environment setup is reconciling an uncertain provider mutation.")
        ),
        "provider-mutation-outcome-unknown"
      );
    }
  };
}

export async function runEnvironmentOperationWorkflow(
  operation: EnvironmentOperationRecord,
  executor: SelectedGhExecutor,
  dependencies: EnvironmentOperationWorkflowDependencies
): Promise<{ shouldMonitor: boolean }> {
  return runSetupCoordinator(
    operation,
    createSetupCoordinatorPorts(operation, executor, dependencies)
  );
}
