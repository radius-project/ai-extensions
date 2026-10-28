import { describe, expect, it, vi } from "vitest";
import { createWorkflowFileCommitter } from "@radius-project/core";
import { createSetupEnvironmentPorts } from "./setup-environment-adapter.js";
import { persistBestEffort } from "../services/setup-checkpoint.js";
import type {
  ConfigureEnvironmentDependencies,
  CreateEnvironmentInstanceEntry
} from "../services/configure-environment.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";

const unexpected = (): never => {
  throw new Error("Unexpected adapter dependency.");
};

function harness(
  overrides: Partial<ConfigureEnvironmentDependencies> = {},
  bindings: Partial<
    Pick<
      Parameters<typeof createSetupEnvironmentPorts>[0],
      "provider" | "finalize" | "instanceId" | "isCurrentPresentation"
    >
  > = {}
) {
  const dependencies: ConfigureEnvironmentDependencies = {
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
      finalized.push({ ...input });
      return "stopped";
    },
    ...bindings
  });
  return { ports, finalized, steps };
}

describe("Canvas setup configuration adapter", () => {
  it.each([
    [null, null, "the setup branch", "the default branch"],
    ["", "", "the setup branch", "the default branch"],
    ["setup/topic", "trunk", "setup/topic", "trunk"]
  ])(
    "preserves nullable publication identity and actionable merge guidance",
    (branch, baseBranch, displayBranch, displayBase) => {
      const finish = vi.fn();
      const { ports } = harness({ finish });
      ports.finishMergeRequired({
        outcome: "awaiting-merge",
        pullRequestUrl: null,
        branch,
        baseBranch
      });
      expect(finish).toHaveBeenCalledExactlyOnceWith(
        { operationId: "setup-adapter" },
        "action_required",
        {
          terminal: {
            reason: "pr-merge-required",
            pullRequestUrl: null,
            branch,
            baseBranch,
            userMessage: `Open and merge a pull request from "${displayBranch}" into "${displayBase}" to finish setup.`
          }
        }
      );
    }
  );

  it.each(["azure", "aws"])(
    "preserves repository-refusal cleanup execution for %s",
    async (provider) => {
      const calls: string[][] = [];
      const cleanupResult = { code: 0, stdout: "removed", stderr: "" };
      const cleanupArgs = ["ad", "app", "delete", "--id", "owned-application"];
      const finalized: Record<string, unknown>[] = [];
      const h = harness(
        {
          preflightRepoAdmin: async () => "Repository admin access was lost.",
          runAzCommand: async (args) => {
            calls.push(args);
            return cleanupResult;
          }
        },
        {
          provider,
          finalize: async (input) => {
            finalized.push({ ...input });
            if (provider === "azure") {
              if (typeof input.runAz !== "function")
                throw new Error("Azure cleanup runner is missing.");
              expect(await input.runAz(cleanupArgs)).toEqual(cleanupResult);
            } else {
              expect(input.runAz).toBeNull();
            }
            return "failed";
          }
        }
      );

      expect(await h.ports.preflightRepository("octo/app")).toBe(false);
      expect(await h.ports.finalizeFailure({ kind: "repository-access" })).toBe(
        "failed"
      );
      expect(finalized).toEqual([
        expect.objectContaining({
          status: 403,
          code: "repo-admin-required",
          error: "Repository admin access was lost.",
          stage: "configure",
          classification: "needs-someone-else"
        })
      ]);
      expect(calls).toEqual(provider === "azure" ? [cleanupArgs] : []);
    }
  );

  it("preserves the protected-branch refusal and adapter-formatted fallback failure", async () => {
    const formatted: unknown[] = [];
    const removed: string[] = [];
    const h = harness({
      getDefaultBranch: async () => "trunk",
      getBranchHeadSha: async (_repo, branch) => {
        expect(branch).toBe("trunk");
        return null;
      },
      errorMessage: (error) => {
        formatted.push(error);
        if (!(error instanceof Error)) throw new Error("Expected an Error.");
        return `Selected account: ${error.message}`;
      },
      tempFile: {
        write: () => "workflow-body.json",
        remove: (path) => removed.push(path)
      }
    });
    const target = { targetRepo: "octo/app", envName: "dev" };
    const command = ["api", "--method", "PUT", "/repos/octo/app/contents/p"];
    const committer = createWorkflowFileCommitter(
      h.ports.workflowFiles({
        ...target,
        runGh: async (args) => {
          expect(args).toEqual([
            "api",
            "/repos/octo/app/contents/p",
            "--jq",
            ".sha"
          ]);
          return { code: 1, stdout: "", stderr: "HTTP 404" };
        },
        runGhWorkflow: async (args) => {
          expect(args).toEqual([...command, "--input", "workflow-body.json"]);
          return { code: 1, stdout: "", stderr: "protected branch" };
        }
      }),
      target
    );

    await expect(
      committer.commitWorkflowFileSmart(
        "p",
        Buffer.from("workflow").toString("base64"),
        "Add workflow"
      )
    ).resolves.toMatchObject({
      ok: false,
      viaPr: false,
      stderr:
        'protected branch (PR fallback failed: Selected account: could not resolve head of base branch "trunk")'
    });
    expect(formatted).toHaveLength(1);
    expect(removed).toEqual(["workflow-body.json"]);
    expect(committer.pullRequestState()).toBeUndefined();
  });

  it("reports a final best-effort save failure after recording incomplete credentials", async () => {
    const diagnostics: unknown[] = [];
    const events: string[] = [];
    let terminal = false;
    const h = harness({
      persistBestEffort,
      persistOperations: async () => {
        events.push("persist");
        if (terminal) throw new Error("disk full");
      },
      reportOperationDiagnostic: (diagnostic) => {
        events.push("diagnostic");
        diagnostics.push(diagnostic);
      },
      finish: (_operation, state, options) => {
        expect(state).toBe("action_required");
        expect(options).toMatchObject({
          terminal: { reason: "credentials-incomplete", pullRequestUrl: null }
        });
        events.push("terminal");
        terminal = true;
      }
    });

    await h.ports.recovery.persist();
    h.ports.finishCredentialsIncomplete({
      provider: "azure",
      pullRequestUrl: null
    });
    await expect(h.ports.persistBestEffort()).resolves.toBe(false);

    expect(events).toEqual(["persist", "terminal", "persist", "diagnostic"]);
    expect(diagnostics).toEqual([
      {
        code: "operation-store-write-failed",
        message: "Could not persist setup operation setup-adapter: disk full"
      }
    ]);
  });

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
      credentials: handle,
      assertActive: () => {}
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

  it("does not resolve a presentation when setup has no panel", () => {
    const readInstanceEntry = vi.fn(unexpected);
    const h = harness({ readInstanceEntry }, { instanceId: undefined });
    h.ports.projectVerification({
      dispatchedAt: 123,
      verifyRunId: "42",
      verifyRunUrl: "https://github.test/run/42"
    });
    expect(readInstanceEntry).not.toHaveBeenCalled();
  });

  it("does not publish verification into a replaced presentation", () => {
    let current = true;
    let entry: CreateEnvironmentInstanceEntry = { state: {} };
    const readInstanceEntry = vi.fn(() => entry);
    const h = harness(
      { readInstanceEntry },
      { isCurrentPresentation: () => current }
    );
    const verification = {
      dispatchedAt: 123,
      verifyRunId: "42",
      verifyRunUrl: "https://github.test/run/42"
    };
    h.ports.projectVerification(verification);
    expect(entry.state.verifyRunId).toBe("42");
    current = false;
    entry = { state: {} };
    h.ports.projectVerification(verification);
    expect(entry.state).toEqual({});
    expect(readInstanceEntry).toHaveBeenCalledOnce();
  });
});
