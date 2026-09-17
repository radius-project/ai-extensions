import { expect, it } from "vitest";
import { createRecipeEvidenceParser } from "./recipe-evidence.js";

const target = { repo: "owner/repo", environment: "dev" };
const value = {
  target,
  provider: "azure",
  recipes: [
    {
      resourceType: "Radius.Compute/containers",
      kind: "bicep",
      source: "br:ghcr.io/owner/recipes/container:v1"
    }
  ],
  observation: {
    quality: "current",
    completeness: "complete",
    evidence: "radius",
    observedAt: "2026-09-15T00:00:00Z"
  }
};
it("retains actual selected registrations including an observed empty set", () => {
  const parse = createRecipeEvidenceParser();
  expect(parse(target, value)).toMatchObject({ status: "ok", value });
  expect(parse(target, { ...value, recipes: [] })).toMatchObject({
    status: "ok",
    value: { recipes: [] }
  });
});
it.each([
  {
    ...value,
    observation: { ...value.observation, completeness: "unavailable" }
  },
  { ...value, target: { ...target, environment: "other" } },
  { ...value, recipes: [{ kind: "bicep" }] },
  {
    ...value,
    recipes: [
      {
        ...value.recipes[0],
        source: "https://reader:credential@example.com/recipe"
      }
    ]
  },
  { ...value, observation: { quality: "current" } }
])(
  "rejects mismatched, malformed or credential-bearing registration evidence",
  (evidence) => {
    expect(createRecipeEvidenceParser()(target, evidence)).toMatchObject({
      status: "failed",
      error: { code: "EVIDENCE_MISMATCH" }
    });
  }
);
