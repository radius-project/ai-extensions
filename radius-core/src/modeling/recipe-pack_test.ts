import { describe, it, expect } from "vitest";
import {
  parseRecipePack,
  deriveConcreteResource,
  normalizeRecipeSource,
  recipePackPathForProvider,
  recipePackContentPath,
} from "./recipe-pack.js";

describe("normalizeRecipeSource", () => {
  it("strips the registry host and version tag from an AVM source", () => {
    expect(
      normalizeRecipeSource("mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"),
    ).toBe("avm/res/cache/redis-enterprise");
  });

  it("strips the registry host and tag from a kube-recipes source", () => {
    expect(
      normalizeRecipeSource("ghcr.io/radius-project/kube-recipes/containers:latest"),
    ).toBe("kube-recipes/containers");
  });

  it("handles a source with no version tag", () => {
    expect(normalizeRecipeSource("avm/res/sql/server")).toBe("avm/res/sql/server");
  });

  it("returns an empty string for an empty source", () => {
    expect(normalizeRecipeSource("")).toBe("");
  });
});

describe("deriveConcreteResource", () => {
  it("maps an Azure Verified Module to its ARM resource type", () => {
    const c = deriveConcreteResource("mcr.microsoft.com/bicep/avm/res/db-for-my-sql/flexible-server:0.10.3");
    expect(c?.type).toBe("Microsoft.DBforMySQL/flexibleServers");
    expect(c?.provider).toBe("azure");
    expect(c?.name).toBe("flexibleServers");
  });

  it("maps a kube-recipe to its primary Kubernetes object", () => {
    expect(deriveConcreteResource("ghcr.io/radius-project/kube-recipes/mysqldatabases:latest")?.type)
      .toBe("apps/Deployment");
    expect(deriveConcreteResource("ghcr.io/radius-project/kube-recipes/secrets:latest")?.type)
      .toBe("core/Secret");
    expect(deriveConcreteResource("ghcr.io/radius-project/kube-recipes/persistentvolumes:latest")?.type)
      .toBe("core/PersistentVolumeClaim");
    expect(deriveConcreteResource("ghcr.io/radius-project/kube-recipes/routes:latest")?.type)
      .toBe("gateway.networking.k8s.io/HTTPRoute");
  });

  it("returns null for an unrecognized source", () => {
    expect(deriveConcreteResource("ghcr.io/example/unknown:latest")).toBeNull();
  });
});

describe("recipePackPathForProvider", () => {
  it("selects the azure pack for the azure provider", () => {
    expect(recipePackPathForProvider("azure")).toBe("recipepack/azure/aks-recipepack.bicep");
  });

  it("selects the kubernetes default pack for aws and kubernetes", () => {
    expect(recipePackPathForProvider("aws")).toBe("recipepack/kubernetes/default-recipepack.bicep");
    expect(recipePackPathForProvider("kubernetes")).toBe("recipepack/kubernetes/default-recipepack.bicep");
  });

  it("falls back to the kubernetes default pack for an unknown provider", () => {
    expect(recipePackPathForProvider("gcp")).toBe("recipepack/kubernetes/default-recipepack.bicep");
  });

  it("builds a contents API path pinned to the main ref", () => {
    expect(recipePackContentPath("azure")).toBe(
      "/repos/radius-project/resource-types-contrib/contents/recipepack/azure/aks-recipepack.bicep?ref=main",
    );
  });
});

describe("parseRecipePack", () => {
  it("returns an empty list for empty input", () => {
    expect(parseRecipePack("")).toEqual([]);
    expect(parseRecipePack("param foo string")).toEqual([]);
  });

  it("extracts each recipe entry's type, kind, and source", () => {
    const pack = `
resource p 'Radius.Core/recipePacks@2025-08-01-preview' = {
  properties: {
    recipes: {
      'Radius.Data/mySqlDatabases': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/mysqldatabases:latest'
      }
      'Radius.Compute/routes': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/routes:latest'
        parameters: {
          gatewayName: 'radius'
          gatewayNamespace: 'radius-system'
        }
      }
    }
  }
}
`;
    const entries = parseRecipePack(pack);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      resourceType: "Radius.Data/mySqlDatabases",
      kind: "bicep",
      source: "ghcr.io/radius-project/kube-recipes/mysqldatabases:latest",
    });
    expect(entries[1].resourceType).toBe("Radius.Compute/routes");
    expect(entries[1].source).toBe("ghcr.io/radius-project/kube-recipes/routes:latest");
  });

  it("captures the top-level kind/source even when parameters contain nested kind keys", () => {
    // AVM entries carry `lock: { kind: 'None' }` and other nested `kind:` values
    // inside their parameters; the parser must not mistake those for the recipe kind.
    const pack = `
resource p 'Radius.Core/recipePacks@2025-08-01-preview' = {
  properties: {
    recipes: {
      'Radius.Data/redisCaches': {
        kind: 'bicep'
        source: 'mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1'
        parameters: {
          name: '{{context.resource.name}}'
          lock: {
            kind: 'None'
          }
        }
      }
    }
  }
}
`;
    const entries = parseRecipePack(pack);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("bicep");
    expect(entries[0].source).toBe("mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1");
  });

  it("skips an entry that declares no source", () => {
    const pack = `
    recipes: {
      'Radius.Data/mySqlDatabases': {
        kind: 'bicep'
      }
    }
`;
    expect(parseRecipePack(pack)).toEqual([]);
  });
});
