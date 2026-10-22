import { buildGraphViaRad } from "@radius-project/adapter-shared";
import {
  DEPLOY_RAD_COMMANDS_STEP,
  classifyDeploymentDispatchFailure,
  fetchRecipePack,
  projectSafeApplicationGraph,
  resolveRecipeOutputs
} from "@radius-project/core";
import {
  appParams,
  resolveDeployParams,
  partitionParams,
  extractAppName,
  buildDeployRadCommand,
  buildAppGraphRadCommand
} from "../bicep.js";
import { canvasGraphResources } from "../canvas-graph-resources.js";
import {
  findWorkflowRun,
  getRunDetail,
  latestWorkflowRunId,
  fetchRunLog
} from "../deploy.js";
import {
  buildDeployStatusMap,
  buildDeployMessageMap,
  applyDeployMessages,
  applyDeployStatusToResources,
  settleDeployStatuses
} from "../deploy-artifacts.js";
import { selectedGhApiJson } from "../gh.js";
import type { GhCommandPresentation } from "../gh-command-display.js";
import {
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  generatePortalUrl,
  syncRepoWorkflows
} from "../infra.js";
import { radArtifactsDirForSelection } from "../remote-rad-artifacts.js";
import { fetchSelectedBicep } from "../selected-bicep-source.js";
import { createSelectedRepositoryReader } from "../selected-repository-reader.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "../source-refs.js";
import { uncommittedGeneratedPaths } from "../workspace.js";
import {
  createDeployDispatchService,
  type DeployCommandResult
} from "../server/services/deploy-dispatch.js";
import { createDeployMonitorService } from "../server/services/deploy-monitor.js";
import { createDeployOutcomeService } from "../server/services/deploy-outcome.js";
import { createPlannedGraphRecoveryService } from "../server/services/deploy-planned-graph.js";
import { bindDeploymentExecutor } from "./deployment-executor.js";
import type {
  DeploymentExecution,
  DeploymentExecutionOwner
} from "./deployment-execution-owner.js";
import { createDeploymentWorkflowPorts } from "./deployment-workflows.js";
import { createDeploymentWorkflowPreparation } from "./deployment-workflow-preparation.js";
import { optionalString, record } from "./util.js";

export interface ProductionDeploymentMonitorPorts {
  owner: DeploymentExecutionOwner;
  ghCommandPresentation: GhCommandPresentation;
  runAz(args: string[], timeout: number): Promise<DeployCommandResult>;
  invalidateDeployListCache(repo: string): void;
  reportWorkflowProgress(message: string): void;
  buildGraph?: typeof buildGraphViaRad;
  readRadArtifacts?: typeof radArtifactsDirForSelection;
}

