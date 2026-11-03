import type {
  CreateEnvironmentOperation,
  CreateEnvironmentRefusal,
  OperationStartResult
} from "./create-environment-types.js";
import { setupStartConflictResponse } from "./operation-start-conflict.js";
import {
  findNamespaceClaimConflict,
  loadNamespaceClaims,
  type NamespaceClaimsPorts
} from "./create-environment-namespace-claims.js";
import {
  admitSetupOperation,
  type SetupAdmissionIssue,
  type SetupNamespaceIssue
} from "@radius-project/core";

// The namespace rung runs last of the pre-mutation checks, once the operation
// this request belongs to is settled. That ordering is required rather than
// cosmetic: the claim read is authoritative, so it must run as the GitHub
// account pinned to this operation, and that account is only known once the
// operation is adopted or started. It still precedes every GitHub mutation.

export interface CreateEnvironmentRequestData {
  repo?: string;
  environment?: string;
  operationEnvironment?: string;
  provider?: string;
  operationId?: unknown;
  origin?: string | null;
  resumeTarget?: string | null;
  resumeBranch?: string | null;
  branch?: string | null;
  resumeReason?: string | null;
  profileName?: string;
  clientId?: string;
  tenantId?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  // The resource group the AKS cluster itself lives in, which is not the
  // application's `resourceGroup`. An AKS cluster name is only unique within a
  // resource group, so this is part of what identifies the cluster.
  clusterResourceGroup?: string;
  cluster?: string;
  location?: string;
  namespace?: string;
  roleArn?: string;
  region?: string;
  accountId?: string;
  vpcId?: string;
  subnetIds?: string;
}

export interface AdmissionPorts {
  isValidRepoSlug(repo: string): boolean;
  getOperation(operationId: string): CreateEnvironmentOperation | null;
  isStale(operation: CreateEnvironmentOperation): boolean;
  isTerminalState(state: unknown): boolean;
  createOperation(input: {
    provider: string;
    repo: string;
    environment: string;
    stages: unknown;
    journey: Record<string, unknown>;
  }): CreateEnvironmentOperation;
  buildStages(input: { includeIdentity: boolean }): unknown;
  startOperation(operation: CreateEnvironmentOperation): OperationStartResult;
  persistOperations(): Promise<void>;
  reportOperationDiagnostic(diagnostic: {
    code: string;
    message: string;
  }): void;
  finishFailed(
    operation: CreateEnvironmentOperation,
    failure: Record<string, unknown>
  ): void;
  enterStage(operation: CreateEnvironmentOperation, stage: string): void;
  errorMessage(error: unknown): string;
  stageAuthorizeIdentity: string;
  stageConfigureEnvironment: string;
  namespaceClaimsFor(operationId: string): NamespaceClaimsPorts | null;
}

export interface AdmittedCreateEnvironmentRequest {
  outcome: "admitted";
  operation: CreateEnvironmentOperation;
  targetRepo: string;
  envName: string;
  provider: string;
}

export interface RefusedCreateEnvironmentRequest {
  outcome: "refused";
  refusal: CreateEnvironmentRefusal;
  // The operation the caller must expose to its generic catch. Rungs 4 and 5
  // deliberately leave this null so a failed admission cannot finalize a record
  // the route does not own.
  operation: CreateEnvironmentOperation | null;
}

export type CreateEnvironmentAdmission =
  AdmittedCreateEnvironmentRequest | RefusedCreateEnvironmentRequest;

// The namespace rung, factored out because it runs once the operation whose
// pinned GitHub account will perform the read is known: adopted on the
// continuation path, freshly started otherwise. It reads through that account
// rather than the ambient one, so a customer who passed readiness with the
// selected account is never refused because some other account cannot see the
// repository.
async function refuseClaimedNamespace(
  data: CreateEnvironmentRequestData,
  targetRepo: string,
  envName: string,
  provider: string,
  operationId: string,
  ports: AdmissionPorts
): Promise<SetupNamespaceIssue | null> {
  const unavailable = (detail: string): SetupNamespaceIssue => ({
    code: "namespace-claims-unavailable",
    detail
  });
  const claimsPorts = ports.namespaceClaimsFor(operationId);
  if (!claimsPorts) {
    return unavailable(
      "the GitHub account pinned to this setup is unavailable."
    );
  }
  const claims = await loadNamespaceClaims(targetRepo, claimsPorts);
  if (!claims.ok) return unavailable(claims.reason);
  const conflict = findNamespaceClaimConflict(claims.claims, {
    provider,
    subscriptionId: data.subscriptionId ?? "",
    clusterResourceGroup: data.clusterResourceGroup ?? "",
    accountId: data.accountId ?? "",
    region: data.region ?? "",
    cluster: data.cluster ?? "",
    namespace: data.namespace ?? "",
    // Saving an environment must not collide with the namespace it already
    // holds. The form locks the name on edit, so the submitted name is the
    // environment being written.
    excludeEnvironment: envName
  });
  if (!conflict) return null;
  return {
    code: "namespace-already-claimed",
    namespace: conflict.namespace,
    cluster: conflict.cluster,
    environment: conflict.environment
  };
}

