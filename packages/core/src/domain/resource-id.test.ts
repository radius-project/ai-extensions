import { describe, expect, it } from "vitest";
import { parseResourceId } from "./resource-id.js";

const prefix = "/planes/radius/local/resourceGroups/team/providers/";

describe("resource identity", () => {
  it.each(["Radius.Compute", "Radius.Core", "Radius.Custom2"])(
    "preserves %s identity, punctuation and nested types",
    (provider) => {
      const id = `${prefix}${provider}/applications/app.one_2/children/child`;
      expect(parseResourceId(id)).toEqual({
        id,
        plane: { type: "radius", name: "local" },
        scopes: [{ type: "resourceGroups", name: "team" }],
        resourceGroup: "team",
        provider,
        type: `${provider}/applications/children`,
        name: "child",
        segments: [
          { type: "applications", name: "app.one_2" },
          { type: "children", name: "child" }
        ]
      });
    }
  );
  it("parses an Azure Resource Manager ID without a plane", () => {
    const id =
      "/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Cache/redis/cache";
    expect(parseResourceId(id)).toEqual({
      id,
      scopes: [
        { type: "subscriptions", name: "0000" },
        { type: "resourceGroups", name: "rg" }
      ],
      resourceGroup: "rg",
      provider: "Microsoft.Cache",
      type: "Microsoft.Cache/redis",
      name: "cache",
      segments: [{ type: "redis", name: "cache" }]
    });
  });
  it("parses a UCP-qualified Azure ID", () => {
    expect(
      parseResourceId(
        "/planes/azure/azurecloud/subscriptions/0000/resourceGroups/RG/providers/Microsoft.Storage/storageAccounts/store"
      )
    ).toMatchObject({
      plane: { type: "azure", name: "azurecloud" },
      resourceGroup: "RG",
      type: "Microsoft.Storage/storageAccounts",
      name: "store"
    });
  });
  it("parses an AWS ID, which has no resource group", () => {
    const parsed = parseResourceId(
      "/planes/aws/aws/accounts/1234/regions/us-west-2/providers/AWS.Kinesis/Stream/events"
    );
    expect(parsed).toMatchObject({
      plane: { type: "aws", name: "aws" },
      scopes: [
        { type: "accounts", name: "1234" },
        { type: "regions", name: "us-west-2" }
      ],
      provider: "AWS.Kinesis",
      type: "AWS.Kinesis/Stream",
      name: "events"
    });
    expect(parsed).not.toHaveProperty("resourceGroup");
  });
  it("parses a plane-scoped resource without scope pairs", () => {
    expect(
      parseResourceId(
        "/planes/radius/local/providers/System.Resources/resourceProviders/Radius.Core"
      )
    ).toMatchObject({
      scopes: [],
      provider: "System.Resources",
      type: "System.Resources/resourceProviders",
      name: "Radius.Core"
    });
  });
  it.each([
    "",
    "name",
    "/planes",
    "/planes/radius/local",
    "/planes/radius/local/resourceGroups",
    "/planes/radius/local/resourceGroups/team",
    "/planes/radius/local/resourceGroups/team/providers",
    "/subscriptions/0000/resourceGroups/rg",
    `${prefix}Radius.Core/apps`,
    `${prefix}Radius.Core/apps/a/`,
    `${prefix}Radius.Core/apps/..`,
    `${prefix}Radius.Core/apps/a?query`,
    `${prefix}Radius.Core/apps/a#fragment`,
    `${prefix}Radius.Core/apps/a\\b`,
    `${prefix}Radius.Core/apps/a b`,
    `${prefix}Microsoft.Web/sites/a/providers/Microsoft.Insights/diagnosticSettings/d`,
    "/wrong/radius/local/resourceGroups/team/providers/Radius.Core/apps/a",
    "/planes/radius/local/resourceGroups/team/wrong/Radius.Core/apps/a",
    "/planes//local/resourceGroups/team/providers/Radius.Core/apps/a"
  ])("rejects malformed or non-resource identity %s", (id) => {
    expect(parseResourceId(id)).toBeUndefined();
  });
});
