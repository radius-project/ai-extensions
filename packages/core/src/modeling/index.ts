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
  IGNORED_SOURCE_DIRS,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  evaluateAppSource,
  unsupportedAppSourceReport
} from "./app-source.js";
export type { AppSourceEvaluation, AppSourceStatus } from "./app-source.js";

export { fetchBicepFromRepo } from "./repo.js";
export { fetchRecipePack, resolveRecipeOutputs } from "./recipe-resolver.js";
