import { describe, it, expect } from "vitest";
import {
  mapFileToResourceType,
  parseRecipeResources,
  formatResourceType,
  radiusTypeToContribDir,
  categorizeToCanonicalType,
  resolveCanonicalResources,
  inferResourcesFromSchema,
  generateRecipeFromStaticMappings,
  CANONICAL_RESOURCE_MAP,
} from "./recipes.js";

// ─── mapFileToResourceType ───────────────────────────────────────────────────

describe("mapFileToResourceType", () => {
  it("maps known base names to their Radius namespace", () => {
    expect(mapFileToResourceType("containers")).toBe("Radius.Compute/containers");
    expect(mapFileToResourceType("mySqlDatabases")).toBe("Radius.Data/mySqlDatabases");
    expect(mapFileToResourceType("secrets")).toBe("Radius.Security/secrets");
    expect(mapFileToResourceType("gateways")).toBe("Radius.Networking/gateways");
    expect(mapFileToResourceType("rabbitMQQueues")).toBe("Radius.Messaging/rabbitMQQueues");
    expect(mapFileToResourceType("stateStores")).toBe("Radius.Dapr/stateStores");
    expect(mapFileToResourceType("pubSubBrokers")).toBe("Radius.Dapr/pubSubBrokers");
  });

  it("falls back to Radius.Core/<baseName> for unknown types", () => {
    expect(mapFileToResourceType("unknownThing")).toBe("Radius.Core/unknownThing");
    expect(mapFileToResourceType("customResource")).toBe("Radius.Core/customResource");
  });

  it("handles empty string", () => {
    expect(mapFileToResourceType("")).toBe("Radius.Core/");
  });
});

// ─── parseRecipeResources ────────────────────────────────────────────────────

describe("parseRecipeResources", () => {
  it("parses Azure ARM resource declarations", () => {
    const bicep = `
resource redis 'Microsoft.Cache/redis@2022-06-01' = {
  name: 'myredis'
}
`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "redis",
      type: "Microsoft.Cache/redis",
      apiVersion: "2022-06-01",
      provider: "azure",
      displayType: "Azure Cache/redis",
    });
  });

  it("parses AWS resource declarations", () => {
    const bicep = `
resource ecr 'AWS.ECR/Repository@default' = {
  name: 'myrepo'
}
`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "ecr",
      type: "AWS.ECR/Repository",
      apiVersion: "default",
      provider: "aws",
    });
  });

  it("parses Kubernetes resource declarations", () => {
    const bicep = `
resource deployment 'apps/Deployment@v1' = {
  name: 'myapp'
}
`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "deployment",
      type: "apps/Deployment",
      apiVersion: "v1",
      provider: "kubernetes",
    });
  });

  it("recognizes dotted k8s groups like networking.k8s.io", () => {
    const bicep = `resource ingress 'networking.k8s.io/Ingress@v1' = { name: 'ing' }`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("kubernetes");
  });

  it("recognizes rbac.authorization.k8s.io as kubernetes", () => {
    const bicep = `resource role 'rbac.authorization.k8s.io/ClusterRole@v1' = { name: 'r' }`;
    const result = parseRecipeResources(bicep);
    expect(result[0].provider).toBe("kubernetes");
  });

  it("skips existing resource references", () => {
    const bicep = `
resource existingVnet 'Microsoft.Network/virtualNetworks@2021-02-01' existing = {
  name: 'vnet'
}
resource newNic 'Microsoft.Network/networkInterfaces@2021-02-01' = {
  name: 'nic'
}
`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("newNic");
  });

  it("parses multiple resources from a single file", () => {
    const bicep = `
resource server 'Microsoft.DBforMySQL/flexibleServers@2021-05-01' = { name: 's' }
resource db 'Microsoft.DBforMySQL/flexibleServers/databases@2021-05-01' = { name: 'd' }
`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("server");
    expect(result[1].name).toBe("db");
  });

  it("returns empty array for content with no resource declarations", () => {
    expect(parseRecipeResources("param location string = 'eastus'")).toEqual([]);
    expect(parseRecipeResources("")).toEqual([]);
  });

  it("handles resources without @apiVersion", () => {
    const bicep = `resource thing 'SomeProvider/thing' = { name: 't' }`;
    const result = parseRecipeResources(bicep);
    expect(result).toHaveLength(1);
    expect(result[0].apiVersion).toBe("");
    expect(result[0].provider).toBe("cloud");
  });
});

// ─── formatResourceType ──────────────────────────────────────────────────────

