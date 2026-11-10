import {
  classifyAwsCliError,
  eksAcceptsAccessEntries,
  eksAuthenticationMode,
  isAwsRegion,
  isEksClusterName,
  namesGitHubProvider,
  parseAwsRoleArn,
  parseAwsSubnets,
  parseAwsVpcs,
  parseAwsZoneTypes,
  parsePolicyDocument,
  radiusRoleRepositoryId,
  trustedGitHubSubjects,
  type AwsCliErrorKind,
  type AwsClusterUnusableReason,
  type PolicyDocument
} from "@radius-project/core";
import { remediationView } from "@radius-project/core/remediations";
import { isValidRepoSlug } from "../../azure-oidc.js";
import type { AwsRepositoryIdLookup } from "./aws-deploy-identity.js";
import type {
  AwsDiscoveryList,
  AwsDiscoveryResult,
  DiscoveryDependencies
} from "./discovery.js";
import { mapWithLimit } from "./map-with-limit.js";

// AWS half of environment-wizard discovery. Every query is scoped to the
// credential profile's region; the account is whatever the signed-in CLI
// session holds, which profile verification already matched.

const AWS_CLI_TIMEOUT_MS = 20000;
const KUBECTL_TIMEOUT_MS = 10000;
const USABLE_CLUSTER_STATUSES = new Set(["ACTIVE", "UPDATING"]);
export const AWS_DEFAULT_NAMESPACES = ["default"];

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
  /** The describe-cluster status, or empty when the cluster was not described. */
  status: string;
  usable: boolean;
  /** Present only when `usable` is false. */
  unusableReason?: AwsClusterUnusableReason;
  /** Present only for a cluster whose describe-cluster call failed. */
  describeErrorKind?: AwsCliErrorKind;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordError(
  result: AwsDiscoveryResult,
  list: AwsDiscoveryList,
  error: unknown
): void {
  const message = errorMessage(error);
  result.errors = result.errors || {};
  result.errors[list] = message.slice(0, 800);
  result.errorKinds = result.errorKinds || {};
  result.errorKinds[list] = classifyAwsCliError(message);
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

function notDescribed(
  name: string,
  describeErrorKind: AwsCliErrorKind
): AwsClusterItem {
  return {
    id: name,
    name,
    vpcId: "",
    authenticationMode: "",
    status: "",
    usable: false,
    unusableReason: "not-described",
    describeErrorKind
  };
}

export function parseAwsCluster(name: string, output: unknown): AwsClusterItem {
  const cluster =
    isRecord(output) && isRecord(output.cluster) ? output.cluster : {};
  const status = typeof cluster.status === "string" ? cluster.status : "";
  // An answer without a status is not a description setup can rely on.
  if (status === "") return notDescribed(name, "other");
  const vpcConfig =
    isRecord(cluster.resourcesVpcConfig) ? cluster.resourcesVpcConfig : {};
  const authenticationMode = eksAuthenticationMode(output);
  const unusableReason: AwsClusterUnusableReason | undefined =
    !USABLE_CLUSTER_STATUSES.has(status) ? "status"
    : !eksAcceptsAccessEntries(authenticationMode) ? "config-map"
    : undefined;
  return {
    id: name,
    name,
    vpcId: typeof vpcConfig.vpcId === "string" ? vpcConfig.vpcId : "",
    authenticationMode,
    status,
    usable: unusableReason === undefined,
    ...(unusableReason ? { unusableReason } : {})
  };
}

async function describeCluster(
  name: string,
  region: string,
  dependencies: DiscoveryDependencies
): Promise<AwsClusterItem> {
  try {
    return parseAwsCluster(
      name,
      await awsJson(
        dependencies,
        ["eks", "describe-cluster", "--name", name],
        region
      )
    );
  } catch (e) {
    return notDescribed(name, classifyAwsCliError(errorMessage(e)));
  }
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

// The four EC2 reads run together, and each one's failure is recorded on its
// own list: a denied route-table, VPC, or zone read leaves the subnets listed.
async function discoverNetwork(
  result: AwsDiscoveryResult,
  vpcIds: readonly string[],
  region: string,
  dependencies: DiscoveryDependencies
): Promise<void> {
  const vpcFilter = `Name=vpc-id,Values=${vpcIds.join(",")}`;
  const [vpcs, subnets, routeTables, zones] = await Promise.allSettled([
    awsJson(
      dependencies,
      ["ec2", "describe-vpcs", "--vpc-ids", ...vpcIds],
      region
    ),
    awsJson(
      dependencies,
      ["ec2", "describe-subnets", "--filters", vpcFilter],
      region
    ),
    awsJson(
      dependencies,
      ["ec2", "describe-route-tables", "--filters", vpcFilter],
      region
    ),
    awsJson(dependencies, ["ec2", "describe-availability-zones"], region)
  ]);
  if (vpcs.status === "fulfilled") result.vpcs = parseAwsVpcs(vpcs.value);
  else recordError(result, "vpcs", vpcs.reason);
  if (routeTables.status === "rejected") {
    recordError(result, "routeTables", routeTables.reason);
  }
  if (zones.status === "rejected") recordError(result, "zones", zones.reason);
  if (subnets.status === "rejected") {
    recordError(result, "subnets", subnets.reason);
    return;
  }
  result.subnets = parseAwsSubnets(subnets.value, {
    routeTables:
      routeTables.status === "fulfilled" ? routeTables.value : undefined,
    zones:
      zones.status === "fulfilled" ? parseAwsZoneTypes(zones.value) : undefined,
    region
  });
}

function needsSignIn(result: AwsDiscoveryResult): boolean {
  return (
    Object.values(result.errorKinds || {}).includes("credentials") ||
    result.clusters.some(
      (cluster) => cluster.describeErrorKind === "credentials"
    )
  );
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
  if (requestedCluster && !isEksClusterName(requestedCluster)) {
    return { ...result, error: "Invalid EKS cluster name." };
  }
  result.namespaces = [...AWS_DEFAULT_NAMESPACES];
  await discoverClustersAndNetwork(
    result,
    region,
    requestedCluster,
    dependencies
  );
  if (needsSignIn(result)) {
    result.remediation = remediationView("aws-cli-login", {
      nextStep: "refresh-discovery"
    });
  }
  return result;
}

async function discoverClustersAndNetwork(
  result: AwsDiscoveryResult,
  region: string,
  requestedCluster: string,
  dependencies: DiscoveryDependencies
): Promise<void> {
  let names: string[];
  try {
    const listed = await awsJson(
      dependencies,
      ["eks", "list-clusters", "--query", "clusters"],
      region
    );
    names =
      Array.isArray(listed) ?
        listed.filter((name): name is string => typeof name === "string")
      : [];
  } catch (e) {
    // Every later call would fail the same way, so none runs.
    recordError(result, "clusters", e);
    return;
  }
  result.clusters = await Promise.all(
    names.map((name) => describeCluster(name, region, dependencies))
  );
  const usable = result.clusters.filter((cluster) => cluster.usable);
  const vpcIds = [
    ...new Set(usable.map((cluster) => cluster.vpcId).filter(Boolean))
  ];
  if (vpcIds.length > 0) {
    await discoverNetwork(result, vpcIds, region, dependencies);
  }

  const namespaceCluster =
    requestedCluster ?
      usable.some((cluster) => cluster.name === requestedCluster) ?
        requestedCluster
      : ""
    : usable.length === 1 ? usable[0].name
    : "";
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

const GITHUB_API_TIMEOUT_MS = 15000;

// GitHub's ID for the repository, which the role's ownership tag holds. A
// name can't be compared, because another repository can take it. The read
// uses the default `gh` account, which may not see the repository; setup
// checks the ID again with the selected account.
async function readRepositoryId(
  repo: string,
  dependencies: AwsRoleListDependencies
): Promise<AwsRepositoryIdLookup> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, reason: `"${repo}" is not an owner/name repository` };
  }
  let out: string;
  try {
    out = await dependencies.runCli(
      "gh",
      ["api", `/repos/${repo.trim()}`, "--jq", ".id"],
      { timeout: GITHUB_API_TIMEOUT_MS }
    );
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const id = /^[1-9]\d*$/.test(out.trim()) ? Number(out.trim()) : NaN;
  return Number.isSafeInteger(id) ?
      { ok: true, repoId: id }
    : { ok: false, reason: "GitHub returned no repository ID" };
}

// GitHub's ID for the repository Radius created the role for, or null when
// Radius did not tag it with one.
async function readRoleOwner(
  roleName: string,
  dependencies: AwsRoleListDependencies
): Promise<number | null> {
  const out = await dependencies.runCli(
    "aws",
    ["iam", "get-role", "--role-name", roleName, "--output", "json"],
    { timeout: AWS_CLI_TIMEOUT_MS }
  );
  const parsed: unknown = JSON.parse(out);
  if (!isRecord(parsed) || !isRecord(parsed.Role)) {
    throw new Error(`get-role returned no role for ${roleName}.`);
  }
  return radiusRoleRepositoryId(parsed.Role);
}

export interface AwsRoleList {
  readonly roles: AwsRoleCandidate[];
  // Why roles Radius created were left out without knowing whose they are.
  // Absent when every role could be checked.
  readonly hiddenReason?: string;
}

const NOT_READ: AwsRepositoryIdLookup = { ok: false, reason: "not read" };

/**
 * Roles the signed-in identity can see, for the `use an existing role…`
 * picker. Service-linked roles, which GitHub cannot assume, roles in another
 * account, and roles that Radius created for another repository are left out.
 * Roles that already trust GitHub come first.
 *
 * Only roles whose trust names the account's GitHub provider get their tags
 * read, because Radius creates every role it owns with that trust. If one of
 * those reads fails, the whole listing fails, because the picker cannot tell
 * whether another repository owns that role. A role Radius created belongs to
 * the repository whose GitHub ID it is tagged with, so this repository's ID is
 * read once when any such role turns up. If that read fails, those roles are
 * left out and `hiddenReason` says why.
 */
export async function listAwsRoles(
  data: { accountId?: string; repo?: string },
  dependencies: AwsRoleListDependencies
): Promise<AwsRoleList> {
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
  const owners = await mapWithLimit(
    listed,
    ROLE_TAG_READ_CONCURRENCY,
    async ({ candidate, readTags }) =>
      readTags ? readRoleOwner(candidate.name, dependencies) : null
  );
  const tagged = owners.filter((owner) => owner !== null).length;
  // Read only when a role has Radius's ownership tag.
  const repository =
    tagged > 0 ? await readRepositoryId(repo, dependencies) : NOT_READ;
  const candidates = listed
    .filter((_, index) => {
      const owner = owners[index];
      return owner === null || (repository.ok && owner === repository.repoId);
    })
    .map(({ candidate }) => candidate);
  const trustsGitHub = (candidate: AwsRoleCandidate): number =>
    candidate.trustedSubjects.length > 0 ? 0 : 1;
  const sorted = candidates.sort(
    (a, b) => trustsGitHub(a) - trustsGitHub(b) || a.name.localeCompare(b.name)
  );
  if (repository.ok || tagged === 0) return { roles: sorted };
  return {
    roles: sorted,
    hiddenReason: `Radius left out ${tagged} role${tagged === 1 ? "" : "s"} it created, because GitHub didn't return the ID of ${repo || "this repository"} (${repository.reason}), so it can't tell which repository ${tagged === 1 ? "it belongs" : "they belong"} to. Check that the default GitHub CLI account can read the repository and try again, or type the role name.`
  };
}
