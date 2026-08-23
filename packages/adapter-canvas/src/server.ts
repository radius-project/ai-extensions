// Canvas adapter — HTTP server host for the webview.
//
// Owns the local loopback server that backs each canvas instance: the 40-route
// request handler (parse request -> call an @radius-project/core use-case or adapter
// helper -> serialize), the page router, and the idempotent server lifecycle
// (stable per-instance port, reuse on re-open). The only product logic here is
// glue; everything substantive is delegated to @radius-project/core or the sibling
// adapter modules (pages/deploy/infra/gh). No SDK surface — that stays in
// extension.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemediation,
  computeGraphDiff,
  deployStatusKeys,
  fetchBicepFromRepo,
  fetchRecipePack,
  mergeDeployedGraphMetadata,
  projectDeployedGraph,
  resolveRecipeOutputs,
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  remediationSessionMessage,
  remediationView,
  stateRegistryForEnvironment
} from "@radius-project/core";
import type { Remediation, RemediationView } from "@radius-project/core";
import { buildGraphViaRad } from "@radius-project/adapter-shared";
import {
  sharedCredentials,
  cloudCredential,
  listCredentialProfiles,
  saveCredentialProfile,
  deleteCredentialProfile,
  recordGraphBuildEvent
} from "./shared.js";
import type {
  CanvasGraphResource,
  CanvasState,
  DeployErrorKind,
  GraphBuildEvent,
  GraphProgressView,
  GraphView
} from "./shared.js";
import {
  fetchFileFromRepo,
  github,
  cliExec,
  runCommand,
  commitFileToRepo,
  getDefaultBranch,
  getBranchHeadSha,
  createBranchRef,
  createPullRequestApi,
  ghApiJson,
  getGitHubIdentity,
  getGhPackageCredentials,
  resetGhIdentityCache,
  createSelectedGhExecutor,
  getActiveKeyringLogin,
  switchGhKeyringAccount,
  selectedGhApiJson,
  selectedGetDefaultBranch,
  selectedGetBranchHeadSha,
  selectedCreateBranchRef,
  selectedCreatePullRequest,
  selectedFetchFileFromRepo
} from "./gh.js";
import type { CliOptions, SelectedGhExecutor } from "./gh.js";
import {
  buildAppDeleteArgs,
  isAzResourceNotFound,
  parseServedReposFromSubjects,
  isUuid,
  isValidRepoSlug,
  isAksClusterName,
  isResourceGroupName,
  GITHUB_API_VERSION
} from "./azure-oidc.js";
import type { GitHubJsonResponse } from "./azure-oidc.js";
import { bootstrapGHCRStatePackage } from "./ghcr.js";
import {
  appParams,
  resolveDeployParams,
  partitionParams,
  buildDeployRadCommand,
  buildAppGraphRadCommand,
  extractAppName
} from "./bicep.js";
import {
  createWorkspaceGitHub,
  defaultBranchForState,
  resolveWorkspaceBicep,
  fetchWorkspaceFile,
  isWorkspaceSelection,
  resolveSessionId,
  toSafeRepoRelPath,
  uncommittedGeneratedPaths,
  workspaceGraphJsonPath
} from "./workspace.js";
import {
  DEFAULT_CANVAS_PAGE,
  DEPLOY_REPAIR_ATTEMPT_CAP
} from "./runtime/hooks.js";
import {
  buildVerifyWorkflowDispatchArgs,
  planCredentialVerification
} from "./verification-plan.js";
import {
  operations,
  isTerminalState,
  isStale,
  hasCompleteVerificationIdentity,
  toClientView,
  createOperation,
  buildStages,
  enterStage,
  setStageState,
  hasWarnings,
  addLegacyStep,
  setContext,
  setCanonicalEnvironment,
  setCloudContext,
  getSetupArtifactLedger,
  recordAzureApp,
  recordServicePrincipal,
  recordCreatedFederatedCredential,
  recordCreatedRoleAssignment,
  recordGitHubEnvironment,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordCleanupState,
  projectCleanupSummary,
  finish,
  finishSucceeded,
  canResumeInput,
  requireInput,
  resumeAfterInput,
  setExecutionActive,
  INPUT_REQUIRED_STATE,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_CONFIGURE_ENVIRONMENT,
  STAGE_VERIFY
} from "./operations.js";
import {
  radArtifactsDirForSelection,
  radArtifactsFingerprint
} from "./remote-rad-artifacts.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "./source-refs.js";
import {
  generateVerifyWorkflow,
  generateDeployWorkflow,
  generateDeleteWorkflow,
  generatePortalUrl,
  syncRepoWorkflows,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE
} from "./infra.js";
import type { WorkflowCommitFailure } from "./infra.js";
import {
  findWorkflowRun,
  latestWorkflowRunId,
  getRunDetail,
  fetchRunLog,
  extractErrorLines,
  extractGitHubActionsStepLog,
  extractRadDeployError,
  explainOidcEnterpriseClaim,
  explainNoSubscriptions,
  explainRepoAccessForEnvSetup
} from "./deploy.js";
import {
  applyDeployMessages,
  applyDeployStatusToResources,
  buildDeployMessageMap,
  buildDeployStatusMap,
  createDeployStatusReader,
  settleDeployStatuses
} from "./deploy-artifacts.js";
import { graphPage } from "./pages/graph-page.js";
import { plannedGraphPage } from "./pages/planned-graph-page.js";
import { graphDiffPage } from "./pages/graph-diff-page.js";
import { deployedGraphPage } from "./pages/deployed-graph-page.js";
import { environmentPage } from "./pages/environment-page.js";
import { deployingPage } from "./pages/deploying-page.js";
import { createCanvasServer } from "./server/create-canvas-server.js";
import { createRequestHandler as createScaffoldRequestHandler } from "./server/create-request-handler.js";
import {
  syncRequestedPage,
  type CanvasRequestContext
} from "./server/request-context.js";
import { createProductionCanvasServerDependencies } from "./server/dependencies.js";
import { createServerRouteTable } from "./server/route-table.js";
import { createLivenessSourceRoutes } from "./server/routes/liveness-source.js";
import { createDeploymentsRoutes } from "./server/routes/deployments.js";
import { createOperationsStatusRoutes } from "./server/routes/operations-status.js";
import { createRepositoriesRoutes } from "./server/routes/repositories.js";
import { createAzureDiscoveryRoutes } from "./server/routes/azure-discovery.js";
import { createAzureAutoSetupRoutes } from "./server/routes/azure-auto-setup.js";
import { composeAzureAutoSetupDependencies } from "./server/azure-auto-setup-dependencies.js";
import { createIdentityProfilesRoutes } from "./server/routes/identity-profiles.js";
import { createIdentityAuthRoutes } from "./server/routes/identity-auth.js";
import {
  createRemediationRoutes,
  productionRemediationDependencies
} from "./server/routes/remediations.js";
import {
  createGraphsPlanningRoutes,
  createGraphsPlanningStreamRoutes
} from "./server/routes/graphs-planning.js";
import { createGraphsPlanningWritesRoutes } from "./server/routes/graphs-planning-writes.js";
import { createGraphPlanningWorkflows } from "./server/routes/graph-workflows.js";
import { createGraphPipeline } from "./server/routes/graph-pipeline.js";
import { createCreateEnvironmentRoutes } from "./server/routes/create-environment.js";
import { validateBrowserMutationRequest } from "./server/browser-mutation.js";
import { createGitHubAccountCoordinator } from "./server/services/github-account-coordinator.js";
import {
  createGitHubAccountReadinessService,
  createGitHubSelectionHandleStore
} from "./server/services/github-account-readiness.js";
import { createEnvironmentsRoutes } from "./server/routes/environments.js";
import { createDeployRequestService } from "./server/services/deploy-request.js";
import { createDeployMonitorService } from "./server/services/deploy-monitor.js";
import { createDeployDispatchService } from "./server/services/deploy-dispatch.js";
import { createDeployOutcomeService } from "./server/services/deploy-outcome.js";
import { createPlannedGraphRecoveryService } from "./server/services/deploy-planned-graph.js";
import { runEnvironmentOperationWorkflow } from "./server/services/environment-operation.js";
import type { CanvasServerEntry } from "./server/types.js";

export type { CanvasServerEntry } from "./server/types.js";

interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export async function persistMutationCheckpoint({
  operation,
  persist,
  report,
  fail
}: {
  operation: any;
  persist: () => Promise<void>;
  report?: (diagnostic: { code: string; message: string }) => void;
  fail: (status: number, error: string, code: string) => Promise<void>;
}): Promise<boolean> {
  try {
    await persist();
    return true;
  } catch (error) {
    report?.({
      code: "operation-store-write-failed",
      message: `Could not persist setup operation ${operation?.operationId || "unknown"}: ${errorMessage(error)}`
    });
    // Do not retry the same deterministic write or continue making cloud
    // changes without durable provenance for what already succeeded.
    await fail(
      500,
      "Radius changed no further cloud resources because it could not save the setup recovery record.",
      "operation-persistence-failed"
    );
    return false;
  }
}

export async function persistBestEffort({
  operation,
  persist,
  report
}: {
  operation: any;
  persist: () => Promise<void>;
  report?: (diagnostic: { code: string; message: string }) => void;
}): Promise<boolean> {
  try {
    await persist();
    return true;
  } catch (error) {
    report?.({
      code: "operation-store-write-failed",
      message: `Could not persist setup operation ${operation?.operationId || "unknown"}: ${errorMessage(error)}`
    });
    return false;
  }
}

interface ChildProcessInput {
  stdin: { end(): unknown } | null;
}

export function endChildInput(child: ChildProcessInput): void {
  try {
    child.stdin?.end();
  } catch (_error: unknown) {
    // Closing stdin is best-effort; the command callback remains authoritative.
  }
}

function runCliCommand(
  cmd: string,
  args: string[],
  timeout = 60000
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = cliExec(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        code: err ? err.code || 1 : 0,
        stdout: stdout || "",
        stderr: stderr || ""
      });
    });
    endChildInput(child);
  });
}

interface ManagedEnvironment {
  name: string;
  provider?: string;
}

interface CachedPayload {
  at: number;
  payload: unknown;
}

interface AppBicepHandoffInput {
  repo: string;
  branches: string[];
  page: string;
}

export interface DeployRepairHandoffInput {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  attemptId: string;
  instanceId: string;
}

// Payload for the informational failure notice. Carries no attemptId: a notice
// never opens a repair loop, so there is no attempt for the agent to address.
export interface DeployFailureNoticeInput {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  instanceId: string;
}

interface OpenSourceInput {
  path: string;
  line: number;
  instanceId: string;
  state?: CanvasState;
}

type AppBicepHandoff = (input: AppBicepHandoffInput) => Promise<unknown>;
type DeployRepairHandoff = (input: DeployRepairHandoffInput) => unknown;
type DeployFailureNotice = (input: DeployFailureNoticeInput) => unknown;
type OpenSourceHandler = (input: OpenSourceInput) => Promise<unknown>;
type SessionPromptHandler = (
  prompt: string | SessionPromptMessage
) => Promise<unknown>;

interface IdValidationInput {
  tenantId?: string;
  subscriptionId?: string;
}

interface AzureLoginInput {
  tenantId?: string;
  activeTenantId?: string;
}

interface AzureCliAssistInput {
  action?: string;
  tenantId?: string;
}

// A prompt paired with the shorter text the chat timeline shows in its place.
// Mirrors the runtime's HandoffMessage: server-originated prompts are also
// machine-authored, so they must not render as if the user typed them (#209).
export interface SessionPromptMessage {
  prompt: string;
  displayPrompt: string;
}

