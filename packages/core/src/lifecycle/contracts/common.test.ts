import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ConcreteResource,
  RecipePackEntry
} from "../../modeling/index.js";
import {
  actionResponseSchema,
  commonSchemas,
  handleSchema,
  type ConcreteResourceRecord,
  type RecipeRegistration,
  type Source,
  type ValidationCheck,
  type ValidationReport
} from "./common.js";

describe("lifecycle common schema data", () => {
  const outputRefSchema =
    actionResponseSchema.oneOf[1].properties.stagedOutputRefs.items;
  it.each([
    "a/b",
    "revision-1/app.bicep",
    "revision:01234567/custom-types.tgz",
    "staging/bicepconfig.json",
    "staging/custom-recipe-pack.bicep",
    "staging/redis-recipe.bicep",
    `${"a".repeat(256)}/${"b".repeat(255)}`
  ])("accepts scoped staged output reference %s", (ref) => {
    expect(new RegExp(outputRefSchema.pattern, "u").test(ref)).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(outputRefSchema.maxLength);
    expect(new RegExp(handleSchema.pattern, "u").test(ref)).toBe(false);
  });
  it.each([
    "",
    "output",
    "staged-output",
    "/app.bicep",
    "staging/",
    "../app.bicep",
    "staging/..",
    "staging/.",
    "staging/../app.bicep",
    "staging/nested/app.bicep",
    "staging//app.bicep",
    "C:/app.bicep",
    "C:staging/app.bicep",
    "C:\\app.bicep",
    "\\\\server\\share\\app.bicep",
    "//server/share",
    "staging\\app.bicep",
    "staging/C:app.bicep",
    "file:///app.bicep",
    "https://example.test/app.bicep",
    "staging/%2e%2e",
    "staging/app.bicep.",
    "staging/app.bicep ",
    "staging/app.bicep\n",
    "staging/CON",
    "staging/nul.bicep",
    `${"a".repeat(257)}/app.bicep`,
    `staging/${"b".repeat(256)}`
  ])("rejects unsafe or unscoped staged output reference %j", (ref) => {
    expect(new RegExp(outputRefSchema.pattern, "u").test(ref)).toBe(false);
  });
  it("publishes draft-07 JSON data without runtime dependencies", () => {
    for (const schema of Object.values(commonSchemas)) {
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    }
  });

  it("infers tagged sources, required validation checks and distinct statuses", () => {
    expectTypeOf<Extract<Source, { kind: "workspace" }>>().toEqualTypeOf<{
      kind: "workspace";
      workspaceRef: string;
      branch: string;
      expectedFingerprint: string;
    }>();
    expectTypeOf<Extract<Source, { kind: "git" }>>().toEqualTypeOf<{
      kind: "git";
      ref: string;
      expectedCommit: string;
    }>();
    expectTypeOf<ValidationReport["status"]>().toEqualTypeOf<
      "passed" | "failed" | "incomplete"
    >();
    expectTypeOf<ValidationCheck["status"]>().toEqualTypeOf<
      "passed" | "failed" | "unavailable" | "skipped"
    >();
    expectTypeOf<ValidationCheck["classification"]>().toEqualTypeOf<
      "required" | "advisory"
    >();
    expectTypeOf<ConcreteResourceRecord>().toEqualTypeOf<ConcreteResource>();
    expectTypeOf<RecipeRegistration>().toEqualTypeOf<RecipePackEntry>();
  });
});
