import { describe, expect, it } from "vitest";
import { azure } from "./azure.js";

describe("azure.portalUrl", () => {
  const ctx = {
    subscriptionId: "11111111-2222-3333-4444-555555555555",
    resourceGroup: "radius-rg",
    region: "eastus",
    clusterName: "radius-aks",
  };

  it("falls back to resource group resource list for type-only ARM references", () => {
    const url = azure.portalUrl("Microsoft.Cache/redis", ctx);
    expect(url).toBe(
      "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/resources",
    );
  });

  it("falls back to resource group resource list for type-only ARM references with API versions", () => {
    const url = azure.portalUrl("Microsoft.Cache/redis@2024-03-01", ctx);
    expect(url).toBe(
      "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/resources",
    );
  });

  it("links directly to a concrete ARM resource ID", () => {
    const id =
      "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.DBforMySQL/flexibleServers/radius-mysql/databases/appdb";
    const url = azure.portalUrl(id, ctx);
    expect(url).toBe(
      "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.DBforMySQL/flexibleServers/radius-mysql/databases/appdb/overview",
    );
  });

  it("links kubernetes resources to the concrete AKS cluster", () => {
    const url = azure.portalUrl("apps/Deployment", ctx);
    expect(url).toBe(
      "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.ContainerService/managedClusters/radius-aks/overview",
    );
  });

  it("falls back to the resource group overview when type is unknown", () => {
    const url = azure.portalUrl("Some/UnknownType", ctx);
    expect(url).toBe(
      "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/resources",
    );
  });
});