interface DeployHandoffSummary {
  state: string;
  attempts: number;
  maxAttempts: number;
  pending: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

// The one adapter from `ghApiJson` to the `GitHubJsonRunner` port. Both the
// auto-setup routes and the deploy preflight read GitHub variables and OIDC
// customization through it, so status, body shape, and API version cannot drift
// between them. `executor` routes the read through a specific signed-in account
// when the caller has one; the deploy path has no operation context, so it uses
// the default `gh` credentials, the same identity the rest of the deploy uses.
async function runGitHubJsonRequest(
  apiPath: string,
  executor?: SelectedGhExecutor
): Promise<GitHubJsonResponse> {
  const result =
    executor ?
      await selectedGhApiJson(executor, apiPath)
    : await ghApiJson(apiPath, {
        headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION }
      });
  return {
    ok: result.ok,
    status: result.status,
    json:
      (
        result.json !== null &&
        typeof result.json === "object" &&
        !Array.isArray(result.json)
      ) ?
        record(result.json)
      : null,
    stderr: result.stderr
  };
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function canvasGraphResources(values: unknown[]): CanvasGraphResource[] {
  return values.map((value) => {
    const item = record(value);
    const connections =
      Array.isArray(item.connections) ?
        item.connections.map((connection) => {
          const fields = record(connection);
          return {
            ...fields,
            id: optionalString(fields.id),
            name: optionalString(fields.name),
            direction: optionalString(fields.direction)
          };
        })
      : undefined;
    return {
      ...item,
      id: optionalString(item.id),
      name: optionalString(item.name),
      type: optionalString(item.type),
      ...(connections ? { connections } : {})
    };
  });
}

interface DeploymentRecord {
  id: string;
  state: string;
  runUrl: string;
  isDeploy: boolean;
  isDelete: boolean;
  runStatus: string;
  runConclusion: string;
}

interface DeploymentRow {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
}

interface DeployStatusRecord {
  runConclusion?: string;
  runStatus?: string;
  state?: string;
}

// Composition root for the migrated `liveness-source` family. The handlers
// receive only the three seams they use; the open handler is read through a
// getter so the SDK entry can still register it after construction.
const livenessSourceRoutes = createLivenessSourceRoutes({
  getOpenSourceHandler: () => openSourceHandler,
  readInstanceState: (instanceId) =>
    canvasServer.instances.get(instanceId)?.state,
  toSafeRepoRelPath
});

function scheduleEnvironmentOperationForInstance(
  instanceId: string,
  operation: { operationId: string }
): boolean {
  const coordinator = instanceRequestCoordinators.get(instanceId);
  if (!coordinator) {
    console.error(
      `[radius operations] Missing request coordinator for instance ${instanceId}; cannot schedule operation ${operation.operationId}.`
    );
    return false;
  }
  coordinator.scheduleEnvironmentOperation(operation);
  return true;
}

// Composition root for the migrated `operations-status` family. Reads, creates,
// and resumable actions each receive only the registry, mutation, persistence,
// projection, and per-instance scheduling seams they invoke.
const operationsStatusRoutes = createOperationsStatusRoutes(
  {
    latest: (repo) => operations.latest(repo),
    latestAny: () => operations.latestAny(),
    get: (operationId) => operations.get(operationId),
    toClientView
  },
  {
    isValidRepoSlug,
    isResourceGroupName,
    isAksClusterName,
    isUuid,
    buildStages,
    createOperation,
    claimSelectionHandle: (input) => githubSelectionHandles.claim(input),
    startOperation: (op) => operations.start(op),
    persistOperations: () => operations.persist(),
    finish,
    scheduleEnvironmentOperation: scheduleEnvironmentOperationForInstance,
    errorMessage
  },
  {
    getOperation: (operationId) => operations.get(operationId),
    canResumeInput,
    resumeAfterInput,
    requireInput,
    finish,
    isTerminalState,
    persistOperations: () => operations.persist(),
    toClientView,
    scheduleEnvironmentOperation: scheduleEnvironmentOperationForInstance,
    errorMessage,
    inputRequiredState: INPUT_REQUIRED_STATE
  }
);

// Composition root for the migrated `repositories` family. Three seams: the
// subprocess runner, a reader for the live instance state the branch cache is
// written to, and the workspace-repo predicate, which stays defined here and is
// injected rather than copied.
const repositoriesRoutes = createRepositoriesRoutes({
  cliExec: (command, args, options, callback) => {
    cliExec(command, args, options, callback);
  },
  readInstanceState: (instanceId) =>
    canvasServer.instances.get(instanceId)?.state,
  repoMatchesWorkspace
});

// Composition root for the migrated `deployments` family: the read routes, the
// destructive POST /api/delete-deployment, and POST /api/deploy, whose
// multi-stage runtime behavior lives in the deploy services composed below.
//
// The listing cache, its TTL and the deploy service are read through getters
// because all three are declared further down the module and would otherwise be
// in the temporal dead zone when this object is built at import time.
const deploymentsRoutes = createDeploymentsRoutes({
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  triggerDeployRepairHandoff,
  triggerDeployFailureNotice,
  deployHandoffStatus,
  resolveRepoAppName,
  resolveEnvDeployment,
  ghOrThrow: (args) => ghOrThrow(args),
  resetDeploymentViewState: (state, attemptId) => {
    resetDeploymentViewState(state, attemptId);
  },
  get deployListCache() {
    return deployListCache;
  },
  get deployListTtlMs() {
    return DEPLOY_LIST_TTL_MS;
  },
  activeDeploymentMutation: (state) => activeDeploymentMutation(state),
  reserveDeploymentMutation: (state, reservation) =>
    reserveDeploymentMutation(state, reservation),
  releaseDeploymentMutation,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation: (state) =>
    localDeploymentBlocksMutation(state),
  ensureWorkflowsCurrent: (repo, environment, provider, only) =>
    ensureWorkflowsCurrent(repo, environment, provider, only),
  findWorkflowRun,
  runGh: (args, timeout = 20000, extraEnv) =>
    new Promise((resolve) => {
      const opts: CliOptions = { timeout };
      if (extraEnv) opts.env = extraEnv;
      cliExec("gh", args, opts, (err, stdout, stderr) => {
        resolve({
          code: err ? err.code || 1 : 0,
          stdout: (stdout || "").trim(),
          stderr: stderr || ""
        });
      });
    }),
  readProcessEnv: () => process.env,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  // Declared as a getter for the same temporal-dead-zone reason as the cache
  // above: the deploy services are composed further down, after the workflow
  // file names and the instance container they narrow over exist.
  get deployRequest() {
    return deployRequestService;
  }
});

// Composition root for the `azure-discovery` routes. Four seams:
// `az` runner (which carries the agent-session-stripped `cliExec` environment
// the Azure setup routes run under), the general trimmed-stdout CLI runner the
// discovery enumeration branches on, and the two pure `azure-oidc` helpers,
// injected rather than imported by the handler module.
const azureDiscoveryRoutes = createAzureDiscoveryRoutes({
  runAz: (command, args) => runCliCommand(command, args),
  runCli: (command, args, options) => runCommand(command, args, options),
  isUuid,
  parseServedReposFromSubjects: (subjects) =>
    parseServedReposFromSubjects(subjects as Iterable<unknown>)
});

const azureAutoSetupRoutes = createAzureAutoSetupRoutes(
  composeAzureAutoSetupDependencies({
    isServerOwnedRequest: (instanceId, request) =>
      instanceRequestCoordinators.get(instanceId)?.isServerOwned(request) ??
      false,
    lifecycle: {
      get: (operationId) => operations.get(operationId),
      isStale: (operation) => isStale(operation),
      create: (input) => createOperation(input),
      buildStages: () => buildStages(),
      start: (operation) => operations.start(operation),
      persist: () => operations.persist(),
      report: (diagnostic) => operations.report?.(diagnostic),
      finish: (operation, state, options) => {
        finish(operation, state, options);
      }
    },
    progress: {
      enterStage: (operation, stage) => {
        enterStage(operation, stage);
      },
      setStageState: (operation, stage, state) => {
        setStageState(operation, stage, state);
      },
      hasWarnings: (operation) => hasWarnings(operation),
      addLegacyStep: (operation, text) => {
        addLegacyStep(operation, text);
      },
      setContext: (operation, patch) => {
        setContext(operation, patch);
      },
      setCloudContext: (operation, provider, patch) => {
        setCloudContext(operation, provider, patch);
      },
      requireInput: (operation, input) => {
        requireInput(operation, input);
      },
      resumeAfterInput: (operation) => {
        resumeAfterInput(operation);
      }
    },
    artifacts: {
      recordAzureApp: (operation, patch) => {
        recordAzureApp(operation, patch);
      },
      recordServicePrincipal: (operation, patch) => {
        recordServicePrincipal(operation, patch);
      },
      recordCreatedFederatedCredential: (operation, entry) => {
        recordCreatedFederatedCredential(operation, entry);
      },
      recordCreatedRoleAssignment: (operation, entry) => {
        recordCreatedRoleAssignment(operation, entry);
      }
    },
    external: {
      getSelectedGitHubExecutor: (operationId) =>
        selectedGitHubExecutorsByOperation.get(operationId),
      getGitHubIdentity,
      preflightRepoAdmin: (repo, executor) =>
        preflightRepoAdmin(repo, executor),
      preflightGhcrPackageWriteAccess: (executor) =>
        preflightGhcrPackageWriteAccess(
          getGhPackageCredentials,
          getGitHubIdentity,
          executor
        ),
      runGitHubJson: (apiPath, executor) =>
        runGitHubJsonRequest(apiPath, executor),
      runAz: (args) => runCliCommand("az", args)
    },
    tempFile: {
      createPath: () =>
        join(
          tmpdir(),
          `radius-fed-cred-${randomBytes(12).toString("hex")}.json`
        ),
      write: (path, contents) => {
        writeFileSync(path, contents, { mode: 0o600 });
      },
      remove: (path) => {
        try {
          unlinkSync(path);
        } catch {}
      }
    },
    ensureServicePrincipal,
    finalizeSetupFailure,
    persistMutationCheckpoint,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stageAuthorizeIdentity: STAGE_AUTHORIZE_IDENTITY
  })
);

const githubAccountCoordinator = createGitHubAccountCoordinator({
  createExecutor: (login) => createSelectedGhExecutor(login),
  getActiveKeyringLogin,
  switchKeyringAccount: switchGhKeyringAccount,
  resetIdentityCache: resetGhIdentityCache
});
const githubAccountReadiness = createGitHubAccountReadinessService(
  githubAccountCoordinator
);
const githubSelectionHandles = createGitHubSelectionHandleStore();
const selectedGitHubExecutorsByOperation = new Map<
  string,
  SelectedGhExecutor
>();

// Composition root for the credential-profile and GitHub-identity half of the
// `identity-credentials` family. Ten narrow function seams: the three profile
// store operations, the four gh identity operations, the advisory repo
// preflight, the repo-slug guard, and the error formatter. `preflightRepoAdmin`
// and `errorMessage` stay defined here and are injected rather than moved, so
// the route module spawns nothing and touches no disk.
const identityProfilesRoutes = createIdentityProfilesRoutes({
  listCredentialProfiles,
  saveCredentialProfile,
  deleteCredentialProfile,
  getGitHubIdentity,
  resetGhIdentityCache,
  prepareGitHubAccount: async ({ instanceId, repo, environment, login }) => {
    const generation = githubSelectionHandles.begin(instanceId);
    const readiness = await githubAccountReadiness.check({
      instanceId,
      repo,
      environment,
      login
    });
    if (!readiness.ready || !readiness.credentialSource) return { readiness };
    const selection = githubSelectionHandles.mint({
      instanceId,
      repo,
      environment,
      login: readiness.login,
      credentialSource: readiness.credentialSource,
      generation
    });
    if (!selection) return { readiness };
    return {
      readiness,
      selectionHandle: selection.handle,
      expiresAt: selection.expiresAt
    };
  },
  preflightRepoAdmin,
  isValidRepoSlug,
  errorMessage
});

// Composition root for the auth/verify half of the `identity-credentials`
// family. Eight narrow function seams: the CLI runner from `gh.ts`, and the
// GUID, Azure-message, prompt-builder and error helpers that stay defined here.
// The session-prompt hook is bound here too so the route module never reads the
// mutable module-level handler.
const identityAuthRoutes = createIdentityAuthRoutes({
  azureCredentialIdValidationError,
  azureLoginRequiredResponse,
  isCliCommandMissing,
  isUuid,
  buildAzureCliAssistMessage: azureCliAssistMessage,
  runSessionPrompt: (prompt) =>
    invokeSessionPrompt(sessionPromptHandler, prompt),
  runCommand: (command, args, options) => runCommand(command, args, options),
  errorMessage
});

// Suggested terminal commands are handed to the Copilot session, never run by
// this server. The route rebuilds each command from the core registry, so the
// only seams it needs are that same session hook and the error formatter.
const remediationRoutes = createRemediationRoutes(
  productionRemediationDependencies({
    runSessionPrompt: (prompt) =>
      invokeSessionPrompt(sessionPromptHandler, prompt),
    errorMessage
  })
);

const graphsPlanningStreamRoutes = createGraphsPlanningStreamRoutes({
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  defaultBranchForState,
  prepareSourceRef: (entry, context) =>
    prepareSourceRefResources(entry, "graph", context),
  commitSourceRef: (entry, resources, context, expectedToken) =>
    setSourceRefResources(entry, "graph", resources, context, expectedToken),
  triggerAppBicepHandoff: (entry, repo, branch) =>
    triggerAppBicepHandoff(entry, repo, branch, "graph"),
  fetchBicepSelection: (entry, repo, branch) =>
    fetchBicepSelection(entry, repo, branch),
  listBranchPaths: (entry, repo, branch) =>
    listBranchPaths(entry, repo, branch),
  workspaceGraphJsonPath: (state, bicepRepoPath) =>
    workspaceGraphJsonPath(state, bicepRepoPath),
  radArtifactsDirForSelection: (options) =>
    radArtifactsDirForSelection({ ...options, github }),
  buildGraphViaRad: (content, bicepPath, options) =>
    buildGraphViaRad(content, bicepPath, options),
  canvasGraphResources,
  errorMessage
});

// Composition root for the write half of the `graphs-planning` family. The
// complete dependency object is assembled here and nowhere else; the workflow
// service receives narrow function seams and the shared modeling pipeline
// receives its own eight, so neither module holds a GitHub client, spawns
// `rad`, or touches disk directly.
//
// `github` is bound into `resolveRadArtifactsDir`, `fetchRecipePack` and
// `resolveRecipeOutputs` here rather than injected, which is what keeps the
// route modules free of it. The pure helpers (`defaultBranchForState`,
// `computeGraphDiff`, `record`, …) are injected rather than imported by the
// workflows, matching how the sibling families inject `repoMatchesWorkspace`.
const graphPlanningWorkflows = createGraphPlanningWorkflows<CanvasServerEntry>({
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  pipeline: createGraphPipeline<CanvasServerEntry>({
    fetchBicepSelection: (entry, repo, branch) =>
      fetchBicepSelection(entry, repo, branch),
    resolveRadArtifactsDir: (request) =>
      radArtifactsDirForSelection({ ...request, github }),
    buildGraphViaRad: (content, definitionFile, options) =>
      buildGraphViaRad(content, definitionFile, options),
    canvasGraphResources,
    workspaceGraphJsonPath,
    graphDefinitionHash,
    radArtifactsFingerprint,
    removeDirectory: (dir) => {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
  triggerAppBicepHandoff,
  listBranchPaths: (entry, repo, branch) =>
    listBranchPaths(entry, repo, branch),
  prepareSourceRefResources: (entry, view, sourceRefInput) =>
    prepareSourceRefResources(entry, view, sourceRefInput),
  setSourceRefResources: (entry, view, resources, sourceRefInput, token) =>
    setSourceRefResources(entry, view, resources, sourceRefInput, token),
  isCurrentSourceRefToken,
  defaultBranchForState,
  canReuseModeledGraph,
  addGraphProgress,
  beginPlannedGraphRequest,
  isCurrentPlannedGraphRequest,
  fetchRecipePack: (provider) => fetchRecipePack(github, provider),
  resolveRecipeOutputs: (resources, recipes, provider) =>
    resolveRecipeOutputs(github, resources, recipes, provider),
  computeGraphDiff: (baseResources, headResources) =>
    computeGraphDiff(baseResources, headResources),
  record,
  optionalString,
  errorMessage,
  now: () => Date.now()
});

// Composition root for the read-only half of the `graphs-planning` family. The
// Deployed route reads status through the cached artifact reader, but obtains its
// fixed topology through the same modeled-graph workflow and cache as the Graph
// route. It never parses Bicep or invokes rad through a second path.
const graphsPlanningRoutes = createGraphsPlanningRoutes({
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  createDeployStatusReader: (options) => cachedDeployStatusReader(options),
  loadModeledGraph: async (instanceId, repo, branch) => {
    const outcome = await graphPlanningWorkflows.loadGraph({
      instanceId,
      body: JSON.stringify({ repo, branch, refresh: true })
    });
    const workflowError = optionalString(outcome.payload.error);
    return {
      status: outcome.status,
      retry: outcome.payload.needsAppBicep === true,
      error:
        workflowError ||
        (outcome.status >= 400 ?
          `Modeled graph load failed with status ${outcome.status}.`
        : undefined)
    };
  },
  buildDeployStatusMap,
  buildDeployMessageMap,
  deployStatusKeys,
  mergeDeployedGraphMetadata,
  projectDeployedGraph: (modeled, statusByKey) =>
    projectDeployedGraph(modeled as any[], statusByKey),
  canvasGraphResources,
  applyDeployMessages,
  settleDeployStatuses,
  errorMessage,
  repoMatchesWorkspace,
  now: () => Date.now()
});

// The route layer sees exactly one seam: the workflow service above. Parsing
// and serialization are all it owns.
const graphsPlanningWritesRoutes = createGraphsPlanningWritesRoutes({
  workflows: graphPlanningWorkflows
});

// The listing TTL and verify-workflow filename are declared here, before the
// environments composition root reads them eagerly. Their canonical uses stay
// below with the rest of the cache and verify constants; hoisting only the
// declaration keeps the module-init read out of the temporal dead zone.
const ENV_LIST_TTL_MS = 15000;
const VERIFY_WORKFLOW_FILE = "radius-verify-credentials.yml";

// Composition root for the migrated `environments` family. Its remaining
// route, `POST /api/create-environment`, is large enough to own a separate
// composition root below. Every seam is a narrow named function: the two subprocess
// runners (`cliExec`, `runCommand`), the repo-file fetch and bicep param parse
// for `app-params`, the app-name and active-deployment resolvers plus the
// error logger for `delete-environment`, three narrow accessors over the
// module-level `envListCache` (so this module owns no cache), the workflow-sync
// kickoff and clock for `list-environments`, and the operation-registry,
// run-inspection, and finisher helpers for `verify-status`. `repoMatchesWorkspace`,
// `errorMessage`, `VERIFY_WORKFLOW_FILE`, and `STAGE_VERIFY` stay defined here
// and are injected rather than moved, so the route module spawns nothing and
// reads no module-level mutable state.
const environmentsRoutes = createEnvironmentsRoutes({
  errorMessage,
  repoMatchesWorkspace,
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  runCommand: (command, args, options) => runCommand(command, args, options),
  fetchFileFromRepo: (repo, path, branch) =>
    fetchFileFromRepo(repo, path, branch),
  appParams,
  resolveRepoAppName: (repo, branch) => resolveRepoAppName(repo, branch),
  resolveEnvDeployment: (repo, environment, appName) =>
    resolveEnvDeployment(repo, environment, appName),
  logError: (message) => console.error(message),
  cliExec: (command, args, options, callback) => {
    cliExec(command, args, options, callback);
  },
  envListCacheGet: (repo) => envListCache.get(repo),
  envListCacheSet: (repo, entry) => {
    envListCache.set(repo, entry);
  },
  envListCacheDelete: (repo) => {
    envListCache.delete(repo);
  },
  envListTtlMs: ENV_LIST_TTL_MS,
  kickoffWorkflowSync: (repo, managedEnvironments, workingBranch) =>
    kickoffWorkflowSync(repo, managedEnvironments, workingBranch),
  now: () => Date.now(),
  getOperation: (operationId) => operations.get(operationId),
  getSelectedGitHubExecutor: (operationId) =>
    selectedGitHubExecutorsByOperation.get(operationId),
  hasCompleteVerificationIdentity,
  findWorkflowRun: (repo, workflowFile, sinceMs, knownId, executor) =>
    findWorkflowRun(repo, workflowFile, sinceMs, knownId, executor),
  getRunDetail: (repo, runId, executor) => getRunDetail(repo, runId, executor),
  fetchRunLog: (repo, runId, executor) => fetchRunLog(repo, runId, executor),
  extractErrorLines: (logText, max) => extractErrorLines(logText, max),
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  explainNoSubscriptions,
  addLegacyStep: (operation, text) => addLegacyStep(operation, text),
  isTerminalState,
  finish,
  finishSucceeded,
  persistBestEffort,
  persistOperations: () => operations.persist(),
  reportOperationDiagnostic: (diagnostic) => operations.report?.(diagnostic),
  verifyWorkflowFile: VERIFY_WORKFLOW_FILE,
  stageVerify: STAGE_VERIFY
});

// Composition root for `POST /api/create-environment`. The route's four seams
// live in `create-environment*.ts`; everything they touch is injected here, so
// the module spawns no process directly, imports no `node:fs`, and reads no
// module-level mutable state. `isServerOwnedRequest` is deliberately a
// per-request function rather than a value: the token is a per-instance
// `randomUUID()` held by that instance's request coordinator, and this route is
// reachable only through the internal loopback POST that carries it.
const createEnvironmentRoutes = createCreateEnvironmentRoutes({
  isServerOwnedRequest: (instanceId, request) =>
    instanceRequestCoordinators.get(instanceId)?.isServerOwned(request) ??
    false,
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  getSelectedGitHubExecutor: (operationId) =>
    selectedGitHubExecutorsByOperation.get(operationId),
  cliExec: (command, args, options, callback) =>
    cliExec(command, args, options, callback),
  readProcessEnv: () => process.env,
  isValidRepoSlug,
  getOperation: (operationId) => operations.get(operationId),
  isStale: (operation) => isStale(operation),
  createOperation,
  buildStages,
  startOperation: (operation) => operations.start(operation),
  persistOperations: () => operations.persist(),
  reportOperationDiagnostic: (diagnostic) => operations.report?.(diagnostic),
  finishFailed: (operation, failure) => {
    finish(operation, "failed", { failure });
  },
  enterStage: (operation, stage) => {
    enterStage(operation, stage);
  },
  errorMessage,
  stageAuthorizeIdentity: STAGE_AUTHORIZE_IDENTITY,
  stageConfigureEnvironment: STAGE_CONFIGURE_ENVIRONMENT,
  addLegacyStep: (operation, text) => {
    addLegacyStep(operation, text);
  },
  finalizeSetupFailure: (operation, input) =>
    finalizeSetupFailure(operation, input as never),
  persistMutationCheckpoint,
  persistBestEffort,
  runAzCommand: (args) => runCliCommand("az", args),
  preflightRepoAdmin: (repo, executor) => preflightRepoAdmin(repo, executor),
  preflightGhcrPackageWriteAccess: (executor) =>
    preflightGhcrPackageWriteAccess(
      getGhPackageCredentials,
      getGitHubIdentity,
      executor
    ),
  readGitHubJson: (apiPath, executor) =>
    runGitHubJsonRequest(apiPath, executor),
  bootstrapGHCRStatePackage: (input) =>
    bootstrapGHCRStatePackage({
      targetRepository: input.targetRepository,
      registry: input.registry,
      credentials: input.credentials as GhcrPackageCredentials
    }),
  stateRegistryForEnvironment,
  getDefaultBranch: (repo, executor) =>
    executor ?
      selectedGetDefaultBranch(executor, repo)
    : getDefaultBranch(repo),
  getBranchHeadSha: (repo, branch, executor) =>
    executor ?
      selectedGetBranchHeadSha(executor, repo, branch)
    : getBranchHeadSha(repo, branch),
  createBranchRef: (repo, branch, sha, executor) =>
    executor ?
      selectedCreateBranchRef(executor, repo, branch, sha)
    : createBranchRef(repo, branch, sha),
  tempFile: {
    write: (contents) => {
      const path = join(
        tmpdir(),
        "radius-wf-commit-" +
          Date.now() +
          "-" +
          Math.random().toString(36).slice(2) +
          ".json"
      );
      writeFileSync(path, contents);
      return path;
    },
    remove: (path) => {
      try {
        unlinkSync(path);
      } catch {}
    }
  },
  setCanonicalEnvironment: (operation, environment) => {
    setCanonicalEnvironment(operation, environment);
  },
  recordGitHubEnvironment: (operation, patch) => {
    recordGitHubEnvironment(operation, patch);
  },
  envListCacheDelete: (repo) => {
    envListCache.delete(repo);
  },
  ociStateBackend: OCI_STATE_BACKEND,
  defaultStateArchive: DEFAULT_STATE_ARCHIVE,
  azureCredential: () => cloudCredential(sharedCredentials.azure),
  awsCredential: () => cloudCredential(sharedCredentials.aws),
  optionalString,
  generateVerifyWorkflow: (environment, provider) =>
    generateVerifyWorkflow(environment, provider),
  generateDeployWorkflow: (environment, appFile) =>
    generateDeployWorkflow(environment, appFile),
  generateDeleteWorkflow: (environment) => generateDeleteWorkflow(environment),
  recordCommittedWorkflowFile: (operation, entry) => {
    recordCommittedWorkflowFile(operation, entry);
  },
  deleteLegacyDeployWorkflow: (repo, executor) =>
    deleteLegacyDeployWorkflow(repo, executor),
  createPullRequestApi: (repo, head, base, title, body, executor) =>
    executor ?
      selectedCreatePullRequest(executor, repo, head, base, title, body)
    : createPullRequestApi(repo, head, base, title, body),
  planCredentialVerification,
  fetchFileFromRepo: (repo, path, branch, executor) =>
    executor ?
      selectedFetchFileFromRepo(executor, repo, path, branch)
    : fetchFileFromRepo(repo, path, branch),
  buildVerifyWorkflowDispatchArgs,
  verifyWorkflowFile: VERIFY_WORKFLOW_FILE,
  stageVerify: STAGE_VERIFY,
  recordCleanupState: (operation, patch) => {
    recordCleanupState(operation, patch);
  },
  recordCommitState: (operation, patch) => {
    recordCommitState(operation, patch);
  },
  setStageState: (operation, stage, state) => {
    setStageState(operation, stage, state);
  },
  finish: (operation, state, options) => {
    finish(operation, state, options);
  },
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now()
});

// Built once at module initialization so table validation runs a single time
// and a missing typed handler fails early rather than per instance.
const serverRoutes = createServerRouteTable({
  ...livenessSourceRoutes,
  ...operationsStatusRoutes,
  ...repositoriesRoutes,
  ...deploymentsRoutes,
  ...azureDiscoveryRoutes,
  ...azureAutoSetupRoutes,
  ...identityProfilesRoutes,
  ...identityAuthRoutes,
  ...remediationRoutes,
  ...graphsPlanningRoutes,
  ...graphsPlanningStreamRoutes,
  ...graphsPlanningWritesRoutes,
  ...environmentsRoutes,
  ...createEnvironmentRoutes
});

// Per-instance coordinators own the server token, background operation runner,
// recovered verification monitors, and page/unmatched request handling. They are
// released by the stopped hook when the instance stops.
const instanceRequestCoordinators = new Map<
  string,
  ReturnType<typeof createInstanceRequestCoordinator>
>();

const canvasServer = createCanvasServer(
  createProductionCanvasServerDependencies({
    createRequestHandler: ({ instanceId, instances, markActivity }) => {
      const coordinator = createInstanceRequestCoordinator(
        instanceId,
        () => instances.get(instanceId)?.baseUrl || ""
      );
      instanceRequestCoordinators.set(instanceId, coordinator);
      return createScaffoldRequestHandler({
        instanceId,
        instances,
        routes: serverRoutes,
        handleUnmatchedRequest: coordinator.handleUnmatchedRequest,
        // Server-owned internal calls must not refresh the webview activity
        // clock, or the idle-respawn timer never fires.
        markActivity: (request) => {
          if (!coordinator.isServerOwned(request)) markActivity();
        },
        validateBrowserMutation: (context) =>
          coordinator.validateBrowserMutation(context.request),
        preRoute: preRouteCanvasRequest
      });
    },
    onStarted: (instanceId, entry) => {
      shuttingDownInstances.delete(instanceId);
      const coordinator = instanceRequestCoordinators.get(instanceId);
      if (coordinator) {
        entry.state.browserMutationNonce = coordinator.browserMutationNonce;
        coordinator.startRecoveredVerificationTasks();
      }
    },
    onStopped: (instanceId) => {
      instanceRequestCoordinators.delete(instanceId);
    },
    defaultPage: DEFAULT_CANVAS_PAGE,
    preferredPort: preferredPortForInstance
  })
);

// Shared instance registry used by the runtime and request handler.
export const servers = canvasServer.instances;

let environmentOperationTestRunner:
  ((operationId: string) => Promise<void>) | null = null;

export function setEnvironmentOperationTestRunner(
  runner: ((operationId: string) => Promise<void>) | null
): void {
  environmentOperationTestRunner = runner;
}

const activeEnvironmentTasks = new Map<string, Set<string>>();
const environmentTasksSettledListeners = new Map<string, Set<() => void>>();
const shuttingDownInstances = new Set<string>();
const activeVerificationMonitors = new Set<string>();

export function hasActiveEnvironmentTasks(instanceId: string): boolean {
  return (activeEnvironmentTasks.get(instanceId)?.size || 0) > 0;
}

export function markEnvironmentInstanceShuttingDown(instanceId: string): void {
  shuttingDownInstances.add(instanceId);
}

export function onEnvironmentTasksSettled(
  instanceId: string,
  listener: () => void
): () => void {
  let listeners = environmentTasksSettledListeners.get(instanceId);
  if (!listeners) {
    listeners = new Set();
    environmentTasksSettledListeners.set(instanceId, listeners);
  }

  listeners.add(listener);
  let listening = true;
  const stop = () => {
    if (!listening) return;
    listening = false;
    listeners?.delete(listener);
    if (listeners?.size === 0)
      environmentTasksSettledListeners.delete(instanceId);
  };
  if (!hasActiveEnvironmentTasks(instanceId)) {
    queueMicrotask(() => {
      if (!listening || hasActiveEnvironmentTasks(instanceId)) return;
      try {
        listener();
      } catch {
        // Listener failures must not affect task settlement.
      }
    });
  }
  return stop;
}

export function graphDefinitionHash(
  content: string,
  artifactsFingerprint = ""
): string {
  return createHash("sha256")
    .update(content)
    .update("\0")
    .update(artifactsFingerprint)
    .digest("hex");
}

export function canReuseModeledGraph(
  state: CanvasState,
  repo: string,
  branch: string,
  definitionHash: string
): boolean {
  return (
    state?.graphLoaded === true &&
    state.graphTargetRepo === repo &&
    state.graphBranch === branch &&
    state.graphDefinitionHash === definitionHash &&
    Array.isArray(state.graphResources)
  );
}

export function isCurrentSourceRefToken(
  state: {
    sourceRefContexts?: Partial<Record<GraphView, { token?: string }>>;
  },
  view: GraphView,
  token: unknown
): boolean {
  return !!token && state?.sourceRefContexts?.[view]?.token === token;
}

export function addGraphProgress(
  state: CanvasState,
  generation: number,
  view: GraphProgressView,
  event: Omit<GraphBuildEvent, "sequence">
): boolean {
  if (!state || state.graphBuildGeneration !== generation) return false;
  const record = state.graphProgressRecords?.[view];
  if (!record) return false;
  recordGraphBuildEvent(record, event);
  return true;
}

// deployStatusReaderFromState - build a deployed-graph/status reader for a
// canvas instance's state.
//
// Deploy status and the deployed application graph are published by the deploy
// workflow as a workflow artifact (see ./deploy-artifacts.ts). Scope the read to
// the run being monitored when there is one, so an in-flight deploy reports its
// own status rather than the previous run's; otherwise read the newest matching
// artifact repo-wide, which is what a fresh canvas session with no run in flight
// needs.
//
// The application name only breaks ties between artifacts in the same
// environment; it is never a lookup key and never a hard filter. That is why the
// ordinary `resolveRepoAppName` is good enough here even though it falls back to
// the repository's short name: a wrong guess cannot hide a real artifact.
async function deployStatusReaderFromState(
  state: CanvasState,
  repo: string,
  branch: string,
  runId?: number | string | null
) {
  const environment = state?.deployEnvName || state?.envName || "";
  let application = state?.deployAppName || "";
  if (!application && repo) {
    application = await resolveRepoAppName(
      repo,
      branch || state?.deployingBranch || state?.graphBranch || ""
    );
    if (application && state) state.deployAppName = application;
  }
  return cachedDeployStatusReader({
    repo,
    environment,
    application,
    runId: runId ?? state?.deployRunId ?? null
  });
}

// createDeployStatusReader keeps its TTL cache, single-flight de-dup and
// monotonic `sequence` guard in the reader instance, so building a fresh reader
// per request makes all three inert and lets the deploy monitor and an
// /api/deployed-graph poll download the same artifact concurrently. Cache
// readers by their identity so callers reading the same deployment share one.
const deployStatusReaders = new Map<
  string,
  ReturnType<typeof createDeployStatusReader>
>();
const MAX_DEPLOY_STATUS_READERS = 32;

function cachedDeployStatusReader(
  options: Parameters<typeof createDeployStatusReader>[0]
): ReturnType<typeof createDeployStatusReader> {
  const key = [
    options.repo,
    options.environment || "",
    options.application || "",
    options.runId ?? ""
  ].join("\n");
  const existing = deployStatusReaders.get(key);
  if (existing) {
    // Refresh LRU position so the cap evicts genuinely idle readers, not the
    // one a live deploy is actively polling.
    deployStatusReaders.delete(key);
    deployStatusReaders.set(key, existing);
    return existing;
  }
  const reader = createDeployStatusReader(options);
  deployStatusReaders.set(key, reader);
  // Bounded: each run mints a new key (runId is part of it), so a long session
  // cycling through deploys/environments must not grow the map without limit.
  while (deployStatusReaders.size > MAX_DEPLOY_STATUS_READERS) {
    const oldest = deployStatusReaders.keys().next().value;
    if (oldest === undefined) break;
    deployStatusReaders.delete(oldest);
  }
  return reader;
}

// Short-lived cache for the /api/list-environments listing to keep the planned
// and deploy pages snappy. Invalidated on environment creation.
const envListCache = new Map<string, CachedPayload>();

// Short-lived cache for the /api/list-deployments listing. The listing fans out
// into many per-record `gh api` calls, so caching keeps the deploy page snappy
// across re-opens and the workflow poll. Invalidated when a deploy or delete is
// dispatched: the deployments route family is handed this same map and evicts
// from there, while the deploy dispatch service evicts through the
// `invalidateDeployListCache` seam bound below.
const DEPLOY_LIST_TTL_MS = 15000;
const deployListCache = new Map<string, CachedPayload>();

// Both listing caches are module-scoped, so they outlive any single canvas
// server instance. Callers that must not observe a listing captured under
// different external state clear them wholesale through this seam.
export function resetListingCaches(
  environments: { clear(): void } = envListCache,
  deployments: { clear(): void } = deployListCache
): void {
  environments.clear();
  deployments.clear();
}

// A deploy request resolves branch and GitHub state asynchronously before
// beginDeployAttempt marks the canvas state in progress. Reserve that window so
// two near-simultaneous requests cannot both pass the conflict check and start.
// Deploy reservations live through the background monitor; delete reservations
// live through the short GitHub record-publication window. Failures release
// immediately.
export interface DeploymentDispatchReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete";
  expiresAt: number;
  attemptId?: string;
}

export const DEPLOYMENT_MUTATION_LEASE_MS = 30 * 60 * 1000;

type DeploymentDispatchReservationInput = Omit<
  DeploymentDispatchReservation,
  "expiresAt"
>;

export function activeDeploymentMutation(
  state: CanvasState,
  now = Date.now()
): DeploymentDispatchReservation | undefined {
  const current = state.deploymentMutation;
  if (current && current.expiresAt <= now) {
    delete state.deploymentMutation;
    return undefined;
  }
  return current;
}

export function reserveDeploymentMutation(
  state: CanvasState,
  reservation: DeploymentDispatchReservationInput,
  now = Date.now()
): DeploymentDispatchReservation | null {
  if (activeDeploymentMutation(state, now)) return null;
  const owner = {
    ...reservation,
    expiresAt: now + DEPLOYMENT_MUTATION_LEASE_MS
  };
  state.deploymentMutation = owner;
  return owner;
}

export function releaseDeploymentMutation(
  state: CanvasState,
  reservation: DeploymentDispatchReservation
): void {
  if (state.deploymentMutation === reservation) delete state.deploymentMutation;
}

export function deploymentStatusBlocksMutation(status: unknown): boolean {
  return (
    status === "pending" || status === "in_progress" || status === "deleting"
  );
}

export function localDeploymentBlocksMutation(
  state: CanvasState,
  now = Date.now()
): boolean {
  if (state.deployStatus !== "in_progress") return false;
  return (
    typeof state.deployStartedAt !== "number" ||
    state.deployStartedAt + DEPLOYMENT_MUTATION_LEASE_MS > now
  );
}

export function resolveDeploymentEnvironment(
  state: CanvasState,
  requestedEnvironment: unknown
): string {
  return (
    (typeof requestedEnvironment === "string" && requestedEnvironment) ||
    (typeof state.envName === "string" && state.envName) ||
    ""
  );
}

export function beginPlannedGraphRequest(state: CanvasState): number {
  const generation =
    typeof state.plannedRequestGeneration === "number" ?
      state.plannedRequestGeneration + 1
    : 1;
  state.plannedRequestGeneration = generation;
  state.plannedResources = null;
  return generation;
}

export function isCurrentPlannedGraphRequest(
  state: CanvasState,
  generation: number
): boolean {
  return state.plannedRequestGeneration === generation;
}

export function resetDeploymentViewState(
  state: CanvasState,
  attemptId: unknown,
  now = Date.now()
): void {
  const requestedAttemptId =
    typeof attemptId === "string" ? attemptId : undefined;
  if (
    state.deployAttempt?.id &&
    requestedAttemptId !== state.deployAttempt.id
  ) {
    return;
  }
  delete state.deployResult;
  const mutation = activeDeploymentMutation(state, now);
  if (
    mutation?.attemptId &&
    mutation.attemptId === requestedAttemptId &&
    state.deployAttempt?.id === requestedAttemptId
  ) {
    releaseDeploymentMutation(state, mutation);
  }
}

// Throttle for the background workflow drift-sync kicked off from the
// environments listing: repo -> last-attempt epoch ms. Keeps the sync from
// re-running on every page load / poll while still self-healing stale workflows.
const WORKFLOW_SYNC_TTL_MS = 5 * 60 * 1000;
const workflowSyncState = new Map<string, number>();

// Fire-and-forget: re-sync the repo's committed Radius workflow files with the
// upstream templates when they've drifted. Runs in the background so it never
// delays the environments listing, and is throttled per repo. Managed
// environments (name + provider) are required to regenerate the expected
// content, so this is only called on the fresh-compute path. `workingBranch` is
// the session worktree branch (when it matches the repo) so the sync updates
// both the default branch and the branch a worktree-consistent deploy runs.
function kickoffWorkflowSync(
  repo: string,
  managedEnvironments: ManagedEnvironment[],
  workingBranch: string
): void {
  if (!repo || !managedEnvironments || managedEnvironments.length === 0) return;
  // Throttle per repo+branch so switching the working branch triggers a fresh
  // sync instead of waiting out a repo-wide cooldown.
  const key = `${repo}\u0000${workingBranch || ""}`;
  const last = workflowSyncState.get(key) || 0;
  if (Date.now() - last < WORKFLOW_SYNC_TTL_MS) return;
  workflowSyncState.set(key, Date.now());
  syncRepoWorkflows(repo, managedEnvironments, {
    workingBranch: workingBranch || "",
    log: (m) => console.error(`[radius workflow-sync] ${repo}: ${m}`)
  })
    .then((r) => {
      if (r && r.updated && r.updated.length) {
        console.error(
          `[radius workflow-sync] ${repo}: updated ${
            r.updated.length
          } workflow file(s) across ${(r.branches || []).join(
            ", "
          )}: ${r.updated.join(", ")}`
        );
      }
    })
    .catch((e: unknown) =>
      console.error(`[radius workflow-sync] ${repo}: ${errorMessage(e)}`)
    );
}

// Bare filename of the shared verify-credentials workflow (matches
// infra.ts's VERIFY_WORKFLOW_PATH). Used to target a pre-dispatch sync.
// Declared alongside the other verify constants; see the composition-root copy
// above for the eagerly-read value.

// Awaited, best-effort pre-dispatch workflow sync. Before the extension runs a
// committed workflow (deploy / delete / verify), ensure that workflow's files
// are present on the branch it runs from AND in sync with the upstream Radius
// templates, so the dispatch never 404s on a missing file or executes a drifted
// copy. Unlike the throttled background pass (kickoffWorkflowSync), this is
// scoped to just the workflow about to run (`only`), authors a missing file
// (`create`), and is awaited so any create/update lands before the dispatch —
// but a sync failure never blocks the dispatch (we log and proceed). `provider`
// may be "" when unknown; deploy and delete workflow content is
// provider-agnostic, so it only matters for verify. `workingBranch` (when it
// matches the repo) is synced alongside the default branch so a
// worktree-consistent run uses current files on both.
async function ensureWorkflowsCurrent(
  repo: string,
  environment: string,
  provider: string,
  only: string[],
  workingBranch = ""
): Promise<{ created: string[]; failed: WorkflowCommitFailure[] }> {
  if (!repo || !environment || !only || only.length === 0)
    return { created: [], failed: [] };
  try {
    const r = await syncRepoWorkflows(
      repo,
      [{ name: environment, provider: provider || "" }],
      {
        workingBranch: workingBranch || "",
        only,
        // Author the workflow if it's missing on the branch it will run from,
        // not just update drift. `gh workflow run` resolves the workflow from
        // the default branch, so a never-committed (or wrongly-refed) file 404s;
        // creating it here makes the dispatch self-healing.
        create: true,
        log: (m) => console.error(`[radius workflow-presync] ${repo}: ${m}`)
      }
    );
    if (
      r &&
      ((r.updated && r.updated.length) || (r.created && r.created.length))
    ) {
      const changed = [...(r.updated || []), ...(r.created || [])];
      console.error(
        `[radius workflow-presync] ${repo}: ${changed.join(", ")} before dispatch`
      );
    }
    return { created: r.created || [], failed: r.failed || [] };
  } catch (e) {
    console.error(`[radius workflow-presync] ${repo}: ${errorMessage(e)}`);
    return { created: [], failed: [] };
  }
}

// no access to the SDK `session`, so when a graph/generate route finds no
// app.bicep it delegates through this hook, which injects a user turn asking the
// agent to run the radius-app-bicep skill. This is what makes branch/repo
// selection (not just canvas open) trigger generation automatically.
let appBicepHandoff: AppBicepHandoff | null = null;
export function setAppBicepHandoff(fn: AppBicepHandoff): void {
  appBicepHandoff = fn;
}

// Registered by the SDK entry (extension.ts) to hand a failed canvas deploy
// back to the agent for repair. The canvas Deploy button dispatches the workflow
// itself, so without this a failure dead-ends in the UI.
let deployRepairHandoff: DeployRepairHandoff | null = null;
export function setDeployRepairHandoff(fn: DeployRepairHandoff | null): void {
  deployRepairHandoff = fn;
}

// Registered by the SDK entry (extension.ts) to relay a canvas deploy failure
// that must NOT be auto-repaired (its workflow run could not be confirmed) back
// to the agent as an informational report. Separate from the repair handoff so
// the two can never be confused: this one never opens a repair loop.
let deployFailureNotice: DeployFailureNotice | null = null;
export function setDeployFailureNotice(fn: DeployFailureNotice | null): void {
  deployFailureNotice = fn;
}

// Handler registered by the SDK entry (extension.ts) that opens a repo file in
// the Copilot app's built-in "editor" canvas (side pane). The server has no SDK
// access, so the webview's "View source code" click (for local-workspace graphs)
// reaches the SDK through this hook. Mirrors setAppBicepHandoff.
let openSourceHandler: OpenSourceHandler | null = null;
export function setOpenSourceHandler(fn: OpenSourceHandler): void {
  openSourceHandler = fn;
}

// The server also cannot inject an arbitrary user turn by itself, so routes that
// need the Copilot session to take an out-of-band action (for example, kicking
// off Azure CLI login or install guidance) delegate through this hook.
let sessionPromptHandler: SessionPromptHandler | null = null;
export function setSessionPromptHandler(fn: SessionPromptHandler): void {
  sessionPromptHandler = fn;
}

export function isCliCommandMissing(detail: unknown): boolean {
  const text = String(detail || "").trim();
  if (!text) return false;
  return (
    /\bspawn(?:Sync)?\s+az(?:\.exe)?\s+ENOENT\b/i.test(text) ||
    /\baz(?:\.exe)?:\s*command not found\b/i.test(text) ||
    /['"]?az(?:\.exe)?['"]?\s+is not recognized as an internal or external command\b/i.test(
      text
    )
  );
}

export function azureCredentialIdValidationError({
  tenantId = "",
  subscriptionId = ""
}: IdValidationInput = {}): string {
  if (tenantId && !isUuid(tenantId)) {
    return `Invalid tenantId "${tenantId}" (expected a GUID).`;
  }
  if (subscriptionId && !isUuid(subscriptionId)) {
    return `Invalid subscriptionId "${subscriptionId}" (expected a GUID).`;
  }
  return "";
}

export function azureLoginRequiredResponse({
  tenantId = "",
  activeTenantId = ""
}: AzureLoginInput = {}): {
  error: string;
  code: string;
  tenantId: string;
  remediation: RemediationView;
} {
  const error =
    activeTenantId ?
      `Active Azure session is tenant ${activeTenantId}, not ${tenantId}. Run "az login --use-device-code --tenant ${tenantId}" in your terminal, then click Verify Credentials again.`
    : 'No active Azure session. Run "az login --use-device-code" in your terminal, then click Verify Credentials again.';
  return {
    error,
    code: "az-login-required",
    tenantId,
    remediation: remediationView("azure-cli-login", { tenantId })
  };
}

export async function invokeSessionPrompt(
  handler: SessionPromptHandler | null,
  prompt: string | SessionPromptMessage
): Promise<{ status: number; error?: string }> {
  if (typeof handler !== "function") {
    return {
      status: 503,
      error: "Could not reach the Copilot session to start Azure CLI help."
    };
  }
  try {
    await handler(prompt);
    return { status: 200 };
  } catch {
    return {
      status: 502,
      error: "The Copilot session could not start Azure CLI help."
    };
  }
}

// The Azure CLI assist prompts now come from the shared remediation registry in
// core, so this route and /api/run-remediation cannot drift apart in wording,
// command shape, or tenant handling. The registry reproduces the original text
// exactly; `server.test.ts` pins that against the frozen legacy strings.
function azureCliAssistRemediation({
  action = "login",
  tenantId = ""
}: AzureCliAssistInput = {}): Remediation {
  const id = action === "install" ? "azure-cli-install" : "azure-cli-login";
  const requested = typeof tenantId === "string" ? tenantId.trim() : "";
  const result = buildRemediation(
    id,
    isUuid(requested) ? { tenantId: requested } : {}
  );
  // Unreachable: both Azure ids build unconditionally, and the tenant is only
  // passed once `isUuid` accepted it. Reaching here would mean the registry
  // stopped offering an id this route names, which no test can stage without
  // replacing the registry itself.
  /* v8 ignore next 3 */
  if (!result.ok) {
    throw new Error(`Azure CLI assist is unavailable: ${result.reason}`);
  }
  return result.remediation;
}

export function buildAzureCliAssistPrompt(
  input: AzureCliAssistInput = {}
): string {
  return remediationSessionMessage(azureCliAssistRemediation(input)).prompt;
}

// Timeline stand-in for buildAzureCliAssistPrompt. The canvas clicks Verify
// Credentials on the user's behalf, so the turn it injects should read as a
// status line, not as multi-paragraph instructions the user appears to have
// typed. The agent still receives the full prompt.
export function azureCliAssistDisplayPrompt(
  input: AzureCliAssistInput = {}
): string {
  return remediationSessionMessage(azureCliAssistRemediation(input))
    .displayPrompt;
}

// Pairs the agent-facing Azure CLI prompt with its timeline stand-in so the two
// cannot drift apart or be swapped at the call site.
export function azureCliAssistMessage(
  input: AzureCliAssistInput = {}
): SessionPromptMessage {
  return remediationSessionMessage(azureCliAssistRemediation(input));
}

// Fire the app.bicep handoff at most once per repo+branch(es) for a given
// instance. Fire-and-forget so it never blocks the HTTP response.
function triggerAppBicepHandoff(
  entry: { state: CanvasState } | undefined,
  repo: string,
  branches: string | string[],
  page: string
): void {
  try {
    if (typeof appBicepHandoff !== "function") return;
    if (!repo) return;
    const list = (Array.isArray(branches) ? branches : [branches]).filter(
      (branch): branch is string => Boolean(branch)
    );
    const state = entry?.state;
    const key = `${repo}::${list.join(",")}`;
    if (state) {
      if (state.appBicepHandoffKey === key) return; // already handed off
      state.appBicepHandoffKey = key;
    }
    Promise.resolve(appBicepHandoff({ repo, branches: list, page })).catch(
      () => {}
    );
  } catch {
    /* never let a handoff failure break the response */
  }
}

// Hand a failed deploy to the agent to repair and redeploy. Fires at most once
// per repair loop: once the agent owns the loop it redeploys and re-reads status
// itself, so re-handing off every failed attempt would double-drive it.
// `branch-not-pushed` is excluded: the user fixes that with a push, not by
// editing the model. Azure OIDC preflight failures are excluded for the same
// reason: their remedies live in cloud identity configuration, not app.bicep.
//
// Delivery is tracked explicitly (pending -> delivered | failed) because the
// browser stops polling once a deploy is terminal: a rejected send has no later
// poll to piggyback on, so the status route keeps the poll alive while delivery
// is pending or retryable and gives up after DEPLOY_HANDOFF_MAX_ATTEMPTS.
export interface DeployAttemptInput {
  repo: string;
  branch: string;
  provider: string;
  environment: string;
  appFile: string;
  // True only for a redeploy the agent makes from inside a repair loop it
  // already owns. Resolved from the attempt id by resolveDeployRepairLoop, not
  // taken from the client: an agent-initiated deploy is not by itself a repair.
  repairLoop: boolean;
  // The attempt this redeploy continues, so a loop keeps one identity across
  // its retries. Empty for any deploy that opens a new attempt.
  attemptId?: string;
}

// Marks a deploy that failed before anything could have started running: the
// branch it names is not on the remote, so GitHub refused the dispatch. The
// fix is a git push, not a model repair.
export const DEPLOY_BRANCH_NOT_PUSHED_KIND: DeployErrorKind =
  "branch-not-pushed";

// Marks a deploy that failed without proving that no workflow is running: the
// dispatch outcome was never confirmed, or monitoring stopped before the run
// reported one. Distinct from a confirmed failure — a workflow GitHub refused
// to start, or one that ran and reported its own failure — which is the only
// kind a repair redeploy may act on, because it is the only kind that cannot
// leave a run in flight for a redeploy to race.
export const DEPLOY_RUN_UNCONFIRMED_KIND: DeployErrorKind = "run-unconfirmed";

// Marks a deploy refused by the Azure OIDC preflight: the app registration the
// target environment names holds no federated credential GitHub's token could
// match, so the workflow could only fail its login. Nothing was dispatched, and
// the fix is in Azure and GitHub configuration rather than in the model, so this
// never opens a repair loop.
export const DEPLOY_OIDC_SUBJECT_MISSING_KIND: DeployErrorKind =
  "oidc-subject-missing";

// A federated credential exists, but Entra's case-sensitive subject comparison
// rejects it. This stays distinct from "missing" so the browser does not send
// the user through environment creation, which would preserve the bad casing.
export const DEPLOY_OIDC_SUBJECT_CASE_MISMATCH_KIND: DeployErrorKind =
  "oidc-subject-case-mismatch";

// Ceiling for the preflight's `az` call. The check is advisory — it can only
// block on a definitive answer — so a slow or hung `az` must not hold up a
// deploy that authenticates in Actions rather than locally.
const AZURE_PREFLIGHT_TIMEOUT_MS = 15000;

// Split a failed `gh workflow run` by whether it proves no run was created.
// GitHub naming the branch as unresolvable is proof: it rejected the request.
// Anything else is not — the request can be accepted and the answer lost (the
// CLI timing out, for one), and the token-scope retry can dispatch twice — so
// it has to be treated as a run that may exist.
export function classifyDeployDispatchFailure(stderr: string): DeployErrorKind {
  if (
    /no ref found|could not resolve|no commit found for the ref/i.test(
      stderr || ""
    )
  )
    return DEPLOY_BRANCH_NOT_PUSHED_KIND;
  return DEPLOY_RUN_UNCONFIRMED_KIND;
}

// Decide, server-side, whether an incoming deploy continues an existing repair
// loop, and whether that loop still has budget. The tool validates the attempt
// before it POSTs, but another deploy can start in between, so re-check here
// against the attempt this panel currently holds: a stale repair must not
// overwrite the newer deploy or mark it as already owned (which would suppress
// its own failure handoff). An unbound request is an ordinary deploy and always
// proceeds.
export function resolveDeployRepairLoop(
  state: CanvasState,
  requestedAttemptId: unknown
): {
  repairLoop: boolean;
  attemptId: string;
  repairAttempt: number;
  error?: string;
} {
  const requested =
    typeof requestedAttemptId === "string" ? requestedAttemptId : "";
  if (!requested) return { repairLoop: false, attemptId: "", repairAttempt: 0 };
  const current = state?.deployAttempt?.id || "";
  if (current !== requested) {
    return {
      repairLoop: false,
      attemptId: "",
      repairAttempt: 0,
      error: `Deploy attempt "${requested}" is no longer the current attempt for this canvas session, so nothing was deployed. A newer deploy has replaced it; ask the user which deploy to repair.`
    };
  }
  // A repair redeploy only makes sense against a deploy that actually failed.
  // The attempt stays current after it settles, and the agent was told to keep
  // passing its id, so without this an attempt-bound call could land on a
  // deploy that is still running (starting a second workflow run and a second
  // monitor over the same state) or on one that already succeeded (spending
  // repair budget on a finished loop, and — because a loop redeploy is marked
  // agent-owned — silently suppressing the handoff if it fails).
  const deployStatus = state?.deployStatus || "";
  if (deployStatus !== "failed") {
    return {
      repairLoop: false,
      attemptId: "",
      repairAttempt: 0,
      error:
        deployStatus === "in_progress" ?
          `Deploy attempt "${requested}" is still running, so nothing was deployed. Poll the radius_deploy_status tool until it reports success or failed before redeploying.`
        : `Deploy attempt "${requested}" is not in a failed state, so there is nothing to repair and nothing was deployed. Its repair loop is over. To deploy again, call radius_deploy without an attemptId to start a new deploy.`
    };
  }
  // "failed" covers two different things, and only one is safe to redeploy.
  // A confirmed failure — GitHub refused the dispatch, or the run finished and
  // reported failure — leaves nothing in flight. The rest do not: the dispatch
  // may have been accepted without us learning of it, or monitoring may have
  // stopped before the run reported, in which case a redeploy would race a
  // second run against the same target — exactly what the in_progress check
  // above prevents, arriving by a different route. Deciding this from stored
  // state keeps the resolver synchronous; re-querying the run would put an
  // await in front of beginDeployAttempt, which must not happen.
  if ((state?.deployErrorKind || "") === DEPLOY_RUN_UNCONFIRMED_KIND) {
    const runUrl = state?.deployRunUrl || "";
    return {
      repairLoop: false,
      attemptId: "",
      repairAttempt: 0,
      error: `Deploy attempt "${requested}" never confirmed what happened to its workflow, so a run may still be in flight and nothing was deployed. Redeploying now could start a second run against the same target.${runUrl ? ` Check the run at ${runUrl}` : " Check the repository's Actions tab"} and tell the user what it shows. To deploy again afterwards, call radius_deploy without an attemptId — this attempt cannot be repaired, because its outcome will never be confirmed.`
    };
  }
  // The cap the handoff prompt states is also enforced here, because prompt
  // text alone is an instruction the agent can lose track of across a long
  // repair loop. Refusing before anything is dispatched keeps a runaway loop
  // from burning CI runs.
  const repairAttempt = (state.deployRepairAttempts || 0) + 1;
  if (repairAttempt > DEPLOY_REPAIR_ATTEMPT_CAP) {
    return {
      repairLoop: false,
      attemptId: "",
      repairAttempt: 0,
      error: `This repair loop has already used its ${DEPLOY_REPAIR_ATTEMPT_CAP} automatic repair attempts, so nothing was deployed. Stop retrying: report the remaining failure and what you tried to the user, and let them decide whether to deploy again from the canvas.`
    };
  }
  return { repairLoop: true, attemptId: requested, repairAttempt };
}

// Open a new deploy attempt on a reused canvas state. Deliberately
// synchronous: the reset and the new attempt id must land together, because
// a previous attempt's handoff settling between them would still see itself
// as the current attempt and could mark the incoming deploy as repairing,
// suppressing its own repair handoff for good. Anything that needs awaiting
// (branch resolution) has to happen before this is called.
export function beginDeployAttempt(
  state: CanvasState,
  input: DeployAttemptInput
): void {
  state.deployStatus = "in_progress";
  state.deployError = null;
  state.deployErrorKind = null;
  state.deployErrorBranch = null;
  state.deployErrorPaths = null;
  state.deployRunUrl = null;
  state.deployRunId = null;
  // Concrete outputs belong to one deployment attempt. Keeping the previous
  // graph would relabel a later failed run with stale resource and portal data.
  state.deployedGraph = null;
  state.deployedGraphRepo = undefined;
  // Only a redeploy inside an existing repair loop is already owned by the
  // agent. Every other deploy — including the agent's first one, which opens no
  // loop — must stay eligible to hand its failure off; marking that one as
  // repairing made triggerDeployRepairHandoff bail out and silently dropped the
  // repair.
  state.deployRepairing = input.repairLoop;
  state.deployHandoffState = input.repairLoop ? "delivered" : "idle";
  // The delivery budget belongs to the loop, not to a single deploy: resetting
  // it on every redeploy would let an undeliverable handoff retry forever.
  state.deployHandoffAttempts =
    input.repairLoop ? state.deployHandoffAttempts || 0 : 0;
  // The informational failure notice has no repair loop to inherit a budget
  // from, so every new deploy attempt resets it unconditionally. Without this
  // reset a canvas panel — whose CanvasState is reused across deploys — would
  // keep a "delivered" (or exhausted "failed") notice for its whole life, and
  // every later run-unconfirmed failure would bail at the trigger's guard and
  // never reach chat.
  state.deployNoticeState = "idle";
  state.deployNoticeAttempts = 0;
  // Same lifetime as the delivery budget, and counted the way
  // resolveDeployRepairLoop projected it, so the number the agent is told
  // matches the one the next call is checked against. A deploy that opens a
  // new attempt starts a fresh loop with a full budget.
  state.deployRepairAttempts =
    input.repairLoop ? (state.deployRepairAttempts || 0) + 1 : 0;
  state.deployingBranch = input.branch;
  // Immutable identity for this attempt. A canvas panel is reused across
  // deploys, so the repair loop binds to this snapshot instead of the panel:
  // a stale repair cannot redeploy whatever the user started next. A redeploy
  // inside a loop keeps the id it was handed, so the agent can keep addressing
  // the same loop across retries instead of being told its attempt is inactive.
  state.deployAttempt = {
    id:
      (input.repairLoop && input.attemptId) ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    targetRepo: input.repo,
    environment: input.environment,
    branch: input.branch,
    provider: input.provider,
    appFile: input.appFile
  };
}

export const DEPLOY_HANDOFF_MAX_ATTEMPTS = 3;
// Backoff before re-sending a handoff whose delivery was rejected.
export const DEPLOY_HANDOFF_RETRY_DELAY_MS = 2000;

export function triggerDeployRepairHandoff(
  entry: { state: CanvasState } | undefined,
  instanceId = ""
): boolean {
  try {
    if (typeof deployRepairHandoff !== "function") return false;
    const state = entry?.state;
    if (!state || state.deployStatus !== "failed") return false;
    if (
      state.deployErrorKind === DEPLOY_BRANCH_NOT_PUSHED_KIND ||
      // Refused before dispatch because no federated credential can match the
      // token GitHub would mint. Repairing the model cannot change that.
      state.deployErrorKind === DEPLOY_OIDC_SUBJECT_MISSING_KIND ||
      state.deployErrorKind === DEPLOY_OIDC_SUBJECT_CASE_MISMATCH_KIND ||
      // An attempt whose run may still be in flight can never be repaired: the
      // resolver refuses its redeploy. Opening a loop only to refuse its first
      // call would spend a cycle and tell the agent two different things.
      state.deployErrorKind === DEPLOY_RUN_UNCONFIRMED_KIND
    )
      return false;
    if (state.deployRepairing) return false;
    if (
      state.deployHandoffState === "pending" ||
      state.deployHandoffState === "failed"
    )
      return false;
    const repo =
      state.deployingRepo || state.plannedRepo || state.contextRepo || "";
    const branch = state.deployingBranch || "";
    const error = state.deployError || "";
    const deployRunUrl = state.deployRunUrl || "";
    const attemptId = state.deployAttempt?.id || "";
    state.deployHandoffState = "pending";
    state.deployHandoffAttempts = (state.deployHandoffAttempts || 0) + 1;
    // A canvas panel is reused across deploys and these callbacks settle
    // asynchronously, so a user deploy started in the meantime would otherwise
    // be mutated by the previous attempt's handoff. Binding to the attempt that
    // opened this handoff keeps a stale settle from marking the new attempt as
    // delivered/owned, which would suppress its own handoff for good. Compare
    // both sides normalized so an attempt-less handoff still settles against an
    // attempt-less state - refusing to settle there would strand it as pending
    // and block every later trigger - while a new deploy's id still revokes it.
    const ownsAttempt = () => (state.deployAttempt?.id || "") === attemptId;
    const delivered = () => {
      if (!ownsAttempt()) return;
      state.deployHandoffState = "delivered";
      state.deployRepairing = true;
    };
    // A handoff that never reached the agent must not leave the loop marked as
    // owned; it becomes retryable until the attempt budget runs out.
    const failed = () => {
      if (!ownsAttempt()) return;
      state.deployRepairing = false;
      const exhausted =
        (state.deployHandoffAttempts || 0) >= DEPLOY_HANDOFF_MAX_ATTEMPTS;
      state.deployHandoffState = exhausted ? "failed" : "retryable";
      // Retry from the server too. /api/deploy-status also retries, but only
      // while the webview polls it, so a transient delivery failure would
      // otherwise strand the handoff as retryable with budget left over -
      // exactly the unmounted-panel case this trigger exists to cover.
      if (exhausted) return;
      const timer = setTimeout(() => {
        // The backoff is another window for a new deploy to start, and that
        // deploy drives its own handoff.
        if (!ownsAttempt()) return;
        triggerDeployRepairHandoff(entry, instanceId);
      }, DEPLOY_HANDOFF_RETRY_DELAY_MS);
      // Never hold the process open for a retry.
      timer.unref?.();
    };
    try {
      Promise.resolve(
        deployRepairHandoff({
          repo,
          branch,
          error,
          deployRunUrl,
          attemptId,
          instanceId
        })
      ).then(delivered, failed);
    } catch {
      failed();
      return false;
    }
    return true;
  } catch {
    /* never let a handoff failure break the response */
  }
  return false;
}

// What the webview needs to decide whether to keep polling after a failed deploy.
export function deployHandoffStatus(state: CanvasState): DeployHandoffSummary {
  const handoffState = state?.deployHandoffState || "idle";
  return {
    state: handoffState,
    attempts: state?.deployHandoffAttempts || 0,
    maxAttempts: DEPLOY_HANDOFF_MAX_ATTEMPTS,
    pending: handoffState === "pending" || handoffState === "retryable"
  };
}

// Relay a failed canvas deploy whose workflow run could not be confirmed
// (DEPLOY_RUN_UNCONFIRMED_KIND) to the agent as an informational report.
//
// Deliberately parallel to triggerDeployRepairHandoff but kept separate:
//   * it fires ONLY for the run-unconfirmed kind — the one the repair path
//     refuses, so a failure is handled by exactly one of the two triggers;
//   * it never sets deployRepairing and never opens a repair loop, because a run
//     may still be in flight and an automatic redeploy could race it;
//   * it tracks delivery on its own deployNotice* fields so it can never be
//     confused with, or suppress, a repair handoff.
// Branch-not-pushed is intentionally NOT relayed here: the canvas already shows a
// dedicated, actionable "push the branch" panel for it, so a chat report would be
// redundant noise.
export function triggerDeployFailureNotice(
  entry: { state: CanvasState } | undefined,
  instanceId = ""
): boolean {
  try {
    if (typeof deployFailureNotice !== "function") return false;
    const state = entry?.state;
    if (!state || state.deployStatus !== "failed") return false;
    if (state.deployErrorKind !== DEPLOY_RUN_UNCONFIRMED_KIND) return false;
    if (
      state.deployNoticeState === "pending" ||
      state.deployNoticeState === "delivered" ||
      state.deployNoticeState === "failed"
    )
      return false;
    const repo =
      state.deployingRepo || state.plannedRepo || state.contextRepo || "";
    const branch = state.deployingBranch || "";
    const error = state.deployError || "";
    const deployRunUrl = state.deployRunUrl || "";
    // Bind delivery to the attempt that opened this notice: a canvas panel is
    // reused across deploys and these callbacks settle asynchronously, so a new
    // deploy started in the meantime must revoke a stale settle rather than have
    // it mark the wrong attempt reported. Compare both sides normalized so an
    // attempt-less notice still settles against attempt-less state.
    const attemptId = state.deployAttempt?.id || "";
    state.deployNoticeState = "pending";
    state.deployNoticeAttempts = (state.deployNoticeAttempts || 0) + 1;
    const ownsAttempt = () => (state.deployAttempt?.id || "") === attemptId;
    const delivered = () => {
      if (!ownsAttempt()) return;
      state.deployNoticeState = "delivered";
    };
    const failed = () => {
      if (!ownsAttempt()) return;
      const exhausted =
        (state.deployNoticeAttempts || 0) >= DEPLOY_HANDOFF_MAX_ATTEMPTS;
      state.deployNoticeState = exhausted ? "failed" : "retryable";
      if (exhausted) return;
      const timer = setTimeout(() => {
        if (!ownsAttempt()) return;
        triggerDeployFailureNotice(entry, instanceId);
      }, DEPLOY_HANDOFF_RETRY_DELAY_MS);
      timer.unref?.();
    };
    try {
      Promise.resolve(
        deployFailureNotice({
          repo,
          branch,
          error,
          deployRunUrl,
          instanceId
        })
      ).then(delivered, failed);
    } catch {
      failed();
      return false;
    }
    return true;
  } catch {
    /* never let a notice failure break the response */
  }
  return false;
}

// Bare filename of the legacy monolithic deploy workflow that the composite-
// action model (run-rad-commands*.yml) replaces. Removed from target repos on
// commit so it does not double-trigger alongside the new dispatcher.
const LEGACY_DEPLOY_WORKFLOW_FILE = "radius-deploy.yml";

// The workflow that actually runs `rad` deploy commands. The deployments list
// only surfaces deployment records produced by this workflow — records created
// by other environment-bound workflows (verify-credentials, delete-application)
// are not real application deployments and are filtered out.
const DEPLOY_WORKFLOW_FILE = "run-rad-commands.yml";
const DELETE_WORKFLOW_FILE = "delete-application.yml";

// Name of the step inside the run-rad-commands composite action that executes
// the `rad` commands (and therefore `rad deploy`). The deploy monitor keys its
// in-flight handling — start time, per-resource status polling, the "still
// running" heartbeat — on finding a step with this exact name, so a mismatch
// silently disables all of it. It is exported so a test can pin it.
//
// Do not guess at this value: it must match
// radius-project/radius .github/extension/actions/run-rad-commands/action.yml.
export const DEPLOY_RAD_COMMANDS_STEP = "Run rad commands";

// ── POST /api/deploy composition root ────────────────────────────────────────
// One complete dependency object per deploy service, each narrowed to the seams
// that service actually uses. Every factory validates its own list at
// construction, so a missing seam fails while this module initialises rather
// than mid-deploy. Placed here because the workflow file names, the listing
// cache and the instance container above are all `const` and would otherwise be
// in the temporal dead zone at the family's composition site.

// The deploy's own gh runner: 30s timeout, resolves (never rejects) on a
// non-zero exit so the dispatch path can read stderr and choose its message.
function runGhForDeploy(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      args,
      { timeout: 30000, ...(options.env ? { env: options.env } : {}) },
      (err, stdout, stderr) => {
        resolve({
          code: err ? err.code || 1 : 0,
          stdout: stdout || "",
          stderr: stderr || ""
        });
      }
    );
  });
}

