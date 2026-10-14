import { describe, expect, it, vi } from "vitest";
import { createOperation, enterStage, requestStop } from "../../operations.js";
import { guardStopBoundary } from "../../server.js";
import { isValidRepoSlug } from "../../azure-oidc.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { createCreateEnvironmentRoutes } from "../routes/create-environment.js";
import {
  createConfigureEnvironmentService,
  type ConfigureEnvironmentDependencies
} from "./configure-environment.js";

const unexpected = (): never => {
  throw new Error("Unexpected configuration dependency.");
};

function fixture() {
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

describe("transport-independent environment configuration", () => {
  it.each(
    Object.keys(fixture().dependencies).filter((name) => name !== "tempFile")
  )("rejects the missing required %s binding during construction", (name) => {
    const { dependencies } = fixture();
    Reflect.deleteProperty(dependencies, name);
    expect(() => createConfigureEnvironmentService(dependencies)).toThrow(
      `Missing environment configuration dependency: ${name}`
    );
    expect(() =>
      createCreateEnvironmentRoutes({
        ...dependencies,
        isServerOwnedRequest: () => true
      })
    ).toThrow(`Missing environment configuration dependency: ${name}`);
  });

  it.each([
    "ociStateBackend",
    "defaultStateArchive",
    "verifyWorkflowFile",
    "stageVerify",
    "stageAuthorizeIdentity",
    "stageConfigureEnvironment"
  ])("rejects an empty %s binding during construction", (name) => {
    const { dependencies } = fixture();
    Reflect.set(dependencies, name, "");
    expect(() => createConfigureEnvironmentService(dependencies)).toThrow(
      `Missing environment configuration dependency: ${name}`
    );
  });

  it.each(["write", "remove"])(
    "rejects a missing temporary-file %s binding during construction",
    (name) => {
      const { dependencies } = fixture();
      Reflect.deleteProperty(dependencies.tempFile, name);
      expect(() => createConfigureEnvironmentService(dependencies)).toThrow(
        `Missing environment configuration dependency: tempFile.${name}`
      );
    }
  );

  it("rejects a missing temporary-file port during construction", () => {
    const { dependencies } = fixture();
    Reflect.deleteProperty(dependencies, "tempFile");
    expect(() => createConfigureEnvironmentService(dependencies)).toThrow(
      "Missing environment configuration dependency: tempFile.write"
    );
  });

  it("requires the HTTP authorization gate even with a prebuilt service", () => {
    const { dependencies } = fixture();
    const service = createConfigureEnvironmentService(dependencies);
    const http = { ...dependencies, isServerOwnedRequest: () => true };
    Reflect.deleteProperty(http, "isServerOwnedRequest");
    expect(() => createCreateEnvironmentRoutes(http, service)).toThrow(
      "Missing environment configuration dependency: isServerOwnedRequest"
    );
  });

  it("reports a stop checkpoint failure without starting provider work", async () => {
    const test = fixture();
    requestStop(test.operation);
    test.dependencies.guardStopBoundary = guardStopBoundary;
    test.dependencies.persistOperations = vi.fn(async () => {
      throw new Error("Stop record unavailable");
    });
    const result = await createConfigureEnvironmentService(test.dependencies)(
      { data: test.data },
      "absent-panel"
    );
    expect(result).toMatchObject({
      kind: "stopped",
      status: 200,
      body: { boundary: "before-github-environment" }
    });
    expect(
      test.dependencies.reportOperationDiagnostic
    ).toHaveBeenCalledExactlyOnceWith({
      code: "operation-store-write-failed",
      message:
        "Could not persist setup operation op-configure: Stop record unavailable"
    });
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("composes without a panel and refuses a foreign operation before any finalization", async () => {
    const test = fixture();
    const result = await createConfigureEnvironmentService(test.dependencies)(
      { data: { ...test.data, operationId: "foreign" } },
      "absent-panel"
    );
    expect(result).toMatchObject({
      kind: "refused",
      status: 409,
      body: { code: "operation-continuation-mismatch" }
    });
    expect(test.finalize).not.toHaveBeenCalled();
    expect(test.dependencies.persistOperations).not.toHaveBeenCalled();
  });

  it("looks up the registered executor and finalizes an unavailable binding", async () => {
    const test = fixture();
    const selected = vi.fn(() => null);
    test.dependencies.getSelectedGitHubExecutor = selected;
    const result = await createConfigureEnvironmentService(test.dependencies)(
      { data: test.data },
      "absent-panel"
    );
    expect(selected).toHaveBeenCalledExactlyOnceWith(
      test.operation.operationId
    );
    expect(result).toMatchObject({
      kind: "failed",
      status: 400,
      body: {
        error:
          "The selected GitHub account executor is unavailable. Re-check the account and retry."
      }
    });
    expect(test.finalize).toHaveBeenCalledOnce();
    expect(test.finalize.mock.calls[0]?.[0]).toBe(test.operation);
  });

  it.each([
    "identity failure",
    Object.assign(new Error("identity failure"), { stack: "" })
  ])(
    "keeps original selected-account failure classification and cleanup ports for %s",
    async (error) => {
      const test = fixture();
      test.dependencies.getSelectedGitHubExecutor = () => ({
        ...successfulSelectedGhExecutor(),
        verifyIdentity: async () => {
          throw error;
        }
      });
      const az = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      test.dependencies.runAzCommand = az;
      test.dependencies.finalizeSetupFailure = vi.fn(async (_op, input) => {
        expect(input.evidence).toBeNull();
        expect(input.runDeleteEnvironment).toBeNull();
        const runAz = input.runAz;
        if (typeof runAz !== "function")
          throw new Error("Expected selected Azure cleanup runner");
        await runAz(["cleanup"]);
        return { status: 400, body: { error: "public identity failure" } };
      });
      const result = await createConfigureEnvironmentService(test.dependencies)(
        { data: test.data },
        "absent-panel"
      );
      expect(result.body.error).toBe("public identity failure");
      expect(az).toHaveBeenCalledExactlyOnceWith(["cleanup"]);
      expect(test.dependencies.finalizeSetupFailure).toHaveBeenCalledOnce();
    }
  );

  it("awaits cleanup and returns the prerequisite failure without repeating finalization", async () => {
    const test = fixture();
    test.dependencies.preflightRepoAdmin = async () => "not authorized";
    let reject: (error: Error) => void = unexpected;
    const cleanup = new Promise<never>((_resolve, failure) => {
      reject = failure;
    });
    test.dependencies.finalizeSetupFailure = vi.fn(() => cleanup);
    let settled = false;
    const pending = createConfigureEnvironmentService(test.dependencies)(
      { data: test.data },
      "absent-panel"
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(test.dependencies.finalizeSetupFailure).toHaveBeenCalledOnce()
    );
    expect(settled).toBe(false);
    reject(new Error("private cleanup failure"));
    expect(await pending).toMatchObject({
      kind: "failed",
      status: 500,
      body: { code: "setup-handler-failed" }
    });
    expect(test.dependencies.finalizeSetupFailure).toHaveBeenCalledOnce();
    expect(
      test.dependencies.reportOperationDiagnostic
    ).toHaveBeenCalledExactlyOnceWith({
      code: "setup-handler-failed",
      message: "private cleanup failure"
    });
  });

  it("honors a stop after identity failure, saving and reporting before returning", async () => {
    const test = fixture();
    test.dependencies.getSelectedGitHubExecutor = () => ({
      ...successfulSelectedGhExecutor(),
      verifyIdentity: async () => {
        throw new Error("identity changed");
      }
    });
    test.dependencies.guardStopBoundary = async (input) => {
      expect(input.boundary).toBe("before-setup-failure-cleanup");
      await input.persist();
      input.report({ code: "stopped", message: "Stopped safely." });
      input.respond(200, { cancelled: true });
      return false;
    };
    const result = await createConfigureEnvironmentService(test.dependencies)(
      { data: test.data },
      "absent-panel"
    );
    expect(result).toMatchObject({ kind: "stopped", status: 200 });
    expect(test.dependencies.persistOperations).toHaveBeenCalledOnce();
    expect(
      test.dependencies.reportOperationDiagnostic
    ).toHaveBeenCalledExactlyOnceWith({
      code: "stopped",
      message: "Stopped safely."
    });
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it.each([
    { stderr: "denied", stdout: "ignored", expected: "denied" },
    { stderr: "", stdout: "provider refused", expected: "provider refused" },
    { stderr: "", stdout: "", expected: "GitHub API request failed." },
    { stderr: "", stdout: "", expected: null }
  ])(
    "binds finalizer cleanup to the selected account ($expected)",
    async ({ stderr, stdout, expected }) => {
      const test = fixture();
      test.dependencies.preflightRepoAdmin = async () => "not authorized";
      const run = vi.fn(async () => ({
        code: expected === null ? 0 : 1,
        stdout,
        stderr
      }));
      test.dependencies.getSelectedGitHubExecutor = () =>
        successfulSelectedGhExecutor({ run });
      test.dependencies.finalizeSetupFailure = async (_op, input) => {
        const cleanup = input.runDeleteEnvironment;
        const variable = input.runGitHubVariable;
        if (typeof cleanup !== "function" || typeof variable !== "function")
          throw new Error("Missing cleanup runners");
        if (expected === null)
          await expect(cleanup(["delete"])).resolves.toBeUndefined();
        else await expect(cleanup(["delete"])).rejects.toThrow(expected);
        await variable(["variable"]);
        return { status: 403, body: { error: "not authorized" } };
      };
      expect(
        await createConfigureEnvironmentService(test.dependencies)(
          { data: test.data },
          "absent-panel"
        )
      ).toMatchObject({ kind: "failed", status: 403 });
      expect(run.mock.calls).toEqual([
        [["delete"]],
        [["variable"], { timeout: 20000 }]
      ]);
    }
  );
});
