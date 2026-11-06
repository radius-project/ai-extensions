import {
  DEPLOY_DISPATCHER_FILE,
  DELETE_APP_DISPATCHER_FILE,
  DEPLOY_RAD_COMMANDS_STEP,
  appParams,
  partitionParams,
  extractAppName,
  buildDeployRadCommand,
  buildAppGraphRadCommand,
  classifyDeployDispatchFailure,
  deploymentStatusBlocksMutation,
  projectDeploymentGraph,
  settleDeployStatuses,
  buildDeployStatusMap,
  buildDeployMessageMap,
  applyDeployMessages,
  applyDeployStatusToResources,
  type GhCommandPresentation
} from "@radius-project/core";
import {
  generatePortalUrl,
  GITHUB_API_VERSION
} from "@radius-project/core/platforms";
import {
  createDeploymentRuntime,
  type DeploymentRuntimePorts
} from "./runtime-deployment.js";
import { createDeploymentRepository } from "./deployment-repository.js";
import type { DeploymentCommandExecutor } from "./deployment-command-bindings.js";
import { createDeploymentWorkflows } from "./deployment-workflows.js";
import { createDeploymentLookup } from "./deployment-lookup.js";
import {
  createDeploymentObservationBindings,
  type DeploymentObservationExecutor
} from "./deployment-observation-bindings.js";
import {
  createDeploymentFileReader,
  createDeploymentStatusReader
} from "./deployment-bindings.js";
import {
  readWorkspaceFile,
  normalizeDeploymentAppFile,
  uncommittedGeneratedPaths
} from "./deployment-workspace.js";
import { resolveDeployParams } from "./deployment-parameters.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import { createDeployDispatchService } from "./deployment-dispatch.js";
import { createDeployMonitorService } from "./deployment-monitor.js";
import { createDeployOutcomeService } from "./deployment-outcome.js";
import { assertDeployDependencies } from "./deployment-service-dependencies.js";

