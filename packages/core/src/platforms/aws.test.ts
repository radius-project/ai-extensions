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
    expect(aws.recipePlatform).toBe("aws");
    expect(aws.clusterServiceName).toBe("EKS");
  });

  it("advertises OIDC and portal-link support", () => {
    expect(aws.supports).toEqual({ oidc: true, portalUrl: true });
  });
});

describe("aws.generateOidc", () => {
  it("reports the account and region in the verification output", () => {
    const result = aws.generateOidc({
      accountId: "123456789012",
      region: "eu-west-1"
    });

    expect(result.message).toBe("AWS authentication validated");
    expect(result.output).toContain("Account ID: 123456789012");
    expect(result.output).toContain("Region: eu-west-1");
  });

  it("emits gh variable commands for the non-secret identifiers", () => {
    const result = aws.generateOidc({
      accountId: "123456789012",
      region: "eu-west-1"
    });

    expect(result.output).toContain(
      'gh variable set AWS_ACCOUNT_ID --body "123456789012"'
    );
    expect(result.output).toContain(
      'gh variable set AWS_REGION --body "eu-west-1"'
    );
    // These identifiers are deliberately variables, never secrets.
    expect(result.output).not.toContain("gh secret set");
  });

  it.each([
    ["an empty object", {}],
    ["blank values", { accountId: "", region: "" }],
    ["null values", { accountId: null, region: null }],
    ["undefined values", { accountId: undefined, region: undefined }]
  ])("substitutes empty strings for %s", (_label, data) => {
    const result = aws.generateOidc(data);

    expect(result.output).toContain("Account ID: \n");
    expect(result.output).toContain("Region: \n");
    expect(result.output).toContain('gh variable set AWS_ACCOUNT_ID --body ""');
    expect(result.output).toContain('gh variable set AWS_REGION --body ""');
  });
});

describe("aws.environmentSecrets", () => {
  it("returns both identifiers as GitHub variables, not secrets", () => {
    expect(
      aws.environmentSecrets({ accountId: "123456789012", region: "eu-west-1" })
    ).toEqual([
      { kind: "variable", name: "AWS_ACCOUNT_ID", value: "123456789012" },
      { kind: "variable", name: "AWS_REGION", value: "eu-west-1" }
    ]);
  });

  it("passes missing values through untouched for the caller to validate", () => {
    const specs = aws.environmentSecrets({});

    expect(specs.map((s) => s.name)).toEqual(["AWS_ACCOUNT_ID", "AWS_REGION"]);
    expect(specs.every((s) => s.value === undefined)).toBe(true);
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
