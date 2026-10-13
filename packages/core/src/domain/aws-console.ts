import { parseResourceId } from "./resource-id.js";

/** The display name of a cloud console, derived from a console URL. */
export type CloudConsoleName = "AWS console" | "Azure portal" | "";

const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

// Each recognized AWS resource type (keyed by its lowercased UCP type) maps to
// the console path of that service's list page. The region is appended as a
// query parameter, so the hash, when present, follows it.
const AWS_CONSOLE_PATHS: Readonly<
  Record<string, { readonly path: string; readonly hash: string }>
> = {
  "aws.rds/dbinstance": { path: "/rds/home", hash: "#databases:" },
  "aws.rds/dbcluster": { path: "/rds/home", hash: "#databases:" },
  "aws.s3/bucket": { path: "/s3/buckets", hash: "" },
  "aws.elasticache/cachecluster": {
    path: "/elasticache/home",
    hash: "#/redis"
  },
  "aws.elasticache/replicationgroup": {
    path: "/elasticache/home",
    hash: "#/redis"
  },
  "aws.elasticache/serverlesscache": {
    path: "/elasticache/home",
    hash: "#/redis"
  },
  "aws.memorydb/cluster": { path: "/memorydb/home", hash: "#/clusters" },
  "aws.docdb/dbcluster": { path: "/docdb/home", hash: "#clusters" },
  "aws.docdb/dbinstance": { path: "/docdb/home", hash: "#clusters" },
  "aws.msk/cluster": { path: "/msk/home", hash: "#/clusters" },
  "aws.msk/serverlesscluster": { path: "/msk/home", hash: "#/clusters" },
  "aws.opensearchservice/domain": {
    path: "/aos/home",
    hash: "#opensearch/domains"
  },
  "aws.amazonmq/broker": { path: "/amazon-mq/home", hash: "#/brokers" },
  "aws.bedrock/agent": { path: "/bedrock/home", hash: "#/agents" },
  "aws.bedrock/knowledgebase": {
    path: "/bedrock/home",
    hash: "#/knowledge-bases"
  },
  "aws.bedrock/guardrail": { path: "/bedrock/home", hash: "#/guardrails" },
  "aws.ecr/repository": {
    path: "/ecr/private-registry/repositories",
    hash: ""
  },
  "aws.secretsmanager/secret": {
    path: "/secretsmanager/listsecrets",
    hash: ""
  },
  "aws.sqs/queue": { path: "/sqs/v3/home", hash: "#/queues" },
  "aws.sns/topic": { path: "/sns/v3/home", hash: "#/topics" },
  "aws.dynamodb/table": { path: "/dynamodbv2/home", hash: "#tables" },
  "aws.dynamodb/globaltable": { path: "/dynamodbv2/home", hash: "#tables" },
  "aws.eks/cluster": { path: "/eks/home", hash: "#/clusters" },
  "aws.ec2/securitygroup": { path: "/ec2/home", hash: "#SecurityGroups:" },
  "aws.lambda/function": { path: "/lambda/home", hash: "#/functions" }
};

/**
 * The AWS console list page for the service that owns the resource `id`, in the
 * region the ID names. Returns `""` for anything else, including an AWS type
 * the canvas does not recognize, so a caller never shows a fabricated link.
 */
export function awsConsoleUrl(id: string): string {
  const parsed = parseResourceId(id);
  if (parsed?.plane?.type.toLowerCase() !== "aws") return "";
  const region = parsed.scopes.find(
    (scope) => scope.type.toLowerCase() === "regions"
  )?.name;
  if (!region || !AWS_REGION.test(region)) return "";
  const target = AWS_CONSOLE_PATHS[parsed.type.toLowerCase()];
  if (!target) return "";
  // GovCloud regions are served from their own partition's console.
  const host =
    region.includes("-gov-") ?
      "console.amazonaws-us-gov.com"
    : `${region}.console.aws.amazon.com`;
  return `https://${host}${target.path}?region=${region}${target.hash}`;
}

const HTTPS_AUTHORITY = /^https:\/\/([^/?#]*)/i;

// The lowercased host of an https URL, or "" for anything else. Parsed by hand
// because core stays free of DOM and Node types, so it has no URL global. A
// console link never carries credentials, so an authority with `@` is refused.
function httpsHost(url: string): string {
  const authority = HTTPS_AUTHORITY.exec(url.trim())?.[1] ?? "";
  if (authority.includes("@")) return "";
  return authority.replace(/:\d*$/, "").toLowerCase();
}

/**
 * Name the console a URL opens, from its host. Deriving the name from the
 * destination keeps a link's label correct whichever producer supplied it.
 */
export function consoleNameForUrl(url: string): CloudConsoleName {
  const host = httpsHost(url);
  if (
    host === "console.aws.amazon.com" ||
    host.endsWith(".console.aws.amazon.com") ||
    host === "console.amazonaws-us-gov.com"
  ) {
    return "AWS console";
  }
  return host === "portal.azure.com" ? "Azure portal" : "";
}
