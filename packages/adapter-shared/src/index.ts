// @radius-project/adapter-shared — Node-runtime helpers shared across Radius adapters.
//
// This package holds impure, Node-only product logic that the pure
// `@radius-project/core` package intentionally excludes (it declares "No SDK /
// HTTP / DOM dependencies"). Adapters (canvas, and any future adapter) import
// from here instead of duplicating process-spawning / download / filesystem
// code.

export {
  RADIUS_EXTENSION_REGISTRY,
  RADIUS_BICEP_EXPERIMENTAL_FEATURES,
  radiusExtensionRefForVersion,
  resolveRadiusExtensionRef,
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
export { createLifecycleValidators } from "./lifecycle/validation.js";
export type {
  ContractValidation,
  LifecycleValidators
} from "./lifecycle/validation.js";
export {
  createSourceReadAdapter,
  nodeSourceFileSystem
} from "./lifecycle/source-access.js";
export type {
  AuthorizedRemoteSource,
  AuthorizedSourceLocation,
  AuthorizedWorkspaceLocation,
  SourceAuthorityPort,
  SourceCaptureLimits,
  SourceFileSystem,
  SourceGitPort,
  SourceReadAdapter,
  SourceReadDependencies,
  SourceReadHandle
} from "./lifecycle/source-access.js";
export * from "./lifecycle/application-read.js";
export * from "./lifecycle/environment-read.js";
export * from "./lifecycle/workspace-source.js";
export * from "./lifecycle/github-source.js";
export * from "./lifecycle/deployed-application-read.js";
export * from "./lifecycle/recipe-evidence.js";
export * from "./lifecycle/graph-execution.js";
export * from "./lifecycle/definition-validation.js";
export * from "./lifecycle/definition-promotion.js";
