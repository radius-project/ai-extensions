import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../../../../", import.meta.url);
const {
  extractRecipeDefinition,
  parseAzureRecipePackPin,
  validateAzureRecipePack
} = await import(
  new URL(
    "plugins/radius/skills/radius-app-bicep/scripts/radius-recipe-pack.mjs",
    repositoryRoot
  ).href
);

const fixtureRoot = new URL(
  "../../fixtures/radius-type-definition/",
  import.meta.url
);
const defaults = readFileSync(new URL("defaults.yaml", fixtureRoot), "utf8");
const recipePack = readFileSync(
  new URL("aks-recipepack.bicep", fixtureRoot),
  "utf8"
);
const postgreSqlRecipe = readFileSync(
  new URL("postgresql-recipe.bicep", fixtureRoot),
  "utf8"
).trimEnd();
const resourceTypesContribCommit = "d35ca390587661117a45a37bc2916f7aebf11428";
const azureRecipePackPin = `  - name: azure
    repo: github.com/radius-project/resource-types-contrib
    ref: ${resourceTypesContribCommit}
    tag: "recipe-pack/azure/v0.1.0"`;

function replaceAzureRecipePackPin(
  replacement: (pin: string) => string
): string {
  return defaults.replace(azureRecipePackPin, replacement(azureRecipePackPin));
}

