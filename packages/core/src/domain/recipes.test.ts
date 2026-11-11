import { describe, expect, it } from "vitest";
import { aggregateRecipes } from "./recipes.js";
import {
  getEquivalentTypes,
  isApplicationType,
  isEnvironmentType
} from "./resources.js";
import type { Resource, RecipePackProperties } from "./resources.js";

describe("shared resource and recipe contracts", () => {
  it.each(["applications", "environments"])(
    "keeps legacy-first %s equivalents and returns independent arrays",
    (type) => {
      const expected = [`Applications.Core/${type}`, `Radius.Core/${type}`];
      expect(getEquivalentTypes(expected[1])).toEqual(expected);
      const first = getEquivalentTypes(expected[0]);
      first?.reverse();
      expect(getEquivalentTypes(expected[0])).toEqual(expected);
    }
  );
  it("uses exact type membership without treating unknown types as equivalents", () => {
    expect(isApplicationType()).toBe(false);
    expect(isEnvironmentType()).toBe(false);
    expect(isApplicationType("Applications.Core/applications")).toBe(true);
    expect(isApplicationType("Radius.Core/environments")).toBe(false);
    expect(isEnvironmentType("Radius.Core/environments")).toBe(true);
    expect(isEnvironmentType("radius.core/environments")).toBe(false);
    expect(getEquivalentTypes("Other/applications")).toBeUndefined();
  });
  it("preserves inline and pack order, duplicates, and last case-insensitive pack key", () => {
    const pack: Resource<RecipePackProperties> = {
      id: "/planes/radius/local/resourceGroups/test/providers/Radius.Core/recipePacks/actual",
      name: "fallback",
      type: "Radius.Core/recipePacks",
      systemData: {},
      properties: { recipes: { db: { kind: "bicep", source: "pack" } } }
    };
    const environment = {
      recipes: {
        db: {
          first: { templateKind: "bicep", templatePath: "inline" },
          second: { templateKind: "bicep", templatePath: "inline" }
        }
      },
      recipePacks: ["MISSING", "PACK", "pack", "invalid"]
    };
    const before = structuredClone(environment);
    expect(
      aggregateRecipes(environment, {
        PACK: { ...pack, properties: { recipes: {} } },
        pack,
        invalid: { ...pack, id: "invalid" }
      })
    ).toEqual([
      { recipePack: "", type: "db", kind: "bicep", source: "inline" },
      { recipePack: "", type: "db", kind: "bicep", source: "inline" },
      { recipePack: "actual", type: "db", kind: "bicep", source: "pack" },
      { recipePack: "actual", type: "db", kind: "bicep", source: "pack" },
      { recipePack: "fallback", type: "db", kind: "bicep", source: "pack" }
    ]);
    expect(environment).toEqual(before);
  });
  it("retains explicit empty recipe data", () => {
    expect(aggregateRecipes({ recipes: {} }, {})).toEqual([]);
    expect(aggregateRecipes({}, {})).toEqual([]);
  });
});
