import type {
  AzureApplicationPorts,
  AzureCredentialPorts
} from "@radius-project/core";
import type {
  AzureAutoSetupApplicationInput,
  AzureAutoSetupCredentialInput,
  AzureAutoSetupWorkflow
} from "./azure-auto-setup-types.js";
import { createAzureRecoveryPort } from "../services/azure-setup-recovery.js";
import { deterministicProviderUuid } from "../services/provider-mutation-recovery.js";
import { createAzureSetupPresentation } from "./azure-setup-presentation.js";

function execution(
  workflow: AzureAutoSetupWorkflow,
  persist: () => Promise<void>,
  sleep: (milliseconds: number) => Promise<void>
) {
  return {
    operationId: workflow.operation.operationId,
    get environment() {
      return workflow.operation.environment;
    },
    runAz: workflow.runAz,
    sleep,
    stopBoundary: workflow.stopBoundary,
    checkpoint: workflow.checkpoint,
    haltKind: (): "failed" | "stopped" | "input-required" =>
      workflow.operation.state === "cancelled" ? "stopped"
      : workflow.operation.inputRequired ? "input-required"
      : "failed",
    recovery: createAzureRecoveryPort(workflow.operation, persist),
    ...createAzureSetupPresentation(workflow)
  };
}

export function createAzureApplicationPorts(
  workflow: AzureAutoSetupWorkflow,
  dependencies: AzureAutoSetupApplicationInput["dependencies"]
): AzureApplicationPorts {
  const { operation } = workflow;
  const { operations } = dependencies;
  return {
    ...execution(workflow, () => operations.persist(), dependencies.sleep),
    get environment() {
      return operation.environment;
    },
    runGitHubJson: workflow.runGitHubJson,
    persist: () => operations.persist(),
    getApplicationArtifact: () => operation.setupArtifacts?.azureApp,
    recordAzureApp: (patch) => operations.recordAzureApp(operation, patch),
    persistenceFailure(error) {
      operations.report({
        code: "operation-store-write-failed",
        message: `Could not persist setup operation ${operation.operationId}: ${error instanceof Error ? error.message : String(error)}`
      });
      operations.finish(operation, "failed", {
        failure: {
          code: "operation-persistence-failed",
          stage: operation.currentStage,
          stepSeq: null,
          message:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          classification: "unknown"
        }
      });
      workflow.respond(500, {
        error:
          "Radius changed no cloud resources because it could not save the setup recovery record.",
        code: "operation-persistence-failed",
        operationId: operation.operationId
      });
    }
  };
}

export function createAzureCredentialPorts(
  workflow: AzureAutoSetupWorkflow,
  dependencies: AzureAutoSetupCredentialInput["dependencies"]
): AzureCredentialPorts {
  const { operation } = workflow;
  const { operations } = dependencies;
  return {
    ...execution(workflow, operations.persist, dependencies.sleep),
    get environment() {
      return operation.environment;
    },
    isRollbackPending: () => {
      const recovery = operation.providerRecovery;
      return (
        recovery !== null &&
        typeof recovery === "object" &&
        "state" in recovery &&
        recovery.state === "rollback_pending"
      );
    },
    deterministicUuid: deterministicProviderUuid,
    ensureServicePrincipal: (clientId, beforeCreate) =>
      dependencies.ensureServicePrincipal(
        clientId,
        workflow.runAz,
        { operation, persist: operations.persist },
        beforeCreate,
        dependencies.sleep
      ),
    tempFile: dependencies.tempFile,
    withCredentialProvenanceLock: (work) =>
      operations.withCredentialProvenanceLock(work),
    recordServicePrincipal: (patch) =>
      operations.recordServicePrincipal(operation, patch),
    recordCreatedFederatedCredential: (entry) =>
      operations.recordCreatedFederatedCredential(operation, entry),
    recordFederatedCredentialProvenance: (entry) =>
      operations.recordFederatedCredentialProvenance(operation, entry),
    recordCreatedRoleAssignment: (entry) =>
      operations.recordCreatedRoleAssignment(operation, entry)
  };
}
