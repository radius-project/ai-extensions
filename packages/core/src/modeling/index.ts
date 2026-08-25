// modeling/ — pure repository-modeling helpers: recipe-pack parsing and
// concrete-resource derivation, plus the GitHub-fetching orchestration (behind
// the GitHub port) that fetches the skill-generated app.bicep and resolves the
// default recipe pack's outputs for the planned graph.

export { RECIPE_PACK_REF } from "./recipe-pack.js";
export type { ConcreteResource, RecipePackEntry } from "./recipe-pack.js";

export {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
  normalizeAppBicep,
  parseAppOrigin,
  serializeAppOrigin
} from "./app-origin.js";
export type {
  AppModelFreshness,
  AppModelFreshnessInput,
  AppModelFreshnessStatus,
  AppOrigin
} from "./app-origin.js";

export {
  CONCURRENT_EDIT_MESSAGE,
  CUSTOM_TYPE_STAGED_FILES,
  REPAIR_ATTEMPT_BUDGET,
  REPAIR_COMPILE_LIMIT,
  REPEATED_FAILURE_MESSAGE,
  REQUIRED_STAGED_FILES,
  STAGING_DIR_PREFIX,
  STAGING_IGNORE_PATTERN,
  STAGING_RUN_RECORD,
  UNRECORDED_RUN_MESSAGE,
  changedManagedFiles,
  concurrentEditMessage,
  evaluateRepairAttempt,
  evaluateStagedRun,
  fingerprintCompilerOutput,
  isPublishableExtraArtifact,
  isRepeatedFailure,
  isStagingDirName,
  nextRepairState,
  parseRepairState,
  publishableFiles,
  repairBudgetSpentMessage,
  requiredStagedFiles,
  sanitizeRunId,
  stagingDirName
} from "./app-staging.js";
export type {
  ManagedFileHashes,
  RepairDecision,
  RepairState,
  RepairVerdict,
  StagedRunEvaluation,
  StagedRunInput,
  StagedRunRecord,
  StagedRunStatus
} from "./app-staging.js";

export {
  IGNORED_SOURCE_DIRS,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  UNIDENTIFIED_APPLICATION_MESSAGE,
  WORKSPACE_MANIFEST_FILES,
  ambiguousAppSourceBrief,
  dockerfileDirectories,
  evaluateAppSource,
  findWorkspaceManifests,
  unsupportedAppSourceReport
} from "./app-source.js";
export type { AppSourceEvaluation, AppSourceStatus } from "./app-source.js";

export { fetchBicepFromRepo } from "./repo.js";
export { fetchRecipePack, resolveRecipeOutputs } from "./recipe-resolver.js";
