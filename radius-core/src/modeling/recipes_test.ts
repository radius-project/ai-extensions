import { describe, it, expect } from "vitest";
import {
  mapFileToResourceType,
  parseRecipeResources,
  formatResourceType,
  radiusTypeToContribDir,
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

