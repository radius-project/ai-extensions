// @radius-project/core — UI-agnostic core for the Radius Canvas product.
//
// This package contains pure logic shared by every UI adapter (canvas, browser,
// chat): repository modeling, application-graph build/diff, the compute-platform
// abstraction, and workflow generation. It must not depend on the Copilot SDK,
// HTTP, or the DOM. Repository reads are reached only through the GitHub port —
// see src/ports.
//
// This barrel is the package's public surface: only names an adapter actually
// imports belong here. Helpers that exist for a sibling core module stay
// exported from their own module and out of this file.

export { redactCredentials } from "./credential-redaction.js";
export { runSetupCoordinator } from "./setup-coordinator.js";
export type {
  SetupCoordinatorTarget,
  SetupCoordinatorOperation,
  SetupCoordinatorStageResult,
  SetupCoordinatorFailure,
  SetupCoordinatorEvent,
  SetupCoordinatorPorts
} from "./setup-coordinator.js";
export {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureError,
  GitHubEnvironmentEnsureCancelled,
  parseEnvironmentProviderId,
  readEnsuredGitHubEnvironment
} from "./setup-github-environment.js";
export type {
  EnsureGitHubEnvironmentInput,
  GitHubEnvironmentCommandResult,
  GitHubEnvironmentReadResult,
  EnsuredGitHubEnvironment,
  GitHubEnvironmentCreatedCandidate,
  GitHubEnvironmentResolutionRecord,
  GitHubEnvironmentRecoveryPort
} from "./setup-github-environment.js";
export {
  proveGitHubEnvironmentCreated,
  type GitHubEnvironmentCreationEvidence,
  type GitHubEnvironmentCreationProof,
  type GitHubEnvironmentPreflight
} from "./setup-github-environment-provenance.js";

export {
  applySetupProviderConfiguration,
  azureRoleScope,
  cloudCredentialsComplete,
  setupProviderCredentialStatus
} from "./setup-provider-configuration.js";
export type {
  SetupProviderConfigurationEvent,
  SetupProviderCredentialPorts,
  SetupProviderCredentialStatus
} from "./setup-provider-configuration.js";

export { admitSetupOperation } from "./setup-admission.js";
export type {
  SetupAdmissionInput,
  SetupAdmissionIssue,
  SetupAdmissionPorts,
  SetupAdmissionResult,
  SetupNamespaceIssue,
  SetupOperationSnapshot,
  SetupStartResult,
  SetupTarget
} from "./setup-admission.js";
export {
  honorSetupStop,
  saveSetupCheckpoint,
  saveSetupOperation
} from "./setup-boundary.js";
export type {
  SetupCheckpointOperation,
  SetupCheckpointResult,
  SetupPersistenceResult,
  SetupStopPorts
} from "./setup-boundary.js";

export {
  createWorkflowReadContext,
  createWorkflowReadCooldowns,
  isSecondaryWorkflowRateLimitMessage,
  WorkflowReadInterruptedError,
  WORKFLOW_READ_LIMITS
} from "./workflow-read-policy.js";
export type {
  WorkflowReadClock,
  WorkflowReadContext,
  WorkflowReadCooldowns,
  WorkflowReadDecision,
  WorkflowReadReason
} from "./workflow-read-policy.js";
//
// Modules are extracted incrementally from the canvas adapter; see
// docs/design/radius-extension-modularization.md for the target layout.