describe("formatResourceType", () => {
  it("formats Azure types", () => {
    expect(formatResourceType("Microsoft.Cache/redis")).toBe("Azure Cache/redis");
    expect(formatResourceType("Microsoft.DBforMySQL/flexibleServers")).toBe(
      "Azure DBforMySQL/flexibleServers"
    );
  });

  it("formats AWS types", () => {
    expect(formatResourceType("AWS.ECR/Repository")).toBe("AWS ECR Repository");
    expect(formatResourceType("AWS.MemoryDB/Cluster")).toBe("AWS MemoryDB Cluster");
  });

  it("formats Kubernetes types (core groups)", () => {
    expect(formatResourceType("apps/Deployment")).toBe("K8s Deployment");
    expect(formatResourceType("core/Service")).toBe("K8s Service");
    expect(formatResourceType("batch/Job")).toBe("K8s Job");
  });

  it("returns type unchanged for unknown formats", () => {
    expect(formatResourceType("SomeProvider/thing")).toBe("SomeProvider/thing");
    expect(formatResourceType("customType")).toBe("customType");
  });

  it("handles Microsoft type with no sub-resource", () => {
    expect(formatResourceType("Microsoft.Compute")).toBe("Azure Compute/");
  });
});

// ─── radiusTypeToContribDir ──────────────────────────────────────────────────

describe("radiusTypeToContribDir", () => {
  it("converts Radius type to contrib directory path", () => {
    expect(radiusTypeToContribDir("Radius.Compute/containers")).toBe("Compute/containers");
    expect(radiusTypeToContribDir("Radius.Data/mySqlDatabases")).toBe("Data/mySqlDatabases");
    expect(radiusTypeToContribDir("Radius.Security/secrets")).toBe("Security/secrets");
  });

  it("returns null for types without exactly two parts", () => {
    expect(radiusTypeToContribDir("noslash")).toBeNull();
    expect(radiusTypeToContribDir("too/many/parts")).toBeNull();
    expect(radiusTypeToContribDir("")).toBeNull();
  });
});

// ─── categorizeToCanonicalType ───────────────────────────────────────────────

describe("categorizeToCanonicalType", () => {
  it("categorizes by type name keywords", () => {
    expect(categorizeToCanonicalType("mySqlDatabases")).toBe("Radius.Data/mySqlDatabases");
    expect(categorizeToCanonicalType("postgresDatabases")).toBe("Radius.Data/postgreSqlDatabases");
    expect(categorizeToCanonicalType("redisCaches")).toBe("Radius.Data/redisCaches");
    expect(categorizeToCanonicalType("mongoDatabases")).toBe("Radius.Data/mongoDatabases");
    expect(categorizeToCanonicalType("neo4jDatabases")).toBe("Radius.Data/neo4jDatabases");
    expect(categorizeToCanonicalType("rabbitMQQueues")).toBe("Radius.Messaging/rabbitMQQueues");
    expect(categorizeToCanonicalType("amqpBroker")).toBe("Radius.Messaging/rabbitMQQueues");
    expect(categorizeToCanonicalType("secrets")).toBe("Radius.Security/secrets");
    expect(categorizeToCanonicalType("sqlDatabases")).toBe("Radius.Data/sqlDatabases");
    expect(categorizeToCanonicalType("containerImages")).toBe("Radius.Compute/containerImages");
    expect(categorizeToCanonicalType("containers")).toBe("Radius.Compute/containers");
    expect(categorizeToCanonicalType("routes")).toBe("Radius.Compute/routes");
    expect(categorizeToCanonicalType("persistentVolumes")).toBe("Radius.Compute/persistentVolumes");
  });

  it("uses description as fallback hint", () => {
    expect(categorizeToCanonicalType("myCache", "cache service")).toBe("Radius.Data/redisCaches");
    expect(categorizeToCanonicalType("cosmosAccount", "cosmos db")).toBe("Radius.Data/mongoDatabases");
  });

  it("prefers type name match over description", () => {
    // 'mysql' in type name should match even if description says 'cache'
    expect(categorizeToCanonicalType("mysqlThing", "cache")).toBe("Radius.Data/mySqlDatabases");
  });

  it("returns null for completely unknown types", () => {
    expect(categorizeToCanonicalType("unknownThing")).toBeNull();
    expect(categorizeToCanonicalType("")).toBeNull();
    expect(categorizeToCanonicalType("foo", "bar")).toBeNull();
  });

  it("handles gateway keyword", () => {
    expect(categorizeToCanonicalType("apiGateway")).toBe("Radius.Compute/routes");
  });

  it("handles volume keyword", () => {
    expect(categorizeToCanonicalType("dataVolume")).toBe("Radius.Compute/persistentVolumes");
  });

  it("handles image keyword for containerImages", () => {
    expect(categorizeToCanonicalType("imageRegistry")).toBe("Radius.Compute/containerImages");
  });
});

// ─── resolveCanonicalResources ───────────────────────────────────────────────