// Like runGhForDeploy but feeds a value (e.g. a secret JSON) over stdin so it
// never lands on the argv/process list.
function runGhWithStdinForDeploy(
  args: string[],
  stdin: string,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = cliExec(
      "gh",
      args,
      { timeout: 30000, ...(options.env ? { env: options.env } : {}) },
      (err, stdout, stderr) => {
        resolve({
          code: err ? err.code || 1 : 0,
          stdout: stdout || "",
          stderr: stderr || ""
        });
      }
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

const deployPlannedGraphService = createPlannedGraphRecoveryService({
  prepareSourceRefResources: (entry, view, context) =>
    prepareSourceRefResources(entry, view, context),
  setSourceRefResources: (entry, view, resources, context, expectedToken) =>
    setSourceRefResources(entry, view, resources, context, expectedToken),
  fetchBicepSelection: (entry, repo, branch) =>
    fetchBicepSelection(entry as CanvasServerEntry, repo, branch),
  radArtifactsDirForSelection: ({
    isLocal,
    state,
    repo,
    branch,
    bicepRepoPath,
    log
  }) =>
    radArtifactsDirForSelection({
      isLocal,
      state,
      github,
      repo,
      branch,
      bicepRepoPath,
      log
    }),
  buildGraphViaRad: (content, bicepPath, options) =>
    buildGraphViaRad(content, bicepPath, options),
  fetchRecipePack: (provider) => fetchRecipePack(github, provider),
  resolveRecipeOutputs: (parsed, recipes, provider) =>
    resolveRecipeOutputs(github, parsed, recipes, provider),
  canvasGraphResources,
  errorMessage
});

const deployDispatchService = createDeployDispatchService({
  deployWorkflowFile: DEPLOY_WORKFLOW_FILE,
  deployWorkflowFiles: [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE],
  branchNotPushedKind: DEPLOY_BRANCH_NOT_PUSHED_KIND,
  oidcSubjectMissingKind: DEPLOY_OIDC_SUBJECT_MISSING_KIND,
  oidcSubjectCaseMismatchKind: DEPLOY_OIDC_SUBJECT_CASE_MISMATCH_KIND,
  getBranchHeadSha,
  getDefaultBranch,
  runGh: runGhForDeploy,
  runGhWithStdin: runGhWithStdinForDeploy,
  runAz: async (args) => {
    // Short timeout on purpose: this runs before every Azure deploy, including
    // redeploys and repair attempts, and an unusable check is only ever a
    // warning. Waiting out the default 60s would add a minute of dead time to a
    // deploy that was always going to succeed.
    const result = await runCliCommand("az", args, AZURE_PREFLIGHT_TIMEOUT_MS);
    return {
      code: result.code ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  },
  runGitHubJson: (apiPath) => runGitHubJsonRequest(apiPath),
  readProcessEnv: () => process.env,
  fetchFileForSelection: (entry, repo, branch, repoPath) =>
    fetchFileForSelection(entry as CanvasServerEntry, repo, branch, repoPath),
  appParams,
  resolveDeployParams: (params) => resolveDeployParams(params),
  partitionParams,
  extractAppName,
  buildDeployRadCommand,
  buildAppGraphRadCommand,
  ensureDeployWorkflowsOnBranch,
  ensureWorkflowsCurrent,
  latestWorkflowRunId,
  classifyDeployDispatchFailure,
  uncommittedGeneratedPaths: (entry) =>
    uncommittedGeneratedPaths(
      (entry as CanvasServerEntry).state?.workspacePath
    ),
  invalidateDeployListCache: (repo) => {
    deployListCache.delete(repo);
  },
  errorMessage,
  now: () => Date.now()
});

const deployOutcomeService = createDeployOutcomeService({
  settleDeployStatuses,
  fetchRunLog,
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  extractRadDeployError: (logText) => extractRadDeployError(logText),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now()
});

const deployMonitorService = createDeployMonitorService({
  plannedGraph: deployPlannedGraphService,
  dispatch: deployDispatchService,
  outcome: deployOutcomeService,
  deployRadCommandsStep: DEPLOY_RAD_COMMANDS_STEP,
  unconfirmedRunKind: DEPLOY_RUN_UNCONFIRMED_KIND,
  findWorkflowRun: (repo, workflowFile, sinceMs, knownId, afterRunId) =>
    findWorkflowRun(
      repo,
      workflowFile,
      sinceMs,
      knownId,
      undefined,
      afterRunId
    ),
  getRunDetail,
  createStatusReader: (state, repo, branch, runId) =>
    deployStatusReaderFromState(state, repo, branch, runId),
  buildDeployStatusMap,
  buildDeployMessageMap,
  applyDeployMessages,
  applyDeployStatusToResources,
  generatePortalUrl,
  optionalString,
  errorMessage,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now()
});

const deployRequestService = createDeployRequestService({
  readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
  resolveDeployRepairLoop,
  resolveDeploymentEnvironment,
  activeDeploymentMutation: (state) => activeDeploymentMutation(state),
  localDeploymentBlocksMutation: (state) =>
    localDeploymentBlocksMutation(state),
  reserveDeploymentMutation: (state, reservation) =>
    reserveDeploymentMutation(state, reservation),
  releaseDeploymentMutation,
  deploymentStatusBlocksMutation,
  resolveEnvDeployment,
  runCommand: (command, args) => runCommand(command, args),
  canvasGraphResources,
  beginDeployAttempt,
  triggerDeployRepairHandoff: (entry, instanceId) =>
    triggerDeployRepairHandoff(entry, instanceId),
  triggerDeployFailureNotice: (entry, instanceId) =>
    triggerDeployFailureNotice(entry, instanceId),
  monitor: deployMonitorService,
  unconfirmedRunKind: DEPLOY_RUN_UNCONFIRMED_KIND,
  repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP,
  errorMessage
});

// gh runner that REJECTS on failure, so callers can fail closed instead of
// silently treating a GitHub outage or timeout as "no data". Used by the
// deployment-resolution paths where an empty result must not be mistaken for a
// definitive answer (e.g. "no app is deployed" → allow environment deletion).
function ghOrThrow(args: string[], timeout = 12000): Promise<string> {
  return new Promise((resolve, reject) => {
    cliExec("gh", args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || "").trim());
    });
  });
}

