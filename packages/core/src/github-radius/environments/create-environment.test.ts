import { describe, expect, it } from "vitest";
import {
  createOperation,
  operationDomain
} from "../../../test/support/environment-operation-domain.js";
import {
  runCreateEnvironment,
  type CreateEnvironmentDependencies
} from "./create-environment.js";
import type { CreateEnvironmentOperation } from "./create-environment-types.js";
import type { SelectedGhExecutor } from "./execution-ports.js";
import { environmentSetupContinuations } from "./environment-operation.js";
import type { AzureAutoSetupDependencies } from "./azure-auto-setup-types.js";

function unexpected(): never {
  throw new Error("Unexpected external operation");
}

function harness(provider = "azure") {
  const events: string[] = [];
  const variables: Record<string, string | undefined> = {};
  const operation: CreateEnvironmentOperation = {
    providerRecovery: createOperation().providerRecovery,
    operationId: "op-independent",
    repo: "octo/app",
    environment: "dev",
    provider,
    currentStage: "configure",
    state: "running",
    stages: [],
    steps: []
  };
  const executor: SelectedGhExecutor = {
    login: "octocat",
    credentialSource: "keyring",
    requiresKeyringSwitch: false,
    scopes: ["repo", "workflow", "write:packages"],
    run: unexpected,
    runOrThrow: unexpected,
    verifyIdentity: async () => {
      events.push("identity");
    },
    packageCredentials: unexpected,
    redact: (value) => value,
    errorMessage: (error) => String(error)
  };
  const dependencies: CreateEnvironmentDependencies = {
    operationDomain,
    legacyDeployWorkflowFile: "radius-deploy.yml",
    isValidRepoSlug: (repo) => repo === "octo/app",
    getOperation: () => operation,
    isStale: () => false,
    isTerminalState: (state) => state === "failed",
    createOperation: () => operation,
    buildStages: () => [],
    startOperation: () => ({ ok: true }),
    persistOperations: async () => {
      events.push("persist");
    },
    reportOperationDiagnostic: unexpected,
    finishFailed: unexpected,
    enterStage: (op, stage) => {
      op.currentStage = stage;
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    stageAuthorizeIdentity: "authorize",
    stageConfigureEnvironment: "configure",
    namespaceClaimsFor: () => ({
      listEnvironmentNames: async () => ({ ok: true, names: [] }),
      readEnvironmentVariables: unexpected
    }),
    getSelectedGitHubExecutor: () => executor,
    addLegacyStep: (_op, message) => {
      events.push(message);
    },
    finalizeSetupFailure: async (_op, input) => ({
      status: Number(input.status),
      body: { error: input.error, code: input.code }
    }),
    persistMutationCheckpoint: async (input) => {
      await input.persist();
      return true;
    },
    persistBestEffort: async (input) => {
      await input.persist();
      return true;
    },
    guardStopBoundary: async ({ boundary }) => {
      events.push(boundary);
      return true;
    },
    runAzCommand: unexpected,
    preflightRepoAdmin: async () => {
      events.push("admin");
      return "";
    },
    preflightGhcrPackageWriteAccess: async () => ({
      ok: true,
      credentials: {
        username: "octocat",
        token: "synthetic-package-credential"
      }
    }),
    readGitHubJson: async () => ({
      ok: true,
      status: 200,
      json: { name: "dev", id: 12 }
    }),
    bootstrapGHCRStatePackage: async () => {
      events.push("package");
      return { visibility: "private" };
    },
    stateRegistryForEnvironment: () => "ghcr.io/octo/app/dev",
    getDefaultBranch: async () => "trunk",
    fetchFileFromRepoResult: async () => ({
      content: null,
      error: null,
      status: 404
    }),
    getBranchHeadSha: unexpected,
    createBranchRef: unexpected,
    tempFile: { write: unexpected, remove: unexpected },
    setCanonicalEnvironment: (_op, name) => {
      events.push(`canonical:${name}`);
    },
    recordGitHubEnvironment: (_op, patch) => {
      events.push(`environment:${patch.state}`);
    },
    recordGitHubEnvironmentVariable: unexpected,
    promoteCreatedGitHubEnvironment: unexpected,
    envListCacheDelete: () => {
      events.push("invalidate");
    },
    ociStateBackend: "oci",
    defaultStateArchive: "state",
    azureCredential: () => ({
      clientId: "client",
      tenantId: "tenant",
      subscriptionId: "subscription"
    }),
    awsCredential: () => ({ roleArn: "synthetic-role" }),
    optionalString: (value) => (typeof value === "string" ? value : ""),
    generateVerifyWorkflow: async () => "verify",
    generateDeployWorkflow: async () => ({ "radius-deploy-dev.yml": "deploy" }),
    generateDeleteWorkflow: async () => ({ "radius-delete-dev.yml": "delete" }),
    recordCommittedWorkflowFile: (_op, entry) => {
      events.push(`record:${entry.path}`);
    },
    deleteLegacyDeployWorkflow: async () => false,
    createPullRequestApi: unexpected,
    planCredentialVerification: async () => ({
      shouldDispatch: false,
      trigger: "none",
      ref: "trunk",
      defaultBranch: "trunk",
      pullRequestUrl: "",
      skipReason: "Merge the workflow first."
    }),
    fetchFileFromRepo: unexpected,
    buildVerifyWorkflowDispatchArgs: unexpected,
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify",
    recordCleanupState: (_op, patch) => {
      events.push(`cleanup:${patch.state}`);
    },
    recordCommitState: () => {
      events.push("commit-state");
    },
    setStageState: (_op, stage, state) => {
      events.push(`${stage}:${state}`);
    },
    finish: (op, state) => {
      op.state = state;
    },
    sleep: unexpected,
    now: () => 1_800_000_000_000,
    verificationDispatched: () => {
      events.push("verification-state");
    },
    createWorkflowScopeGhRunner: () => ({
      runGh: unexpected,
      runGhOrThrow: unexpected,
      runGhWorkflow: unexpected,
      setEnvironmentVariable: async (name, value) => {
        variables[name] = value;
        events.push(`variable:${name}`);
        return true;
      }
    }),
    createWorkflowFileCommitter: () => ({
      pullRequestState: () => undefined,
      commitWorkflowFileSmart: async (path) => {
        events.push(`publish:${path}`);
        return { ok: true, changed: true, viaPr: false };
      }
    })
  };
  return { dependencies, operation, events, variables, executor };
}

describe("independent environment setup coordinator", () => {
  it("composes the real coordinators for an independent caller without HTTP or Canvas state", async () => {
    const test = harness();
    const azure: AzureAutoSetupDependencies = {
      operationDomain,
      deterministicProviderUuid: unexpected,
      operations: {
        get: unexpected,
        isStale: unexpected,
        create: unexpected,
        buildStages: unexpected,
        start: unexpected,
        persist: unexpected,
        report: unexpected,
        finish: unexpected,
        enterStage: unexpected,
        setStageState: unexpected,
        hasWarnings: unexpected,
        addLegacyStep: unexpected,
        setContext: unexpected,
        setCloudContext: unexpected,
        requireInput: unexpected,
        resumeAfterInput: unexpected,
        withCredentialProvenanceLock: unexpected,
        recordAzureApp: unexpected,
        recordServicePrincipal: unexpected,
        recordCreatedFederatedCredential: unexpected,
        recordFederatedCredentialProvenance: unexpected,
        recordCreatedRoleAssignment: unexpected
      },
      external: {
        getSelectedGitHubExecutor: unexpected,
        getGitHubIdentity: unexpected,
        preflightRepoAdmin: unexpected,
        preflightGhcrPackageWriteAccess: unexpected,
        runGitHubJson: unexpected,
        runAz: unexpected
      },
      tempFile: {
        createPath: unexpected,
        write: unexpected,
        remove: unexpected
      },
      ensureServicePrincipal: unexpected,
      finalizeSetupFailure: async (_operation, failure) => ({
        status: failure.status,
        body: { error: failure.error, code: failure.code }
      }),
      persistMutationCheckpoint: unexpected,
      honorStopBoundary: async () => true,
      sleep: unexpected,
      stageAuthorizeIdentity: "authorize"
    };
    const continuations = environmentSetupContinuations({
      azure,
      environment: test.dependencies
    });
    await expect(continuations.provisionAzureCredentials({})).rejects.toThrow(
      /required/i
    );
    await expect(
      continuations.configureEnvironment({
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        resourceGroup: "rg",
        cluster: "cluster",
        namespace: "isolated"
      })
    ).resolves.toMatchObject({ success: true });
    expect(test.events).toContain(
      "publish:.github/workflows/radius-verify-credentials.yml"
    );
  });

  it("preserves a custom committer diagnostic when optional delete-workflow publication fails", async () => {
    const test = harness();
    test.dependencies.createWorkflowFileCommitter = (ports) => ({
      pullRequestState: () => undefined,
      commitWorkflowFileSmart: async (path) => {
        if (path.includes("radius-delete")) {
          throw new Error(
            ports.errorMessage(new Error("Delete workflow access denied"))
          );
        }
        return { ok: true, changed: true, viaPr: false };
      }
    });
    const result = await runCreateEnvironment(
      {
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        resourceGroup: "rg",
        cluster: "cluster",
        namespace: "isolated"
      },
      test.dependencies
    );
    expect(result.body.success).toBe(true);
    expect(result.body.steps).toContain(
      "⚠️ Could not generate/commit delete workflows: Delete workflow access denied"
    );
  });

  it("reports terminal persistence failure while preserving incomplete-credential guidance", async () => {
    const test = harness();
    const diagnostics: object[] = [];
    test.dependencies.azureCredential = () => ({});
    test.dependencies.planCredentialVerification = async () => ({
      shouldDispatch: true,
      trigger: "workflow_dispatch",
      ref: "trunk",
      defaultBranch: "trunk",
      pullRequestUrl: "",
      skipReason: ""
    });
    test.dependencies.reportOperationDiagnostic = (diagnostic) => {
      diagnostics.push(diagnostic);
    };
    test.dependencies.persistBestEffort = async ({ persist, report }) => {
      await persist();
      report({ code: "persist-failed", message: "Save unavailable" });
      return false;
    };
    const result = await runCreateEnvironment(
      {
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        resourceGroup: "rg",
        cluster: "cluster",
        namespace: "isolated"
      },
      test.dependencies
    );
    expect(result.body).toMatchObject({ success: true, verifySkipped: true });
    expect(result.body.verifySkipReason).toContain("not fully configured");
    expect(diagnostics).toEqual([
      { code: "persist-failed", message: "Save unavailable" }
    ]);
    expect(test.operation.state).toBe("action_required");
  });

  it("honors Stop arriving after pull-request intent is persisted without opening a pull request", async () => {
    const test = harness();
    test.dependencies.createWorkflowFileCommitter = () => ({
      pullRequestState: () => ({ branch: "setup-dev", base: "trunk" }),
      commitWorkflowFileSmart: async () => ({
        ok: true,
        changed: true,
        viaPr: true
      })
    });
    test.dependencies.persistOperations = async () => {
      if (
        operationDomain
          .providerMutationsByKind(test.operation, "github_pull_request.create")
          .some((mutation) => mutation.status === "prepared")
      ) {
        operationDomain.requestStop(test.operation);
      }
    };
    test.dependencies.guardStopBoundary = async ({ respond }) => {
      if (!operationDomain.shouldStop(test.operation)) return true;
      respond(200, { cancelled: true, code: "operation-stopped" });
      return false;
    };
    const result = await runCreateEnvironment(
      {
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        resourceGroup: "rg",
        cluster: "cluster",
        namespace: "isolated"
      },
      test.dependencies
    );
    expect(result.outcome).toBe("cancelled");
    expect(
      operationDomain.providerMutationsByKind(
        test.operation,
        "github_pull_request.create"
      )
    ).toEqual([expect.objectContaining({ status: "not_applied" })]);
  });

  it.each(["azure", "aws"])(
    "configures %s and publishes workflows without a Canvas host",
    async (provider) => {
      const test = harness(provider);
      const result = await runCreateEnvironment(
        {
          repo: "octo/app",
          environment: "dev",
          provider,
          resourceGroup: "rg",
          cluster: "cluster",
          namespace: "isolated"
        },
        test.dependencies
      );
      expect(result.body).toMatchObject({
        success: true,
        environment: "dev",
        provider,
        actionRequired: true
      });
      expect(result.outcome).toBe("action_required");
      expect(test.operation.state).toBe("action_required");
      expect(test.variables.RADIUS_MANAGED).toBe("true");
      expect(test.events.indexOf("identity")).toBeLessThan(
        test.events.indexOf("package")
      );
      expect(test.events).toContain(
        "publish:.github/workflows/radius-verify-credentials.yml"
      );
      expect(test.events).toContain("cleanup:not_needed");
    }
  );

  it("refuses a mismatched operation before selecting credentials or mutating providers", async () => {
    const test = harness();
    test.operation.environment = "production";
    const result = await runCreateEnvironment(
      {
        repo: "octo/app",
        environment: "dev",
        operationId: test.operation.operationId
      },
      test.dependencies
    );
    expect(result.body.code).toBe("operation-continuation-mismatch");
    expect(test.events).toEqual([]);
  });

  it("stops at a checkpoint without publishing later resources", async () => {
    const test = harness();
    test.dependencies.guardStopBoundary = async ({ boundary, respond }) => {
      if (boundary !== "after-ghcr-state-package") return true;
      respond(200, { cancelled: true, code: "operation-stopped", boundary });
      return false;
    };
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.outcome).toBe("cancelled");
    expect(test.events).toContain("package");
    expect(test.events.some((entry) => entry.startsWith("publish:"))).toBe(
      false
    );
  });

  it("reports provider failure without publishing workflows or pretending success", async () => {
    const test = harness();
    test.dependencies.bootstrapGHCRStatePackage = async () => {
      throw new Error("registry unavailable");
    };
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.outcome).toBe("failed");
    expect(result.body.error).toBe("registry unavailable");
    expect(test.events.some((entry) => entry.startsWith("publish:"))).toBe(
      false
    );
  });

  it.each([
    "admin-refusal",
    "default-branch-refusal",
    "provider-failure"
  ] as const)(
    "keeps cleanup commands pinned to the selected identities after %s",
    async (failurePoint) => {
      const test = harness();
      const commands: Array<{ args: string[]; timeout?: number }> = [];
      const azure: string[][] = [];
      test.executor.run = async (args, options) => {
        commands.push({ args, timeout: options?.timeout });
        if (args[0] === "refused")
          return { code: 1, stdout: "denied", stderr: "" };
        if (args[0] === "empty") return { code: 1, stdout: "", stderr: "" };
        return {
          code: "0",
          stdout: '{"id":"environment-id","name":"dev"}',
          stderr: ""
        };
      };
      test.dependencies.runAzCommand = async (args) => {
        azure.push(args);
        return { code: 0 };
      };
      if (failurePoint === "admin-refusal")
        test.dependencies.preflightRepoAdmin = async () => "Admin required";
      if (failurePoint === "default-branch-refusal")
        test.dependencies.getDefaultBranch = async () => null;
      if (failurePoint === "provider-failure")
        test.dependencies.bootstrapGHCRStatePackage = async () => {
          throw new Error("registry unavailable");
        };
      test.dependencies.finalizeSetupFailure = async (_operation, input) => {
        if (
          typeof input.runAz !== "function" ||
          typeof input.runGitHubVariable !== "function" ||
          typeof input.runDeleteEnvironment !== "function" ||
          typeof input.readEnvironment !== "function"
        ) {
          throw new Error("Cleanup must receive the pinned external ports.");
        }
        await input.runAz(["ad", "app", "show"]);
        await input.runGitHubVariable(["variable", "list"]);
        await input.runDeleteEnvironment(["api", "delete-exact"]);
        await expect(input.runDeleteEnvironment(["refused"])).rejects.toThrow(
          "denied"
        );
        await expect(input.runDeleteEnvironment(["empty"])).rejects.toThrow(
          "GitHub API request failed."
        );
        await input.readEnvironment(["api", "read-exact"]);
        return {
          status: Number(input.status),
          body: { code: input.code, error: input.error }
        };
      };
      const result = await runCreateEnvironment(
        { repo: "octo/app" },
        test.dependencies
      );
      expect(result.outcome).toBe("failed");
      expect(azure).toEqual([["ad", "app", "show"]]);
      expect(commands).toContainEqual({
        args: ["variable", "list"],
        timeout: 20000
      });
      expect(commands.map((command) => command.args)).toContainEqual([
        "api",
        "read-exact"
      ]);
      expect(test.events.some((entry) => entry.startsWith("publish:"))).toBe(
        false
      );
    }
  );

  it.each(["before-github-environment", "before-setup-failure-cleanup"])(
    "passes persistence and diagnostic ports through cancellation at %s",
    async (stopAt) => {
      const test = harness();
      const diagnostics: object[] = [];
      test.dependencies.reportOperationDiagnostic = (diagnostic) => {
        diagnostics.push(diagnostic);
      };
      if (stopAt === "before-setup-failure-cleanup") {
        test.executor.verifyIdentity = async () => {
          throw new Error("identity unavailable");
        };
      }
      test.dependencies.guardStopBoundary = async ({
        boundary,
        persist,
        report,
        respond
      }) => {
        if (boundary !== stopAt) return true;
        await persist();
        report({
          code: "stop-persisted",
          message: "Stop recorded before cleanup."
        });
        respond(200, { cancelled: true });
        return false;
      };
      expect(
        (await runCreateEnvironment({ repo: "octo/app" }, test.dependencies))
          .outcome
      ).toBe("cancelled");
      expect(diagnostics).toEqual([
        { code: "stop-persisted", message: "Stop recorded before cleanup." }
      ]);
      expect(test.events).toContain("persist");
      expect(test.events).not.toContain("package");
    }
  );

  it("reports failed best-effort terminal persistence without losing action-required guidance", async () => {
    const test = harness();
    const diagnostics: object[] = [];
    test.dependencies.reportOperationDiagnostic = (diagnostic) => {
      diagnostics.push(diagnostic);
    };
    test.dependencies.persistBestEffort = async ({ persist, report }) => {
      await persist();
      report({
        code: "terminal-save-retry",
        message: "Retry saving the terminal record."
      });
      return false;
    };
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.outcome).toBe("action_required");
    expect(diagnostics).toEqual([
      {
        code: "terminal-save-retry",
        message: "Retry saving the terminal record."
      }
    ]);
  });

  describe("pull-request reconciliation", () => {
    const matchingPullRequest = {
      html_url: "https://github.com/octo/app/pull/23",
      number: 23,
      head: { ref: "setup-dev" },
      base: { ref: "trunk" }
    };

    function recoveringPullRequest() {
      const test = harness();
      operationDomain.prepareProviderMutation(test.operation, {
        kind: "github_pull_request.create",
        target: "octo/app:setup-dev:trunk"
      });
      test.dependencies.createWorkflowFileCommitter = () => ({
        pullRequestState: () => ({ branch: "setup-dev", base: "trunk" }),
        commitWorkflowFileSmart: async () => ({
          ok: true,
          changed: false,
          viaPr: true
        })
      });
      return test;
    }

    it.each([
      null,
      "untrusted",
      {},
      { ...matchingPullRequest, html_url: 42 },
      { ...matchingPullRequest, number: "23" },
      { ...matchingPullRequest, head: undefined },
      { ...matchingPullRequest, head: null },
      { ...matchingPullRequest, head: "setup-dev" },
      { ...matchingPullRequest, head: {} },
      { ...matchingPullRequest, head: { ref: "another-setup" } },
      { ...matchingPullRequest, base: undefined },
      { ...matchingPullRequest, base: null },
      { ...matchingPullRequest, base: "trunk" },
      { ...matchingPullRequest, base: {} },
      { ...matchingPullRequest, base: { ref: "another-base" } }
    ])(
      "ignores nonmatching provider records and adopts only the exact pull request (%j)",
      async (unrelated) => {
        const test = recoveringPullRequest();
        const queries: string[][] = [];
        test.dependencies.createWorkflowScopeGhRunner = () => ({
          runGh: async (args) => {
            queries.push(args);
            return {
              code: "0",
              stdout: JSON.stringify([unrelated, matchingPullRequest]),
              stderr: ""
            };
          },
          runGhOrThrow: unexpected,
          runGhWorkflow: unexpected,
          setEnvironmentVariable: unexpected
        });
        const result = await runCreateEnvironment(
          { repo: "octo/app" },
          test.dependencies
        );
        expect(result.body).toMatchObject({
          success: true,
          pullRequestUrl: matchingPullRequest.html_url
        });
        expect(queries).toEqual([
          [
            "api",
            "/repos/octo/app/pulls?state=open&head=setup-dev&base=trunk&per_page=10"
          ]
        ]);
        expect(
          operationDomain.providerMutationsByKind(
            test.operation,
            "github_pull_request.create"
          )
        ).toEqual([expect.objectContaining({ status: "confirmed" })]);
        expect(test.events).not.toContain("package");
      }
    );

    it.each([
      { stdout: "[]", state: "not_applied" },
      { stdout: "{}", state: "not_applied" },
      {
        stdout: JSON.stringify([matchingPullRequest, matchingPullRequest]),
        state: "manual_required"
      },
      { stdout: "{", state: "outcome_unknown" }
    ])(
      "does not replay a create when the read-back is $state ($stdout)",
      async ({ stdout, state }) => {
        const test = recoveringPullRequest();
        test.dependencies.createWorkflowScopeGhRunner = () => ({
          runGh: async () => ({ code: 0, stdout, stderr: "" }),
          runGhOrThrow: unexpected,
          runGhWorkflow: unexpected,
          setEnvironmentVariable: unexpected
        });
        const result = await runCreateEnvironment(
          { repo: "octo/app" },
          test.dependencies
        );
        expect(
          operationDomain.providerMutationsByKind(
            test.operation,
            "github_pull_request.create"
          )
        ).toEqual([expect.objectContaining({ status: state })]);
        if (state === "not_applied") {
          expect(result.body).toMatchObject({
            success: true,
            pullRequestUrl: ""
          });
          expect(result.body.steps).toContainEqual(
            expect.stringContaining("Open one manually")
          );
        } else {
          expect(result.body.code).toBe(
            state === "manual_required" ?
              "provider-mutation-manual-required"
            : "provider-mutation-outcome-unknown"
          );
        }
      }
    );

    it.each([
      {
        stderr: "GitHub unavailable",
        stdout: "",
        detail: "GitHub unavailable"
      },
      { stderr: "", stdout: "Read failed", detail: "Read failed" },
      {
        stderr: "",
        stdout: "",
        detail: "GitHub pull requests could not be read."
      }
    ])(
      "preserves an unreadable pull-request outcome ($detail)",
      async ({ stderr, stdout, detail }) => {
        const test = recoveringPullRequest();
        test.dependencies.createWorkflowScopeGhRunner = () => ({
          runGh: async () => ({ code: 1, stdout, stderr }),
          runGhOrThrow: unexpected,
          runGhWorkflow: unexpected,
          setEnvironmentVariable: unexpected
        });
        const result = await runCreateEnvironment(
          { repo: "octo/app" },
          test.dependencies
        );
        expect(result.status).toBe(202);
        expect(
          operationDomain.providerMutationsByKind(
            test.operation,
            "github_pull_request.create"
          )
        ).toEqual([
          expect.objectContaining({
            status: "outcome_unknown",
            evidence: `Provider state could not be read: ${detail}`
          })
        ]);
        expect(result.body.reconciling).toBe(true);
      }
    );

    it("retains merge guidance when the matching pull request omits its URL", async () => {
      const test = recoveringPullRequest();
      test.dependencies.createWorkflowScopeGhRunner = () => ({
        runGh: async () => ({
          code: 0,
          stdout: JSON.stringify([{ ...matchingPullRequest, html_url: "" }]),
          stderr: ""
        }),
        runGhOrThrow: unexpected,
        runGhWorkflow: unexpected,
        setEnvironmentVariable: unexpected
      });
      const result = await runCreateEnvironment(
        { repo: "octo/app" },
        test.dependencies
      );
      expect(result.body).toMatchObject({
        actionRequired: true,
        pullRequestUrl: "",
        pullRequestBranch: "setup-dev"
      });
      expect(
        operationDomain.unresolvedProviderMutations(test.operation)
      ).toEqual([]);
    });
  });

  it.each<Record<string, string | number | boolean | null>>([
    {},
    { name: "RADIUS_MANAGED" },
    { name: 12, value: "true" },
    { name: "RADIUS_MANAGED", value: false }
  ])(
    "requires manual recovery for incomplete saved variable intent (%j)",
    async (intent) => {
      const test = harness();
      operationDomain.prepareProviderMutation(test.operation, {
        kind: "github_environment_variable.put",
        target: "octo/app:dev:RADIUS_MANAGED",
        intent
      });
      const result = await runCreateEnvironment(
        { repo: "octo/app" },
        test.dependencies
      );
      expect(result.body.code).toBe("provider-mutation-manual-required");
      expect(
        operationDomain.providerMutationsByKind(
          test.operation,
          "github_environment_variable.put"
        )
      ).toEqual([expect.objectContaining({ status: "manual_required" })]);
      expect(test.variables).toEqual({});
      expect(test.events).not.toContain("package");
    }
  );

  it("keeps setup successful when operation narration throws", async () => {
    const test = harness();
    test.dependencies.addLegacyStep = () => {
      throw new Error("Narration unavailable");
    };
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.body.success).toBe(true);
    expect(result.body.steps).toContain(
      '✅ GitHub environment "dev" resolved.'
    );
    expect(test.variables.RADIUS_MANAGED).toBe("true");
  });

  it("fails closed when the selected account disappears after admission", async () => {
    const test = harness();
    test.dependencies.getSelectedGitHubExecutor = () => null;
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.body.error).toContain(
      "The selected GitHub account executor is unavailable"
    );
    expect(test.events).not.toContain("identity");
    expect(test.events).not.toContain("package");
  });

  it("honors Stop between administration and package authorization", async () => {
    const test = harness();
    test.dependencies.guardStopBoundary = async ({ boundary, respond }) => {
      if (boundary !== "before-ghcr-bootstrap") return true;
      respond(200, { cancelled: true });
      return false;
    };
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.outcome).toBe("cancelled");
    expect(test.events).toContain("admin");
    expect(test.events).not.toContain("package");
  });

  it("refuses completion after an optional workflow write remains unresolved", async () => {
    const test = harness();
    test.dependencies.createWorkflowFileCommitter = () => ({
      pullRequestState: () => undefined,
      commitWorkflowFileSmart: async (path) => {
        if (path.includes("radius-delete")) {
          operationDomain.prepareProviderMutation(test.operation, {
            kind: "github_workflow.put",
            target: `octo/app:trunk:${path}`
          });
          throw new Error(
            "Provider disconnected before acknowledging the write"
          );
        }
        return { ok: true, changed: true, viaPr: false };
      }
    });
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("provider-reconciliation-pending");
    expect(test.events).not.toContain("verification-state");
  });

  it("does not authorize a workflow mutation while Stop awaits reconciliation", async () => {
    const test = harness();
    test.dependencies.createWorkflowFileCommitter = (ports) => ({
      pullRequestState: () => undefined,
      commitWorkflowFileSmart: async () => {
        operationDomain.prepareProviderMutation(test.operation, {
          kind: "github_workflow.put",
          target: "octo/app:trunk:workflow"
        });
        operationDomain.requestStop(test.operation);
        await ports.mutationRecovery?.beforeMutation?.(
          "github_workflow.put",
          "octo/app:trunk:workflow"
        );
        throw new Error("A new workflow write must not be authorized");
      }
    });
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.status).toBe(202);
    expect(result.body.message).toContain(
      "Radius must reconcile the existing provider request"
    );
    expect(test.operation.state).toBe("running");
  });

  it("continues setup after a saved variable reconciliation checkpoint", async () => {
    const test = harness();
    const pending = operationDomain.prepareProviderMutation(test.operation, {
      kind: "github_environment_variable.put",
      target: "octo/app:dev:RADIUS_MANAGED",
      intent: { name: "RADIUS_MANAGED", value: "true" }
    });
    test.dependencies.createWorkflowScopeGhRunner = () => ({
      runGh: unexpected,
      runGhOrThrow: unexpected,
      runGhWorkflow: unexpected,
      setEnvironmentVariable: async (name, value) => {
        test.variables[name] = value;
        operationDomain.settleProviderMutation(
          test.operation,
          pending.mutationId,
          "confirmed",
          "The provider returned the exact intended value."
        );
        return true;
      }
    });
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.body.success).toBe(true);
    expect(test.variables).toEqual({ RADIUS_MANAGED: "true" });
    expect(test.events).toContain(
      "after-environment-variable-reconciliation:RADIUS_MANAGED"
    );
    expect(test.events).toContain(
      "record:.github/workflows/radius-verify-credentials.yml"
    );
  });

  it.each(["push", "workflow_dispatch"] as const)(
    "honors Stop within %s verification before issuing its GitHub request",
    async (trigger) => {
      const test = harness();
      const boundary =
        trigger === "push" ?
          "before-automatic-verification-discovery:1"
        : "before-verification-dispatch-attempt:1";
      test.dependencies.planCredentialVerification = async () => ({
        shouldDispatch: true,
        trigger,
        ref: "trunk",
        defaultBranch: "trunk",
        pullRequestUrl: "",
        skipReason: ""
      });
      test.dependencies.createWorkflowScopeGhRunner = () => ({
        runGh: async (args) => {
          expect(args).toContain("--limit");
          expect(args).toContain("1");
          return { code: 0, stdout: "[]", stderr: "" };
        },
        runGhOrThrow: unexpected,
        runGhWorkflow: unexpected,
        setEnvironmentVariable: async () => true
      });
      test.dependencies.guardStopBoundary = async ({
        boundary: current,
        respond
      }) => {
        if (current !== boundary) return true;
        respond(200, { cancelled: true });
        return false;
      };
      const result = await runCreateEnvironment(
        { repo: "octo/app" },
        test.dependencies
      );
      expect(result.outcome).toBe("cancelled");
      expect(test.events).not.toContain("verification-state");
    }
  );

  it("requires manual review when automatic verification cannot identify a run", async () => {
    const test = harness();
    test.dependencies.planCredentialVerification = async () => ({
      shouldDispatch: false,
      trigger: "push",
      ref: "setup-dev",
      defaultBranch: "trunk",
      pullRequestUrl: "",
      skipReason: ""
    });
    test.dependencies.createWorkflowScopeGhRunner = () => ({
      runGh: async () => ({
        code: 1,
        stdout: "",
        stderr: "GitHub unavailable"
      }),
      runGhOrThrow: unexpected,
      runGhWorkflow: unexpected,
      setEnvironmentVariable: async () => true
    });
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.body.code).toBe("provider-mutation-manual-required");
    expect(result.body.error).toContain("GitHub unavailable");
    expect(test.operation.state).toBe("failed_partial");
    expect(test.events).not.toContain("verification-state");
  });

  it.each(["admin", "branch", "provider"] as const)(
    "never offers Azure cleanup for an AWS %s failure",
    async (failure) => {
      const test = harness("aws");
      if (failure === "admin")
        test.dependencies.preflightRepoAdmin = async () => "Admin required";
      if (failure === "branch")
        test.dependencies.getDefaultBranch = async () => null;
      if (failure === "provider")
        test.dependencies.bootstrapGHCRStatePackage = async () => {
          throw "Registry unavailable";
        };
      const failures: Record<string, unknown>[] = [];
      test.dependencies.finalizeSetupFailure = async (_operation, input) => {
        failures.push(input);
        return {
          status: Number(input.status),
          body: { error: input.error, code: input.code }
        };
      };
      const result = await runCreateEnvironment(
        { repo: "octo/app", provider: "aws" },
        test.dependencies
      );
      expect(result.outcome).toBe("failed");
      expect(failures).toEqual([expect.objectContaining({ runAz: null })]);
      if (failure === "provider")
        expect(failures[0]).toMatchObject({
          error: "Registry unavailable",
          evidence: null
        });
      expect(test.events).not.toContain("verification-state");
    }
  );

  it("finalizes an error whose external port removed its stack", async () => {
    const test = harness();
    test.dependencies.bootstrapGHCRStatePackage = async () => {
      const error = new Error("Registry unavailable");
      error.stack = undefined;
      throw error;
    };
    const failures: Record<string, unknown>[] = [];
    test.dependencies.finalizeSetupFailure = async (_operation, input) => {
      failures.push(input);
      return {
        status: Number(input.status),
        body: { error: input.error, code: input.code }
      };
    };
    const result = await runCreateEnvironment(
      { repo: "octo/app" },
      test.dependencies
    );
    expect(result.outcome).toBe("failed");
    expect(failures).toEqual([
      expect.objectContaining({ error: "Registry unavailable", evidence: null })
    ]);
  });
});
