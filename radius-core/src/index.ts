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
  MODELED_GRAPH_DEFAULTS,
  computeDiffHash,
  buildModeledGraph,
  stripAPIVersion,
  addInboundConnections,
  buildResourceID,
  applicationGraphToResources,
  computeGraphDiff,
} from "./graph/index.js";
export {
  parseTerraformResources,
  formatTerraformType,
  formatTerraformModule,
  mapFileToResourceType,
  parseRecipeResources,
  formatResourceType,
  radiusTypeToContribDir,
  discoverSourceCodeRefs,
  fetchBicepFromRepo,
  loadRecipeResources,
  fetchRecipesFromGitHub,
  resolveRecipeOutputs,
} from "./modeling/index.js";
export {
  getPlatform,
  listPlatforms,
  generatePortalUrl,
  azure,
  aws,
} from "./platforms/index.js";
export type {
  ComputePlatform,
  OidcResult,
  PortalContext,
  SecretSpec,
  PlatformCapabilities,
} from "./platforms/index.js";
export {
  generateVerifyWorkflow,
  verifyTemplateFile,
  VERIFY_AZURE_FILE,
  VERIFY_AWS_FILE,
  generateDeployWorkflow,
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeleteWorkflow,
  DELETE_RADIUS_REF,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE,
} from "./workflows/index.js";
export type { DeployWorkflowFiles, DeleteWorkflowFiles } from "./workflows/index.js";
export type {
  Shell,
  ShellResult,
  GitHub,
  StateStore,
  Clock,
  Logger,
  Ports,
} from "./ports/index.js";

