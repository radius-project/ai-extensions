import { describe, it, expect } from "vitest";
import { aws } from "./aws.js";
import { awsConsoleUrl } from "../domain/aws-console.js";
import type { PortalContext } from "./types.js";

function ctx(overrides: Partial<PortalContext> = {}): PortalContext {
  return {
    subscriptionId: "",
    resourceGroup: "",
    clusterName: "",
    ...overrides
  };
}

describe("aws platform descriptor", () => {
  it("declares the registry identity the platform registry keys on", () => {
    expect(aws.id).toBe("aws");
    expect(aws.displayName).toBe("AWS");
    expect(aws.clusterServiceName).toBe("EKS");
  });
});

describe("aws.portalUrl", () => {
  const scope =
    "/planes/aws/aws/accounts/123456789012/regions/us-west-2/providers";

  it("links an AWS resource ID through the region-aware console mapping", () => {
    const id = `${scope}/AWS.RDS/DBInstance/db`;
    expect(aws.portalUrl(id, ctx())).toBe(awsConsoleUrl(id));
    expect(aws.portalUrl(id, ctx())).toBe(
      "https://us-west-2.console.aws.amazon.com/rds/home?region=us-west-2#databases:"
    );
  });

  it.each([
    ["a bare resource type", "AWS.RDS/DBInstance"],
    ["a Terraform type", "aws_db_instance"],
    ["a Kubernetes type", "apps/Deployment"],
    ["an empty value", ""],
    ["an unrecognized AWS type", `${scope}/AWS.IAM/Role/r`]
  ])("returns no link for %s", (_label, value) => {
    expect(aws.portalUrl(value, ctx())).toBe("");
  });
});
