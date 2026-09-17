import { stripAPIVersion } from "../graph/model.js";
import { deriveConcreteResource } from "../modeling/recipe-pack.js";
import { normalizeRecipeResourceType } from "../modeling/recipe-resolver.js";
import type { CanonicalGraph, RecipeRegistration } from "./contracts/common.js";
import {
  portFailure,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import type { ReadonlyData, RecipeRegistrationEvidence } from "./ports.js";

function unavailable(message: string) {
  return portUnavailable(
    "RESULT_UNAVAILABLE",
    {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "radius",
      limitation: message
    },
    { diagnostics: [{ message, truncated: false }] }
  );
}

export function enrichGraphWithRegistrations(
  graph: ReadonlyData<CanonicalGraph>,
  evidence: RecipeRegistrationEvidence
): PortResult<CanonicalGraph> {
  if (
    evidence.observation.quality !== "current" ||
    evidence.observation.completeness !== "complete"
  )
    return unavailable(
      "Current complete actual environment recipe registrations are required for a planned graph."
    );
  const recipes = new Map<string, ReadonlyData<RecipeRegistration>>();
  for (const recipe of evidence.recipes) {
    const type = normalizeRecipeResourceType(recipe.resourceType);
    if (recipes.has(type)) return portFailure("EVIDENCE_CONFLICT");
    recipes.set(type, recipe);
  }
  const resources: CanonicalGraph["resources"] = [];
  for (const resource of graph.resources) {
    const type = normalizeRecipeResourceType(stripAPIVersion(resource.type));
    const recipe = recipes.get(type);
    if (!recipe) return portFailure("RECIPE_PACK_REQUIRED");
    if (recipe.kind !== "bicep")
      return unavailable(
        "The registered recipe kind has no supported read-only output projection."
      );
    if (
      !recipe.source.startsWith("br:mcr.microsoft.com/bicep/avm/res/") &&
      !recipe.source.startsWith("br:ghcr.io/radius-project/kube-recipes/")
    )
      return unavailable(
        "The actual registered recipe source is outside the registries covered by the existing primary-resource mapping."
      );
    const concrete = deriveConcreteResource(recipe.source);
    if (!concrete)
      return unavailable(
        "The registered recipe has no known primary-resource projection; its outputs cannot be inferred from the available read evidence."
      );
    resources.push({
      ...resource,
      connections: resource.connections.map((connection) => ({
        ...connection
      })),
      outputResources: [concrete]
    });
  }
  return portSuccess({ resources });
}
