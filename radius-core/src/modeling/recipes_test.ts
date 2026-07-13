import { describe, it, expect } from "vitest";
import {
  mapFileToResourceType,
  parseRecipeResources,
  formatResourceType,
  radiusTypeToContribDir,
  CANONICAL_RESOURCE_MAP,
  categorizeToCanonicalType,
  resolveCanonicalResources,
  inferResourcesFromSchema,
  generateRecipeFromStaticMappings,
} from "./recipes.js";

describe("mapFileToResourceType", () => {
  it("maps known base names to their Radius namespace type", () => {
    expect(mapFileToResourceType("containers")).toBe("Radius.Compute/containers");
    expect(mapFileToResourceType("mySqlDatabases")).toBe("Radius.Data/mySqlDatabases");
    expect(mapFileToResourceType("secrets")).toBe("Radius.Security/secrets");
    expect(mapFileToResourceType("rabbitMQQueues")).toBe("Radius.Messaging/rabbitMQQueues");
    expect(mapFileToResourceType("stateStores")).toBe("Radius.Dapr/stateStores");
  });

  it("falls back to Radius.Core/<baseName> for unknown names", () => {
    expect(mapFileToResourceType("widgets")).toBe("Radius.Core/widgets");
    expect(mapFileToResourceType("")).toBe("Radius.Core/");
  });
});

describe("formatResourceType", () => {
  it("formats Azure (Microsoft.*) types", () => {
    expect(formatResourceType("Microsoft.Cache/redis")).toBe("Azure Cache/redis");
    expect(formatResourceType("Microsoft.KeyVault/vaults")).toBe("Azure KeyVault/vaults");
  });

  it("formats Azure types with a missing resource segment", () => {
    expect(formatResourceType("Microsoft.Storage")).toBe("Azure Storage/");
  });

  it("formats AWS types", () => {
    expect(formatResourceType("AWS.MemoryDB/Cluster")).toBe("AWS MemoryDB Cluster");
    expect(formatResourceType("AWS.S3/Bucket")).toBe("AWS S3 Bucket");
  });

  it("formats built-in Kubernetes types", () => {
    expect(formatResourceType("apps/Deployment")).toBe("K8s Deployment");
    expect(formatResourceType("core/Service")).toBe("K8s Service");
    expect(formatResourceType("batch/Job")).toBe("K8s Job");
  });

  it("returns the raw type for unrecognized inputs", () => {
    expect(formatResourceType("google/Compute")).toBe("google/Compute");
    expect(formatResourceType("plaintype")).toBe("plaintype");
  });
});

describe("radiusTypeToContribDir", () => {
  it("converts a Radius type to its contrib directory", () => {
    expect(radiusTypeToContribDir("Radius.Compute/containers")).toBe("Compute/containers");
    expect(radiusTypeToContribDir("Radius.Data/mySqlDatabases")).toBe("Data/mySqlDatabases");
  });

  it("returns null when the type is not a two-part path", () => {
    expect(radiusTypeToContribDir("Radius.Compute")).toBeNull();
    expect(radiusTypeToContribDir("Radius.Compute/containers/extra")).toBeNull();
  });
});

describe("parseRecipeResources", () => {
  it("returns an empty array when there are no resource declarations", () => {
    expect(parseRecipeResources("")).toEqual([]);
    expect(parseRecipeResources("param foo string")).toEqual([]);
  });

  it("categorizes an Azure (Microsoft.*) resource", () => {
    const content = `resource cache 'Microsoft.Cache/redis@2022-06-01' = {}`;
    const resources = parseRecipeResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual({
      name: "cache",
      type: "Microsoft.Cache/redis",
      apiVersion: "2022-06-01",
      provider: "azure",
      displayType: "Azure Cache/redis",
    });
  });

  it("categorizes an AWS resource", () => {
    const content = `resource cluster 'AWS.MemoryDB/Cluster@default' = {}`;
    const resources = parseRecipeResources(content);
    expect(resources[0].provider).toBe("aws");
    expect(resources[0].apiVersion).toBe("default");
  });

  it("categorizes a Kubernetes resource by its API group", () => {
    const content = `resource dep 'apps/Deployment@v1' = {}`;
    const resources = parseRecipeResources(content);
    expect(resources[0].provider).toBe("kubernetes");
  });

  it("categorizes a dotted DNS-style Kubernetes group", () => {
    const content = `resource ing 'networking.k8s.io/Ingress@v1' = {}`;
    const resources = parseRecipeResources(content);
    expect(resources[0].provider).toBe("kubernetes");
  });

  it("defaults to the cloud provider for unknown groups", () => {
    const content = `resource thing 'Some.Custom/thing@v1' = {}`;
    const resources = parseRecipeResources(content);
    expect(resources[0].provider).toBe("cloud");
  });

  it("handles a resource with no apiVersion", () => {
    const content = `resource dep 'apps/Deployment' = {}`;
    const resources = parseRecipeResources(content);
    expect(resources[0].apiVersion).toBe("");
  });

  it("skips 'existing' resources", () => {
    const content = `resource preexisting 'Microsoft.Cache/redis@2022-06-01' existing = {}`;
    expect(parseRecipeResources(content)).toEqual([]);
  });

  it("parses multiple resource declarations", () => {
    const content = `
resource db 'Microsoft.DBforMySQL/flexibleServers@2023-01-01' = {}
resource dep 'apps/Deployment@v1' = {}
`;
    const resources = parseRecipeResources(content);
    expect(resources).toHaveLength(2);
    expect(resources[0].provider).toBe("azure");
    expect(resources[1].provider).toBe("kubernetes");
  });
});