function admissionRefusal(
  issue: SetupAdmissionIssue,
  targetRepo: string
): CreateEnvironmentRefusal {
  switch (issue.code) {
    case "target-missing":
      return {
        status: 400,
        body: { error: "No target repository specified." }
      };
    case "invalid-repo":
      return {
        status: 400,
        body: {
          error: `Invalid repository "${targetRepo}". Expected "owner/repo".`,
          code: "invalid-repo"
        }
      };
    case "operation-continuation-mismatch":
      return {
        status: 409,
        body: {
          error:
            "The environment request does not match the setup operation it is continuing.",
          code: issue.code,
          operationId: issue.operationId
        }
      };
    case "operation-start-conflict":
      return {
        status: 409,
        body: setupStartConflictResponse(targetRepo, issue.conflict)
      };
    case "operation-persistence-failed":
      return {
        status: 500,
        body: {
          error:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          code: issue.code,
          operationId: issue.operationId
        }
      };
    case "namespace-claims-unavailable":
      return {
        status: 409,
        body: {
          error: `Radius created nothing because it could not confirm which namespaces ${targetRepo}'s environments already use: ${issue.detail}`,
          code: issue.code
        }
      };
    case "namespace-already-claimed":
      return {
        status: 409,
        body: {
          error: `Namespace "${issue.namespace}" on cluster "${issue.cluster}" already belongs to environment "${issue.environment}". Radius allows one environment per namespace, so choose a different namespace or deploy to "${issue.environment}".`,
          code: issue.code,
          environment: issue.environment
        }
      };
  }
}

// Core owns admission order; this binding retains namespace execution, record
// projection, diagnostics and the existing HTTP refusal contract.
export async function admitCreateEnvironmentRequest(
  data: CreateEnvironmentRequestData,
  ports: AdmissionPorts
): Promise<CreateEnvironmentAdmission> {
  const result = await admitSetupOperation(data, {
    isValidRepo: ports.isValidRepoSlug,
    getOperation: ports.getOperation,
    isStale: ports.isStale,
    isTerminal: ports.isTerminalState,
    continuationStages: [
      ports.stageAuthorizeIdentity,
      ports.stageConfigureEnvironment
    ],
    createOperation: ({ repo, environment, provider, journey }) =>
      ports.createOperation({
        repo,
        environment,
        provider,
        journey,
        stages: ports.buildStages({ includeIdentity: false })
      }),
    startOperation: ports.startOperation,
    persist: ports.persistOperations,
    recordPersistenceFailure: (operation, error) => {
      ports.reportOperationDiagnostic({
        code: "operation-store-write-failed",
        message: `Could not persist setup operation ${operation.operationId}: ${ports.errorMessage(error)}`
      });
      ports.finishFailed(operation, {
        code: "operation-persistence-failed",
        stage: operation.currentStage,
        stepSeq: null,
        message:
          "Radius changed no cloud resources because it could not save the setup recovery record.",
        classification: "unknown"
      });
    },
    checkNamespace: (operation, target) =>
      refuseClaimedNamespace(
        data,
        target.repo,
        target.environment,
        target.provider,
        operation.operationId,
        ports
      ),
    enterConfiguration: (operation) =>
      ports.enterStage(operation, ports.stageConfigureEnvironment)
  });
  if (result.outcome === "refused") {
    return {
      outcome: "refused",
      operation: result.operation,
      refusal: admissionRefusal(result.issue, result.target.repo)
    };
  }
  return {
    outcome: "admitted",
    operation: result.operation,
    targetRepo: result.target.repo,
    envName: result.target.environment,
    provider: result.target.provider
  };
}
