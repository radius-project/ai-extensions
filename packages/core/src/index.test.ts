import { describe, it, expect } from "vitest";
import * as core from "./index.js";

// The package barrel is the contract every adapter imports through. These tests
// pin the exported surface so a re-export dropped during a refactor breaks here
// rather than in an adapter build.
const EXPECTED_FUNCTIONS = [
  "addInboundConnections",
  "applicationGraphToResources",
  "computeGraphDiff",
  "deployStatusKeys",
  "filterGraphVisualizationResources",
  "lookupDeployStatus",
  "projectDeployedGraph",
  "buildResourceID",
  "stripAPIVersion",
  "evaluateAppModelFreshness",
  "normalizeAppBicep",
  "parseAppOrigin",
  "serializeAppOrigin",
  "recipePackPathForProvider",
  "recipePackContentPath",
  "normalizeRecipeSource",
  "deriveConcreteResource",
  "parseRecipePack",
  "evaluateAppSource",
  "findDockerfiles",
  "isDockerfilePath",
  "isIgnoredSourcePath",
  "unsupportedAppSourceReport",
  "fetchBicepFromRepo",
  "fetchRecipePack",
  "resolveRecipeOutputs",
  "getPlatform",
  "listPlatforms",
  "generatePortalUrl",
  "buildOidcSubject",
  "buildEnvironmentSuffix",
  "buildFederatedCredentialName",
  "generateVerifyWorkflow",
  "verifyTemplateFile",
  "generateDeployWorkflow",
  "defaultDeployTemplateVars",
  "stateRegistryForEnvironment",
  "generateDeleteWorkflow"
] as const;

const EXPECTED_VALUES = [
  "RADIUS_CORE_VERSION",
  "MODELED_GRAPH_DEFAULTS",
  "APP_ORIGIN_REPO_PATH",
  "APP_ORIGIN_ROOT_PATH",
  "RECIPE_PACK_REPO",
  "RECIPE_PACK_REF",
  "IGNORED_SOURCE_DIRS",
  "UNSUPPORTED_NO_DOCKERFILE_MESSAGE",
  "azure",
  "aws",
  "VERIFY_AZURE_FILE",
  "VERIFY_AWS_FILE",
  "RADIUS_REF",
  "RADIUS_WORKFLOW_REPO",
  "RADIUS_WORKFLOW_DIR",
  "DEPLOY_DISPATCHER_FILE",
  "DEPLOY_AZURE_FILE",
  "DEPLOY_AWS_FILE",
  "DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE",
  "DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS",
  "DEFAULT_TARGET_CLUSTER_ARCH_MODE",
  "DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS",
  "RADIUS_BUILD_ARCH_MODE_VAR",
  "RADIUS_BUILD_PLATFORMS_VAR",
  "DEFAULT_STATE_ARCHIVE",
  "OCI_STATE_BACKEND",
  "DELETE_RADIUS_REF",
  "DELETE_APP_DISPATCHER_FILE",
  "DELETE_AZURE_FILE",
  "DELETE_AWS_FILE"
] as const;

describe("@radius-project/core package barrel", () => {
  it("exports the package version constant", () => {
    expect(core.RADIUS_CORE_VERSION).toBe("0.1.0");
  });

  it.each(EXPECTED_FUNCTIONS)("exports %s as a callable", (name) => {
    expect(typeof core[name]).toBe("function");
  });

  it.each(EXPECTED_VALUES)("exports the %s value", (name) => {
    expect(core[name]).toBeDefined();
  });

  it("exports nothing beyond the documented surface", () => {
    const actual = Object.keys(core).sort();
    const expected = [...EXPECTED_FUNCTIONS, ...EXPECTED_VALUES].sort();

    expect(actual).toEqual(expected);
  });

  it("re-exports the same instances the submodule entry points expose", async () => {
    const [graph, modeling, platforms, workflows] = await Promise.all([
      import("./graph/index.js"),
      import("./modeling/index.js"),
      import("./platforms/index.js"),
      import("./workflows/index.js")
    ]);

    expect(core.computeGraphDiff).toBe(graph.computeGraphDiff);
    expect(core.parseRecipePack).toBe(modeling.parseRecipePack);
    expect(core.azure).toBe(platforms.azure);
    expect(core.aws).toBe(platforms.aws);
    expect(core.generateDeleteWorkflow).toBe(workflows.generateDeleteWorkflow);
  });

  it("keeps the platform registry reachable through the barrel", () => {
    expect(core.getPlatform("azure")).toBe(core.azure);
    expect(core.getPlatform("aws")).toBe(core.aws);
    expect(core.listPlatforms()).toEqual([core.azure, core.aws]);
  });
});
