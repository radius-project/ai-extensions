import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  parseRecipePack,
  deriveConcreteResource,
  normalizeRecipeSource,
  recipePackPathForProvider,
  recipePackContentPath
} from "./recipe-pack.js";

// Read a committed recipe-pack snapshot from ./testdata. These are verbatim
// copies of the packs in radius-project/resource-types-contrib@main
// (recipe-packs/azure-aks/azure-aks.bicep and
// recipe-packs/kubernetes/default.bicep). They let the parser be
// exercised against the real pack structure without any network I/O (hermetic).
// To refresh: re-download each file's raw contents over the pinned ref and
// overwrite it here, then update the expected tables below if entries changed.
const readFixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./testdata/${name}`, import.meta.url)),
    "utf8"
  );

describe("normalizeRecipeSource", () => {
  it("strips the registry host and version tag from an AVM source", () => {
    expect(
      normalizeRecipeSource(
        "mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"
      )
    ).toBe("avm/res/cache/redis-enterprise");
  });

  it("strips the registry host and tag from a kube-recipes source", () => {
    expect(
      normalizeRecipeSource(
        "ghcr.io/radius-project/kube-recipes/containers:latest"
      )
    ).toBe("kube-recipes/containers");
  });

  it("handles a source with no version tag", () => {
    expect(normalizeRecipeSource("avm/res/sql/server")).toBe(
      "avm/res/sql/server"
    );
  });

  it("strips an OCI digest before normalizing", () => {
    expect(
      normalizeRecipeSource(
        "mcr.microsoft.com/bicep/avm/res/sql/server:0.1.0@sha256:abc123"
      )
    ).toBe("avm/res/sql/server");
    expect(
      normalizeRecipeSource(
        "mcr.microsoft.com/bicep/avm/res/sql/server@sha256:abc123"
      )
    ).toBe("avm/res/sql/server");
  });

  it("returns an empty string for an empty source", () => {
    expect(normalizeRecipeSource("")).toBe("");
  });
});

describe("deriveConcreteResource", () => {
  it("maps an Azure Verified Module to its ARM resource type", () => {
    const c = deriveConcreteResource(
      "mcr.microsoft.com/bicep/avm/res/db-for-my-sql/flexible-server:0.10.3"
    );
    expect(c?.type).toBe("Microsoft.DBforMySQL/flexibleServers");
    expect(c?.provider).toBe("azure");
    expect(c?.name).toBe("flexibleServers");
  });

  it("maps a kube-recipe to its primary Kubernetes object", () => {
    expect(
      deriveConcreteResource(
        "ghcr.io/radius-project/kube-recipes/mysqldatabases:latest"
      )?.type
    ).toBe("apps/Deployment");
    expect(
      deriveConcreteResource(
        "ghcr.io/radius-project/kube-recipes/secrets:latest"
      )?.type
    ).toBe("core/Secret");
    expect(
      deriveConcreteResource(
        "ghcr.io/radius-project/kube-recipes/persistentvolumes:latest"
      )?.type
    ).toBe("core/PersistentVolumeClaim");
    expect(
      deriveConcreteResource(
        "ghcr.io/radius-project/kube-recipes/routes:latest"
      )?.type
    ).toBe("gateway.networking.k8s.io/HTTPRoute");
  });

  it("returns null for an unrecognized source", () => {
    expect(deriveConcreteResource("ghcr.io/example/unknown:latest")).toBeNull();
  });

  it("maps an Azure container recipe to the AKS managed cluster (provider-scoped)", () => {
    // On an AKS environment the container runs on the managed cluster, so its
    // concrete Azure resource is the cluster — not the Deployment the shared
    // kube-recipes/containers recipe emits on a plain Kubernetes environment.
    const src = "ghcr.io/radius-project/kube-recipes/containers:latest";
    expect(deriveConcreteResource(src, "azure")?.type).toBe(
      "Microsoft.ContainerService/managedClusters"
    );
    // The same source stays a Kubernetes Deployment off Azure and with no provider.
    expect(deriveConcreteResource(src, "kubernetes")?.type).toBe(
      "apps/Deployment"
    );
    expect(deriveConcreteResource(src)?.type).toBe("apps/Deployment");
  });
});

describe("recipePackPathForProvider", () => {
  it("selects the azure pack for the azure provider", () => {
    expect(recipePackPathForProvider("azure")).toBe(
      "recipe-packs/azure-aks/azure-aks.bicep"
    );
  });

  it("selects the kubernetes default pack for aws and kubernetes", () => {
    expect(recipePackPathForProvider("aws")).toBe(
      "recipe-packs/kubernetes/default.bicep"
    );
    expect(recipePackPathForProvider("kubernetes")).toBe(
      "recipe-packs/kubernetes/default.bicep"
    );
  });

  it("falls back to the kubernetes default pack for an unknown provider", () => {
    expect(recipePackPathForProvider("gcp")).toBe(
      "recipe-packs/kubernetes/default.bicep"
    );
  });

  it("builds a contents API path pinned to the main ref", () => {
    expect(recipePackContentPath("azure")).toBe(
      "/repos/radius-project/resource-types-contrib/contents/recipe-packs/azure-aks/azure-aks.bicep?ref=main"
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
      source: "ghcr.io/radius-project/kube-recipes/mysqldatabases:latest"
    });
    expect(entries[1].resourceType).toBe("Radius.Compute/routes");
    expect(entries[1].source).toBe(
      "ghcr.io/radius-project/kube-recipes/routes:latest"
    );
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
    expect(entries[0].source).toBe(
      "mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"
    );
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

  it("skips a source-less entry without borrowing the next entry's source", () => {
    // The source-less mySqlDatabases entry must not capture the following
    // containers entry's source: parsing is scoped to each entry's own block.
    const pack = `
    recipes: {
      'Radius.Data/mySqlDatabases': {
        kind: 'bicep'
      }
      'Radius.Compute/containers': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/containers:latest'
      }
    }
