import { describe, expect, it } from "vitest";
import { awsConsoleUrl, consoleNameForUrl } from "./aws-console.js";

const account = "/planes/aws/aws/accounts/123456789012";
const scope = `${account}/regions/us-west-2/providers`;
const origin = "https://us-west-2.console.aws.amazon.com";

describe("AWS console URL", () => {
  it.each([
    ["AWS.RDS/DBInstance", "/rds/home?region=us-west-2#databases:"],
    ["AWS.RDS/DBCluster", "/rds/home?region=us-west-2#databases:"],
    ["AWS.S3/Bucket", "/s3/buckets?region=us-west-2"],
    [
      "AWS.ElastiCache/CacheCluster",
      "/elasticache/home?region=us-west-2#/redis"
    ],
    [
      "AWS.ElastiCache/ReplicationGroup",
      "/elasticache/home?region=us-west-2#/redis"
    ],
    [
      "AWS.ElastiCache/ServerlessCache",
      "/elasticache/home?region=us-west-2#/redis"
    ],
    ["AWS.MemoryDB/Cluster", "/memorydb/home?region=us-west-2#/clusters"],
    ["AWS.DocDB/DBCluster", "/docdb/home?region=us-west-2#clusters"],
    ["AWS.DocDB/DBInstance", "/docdb/home?region=us-west-2#clusters"],
    ["AWS.MSK/Cluster", "/msk/home?region=us-west-2#/clusters"],
    ["AWS.MSK/ServerlessCluster", "/msk/home?region=us-west-2#/clusters"],
    [
      "AWS.OpenSearchService/Domain",
      "/aos/home?region=us-west-2#opensearch/domains"
    ],
    ["AWS.AmazonMQ/Broker", "/amazon-mq/home?region=us-west-2#/brokers"],
    ["AWS.Bedrock/Agent", "/bedrock/home?region=us-west-2#/agents"],
    [
      "AWS.Bedrock/KnowledgeBase",
      "/bedrock/home?region=us-west-2#/knowledge-bases"
    ],
    ["AWS.Bedrock/Guardrail", "/bedrock/home?region=us-west-2#/guardrails"],
    [
      "AWS.ECR/Repository",
      "/ecr/private-registry/repositories?region=us-west-2"
    ],
    [
      "AWS.SecretsManager/Secret",
      "/secretsmanager/listsecrets?region=us-west-2"
    ],
    ["AWS.SQS/Queue", "/sqs/v3/home?region=us-west-2#/queues"],
    ["AWS.SNS/Topic", "/sns/v3/home?region=us-west-2#/topics"],
    ["AWS.DynamoDB/Table", "/dynamodbv2/home?region=us-west-2#tables"],
    ["AWS.DynamoDB/GlobalTable", "/dynamodbv2/home?region=us-west-2#tables"],
    ["AWS.EKS/Cluster", "/eks/home?region=us-west-2#/clusters"],
    ["AWS.EC2/SecurityGroup", "/ec2/home?region=us-west-2#SecurityGroups:"],
    ["AWS.Lambda/Function", "/lambda/home?region=us-west-2#/functions"]
  ])("links %s to its service list page", (type, path) => {
    expect(awsConsoleUrl(`${scope}/${type}/name`)).toBe(`${origin}${path}`);
  });

  it("matches the plane and type case-insensitively", () => {
    expect(
      awsConsoleUrl(
        `/planes/AWS/aws/accounts/1/regions/eu-central-1/providers/aws.rds/dbinstance/db`
      )
    ).toBe(
      "https://eu-central-1.console.aws.amazon.com/rds/home?region=eu-central-1#databases:"
    );
  });

  it("uses the GovCloud console for a GovCloud region", () => {
    expect(
      awsConsoleUrl(
        `${account}/regions/us-gov-west-1/providers/AWS.S3/Bucket/b`
      )
    ).toBe(
      "https://console.amazonaws-us-gov.com/s3/buckets?region=us-gov-west-1"
    );
  });

  it.each([
    ["an unrecognized AWS type", `${scope}/AWS.IAM/Role/r`],
    [
      "a nested type of a recognized service",
      `${scope}/AWS.S3/Bucket/b/Policy/p`
    ],
    [
      "an Azure Resource Manager ID",
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Cache/redis/c"
    ],
    [
      "a Radius plane",
      "/planes/radius/local/resourceGroups/rg/providers/AWS.S3/Bucket/b"
    ],
    ["an ID without a region", `${account}/providers/AWS.S3/Bucket/b`],
    [
      "an invalid region",
      `${account}/regions/US-WEST-2/providers/AWS.S3/Bucket/b`
    ],
    [
      "a region one character short",
      `${account}/regions/us-west-/providers/AWS.S3/Bucket/b`
    ],
    ["a malformed ID", "not/a/resource/id"],
    ["an empty ID", ""],
    [
      "a China region in another partition",
      `/planes/aws/aws/accounts/123456789012/regions/cn-north-1/providers/AWS.S3/Bucket/b`
    ],
    [
      "the other China region",
      `/planes/aws/aws/accounts/123456789012/regions/cn-northwest-1/providers/AWS.RDS/DBInstance/db`
    ]
  ])("carries no link for %s", (_case, id) => {
    expect(awsConsoleUrl(id)).toBe("");
  });
});

describe("console name for a URL", () => {
  it.each([
    [`${origin}/rds/home?region=us-west-2`, "AWS console"],
    ["https://console.aws.amazon.com/s3/buckets", "AWS console"],
    ["https://console.amazonaws-us-gov.com/s3/buckets", "AWS console"],
    ["https://portal.azure.com/#@/resource/x/overview", "Azure portal"],
    ["https://PORTAL.AZURE.COM/#x", "Azure portal"],
    ["https://evilconsole.aws.amazon.com.example/x", ""],
    ["https://console.aws.amazon.com.example/x", ""],
    ["http://us-west-2.console.aws.amazon.com/rds/home", ""],
    ["https://portal.test/live", ""],
    ["https://console.aws.amazon.com:443/s3/buckets", "AWS console"],
    [" https://portal.azure.com/#x ", "Azure portal"],
    ["https://user@console.aws.amazon.com/s3/buckets", ""],
    ["https://console.aws.amazon.com@example.com/x", ""],
    ["https:///console.aws.amazon.com", ""],
    ["https://outside.test\\.console.aws.amazon.com/rds/home", ""],
    ["https://outside.test%2F.console.aws.amazon.com/rds/home", ""],
    ["https://outside.test\t.console.aws.amazon.com/rds/home", ""],
    ["not a url", ""],
    ["", ""]
  ])("names %s as %j", (url, name) => {
    expect(consoleNameForUrl(url)).toBe(name);
  });
});
