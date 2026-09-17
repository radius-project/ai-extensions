import {
  environmentConfigurationSchema,
  type EnvironmentConfiguration
} from "./contracts/catalog.js";
import type {
  EnvironmentChange,
  EnvironmentConfigurationPlan,
  EnvironmentInspection,
  EnvironmentSelection
} from "./ports.js";
import { portFailure, portSuccess, type PortResult } from "./errors.js";
import { sameLifecycleData } from "./operations.js";

/** A patch never supplies omitted configuration from another environment or provider. */
export function planEnvironmentConfiguration(
  target: EnvironmentSelection,
  change: EnvironmentChange,
  current: EnvironmentInspection | null
): PortResult<EnvironmentConfigurationPlan> {
  if (change.operation === "environment.create") {
    return current ?
        portFailure("PRECONDITION_FAILED")
      : portSuccess(
          structuredClone({
            target,
            change,
            configuration: change.configuration,
            expected: null
          })
        );
  }
  const previous = current?.configuration;
  const patch = change.patch;
  if (
    !current ||
    !previous ||
    !sameLifecycleData(current.target, target) ||
    current.observation.quality !== "current" ||
    current.observation.completeness === "unavailable"
  )
    return portFailure("PRECONDITION_FAILED");
  const identityRef = patch.identityRef ?? previous.identityRef;
  const references = patch.recipes ?? previous.recipes;
  if (!identityRef || !references) return portFailure("PRECONDITION_FAILED");
  if (
    !patch.recipes &&
    (current.recipeObservation?.quality !== "current" ||
      current.recipeObservation.completeness !== "complete")
  )
    return portFailure("RECIPE_PACK_REQUIRED");
  const recipeSchema =
    environmentConfigurationSchema.oneOf[0].properties.recipes.items;
  if (
    references.some(
      (recipe) =>
        recipe.kind !== "bicep" ||
        !new RegExp(recipeSchema.properties.source.pattern).test(
          recipe.source
        ) ||
        !new RegExp(recipeSchema.properties.resourceType.pattern).test(
          recipe.resourceType
        )
    )
  )
    return portFailure("RECIPE_PACK_REQUIRED");
  const recipes = references.map((recipe) => ({
    ...recipe,
    kind: "bicep" as const
  }));
  let configuration: EnvironmentConfiguration;
  if (patch.provider === "azure") {
    if (previous.provider !== "azure")
      return portFailure("PRECONDITION_FAILED");
    const settings = { ...previous.settings, ...patch.settings };
    if (
      !settings.subscriptionId ||
      !settings.resourceGroup ||
      !settings.location
    )
      return portFailure("PRECONDITION_FAILED");
    configuration = {
      provider: "azure",
      identityRef,
      recipes,
      settings: {
        subscriptionId: settings.subscriptionId,
        resourceGroup: settings.resourceGroup,
        location: settings.location
      }
    };
  } else {
    if (previous.provider !== "aws") return portFailure("PRECONDITION_FAILED");
    const settings = { ...previous.settings, ...patch.settings };
    if (!settings.accountId || !settings.region || !settings.roleName)
      return portFailure("PRECONDITION_FAILED");
    configuration = {
      provider: "aws",
      identityRef,
      recipes,
      settings: {
        accountId: settings.accountId,
        region: settings.region,
        roleName: settings.roleName
      }
    };
  }
  return portSuccess(
    structuredClone({ target, change, configuration, expected: current })
  );
}
