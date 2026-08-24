import type { IncomingMessage } from "node:http";
import type { SelectedGhExecutor } from "../../gh.js";
import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import {
  admitCreateEnvironmentRequest,
  refuseUnlessServerOwned,
  type AdmissionPorts,
  type CreateEnvironmentRequestData
} from "./create-environment-refusals.js";
import {
  createWorkflowScopeGhRunner,
  type WorkflowScopeGhRunnerPorts
} from "./create-environment-gh-runner.js";
import { createWorkflowFileCommitter } from "./create-environment-workflow-committer.js";
import {
  applyProviderConfiguration,
  publishWorkflowFiles
} from "./create-environment-workflow-publisher.js";
import {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureCancelled,
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment,
  type GitHubEnvironmentReadResult
} from "../services/github-environment.js";
import type { WorkflowTempFilePort } from "./create-environment-workflow-committer.js";
import type {
  CreateEnvironmentCommandResult,
  CreateEnvironmentOperation,
  CreateEnvironmentPullRequestResult,
  CredentialVerificationPlanResult,
  GhcrPreflightResult,
  SetupFailureResponse
} from "./create-environment-types.js";
import { shouldStop, unresolvedProviderMutations } from "../../operations.js";
import {
  executeRecoverableMutation,
  providerMutationWillWrite,
  ProviderMutationRecoveryError
} from "../services/provider-mutation-recovery.js";
import { selectedEnvironmentReader } from "../services/github-environment.js";
import {
  findExactVerificationRun,
  hasPostDispatchVerificationRuns
} from "../../verification-run-identity.js";

// Seam 4 of the `POST /api/create-environment` slice: the seven-step use case.
//
// This route holds the connection for the whole workflow and answers with a
// single synchronous 200 at the end — it does not acknowledge early and continue
// in the background. Between steps it takes five cancellation gates through
// `checkpoint()`; each one both persists the operation and, on a persistence
// failure, finalizes the operation and answers 500, after which the use case
// returns without touching GitHub again.
//
// `fail` and `checkpoint` stay here rather than moving into the gh runner or the
// committer: they are operation-finalization and cancellation concerns, and
// relocating them would change when cancellation is observed.

export interface CreateEnvironmentInstanceEntry {
  state: CanvasState;
}

