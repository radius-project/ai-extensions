import {
  isAwsRegion,
  parseAwsSubnets,
  parseAwsVpcs,
  parsePolicyDocument,
  trustedGitHubSubjects
} from "@radius-project/core";
import type { DiscoveryDependencies, DiscoveryResult } from "./discovery.js";

// AWS half of environment-wizard discovery. Every query is scoped to the
// credential profile's region; the account is whatever the signed-in CLI
// session holds, which profile verification already matched.

const AWS_CLI_TIMEOUT_MS = 20000;
const KUBECTL_TIMEOUT_MS = 10000;
const EKS_CLUSTER_PATTERN = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
export const AWS_DEFAULT_NAMESPACES = [
  "default",
  "kube-system",
  "radius-system"
];

export interface AwsDiscoveryRequest {
  accountId?: string;
  region?: string;
  cluster?: string;
}

export interface AwsClusterItem {
  id: string;
  name: string;
  vpcId: string;
  authenticationMode: string;
  /** False for clusters whose auth mode cannot take an access entry. */
  usable: boolean;
}

export interface AwsSubnetItem {
  id: string;
  name: string;
  vpcId: string;
  availabilityZone: string;
  public: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordError(
  result: DiscoveryResult,
  facet: string,
  error: unknown
): void {
  result.errors = result.errors || {};
  result.errors[facet] = errorMessage(error).slice(0, 800);
}

async function awsJson(
  dependencies: DiscoveryDependencies,
  args: string[],
  region: string
): Promise<unknown> {
  const out = await dependencies.runCli(
    "aws",
    [...args, "--region", region, "--output", "json"],
    { timeout: AWS_CLI_TIMEOUT_MS }
  );
  return JSON.parse(out || "null");
}

export function parseAwsCluster(name: string, output: unknown): AwsClusterItem {
  const cluster =
    isRecord(output) && isRecord(output.cluster) ? output.cluster : {};
  const vpcConfig =
    isRecord(cluster.resourcesVpcConfig) ? cluster.resourcesVpcConfig : {};
  const accessConfig =
    isRecord(cluster.accessConfig) ? cluster.accessConfig : {};
  const authenticationMode =
    typeof accessConfig.authenticationMode === "string" ?
      accessConfig.authenticationMode
    : "CONFIG_MAP";
  return {
    id: name,
    name,
    vpcId: typeof vpcConfig.vpcId === "string" ? vpcConfig.vpcId : "",
    authenticationMode,
    usable: authenticationMode !== "CONFIG_MAP"
  };
}

async function discoverNamespaces(
  cluster: string,
  region: string,
  dependencies: DiscoveryDependencies
): Promise<string[]> {
  const kubeconfig = dependencies.createTemporaryKubeconfig();
  try {
    await dependencies.runCli(
      "aws",
      [
        "eks",
        "update-kubeconfig",
        "--name",
        cluster,
        "--region",
        region,
        "--kubeconfig",
        kubeconfig.path
      ],
      { timeout: AWS_CLI_TIMEOUT_MS }
    );
    const names = await dependencies.runCli(
      "kubectl",
      [
        "--kubeconfig",
        kubeconfig.path,
        "get",
        "namespaces",
        "-o",
        "jsonpath={.items[*].metadata.name}"
      ],
      { timeout: KUBECTL_TIMEOUT_MS }
    );
    return names.replace(/"/g, "").split(" ").filter(Boolean);
  } finally {
    kubeconfig.remove();
  }
}

export async function discoverAwsResources(
  data: AwsDiscoveryRequest,
  dependencies: DiscoveryDependencies
): Promise<DiscoveryResult | (DiscoveryResult & { error: string })> {
  const result: DiscoveryResult = {
    clusters: [],
    resourceGroups: [],
    namespaces: [],
    vpcs: [],
    subnets: []
  };
  const region = typeof data.region === "string" ? data.region.trim() : "";
  if (!isAwsRegion(region)) {
    return {
      ...result,
      error: `Invalid AWS region "${region}". Select a credential profile with a region such as us-west-2.`
    };
  }
  const requestedCluster =
    typeof data.cluster === "string" ? data.cluster.trim() : "";
  if (requestedCluster && !EKS_CLUSTER_PATTERN.test(requestedCluster)) {
    return { ...result, error: "Invalid EKS cluster name." };
  }

  const clusters: AwsClusterItem[] = [];
  try {
    const listed = await awsJson(
      dependencies,
      ["eks", "list-clusters", "--query", "clusters"],
      region
    );
    const names =
      Array.isArray(listed) ?
        listed.filter((name): name is string => typeof name === "string")
      : [];
    const described = await Promise.all(
      names.map(async (name) => {
        try {
          return parseAwsCluster(
            name,
            await awsJson(
              dependencies,
              ["eks", "describe-cluster", "--name", name],
              region
            )
          );
        } catch {
          // Listed but not describable: still offer it, and let setup's own
          // cluster check report the reason.
          return {
            id: name,
            name,
            vpcId: "",
            authenticationMode: "",
            usable: true
          };
        }
      })
    );
    clusters.push(...described);
  } catch (e) {
    recordError(result, "clusters", e);
  }
  result.clusters = clusters;

  try {
    result.vpcs = parseAwsVpcs(
      await awsJson(dependencies, ["ec2", "describe-vpcs"], region)
    );
  } catch (e) {
    recordError(result, "vpcs", e);
  }

  try {
    const [subnets, routeTables] = await Promise.all([
      awsJson(dependencies, ["ec2", "describe-subnets"], region),
      awsJson(dependencies, ["ec2", "describe-route-tables"], region)
    ]);
    result.subnets = parseAwsSubnets(subnets, routeTables);
  } catch (e) {
    recordError(result, "subnets", e);
  }

  const namespaceCluster =
    requestedCluster || (clusters.length === 1 ? clusters[0].name : "");
  result.namespaces = [...AWS_DEFAULT_NAMESPACES];
  if (namespaceCluster) {
    try {
      const names = await discoverNamespaces(
        namespaceCluster,
        region,
        dependencies
      );
      if (names.length > 0) result.namespaces = names;
    } catch (e) {
      recordError(result, "namespaces", e);
    }
  }
  return result;
}

export interface AwsRoleCandidate {
  readonly arn: string;
  readonly name: string;
  /** GitHub subjects the role already trusts, such as `repo:o/r:environment:dev`. */
  readonly trustedSubjects: readonly string[];
}

/**
 * Roles the signed-in identity can see, for the `use an existing role…`
 * picker. Service-linked roles are left out because they cannot be assumed
 * from GitHub.
 */
export async function listAwsRoles(
  data: { accountId?: string },
  dependencies: Pick<DiscoveryDependencies, "runCli">
): Promise<AwsRoleCandidate[]> {
  const accountId = typeof data.accountId === "string" ? data.accountId : "";
  const out = await dependencies.runCli(
    "aws",
    ["iam", "list-roles", "--output", "json"],
    { timeout: AWS_CLI_TIMEOUT_MS }
  );
  const parsed: unknown = JSON.parse(out || "{}");
  const roles =
    isRecord(parsed) && Array.isArray(parsed.Roles) ? parsed.Roles : [];
  const candidates: AwsRoleCandidate[] = [];
  for (const role of roles) {
    if (!isRecord(role)) continue;
    const arn = typeof role.Arn === "string" ? role.Arn : "";
    const name = typeof role.RoleName === "string" ? role.RoleName : "";
    const path = typeof role.Path === "string" ? role.Path : "/";
    if (!arn || !name || path.startsWith("/aws-service-role/")) continue;
    let trustedSubjects: string[];
    try {
      trustedSubjects = trustedGitHubSubjects(
        parsePolicyDocument(role.AssumeRolePolicyDocument),
        accountId
      );
    } catch {
      trustedSubjects = [];
    }
    candidates.push({ arn, name, trustedSubjects });
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}
