import { describe, expect, it } from "vitest";
import {
  MODEL_ONLY_MARKER,
  MODEL_ONLY_MESSAGE,
  modelOnlyRestriction,
  parseModelOnlyAuthoring,
  validateModelOnlyArtifacts
} from "./model-authoring.js";
import { parseAppOrigin, serializeAppOrigin } from "./app-origin.js";

const evidence = {
  mode: "model-only",
  deployment: "unverified",
  profile: "compose.yaml + compose.full.yaml",
  recipes: [
    {
      resourceType: "Radius.Compute/containers",
      apiVersion: "2025-08-01-preview",
      sourcePath: ".radius/recipes/containers/main.bicep",
      sourceHash: `sha256:${"a".repeat(64)}`
    }
  ]
};

describe("model-only authoring evidence", () => {
  it("round trips evidence without turning compilation provenance into deployment readiness", () => {
    const authoring = parseModelOnlyAuthoring(evidence);
    const origin = {
      generatedAt: "2026-10-11T00:00:00Z",
      sourceCommit: "b".repeat(40),
      skillVersion: "1",
      appBicepHash: `sha256:${"c".repeat(64)}`,
      authoring
    };
    expect(parseAppOrigin(serializeAppOrigin(origin))).toEqual(origin);
    expect(
      parseAppOrigin(JSON.stringify({ ...origin, authoring: {} }))
    ).toBeNull();
    expect(
      parseModelOnlyAuthoring({
        ...evidence,
        recipes: [
          { ...evidence.recipes[0], artifactDigest: `sha256:${"d".repeat(64)}` }
        ]
      }).recipes[0].artifactDigest
    ).toBe(`sha256:${"d".repeat(64)}`);
  });

  it.each([
    null,
    [],
    "model-only",
    {},
    { ...evidence, mode: "deploy" },
    { ...evidence, deployment: "ready" },
    { ...evidence, profile: "" },
    { ...evidence, recipes: [] },
    { ...evidence, recipes: null },
    { ...evidence, recipes: [null] },
    ...["sourcePath", "sourceHash", "resourceType", "apiVersion"].map(
      (field) => ({
        ...evidence,
        recipes: [{ ...evidence.recipes[0], [field]: "" }]
      })
    ),
    ...[
      "/outside",
      "../outside",
      "a/../b",
      "a//b",
      "a/./b",
      "C:\\file",
      "a\\b",
      "br:tag"
    ].map((sourcePath) => ({
      ...evidence,
      recipes: [{ ...evidence.recipes[0], sourcePath }]
    })),
    {
      ...evidence,
      recipes: [{ ...evidence.recipes[0], sourceHash: "latest" }]
    },
    {
      ...evidence,
      recipes: [{ ...evidence.recipes[0], artifactDigest: "sha256:abc" }]
    }
  ])("rejects incomplete, mutable or unconfined evidence: %j", (value) => {
    expect(() => parseModelOnlyAuthoring(value)).toThrow();
  });

  it.each([undefined, null, "", "{}"])(
    "leaves the legacy/default authoring contract unchanged for %j",
    (origin) => {
      expect(modelOnlyRestriction("resource app = {}", origin)).toBeNull();
    }
  );

  it("retains the restriction when either durable copy is removed or mutated", () => {
    const origin = JSON.stringify({ authoring: evidence });
    expect(modelOnlyRestriction(MODEL_ONLY_MARKER)).toBe(MODEL_ONLY_MESSAGE);
    expect(modelOnlyRestriction("edited model", origin)).toBe(
      MODEL_ONLY_MESSAGE
    );
    for (const changed of [
      "broken",
      "null",
      "[]",
      '{"authoring":null}',
      '{"authoring":{"mode":"ready"}}'
    ]) {
      expect(modelOnlyRestriction("", changed)).toContain(
        "cannot be established"
      );
    }
  });

  it("requires paired evidence and prevents staged-run evidence mutation", () => {
    const authoring = parseModelOnlyAuthoring(evidence);
    const origin = JSON.stringify({ authoring });
    expect(() =>
      validateModelOnlyArtifacts(MODEL_ONLY_MARKER, origin, authoring)
    ).not.toThrow();
    expect(() => validateModelOnlyArtifacts(MODEL_ONLY_MARKER, origin)).toThrow(
      "retain"
    );
    expect(() => validateModelOnlyArtifacts("default", "{}")).not.toThrow();
    expect(() => validateModelOnlyArtifacts("model", origin)).toThrow(
      "both be retained"
    );
    expect(() => validateModelOnlyArtifacts(MODEL_ONLY_MARKER, "{}")).toThrow(
      "both be retained"
    );
    expect(() => validateModelOnlyArtifacts("model", "{}", authoring)).toThrow(
      "retain"
    );
    expect(() =>
      validateModelOnlyArtifacts(MODEL_ONLY_MARKER, origin, {
        ...authoring,
        profile: "other"
      })
    ).toThrow("retain");
  });
});
