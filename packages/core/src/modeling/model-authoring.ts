export const MODEL_ONLY_MARKER =
  "// Radius authoring: model-only; deployment: unverified.";
export const MODEL_ONLY_MESSAGE =
  "Model-only application: deployment is unverified. Recipe source evidence is not Environment registration or runtime validation. Deployment planning and deployment are unavailable; retain this restriction when regenerating.";

export interface ModelOnlyAuthoring {
  mode: "model-only";
  deployment: "unverified";
  profile: string;
  recipes: {
    resourceType: string;
    apiVersion: string;
    sourcePath: string;
    sourceHash: string;
    artifactDigest?: string;
  }[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model-only evidence must be an object.");
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Model-only evidence contains a missing or empty field.");
  }
  return value.trim();
}

function digest(value: unknown): string {
  const result = text(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) {
    throw new Error("Model-only evidence requires an exact sha256 digest.");
  }
  return result;
}

export function parseModelOnlyAuthoring(value: unknown): ModelOnlyAuthoring {
  const fields = record(value);
  if (fields.mode !== "model-only" || fields.deployment !== "unverified") {
    throw new Error("Authoring evidence must declare model-only/unverified.");
  }
  if (!Array.isArray(fields.recipes) || fields.recipes.length === 0) {
    throw new Error(
      "Model-only authoring requires pinned Recipe source evidence."
    );
  }
  const recipes = fields.recipes.map((entry: unknown) => {
    const recipe = record(entry);
    const sourcePath = text(recipe.sourcePath);
    if (
      sourcePath.startsWith("/") ||
      sourcePath.includes("\\") ||
      sourcePath.includes(":") ||
      sourcePath
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(
        "Recipe evidence sourcePath must be repository-relative."
      );
    }
    return {
      resourceType: text(recipe.resourceType),
      apiVersion: text(recipe.apiVersion),
      sourcePath,
      sourceHash: digest(recipe.sourceHash),
      ...(recipe.artifactDigest === undefined ?
        {}
      : {
          artifactDigest: digest(recipe.artifactDigest)
        })
    };
  });
  return {
    mode: "model-only",
    deployment: "unverified",
    profile: text(fields.profile),
    recipes
  };
}

// This recognizes an explicit provenance marker, not Bicep semantics. Either
// durable copy is sufficient to restrict consumers when its sibling is lost.
export function modelOnlyRestriction(
  model: string,
  originText?: string | null
): string | null {
  if (model.includes(MODEL_ONLY_MARKER)) return MODEL_ONLY_MESSAGE;
  if (!originText) return null;
  try {
    const origin = record(JSON.parse(originText));
    if (origin.authoring !== undefined) {
      parseModelOnlyAuthoring(origin.authoring);
      return MODEL_ONLY_MESSAGE;
    }
  } catch {
    return "Application authoring provenance is invalid; deployment readiness cannot be established.";
  }
  return null;
}

export function validateModelOnlyArtifacts(
  model: string,
  originText: string,
  expected?: ModelOnlyAuthoring
): void {
  const origin = record(JSON.parse(originText));
  const authoring =
    origin.authoring === undefined ?
      undefined
    : parseModelOnlyAuthoring(origin.authoring);
  if (Boolean(authoring) !== model.includes(MODEL_ONLY_MARKER)) {
    throw new Error(
      "Model-only marker and origin evidence must both be retained."
    );
  }
  if (JSON.stringify(authoring) !== JSON.stringify(expected)) {
    throw new Error(
      "The staged run must retain its selected model-only evidence."
    );
  }
}