describe("resolveCanonicalResources", () => {
  it("resolves exact Radius type for azure provider", () => {
    const result = resolveCanonicalResources("Radius.Data/mySqlDatabases", "azure");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].provider).toBe("azure");
  });

  it("resolves exact Radius type for aws provider", () => {
    const result = resolveCanonicalResources("Radius.Data/redisCaches", "aws");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].provider).toBe("aws");
  });

  it("falls back to categorization when type is not an exact key", () => {
    const result = resolveCanonicalResources("Custom/mySqlThing", "azure");
    expect(result.length).toBeGreaterThan(0);
  });

  it("uses description hint for categorization fallback", () => {
    const result = resolveCanonicalResources("Custom/cacheStore", "azure", "cache service");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array when no match is found", () => {
    expect(resolveCanonicalResources("Unknown/foo", "azure")).toEqual([]);
    expect(resolveCanonicalResources("Unknown/foo", "aws")).toEqual([]);
  });

  it("treats non-aws providers as azure", () => {
    const azureResult = resolveCanonicalResources("Radius.Data/mySqlDatabases", "azure");
    const gcpResult = resolveCanonicalResources("Radius.Data/mySqlDatabases", "gcp");
    expect(gcpResult).toEqual(azureResult);
  });
});

// ─── inferResourcesFromSchema ────────────────────────────────────────────────

describe("inferResourcesFromSchema", () => {
  it("infers resources from schema description", () => {
    const yaml = `
description: |
  A MySQL database resource
apiVersions:
  - 2024-01-01
`;
    const result = inferResourcesFromSchema(yaml, "Radius.Data/mySqlDatabases", "azure");
    expect(result.length).toBeGreaterThan(0);
  });

  it("uses description hint from YAML when type doesn't match directly", () => {
    const yaml = `
description: |
  A cache service for redis
apiVersions:
  - 2024-01-01
`;
    const result = inferResourcesFromSchema(yaml, "Custom/myStore", "azure");
    // Description contains 'cache' so should match redisCaches
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array when schema has no useful hints", () => {
    const yaml = `
description: |
  An unknown thing
apiVersions:
  - 2024-01-01
`;
    const result = inferResourcesFromSchema(yaml, "Unknown/foo", "azure");
    expect(result).toEqual([]);
  });

  it("handles schema without description match", () => {
    const yaml = `types:\n  - something\n`;
    const result = inferResourcesFromSchema(yaml, "Radius.Data/mySqlDatabases", "azure");
    // Exact type match still works even without description
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── generateRecipeFromStaticMappings ────────────────────────────────────────

describe("generateRecipeFromStaticMappings", () => {
  it("returns mapped resources for known Radius types", () => {
    const result = generateRecipeFromStaticMappings("Radius.Data/redisCaches", "azure");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBe("apps/Deployment");
  });

  it("returns mapped resources for aws provider", () => {
    const result = generateRecipeFromStaticMappings("Radius.Data/redisCaches", "aws");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBe("aws_elasticache_replication_group");
  });

  it("returns fallback resource for completely unknown types", () => {
    const result = generateRecipeFromStaticMappings("Radius.Custom/unknownThing", "azure");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "resource",
      type: "unknownThing",
      provider: "cloud",
      displayType: "unknownThing",
    });
  });

  it("handles types with categorizable names even if not exact key", () => {
    const result = generateRecipeFromStaticMappings("Radius.Data/postgresDatabases", "azure");
    // 'postgres' in type name should match via categorization
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].provider).toBe("azure");
  });
});

// ─── CANONICAL_RESOURCE_MAP ──────────────────────────────────────────────────

describe("CANONICAL_RESOURCE_MAP", () => {
  it("is a non-empty record", () => {
    expect(Object.keys(CANONICAL_RESOURCE_MAP).length).toBeGreaterThan(0);
  });

  it("has both azure and aws entries for each type", () => {
    for (const [key, value] of Object.entries(CANONICAL_RESOURCE_MAP)) {
      expect(value).toHaveProperty("azure", expect.any(Array));
      expect(value).toHaveProperty("aws", expect.any(Array));
      expect((value as any).azure.length).toBeGreaterThan(0);
      expect((value as any).aws.length).toBeGreaterThan(0);
    }
  });

  it("each resource entry has required fields", () => {
    for (const [, value] of Object.entries(CANONICAL_RESOURCE_MAP)) {
      for (const provider of ["azure", "aws"] as const) {
        for (const entry of (value as any)[provider]) {
          expect(entry).toHaveProperty("name");
          expect(entry).toHaveProperty("type");
          expect(entry).toHaveProperty("provider");
          expect(entry).toHaveProperty("displayType");
        }
      }
    }
  });

  it("contains expected canonical types", () => {
    expect(CANONICAL_RESOURCE_MAP).toHaveProperty("Radius.Compute/containers");
    expect(CANONICAL_RESOURCE_MAP).toHaveProperty("Radius.Data/mySqlDatabases");
    expect(CANONICAL_RESOURCE_MAP).toHaveProperty("Radius.Data/redisCaches");
    expect(CANONICAL_RESOURCE_MAP).toHaveProperty("Radius.Security/secrets");
    expect(CANONICAL_RESOURCE_MAP).toHaveProperty("Radius.Messaging/rabbitMQQueues");
  });
});