`;
    const entries = parseRecipePack(pack);
    expect(entries).toHaveLength(1);
    expect(entries[0].resourceType).toBe("Radius.Compute/containers");
    expect(entries[0].source).toBe(
      "ghcr.io/radius-project/kube-recipes/containers:latest"
    );
  });

  it("reads kind/source even when source precedes kind around a parameters block", () => {
    // Order-independence: parameters may appear between source and kind; nested
    // decoys inside it must still be ignored.
    const pack = `
    recipes: {
      'Radius.Data/redisCaches': {
        source: 'mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1'
        parameters: {
          lock: {
            kind: 'None'
          }
        }
        kind: 'bicep'
      }
    }
`;
    const entries = parseRecipePack(pack);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("bicep");
    expect(entries[0].source).toBe(
      "mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"
    );
  });

  it("defaults the kind to bicep when an entry declares only a source", () => {
    const pack = `
    recipes: {
      'Radius.Data/redisCaches': {
        source: 'ghcr.io/radius-project/kube-recipes/rediscaches:latest'
      }
    }
`;
    const entries = parseRecipePack(pack);

    expect(entries).toEqual([
      {
        resourceType: "Radius.Data/redisCaches",
        kind: "bicep",
        source: "ghcr.io/radius-project/kube-recipes/rediscaches:latest"
      }
    ]);
  });

  it("preserves a non-bicep kind", () => {
    const pack = `
    recipes: {
      'Radius.Data/redisCaches': {
        kind: 'terraform'
        source: 'ghcr.io/radius-project/kube-recipes/rediscaches:latest'
      }
    }
`;
    expect(parseRecipePack(pack)[0].kind).toBe("terraform");
  });

  it("ignores a resource type outside the Radius namespace", () => {
    const pack = `
    recipes: {
      'Applications.Core/containers': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/containers:latest'
      }
    }