export interface ProductionDeploymentPorts {
  awsEnabled: boolean;
  execute: DeploymentObservationExecutor & DeploymentCommandExecutor;
  ghCommandPresentation?: GhCommandPresentation;
  readProcessEnv(): NodeJS.ProcessEnv;
  ghCredentialSource(): "injected" | "keyring";
  redactDiagnostic(value: string): string;
  reportDiagnostic(value: string): void;
  now(): number;
  id(): string;
  sleep(milliseconds: number): Promise<void>;
  delivery?: Pick<
    DeploymentRuntimePorts["delivery"],
    "sendRepair" | "sendNotice"
  >;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Production composition shared by Canvas and frontends with no Canvas server. */
export function createProductionDeploymentRuntime(
  ports: ProductionDeploymentPorts
) {
  assertDeployDependencies("createProductionDeploymentRuntime", ports, [
    "execute",
    "readProcessEnv",
    "ghCredentialSource",
    "redactDiagnostic",
    "reportDiagnostic",
    "now",
    "id",
    "sleep"
  ]);
  const repository = createDeploymentRepository(ports);
  const workflows = createDeploymentWorkflows(ports.awsEnabled, {
    ...repository,
    readRepositoryFile: repository.readFileResult,
    now: ports.now,
    reportDiagnostic: ports.reportDiagnostic
  });
  const lookup = createDeploymentLookup({
    ghOrThrow: repository.ghOrThrow,
    deployWorkflowFile: DEPLOY_DISPATCHER_FILE,
    deleteWorkflowFile: DELETE_APP_DISPATCHER_FILE
  });
  const reads = createDeploymentObservationBindings(ports);
  const dispatchListeners = new Set<(repo: string) => void>();
  function notifyDispatch(repo: string): void {
    for (const listener of dispatchListeners) {
      try {
        listener(repo);
      } catch (error) {
        ports.reportDiagnostic(ports.redactDiagnostic(errorMessage(error)));
      }
    }
  }
  const outcome = createDeployOutcomeService({
    projectSafeGraphResources: projectDeploymentGraph,
    settleDeployStatuses,
    fetchRunLog: (repo, runId, request) =>
      reads.fetchRunLog(repo, runId, undefined, request),
    redactDiagnostic: ports.redactDiagnostic,
    cloudAuthDriftKind: "cloud-auth-drift",
    sleep: ports.sleep,
    now: ports.now
  });
  const runtime = createDeploymentRuntime({
    awsEnabled: ports.awsEnabled,
    now: ports.now,
    id: ports.id,
    reportError: (error) =>
      ports.reportDiagnostic(ports.redactDiagnostic(errorMessage(error))),
    normalizeAppFile: normalizeDeploymentAppFile,
    resolveDefaultBranch: async (repo) => {
      const branch = await repository.ghOrThrow([
        "repo",
        "view",
        repo,
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name"
      ]);
      if (!branch)
        throw new Error(
          "GitHub returned no deployment branch. Specify branch explicitly."
        );
      return branch;
    },
    resolveDeployment: lookup.resolveEnvDeployment,
    statusBlocksMutation: deploymentStatusBlocksMutation,
    delivery: {
      ...ports.delivery,
      redactDiagnostic: ports.redactDiagnostic,
      reportDiagnostic: ports.reportDiagnostic
    },
    createExecution: (_invocation, workspace) => {
      const readFile = createDeploymentFileReader(workspace, {
        readWorkspaceFile,
        readRepositoryFile: repository.readFile
      });
      const dispatch = createDeployDispatchService({
        ghCommandPresentation: ports.ghCommandPresentation,
        deployWorkflowFile: DEPLOY_DISPATCHER_FILE,
        deployWorkflowFiles: workflows.files,
        branchNotPushedKind: "branch-not-pushed",
        oidcSubjectMissingKind: "oidc-subject-missing",
        oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
        getBranchHeadSha: repository.branchHead,
        getDefaultBranch: repository.defaultBranch,
        runGh: repository.runGh,
        runGhWithStdin: repository.runGhWithStdin,
        runAz: (args) => repository.runCliCommand("az", args, 15000),
        runGitHubJson: async (apiPath) => {
          const result = await repository.readJson(apiPath, {
            headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION }
          });
          return {
            ...result,
            json:
              (
                result.json !== null &&
                typeof result.json === "object" &&
                !Array.isArray(result.json)
              ) ?
                Object.fromEntries(Object.entries(result.json))
              : null
          };
        },
        readProcessEnv: ports.readProcessEnv,
        ghCredentialSource: ports.ghCredentialSource,
        appParams,
        resolveDeployParams,
        partitionParams,
        extractAppName,
        buildDeployRadCommand,
        buildAppGraphRadCommand,
        fetchFileForSelection: (_entry, repo, branch, path) =>
          readFile(repo, branch, path),
        uncommittedGeneratedPaths: () =>
          uncommittedGeneratedPaths(workspace?.workspacePath),
        ensureDeployWorkflowsOnBranch: workflows.ensureOnBranch,
        ensureWorkflowsCurrent: workflows.ensureCurrent,
        verifyAppFileInput: workflows.verifyAppFileInput,
        latestWorkflowRunId: reads.latestWorkflowRunId,
        classifyDeployDispatchFailure,
        invalidateDeployListCache: notifyDispatch,
        errorMessage,
        sleep: ports.sleep,
        now: ports.now
      });
      const observation = createWorkflowObservationScope(
        reads.createDeployStatusReader
      );
      const monitor = createDeployMonitorService({
        dispatch,
        outcome,
        deployRadCommandsStep: DEPLOY_RAD_COMMANDS_STEP,
        unconfirmedRunKind: "run-unconfirmed",
        findWorkflowRun: (repo, workflow, since, known, after) =>
          reads.findWorkflowRun(repo, workflow, since, known, undefined, after),
        getRunDetail: (repo, runId, request) =>
          reads.getRunDetail(repo, runId, undefined, request, {
            includeProtection: true
          }),
        createStatusReader: createDeploymentStatusReader(observation),
        buildDeployStatusMap,
        buildDeployMessageMap,
        applyDeployMessages,
        applyDeployStatusToResources,
        settleDeployStatuses,
        generatePortalUrl,
        optionalString: (value) => (typeof value === "string" ? value : ""),
        errorMessage,
        sleep: ports.sleep,
        now: ports.now
      });
      return { observation, monitor };
    }
  });
  return {
    ...runtime,
    subscribeDispatch(listener: (repo: string) => void): () => void {
      dispatchListeners.add(listener);
      return () => {
        dispatchListeners.delete(listener);
      };
    }
  };
}
