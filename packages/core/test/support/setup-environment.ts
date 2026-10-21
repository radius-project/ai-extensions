import type {
  SetupEnvironmentEvent,
  SetupEnvironmentFailure,
  SetupEnvironmentInput,
  SetupEnvironmentPorts
} from "../../src/setup-environment-contracts.js";
import type {
  SetupWorkflowMutation,
  SetupWorkflowRecoveryPort
} from "../../src/setup-workflow-recovery.js";
import { ProviderMutationRecoveryError } from "../../src/setup-recovery-error.js";

export function setupEnvironmentHarness(
  overrides: Partial<SetupEnvironmentPorts> = {}
) {
  const transcript: unknown[] = [];
  const events: SetupEnvironmentEvent[] = [];
  const failures: SetupEnvironmentFailure[] = [];
  const mutations: SetupWorkflowMutation[] = [];
  let verification: unknown;
  let stopped = false;
  const credential = Symbol("package-credential");
  const recovery: SetupWorkflowRecoveryPort = {
    operationId: "op_setup",
    find: (kind, target) =>
      mutations.find(
        (entry) => entry.kind === kind && entry.target === target
      ) ?? null,
    byKind: (kind) => mutations.filter((entry) => entry.kind === kind),
    unresolved: () =>
      mutations.filter(
        (entry) =>
          entry.status === "prepared" || entry.status === "outcome_unknown"
      ),
    willWrite: (kind, target) => !recovery.find(kind, target),
    execute: async (input) => {
      const existing = recovery.find(input.kind, input.target);
      if (existing) {
        transcript.push(["reconcile", input.kind, input.target]);
        const result = await input.reconcile();
        if (result.state === "manual_required")
          throw new ProviderMutationRecoveryError(
            result.guidance,
            "provider-mutation-manual-required"
          );
        if (result.state === "not_applied") {
          existing.status = "not_applied";
          return result;
        }
        existing.status = "confirmed";
        return { state: "applied", value: result.value, recovered: true };
      }
      const mutation: SetupWorkflowMutation = {
        kind: input.kind,
        target: input.target,
        mutationId: String(mutations.length),
        status: "prepared",
        evidence: null,
        intent: input.intent
      };
      mutations.push(mutation);
      transcript.push(["prepare", input.kind, input.target, input.intent]);
      await recovery.persist();
      if (stopped && input.beforeMutation) {
        mutation.status = "not_applied";
        if (await input.beforeMutation())
          throw new ProviderMutationRecoveryError(
            "Reconciliation must finish before stop",
            "provider-mutation-outcome-unknown"
          );
        return { state: "cancelled" };
      }
      await input.validateBeforeMutation?.();
      const result = await input.mutate();
      if (result.code !== 0 && result.code !== "0") {
        mutation.status = "not_applied";
        if (input.rejectionGuidance)
          throw new ProviderMutationRecoveryError(
            input.rejectionGuidance(result),
            "provider-mutation-manual-required"
          );
        return { state: "not_applied", result };
      }
      const value = input.accept(result);
      mutation.status = "confirmed";
      input.onConfirmed?.(value, false);
      await recovery.persist();
      return { state: "applied", value, recovered: false };
    },
    rollbackPending: () => false,
    markRollbackPending: () => {
      transcript.push("rollback");
    },
    settleManual: (kind, target, guidance) => {
      transcript.push(["manual", kind, target, guidance]);
    },
    persist: async () => {
      transcript.push("persist");
    }
  };
  const run = async (args: string[]) => {
    transcript.push(["gh", args]);
    if (args[0] === "api" && args.includes("--jq"))
      return { code: 0, stdout: "old-blob", stderr: "" };
    throw new Error(`Unexpected read: ${args.join(" ")}`);
  };
  const write = async (args: string[]) => {
    transcript.push(["write", args]);
    return {
      code: 0,
      stdout: '{"content":{"sha":"new-blob"},"commit":{"sha":"new-commit"}}',
      stderr: ""
    };
  };
  const ports: SetupEnvironmentPorts = {
    recovery,
    stopRequested: () => stopped,
    stopBoundary: async (boundary) => {
      transcript.push(["stop", boundary]);
      return !stopped;
    },
    checkpoint: async (boundary) => {
      transcript.push(["checkpoint", boundary]);
      return true;
    },
    finalizeFailure: async (failure) => {
      failures.push(failure);
      transcript.push(["finalize", failure]);
      return "failed";
    },
    preflightRepository: async (repo) => {
      transcript.push(["repository", repo]);
      return true;
    },
    preflightPackages: async () => {
      transcript.push("packages");
      return credential;
    },
    readEnsuredEnvironment: () => null,
    ensureEnvironment: async (repo, name) => {
      transcript.push(["ensure", repo, name]);
      return { name, state: "reused", providerId: "env-id" };
    },
    setCanonicalEnvironment: (name) => {
      transcript.push(["canonical", name]);
    },
    recordEnvironment: (patch) => {
      transcript.push(["environment", patch]);
    },
    promoteCreatedEnvironment: () => false,
    bindEnvironment: (target) => {
      transcript.push(["bind", target]);
      return {
        runGh: run,
        runGhWorkflow: write,
        setEnvironmentVariable: async (name, value) => {
          transcript.push(["variable", name, value]);
          return false;
        }
      };
    },
    getDefaultBranch: async () => "trunk",
    stateRegistryForEnvironment: (repo, environment) =>
      `ghcr.io/${repo}-${environment}`,
    bootstrapStatePackage: async (request) => {
      if (request.credentials !== credential)
        throw new Error("Wrong credential handle");
      transcript.push([
        "bootstrap",
        request.targetRepository,
        request.registry
      ]);
      return { visibility: "private" };
    },
    workflowFiles: ({ runGh, runGhWorkflow }) => ({
      runGh,
      runGhWorkflow,
      getDefaultBranch: async () => "trunk",
      getBranchHeadSha: async () => "base-sha",
      createBranchRef: async (_repo, branch, sha) => {
        transcript.push(["branch", branch, sha]);
        return { ok: true, stderr: "" };
      },
      tempFile: {
        write: (content) => {
          transcript.push(["file", JSON.parse(content)]);
          return "body.json";
        },
        remove: (path) => {
          transcript.push(["remove", path]);
        }
      },
      contentDigest: (value) => `digest:${value}`,
      blobSha: (value) => `blob:${value}`,
      parseBranchTarget: (value) => {
        const [repo, branch, baseSha] = value.split("\0");
        return repo && branch && baseSha ? { repo, branch, baseSha } : null;
      },
      proveBranchAbsent: async () => ({
        state: "absent",
        evidence: "listed refs"
      }),
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      report: (event) => {
        transcript.push(event);
      },
      now: () => 100
    }),
    azureCredential: () => ({}),
    awsCredential: () => ({}),
    optionalString: (value) => (typeof value === "string" ? value : ""),
    envListCacheDelete: (repo) => {
      transcript.push(["cache", repo]);
    },
    ociStateBackend: "oci",
    defaultStateArchive: "state",
    verifyWorkflowFile: "radius-verify-credentials.yml",
    legacyDeployWorkflowFile: "radius-deploy.yml",
    fetchFileFromRepoResult: async () => ({
      content: null,
      error: null,
      status: 404
    }),
    parseWorkflow: () => ({ on: { workflow_dispatch: {} } }),
    verification: () => verification,
    setVerification: (value) => {
      verification = value;
      transcript.push(["verification", value]);
    },
    generateVerifyWorkflow: async () => "verify",
    generateDeployWorkflow: async () => ({ "deploy.yml": "deploy" }),
    generateDeleteWorkflow: async () => ({ "delete.yml": "delete" }),
    recordCommittedWorkflowFile: (entry) => {
      transcript.push(["committed", entry]);
    },
    deleteLegacyDeployWorkflow: async () => true,
    encode: (content) => content,
    createPullRequest: async () => ({
      ok: true,
      url: "https://github.test/pr/1",
      number: 1
    }),
    recordCommitState: (patch) => {
      transcript.push(["commit", patch]);
    },
    planCredentialVerification: async ({
      defaultBranch,
      prState,
      pullRequestUrl
    }) => ({
      shouldDispatch: true,
      trigger: "workflow_dispatch",
      ref: prState?.branch || defaultBranch,
      defaultBranch,
      pullRequestUrl,
      skipReason: "",
      supportsOperationMarker: true
    }),
    fetchFileFromRepo: async () => "verify",
    discoverAutomaticVerificationRun: async () => ({
      state: "discovered",
      runId: "10",
      runUrl: "https://github.test/run/10"
    }),
    terminalizeManualRequired: (guidance) => {
      transcript.push(["terminal-manual", guidance]);
    },
    runVerificationDispatch: async (input) => {
      transcript.push(["dispatch", input.ref, input.operationMarker]);
      input.ports.applyIdentity(
        {
          dispatchedAt: 120,
          baselineRunId: 9,
          ref: input.ref,
          environment: input.environment,
          operationMarker: input.operationMarker
        },
        null
      );
      return {
        state: "accepted",
        runId: "10",
        runUrl: "https://github.test/run/10",
        recovered: false
      };
    },
    buildVerifyWorkflowDispatchArgs: () => ["workflow", "run"],
    enterVerifyStage: () => {
      transcript.push("enter-verify");
    },
    projectVerification: (projection) => {
      transcript.push(["project", projection]);
    },
    recordCleanupNotNeeded: () => {
      transcript.push("cleanup-not-needed");
    },
    skipVerifyStage: () => {
      transcript.push("skip-verify");
    },
    finishMergeRequired: (terminal) => {
      transcript.push(["finish-merge", terminal]);
    },
    finishCredentialsIncomplete: (terminal) => {
      transcript.push(["finish-credentials", terminal]);
    },
    persistBestEffort: async () => {
      transcript.push("persist-best-effort");
    },
    report: (event) => {
      events.push(event);
      transcript.push(["event", event]);
    },
    now: () => 100,
    sleep: async (milliseconds) => {
      transcript.push(["sleep", milliseconds]);
    },
    ...overrides
  };
  const input: SetupEnvironmentInput = {
    operationId: "op_setup",
    targetRepo: "octo/app",
    envName: "dev",
    provider: "azure",
    data: {
      clientId: "client",
      tenantId: "tenant",
      subscriptionId: "subscription"
    }
  };
  const protectDefaultBranch = () => {
    const bind = ports.bindEnvironment;
    let first = true;
    ports.bindEnvironment = (target) => {
      const runner = bind(target);
      return {
        ...runner,
        runGhWorkflow: async (args) => {
          if (first) {
            first = false;
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 403: protected branch"
            };
          }
          return runner.runGhWorkflow(args);
        }
      };
    };
  };
  return {
    ports,
    input,
    transcript,
    events,
    failures,
    mutations,
    protectDefaultBranch,
    stop: () => {
      stopped = true;
    }
  };
}
