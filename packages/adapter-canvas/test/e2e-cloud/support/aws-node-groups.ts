import { eksAuthenticationMode } from "@radius-project/core";
import {
  AWS_MAIN_NODE_GROUPS,
  awsDetail,
  readAws,
  succeeded,
  waitFor,
  type AwsCleanupCluster
} from "./aws-cloud-cleanup.js";
import {
  asRecord,
  clusterLabel,
  list,
  text,
  type AwsJourneyPorts
} from "./aws-journey-support.js";
import { describeError } from "./cloud-command-port.js";
import {
  AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS,
  AWS_NODE_POLL_MS,
  AWS_NODE_READY_TIMEOUT_MS
} from "./aws-timeout-budget.js";

// The main cluster's node groups stay at zero nodes between runs. A run
// updates each to the control plane's Kubernetes version while it still has
// no nodes, scales it up, and waits for its nodes to be Ready. Its teardown
// scales them back to zero, and so does a failed scale-up. EKS upgrades the
// control plane on its own under the STANDARD upgrade policy; managed node
// groups don't follow, which is why the update happens here.

/** The node label that names a node's pool, set on each node group. */
export const NODE_POOL_LABEL = "radius-e2e/pool";

export type AwsMainNodeGroup = (typeof AWS_MAIN_NODE_GROUPS)[number];

export interface AwsNodeKubernetes {
  // `kubectl get nodes --selector <selector> -o json`.
  listNodes(cluster: AwsCleanupCluster, selector: string): Promise<unknown>;
}

export interface AwsNodeGroupPorts extends AwsJourneyPorts {
  readonly kubernetes: AwsNodeKubernetes;
  log(line: string): void;
}

export interface AwsClusterState {
  readonly status: string;
  readonly version: string;
  readonly authenticationMode: string;
  readonly endpointPublicAccess: boolean;
  readonly clusterSecurityGroupId: string;
  readonly supportType: string;
}

export interface AwsNodeGroup {
  readonly name: string;
  readonly status: string;
  readonly version: string;
  readonly releaseVersion: string;
  readonly minSize: number;
  readonly maxSize: number;
  readonly desiredSize: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly taints: ReadonlyArray<{
    key: string;
    value: string;
    effect: string;
  }>;
  readonly launchTemplate: { id: string; version: string } | null;
}

export interface AwsRunVersions {
  readonly clusters: Array<{ name: string; region: string; version: string }>;
  readonly nodeGroups: Array<{
    cluster: string;
    name: string;
    version: string;
    releaseVersion: string;
  }>;
  readonly radius: string;
}

export async function readAwsCluster(
  ports: Pick<AwsJourneyPorts, "runAws">,
  cluster: AwsCleanupCluster
): Promise<AwsClusterState> {
  const described = await readAws(ports, [
    "eks",
    "describe-cluster",
    "--region",
    cluster.region,
    "--name",
    cluster.name
  ]);
  const record = asRecord(asRecord(described)?.cluster);
  const vpc = asRecord(record?.resourcesVpcConfig);
  return {
    status: text(record?.status),
    version: text(record?.version),
    authenticationMode: eksAuthenticationMode(described),
    endpointPublicAccess: vpc?.endpointPublicAccess === true,
    clusterSecurityGroupId: text(vpc?.clusterSecurityGroupId),
    supportType: text(asRecord(record?.upgradePolicy)?.supportType)
  };
}

export async function readAwsNodeGroup(
  ports: Pick<AwsJourneyPorts, "runAws">,
  cluster: AwsCleanupCluster,
  name: string
): Promise<AwsNodeGroup> {
  const group = asRecord(
    asRecord(
      await readAws(ports, [
        "eks",
        "describe-nodegroup",
        "--region",
        cluster.region,
        "--cluster-name",
        cluster.name,
        "--nodegroup-name",
        name
      ])
    )?.nodegroup
  );
  const scaling = asRecord(group?.scalingConfig);
  const size = (field: string) => {
    const value = scaling?.[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new Error(`EKS reported no ${field} for node group ${name}.`);
    return value;
  };
  const required = (field: string) => {
    const value = text(group?.[field]);
    if (!value)
      throw new Error(`EKS reported no ${field} for node group ${name}.`);
    return value;
  };
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(group?.labels) ?? {}))
    labels[key] = text(value);
  const template = asRecord(group?.launchTemplate);
  return {
    name,
    status: required("status"),
    version: required("version"),
    releaseVersion: text(group?.releaseVersion),
    minSize: size("minSize"),
    maxSize: size("maxSize"),
    desiredSize: size("desiredSize"),
    labels,
    taints: list(group?.taints).map((entry) => {
      const taint = asRecord(entry);
      return {
        key: text(taint?.key),
        value: text(taint?.value),
        effect: text(taint?.effect)
      };
    }),
    launchTemplate:
      template ?
        { id: text(template.id), version: text(template.version) }
      : null
  };
}

