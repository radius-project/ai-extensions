import { workflowTempFile } from "@radius-project/adapter-shared";
import { ensureAzureServicePrincipal } from "@radius-project/core";
import { createAzureRecoveryPort } from "./server/services/azure-setup-recovery.js";
import { canvasGraphResources } from "./canvas-graph-resources.js";
import { fetchSelectedBicep } from "./selected-bicep-source.js";
import { createProductionDeploymentMonitor } from "./runtime/production-deployment-monitor.js";
import { deliverDeploymentNotice } from "./runtime/deployment-notice-delivery.js";
import {
  DEPLOYMENT_MUTATION_LEASE_MS,
  beginDeployAttempt,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation,
  resolveDeploymentEnvironment
} from "./runtime/deployment-attempt.js";
export {
  DEPLOYMENT_MUTATION_LEASE_MS,
  beginDeployAttempt,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation,
  resolveDeploymentEnvironment,
  type DeployAttemptInput
} from "./runtime/deployment-attempt.js";
// Canvas adapter — HTTP server host for the webview.
//
// Owns the local loopback server that backs each canvas instance: the declared
// route handler (parse request -> call an @radius-project/core use-case or adapter
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
  resolveDeploymentRepairLoop,
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  deployStatusKeys,
  fetchRecipePack,
  isKubernetesNamespace,
  mergeDeployedGraphDisplayMetadata,
  mergeDeployedGraphMetadata,
  monitorSetupVerification,
  projectDeployedGraph,
  resolveRecipeOutputs,
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  remediationSessionMessage,
  remediationView,
  stateRegistryForEnvironment
} from "@radius-project/core";
import { WORKFLOW_READ_LIMITS } from "@radius-project/core";
import type { Remediation, RemediationView } from "@radius-project/core";
import {
  buildGraphViaRad,
  createWorkflowReadSession,
  type WorkflowReadRequest
} from "@radius-project/adapter-shared";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  presentedRemediationView,
  presentRemediation
} from "./gh-command-display.js";
import { resolveGhCommandPresentation } from "./gh-command-resolution.js";
import {
  describeMissingGitHubAppAccess,
  GITHUB_APP_ACCESS_PROBES,
  isGitHubAppBotLogin
} from "./github-app-installation.js";
import {
  sharedCredentials,
  cloudCredential,
  listCredentialProfiles,
  saveCredentialProfile,
  deleteCredentialProfile,
  recordGraphBuildEvent
} from "./shared.js";
import type {
  CanvasState,
  DeployErrorKind,
  GraphBuildEvent,
  GraphProgressView,
  GraphView
} from "./shared.js";

const GH_COMMAND_PRESENTATION = resolveGhCommandPresentation();
import {
  fetchFileFromRepo,
  fetchFileFromRepoResult,
  github,
  cliExec,
  runCommand,
  getDefaultBranch,
  getBranchHeadSha,
  createBranchRef,
  createPullRequestApi,
  ghApiJson,
  getGitHubIdentity,
  getGhPackageCredentials,
  resetGhIdentityCache,
  createSelectedGhExecutor,
  selectedGhApiJson,
  selectedGetDefaultBranch,
  selectedGetBranchHeadSha,
  selectedCreateBranchRef,
  selectedCreatePullRequest,
  selectedFetchFileFromRepo,
  selectedFetchFileFromRepoResult,
  redactGhCredentials
} from "./gh.js";
import type {
  CliOptions,
  GitHubIdentityAccount,
  SelectedGhExecutor
} from "./gh.js";
import {
  buildAppDeleteArgs,
  buildFederatedCredentialDeleteArgs,
  isAzResourceNotFound,
  parseServedReposFromSubjects,
  isUuid,
  isValidRepoSlug,
  isAksClusterName,
  isResourceGroupName,
  GITHUB_API_VERSION
} from "./azure-oidc.js";
import type { GitHubJsonResponse } from "./azure-oidc.js";
import { bootstrapGHCRStatePackage, deleteGHCRStatePackage } from "./ghcr.js";
import { resolveGeneratorVersion } from "./generator-version.js";
import {
  classifyProvider,
  parseGitHubEnvironmentVariables
} from "./provider-classification.js";
import { appParams, extractAppName } from "./bicep.js";
import {
  commitWorkspaceBranchResolution,
  createWorkspaceGitHub,
  currentWorkspaceBranch,
  defaultBranchForState,
  resolveWorkspaceBicep,
  isWorkspaceSelection,
  resolveGraphBranchForRequest,
  modelingRunLastActivityAtMs,
  resolveSessionId,
  toSafeRepoRelPath,
  workspaceGraphJsonPath,
  workspaceSourceRevision
} from "./workspace.js";
import { readSelectedSourceRevision } from "./app-model-authoring-failure.js";
import {
  DEFAULT_CANVAS_PAGE,
  DEPLOY_REPAIR_ATTEMPT_CAP
} from "./runtime/hooks.js";
import { observeWorkspaceModelingRun } from "./runtime/modeling-activity.js";
import {
  deliverDeploymentRepair,
  type DeploymentRepairHandoffInput as DeployRepairHandoffInput
} from "./runtime/deployment-repair-delivery.js";
export type { DeploymentRepairHandoffInput as DeployRepairHandoffInput } from "./runtime/deployment-repair-delivery.js";
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
  buildDeleteStages,
  OPERATION_KIND_DELETE,
  matchDeleteOperationEnvironment,
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
  recordGitHubEnvironmentVariable,
  promoteCreatedGitHubEnvironment,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordCleanupState,
  recordCleanupDeletion,
  cleanupArtifactIdentity,
  cleanupTargetKey,
  formatGitHubEnvironmentLabel,
  hasReachedSetupCommitPoint,
  projectCleanupSummary,
  finish,
  finishSucceeded,
  canDismissOperation,
  dismissOperation,
  canResumeInput,
  requireInput,
  resumeAfterInput,
  getAzureAppCreateContinuation,
  setAzureAppCreateContinuation,
  announceOperationTerminal,
  shouldStop,
  stopAtBoundary,
  setCommandState,
  providerMutationId,
  providerMutationRecord,
  provenOwnedCleanupTargets,
  providerRecoveryManualGuidance,
  settleProviderMutation,
  unresolvedProviderMutations,
  githubEnvironmentVariableRollbackTargets,
  workflowRollbackCommitState,
  workflowRollbackTargets,
  INPUT_REQUIRED_STATE,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_CONFIGURE_ENVIRONMENT,
  STAGE_VERIFY
} from "./operations.js";
import type {
  SetupCleanupArtifactType,
  SetupCleanupOutcome,
  SetupCleanupResult
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
  syncRepoWorkflows,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  LEGACY_DEPLOY_WORKFLOW_FILE
} from "./infra.js";
import type { WorkflowCommitFailure, WorkflowSyncPorts } from "./infra.js";
import type { SelectedRepositoryReader } from "./selected-repository-reader.js";
import {
  findWorkflowRun,
  getRunDetail,
  fetchRunLog,
  extractErrorLines,
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  explainNoSubscriptions,
  explainRepoAccessForEnvSetup,
  isGitHubRateLimitError,
  isSelectedGhAuthorizationError,
  selectedCommandAuthorizationError
} from "./deploy.js";
import {
  applyDeployMessages,
  buildDeployMessageMap,
  buildDeployStatusMap,
  createDeployStatusReader,
  downloadWorkflowArtifact,
  listWorkflowArtifacts,
  settleDeployStatuses
} from "./deploy-artifacts.js";
import { graphPage } from "./pages/graph-page.js";
import { plannedGraphPage } from "./pages/planned-graph-page.js";
import { graphDiffPage } from "./pages/graph-diff-page.js";
import { deployedGraphPage } from "./pages/deployed-graph-page.js";
import { environmentPage } from "./pages/environment-page.js";
import { deployingPage } from "./pages/deploying-page.js";
import { createCanvasServer } from "./server/create-canvas-server.js";
import { createWorkflowObservationScope } from "./server/services/workflow-observation-scope.js";
import { createRequestHandler as createScaffoldRequestHandler } from "./server/create-request-handler.js";
import {
  syncRequestedPage,
  type CanvasRequestContext
} from "./server/request-context.js";
import { createProductionCanvasServerDependencies } from "./server/dependencies.js";
import { createServerRouteTable } from "./server/route-table.js";
import { createLivenessSourceRoutes } from "./server/routes/liveness-source.js";
import { createDeploymentsRoutes } from "./server/routes/deployments.js";
import { probeDeleteConflict } from "./server/services/delete-conflict.js";
import {
  createOperationsStatusRoutes,
  type OperationActionDependencies
} from "./server/routes/operations-status.js";
import { createOperationResumeService } from "./server/services/operation-resume.js";
import { createOperationsControlRoutes } from "./server/routes/operations-control.js";
import {
  createOperationsControlService,
  type OperationControlService,
  type OperationsControlDependencies
} from "./server/services/operation-control.js";
import { checkSetupPullRequestMergeForOperation } from "./server/services/setup-pull-request.js";
import {
  cancelVerificationWorkflow,
  requireVerificationWorkflowIdentity,
  readVerificationWorkflowState
} from "./server/services/verification-workflow-cancellation.js";
import { honorStopBoundary } from "./server/services/operation-stop-boundary.js";
import {
  persistBestEffort,
  persistMutationCheckpoint
} from "./server/services/setup-checkpoint.js";
import {
  CLEANUP_COMMANDS,
  cleanupRemovedGitHubEnvironment
} from "./server/services/cleanup-commands.js";
import { createEnvironmentListingCache } from "./server/services/environment-listing-cache.js";
import type { CleanupCommandKind } from "./server/services/cleanup-commands.js";
import { runWorkflowRollback } from "./server/services/workflow-rollback.js";
import type { WorkflowRollbackPorts } from "./server/services/workflow-rollback.js";
import {
  createWorkflowRollbackPorts,
  createSelectedWorkflowRollbackCommand
} from "./server/services/workflow-rollback-ports.js";
import type { WorkflowRollbackCommand } from "./server/services/workflow-rollback-ports.js";
import {
  rollbackGitHubEnvironmentVariables,
  type GitHubVariableCommand
} from "./server/services/github-environment-variable-rollback.js";
import { createRepositoriesRoutes } from "./server/routes/repositories.js";
import { createAzureDiscoveryRoutes } from "./server/routes/azure-discovery.js";
import { createTemporaryKubeconfig } from "./server/temporary-kubeconfig.js";
import { createAzureSetupService } from "./server/services/azure-setup.js";
import {
  createConfigureEnvironmentService,
  type ConfigureEnvironmentDependencies
} from "./server/services/configure-environment.js";
import type { SetupServices } from "./server/services/setup-outcome.js";
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
import {
  beginGraphRepairAttempt,
  clearGraphRepairAttempt,
  graphRepairHandoffMessage,
  type GraphRepairRequest
} from "./graph-model-repair.js";
import { createSelectedNamespaceClaimsPorts } from "./server/routes/create-environment-namespace-claims.js";
import { validateBrowserMutationRequest } from "./server/browser-mutation.js";
import type { EnvironmentAccountContext } from "./runtime/environment-account-context.js";
import {
  createGitHubAccountReadinessService,
  createGitHubSelectionHandleStore
} from "./server/services/github-account-readiness.js";
import { createEnvironmentsRoutes } from "./server/routes/environments.js";
import type { EnvironmentsDependencies } from "./server/routes/environments-types.js";
import {
  createVerificationStatusService,
  type VerificationStatusInput,
  type VerificationStatusResult
} from "./server/services/verification-status.js";
import { createDeployRequestService } from "./server/services/deploy-request.js";
import { retryDeploymentDelivery } from "./runtime/deployment-delivery-retry.js";
import { classifyDeploymentDispatchFailure } from "@radius-project/core";
import { toGhCommandResult } from "./server/services/gh-command-result.js";
import { shouldRetryWithKeyringCredential } from "./server/services/workflow-credential-fallback.js";
import { verifyWorkflowFilesMatchSource } from "./server/services/delete-environment-workflow-verification.js";
import {
  ProviderMutationRecoveryError,
  recordProviderReconciliationFailure
} from "./server/services/provider-mutation-recovery.js";
import {
  pendingBranchDelete,
  reconcileRecoveredBranchDelete
} from "./server/services/recovered-branch-delete.js";
import {
  branchRefListingArgs,
  branchRefReadArgs,
  isNotFoundResponse
} from "./server/services/branch-absence.js";
import {
  buildGitHubEnvironmentDeleteArgs,
  deleteGitHubEnvironmentIdempotent as deleteGitHubEnvironmentPrimitive,
  parseEnvironmentProviderId,
  selectedEnvironmentReader
} from "./server/services/github-environment.js";

export { selectedEnvironmentReader };
import {
  CleanupJournalPersistenceError,
  type CleanupIdentityVerdict,
  cleanupDeletionKind,
  executeJournaledCleanupDeletion,
  isCleanupDeletionKind,
  type CleanupDeletionCommandResult,
  type CleanupDeletionOutcome,
  type ExactIdentityRead
} from "./server/services/cleanup-deletion-journal.js";
import type { ResourceAbsenceProof } from "./server/services/resource-absence.js";
import {
  ENVIRONMENT_PAGE_SIZE,
  environmentListingArgs,
  environmentNameFromApiPath,
  environmentsApiPath,
  proveEnvironmentAbsent
} from "./server/services/environment-absence.js";
import {
  readRecoveredVerificationIdentity,
  recoverVerificationRun,
  verificationActionsUrl
} from "./server/services/recovered-verification-run.js";
import { planRecoveredCleanup } from "./server/services/recovered-cleanup-command.js";
import {
  runEnvironmentDeletion,
  statePackageDeletionFailureMessage,
  type EnvironmentDeletionPorts
} from "./server/services/environment-deletion.js";
import { createStatePackageDeletion } from "./server/services/state-package-deletion.js";
import {
  recordCredentialProvenance,
  listCredentialProvenanceForClient,
  removeCredentialProvenance,
  clearEnvironmentCredentialProvenance,
  withCredentialProvenanceLock
} from "./credential-provenance.js";
import { classifyCompletedDeleteEnvRun } from "./server/services/delete-env-run-classifier.js";
import type {
  RadiusEnvDeletionOutcome,
  GitHubEnvDeletionOutcome
} from "./server/services/environment-deletion.js";
import { createDeploymentAbandonmentService } from "./server/services/deployment-abandonment.js";
import { resolveEnvironmentDeployment } from "./server/services/deployment-resolver.js";
import type { DeploymentRow } from "./server/services/deployment-resolver.js";
import { runEnvironmentOperationWorkflow } from "./server/services/environment-operation.js";
import type { RemediationReference } from "./server/services/environment-operation.js";
import {
  monitorVerificationWithSelectedAccount,
  verificationAcquisitionExpiredCopy,
  verificationTrackingDeadline
} from "./server/services/verification-retry.js";
import { runVerificationRetry as runSelectedVerificationRetry } from "./server/services/verification-retry-runner.js";
import type { CanvasServerEntry } from "./server/types.js";
import type { CanvasServerDependencyOverrides } from "./server/dependencies.js";
import type { EnvironmentExecutionOwner } from "./runtime/environment-execution-owner.js";
import type {
  DeploymentExecutionOwner,
  DeploymentExecution
} from "./runtime/deployment-execution-owner.js";
import { createDeploymentReservationBindings } from "./server/services/deployment-reservations.js";
import { createDeploymentPresentation } from "./server/services/deployment-presentation.js";
import type { DeploymentAccountResolver } from "./runtime/deployment-account.js";
import { createSetupExecution } from "./runtime/setup-execution.js";
export { reopenProviderReconciliation } from "./runtime/setup-execution.js";

export type { CanvasServerEntry } from "./server/types.js";
export { resolveDeployStatus } from "./server/services/deployment-resolver.js";

interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  // Set when the runner's timeout killed the child. The command's outcome is
  // then unknown, so no credential fallback may re-run it.
  timedOut?: boolean;
}

export {
  persistBestEffort,
  persistMutationCheckpoint
} from "./server/services/setup-checkpoint.js";

/**
 * Honor a recorded stop at a named safe boundary between remote mutations.
 *
 * Called before a mutation begins and again once its provenance is saved, never
 * while an Azure CLI, GitHub CLI, or HTTP call is in flight. Radius does not
 * kill a running process: it lets the current write finish, records what it did,
 * and stops before the next one. Returns true when the caller may continue.
 */
export async function guardStopBoundary({
  operation,
  boundary,
  persist,
  report,
  respond
}: {
  operation: any;
  boundary: string;
  persist: () => Promise<void>;
  report?: (diagnostic: { code: string; message: string }) => void;
  respond: (status: number, body: Record<string, unknown>) => void;
}): Promise<boolean> {
  const proceed = await honorStopBoundary({
    operation,
    boundary,
    persist,
    report
  });
  if (proceed) return true;
  respond(200, {
    cancelled: true,
    code: "operation-stopped",
    boundary,
    operationId: operation.operationId,
    operation: toClientView(operation)
  });
  return false;
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
      resolve(toGhCommandResult(err, stdout, stderr));
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
  progressView?: GraphProgressView;
  // The instance's state, so the runtime can resolve each branch's model
  // against the same workspace context the route just rendered from, and so it
  // can deduplicate against the handoff it last performed for this panel.
  state?: CanvasState;
  // Whether the render that raised this handoff is still on screen, re-checked
  // by the runtime just before it mints attempt tokens and speaks.
  isCurrent?: () => boolean;
  environmentKey?: string;
}

// Payload for the informational failure notice. Carries no attemptId: a notice
// never opens a repair loop, so there is no attempt for the agent to address.
export interface DeployFailureNoticeInput {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  dispatchRefused?: boolean;
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

// Composition root for the cooperative controls in the same `operations-status`
// family: stop, continue, rollback, and the setup, verification, and cleanup
// retries.
//
// Eligibility, command identity, and the retry snapshot are imported directly by
// the route module from `operations.ts`, which is independently tested; the
// merge proof stays in its own service with a single GitHub port. What is
// injected here is the genuine I/O the routes cannot decide alone.
function requiredVerificationWorkflowContext(op: {
  operationId: string;
  repo?: unknown;
  verification?: unknown;
  context?: unknown;
  [key: string]: unknown;
}): {
  identity: ReturnType<typeof requireVerificationWorkflowIdentity>;
  login: string;
} {
  const identity = requireVerificationWorkflowIdentity(op);
  const operationContext =
    op.context && typeof op.context === "object" ? op.context : null;
  const login =
    (
      operationContext &&
      "githubLogin" in operationContext &&
      typeof operationContext.githubLogin === "string"
    ) ?
      operationContext.githubLogin.trim()
    : "";
  if (!login) {
    throw new Error(
      "The interrupted setup does not record the GitHub account that started it."
    );
  }
  return { identity, login };
}

// Composition root for the `azure-discovery` routes. Four seams:
// `az` runner (which carries the agent-session-stripped `cliExec` environment
// the Azure setup routes run under), the general trimmed-stdout CLI runner the
// discovery enumeration branches on, and the two pure `azure-oidc` helpers,
// injected rather than imported by the handler module.
const azureDiscoveryRoutes = createAzureDiscoveryRoutes({
  runAz: (command, args) => runCliCommand(command, args),
  runCli: (command, args, options) => runCommand(command, args, options),
  isUuid,
  createTemporaryKubeconfig,
  parseServedReposFromSubjects: (subjects) =>
    parseServedReposFromSubjects(subjects as Iterable<unknown>)
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
    presentRemediation: (remediation) =>
      presentRemediation(remediation, GH_COMMAND_PRESENTATION),
    runSessionPrompt: (prompt) =>
      invokeSessionPrompt(sessionPromptHandler, prompt),
    errorMessage
  })
);

// Composition root for the write half of the `graphs-planning` family. The
// complete dependency object is assembled here and nowhere else; the workflow
// service receives narrow function seams and the shared modeling pipeline
// receives its own eight, so neither module holds a GitHub client, spawns
// `rad`, or touches disk directly.
//
// `github` is bound into `resolveRadArtifactsDir`, `fetchRecipePack` and
// `resolveRecipeOutputs` here rather than injected, which is what keeps the
// route modules free of it. The pure helpers (`computeGraphDiff`, `record`, …)
// are injected rather than imported by the workflows, matching how the sibling
// families inject `repoMatchesWorkspace`.
const observeServerWorkspaceModelingRun = (
  state: CanvasState,
  repo: string,
  branches: string[]
): Promise<number | null> =>
  observeWorkspaceModelingRun(
    repo,
    branches,
    {
      repo: state.workspaceRepo ?? "",
      branch: state.workspaceBranch ?? "",
      path: state.workspacePath
    },
    modelingRunLastActivityAtMs
  );

