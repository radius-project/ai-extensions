import { describe, it, expect } from "vitest";
import type { GitHub } from "../ports/index.js";
import {
  loadRecipeResources,
  fetchResourceTypeSchema,
  fetchRecipeFromAnyPlatform,
  generateRecipeFromContrib,
  resolveRecipeOutputs,
  fetchRecipesFromGitHub,
} from "./recipe-resolver.js";
import { CANONICAL_RESOURCE_MAP } from "./recipes.js";

interface FakeConfig {
  content?: Record<string, string | null>;
  names?: Record<string, string[]>;
  tree?: Record<string, string[]>;
}

// A configurable in-memory GitHub port. Keys are the API paths / repo:branch
// combinations the code under test requests; anything unlisted resolves empty.
function fakeGitHub(cfg: FakeConfig = {}): GitHub {
  return {
    async getContent(apiPath: string) {
      return cfg.content?.[apiPath] ?? null;
    },
    async listNames(apiPath: string) {
      return cfg.names?.[apiPath] ?? [];
    },
    async treePaths(repo: string, branch: string) {
      return cfg.tree?.[`${repo}@${branch}`] ?? [];
    },
  };
}

const CONTRIB = "/repos/radius-project/resource-types-contrib/contents";

describe("loadRecipeResources", () => {
  it("returns null when the recipe directory is empty", async () => {
    const gh = fakeGitHub();
    expect(await loadRecipeResources(gh, "Data/mySqlDatabases/recipes/aws/terraform", "terraform")).toBeNull();
  });

  it("returns null when the main file content is empty", async () => {
    const gh = fakeGitHub({
      names: { [`${CONTRIB}/Data/redisCaches/recipes/kubernetes/bicep`]: ["main.bicep"] },
      content: { [`${CONTRIB}/Data/redisCaches/recipes/kubernetes/bicep/main.bicep`]: null },
    });
    expect(await loadRecipeResources(gh, "Data/redisCaches/recipes/kubernetes/bicep", "bicep")).toBeNull();
  });

  it("parses a bicep recipe's concrete resources", async () => {
    const gh = fakeGitHub({
      names: { [`${CONTRIB}/Data/redisCaches/recipes/kubernetes/bicep`]: ["main.bicep"] },
      content: {
        [`${CONTRIB}/Data/redisCaches/recipes/kubernetes/bicep/main.bicep`]:
          `resource dep 'apps/Deployment@v1' = {}`,
      },
    });
    const result = await loadRecipeResources(gh, "Data/redisCaches/recipes/kubernetes/bicep", "bicep");
    expect(result?.format).toBe("bicep");
    expect(result?.concreteResources).toHaveLength(1);
    expect(result?.concreteResources[0].provider).toBe("kubernetes");
  });

  it("parses a terraform recipe using main.tf", async () => {
    const gh = fakeGitHub({
      names: { [`${CONTRIB}/Data/mySqlDatabases/recipes/aws/terraform`]: ["main.tf", "variables.tf"] },
      content: {
        [`${CONTRIB}/Data/mySqlDatabases/recipes/aws/terraform/main.tf`]:
          `resource "aws_db_instance" "mysql" { engine = "mysql" }`,
      },
    });
    const result = await loadRecipeResources(gh, "Data/mySqlDatabases/recipes/aws/terraform", "terraform");
    expect(result?.format).toBe("terraform");
    expect(result?.concreteResources[0].type).toBe("aws_db_instance");
  });
});

describe("fetchResourceTypeSchema", () => {
  it("fetches the <typeName>.yaml schema for a valid Radius type", async () => {
    const gh = fakeGitHub({
      content: { [`${CONTRIB}/Data/mySqlDatabases/mySqlDatabases.yaml`]: "description: mysql" },
    });
    expect(await fetchResourceTypeSchema(gh, "Radius.Data/mySqlDatabases")).toBe("description: mysql");
  });

  it("returns null for a type that has no contrib directory", async () => {
    const gh = fakeGitHub();
    expect(await fetchResourceTypeSchema(gh, "Radius.Compute")).toBeNull();
  });
});

describe("fetchRecipeFromAnyPlatform", () => {
  it("returns null when the type has no contrib directory", async () => {
    const gh = fakeGitHub();
    expect(await fetchRecipeFromAnyPlatform(gh, "Radius.Compute", "kubernetes")).toBeNull();
  });

  it("skips the excluded platform and loads from another one", async () => {
    const dir = "Data/mySqlDatabases";
    const gh = fakeGitHub({
      names: {
        [`${CONTRIB}/${dir}/recipes`]: ["kubernetes", "aws"],
        [`${CONTRIB}/${dir}/recipes/aws/terraform`]: ["main.tf"],
      },
      content: {
        [`${CONTRIB}/${dir}/recipes/aws/terraform/main.tf`]:
          `resource "aws_db_instance" "mysql" { engine = "mysql" }`,
      },
    });
    const recipe = await fetchRecipeFromAnyPlatform(gh, "Radius.Data/mySqlDatabases", "kubernetes");
    expect(recipe?.provider).toBe("aws");
    expect(recipe?.templateKind).toBe("terraform");
    expect(recipe?.resourceType).toBe("Radius.Data/mySqlDatabases");
    expect(recipe?.concreteResources[0].type).toBe("aws_db_instance");
  });

  it("returns null when only the excluded platform has a recipe", async () => {
    const dir = "Data/mySqlDatabases";
    const gh = fakeGitHub({
      names: { [`${CONTRIB}/${dir}/recipes`]: ["kubernetes"] },
    });
    expect(await fetchRecipeFromAnyPlatform(gh, "Radius.Data/mySqlDatabases", "kubernetes")).toBeNull();
  });
});

