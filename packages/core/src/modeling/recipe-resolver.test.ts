import { describe, it, expect } from "vitest";
import type { GitHub } from "../ports/index.js";
import { resolveRecipeOutputs, fetchRecipePack } from "./recipe-resolver.js";
import { recipePackContentPath } from "./recipe-pack.js";

interface FakeConfig {
  content?: Record<string, string | null>;
}

// A configurable in-memory GitHub port. `fetchRecipePack` reaches GitHub only
// through `getContent`; anything unlisted resolves to null.
function fakeGitHub(cfg: FakeConfig = {}): GitHub {
  return {
    async getContent(apiPath: string) {
      return cfg.content?.[apiPath] ?? null;
    },
    async listNames() {
      return [];
    },
    async treePaths() {
      return [];
    }
  };
}

// A minimal recipe-pack bicep with one AVM-backed and two kube-recipe-backed
// entries, mirroring the shape of the committed packs.
const AZURE_PACK = `
extension radius
resource recipes 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: 'azure-aks'
  properties: {
    recipes: {
      'Radius.Data/mySqlDatabases': {
        kind: 'bicep'
        source: 'mcr.microsoft.com/bicep/avm/res/db-for-my-sql/flexible-server:0.10.3'
        parameters: {
          name: '{{context.resource.name}}'
          lock: {
            kind: 'None'
          }
        }
        outputs: {
          host: 'fqdn'
        }
      }
      'Radius.Compute/containers': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/containers:latest'
      }
      'Radius.Security/secrets': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/secrets:latest'
      }
    }
  }
}
`;

describe("fetchRecipePack", () => {
  it("returns an empty list when the pack file is absent", async () => {
    const gh = fakeGitHub();
    expect(await fetchRecipePack(gh, "azure")).toEqual([]);
  });

  it("parses the pack and derives one concrete resource per entry", async () => {
    const gh = fakeGitHub({
      content: { [recipePackContentPath("azure")]: AZURE_PACK }
    });
    const recipes = await fetchRecipePack(gh, "azure");
    expect(recipes).toHaveLength(3);

    const mysql = recipes.find(
      (r) => r.resourceType === "Radius.Data/mySqlDatabases"
    );
    expect(mysql?.name).toBe("mySqlDatabases");
    expect(mysql?.templateKind).toBe("bicep");
    expect(mysql?.templatePath).toBe(
      "mcr.microsoft.com/bicep/avm/res/db-for-my-sql/flexible-server:0.10.3"
    );
    // AVM module maps to its ARM resource type.
    expect(mysql?.concreteResources).toHaveLength(1);
    expect(mysql?.concreteResources[0].type).toBe(
      "Microsoft.DBforMySQL/flexibleServers"
    );
    expect(mysql?.concreteResources[0].provider).toBe("azure");

    const containers = recipes.find(
      (r) => r.resourceType === "Radius.Compute/containers"
    );
    // On the Azure pack a container materializes onto the AKS managed cluster.
    expect(containers?.concreteResources[0].type).toBe(
      "Microsoft.ContainerService/managedClusters"
    );
    expect(containers?.concreteResources[0].provider).toBe("azure");

    const secrets = recipes.find(
      (r) => r.resourceType === "Radius.Security/secrets"
    );
    expect(secrets?.concreteResources[0].type).toBe("core/Secret");
  });

  it("reads the kubernetes default pack for aws and kubernetes providers", async () => {
    const KUBE_PACK = `
resource kubernetesRecipePack 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: 'default'
  properties: {
    recipes: {
      'Radius.Data/redisCaches': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/rediscaches:latest'
      }
    }
  }
}
`;
    // Both providers resolve to recipe-packs/kubernetes/default.bicep.
    expect(recipePackContentPath("aws")).toBe(
      recipePackContentPath("kubernetes")
    );
    const gh = fakeGitHub({
      content: { [recipePackContentPath("aws")]: KUBE_PACK }
    });
    const recipes = await fetchRecipePack(gh, "aws");
    expect(recipes).toHaveLength(1);
    expect(recipes[0].resourceType).toBe("Radius.Data/redisCaches");
    expect(recipes[0].concreteResources[0].type).toBe("apps/Deployment");
  });

  it("yields an entry with no concrete resource when the source is unrecognized", async () => {
    const UNKNOWN_PACK = `
resource p 'Radius.Core/recipePacks@2025-08-01-preview' = {
  properties: {
    recipes: {
      'Radius.Custom/widgets': {
        kind: 'bicep'
        source: 'ghcr.io/example/unknown-recipe:latest'
      }
    }
  }
}
`;
    const gh = fakeGitHub({
      content: { [recipePackContentPath("azure")]: UNKNOWN_PACK }
    });
    const recipes = await fetchRecipePack(gh, "azure");
    expect(recipes).toHaveLength(1);
    expect(recipes[0].concreteResources).toEqual([]);
  });
});

