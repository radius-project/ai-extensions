import { eksAuthenticationMode } from "@radius-project/core";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import {
  AWS_MAIN_NODE_GROUPS,
  awsDetail,
  awsError,
  readAws,
  readAwsIfFound,
  runNodeGroupUpdate,
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
  AWS_NODE_GROUP_START_TIMEOUT_MS,
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
  name: AwsMainNodeGroup
): Promise<AwsNodeGroup & { readonly name: AwsMainNodeGroup }> {
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
  return { ...group, name };
}

// Start a node group update and return its ID. One that another update
// still holds is retried until that update ends.
async function startUpdate(
  ports: AwsJourneyPorts,
  name: AwsMainNodeGroup,
  args: string[],
  what: string,
  updates: AwsNodeGroupUpdates
): Promise<string> {
  // Recorded before it is sent: AWS may accept an update whose answer never
  // arrives, and a scale-down must not take that group at zero at its word.
  const before = updates.get(name);
  updates.set(name, UNKNOWN_UPDATE);
  const answers: AwsCommandResult[] = [];
  const counted: AwsJourneyPorts = {
    ...ports,
    runAws: async (call) => {
      const answer = await ports.runAws(call);
      answers.push(answer);
      return answer;
    }
  };
  // The record goes only when nothing can have started: no attempt was
  // sent, or AWS refused each one. A ResourceInUseException doesn't count,
  // since the update holding the group may be one whose answer was lost.
  // Keeping the record by mistake costs one scale to zero; dropping it by
  // mistake leaves nodes running.
  const unsent = () => {
    if (
      !answers.every(
        (answer) =>
          /An error occurred \(/.test(answer.stderr) &&
          !awsError(answer, "ResourceInUseException")
      )
    )
      return;
    if (before === undefined) updates.delete(name);
    else updates.set(name, before);
  };
  let result: AwsCommandResult;
  try {
    result = await runNodeGroupUpdate(counted, args);
  } catch (error) {
    // Stopped before the next attempt, as once the run stops.
    unsent();
    throw error;
  }
  if (!succeeded(result)) {
    unsent();
    throw new Error(`${what} failed: ${awsDetail(result)}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Reported below.
  }
  const id = text(asRecord(asRecord(parsed)?.update)?.id);
  if (!id)
    throw new Error(
      `${what} returned no update ID, so the run can't tell when it ends: ${result.stdout.trim() || "(no output)"}`
    );
  updates.set(name, id);
  return id;
}

/**
 * The update each node group last started in a run, until it ends. A describe
 * of a group during an update may still show it as it was, so a scale-down
 * waits for these before it takes a group at zero at its word.
 */
export type AwsNodeGroupUpdates = Map<AwsMainNodeGroup, string>;

// In AwsNodeGroupUpdates: an update was sent, but its ID never came back.
const UNKNOWN_UPDATE = "";

// Poll a node group update by its ID until it ends or `timeoutMs` passes. An
// update EKS doesn't list yet counts as not ended.
async function pollUpdate(
  ports: AwsJourneyPorts,
  cluster: AwsCleanupCluster,
  name: string,
  id: string,
  timeoutMs: number
): Promise<{ ended: boolean; update: Record<string, unknown> | null }> {
  // Set inside the poll, so TypeScript can't narrow it from here.
  let update = null as Record<string, unknown> | null;
  const ended = await waitFor(ports, timeoutMs, AWS_NODE_POLL_MS, async () => {
    const read = await readAwsIfFound(
      ports,
      [
        "eks",
        "describe-update",
        "--region",
        cluster.region,
        "--name",
        cluster.name,
        "--nodegroup-name",
        name,
        "--update-id",
        id
      ],
      "ResourceNotFoundException"
    );
    update = asRecord(asRecord(read)?.update);
    const status = text(update?.status);
    return status !== "" && status !== "InProgress";
  });
  return { ended, update };
}

/**
 * Wait for a node group update to end, by its ID: only DescribeUpdate says
 * when it is done. Once it ends it leaves `updates`. Throws unless it ended
 * Successful.
 */
async function waitForUpdate(
  ports: AwsJourneyPorts,
  cluster: AwsCleanupCluster,
  name: AwsMainNodeGroup,
  id: string,
  what: string,
  updates: AwsNodeGroupUpdates
): Promise<void> {
  const { ended, update } = await pollUpdate(
    ports,
    cluster,
    name,
    id,
    AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS
  );
  const status = text(update?.status) || "not listed";
  if (!ended)
    throw new Error(
      `${what} is ${status === "InProgress" ? "still in progress" : "still not listed by EKS"} after ${AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS / 60_000} minutes (update ${id}).`
    );
  updates.delete(name);
  if (status !== "Successful") {
    const reasons = list(update?.errors)
      .map((entry) => {
        const error = asRecord(entry);
        return `${text(error?.errorCode)}: ${text(error?.errorMessage)}`;
      })
      .join("; ");
    throw new Error(
      `${what} ended ${status} (update ${id}): ${(reasons || "EKS gave no reason").replace(/\.?$/, ".")}`
    );
  }
}

async function updateToControlPlane(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster,
  name: AwsMainNodeGroup,
  version: string,
  updates: AwsNodeGroupUpdates
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
  const what = `Updating node group ${name} ${where} to Kubernetes ${version}`;
  const id = await startUpdate(
    ports,
    name,
    [
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
    ],
    what,
    updates
  );
  await waitForUpdate(ports, cluster, name, id, what, updates);
  const updated = await readAwsNodeGroup(ports, cluster, name);
  if (updated.version !== version)
    throw new Error(
      `Node group ${name} ${where} is at Kubernetes ${updated.version} after its update to ${version}.`
    );
}

function scalingWhat(
  cluster: AwsCleanupCluster,
  name: string,
  desired: number
): string {
  return `Scaling node group ${name} on cluster ${clusterLabel(cluster)} to ${desired}`;
}

// Start scaling a group and return the update's ID.
async function scaleTo(
  ports: AwsJourneyPorts,
  cluster: AwsCleanupCluster,
  group: AwsNodeGroup & { readonly name: AwsMainNodeGroup },
  desired: number,
  updates: AwsNodeGroupUpdates
): Promise<string> {
  return startUpdate(
    ports,
    group.name,
    [
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
    ],
    scalingWhat(cluster, group.name, desired),
    updates
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
  cluster: AwsCleanupCluster,
  // Updates this run started, which may still be in progress.
  updates: AwsNodeGroupUpdates = new Map()
): Promise<void> {
  const failures: string[] = [];
  const started: Array<{ name: AwsMainNodeGroup; id: string }> = [];
  // One wait for every update still in progress, not one per group.
  const deadline = ports.now() + AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS;
  for (const name of AWS_MAIN_NODE_GROUPS) {
    try {
      const pending = updates.get(name);
      if (pending !== undefined && pending !== UNKNOWN_UPDATE) {
        const { ended } = await pollUpdate(
          ports,
          cluster,
          name,
          pending,
          Math.max(0, deadline - ports.now())
        );
        if (!ended) {
          failures.push(
            `${name}: update ${pending} is still in progress after ${AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS / 60_000} minutes, so the group could not be scaled to zero`
          );
          continue;
        }
        updates.delete(name);
      }
      const group = await readAwsNodeGroup(ports, cluster, name);
      // A group at zero is left alone, unless an update was sent to it whose
      // answer never came back, which a read may not show yet.
      if (
        group.desiredSize === 0 &&
        group.minSize === 0 &&
        pending !== UNKNOWN_UPDATE
      )
        continue;
      const id = await scaleTo(
        ports,
        cluster,
        await waitForActive(ports, cluster, name),
        0,
        updates
      );
      started.push({ name, id });
      ports.log(
        `Scaling node group ${name} on cluster ${clusterLabel(cluster)} to zero from ${group.desiredSize}.`
      );
    } catch (error) {
      failures.push(`${name}: ${describeError(error)}`);
    }
  }
  for (const { name, id } of started) {
    try {
      await waitForUpdate(
        ports,
        cluster,
        name,
        id,
        scalingWhat(cluster, name, 0),
        updates
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

export interface AwsNodeGroupStartOptions {
  readonly sizes?: Partial<Record<AwsMainNodeGroup, number>>;
  // Filled with each update it starts, for the teardown's scale-down.
  readonly updates?: AwsNodeGroupUpdates;
  // Once aborted, the start sends nothing more to AWS and leaves the
  // scale-down to whoever stopped it.
  readonly signal?: AbortSignal;
}

// The start's ports: once `signal` aborts, or the start's time limit passes,
// the next AWS call, node read, or wait throws instead. A call already sent
// still finishes.
function limitedPorts(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster,
  signal: AbortSignal | undefined
): AwsNodeGroupPorts {
  const deadline = ports.now() + AWS_NODE_GROUP_START_TIMEOUT_MS;
  const check = () => {
    signal?.throwIfAborted();
    if (ports.now() >= deadline)
      throw new Error(
        `Starting the node groups on cluster ${clusterLabel(cluster)} took longer than ${AWS_NODE_GROUP_START_TIMEOUT_MS / 60_000} minutes, the limit that keeps it inside the preflight stage.`
      );
  };
  return {
    ...ports,
    runAws: async (args) => {
      check();
      return ports.runAws(args);
    },
    sleep: async (milliseconds) => {
      check();
      await ports.sleep(milliseconds);
      check();
    },
    kubernetes: {
      listNodes: async (target, selector) => {
        check();
        return ports.kubernetes.listNodes(target, selector);
      }
    }
  };
}

/**
 * Update each node group to the control plane's version while it has no
 * nodes, scale it up, and wait for its nodes to be Ready, all within
 * AWS_NODE_GROUP_START_TIMEOUT_MS. A failure after the first scale-up scales
 * every group back to zero before it is thrown, unless `signal` stopped the
 * start: then whoever stopped it scales down.
 */
export async function startAwsNodeGroups(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster,
  options: AwsNodeGroupStartOptions = {}
): Promise<void> {
  const { sizes = {}, updates = new Map(), signal } = options;
  const limited = limitedPorts(ports, cluster, signal);
  const { version } = await readAwsCluster(limited, cluster);
  if (!version)
    throw new Error(
      `EKS reported no Kubernetes version for cluster ${clusterLabel(cluster)}.`
    );
  for (const name of AWS_MAIN_NODE_GROUPS)
    await updateToControlPlane(limited, cluster, name, version, updates);

  const scaling = new Map<AwsMainNodeGroup, { size: number; id: string }>();
  try {
    for (const name of AWS_MAIN_NODE_GROUPS) {
      const group = await waitForActive(limited, cluster, name);
      const size = sizes[name] ?? (name === "isolated" ? 1 : group.maxSize);
      const id = await scaleTo(limited, cluster, group, size, updates);
      scaling.set(name, { size, id });
    }
    for (const [name, { size, id }] of scaling)
      await waitForUpdate(
        limited,
        cluster,
        name,
        id,
        scalingWhat(cluster, name, size),
        updates
      );
    for (const [name, { size }] of scaling)
      await waitForReadyNodes(limited, cluster, name, size);
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = `${describeError(error).replace(/\.?$/, ".")} This is an infrastructure failure, not a product one.`;
    try {
      await scaleAwsNodeGroupsToZero(ports, cluster, updates);
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

/** One run's start of the node groups, and the teardown that ends it. */
export interface AwsNodeGroupRun {
  /** Start the node groups. Refused once the run stopped. */
  start(sizes?: Partial<Record<AwsMainNodeGroup, number>>): Promise<void>;
  /**
   * Stop a start still running, wait for it to end, then scale to zero every
   * group it may have changed. When this returns, the run writes nothing
   * more to AWS.
   */
  stop(): Promise<void>;
}

export function createAwsNodeGroupRun(
  ports: AwsNodeGroupPorts,
  cluster: AwsCleanupCluster
): AwsNodeGroupRun {
  const stopping = new AbortController();
  const updates: AwsNodeGroupUpdates = new Map();
  let starting: Promise<void> | null = null;
  return {
    start(sizes = {}) {
      if (stopping.signal.aborted)
        return Promise.reject(
          new Error(
            `The node groups on cluster ${clusterLabel(cluster)} don't start, because the teardown already began.`
          )
        );
      if (starting)
        return Promise.reject(
          new Error(
            `The node groups on cluster ${clusterLabel(cluster)} were already started.`
          )
        );
      starting = startAwsNodeGroups(ports, cluster, {
        sizes,
        updates,
        signal: stopping.signal
      });
      return starting;
    },
    async stop() {
      stopping.abort(
        new Error(
          `Starting the node groups on cluster ${clusterLabel(cluster)} stopped, because the teardown began.`
        )
      );
      if (!starting) return;
      // Its failure is the start's to report. What matters here is that it
      // sends nothing after the scale-down.
      await starting.catch(() => undefined);
      await scaleAwsNodeGroupsToZero(ports, cluster, updates);
    }
  };
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
