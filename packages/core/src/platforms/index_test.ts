import { describe, it, expect } from "vitest";
import { getPlatform, listPlatforms, generatePortalUrl } from "./index.js";

describe("getPlatform", () => {
  it("returns the azure platform by id", () => {
    const platform = getPlatform("azure");
    expect(platform).toBeDefined();
    expect(platform!.id).toBe("azure");
    expect(platform!.displayName).toBe("Azure");
  });

  it("returns the aws platform by id", () => {
    const platform = getPlatform("aws");
    expect(platform).toBeDefined();
    expect(platform!.id).toBe("aws");
    expect(platform!.displayName).toBe("AWS");
  });

  it("returns undefined for an unknown platform id", () => {
    expect(getPlatform("gcp")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getPlatform("")).toBeUndefined();
  });
});

describe("listPlatforms", () => {
  it("returns all registered platforms", () => {
    const platforms = listPlatforms();
    expect(platforms).toHaveLength(2);
    const ids = platforms.map((p) => p.id).sort();
    expect(ids).toEqual(["aws", "azure"]);
  });

  it("returns platform objects with required properties", () => {
    const platforms = listPlatforms();
    for (const p of platforms) {
      expect(p.id).toBeDefined();
      expect(p.displayName).toBeDefined();
      expect(p.supports).toBeDefined();
      expect(typeof p.portalUrl).toBe("function");
    }
  });
});

describe("generatePortalUrl", () => {
  it("returns an azure portal URL for a full ARM resource ID", () => {
    const state = {
      oidcAzure: { subscriptionId: "sub-123" },
      deployParams: { resourceGroup: "my-rg" }
    };
    const armId =
      "/subscriptions/sub-123/resourceGroups/my-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/mydb";
    const url = generatePortalUrl(armId, "azure", state);
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("sub-123");
    expect(url).toContain("my-rg");
    expect(url).toContain("Microsoft.DBforPostgreSQL");
    expect(url).toContain("flexibleServers");
  });

  it("returns an aws console URL for a known aws resource type", () => {
    const state = {
      oidcAws: { region: "eu-west-1" }
    };
    const url = generatePortalUrl("aws_db_instance", "aws", state);
    expect(url).toContain("eu-west-1.console.aws.amazon.com");
    expect(url).toContain("rds");
  });

  it("uses default subscription when state.oidcAzure is missing", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "azure", {});
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
  });

  it("uses default resource group when deployParams and azureResourceGroup are missing", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "azure", {});
    expect(url).toContain("radius-rg");
  });

  it("falls back to azureResourceGroup when deployParams is absent", () => {
    const state = { azureResourceGroup: "fallback-rg" };
    const url = generatePortalUrl("DBforPostgreSQL", "azure", state);
    expect(url).toContain("fallback-rg");
  });

  it("uses default region when state.oidcAws is missing", () => {
    const url = generatePortalUrl("aws_db_instance", "aws", {});
    expect(url).toContain("us-east-1");
  });

  it("returns empty string for an unknown provider", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "gcp", {});
    expect(url).toBe("");
  });

  it("handles null state without throwing", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "azure", null);
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg");
  });

  it("handles undefined state without throwing", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "azure", undefined);
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
  });

  it("handles state with null nested objects", () => {
    const state = {
      oidcAzure: null,
      deployParams: null,
      azureResourceGroup: null
    };
    const url = generatePortalUrl("DBforPostgreSQL", "azure", state);
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg");
  });

  it("handles state with empty string values (uses defaults via falsy check)", () => {
    const state = {
      oidcAzure: { subscriptionId: "" },
      deployParams: { resourceGroup: "" }
    };
    const url = generatePortalUrl("DBforPostgreSQL", "azure", state);
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg");
  });

  it("falls back to the azure resource group resource list for an unrecognized resource type", () => {
    const url = generatePortalUrl("UnknownResource", "azure", {});
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg/resources");
  });

  it("returns empty string when provider is null", () => {
    const url = generatePortalUrl("DBforPostgreSQL", null as any, {});
    expect(url).toBe("");
  });

  it("returns empty string when provider is undefined", () => {
    const url = generatePortalUrl("DBforPostgreSQL", undefined as any, {});
    expect(url).toBe("");
  });

  it("falls back to the azure resource group resource list for unsupported shorthand azure resource types", () => {
    const url = generatePortalUrl("KeyVault", "azure", {});
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg/resources");
  });

  it("handles aws ECR resource type", () => {
    const state = { oidcAws: { region: "us-west-2" } };
    const url = generatePortalUrl("aws_ecr", "aws", state);
    expect(url).toContain("ecr/repositories");
    expect(url).toContain("us-west-2");
  });

  it("handles kubernetes resource types on azure when cluster state is present (links to AKS)", () => {
    const state = {
      oidcAzure: { subscriptionId: "sub-k8s" },
      deployParams: { resourceGroup: "k8s-rg" },
      radiusK8sCluster: "my-aks-cluster"
    };
    const url = generatePortalUrl("apps/Deployment", "azure", state);
    expect(url).toContain("managedClusters/my-aks-cluster");
    expect(url).toContain("sub-k8s");
    expect(url).toContain("k8s-rg");
  });

  it("prefers deployParams.cluster when present (azure kubernetes types)", () => {
    const url = generatePortalUrl("apps/Deployment", "azure", {
      deployParams: { cluster: "dp-aks" },
      radiusK8sCluster: "radius-aks"
    });
    expect(url).toContain("managedClusters/dp-aks");
  });

  it("uses k8sCluster as a legacy fallback (azure kubernetes types)", () => {
    const url = generatePortalUrl("apps/Deployment", "azure", {
      k8sCluster: "legacy-aks"
    });
    expect(url).toContain("managedClusters/legacy-aks");
  });

  it("handles kubernetes resource types on aws (links to EKS)", () => {
    const url = generatePortalUrl("core/Service", "aws", {});
    expect(url).toContain("eks");
  });
});