export async function deleteNewlyCreatedGitHubEnvironment(
  artifact:
    | { state?: string | null; repo?: string | null; name?: string | null }
    | null
    | undefined,
  runDelete: (args: string[]) => Promise<unknown> = (args) =>
    ghOrThrow(args, 20000)
): Promise<boolean> {
  if (!artifact || artifact.state !== "created") return false;
  const repo = optionalString(artifact.repo);
  const name = optionalString(artifact.name);
  if (!repo || !name) return false;
  await runDelete([
    "api",
    "--method",
    "DELETE",
    `/repos/${repo}/environments/${encodeURIComponent(name)}`
  ]);
  return true;
}

function buildRoleAssignmentDeleteArgs({
  objectId,
  role,
  scope
}: {
  objectId: string;
  role: string;
  scope: string;
}): string[] {
  return [
    "role",
    "assignment",
    "delete",
    "--assignee-object-id",
    objectId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    role,
    "--scope",
    scope,
    "--output",
    "none"
  ];
}

function buildFederatedCredentialDeleteArgs({
  appId,
  name
}: {
  appId: string;
  name: string;
}): string[] {
  return [
    "ad",
    "app",
    "federated-credential",
    "delete",
    "--id",
    appId,
    "--federated-credential-id",
    name
  ];
}

