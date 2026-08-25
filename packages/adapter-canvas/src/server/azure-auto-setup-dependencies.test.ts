import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import type {
  AzureAutoSetupExternalPort,
  AzureAutoSetupOperation,
  AzureAutoSetupOperationArtifactPort,
  AzureAutoSetupOperationLifecyclePort,
  AzureAutoSetupOperationProgressPort,
  AzureAutoSetupTempFilePort
} from "./routes/azure-auto-setup-types.js";
import { composeAzureAutoSetupDependencies } from "./azure-auto-setup-dependencies.js";

const operation: AzureAutoSetupOperation = {
  operationId: "op-composition",
  repo: "octo/app",
  environment: "dev",
  provider: "azure",
  currentStage: "authorize_identity"
};

describe("Azure auto-setup dependency composition", () => {
  it("maps every lifecycle, progress, artifact, and external seam", () => {
    const lifecycle: AzureAutoSetupOperationLifecyclePort = {
      get: vi.fn(() => operation),
      isStale: vi.fn(() => false),
      create: vi.fn(() => operation),
      buildStages: vi.fn(() => []),
      start: vi.fn(() => ({ ok: true as const })),
      persist: vi.fn(async () => {}),
      report: vi.fn(),
      finish: vi.fn()
    };
    const progress: AzureAutoSetupOperationProgressPort = {
      enterStage: vi.fn(),
      setStageState: vi.fn(),
      hasWarnings: vi.fn(() => false),
      addLegacyStep: vi.fn(),
      setContext: vi.fn(),
      setCloudContext: vi.fn(),
      requireInput: vi.fn(),
      resumeAfterInput: vi.fn()
    };
    const artifacts: AzureAutoSetupOperationArtifactPort = {
      withCredentialProvenanceLock: async (work) => work(),
      recordAzureApp: vi.fn(),
      recordServicePrincipal: vi.fn(),
      recordCreatedFederatedCredential: vi.fn(),
      recordFederatedCredentialProvenance: vi.fn(async () => {}),
      recordCreatedRoleAssignment: vi.fn()
    };
    const external: AzureAutoSetupExternalPort = {
      getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
      getGitHubIdentity: vi.fn(async () => null),
      preflightRepoAdmin: vi.fn(async () => ""),
      preflightGhcrPackageWriteAccess: vi.fn(async () => ({
        ok: true as const
      })),
      runGitHubJson: vi.fn(async () => ({
        ok: false,
        status: 404,
        json: null
      })),
      runAz: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }))
    };
    const tempFile: AzureAutoSetupTempFilePort = {
      createPath: vi.fn(() => "C:\\temp\\fic.json"),
      write: vi.fn(),
      remove: vi.fn()
    };
    const isServerOwnedRequest = vi.fn(() => true);
    const ensureServicePrincipal = vi.fn(async () => ({
      ok: true as const,
      state: "reused" as const,
      origin: "pre_existing" as const,
      objectId: null
    }));
    const finalizeSetupFailure = vi.fn(async () => ({
      status: 400,
      body: { code: "setup-failed" }
    }));
    const persistMutationCheckpoint = vi.fn(async () => true);
    const sleep = vi.fn(async () => {});

    const composed = composeAzureAutoSetupDependencies({
      isServerOwnedRequest,
      lifecycle,
      progress,
      artifacts,
      external,
      tempFile,
      ensureServicePrincipal,
      finalizeSetupFailure,
      persistMutationCheckpoint,
      sleep,
      stageAuthorizeIdentity: "authorize_identity"
    });

    expect(composed.operations).toEqual({
      ...lifecycle,
      ...progress,
      ...artifacts
    });
    expect(composed.isServerOwnedRequest).toBe(isServerOwnedRequest);
    expect(composed.external).toBe(external);
    expect(composed.tempFile).toBe(tempFile);
    expect(composed.ensureServicePrincipal).toBe(ensureServicePrincipal);
    expect(composed.finalizeSetupFailure).toBe(finalizeSetupFailure);
    expect(composed.persistMutationCheckpoint).toBe(persistMutationCheckpoint);
    expect(composed.sleep).toBe(sleep);
    expect(composed.stageAuthorizeIdentity).toBe("authorize_identity");
  });
});