export function createProductionDeploymentMonitor(
  execution: DeploymentExecution,
  ports: ProductionDeploymentMonitorPorts
) {
  const isCurrent = () =>
    ports.owner.execution(execution.invocation) === execution &&
    !execution.observation.stopped;
  const executor = bindDeploymentExecutor(execution.executor, isCurrent);
  const reader = createSelectedRepositoryReader(executor);
  const workflows = createDeploymentWorkflowPorts(executor);
  const preparation = createDeploymentWorkflowPreparation(workflows, {
    sync: syncRepoWorkflows,
    log: ports.reportWorkflowProgress
  });
  const sleep = (milliseconds: number) =>
    execution.observation.delay(milliseconds);
  const readRadArtifacts =
    ports.readRadArtifacts ?? radArtifactsDirForSelection;
  const plannedGraph = createPlannedGraphRecoveryService({
    prepareSourceRefResources,
    setSourceRefResources,
    fetchBicepSelection: (entry, repo, branch) =>
      fetchSelectedBicep(entry.state, repo, branch, reader),
    radArtifactsDirForSelection: (input) =>
      readRadArtifacts({ ...input, github: reader }),
    buildGraphViaRad: ports.buildGraph ?? buildGraphViaRad,
    fetchRecipePack: (provider) => fetchRecipePack(reader, provider),
    resolveRecipeOutputs: (parsed, recipes, provider) =>
      resolveRecipeOutputs(reader, parsed, recipes, provider),
    canvasGraphResources,
    errorMessage: executor.errorMessage
  });
  const dispatch = createDeployDispatchService({
    isCurrent,
    ghCommandPresentation: ports.ghCommandPresentation,
    deployWorkflowFile: DEPLOY_DISPATCHER_FILE,
    deployWorkflowFiles: [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE],
    branchNotPushedKind: "branch-not-pushed",
    oidcSubjectMissingKind: "oidc-subject-missing",
    oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
    getBranchHeadSha: workflows.getBranchHeadSha,
    getDefaultBranch: workflows.getDefaultBranch,
    runGh: (args) => executor.run(args, { timeout: 30000 }),
    runGhWithStdin: (args, stdin) =>
      executor.run(args, { stdin, timeout: 30000 }),
    // Advisory local preflight must not delay an Actions-authenticated deploy
    // behind the general-purpose command timeout.
    runAz: (args) => ports.runAz(args, 15000),
    runGitHubJson: async (apiPath) => {
      const response = await selectedGhApiJson(executor, apiPath);
      return {
        ...response,
        json:
          (
            response.json !== null &&
            typeof response.json === "object" &&
            !Array.isArray(response.json)
          ) ?
            record(response.json)
          : null
      };
    },
    readProcessEnv: () => ({}),
    ghCredentialSource: () => executor.credentialSource,
    fetchFileForSelection: (_entry, repo, branch, repoPath) =>
      workflows.fetchFileFromRepo(repo, repoPath, branch),
    appParams,
    resolveDeployParams,
    partitionParams,
    extractAppName,
    buildDeployRadCommand,
    buildAppGraphRadCommand,
    ensureDeployWorkflowsOnBranch: preparation.publish,
    ensureWorkflowsCurrent: preparation.synchronize,
    sleep,
    latestWorkflowRunId: (repo, workflow) =>
      latestWorkflowRunId(repo, workflow, executor),
    classifyDeployDispatchFailure: classifyDeploymentDispatchFailure,
    uncommittedGeneratedPaths: (entry) =>
      uncommittedGeneratedPaths(entry.state.workspacePath),
    invalidateDeployListCache: ports.invalidateDeployListCache,
    errorMessage: executor.errorMessage,
    now: Date.now
  });
  const outcome = createDeployOutcomeService({
    projectSafeGraphResources: (graph) =>
      canvasGraphResources(projectSafeApplicationGraph(graph).resources),
    settleDeployStatuses,
    fetchRunLog: (repo, runId, request) =>
      fetchRunLog(repo, runId, executor, request),
    redactDiagnostic: executor.redact,
    cloudAuthDriftKind: "cloud-auth-drift",
    sleep,
    now: Date.now
  });
  return createDeployMonitorService({
    plannedGraph,
    dispatch,
    outcome,
    deployRadCommandsStep: DEPLOY_RAD_COMMANDS_STEP,
    unconfirmedRunKind: "run-unconfirmed",
    findWorkflowRun: (repo, workflowFile, sinceMs, knownId, afterRunId) =>
      findWorkflowRun(
        repo,
        workflowFile,
        sinceMs,
        knownId,
        executor,
        afterRunId
      ),
    getRunDetail: (repo, runId, request) =>
      getRunDetail(repo, runId, executor, request, { includeProtection: true }),
    createStatusReader: async (state, repo, _branch, runId) =>
      execution.observation.reader({
        repo,
        environment: execution.invocation.target.environment,
        application: state.deployAppName || "",
        runId
      }),
    buildDeployStatusMap,
    buildDeployMessageMap,
    applyDeployMessages,
    applyDeployStatusToResources,
    settleDeployStatuses,
    generatePortalUrl,
    optionalString,
    errorMessage: executor.errorMessage,
    sleep,
    now: Date.now
  });
}
