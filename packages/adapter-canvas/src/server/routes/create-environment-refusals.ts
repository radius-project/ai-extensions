import type {
  CreateEnvironmentOperation,
  CreateEnvironmentRefusal,
  OperationStartResult
} from "./create-environment-types.js";

// Seam 1 of the `POST /api/create-environment` slice: the refusal ladder.
//
// Six rungs, in this exact order, every one of them reached before the route
// performs any GitHub mutation:
//
//   1. 403 not server-owned            (before the body is even read)
//   2. 400 no target repository
//   3. 400 malformed repository slug
//   4. 409 continuation does not match the operation it claims to continue
//   5. 409 another setup is already running for the repo
//   6. 500 the setup recovery record could not be persisted
//
// Rung 6 also finalizes the operation as failed, because a record that cannot be
// saved must not be left looking live. Rungs are returned as data rather than
// written to the socket so the ladder is assertable without a live response.

export const SERVER_OWNED_REFUSAL: CreateEnvironmentRefusal = {
  status: 403,
  body: {
    error: "This endpoint is reserved for server-owned operations.",
    code: "server-owned-operation-required"
  }
};

export interface CreateEnvironmentRequestData {
  repo?: string;
  environment?: string;
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
  reportOperationDiagnostic(diagnostic: { code: string; message: string }): void;
  finishFailed(
    operation: CreateEnvironmentOperation,
    failure: Record<string, unknown>
  ): void;
  enterStage(operation: CreateEnvironmentOperation, stage: string): void;
  errorMessage(error: unknown): string;
  stageAuthorizeIdentity: string;
  stageConfigureEnvironment: string;
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
  | AdmittedCreateEnvironmentRequest
  | RefusedCreateEnvironmentRequest;

// Rung 1. Split out because it is decided before the request body is read.
export function refuseUnlessServerOwned(
  isServerOwned: boolean
): CreateEnvironmentRefusal | null {
  return isServerOwned ? null : SERVER_OWNED_REFUSAL;
}

// Rungs 2 through 6. Returns the adopted or freshly started operation on
// success, with the configure-environment stage already entered.
export async function admitCreateEnvironmentRequest(
  data: CreateEnvironmentRequestData,
  ports: AdmissionPorts
): Promise<CreateEnvironmentAdmission> {
  // `||` not `??`: an empty-string repo must fall through to the no-repo rung,
  // and an empty-string environment/provider must take the default.
  const targetRepo = data.repo || "";
  const envName = data.environment || "dev";
  const provider = data.provider || "azure";

  if (!targetRepo) {
    return {
      outcome: "refused",
      operation: null,
      refusal: {
        status: 400,
        body: { error: "No target repository specified." }
      }
    };
  }

  if (!ports.isValidRepoSlug(targetRepo)) {
    return {
      outcome: "refused",
      operation: null,
      refusal: {
        status: 400,
        body: {
          error: `Invalid repository "${targetRepo}". Expected "owner/repo".`,
          code: "invalid-repo"
        }
      }
    };
  }

  // Adopt the record /api/azure-auto-setup left running, so the two POSTs read
  // as one operation. When credentials already exist that route never ran, so
  // start a record here instead — with the identity stage omitted rather than
  // shown as skipped, because a stage that cannot happen has no business in the
  // checklist.
  const continuationId =
    typeof data.operationId === "string" ? data.operationId : "";
  if (continuationId) {
    const existing = ports.getOperation(continuationId);
    if (
      !existing ||
      ports.isStale(existing) ||
      existing.repo !== targetRepo ||
      existing.environment !== envName ||
      existing.provider !== provider ||
      (existing.currentStage !== ports.stageAuthorizeIdentity &&
        existing.currentStage !== ports.stageConfigureEnvironment) ||
      existing.inputRequired
    ) {
      return {
        outcome: "refused",
        operation: null,
        refusal: {
          status: 409,
          body: {
            error:
              "The environment request does not match the setup operation it is continuing.",
            code: "operation-continuation-mismatch",
            operationId: continuationId
          }
        }
      };
    }
    ports.enterStage(existing, ports.stageConfigureEnvironment);
    return {
      outcome: "admitted",
      operation: existing,
      targetRepo,
      envName,
      provider
    };
  }

  const operation = ports.createOperation({
    provider,
    repo: targetRepo,
    environment: envName,
    stages: ports.buildStages({ includeIdentity: false }),
    journey: {
      origin: data.origin || null,
      resumeTarget: data.resumeTarget || null,
      resumeBranch: data.resumeBranch || data.branch || null,
      resumeReason: data.resumeReason || null
    }
  });
  const started = ports.startOperation(operation);
  if (!started.ok) {
    return {
      outcome: "refused",
      operation: null,
      refusal: {
        status: 409,
        body: {
          error: `Setup is already running for ${targetRepo}.`,
          code: "operation-in-progress",
          operationId: started.conflict.operationId
        }
      }
    };
  }
  try {
    await ports.persistOperations();
  } catch (error) {
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
    return {
      outcome: "refused",
      operation,
      refusal: {
        status: 500,
        body: {
          error:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          code: "operation-persistence-failed",
          operationId: operation.operationId
        }
      }
    };
  }
  ports.enterStage(operation, ports.stageConfigureEnvironment);
  return {
    outcome: "admitted",
    operation,
    targetRepo,
    envName,
    provider
  };
}
