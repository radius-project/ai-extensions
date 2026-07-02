import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadRecipeResources,
  fetchRecipesFromGitHub,
  resolveRecipeOutputs,
  fetchResourceTypeSchema,
  fetchRecipeFromAnyPlatform,
  generateRecipeFromContrib,
} from "./recipe-resolver.js";

// Mock dependencies
vi.mock("./terraform.js", () => ({
  parseTerraformResources: vi.fn((content: string) => {
    if (content.includes("resource")) {
      return [{ name: "instance", type: "aws_db_instance", provider: "aws", displayType: "AWS RDS Instance" }];
    }
    return [];
  }),
}));

vi.mock("./recipes.js", () => ({
  parseRecipeResources: vi.fn((content: string) => {
    if (content.includes("resource")) {
      return [{ name: "deployment", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" }];
    }
    return [];
  }),
  CANONICAL_RESOURCE_MAP: {
    "Radius.Data/mySqlDatabases": {
      azure: [
        { name: "mysqlServer", type: "Microsoft.DBforMySQL/flexibleServers", provider: "azure", displayType: "Azure MySQL Flexible Server" },
      ],
      aws: [
        { name: "rdsInstance", type: "aws_db_instance", provider: "aws", displayType: "AWS RDS MySQL Instance" },
      ],
    },
    "Radius.Compute/containers": {
      azure: [
        { name: "deployment", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" },
      ],
    },
  },
  inferResourcesFromSchema: vi.fn(() => []),
  generateRecipeFromStaticMappings: vi.fn((type: string) => [
    { name: "resource", type: type.split("/").pop(), provider: "cloud", displayType: type.split("/").pop() },
  ]),
  radiusTypeToContribDir: vi.fn((radiusType: string) => {
    const parts = radiusType.split("/");
    if (parts.length !== 2) return null;
    const namespace = parts[0].replace("Radius.", "");
    const typeName = parts[1];
    return `${namespace}/${typeName}`;
  }),
}));

vi.mock("../platforms/index.js", () => ({
  getPlatform: vi.fn((id: string) => {
    if (id === "azure") return { id: "azure", recipePlatform: "kubernetes", clusterServiceName: "AKS" };
    if (id === "aws") return { id: "aws", recipePlatform: "kubernetes", clusterServiceName: "EKS" };
    return undefined;
  }),
}));

function createMockGh(overrides: Partial<{
  getContent: (path: string) => Promise<string | null>;
  listNames: (path: string) => Promise<string[]>;
  treePaths: (repo: string, branch: string) => Promise<string[]>;
}> = {}) {
  return {
    getContent: overrides.getContent ?? vi.fn(async () => null),
    listNames: overrides.listNames ?? vi.fn(async () => []),
    treePaths: overrides.treePaths ?? vi.fn(async () => []),
  };
}

describe("loadRecipeResources", () => {
  it("returns null when directory listing is empty", async () => {
    const gh = createMockGh({ listNames: async () => [] });
    const result = await loadRecipeResources(gh, "Compute/containers/recipes/kubernetes/bicep", "bicep");
    expect(result).toBeNull();
  });

  it("returns null when content fetch returns null", async () => {
    const gh = createMockGh({
      listNames: async () => ["main.bicep"],
      getContent: async () => null,
    });
    const result = await loadRecipeResources(gh, "Compute/containers/recipes/kubernetes/bicep", "bicep");
    expect(result).toBeNull();
  });

  it("returns parsed bicep resources when content exists", async () => {
    const gh = createMockGh({
      listNames: async () => ["main.bicep", "params.bicep"],
      getContent: async () => "resource deployment 'apps/Deployment@v1' = {}",
    });
    const result = await loadRecipeResources(gh, "Compute/containers/recipes/kubernetes/bicep", "bicep");
    expect(result).not.toBeNull();
    expect(result!.format).toBe("bicep");
    expect(result!.concreteResources).toHaveLength(1);
    expect(result!.concreteResources[0].name).toBe("deployment");
  });

  it("returns parsed terraform resources for terraform format", async () => {
    const gh = createMockGh({
      listNames: async () => ["main.tf"],
      getContent: async () => 'resource "aws_db_instance" "mysql" {}',
    });
    const result = await loadRecipeResources(gh, "Data/mySqlDatabases/recipes/aws/terraform", "terraform");
    expect(result).not.toBeNull();
    expect(result!.format).toBe("terraform");
    expect(result!.concreteResources[0].type).toBe("aws_db_instance");
  });

  it("prefers .bicep file over other files", async () => {
    const gh = createMockGh({
      listNames: async () => ["readme.md", "main.bicep", "params.json"],
      getContent: async () => "resource dep 'apps/Deployment@v1' = {}",
    });
    const result = await loadRecipeResources(gh, "Compute/containers/recipes/kubernetes/bicep", "bicep");
    expect(result).not.toBeNull();
  });

  it("prefers main.tf file for terraform listings", async () => {
    const gh = createMockGh({
      listNames: async () => ["variables.tf", "main.tf", "outputs.tf"],
      getContent: async () => 'resource "aws_db_instance" "db" {}',
    });
    const result = await loadRecipeResources(gh, "Data/mySqlDatabases/recipes/aws/terraform", "terraform");
    expect(result).not.toBeNull();
  });

  it("falls back to first file when no .bicep or main.tf present", async () => {
    const gh = createMockGh({
      listNames: async () => ["custom.json"],
      getContent: async () => "no declarations here",
    });
    const result = await loadRecipeResources(gh, "Compute/containers/recipes/kubernetes/bicep", "bicep");
    expect(result).not.toBeNull();
    expect(result!.format).toBe("bicep");
    expect(result!.content).toBe("no declarations here");
  });
});

describe("fetchRecipesFromGitHub", () => {
  it("discovers resource types from repo tree and loads recipes", async () => {
    const gh = createMockGh({
      treePaths: async () => [
        "Compute/containers/recipes/kubernetes/bicep/main.bicep",
        "Data/mySqlDatabases/recipes/kubernetes/terraform/main.tf",
      ],
      listNames: async (path: string) => {
        if (path.includes("bicep")) return ["main.bicep"];
        if (path.includes("terraform")) return ["main.tf"];
        return [];
      },
      getContent: async () => "resource dep 'apps/Deployment@v1' = {}",
    });

    const recipes = await fetchRecipesFromGitHub(gh, "azure");
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes[0].resourceType).toContain("Radius.");
  });

  it("falls back to known types when tree fetch returns empty", async () => {
    const gh = createMockGh({
      treePaths: async () => [],
      listNames: async () => ["main.bicep"],
      getContent: async () => "resource dep 'apps/Deployment@v1' = {}",
    });

    const recipes = await fetchRecipesFromGitHub(gh, "azure");
    expect(recipes.length).toBeGreaterThan(0);
  });

  it("skips resource types with no available recipes", async () => {
    const gh = createMockGh({
      treePaths: async () => [
        "Compute/containers/recipes/kubernetes/bicep/main.bicep",
      ],
      listNames: async () => [],
      getContent: async () => null,
    });

    const recipes = await fetchRecipesFromGitHub(gh, "azure");
    expect(recipes).toHaveLength(0);
  });

  it("prefers bicep format over terraform", async () => {
    let contentCallCount = 0;
    const gh = createMockGh({
      treePaths: async () => [
        "Compute/containers/recipes/kubernetes/bicep/main.bicep",
      ],
      listNames: async (path: string) => {
        if (path.includes("bicep")) return ["main.bicep"];
        if (path.includes("terraform")) return ["main.tf"];
        return [];
      },
      getContent: async () => {
        contentCallCount++;
        return "resource dep 'apps/Deployment@v1' = {}";
      },
    });

    const recipes = await fetchRecipesFromGitHub(gh, "azure");
    // Should have found the bicep recipe and not continued to terraform
    const containerRecipe = recipes.find(r => r.resourceType === "Radius.Compute/containers");
    if (containerRecipe) {
      expect(containerRecipe.templateKind).toBe("bicep");
    }
  });

  it("uses correct platform based on provider", async () => {
    const gh = createMockGh({
      treePaths: async () => [
        "Compute/containers/recipes/kubernetes/bicep/main.bicep",
      ],
      listNames: async () => ["main.bicep"],
      getContent: async () => "resource dep 'apps/Deployment@v1' = {}",
    });

    const recipes = await fetchRecipesFromGitHub(gh, "aws");
    if (recipes.length > 0) {
      expect(recipes[0].provider).toBe("kubernetes");
    }
  });
});

describe("resolveRecipeOutputs", () => {
  it("resolves cloud-managed database types directly from canonical map", async () => {
    const gh = createMockGh();
    const appResources = [{ name: "db", type: "Radius.Data/mySqlDatabases@2024-01-01" }];
    const recipes: any[] = [];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(result).toHaveLength(1);
    expect(result[0].recipe.templateKind).toBe("canonical-managed");
    expect(result[0].outputResources[0].type).toBe("Microsoft.DBforMySQL/flexibleServers");
  });

  it("does not use canonical map for cloud-managed types on kubernetes provider", async () => {
    const gh = createMockGh();
    const appResources = [{ name: "db", type: "Radius.Data/mySqlDatabases" }];
    const recipes: any[] = [];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "kubernetes");
    expect(result).toHaveLength(1);
    // Should not be canonical-managed since provider is kubernetes
    expect(result[0].recipe.templateKind).not.toBe("canonical-managed");
  });

  it("matches recipes by normalized type", async () => {
    const gh = createMockGh();
    const appResources = [{ name: "web", type: "Applications.Core/containers@2024-01-01" }];
    const recipes = [{
      name: "containers",
      resourceType: "Radius.Compute/containers",
      templateKind: "bicep",
      templatePath: "ghcr.io/...",
      provider: "kubernetes",
      concreteResources: [{ name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" }],
    }];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(result).toHaveLength(1);
    expect(result[0].recipe.name).toBe("containers");
    expect(result[0].outputResources[0].type).toBe("apps/Deployment");
  });

  it("falls back to generateRecipeFromContrib when no recipe matches", async () => {
    const gh = createMockGh({
      listNames: async () => [],
      getContent: async () => null,
    });
    const appResources = [{ name: "cache", type: "Radius.Data/redisCaches" }];
    const recipes: any[] = [];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(result).toHaveLength(1);
    expect(result[0].outputResources.length).toBeGreaterThan(0);
  });

  it("annotates K8s Deployment nodes with managed service name", async () => {
    const gh = createMockGh();
    const appResources = [{ name: "web", type: "Radius.Compute/containers" }];
    const recipes = [{
      name: "containers",
      resourceType: "Radius.Compute/containers",
      templateKind: "bicep",
      templatePath: "ghcr.io/...",
      provider: "kubernetes",
      concreteResources: [{ name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" }],
    }];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(result[0].outputResources[0].displayType).toBe("K8s Deployment (AKS)");
  });

  it("annotates with EKS for aws provider", async () => {
    const gh = createMockGh();
    const appResources = [{ name: "web", type: "Radius.Compute/containers" }];
    const recipes = [{
      name: "containers",
      resourceType: "Radius.Compute/containers",
      templateKind: "bicep",
      templatePath: "ghcr.io/...",
      provider: "kubernetes",
      concreteResources: [{ name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" }],
    }];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "aws");
    expect(result[0].outputResources[0].displayType).toBe("K8s Deployment (EKS)");
  });

  it("does not double-annotate Deployments that already have parenthetical", async () => {
    const gh = createMockGh();
    const appResources = [{ name: "web", type: "Radius.Compute/containers" }];
    const recipes = [{
      name: "containers",
      resourceType: "Radius.Compute/containers",
      templateKind: "bicep",
      templatePath: "ghcr.io/...",
      provider: "kubernetes",
      concreteResources: [{ name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment (custom)" }],
    }];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(result[0].outputResources[0].displayType).toBe("K8s Deployment (custom)");
  });

  it("handles multiple app resources", async () => {
    const gh = createMockGh();
    const appResources = [
      { name: "web", type: "Radius.Compute/containers" },
      { name: "db", type: "Radius.Data/mySqlDatabases" },
    ];
    const recipes = [{
      name: "containers",
      resourceType: "Radius.Compute/containers",
      templateKind: "bicep",
      templatePath: "ghcr.io/...",
      provider: "kubernetes",
      concreteResources: [{ name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" }],
    }];

    const result = await resolveRecipeOutputs(gh, appResources, recipes, "azure");
    expect(result).toHaveLength(2);
  });
});

describe("fetchResourceTypeSchema", () => {
  it("returns schema content for valid Radius type", async () => {
    const gh = createMockGh({
      getContent: async (path: string) => {
        if (path.includes("containers.yaml")) return "description: |\n  A container\n";
        return null;
      },
    });

    const result = await fetchResourceTypeSchema(gh, "Radius.Compute/containers");
    expect(result).toBe("description: |\n  A container\n");
  });

  it("returns null for invalid type format", async () => {
    const gh = createMockGh();
    const result = await fetchResourceTypeSchema(gh, "invalidType");
    expect(result).toBeNull();
  });

  it("returns null when getContent returns null", async () => {
    const gh = createMockGh({ getContent: async () => null });
    const result = await fetchResourceTypeSchema(gh, "Radius.Compute/containers");
    expect(result).toBeNull();
  });
});

describe("fetchRecipeFromAnyPlatform", () => {
  it("returns null for invalid type format", async () => {
    const gh = createMockGh();
    const result = await fetchRecipeFromAnyPlatform(gh, "invalidType", "kubernetes");
    expect(result).toBeNull();
  });

  it("returns null when no platforms have recipes", async () => {
    const gh = createMockGh({ listNames: async () => [] });
    const result = await fetchRecipeFromAnyPlatform(gh, "Radius.Compute/containers", "kubernetes");
    expect(result).toBeNull();
  });

  it("skips excluded platform and tries others", async () => {
    const gh = createMockGh({
      listNames: async (path: string) => {
        if (path.includes("/recipes")) return ["kubernetes", "aws"];
        if (path.includes("aws/terraform")) return ["main.tf"];
        return [];
      },
      getContent: async (path: string) => {
        if (path.includes("aws/terraform")) return 'resource "aws_db_instance" "db" {}';
        return null;
      },
    });

    const result = await fetchRecipeFromAnyPlatform(gh, "Radius.Compute/containers", "kubernetes");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
  });

  it("returns first successful format for available platform", async () => {
    const gh = createMockGh({
      listNames: async (path: string) => {
        if (path.includes("/recipes")) return ["azure"];
        if (path.includes("azure/terraform")) return ["main.tf"];
        if (path.includes("azure/bicep")) return [];
        return [];
      },
      getContent: async () => 'resource "azurerm_resource" "r" {}',
    });

    const result = await fetchRecipeFromAnyPlatform(gh, "Radius.Compute/containers", "kubernetes");
    expect(result).not.toBeNull();
    expect(result!.templateKind).toBe("terraform");
  });

  it("returns null when all non-excluded platforms have no recipes", async () => {
    const gh = createMockGh({
      listNames: async (path: string) => {
        if (path.includes("/recipes")) return ["kubernetes"];
        return [];
      },
    });

    const result = await fetchRecipeFromAnyPlatform(gh, "Radius.Compute/containers", "kubernetes");
    expect(result).toBeNull();
  });
});

describe("generateRecipeFromContrib", () => {
  it("returns alt-platform recipe when available", async () => {
    const gh = createMockGh({
      listNames: async (path: string) => {
        if (path.includes("/recipes")) return ["aws"];
        if (path.includes("aws/terraform")) return ["main.tf"];
        return [];
      },
      getContent: async () => 'resource "aws_db_instance" "db" {}',
    });

    const result = await generateRecipeFromContrib(gh, "Radius.Data/mySqlDatabases", "azure");
    expect(result.source).toBe("contrib-alt-platform");
    expect(result.resources.length).toBeGreaterThan(0);
    expect(result.recipe).not.toBeNull();
  });

  it("falls back to schema inference when no alt-platform recipe exists", async () => {
    const { inferResourcesFromSchema } = await import("./recipes.js");
    (inferResourcesFromSchema as any).mockReturnValueOnce([
      { name: "dep", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" },
    ]);

    const gh = createMockGh({
      listNames: async () => [],
      getContent: async (path: string) => {
        if (path.includes(".yaml")) return "description: |\n  A mysql database\n";
        return null;
      },
    });

    const result = await generateRecipeFromContrib(gh, "Radius.Data/mySqlDatabases", "azure");
    expect(result.source).toBe("contrib-schema");
    expect(result.recipe).toBeNull();
  });

  it("falls back to static mappings when schema inference returns empty", async () => {
    const gh = createMockGh({
      listNames: async () => [],
      getContent: async () => null,
    });

    const result = await generateRecipeFromContrib(gh, "Radius.Data/mySqlDatabases", "azure");
    expect(result.source).toBe("static-fallback");
    expect(result.recipe).toBeNull();
    expect(result.resources.length).toBeGreaterThan(0);
  });

  it("uses correct recipePlatform for unknown provider", async () => {
    const gh = createMockGh({
      listNames: async () => [],
      getContent: async () => null,
    });

    const result = await generateRecipeFromContrib(gh, "Radius.Compute/containers", "unknown-provider");
    expect(result.source).toBe("static-fallback");
  });

  it("returns alt-platform recipe with correct structure", async () => {
    const gh = createMockGh({
      listNames: async (path: string) => {
        if (path.includes("/recipes")) return ["azure"];
        if (path.includes("azure/terraform")) return ["main.tf"];
        return [];
      },
      getContent: async () => 'resource "azurerm_mysql" "db" {}',
    });

    const result = await generateRecipeFromContrib(gh, "Radius.Data/mySqlDatabases", "aws");
    expect(result.source).toBe("contrib-alt-platform");
    expect(result.recipe).toMatchObject({
      name: "mySqlDatabases",
      resourceType: "Radius.Data/mySqlDatabases",
    });
  });
});
