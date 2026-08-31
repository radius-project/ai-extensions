import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupDependencies,
  AzureAutoSetupExternalPort,
  AzureAutoSetupOperation,
  AzureAutoSetupOperationPort,
  AzureAutoSetupTempFilePort
} from "../../../src/server/routes/azure-auto-setup-types.js";
import { successfulSelectedGhExecutor } from "./selected-gh.js";

/** Joined-argv prefix of the `az account show` caller-identity projection. */
export const CALLER_IDENTITY_COMMAND_PREFIX = "account show --query {type:";

/**
 * How a fake `az` should answer the caller-identity projection.
 *
 * `stdout` overrides the projection payload verbatim so a suite can drive the
 * malformed and unexpected-principal branches; `code`/`stderr` drive the
 * command-failure branch.
 */
export interface FakeCallerIdentity {
  type?: string;
  name?: string;
  stdout?: string;
  code?: string | number;
  stderr?: string;
}

/** Build the `az account show` result a fake `az` returns for a caller. */
export function callerIdentityResult(
  identity: FakeCallerIdentity = {}
): AzureAutoSetupCommandResult {
  return {
    code: identity.code ?? 0,
    stdout:
      identity.stdout ??
      JSON.stringify({
        type: identity.type ?? "user",
        name: identity.name ?? "dev@contoso.com"
      }),
    stderr: identity.stderr ?? ""
  };
}

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
      withCredentialProvenanceLock: async (work) => work(),
      recordAzureApp: () => {},
      recordServicePrincipal: () => {},
      recordCreatedFederatedCredential: () => {},
      recordFederatedCredentialProvenance: async () => {},
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
    honorStopBoundary: async () => true,
    sleep: async () => unexpected("sleep"),
    stageAuthorizeIdentity: "authorize_identity",
    ...dependencyOverrides
  };
}