`;
    expect(parseRecipePack(pack)).toEqual([]);
  });

  it("still yields the entry when the pack is truncated before its closing brace", () => {
    // A partially fetched pack ends mid-entry; the final line is still scanned so
    // a truncated file degrades to the entries it did contain rather than none.
    const pack = `recipes: {
      'Radius.Data/redisCaches': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/rediscaches:latest'`;

    const entries = parseRecipePack(pack);

    expect(entries).toEqual([
      {
        resourceType: "Radius.Data/redisCaches",
        kind: "bicep",
        source: "ghcr.io/radius-project/kube-recipes/rediscaches:latest"
      }
    ]);
  });
});

// Hermetic regression test against committed snapshots of the real packs. Guards
// the parser + curated map against the actual pack structure (nested parameter
// blocks, comments, real sources) without hitting the network. If upstream pack
// content changes, refresh the fixtures and update the expected tables below; a
// new source that isn't in the curated map surfaces here as an unresolved entry.
describe("committed recipe-pack snapshots", () => {
  // resourceType -> the concrete type each entry must resolve to.
  const AZURE_EXPECTED: Record<string, string> = {
    "Radius.Data/redisCaches": "Microsoft.Cache/redisEnterprise",
    "Radius.AI/models": "Microsoft.CognitiveServices/accounts",
    "Radius.AI/search": "Microsoft.Search/searchServices",
    "Radius.Data/mongoDatabases": "Microsoft.DocumentDB/databaseAccounts",
    "Radius.Data/mySqlDatabases": "Microsoft.DBforMySQL/flexibleServers",
    "Radius.Data/postgreSqlDatabases":
      "Microsoft.DBforPostgreSQL/flexibleServers",
    "Radius.Data/sqlServerDatabases": "Microsoft.Sql/servers",
    "Radius.Messaging/rabbitMQ": "Microsoft.ServiceBus/namespaces",
    "Radius.Messaging/kafka": "Microsoft.EventHub/namespaces",
    "Radius.Storage/objectStorage": "Microsoft.Storage/storageAccounts",
    "Radius.Compute/containers": "Microsoft.ContainerService/managedClusters",
    "Radius.Compute/persistentVolumes": "core/PersistentVolumeClaim",
    "Radius.Security/secrets": "core/Secret",
    "Radius.Compute/routes": "gateway.networking.k8s.io/HTTPRoute",
    "Radius.Compute/containerImages": "batch/Job"
  };

  const KUBE_EXPECTED: Record<string, string> = {
    "Radius.Compute/containers": "apps/Deployment",
    "Radius.Compute/persistentVolumes": "core/PersistentVolumeClaim",
    "Radius.Compute/routes": "gateway.networking.k8s.io/HTTPRoute",
    "Radius.Security/secrets": "core/Secret",
    "Radius.Data/mySqlDatabases": "apps/Deployment",
    "Radius.Data/redisCaches": "apps/Deployment"
  };

  it.each([
    {
      provider: "azure",
      fixture: "azure-aks.bicep",
      expected: AZURE_EXPECTED
    },
    {
      provider: "kubernetes",
      fixture: "default.bicep",
      expected: KUBE_EXPECTED
    }
  ])(
    "resolves every entry in the $provider pack to a concrete resource",
    ({ provider, fixture, expected }) => {
      const entries = parseRecipePack(readFixture(fixture));

      // Every entry the pack declares must derive a concrete resource: an
      // unresolved entry means the curated SOURCE_CONCRETE_MAP is missing a source.
      const unresolved = entries
        .filter((e) => deriveConcreteResource(e.source, provider) === null)
        .map((e) => `${e.resourceType} (${e.source})`);
      expect(
        unresolved,
        `unmapped recipe sources: ${unresolved.join(", ")}`
      ).toEqual([]);

      // The parsed set must match the expected resource types exactly (no drift).
      expect(entries.map((e) => e.resourceType).sort()).toEqual(
        Object.keys(expected).sort()
      );

      // Each entry must derive the specific expected concrete type for this provider.
      for (const entry of entries) {
        expect(deriveConcreteResource(entry.source, provider)?.type).toBe(
          expected[entry.resourceType]
        );
      }
    }
  );
});
