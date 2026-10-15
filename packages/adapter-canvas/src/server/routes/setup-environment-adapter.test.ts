import { describe, expect, it } from "vitest";
import { createSetupEnvironmentPorts } from "./setup-environment-adapter.js";
import type {
  CreateEnvironmentDependencies,
  CreateEnvironmentInstanceEntry
} from "./create-environment.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";

const unexpected = (): never => {
  throw new Error("Unexpected adapter dependency.");
};

function harness(overrides: Partial<CreateEnvironmentDependencies> = {}) {
  const dependencies: CreateEnvironmentDependencies = {
    isServerOwnedRequest: unexpected,
    getSelectedGitHubExecutor: unexpected,
    readInstanceEntry: unexpected,
    isValidRepoSlug: unexpected,
    getOperation: unexpected,
    isStale: unexpected,
    isTerminalState: unexpected,
    createOperation: unexpected,
    buildStages: unexpected,
    startOperation: unexpected,
    persistOperations: unexpected,
    reportOperationDiagnostic: unexpected,
    finishFailed: unexpected,
    enterStage: unexpected,
    errorMessage: unexpected,
    stageAuthorizeIdentity: "identity",
    stageConfigureEnvironment: "configure",
    namespaceClaimsFor: unexpected,
    cliExec: unexpected,
    readProcessEnv: unexpected,
    addLegacyStep: unexpected,
    finalizeSetupFailure: unexpected,
    persistMutationCheckpoint: unexpected,
    persistBestEffort: unexpected,
    guardStopBoundary: unexpected,
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
    now: unexpected,
    ...overrides
  };
  const finalized: Record<string, unknown>[] = [];
  const steps: string[] = [];
  const ports = createSetupEnvironmentPorts({
    dependencies,
    operation: { operationId: "setup-adapter" },
    selectedExecutor: successfulSelectedGhExecutor(),
    instanceId: "panel",
    provider: "azure",
    steps,
    stopBoundary: unexpected,
    checkpoint: unexpected,
    fail: unexpected,
    finalize: async (input) => {
      finalized.push(input);
      return "stopped";
    }
  });
  return { ports, finalized, steps };
}

describe("Canvas setup configuration adapter", () => {
  it("keeps package credentials request-local and refuses another request's opaque handle", async () => {
    const credentials = { username: "selected", credential: "fixture" };
    const requests: unknown[] = [];
    const overrides = {
      preflightGhcrPackageWriteAccess: async () => ({
        ok: true as const,
        credentials
      }),
      bootstrapGHCRStatePackage: async (input: unknown) => {
        requests.push(input);
        return { visibility: "private" };
      }
    };
    const first = harness(overrides);
    const second = harness(overrides);
    const handle = await first.ports.preflightPackages();
    await second.ports.preflightPackages();
    expect(typeof handle).toBe("symbol");
    if (handle === null) throw new Error("Expected package preflight success.");
    const request = {
      targetRepository: "octo/app",
      registry: "ghcr.io/octo/app/state",
      credentials: handle
    };
    await first.ports.bootstrapStatePackage(request);
    expect(requests).toEqual([{ ...request, credentials }]);
    expect(() => second.ports.bootstrapStatePackage(request)).toThrow(
      "The selected package credential is unavailable."
    );
    expect(requests).toHaveLength(1);
  });

  it("keeps package remediation in Canvas and propagates a stop honored during finalization", async () => {
    const h = harness({
      preflightGhcrPackageWriteAccess: async () => ({
        ok: false,
        status: 403,
        error: "Selected account needs package permission.",
        code: "package-permission"
      })
    });
    expect(await h.ports.preflightPackages()).toBeNull();
    expect(await h.ports.finalizeFailure({ kind: "package-access" })).toBe(
      "stopped"
    );
    expect(h.finalized).toEqual([
      {
        status: 403,
        error: "Selected account needs package permission.",
        code: "package-permission"
      }
    ]);
  });

  it("projects verification into the currently attached panel and tolerates a closed panel", () => {
    let entry: CreateEnvironmentInstanceEntry | undefined;
    const h = harness({ readInstanceEntry: () => entry });
    const verification = {
      dispatchedAt: 123,
      verifyRunId: "42",
      verifyRunUrl: "https://github.test/run/42"
    };
    h.ports.projectVerification(verification);
    entry = { state: {} };
    h.ports.projectVerification(verification);
    expect(entry.state).toEqual({
      deployDispatchedAt: 123,
      verifyRunId: "42",
      verifyRunUrl: "https://github.test/run/42"
    });
  });
});
