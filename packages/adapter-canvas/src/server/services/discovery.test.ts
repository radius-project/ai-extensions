import { describe, expect, it } from "vitest";
import { isUuid } from "../../azure-oidc.js";
import { discoverResources, type DiscoveryDependencies } from "./discovery.js";

describe("discovery service (SU-08)", () => {
  it("can reject unsafe subscription input without an HTTP context or CLI call", async () => {
    const dependencies: DiscoveryDependencies = {
      isUuid,
      runCli: () => {
        throw new Error("CLI must not be reached");
      }
    };

    await expect(
      discoverResources(
        { provider: "azure", subscriptionId: "x&calc" },
        dependencies
      )
    ).resolves.toEqual({
      error: 'Invalid subscriptionId "x&calc" (expected a GUID).',
      clusters: [],
      resourceGroups: [],
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    });
  });
});
