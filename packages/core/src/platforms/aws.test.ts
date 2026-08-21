import { describe, it, expect } from "vitest";
import { aws } from "./aws.js";
import type { PortalContext } from "./types.js";

function ctx(overrides: Partial<PortalContext> = {}): PortalContext {
  return {
    subscriptionId: "",
    resourceGroup: "",
    region: "us-west-2",
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
  const region = "us-west-2";
  const base = `https://${region}.console.aws.amazon.com`;

  it.each([
    ["aws_db_instance", `${base}/rds/home?region=${region}#databases:`],
    ["RDS", `${base}/rds/home?region=${region}#databases:`],
    [
      "aws_secretsmanager_secret",
      `${base}/secretsmanager/home?region=${region}#!/listSecrets`
    ],
    [
      "Secrets Manager",
      `${base}/secretsmanager/home?region=${region}#!/listSecrets`
    ],
    ["aws_ecr_repository", `${base}/ecr/repositories?region=${region}`],
    ["ECR", `${base}/ecr/repositories?region=${region}`],
    ["aws_lb", `${base}/ec2/home?region=${region}#LoadBalancers:`],
    ["Load Balancer", `${base}/ec2/home?region=${region}#LoadBalancers:`],
    ["aws_ebs_volume", `${base}/ec2/home?region=${region}#Volumes:`],
    ["EBS", `${base}/ec2/home?region=${region}#Volumes:`],
    ["aws_security_group", `${base}/ec2/home?region=${region}#SecurityGroups:`],
    ["Security Group", `${base}/ec2/home?region=${region}#SecurityGroups:`],
    [
      "aws_db_subnet_group",
      `${base}/rds/home?region=${region}#db-subnet-groups-list:`
    ],
    [
      "Subnet Group",
      `${base}/rds/home?region=${region}#db-subnet-groups-list:`
    ],
    [
      "aws_elasticache_cluster",
      `${base}/memorydb/home?region=${region}#/clusters`
    ],
    ["MemoryDB", `${base}/memorydb/home?region=${region}#/clusters`],
    ["apps/Deployment", `${base}/eks/home?region=${region}#/clusters`],
    ["core/Service", `${base}/eks/home?region=${region}#/clusters`],
    ["networking/Ingress", `${base}/eks/home?region=${region}#/clusters`],
    [
      "core/PersistentVolumeClaim",
      `${base}/eks/home?region=${region}#/clusters`
    ]
  ])("deep links %s to its console page", (resourceType, expected) => {
    expect(aws.portalUrl(resourceType, ctx())).toBe(expected);
  });

  it("builds the console host from the supplied region", () => {
    expect(aws.portalUrl("RDS", ctx({ region: "ap-southeast-1" }))).toBe(
      "https://ap-southeast-1.console.aws.amazon.com/rds/home?region=ap-southeast-1#databases:"
    );
  });

  it.each([
    ["an unrecognized resource type", "aws_kinesis_stream"],
    ["an empty resource type", ""],
    ["a Radius abstract type", "Radius.Data/redisCaches"]
  ])("returns an empty string for %s", (_label, resourceType) => {
    expect(aws.portalUrl(resourceType, ctx())).toBe("");
  });

  it("prefers the RDS instance link over the subnet-group link when both match", () => {
    // Matching is ordered, so a type containing both markers resolves to the
    // first rule rather than the later subnet-group one.
    expect(aws.portalUrl("aws_db_instance_subnet_group", ctx())).toBe(
      `${base}/rds/home?region=${region}#databases:`
    );
  });
});