/** How many nodes in a `kubectl get nodes -o json` list are Ready. */
export function countReadyNodes(payload: unknown): number {
  const items = asRecord(payload)?.items;
  if (!Array.isArray(items))
    throw new Error("kubectl get nodes did not return an items list.");
  return items.filter((item) =>
    list(asRecord(asRecord(item)?.status)?.conditions).some((entry) => {
      const condition = asRecord(entry);
      return condition?.type === "Ready" && condition.status === "True";
    })
  ).length;
}

async function waitForActive(
  ports: AwsJourneyPorts,
  cluster: AwsCleanupCluster,
  name: string
): Promise<AwsNodeGroup> {
  let group = await readAwsNodeGroup(ports, cluster, name);
  const active = await waitFor(
    ports,
    AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS,
    AWS_NODE_POLL_MS,
    async () => {
      if (group.status === "ACTIVE") return true;
      group = await readAwsNodeGroup(ports, cluster, name);
      return group.status === "ACTIVE";
    }
  );
  if (!active)
    throw new Error(
      `Node group ${name} on cluster ${clusterLabel(cluster)} stayed ${group.status} for ${AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS / 60_000} minutes.`
    );
  return group;
}

async function updateToControlPlane(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster,
  name: AwsMainNodeGroup,
  version: string
): Promise<void> {
  const where = `on cluster ${clusterLabel(cluster)}`;
  const group = await waitForActive(ports, cluster, name);
  if (group.version === version) return;
  if (group.desiredSize > 0)
    throw new Error(
      `Node group ${name} ${where} runs Kubernetes ${group.version} on ${group.desiredSize} nodes, and the control plane is at ${version}. Updating it now would replace running nodes, so the run stopped before changing it. Run the Cloud E2E cleanup workflow, which scales it to zero, then retry.`
    );
  ports.log(
    `Updating node group ${name} ${where} from Kubernetes ${group.version} to ${version} while it has no nodes.`
  );
  const result = await ports.runAws([
    "eks",
    "update-nodegroup-version",
    "--region",
    cluster.region,
    "--cluster-name",
    cluster.name,
    "--nodegroup-name",
    name,
    "--kubernetes-version",
    version
  ]);
  if (!succeeded(result))
    throw new Error(
      `Updating node group ${name} ${where} to Kubernetes ${version} failed: ${awsDetail(result)}`
    );
  const updated = await waitForActive(ports, cluster, name);
  if (updated.version !== version)
    throw new Error(
      `Node group ${name} ${where} is at Kubernetes ${updated.version} after its update to ${version}.`
    );
}

async function scaleTo(
  ports: AwsJourneyPorts,
  cluster: AwsCleanupCluster,
  group: AwsNodeGroup,
  desired: number
): Promise<void> {
  const result = await ports.runAws([
    "eks",
    "update-nodegroup-config",
    "--region",
    cluster.region,
    "--cluster-name",
    cluster.name,
    "--nodegroup-name",
    group.name,
    "--scaling-config",
    `minSize=0,maxSize=${Math.max(group.maxSize, desired, 1)},desiredSize=${desired}`
  ]);
  if (!succeeded(result))
    throw new Error(
      `Scaling node group ${group.name} on cluster ${clusterLabel(cluster)} to ${desired} failed: ${awsDetail(result)}`
    );
}

async function waitForReadyNodes(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster,
  name: AwsMainNodeGroup,
  desired: number
): Promise<void> {
  let ready = 0;
  const done = await waitFor(
    ports,
    AWS_NODE_READY_TIMEOUT_MS,
    AWS_NODE_POLL_MS,
    async () => {
      ready = countReadyNodes(
        await ports.kubernetes.listNodes(cluster, `${NODE_POOL_LABEL}=${name}`)
      );
      return ready >= desired;
    }
  );
  if (!done)
    throw new Error(
      `Nodes don't become ready: node group ${name} on cluster ${clusterLabel(cluster)} has ${ready} of ${desired} nodes Ready after ${AWS_NODE_READY_TIMEOUT_MS / 60_000} minutes.`
    );
}

