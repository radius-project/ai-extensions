import { describe, expect, it } from "vitest";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import { MAIN, SECOND } from "../../support/aws/cleanup-scenario.js";
import {
  awsWrites,
  createJourneyWorld,
  type JourneyWorld
} from "../../support/aws/journey-scenario.js";
import {
  countReadyNodes,
  describeRadiusRelease,
  readAwsRunVersions,
  scaleAwsNodeGroupsToZero,
  startAwsNodeGroups,
  type AwsNodeGroupPorts
} from "./aws-node-groups.js";

const MAIN_LABEL = `${MAIN.name} (${MAIN.region})`;
const COMMIT = "a".repeat(40);

function node(ready: string | null) {
  return {
    metadata: { name: "node" },
    status: {
      conditions: ready === null ? [] : [{ type: "Ready", status: ready }]
    }
  };
}

// Kubernetes as the main cluster's nodes look: one Ready node per desired
// node in each pool, unless the pool is held back.
function nodePorts(
  world: JourneyWorld,
  options: {
    held?: ReadonlySet<string>;
    runAws?: (args: string[]) => Promise<AwsCommandResult> | null;
  } = {}
): AwsNodeGroupPorts & { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    ...world.ports,
    runAws: (args) => options.runAws?.(args) ?? world.ports.runAws(args),
    lines,
    log: (line) => lines.push(line),
    kubernetes: {
      listNodes: async (cluster, selector) => {
        const pool = /^radius-e2e\/pool=(.+)$/.exec(selector)?.[1] ?? "";
        const group = world.aws.clusters
          .get(`${cluster.region}:${cluster.name}`)
          ?.nodegroups.get(pool);
        if (!group) throw new Error(`No pool ${selector}`);
        const count = options.held?.has(pool) ? 0 : group.desiredSize;
        return { items: Array.from({ length: count }, () => node("True")) };
      }
    }
  };
}

