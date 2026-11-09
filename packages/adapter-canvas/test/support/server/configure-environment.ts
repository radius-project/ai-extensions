import { vi } from "vitest";
import { createOperation, enterStage } from "../../../src/operations.js";
import { isValidRepoSlug } from "../../../src/azure-oidc.js";
import { successfulSelectedGhExecutor } from "./selected-gh.js";
import type { ConfigureEnvironmentDependencies } from "../../../src/server/services/configure-environment.js";

const unexpected = (): never => {
  throw new Error("Unexpected configuration dependency.");
};

export function configureEnvironmentFixture() {
  const operation = createOperation({
    operationId: "op-configure",
    repo: "octo/app",
    environment: "dev",
    provider: "azure"
  });
  operation.currentStage = "configure";
  const finalize = vi.fn<
    ConfigureEnvironmentDependencies["finalizeSetupFailure"]
  >(async (_op, input) => ({
    status: Number(input.status),
    body: { error: input.error, code: input.code }
  }));
  const dependencies: ConfigureEnvironmentDependencies = {
    getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
    readInstanceEntry: unexpected,
    isValidRepoSlug,
    getOperation: (id) => (id === operation.operationId ? operation : null),
    isStale: () => false,
    isTerminalState: () => false,
    createOperation: unexpected,
    buildStages: unexpected,
    startOperation: unexpected,
    persistOperations: vi.fn(async () => {}),
    reportOperationDiagnostic: vi.fn(),
    finishFailed: unexpected,
    enterStage,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    stageAuthorizeIdentity: "identity",
    stageConfigureEnvironment: "configure",
    namespaceClaimsFor: () => ({
      listEnvironmentNames: async () => ({ ok: true, names: [] }),
      readEnvironmentVariables: unexpected
    }),
    cliExec: unexpected,
    readProcessEnv: unexpected,
    addLegacyStep: vi.fn(),
    finalizeSetupFailure: finalize,
    persistMutationCheckpoint: unexpected,
    persistBestEffort: unexpected,
    guardStopBoundary: async () => true,
    isShuttingDown: () => false,
    runAzCommand: unexpected,
    preflightRepoAdmin: unexpected,
    preflightGhcrPackageWriteAccess: unexpected,
    readGitHubJson: unexpected,
    bootstrapGHCRStatePackage: unexpected,
    stateRegistryForEnvironment: unexpected,
    getDefaultBranch: unexpected,
    fetchFileFromRepoResult: unexpected,
    getBranchHeadSha: unexpected,
    createBranchRef: unexpected,
    tempFile: { write: unexpected, remove: unexpected },
    setCanonicalEnvironment: unexpected,
    recordGitHubEnvironment: unexpected,
    recordGitHubEnvironmentVariable: unexpected,
    promoteCreatedGitHubEnvironment: unexpected,
    envListCacheDelete: unexpected,
    ociStateBackend: "oci",
    defaultStateArchive: "radius-state",
    azureCredential: unexpected,
    awsCredential: unexpected,
    optionalString: unexpected,
    generateVerifyWorkflow: unexpected,
    generateDeployWorkflow: unexpected,
    generateDeleteWorkflow: unexpected,
    recordCommittedWorkflowFile: unexpected,
    deleteLegacyDeployWorkflow: unexpected,
    createPullRequestApi: unexpected,
    planCredentialVerification: unexpected,
    fetchFileFromRepo: unexpected,
    buildVerifyWorkflowDispatchArgs: unexpected,
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify",
    recordCleanupState: unexpected,
    recordCommitState: unexpected,
    setStageState: unexpected,
    finish: unexpected,
    sleep: unexpected,
    now: unexpected
  };
  const data = {
    repo: operation.repo,
    environment: operation.environment,
    operationId: operation.operationId
  };
  return { dependencies, operation, data, finalize };
}