function buildServicePrincipalDeleteArgs({ id }: { id: string }): string[] {
  return ["ad", "sp", "delete", "--id", id];
}

function isAzureCleanupNotFound(
  artifactType: string,
  result: Partial<CommandResult> | null | undefined
): boolean {
  const detail = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  if (artifactType === "role_assignment") {
    return /No matched assignments were found to delete|No matching role assignments were found|The role assignment does not exist/i.test(
      detail
    );
  }
  return (
    isAzResourceNotFound(detail) ||
    /FederatedIdentityCredential.*not found|service principal.*not found|application.*not found|does not exist/i.test(
      detail
    )
  );
}

function cleanupTargetLabel(
  artifactType: string,
  artifact: Record<string, unknown>
): string {
  if (artifactType === "role_assignment") {
    return `${String(artifact.role || "")} @ ${String(artifact.scope || "")}`;
  }
  if (artifactType === "federated_credential") {
    return `${String(artifact.name || "")} @ ${String(artifact.subject || "")}`;
  }
  if (artifactType === "service_principal") {
    return String(artifact.appId || artifact.objectId || "");
  }
  return String(artifact.appId || "");
}

export async function ensureServicePrincipal(
  clientId: string,
  runAz: (args: string[]) => Promise<Partial<CommandResult>>
): Promise<
  | { ok: true; state: "created" | "reused"; objectId: string | null }
  | { ok: false; stderr: string }
