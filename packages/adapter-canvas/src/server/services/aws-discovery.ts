import {
  eksAcceptsAccessEntries,
  eksAuthenticationMode,
  isAwsRegion,
  namesGitHubProvider,
  parseAwsRoleArn,
  parseAwsSubnets,
  parseAwsVpcs,
  parsePolicyDocument,
  radiusRoleRepository,
  trustedGitHubSubjects,
  type PolicyDocument
} from "@radius-project/core";
import type { AwsDiscoveryResult, DiscoveryDependencies } from "./discovery.js";
import { mapWithLimit } from "./map-with-limit.js";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordError(
  result: AwsDiscoveryResult,
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
  const authenticationMode = eksAuthenticationMode(output);
  return {
    id: name,
    name,
    vpcId: typeof vpcConfig.vpcId === "string" ? vpcConfig.vpcId : "",
    authenticationMode,
    usable: eksAcceptsAccessEntries(authenticationMode)
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
): Promise<AwsDiscoveryResult | (AwsDiscoveryResult & { error: string })> {
  const result: AwsDiscoveryResult = {
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

export type AwsRoleListDependencies = Pick<DiscoveryDependencies, "runCli">;

// `list-roles` does not return tags, so the picker reads them one role at a
// time with `get-role`, the same call setup makes. Bound the reads so a large
// account does not run into IAM's request throttling.
const ROLE_TAG_READ_CONCURRENCY = 4;

// A role whose tags cannot be read stays in the list, because setup reads the
// picked role's tags again before any AWS write.
async function managedForAnotherRepository(
  roleName: string,
  repo: string,
  dependencies: AwsRoleListDependencies
): Promise<boolean> {
  try {
    const out = await dependencies.runCli(
      "aws",
      ["iam", "get-role", "--role-name", roleName, "--output", "json"],
      { timeout: AWS_CLI_TIMEOUT_MS }
    );
    const parsed: unknown = JSON.parse(out);
    const owner = radiusRoleRepository(isRecord(parsed) ? parsed.Role : null);
    return owner !== null && owner.toLowerCase() !== repo.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Roles the signed-in identity can see, for the `use an existing role…`
 * picker. Service-linked roles, which GitHub cannot assume, roles in another
 * account, and roles that Radius created for another repository are left out.
 * Roles that already trust GitHub come first.
 *
 * Only roles whose trust names the account's GitHub provider get their tags
 * read, because Radius creates every role it owns with that trust.
 */
export async function listAwsRoles(
  data: { accountId?: string; repo?: string },
  dependencies: AwsRoleListDependencies
): Promise<AwsRoleCandidate[]> {
  const accountId = typeof data.accountId === "string" ? data.accountId : "";
  const repo = typeof data.repo === "string" ? data.repo : "";
  const out = await dependencies.runCli(
    "aws",
    ["iam", "list-roles", "--output", "json"],
    { timeout: AWS_CLI_TIMEOUT_MS }
  );
  const parsed: unknown = JSON.parse(out || "{}");
  const roles =
    isRecord(parsed) && Array.isArray(parsed.Roles) ? parsed.Roles : [];
  const listed: Array<{
    readonly candidate: AwsRoleCandidate;
    readonly readTags: boolean;
  }> = [];
  for (const role of roles) {
    if (!isRecord(role)) continue;
    const arn = typeof role.Arn === "string" ? role.Arn : "";
    const name = typeof role.RoleName === "string" ? role.RoleName : "";
    const path = typeof role.Path === "string" ? role.Path : "/";
    if (!arn || !name || path.startsWith("/aws-service-role/")) continue;
    if (accountId !== "" && parseAwsRoleArn(arn)?.accountId !== accountId) {
      continue;
    }
    let policy: PolicyDocument | null;
    try {
      policy = parsePolicyDocument(role.AssumeRolePolicyDocument);
    } catch {
      policy = null;
    }
    listed.push({
      candidate: {
        arn,
        name,
        trustedSubjects: policy ? trustedGitHubSubjects(policy, accountId) : []
      },
      readTags: policy !== null && namesGitHubProvider(policy, accountId)
    });
  }
  const otherRepository = await mapWithLimit(
    listed,
    ROLE_TAG_READ_CONCURRENCY,
    async ({ candidate, readTags }) =>
      readTags &&
      (await managedForAnotherRepository(candidate.name, repo, dependencies))
  );
  const candidates = listed
    .filter((_, index) => !otherRepository[index])
    .map(({ candidate }) => candidate);
  const trustsGitHub = (candidate: AwsRoleCandidate): number =>
    candidate.trustedSubjects.length > 0 ? 0 : 1;
  return candidates.sort(
    (a, b) => trustsGitHub(a) - trustsGitHub(b) || a.name.localeCompare(b.name)
  );
}
