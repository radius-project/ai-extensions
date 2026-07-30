import { describe, expect, it } from "vitest";
import { azure } from "./azure.js";

describe("azure platform", () => {
  // ─── Static properties ───────────────────────────────────────────────────────

  describe("static properties", () => {
    it("has the correct id", () => {
      expect(azure.id).toBe("azure");
    });

    it("has the correct displayName", () => {
      expect(azure.displayName).toBe("Azure");
    });

    it("has recipePlatform set to kubernetes", () => {
      expect(azure.recipePlatform).toBe("kubernetes");
    });

    it("has clusterServiceName set to AKS", () => {
      expect(azure.clusterServiceName).toBe("AKS");
    });

    it("supports oidc", () => {
      expect(azure.supports.oidc).toBe(true);
    });

    it("supports portalUrl", () => {
      expect(azure.supports.portalUrl).toBe(true);
    });

  });

  // ─── generateOidc ────────────────────────────────────────────────────────────

  describe("generateOidc", () => {
    it("returns a message and output with populated data", () => {
      const result = azure.generateOidc({
        tenantId: "tenant-123",
        subscriptionId: "sub-456",
        clientId: "client-789",
      });
      expect(result.message).toBe("Azure OIDC configuration generated");
      expect(result.output).toContain("tenant-123");
      expect(result.output).toContain("sub-456");
      expect(result.output).toContain("client-789");
      expect(result.output).toContain("AZURE_TENANT_ID");
      expect(result.output).toContain("AZURE_SUBSCRIPTION_ID");
      expect(result.output).toContain("AZURE_CLIENT_ID");
      expect(result.output).toContain("az ad app federated-credential create");
      expect(result.output).toContain("az role assignment create");
    });

    it("uses empty strings when data fields are missing", () => {
      const result = azure.generateOidc({});
      expect(result.message).toBe("Azure OIDC configuration generated");
      expect(result.output).toContain('--body ""');
      expect(result.output).toContain("<CLIENT_ID>");
      expect(result.output).toContain("<SUBSCRIPTION_ID>");
    });

    it("handles undefined data fields gracefully", () => {
      const result = azure.generateOidc({ tenantId: undefined, subscriptionId: undefined, clientId: undefined });
      expect(result.message).toBe("Azure OIDC configuration generated");
      expect(result.output).toContain('--body ""');
    });

    it("does not crash with null data (null guard added)", () => {
      const result = azure.generateOidc(null);
      expect(result.message).toBe("Azure OIDC configuration generated");
      expect(result.output).toContain("<CLIENT_ID>");
    });

    it("does not crash with an empty object", () => {
      expect(() => azure.generateOidc({})).not.toThrow();
    });

    it("includes a Service Management Reference (Service Tree) note for enterprise tenants", () => {
      const result = azure.generateOidc({ clientId: "client-789" });
      expect(result.output).toContain("--service-management-reference");
      expect(result.output).toContain("ServiceManagementReference");
    });

    it("warns that a customized/immutable OIDC subject must match GitHub", () => {
      const result = azure.generateOidc({ repo: "octo-org/octo-repo" });
      expect(result.output).toContain("actions/oidc/customization/sub");
      expect(result.output).toContain("AADSTS700213");
    });

    it("uses the provided repo full name and environment in the subject", () => {
      const result = azure.generateOidc({
        repoFullName: "octo-org/octo-repo",
        environment: "staging",
      });
      expect(result.output).toContain(
        '"subject": "repo:octo-org/octo-repo:environment:staging"',
      );
    });

    it("falls back to OWNER/REPO and production in the subject", () => {
      const result = azure.generateOidc({});
      expect(result.output).toContain(
        '"subject": "repo:OWNER/REPO:environment:production"',
      );
    });
  });

  // ─── environmentSecrets ──────────────────────────────────────────────────────

  describe("environmentSecrets", () => {
    it("returns the correct secrets with provided data", () => {
      const secrets = azure.environmentSecrets({
        subscriptionId: "sub-123",
        resourceGroup: "rg-test",
        location: "westus2",
      });
      expect(secrets).toHaveLength(3);
      expect(secrets[0]).toEqual({ kind: "variable", name: "AZURE_SUBSCRIPTION_ID", value: "sub-123" });
      expect(secrets[1]).toEqual({ kind: "variable", name: "AZURE_RESOURCE_GROUP", value: "rg-test" });
      expect(secrets[2]).toEqual({ kind: "variable", name: "AZURE_LOCATION", value: "westus2" });
    });

    it("returns undefined values when data fields are missing", () => {
      const secrets = azure.environmentSecrets({});
      expect(secrets).toHaveLength(3);
      expect(secrets[0].value).toBeUndefined();
      expect(secrets[1].value).toBeUndefined();
      expect(secrets[2].value).toBeUndefined();
    });

    it("does not crash with null data (null guard added)", () => {
      const secrets = azure.environmentSecrets(null);
      expect(secrets).toHaveLength(3);
      expect(secrets[0].value).toBeUndefined();
    });

    it("all entries have kind 'variable'", () => {
      const secrets = azure.environmentSecrets({ subscriptionId: "s", resourceGroup: "r", location: "l" });
      for (const s of secrets) {
        expect(s.kind).toBe("variable");
      }
    });
  });

  // ─── portalUrl ───────────────────────────────────────────────────────────────

  describe("portalUrl", () => {
    const ctx = {
      subscriptionId: "11111111-2222-3333-4444-555555555555",
      resourceGroup: "radius-rg",
      region: "eastus",
      clusterName: "radius-aks",
    };

    const rgUrl =
      "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/resources";

    // --- ARM resource ID path (normalizeArmResourceId) ---

    it("links directly to a concrete ARM resource ID", () => {
      const id =
        "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.DBforMySQL/flexibleServers/radius-mysql/databases/appdb";
      const url = azure.portalUrl(id, ctx);
      expect(url).toBe(
        "https://portal.azure.com/#@/resource/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.DBforMySQL/flexibleServers/radius-mysql/databases/appdb/overview",
      );
    });

    it("handles ARM resource ID with leading double slashes", () => {
      const id =
        "//subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.Cache/redis/myredis";
      const url = azure.portalUrl(id, ctx);
      expect(url).toContain("/overview");
      expect(url).toContain("Microsoft.Cache/redis/myredis");
    });

    it("handles ARM resource ID with trailing slashes", () => {
      const id =
        "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.Cache/redis/myredis/";
      const url = azure.portalUrl(id, ctx);
      expect(url).toContain("/overview");
    });

    it("handles ARM resource ID with query string", () => {
      const id =
        "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/radius-rg/providers/Microsoft.Cache/redis/myredis?api-version=2024-01-01";
      const url = azure.portalUrl(id, ctx);
      expect(url).toContain("/overview");
      expect(url).not.toContain("api-version");
    });

    it("returns the resource group url for non-ARM strings", () => {
      const url = azure.portalUrl("random/string", ctx);
      expect(url).toBe(rgUrl);
    });

    // --- normalizeAzureResourceType path ---

    it("falls back to resource group resource list for type-only ARM references", () => {
      const url = azure.portalUrl("Microsoft.Cache/redis", ctx);
      expect(url).toBe(rgUrl);
    });

    it("falls back to resource group resource list for type-only ARM references with API versions", () => {
      const url = azure.portalUrl("Microsoft.Cache/redis@2024-03-01", ctx);
      expect(url).toBe(rgUrl);
    });

    it("handles Microsoft.* type with nested subtypes", () => {
      const url = azure.portalUrl("Microsoft.Network/virtualNetworks/subnets", ctx);
      expect(url).toBe(rgUrl);
    });

    it("handles resource type that is a full ARM ID path", () => {
      // normalizeArmResourceId runs first, catches /subscriptions/ paths
      const id =
        "/subscriptions/sub-id/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
      const url = azure.portalUrl(id, ctx);
      expect(url).toContain("/overview");
    });

    it("handles ARM ID with spaces via normalizeArmResourceId", () => {
      const url = azure.portalUrl("  /subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/mysite  ", ctx);
      expect(url).toContain("/overview");
    });

    // --- isKubernetesResourceType path ---

    it("links kubernetes 'apps/' resources to the concrete AKS cluster", () => {
      const url = azure.portalUrl("apps/Deployment", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'core/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("core/Service", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'batch/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("batch/Job", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'autoscaling/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("autoscaling/HorizontalPodAutoscaler", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'networking.k8s.io/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("networking.k8s.io/Ingress", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'storage.k8s.io/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("storage.k8s.io/StorageClass", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'rbac.authorization.k8s.io/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("rbac.authorization.k8s.io/ClusterRole", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links kubernetes 'apiextensions.k8s.io/' resources to the AKS cluster", () => {
      const url = azure.portalUrl("apiextensions.k8s.io/CustomResourceDefinition", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("is case-insensitive for kubernetes resource types", () => {
      const url = azure.portalUrl("APPS/Deployment", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("links Radius.* resources to AKS cluster when cluster name is provided", () => {
      const url = azure.portalUrl("Radius.Compute/containers", ctx);
      expect(url).toContain("managedClusters/radius-aks/overview");
    });

    it("falls back to resource group when Radius.* resource and no cluster name", () => {
      const noClusterCtx = { ...ctx, clusterName: "" };
      const url = azure.portalUrl("Radius.Compute/containers", noClusterCtx);
      expect(url).toBe(rgUrl);
    });

    it("falls back to resource group when kubernetes type and no cluster name", () => {
      const noClusterCtx = { ...ctx, clusterName: undefined };
      const url = azure.portalUrl("apps/Deployment", noClusterCtx);
      expect(url).toBe(rgUrl);
    });

    it("falls back to resource group when cluster name is only whitespace", () => {
      const wsCtx = { ...ctx, clusterName: "   " };
      const url = azure.portalUrl("apps/Deployment", wsCtx);
      expect(url).toBe(rgUrl);
    });

    // --- Unknown/fallback path ---

    it("falls back to the resource group overview when type is unknown", () => {
      const url = azure.portalUrl("Some/UnknownType", ctx);
      expect(url).toBe(rgUrl);
    });

    it("falls back to resource group for empty string resource type", () => {
      const url = azure.portalUrl("", ctx);
      expect(url).toBe(rgUrl);
    });

    it("falls back to resource group for whitespace-only resource type", () => {
      const url = azure.portalUrl("   ", ctx);
      expect(url).toBe(rgUrl);
    });

    // --- Edge cases for normalizeArmResourceId ---

    it("does not treat a path without /subscriptions/ prefix as an ARM ID", () => {
      const url = azure.portalUrl("/resourceGroups/rg/providers/Microsoft.Cache/redis/myredis", ctx);
      // This won't match normalizeArmResourceId, won't match normalizeAzureResourceType, isn't kubernetes
      expect(url).toBe(rgUrl);
    });

    // --- Edge cases for normalizeAzureResourceType ---

    it("handles resource type that is only an API version (empty after split)", () => {
      const url = azure.portalUrl("@2024-01-01", ctx);
      // normalizeAzureResourceType: trimmed = "@2024-01-01", noApiVersion = "" → returns ""
      expect(url).toBe(rgUrl);
    });

    it("handles resource type that starts with spaces then Microsoft.", () => {
      const url = azure.portalUrl("  Microsoft.Storage/storageAccounts  ", ctx);
      expect(url).toBe(rgUrl);
    });

    // --- Edge cases for normalizeArmResourceId ---

    it("handles ARM ID with no /providers/ segment", () => {
      const id = "/subscriptions/sub-id/resourceGroups/rg-name";
      const url = azure.portalUrl(id, ctx);
      expect(url).toContain("/overview");
    });

    it("handles ARM ID with provider but only one segment after", () => {
      const id = "/subscriptions/sub-id/resourceGroups/rg/providers/Microsoft.Web";
      const url = azure.portalUrl(id, ctx);
      expect(url).toContain("/overview");
    });

    // --- Error conditions: verify no crashes ---

    it("does not crash when resourceType is null-ish (empty)", () => {
      expect(() => azure.portalUrl("", ctx)).not.toThrow();
    });

    it("does not crash with very long resource type string", () => {
      const longStr = "Microsoft." + "a".repeat(10000);
      expect(() => azure.portalUrl(longStr, ctx)).not.toThrow();
    });

    it("does not crash with special characters in resource type", () => {
      expect(() => azure.portalUrl("Microsoft.Cache/redis!@#$%^&*()", ctx)).not.toThrow();
    });

    it("does not crash with unicode characters in resource type", () => {
      expect(() => azure.portalUrl("Microsoft.Cache/redis/名前", ctx)).not.toThrow();
    });

    it("does not crash with newlines in resource type", () => {
      expect(() => azure.portalUrl("Microsoft.Cache\n/redis", ctx)).not.toThrow();
    });
  });

  // ─── Error conditions for all methods ────────────────────────────────────────

  describe("error conditions", () => {
    it("generateOidc does not crash with numeric data values", () => {
      const result = azure.generateOidc({ tenantId: 12345, subscriptionId: 67890, clientId: 0 });
      expect(result.message).toBe("Azure OIDC configuration generated");
      expect(result.output).toContain("12345");
    });

    it("generateOidc does not crash with boolean data values", () => {
      expect(() => azure.generateOidc({ tenantId: true, subscriptionId: false })).not.toThrow();
    });

    it("environmentSecrets does not crash with numeric values", () => {
      const secrets = azure.environmentSecrets({ subscriptionId: 123, resourceGroup: 456, location: 789 });
      expect(secrets).toHaveLength(3);
      expect(secrets[0].value).toBe(123);
    });

    it("environmentSecrets does not crash with empty string values", () => {
      const secrets = azure.environmentSecrets({ subscriptionId: "", resourceGroup: "", location: "" });
      expect(secrets).toHaveLength(3);
    });

    it("portalUrl does not crash with missing context fields", () => {
      const minCtx = { subscriptionId: "sub", resourceGroup: "rg", region: "eastus" };
      expect(() => azure.portalUrl("apps/Deployment", minCtx)).not.toThrow();
    });

    it("portalUrl does not crash with null resourceType", () => {
      const ctx = { subscriptionId: "sub", resourceGroup: "rg", region: "eastus" };
      expect(() => azure.portalUrl(null as unknown as string, ctx)).not.toThrow();
    });

    it("portalUrl does not crash with undefined resourceType", () => {
      const ctx = { subscriptionId: "sub", resourceGroup: "rg", region: "eastus" };
      expect(() => azure.portalUrl(undefined as unknown as string, ctx)).not.toThrow();
    });
  });
});