> {
  const showArgs = [
    "ad",
    "sp",
    "show",
    "--id",
    clientId,
    "--query",
    "id",
    "-o",
    "tsv"
  ];
  const before = await runAz(showArgs);
  const existingObjectId = String(before.stdout || "").trim();
  if ((before.code === 0 || before.code === "0") && existingObjectId) {
    return { ok: true, state: "reused", objectId: existingObjectId };
  }
  if (before.code === 0 || before.code === "0") {
    return {
      ok: false,
      stderr: "The Service Principal lookup returned an empty object id."
    };
  }
  if (before.code !== 0 && !isAzResourceNotFound(before.stderr)) {
    return {
      ok: false,
      stderr:
        String(before.stderr || "").trim() ||
        "Failed to look up the Service Principal before creation."
    };
  }

  const create = await runAz(["ad", "sp", "create", "--id", clientId]);
  if (create.code === 0 || create.code === "0") {
    return { ok: true, state: "created", objectId: null };
  }

  const after = await runAz(showArgs);
  const racedObjectId = String(after.stdout || "").trim();
  if ((after.code === 0 || after.code === "0") && racedObjectId) {
    return { ok: true, state: "reused", objectId: racedObjectId };
  }

  return {
    ok: false,
    stderr:
      String(create.stderr || "").trim() ||
      String(after.stderr || "").trim() ||
      "Could not create or find the Service Principal."
  };
}

export async function cleanupAzureSetupArtifacts(
  op: any,
  {
    runAz,
    steps
  }: {
    runAz: (args: string[]) => Promise<Partial<CommandResult>>;
    steps?: string[];
  }
): Promise<{
  attempt: number;
  state: "not_needed" | "succeeded" | "succeeded_with_warnings";
  results: Array<{
    attempt: number;
    artifactType:
      | "role_assignment"
      | "federated_credential"
      | "service_principal"
      | "azure_app";
    target: string;
    outcome: "deleted" | "not_found" | "warning" | "skipped";
    detail: string | null;
  }>;
  warnings: string[];
}> {
  const ledger = getSetupArtifactLedger(op);
  const attempt = Number(ledger?.cleanup?.attempts || 0) + 1;
  const priorResults =
    Array.isArray(ledger?.cleanup?.results) ? ledger.cleanup.results : [];
  if (!ledger) {
    return { attempt, state: "not_needed", results: [], warnings: [] };
  }

  const deletions: Array<{
    artifactType:
      | "role_assignment"
      | "federated_credential"
      | "service_principal"
      | "azure_app";
    artifact: Record<string, unknown>;
    args?: string[];
    missingDetail?: string;
  }> = [];

  for (const roleAssignment of [...ledger.roleAssignments].reverse()) {
    const objectId = String(roleAssignment.principalObjectId || "").trim();
    deletions.push({
      artifactType: "role_assignment",
      artifact: roleAssignment as Record<string, unknown>,
      ...(objectId ?
        {
          args: buildRoleAssignmentDeleteArgs({
            objectId,
            role: String(roleAssignment.role || ""),
            scope: String(roleAssignment.scope || "")
          })
        }
      : {
          missingDetail:
            "Missing the Service Principal object id needed to target this role assignment precisely."
        })
    });
  }

  const cleanupAppId = String(
    ledger.azureApp.appId || ledger.servicePrincipal.appId || ""
  ).trim();
  for (const credential of [...ledger.federatedCredentials].reverse()) {
    deletions.push({
      artifactType: "federated_credential",
      artifact: credential as Record<string, unknown>,
      ...(cleanupAppId ?
        {
          args: buildFederatedCredentialDeleteArgs({
            appId: cleanupAppId,
            name: String(credential.name || "")
          })
        }
      : {
          missingDetail:
            "Missing the App Registration id needed to target this federated credential."
        })
    });
  }

  if (ledger.servicePrincipal.state === "created") {
    const spId = String(
      ledger.servicePrincipal.appId || ledger.servicePrincipal.objectId || ""
    ).trim();
    deletions.push({
      artifactType: "service_principal",
      artifact: ledger.servicePrincipal as Record<string, unknown>,
      ...(spId ?
        { args: buildServicePrincipalDeleteArgs({ id: spId }) }
      : {
          missingDetail:
            "Missing the Service Principal id needed to delete the created identity."
        })
    });
  }

  if (ledger.azureApp.state === "created") {
    const appId = String(ledger.azureApp.appId || "").trim();
    deletions.push({
      artifactType: "azure_app",
      artifact: ledger.azureApp as Record<string, unknown>,
      ...(appId ?
        { args: buildAppDeleteArgs({ appId }) }
      : {
          missingDetail:
            "Missing the App Registration id needed to delete the created application."
        })
    });
  }

  if (deletions.length === 0) {
    recordCleanupState(op, { attempts: attempt, state: "not_needed" });
    return { attempt, state: "not_needed", results: [], warnings: [] };
  }

  recordCleanupState(op, { attempts: attempt, state: "running" });
  steps?.push(
    "Cleaning up Azure artifacts created during this setup attempt..."
  );

  const warnings: string[] = [];
  const attemptResults: Array<{
    attempt: number;
    artifactType:
      | "role_assignment"
      | "federated_credential"
      | "service_principal"
      | "azure_app";
    target: string;
    outcome: "deleted" | "not_found" | "warning" | "skipped";
    detail: string | null;
  }> = [];
  const pushResult = (
    artifactType:
      | "role_assignment"
      | "federated_credential"
      | "service_principal"
      | "azure_app",
    artifact: Record<string, unknown>,
    outcome: "deleted" | "not_found" | "warning" | "skipped",
    detail: string | null
  ) => {
    attemptResults.push({
      attempt,
      artifactType,
      target: cleanupTargetLabel(artifactType, artifact),
      outcome,
      detail
    });
  };

  for (const deletion of deletions) {
    const label = cleanupTargetLabel(deletion.artifactType, deletion.artifact);
    if (deletion.missingDetail) {
      warnings.push(deletion.missingDetail);
      steps?.push(`⚠ ${deletion.missingDetail}`);
      pushResult(
        deletion.artifactType,
        deletion.artifact,
        "skipped",
        deletion.missingDetail
      );
      continue;
    }

    let result: Partial<CommandResult>;
    try {
      result = await runAz(deletion.args || []);
    } catch (error) {
      const detail =
        error instanceof Error ?
          error.message
        : String(error || "Unknown error");
      const warning = `Failed to delete ${label}: ${detail}`;
      warnings.push(warning);
      steps?.push(`⚠ ${warning}`);
      pushResult(deletion.artifactType, deletion.artifact, "warning", detail);
      continue;
    }

    if (result.code === 0 || result.code === "0") {
      steps?.push(`✅ Deleted ${label}`);
      pushResult(deletion.artifactType, deletion.artifact, "deleted", null);
      continue;
    }

    if (isAzureCleanupNotFound(deletion.artifactType, result)) {
      steps?.push(`✅ ${label} was already absent`);
      pushResult(deletion.artifactType, deletion.artifact, "not_found", null);
      continue;
    }

    const detail =
      String(result.stderr || "").trim() ||
      String(result.stdout || "").trim() ||
      "Unknown Azure CLI error.";
    const warning = `Failed to delete ${label}: ${detail}`;
    warnings.push(warning);
    steps?.push(`⚠ ${warning}`);
    pushResult(deletion.artifactType, deletion.artifact, "warning", detail);
  }

  const finalState = warnings.length ? "succeeded_with_warnings" : "succeeded";
  const results = [...priorResults, ...attemptResults];
  recordCleanupState(op, {
    state: finalState,
    attempts: attempt,
    results
  });
  return { attempt, state: finalState, results: attemptResults, warnings };
}

function hasReachedSetupCommitPoint(op: any): boolean {
  const ledger = getSetupArtifactLedger(op);
  if (!ledger) return false;
  return (
    ledger.commit.mode !== "not_started" ||
    ledger.commit.workflowFiles.length > 0
  );
}

function sanitizeFailureExtra(extra: Record<string, unknown> = {}) {
  const safe = { ...(extra || {}) };
  delete safe.azError;
  delete safe.ghError;
  return safe;
}

