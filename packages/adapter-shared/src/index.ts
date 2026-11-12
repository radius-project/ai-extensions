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
export * from "./deployment-repository.js";
export * from "./deployment-workspace.js";
export * from "./deployment-observation-bindings.js";
export * from "./deployment-templates.js";
export * from "./deployment-parameters.js";
export * from "./deployment-dispatch.js";
export * from "./deployment-monitor.js";
export * from "./deployment-outcome.js";
export * from "./deployment-service-dependencies.js";
export * from "./workflow-observation-scope.js";
export * from "./deployment-bindings.js";
export * from "./deployment-workflows.js";
export * from "./deployment-lookup.js";
export * from "./deployment-identity.js";
export * from "./deployment-owner.js";
export {
  createDeploymentRuntime,
  type DeploymentRuntime,
  type DeploymentRuntimePorts,
  type DeploymentStartResult,
  type DeploymentStartContext,
  type DeploymentStartInput,
  type DeploymentWorkspace
} from "./runtime-deployment.js";
export * from "./deployment-repair.js";
export * from "./production-deployment.js";
