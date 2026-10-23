import { parse as parseYaml } from "yaml";
import type { SetupEnvironmentPorts } from "@radius-project/core";
import { encodeWorkflowContent } from "@radius-project/adapter-shared";
import type { SelectedGhExecutor } from "../../gh.js";
import type { ConfigureEnvironmentDependencies } from "../services/configure-environment.js";
import type {
  CreateEnvironmentOperation,
  GhcrPreflightResult
} from "./create-environment-types.js";
import type { SetupFailureInput } from "../services/setup-outcome.js";
import {
  shouldStop,
  terminalizeProviderManualRequired
} from "../../operations.js";
import { createSetupWorkflowRecoveryPort } from "../services/setup-workflow-recovery.js";
import {
  readEnsuredGitHubEnvironment,
  ensureGitHubEnvironment
} from "../services/github-environment.js";
import { createWorkflowScopeGhRunner } from "./create-environment-gh-runner.js";
import { bindWorkflowFileCommitterPorts } from "./create-environment-workflow-committer.js";
import { describeMergeRequiredTerminal } from "../../verification-plan.js";
import { LEGACY_DEPLOY_WORKFLOW_FILE } from "../../infra.js";
import { discoverAutomaticVerificationRun } from "../services/automatic-verification-run.js";
import { runVerificationDispatch } from "../services/verification-dispatch.js";
import {
  describeSetupEnvironmentFailure,
  presentSetupVerificationSkip,
  reportSetupEnvironment
} from "./setup-environment-presentation.js";

