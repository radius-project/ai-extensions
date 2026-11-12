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
import type { DeployCommandResult } from "./deployment-dispatch.js";
import { createDeploymentWorkflows } from "./deployment-workflows.js";
import { createDeploymentLookup } from "./deployment-lookup.js";
import { createDeploymentIdentityReader } from "./deployment-identity.js";
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
  const reads = createDeploymentObservationBindings(ports);
  const lookup = createDeploymentLookup({
    readApplicationIdentity: createDeploymentIdentityReader({
      ...reads,
      redactDiagnostic: ports.redactDiagnostic
    }),
    ghOrThrow: repository.ghOrThrow,
    deployWorkflowFile: DEPLOY_DISPATCHER_FILE,
    deleteWorkflowFile: DELETE_APP_DISPATCHER_FILE
  });
  const reportError = (error: unknown): void =>
    ports.reportDiagnostic(ports.redactDiagnostic(errorMessage(error)));
  const dispatchListeners = new Set<(repo: string) => unknown>();
  function notifyDispatch(repo: string): void {
    for (const listener of dispatchListeners) {
      if (runtime.owner.isShuttingDown()) return;
      try {
        void Promise.resolve(listener(repo)).then(undefined, reportError);
      } catch (error) {
        reportError(error);
      }
    }
  }
  const commandResult = async (
    pending: Promise<DeployCommandResult>
  ): Promise<DeployCommandResult> => {
    const result = await pending;
    return result.code === 0 ?
        result
      : {
          ...result,
          stdout: ports.redactDiagnostic(result.stdout),
          stderr: ports.redactDiagnostic(result.stderr)
        };
  };
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
    reportError,
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
    createExecution: (invocation, workspace, plannedGraph) => {
      const workspacePath = workspace?.workspacePath;
      const matchingWorkspace =
        workspace?.repo.toLowerCase() ===
          invocation.target.repo.toLowerCase() &&
        workspace.branch === invocation.target.branch;
      const readFile = createDeploymentFileReader(workspace, {
        readWorkspaceFile,
        readRepositoryFile: repository.readFile
      });
      const dispatch = createDeployDispatchService({
        id: ports.id,
        ghCommandPresentation: ports.ghCommandPresentation,
        deployWorkflowFile: DEPLOY_DISPATCHER_FILE,
        deployWorkflowFiles: workflows.files,
        branchNotPushedKind: "branch-not-pushed",
        oidcSubjectMissingKind: "oidc-subject-missing",
        oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
        getBranchHeadSha: repository.branchHead,
        getDefaultBranch: repository.defaultBranch,
        runGh: (args, options) =>
          commandResult(repository.runGh(args, options)),
        runGhWithStdin: (args, stdin, options) =>
          commandResult(repository.runGhWithStdin(args, stdin, options)),
        runAz: (args) =>
          commandResult(repository.runCliCommand("az", args, 15000)),
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
          uncommittedGeneratedPaths(workspacePath),
        canRemediateBranch: (_entry, branch) =>
          matchingWorkspace && branch === invocation.target.branch,
        ensureDeployWorkflowsOnBranch: workflows.ensureOnBranch,
        ensureWorkflowsCurrent: workflows.ensureCurrent,
        verifyAppFileInput: workflows.verifyAppFileInput,
        latestWorkflowRunId: reads.latestWorkflowRunId,
        classifyDeployDispatchFailure,
        invalidateDeployListCache: notifyDispatch,
        errorMessage: (error) => ports.redactDiagnostic(errorMessage(error)),
        sleep: ports.sleep,
        now: ports.now
      });
      const observation = createWorkflowObservationScope(
        reads.createDeployStatusReader
      );
      const monitor = createDeployMonitorService({
        plannedGraph,
        dispatch,
        outcome,
        deployRadCommandsStep: DEPLOY_RAD_COMMANDS_STEP,
        unconfirmedRunKind: "run-unconfirmed",
        findWorkflowRun: (repo, workflow, since, known, after, correlation) =>
          reads.findWorkflowRun(
            repo,
            workflow,
            since,
            known,
            undefined,
            after,
            correlation
          ),
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
    /**
     * Repository dispatch facts survive attempt invalidation, but not shutdown.
     * Returned promises are observed without delaying deployment or shutdown.
     */
    subscribeDispatch(listener: (repo: string) => unknown): () => void {
      if (runtime.owner.isShuttingDown())
        throw new Error("Deployment runtime is shutting down.");
      dispatchListeners.add(listener);
      return () => {
        dispatchListeners.delete(listener);
      };
    }
  };
}