describe("generateRecipeFromContrib", () => {
  it("uses an alternate-platform recipe when available", async () => {
    const dir = "Data/mySqlDatabases";
    const gh = fakeGitHub({
      names: {
        [`${CONTRIB}/${dir}/recipes`]: ["aws"],
        [`${CONTRIB}/${dir}/recipes/aws/terraform`]: ["main.tf"],
      },
      content: {
        [`${CONTRIB}/${dir}/recipes/aws/terraform/main.tf`]:
          `resource "aws_db_instance" "mysql" { engine = "mysql" }`,
      },
    });
    const result = await generateRecipeFromContrib(gh, "Radius.Data/mySqlDatabases", "azure");
    expect(result.source).toBe("contrib-alt-platform");
    expect(result.resources[0].type).toBe("aws_db_instance");
  });

  it("infers from the YAML schema when no recipe is available", async () => {
    const gh = fakeGitHub({
      content: {
        [`${CONTRIB}/Data/redisCaches/redisCaches.yaml`]: "description: |\n  A redis cache.\ntypes:",
      },
    });
    const result = await generateRecipeFromContrib(gh, "Radius.Data/redisCaches", "azure");
    expect(result.source).toBe("contrib-schema");
    expect(result.resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/redisCaches"].azure);
  });

  it("falls back to static mappings when nothing is reachable", async () => {
    const gh = fakeGitHub();
    const result = await generateRecipeFromContrib(gh, "Radius.Data/redisCaches", "aws");
    expect(result.source).toBe("static-fallback");
    expect(result.resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/redisCaches"].aws);
  });
});

describe("resolveRecipeOutputs", () => {
  it("resolves cloud-managed database types straight from the canonical map", async () => {
    const gh = fakeGitHub();
    const appResources = [{ name: "db", type: "Radius.Data/mySqlDatabases@2025-08-01-preview" }];
    const resolved = await resolveRecipeOutputs(gh, appResources, [], "aws");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].recipe.templateKind).toBe("canonical-managed");
    expect(resolved[0].outputResources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/mySqlDatabases"].aws);
  });

  it("matches a directly provided recipe by resource type", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Radius.Compute/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/...",
        concreteResources: [
          { name: "service", type: "core/Service", provider: "kubernetes", displayType: "K8s Service" },
        ],
      },
    ];
    const appResources = [{ name: "api", type: "Radius.Compute/containers@2025-08-01-preview" }];
    const resolved = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(resolved[0].recipe.name).toBe("containers");
    expect(resolved[0].outputResources[0].type).toBe("core/Service");
  });

  it("normalizes legacy Applications.* types before matching", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Radius.Compute/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/...",
        concreteResources: [
          { name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" },
        ],
      },
    ];
    const appResources = [{ name: "api", type: "Applications.Core/containers" }];
    const resolved = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    // K8s Deployment nodes get annotated with the managed cluster service name.
    expect(resolved[0].outputResources[0].displayType).toBe("K8s Deployment (AKS)");
  });

  it("dynamically resolves via contrib when no recipe matches", async () => {
    const gh = fakeGitHub();
    const appResources = [{ name: "cache", type: "Radius.Data/redisCaches@2025-08-01-preview" }];
    const resolved = await resolveRecipeOutputs(gh, appResources, [], "aws");
    // No recipe passed and contrib unreachable -> static fallback.
    expect(resolved[0].recipe.templateKind).toBe("static-fallback");
    expect(resolved[0].outputResources).toEqual(CANONICAL_RESOURCE_MAP["Radius.Data/redisCaches"].aws);
  });
});

describe("fetchRecipesFromGitHub", () => {
  it("discovers recipe directories from the repo tree", async () => {
    const dir = "Data/redisCaches";
    const gh = fakeGitHub({
      tree: {
        "radius-project/resource-types-contrib@main": [
          `${dir}/recipes/kubernetes/bicep/main.bicep`,
          `${dir}/redisCaches.yaml`,
        ],
      },
      names: { [`${CONTRIB}/${dir}/recipes/kubernetes/bicep`]: ["main.bicep"] },
      content: {
        [`${CONTRIB}/${dir}/recipes/kubernetes/bicep/main.bicep`]:
          `resource dep 'apps/Deployment@v1' = {}`,
      },
    });
    const recipes = await fetchRecipesFromGitHub(gh, "azure");
    expect(recipes).toHaveLength(1);
    expect(recipes[0].resourceType).toBe("Radius.Data/redisCaches");
    expect(recipes[0].templateKind).toBe("bicep");
    expect(recipes[0].concreteResources[0].provider).toBe("kubernetes");
  });

  it("falls back to known types when the tree is empty", async () => {
    // Tree empty -> known types are attempted, but no recipe dirs resolve, so
    // the result is an empty recipe list (each loadRecipeResources returns null).
    const gh = fakeGitHub();
    const recipes = await fetchRecipesFromGitHub(gh, "azure");
    expect(recipes).toEqual([]);
  });
});
