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
//
// Modules are extracted incrementally from the canvas adapter; see
// docs/design/radius-extension-modularization.md for the target layout.

export {
  applicationGraphToResources,
  computeGraphDiff,
  deployStatusKeys,
  filterGraphVisualizationResources,
  lookupDeployStatus,
  projectDeployedGraph
} from "./graph/index.js";
export type { DeployStatus } from "./graph/index.js";
export {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
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
  CONCURRENT_EDIT_MESSAGE,
  CUSTOM_TYPE_STAGED_FILES,
  REQUIRED_STAGED_FILES,
  STAGING_DIR_PREFIX,
  STAGING_IGNORE_PATTERN,
  STAGING_RUN_RECORD,
  UNRECORDED_RUN_MESSAGE,
  changedManagedFiles,
  concurrentEditMessage,
  evaluateStagedRun,
  isPublishableExtraArtifact,
  isStagingDirName,
  publishableFiles,
  requiredStagedFiles,
  sanitizeRunId,
  stagingDirName,
  fetchBicepFromRepo,
  fetchRecipePack,
  resolveRecipeOutputs
} from "./modeling/index.js";
export type { ConcreteResource, RecipePackEntry } from "./modeling/index.js";
export type { AppSourceEvaluation, AppSourceStatus } from "./modeling/index.js";
export type {
  ManagedFileHashes,
  StagedRunEvaluation,
  StagedRunInput,
  StagedRunRecord,
  StagedRunStatus
} from "./modeling/index.js";
export type {
  AppModelFreshness,
  AppModelFreshnessInput,
  AppModelFreshnessStatus,
  AppOrigin
} from "./modeling/index.js";
export {
  getPlatform,
  generatePortalUrl,
  buildOidcSubject,
  buildEnvironmentSuffix,
  buildFederatedCredentialName
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
