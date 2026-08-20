import type {
  AzureAutoSetupDependencies,
  AzureAutoSetupExternalPort,
  AzureAutoSetupOperation,
  AzureAutoSetupOperationPort,
  AzureAutoSetupTempFilePort
} from "../../../src/server/routes/azure-auto-setup-types.js";
import { successfulSelectedGhExecutor } from "./selected-gh.js";

export interface AzureAutoSetupDependencyOverrides extends Omit<
  Partial<AzureAutoSetupDependencies>,
  "external" | "operations" | "tempFile"
> {
  external?: Partial<AzureAutoSetupExternalPort>;
  operations?: Partial<AzureAutoSetupOperationPort>;
  tempFile?: Partial<AzureAutoSetupTempFilePort>;
}

function unexpected(name: string): never {
  throw new Error(`unexpected Azure auto-setup dependency call: ${name}`);
}

const operation: AzureAutoSetupOperation = {
  operationId: "op-test",
  repo: "octo/app",
  environment: "dev",
  provider: "azure",
  currentStage: "authorize_identity"
};

export function createAzureAutoSetupTestDependencies(
  overrides: AzureAutoSetupDependencyOverrides = {}
): AzureAutoSetupDependencies {
  const {
    external: externalOverrides,
    operations: operationOverrides,
    tempFile: tempFileOverrides,
    ...dependencyOverrides
  } = overrides;
  return {
    isServerOwnedRequest: () => true,
    operations: {
      get: () => undefined,
      isStale: () => false,
      create: () => operation,
      buildStages: () => [],
      start: () => ({ ok: true }),
      persist: async () => {},
      report: () => {},
      finish: () => {},
      enterStage: () => {},
      setStageState: () => {},
      hasWarnings: () => false,
      addLegacyStep: () => {},
      setContext: () => {},
      setCloudContext: () => {},
      requireInput: () => {},
      resumeAfterInput: () => {},
      recordAzureApp: () => {},
      recordServicePrincipal: () => {},
      recordCreatedFederatedCredential: () => {},
      recordCreatedRoleAssignment: () => {},
      ...operationOverrides
    },
    external: {
      getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
      getGitHubIdentity: async () => unexpected("getGitHubIdentity"),
      preflightRepoAdmin: async () => unexpected("preflightRepoAdmin"),
      preflightGhcrPackageWriteAccess: async () =>
        unexpected("preflightGhcrPackageWriteAccess"),
      runGitHubJson: async () => unexpected("runGitHubJson"),
      runAz: async () => unexpected("runAz"),
      ...externalOverrides
    },
    tempFile: {
      createPath: () => unexpected("tempFile.createPath"),
      write: () => unexpected("tempFile.write"),
      remove: () => unexpected("tempFile.remove"),
      ...tempFileOverrides
    },
    ensureServicePrincipal: async () => unexpected("ensureServicePrincipal"),
    finalizeSetupFailure: async () => unexpected("finalizeSetupFailure"),
    persistMutationCheckpoint: async () =>
      unexpected("persistMutationCheckpoint"),
    sleep: async () => unexpected("sleep"),
    stageAuthorizeIdentity: "authorize_identity",
    ...dependencyOverrides
  };
}
