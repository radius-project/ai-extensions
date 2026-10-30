import type {
  AzureAutoSetupDependencies,
  AzureAutoSetupOperationArtifactPort,
  AzureAutoSetupOperationLifecyclePort,
  AzureAutoSetupOperationProgressPort
} from "./routes/azure-auto-setup-types.js";
import type { AzureSetupDependencies } from "./services/azure-setup.js";

export interface AzureAutoSetupCompositionSeams extends Pick<
  AzureAutoSetupDependencies,
  | "external"
  | "isStopped"
  | "tempFile"
  | "ensureServicePrincipal"
  | "finalizeSetupFailure"
  | "persistMutationCheckpoint"
  | "honorStopBoundary"
  | "sleep"
  | "stageAuthorizeIdentity"
> {
  lifecycle: AzureAutoSetupOperationLifecyclePort;
  progress: AzureAutoSetupOperationProgressPort;
  artifacts: AzureAutoSetupOperationArtifactPort;
}

export function composeAzureAutoSetupDependencies({
  lifecycle,
  progress,
  artifacts,
  ...dependencies
}: AzureAutoSetupCompositionSeams): AzureSetupDependencies {
  return {
    ...dependencies,
    operations: {
      ...lifecycle,
      ...progress,
      ...artifacts
    }
  };
}