export function createSetupEnvironmentPorts(input: {
  dependencies: ConfigureEnvironmentDependencies;
  operation: CreateEnvironmentOperation;
  selectedExecutor: SelectedGhExecutor;
  instanceId?: string;
  isCurrentPresentation?: () => boolean;
  provider: string;
  steps: string[];
  stopBoundary(boundary: string): Promise<boolean>;
  checkpoint(boundary: string): Promise<boolean>;
  fail(
    status: number,
    error: string,
    code: string,
    extra: Record<string, unknown>
  ): Promise<"failed" | "stopped">;
  finalize(input: SetupFailureInput): Promise<"failed" | "stopped">;
}): SetupEnvironmentPorts {
  const {
    dependencies: d,
    operation,
    selectedExecutor: executor,
    steps,
    provider
  } = input;
  let repositoryAccess = "";
  let packagePreflight: GhcrPreflightResult | undefined;
  const credentialHandle = Symbol("setup-package-credential");
  const pushStep = (message: string) => {
    steps.push(message);
  };
  return {
    recovery: createSetupWorkflowRecoveryPort(operation, () =>
      d.persistOperations()
    ),
    stopRequested: () => shouldStop(operation),
    isExecutionStopped: d.isShuttingDown,
    stopBoundary: input.stopBoundary,
    checkpoint: input.checkpoint,
    preflightRepository: async (repo) => {
      repositoryAccess = await d.preflightRepoAdmin(repo, executor);
      return repositoryAccess === "";
    },
    preflightPackages: async () => {
      packagePreflight = await d.preflightGhcrPackageWriteAccess(executor);
      return packagePreflight.ok ? credentialHandle : null;
    },
    finalizeFailure: async (failure) => {
      if (failure.kind === "repository-access") {
        return input.finalize({
          status: 403,
          error: repositoryAccess,
          code: "repo-admin-required",
          stage: d.stageConfigureEnvironment,
          classification: "needs-someone-else",
          runAz:
            provider === "azure" ?
              (args: string[]) => d.runAzCommand(args)
            : null
        });
      }
      if (failure.kind === "package-access") {
        if (!packagePreflight || packagePreflight.ok) {
          throw new Error("Package preflight failure is unavailable.");
        }
        return input.finalize({
          status: 403,
          error: packagePreflight.error,
          code: packagePreflight.code
        });
      }
      const presented = describeSetupEnvironmentFailure(failure, {
        steps,
        ociStateBackend: d.ociStateBackend,
        defaultStateArchive: d.defaultStateArchive,
        ghCommandPresentation: d.ghCommandPresentation
      });
      return input.fail(
        presented.status,
        presented.error,
        presented.code,
        presented.extra
      );
    },
    readEnsuredEnvironment: (repo, name) =>
      readEnsuredGitHubEnvironment(operation, repo, name),
    ensureEnvironment: (repo, requestedName, beforeCreate) =>
      ensureGitHubEnvironment({
        repo,
        requestedName,
        readGitHubJson: (path) => d.readGitHubJson(path, executor),
        runGh: (args) => executor.run(args),
        mutationRecovery: { operation, persist: () => d.persistOperations() },
        beforeCreate,
        now: d.now
      }),
    setCanonicalEnvironment: (name) =>
      d.setCanonicalEnvironment(operation, name),
    recordEnvironment: (patch) => d.recordGitHubEnvironment(operation, patch),
    promoteCreatedEnvironment: (identity) =>
      d.promoteCreatedGitHubEnvironment(operation, identity),
    bindEnvironment: ({ journalVariables, ...target }) =>
      createWorkflowScopeGhRunner(
        d,
        {
          ...target,
          isStopped: d.isShuttingDown,
          ...(journalVariables ?
            {
              mutationRecovery: {
                operation,
                persist: () => d.persistOperations(),
                recordVariable: (entry) =>
                  d.recordGitHubEnvironmentVariable(operation, entry)
              }
            }
          : {})
        },
        executor
      ),
    getDefaultBranch: (repo) => d.getDefaultBranch(repo, executor),
    stateRegistryForEnvironment: (repo, environment) =>
      d.stateRegistryForEnvironment(repo, environment),
    bootstrapStatePackage: (request) => {
      if (request.credentials !== credentialHandle || !packagePreflight?.ok) {
        throw new Error("The selected package credential is unavailable.");
      }
      return d.bootstrapGHCRStatePackage({
        targetRepository: request.targetRepository,
        registry: request.registry,
        credentials: packagePreflight.credentials
      });
    },
    workflowFiles: ({ runGh, runGhWorkflow }) =>
      bindWorkflowFileCommitterPorts({
        runGh,
        runGhWorkflow,
        getDefaultBranch: (repo) => d.getDefaultBranch(repo, executor),
        getBranchHeadSha: (repo, branch) =>
          d.getBranchHeadSha(repo, branch, executor),
        createBranchRef: (repo, branch, sha) =>
          d.createBranchRef(repo, branch, sha, executor),
        tempFile: d.tempFile,
        errorMessage: (error) => d.errorMessage(error),
        pushStep,
        now: () => d.now()
      }),
    azureCredential: () => d.azureCredential(),
    awsCredential: () => d.awsCredential(),
    optionalString: (value) => d.optionalString(value),
    envListCacheDelete: (repo) => d.envListCacheDelete(repo),
    ociStateBackend: d.ociStateBackend,
    defaultStateArchive: d.defaultStateArchive,
    verifyWorkflowFile: d.verifyWorkflowFile,
    legacyDeployWorkflowFile: LEGACY_DEPLOY_WORKFLOW_FILE,
    fetchFileFromRepoResult: (repo, path, branch) =>
      d.fetchFileFromRepoResult(repo, path, branch, executor),
    parseWorkflow: parseYaml,
    verification: () => operation.verification,
    setVerification: (value) => {
      operation.verification = value;
    },
    generateVerifyWorkflow: (environment, workflowProvider, marker) =>
      d.generateVerifyWorkflow(environment, workflowProvider, marker),
    generateDeployWorkflow: (environment, appFile) =>
      d.generateDeployWorkflow(environment, appFile),
    generateDeleteWorkflow: (environment) =>
      d.generateDeleteWorkflow(environment),
    recordCommittedWorkflowFile: (entry) =>
      d.recordCommittedWorkflowFile(operation, entry),
    deleteLegacyDeployWorkflow: (repo, beforeDelete, branch) =>
      d.deleteLegacyDeployWorkflow(repo, executor, beforeDelete, branch),
    encode: encodeWorkflowContent,
    createPullRequest: (repo, head, base, environment) =>
      d.createPullRequestApi(
        repo,
        head,
        base,
        "Add Radius deploy workflows for environment " + environment,
        [
          "This PR adds the GitHub Actions workflows that power the Radius extension for the **" +
            environment +
            "** environment:",
          "",
          "- `.github/workflows/radius-verify-credentials.yml`",
          "- Radius deploy workflow(s) under `.github/workflows/`",
          "- Radius delete workflow(s) under `.github/workflows/`",
          "",
          "They were committed to `" +
            head +
            "` because direct pushes to `" +
            base +
            "` are not permitted. Merge this PR to enable deploying and deleting the application from the Radius canvas."
        ].join("\n"),
        executor
      ),
    recordCommitState: (patch) => d.recordCommitState(operation, patch),
    planCredentialVerification: (request) =>
      d.planCredentialVerification(request),
    fetchFileFromRepo: (repo, path, branch) =>
      d.fetchFileFromRepo(repo, path, branch, executor),
    discoverAutomaticVerificationRun,
    terminalizeManualRequired: (guidance) =>
      terminalizeProviderManualRequired(operation, guidance),
    runVerificationDispatch: (request) =>
      runVerificationDispatch({ ...request, operation }),
    buildVerifyWorkflowDispatchArgs: (request) =>
      d.buildVerifyWorkflowDispatchArgs(request),
    enterVerifyStage: () => d.enterStage(operation, d.stageVerify),
    projectVerification: ({ dispatchedAt, verifyRunId, verifyRunUrl }) => {
      if (input.isCurrentPresentation && !input.isCurrentPresentation()) return;
      const entry =
        input.instanceId === undefined ?
          undefined
        : d.readInstanceEntry(input.instanceId);
      if (entry) {
        entry.state.deployDispatchedAt = dispatchedAt;
        entry.state.verifyRunId = verifyRunId;
        entry.state.verifyRunUrl = verifyRunUrl;
      }
    },
    recordCleanupNotNeeded: () =>
      d.recordCleanupState(operation, { state: "not_needed" }),
    skipVerifyStage: () => d.setStageState(operation, d.stageVerify, "skipped"),
    finishMergeRequired: ({ outcome, pullRequestUrl, branch, baseBranch }) =>
      d.finish(operation, "action_required", {
        terminal: {
          reason: "pr-merge-required",
          pullRequestUrl,
          branch,
          baseBranch,
          userMessage: describeMergeRequiredTerminal({
            outcome,
            branch: branch || "the setup branch",
            baseBranch: baseBranch || "the default branch",
            hasPullRequest: pullRequestUrl !== null
          })
        }
      }),
    finishCredentialsIncomplete: ({
      provider: credentialProvider,
      pullRequestUrl
    }) =>
      d.finish(operation, "action_required", {
        terminal: {
          reason: "credentials-incomplete",
          pullRequestUrl,
          userMessage: presentSetupVerificationSkip({
            kind: "credentials",
            provider: credentialProvider
          })
        }
      }),
    persistBestEffort: () =>
      d.persistBestEffort({
        operation,
        persist: () => d.persistOperations(),
        report: (diagnostic) => d.reportOperationDiagnostic(diagnostic)
      }),
    report: (event) =>
      reportSetupEnvironment(event, {
        pushStep,
        errorMessage: (error) => d.errorMessage(error),
        login: executor.login,
        credentialSource: executor.credentialSource,
        verifyWorkflowFile: d.verifyWorkflowFile
      }),
    now: () => d.now(),
    sleep: (milliseconds) => d.sleep(milliseconds)
  };
}