/**
 * Scale the main cluster's node groups to zero. Tries every group, then
 * throws naming each one it couldn't scale down.
 */
export async function scaleAwsNodeGroupsToZero(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster
): Promise<void> {
  const failures: string[] = [];
  for (const name of AWS_MAIN_NODE_GROUPS) {
    try {
      const group = await readAwsNodeGroup(ports, cluster, name);
      if (group.desiredSize === 0 && group.minSize === 0) continue;
      await scaleTo(
        ports,
        cluster,
        await waitForActive(ports, cluster, name),
        0
      );
      ports.log(
        `Scaled node group ${name} on cluster ${clusterLabel(cluster)} to zero from ${group.desiredSize}.`
      );
    } catch (error) {
      failures.push(`${name}: ${describeError(error)}`);
    }
  }
  if (failures.length > 0)
    throw new Error(
      `Could not scale the node groups on cluster ${clusterLabel(cluster)} to zero (${failures.join("; ")}). They keep costing until they are. Run the Cloud E2E cleanup workflow, which scales them down.`
    );
}

/**
 * Update each node group to the control plane's version while it has no
 * nodes, scale it up, and wait for its nodes to be Ready. A failure after the
 * first scale-up scales every group back to zero before it is thrown.
 */
export async function startAwsNodeGroups(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster,
  sizes: Partial<Record<AwsMainNodeGroup, number>> = {}
): Promise<void> {
  const { version } = await readAwsCluster(ports, cluster);
  if (!version)
    throw new Error(
      `EKS reported no Kubernetes version for cluster ${clusterLabel(cluster)}.`
    );
  for (const name of AWS_MAIN_NODE_GROUPS)
    await updateToControlPlane(ports, cluster, name, version);

  const desired = new Map<AwsMainNodeGroup, number>();
  try {
    for (const name of AWS_MAIN_NODE_GROUPS) {
      const group = await waitForActive(ports, cluster, name);
      const size = sizes[name] ?? (name === "isolated" ? 1 : group.maxSize);
      desired.set(name, size);
      await scaleTo(ports, cluster, group, size);
    }
    for (const [name, size] of desired) {
      await waitForActive(ports, cluster, name);
      await waitForReadyNodes(ports, cluster, name, size);
    }
  } catch (error) {
    const failure = `${describeError(error)} This is an infrastructure failure, not a product one.`;
    try {
      await scaleAwsNodeGroupsToZero(ports, cluster);
    } catch (scaleDown) {
      throw new Error(
        `${failure} Scaling the node groups back to zero also failed: ${describeError(scaleDown)}`,
        { cause: scaleDown }
      );
    }
    throw new Error(`${failure} The node groups were scaled back to zero.`, {
      cause: error
    });
  }
}

/** Radius's build, as the run's environments install it. */
export function describeRadiusRelease(release: string | undefined): string {
  if (!release?.trim())
    return "edge, the AWS workflows' default, whose images follow Radius main";
  let parsed: unknown;
  try {
    parsed = JSON.parse(release);
  } catch {
    parsed = null;
  }
  const tag = text(asRecord(parsed)?.tag);
  const commit = text(asRecord(parsed)?.commit);
  if (!tag || !commit)
    throw new Error(
      "RADIUS_CLOUD_E2E_RELEASE must contain a release tag and commit."
    );
  return `${tag} at ${commit}`;
}

/** The versions a run used, for triage after an automatic upgrade. */
export async function readAwsRunVersions(
  ports: Pick<AwsJourneyPorts, "runAws">,
  // The main cluster first: it has the node groups.
  clusters: readonly [AwsCleanupCluster, AwsCleanupCluster],
  radiusRelease: string | undefined
): Promise<AwsRunVersions> {
  const radius = describeRadiusRelease(radiusRelease);
  const versions: AwsRunVersions = { clusters: [], nodeGroups: [], radius };
  for (const cluster of clusters)
    versions.clusters.push({
      name: cluster.name,
      region: cluster.region,
      version: (await readAwsCluster(ports, cluster)).version
    });
  const main = clusters[0];
  for (const name of AWS_MAIN_NODE_GROUPS) {
    const group = await readAwsNodeGroup(ports, main, name);
    versions.nodeGroups.push({
      cluster: main.name,
      name,
      version: group.version,
      releaseVersion: group.releaseVersion
    });
  }
  return versions;
}