export async function finalizeSetupFailure(
  op: any,
  {
    status,
    error,
    code,
    stage,
    classification,
    evidence = null,
    extra = {},
    steps,
    runAz,
    runDeleteEnvironment
  }: {
    status: number;
    error: string;
    code: string;
    stage?: string | null;
    classification?: string;
    evidence?: string | null;
    extra?: Record<string, unknown>;
    steps?: string[];
    runAz?: ((args: string[]) => Promise<Partial<CommandResult>>) | null;
    runDeleteEnvironment?: ((args: string[]) => Promise<unknown>) | null;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const safeExtra = sanitizeFailureExtra(extra || {});
  const body: Record<string, unknown> = {
    error,
    ...(code ? { code } : {}),
    ...(op ? { operationId: op.operationId } : {}),
    ...safeExtra
  };
  const ledger = getSetupArtifactLedger(op);
  const commitPointReached = hasReachedSetupCommitPoint(op);
  let terminalState: "failed" | "failed_partial" = "failed";
  let cleanupSummary:
    | {
        attempt: number;
        rollbackAttempted: boolean;
        rollbackBeforeCommit: boolean;
        state: "not_needed" | "succeeded" | "succeeded_with_warnings";
        warnings: string[];
        results: Array<{
          attempt: number;
          artifactType:
            | "github_environment"
            | "role_assignment"
            | "federated_credential"
            | "service_principal"
            | "azure_app";
          target: string;
          outcome: "deleted" | "not_found" | "warning" | "skipped";
          detail: string | null;
        }>;
      }
    | undefined;

  if (ledger) {
    if (commitPointReached) {
      recordCleanupState(op, { state: "not_needed" });
      cleanupSummary = projectCleanupSummary(op);
      if (ledger.commit.workflowFiles.length > 0)
        terminalState = "failed_partial";
    } else {
      const attempt = Number(ledger.cleanup.attempts || 0) + 1;
      const warnings: string[] = [];
      let results: Array<{
        attempt: number;
        artifactType:
          | "github_environment"
          | "role_assignment"
          | "federated_credential"
          | "service_principal"
          | "azure_app";
        target: string;
        outcome: "deleted" | "not_found" | "warning" | "skipped";
        detail: string | null;
      }> = [];
      let cleanupState: "not_needed" | "succeeded" | "succeeded_with_warnings" =
        "not_needed";

      if (runAz) {
        const azureCleanup = await cleanupAzureSetupArtifacts(op, {
          runAz,
          steps
        });
        warnings.push(...azureCleanup.warnings);
        results = [
          ...results,
          ...(azureCleanup.results as Array<{
            attempt: number;
            artifactType:
              | "role_assignment"
              | "federated_credential"
              | "service_principal"
              | "azure_app";
            target: string;
            outcome: "deleted" | "not_found" | "warning" | "skipped";
            detail: string | null;
          }>)
        ];
        cleanupState = azureCleanup.state;
      } else {
        recordCleanupState(op, { attempts: attempt, state: "not_needed" });
      }

      const envRepo = optionalString(ledger.githubEnvironment.repo);
      const envName = optionalString(ledger.githubEnvironment.name);
      if (ledger.githubEnvironment.state === "created") {
        const target =
          envRepo && envName ?
            `${envRepo}:${envName}`
          : envName || envRepo || "GitHub environment";
        if (!runDeleteEnvironment) {
          const detail =
            "Missing the GitHub delete helper needed to remove the newly created environment.";
          warnings.push(detail);
          steps?.push(`⚠️ ${detail}`);
          results.push({
            attempt,
            artifactType: "github_environment",
            target,
            outcome: "warning",
            detail
          });
          cleanupState = "succeeded_with_warnings";
        } else {
          try {
            const deleted = await deleteNewlyCreatedGitHubEnvironment(
              ledger.githubEnvironment,
              runDeleteEnvironment
            );
            if (deleted) {
              steps?.push(`✅ Deleted GitHub environment "${envName}"`);
              results.push({
                attempt,
                artifactType: "github_environment",
                target,
                outcome: "deleted",
                detail: null
              });
              if (cleanupState === "not_needed") cleanupState = "succeeded";
            } else {
              const detail =
                "Missing the GitHub environment name or repository needed to target the newly created environment precisely.";
              warnings.push(detail);
              steps?.push(`⚠️ ${detail}`);
              results.push({
                attempt,
                artifactType: "github_environment",
                target,
                outcome: "warning",
                detail
              });
              cleanupState = "succeeded_with_warnings";
            }
          } catch (cleanupError) {
            const detail = errorMessage(cleanupError);
            const warning = `Failed to delete GitHub environment "${envName}": ${detail}`;
            warnings.push(warning);
            steps?.push(`⚠️ ${warning}`);
            results.push({
              attempt,
              artifactType: "github_environment",
              target,
              outcome: "warning",
              detail
            });
            cleanupState = "succeeded_with_warnings";
          }
        }
      } else if (ledger.githubEnvironment.state === "created_candidate") {
        const target =
          envRepo && envName ?
            `${envRepo}:${envName}`
          : envName || envRepo || "GitHub environment";
        const detail = `GitHub environment "${target}" was left in place because a pre-create 404 followed by GitHub's idempotent PUT cannot prove this request created it. Review it manually and delete it yourself if this setup should be rolled back.`;
        warnings.push(detail);
        steps?.push(`⚠️ ${detail}`);
        results.push({
          attempt,
          artifactType: "github_environment",
          target,
          outcome: "skipped",
          detail
        });
        cleanupState = "succeeded_with_warnings";
      }

      if (results.length > 0) {
        const priorResults =
          Array.isArray(ledger.cleanup.results) ?
            ledger.cleanup.results.filter(
              (entry: any) => entry.attempt < attempt
            )
          : [];
        if (warnings.length > 0) cleanupState = "succeeded_with_warnings";
        else if (cleanupState === "not_needed") cleanupState = "succeeded";
        recordCleanupState(op, {
          attempts: attempt,
          state: cleanupState,
          results: [...priorResults, ...results]
        });
      }

      cleanupSummary = projectCleanupSummary(op);
      if (warnings.length > 0 || ledger.commit.workflowFiles.length > 0) {
        terminalState = "failed_partial";
      }
    }
  }

  if (cleanupSummary) {
    body.cleanup = cleanupSummary;
    if (cleanupSummary.warnings.length > 0) {
      body.cleanupWarning = cleanupSummary.warnings[0];
    }
  }
  if (op) {
    finish(op, terminalState, {
      failure: {
        code: code || "setup-failed",
        stage: stage || op.currentStage,
        message: error,
        classification:
          classification ||
          (status === 403 ? "needs-someone-else" : "user-fixable"),
        evidence
      }
    });
  }
  return { status, body };
}

// Preflight the acting gh account's access to `repo` BEFORE any Azure/GitHub
// mutation (App Registration create, environment PUT). Uses ghApiJson, which
// routes through cliExec→ghChildEnv and therefore acts as the same active
// keyring account the later mutations use. Returns a clear, actionable error
// string when the account can't read the repo or lacks admin, else ''.
//
// Keying on ghApiJson's parsed HTTP status (not string-matched error text) makes
// the two failure modes unambiguous: a 404 means the account genuinely can't see
// the repo (readFailed), while any other non-ok result — a transient error, a
// non-JSON body, or an unparseable status — is treated as ambiguous and returns
// '' so the preflight never silently misdirects; the real op then surfaces the
// true error. GitHub still enforces permissions server-side regardless.
async function preflightRepoAdmin(
  repo: string,
  executor?: SelectedGhExecutor
): Promise<string> {
  let login = "";
  const runJson = (path: string) =>
    executor ? selectedGhApiJson(executor, path) : ghApiJson(path);
  const who = await runJson("user");
  if (who.ok) login = optionalString(record(who.json).login);
  let readFailed = false,
    permissions = null;
  const res = await runJson(`repos/${repo}`);
  if (res.ok) {
    const value = record(res.json).permissions;
    permissions = value && typeof value === "object" ? record(value) : null;
  } else if (res.status === 404) {
    readFailed = true;
  } else {
    return ""; // ambiguous/transient — don't block or mislead; let the real op surface the true error
  }
  return explainRepoAccessForEnvSetup({
    repo,
    login,
    readFailed,
    permissions
  });
}

type GhcrPackageCredentialLoader = typeof getGhPackageCredentials;
type GhcrPackageIdentityLoader = typeof getGitHubIdentity;
type GhcrPackageCredentials = Awaited<ReturnType<GhcrPackageCredentialLoader>>;
type GhcrPackageIdentity = Awaited<ReturnType<GhcrPackageIdentityLoader>>;
type GhcrPackagePreflightResult =
  | {
      ok: true;
      credentials: GhcrPackageCredentials;
      identity: GhcrPackageIdentity;
      login: string;
    }
  | {
      ok: false;
      status: 403;
      code: "ghcr-auth-failed" | "ghcr-scope-required";
      error: string;
    };

// Resolve the exact GitHub Packages credential GHCR writes will use, then check
// that very account for write:packages. The package credential is authoritative:
// on multi-account machines it can differ from a merely-active gh login, and the
// packages scope is read keyring-first to match getGhPackageCredentials.
export async function preflightGhcrPackageWriteAccess(
  loadCredentials: GhcrPackageCredentialLoader = getGhPackageCredentials,
  loadIdentity: GhcrPackageIdentityLoader = getGitHubIdentity,
  selectedExecutor?: SelectedGhExecutor
): Promise<GhcrPackagePreflightResult> {
  let packageCredentials: GhcrPackageCredentials;
  try {
    packageCredentials =
      selectedExecutor ?
        selectedExecutor.packageCredentials()
      : await loadCredentials();
  } catch (e) {
    return {
      ok: false,
      status: 403,
      code: "ghcr-auth-failed",
      error: `Could not authenticate to GitHub Packages for this repository. ${errorMessage(
        e
      )}`
    };
  }

  let ghPkgIdentity: GhcrPackageIdentity;
  try {
    ghPkgIdentity =
      selectedExecutor ?
        {
          actingLogin: selectedExecutor.login,
          displayLogin: selectedExecutor.login,
          mismatch: false,
          actingHasWorkflow: selectedExecutor.scopes.includes("workflow"),
          actingHasPackages: selectedExecutor.scopes.includes("write:packages"),
          reason: "selected-account-executor",
          accounts: [
            {
              login: selectedExecutor.login,
              hasWorkflow: selectedExecutor.scopes.includes("workflow"),
              hasPackages: selectedExecutor.scopes.includes("write:packages"),
              switchable: selectedExecutor.credentialSource === "keyring",
              acting: true
            }
          ]
        }
      : await loadIdentity();
  } catch (e) {
    return {
      ok: false,
      status: 403,
      code: "ghcr-auth-failed",
      error: `Could not authenticate to GitHub Packages for this repository. ${errorMessage(
        e
      )}`
    };
  }

  const ghPkgLogin = (packageCredentials.username || "").trim();
  if (!ghPkgLogin) {
    return {
      ok: false,
      status: 403,
      code: "ghcr-auth-failed",
      error:
        "Could not determine which GitHub account the GHCR package credentials belong to. Re-authenticate to GitHub Packages and retry."
    };
  }
  const ghPkgAccount =
    (ghPkgIdentity.accounts || []).find((a) => a.login === ghPkgLogin) || null;
  const ghPkgHasPackages =
    ghPkgAccount ? ghPkgAccount.hasPackages
    : ghPkgIdentity.actingLogin === ghPkgLogin ? ghPkgIdentity.actingHasPackages
    : false;
  if (!ghPkgHasPackages) {
    return {
      ok: false,
      status: 403,
      code: "ghcr-scope-required",
      error: `The account @${ghPkgLogin} needs the write:packages permission to proceed. In the terminal, run: gh auth switch --hostname github.com --user ${ghPkgLogin}. Then run: gh auth refresh --hostname github.com --scopes read:packages,write:packages. This will make @${ghPkgLogin} the active GitHub CLI account if it is not already active.`
    };
  }

  return {
    ok: true,
    credentials: packageCredentials,
    identity: ghPkgIdentity,
    login: ghPkgLogin
  };
}

// How many of an environment's newest deployment records to resolve
// concurrently before falling back to a serial walk. The relevant deploy/delete
// record is almost always in the newest handful.
const DEPLOY_MAX_PARALLEL_RECORDS = 10;

// Resolve the Radius application name for a repo the same way /api/list-applications
// does: read the name declared in `.radius/app.bicep` (or `app.bicep`) on `branch`,
// falling back to the repo's short name when it can't be read. A repo hosts a single
// Radius application in this model. Best-effort — a read failure falls back to the
// basename rather than throwing, since callers use the name only for display and for
// targeting the app's deploy/delete, not for the fail-closed deployment check itself.
async function resolveRepoAppName(
  repo: string,
  branch: string
): Promise<string> {
  let appName = repo.split("/").pop() || repo;
  const ref = branch || "main";
  for (const p of [".radius/app.bicep", "app.bicep"]) {
    let raw: string;
    try {
      raw = await ghOrThrow([
        "api",
        `/repos/${repo}/contents/${p}?ref=${ref}`,
        "--jq",
        ".content"
      ]);
    } catch {
      raw = "";
    }
    if (!raw) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      decoded = "";
    }
    const name = extractAppName(decoded);
    if (name) {
      appName = name;
      break;
    }
  }
  return appName;
}

// Derive the deployment status for a single deploy record from the linked
// workflow run's completion state, falling back to the deployment-status record
// when no run information is available.  Exported for unit tests.
//
// `rec` must carry: { runConclusion, runStatus, state }
// Returns one of: "success" | "failed" | "pending"
export function resolveDeployStatus(rec: DeployStatusRecord): string {
  if (rec.runConclusion === "success") return "success";
  if (rec.runConclusion) return "failed"; // completed, non-success (failure/cancelled/timed_out/…)
  if (rec.runStatus && rec.runStatus !== "completed") return "pending"; // genuinely still running
  // No linked run (or unknown run state): fall back to the deployment
  // record's own state so we still reflect a terminal outcome.
  if (rec.state === "success") return "success";
  if (rec.state === "failure" || rec.state === "error") return "failed";
  return "pending";
}

// Read the `default:` of the `environment` input under `on.workflow_dispatch.inputs`.
// Indentation-aware rather than a bare regex, because `environment:` also appears as a
// job-level key and matching the wrong one would silently mis-target a deploy. Kept as
// hand-rolled parsing to avoid pulling a YAML dependency into the adapter for one field.
// Resolve the CURRENT application deployment for a single environment, or null
// when no application is deployed (no deploy/delete record, or the latest delete
// succeeded). Scoped to the environment's OWN deployment history (the GitHub
// `environment=` filter) so a busy environment can never crowd another's latest
// record out of a shared, repo-wide page. Rejects on any GitHub error so callers
// fail closed rather than mistaking an outage for "nothing deployed".
//
// `appName` is the resolved Radius application name (see resolveRepoAppName); it
// must be passed in so the returned row targets the real app declared in
// app.bicep, not the repo basename — the environment-deletion guard dispatches a
// delete for this name and redirects to it, and the deployments list links to it.
// Returns `{ app, environment, provider, status, deploymentId, runUrl }`.
async function resolveEnvDeployment(
  repo: string,
  environment: string,
  appName: string
): Promise<DeploymentRow | null> {
  appName = appName || repo.split("/").pop() || repo;
  // Provider is cosmetic (drives portal links only), so a lookup failure here
  // must not block the whole resolution — soft-fail to an empty provider.
  let provider = "";
  try {
    const varsRaw = await ghOrThrow([
      "api",
      `/repos/${repo}/environments/${encodeURIComponent(
        environment
      )}/variables?per_page=100`,
      "--jq",
      ".variables[].name"
    ]);
    if (/AZURE_/.test(varsRaw)) provider = "azure";
    else if (/AWS_/.test(varsRaw)) provider = "aws";
  } catch {
    /* provider stays "" */
  }

  // Newest-first deployment records for THIS environment only.
  const idsRaw = await ghOrThrow([
    "api",
    `/repos/${repo}/deployments?per_page=100&environment=${encodeURIComponent(
      environment
    )}`,
    "--jq",
    ".[].id"
  ]);
  const ids = idsRaw ? idsRaw.split("\n").filter(Boolean) : [];

  const resolveRecord = async (id: string): Promise<DeploymentRecord> => {
    const stateRaw = await ghOrThrow([
      "api",
      `/repos/${repo}/deployments/${id}/statuses?per_page=1`,
      "--jq",
      '(.[0].state // "") + "\\t" + (.[0].log_url // .[0].target_url // "")'
    ]);
    const tab = stateRaw.indexOf("\t");
    const state = tab === -1 ? stateRaw : stateRaw.slice(0, tab);
    const logUrl = tab === -1 ? "" : stateRaw.slice(tab + 1);
    let runUrl = "";
    const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
    if (m) runUrl = `https://github.com/${repo}/actions/runs/${m[1]}`;
    else if (/^https?:\/\//.test(logUrl || "")) runUrl = logUrl;
    let runPath = "";
    let runStatus = "";
    let runConclusion = "";
    if (m) {
      const runInfo = await ghOrThrow([
        "api",
        `/repos/${repo}/actions/runs/${m[1]}`,
        "--jq",
        '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
      ]);
      const parts = runInfo.split("\t");
      runPath = parts[0] || "";
      runStatus = parts[1] || "";
      runConclusion = parts[2] || "";
    }
    const isDeploy = new RegExp(
      `(^|/)${DEPLOY_WORKFLOW_FILE.replace(/[.]/g, "\\$&")}$`
    ).test(runPath);
    const isDelete = new RegExp(
      `(^|/)${DELETE_WORKFLOW_FILE.replace(/[.]/g, "\\$&")}$`
    ).test(runPath);
    return { id, state, runUrl, isDeploy, isDelete, runStatus, runConclusion };
  };

  // Apply the selection rules to a resolved record:
  //   'skip'  → not relevant (verify-credentials, or a failed delete); keep walking
  //   null    → app deleted; environment has no active deployment
  //   object  → the deployment row for this environment
  const decide = (rec: DeploymentRecord): DeploymentRow | "skip" | null => {
    if (!rec.isDeploy && !rec.isDelete) return "skip";
    if (rec.isDelete && rec.runConclusion === "success") return null;
    if (rec.isDelete && rec.runConclusion && rec.runConclusion !== "success")
      return "skip";
    let status: string;
    if (rec.isDelete) {
      status = "deleting"; // delete still in progress
    } else {
      // Deploy status is derived from the WORKFLOW RUN's completion, not the
      // GitHub deployment-status record. A failed deploy often leaves that
      // record stuck at "pending"/"in_progress" (the workflow never posts a
      // terminal "failure" status), which previously mis-reported a failed
      // deploy as "pending" and wrongly kept the Deploy button greyed out.
      // Treat the run as authoritative: only a run that has NOT completed is
      // "pending"; a completed run is "success" or "failed" by its
      // conclusion, and a failed deploy does not block a redeploy.
      status = resolveDeployStatus(rec);
    }
    return {
      app: appName,
      environment,
      provider,
      status,
      deploymentId: rec.id,
      runUrl: rec.runUrl
    };
  };

  // Resolve the newest batch concurrently, then apply the rules newest-first.
  const batch = ids.slice(0, DEPLOY_MAX_PARALLEL_RECORDS);
  const resolved = await Promise.all(batch.map(resolveRecord));
  for (const rec of resolved) {
    const r = decide(rec);
    if (r === "skip") continue;
    return r;
  }
  // Rare fallback: nothing decisive in the newest batch — walk the rest serially.
  for (const id of ids.slice(DEPLOY_MAX_PARALLEL_RECORDS)) {
    const r = decide(await resolveRecord(id));
    if (r === "skip") continue;
    return r;
  }
  return null;
}

/**
 * Best-effort delete of the legacy `.github/workflows/radius-deploy.yml` from a
 * target repo. No-op when the file is absent. Self-contained (uses cliExec) so
 * it can be called from any request handler regardless of its local gh runner.
 */
async function deleteLegacyDeployWorkflow(
  targetRepo: string,
  executor?: SelectedGhExecutor
): Promise<boolean> {
  const path = ".github/workflows/" + LEGACY_DEPLOY_WORKFLOW_FILE;
  if (executor) {
    const lookup = await executor.run(
      ["api", "/repos/" + targetRepo + "/contents/" + path, "--jq", ".sha"],
      { timeout: 30000 }
    );
    const sha = lookup.code === 0 ? lookup.stdout.trim() : "";
    if (!sha) return false;
    await executor.run(
      [
        "api",
        "--method",
        "DELETE",
        "/repos/" + targetRepo + "/contents/" + path,
        "-f",
        "message=Remove legacy Radius deploy workflow (replaced by run-rad-commands.yml)",
        "-f",
        "sha=" + sha
      ],
      { timeout: 30000 }
    );
    return true;
  }
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", "/repos/" + targetRepo + "/contents/" + path, "--jq", ".sha"],
      { timeout: 30000 },
      (err, stdout) => {
        const sha = err ? "" : (stdout || "").trim();
        if (!sha) {
          resolve(false);
          return;
        }
        cliExec(
          "gh",
          [
            "api",
            "--method",
            "DELETE",
            "/repos/" + targetRepo + "/contents/" + path,
            "-f",
            "message=Remove legacy Radius deploy workflow (replaced by run-rad-commands.yml)",
            "-f",
            "sha=" + sha
          ],
          { timeout: 30000 },
          () => resolve(true)
        );
      }
    );
  });
}

// Ensure the deploy workflow files exist on `branch` so that dispatching
// `run-rad-commands.yml` with `--ref branch` resolves — both the dispatcher
// itself and the provider workflow it pulls in via a local-path `uses:`. The
// env-creation flow commits these to the repo's DEFAULT branch only (the GitHub
// contents API commit is branch-less), so a feature/worktree branch usually
// lacks them. Missing files are generated from the pinned upstream templates and
// committed onto `branch`; existing ones are left untouched. Best-effort per
// file — a commit failure is surfaced by the caller, not thrown here.
async function ensureDeployWorkflowsOnBranch(
  repo: string,
  branch: string,
  envName: string,
  log: (message: string) => void = () => {}
): Promise<void> {
  if (!repo || !branch) return;
  // Only the dispatcher + the Azure provider workflow are published to target
  // repos today (the AWS provider file is intentionally withheld, matching the
  // env-creation commit step), so those are the two a `--ref` dispatch needs.
  const wanted = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
  const existsOnBranch = (file: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      cliExec(
        "gh",
        [
          "api",
          `/repos/${repo}/contents/.github/workflows/${file}?ref=${encodeURIComponent(
            branch
          )}`,
          "--jq",
          ".sha"
        ],
        { timeout: 15000 },
        (err, stdout) => resolve(!err && !!(stdout || "").trim())
      );
    });
  const presence = await Promise.all(wanted.map(existsOnBranch));
  const missing = wanted.filter((_, i) => !presence[i]);
  if (missing.length === 0) return;
  log(
    'Publishing deploy workflow(s) to branch "' +
      branch +
      '": ' +
      missing.join(", ")
  );
  const generated = await generateDeployWorkflow(envName, ".radius/app.bicep");
  for (const file of missing) {
    const content = generated && generated[file];
    if (!content) continue;
    await commitFileToRepo(
      repo,
      ".github/workflows/" + file,
      content,
      branch,
      "Add Radius deploy workflow (" +
        file +
        ") to " +
        branch +
        " for worktree-consistent deploy"
    );
  }
}

export function getLastWebviewActivityAt(): number {
  return canvasServer.getLastActivityAt();
}

function accessForSelection(
  entry: { state: CanvasState },
  repo: string,
  branch: string
) {
  const state = entry?.state || {};
  const selectedBranch = branch || defaultBranchForState(state);
  const useWorkspace = isWorkspaceSelection(state, repo, selectedBranch);
  return {
    branch: selectedBranch,
    github:
      useWorkspace ?
        createWorkspaceGitHub(state, repo, selectedBranch)
      : github,
    useWorkspace
  };
}

