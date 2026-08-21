import { describe, it, expect } from "vitest";
import { getPlatform, generatePortalUrl } from "./index.js";

describe("getPlatform", () => {
  it("returns the azure platform by id", () => {
    const platform = getPlatform("azure");
    expect(platform).toBeDefined();
    expect(platform!.id).toBe("azure");
    expect(platform!.displayName).toBe("Azure");
    expect(platform!.clusterServiceName).toBe("AKS");
    expect(typeof platform!.portalUrl).toBe("function");
  });

  it("returns the aws platform by id", () => {
    const platform = getPlatform("aws");
    expect(platform).toBeDefined();
    expect(platform!.id).toBe("aws");
    expect(platform!.displayName).toBe("AWS");
    expect(platform!.clusterServiceName).toBe("EKS");
    expect(typeof platform!.portalUrl).toBe("function");
  });

  it("returns undefined for an unknown platform id", () => {
    expect(getPlatform("gcp")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getPlatform("")).toBeUndefined();
  });
});

describe("generatePortalUrl", () => {
  // The deep link is built from a fixed placeholder context. Nothing populates
  // a real subscription, resource group, region, or cluster, so these assert the
  // placeholder contract rather than state-driven substitution.
  it("returns an azure portal URL built from a full ARM resource ID", () => {
    const armId =
      "/subscriptions/sub-123/resourceGroups/my-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/mydb";
    const url = generatePortalUrl(armId, "azure");
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("sub-123");
    expect(url).toContain("my-rg");
    expect(url).toContain("Microsoft.DBforPostgreSQL");
    expect(url).toContain("flexibleServers");
  });

  it("returns an aws console URL for a known aws resource type", () => {
    const url = generatePortalUrl("aws_db_instance", "aws");
    expect(url).toContain("us-east-1.console.aws.amazon.com");
    expect(url).toContain("rds");
  });

  it("uses the placeholder subscription and resource group for azure links", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "azure");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg");
  });

  it("uses the placeholder region for aws links", () => {
    const url = generatePortalUrl("aws_db_instance", "aws");
    expect(url).toContain("us-east-1");
  });

  it("returns empty string for an unknown provider", () => {
    const url = generatePortalUrl("DBforPostgreSQL", "gcp");
    expect(url).toBe("");
  });

  it("returns empty string when provider is null", () => {
    const url = generatePortalUrl("DBforPostgreSQL", null as any);
    expect(url).toBe("");
  });

  it("returns empty string when provider is undefined", () => {
    const url = generatePortalUrl("DBforPostgreSQL", undefined as any);
    expect(url).toBe("");
  });

  it("falls back to the azure resource group resource list for an unrecognized resource type", () => {
    const url = generatePortalUrl("UnknownResource", "azure");
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg/resources");
  });

  it("falls back to the azure resource group resource list for unsupported shorthand azure resource types", () => {
    const url = generatePortalUrl("KeyVault", "azure");
    expect(url).toContain("portal.azure.com");
    expect(url).toContain("00000000-0000-0000-0000-000000000000");
    expect(url).toContain("radius-rg/resources");
  });

  it("handles aws ECR resource type", () => {
    const url = generatePortalUrl("aws_ecr", "aws");
    expect(url).toContain("ecr/repositories");
    expect(url).toContain("us-east-1");
  });

  // No cluster name is supplied, so azure kubernetes types cannot deep link to
  // AKS and fall back to the resource group list. The cluster-linked form is
  // covered directly against azure.portalUrl in azure.test.ts.
  it("falls back to the resource group list for azure kubernetes types without a cluster", () => {
    const url = generatePortalUrl("apps/Deployment", "azure");
    expect(url).not.toContain("managedClusters");
    expect(url).toContain("radius-rg/resources");
  });

  it("handles kubernetes resource types on aws (links to EKS)", () => {
    const url = generatePortalUrl("core/Service", "aws");
    expect(url).toContain("eks");
  });
});
