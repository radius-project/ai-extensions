import { setupAutomaticBranchVerificationPolicy } from "./setup-verification-policy.js";
import {
  GitHubEnvironmentEnsureCancelled,
  GitHubEnvironmentEnsureError
} from "./setup-github-environment.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";
import { createWorkflowFileCommitter } from "./setup-workflow-committer.js";
import { publishSetupWorkflowFiles } from "./setup-workflow-publication.js";
import {
  applySetupProviderConfiguration,
  setupProviderCredentialStatus,
  type SetupProviderCredentialStatus
} from "./setup-provider-configuration.js";
import type {
  SetupEnvironmentInput,
  SetupEnvironmentPorts,
  SetupEnvironmentResult,
  SetupPullRequestResult,
  SetupVerificationSkipReason,
  SetupPullRequestNextStep
} from "./setup-environment-contracts.js";

type AcknowledgedPullRequest = Omit<SetupPullRequestResult, "ok"> & {
  ok: true;
};

export async function configureSetupEnvironment(
  input: SetupEnvironmentInput,
  ports: SetupEnvironmentPorts
): Promise<SetupEnvironmentResult> {
  const { targetRepo, provider, data } = input;
  let envName = input.envName;
  const runMutationAttempt = async <T>(
    failureBoundary: string,
    mutate: () => Promise<T>
  ): Promise<{ completed: true; value: T } | { completed: false }> => {
    try {
      return { completed: true, value: await mutate() };
    } catch (error) {
      if (
        error instanceof ProviderMutationRecoveryError &&
        error.code === "provider-mutation-outcome-unknown"
      )
        throw error;
      if (!(await ports.stopBoundary(failureBoundary)))
        return { completed: false };
      throw error;
    }
  };
  const reconcilingProviderMutation = ports.recovery.unresolved().length > 0;

  if (!(await ports.stopBoundary("before-github-environment")))
    return { kind: "stopped" };
  let packageCredentials: symbol | undefined;
  if (!reconcilingProviderMutation) {
    if (!(await ports.preflightRepository(targetRepo))) {
      return {
        kind: await ports.finalizeFailure({ kind: "repository-access" })
      };
    }
    if (!(await ports.stopBoundary("before-ghcr-bootstrap")))
      return { kind: "stopped" };
    const credential = await ports.preflightPackages();
    if (credential === null) {
      return { kind: await ports.finalizeFailure({ kind: "package-access" }) };
    }
    packageCredentials = credential;
  }

  let ensuredEnvironment = ports.readEnsuredEnvironment(targetRepo, envName);
  try {
    ensuredEnvironment ??= await ports.ensureEnvironment(
      targetRepo,
      envName,
      () => ports.stopBoundary("before-github-environment-create")
    );
  } catch (error) {
    if (error instanceof GitHubEnvironmentEnsureCancelled)
      return { kind: "stopped" };
    if (
      error instanceof GitHubEnvironmentEnsureError &&
      error.createdCandidate
    ) {
      ports.recordEnvironment({
        state: "created_candidate",
        repo: error.createdCandidate.repo,
        name: error.createdCandidate.name,
        origin: "unknown"
      });
    }
    if (!(await ports.stopBoundary("after-github-environment-attempt")))
      return { kind: "stopped" };
    throw error;
  }
  const requestedEnvName = envName;
  envName = ensuredEnvironment.name;
  ports.setCanonicalEnvironment(envName);

  const { runGh, setEnvironmentVariable, runGhWorkflow } =
    ports.bindEnvironment({
      targetRepo,
      envName,
      environmentProviderId: ensuredEnvironment.providerId,
      journalVariables: provider === "azure"
    });
  ports.recordEnvironment({
    state: ensuredEnvironment.state,
    repo: targetRepo,
    name: envName,
    providerId: ensuredEnvironment.providerId,
    origin: ensuredEnvironment.state === "reused" ? "pre_existing" : "unknown"
  });
  if (
    ensuredEnvironment.creationProof?.proven &&
    ports.promoteCreatedEnvironment({
      repo: targetRepo,
      name: envName
    })
  ) {
    ports.report({ kind: "environment-owned", envName });
  } else if (
    ensuredEnvironment.state === "created_candidate" &&
    ensuredEnvironment.creationProof &&
    !ensuredEnvironment.creationProof.proven
  ) {
    ports.report({
      kind: "environment-unowned",
      envName,
      detail: ensuredEnvironment.creationProof.detail
    });
  }
  if (requestedEnvName === envName) {
    ports.report({ kind: "environment-resolved", envName });
  } else {
    ports.report({
      kind: "environment-canonicalized",
      envName,
      requestedEnvName
    });
  }
  if (!(await ports.checkpoint("after-github-environment")))
    return { kind: "stopped" };

  const pendingVariable = ports.recovery
    .unresolved()
    .find((mutation) => mutation.kind === "github_environment_variable.put");
  if (pendingVariable) {
    const name =
      typeof pendingVariable.intent?.name === "string" ?
        pendingVariable.intent.name
      : "";
    const value =
      typeof pendingVariable.intent?.value === "string" ?
        pendingVariable.intent.value
      : "";
    if (!name || !value) {
      const guidance =
        "Radius cannot reconcile the interrupted GitHub environment variable because its saved intent is incomplete. Review the environment variables manually before starting a new setup.";
      ports.recovery.settleManual(
        pendingVariable.kind,
        pendingVariable.target,
        guidance
      );
      await ports.recovery.persist();
      throw new ProviderMutationRecoveryError(
        guidance,
        "provider-mutation-manual-required"
      );
    }
    await setEnvironmentVariable(name, value);
    if (
      !(await ports.checkpoint(
        `after-environment-variable-reconciliation:${name}`
      ))
    ) {
      return { kind: "stopped" };
    }
  }

  const defaultBranch = await ports.getDefaultBranch(targetRepo);
  if (!defaultBranch) {
    return {
      kind: await ports.finalizeFailure({
        kind: "default-branch-unavailable",
        targetRepo
      })
    };
  }
  const stateRegistry = ports.stateRegistryForEnvironment(targetRepo, envName);

  if (!reconcilingProviderMutation) {
    ports.report({ kind: "package-creating", stateRegistry });
    if (!(await ports.stopBoundary("before-ghcr-state-package")))
      return { kind: "stopped" };
    const statePackageAttempt = await runMutationAttempt(
      "after-ghcr-state-package-attempt",
      () =>
        ports.bootstrapStatePackage({
          targetRepository: targetRepo,
          registry: stateRegistry,
          credentials: packageCredentials
        })
    );
    if (!statePackageAttempt.completed) return { kind: "stopped" };
    const statePackage = statePackageAttempt.value;
    ports.report({
      kind: "package-created",
      visibility: statePackage.visibility,
      targetRepo
    });
    if (!(await ports.checkpoint("after-ghcr-state-package")))
      return { kind: "stopped" };
  }

  const committer = createWorkflowFileCommitter(
    {
      ...ports.workflowFiles({ targetRepo, envName, runGh, runGhWorkflow }),
      mutationRecovery: {
        ...ports.recovery,
        beforeMutation: async () => {
          if (ports.stopRequested() && ports.recovery.unresolved().length > 0) {
            throw new ProviderMutationRecoveryError(
              "Radius must reconcile the existing provider request before it can honor Stop or write another workflow.",
              "provider-mutation-outcome-unknown"
            );
          }
          return ports.stopBoundary("before-workflow-provider-mutation");
        }
      }
    },
    { targetRepo, envName }
  );
  const prBranch = (): string | null =>
    committer.pullRequestState()?.branch || null;

  let providerConfiguration: SetupProviderCredentialStatus;
  if (reconcilingProviderMutation) {
    providerConfiguration = setupProviderCredentialStatus(
      provider,
      data,
      ports
    );
  } else {
    if (!(await ports.stopBoundary("before-radius-managed-variable")))
      return { kind: "stopped" };
    const managedVariable = await runMutationAttempt(
      "after-radius-managed-variable-attempt",
      () => setEnvironmentVariable("RADIUS_MANAGED", "true")
    );
    if (!managedVariable.completed) return { kind: "stopped" };
    ports.envListCacheDelete(targetRepo);
    if (!(await ports.checkpoint("after-radius-managed-variable")))
      return { kind: "stopped" };

    ports.report({ kind: "package-configuring", stateRegistry });
    if (!(await ports.stopBoundary("before-state-package-configuration")))
      return { kind: "stopped" };
    const stateConfiguration = await runMutationAttempt(
      "after-state-package-configuration-attempt",
      async () => {
        await setEnvironmentVariable(
          "RADIUS_STATE_BACKEND",
          ports.ociStateBackend
        );
        await setEnvironmentVariable("RADIUS_STATE_REGISTRY", stateRegistry);
        await setEnvironmentVariable(
          "RADIUS_STATE_ARCHIVE",
          ports.defaultStateArchive
        );
      }
    );
    if (!stateConfiguration.completed) return { kind: "stopped" };
    ports.report({
      kind: "package-configured",
      archive: ports.defaultStateArchive
    });
    if (!(await ports.checkpoint("after-state-package-configuration")))
      return { kind: "stopped" };
    if (data.profileName) {
      if (!(await ports.stopBoundary("before-credential-profile-variable")))
        return { kind: "stopped" };
      const profileVariable = await runMutationAttempt(
        "after-credential-profile-variable-attempt",
        () =>
          setEnvironmentVariable("RADIUS_CREDENTIAL_PROFILE", data.profileName)
      );
      if (!profileVariable.completed) return { kind: "stopped" };
      if (!(await ports.checkpoint("after-credential-profile-variable")))
        return { kind: "stopped" };
    }
    if (!(await ports.stopBoundary("before-provider-configuration")))
      return { kind: "stopped" };
    const providerConfigurationAttempt = await runMutationAttempt(
      "after-provider-configuration-attempt",
      () =>
        applySetupProviderConfiguration(provider, data, {
          azureCredential: () => ports.azureCredential(),
          awsCredential: () => ports.awsCredential(),
          optionalString: (value) => ports.optionalString(value),
          setEnvironmentVariable,
          report: (event) =>
            ports.report({ kind: "provider-configuration", event })
        })
    );
    if (!providerConfigurationAttempt.completed) return { kind: "stopped" };
    providerConfiguration = providerConfigurationAttempt.value;
    if (!(await ports.checkpoint("after-provider-configuration")))
      return { kind: "stopped" };
  }
  const { credentialsComplete } = providerConfiguration;
  let verifySkipReason: SetupVerificationSkipReason | null = null;
  if (!(await ports.stopBoundary("before-workflow-policy-read")))
    return { kind: "stopped" };
  const [defaultVerify, defaultDispatcher, defaultLegacyDeploy] =
    await Promise.all([
      ports.fetchFileFromRepoResult(
        targetRepo,
        ".github/workflows/radius-verify-credentials.yml",
        defaultBranch
      ),
      ports.fetchFileFromRepoResult(
        targetRepo,
        ".github/workflows/run-rad-commands.yml",
        defaultBranch
      ),
      ports.fetchFileFromRepoResult(
        targetRepo,
        `.github/workflows/${ports.legacyDeployWorkflowFile}`,
        defaultBranch
      )
    ]);
  const automaticPolicy = setupAutomaticBranchVerificationPolicy(
    {
      verify: defaultVerify,
      dispatcher: defaultDispatcher,
      legacyDeploy: defaultLegacyDeploy
    },
    ports.parseWorkflow
  );
  if (
    credentialsComplete &&
    automaticPolicy.state === "disabled" &&
    automaticPolicy.reason !== "verify-present"
  ) {
    ports.report({
      kind: "automatic-policy-disabled",
      policy: automaticPolicy
    });
  }
  const setupPushOperationMarker =
    credentialsComplete && automaticPolicy.state === "enabled" ?
      input.operationId
    : undefined;
  const existingVerification =
    (
      ports.verification() &&
      typeof ports.verification() === "object" &&
      !Array.isArray(ports.verification())
    ) ?
      (ports.verification() as Record<string, unknown>)
    : null;
  const existingAutomaticIdentity =
    (
      existingVerification?.event === "push" &&
      existingVerification.operationMarker === input.operationId &&
      typeof existingVerification.ref === "string" &&
      existingVerification.ref &&
      Number.isFinite(Number(existingVerification.dispatchedAt))
    ) ?
      existingVerification
    : null;
  const automaticStartedAt =
    existingAutomaticIdentity ?
      Number(existingAutomaticIdentity.dispatchedAt)
    : ports.now();
  const commitWorkflowFileSmart = async (
    path: string,
    contentB64: string,
    message: string
  ) => {
    const outcome = await committer.commitWorkflowFileSmart(
      path,
      contentB64,
      message
    );
    const fallback = committer.pullRequestState();
    if (
      setupPushOperationMarker &&
      outcome.ok &&
      outcome.viaPr &&
      fallback &&
      !ports.verification()
    ) {
      ports.setVerification({
        dispatchedAt: automaticStartedAt,
        workflow: ports.verifyWorkflowFile,
        ref: fallback.branch,
        environment: envName,
        event: "push",
        operationMarker: setupPushOperationMarker,
        baselineRunId: null,
        runId: null,
        runUrl: null
      });
    }
    return outcome;
  };
  if (!(await ports.checkpoint("before-workflow-commit")))
    return { kind: "stopped" };
  const published = await publishSetupWorkflowFiles(
    {
      generateVerifyWorkflow: (
        environment,
        workflowProvider,
        pushOperationMarker
      ) =>
        ports.generateVerifyWorkflow(
          environment,
          workflowProvider,
          pushOperationMarker
        ),
      generateDeployWorkflow: (environment, appFile) =>
        ports.generateDeployWorkflow(environment, appFile),
      generateDeleteWorkflow: (environment) =>
        ports.generateDeleteWorkflow(environment),
      commitWorkflowFileSmart,
      recordCommittedWorkflowFile: (entry) =>
        ports.recordCommittedWorkflowFile(entry),
      deleteLegacyDeployWorkflow: async (repo, branch) => {
        const legacyDelete =
          ports.recovery.unresolved().length > 0 ?
            true
          : await ports.deleteLegacyDeployWorkflow(
              repo,
              () => ports.stopBoundary("before-legacy-workflow-delete"),
              branch
            );
        if (legacyDelete === "cancelled") return legacyDelete;
        if (
          automaticPolicy.state === "disabled" &&
          (automaticPolicy.reason === "legacy-deploy-present" ||
            automaticPolicy.reason === "legacy-deploy-unreadable") &&
          legacyDelete !== true
        ) {
          throw new Error(
            branch ?
              `Radius could not remove the legacy deploy workflow from setup branch "${branch}", so it did not continue with verification.`
            : "Radius could not remove the legacy deploy workflow from the default branch, so it did not continue with verification."
          );
        }
        return legacyDelete;
      },
      pullRequestBranch: prBranch,
      encode: ports.encode,
      report: (event) => ports.report({ kind: "workflow-publication", event }),
      gate: () => ports.checkpoint("after-workflow-commit")
    },
    {
      targetRepo,
      envName,
      provider,
      defaultBranch,
      setupPushOperationMarker
    }
  );
  if (published.outcome === "cancelled") return { kind: "stopped" };
  if (published.outcome === "refused") {
    return {
      kind: await ports.finalizeFailure({
        kind: "workflow-commit",
        targetRepo,
        publication: published
      })
    };
  }
  const unresolvedWorkflowWrites = ports.recovery
    .unresolved()
    .filter((mutation) => mutation.kind === "github_workflow.put");
  if (unresolvedWorkflowWrites.length > 0) {
    return {
      kind: await ports.finalizeFailure({
        kind: "workflow-reconciliation-pending"
      })
    };
  }
  let pullRequestUrl = "";
  let pullRequestOpened = false;
  const prState = committer.pullRequestState();
  if (prState) {
    const prMutationKind = "github_pull_request.create";
    const prMutationTarget = `${targetRepo}:${prState.branch}:${prState.base}`;
    if (
      ports.recovery.willWrite(prMutationKind, prMutationTarget) &&
      !(await ports.stopBoundary("before-workflow-pull-request"))
    )
      return { kind: "stopped" };
    const prAttempt = await runMutationAttempt(
      "after-workflow-pull-request-attempt",
      () =>
        ports.recovery.execute<AcknowledgedPullRequest>({
          kind: prMutationKind,
          target: prMutationTarget,
          providerIdempotencyKey: prState.branch,
          beforeMutation: () =>
            ports.stopBoundary("before-workflow-pull-request"),
          mutate: async () => {
            const result = await ports.createPullRequest(
              targetRepo,
              prState.branch,
              prState.base,
              envName
            );
            return {
              code: result.ok ? 0 : 1,
              stdout: result.ok ? JSON.stringify(result) : "",
              stderr: result.stderr || "",
              timedOut: result.timedOut
            };
          },
          accept: (result) =>
            JSON.parse(result.stdout) as AcknowledgedPullRequest,
          reconcile: async () => {
            const listed = await runGh([
              "api",
              `/repos/${targetRepo}/pulls?state=open&head=${encodeURIComponent(
                prState.branch
              )}&base=${encodeURIComponent(prState.base)}&per_page=10`
            ]);
            if (listed.code !== 0 && listed.code !== "0") {
              throw new Error(
                listed.stderr ||
                  listed.stdout ||
                  "GitHub pull requests could not be read."
              );
            }
            let matches: Array<{ html_url: string; number: number }> = [];
            try {
              const parsed: unknown = JSON.parse(listed.stdout);
              if (Array.isArray(parsed)) {
                matches = parsed
                  .filter(
                    (
                      value
                    ): value is {
                      html_url: string;
                      number: number;
                      head: { ref: string };
                      base: { ref: string };
                    } =>
                      value !== null &&
                      typeof value === "object" &&
                      "html_url" in value &&
                      typeof value.html_url === "string" &&
                      "number" in value &&
                      typeof value.number === "number" &&
                      "head" in value &&
                      value.head !== null &&
                      typeof value.head === "object" &&
                      "ref" in value.head &&
                      value.head.ref === prState.branch &&
                      "base" in value &&
                      value.base !== null &&
                      typeof value.base === "object" &&
                      "ref" in value.base &&
                      value.base.ref === prState.base
                  )
                  .map((value) => ({
                    html_url: value.html_url,
                    number: value.number
                  }));
              }
            } catch {
              throw new Error(
                "GitHub returned an unreadable pull request list."
              );
            }
            if (matches.length === 0) {
              return {
                state: "not_applied" as const,
                evidence:
                  "GitHub confirmed no open pull request uses the operation-specific branch."
              };
            }
            if (matches.length > 1) {
              return {
                state: "manual_required" as const,
                guidance:
                  `Multiple pull requests use operation branch "${prState.branch}". ` +
                  "Radius will not create, close, or modify any of them."
              };
            }
            return {
              state: "applied" as const,
              value: {
                ok: true as const,
                url: matches[0].html_url,
                number: matches[0].number
              },
              evidence:
                "The pull request head and base match the operation-specific branch provenance."
            };
          }
        })
    );
    if (!prAttempt.completed) return { kind: "stopped" };
    const prMutation = prAttempt.value;
    if (prMutation.state === "cancelled") return { kind: "stopped" };
    const pr =
      prMutation.state === "applied" ?
        prMutation.value
      : {
          ok: false as const,
          stderr: "GitHub confirmed the pull request was not created."
        };
    if (pr.ok) {
      pullRequestUrl = pr.url || "";
      pullRequestOpened = true;
      ports.report({
        kind: "pull-request-opened",
        number: pr.number,
        url: pr.url
      });
    } else {
      ports.report({
        kind: "pull-request-failed",
        branch: prState.branch,
        base: prState.base,
        detail: pr.stderr
      });
    }
    ports.recordCommitState({
      mode: "pull_request",
      branch: prState.branch,
      baseBranch: prState.base,
      pullRequestUrl: pullRequestUrl || null
    });
    if (!(await ports.checkpoint("after-workflow-pull-request")))
      return { kind: "stopped" };
  }
  let verifyRunUrl = "";
  let verifyRunId: string | number | null = null;
  let dispatchedAt = ports.now();
  let verificationRef = defaultBranch;
  let baselineRunId: number | null = null;
  const verifyPlan = await ports.planCredentialVerification({
    targetRepo,
    defaultBranch,
    prState: prState || null,
    pullRequestUrl,
    automaticPushEnabled: Boolean(prState && setupPushOperationMarker),
    branchVerificationAllowed:
      automaticPolicy.state === "enabled" ||
      automaticPolicy.reason === "verify-present",
    fetchFile: (repo, path, branch) =>
      ports.fetchFileFromRepo(repo, path, branch)
  });
  if (verifyPlan.pullRequestUrl) pullRequestUrl = verifyPlan.pullRequestUrl;
  if (verifyPlan.trigger === "none") {
    verifySkipReason = { kind: "merge", reason: verifyPlan.skipReason };
    ports.report({
      kind: "verification-merge-skip",
      reason: verifyPlan.skipReason
    });
  } else if (!credentialsComplete) {
    verifySkipReason = {
      kind: "credentials",
      provider: providerConfiguration.provider
    };
    ports.report({
      kind: "verification-credentials-skip",
      provider: providerConfiguration.provider
    });
  } else if (verifyPlan.trigger === "push") {
    verificationRef = verifyPlan.ref;
    dispatchedAt = automaticStartedAt;
    ports.report({ kind: "verification-discovering", ref: verificationRef });
    const automatic = await ports.discoverAutomaticVerificationRun({
      identity: {
        repo: targetRepo,
        workflow: ports.verifyWorkflowFile,
        ref: verificationRef,
        environment: envName,
        operationMarker: input.operationId,
        startedAt: automaticStartedAt
      },
      listRuns: () =>
        runGh([
          "run",
          "list",
          "--workflow=" + ports.verifyWorkflowFile,
          "--limit",
          "10",
          "--json",
          "databaseId,createdAt,displayTitle,event,headBranch",
          "--repo",
          targetRepo
        ]),
      stopBoundary: ports.stopBoundary,
      sleep: (milliseconds) => ports.sleep(milliseconds)
    });
    if (automatic.state === "cancelled") return { kind: "stopped" };
    if (automatic.state === "manual_required") {
      ports.terminalizeManualRequired(automatic.guidance);
      await ports.recovery.persist();
      throw new ProviderMutationRecoveryError(
        automatic.guidance,
        "provider-mutation-manual-required"
      );
    }
    verifyRunId = automatic.runId;
    verifyRunUrl = automatic.runUrl;
    ports.report({ kind: "verification-automatic" });
    ports.report({ kind: "verification-run", url: verifyRunUrl });
    const automaticVerification = ports.verification();
    ports.setVerification({
      ...(automaticVerification && typeof automaticVerification === "object" ?
        automaticVerification
      : {}),
      dispatchedAt,
      workflow: ports.verifyWorkflowFile,
      ref: verificationRef,
      environment: envName,
      event: "push",
      operationMarker: input.operationId,
      baselineRunId: null,
      runId: automatic.runId,
      runUrl: automatic.runUrl
    });
  } else {
    verificationRef = verifyPlan.ref;
    ports.report({
      kind: "verification-dispatch-identity",
      targetRepo,
      envName,
      ref: verificationRef
    });
    ports.report({ kind: "verification-dispatching" });
    if (!(await ports.stopBoundary("before-verification-dispatch")))
      return { kind: "stopped" };
    const supportsOperationMarker =
      verifyPlan.supportsOperationMarker !== false;
    const operationMarker = supportsOperationMarker ? input.operationId : "";
    const dispatchMutationKind = "github_workflow.dispatch";
    const dispatchMutationTarget = `${targetRepo}:${ports.verifyWorkflowFile}:${verificationRef}:${envName}`;
    const dispatch = await ports.runVerificationDispatch({
      kind: dispatchMutationKind,
      target: dispatchMutationTarget,
      repo: targetRepo,
      workflowPath: `.github/workflows/${ports.verifyWorkflowFile}`,
      workflowFile: ports.verifyWorkflowFile,
      environment: envName,
      ref: verificationRef,
      operationMarker,
      allowRegistrationRetry: true,
      ports: {
        runGh: (args) => runGh(args),
        sendDispatch: () =>
          runGhWorkflow(
            ports.buildVerifyWorkflowDispatchArgs({
              workflowFile: ports.verifyWorkflowFile,
              targetRepo,
              envName,
              ref: verificationRef,
              operationMarker
            })
          ),
        persist: () => ports.recovery.persist(),
        stopBoundary: ports.stopBoundary,
        applyIdentity: (identity, run) => {
          const currentVerification = ports.verification();
          const prior =
            (
              currentVerification !== null &&
              typeof currentVerification === "object"
            ) ?
              currentVerification
            : {};
          ports.setVerification({
            ...prior,
            dispatchedAt: identity.dispatchedAt,
            dispatchMutationTarget,
            workflow: ports.verifyWorkflowFile,
            ref: identity.ref,
            environment: identity.environment,
            event: "workflow_dispatch",
            operationMarker: identity.operationMarker,
            baselineRunId: identity.baselineRunId,
            runId: run?.runId ?? null,
            runUrl: run?.runUrl ?? null
          });
          dispatchedAt = identity.dispatchedAt;
          baselineRunId = identity.baselineRunId;
          verificationRef = identity.ref;
        },
        terminalizeManualRequired: (guidance) =>
          ports.terminalizeManualRequired(guidance),
        now: () => ports.now(),
        sleep: (milliseconds) => ports.sleep(milliseconds)
      }
    });
    if (dispatch.state === "cancelled") return { kind: "stopped" };
    if (dispatch.state === "baseline_failed") {
      return {
        kind: await ports.finalizeFailure({
          kind: "verification-baseline",
          unreadable: dispatch.unreadable,
          detail: dispatch.detail
        })
      };
    }
    if (dispatch.state === "manual_required") {
      throw new ProviderMutationRecoveryError(
        dispatch.guidance,
        "provider-mutation-manual-required"
      );
    }
    if (dispatch.state === "accepted") {
      ports.report({ kind: "verification-dispatched" });
      verifyRunId = dispatch.runId;
      verifyRunUrl = dispatch.runUrl;
      ports.report({ kind: "verification-run", url: verifyRunUrl });
    } else {
      if (!(await ports.stopBoundary("after-verification-dispatch-attempt"))) {
        return { kind: "stopped" };
      }
      const detail = dispatch.detail || "The GitHub CLI request failed.";
      ports.report({ kind: "verification-dispatch-failed", detail });
      return {
        kind: await ports.finalizeFailure({
          kind: "verification-dispatch",
          detail,
          environment: envName,
          operationMarker:
            verifyPlan.supportsOperationMarker !== false ?
              input.operationId
            : null,
          provider,
          repo: targetRepo,
          stateRegistry
        })
      };
    }
  }
  {
    const currentVerification = ports.verification();
    const priorVerification =
      currentVerification !== null && typeof currentVerification === "object" ?
        currentVerification
      : {};
    const priorOperationMarker =
      (
        "operationMarker" in priorVerification &&
        typeof priorVerification.operationMarker === "string"
      ) ?
        priorVerification.operationMarker
      : "";
    ports.setVerification({
      ...priorVerification,
      dispatchedAt,
      workflow: ports.verifyWorkflowFile,
      ref: verificationRef,
      event: verifyPlan.trigger === "push" ? "push" : "workflow_dispatch",
      operationMarker:
        priorOperationMarker || (prState ? input.operationId : null),
      baselineRunId,
      environment: envName,
      runId: verifyRunId == null ? null : String(verifyRunId),
      runUrl: verifyRunUrl || null
    });
    if (verifyPlan.trigger !== "none") ports.enterVerifyStage();
    if (!prState) {
      ports.recordCommitState({
        mode: "default_branch",
        branch: defaultBranch,
        baseBranch: verifyPlan.defaultBranch,
        pullRequestUrl: pullRequestUrl || null
      });
    }
    if (!(await ports.checkpoint("after-verification-dispatch")))
      return { kind: "stopped" };
    ports.projectVerification({ dispatchedAt, verifyRunId, verifyRunUrl });
  }
  const awaitingMerge = verifyPlan.trigger === "none";
  const awaitingCredentials = !credentialsComplete;
  const nextStepOutcome: SetupPullRequestNextStep =
    awaitingMerge && awaitingCredentials ? "awaiting-merge-and-credentials"
    : awaitingMerge ? "awaiting-merge"
    : awaitingCredentials ? "awaiting-credentials"
    : "verification-running";
  if (prState && pullRequestOpened) {
    ports.report({
      kind: "pull-request-next-step",
      outcome: nextStepOutcome,
      baseBranch: prState.base,
      ref: verificationRef
    });
  }

  const actionRequired = verifyPlan.trigger === "none";
  const publicationIdentity = prState || {
    branch: defaultBranch,
    base: verifyPlan.defaultBranch
  };
  ports.recordCleanupNotNeeded();
  if (actionRequired) {
    ports.skipVerifyStage();
    ports.finishMergeRequired({
      outcome: nextStepOutcome,
      pullRequestUrl: pullRequestUrl || null,
      branch: publicationIdentity.branch,
      baseBranch: publicationIdentity.base
    });
    await ports.persistBestEffort();
  } else if (!credentialsComplete) {
    ports.recordCommitState({
      mode: prState ? "pull_request" : "default_branch",
      branch: publicationIdentity.branch,
      baseBranch: publicationIdentity.base,
      pullRequestUrl: pullRequestUrl || null
    });
    ports.skipVerifyStage();
    ports.finishCredentialsIncomplete({
      provider: providerConfiguration.provider,
      pullRequestUrl: pullRequestUrl || null
    });
    await ports.persistBestEffort();
  }

  return {
    kind: "configured",
    operationId: input.operationId,
    environment: envName,
    provider,
    repo: targetRepo,
    stateBackend: ports.ociStateBackend,
    stateRegistry,
    stateArchive: ports.defaultStateArchive,
    verifyRunUrl,
    actionRequired,
    pullRequestUrl,
    pullRequestBranch: actionRequired ? publicationIdentity.branch : null,
    pullRequestBaseBranch: actionRequired ? publicationIdentity.base : null,
    verifySkipped: verifySkipReason !== null,
    verifySkipReason
  };
}