function triggerGraphRepairHandoff(
  entry: CanvasServerEntry,
  request: GraphRepairRequest
) {
  if (request.view === "diff") entry.state.diffModelingFailed = true;
  const attempt = beginGraphRepairAttempt(entry.state, request);
  if (attempt.repairing) {
    void invokeSessionPrompt(
      sessionPromptHandler,
      graphRepairHandoffMessage(request, attempt)
    ).then((result) => {
      if (result.status >= 400) {
        console.error(
          `[radius graph] failed to hand repair attempt ${attempt.attempt} to the agent: ${result.error}`
        );
      }
    });
  }
  return attempt;
}

// The listing TTL and verify-workflow filename are declared here, before the
// environments composition root reads them eagerly. Their canonical uses stay
// below with the rest of the cache and verify constants; hoisting only the
// declaration keeps the module-init read out of the temporal dead zone.
const ENV_LIST_TTL_MS = 15000;
const VERIFY_WORKFLOW_FILE = "radius-verify-credentials.yml";

// Reads the environment's stored GitHub variables to determine its provider and
// the app registration id the delete cleanup targets. Kept beside the
// `environments` composition root because it is only used by that route's
// delete flow. Throws on an API/permission failure so the route fails closed.
async function discoverEnvironmentTarget(
  repo: string,
  environment: string
): Promise<{
  provider: string;
  clientId: string;
  tenantId: string;
  repoId: number;
}> {
  const out = await runCommand(
    "gh",
    [
      "api",
      `/repos/${repo}/environments/${encodeURIComponent(
        environment
      )}/variables?per_page=100`,
      "--jq",
      '.variables[] | .name + "\\t" + (.value // "")'
    ],
    { timeout: 15000 }
  );
  const vars = parseGitHubEnvironmentVariables(out);
  // Classify the provider by the presence of a canonical, exact-named
  // configuration variable (see classifyProvider) rather than a regex over
  // every variable name, and share that logic with the environment listing so
  // the two paths never disagree about the same environment.
  const provider = classifyProvider(vars);
  let repoId = 0;
  if (provider === "azure") {
    const repoIdOutput = await runCommand(
      "gh",
      ["api", `/repos/${repo}`, "--jq", ".id"],
      { timeout: 15000 }
    );
    repoId = Number(repoIdOutput.trim());
    if (!Number.isFinite(repoId) || repoId <= 0) {
      throw new Error("GitHub returned an invalid repository id.");
    }
  }
  return {
    provider,
    clientId: vars.AZURE_CLIENT_ID || "",
    tenantId: vars.AZURE_TENANT_ID || "",
    repoId
  };
}

// Reads what the repository's environments already claim, for the create
// route's namespace rung. The read runs as the GitHub account pinned to that
// operation, the same account every other step of the setup uses, so a customer
// who passed readiness with the selected account is never refused because the
// ambient `gh` account cannot see the repository. No pinned account means the
// claims cannot be established, and the rung fails closed on null.
const namespaceClaimsFor = (
  accountContext: Pick<EnvironmentAccountContext, "getExecutor">,
  operationId: string
) => {
  const executor = accountContext.getExecutor(operationId);
  return executor ? createSelectedNamespaceClaimsPorts(executor) : null;
};

export type EnvironmentOperationRunner = (
  operationId: string,
  commandId?: string
) => Promise<void>;

export function cleanupProviderRecoveryDisposition(operation: any): {
  blockers: ReturnType<typeof unresolvedProviderMutations>;
  mayStartDestructiveCleanup: boolean;
  mayCompleteCleanup: boolean;
} {
  const blockers = unresolvedProviderMutations(operation);
  return {
    blockers,
    mayStartDestructiveCleanup: blockers.every(
      (mutation) => mutation.kind === "github_branch.delete"
    ),
    mayCompleteCleanup: blockers.length === 0
  };
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

// Short-lived cache for the /api/list-environments listing to keep the planned
// and deploy pages snappy. Invalidated on environment creation, on an explicit
// environment delete, and by the rollback and exit passes that remove the
// environment a setup created. Eviction goes through `invalidate`, which also
// makes any listing already in flight for that repository unable to cache what
// it read — see `server/services/environment-listing-cache.ts`.
const envListCache = createEnvironmentListingCache();

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
  kind: "deploy" | "delete" | "abandon";
  expiresAt: number;
  attemptId?: string;
}

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
  workingBranch = "",
  ports?: WorkflowSyncPorts
): Promise<{
  created: string[];
  updated: string[];
  failed: WorkflowCommitFailure[];
}> {
  if (!repo || !environment || !only || only.length === 0)
    return { created: [], updated: [], failed: [] };
  try {
    if (ports)
      await ports.generateDeployWorkflow(environment, ".radius/app.bicep");
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
      },
      ports
    );
    if (ports && r.failed.length > 0) {
      throw new Error(
        "Could not prepare deployment workflows: " +
          r.failed.map(({ path, branch }) => `${path} on ${branch}`).join(", ")
      );
    }
    if (
      r &&
      ((r.updated && r.updated.length) || (r.created && r.created.length))
    ) {
      const changed = [...(r.updated || []), ...(r.created || [])];
      console.error(
        `[radius workflow-presync] ${repo}: ${changed.join(", ")} before dispatch`
      );
    }
    return {
      // Downstream dispatchers use this list only to decide whether GitHub may
      // still be registering a workflow, including one created concurrently.
      created: [
        ...new Set([...(r.created || []), ...(r.registrationPending || [])])
      ],
      updated: r.updated || [],
      failed: r.failed || []
    };
  } catch (e) {
    console.error(`[radius workflow-presync] ${repo}: ${errorMessage(e)}`);
    if (ports) throw e;
    return { created: [], updated: [], failed: [] };
  }
}