export interface CreateEnvironmentDependencies
  extends AdmissionPorts, WorkflowScopeGhRunnerPorts {
  // --- request scope ---
  // Evaluated per request against this instance's server-owned token. Never a
  // construction-time value: the token is a per-instance randomUUID().
  isServerOwnedRequest(instanceId: string, request: IncomingMessage): boolean;
  getSelectedGitHubExecutor(
    operationId: string
  ): SelectedGhExecutor | null | undefined;
  readInstanceEntry(
    instanceId: string
  ): CreateEnvironmentInstanceEntry | undefined;

  // --- narration + operation finalization ---
  addLegacyStep(operation: CreateEnvironmentOperation, text: string): void;
  finalizeSetupFailure(
    operation: CreateEnvironmentOperation | null,
    input: Record<string, unknown>
  ): Promise<SetupFailureResponse>;
  persistMutationCheckpoint(input: {
    operation: CreateEnvironmentOperation | null;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
    fail: (status: number, error: string, code: string) => Promise<void>;
  }): Promise<boolean>;
  persistBestEffort(input: {
    operation: CreateEnvironmentOperation | null;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
  }): Promise<boolean>;
  // Honors a recorded stop between remote mutations. Returns false once it has
  // closed the operation and answered the request, so the caller must return
  // without touching Azure or GitHub again. Never called while a command is in
  // flight: Radius lets the current write finish and stops before the next one.
  guardStopBoundary(input: {
    operation: CreateEnvironmentOperation | null;
    boundary: string;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
    respond: (status: number, body: Record<string, unknown>) => void;
  }): Promise<boolean>;
  runAzCommand(
    args: string[]
  ): Promise<Partial<CreateEnvironmentCommandResult>>;

  // --- preflight ---
  preflightRepoAdmin(
    repo: string,
    executor?: SelectedGhExecutor
  ): Promise<string>;
  preflightGhcrPackageWriteAccess(
    executor?: SelectedGhExecutor
  ): Promise<GhcrPreflightResult>;
  readGitHubJson(
    apiPath: string,
    executor?: SelectedGhExecutor
  ): Promise<GitHubEnvironmentReadResult>;
  bootstrapGHCRStatePackage(input: {
    targetRepository: string;
    registry: string;
    credentials: unknown;
  }): Promise<{ visibility: string | undefined }>;
  stateRegistryForEnvironment(repo: string, environment: string): string;

  // --- committer ports ---
  getDefaultBranch(
    repo: string,
    executor?: SelectedGhExecutor
  ): Promise<string | null | undefined>;
  getBranchHeadSha(
    repo: string,
    branch: string,
    executor?: SelectedGhExecutor
  ): Promise<string | null | undefined>;
  createBranchRef(
    repo: string,
    branch: string,
    sha: string,
    executor?: SelectedGhExecutor
  ): Promise<{ ok: boolean; stderr: string }>;
  tempFile: WorkflowTempFilePort;

  // --- GitHub environment ---
  setCanonicalEnvironment(
    operation: CreateEnvironmentOperation,
    environment: string
  ): void;
  recordGitHubEnvironment(
    operation: CreateEnvironmentOperation,
    patch: {
      state: string;
      repo: string;
      name: string;
      providerId?: string | null;
      origin?: string;
    }
  ): void;
  // Promotes the environment this request wrote from "Radius may own this" to
  // "Radius created this", and only after the identity is durably saved. It
  // answers false when the ledger cannot match the proof, which leaves the safe
  // under-claim in place.
  promoteCreatedGitHubEnvironment(
    operation: CreateEnvironmentOperation,
    identity: { repo: string; name: string }
  ): boolean;
  envListCacheDelete(repo: string): void;
  ociStateBackend: string;
  defaultStateArchive: string;

  // --- credentials ---
  azureCredential(): Record<string, unknown>;
  awsCredential(): Record<string, unknown>;
  optionalString(value: unknown): string;

  // --- workflow generation and commit ---
  generateVerifyWorkflow(
    environment: string,
    provider: string
  ): Promise<string>;
  generateDeployWorkflow(
    environment: string,
    appFile: string
  ): Promise<Record<string, string>>;
  generateDeleteWorkflow(environment: string): Promise<Record<string, string>>;
  recordCommittedWorkflowFile(
    operation: CreateEnvironmentOperation,
    entry: {
      path: string;
      branch: string | null;
      mode: string;
      commitSha: string | null;
      blobSha: string | null;
      contentSha256: string | null;
      previousBlobSha: string | null;
      previousBlobKnown: boolean;
    }
  ): void;
  deleteLegacyDeployWorkflow(
    repo: string,
    executor?: SelectedGhExecutor,
    beforeDelete?: () => Promise<boolean>
  ): Promise<boolean | "cancelled">;
  createPullRequestApi(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
    executor?: SelectedGhExecutor
  ): Promise<CreateEnvironmentPullRequestResult>;

  // --- verification ---
  planCredentialVerification(input: {
    targetRepo: string;
    prState: { branch: string; base: string } | null;
    pullRequestUrl: string;
    fetchFile: (
      repo: string,
      path: string,
      branch: string
    ) => Promise<string | null | undefined>;
    resolveDefaultBranch: (repo: string) => Promise<string | null | undefined>;
  }): Promise<CredentialVerificationPlanResult>;
  fetchFileFromRepo(
    repo: string,
    path: string,
    branch: string,
    executor?: SelectedGhExecutor
  ): Promise<string | null | undefined>;
  buildVerifyWorkflowDispatchArgs(input: {
    workflowFile: string;
    targetRepo: string;
    envName: string;
    ref?: string;
    operationMarker?: string;
  }): string[];
  verifyWorkflowFile: string;
  stageVerify: string;

  // --- terminal state ---
  recordCleanupState(
    operation: CreateEnvironmentOperation,
    patch: { state: string }
  ): void;
  recordCommitState(
    operation: CreateEnvironmentOperation,
    patch: Record<string, unknown>
  ): void;
  setStageState(
    operation: CreateEnvironmentOperation,
    stage: string,
    state: string
  ): void;
  finish(
    operation: CreateEnvironmentOperation,
    state: string,
    options: Record<string, unknown>
  ): void;

  // --- clocks ---
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

export async function handleCreateEnvironment(
  context: CanvasRequestContext,
  dependencies: CreateEnvironmentDependencies
): Promise<void> {
  const { response } = context;
  const respond = (status: number, payload: unknown): void => {
    // Header order is observable: Content-Type is set before the status line.
    response.setHeader("Content-Type", "application/json");
    response.writeHead(status);
    response.end(JSON.stringify(payload));
  };

  // Rung 1, decided before the body is read.
  const serverOwnedRefusal = refuseUnlessServerOwned(
    dependencies.isServerOwnedRequest(context.instanceId, context.request)
  );
  if (serverOwnedRefusal) {
    respond(serverOwnedRefusal.status, serverOwnedRefusal.body);
    return;
  }

  const body = await context.readTextBody();
  // Declared out here so the generic catch below can close it rather than
  // discarding everything the route had learned.
  let op: CreateEnvironmentOperation | null = null;
  let steps: string[] = [];
  let deleteGitHubEnvironmentRunner:
    ((args: string[]) => Promise<unknown>) | null = null;
  // The cleanup's identity gate reads the environment back before deleting it.
  // It has to read through the same account the environment was created with,
  // or an access failure reads as "gone" and the delete goes out blind.
  let readGitHubEnvironmentRunner:
    ((args: string[]) => Promise<CreateEnvironmentCommandResult>) | null = null;
  try {
    const data: CreateEnvironmentRequestData = JSON.parse(body);
    const admission = await admitCreateEnvironmentRequest(data, dependencies);
    if (admission.outcome === "refused") {
      op = admission.operation;
      respond(admission.refusal.status, admission.refusal.body);
      return;
    }
    const { targetRepo, provider } = admission;
    let { envName } = admission;
    op = admission.operation;
    const operation = admission.operation;
    const selectedExecutor = dependencies.getSelectedGitHubExecutor(
      operation.operationId
    );
    if (!selectedExecutor) {
      throw new Error(
        "The selected GitHub account executor is unavailable. Re-check the account and retry."
      );
    }
    await selectedExecutor.verifyIdentity();
    deleteGitHubEnvironmentRunner = async (args) => {
      const result = await selectedExecutor.run(args);
      if (result.code !== 0 && result.code !== "0") {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(detail || "GitHub API request failed.");
      }
    };
    readGitHubEnvironmentRunner = selectedEnvironmentReader(selectedExecutor);

    steps = [];
    const rawPush = steps.push.bind(steps);
    steps.push = (...items: string[]) => {
      for (const item of items) {
        try {
          dependencies.addLegacyStep(operation, item);
        } catch {
          /* narration must never break setup */
        }
      }
      return rawPush(...items);
    };
    const stopBoundary = (boundary: string) =>
      dependencies.guardStopBoundary({
        operation,
        boundary,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        respond
      });
    const runMutationAttempt = async <T>(
      failureBoundary: string,
      mutate: () => Promise<T>
    ): Promise<{ completed: true; value: T } | { completed: false }> => {
      try {
        return { completed: true, value: await mutate() };
      } catch (error) {
        // Reconciliation still owns this operation and it is not terminal.
        // Honoring a Stop here would end it with the journal entry open and
        // nothing left to reconcile it, so the reconciling answer wins.
        if (
          error instanceof ProviderMutationRecoveryError &&
          error.code === "provider-mutation-outcome-unknown"
        ) {
          throw error;
        }
        if (!(await stopBoundary(failureBoundary))) {
          return { completed: false };
        }
        throw error;
      }
    };

    if (
      !(await dependencies.guardStopBoundary({
        operation,
        boundary: "before-github-environment",
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        respond
      }))
    ) {
      return;
    }

    // Preflight repo access + admin BEFORE any GitHub mutation. Reachable
    // directly when credentials already exist and azure-auto-setup is skipped,
    // so guarding here too is required.
    const accessMsg = await dependencies.preflightRepoAdmin(
      targetRepo,
      selectedExecutor
    );
    if (accessMsg) {
      if (!(await stopBoundary("before-setup-failure-cleanup"))) return;
      const failure = await dependencies.finalizeSetupFailure(operation, {
        status: 403,
        error: accessMsg,
        code: "repo-admin-required",
        stage: dependencies.stageConfigureEnvironment,
        classification: "needs-someone-else",
        steps,
        runAz:
          provider === "azure" ?
            (args: string[]) => dependencies.runAzCommand(args)
          : null,
        runDeleteEnvironment: deleteGitHubEnvironmentRunner,
        readEnvironment: readGitHubEnvironmentRunner
      });
      respond(failure.status, failure.body);
      return;
    }

    const ghcrPreflight =
      await dependencies.preflightGhcrPackageWriteAccess(selectedExecutor);
    if (!ghcrPreflight.ok) {
      if (!(await stopBoundary("before-setup-failure-cleanup"))) return;
      const failure = await dependencies.finalizeSetupFailure(operation, {
        status: 403,
        error: ghcrPreflight.error,
        code: ghcrPreflight.code,
        steps,
        runDeleteEnvironment: deleteGitHubEnvironmentRunner,
        readEnvironment: readGitHubEnvironmentRunner
      });
      respond(failure.status, failure.body);
      return;
    }
    const packageCredentials = ghcrPreflight.credentials;

    let ensuredEnvironment = readEnsuredGitHubEnvironment(
      operation,
      targetRepo,
      envName
    );
    try {
      ensuredEnvironment ??= await ensureGitHubEnvironment({
        repo: targetRepo,
        requestedName: envName,
        readGitHubJson: (apiPath) =>
          dependencies.readGitHubJson(apiPath, selectedExecutor),
        runGh: (args) => selectedExecutor.run(args),
        mutationRecovery: {
          operation,
          persist: () => dependencies.persistOperations()
        },
        beforeCreate: () => stopBoundary("before-github-environment-create"),
        now: dependencies.now
      });
    } catch (error) {
      if (error instanceof GitHubEnvironmentEnsureCancelled) return;
      if (
        error instanceof GitHubEnvironmentEnsureError &&
        error.createdCandidate
      ) {
        dependencies.recordGitHubEnvironment(operation, {
          state: "created_candidate",
          repo: error.createdCandidate.repo,
          name: error.createdCandidate.name
        });
      }
      if (!(await stopBoundary("after-github-environment-attempt"))) return;
      throw error;
    }
    const requestedEnvName = envName;
    envName = ensuredEnvironment.name;
    dependencies.setCanonicalEnvironment(operation, envName);

    const runner = createWorkflowScopeGhRunner(
      dependencies,
      {
        targetRepo,
        envName
      },
      selectedExecutor
    );
    const { runGh, setEnvironmentVariable, runGhWorkflow } = runner;

    const fail = async (
      status: number,
      error: string,
      code: string,
      extra: Record<string, unknown> = {}
    ): Promise<void> => {
      if (!(await stopBoundary("before-setup-failure-cleanup"))) return;
      const failure = await dependencies.finalizeSetupFailure(operation, {
        status,
        error,
        code,
        extra,
        steps,
        evidence:
          typeof extra.azError === "string" ? extra.azError
          : typeof extra.ghError === "string" ? extra.ghError
          : null,
        runAz:
          provider === "azure" ?
            (args: string[]) => dependencies.runAzCommand(args)
          : null,
        runDeleteEnvironment: deleteGitHubEnvironmentRunner,
        readEnvironment: readGitHubEnvironmentRunner
      });
      respond(failure.status, failure.body);
    };
    // Both gates in one call: the checkpoint saves the provenance of the write
    // that just finished, and the boundary then decides whether a stop recorded
    // while it ran should be honored before the next write starts.
    const checkpoint = async (boundary = "environment-mutation") => {
      const saved = await dependencies.persistMutationCheckpoint({
        operation,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        fail
      });
      if (!saved) return false;
      return stopBoundary(boundary);
    };

    dependencies.recordGitHubEnvironment(operation, {
      state: ensuredEnvironment.state,
      repo: targetRepo,
      name: envName,
      providerId: ensuredEnvironment.providerId,
      origin: ensuredEnvironment.state === "reused" ? "pre_existing" : "unknown"
    });
    if (
      ensuredEnvironment.creationProof?.proven &&
      dependencies.promoteCreatedGitHubEnvironment(operation, {
        repo: targetRepo,
        name: envName
      })
    ) {
      steps.push(
        `✅ GitHub environment "${envName}" created by this setup — Radius owns it and can remove it.`
      );
    } else if (
      ensuredEnvironment.state === "created_candidate" &&
      ensuredEnvironment.creationProof &&
      !ensuredEnvironment.creationProof.proven
    ) {
      steps.push(
        `ℹ️ Radius left GitHub environment "${envName}" outside its cleanup scope. ${ensuredEnvironment.creationProof.detail}`
      );
    }
    if (requestedEnvName === envName) {
      steps.push(`✅ GitHub environment "${envName}" resolved.`);
    } else {
      steps.push(
        `✅ GitHub resolved requested environment "${requestedEnvName}" as "${envName}".`
      );
    }
    if (!(await checkpoint("after-github-environment"))) return;

    const defaultBranch =
      (await dependencies.getDefaultBranch(targetRepo, selectedExecutor)) ||
      "main";
    const stateRegistry = dependencies.stateRegistryForEnvironment(
      targetRepo,
      envName
    );

    steps.push(
      'Creating private GHCR state package "' + stateRegistry + '"...'
    );
    if (!(await stopBoundary("before-ghcr-state-package"))) return;
    // Bootstrap is one atomic boundary: the manifest push, visibility check, and
    // repository linkage must finish together before the package is usable.
    const statePackageAttempt = await runMutationAttempt(
      "after-ghcr-state-package-attempt",
      () =>
        dependencies.bootstrapGHCRStatePackage({
          targetRepository: targetRepo,
          registry: stateRegistry,
          credentials: packageCredentials
        })
    );
    if (!statePackageAttempt.completed) return;
    const statePackage = statePackageAttempt.value;
    steps.push(
      `✅ GHCR state package is ${statePackage.visibility} and linked to ${targetRepo}.`
    );
    if (!(await checkpoint("after-ghcr-state-package"))) return;

    const committer = createWorkflowFileCommitter(
      {
        runGh: (args) => runGh(args),
        runGhWorkflow: (args) => runGhWorkflow(args),
        getDefaultBranch: (repo) =>
          dependencies.getDefaultBranch(repo, selectedExecutor),
        getBranchHeadSha: (repo, branch) =>
          dependencies.getBranchHeadSha(repo, branch, selectedExecutor),
        createBranchRef: (repo, branch, sha) =>
          dependencies.createBranchRef(repo, branch, sha, selectedExecutor),
        tempFile: dependencies.tempFile,
        errorMessage: (error) => dependencies.errorMessage(error),
        pushStep: (message) => {
          steps.push(message);
        },
        mutationRecovery: {
          operation,
          persist: () => dependencies.persistOperations(),
          beforeMutation: async () => {
            if (
              shouldStop(operation) &&
              unresolvedProviderMutations(operation).length > 0
            ) {
              throw new ProviderMutationRecoveryError(
                "Radius must reconcile the existing provider request before it can honor Stop or write another workflow.",
                "provider-mutation-outcome-unknown"
              );
            }
            return stopBoundary("before-workflow-provider-mutation");
          }
        },
        now: () => dependencies.now()
      },
      { targetRepo, envName }
    );
    const commitWorkflowFileSmart = committer.commitWorkflowFileSmart;
    const prBranch = (): string | null =>
      committer.pullRequestState()?.branch || null;

    // Tag the environment as Radius-managed so the listing can filter out
    // environments created outside this extension.
    if (!(await stopBoundary("before-radius-managed-variable"))) return;
    const managedVariable = await runMutationAttempt(
      "after-radius-managed-variable-attempt",
      () => setEnvironmentVariable("RADIUS_MANAGED", "true")
    );
    if (!managedVariable.completed) return;
    // A new environment invalidates the cached listing for this repo.
    dependencies.envListCacheDelete(targetRepo);
    if (!(await checkpoint("after-radius-managed-variable"))) return;

    steps.push('Configuring Radius state package "' + stateRegistry + '"...');
    if (!(await stopBoundary("before-state-package-configuration"))) return;
    // These values form one backend contract. Stopping between them would leave
    // a backend selected without the registry or archive needed to read it.
    const stateConfiguration = await runMutationAttempt(
      "after-state-package-configuration-attempt",
      async () => {
        await setEnvironmentVariable(
          "RADIUS_STATE_BACKEND",
          dependencies.ociStateBackend
        );
        await setEnvironmentVariable("RADIUS_STATE_REGISTRY", stateRegistry);
        await setEnvironmentVariable(
          "RADIUS_STATE_ARCHIVE",
          dependencies.defaultStateArchive
        );
      }
    );
    if (!stateConfiguration.completed) return;
    steps.push(
      `✅ Radius state package configured with archive tag "${dependencies.defaultStateArchive}".`
    );
    if (!(await checkpoint("after-state-package-configuration"))) return;

    // Record the credential profile this environment was created from so the
    // Environments listing can show it in the Credentials column.
    if (data.profileName) {
      if (!(await stopBoundary("before-credential-profile-variable"))) return;
      const profileVariable = await runMutationAttempt(
        "after-credential-profile-variable-attempt",
        () =>
          setEnvironmentVariable("RADIUS_CREDENTIAL_PROFILE", data.profileName)
      );
      if (!profileVariable.completed) return;
      if (!(await checkpoint("after-credential-profile-variable"))) return;
    }

    // Step 2: Set environment variables and secrets based on provider
    if (!(await stopBoundary("before-provider-configuration"))) return;
    // Provider identity fields are a coherent login contract. Exposing a Stop
    // between individual values would preserve a credential set that cannot
    // identify one principal, tenant, and subscription together.
    const providerConfiguration = await runMutationAttempt(
      "after-provider-configuration-attempt",
      () =>
        applyProviderConfiguration(provider, data, {
          azureCredential: () => dependencies.azureCredential(),
          awsCredential: () => dependencies.awsCredential(),
          optionalString: (value) => dependencies.optionalString(value),
          setEnvironmentVariable,
          pushStep: (message) => {
            steps.push(message);
          }
        })
    );
    if (!providerConfiguration.completed) return;
    const { credentialsComplete, missingCredNote } =
      providerConfiguration.value;
    if (!(await checkpoint("after-provider-configuration"))) return;
    // When verification is deliberately not dispatched (incomplete cloud
    // credentials, or workflows that only exist on a PR branch), this holds the
    // reason so the response can signal the client to skip polling
    // /api/verify-status, which would otherwise spin until the timeout.
    let verifySkipReason = "";

    // This is the commit point. After it, a stop keeps the resources in place
    // rather than removing them, because the workflow files may already be
    // visible to the repository.
    if (!(await stopBoundary("before-workflow-commit"))) return;

    // Steps 3, 4 and 4b: publish the verify, deploy and delete workflow files.
    // `gate` is this use case's own `checkpoint`, passed in so the gates fire at
    // the same points they did inline; the publisher never finalizes or
    // responds, so `fail` is still called from here alone.
    const published = await publishWorkflowFiles(
      {
        generateVerifyWorkflow: (environment, workflowProvider) =>
          dependencies.generateVerifyWorkflow(environment, workflowProvider),
        generateDeployWorkflow: (environment, appFile) =>
          dependencies.generateDeployWorkflow(environment, appFile),
        generateDeleteWorkflow: (environment) =>
          dependencies.generateDeleteWorkflow(environment),
        commitWorkflowFileSmart,
        recordCommittedWorkflowFile: (op, entry) =>
          dependencies.recordCommittedWorkflowFile(op, entry),
        deleteLegacyDeployWorkflow: (repo) =>
          dependencies.deleteLegacyDeployWorkflow(repo, selectedExecutor, () =>
            stopBoundary("before-legacy-workflow-delete")
          ),
        usingPullRequestBranch: () => Boolean(committer.pullRequestState()),
        pullRequestBranch: prBranch,
        errorMessage: (error) => dependencies.errorMessage(error),
        pushStep: (message) => {
          steps.push(message);
        },
        gate: () => checkpoint("after-workflow-commit")
      },
      { operation, targetRepo, envName, provider, defaultBranch }
    );
    if (published.outcome === "cancelled") return;
    if (published.outcome === "refused") {
      await fail(published.status, published.error, published.code, {
        steps,
        ghError: published.ghError
      });
      return;
    }

    // Step 4c: If any workflow commit fell back to a PR branch, open the pull
    // request now so the user can merge it. Until it's merged, the workflows
    // don't exist on the default branch, so we skip dispatching the verify run
    // (it would 404) and tell the user to merge first.
    let pullRequestUrl = "";
    const prState = committer.pullRequestState();
    if (prState) {
      const prTitle = "Add Radius deploy workflows for environment " + envName;
      const prBody = [
        "This PR adds the GitHub Actions workflows that power the Radius extension for the **" +
          envName +
          "** environment:",
        "",
        "- `.github/workflows/radius-verify-credentials.yml`",
        "- Radius deploy workflow(s) under `.github/workflows/`",
        "- Radius delete workflow(s) under `.github/workflows/`",
        "",
        "They were committed to `" +
          prState.branch +
          "` because direct pushes to `" +
          prState.base +
          "` are not permitted. Merge this PR to enable deploying and deleting the application from the Radius canvas."
      ].join("\n");
      const prMutationKind = "github_pull_request.create";
      const prMutationTarget = `${targetRepo}:${prState.branch}:${prState.base}`;
      // Only a forward create is stoppable. A journaled attempt that reaches
      // here to be reconciled is a read, and stopping before it would strand the
      // provenance of a request nobody saw answered.
      if (
        providerMutationWillWrite(
          operation,
          prMutationKind,
          prMutationTarget
        ) &&
        !(await stopBoundary("before-workflow-pull-request"))
      )
        return;
      const prAttempt = await runMutationAttempt(
        "after-workflow-pull-request-attempt",
        () =>
          executeRecoverableMutation<CreateEnvironmentPullRequestResult>({
            operation,
            kind: prMutationKind,
            target: prMutationTarget,
            providerIdempotencyKey: prState.branch,
            persist: () => dependencies.persistOperations(),
            mutate: async () => {
              const result = await dependencies.createPullRequestApi(
                targetRepo,
                prState.branch,
                prState.base,
                prTitle,
                prBody,
                selectedExecutor
              );
              return {
                code: result.ok ? 0 : 1,
                stdout: result.ok ? JSON.stringify(result) : "",
                stderr: result.stderr || "",
                timedOut: result.timedOut
              };
            },
            accept: (result) =>
              JSON.parse(result.stdout) as CreateEnvironmentPullRequestResult,
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
                  ok: true,
                  url: matches[0].html_url,
                  number: matches[0].number
                },
                evidence:
                  "The pull request head and base match the operation-specific branch provenance."
              };
            }
          })
      );
      if (!prAttempt.completed) return;
      const prMutation = prAttempt.value;
      const pr: CreateEnvironmentPullRequestResult =
        prMutation.state === "applied" ?
          prMutation.value
        : {
            ok: false,
            stderr: "GitHub confirmed the pull request was not created."
          };
      if (pr.ok) {
        pullRequestUrl = pr.url || "";
        steps.push("✅ Opened pull request #" + pr.number + ": " + pr.url);
        steps.push(
          '👉 Merge the pull request above to finish setup; credential verification and deploys run once it lands on "' +
            prState.base +
            '".'
        );
      } else {
        steps.push(
          '⚠️ Committed workflows to branch "' +
            prState.branch +
            '" but could not open a pull request automatically: ' +
            ((pr.stderr || "").trim() || "GitHub API request failed.") +
            ' Open one manually from that branch into "' +
            prState.base +
            '".'
        );
      }
      // Record the commit identity before the boundary. A stop honored here must
      // still be able to tell the customer the workflows were committed, where,
      // and which pull request carries them.
      dependencies.recordCommitState(operation, {
        mode: "pull_request",
        branch: prState.branch,
        baseBranch: prState.base,
        pullRequestUrl: pullRequestUrl || null
      });
      if (!(await checkpoint("after-workflow-pull-request"))) return;
    }
    // Step 5: Dispatch the verify workflow.
    //
    // On the PR path this used to be an unconditional skip, which was right for
    // a first-time setup and wrong for every repository that already had the
    // workflows on its default branch. planCredentialVerification decides
    // instead, and returns an empty pullRequestUrl when it dispatches so a
    // merely informational PR is not mistaken for a blocking one.
    let verifyRunUrl = "";
    let verifyRunId: string | number | null = null;
    const dispatchedAt = dependencies.now();
    let verificationRef = defaultBranch;
    let baselineRunId: number | null = null;
    let verificationManualReason = "";
    const verifyPlan = await dependencies.planCredentialVerification({
      targetRepo,
      prState: prState || null,
      pullRequestUrl,
      fetchFile: (repo, path, branch) =>
        dependencies.fetchFileFromRepo(repo, path, branch, selectedExecutor),
      resolveDefaultBranch: (repo) =>
        dependencies.getDefaultBranch(repo, selectedExecutor)
    });
    pullRequestUrl = verifyPlan.pullRequestUrl;
    if (prState && verifyPlan.shouldDispatch) {
      // The pull request is informational when verification can run from the
      // branch immediately. Preserve the pre-existing non-blocking projection
      // after the earlier provenance checkpoint recorded the actual PR.
      dependencies.recordCommitState(operation, {
        mode: "pull_request",
        branch: prState.branch,
        baseBranch: prState.base,
        pullRequestUrl: null
      });
    }
    if (!verifyPlan.shouldDispatch) {
      verifySkipReason =
        verifyPlan.skipReason ||
        "Credential verification will run automatically once the workflows are on the default branch.";
      steps.push(
        `⏭️ Skipping credential verification until the pull request is merged — ${
          verifyPlan.skipReason ||
          "the workflows are not on the default branch yet"
        }.`
      );
    } else if (!credentialsComplete) {
      // The identifying cloud credentials the verify workflow needs to log in
      // weren't configured, so dispatching would only produce a run that fails
      // at the cloud-login step (issue #219). Skip it and tell the user how to
      // finish, rather than surfacing an unexplained failure.
      verifySkipReason = missingCredNote;
      steps.push(
        "⏭️ Skipping credential verification — cloud credentials are not fully configured. " +
          missingCredNote
      );
    } else {
      if (verifyPlan.ref)
        steps.push(
          `ℹ️ The verify workflow is already on "${verifyPlan.defaultBranch}", so verification runs now against branch "${verifyPlan.ref}" rather than waiting for the merge.`
        );
      steps.push("Dispatching verify-credentials workflow...");
      if (!(await stopBoundary("before-verification-dispatch"))) return;
      // Wait briefly for GitHub to index the workflow. The dispatch itself is
      // issued once: if Radius loses the response, it discovers and adopts the
      // accepted run instead of dispatching a duplicate.
      await dependencies.sleep(3000);
      const baselineResult = await runGh([
        "run",
        "list",
        "--workflow=" + dependencies.verifyWorkflowFile,
        "--limit",
        "1",
        "--json",
        "databaseId",
        "--repo",
        targetRepo
      ]);
      if (baselineResult.code !== 0 && baselineResult.code !== "0") {
        await fail(
          502,
          "Radius could not read the verification-run baseline, so it did not dispatch the workflow. Retry after GitHub Actions run history is readable.",
          "verify-baseline-read-failed",
          {
            steps,
            ghError: baselineResult.stderr || baselineResult.stdout || ""
          }
        );
        return;
      }
      baselineRunId = null;
      try {
        const parsed: unknown = JSON.parse(baselineResult.stdout);
        if (!Array.isArray(parsed)) throw new Error("expected an array");
        const first = Array.isArray(parsed) ? parsed[0] : null;
        if (
          first &&
          typeof first === "object" &&
          "databaseId" in first &&
          Number.isFinite(Number(first.databaseId))
        ) {
          baselineRunId = Number(first.databaseId);
        }
      } catch {
        await fail(
          502,
          "GitHub returned an unreadable verification-run baseline, so Radius did not dispatch the workflow.",
          "verify-baseline-read-failed",
          { steps }
        );
        return;
      }
      verificationRef = verifyPlan.ref || defaultBranch;
      const supportsOperationMarker =
        verifyPlan.supportsOperationMarker !== false;
      const operationMarker =
        supportsOperationMarker ? operation.operationId : "";
      const verificationActionsUrl =
        `https://github.com/${targetRepo}/actions/workflows/` +
        encodeURIComponent(dependencies.verifyWorkflowFile);
      operation.verification = {
        dispatchedAt,
        workflow: dependencies.verifyWorkflowFile,
        ref: verificationRef,
        environment: envName,
        event: "workflow_dispatch",
        operationMarker: operationMarker || null,
        baselineRunId,
        runId: null,
        runUrl: null
      };
      const discoverAcceptedRun = async (): Promise<
        | { state: "applied"; value: string; evidence: string }
        | { state: "manual_required"; guidance: string }
      > => {
        const runsResult = await runGh([
          "run",
          "list",
          "--workflow=" + dependencies.verifyWorkflowFile,
          "--limit",
          "10",
          "--json",
          "databaseId,createdAt,displayTitle,event,headBranch",
          "--repo",
          targetRepo
        ]);
        if (runsResult.code !== 0 && runsResult.code !== "0") {
          throw new Error(
            runsResult.stderr ||
              runsResult.stdout ||
              "GitHub workflow runs could not be read."
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(runsResult.stdout);
        } catch {
          throw new Error("GitHub returned an unreadable workflow run list.");
        }
        if (!operationMarker) {
          return {
            state: "manual_required",
            guidance: `The installed verification workflow does not expose Radius's operation marker. Check the accepted run in ${verificationActionsUrl}; Radius will not guess which run belongs to this operation or dispatch another one.`
          };
        }
        const exact = findExactVerificationRun(parsed, {
          baselineRunId,
          dispatchedAt,
          ref: verificationRef,
          environment: envName,
          operationMarker
        });
        if (exact.state === "applied") {
          return {
            state: "applied",
            value: exact.runId,
            evidence:
              "The workflow, ref, environment, event, and operation-specific run title matched exactly."
          };
        }
        if (exact.state === "ambiguous") {
          return {
            state: "manual_required",
            guidance: `Multiple verification runs carry this operation's exact marker. Check ${verificationActionsUrl}; Radius will not choose one or dispatch another run.`
          };
        }
        if (
          hasPostDispatchVerificationRuns(parsed, baselineRunId, dispatchedAt)
        ) {
          return {
            state: "manual_required",
            guidance:
              `GitHub exposed one or more new verification runs, but none matches this operation's exact workflow/ref/environment/event marker. ` +
              `Check ${verificationActionsUrl}; Radius will not adopt or redispatch a run.`
          };
        }
        throw new Error(
          "No verification run with this operation's exact marker is visible yet."
        );
      };
      const dispatchMutationKind = "github_workflow.dispatch";
      const dispatchMutationTarget = `${targetRepo}:${dependencies.verifyWorkflowFile}:${verificationRef}:${envName}`;
      // The boundary above guarded the indexing wait and the baseline read. This
      // one guards the write itself, so a stop recorded while those reads ran is
      // honored before GitHub is asked to start a run. A journaled attempt that
      // reaches here only to be reconciled is a read, and is never stopped.
      if (
        providerMutationWillWrite(
          operation,
          dispatchMutationKind,
          dispatchMutationTarget
        ) &&
        !(await stopBoundary("before-verification-dispatch-attempt:1"))
      )
        return;
      const dispatch = await executeRecoverableMutation({
        operation,
        kind: dispatchMutationKind,
        target: dispatchMutationTarget,
        // The marker travels with the intent, so a recovery reads the identity
        // this dispatch sent rather than re-deriving one that may have changed.
        providerIdempotencyKey: operationMarker || null,
        persist: () => dependencies.persistOperations(),
        mutate: () =>
          runGhWorkflow(
            dependencies.buildVerifyWorkflowDispatchArgs({
              workflowFile: dependencies.verifyWorkflowFile,
              targetRepo,
              envName,
              ref: verifyPlan.ref,
              operationMarker
            })
          ),
        accept: () => "",
        reconcile: async () => {
          for (const delay of [0, 2000, 5000]) {
            if (delay > 0) await dependencies.sleep(delay);
            try {
              return await discoverAcceptedRun();
            } catch {
              if (delay === 5000)
                throw new Error(
                  "GitHub has not exposed an accepted verification run yet."
                );
            }
          }
          throw new Error(
            "GitHub has not exposed an accepted verification run."
          );
        }
      });
      const dispatchResult =
        dispatch.state === "applied" ?
          { code: 0, stdout: "", stderr: "" }
        : dispatch.result || {
            code: 1,
            stdout: "",
            stderr: "GitHub confirmed the dispatch was not accepted."
          };

      if (dispatchResult.code === 0) {
        steps.push("✅ Credentials verification dispatched.");
        if (dispatch.state === "applied" && dispatch.recovered) {
          verifyRunId = dispatch.value;
        } else if (!operationMarker) {
          verificationManualReason =
            `GitHub accepted verification, but the installed legacy workflow cannot expose an operation-specific run marker. ` +
            `Review the run in ${verificationActionsUrl}. Radius will not adopt or redispatch it.`;
          verifyRunUrl = verificationActionsUrl;
        } else {
          await dependencies.sleep(5000);
          try {
            const discovered = await discoverAcceptedRun();
            if (discovered.state === "applied") {
              verifyRunId = discovered.value;
            } else {
              verificationManualReason = discovered.guidance;
              verifyRunUrl = verificationActionsUrl;
            }
          } catch {
            verificationManualReason =
              `GitHub accepted verification, but Radius could not confirm the exact marked run. ` +
              `Review ${verificationActionsUrl}; Radius will not adopt another run or dispatch again.`;
            verifyRunUrl = verificationActionsUrl;
          }
        }
        if (verifyRunId !== null) {
          verifyRunUrl =
            "https://github.com/" + targetRepo + "/actions/runs/" + verifyRunId;
          steps.push("Verify run: " + verifyRunUrl);
        }
      } else {
        // The dispatch settled its own provenance before returning, so the stop
        // is honored here rather than inside the automatic cleanup below.
        if (!(await stopBoundary("after-verification-dispatch-attempt:1")))
          return;
        const detail =
          (dispatchResult.stderr || dispatchResult.stdout || "").trim() ||
          "The GitHub CLI request failed.";
        steps.push("❌ Could not dispatch verify workflow: " + detail);
        await fail(
          400,
          "Environment and state package were configured, but GitHub definitively rejected the verify workflow dispatch. " +
            detail,
          "verify-dispatch-failed",
          {
            environment: envName,
            event: "workflow_dispatch",
            operationMarker:
              verifyPlan.supportsOperationMarker !== false ?
                operation.operationId
              : null,
            provider,
            repo: targetRepo,
            stateBackend: dependencies.ociStateBackend,
            stateRegistry,
            stateArchive: dependencies.defaultStateArchive,
            steps,
            ghError: detail
          }
        );
        return;
      }
    }

    // Record dispatch markers so the deploy monitor can track the correct
    // (newly-triggered) runs rather than any stale runs.
    {
      const priorVerification =
        (
          operation.verification !== null &&
          typeof operation.verification === "object"
        ) ?
          operation.verification
        : {};
      const priorOperationMarker =
        (
          "operationMarker" in priorVerification &&
          typeof priorVerification.operationMarker === "string"
        ) ?
          priorVerification.operationMarker
        : "";
      operation.verification = {
        ...priorVerification,
        dispatchedAt,
        workflow: dependencies.verifyWorkflowFile,
        ref: verificationRef,
        event: "workflow_dispatch",
        operationMarker:
          priorOperationMarker || (prState ? operation.operationId : null),
        baselineRunId,
        environment: envName,
        runId: verifyRunId == null ? null : String(verifyRunId),
        runUrl: verifyRunUrl || null
      };
      if (verifyPlan.shouldDispatch)
        dependencies.enterStage(operation, dependencies.stageVerify);
      // Record the commit identity, including any pull request, before the
      // safe-boundary check. A stop honored here must still be able to tell the
      // customer that the workflows were committed and where.
      if (!prState) {
        dependencies.recordCommitState(operation, {
          mode: verifyPlan.shouldDispatch ? "default_branch" : "pull_request",
          branch: defaultBranch,
          baseBranch: verifyPlan.defaultBranch || defaultBranch,
          pullRequestUrl: pullRequestUrl || null
        });
      }
      if (!(await checkpoint("after-verification-dispatch"))) return;
      const entry = dependencies.readInstanceEntry(context.instanceId);
      if (entry) {
        entry.state.deployDispatchedAt = dispatchedAt;
        entry.state.verifyRunId = verifyRunId;
        entry.state.verifyRunUrl = verifyRunUrl;
      }
    }

    const actionRequired =
      !verifyPlan.shouldDispatch || verificationManualReason !== "";
    dependencies.recordCleanupState(operation, { state: "not_needed" });
    if (actionRequired) {
      // The third terminal state, and the one the product kept getting wrong.
      // Verification was never dispatched, so there is nothing to wait for and
      // nothing failed — the operation is finished and the remaining work is the
      // user's. The client used to poll for a verify run that could not exist
      // and, eight minutes later, reported this as a timeout.
      dependencies.setStageState(
        operation,
        dependencies.stageVerify,
        "skipped"
      );
      dependencies.finish(operation, "action_required", {
        terminal: {
          reason:
            verificationManualReason ?
              "verification-run-manual"
            : "pr-merge-required",
          pullRequestUrl: pullRequestUrl || null,
          branch: prState?.branch || null,
          baseBranch: prState?.base || verifyPlan.defaultBranch || null,
          userMessage:
            verificationManualReason ||
            (pullRequestUrl ?
              "Merge the pull request to finish setup; credential verification and deploys run once it lands."
            : `Open and merge a pull request from "${
                prState?.branch || "the setup branch"
              }" into "${
                prState?.base ||
                verifyPlan.defaultBranch ||
                "the default branch"
              }" to finish setup.`)
        }
      });
      await dependencies.persistBestEffort({
        operation,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic)
      });
    } else if (!credentialsComplete) {
      // Verify was deliberately not dispatched because the identifying cloud
      // credentials are incomplete (issue #219). There is no run to wait for, so
      // finish the operation as action_required carrying the reason, rather than
      // leaving it in progress polling a verify run that will never exist.
      dependencies.recordCommitState(operation, {
        mode: prState ? "pull_request" : "default_branch",
        branch: prState?.branch || defaultBranch,
        baseBranch: prState?.base || verifyPlan.defaultBranch || defaultBranch,
        pullRequestUrl: pullRequestUrl || null
      });
      dependencies.setStageState(
        operation,
        dependencies.stageVerify,
        "skipped"
      );
      dependencies.finish(operation, "action_required", {
        terminal: {
          reason: "credentials-incomplete",
          pullRequestUrl: pullRequestUrl || null,
          userMessage: missingCredNote
        }
      });
      await dependencies.persistBestEffort({
        operation,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic)
      });
    } else {
      // Verification is dispatched but still running; stage, commit identity,
      // and exact dispatch identity were persisted together above.
    }

    respond(200, {
      success: true,
      operationId: operation.operationId,
      environment: envName,
      provider,
      repo: targetRepo,
      stateBackend: dependencies.ociStateBackend,
      stateRegistry,
      stateArchive: dependencies.defaultStateArchive,
      verifyRunUrl,
      // Stated, not inferred. A pull request can exist on a run that verified
      // perfectly well, so the client must not read a URL as a control-flow
      // decision — that inference is what #247 was.
      actionRequired,
      pullRequestUrl,
      pullRequestBranch: actionRequired ? prState?.branch || null : null,
      pullRequestBaseBranch:
        actionRequired ?
          prState?.base || verifyPlan.defaultBranch || null
        : null,
      // Distinct signal for a deliberately-skipped verification (incomplete
      // cloud credentials, or workflows not yet on the default branch) so a
      // direct API caller can tell it apart from a dispatched run; the canvas
      // itself reads the operation's terminal state, not this field.
      verifySkipped: verifySkipReason !== "",
      verifySkipReason,
      steps
    });
  } catch (e) {
    // Reconciliation still owns this operation and it is not terminal. A stop
    // recorded now is honored by the reconciling pass at its own boundary;
    // ending the operation here would strand the journal entry unreconciled.
    if (
      e instanceof ProviderMutationRecoveryError &&
      e.code === "provider-mutation-outcome-unknown" &&
      op
    ) {
      respond(202, {
        operationId: op.operationId,
        code: e.code,
        reconciling: true,
        message: e.message
      });
      return;
    }
    if (
      op &&
      !(await dependencies.guardStopBoundary({
        operation: op,
        boundary: "before-setup-failure-cleanup",
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        respond
      }))
    ) {
      return;
    }
    const failure = await dependencies.finalizeSetupFailure(op, {
      status: 400,
      error: dependencies.errorMessage(e),
      code:
        e instanceof ProviderMutationRecoveryError ?
          e.code
        : "create-environment-unhandled",
      classification: "unknown",
      evidence: e instanceof Error ? e.stack || null : null,
      steps,
      runAz:
        op && op.provider === "azure" ?
          (args: string[]) => dependencies.runAzCommand(args)
        : null,
      runDeleteEnvironment: deleteGitHubEnvironmentRunner,
      readEnvironment: readGitHubEnvironmentRunner
    });
    respond(failure.status, failure.body);
  }
}

export function createCreateEnvironmentRoutes(
  dependencies: CreateEnvironmentDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/create-environment": (context) =>
      handleCreateEnvironment(context, dependencies)
  };
}