function groups(world: JourneyWorld) {
  const cluster = world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`);
  return Object.fromEntries(
    [...(cluster?.nodegroups.values() ?? [])].map((group) => [
      group.name,
      { version: group.version, desiredSize: group.desiredSize }
    ])
  );
}

// Refuses `command` after its first `after` calls, `times` times.
function refusing(command: string, after: number, times = Infinity) {
  let seen = 0;
  return (args: string[]): Promise<AwsCommandResult> | null => {
    if (args.slice(0, 2).join(" ") !== command) return null;
    seen += 1;
    return seen > after && seen <= after + times ?
        Promise.resolve({
          code: 254,
          stdout: "",
          stderr: `An error occurred (AccessDeniedException) when calling ${command}`
        })
      : null;
  };
}

describe("startAwsNodeGroups", () => {
  it("scales the default group to its size and the isolated group to one, then waits for Ready nodes", async () => {
    const world = createJourneyWorld();
    await startAwsNodeGroups(nodePorts(world), MAIN);
    expect(awsWrites(world)).toEqual([
      "eks update-nodegroup-config",
      "eks update-nodegroup-config"
    ]);
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 2 },
      isolated: { version: "1.33", desiredSize: 1 }
    });
  });

  it("takes other sizes", async () => {
    const world = createJourneyWorld();
    await startAwsNodeGroups(nodePorts(world), MAIN, { default: 1 });
    expect(groups(world).default).toEqual({ version: "1.33", desiredSize: 1 });
  });

  it("updates each group to the control plane's version while it has no nodes", async () => {
    const world = createJourneyWorld();
    const cluster = world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`);
    if (cluster) cluster.version = "1.34";
    const ports = nodePorts(world);
    await startAwsNodeGroups(ports, MAIN);
    expect(awsWrites(world)).toEqual([
      "eks update-nodegroup-version",
      "eks update-nodegroup-version",
      "eks update-nodegroup-config",
      "eks update-nodegroup-config"
    ]);
    expect(
      world.calls.find((args) => args[1] === "update-nodegroup-version")
    ).toContain("1.34");
    expect(groups(world)).toEqual({
      default: { version: "1.34", desiredSize: 2 },
      isolated: { version: "1.34", desiredSize: 1 }
    });
    expect(ports.lines[0]).toBe(
      `Updating node group default on cluster ${MAIN_LABEL} from Kubernetes 1.33 to 1.34 while it has no nodes.`
    );
  });

  it("refuses to update a group that has nodes, and changes nothing", async () => {
    const world = createJourneyWorld();
    const cluster = world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`);
    if (cluster) cluster.version = "1.34";
    const group = cluster?.nodegroups.get("default");
    if (group) group.desiredSize = 1;
    await expect(startAwsNodeGroups(nodePorts(world), MAIN)).rejects.toThrow(
      `Node group default on cluster ${MAIN_LABEL} runs Kubernetes 1.33 on 1 nodes, and the control plane is at 1.34. Updating it now would replace running nodes, so the run stopped before changing it. Run the Cloud E2E cleanup workflow, which scales it to zero, then retry.`
    );
    expect(awsWrites(world)).toEqual([]);
  });

  it("scales back to zero when the nodes don't become ready", async () => {
    const world = createJourneyWorld();
    const start = world.clock.now;
    await expect(
      startAwsNodeGroups(
        nodePorts(world, { held: new Set(["isolated"]) }),
        MAIN
      )
    ).rejects.toThrow(
      `Nodes don't become ready: node group isolated on cluster ${MAIN_LABEL} has 0 of 1 nodes Ready after 10 minutes. This is an infrastructure failure, not a product one. The node groups were scaled back to zero.`
    );
    expect(world.clock.now - start).toBeGreaterThanOrEqual(10 * 60_000);
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("scales the first group back down when the second can't be scaled up", async () => {
    const world = createJourneyWorld();
    await expect(
      startAwsNodeGroups(
        nodePorts(world, {
          runAws: refusing("eks update-nodegroup-config", 1, 1)
        }),
        MAIN
      )
    ).rejects.toThrow(
      /^Scaling node group isolated .* to 1 failed: .*AccessDeniedException.*The node groups were scaled back to zero\.$/s
    );
    expect(groups(world).default).toEqual({ version: "1.33", desiredSize: 0 });
  });

  it("reports a failed scale-down after a failed scale-up instead of hiding it", async () => {
    const world = createJourneyWorld();
    const error = startAwsNodeGroups(
      nodePorts(world, { runAws: refusing("eks update-nodegroup-config", 1) }),
      MAIN
    );
    await expect(error).rejects.toThrow(
      "This is an infrastructure failure, not a product one. Scaling the node groups back to zero also failed: Could not scale the node groups on cluster"
    );
    await expect(error).rejects.toThrow(
      "Run the Cloud E2E cleanup workflow, which scales them down."
    );
    expect(groups(world).default.desiredSize).toBe(2);
  });

  it("stops when a version update fails or doesn't take", async () => {
    const world = createJourneyWorld();
    const cluster = world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`);
    if (cluster) cluster.version = "1.34";
    world.aws.refuseOnce("eks update-nodegroup-version", "ClientException");
    await expect(startAwsNodeGroups(nodePorts(world), MAIN)).rejects.toThrow(
      `Updating node group default on cluster ${MAIN_LABEL} to Kubernetes 1.34 failed: `
    );
    const ignored = (args: string[]) =>
      args[1] === "update-nodegroup-version" ?
        Promise.resolve({ code: 0, stdout: "{}", stderr: "" })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: ignored }), MAIN)
    ).rejects.toThrow(
      `Node group default on cluster ${MAIN_LABEL} is at Kubernetes 1.33 after its update to 1.34.`
    );
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("stops when a group never becomes ACTIVE", async () => {
    const world = createJourneyWorld();
    const group = world.aws.clusters
      .get(`${MAIN.region}:${MAIN.name}`)
      ?.nodegroups.get("default");
    if (group) {
      group.status = "UPDATING";
      group.updatingReads = 1000;
    }
    await expect(startAwsNodeGroups(nodePorts(world), MAIN)).rejects.toThrow(
      `Node group default on cluster ${MAIN_LABEL} stayed UPDATING for 15 minutes.`
    );
  });

  it("stops when EKS reports no version or no scaling config", async () => {
    const world = createJourneyWorld();
    const noVersion = (args: string[]) =>
      args[1] === "describe-cluster" ?
        Promise.resolve({ code: 0, stdout: '{"cluster":{}}', stderr: "" })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: noVersion }), MAIN)
    ).rejects.toThrow(
      `EKS reported no Kubernetes version for cluster ${MAIN_LABEL}.`
    );
    const noScaling = (args: string[]) =>
      args[1] === "describe-nodegroup" ?
        Promise.resolve({
          code: 0,
          stdout: '{"nodegroup":{"status":"ACTIVE","version":"1.33"}}',
          stderr: ""
        })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: noScaling }), MAIN)
    ).rejects.toThrow("EKS reported no minSize for node group default.");
    const noGroupVersion = (args: string[]) =>
      args[1] === "describe-nodegroup" ?
        Promise.resolve({
          code: 0,
          stdout: '{"nodegroup":{"status":"ACTIVE"}}',
          stderr: ""
        })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: noGroupVersion }), MAIN)
    ).rejects.toThrow("EKS reported no version for node group default.");
  });
});

describe("scaleAwsNodeGroupsToZero", () => {
  it("leaves groups at zero alone", async () => {
    const world = createJourneyWorld();
    await scaleAwsNodeGroupsToZero(nodePorts(world), MAIN);
    expect(awsWrites(world)).toEqual([]);
  });

  it("scales every group down, waiting for one that is still updating", async () => {
    const world = createJourneyWorld();
    const ports = nodePorts(world);
    await startAwsNodeGroups(ports, MAIN);
    await scaleAwsNodeGroupsToZero(ports, MAIN);
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
    expect(ports.lines.slice(-2)).toEqual([
      `Scaled node group default on cluster ${MAIN_LABEL} to zero from 2.`,
      `Scaled node group isolated on cluster ${MAIN_LABEL} to zero from 1.`
    ]);
  });

  it("tries every group and names each one it couldn't scale down", async () => {
    const world = createJourneyWorld();
    await startAwsNodeGroups(nodePorts(world), MAIN);
    world.aws.refuseOnce(
      "eks update-nodegroup-config",
      "AccessDeniedException"
    );
    await expect(
      scaleAwsNodeGroupsToZero(nodePorts(world), MAIN)
    ).rejects.toThrow(
      `Could not scale the node groups on cluster ${MAIN_LABEL} to zero (default: Scaling node group default on cluster ${MAIN_LABEL} to 0 failed: An error occurred (AccessDeniedException) when calling the eks update-nodegroup-config operation: Refused by the test.). They keep costing until they are. Run the Cloud E2E cleanup workflow, which scales them down.`
    );
    expect(groups(world).isolated.desiredSize).toBe(0);
  });
});

describe("countReadyNodes", () => {
  it("counts only nodes whose Ready condition is True", () => {
    expect(
      countReadyNodes({
        items: [node("True"), node("False"), node(null), {}, null]
      })
    ).toBe(1);
  });

  it("refuses a list it can't read", () => {
    expect(() => countReadyNodes({})).toThrow(
      "kubectl get nodes did not return an items list."
    );
  });
});

describe("describeRadiusRelease", () => {
  it("names edge when no release is pinned, and the pinned release otherwise", () => {
    expect(describeRadiusRelease(undefined)).toBe(
      "edge, the AWS workflows' default, whose images follow Radius main"
    );
    expect(describeRadiusRelease(" ")).toContain("edge");
    expect(
      describeRadiusRelease(
        JSON.stringify({ tag: "v0.55.0", commit: COMMIT, checksum: "b" })
      )
    ).toBe(`v0.55.0 at ${COMMIT}`);
  });

  it.each(["not json", JSON.stringify({ tag: "v0.55.0" })])(
    "refuses %s",
    (release) => {
      expect(() => describeRadiusRelease(release)).toThrow(
        "RADIUS_CLOUD_E2E_RELEASE must contain a release tag and commit."
      );
    }
  );
});

describe("readAwsRunVersions", () => {
  it("records both clusters' versions, the node groups' versions, and Radius", async () => {
    const world = createJourneyWorld();
    const second = world.aws.clusters.get(`${SECOND.region}:${SECOND.name}`);
    if (second) second.version = "1.32";
    expect(
      await readAwsRunVersions(world.ports, [MAIN, SECOND], undefined)
    ).toEqual({
      clusters: [
        { name: MAIN.name, region: MAIN.region, version: "1.33" },
        { name: SECOND.name, region: SECOND.region, version: "1.32" }
      ],
      nodeGroups: [
        {
          cluster: MAIN.name,
          name: "default",
          version: "1.33",
          releaseVersion: "1.33.0-20261101"
        },
        {
          cluster: MAIN.name,
          name: "isolated",
          version: "1.33",
          releaseVersion: "1.33.0-20261101"
        }
      ],
      radius:
        "edge, the AWS workflows' default, whose images follow Radius main"
    });
  });
});