describe("resolveRecipeOutputs", () => {
  it("matches a directly provided recipe by resource type", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Radius.Compute/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/...",
        concreteResources: [
          {
            name: "service",
            type: "core/Service",
            provider: "kubernetes",
            displayType: "Service"
          }
        ]
      }
    ];
    const appResources = [
      { name: "api", type: "Radius.Compute/containers@2025-08-01-preview" }
    ];
    const resolved = await resolveRecipeOutputs(
      gh,
      appResources,
      recipes,
      "azure"
    );
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
          {
            name: "deployment",
            type: "apps/Deployment",
            provider: "kubernetes",
            displayType: "Deployment"
          }
        ]
      }
    ];
    const appResources = [
      { name: "api", type: "Applications.Core/containers" }
    ];
    const resolved = await resolveRecipeOutputs(
      gh,
      appResources,
      recipes,
      "azure"
    );
    // K8s Deployment nodes get annotated with the managed cluster service name.
    expect(resolved[0].outputResources[0].displayType).toBe("Deployment (AKS)");
  });

  it("normalizes Applications.Datastores/sqlDatabases to Radius.Data/sqlServerDatabases", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "sqlServerDatabases",
        resourceType: "Radius.Data/sqlServerDatabases",
        templateKind: "bicep",
        templatePath: "mcr.microsoft.com/bicep/avm/res/sql/server:0.21.4",
        concreteResources: [
          {
            name: "server",
            type: "Microsoft.Sql/servers",
            provider: "azure",
            displayType: "SQL Server"
          }
        ]
      }
    ];
    const appResources = [
      { name: "db", type: "Applications.Datastores/sqlDatabases" }
    ];
    const resolved = await resolveRecipeOutputs(
      gh,
      appResources,
      recipes,
      "azure"
    );
    expect(resolved[0].recipe?.name).toBe("sqlServerDatabases");
    expect(resolved[0].outputResources[0].type).toBe("Microsoft.Sql/servers");
  });

  it("normalizes Applications.Messaging/rabbitMQQueues to Radius.Messaging/rabbitMQ", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "rabbitMQ",
        resourceType: "Radius.Messaging/rabbitMQ",
        templateKind: "bicep",
        templatePath:
          "mcr.microsoft.com/bicep/avm/res/service-bus/namespace:0.16.2",
        concreteResources: [
          {
            name: "namespace",
            type: "Microsoft.ServiceBus/namespaces",
            provider: "azure",
            displayType: "Service Bus"
          }
        ]
      }
    ];
    const appResources = [
      { name: "queue", type: "Applications.Messaging/rabbitMQQueues" }
    ];
    const resolved = await resolveRecipeOutputs(
      gh,
      appResources,
      recipes,
      "azure"
    );
    expect(resolved[0].recipe?.name).toBe("rabbitMQ");
    expect(resolved[0].outputResources[0].type).toBe(
      "Microsoft.ServiceBus/namespaces"
    );
  });

  it("produces no outputs when no recipe matches", async () => {
    const gh = fakeGitHub();
    const appResources = [
      { name: "cache", type: "Radius.Data/redisCaches@2025-08-01-preview" }
    ];
    const resolved = await resolveRecipeOutputs(gh, appResources, [], "aws");
    // No matching recipe -> nothing is fabricated.
    expect(resolved[0].recipe).toBeNull();
    expect(resolved[0].outputResources).toEqual([]);
  });

  it("falls back to the raw type when a pack keys a legacy Applications.* type", async () => {
    // The pack still lists the pre-rename type, so normalization finds nothing
    // and the raw lookup has to resolve it.
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Applications.Core/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/radius-project/kube-recipes/containers:latest",
        concreteResources: [
          {
            name: "deployment",
            type: "apps/Deployment",
            provider: "kubernetes",
            displayType: "Deployment"
          }
        ]
      }
    ];

    const resolved = await resolveRecipeOutputs(
      gh,
      [{ name: "api", type: "Applications.Core/containers" }],
      recipes,
      "aws"
    );

    expect(resolved[0].recipe?.name).toBe("containers");
    expect(resolved[0].outputResources[0].displayType).toBe("Deployment (EKS)");
  });

  it("leaves a Deployment display type alone when it already names a cluster service", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Radius.Compute/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/...",
        concreteResources: [
          {
            name: "deployment",
            type: "apps/Deployment",
            provider: "kubernetes",
            displayType: "Deployment (AKS)"
          }
        ]
      }
    ];

    const resolved = await resolveRecipeOutputs(
      gh,
      [{ name: "api", type: "Radius.Compute/containers" }],
      recipes,
      "azure"
    );

    expect(resolved[0].outputResources[0].displayType).toBe("Deployment (AKS)");
  });

  it("leaves non-Deployment outputs and Deployments without a display type unannotated", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Radius.Compute/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/...",
        concreteResources: [
          {
            name: "service",
            type: "core/Service",
            provider: "kubernetes",
            displayType: "Service"
          },
          {
            name: "deployment",
            type: "apps/Deployment",
            provider: "kubernetes",
            displayType: ""
          }
        ]
      }
    ];

    const resolved = await resolveRecipeOutputs(
      gh,
      [{ name: "api", type: "Radius.Compute/containers" }],
      recipes,
      "azure"
    );

    expect(resolved[0].outputResources.map((r: any) => r.displayType)).toEqual([
      "Service",
      ""
    ]);
  });

  it("falls back to K8s when the provider has no registered platform", async () => {
    const gh = fakeGitHub();
    const recipes = [
      {
        name: "containers",
        resourceType: "Radius.Compute/containers",
        templateKind: "bicep",
        templatePath: "ghcr.io/...",
        concreteResources: [
          {
            name: "deployment",
            type: "apps/Deployment",
            provider: "kubernetes",
            displayType: "Deployment"
          }
        ]
      }
    ];

    const resolved = await resolveRecipeOutputs(
      gh,
      [{ name: "api", type: "Radius.Compute/containers" }],
      recipes,
      "kubernetes"
    );

    expect(resolved[0].outputResources[0].displayType).toBe("Deployment (K8s)");
  });

  it("preserves every field of the app resource on the planned entry", async () => {
    const gh = fakeGitHub();
    const appResource = {
      id: "/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/api",
      name: "api",
      type: "Radius.Compute/containers@2025-08-01-preview",
      connections: [{ id: "db", direction: "Outbound" }],
      diffHash: `sha256:${"a".repeat(64)}`
    };

    const resolved = await resolveRecipeOutputs(gh, [appResource], [], "azure");

    expect(resolved[0]).toMatchObject({
      id: appResource.id,
      name: "api",
      connections: appResource.connections,
      diffHash: appResource.diffHash
    });
  });

  it("returns an empty list for no app resources", async () => {
    expect(await resolveRecipeOutputs(fakeGitHub(), [], [], "azure")).toEqual(
      []
    );
  });
});