export {
  ARTIFACT_PAGE_SIZE,
  MAX_ARTIFACT_PAGES,
  DEPLOY_STATUS_FILES,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_PROGRESS_SCHEMA_VERSION,
  MAX_ARTIFACT_CANDIDATES,
  isLiveSlotArtifactName,
  sanitizeArtifactSegment,
  deployStatusArtifactPrefix,
  selectDeployStatusArtifacts,
  parseDeployProgressArtifact,
  parseDeployGraphArtifact,
  confirmArtifactIdentity,
  createDeployStatusReader
} from "./deploy-artifact-evidence.js";
export type {
  ArtifactFiles,
  DeployProgress,
  DeployProgressResource,
  DeployStatusReaderOptions,
  DownloadArtifact,
  ListArtifacts,
  ReaderStatus,
  WorkflowArtifact
} from "./deploy-artifact-evidence.js";
export {
  applicationGraphToResources,
  computeGraphDiff,
  deployStatusKeys,
  filterGraphVisualizationResources,
  lookupDeployStatus,
  mergeDeployedGraphDisplayMetadata,
  mergeDeployedGraphMetadata,
  projectGraphOutputMetadata,
  projectSafeApplicationGraph,
  projectDeployedGraph
} from "./graph/index.js";
export type { DeployStatus, SafeApplicationGraph } from "./graph/index.js";
export {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
  freshnessIdentity,
  normalizeAppBicep,
  parseAppOrigin,
  serializeAppOrigin,
  RECIPE_PACK_REF,
  IGNORED_SOURCE_DIRS,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  UNIDENTIFIED_APPLICATION_MESSAGE,
  WORKSPACE_MANIFEST_FILES,
  ambiguousAppSourceBrief,
  dockerfileDirectories,
  evaluateAppSource,
  findWorkspaceManifests,
  unsupportedAppSourceReport,
  STAGING_DIR_PREFIX,
  isStagingDirName,
  fetchBicepFromRepo,
  fetchRecipePack,
  resolveRecipeOutputs
} from "./modeling/index.js";
export type { ConcreteResource, RecipePackEntry } from "./modeling/index.js";
export type { AppSourceEvaluation, AppSourceStatus } from "./modeling/index.js";
export type {
  AppModelFreshness,
  AppModelFreshnessInput,
  AppModelFreshnessStatus,
  AppOrigin
} from "./modeling/index.js";
export {
  GENERATED_MODEL_PATHS,
  REMEDIATION_IDS,
  buildRemediation,
  isRemediationId,
  remediationSessionMessage,
  remediationView
} from "./remediations.js";
export type {
  GeneratedModelPath,
  Remediation,
  RemediationCwd,
  RemediationId,
  RemediationImpact,
  RemediationResult,
  RemediationSessionMessage,
  RemediationView
} from "./remediations.js";
export {
  getPlatform,
  generatePortalUrl,
  buildOidcSubject,
  buildEnvironmentSuffix,
  buildFederatedCredentialName,
  KUBERNETES_NAMESPACE_ERROR,
  KUBERNETES_NAMESPACE_PATTERN,
  isKubernetesNamespace
} from "./platforms/index.js";
export type {
  ComputePlatform,
  PortalContext,
  OidcSubjectConfig,
  BuildOidcSubjectInput
} from "./platforms/index.js";
export {
  generateVerifyWorkflow,
  verifyTemplateFile,
  generateDeployWorkflow,
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  stateRegistryForEnvironment,
  generateDeleteWorkflow,
  DELETE_RADIUS_REF,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_GUARD_STEP_NAME,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE
} from "./workflows/index.js";
export type {
  DeployWorkflowFiles,
  DeployWorkflowOptions,
  DeployWorkflowTemplateVars,
  DeleteWorkflowFiles
} from "./workflows/index.js";
export type { GitHub } from "./ports/index.js";
export type {
  WorkflowReadTiming,
  WorkflowResponseMetadata,
  WorkflowReadEvidence
} from "./workflow-read-metadata.js";
export {
  observeWorkflowRun,
  confirmedWorkflowConclusion
} from "./workflow-observation.js";
export type {
  WorkflowJob,
  WorkflowRunDetail,
  WorkflowRunRead,
  WorkflowStep,
  WorkflowTarget,
  WorkflowObservationReads
} from "./workflow-observation.js";
export {
  DEPLOY_RAD_COMMANDS_STEP,
  extractErrorLines,
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  classifyDeployCloudAuthDrift,
  extractRadDeployError,
  collectWorkflowFailure
} from "./workflow-diagnostics.js";
export type {
  DeployCloudAuthDriftInput,
  WorkflowFailure,
  WorkflowFailureReads
} from "./workflow-diagnostics.js";
export {
  parseWorkflowProtection,
  describeWorkflowProtection
} from "./workflow-protection.js";
export type {
  WorkflowProtectionEvidence,
  WorkflowPendingEnvironment
} from "./workflow-protection.js";

export * from "./setup-azure-continuation.js";

export * from "./setup-azure-contracts.js";
export * from "./setup-azure-events.js";
export * from "./setup-azure-recovery.js";
export {
  azureRetryDelayMs,
  buildRoleAssignmentArgs,
  federatedCredentialIdFrom,
  findFederatedCredentialNameCollision,
  isReplicationLagError,
  isRetryableAzureReadFailure,
  pickAksResourceGroup,
  readFederatedCredentialId
} from "./setup-azure-reads.js";
export * from "./setup-azure-service-principal.js";
export * from "./setup-azure-application.js";
export * from "./setup-azure-credentials.js";
export * from "./setup-azure-account.js";
export * from "./setup-azure.js";
export * from "./setup-github-preflight.js";

export * from "./setup-workflow-committer.js";
export * from "./setup-workflow-contracts.js";
export * from "./setup-workflow-recovery.js";
export * from "./setup-workflow-scope.js";
export * from "./setup-recovery-error.js";

export {
  publishSetupWorkflowFiles,
  type SetupWorkflowPublicationEvent,
  type SetupWorkflowCommitRecord
} from "./setup-workflow-publication.js";

export * from "./setup-environment-variable.js";
export * from "./setup-environment.js";
export * from "./setup-environment-contracts.js";

export * from "./setup-verification-policy.js";
export * from "./setup-verification-plan.js";
