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
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment
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
    patch: { state: string; repo: string; name: string }
  ): void;
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
    entry: { path: string; branch: string | null; mode: string }
  ): void;
  deleteLegacyDeployWorkflow(
    repo: string,
    executor?: SelectedGhExecutor
  ): Promise<boolean>;
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

    // Preflight repo access + admin BEFORE any GitHub mutation. Reachable
    // directly when credentials already exist and azure-auto-setup is skipped,
    // so guarding here too is required.
    const accessMsg = await dependencies.preflightRepoAdmin(
      targetRepo,
      selectedExecutor
    );
    if (accessMsg) {
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
          : null
      });
      respond(failure.status, failure.body);
      return;
    }

    const ghcrPreflight =
      await dependencies.preflightGhcrPackageWriteAccess(selectedExecutor);
    if (!ghcrPreflight.ok) {
      const failure = await dependencies.finalizeSetupFailure(operation, {
        status: 403,
        error: ghcrPreflight.error,
        code: ghcrPreflight.code,
        steps
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
        runGh: (args) => selectedExecutor.run(args)
      });
    } catch (error) {
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

    deleteGitHubEnvironmentRunner = async (args) => {
      const result = await runGh(args);
      if (result.code !== 0 && result.code !== "0") {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(detail || "GitHub API request failed.");
      }
    };

    const fail = async (
      status: number,
      error: string,
      code: string,
      extra: Record<string, unknown> = {}
    ): Promise<void> => {
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
        runDeleteEnvironment: deleteGitHubEnvironmentRunner
      });
      respond(failure.status, failure.body);
    };
    const checkpoint = () =>
      dependencies.persistMutationCheckpoint({
        operation,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        fail
      });

    dependencies.recordGitHubEnvironment(operation, {
      state: ensuredEnvironment.state,
      repo: targetRepo,
      name: envName
    });
    if (requestedEnvName === envName) {
      steps.push(`✅ GitHub environment "${envName}" resolved.`);
    } else {
      steps.push(
        `✅ GitHub resolved requested environment "${requestedEnvName}" as "${envName}".`
      );
    }
    if (!(await checkpoint())) return;

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
    const statePackage = await dependencies.bootstrapGHCRStatePackage({
      targetRepository: targetRepo,
      registry: stateRegistry,
      credentials: packageCredentials
    });
    steps.push(
      `✅ GHCR state package is ${statePackage.visibility} and linked to ${targetRepo}.`
    );

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
        now: () => dependencies.now()
      },
      { targetRepo, envName }
    );
    const commitWorkflowFileSmart = committer.commitWorkflowFileSmart;
    const prBranch = (): string | null =>
      committer.pullRequestState()?.branch || null;

    // Tag the environment as Radius-managed so the listing can filter out
    // environments created outside this extension.
    await setEnvironmentVariable("RADIUS_MANAGED", "true");
    // A new environment invalidates the cached listing for this repo.
    dependencies.envListCacheDelete(targetRepo);

    steps.push('Configuring Radius state package "' + stateRegistry + '"...');
    await setEnvironmentVariable(
      "RADIUS_STATE_BACKEND",
      dependencies.ociStateBackend
    );
    await setEnvironmentVariable("RADIUS_STATE_REGISTRY", stateRegistry);
    await setEnvironmentVariable(
      "RADIUS_STATE_ARCHIVE",
      dependencies.defaultStateArchive
    );
    steps.push(
      `✅ Radius state package configured with archive tag "${dependencies.defaultStateArchive}".`
    );

    // Record the credential profile this environment was created from so the
    // Environments listing can show it in the Credentials column.
    if (data.profileName) {
      await setEnvironmentVariable(
        "RADIUS_CREDENTIAL_PROFILE",
        data.profileName
      );
    }

    // Step 2: Set environment variables and secrets based on provider
    const { credentialsComplete, missingCredNote } =
      await applyProviderConfiguration(provider, data, {
        azureCredential: () => dependencies.azureCredential(),
        awsCredential: () => dependencies.awsCredential(),
        optionalString: (value) => dependencies.optionalString(value),
        setEnvironmentVariable,
        pushStep: (message) => {
          steps.push(message);
        }
      });
    // When verification is deliberately not dispatched (incomplete cloud
    // credentials, or workflows that only exist on a PR branch), this holds the
    // reason so the response can signal the client to skip polling
    // /api/verify-status, which would otherwise spin until the timeout.
    let verifySkipReason = "";

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
          dependencies.deleteLegacyDeployWorkflow(repo, selectedExecutor),
        usingPullRequestBranch: () => Boolean(committer.pullRequestState()),
        pullRequestBranch: prBranch,
        errorMessage: (error) => dependencies.errorMessage(error),
        pushStep: (message) => {
          steps.push(message);
        },
        gate: checkpoint
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
      const pr = await dependencies.createPullRequestApi(
        targetRepo,
        prState.branch,
        prState.base,
        prTitle,
        prBody,
        selectedExecutor
      );
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
      // Wait briefly for GitHub to index the workflow, then dispatch with a few
      // retries to ride out indexing/propagation races.
      await dependencies.sleep(3000);
      const dispatchDelays = [0, 2000, 5000];
      let dispatchResult: CreateEnvironmentCommandResult = {
        code: 1,
        stdout: "",
        stderr: ""
      };
      for (const delay of dispatchDelays) {
        if (delay > 0) await dependencies.sleep(delay);
        dispatchResult = await runGhWorkflow(
          dependencies.buildVerifyWorkflowDispatchArgs({
            workflowFile: dependencies.verifyWorkflowFile,
            targetRepo,
            envName,
            ref: verifyPlan.ref
          })
        );
        if (dispatchResult.code === 0) break;
      }

      if (dispatchResult.code === 0) {
        steps.push("✅ Credentials verification dispatched.");
        await dependencies.sleep(5000);
        const runsResult = await runGh([
          "run",
          "list",
          "--workflow=radius-verify-credentials.yml",
          "--limit",
          "1",
          "--json",
          "databaseId,status,url",
          "--repo",
          targetRepo
        ]);
        try {
          const parsed: unknown = JSON.parse(runsResult.stdout);
          const runs = Array.isArray(parsed) ? parsed : [];
          if (runs.length > 0) {
            verifyRunId = runs[0].databaseId;
            verifyRunUrl =
              "https://github.com/" +
              targetRepo +
              "/actions/runs/" +
              verifyRunId;
            steps.push("Verify run: " + verifyRunUrl);
          }
        } catch {}
      } else {
        const detail =
          (dispatchResult.stderr || dispatchResult.stdout || "").trim() ||
          "The GitHub CLI request failed.";
        steps.push("❌ Could not dispatch verify workflow: " + detail);
        await fail(
          400,
          "Environment and state package were configured, but the verify workflow could not be dispatched after multiple attempts. " +
            detail,
          "verify-dispatch-failed",
          {
            environment: envName,
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
      operation.verification = {
        dispatchedAt,
        workflow: dependencies.verifyWorkflowFile,
        ref: verifyPlan.ref || defaultBranch,
        environment: envName,
        runId: verifyRunId == null ? null : String(verifyRunId),
        runUrl: verifyRunUrl || null
      };
      if (verifyPlan.shouldDispatch)
        dependencies.enterStage(operation, dependencies.stageVerify);
      if (!(await checkpoint())) return;
      const entry = dependencies.readInstanceEntry(context.instanceId);
      if (entry) {
        entry.state.deployDispatchedAt = dispatchedAt;
        entry.state.verifyRunId = verifyRunId;
        entry.state.verifyRunUrl = verifyRunUrl;
      }
    }

    const actionRequired = !verifyPlan.shouldDispatch;
    dependencies.recordCleanupState(operation, { state: "not_needed" });
    if (actionRequired) {
      dependencies.recordCommitState(operation, {
        mode: "pull_request",
        branch: prState?.branch || defaultBranch,
        baseBranch: prState?.base || verifyPlan.defaultBranch || defaultBranch,
        pullRequestUrl: pullRequestUrl || null
      });
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
          reason: "pr-merge-required",
          pullRequestUrl: pullRequestUrl || null,
          branch: prState?.branch || null,
          baseBranch: prState?.base || verifyPlan.defaultBranch || null,
          userMessage:
            pullRequestUrl ?
              "Merge the pull request to finish setup; credential verification and deploys run once it lands."
            : `Open and merge a pull request from "${
                prState?.branch || "the setup branch"
              }" into "${
                prState?.base ||
                verifyPlan.defaultBranch ||
                "the default branch"
              }" to finish setup.`
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
      dependencies.recordCommitState(operation, {
        mode: prState ? "pull_request" : "default_branch",
        branch: prState?.branch || defaultBranch,
        baseBranch: prState?.base || verifyPlan.defaultBranch || defaultBranch,
        pullRequestUrl: pullRequestUrl || null
      });
      // Verification is dispatched but still running; stage and exact dispatch
      // identity were persisted together above.
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
    const failure = await dependencies.finalizeSetupFailure(op, {
      status: 400,
      error: dependencies.errorMessage(e),
      code: "create-environment-unhandled",
      classification: "unknown",
      evidence: e instanceof Error ? e.stack || null : null,
      steps,
      runAz:
        op && op.provider === "azure" ?
          (args: string[]) => dependencies.runAzCommand(args)
        : null,
      runDeleteEnvironment: deleteGitHubEnvironmentRunner
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