// no access to the SDK `session`, so when a graph/generate route finds no
// app.bicep it delegates through this hook, which injects a user turn asking the
// agent to run the radius-app-bicep skill. This is what makes branch/repo
// selection (not just canvas open) trigger generation automatically.
let appBicepHandoff: AppBicepHandoff | null = null;
export function setAppBicepHandoff(fn: AppBicepHandoff | null): void {
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
export function setSessionPromptHandler(fn: SessionPromptHandler | null): void {
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
      error: "Could not reach the Copilot session to run this command."
    };
  }
  try {
    await handler(prompt);
    return { status: 200 };
  } catch {
    return {
      status: 502,
      error: "The Copilot session could not run this command."
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

// Report a graph view's application model to the runtime, which decides whether
// it needs authoring, a refresh, the user's agreement, or only a note.
//
// Deliberately unconditional: a route calls this on every render, whether or not
// the model exists, because a model that is present can still be stale. The
// runtime owns the dedupe — its key covers what is wrong with the model, not
// merely which branches were looked at, so re-reporting an unchanged situation
// stays silent while a model that changes from stale to hand-edited is still
// reported. Fire-and-forget so it never blocks the HTTP response.
function triggerAppBicepHandoff(
  entry: { state: CanvasState } | undefined,
  repo: string,
  branches: string | string[],
  page: string,
  progressView: GraphProgressView = page === "graph-diff" ? "diff" : "graph",
  isCurrent?: () => boolean,
  environmentKey?: string
): void {
  try {
    if (typeof appBicepHandoff !== "function") return;
    if (!repo) return;
    const list = (Array.isArray(branches) ? branches : [branches]).filter(
      (branch): branch is string => Boolean(branch)
    );
    Promise.resolve(
      appBicepHandoff({
        repo,
        branches: list,
        page,
        progressView,
        state: entry?.state,
        isCurrent,
        environmentKey
      })
    ).catch(() => {});
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
export const DEPLOY_DISPATCH_REFUSED_KIND: DeployErrorKind = "dispatch-refused";

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

// Marks a redeploy whose cloud login/authorization failed before any resource
// was touched (exception 5.2): an environment that verified earlier no longer
// authenticates, so its trust or permissions drifted. The fix is to re-verify
// the credentials, not to change the model, so like the OIDC-subject kinds this
// never opens an automatic repair loop.
export const DEPLOY_CLOUD_AUTH_DRIFT_KIND: DeployErrorKind = "cloud-auth-drift";

// Split a failed `gh workflow run` by whether it proves no run was created.
// GitHub naming the branch as unresolvable is proof: it rejected the request.
// Anything else is not — the request can be accepted and the answer lost (the
// CLI timing out, for one), and the token-scope retry can dispatch twice — so
// it has to be treated as a run that may exist.
export function classifyDeployDispatchFailure(stderr: string): DeployErrorKind {
  return classifyDeploymentDispatchFailure(stderr);
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
  return resolveDeploymentRepairLoop(state, requestedAttemptId);
}

export {
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  DEPLOY_HANDOFF_RETRY_DELAY_MS
} from "@radius-project/core";

interface DeploymentDeliveryLifetime {
  isCurrent(): boolean;
  redactDiagnostic?(value: string): string;
  retry(callback: () => void, milliseconds: number): void;
  publish(): void;
}

export function triggerDeployRepairHandoff(
  entry: { state: CanvasState } | undefined,
  instanceId = "",
  lifetime?: DeploymentDeliveryLifetime
): boolean {
  try {
    if (lifetime && !lifetime.isCurrent()) return false;
    if (typeof deployRepairHandoff !== "function") return false;
    const state = entry?.state;
    if (!state) return false;
    return deliverDeploymentRepair(
      state,
      {
        repo:
          state.deployingRepo || state.plannedRepo || state.contextRepo || "",
        branch: state.deployingBranch || "",
        error: state.deployError || "",
        deployRunUrl: state.deployRunUrl || "",
        instanceId
      },
      {
        isCurrent: () => lifetime?.isCurrent() ?? true,
        send: (input) => {
          if (typeof deployRepairHandoff !== "function")
            throw new Error("The host repair handoff is unavailable.");
          return deployRepairHandoff(input);
        },
        redactDiagnostic: lifetime?.redactDiagnostic ?? redactGhCredentials,
        publish: () => lifetime?.publish(),
        retry: (callback, milliseconds) => {
          if (lifetime) lifetime.retry(callback, milliseconds);
          else {
            const timer = setTimeout(callback, milliseconds);
            timer.unref?.();
          }
        },
        reportError: () => {
          console.error(
            "[radius repair] Could not deliver the repair handoff."
          );
        }
      }
    );
  } catch {
    console.error("[radius repair] Could not start the repair handoff.");
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

// Relay an uncertain workflow or a refused preparation as an informational report.
//
// Deliberately parallel to triggerDeployRepairHandoff but kept separate:
//   * neither supported failure opens a repair loop;
//   * it never sets deployRepairing and never opens a repair loop, because a run
//     may still be in flight and an automatic redeploy could race it;
//   * it tracks delivery on its own deployNotice* fields so it can never be
//     confused with, or suppress, a repair handoff.
// Branch-not-pushed is intentionally NOT relayed here: the canvas already shows a
// dedicated, actionable "push the branch" panel for it, so a chat report would be
// redundant noise.
export function triggerDeployFailureNotice(
  entry: { state: CanvasState } | undefined,
  instanceId = "",
  lifetime?: DeploymentDeliveryLifetime
): boolean {
  try {
    if (lifetime && !lifetime.isCurrent()) return false;
    if (typeof deployFailureNotice !== "function") return false;
    const state = entry?.state;
    if (!state) return false;
    return deliverDeploymentNotice(
      state,
      {
        repo:
          state.deployingRepo || state.plannedRepo || state.contextRepo || "",
        branch: state.deployingBranch || "",
        error: state.deployError || "",
        deployRunUrl: state.deployRunUrl || "",
        instanceId,
        ...(state.deployErrorKind === DEPLOY_DISPATCH_REFUSED_KIND ?
          { dispatchRefused: true }
        : {})
      },
      {
        isCurrent: () => lifetime?.isCurrent() ?? true,
        redactDiagnostic: lifetime?.redactDiagnostic ?? redactGhCredentials,
        send: (input) => {
          if (!deployFailureNotice)
            throw new Error("Deployment notice delivery is unavailable.");
          return deployFailureNotice(input);
        },
        publish: () => lifetime?.publish(),
        retry: (callback, milliseconds) => {
          if (lifetime) lifetime.retry(callback, milliseconds);
          else {
            const timer = setTimeout(callback, milliseconds);
            timer.unref?.();
          }
        },
        reportError: (error) =>
          console.error("[radius notice] Delivery failed:", error)
      }
    );
  } catch {
    console.error("[radius notice] Could not prepare deployment notice.");
  }
  return false;
}

// The workflow that actually runs `rad` deploy commands. The deployments list
// only surfaces deployment records produced by this workflow — records created
// by other environment-bound workflows (verify-credentials, delete-application)
// are not real application deployments and are filtered out.
const DEPLOY_WORKFLOW_FILE = "run-rad-commands.yml";
const DELETE_WORKFLOW_FILE = "delete-application.yml";

export { DEPLOY_RAD_COMMANDS_STEP } from "@radius-project/core";

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
        resolve(toGhCommandResult(err, stdout, stderr));
      }
    );
  });
}

// Dispatch the just-committed delete-environment workflow and wait for its run
// to finish. Tearing down the Radius environment needs cluster access, so it
// runs on the ephemeral control plane the workflow spins up (authenticating with
// the environment's still-present federated credential — hence this must run
// before the credential is removed). Best-effort: a dispatch or run failure is
// reported as a `failed` outcome the runner records as a warning, never a throw.
async function deleteRadiusEnvironmentViaWorkflow(
  repo: string,
  environment: string,
  onHeartbeat?: () => void | Promise<void>
): Promise<RadiusEnvDeletionOutcome> {
  const sync = await ensureWorkflowsCurrent(repo, environment, "", [
    DELETE_ENV_DISPATCHER_FILE,
    DELETE_ENV_AZURE_FILE
  ]);
  // Committing the workflows is best-effort and can silently no-op (a protected
  // branch, or an exception `ensureWorkflowsCurrent` swallows), and the delete
  // dispatcher `uses:` the reusable provider file that carries the "no deployed
  // applications" safety guard. `gh workflow run` resolves BOTH files from the
  // default branch, so before dispatching we read BOTH back from that branch and
  // confirm they match the packaged source. Any file that is missing, stale, or
  // unreadable stops the deletion here — a stale provider means a stale guard,
  // and dispatching against it could tear down an environment that still has
  // deployed applications. (The narrow `sync.failed` list only names files whose
  // commit definitely failed; the read-back is the authoritative gate because it
  // also catches a swallowed sync exception that reports no failure at all.)
  let expectedDeleteWorkflows: Record<string, string>;
  try {
    expectedDeleteWorkflows = await generateDeleteWorkflow(environment);
  } catch (error) {
    return {
      outcome: "failed",
      detail: `Could not build the delete-environment workflow templates to verify them: ${errorMessage(
        error
      )}`
    };
  }
  const workflowVerification = await verifyWorkflowFilesMatchSource(
    [DELETE_ENV_DISPATCHER_FILE, DELETE_ENV_AZURE_FILE].map((file) => ({
      file,
      path: `.github/workflows/${file}`,
      expected: expectedDeleteWorkflows[file] || ""
    })),
    {
      defaultBranch: async () => (await getDefaultBranch(repo)) || "",
      readFile: (path, branch) => fetchFileFromRepo(repo, path, branch),
      errorMessage
    }
  );
  if (!workflowVerification.ok) {
    return {
      outcome: "failed",
      detail: `${workflowVerification.detail} Radius did not start the deletion of "${environment}" in ${repo}.`
    };
  }
  const ghWorkflow = async (args: string[]): Promise<CommandResult> => {
    const first = await runGhForDeploy(args);
    if (first.code === 0) return first;
    const env = process.env;
    // Dispatching a workflow requires the `workflow` scope, which an injected
    // GH_TOKEN often lacks. Retry with it stripped ONLY when that fallback is
    // safe: the failure positively names the missing scope, and the dispatch did
    // not time out. A timed-out (or otherwise killed) dispatch may already have
    // been accepted by GitHub, so re-running it would start the destructive
    // delete workflow a SECOND time; and the retry runs as whichever account the
    // keyring holds, so it must never be entered on an unknown failure.
    const retryAllowed = shouldRetryWithKeyringCredential({
      stderr: first.stderr,
      timedOut: first.timedOut === true,
      hasInjectedToken: Boolean(
        env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
      )
    });
    if (!retryAllowed) return first;
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const retry = await runGhForDeploy(args, { env: fallbackEnv });
    return retry.code === 0 ? retry : first;
  };
  const justCreated = sync.created.some(
    (p) => p.split("/").pop() === DELETE_ENV_DISPATCHER_FILE
  );
  const dispatchedAt = Date.now();
  // A unique id echoed into the run's display name (via the dispatcher's
  // `run-name:`) so the specific run this call started can be matched exactly —
  // never a concurrent or manual deletion of a different environment.
  const correlationId = `del-${dispatchedAt.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const dispatchArgs = [
    "workflow",
    "run",
    DELETE_ENV_DISPATCHER_FILE,
    "-f",
    "environment=" + environment,
    "-f",
    "correlation_id=" + correlationId,
    "--repo",
    repo
  ];
  let dispatch: CommandResult = { code: 1, stdout: "", stderr: "" };
  const dispatchDelays = justCreated ? [0, 2000, 5000] : [0];
  if (justCreated) await sleepMs(3000);
  for (const delay of dispatchDelays) {
    if (delay > 0) await sleepMs(delay);
    dispatch = await ghWorkflow(dispatchArgs);
    if (dispatch.code === 0) break;
    if (!/not found|HTTP 404/i.test(dispatch.stderr || "")) break;
  }
  if (dispatch.code !== 0) {
    return {
      outcome: "failed",
      detail:
        (dispatch.stderr || "").trim() ||
        `Failed to start ${DELETE_ENV_DISPATCHER_FILE} on ${repo}.`
    };
  }
  // Resolve and monitor the dispatched run so credential removal only starts
  // after the Radius environment is actually gone.
  let runId: number | string | null = null;
  for (const delay of [0, 2000, 4000]) {
    if (delay > 0) await sleepMs(delay);
    runId = await findWorkflowRun(
      repo,
      DELETE_ENV_DISPATCHER_FILE,
      dispatchedAt,
      null,
      undefined,
      undefined,
      correlationId
    );
    if (runId) break;
  }
  if (!runId) {
    return {
      outcome: "failed",
      detail:
        "The delete-environment workflow was dispatched but its run could not be found to confirm completion."
    };
  }
  const deadline = Date.now() + 30 * 60 * 1000;
  const reads = createWorkflowReadSession();
  let delayMs = 5000;
  while (Date.now() < deadline) {
    const detail = await getRunDetail(repo, runId, undefined, {
      identity: "ambient",
      context: reads.observe(WORKFLOW_READ_LIMITS.runMs)
    });
    if (detail && detail.status === "completed") {
      const classified = classifyCompletedDeleteEnvRun(
        detail.conclusion,
        detail.steps || []
      );
      return classified;
    }
    if (onHeartbeat) {
      try {
        await onHeartbeat();
      } catch {
        // A heartbeat failure must never abort an in-flight deletion.
      }
    }
    await sleepMs(Math.min(delayMs, 15000));
    delayMs = Math.min(Math.ceil(delayMs * 1.5), 15000);
  }
  return {
    outcome: "failed",
    detail:
      "The delete-environment workflow did not complete within 30 minutes."
  };
}

// Delete the GitHub Environment. Idempotent: a 404 (already gone) is reported as
// `not_found`, not a failure, so a re-run after a partial deletion converges.
// The classification and cache-invalidation logic is the shared cleanup
// primitive in `server/services/github-environment.ts`; this wrapper only binds
// the server's `gh` runner and environment-list cache to it. Create-Environment
// rollback binds the same primitive to its own ports.
async function deleteGitHubEnvironmentIdempotent(
  repo: string,
  environment: string
): Promise<GitHubEnvDeletionOutcome> {
  return deleteGitHubEnvironmentPrimitive(repo, environment, {
    runGh: (args) => runGhForDeploy(args),
    invalidateEnvListCache: (target) => {
      envListCache.invalidate(target);
    }
  });
}

function sleepMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

export interface CleanupGitHubContext {
  rollbackCommand: WorkflowRollbackCommand;
  deleteEnvironment(args: string[]): Promise<void>;
  /** Reads an exact resource back through the same selected account. */
  readEnvironment(args: string[]): Promise<CommandResult>;
}

export async function resolveCleanupGitHubContext({
  targets,
  selectedLogin,
  createExecutor = createSelectedGhExecutor,
  formatError = errorMessage
}: {
  targets: readonly { artifactType: string }[];
  selectedLogin: string;
  createExecutor?: (login: string) => Promise<SelectedGhExecutor>;
  formatError?: (error: unknown) => string;
}): Promise<CleanupGitHubContext> {
  const needsGitHub = targets.some(
    (entry) =>
      entry.artifactType === "workflow_file" ||
      entry.artifactType === "github_environment_variable" ||
      entry.artifactType === "github_environment"
  );
  let executor: SelectedGhExecutor | null = null;
  let unavailable = "";
  if (needsGitHub) {
    if (!selectedLogin) {
      unavailable =
        "The operation record does not name the GitHub account that created these artifacts.";
    } else {
      try {
        executor = await createExecutor(selectedLogin);
        await executor.verifyIdentity();
      } catch (error) {
        unavailable = formatError(error);
      }
    }
  }
  const failure = unavailable || "The selected GitHub account is unavailable.";
  return {
    rollbackCommand:
      executor ?
        createSelectedWorkflowRollbackCommand(executor)
      : async () => ({
          ok: false,
          status: null,
          stdout: "",
          stderr: failure
        }),
    readEnvironment:
      executor ?
        (args) => executor.run(args, { timeout: 12000 })
      : async () => ({ code: 1, stdout: "", stderr: failure }),
    deleteEnvironment:
      executor ?
        async (args) => {
          const deleted = await executor.run(args, { timeout: 20000 });
          if (deleted.code === 0 || deleted.code === "0") return;
          const detail = (deleted.stderr || deleted.stdout || "").trim();
          if (!deleted.timedOut) {
            throw new Error(
              detail || "Could not delete the GitHub environment."
            );
          }
          const path = args.at(-1) || "";
          const reread = await executor.run(["api", path], { timeout: 12000 });
          if (reread.code === 0 || reread.code === "0") {
            throw new Error(
              "Outcome unknown after provider timeout; Radius will not repeat this delete blindly. The GitHub environment identity is still present, and deleting it by name again could remove a replacement resource."
            );
          }
          if (
            /(?:HTTP\s+404|\bNot Found\b)/i.test(
              `${reread.stderr}\n${reread.stdout}`
            )
          ) {
            // GitHub answers 404 both for an environment that is gone and for
            // one this token is not allowed to see, and it decides that per
            // resource: reading the repository proves nothing about the Actions
            // environments API. So the corroborating read is the environments
            // listing itself, read to its end by the same executor, and absence
            // only means absence when the whole listing came back without it.
            const proof = await proveEnvironmentAbsentAt(path, (args) =>
              executor.run(args, { timeout: 12000 })
            );
            if (proof.state === "absent") return;
            throw new Error(
              "Outcome unknown after provider timeout; Radius will not repeat this delete blindly. " +
                proof.detail
            );
          }
          throw new Error(
            "Outcome unknown after provider timeout; Radius will not repeat this delete blindly. GitHub environment state could not be read safely."
          );
        }
      : async () => {
          throw new Error(failure);
        }
  };
}
export {
  ENVIRONMENT_PAGE_SIZE,
  environmentsApiPath,
  environmentNameFromApiPath
};

/**
 * Prove the environment an API path names absent, through the same account.
 *
 * Shared by the timed-out delete and the journal's reconcile so the two cannot
 * disagree: neither may read a bare 404 from the environment endpoint as
 * absence, because GitHub returns that for a hidden environment too.
 */
async function proveEnvironmentAbsentAt(
  environmentApiPath: string,
  run: (args: string[]) => Promise<CommandResult>,
  recordedProviderId?: string | null
): Promise<ResourceAbsenceProof> {
  const name = environmentNameFromApiPath(environmentApiPath);
  const listingPath = environmentsApiPath(environmentApiPath);
  if (!name || !listingPath) {
    return {
      state: "unknown",
      detail:
        "Radius could not derive the environments listing for the path it deleted through."
    };
  }
  return proveEnvironmentAbsent({
    repo: listingPath.replace(/^\/repos\//, "").replace(/\/environments$/, ""),
    name,
    recordedProviderId,
    ports: {
      listEnvironments: (page) =>
        run(environmentListingArgs(listingPath, page)),
      readEnvironment: () => run(["api", environmentApiPath])
    }
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
  assignmentId,
  objectId,
  role,
  scope
}: {
  assignmentId?: string;
  objectId: string;
  role: string;
  scope: string;
}): string[] {
  if (assignmentId) {
    const assignmentResourceId = `${scope.replace(
      /\/+$/,
      ""
    )}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`;
    return [
      "role",
      "assignment",
      "delete",
      "--ids",
      assignmentResourceId,
      "--output",
      "none"
    ];
  }
  return [
    "role",
    "assignment",
    "delete",
    "--assignee-object-id",
    objectId,
    "--role",
    role,
    "--scope",
    scope,
    "--output",
    "none"
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
    if (result?.code === 0 || result?.code === "0") {
      try {
        const matches = JSON.parse(String(result.stdout || ""));
        if (Array.isArray(matches) && matches.length === 0) return true;
      } catch {
        // Fall through to the provider's diagnostic text.
      }
    }
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

/**
 * Find or create the Service Principal for an App Registration, and say which
 * of the two actually happened.
 *
 * Three outcomes, deliberately not two:
 *
 *   reused            — the lookup that runs *before* any create found it, so
 *                       it existed independently of this attempt.
 *   created           — the lookup found nothing and `az ad sp create`
 *                       succeeded, so this attempt made it and may remove it.
 *   created_candidate — the lookup found nothing, the create's outcome could
 *                       not be established, and a later lookup found a
 *                       principal anyway. Radius very likely created it, but
 *                       "very likely" is not a licence to delete, and calling
 *                       it `reused` would claim something provably false: it
 *                       was absent moments ago.
 *
 * Collapsing the third case into `reused` is what put a Service Principal this
 * setup created under "Radius will keep — reused" and out of every rollback.
 *
 * The create itself is journaled when a recovery port is supplied. Without one,
 * a restart between the request and its answer left no record that a create had
 * been issued at all, so the next attempt reran it — the one replay the
 * journal exists to prevent.
 */
export async function ensureServicePrincipal(
  clientId: string,
  runAz: (args: string[]) => Promise<Partial<CommandResult>>,
  mutationRecovery?: {
    operation: object & { operationId: string };
    persist(): Promise<void>;
  },
  beforeCreate: () => Promise<boolean> = async () => true,
  sleep: (milliseconds: number) => Promise<void> = sleepMs
) {
  return ensureAzureServicePrincipal(
    clientId,
    runAz,
    mutationRecovery ?
      createAzureRecoveryPort(
        mutationRecovery.operation,
        mutationRecovery.persist
      )
    : undefined,
    beforeCreate,
    sleep
  );
}

/**
 * Hand every deletion this pass could not settle to the customer.
 *
 * Reconciliation only ever runs against a live record, so an unresolved cleanup
 * delete on a record that is about to become terminal would stay unresolved for
 * the life of the extension — blocking the destructive commands, blocking a
 * forward retry, and holding the repository lock with nothing able to release
 * it. Naming the resource converts that into a refusal the panel can show and
 * the customer can act on, and releases the lock so a fresh setup is possible.
 */
export function quarantineUnsettledCleanupDeletions(op: any): number {
  const unsettled = unresolvedProviderMutations(op).filter((mutation) =>
    isCleanupDeletionKind(mutation.kind)
  );
  for (const mutation of unsettled) {
    settleProviderMutation(
      op,
      mutation.mutationId,
      "manual_required",
      `Radius issued one delete for ${mutation.kind.replace(".cleanup_delete", "")} ${mutation.target} and could not establish whether it took effect. ` +
        "It will not repeat that delete. Check that resource and remove it yourself if it is unwanted, then start a new setup."
    );
  }
  return unsettled.length;
}

export async function cleanupAzureSetupArtifacts(
  op: any,
  {
    runAz,
    steps,
    only,
    onResultRecorded,
    persistJournal
  }: {
    runAz: (args: string[]) => Promise<Partial<CommandResult>>;
    steps?: string[];
    // The stable keys a retry is allowed to touch. Rebuilding the full deletion
    // set instead would re-issue deletes for artifacts an earlier attempt
    // already removed and, worse, silently drop the ones it could not.
    only?: ReadonlySet<string> | null;
    // Called after each result is written into the ledger, so a caller that
    // owns durable storage can save one deletion before the next one starts.
    onResultRecorded?: () => Promise<void> | void;
    // Writes the mutation journal to disk. Supplied wherever durable storage
    // exists, because a delete that is not written down before it is issued is
    // one a later attempt cannot tell from a delete that never happened.
    persistJournal?: () => Promise<void>;
  }
): Promise<{
  attempt: number;
  state: "not_needed" | "succeeded" | "succeeded_with_warnings";
  results: SetupCleanupResult[];
  warnings: string[];
  attemptedKeys: Set<string>;
}> {
  const ledger = getSetupArtifactLedger(op);
  const attempt = Number(ledger?.cleanup?.attempts || 0) + 1;
  const priorResults =
    Array.isArray(ledger?.cleanup?.results) ? ledger.cleanup.results : [];
  if (!ledger) {
    return {
      attempt,
      state: "not_needed",
      results: [],
      warnings: [],
      attemptedKeys: new Set()
    };
  }

  const deletions: Array<{
    artifactType: SetupCleanupArtifactType;
    artifact: Record<string, unknown>;
    args?: string[];
    readArgs?: string[];
    // Reads the resource's own immutable id, for kinds addressed by a name the
    // customer may reuse. Present together with the id the ledger recorded.
    identityArgs?: string[];
    recordedProviderId?: string | null;
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
            assignmentId: String(roleAssignment.assignmentId || ""),
            objectId,
            role: String(roleAssignment.role || ""),
            scope: String(roleAssignment.scope || "")
          }),
          ...(roleAssignment.assignmentId ?
            {
              readArgs: [
                "role",
                "assignment",
                "list",
                "--scope",
                String(roleAssignment.scope || ""),
                "--query",
                `[?name=='${String(roleAssignment.assignmentId)}'].id`,
                "-o",
                "json"
              ]
            }
          : {})
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
            credentialId: String(credential.name || "")
          }),
          readArgs: [
            "ad",
            "app",
            "federated-credential",
            "show",
            "--id",
            cleanupAppId,
            "--federated-credential-id",
            String(credential.name || ""),
            "-o",
            "none"
          ],
          // A credential name is the customer's to reuse inside their own
          // application, so the id decides whether this is still Radius's.
          identityArgs: [
            "ad",
            "app",
            "federated-credential",
            "show",
            "--id",
            cleanupAppId,
            "--federated-credential-id",
            String(credential.name || ""),
            "--query",
            "id",
            "-o",
            "tsv"
          ],
          recordedProviderId: optionalString(credential.providerId)
        }
      : {
          missingDetail:
            "Missing the App Registration id needed to target this federated credential."
        })
    });
  }

  if (ledger.servicePrincipal.state === "created") {
    // Only the object id will do. `az ad sp delete --id <appId>` removes
    // whichever principal that application has now, which is the replacement
    // if the customer made one.
    const spObjectId = optionalString(ledger.servicePrincipal.objectId);
    deletions.push({
      artifactType: "service_principal",
      artifact: ledger.servicePrincipal as Record<string, unknown>,
      ...(spObjectId ?
        {
          args: buildServicePrincipalDeleteArgs({ id: spObjectId }),
          readArgs: ["ad", "sp", "show", "--id", spObjectId, "-o", "none"],
          identityArgs: [
            "ad",
            "sp",
            "show",
            "--id",
            spObjectId,
            "--query",
            "id",
            "-o",
            "tsv"
          ],
          recordedProviderId: spObjectId
        }
      : {
          missingDetail:
            "The Service Principal was recorded without Microsoft Entra's own object id for it, so Radius cannot tell it from a principal recreated for the same application. Review it and remove it yourself if it is unwanted."
        })
    });
  }

  if (ledger.azureApp.state === "created") {
    const appId = String(ledger.azureApp.appId || "").trim();
    deletions.push({
      artifactType: "azure_app",
      artifact: ledger.azureApp as Record<string, unknown>,
      ...(appId ?
        {
          args: buildAppDeleteArgs({ appId }),
          readArgs: ["ad", "app", "show", "--id", appId, "-o", "none"]
        }
      : {
          missingDetail:
            "Missing the App Registration id needed to delete the created application."
        })
    });
  }

  const selected =
    only ?
      deletions.filter((deletion) => {
        const label = cleanupTargetLabel(
          deletion.artifactType,
          deletion.artifact
        );
        // Matched on the label as well as the identity, because a result an
        // earlier version wrote was keyed before the provider's own id led the
        // identity. Without this a retry would find nothing to do and leave
        // the target it was named for outstanding forever.
        return (
          only.has(
            cleanupTargetKey({
              artifactType: deletion.artifactType,
              identity: cleanupArtifactIdentity(
                deletion.artifactType,
                deletion.artifact
              ),
              target: label
            })
          ) ||
          only.has(
            cleanupTargetKey({
              artifactType: deletion.artifactType,
              identity: "",
              target: label
            })
          )
        );
      })
    : deletions;
  const attemptedKeys = new Set<string>();

  if (selected.length === 0) {
    recordCleanupState(op, { attempts: attempt, state: "not_needed" });
    return {
      attempt,
      state: "not_needed",
      results: [],
      warnings: [],
      attemptedKeys
    };
  }

  recordCleanupState(op, { attempts: attempt, state: "running" });
  steps?.push(
    "Cleaning up Azure artifacts created during this setup attempt..."
  );

  const warnings: string[] = [];
  const attemptResults: SetupCleanupResult[] = [];
  // Results this pass did not produce survive it. A caller that already
  // recorded part of the same attempt — the rollback runner's GitHub pass runs
  // before this one — must not lose its row to the replace rule below.
  const mergedResults = (): SetupCleanupResult[] => [
    ...priorResults.filter(
      (entry: SetupCleanupResult) =>
        entry.attempt < attempt || !attemptedKeys.has(cleanupTargetKey(entry))
    ),
    ...attemptResults
  ];
  const pushResult = async (
    artifactType: SetupCleanupArtifactType,
    artifact: Record<string, unknown>,
    outcome: SetupCleanupOutcome,
    detail: string | null
  ) => {
    const identity = cleanupArtifactIdentity(artifactType, artifact);
    attemptResults.push({
      attempt,
      artifactType,
      target: cleanupTargetLabel(artifactType, artifact),
      identity,
      outcome,
      detail
    });
    attemptedKeys.add(cleanupTargetKey({ artifactType, identity }));
    // Ownership moves only on proof. A warning leaves the ledger claiming the
    // resource, which is what keeps it retryable and keeps it listed.
    if (outcome === "deleted" || outcome === "not_found") {
      recordCleanupDeletion(op, { artifactType, identity });
    }
    // Each outcome lands in the ledger before the next deletion starts, so an
    // interrupted rollback never loses the record of a resource it removed.
    // The attempt stays `running` until the pass ends, which is how a later
    // read tells an interrupted attempt from a finished one.
    recordCleanupState(op, {
      attempts: attempt,
      state: "running",
      results: mergedResults()
    });
    await onResultRecorded?.();
  };

  for (const deletion of selected) {
    const label = cleanupTargetLabel(deletion.artifactType, deletion.artifact);
    const identity = cleanupArtifactIdentity(
      deletion.artifactType,
      deletion.artifact
    );
    // Every delete below is addressed by an exact immutable provider identity
    // and read back by the same one. An artifact that cannot supply both is one
    // Radius could only delete by name, and a name after a rebuild belongs to
    // the customer's replacement rather than to this attempt's leftover.
    const unidentifiable =
      deletion.missingDetail ||
      (!deletion.readArgs ?
        `${label} has no stable provider identity Radius can verify before and after a delete, so it will not remove it. Review it and delete it yourself if it is unwanted.`
      : !identity ?
        `${label} was recorded without the provider identity a safe delete needs.`
      : null);
    if (unidentifiable) {
      warnings.push(unidentifiable);
      steps?.push(`⚠ ${unidentifiable}`);
      await pushResult(
        deletion.artifactType,
        deletion.artifact,
        "skipped",
        unidentifiable
      );
      continue;
    }

    const readArgs = deletion.readArgs as string[];
    const readExactIdentity = async (): Promise<ExactIdentityRead> => {
      let reread: Partial<CommandResult>;
      try {
        reread = await runAz(readArgs);
      } catch {
        return "unreadable";
      }
      if (isAzureCleanupNotFound(deletion.artifactType, reread))
        return "absent";
      return reread.code === 0 || reread.code === "0" ?
          "present"
        : "unreadable";
    };

    async function confirmRecordedIdentity(): Promise<CleanupIdentityVerdict> {
      const recorded = deletion.recordedProviderId;
      if (!recorded) {
        return {
          decision: "refuse",
          detail: `${label} was recorded without the provider id that tells it from a resource recreated under the same name, so Radius will not delete it. Review it and remove it yourself if it is unwanted.`
        };
      }
      let current: Partial<CommandResult>;
      try {
        current = await runAz(deletion.identityArgs as string[]);
      } catch (error) {
        return {
          decision: "refuse",
          detail: `Radius could not read ${label} to confirm its identity: ${errorMessage(error)}. It removed nothing.`
        };
      }
      if (current.code !== 0 && current.code !== "0") {
        // Already gone. There is nothing under the name to delete, so the
        // artifact settles without a request that could only ever reach
        // whichever resource takes the name next.
        if (isAzureCleanupNotFound(deletion.artifactType, current)) {
          return { decision: "absent" };
        }
        return {
          decision: "refuse",
          detail: `Radius could not read ${label} to confirm its identity, so it removed nothing.`
        };
      }
      const live = String(current.stdout || "").trim();
      if (!live) {
        return {
          decision: "refuse",
          detail: `The provider did not report an id for ${label}, so Radius cannot confirm it is the resource it created. It removed nothing.`
        };
      }
      if (live === recorded) return { decision: "delete" };
      return {
        decision: "refuse",
        detail: `${label} now has a different provider id than the one Radius created, so the name belongs to a replacement. Radius removed nothing.`
      };
    }

    let settled: CleanupDeletionOutcome;
    try {
      settled = await executeJournaledCleanupDeletion({
        operation: op,
        artifactType: deletion.artifactType,
        identity,
        label,
        ...(deletion.identityArgs ? { confirmRecordedIdentity } : {}),
        persist: persistJournal ?? (async () => {}),
        runDelete: async () => {
          const result = await runAz(deletion.args || []);
          return {
            code: result.code ?? 1,
            stdout: String(result.stdout || ""),
            stderr: String(result.stderr || ""),
            ...(result.timedOut === true ? { timedOut: true } : {})
          };
        },
        isAlreadyAbsent: (result: CleanupDeletionCommandResult) =>
          isAzureCleanupNotFound(deletion.artifactType, result),
        readExactIdentity
      });
    } catch (error) {
      if (!(error instanceof CleanupJournalPersistenceError)) throw error;
      // The journal did not reach disk. Radius stops here rather than deleting
      // anything else it could not account for afterwards.
      const detail = `Radius stopped this deletion because it could not save the record of what it was deleting: ${error.message}`;
      warnings.push(detail);
      steps?.push(`⚠ ${detail}`);
      await pushResult(
        deletion.artifactType,
        deletion.artifact,
        "warning",
        detail
      );
      break;
    }

    if (settled.outcome === "deleted") {
      steps?.push(`✅ Deleted ${label}`);
    } else if (settled.outcome === "not_found") {
      steps?.push(`✅ ${label} was already absent`);
    } else {
      const warning = `Failed to delete ${label}: ${settled.detail}`;
      warnings.push(warning);
      steps?.push(`⚠ ${warning}`);
    }
    await pushResult(
      deletion.artifactType,
      deletion.artifact,
      settled.outcome,
      settled.detail
    );
  }

  const finalState = warnings.length ? "succeeded_with_warnings" : "succeeded";
  // Results from this attempt replace the ones it re-tried; anything an earlier
  // attempt recorded and this one did not touch survives untouched.
  const results = mergedResults();
  recordCleanupState(op, {
    state: finalState,
    attempts: attempt,
    results
  });
  return {
    attempt,
    state: finalState,
    results: attemptResults,
    warnings,
    attemptedKeys
  };
}

function sanitizeFailureExtra(extra: Record<string, unknown> = {}) {
  const safe = { ...(extra || {}) };
  delete safe.azError;
  delete safe.ghError;
  return safe;
}

export async function rollbackGitHubEnvironmentVariableArtifacts(
  op: any,
  {
    attempt,
    run,
    persist,
    only,
    steps
  }: {
    attempt: number;
    run: GitHubVariableCommand;
    persist(): Promise<void>;
    only?: Set<string> | null;
    steps?: string[];
  }
): Promise<{
  results: SetupCleanupResult[];
  warnings: string[];
  blocked: boolean;
  attempted: boolean;
}> {
  const variables = githubEnvironmentVariableRollbackTargets(op, only ?? null);
  if (variables.length === 0) {
    return { results: [], warnings: [], blocked: false, attempted: false };
  }
  const outcome = await rollbackGitHubEnvironmentVariables({
    attempt,
    operation: op,
    persist,
    variables,
    run
  });
  for (const entry of outcome.results) {
    if (
      entry.outcome === "deleted" ||
      entry.outcome === "restored" ||
      entry.outcome === "not_found"
    ) {
      recordCleanupDeletion(op, {
        artifactType: "github_environment_variable",
        identity: entry.identity ?? undefined
      });
    }
  }
  steps?.push(...outcome.steps);
  return {
    results: outcome.results,
    warnings: outcome.warnings,
    blocked: outcome.blocked,
    attempted: true
  };
}

/**
 * Remove the GitHub environment this attempt created, or explain why it stays.
 *
 * Shared by the failure path and the cleanup retry. A retry that skipped this
 * would offer to remove a proven-owned environment and then quietly delete only
 * the Azure artifacts, reporting a clean rollback while the environment survived.
 */
/**
 * Revert the workflow files this operation committed, and say whether anything
 * else may be removed.
 *
 * Extracted alongside `cleanupGitHubEnvironmentArtifact` for the same reason:
 * the pass that decides whether a rollback may proceed is the one that most
 * needs to be exercised directly, without a live instance or a real `gh`. The
 * selection, the provenance proof, and the removal itself live in the workflow
 * rollback service; this function is the ledger's half of the transaction —
 * choosing the targets, recording what came back, and reporting the block.
 */
export async function rollbackCommittedWorkflowFiles(
  op: any,
  {
    attempt,
    ports,
    only,
    steps
  }: {
    attempt: number;
    ports: WorkflowRollbackPorts;
    only?: Set<string> | null;
    steps?: string[];
  }
): Promise<{
  results: SetupCleanupResult[];
  warnings: string[];
  blocked: boolean;
  attempted: boolean;
}> {
  const files = workflowRollbackTargets(op, only ?? null);
  if (files.length === 0) {
    return { results: [], warnings: [], blocked: false, attempted: false };
  }
  const outcome = await runWorkflowRollback(
    {
      repo: String(op?.repo || ""),
      attempt,
      commit: workflowRollbackCommitState(op),
      files
    },
    ports
  );
  for (const entry of outcome.results) {
    if (
      entry.outcome === "deleted" ||
      entry.outcome === "restored" ||
      entry.outcome === "not_found"
    ) {
      recordCleanupDeletion(op, {
        artifactType: "workflow_file",
        identity: entry.identity ?? undefined
      });
    }
  }
  steps?.push(...outcome.steps);
  return {
    results: outcome.results,
    warnings: outcome.warnings,
    blocked: outcome.blocked,
    attempted: true
  };
}

export async function cleanupGitHubEnvironmentArtifact(
  op: any,
  {
    attempt,
    runDeleteEnvironment,
    readEnvironment,
    persistJournal,
    invalidateEnvironmentListing,
    steps
  }: {
    attempt: number;
    runDeleteEnvironment?: ((args: string[]) => Promise<unknown>) | null;
    // Reads the exact environment back after an interrupted delete, and writes
    // the mutation journal. Supplied wherever durable storage exists.
    readEnvironment?: ((args: string[]) => Promise<CommandResult>) | null;
    persistJournal?: () => Promise<void>;
    // Called with the repository whose environment was proven removed, so the
    // listing the picker reads stops answering from a cache that still holds
    // it. The server owns this: the browser cannot invalidate a server cache,
    // and a reload that hits the cached payload would redisplay the
    // rolled-back environment under its last known status.
    invalidateEnvironmentListing?: ((repo: string) => void) | null;
    steps?: string[];
  }
): Promise<{
  results: SetupCleanupResult[];
  warnings: string[];
  attempted: boolean;
}> {
  const ledger = getSetupArtifactLedger(op);
  const results: SetupCleanupResult[] = [];
  const warnings: string[] = [];
  if (!ledger) return { results, warnings, attempted: false };
  const artifact = ledger.githubEnvironment;
  if (artifact.state !== "created" && artifact.state !== "created_candidate") {
    return { results, warnings, attempted: false };
  }
  const envRepo = optionalString(artifact.repo);
  const envName = optionalString(artifact.name);
  const target = formatGitHubEnvironmentLabel(artifact);
  const identity = cleanupArtifactIdentity("github_environment", artifact);
  const recordOutcome = (
    outcome: SetupCleanupOutcome,
    detail: string | null
  ) => {
    results.push({
      attempt,
      artifactType: "github_environment",
      target,
      identity,
      outcome,
      detail
    });
    if (outcome === "deleted" || outcome === "not_found") {
      recordCleanupDeletion(op, {
        artifactType: "github_environment",
        identity
      });
    }
  };

  if (artifact.state === "created_candidate") {
    const detail = `Radius left GitHub environment "${target}" in place because a pre-create 404 followed by GitHub's idempotent PUT could not verify that this setup created it. To finish deleting the setup, review the GitHub environment and delete it manually if it belongs to this setup.`;
    warnings.push(detail);
    steps?.push(`⚠️ ${detail}`);
    recordOutcome("skipped", detail);
    return { results, warnings, attempted: true };
  }

  if (!runDeleteEnvironment) {
    const detail =
      "Missing the GitHub delete helper needed to remove the newly created environment.";
    warnings.push(detail);
    steps?.push(`⚠️ ${detail}`);
    recordOutcome("warning", detail);
    return { results, warnings, attempted: true };
  }

  if (!envRepo || !envName) {
    const detail =
      "Missing the GitHub environment name or repository needed to target the newly created environment precisely.";
    warnings.push(detail);
    steps?.push(`⚠️ ${detail}`);
    recordOutcome("warning", detail);
    return { results, warnings, attempted: true };
  }

  const environmentPath = `/repos/${envRepo}/environments/${encodeURIComponent(envName)}`;
  const deleteArgs = buildGitHubEnvironmentDeleteArgs(envRepo, envName);
  let settled: CleanupDeletionOutcome;
  try {
    settled = await executeJournaledCleanupDeletion({
      operation: op,
      artifactType: "github_environment",
      identity: identity || `${envRepo}:${envName}`,
      label: `GitHub environment "${target}"`,
      persist: persistJournal ?? (async () => {}),
      runDelete: async () => {
        try {
          await runDeleteEnvironment(deleteArgs);
          return { code: 0, stdout: "", stderr: "" };
        } catch (cleanupError) {
          const detail = errorMessage(cleanupError);
          // The delete helper throws its own "outcome unknown" sentence when a
          // timeout left the answer in doubt. That is not a rejection, so it is
          // carried through as one rather than settled as "nothing happened".
          return {
            code: 1,
            stdout: "",
            stderr: detail,
            ...(/Outcome unknown after provider timeout/i.test(detail) ?
              { timedOut: true }
            : {})
          };
        }
      },
      // GitHub answers 404 to the DELETE itself both for an environment that
      // is already gone and for one this token is not allowed to see. Neither
      // reading is safe to record, so the answer is deferred to the
      // reconciliation below, which proves absence through the listing.
      // Names are reused. Before the one delete goes out, the environment
      // answering to this name has to still be the one the ledger recorded.
      confirmRecordedIdentity: async (): Promise<CleanupIdentityVerdict> => {
        const recorded = optionalString(artifact.providerId);
        if (!recorded) {
          return {
            decision: "refuse",
            detail: `GitHub environment "${target}" was recorded without GitHub's own id for it, so Radius cannot tell it from an environment recreated under the same name. Review it and delete it yourself if it is unwanted.`
          };
        }
        if (!readEnvironment) {
          return {
            decision: "refuse",
            detail: `Radius has no way to read GitHub environment "${target}" back, so it cannot confirm the environment under that name is still the one it created.`
          };
        }
        let current: CommandResult;
        try {
          current = await readEnvironment(["api", environmentPath]);
        } catch (error) {
          return {
            decision: "refuse",
            detail: `Radius could not read GitHub environment "${target}" to confirm its identity: ${errorMessage(error)}. It removed nothing.`
          };
        }
        if (current.code !== 0 && current.code !== "0") {
          // A bare 404 here is what GitHub answers for an environment this
          // token may not see, so it authorizes nothing on its own. Absence has
          // to come from a listing the same account can actually read, and a
          // resource that is gone settles without a delete being issued at all.
          if (!isNotFoundResponse(current)) {
            return {
              decision: "refuse",
              detail: `Radius could not read GitHub environment "${target}" to confirm its identity, so it removed nothing.`
            };
          }
          let proof: Awaited<ReturnType<typeof proveEnvironmentAbsentAt>>;
          try {
            proof = await proveEnvironmentAbsentAt(
              environmentPath,
              readEnvironment,
              recorded
            );
          } catch (error) {
            return {
              decision: "refuse",
              detail: `Radius could not confirm whether GitHub environment "${target}" is gone: ${errorMessage(error)}. It removed nothing.`
            };
          }
          if (proof.state === "absent") return { decision: "absent" };
          return {
            decision: "refuse",
            detail: `GitHub answered 404 for environment "${target}", but Radius could not prove from a listing the selected account can read that it is actually gone, so it removed nothing.`
          };
        }
        let live: string | null;
        try {
          live = parseEnvironmentProviderId(JSON.parse(current.stdout));
        } catch {
          live = null;
        }
        if (!live) {
          return {
            decision: "refuse",
            detail: `GitHub did not report an id for environment "${target}", so Radius cannot confirm it is the environment it created. It removed nothing.`
          };
        }
        return live === recorded ?
            { decision: "delete" }
          : {
              decision: "refuse",
              detail: `GitHub environment "${target}" now has a different id than the one Radius created, so the name belongs to a replacement. Radius removed nothing.`
            };
      },
      isAlreadyAbsent: (result) =>
        isNotFoundResponse(result) ? "unproven" : false,
      // The same proof the delete port uses. A bare 404 from the environment
      // endpoint is what GitHub answers for an environment this token cannot
      // see, so settling a deletion on it would move ledger ownership for a
      // resource that is still there.
      readExactIdentity: async () => {
        if (!readEnvironment) return "unreadable";
        try {
          const proof = await proveEnvironmentAbsentAt(
            environmentPath,
            readEnvironment,
            optionalString(artifact.providerId)
          );
          if (proof.state === "absent") return "absent";
          return proof.state === "present" ? "present" : "unreadable";
        } catch {
          return "unreadable";
        }
      }
    });
  } catch (error) {
    if (!(error instanceof CleanupJournalPersistenceError)) throw error;
    const detail = `Radius stopped before removing GitHub environment "${target}" because it could not save the record of what it was deleting: ${error.message}`;
    warnings.push(detail);
    steps?.push(`⚠️ ${detail}`);
    recordOutcome("warning", detail);
    return { results, warnings, attempted: true };
  }

  if (settled.outcome === "deleted" || settled.outcome === "not_found") {
    steps?.push(
      settled.outcome === "deleted" ?
        `✅ Deleted GitHub environment "${envName}"`
      : `✅ GitHub environment "${envName}" was already absent`
    );
    recordOutcome(settled.outcome, null);
    invalidateEnvironmentListing?.(envRepo);
  } else {
    const warning = `Failed to delete GitHub environment "${envName}": ${settled.detail}`;
    warnings.push(warning);
    steps?.push(`⚠️ ${warning}`);
    recordOutcome(settled.outcome, settled.detail);
  }
  return { results, warnings, attempted: true };
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
    remediation = null,
    extra = {},
    steps,
    runAz,
    runGitHubVariable,
    runDeleteEnvironment,
    readEnvironment
  }: {
    status: number;
    error: string;
    code: string;
    stage?: string | null;
    classification?: string;
    evidence?: string | null;
    remediation?: RemediationReference | null;
    extra?: Record<string, unknown>;
    steps?: string[];
    runAz?: ((args: string[]) => Promise<Partial<CommandResult>>) | null;
    runGitHubVariable?: GitHubVariableCommand | null;
    runDeleteEnvironment?: ((args: string[]) => Promise<unknown>) | null;
    readEnvironment?: ((args: string[]) => Promise<CommandResult>) | null;
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
        results: SetupCleanupResult[];
      }
    | undefined;

  if (ledger) {
    // A quarantined or unproven provider mutation means Radius cannot say what
    // this attempt owns. Deleting the App Registration and the GitHub
    // environment on that footing is the destructive half of the same guess the
    // journal exists to refuse — and it would contradict, in the same response,
    // the guidance the record already carries. Unproven counts as well as
    // quarantined: an interrupted request that reached the provider is exactly
    // the one whose resource is missing from the ledger. This is deliberately
    // stricter than the disposition that governs a customer's explicit
    // post-terminal rollback, because nobody asked for this one.
    const unresolved = unresolvedProviderMutations(op);
    const quarantine =
      providerRecoveryManualGuidance(op) ||
      (unresolved.length > 0 ?
        `Radius has not confirmed the outcome of ${unresolved[0].kind} for ${unresolved[0].target}, so it cannot tell which resources this attempt owns.`
      : null);
    if (quarantine && !commitPointReached) {
      recordCleanupState(op, { state: "not_needed" });
      addLegacyStep(
        op,
        "⚠️ Radius removed nothing automatically because it could not prove what this attempt owns."
      );
      body.providerRecoveryGuidance = quarantine;
      cleanupSummary = projectCleanupSummary(op);
      terminalState = "failed_partial";
    } else if (commitPointReached) {
      recordCleanupState(op, { state: "not_needed" });
      cleanupSummary = projectCleanupSummary(op);
      if (ledger.commit.workflowFiles.length > 0)
        terminalState = "failed_partial";
    } else {
      const attempt = Number(ledger.cleanup.attempts || 0) + 1;
      const warnings: string[] = [];
      let results: SetupCleanupResult[] = [];
      let cleanupState: "not_needed" | "succeeded" | "succeeded_with_warnings" =
        "not_needed";

      const variableCleanup = await rollbackGitHubEnvironmentVariableArtifacts(
        op,
        {
          attempt,
          run:
            runGitHubVariable ??
            (async () => ({
              code: 1,
              stdout: "",
              stderr: "The selected GitHub account is unavailable."
            })),
          persist: () => operations.persist(),
          steps
        }
      );
      warnings.push(...variableCleanup.warnings);
      results = [...results, ...variableCleanup.results];
      if (variableCleanup.results.length > 0) {
        cleanupState =
          variableCleanup.blocked ? "succeeded_with_warnings" : "succeeded";
      }

      if (!variableCleanup.blocked && runAz) {
        const azureCleanup = await cleanupAzureSetupArtifacts(op, {
          runAz,
          steps,
          persistJournal: () => operations.persist()
        });
        warnings.push(...azureCleanup.warnings);
        results = [...results, ...azureCleanup.results];
        if (
          azureCleanup.state === "succeeded_with_warnings" ||
          (cleanupState === "not_needed" && azureCleanup.state === "succeeded")
        ) {
          cleanupState = azureCleanup.state;
        }
      } else if (!variableCleanup.blocked) {
        recordCleanupState(op, { attempts: attempt, state: "not_needed" });
      }

      if (!variableCleanup.blocked) {
        const environmentCleanup = await cleanupGitHubEnvironmentArtifact(op, {
          attempt,
          runDeleteEnvironment,
          readEnvironment,
          persistJournal: () => operations.persist(),
          invalidateEnvironmentListing: (repo) => {
            envListCache.invalidate(repo);
          },
          steps
        });
        warnings.push(...environmentCleanup.warnings);
        results = [...results, ...environmentCleanup.results];
        if (environmentCleanup.warnings.length > 0) {
          cleanupState = "succeeded_with_warnings";
        } else if (
          environmentCleanup.results.length > 0 &&
          cleanupState === "not_needed"
        ) {
          cleanupState = "succeeded";
        }
      }

      // Same reason as the rollback runner: this record is about to be terminal,
      // so an unresolved deletion would have nobody left to settle it.
      quarantineUnsettledCleanupDeletions(op);
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
        evidence,
        // Only the id and params: the canvas rebuilds the command from the
        // registry so a persisted record cannot carry one of its own.
        ...(remediation ? { remediation } : {})
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
export async function preflightRepoAdmin(
  repo: string,
  executor?: SelectedGhExecutor,
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): Promise<string> {
  const result = await preflightSetupRepository(repo, {
    read: (path) =>
      executor ? selectedGhApiJson(executor, path) : ghApiJson(path),
    fallbackLogin: async () =>
      executor ? executor.login : (await getGitHubIdentity()).actingLogin,
    isAppLogin: isGitHubAppBotLogin,
    probes: GITHUB_APP_ACCESS_PROBES,
    optionalString,
    record
  });
  if (result.kind === "allowed" || result.kind === "ambiguous") return "";
  if (result.kind === "app-denied") {
    return describeMissingGitHubAppAccess(
      result.login,
      repo,
      result.permission
    );
  }
  return explainRepoAccessForEnvSetup(
    { repo, ...result },
    ghCommandPresentation
  );
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
      // The command the customer should run, when there is one the registry
      // will build. Carried alongside the prose so the canvas can offer Copy /
      // Run with Copilot instead of leaving a command to be retyped by hand.
      remediation?: RemediationView | null;
    };

// Resolve the exact GitHub Packages credential GHCR writes will use, then check
// that very account for write:packages. The package credential is
// authoritative: on multi-account machines it can differ from a merely-active
// gh login, and the credential's own `source` decides both which scopes are
// read and which remediation is possible — a `gh auth refresh` cannot change an
// injected session token.
export async function preflightGhcrPackageWriteAccess(
  loadCredentials: GhcrPackageCredentialLoader = getGhPackageCredentials,
  loadIdentity: GhcrPackageIdentityLoader = getGitHubIdentity,
  selectedExecutor?: SelectedGhExecutor,
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): Promise<GhcrPackagePreflightResult> {
  let packageCredentials: GhcrPackageCredentials;
  try {
    packageCredentials =
      selectedExecutor ?
        selectedExecutor.packageCredentials()
      : await loadCredentials();
  } catch (e) {
    const loginCommand = displayGhCommand(ghCommandPresentation, [
      "auth",
      "login",
      "-h",
      "github.com",
      "-s",
      "read:packages",
      "-s",
      "write:packages"
    ]);
    const guidance =
      loginCommand ?
        ` Run \`${loginCommand}\` in a terminal, then retry.${
          ghCommandPresentation.installationNote ?
            ` ${ghCommandPresentation.installationNote}`
          : ""
        }`
      : ` ${ghCommandPresentation.installationNote}`;
    return {
      ok: false,
      status: 403,
      code: "ghcr-auth-failed",
      error: `Could not authenticate to GitHub Packages for this repository. ${errorMessage(
        e
      )}${guidance}`
    };
  }

  let ghPkgIdentity: GhcrPackageIdentity;
  try {
    if (selectedExecutor) {
      ghPkgIdentity = selectedSetupPackageIdentity(
        {
          username: packageCredentials.username,
          source: packageCredentials.source,
          scopes: packageCredentials.scopes
        },
        { login: selectedExecutor.login, scopes: selectedExecutor.scopes }
      );
    } else {
      ghPkgIdentity = await loadIdentity();
    }
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

  const access = assessSetupPackageWriteAccess(
    {
      username: packageCredentials.username,
      source: packageCredentials.source,
      scopes: packageCredentials.scopes
    },
    ghPkgIdentity
  );
  if (access.kind === "identity-missing") {
    return {
      ok: false,
      status: 403,
      code: "ghcr-auth-failed",
      error:
        "Could not determine which GitHub account the GHCR package credentials belong to. Re-authenticate to GitHub Packages and retry."
    };
  }
  const ghPkgLogin = access.login;
  if (access.kind === "scope-required") {
    const scope = explainMissingPackagesScope(
      ghPkgLogin,
      packageCredentials.source,
      ghPkgIdentity.accounts || [],
      ghCommandPresentation
    );
    return {
      ok: false,
      status: 403,
      code: "ghcr-scope-required",
      error: scope.message,
      remediation: scope.remediation
    };
  }

  return {
    ok: true,
    credentials: packageCredentials,
    identity: ghPkgIdentity,
    login: ghPkgLogin
  };
}

// Build the remediation for a packages credential that lacks write:packages.
// The advice depends on WHICH credential was resolved: a stored keyring login
// can be refreshed in place, while the host-injected session token overrides
// stored logins and can only be replaced by selecting another stored account —
// and that is worth suggesting only when such an account actually exists.
export function explainMissingPackagesScope(
  login: string,
  source: GhcrPackageCredentials["source"],
  accounts: readonly GitHubIdentityAccount[],
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): { message: string; remediation: RemediationView | null } {
  const missing = `The GitHub account @${login} is missing the "write:packages" scope required to create this repository's private Radius state package in GHCR.`;
  if (source === "injected-token") {
    const alternative =
      accounts.find(
        (a) => a.switchable && a.hasPackages && a.login !== login
      ) || null;
    const preamble = `${missing} That credential is the Copilot session token, which overrides stored gh logins, so "gh auth refresh" cannot add the scope to it. `;
    if (alternative) {
      // Switching accounts happens in the dialog, so there is no command here.
      return {
        message: `${preamble}Select the stored account @${alternative.login} in the Create Environment dialog, then retry.`,
        remediation: null
      };
    }
    const login_ = presentedRemediationView(
      "github-cli-login",
      { packages: "true" },
      ghCommandPresentation
    );
    return {
      message:
        preamble +
        (login_.runnable ?
          "Run the command below to sign in a stored account that can publish packages, then retry."
        : `${ghCommandPresentation.installationNote} Then sign in a stored account that can publish packages and retry.`),
      remediation: login_.runnable ? login_ : null
    };
  }
  // Build the command from the remediation registry rather than by hand. A
  // hand-written copy drifts from what the Copy/Run buttons offer and misses
  // registry-wide rules -- notably one command per line, because `&&` does not
  // parse in Windows PowerShell 5.1.
  const fix = presentedRemediationView(
    "github-account-scopes",
    {
      login,
      packages: "true"
    },
    ghCommandPresentation
  );
  const grant =
    fix.runnable ?
      "Run the command below (or switch to an account that has it in the Create Environment dialog), then retry."
    : `Grant @${login} the read:packages and write:packages scopes with GitHub CLI (or switch to an account that has them in the Create Environment dialog), then retry.`;
  const accountSwitchWarning =
    fix.runnable ?
      ` This will make @${login} the active GitHub CLI account if it is not already active. Note: gh auth switch changes your machine's active GitHub account for every tool in this terminal until you switch back.`
    : "";
  return {
    message: `${missing} ${grant}${accountSwitchWarning}`,
    remediation: fix.runnable ? fix : null
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
  return resolveEnvironmentDeployment(repo, environment, appName, {
    ghOrThrow,
    deployWorkflowFile: DEPLOY_WORKFLOW_FILE,
    deleteWorkflowFile: DELETE_WORKFLOW_FILE,
    maxParallelRecords: DEPLOY_MAX_PARALLEL_RECORDS
  });
}

/**
 * Best-effort delete of the legacy `.github/workflows/radius-deploy.yml` from a
 * target repo. No-op when the file is absent. Self-contained (uses cliExec) so
 * it can be called from any request handler regardless of its local gh runner.
 */
async function deleteLegacyDeployWorkflow(
  targetRepo: string,
  executor?: SelectedGhExecutor,
  beforeDelete?: () => Promise<boolean>,
  branch?: string
): Promise<boolean | "cancelled"> {
  const path = ".github/workflows/" + LEGACY_DEPLOY_WORKFLOW_FILE;
  const contentPath =
    "/repos/" +
    targetRepo +
    "/contents/" +
    path +
    (branch ? "?ref=" + encodeURIComponent(branch) : "");
  if (executor) {
    const lookup = await executor.run(["api", contentPath, "--jq", ".sha"], {
      timeout: 30000
    });
    const sha = lookup.code === 0 ? lookup.stdout.trim() : "";
    if (!sha) return false;
    if (beforeDelete && !(await beforeDelete())) return "cancelled";
    // Answering `true` for a DELETE that failed would report a removal that did
    // not happen, and the legacy workflow would keep double-triggering
    // alongside the new dispatcher with nothing saying so.
    const removed = await executor.run(
      [
        "api",
        "--method",
        "DELETE",
        "/repos/" + targetRepo + "/contents/" + path,
        "-f",
        "message=Remove legacy Radius deploy workflow (replaced by run-rad-commands.yml)",
        "-f",
        "sha=" + sha,
        ...(branch ? ["-f", "branch=" + branch] : [])
      ],
      { timeout: 30000 }
    );
    return removed.code === 0 || removed.code === "0";
  }
  return new Promise((resolve, reject) => {
    cliExec(
      "gh",
      ["api", contentPath, "--jq", ".sha"],
      { timeout: 30000 },
      (err, stdout) => {
        const sha = err ? "" : (stdout || "").trim();
        if (!sha) {
          resolve(false);
          return;
        }
        void (async () => {
          if (beforeDelete && !(await beforeDelete())) {
            resolve("cancelled");
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
              "sha=" + sha,
              ...(branch ? ["-f", "branch=" + branch] : [])
            ],
            { timeout: 30000 },
            (deleteErr) => resolve(!deleteErr)
          );
        })().catch(reject);
      }
    );
  });
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
  branch: string,
  reader: SelectedRepositoryReader = github
): Promise<{
  content: string | null;
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
}> {
  return fetchSelectedBicep(entry.state, repo, branch, reader);
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

export type EnvironmentDeletionCoordinatorPorts = Omit<
  EnvironmentDeletionPorts,
  "reportStatePackageDeletionFailure"
>;

function productionEnvironmentDeletionPorts(): EnvironmentDeletionCoordinatorPorts {
  return {
    deleteRadiusEnvironment: (input, onHeartbeat) =>
      deleteRadiusEnvironmentViaWorkflow(
        input.repo,
        input.environment,
        onHeartbeat
      ),
    runAz: (args) => runCliCommand("az", args),
    readAzureIdentity: async (clientId) => {
      const tenant = await runCliCommand("az", [
        "account",
        "show",
        "--query",
        "tenantId",
        "-o",
        "tsv"
      ]);
      if (tenant.code !== 0 || !tenant.stdout.trim()) {
        throw new Error(
          tenant.stderr || "Could not resolve the active Entra tenant."
        );
      }
      const application = await runCliCommand("az", [
        "ad",
        "app",
        "show",
        "--id",
        clientId,
        "--query",
        "id",
        "-o",
        "tsv"
      ]);
      if (application.code !== 0 || !application.stdout.trim()) {
        throw new Error(
          application.stderr ||
            "Could not resolve the App Registration object id."
        );
      }
      return {
        tenantId: tenant.stdout.trim(),
        applicationObjectId: application.stdout.trim()
      };
    },
    deleteGitHubEnvironment: (input) =>
      deleteGitHubEnvironmentIdempotent(input.repo, input.environment),
    deleteStatePackage: createStatePackageDeletion({
      stateRegistryForEnvironment,
      getCredentials: getGhPackageCredentials,
      deletePackage: deleteGHCRStatePackage,
      ghCommandPresentation: GH_COMMAND_PRESENTATION
    }),
    withCredentialProvenanceLock,
    readCredentialProvenance: (clientId) =>
      listCredentialProvenanceForClient(clientId),
    removeCredentialProvenance: (clientId, credentialId) =>
      removeCredentialProvenance(clientId, credentialId),
    clearEnvironmentCredentialProvenance: (repoId, environment) =>
      clearEnvironmentCredentialProvenance(repoId, environment),
    persist: () => operations.persist(),
    errorMessage,
    log: (message) => console.error(message)
  };
}

export interface EnvironmentOperationExecutionDependencies {
  executionOwner: EnvironmentExecutionOwner;
  scope: ReturnType<EnvironmentExecutionOwner["attachRuntime"]>;
  accountContext: EnvironmentAccountContext;
  setupServices: SetupServices;
  verificationStatus(
    input: VerificationStatusInput
  ): Promise<VerificationStatusResult>;
  admitRecoveryRollback(operationId: string): Promise<void>;
  presentation?: { instanceId: string };
  environmentOperationRunner?: EnvironmentOperationRunner;
  runDeletion?(
    operation: Parameters<typeof runEnvironmentDeletion>[0]
  ): Promise<void>;
}

async function admitRecoveryRollback(
  control: OperationControlService,
  operationId: string,
  instanceId?: string
): Promise<void> {
  const result = await control({
    instanceId,
    operationId,
    command: "rollback"
  });
  if (result.status >= 400) {
    throw new Error(
      typeof result.body.error === "string" ?
        result.body.error
      : `Operation control failed with status ${result.status}.`
    );
  }
}

export function createEnvironmentOperationExecution(
  dependencies: EnvironmentOperationExecutionDependencies
) {
  const {
    executionOwner,
    accountContext,
    setupServices,
    scope: attachment
  } = dependencies;
  const instanceId = dependencies.presentation?.instanceId;
  if (!accountContext)
    throw new Error("Missing request coordinator dependency: accountContext");
  for (const name of ["authorizeAzure", "configureEnvironment"] as const) {
    if (typeof setupServices?.[name] !== "function") {
      throw new Error(
        `Missing request coordinator dependency: setupServices.${name}`
      );
    }
  }
  if (typeof dependencies.verificationStatus !== "function") {
    throw new Error(
      "Missing request coordinator dependency: verificationStatus"
    );
  }
  const githubAccountCoordinator = accountContext.coordinator;

  // Every server-owned runner saves through the same registry and reports
  // through the same diagnostic channel, so the wiring is bound once rather
  // than rebuilt at each write.
  const saveOperation = (operation: any): Promise<boolean> =>
    persistBestEffort({
      operation,
      persist: () => operations.persist(),
      report: (diagnostic) => operations.report?.(diagnostic)
    });

  const execution = createSetupExecution({
    scope: attachment,
    getOperation: (operationId) => operations.get(operationId),
    persist: () => operations.persist(),
    report: (diagnostic) => operations.report?.(diagnostic),
    isShuttingDown: (operationId) =>
      attachment.isShuttingDown() ||
      (operations.get(operationId)?.kind === "delete" &&
        executionOwner.isShuttingDown(instanceId)),
    deferRecovery: queueMicrotask,
    admitRecoveryRollback: dependencies.admitRecoveryRollback,
    claimVerificationMonitor: executionOwner.claimVerificationMonitor,
    runOperation: runEnvironmentOperation,
    runVerificationRetry,
    runVerificationContinuation: runRecoveredVerificationContinuation,
    observeRecoveredVerification: (operation) =>
      monitorVerificationAsSelectedAccount(operation, (executor) =>
        resolveRecoveredVerificationRun(operation, executor)
      ),
    runCleanup: runCleanupCommand,
    recoverBranchDelete: runRecoveredBranchDelete,
    recoverCleanup: runRecoveredCleanup
  });

  async function monitorVerification(operationId: string): Promise<void> {
    const initialOperation = operations.get(operationId);
    const deadline = verificationTrackingDeadline(
      initialOperation || { operationId },
      Date.now
    );
    const observation = createWorkflowObservationScope(
      createDeployStatusReader
    );
    const stopListening = executionOwner.onShutdown(() => observation.stop());
    try {
      await monitorSetupVerification(deadline, {
        current: () => {
          if (attachment.isShuttingDown()) return undefined;
          const op = operations.get(operationId);
          return op ?
              {
                active: !op.endedAt && op.currentStage === STAGE_VERIFY,
                stopRequested: shouldStop(op)
              }
            : undefined;
        },
        observe: async () => {
          const op = operations.get(operationId);
          const outcome = await dependencies.verificationStatus({
            repo: op?.repo || "",
            environment: op?.environment,
            operationId,
            observation
          });
          if (outcome.status < 200 || outcome.status >= 300) {
            throw new Error(
              outcome.body.error ||
                `Verification status failed with HTTP ${outcome.status}.`
            );
          }
          return outcome.body;
        },
        stop: async () => {
          const op = operations.get(operationId);
          if (!op) return;
          stopAtBoundary(op, "verification-observation", { announce: false });
          const saved = await saveOperation(op);
          if (saved) announceOperationTerminal(op);
        },
        expire: async (message) => {
          const op = operations.get(operationId);
          if (!op || op.endedAt) return;
          finish(op, "failed_partial", {
            failure: {
              code: "verification-tracking-expired",
              stage: op.currentStage,
              stepSeq: null,
              message,
              classification: "user-fixable",
              evidence: null
            }
          });
          await saveOperation(op);
        },
        now: Date.now,
        sleep: (milliseconds) => observation.delay(milliseconds),
        jitter: () => Math.floor(Math.random() * 1000)
      });
    } finally {
      stopListening();
      observation.stop();
    }
  }

  async function monitorVerificationAsSelectedAccount(
    op: any,
    beforeMonitor?: (executor: SelectedGhExecutor) => Promise<boolean>
  ): Promise<void> {
    const observation = createWorkflowObservationScope(
      createDeployStatusReader
    );
    const stopListening = executionOwner.onShutdown(() => observation.stop());
    try {
      await monitorVerificationWithSelectedAccount(op, {
        isStopped: attachment.isShuttingDown,
        createExecutor: (login) =>
          githubAccountCoordinator.createReadOnlyExecutor(login),
        registerExecutor: (operationId, executor) =>
          accountContext.registerExecutor(operationId, executor),
        beforeMonitor,
        monitor: monitorVerification,
        accountUnavailable: async (operation, login, detail) => {
          operation.verification = {
            ...(operation.verification || {}),
            accountUnavailablePhase:
              operation.verification?.runId ? "monitor" : "dispatch"
          };
          const account = login ? `@${login}` : "the saved GitHub account";
          addLegacyStep(
            operation,
            `❌ Could not use ${account} to resume credential verification.`
          );
          finish(operation, "failed_partial", {
            failure: {
              code:
                login ?
                  "verification-retry-github-account-unavailable"
                : "verification-retry-github-account-missing",
              stage: STAGE_VERIFY,
              stepSeq: null,
              message:
                login ?
                  `Radius could not use @${login} to resume credential verification. Re-check that account and retry verification.`
                : "Radius cannot resume credential verification because this operation has no saved GitHub account. Start a new environment setup.",
              classification: "user-fixable",
              evidence: detail
            }
          });
          await saveOperation(operation);
        },
        trackingExpired: async (operation, expiration) => {
          const copy = verificationAcquisitionExpiredCopy("resume", expiration);
          finish(operation, "failed_partial", {
            failure: {
              code: "verification-tracking-expired",
              stage: STAGE_VERIFY,
              stepSeq: null,
              message: copy.message,
              classification: "user-fixable",
              evidence: expiration.detail
            }
          });
          await saveOperation(operation);
        },
        isRateLimitError: (error) => isGitHubRateLimitError(error),
        now: Date.now,
        sleep: (milliseconds) => observation.delay(milliseconds),
        errorMessage
      });
    } finally {
      stopListening();
      observation.stop();
    }
  }

  async function runEnvironmentOperation(operationId: string): Promise<void> {
    if (dependencies.environmentOperationRunner) {
      await dependencies.environmentOperationRunner(operationId);
      return;
    }
    const op = operations.get(operationId);
    if (!op) return;
    if (op.kind === "delete") {
      if (!dependencies.runDeletion) {
        throw new Error(
          "Environment deletion requires the server-ready deletion runner."
        );
      }
      await dependencies.runDeletion(op);
      return;
    }
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
    let releaseExecutor: (() => void) | undefined;
    try {
      const setup = await githubAccountCoordinator.withSelectedAccount(
        selectedLogin,
        { ownerKey: accountContext.ownerKey, operationId },
        async (executor) => {
          releaseExecutor = accountContext.registerExecutor(
            operationId,
            executor
          );
          if (attachment.isShuttingDown()) return { shouldMonitor: false };
          return runEnvironmentOperationWorkflow(op, executor, {
            preflightRepoAdmin: (repo, selectedExecutor) =>
              preflightRepoAdmin(
                repo,
                selectedExecutor,
                GH_COMMAND_PRESENTATION
              ),
            guardStopBoundary: (operation, boundary) =>
              attachment.isShuttingDown() ?
                Promise.resolve(false)
              : honorStopBoundary({
                  operation,
                  boundary,
                  persist: () => operations.persist(),
                  report: (diagnostic) => operations.report?.(diagnostic)
                }),
            preflightGhcrPackageWriteAccess: (selectedExecutor) =>
              preflightGhcrPackageWriteAccess(
                getGhPackageCredentials,
                getGitHubIdentity,
                selectedExecutor,
                GH_COMMAND_PRESENTATION
              ),
            readGitHubJson: (apiPath, selectedExecutor) =>
              runGitHubJsonRequest(apiPath, selectedExecutor),
            setCanonicalEnvironment: (operation, environment) => {
              setCanonicalEnvironment(operation, environment);
            },
            recordGitHubEnvironment: (operation, patch) => {
              recordGitHubEnvironment(operation, patch);
            },
            promoteCreatedGitHubEnvironment: (operation, identity) =>
              promoteCreatedGitHubEnvironment(operation, identity),
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
                    },
                    readEnvironment: selectedEnvironmentReader(executor)
                  });
                }
              }),
            persistProviderMutation: () => operations.persist(),
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
                },
                readEnvironment: selectedEnvironmentReader(selectedExecutor)
              });
            },
            getOperation: (id) => operations.get(id),
            instanceId,
            setupServices: {
              authorizeAzure: (request) => {
                if (attachment.isShuttingDown())
                  throw new Error("Setup execution is shutting down.");
                return setupServices.authorizeAzure(request);
              },
              configureEnvironment: (request, projectionInstanceId) => {
                if (attachment.isShuttingDown())
                  throw new Error("Setup execution is shutting down.");
                return setupServices.configureEnvironment(
                  request,
                  projectionInstanceId,
                  attachment.isCurrent
                );
              }
            },
            now: () => Date.now()
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
      await saveOperation(op);
      if (!setup.value.shouldMonitor) return;
      await monitorVerification(operationId);
    } catch (error) {
      if (!(error instanceof ProviderMutationRecoveryError)) {
        const unresolved = unresolvedProviderMutations(op)[0];
        if (unresolved) {
          await recordProviderReconciliationFailure(
            op,
            unresolved,
            () => operations.persist(),
            error
          );
        }
      }
      throw error;
    } finally {
      releaseExecutor?.();
    }
  }

  /**
   * Repeat verification against the exact workflow identity Radius saved.
   *
   * Two different failures land here: the workflow is not installed until the
   * setup pull request merges, and an Azure role assignment can take minutes to
   * propagate. Both are fixed by running the same workflow again on the same
   * branch for the same environment — never by recreating the environment, and
   * never by adopting some other run that happens to be in the repository.
   */
  async function runVerificationRetry(
    operationId: string,
    commandId: string
  ): Promise<void> {
    if (dependencies.environmentOperationRunner) {
      await dependencies.environmentOperationRunner(operationId, commandId);
      return;
    }

    const operation = operations.get(operationId);
    if (!operation) return;
    const observation = createWorkflowObservationScope(
      createDeployStatusReader
    );
    const stopListening = executionOwner.onShutdown(() => observation.stop());
    try {
      await runSelectedVerificationRetry(operation, commandId, {
        isStopped: attachment.isShuttingDown,
        createExecutor: (login) =>
          githubAccountCoordinator.createReadOnlyExecutor(login),
        registerExecutor: (id, executor) =>
          accountContext.registerExecutor(id, executor),
        stopBoundary: ({ operation: target, boundary, beforePersist }) =>
          attachment.isShuttingDown() ?
            Promise.resolve(false)
          : honorStopBoundary({
              operation: target,
              boundary,
              persist: () => operations.persist(),
              report: (diagnostic) => operations.report?.(diagnostic),
              beforePersist
            }),
        buildDispatchArgs: buildVerifyWorkflowDispatchArgs,
        selectedCommandAuthorizationError,
        isAuthorizationError: isSelectedGhAuthorizationError,
        isRateLimitError: isGitHubRateLimitError,
        now: Date.now,
        sleep: (milliseconds) => observation.delay(milliseconds),
        verifyWorkflowFile: VERIFY_WORKFLOW_FILE,
        stageVerify: STAGE_VERIFY,
        addStep: (target, text, stage) => addLegacyStep(target, text, stage),
        setCommandState,
        finish,
        persist: saveOperation,
        persistJournal: () => operations.persist(),
        monitor: monitorVerification,
        currentState: (id) => operations.get(id)?.state || null,
        errorMessage
      });
    } finally {
      stopListening();
      observation.stop();
    }
    return;
  }

  async function runRecoveredVerificationContinuation(
    operationId: string,
    commandId: string
  ): Promise<void> {
    if (dependencies.environmentOperationRunner) {
      await dependencies.environmentOperationRunner(operationId, commandId);
      return;
    }
    const operation = operations.get(operationId);
    if (!operation) return;
    await monitorVerificationAsSelectedAccount(operation, (executor) =>
      resolveRecoveredVerificationRun(operation, executor)
    );
    if (attachment.isShuttingDown()) return;
    setCommandState(
      operation,
      commandId,
      "finished",
      isTerminalState(operation.state) ? operation.state : "monitoring"
    );
    await saveOperation(operation);
  }

  /**
   * Delete the selected resources this attempt created, before the commit point.
   *
   * Deletion runs in reverse dependency order: the GitHub environment first,
   * then the Azure role assignments, federated credentials, Service Principal,
   * and finally the App Registration everything else hangs off. Each result is
   * written to the ledger and persisted before the next deletion starts, so an
   * interrupted pass still reports exactly what it removed.
   */
  async function runCleanupCommand(
    kind: CleanupCommandKind,
    operationId: string,
    commandId: string
  ): Promise<void> {
    if (dependencies.environmentOperationRunner) {
      await dependencies.environmentOperationRunner(operationId, commandId);
      return;
    }
    const op = operations.get(operationId);
    if (!op || op.endedAt) return;
    const recoveryBeforeCleanup = cleanupProviderRecoveryDisposition(op);
    if (!recoveryBeforeCleanup.mayStartDestructiveCleanup) {
      throw new Error(
        "Provider mutations must be reconciled before cleanup can continue."
      );
    }
    const command = CLEANUP_COMMANDS[kind];
    const selected = command.selectTargets(op);
    const ledger = getSetupArtifactLedger(op);
    const priorResults: SetupCleanupResult[] =
      Array.isArray(ledger?.cleanup?.results) ?
        [...ledger.cleanup.results]
      : [];
    const attempt = Number(ledger?.cleanup?.attempts || 0) + 1;
    const steps: string[] = [];
    const persist = async (): Promise<void> => {
      await saveOperation(op);
    };
    const warnings: string[] = [];
    let results: SetupCleanupResult[] = [];
    const carriedResults = () => [
      ...priorResults.filter((entry) => entry.attempt < attempt),
      ...results
    ];
    const cleanupGitHub = await resolveCleanupGitHubContext({
      targets: selected,
      selectedLogin: optionalString(op.context?.githubLogin)
    });

    // The workflow files come first and gate everything after them. Removing
    // the GitHub environment or the cloud identity while an installed workflow
    // still references them would leave the repository with a job that fails at
    // Azure Login rather than one that is simply gone, so a workflow pass that
    // cannot finish stops the whole rollback here.
    const workflowPass = await rollbackCommittedWorkflowFiles(op, {
      attempt,
      ports: createWorkflowRollbackPorts(cleanupGitHub.rollbackCommand),
      only: new Set<string>(
        selected
          .filter(
            (entry: { artifactType: string }) =>
              entry.artifactType === "workflow_file"
          )
          .map((entry: { key: string }) => entry.key)
      ),
      steps
    });
    if (workflowPass.attempted) {
      warnings.push(...workflowPass.warnings);
      results = [...results, ...workflowPass.results];
      recordCleanupState(op, { state: "running", results: carriedResults() });
      await persist();
      if (workflowPass.blocked) {
        for (const step of steps) addLegacyStep(op, step);
        recordCleanupState(op, {
          attempts: attempt,
          state: "succeeded_with_warnings",
          results: carriedResults()
        });
        setCommandState(op, commandId, "finished", "blocked");
        finish(op, "failed_partial", {
          failure: {
            code: "setup-rollback-blocked",
            stage: op.currentStage,
            stepSeq: null,
            message:
              "Radius could not prove every committed workflow file is still the file it wrote, so it removed nothing and kept the environment and credentials in place.",
            classification: "user-fixable",
            evidence: null
          }
        });
        await persist();
        return;
      }
    }

    const variablePass = await rollbackGitHubEnvironmentVariableArtifacts(op, {
      attempt,
      run: async (args) => {
        const result = await cleanupGitHub.rollbackCommand({ args });
        return {
          code: result.ok ? 0 : 1,
          stdout: result.stdout,
          stderr: result.stderr
        };
      },
      persist,
      only: new Set<string>(
        selected
          .filter(
            (entry: { artifactType: string }) =>
              entry.artifactType === "github_environment_variable"
          )
          .map((entry: { key: string }) => entry.key)
      ),
      steps
    });
    if (variablePass.attempted) {
      warnings.push(...variablePass.warnings);
      results = [...results, ...variablePass.results];
      recordCleanupState(op, { state: "running", results: carriedResults() });
      await persist();
      if (variablePass.blocked) {
        for (const step of steps) addLegacyStep(op, step);
        recordCleanupState(op, {
          attempts: attempt,
          state: "succeeded_with_warnings",
          results: carriedResults()
        });
        setCommandState(op, commandId, "finished", "blocked");
        finish(op, "failed_partial", {
          failure: {
            code: "setup-variable-rollback-blocked",
            stage: op.currentStage,
            stepSeq: null,
            message:
              "Radius could not safely restore every GitHub environment variable, so it left the environment and credentials in place.",
            classification: "user-fixable",
            evidence: null
          }
        });
        await persist();
        return;
      }
    }

    // A GitHub environment can be one of the selected targets, and skipping it
    // here would report a clean removal while the environment survived.
    if (
      selected.some(
        (entry: { artifactType: string }) =>
          entry.artifactType === "github_environment"
      )
    ) {
      const environmentCleanup = await cleanupGitHubEnvironmentArtifact(op, {
        attempt,
        runDeleteEnvironment: cleanupGitHub.deleteEnvironment,
        readEnvironment: cleanupGitHub.readEnvironment,
        persistJournal: () => operations.persist(),
        invalidateEnvironmentListing: (repo) => {
          envListCache.invalidate(repo);
        },
        steps
      });
      warnings.push(...environmentCleanup.warnings);
      results = [...results, ...environmentCleanup.results];
      if (environmentCleanup.results.length > 0) {
        // The attempt counter stays where it is until the Azure pass claims it,
        // so both passes record against the same cleanup attempt.
        recordCleanupState(op, { state: "running", results: carriedResults() });
        await persist();
      }
    }

    const runAz = (args: string[]): Promise<CommandResult> =>
      runCliCommand("az", args);
    const azureCleanup = await cleanupAzureSetupArtifacts(op, {
      runAz,
      steps,
      only: new Set<string>(
        selected
          .filter(
            (entry: { artifactType: string }) =>
              entry.artifactType !== "github_environment" &&
              entry.artifactType !== "github_environment_variable"
          )
          .map((entry: { key: string }) => entry.key)
      ),
      onResultRecorded: persist,
      persistJournal: () => operations.persist()
    });
    warnings.push(...azureCleanup.warnings);
    results = [...results, ...azureCleanup.results];

    for (const step of steps) addLegacyStep(op, step);
    // A deletion this pass issued and could not settle has nobody left to
    // settle it: the record is about to end, and every scheduler that would
    // reread it is gated on a live operation. Leaving it merely unresolved
    // would hold the repository behind an entry no command can clear, so it is
    // handed to the customer by name instead. The delete is still never
    // repeated — `manual_required` refuses that as firmly as `outcome_unknown`.
    quarantineUnsettledCleanupDeletions(op);
    const recoveryAfterCleanup = cleanupProviderRecoveryDisposition(op);
    if (!recoveryAfterCleanup.mayCompleteCleanup) {
      recordCleanupState(op, {
        attempts: azureCleanup.attempt,
        state: "pending",
        results: carriedResults()
      });
      setCommandState(
        op,
        commandId,
        "finished",
        "provider-reconciliation-pending"
      );
      finish(op, "failed_partial", {
        failure: {
          code: "provider-reconciliation-pending",
          stage: op.currentStage,
          stepSeq: null,
          message:
            "Cleanup could not finish because one or more provider mutation outcomes are still unresolved.",
          classification: "user-fixable",
          evidence: recoveryAfterCleanup.blockers
            .map((mutation) => `${mutation.kind} for ${mutation.target}`)
            .join("; ")
        }
      });
      await persist();
      return;
    }
    // The browser reloads the environment table the moment this record turns
    // terminal, and that reload is answered from the repo-scoped listing cache.
    // Invalidating here — before `finish`, not only where the deletion happened
    // — means the reload cannot be answered from a listing assembled before the
    // removal, so a completed rollback never hands the customer back the
    // environment it just removed.
    const cleanupRepo = String(op.repo || "");
    if (cleanupRepo !== "" && cleanupRemovedGitHubEnvironment(results)) {
      envListCache.invalidate(cleanupRepo);
    }
    recordCleanupState(op, {
      attempts: azureCleanup.attempt,
      state: warnings.length ? "succeeded_with_warnings" : "succeeded",
      results: carriedResults()
    });
    if (
      kind === "rollback" &&
      op.providerRecovery?.state === "rollback_pending"
    ) {
      op.providerRecovery.state = "complete";
      op.recoveryState = null;
    }
    setCommandState(
      op,
      commandId,
      "finished",
      warnings.length ? "warnings" : command.cleanedOutcome
    );
    if (warnings.length > 0) {
      finish(op, "failed_partial", {
        failure: {
          code: "setup-cleanup-incomplete",
          stage: op.currentStage,
          stepSeq: null,
          message: command.incompleteMessage,
          classification: "user-fixable",
          evidence: null
        }
      });
    } else {
      finish(op, "cancelled", {
        terminal: {
          reason: command.terminalReason,
          userMessage: command.cleanedMessage
        }
      });
    }
    await persist();
  }

  /**
   * Settle an unresolved setup-branch deletion before anything else runs.
   *
   * This is the one recovery that cannot be folded into the others. Running the
   * setup forward would rebuild against a branch whose fate is unknown, and
   * running the rollback would report a cleanup that skipped the branch it was
   * supposed to remove first. Both are resolved here, or the record ends saying
   * plainly that the branch is the customer's to remove.
   */
  async function runRecoveredBranchDelete(operationId: string): Promise<void> {
    const op = operations.get(operationId);
    if (!op) return;
    const mutation = pendingBranchDelete(op);
    if (!mutation) return;
    // The branch belongs to the account that created it. An ambient `gh` here
    // would read the repository as whoever the CLI happens to be logged in as,
    // and a 404 from the wrong identity is exactly the answer this recovery
    // must never mistake for "the branch is gone".
    const selectedLogin =
      typeof op.context?.githubLogin === "string" ?
        op.context.githubLogin.trim()
      : "";
    let executor: SelectedGhExecutor;
    try {
      if (!selectedLogin) {
        throw new Error(
          "The operation record does not name the GitHub account that created the setup branch."
        );
      }
      executor =
        await githubAccountCoordinator.createReadOnlyExecutor(selectedLogin);
      await executor.verifyIdentity();
    } catch (error) {
      await failRecoveredBranchDelete(
        op,
        "setup-branch-delete-unresolved",
        "Radius could not use the GitHub account that created the recovered setup branch, so it still cannot say whether its deletion took effect: " +
          `${errorMessage(error)}. It changed nothing further.`
      );
      return;
    }
    const outcome = await reconcileRecoveredBranchDelete({
      operation: op,
      mutation,
      readBranchRef: (repo, branch) =>
        executor.run(branchRefReadArgs(repo, branch)),
      // The same permission the 404 came from. Matching-refs answers with every
      // ref sharing the prefix, so the account either can see this repository's
      // refs — in which case the branch's absence from the listing is real — or
      // cannot, in which case nothing is concluded.
      listBranchRefs: (repo, branch, page) =>
        executor.run(branchRefListingArgs(repo, branch, page))
    });
    if (outcome.state === "removed") {
      addLegacyStep(op, `✅ ${outcome.evidence}`);
      // `operations.persist` rather than the best-effort save: a command a
      // runner executes but no reload can find is the one shape that lets the
      // same deletion be scheduled again after the next restart.
      const plan = await planRecoveredCleanup({
        operation: op,
        persist: () => operations.persist()
      });
      if (plan.state === "resume" || plan.state === "start") {
        if (plan.state === "start") {
          addLegacyStep(
            op,
            "⏳ Deleting the resources this interrupted setup created."
          );
        }
        await saveOperation(op);
        await runCleanupCommand(plan.kind, operationId, plan.commandId);
        return;
      }
      // Nothing is left to remove, or a provider answer is still outstanding.
      // The record has to become terminal either way so the panel stops showing
      // work nothing will do, and so the refusal the gates already compute is
      // the one the customer reads.
      finish(op, "failed_partial", {
        failure: {
          code: "setup-branch-removed-pending-rollback",
          stage: op.currentStage,
          stepSeq: null,
          message:
            plan.state === "blocked" ?
              `Radius removed the setup branch an interrupted attempt had created, but it cannot remove anything else yet. ${plan.detail}`
            : "Radius removed the setup branch an interrupted attempt had created. Nothing else from this attempt is left to remove.",
          classification: "user-fixable",
          evidence: null
        }
      });
      await saveOperation(op);
      return;
    }
    addLegacyStep(op, `⚠️ ${outcome.guidance}`);
    await failRecoveredBranchDelete(
      op,
      outcome.state === "unreadable" ?
        "setup-branch-delete-unresolved"
      : "setup-branch-delete-manual-required",
      outcome.guidance,
      { announced: true }
    );
  }

  /**
   * End a recovered branch delete that could not be settled.
   *
   * The blocker is written to the provider recovery record as well as the
   * failure, because the recovery state is what the destructive gates read: a
   * failure message alone would still leave Rollback and Exit on offer for a
   * record whose setup branch may still be in the repository.
   */
  async function failRecoveredBranchDelete(
    op: any,
    code: string,
    guidance: string,
    { announced = false }: { announced?: boolean } = {}
  ): Promise<void> {
    if (!announced) addLegacyStep(op, `⚠️ ${guidance}`);
    if (op.providerRecovery) {
      op.providerRecovery.state = "manual_required";
      op.providerRecovery.guidance = guidance;
    }
    finish(op, "failed_partial", {
      failure: {
        code,
        stage: op.currentStage,
        stepSeq: null,
        message: guidance,
        classification: "user-fixable",
        evidence: null
      }
    });
    await saveOperation(op);
  }

  /**
   * Run the deletion a reconciled operation decided on, opening one if needed.
   *
   * Reconciliation reaching `rollback_pending` is a decision, not a command:
   * without a durable command behind it the record would sit running with no
   * pass to execute and no entry the panel could name. Resolving it here keeps
   * that decision and the command that carries it out in one place, whether the
   * pass was already in flight when the process went away or has to be opened.
   */

  /**
   * Read back the exact identity of every deletion this operation left open.
   *
   * Restricted to artifacts whose journal entry is still unresolved, because a
   * cleanup executor asked about an artifact with no entry would delete it.
   * For the ones it is asked about, `executeRecoverableMutation` takes the
   * reconcile branch — the delete is never issued a second time — so this
   * settles them from provider state alone.
   */
  async function reconcileUnsettledCleanupDeletions(op: any): Promise<void> {
    const unsettled = new Set(
      unresolvedProviderMutations(op)
        .filter((mutation) => isCleanupDeletionKind(mutation.kind))
        .map((mutation) => mutation.mutationId)
    );
    if (unsettled.size === 0) return;
    const targets = provenOwnedCleanupTargets(op).filter((target: any) =>
      unsettled.has(
        providerMutationId(
          op.operationId,
          cleanupDeletionKind(String(target.artifactType)),
          String(target.identity ?? "")
        )
      )
    );
    if (targets.length === 0) return;
    const steps: string[] = [];
    const selectedLogin = optionalString(op.context?.githubLogin);
    if (
      targets.some(
        (target: any) => target.artifactType === "github_environment"
      )
    ) {
      const cleanupGitHub = await resolveCleanupGitHubContext({
        targets,
        selectedLogin
      });
      await cleanupGitHubEnvironmentArtifact(op, {
        attempt: Number(getSetupArtifactLedger(op)?.cleanup?.attempts || 1),
        runDeleteEnvironment: cleanupGitHub.deleteEnvironment,
        readEnvironment: cleanupGitHub.readEnvironment,
        persistJournal: () => operations.persist(),
        invalidateEnvironmentListing: (repo) => {
          envListCache.invalidate(repo);
        },
        steps
      });
    }
    const azureKeys = new Set<string>(
      targets
        .filter((target: any) => target.artifactType !== "github_environment")
        .map((target: any) => String(target.key))
    );
    if (azureKeys.size > 0 && op.provider === "azure") {
      await cleanupAzureSetupArtifacts(op, {
        runAz: (args: string[]) => runCliCommand("az", args),
        steps,
        only: azureKeys,
        persistJournal: () => operations.persist()
      });
    }
    for (const step of steps) addLegacyStep(op, step);
    await saveOperation(op);
  }

  async function runRecoveredCleanup(operationId: string): Promise<void> {
    const op = operations.get(operationId);
    if (!op || op.endedAt) return;
    // Settle the deletions this operation already issued before deciding
    // anything else. The executors reconcile a journaled entry by reading its
    // exact identity and never reissue it, so this is the reconciliation the
    // resume gate is waiting on rather than another pass over the ledger.
    await reconcileUnsettledCleanupDeletions(op);
    const plan = await planRecoveredCleanup({
      operation: op,
      persist: () => operations.persist()
    });
    if (plan.state === "resume" || plan.state === "start") {
      await runCleanupCommand(plan.kind, operationId, plan.commandId);
      return;
    }
    // Nothing executable is left. Terminalizing is what stops the record from
    // holding the repository open for a pass that will never be scheduled; the
    // destructive gates then decide what, if anything, the customer is offered.
    // A deletion still awaiting an answer is named before that happens, because
    // once the record is terminal nothing will reread it.
    quarantineUnsettledCleanupDeletions(op);
    // A record that was already terminal when recovery reopened it keeps the
    // verdict the customer was shown. Reconciliation names what it could not
    // settle, but a cancellation does not become a failure because a delete it
    // issued lost its answer.
    const priorOutcome = op.reconciliationPriorOutcome;
    finish(op, priorOutcome?.state || "failed_partial", {
      failure: {
        code:
          plan.state === "blocked" ?
            "provider-reconciliation-manual-required"
          : "setup-rollback-nothing-owned",
        stage: op.currentStage,
        stepSeq: null,
        message:
          plan.state === "blocked" ?
            plan.detail
          : "Radius reconciled the interrupted setup and found nothing it can prove it created, so it removed nothing.",
        classification: "user-fixable",
        evidence: null
      }
    });
    delete op.reconciliationPriorOutcome;
    await saveOperation(op);
  }

  /**
   * Give a restarted verification the run identity its dispatch never recorded.
   *
   * The dispatch is journaled before the request goes out and confirmed after
   * GitHub accepts it, so a restart in between leaves a record that knows a run
   * exists and cannot say which one. Monitoring that record polls a null run id
   * until the tracking window closes, which reads as a hung setup. So the run is
   * discovered here first, by the operation-specific marker and nothing weaker,
   * and a record whose workflow never carried a marker is handed to the customer
   * immediately rather than waiting for an identity it can never obtain.
   *
   * Returns whether monitoring should continue.
   */
  async function resolveRecoveredVerificationRun(
    op: any,
    executor: SelectedGhExecutor
  ): Promise<boolean> {
    const identity = readRecoveredVerificationIdentity(
      op,
      VERIFY_WORKFLOW_FILE
    );
    const actionsUrl = verificationActionsUrl(identity.repo, identity.workflow);
    const handOff = async (guidance: string): Promise<boolean> => {
      op.verification = {
        ...(op.verification || {}),
        runId: null,
        runUrl: actionsUrl
      };
      finish(op, "action_required", {
        terminal: { reason: "verification-run-manual", userMessage: guidance }
      });
      await saveOperation(op);
      return false;
    };
    const listArgs = [
      "run",
      "list",
      "--workflow=" + identity.workflow,
      "--limit",
      "10",
      "--json",
      "databaseId,createdAt,displayTitle,event,headBranch",
      "--repo",
      identity.repo
    ];
    let outcome;
    try {
      outcome = await recoverVerificationRun({
        runId: op.verification?.runId,
        identity,
        listRuns: async () => {
          const listed = await executor.run(listArgs, { timeout: 30000 });
          const authorizationError = await selectedCommandAuthorizationError(
            executor,
            identity.repo,
            listed
          );
          if (authorizationError) throw authorizationError;
          return listed;
        },
        isAuthorizationError: isSelectedGhAuthorizationError
      });
    } catch (error) {
      if (!isSelectedGhAuthorizationError(error)) throw error;
      addLegacyStep(
        op,
        `❌ Could not use @${executor.login} to recover credential verification.`
      );
      finish(op, "failed_partial", {
        failure: {
          code: "verification-retry-github-account-unavailable",
          stage: STAGE_VERIFY,
          stepSeq: null,
          message: `Radius could not use @${executor.login} to resume credential verification. Re-check that account and retry verification.`,
          classification: "user-fixable",
          evidence: error.message
        }
      });
      op.verification = {
        ...(op.verification || {}),
        accountUnavailablePhase: "dispatch"
      };
      await saveOperation(op);
      return false;
    }
    if (outcome.state === "monitor") return true;
    if (outcome.state === "hand_off") return handOff(outcome.guidance);
    op.verification = {
      ...(op.verification || {}),
      runId: outcome.runId,
      runUrl: outcome.runUrl
    };
    addLegacyStep(
      op,
      `✅ Recovered the credential verification run this setup dispatched: ${outcome.runUrl}`,
      STAGE_VERIFY
    );
    await saveOperation(op);
    return true;
  }

  return execution;
}

