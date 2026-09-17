import Ajv from "ajv";
import {
  nameSchema,
  repositorySchema,
  providerSchema,
  recipeRegistrationSchema,
  observationSchema,
  portFailure,
  portSuccess,
  type EnvironmentSelection,
  type RecipeRegistrationEvidence,
  type PortResult
} from "@radius-project/core/lifecycle";

export function createRecipeEvidenceParser() {
  const validate = new Ajv({
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  }).compile<RecipeRegistrationEvidence>({
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: repositorySchema,
          environment: nameSchema
        },
        required: ["repo", "environment"]
      },
      provider: providerSchema,
      recipes: {
        type: "array",
        maxItems: 100,
        items: recipeRegistrationSchema
      },
      observation: {
        ...observationSchema,
        required: [...observationSchema.required, "observedAt"]
      }
    },
    required: ["target", "provider", "recipes", "observation"]
  });
  return (
    target: EnvironmentSelection,
    value: unknown
  ): PortResult<RecipeRegistrationEvidence> => {
    if (
      !validate(value) ||
      value.observation.completeness === "unavailable" ||
      value.target.repo !== target.repo ||
      value.target.environment !== target.environment ||
      value.recipes.some((recipe) =>
        /(?:https?:\/\/|br:)[^/]*@|[?&](?!ref=)/i.test(recipe.source)
      )
    )
      return portFailure("EVIDENCE_MISMATCH");
    return portSuccess(structuredClone(value));
  };
}
