// @radius-project/core — UI-agnostic core for the Radius Canvas product.
//
// This package contains pure logic shared by every UI adapter (canvas, browser,
// chat): repository modeling, application-graph build/diff, the compute-platform
// abstraction, and workflow generation. It must not depend on the Copilot SDK,
// HTTP, or the DOM. Side effects (shell, GitHub API, state persistence, logging)
// are reached only through ports — see src/ports.
//
// Modules are extracted incrementally from the canvas adapter; see
// docs/design/radius-extension-modularization.md for the target layout.

export const RADIUS_CORE_VERSION = "0.1.0";

export {
  addInboundConnections,
  applicationGraphToResources,
  computeGraphDiff,
  deployStatusKeys,
  filterGraphVisualizationResources,
  lookupDeployStatus,
  projectDeployedGraph,
  MODELED_GRAPH_DEFAULTS,
  buildResourceID,
  stripAPIVersion
} from "./graph/index.js";
export type { DeployStatus } from "./graph/index.js";
export {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
  normalizeAppBicep,
  parseAppOrigin,
  serializeAppOrigin,
  RECIPE_PACK_REPO,
  RECIPE_PACK_REF,
  recipePackPathForProvider,
  recipePackContentPath,
  normalizeRecipeSource,
  deriveConcreteResource,
  parseRecipePack,
  IGNORED_SOURCE_DIRS,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  evaluateAppSource,
  findDockerfiles,
  isDockerfilePath,
  isIgnoredSourcePath,
  unsupportedAppSourceReport,
  fetchBicepFromRepo,
  fetchRecipePack,
  resolveRecipeOutputs
} from "./modeling/index.js";
export type { ConcreteResource, RecipePackEntry } from "./modeling/index.js";
export type {
  AppSourceEvaluation,
  AppSourceStatus
} from "./modeling/index.js";
export type {
  AppModelFreshness,
  AppModelFreshnessInput,
  AppModelFreshnessStatus,
  AppOrigin
} from "./modeling/index.js";
export {
  getPlatform,
  listPlatforms,
  generatePortalUrl,
  azure,
  aws,
  buildOidcSubject,
  buildEnvironmentSuffix,
  buildFederatedCredentialName
} from "./platforms/index.js";
export type {
  ComputePlatform,
  OidcResult,
  PortalContext,
  SecretSpec,
  PlatformCapabilities,
  OidcSubjectConfig,
  BuildOidcSubjectInput
} from "./platforms/index.js";
export {
  generateVerifyWorkflow,
  verifyTemplateFile,
  VERIFY_AZURE_FILE,
  VERIFY_AWS_FILE,
  generateDeployWorkflow,
  defaultDeployTemplateVars,
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE,
  DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS,
  DEFAULT_TARGET_CLUSTER_ARCH_MODE,
  DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS,
  RADIUS_BUILD_ARCH_MODE_VAR,
  RADIUS_BUILD_PLATFORMS_VAR,
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
export type {
  Shell,
  ShellResult,
  GitHub,
  StateStore,
  Clock,
  Logger,
  Ports
} from "./ports/index.js";