export function createInstanceRequestCoordinator(
  instanceId: string,
  resolveBaseUrl: () => string,
  environmentDeletionPorts: EnvironmentDeletionCoordinatorPorts,
  dependencies: {
    executionOwner: EnvironmentExecutionOwner;
    accountContext: EnvironmentAccountContext;
    setupServices: SetupServices;
    verificationStatus(
      input: VerificationStatusInput
    ): Promise<VerificationStatusResult>;
    operationControl: OperationControlService;
    servers: ReadonlyMap<string, CanvasServerEntry>;
    environmentOperationRunner?: EnvironmentOperationRunner;
  }
) {
  if (typeof dependencies.operationControl !== "function") {
    throw new Error("Missing request coordinator dependency: operationControl");
  }
  const attachment = dependencies.executionOwner.attach(instanceId);
  const deletionAttachment =
    dependencies.executionOwner.attachDeletion(instanceId);
  const scope: typeof attachment = {
    ...attachment,
    schedule(operationId, task) {
      const owner =
        operations.get(operationId)?.kind === "delete" ?
          deletionAttachment
        : attachment;
      owner.schedule(operationId, task);
    }
  };
  const execution = createEnvironmentOperationExecution({
    executionOwner: dependencies.executionOwner,
    accountContext: dependencies.accountContext,
    setupServices: dependencies.setupServices,
    get verificationStatus() {
      return dependencies.verificationStatus;
    },
    get environmentOperationRunner() {
      return dependencies.environmentOperationRunner;
    },
    scope,
    presentation: { instanceId },
    admitRecoveryRollback: (operationId) =>
      admitRecoveryRollback(
        dependencies.operationControl,
        operationId,
        instanceId
      ),
    runDeletion: (operation) =>
      runEnvironmentDeletion(operation, {
        ...environmentDeletionPorts,
        reportStatePackageDeletionFailure: async (input) => {
          const result = await invokeSessionPrompt(
            sessionPromptHandler,
            statePackageDeletionFailureMessage(input)
          );
          if (result.status >= 400) {
            throw new Error(
              result.error ||
                "Could not report the GHCR package deletion failure to Copilot chat."
            );
          }
        }
      })
  });
  const serverOwnedToken = randomUUID();
  const browserMutationNonce = randomUUID();

  function startRecoveredTasks(): void {
    for (const op of operations.all()) {
      if (
        op.kind === "delete" &&
        !op.endedAt &&
        !deletionAttachment.hasTask(op.operationId)
      ) {
        execution.scheduleEnvironmentOperation(op);
      } else {
        execution.recoverOperation(op);
      }
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
    const entry = dependencies.servers.get(instanceId);
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
  return {
    browserMutationNonce,
    handleUnmatchedRequest,
    startRecoveredTasks,
    isServerOwned,
    validateBrowserMutation,
    detach: attachment.detach,
    scheduleEnvironmentOperation: execution.scheduleEnvironmentOperation,
    scheduleCommandTask: execution.scheduleCommandTask
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

export interface ProductionCanvasServerRuntimeOptions {
  executionOwner: EnvironmentExecutionOwner;
  accountContext: EnvironmentAccountContext;
  deploymentOwner: DeploymentExecutionOwner;
  deploymentAccount: DeploymentAccountResolver;
  environmentOperationRunner?: EnvironmentOperationRunner;
  environmentDeletionPorts?: EnvironmentDeletionCoordinatorPorts;
  serverDependencies?: Pick<
    CanvasServerDependencyOverrides,
    | "createHttpServer"
    | "createState"
    | "now"
    | "preferredPort"
    | "prepareIdentity"
  >;
}

export function createProductionCanvasServerRuntime(
  options: ProductionCanvasServerRuntimeOptions
) {
  const {
    executionOwner,
    accountContext,
    deploymentOwner,
    deploymentAccount,
    environmentDeletionPorts,
    serverDependencies
  } = options;
  if (!executionOwner)
    throw new Error("Missing canvas server dependency: executionOwner");
  if (!accountContext)
    throw new Error("Missing canvas server dependency: accountContext");
  if (!deploymentOwner)
    throw new Error("Missing canvas server dependency: deploymentOwner");
  if (typeof deploymentAccount !== "function")
    throw new Error("Missing canvas server dependency: deploymentAccount");
  executionOwner.onShutdown(() => deploymentOwner.shutdown());

  const {
    active: ownedDeploymentMutation,
    reserve: reserveOwnedDeploymentMutation,
    release: releaseOwnedDeploymentMutation
  } = createDeploymentReservationBindings(deploymentOwner);
  const deploymentPresentation = createDeploymentPresentation(deploymentOwner);
  executionOwner.onShutdown(() => deploymentPresentation.dispose());
  const localDeploymentBlocksOwnedMutation = (state: CanvasState): boolean =>
    !deploymentPresentation.owns(state) && localDeploymentBlocksMutation(state);
  const githubAccountCoordinator = accountContext.coordinator;
  const githubAccountReadiness = createGitHubAccountReadinessService(
    githubAccountCoordinator,
    {
      ownerKey: accountContext.ownerKey,
      ghCommandPresentation: GH_COMMAND_PRESENTATION
    }
  );
  function notifyOwnedDeployment(
    entry: { state: CanvasState } | undefined,
    instanceId: string,
    notify: typeof triggerDeployRepairHandoff
  ): boolean {
    const attemptId = entry?.state.deployAttempt?.id;
    if (!attemptId) return false;
    const resolved = deploymentOwner.resolve({ attemptId });
    if (resolved.kind !== "resolved") return false;
    const execution = deploymentOwner.execution(resolved.invocation);
    if (
      !execution ||
      execution.invocation.generation !== entry.state.deployGeneration
    )
      return false;
    const isCurrent = () =>
      deploymentOwner.execution(resolved.invocation) === execution &&
      !execution.observation.stopped;
    const result = notify(execution, instanceId, {
      isCurrent,
      redactDiagnostic: execution.executor.redact,
      publish: () => deploymentOwner.publish(resolved.invocation),
      retry: (callback, milliseconds) => {
        void retryDeploymentDelivery(callback, milliseconds, {
          delay: (delay) => execution.observation.delay(delay),
          isCurrent,
          errorMessage: (error) => execution.executor.errorMessage(error),
          reportError: (message) =>
            console.error("[radius deployment] Delivery retry failed:", message)
        });
      }
    });
    deploymentOwner.publish(resolved.invocation);
    return result;
  }
  const repairOwnedDeployment = (
    entry: { state: CanvasState } | undefined,
    instanceId = ""
  ) => notifyOwnedDeployment(entry, instanceId, triggerDeployRepairHandoff);
  const noticeOwnedDeployment = (
    entry: { state: CanvasState } | undefined,
    instanceId = ""
  ) => notifyOwnedDeployment(entry, instanceId, triggerDeployFailureNotice);
  const githubSelectionHandles = createGitHubSelectionHandleStore();
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
    preflightRepoAdmin: (repo) =>
      preflightRepoAdmin(repo, undefined, GH_COMMAND_PRESENTATION),
    isValidRepoSlug,
    errorMessage
  });
  // Composition root for the migrated `liveness-source` family. The handlers
  // receive only the three seams they use; the open handler is read through a
  // getter so the SDK entry can still register it after construction.
  const livenessSourceRoutes = createLivenessSourceRoutes({
    getOpenSourceHandler: () => openSourceHandler,
    readInstanceState: (instanceId) =>
      canvasServer.instances.get(instanceId)?.state,
    getWorkspaceModelRevision: async (instanceId) => {
      const state = canvasServer.instances.get(instanceId)?.state;
      if (
        !state?.graphFromWorkspace ||
        !state.graphTargetRepo ||
        !state.graphBranch
      ) {
        return null;
      }
      const model = await resolveWorkspaceBicep(
        state,
        state.graphTargetRepo,
        state.graphBranch
      );
      // Model content only: the revision must not move when a staged-artifact
      // fingerprint changes, or every stage would look like a model edit.
      return model ? graphDefinitionHash(model.content, "") : null;
    },
    toSafeRepoRelPath
  });

  // A missing presentation uses the runtime setup runner. An explicitly named
  // attachment that disappeared must still report a miss, never fall back.
  function resolveInstanceRunner(
    instanceId: string | undefined,
    operationId: string
  ): Pick<
    ReturnType<typeof createInstanceRequestCoordinator>,
    "scheduleEnvironmentOperation" | "scheduleCommandTask"
  > | null {
    if (instanceId === undefined) return setupExecution;
    const coordinator = instanceRequestCoordinators.get(instanceId);
    if (!coordinator) {
      console.error(
        `[radius operations] Missing request coordinator for instance ${instanceId}; cannot schedule operation ${operationId}.`
      );
      return null;
    }
    return coordinator;
  }

  function scheduleEnvironmentOperationForInstance(
    instanceId: string | undefined,
    operation: { operationId: string }
  ): boolean {
    const coordinator = resolveInstanceRunner(
      instanceId,
      operation.operationId
    );
    if (!coordinator) return false;
    return coordinator.scheduleEnvironmentOperation(operation);
  }

  // Composition root for the migrated `operations-status` family. Reads, creates,
  // and resumable actions each receive only the registry, mutation, persistence,
  // projection, and per-instance scheduling seams they invoke.
  const operationActionDependencies: OperationActionDependencies = {
    getOperation: (operationId) => operations.get(operationId),
    canResumeInput,
    resumeAfterInput,
    requireInput,
    finish,
    isTerminalState,
    canDismissOperation,
    dismissOperation,
    persistOperations: () => operations.persist(),
    toClientView,
    scheduleEnvironmentOperation: scheduleEnvironmentOperationForInstance,
    errorMessage,
    inputRequiredState: INPUT_REQUIRED_STATE
  };
  const operationResume = createOperationResumeService({
    ...operationActionDependencies,
    isShuttingDown: () => executionOwner.isShuttingDown()
  });
  const operationsStatusRoutes = createOperationsStatusRoutes(
    {
      latest: (repo) => operations.latest(repo),
      latestAny: () => operations.latestAny(),
      get: (operationId) => operations.get(operationId),
      toClientView,
      productVersion: resolveGeneratorVersion,
      now: () => Date.now()
    },
    {
      isValidRepoSlug,
      isResourceGroupName,
      isAksClusterName,
      isKubernetesNamespace,
      isUuid,
      buildStages,
      createOperation,
      claimSelectionHandle: (input) => githubSelectionHandles.claim(input),
      startConflict: (repo) => operations.startConflict(repo),
      startOperation: (op) => operations.start(op),
      persistOperations: () => operations.persist(),
      finish,
      scheduleEnvironmentOperation: scheduleEnvironmentOperationForInstance,
      errorMessage
    },
    operationActionDependencies,
    operationResume
  );

  const operationsControlDependencies: OperationsControlDependencies = {
    isShuttingDown: () => executionOwner.isShuttingDown(),
    get: (operationId) => operations.get(operationId),
    acquireForRetry: (op) => operations.acquireForRetry(op),
    persistOperations: () => operations.persist(),
    reportOperationDiagnostic: (diagnostic) => operations.report?.(diagnostic),
    checkPullRequestMerge: (op, pullRequestUrl) =>
      checkSetupPullRequestMergeForOperation(op, pullRequestUrl, {
        createExecutor: (login) =>
          githubAccountCoordinator.createReadOnlyExecutor(login),
        fetchJson: async (executor, apiPath) => {
          const result = await selectedGhApiJson(executor, apiPath);
          return { ok: result.ok, json: result.json, error: result.stderr };
        },
        errorMessage
      }),
    inspectVerificationWorkflow: async (op) => {
      const { identity, login } = requiredVerificationWorkflowContext(op);
      const result = await githubAccountCoordinator.withSelectedAccount(
        login,
        { ownerKey: accountContext.ownerKey, operationId: op.operationId },
        (executor) =>
          readVerificationWorkflowState(executor, identity, {
            run: (selected, args) => selected.run(args, { timeout: 30000 })
          }),
        30000
      );
      if (result.value !== "active" && result.value !== "inactive") {
        throw new Error("GitHub returned an unsupported workflow state.");
      }
      return result.value;
    },
    cancelVerificationWorkflow: async (op) => {
      const { identity, login } = requiredVerificationWorkflowContext(op);
      const result = await githubAccountCoordinator.withSelectedAccount(
        login,
        { ownerKey: accountContext.ownerKey, operationId: op.operationId },
        (executor) =>
          cancelVerificationWorkflow(executor, identity, {
            run: (selected, args) => selected.run(args, { timeout: 30000 })
          }),
        30000
      );
      return result.value;
    },
    schedule: ({ kind, instanceId, operation, commandId }) => {
      if (instanceId === undefined && operation.kind === "delete") return false;
      const coordinator = resolveInstanceRunner(
        instanceId,
        operation.operationId
      );
      if (!coordinator) return false;
      if (kind === "setup_continuation" || kind === "deletion_retry") {
        return coordinator.scheduleEnvironmentOperation(operation);
      } else {
        return coordinator.scheduleCommandTask(kind, operation, commandId);
      }
    },
    // The environments picker reads a repo-scoped cached listing, so an exit that
    // closes a setup has to drop it here: the browser reloads the table straight
    // after, and a cached payload would answer with the environment the abandoned
    // attempt left behind.
    invalidateEnvironmentListing: (repo) => {
      envListCache.invalidate(repo);
    }
  };
  const operationControl = createOperationsControlService(
    operationsControlDependencies
  );
  const operationsControlRoutes = createOperationsControlRoutes(
    operationsControlDependencies,
    operationControl
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
  // destructive POST /api/delete-deployment, GitHub-only
  // POST /api/abandon-deployment, and POST /api/deploy, whose multi-stage runtime
  // behavior lives in the deploy services composed below.
  //
  // The listing cache, its TTL and the deploy service are read through getters
  // because all three are declared later and would otherwise be in the
  // temporal dead zone when this runtime's route dependencies are built.
  const deploymentsRoutes = createDeploymentsRoutes({
    ghCommandPresentation: GH_COMMAND_PRESENTATION,
    isValidRepoSlug,
    readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
    triggerDeployRepairHandoff: repairOwnedDeployment,
    triggerDeployFailureNotice: noticeOwnedDeployment,
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
    activeDeploymentMutation: ownedDeploymentMutation,
    reserveDeploymentMutation: reserveOwnedDeploymentMutation,
    releaseDeploymentMutation: releaseOwnedDeploymentMutation,
    deploymentStatusBlocksMutation,
    localDeploymentBlocksMutation: localDeploymentBlocksOwnedMutation,
    ensureWorkflowsCurrent: (repo, environment, provider, only) =>
      ensureWorkflowsCurrent(repo, environment, provider, only),
    findWorkflowRun,
    runGh: (args, timeout = 20000, extraEnv) =>
      new Promise((resolve) => {
        const opts: CliOptions = { timeout };
        if (extraEnv) opts.env = extraEnv;
        cliExec("gh", args, opts, (err, stdout, stderr) => {
          resolve(toGhCommandResult(err, stdout, stderr, { trimStdout: true }));
        });
      }),
    readProcessEnv: () => process.env,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    // Declared as a getter for the same temporal-dead-zone reason as the cache
    // above: the deploy services are composed further down, after the workflow
    // file names and the instance container they narrow over exist.
    get deployRequest() {
      return deployRequestService;
    },
    get abandonment() {
      return deploymentAbandonmentService;
    },
    probeDeleteConflict: (request, instanceId) => {
      const scope = canvasServer.instances.get(instanceId)?.observation;
      if (!scope)
        throw new Error("Workflow observation instance is unavailable.");
      let observation: WorkflowReadRequest | undefined;
      const read = () =>
        (observation ??= scope.observe(
          undefined,
          WORKFLOW_READ_LIMITS.deleteConflictMs
        ));
      return probeDeleteConflict(request, {
        resolveEnvDeployment,
        listArtifacts: (repo, runId) =>
          listWorkflowArtifacts(repo, runId, undefined, read().context),
        downloadArtifact: (repo, artifact) =>
          downloadWorkflowArtifact(repo, artifact, read().context)
      });
    }
  });

  const azureSetupDependencies = composeAzureAutoSetupDependencies({
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
      },
      getAzureAppCreateContinuation,
      setAzureAppCreateContinuation
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
      withCredentialProvenanceLock,
      recordAzureApp: (operation, patch) => {
        recordAzureApp(operation, patch);
      },
      recordServicePrincipal: (operation, patch) => {
        recordServicePrincipal(operation, patch);
      },
      recordCreatedFederatedCredential: (operation, entry) => {
        recordCreatedFederatedCredential(operation, entry);
      },
      recordFederatedCredentialProvenance: async (operation, entry) => {
        const recorded = await recordCredentialProvenance({
          ...entry,
          operationId: String(operation.operationId || "")
        });
        if (!recorded) {
          throw new Error(
            `Invalid provenance for federated credential ${entry.name}.`
          );
        }
      },
      recordCreatedRoleAssignment: (operation, entry) => {
        recordCreatedRoleAssignment(operation, entry);
      }
    },
    external: {
      getSelectedGitHubExecutor: (operationId) =>
        accountContext.getExecutor(operationId),
      getGitHubIdentity,
      preflightRepoAdmin: (repo, executor) =>
        preflightRepoAdmin(repo, executor, GH_COMMAND_PRESENTATION),
      preflightGhcrPackageWriteAccess: (executor) =>
        preflightGhcrPackageWriteAccess(
          getGhPackageCredentials,
          getGitHubIdentity,
          executor,
          GH_COMMAND_PRESENTATION
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
    honorStopBoundary: (input) =>
      executionOwner.isShuttingDown() ?
        Promise.resolve(false)
      : honorStopBoundary(input),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stageAuthorizeIdentity: STAGE_AUTHORIZE_IDENTITY
  });
  const authorizeAzure = createAzureSetupService(azureSetupDependencies);

  const graphsPlanningStreamRoutes = createGraphsPlanningStreamRoutes({
    readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
    resolveBranchForRequest: (entry, repo, requestedBranch) =>
      resolveGraphBranchForRequest(
        entry.state,
        repo,
        requestedBranch,
        undefined,
        currentWorkspaceBranch
      ),
    commitBranchResolution: (entry, repo, resolution) =>
      commitWorkspaceBranchResolution(entry.state, repo, resolution),
    prepareSourceRef: (entry, context) =>
      prepareSourceRefResources(entry, "graph", context),
    commitSourceRef: (entry, resources, context, expectedToken) =>
      setSourceRefResources(entry, "graph", resources, context, expectedToken),
    isCurrentSourceRef: (entry, expectedToken) =>
      isCurrentSourceRefToken(entry.state, "graph", expectedToken),
    triggerAppBicepHandoff: (entry, repo, branch) =>
      triggerAppBicepHandoff(entry, repo, branch, "graph"),
    triggerGraphRepairHandoff: (entry, request) =>
      triggerGraphRepairHandoff(entry, request),
    clearGraphRepairAttempt: (entry) =>
      clearGraphRepairAttempt(entry.state, "graph"),
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
    errorMessage,
    logError: (message) => console.error(message)
  });

  const graphPlanningWorkflows =
    createGraphPlanningWorkflows<CanvasServerEntry>({
      readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
      resolveBranchForRequest: (
        entry,
        repo,
        requestedBranch,
        followWorkspaceBranch
      ) =>
        resolveGraphBranchForRequest(
          entry.state,
          repo,
          requestedBranch,
          followWorkspaceBranch,
          currentWorkspaceBranch
        ),
      commitBranchResolution: (entry, repo, resolution) =>
        commitWorkspaceBranchResolution(entry.state, repo, resolution),
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
      triggerGraphRepairHandoff: (entry, request) =>
        triggerGraphRepairHandoff(entry, request),
      clearGraphRepairAttempt: (entry, view) => {
        clearGraphRepairAttempt(entry.state, view);
        if (view === "diff") delete entry.state.diffModelingFailed;
      },
      listBranchPaths: (entry, repo, branch) =>
        listBranchPaths(entry, repo, branch),
      prepareSourceRefResources: (entry, view, sourceRefInput) =>
        prepareSourceRefResources(entry, view, sourceRefInput),
      setSourceRefResources: (entry, view, resources, sourceRefInput, token) =>
        setSourceRefResources(entry, view, resources, sourceRefInput, token),
      isCurrentSourceRefToken,
      canReuseModeledGraph,
      addGraphProgress,
      beginPlannedGraphRequest,
      isCurrentPlannedGraphRequest,
      fetchRecipePack: (provider) => fetchRecipePack(github, provider),
      resolveRecipeOutputs: (resources, recipes, provider) =>
        resolveRecipeOutputs(github, resources, recipes, provider),
      computeGraphDiff: (baseResources, headResources) =>
        computeGraphDiff(baseResources, headResources),
      observeModelingRun: observeServerWorkspaceModelingRun,
      readBranchSourceRevision: (entry, repo, branch) =>
        readSelectedSourceRevision(entry.state, repo, branch, {
          isWorkspaceSelection,
          workspaceSourceRevision,
          branchHeadCommit: getBranchHeadSha
        }),
      record,
      optionalString,
      errorMessage,
      logError: (message) => console.error(message),
      now: () => Date.now()
    });

  // Composition root for the read-only half of the `graphs-planning` family. The
  // Deployed route reads status through the cached artifact reader, but obtains its
  // fixed topology through the same modeled-graph workflow and cache as the Graph
  // route. It never parses Bicep or invokes rad through a second path.
  const graphsPlanningRoutes = createGraphsPlanningRoutes({
    readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
    createDeployStatusReader: (options, instanceId) => {
      const scope = canvasServer.instances.get(instanceId)?.observation;
      if (!scope)
        throw new Error("Workflow observation instance is unavailable.");
      return scope.reader(options);
    },
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
    mergeDeployedGraphDisplayMetadata,
    mergeDeployedGraphMetadata,
    projectDeployedGraph: (modeled, statusByKey) =>
      projectDeployedGraph(modeled as any[], statusByKey),
    canvasGraphResources,
    applyDeployMessages,
    settleDeployStatuses,
    errorMessage,
    repoMatchesWorkspace,
    observeModelingRun: observeServerWorkspaceModelingRun,
    now: () => Date.now()
  });

  // The route layer sees exactly one seam: the workflow service above. Parsing
  // and serialization are all it owns.
  const graphsPlanningWritesRoutes = createGraphsPlanningWritesRoutes({
    workflows: graphPlanningWorkflows
  });

  // configuration service has separate bindings below.
  // Every seam is a narrow named function: the two subprocess
  // runners (`cliExec`, `runCommand`), the repo-file fetch and bicep param parse
  // for `app-params`, the app-name and active-deployment resolvers plus the
  // error logger for `delete-environment`, three narrow accessors over the
  // module-level `envListCache` (so this module owns no cache), the workflow-sync
  // kickoff and clock for `list-environments`, and the operation-registry,
  // run-inspection, and finisher helpers for `verify-status`. `repoMatchesWorkspace`,
  // `errorMessage`, `VERIFY_WORKFLOW_FILE`, and `STAGE_VERIFY` stay defined here
  // and are injected rather than moved, so the route module spawns nothing and
  // reads no module-level mutable state.
  const environmentsDependencies: EnvironmentsDependencies = {
    errorMessage,
    redactDiagnostic: (value) => redactGhCredentials(value),
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
    discoverEnvironmentTarget: (repo, environment) =>
      discoverEnvironmentTarget(repo, environment),
    activeDeleteOperation: (repo, environment) => {
      return matchDeleteOperationEnvironment(
        operations.running(repo),
        environment
      );
    },
    createOperation,
    buildDeleteStages: (options) => buildDeleteStages(options),
    startOperation: (op) => operations.start(op),
    toClientView,
    scheduleEnvironmentOperation: scheduleEnvironmentOperationForInstance,
    cliExec: (command, args, options, callback) => {
      cliExec(command, args, options, callback);
    },
    activeDeleteEnvironment: (repo) => {
      const op = operations.latest(repo);
      if (
        op &&
        op.kind === OPERATION_KIND_DELETE &&
        !isTerminalState(op.state) &&
        typeof op.environment === "string"
      ) {
        return op.environment;
      }
      return "";
    },
    envListCacheGet: (repo) => envListCache.get(repo),
    envListCacheSet: (repo, entry) => {
      envListCache.set(repo, entry);
    },
    envListCacheDelete: (repo) => {
      envListCache.invalidate(repo);
    },
    envListCacheGeneration: (repo) => envListCache.generation(repo),
    envListTtlMs: ENV_LIST_TTL_MS,
    kickoffWorkflowSync: (repo, managedEnvironments, workingBranch) =>
      kickoffWorkflowSync(repo, managedEnvironments, workingBranch),
    now: () => Date.now(),
    getOperation: (operationId) => operations.get(operationId),
    getSelectedGitHubExecutor: (operationId) =>
      accountContext.getExecutor(operationId),
    isSelectedGitHubAuthorizationError: (error) =>
      isSelectedGhAuthorizationError(error),
    hasCompleteVerificationIdentity,
    findWorkflowRun: (
      repo,
      workflowFile,
      sinceMs,
      knownId,
      executor,
      afterRunId
    ) =>
      findWorkflowRun(
        repo,
        workflowFile,
        sinceMs,
        knownId,
        executor,
        afterRunId
      ),
    settleVerificationDispatchRecovery: (operation, runId) => {
      const op = operation as any;
      const verification = op?.verification;
      if (!verification) return;
      const target = `${op.repo}:${verification.workflow}:${verification.ref}:${verification.environment}`;
      const mutation = providerMutationRecord(
        op,
        "github_workflow.dispatch",
        target
      );
      if (mutation) {
        settleProviderMutation(
          op,
          mutation.mutationId,
          "confirmed",
          `Adopted verification run ${runId} after the saved pre-dispatch baseline.`
        );
      }
    },
    getRunDetail,
    fetchRunLog,
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
  };
  const environmentsRoutes = createEnvironmentsRoutes(environmentsDependencies);
  const verificationStatus = createVerificationStatusService(
    environmentsDependencies,
    () => createWorkflowObservationScope(createDeployStatusReader)
  );

  // Direct configuration service bindings. Panel projection remains lazy:
  // setup can proceed when the initiating panel is no longer present.
  const configureEnvironmentDependencies: ConfigureEnvironmentDependencies = {
    ghCommandPresentation: GH_COMMAND_PRESENTATION,
    readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
    getSelectedGitHubExecutor: (operationId) =>
      accountContext.getExecutor(operationId),
    cliExec: (command, args, options, callback) =>
      cliExec(command, args, options, callback),
    readProcessEnv: () => process.env,
    isValidRepoSlug,
    getOperation: (operationId) => operations.get(operationId),
    isStale: (operation) => isStale(operation),
    isTerminalState: (state) => isTerminalState(state),
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
    namespaceClaimsFor: (operationId) =>
      namespaceClaimsFor(accountContext, operationId),
    addLegacyStep: (operation, text) => {
      addLegacyStep(operation, text);
    },
    finalizeSetupFailure: (operation, input) =>
      finalizeSetupFailure(operation, input as never),
    persistMutationCheckpoint,
    persistBestEffort,
    guardStopBoundary: async (input) => {
      if (executionOwner.isShuttingDown()) {
        input.respond(503, {
          code: "setup-shutting-down",
          error:
            "The session is shutting down; no further setup work was started.",
          operationId: input.operation?.operationId
        });
        return false;
      }
      return guardStopBoundary(input);
    },
    runAzCommand: (args) => runCliCommand("az", args),
    preflightRepoAdmin: (repo, executor) =>
      preflightRepoAdmin(repo, executor, GH_COMMAND_PRESENTATION),
    preflightGhcrPackageWriteAccess: (executor) =>
      preflightGhcrPackageWriteAccess(
        getGhPackageCredentials,
        getGitHubIdentity,
        executor,
        GH_COMMAND_PRESENTATION
      ),
    readGitHubJson: (apiPath, executor) =>
      runGitHubJsonRequest(apiPath, executor),
    bootstrapGHCRStatePackage: (input) =>
      bootstrapGHCRStatePackage({
        targetRepository: input.targetRepository,
        registry: input.registry,
        credentials: input.credentials as GhcrPackageCredentials,
        ghCommandPresentation: GH_COMMAND_PRESENTATION
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
    tempFile: workflowTempFile,
    setCanonicalEnvironment: (operation, environment) => {
      setCanonicalEnvironment(operation, environment);
    },
    recordGitHubEnvironment: (operation, patch) => {
      recordGitHubEnvironment(operation, patch);
    },
    recordGitHubEnvironmentVariable: (operation, entry) => {
      recordGitHubEnvironmentVariable(operation, entry);
    },
    promoteCreatedGitHubEnvironment: (operation, identity) =>
      promoteCreatedGitHubEnvironment(operation, identity),
    envListCacheDelete: (repo) => {
      envListCache.invalidate(repo);
    },
    ociStateBackend: OCI_STATE_BACKEND,
    defaultStateArchive: DEFAULT_STATE_ARCHIVE,
    azureCredential: () => cloudCredential(sharedCredentials.azure),
    awsCredential: () => cloudCredential(sharedCredentials.aws),
    optionalString,
    generateVerifyWorkflow: (environment, provider, setupPushOperationMarker) =>
      generateVerifyWorkflow(environment, provider, undefined, {
        setupPushOperationMarker
      }),
    generateDeployWorkflow: (environment, appFile) =>
      generateDeployWorkflow(environment, appFile),
    generateDeleteWorkflow: (environment) =>
      generateDeleteWorkflow(environment),
    recordCommittedWorkflowFile: (operation, entry) => {
      recordCommittedWorkflowFile(operation, entry);
    },
    deleteLegacyDeployWorkflow,
    createPullRequestApi: (repo, head, base, title, body, executor) =>
      executor ?
        selectedCreatePullRequest(executor, repo, head, base, title, body)
      : createPullRequestApi(repo, head, base, title, body),
    planCredentialVerification,
    fetchFileFromRepo: (repo, path, branch, executor) =>
      executor ?
        selectedFetchFileFromRepo(executor, repo, path, branch)
      : fetchFileFromRepo(repo, path, branch),
    fetchFileFromRepoResult: (repo, path, branch, executor) =>
      executor ?
        selectedFetchFileFromRepoResult(executor, repo, path, branch)
      : fetchFileFromRepoResult(repo, path, branch),
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
  };
  const configureEnvironment = createConfigureEnvironmentService(
    configureEnvironmentDependencies
  );
  const setupServices: SetupServices = {
    authorizeAzure: (data) => authorizeAzure({ data }),
    configureEnvironment: (data, instanceId, isCurrentPresentation) =>
      configureEnvironment({ data }, instanceId, isCurrentPresentation)
  };
  const setupExecution = createEnvironmentOperationExecution({
    executionOwner,
    scope: executionOwner.attachRuntime(),
    accountContext,
    setupServices,
    verificationStatus,
    admitRecoveryRollback: (operationId) =>
      admitRecoveryRollback(operationControl, operationId),
    get environmentOperationRunner() {
      return options.environmentOperationRunner;
    }
  });

  // Built once per runtime so validation fails before opening any server.
  const serverRoutes = createServerRouteTable({
    ...livenessSourceRoutes,
    ...operationsStatusRoutes,
    ...operationsControlRoutes,
    ...repositoriesRoutes,
    ...deploymentsRoutes,
    ...azureDiscoveryRoutes,
    ...identityProfilesRoutes,
    ...identityAuthRoutes,
    ...remediationRoutes,
    ...graphsPlanningRoutes,
    ...graphsPlanningStreamRoutes,
    ...graphsPlanningWritesRoutes,
    ...environmentsRoutes
  });

  // Coordinators retain transport and provider behavior. Task/claim storage lives
  // in the runtime owner, preserving the scope of each attachment.
  const instanceRequestCoordinators = new Map<
    string,
    ReturnType<typeof createInstanceRequestCoordinator> & {
      start(baseUrl: string): void;
    }
  >();

  const canvasServer = createCanvasServer(
    createProductionCanvasServerDependencies(
      {
        createRequestHandler: ({ instanceId, instances, markActivity }) => {
          let baseUrl = "";
          const coordinator: ReturnType<
            typeof createInstanceRequestCoordinator
          > = createInstanceRequestCoordinator(
            instanceId,
            () => baseUrl,
            environmentDeletionPorts ?? productionEnvironmentDeletionPorts(),
            {
              executionOwner,
              accountContext,
              setupServices,
              verificationStatus,
              operationControl: (input, publish) =>
                operationControl({ ...input, instanceId: undefined }, publish),
              servers: instances,
              get environmentOperationRunner() {
                return options.environmentOperationRunner;
              }
            }
          );
          instanceRequestCoordinators.set(instanceId, {
            ...coordinator,
            start: (url) => {
              baseUrl = url;
              coordinator.startRecoveredTasks();
            }
          });
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
          entry.observation = createWorkflowObservationScope(
            createDeployStatusReader
          );
          executionOwner.markEnvironmentInstanceStarted(instanceId);
          entry.state.ghCommandPresentation = GH_COMMAND_PRESENTATION;
          const coordinator = instanceRequestCoordinators.get(instanceId);
          if (coordinator) {
            entry.state.browserMutationNonce = coordinator.browserMutationNonce;
            coordinator.start(entry.baseUrl);
          }
        },
        onStopped: (instanceId) => {
          deploymentPresentation.detach(instanceId);
          instanceRequestCoordinators.get(instanceId)?.detach();
          instanceRequestCoordinators.delete(instanceId);
        },
        defaultPage: DEFAULT_CANVAS_PAGE,
        preferredPort: preferredPortForInstance
      },
      serverDependencies
    )
  );

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
  // Repo-wide discovery permits a guessed application name as a tie-breaker.
  // An active run instead requires matching application and execution evidence;
  // another application's progress must not paint this deployment's graph.
  function createDeploymentMonitor(execution: DeploymentExecution) {
    return createProductionDeploymentMonitor(execution, {
      owner: deploymentOwner,
      ghCommandPresentation: GH_COMMAND_PRESENTATION,
      runAz: async (args, timeout) => {
        const result = await runCliCommand("az", args, timeout);
        return {
          code: result.code ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? ""
        };
      },
      invalidateDeployListCache: (repo) => {
        deployListCache.delete(repo);
      },
      reportWorkflowProgress: (message) => console.error(message)
    });
  }

  const deployRequestService = createDeployRequestService({
    owner: deploymentOwner,
    account: async (input) => {
      const selected = await deploymentAccount(input);
      if (selected.state !== "selected")
        throw new Error(
          "message" in selected ?
            selected.message
          : `GitHub account selection is ${selected.state}. Select and authorize an account before deploying.`
        );
      return selected.executor;
    },
    present: (instanceId, execution) => {
      const panel = canvasServer.instances.get(instanceId);
      if (panel)
        deploymentPresentation.attach(
          instanceId,
          panel.state,
          execution.invocation
        );
    },
    reportError: (error) =>
      console.error(
        "[radius deployment]",
        redactGhCredentials(errorMessage(error))
      ),
    readInstanceEntry: (instanceId) => canvasServer.instances.get(instanceId),
    resolveDeployRepairLoop,
    resolveDeploymentEnvironment,
    activeDeploymentMutation: ownedDeploymentMutation,
    localDeploymentBlocksMutation: localDeploymentBlocksOwnedMutation,
    reserveDeploymentMutation: reserveOwnedDeploymentMutation,
    releaseDeploymentMutation: releaseOwnedDeploymentMutation,
    deploymentStatusBlocksMutation,
    resolveEnvDeployment: (repo, environment, appName, executor) =>
      resolveEnvironmentDeployment(repo, environment, appName, {
        ghOrThrow: async (args) =>
          (
            await executor.runOrThrow(
              args,
              "Could not read environment deployment history.",
              { timeout: 30000 }
            )
          ).stdout,
        deployWorkflowFile: DEPLOY_WORKFLOW_FILE,
        deleteWorkflowFile: DELETE_WORKFLOW_FILE,
        maxParallelRecords: DEPLOY_MAX_PARALLEL_RECORDS
      }),
    runCommand: async (_command, args, executor) =>
      (
        await executor.runOrThrow(
          args,
          "Could not resolve the deployment branch.",
          { timeout: 30000 }
        )
      ).stdout,
    canvasGraphResources,
    beginDeployAttempt,
    triggerDeployRepairHandoff: repairOwnedDeployment,
    triggerDeployFailureNotice: noticeOwnedDeployment,
    monitorFor: createDeploymentMonitor,
    unconfirmedRunKind: DEPLOY_RUN_UNCONFIRMED_KIND,
    repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP,
    errorMessage
  });

  const deploymentAbandonmentService = createDeploymentAbandonmentService({
    ghCommandPresentation: GH_COMMAND_PRESENTATION,
    isValidRepoSlug,
    readInstanceState: (instanceId) =>
      canvasServer.instances.get(instanceId)?.state,
    activeDeploymentMutation: ownedDeploymentMutation,
    localDeploymentBlocksMutation: localDeploymentBlocksOwnedMutation,
    reserveDeploymentMutation: reserveOwnedDeploymentMutation,
    releaseDeploymentMutation: releaseOwnedDeploymentMutation,
    deploymentStatusBlocksMutation,
    resolveEnvDeployment,
    ghOrThrow: (args) => ghOrThrow(args),
    invalidateDeployListCache: (repo) => {
      deployListCache.delete(repo);
    }
  });

  function getLastWebviewActivityAt(): number {
    return canvasServer.getLastActivityAt();
  }

  // Global pre-routing shared by typed routes and unmatched page requests. Reject
  // cross-site mutations before any routing or body parse, then synchronise the
  // requested page onto the instance entry.
  function preRouteCanvasRequest(context: CanvasRequestContext): boolean {
    const { request } = context;
    if (
      isCrossSiteMutation(request.method, request.headers["sec-fetch-site"])
    ) {
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
    const entry = canvasServer.instances.get(context.instanceId);
    if (entry)
      deploymentPresentation.synchronize(context.instanceId, entry.state);
    return false;
  }

  async function getOrCreateServer(
    instanceId: string,
    page?: string
  ): Promise<CanvasServerEntry> {
    const entry = await canvasServer.getOrCreate(instanceId, page);
    deploymentPresentation.synchronize(instanceId, entry.state);
    return entry;
  }

  async function stopServer(instanceId: string, force = false): Promise<void> {
    await canvasServer.stop(instanceId, force);
  }

  return {
    servers: canvasServer.instances,
    invalidateDeploymentListCache: (repo: string) => {
      deployListCache.delete(repo);
    },
    deploymentOwner,
    deploymentAccount,
    setupExecution,
    verificationStatus,
    operationControl,
    operationResume,
    getOrCreateServer,
    stopServer,
    getLastWebviewActivityAt,
    hasActiveEnvironmentTasks: executionOwner.hasActiveEnvironmentTasks,
    markEnvironmentInstanceShuttingDown:
      executionOwner.markEnvironmentInstanceShuttingDown,
    onEnvironmentTasksSettled: executionOwner.onEnvironmentTasksSettled
  };
}
import {
  assessSetupPackageWriteAccess,
  preflightSetupRepository,
  selectedSetupPackageIdentity
} from "@radius-project/core";
