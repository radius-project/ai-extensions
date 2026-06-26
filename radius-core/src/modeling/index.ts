// modeling/ — pure repository-modeling helpers: docker-compose + Terraform
// parsing, recipe parsing, resource-type mapping, and the canonical
// Radius-type → concrete-resource map, plus the GitHub-fetching orchestration
// (behind the GitHub port) that composes them into app.bicep / recipe outputs.

export { parseComposeServices } from "./compose.js";
export {
  parseTerraformResources,
  formatTerraformType,
  formatTerraformModule,
} from "./terraform.js";
export {
  mapFileToResourceType,
  parseRecipeResources,
  formatResourceType,
  radiusTypeToContribDir,
  CANONICAL_RESOURCE_MAP,
  categorizeToCanonicalType,
  resolveCanonicalResources,
  inferResourcesFromSchema,
  generateRecipeFromStaticMappings,
} from "./recipes.js";

export {
  discoverSourceCodeRefs,
  fetchBicepFromRepo,
  generateBicepFromRepo,
} from "./repo.js";
export {
  loadRecipeResources,
  fetchRecipesFromGitHub,
  resolveRecipeOutputs,
  fetchResourceTypeSchema,
  fetchRecipeFromAnyPlatform,
  generateRecipeFromContrib,
} from "./recipe-resolver.js";