// Unlike repoMatches() in workspace.ts, this helper always receives a
// non-empty repo string and performs strict equality only (no falsy-arg
// shortcut), so the workspace.ts version is not reused here.
function repoMatchesWorkspace(state: CanvasState, repo: string): boolean {
  const workspaceRepo = state?.workspaceRepo || "";
  return !!workspaceRepo && repo === workspaceRepo;
}

// Resolves the app.bicep for a selection and reports where it came from.
// `fromWorkspace` is true only when the local session workspace actually
// supplied the content (not when we fell back to the remote repo), and
// `bicepPath` is the repo-relative path of the local file so callers can save
// sibling artifacts next to the exact app.bicep that was graphed.
// Takes only the state-bearing shape of an instance entry, not the whole
// `CanvasServerEntry`, so the migrated `graphs-planning` write routes can inject
// it against their own narrow entry type without a cast.
async function fetchBicepSelection(
  entry: { state: CanvasState },
  repo: string,
  branch: string
): Promise<{
  content: string | null;
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
}> {
  const access = accessForSelection(entry, repo, branch);
  if (access.useWorkspace) {
    const local = await resolveWorkspaceBicep(entry.state, repo, access.branch);
    if (local)
      return {
        content: local.content,
        fromWorkspace: true,
        branch: access.branch,
        bicepPath: local.repoPath
      };
  }
  const remote = await fetchBicepFromRepo(github, repo, access.branch);
  return {
    content: remote,
    fromWorkspace: false,
    branch: access.branch,
    bicepPath: ""
  };
}

async function fetchFileForSelection(
  entry: CanvasServerEntry,
  repo: string,
  branch: string,
  repoPath: string
): Promise<string | null> {
  const access = accessForSelection(entry, repo, branch);
  if (access.useWorkspace) {
    const local = await fetchWorkspaceFile(
      entry.state,
      repo,
      access.branch,
      repoPath
    );
    if (local !== null) return local;
  }
  return await fetchFileFromRepo(repo, repoPath, access.branch);
}

// Every path on a branch, resolved through the same workspace-or-remote access
// rule as the Bicep selection so the answer describes the tree the graph would
// actually be built from. Resolves empty when the tree cannot be read, which
// callers must treat as "unknown" rather than "empty repository".
async function listBranchPaths(
  entry: CanvasServerEntry,
  repo: string,
  branch: string
): Promise<string[]> {
  const access = accessForSelection(entry, repo, branch);
  return await access.github.treePaths(repo, access.branch);
}

// Reject browser-labeled cross-site mutations while allowing non-browser clients.
export function isCrossSiteMutation(
  method: string | undefined,
  secFetchSite: string | string[] | undefined | null
): boolean {
  const m = String(method || "").toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  const site = String(
    Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite || ""
  )
    .trim()
    .toLowerCase();
  if (!site) return false; // non-browser client (no header) — allow.
  return site !== "same-origin" && site !== "none";
}

// Global pre-routing shared by typed routes and unmatched page requests. Reject
// cross-site mutations before any routing or body parse, then synchronise the
// requested page onto the instance entry.
function preRouteCanvasRequest(context: CanvasRequestContext): boolean {
  const { request } = context;
  if (isCrossSiteMutation(request.method, request.headers["sec-fetch-site"])) {
    context.json(403, {
      error: "Cross-site request rejected.",
      code: "cross-site-forbidden"
    });
    return true;
  }
  syncRequestedPage(
    canvasServer.instances.get(context.instanceId),
    context.url.searchParams.get("page")
  );
  return false;
}

function createInstanceRequestCoordinator(
  instanceId: string,
  resolveBaseUrl: () => string
) {
  const serverOwnedTasks = new Map<string, Promise<void>>();
  const serverOwnedToken = randomUUID();
  const browserMutationNonce = randomUUID();

  function scheduleServerOwnedTask(
    operationId: string,
    task: () => Promise<void>
  ): void {
    let instanceTasks = activeEnvironmentTasks.get(instanceId);
    if (!instanceTasks) {
      instanceTasks = new Set();
      activeEnvironmentTasks.set(instanceId, instanceTasks);
    }
    instanceTasks.add(operationId);
    const op = operations.get(operationId);
    if (op) setExecutionActive(op, true);
    const prior = serverOwnedTasks.get(operationId);
    const running = (prior || Promise.resolve())
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(() => resolve());
          })
      )
      .then(task)
      .catch(async (error) => {
        const current = operations.get(operationId);
        if (shuttingDownInstances.has(instanceId)) return;
        if (current && !current.endedAt) {
          finish(current, "failed", {
            failure: {
              code: "server-owned-task-failed",
              stage: current.currentStage,
              stepSeq: null,
              message: errorMessage(error),
              classification: "unknown",
              evidence: error instanceof Error ? error.stack || null : null
            }
          });
          await operations.persist().catch(() => {});
        }
      })
      .finally(() => {
        if (serverOwnedTasks.get(operationId) !== running) return;
        const current = operations.get(operationId);
        if (current && !current.endedAt) setExecutionActive(current, false);
        serverOwnedTasks.delete(operationId);
        const activeForInstance = activeEnvironmentTasks.get(instanceId);
        activeForInstance?.delete(operationId);
        if (activeForInstance?.size === 0) {
          activeEnvironmentTasks.delete(instanceId);
          for (const listener of environmentTasksSettledListeners.get(
            instanceId
          ) || []) {
            try {
              listener();
            } catch {
              // One shutdown consumer must not block the others.
            }
          }
        }
      });
    serverOwnedTasks.set(operationId, running);
  }

  async function postInternal(pathname: string, data: unknown): Promise<any> {
    const response = await fetch(`${resolveBaseUrl()}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": serverOwnedToken
      },
      body: JSON.stringify(data)
    });
    const result: any = await response.json();
    if (!response.ok && !result?.inputRequired) {
      throw new Error(
        result?.error || `Request failed with HTTP ${response.status}.`
      );
    }
    return result;
  }

  async function monitorVerification(operationId: string): Promise<void> {
    const deadline = Date.now() + 45 * 60 * 1000;
    let delayMs = 5000;
    while (Date.now() < deadline) {
      const op = operations.get(operationId);
      if (!op || op.endedAt || op.currentStage !== STAGE_VERIFY) return;
      const params = new URLSearchParams({
        repo: op.repo,
        environment: op.environment,
        operationId
      });
      const response = await fetch(
        `${resolveBaseUrl()}/api/verify-status?${params.toString()}`,
        { headers: { "X-Radius-Server-Owned": serverOwnedToken } }
      );
      const result: any = await response.json();
      if (!response.ok) {
        throw new Error(
          result?.error ||
            `Verification status failed with HTTP ${response.status}.`
        );
      }
      if (result?.state === "success" || result?.state === "failed") return;
      if (result?.terminal || result?.state === "expired") {
        const current = operations
          .all()
          .find((candidate: any) => candidate.operationId === operationId);
        if (current && !current.endedAt) {
          finish(current, "failed_partial", {
            failure: {
              code: "verification-tracking-expired",
              stage: current.currentStage,
              stepSeq: null,
              message:
                result?.error ||
                "Credential verification is no longer being tracked.",
              classification: "user-fixable",
              evidence: null
            }
          });
          await persistBestEffort({
            operation: current,
            persist: () => operations.persist(),
            report: (diagnostic) => operations.report?.(diagnostic)
          });
        }
        return;
      }
      const jitterMs = Math.floor(Math.random() * 1000);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delayMs, 15_000) + jitterMs)
      );
      delayMs = Math.min(Math.ceil(delayMs * 1.5), 15_000);
    }
    throw new Error(
      "Credential verification did not complete within 45 minutes."
    );
  }

  async function monitorVerificationAsSelectedAccount(
    operationId: string,
    login: string
  ): Promise<void> {
    const executor =
      await githubAccountCoordinator.createReadOnlyExecutor(login);
    selectedGitHubExecutorsByOperation.set(operationId, executor);
    try {
      await monitorVerification(operationId);
    } finally {
      selectedGitHubExecutorsByOperation.delete(operationId);
    }
  }

  async function runEnvironmentOperation(operationId: string): Promise<void> {
    if (environmentOperationTestRunner) {
      await environmentOperationTestRunner(operationId);
      return;
    }
    const op = operations.get(operationId);
    if (!op) return;
    const request = op.request || op.resumeRequest || {};
    const selectedLogin =
      typeof op.context?.githubLogin === "string" ? op.context.githubLogin
      : typeof request.github?.login === "string" ? request.github.login
      : "";
    if (!selectedLogin) {
      throw new Error(
        "The environment operation does not have a pinned GitHub account."
      );
    }
    let executorRegistered = false;
    try {
      const setup = await githubAccountCoordinator.withSelectedAccount(
        selectedLogin,
        { instanceId, operationId },
        async (executor) => {
          selectedGitHubExecutorsByOperation.set(operationId, executor);
          executorRegistered = true;
          return runEnvironmentOperationWorkflow(op, executor, {
            preflightRepoAdmin: (repo, selectedExecutor) =>
              preflightRepoAdmin(repo, selectedExecutor),
            preflightGhcrPackageWriteAccess: (selectedExecutor) =>
              preflightGhcrPackageWriteAccess(
                getGhPackageCredentials,
                getGitHubIdentity,
                selectedExecutor
              ),
            readGitHubJson: (apiPath, selectedExecutor) =>
              runGitHubJsonRequest(apiPath, selectedExecutor),
            setCanonicalEnvironment: (operation, environment) => {
              setCanonicalEnvironment(operation, environment);
            },
            recordGitHubEnvironment: (operation, patch) => {
              recordGitHubEnvironment(operation, patch);
            },
            addLegacyStep: (operation, text) => {
              addLegacyStep(operation, text);
            },
            persistEnvironmentResolution: (operation) =>
              persistMutationCheckpoint({
                operation,
                persist: () => operations.persist(),
                report: (diagnostic) => operations.report?.(diagnostic),
                fail: async (status, error, code) => {
                  await finalizeSetupFailure(operation, {
                    status,
                    error,
                    code,
                    stage: operation.currentStage,
                    classification: "unknown",
                    runDeleteEnvironment: async (args) => {
                      const result = await executor.run(args);
                      if (result.code !== 0 && result.code !== "0") {
                        throw new Error(
                          (result.stderr || result.stdout || "").trim() ||
                            "GitHub API request failed."
                        );
                      }
                    }
                  });
                }
              }),
            finalizeEnvironmentResolutionFailure: async (
              operation,
              input,
              selectedExecutor
            ) => {
              await finalizeSetupFailure(operation, {
                ...input,
                stage: operation.currentStage,
                classification:
                  input.code === "repo-admin-required" ?
                    "needs-someone-else"
                  : "unknown",
                runDeleteEnvironment: async (args) => {
                  const result = await selectedExecutor.run(args);
                  if (result.code !== 0 && result.code !== "0") {
                    throw new Error(
                      (result.stderr || result.stdout || "").trim() ||
                        "GitHub API request failed."
                    );
                  }
                }
              });
            },
            getOperation: (id) => operations.get(id),
            postInternal
          });
        },
        30000
      );
      setContext(op, {
        githubLogin: setup.selectedLogin,
        githubCredentialSource: setup.credentialSource,
        githubAccountSwitched: setup.switched,
        githubAccountRestoration: setup.restoration
      });
      if (
        setup.restoration.state === "failed" ||
        setup.restoration.state === "changed_externally"
      ) {
        addLegacyStep(
          op,
          `⚠️ GitHub CLI account restoration needs attention. ${
            setup.restoration.guidance || ""
          }`.trim()
        );
      }
      await persistBestEffort({
        operation: op,
        persist: () => operations.persist(),
        report: (diagnostic) => operations.report?.(diagnostic)
      });
      if (!setup.value.shouldMonitor) return;
      await monitorVerification(operationId);
    } finally {
      if (executorRegistered) {
        selectedGitHubExecutorsByOperation.delete(operationId);
      }
    }
  }

  function startRecoveredVerificationTasks(): void {
    for (const op of operations.all()) {
      if (
        op.recoveryState !== "verification_pending" ||
        op.currentStage !== STAGE_VERIFY ||
        op.endedAt ||
        activeVerificationMonitors.has(op.operationId)
      )
        continue;
      activeVerificationMonitors.add(op.operationId);
      scheduleServerOwnedTask(op.operationId, async () => {
        try {
          const selectedLogin =
            typeof op.context?.githubLogin === "string" ?
              op.context.githubLogin
            : "";
          if (selectedLogin) {
            await monitorVerificationAsSelectedAccount(
              op.operationId,
              selectedLogin
            );
          } else {
            await monitorVerification(op.operationId);
          }
        } finally {
          activeVerificationMonitors.delete(op.operationId);
        }
      });
    }
  }

  const handleUnmatchedRequest = async (
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> => {
    const url = new URL(req.url || "/", `http://localhost`);
    // Cross-site rejection and requested-page synchronisation now run in the
    // shared pre-routing step so typed routes cannot bypass them; the page
    // handler below still needs the raw value. Webview-activity marking also
    // moved to that seam, where it is gated on isServerOwned so server-owned
    // internal calls still do not count as user activity.
    const requestedPage = url.searchParams.get("page");

    // Default: serve the page HTML based on state
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const entry = servers.get(instanceId);
    let page = requestedPage || entry?.page || DEFAULT_CANVAS_PAGE;
    const state = entry?.state || {};
    // While a deployment is actively in progress, an IMPLICIT landing on the
    // environment / credentials page (a bare "/" load with no ?page=, e.g. a
    // panel re-open or a heartbeat reload that lost the query) is redirected
    // to the live deploying page so the user lands on the in-flight run. An
    // EXPLICIT navigation — a top-nav "Environments" click or any URL that
    // carries ?page= — is always honored, so the user can freely leave the
    // deploying view while a deploy is still being monitored.
    if (
      !requestedPage &&
      (page === "environment" || page === "credentials") &&
      state.deployStatus === "in_progress"
    ) {
      page = "deploying";
    }
    const renderer = isCanvasPage(page) ? PAGE_RENDERERS[page] : undefined;
    // Tell the Environments renderer which subtab to activate (Environments vs
    // Credentials) so a direct ?page=credentials load lands on that subtab.
    if (page === "credentials" || page === "environment") {
      state.activeSubtab =
        page === "credentials" ? "credentials" : "environments";
    }
    if (renderer) {
      res.writeHead(200);
      res.end(renderer(state));
    } else {
      res.writeHead(200);
      res.end(environmentPage(state));
    }
  };
  // Exposed so the composition root can gate webview-activity marking: the
  // scaffold marks activity for every request, but server-owned internal calls
  // must not count as user activity or the idle-respawn timer never fires.
  const isServerOwned = (req: IncomingMessage): boolean =>
    req.headers["x-radius-server-owned"] === serverOwnedToken;
  const validateBrowserMutation = (req: IncomingMessage): boolean => {
    return validateBrowserMutationRequest({
      request: req,
      baseUrl: resolveBaseUrl(),
      nonce: browserMutationNonce
    });
  };
  // Exposed so the migrated `POST /api/operations` route, which is composed once
  // at module init, can reach this instance's server-owned task runner. The
  // route registers and persists the operation itself and then hands the record
  // back here to preserve the established scheduling order.
  const scheduleEnvironmentOperation = (op: { operationId: string }): void => {
    scheduleServerOwnedTask(op.operationId, () =>
      runEnvironmentOperation(op.operationId)
    );
  };
  return {
    browserMutationNonce,
    handleUnmatchedRequest,
    startRecoveredVerificationTasks,
    isServerOwned,
    validateBrowserMutation,
    scheduleEnvironmentOperation
  };
}

const PAGE_RENDERERS = {
  credentials: environmentPage,
  graph: graphPage,
  planned: plannedGraphPage,
  "graph-diff": graphDiffPage,
  deployed: deployedGraphPage,
  environment: environmentPage,
  deploying: deployingPage
};

function isCanvasPage(page: string): page is keyof typeof PAGE_RENDERERS {
  return Object.hasOwn(PAGE_RENDERERS, page);
}

async function preferredPortForInstance(instanceId: string): Promise<number> {
  // Namespace the deterministic port by the Copilot session. Every session is
  // told to open the canvas with the same instanceId ("radius-panel"), so
  // hashing instanceId alone makes all concurrent sessions resolve to one
  // global port. Only the first session to bind it wins; the rest fall back to
  // an ephemeral port (listen(0)) while their webviews keep pinging the shared
  // port — which is now owned by a different, independently-churning process.
  // From those webviews' perspective the server appears to flap down/up as the
  // owning process is reaped/respawned, and the client heartbeat reloads the
  // page on every recovery — the "page keeps reloading" symptom. Mixing the
  // session id into the hash gives each session its own stable port. It stays
  // stable across respawns within the same session, so the heartbeat's
  // reconnect-and-reload still restores a live page after a genuine restart.
  const sessionId = await resolveSessionId();
  const hash = createHash("sha256")
    .update(sessionId + "\u0000" + String(instanceId))
    .digest();
  // Map into a high, mostly-unprivileged range (20000–60000) to reduce the
  // chance of clashing with other listeners.
  return 20000 + (hash.readUInt32BE(0) % 40000);
}

export async function getOrCreateServer(
  instanceId: string,
  page?: string
): Promise<CanvasServerEntry> {
  return await canvasServer.getOrCreate(instanceId, page);
}

export async function stopServer(
  instanceId: string,
  force = false
): Promise<void> {
  await canvasServer.stop(instanceId, force);
}
