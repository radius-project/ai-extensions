import type {
  AzureAutoSetupDependencies,
  AzureAutoSetupOperationArtifactPort,
  AzureAutoSetupOperationLifecyclePort,
  AzureAutoSetupOperationProgressPort
} from "./routes/azure-auto-setup-types.js";

export interface AzureAutoSetupCompositionSeams extends Pick<
  AzureAutoSetupDependencies,
  | "isServerOwnedRequest"
  | "external"
  | "tempFile"
  | "ensureServicePrincipal"
  | "finalizeSetupFailure"
  | "persistMutationCheckpoint"
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
}: AzureAutoSetupCompositionSeams): AzureAutoSetupDependencies {
  return {
    ...dependencies,
    operations: {
      ...lifecycle,
      ...progress,
      ...artifacts
    }
  };
}
