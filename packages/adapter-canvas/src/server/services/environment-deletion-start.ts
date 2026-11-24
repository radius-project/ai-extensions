import {
  admitEnvironmentDeletion,
  type EnvironmentDeletionConfiguration,
  type EnvironmentDeletionTarget
} from "@radius-project/core";
import type {
  DeleteOperationRecord,
  EnvironmentsDependencies
} from "../routes/environments-types.js";

export type EnvironmentDeletionRegistrationPorts = Pick<
  EnvironmentsDependencies,
  | "activeDeleteOperation"
  | "resolveEnvDeployment"
  | "discoverEnvironmentTarget"
  | "createOperation"
  | "buildDeleteStages"
  | "startOperation"
  | "persistOperations"
  | "finish"
  | "errorMessage"
>;

export async function registerEnvironmentDeletion(
  target: EnvironmentDeletionTarget,
  ports: EnvironmentDeletionRegistrationPorts,
  allowAws: boolean,
  authorization?: {
    login: string;
    acceptsConfiguration(
      configuration: EnvironmentDeletionConfiguration
    ): boolean;
  }
) {
  const { repo, environment } = target;
  const existing = ports.activeDeleteOperation(repo, environment);
  if (existing)
    return { kind: "already-deleting" as const, operation: existing };

  const admission = await admitEnvironmentDeletion(target, ports, allowAws);
  if (admission.kind !== "ready") return admission;

  const configuration = admission.configuration;
  if (authorization && !authorization.acceptsConfiguration(configuration)) {
    return { kind: "target-changed" as const };
  }
  const { provider } = configuration;
  const includeAwsCleanup = provider === "aws";
  const operation = ports.createOperation({
    kind: "delete",
    provider,
    repo,
    environment,
    stages: ports.buildDeleteStages({
      includeAzureCleanup: provider === "azure",
      includeAwsCleanup
    })
  });
  operation.request = {
    repo,
    repoId: configuration.repoId,
    environment,
    provider,
    clientId: configuration.clientId,
    tenantId: configuration.tenantId,
    ...(authorization ?
      {
        selectedOwner: authorization.login,
        environmentId: configuration.environmentId
      }
    : {}),
    ...(includeAwsCleanup ?
      {
        roleArn: configuration.roleArn || "",
        trustSubjects: configuration.trustSubjects,
        region: configuration.region || "",
        cluster: configuration.cluster || ""
      }
    : {})
  };
  const started = ports.startOperation(operation);
  if (!started.ok) {
    return {
      kind: "operation-conflict" as const,
      operationId: started.conflict.operationId
    };
  }
  try {
    await ports.persistOperations();
  } catch (error) {
    ports.finish(operation, "failed", {
      failure: {
        code: "operation-registration-persist-failed",
        stage: operation.currentStage,
        stepSeq: null,
        message: "Radius could not durably register the delete operation.",
        classification: "unknown",
        evidence: ports.errorMessage(error)
      }
    });
    return { kind: "registration-failed" as const };
  }
  return { kind: "registered" as const, operation };
}

export async function scheduleRegisteredEnvironmentDeletion(
  operation: DeleteOperationRecord,
  schedule: () => boolean,
  ports: Pick<
    EnvironmentDeletionRegistrationPorts,
    "finish" | "persistOperations"
  >,
  unavailableEvidence: string
): Promise<boolean> {
  if (schedule()) return true;
  ports.finish(operation, "failed", {
    failure: {
      code: "operation-scheduling-failed",
      stage: operation.currentStage,
      stepSeq: null,
      message:
        "Radius accepted the delete operation but could not start any work for it.",
      classification: "unknown",
      evidence: unavailableEvidence
    }
  });
  await ports.persistOperations().catch(() => {});
  return false;
}