describe("parseAzureRecipePackPin", () => {
  it("returns the exact immutable Azure Recipe-pack source", () => {
    expect(parseAzureRecipePackPin(defaults)).toEqual({
      repository: "radius-project/resource-types-contrib",
      commit: resourceTypesContribCommit
    });
    expect(
      [...defaults.matchAll(/^    ref: ([0-9a-f]{40})$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(Array(3).fill(resourceTypesContribCommit));
    expect(
      parseAzureRecipePackPin(
        replaceAzureRecipePackPin((pin) =>
          pin.replace(
            resourceTypesContribCommit,
            resourceTypesContribCommit.toUpperCase()
          )
        )
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\r\n")
      )
    ).toEqual({
      repository: "radius-project/resource-types-contrib",
      commit: resourceTypesContribCommit
    });
  });

  it("accepts an indentationless Recipe-pack sequence", () => {
    expect(
      parseAzureRecipePackPin(`recipePacks:
- name: azure
  repo: github.com/radius-project/resource-types-contrib
  ref: ${resourceTypesContribCommit}
defaultRegistration: []`)
    ).toEqual({
      repository: "radius-project/resource-types-contrib",
      commit: resourceTypesContribCommit
    });
  });

  it.each([
    [
      "without an Azure entry",
      defaults.replace("  - name: azure", "  - name: other"),
      /do not contain an Azure Recipe pack/u
    ],
    [
      "with multiple Azure entries",
      defaults.replace(
        "defaultRegistration:",
        `  - name: azure
    repo: github.com/radius-project/resource-types-contrib
    ref: ${resourceTypesContribCommit}
defaultRegistration:`
      ),
      /multiple Azure Recipe packs/u
    ],
    [
      "from another repository",
      replaceAzureRecipePackPin((pin) =>
        pin.replace(
          "github.com/radius-project/resource-types-contrib",
          "github.com/example/provider"
        )
      ),
      /resource-types-contrib/u
    ],
    [
      "without a commit",
      replaceAzureRecipePackPin((pin) =>
        pin.replace(`    ref: ${resourceTypesContribCommit}\n`, "")
      ),
      /full commit SHA/u
    ],
    [
      "with an abbreviated commit",
      replaceAzureRecipePackPin((pin) =>
        pin.replace(
          resourceTypesContribCommit,
          resourceTypesContribCommit.slice(0, 12)
        )
      ),
      /full commit SHA/u
    ]
  ])("rejects release defaults %s", (_case, source, expected) => {
    expect(() => parseAzureRecipePackPin(source)).toThrow(expected);
  });

  it.each([
    [
      "repository",
      '    repo: github.com/example/provider\n    tag: "recipe-pack/azure/v0.1.0"'
    ],
    [
      "commit",
      `    ref: ${"c".repeat(40)}\n    tag: "recipe-pack/azure/v0.1.0"`
    ]
  ])("rejects a duplicate Azure Recipe-pack %s", (_field, duplicate) => {
    expect(() =>
      parseAzureRecipePackPin(
        defaults.replace('    tag: "recipe-pack/azure/v0.1.0"', duplicate)
      )
    ).toThrow(/duplicate "repo" or "ref" field/u);
  });

  it("rejects non-text and structurally unrelated input", () => {
    expect(() => parseAzureRecipePackPin(null)).toThrow(/must be text/u);
    expect(() =>
      parseAzureRecipePackPin(
        "recipePacks:\n  ignored: true\ndefaultRegistration:"
      )
    ).toThrow(/do not contain an Azure Recipe pack/u);
  });
});

describe("extractRecipeDefinition", () => {
  it("returns only the exact requested definition for any predefined type", () => {
    expect(
      extractRecipeDefinition(recipePack, "Radius.Data/postgreSqlDatabases")
    ).toBe(postgreSqlRecipe);
    expect(
      extractRecipeDefinition(recipePack, "Radius.Data/redisCaches")
    ).toContain("'Radius.Data/redisCaches': {");
    expect(
      extractRecipeDefinition(recipePack, "Radius.Messaging/rabbitMQ")
    ).toContain(
      "source: 'ghcr.io/radius-project/kube-recipes/rabbitmq:latest'"
    );
    expect(
      extractRecipeDefinition(recipePack, "Radius.Core/applications")
    ).toBeUndefined();
  });

  it("preserves indentation and line endings", () => {
    expect(
      extractRecipeDefinition(
        recipePack.replaceAll("\n", "\r\n"),
        "Radius.Data/postgreSqlDatabases"
      )
    ).toBe(postgreSqlRecipe.replaceAll("\n", "\r\n"));
    expect(
      extractRecipeDefinition(
        recipePack
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
        "Radius.Data/postgreSqlDatabases"
      )
    ).toBe(
      postgreSqlRecipe
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")
    );
  });

  it("preserves inline comments on definition boundaries", () => {
    const source = `resource recipes 'Radius.Core/recipePacks@2025-08-01-preview' = {
  properties: {
    recipes: {
      'Radius.Data/postgreSqlDatabases': { // PostgreSQL default
        kind: 'bicep'
        source: 'example.azurecr.io/postgresql:1.0.0'
      } // end PostgreSQL
    }
  }
}`;

    expect(extractRecipeDefinition(source, "Radius.Data/postgreSqlDatabases"))
      .toBe(`      'Radius.Data/postgreSqlDatabases': { // PostgreSQL default
        kind: 'bicep'
        source: 'example.azurecr.io/postgresql:1.0.0'
      } // end PostgreSQL`);
  });

  it("rejects duplicate definitions", () => {
    expect(() =>
      extractRecipeDefinition(
        `${recipePack}\n${recipePack}`,
        "Radius.Data/postgreSqlDatabases"
      )
    ).toThrow(/multiple Recipe definitions.*postgreSqlDatabases/u);
  });

  it.each([
    [
      "without a closing boundary",
      "      'Radius.Data/postgreSqlDatabases': {\n        kind: 'bicep'"
    ],
    [
      "before the next definition",
      recipePack.replace(
        postgreSqlRecipe,
        postgreSqlRecipe.slice(0, postgreSqlRecipe.lastIndexOf("\n"))
      )
    ]
  ])("rejects an incomplete definition %s", (_case, source) => {
    expect(() =>
      extractRecipeDefinition(source, "Radius.Data/postgreSqlDatabases")
    ).toThrow(/incomplete Recipe definition/u);
  });

  it("rejects invalid lookup inputs", () => {
    expect(() =>
      extractRecipeDefinition(null, "Radius.Data/postgreSqlDatabases")
    ).toThrow(/must be text/u);
    for (const resourceType of [
      null,
      "Radius.Data/postgreSqlDatabases@2025-08-01-preview",
      "Radius.Resources/postgreSqlDatabases"
    ]) {
      expect(() => extractRecipeDefinition(recipePack, resourceType)).toThrow(
        /requires an exact predefined resource type/u
      );
    }
  });
});

describe("validateAzureRecipePack", () => {
  it("accepts the pinned pack and line comments on structural boundaries", () => {
    expect(() => validateAzureRecipePack(recipePack)).not.toThrow();
    expect(() =>
      validateAzureRecipePack(`resource recipes 'Radius.Core/recipePacks@2025-08-01-preview' = { // pack
  properties: {
    recipes: { // recipes
      'Radius.Data/widgets': { // default
      }
    }
  }
}`)
    ).not.toThrow();
  });

  it.each([
    ["non-text", null],
    ["empty text", " \n"],
    [
      "without a Recipe-pack resource",
      "recipes: {\n  'Radius.Data/widgets': {\n  }\n}"
    ],
    [
      "without a recipes map",
      "resource recipes 'Radius.Core/recipePacks@2025-08-01-preview' = {\n}"
    ],
    [
      "without a predefined type entry",
      `resource recipes 'Radius.Core/recipePacks@2025-08-01-preview' = {
  properties: {
    recipes: {
    }
  }
}`
    ]
  ])("rejects %s", (_case, source) => {
    expect(() => validateAzureRecipePack(source)).toThrow(
      /must be non-empty text|expected Recipe-pack structure/u
    );
  });
});