describe("categorizeToCanonicalType", () => {
  it("categorizes by type name keyword", () => {
    expect(categorizeToCanonicalType("myMySqlThing")).toBe("Radius.Data/mySqlDatabases");
    expect(categorizeToCanonicalType("postgresStore")).toBe("Radius.Data/postgreSqlDatabases");
    expect(categorizeToCanonicalType("redisThing")).toBe("Radius.Data/redisCaches");
    expect(categorizeToCanonicalType("mongoStore")).toBe("Radius.Data/mongoDatabases");
    expect(categorizeToCanonicalType("neo4jGraph")).toBe("Radius.Data/neo4jDatabases");
    expect(categorizeToCanonicalType("rabbitBroker")).toBe("Radius.Messaging/rabbitMQQueues");
    expect(categorizeToCanonicalType("mySecret")).toBe("Radius.Security/secrets");
    expect(categorizeToCanonicalType("someContainer")).toBe("Radius.Compute/containers");
  });

  it("uses the description as a hint when the type name is generic", () => {
    expect(categorizeToCanonicalType("thing", "an in-memory cache")).toBe("Radius.Data/redisCaches");
    expect(categorizeToCanonicalType("thing", "backed by cosmos")).toBe("Radius.Data/mongoDatabases");
  });

  it("prefers more specific keywords (mysql over generic sql)", () => {
    expect(categorizeToCanonicalType("mysqlDatabase")).toBe("Radius.Data/mySqlDatabases");
    expect(categorizeToCanonicalType("genericSqlDatabase")).toBe("Radius.Data/sqlDatabases");
  });

  it("returns null when nothing matches", () => {
    expect(categorizeToCanonicalType("widget")).toBeNull();
    expect(categorizeToCanonicalType("")).toBeNull();
  });
});

describe("resolveCanonicalResources", () => {
  it("resolves an exact canonical type for azure", () => {
    const resources = resolveCanonicalResources("Radius.Data/mySqlDatabases", "azure");
    expect(resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/mySqlDatabases"].azure);
    expect(resources[0].provider).toBe("azure");
  });

  it("resolves an exact canonical type for aws", () => {
    const resources = resolveCanonicalResources("Radius.Data/mySqlDatabases", "aws");
    expect(resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/mySqlDatabases"].aws);
    expect(resources[0].provider).toBe("aws");
  });

  it("treats any non-aws provider as azure", () => {
    const kube = resolveCanonicalResources("Radius.Data/mySqlDatabases", "kubernetes");
    expect(kube).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/mySqlDatabases"].azure);
  });

  it("falls back to categorization for a non-canonical type", () => {
    const resources = resolveCanonicalResources("Radius.Custom/myRedisCache", "azure");
    expect(resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/redisCaches"].azure);
  });

  it("returns an empty array when nothing matches", () => {
    expect(resolveCanonicalResources("Radius.Custom/widget", "azure")).toEqual([]);
  });
});

describe("inferResourcesFromSchema", () => {
  it("resolves resources from an exact type regardless of schema text", () => {
    const schema = `description: |
  A MySQL database.
apiVersions:`;
    const resources = inferResourcesFromSchema(schema, "Radius.Data/mySqlDatabases", "aws");
    expect(resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/mySqlDatabases"].aws);
  });

  it("uses the schema description to categorize an unknown type", () => {
    const schema = `description: |
  Provides a managed cache layer.
types:`;
    const resources = inferResourcesFromSchema(schema, "Radius.Custom/thing", "azure");
    expect(resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/redisCaches"].azure);
  });

  it("returns an empty array when neither type nor description match", () => {
    const schema = `description: |
  A totally novel resource.
types:`;
    expect(inferResourcesFromSchema(schema, "Radius.Custom/widget", "azure")).toEqual([]);
  });
});

describe("generateRecipeFromStaticMappings", () => {
  it("returns canonical resources when the type is mappable", () => {
    const resources = generateRecipeFromStaticMappings("Radius.Data/redisCaches", "aws");
    expect(resources).toBe(CANONICAL_RESOURCE_MAP["Radius.Data/redisCaches"].aws);
  });

  it("returns a single generic cloud resource when nothing maps", () => {
    const resources = generateRecipeFromStaticMappings("Radius.Custom/widgets", "azure");
    expect(resources).toEqual([
      { name: "resource", type: "widgets", provider: "cloud", displayType: "widgets" },
    ]);
  });
});

describe("CANONICAL_RESOURCE_MAP", () => {
  it("provides azure and aws entries for every canonical type", () => {
    for (const [type, byProvider] of Object.entries(CANONICAL_RESOURCE_MAP)) {
      expect(Array.isArray(byProvider.azure), `${type}.azure`).toBe(true);
      expect(Array.isArray(byProvider.aws), `${type}.aws`).toBe(true);
      expect(byProvider.azure.length).toBeGreaterThan(0);
      expect(byProvider.aws.length).toBeGreaterThan(0);
    }
  });

  it("gives every concrete resource the required fields", () => {
    for (const byProvider of Object.values(CANONICAL_RESOURCE_MAP)) {
      for (const res of [...byProvider.azure, ...byProvider.aws]) {
        expect(res).toHaveProperty("name");
        expect(res).toHaveProperty("type");
        expect(res).toHaveProperty("provider");
        expect(res).toHaveProperty("displayType");
      }
    }
  });
});
