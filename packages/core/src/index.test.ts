import { describe, it, expect } from "vitest";
import * as core from "./index.js";

// The package barrel is the contract every adapter imports through. These tests
// pin the exported surface so a re-export dropped during a refactor breaks here
// rather than in an adapter build — and so a helper that only core itself uses
// cannot drift back into the public surface unnoticed.
//
// Pending confirmation: `dockerfileDirectories`, `findWorkspaceManifests`, and
// `WORKSPACE_MANIFEST_FILES` arrived in #450 and still have no consumer outside
// core — the same category of unused export this change removed elsewhere. They
// are pinned here as staging for the in-flight monorepo-detection work rather
// than as a settled contract; if that work does not land, they should be removed
// along with these entries.
const EXPECTED_FUNCTIONS = [
  "applicationGraphToResources",
  "computeGraphDiff",
  "deployStatusKeys",
  "filterGraphVisualizationResources",
  "lookupDeployStatus",
  "mergeDeployedGraphMetadata",
  "projectDeployedGraph",
  "evaluateAppModelFreshness",
  "freshnessIdentity",
  "normalizeAppBicep",
  "parseAppOrigin",
  "serializeAppOrigin",
  "evaluateAppSource",
  "ambiguousAppSourceBrief",
  "dockerfileDirectories",
  "findWorkspaceManifests",
  "unsupportedAppSourceReport",
  "fetchBicepFromRepo",
  "fetchRecipePack",
  "resolveRecipeOutputs",
  "getPlatform",
  "generatePortalUrl",
  "buildOidcSubject",
  "buildEnvironmentSuffix",
  "buildFederatedCredentialName",
  "buildRemediation",
  "isRemediationId",
  "remediationSessionMessage",
  "remediationView",
  "generateVerifyWorkflow",
  "verifyTemplateFile",
  "generateDeployWorkflow",
  "stateRegistryForEnvironment",
  "generateDeleteWorkflow"
] as const;

const EXPECTED_VALUES = [
  "APP_ORIGIN_REPO_PATH",
  "APP_ORIGIN_ROOT_PATH",
  "RECIPE_PACK_REF",
  "IGNORED_SOURCE_DIRS",
  "UNSUPPORTED_NO_DOCKERFILE_MESSAGE",
  "UNIDENTIFIED_APPLICATION_MESSAGE",
  "WORKSPACE_MANIFEST_FILES",
  // The staging rules are core's specification for the bundled promote script
  // and are reached through the modeling barrel; only the directory prefix is
  // public, because publish-targets.ts confines tool paths against it.
  "STAGING_DIR_PREFIX",
  "RADIUS_REF",
  "RADIUS_WORKFLOW_REPO",
  "RADIUS_WORKFLOW_DIR",
  "DEPLOY_DISPATCHER_FILE",
  "DEPLOY_AZURE_FILE",
  "DEPLOY_AWS_FILE",
  "DEFAULT_STATE_ARCHIVE",
  "OCI_STATE_BACKEND",
  "DELETE_RADIUS_REF",
  "DELETE_APP_DISPATCHER_FILE",
  "DELETE_AZURE_FILE",
  "DELETE_AWS_FILE",
  "REMEDIATION_IDS",
  "GENERATED_MODEL_PATHS"
] as const;

// Helpers that live inside core and are deliberately not part of the package's
// public contract. Re-exporting one is a surface regression, not a convenience.
const MODULE_INTERNAL_NAMES = [
  "addInboundConnections",
  "stripAPIVersion",
  "azure",
  "aws",
  "listPlatforms",
  "RECIPE_PACK_REPO",
  "recipePackPathForProvider",
  "recipePackContentPath",
  "normalizeRecipeSource",
  "deriveConcreteResource",
  "parseRecipePack",
  "findDockerfiles",
  "evaluateStagedRun",
  "publishableFiles",
  "requiredStagedFiles",
  "isPublishableExtraArtifact",
  "isDockerfilePath",
  "isIgnoredSourcePath",
  "defaultDeployTemplateVars",
  "VERIFY_AZURE_FILE",
  "VERIFY_AWS_FILE",
  "DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE",
  "DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS",
  "DEFAULT_TARGET_CLUSTER_ARCH_MODE",
  "DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS",
  "RADIUS_BUILD_ARCH_MODE_VAR",
  "RADIUS_BUILD_PLATFORMS_VAR"
] as const;

describe("@radius-project/core package barrel", () => {
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

  it.each(MODULE_INTERNAL_NAMES)(
    "keeps %s out of the public surface",
    (name) => {
      expect(Object.keys(core)).not.toContain(name);
    }
  );

  it("re-exports the same instances the submodule barrels expose", async () => {
    const [graph, modeling, platforms, workflows] = await Promise.all([
      import("./graph/index.js"),
      import("./modeling/index.js"),
      import("./platforms/index.js"),
      import("./workflows/index.js")
    ]);

    expect(core.computeGraphDiff).toBe(graph.computeGraphDiff);
    expect(core.evaluateAppSource).toBe(modeling.evaluateAppSource);
    expect(core.getPlatform).toBe(platforms.getPlatform);
    expect(core.generateDeleteWorkflow).toBe(workflows.generateDeleteWorkflow);
  });

  it("keeps the platform registry reachable through the barrel", () => {
    expect(core.getPlatform("azure")?.id).toBe("azure");
    expect(core.getPlatform("aws")?.id).toBe("aws");
    expect(core.getPlatform("gcp")).toBeUndefined();
  });
});
