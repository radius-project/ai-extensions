// @radius-project/adapter-shared — Node-runtime helpers shared across Radius adapters.
//
// This package holds impure, Node-only product logic that the pure
// `@radius-project/core` package intentionally excludes (it declares "No SDK /
// HTTP / DOM dependencies"). Adapters (canvas, and any future adapter) import
// from here instead of duplicating process-spawning / download / filesystem
// code.

export {
  createWorkflowArtifactReads,
  createWorkflowArtifactReader,
  WorkflowArtifactReadError
} from "./workflow-artifacts.js";
export type { WorkflowArtifactReaderOptions } from "./workflow-artifacts.js";
export { RADIUS_RELEASE_TAG, RADIUS_RELEASE_COMMIT } from "./radius-release.js";
export {
  RADIUS_EXTENSION_REGISTRY,
  RADIUS_BICEP_EXPERIMENTAL_FEATURES,
  resolveRadiusExtensionRef,
  resolveInstalledRadiusVersion,
  MANAGED_RAD_BIN,
  MANAGED_RAD_PATH,
  resolveExistingRadBinary,
  ensureRadBinary,
  managedBicepEnv,
  spawnRad,
  killChildTree,
  runRadAppGraph,
  runRadBicepPublishExtension,
  runRadBicepPublish,
  buildGraphViaRad
} from "./rad.js";
export type {
  Logger,
  ProcessResult,
  SpawnRadOptions,
  SpawnRadRunner,
  EnsureManagedBicepOptions,
  RadReleaseAsset,
  RadReleaseInfo,
  ExpectedDigest,
  BicepCompileConfig,
  RunRadAppGraphOptions,
  ResolveRadiusExtensionRefOptions,
  BuildGraphViaRadOptions,
  RunRadBicepPublishExtensionOptions,
  RunRadBicepPublishOptions
} from "./rad.js";
export { RadProcessError } from "./rad.js";
export {
  readWorkflowRun,
  readWorkflowRunWithMetadata,
  readWorkflowLog,
  readWorkflowLogWithMetadata,
  selectedWorkflowJson,
  SelectedGhAuthorizationError,
  isSelectedGhAuthorizationError,
  isGitHubRateLimitError,
  selectedCommandAuthorizationError
} from "./workflow-reads.js";
export type {
  WorkflowCommandResult,
  WorkflowExecution,
  WorkflowRunner,
  WorkflowReadOptions,
  SelectedWorkflowExecutor,
  SelectedWorkflowJsonRead
} from "./workflow-reads.js";
export type {
  WorkflowRunResponse,
  WorkflowRunReadOptions,
  WorkflowReadRequest
} from "./workflow-reads.js";
export {
  createWorkflowReadBudget,
  createWorkflowReadSession,
  isWorkflowReadLimitError
} from "./workflow-read-budget.js";
export {
  setupIdentityEqual,
  deterministicProviderUuid
} from "./setup-identity-bindings.js";

export * as ghcrBootstrap from "./ghcr-bootstrap.js";

export * from "./setup-workflow-content.js";
export * from "./deployment-command-bindings.js";
export * from "./deployment-lookup.js";
export {
  toSafeRepoRelPath,
  safeWorkspacePath,
  readWorkspaceFile,
  runWorkspaceGit,
  uncommittedGeneratedPaths
} from "./deployment-workspace.js";
export { createDeploymentObservationBindings } from "./deployment-observation-bindings.js";
export {
  createDeploymentRepository,
  type DeploymentFileResult
} from "./deployment-repository.js";
export {
  createDeploymentWorkflows,
  type DeploymentWorkflowPorts
} from "./deployment-workflows.js";
export {
  createDeploymentTemplates,
  type DeploymentTemplatePorts
} from "./deployment-templates.js";
export {
  createDeploymentFileReader,
  createDeploymentStatusReader,
  type DeploymentFilePorts
} from "./deployment-bindings.js";
export {
  createDeploymentRuntime,
  type DeploymentRuntime,
  type DeploymentRuntimePorts,
  type DeploymentStartResult,
  type DeploymentStartContext,
  type DeploymentStartInput,
  type DeploymentWorkspace
} from "./runtime-deployment.js";

export {
  createDeployDispatchService,
  buildFederatedCredentialListArgs,
  type DeployDispatchInstanceEntry,
  type DeployCommandResult,
  type DeployCommandOptions,
  type DeployDispatchDependencies,
  type DeployDispatchRequest,
  type DeployDispatchOutcome,
  type DeployDispatchService
} from "./deployment-dispatch.js";
export {
  createDeployMonitorService,
  type DeploymentObservationScope,
  type DeploymentGraphRecovery,
  type DeployMonitorInstanceEntry,
  type DeployRunDetail,
  type DeployMonitorStatusReader,
  type DeployResourceStatus,
  type DeployStatusChange,
  type DeployMonitorDependencies,
  type DeployMonitorRequest,
  type DeployMonitorService,
  type DeployObservationService
} from "./deployment-monitor.js";
export {
  createDeployOutcomeService,
  type DeployOutcomeInstanceEntry,
  type DeployRunStep,
  type DeployGraphRead,
  type DeployOutcomeStatusReader,
  type DeployOutcomeDependencies,
  type DeployOutcomeRequest,
  type DeployOutcomeService
} from "./deployment-outcome.js";
export {
  createDeploymentRepairCoordinator,
  type DeploymentDeliveryIdentity,
  type DeploymentFailureNotice,
  type DeploymentRepairHandoff,
  type DeploymentRepairDependencies,
  type DeploymentRepairRequest,
  type DeploymentDeliveryResult,
  type DeploymentRepairCoordinator
} from "./deployment-repair.js";
export { assertDeployDependencies } from "./deployment-service-dependencies.js";

export {
  createWorkflowObservationScope,
  type WorkflowObservationScope
} from "./workflow-observation-scope.js";

export {
  createDeploymentOwner,
  type DeploymentTarget,
  type DeploymentReservation,
  type DeploymentInvocation,
  type DeploymentOwnerPorts,
  type DeploymentLookup,
  type DeploymentOwner
} from "./deployment-owner.js";
export { autogenValue, resolveDeployParams } from "./deployment-parameters.js";
export type {
  DeploymentObservationExecutor,
  DeploymentSelectedWorkflowExecutor
} from "./deployment-observation-bindings.js";
export {
  createProductionDeploymentRuntime,
  type ProductionDeploymentPorts
} from "./production-deployment.js";
