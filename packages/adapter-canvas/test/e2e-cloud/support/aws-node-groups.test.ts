import { describe, expect, it } from "vitest";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import { MAIN, SECOND } from "../../support/aws/cleanup-scenario.js";
import { EKS_UPDATE_NOT_FOUND } from "../../support/aws/recorded-errors.js";
import {
  awsWrites,
  createJourneyWorld,
  type JourneyWorld
} from "../../support/aws/journey-scenario.js";
import { AWS_NODE_GROUP_START_TIMEOUT_MS } from "./aws-timeout-budget.js";
import {
  countReadyNodes,
  createAwsNodeGroupRun,
  type AwsNodeGroupRun,
  describeRadiusRelease,
  readAwsRunVersions,
  scaleAwsNodeGroupsToZero,
  startAwsNodeGroups,
  type AwsNodeGroupPorts,
  type AwsNodeGroupUpdates
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

// Each group as EKS shows it once every update has ended, so an update the
// code left running counts.
function groups(world: JourneyWorld) {
  world.clock.now += world.aws.nodegroupUpdateMs;
  return Object.fromEntries(
    ["default", "isolated"].map((name) => {
      const { nodegroup } = JSON.parse(
        world.aws.run([
          "eks",
          "describe-nodegroup",
          "--region",
          MAIN.region,
          "--cluster-name",
          MAIN.name,
          "--nodegroup-name",
          name
        ]).stdout
      );
      return [
        name,
        {
          version: nodegroup.version,
          desiredSize: nodegroup.scalingConfig.desiredSize
        }
      ];
    })
  );
}

function mainGroup(world: JourneyWorld, name: string) {
  const group = world.aws.clusters
    .get(`${MAIN.region}:${MAIN.name}`)
    ?.nodegroups.get(name);
  if (!group) throw new Error(`No node group ${name}`);
  return group;
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
          stderr: `\nAn error occurred (AccessDeniedException) when calling the UpdateNodegroupConfig operation: User is not authorized to perform eks:UpdateNodegroupConfig\n`
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
    await startAwsNodeGroups(nodePorts(world), MAIN, {
      sizes: { default: 1 }
    });
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
    const noId = (args: string[]) =>
      args[1] === "update-nodegroup-version" ?
        Promise.resolve({ code: 0, stdout: "{}", stderr: "" })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: noId }), MAIN)
    ).rejects.toThrow(
      `Updating node group default on cluster ${MAIN_LABEL} to Kubernetes 1.34 returned no update ID, so the run can't tell when it ends: {}`
    );
    const silent = (args: string[]) =>
      args[1] === "update-nodegroup-version" ?
        Promise.resolve({ code: 0, stdout: "not json", stderr: "" })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: silent }), MAIN)
    ).rejects.toThrow(
      "returned no update ID, so the run can't tell when it ends: not json"
    );
    const empty = (args: string[]) =>
      args[1] === "update-nodegroup-version" ?
        Promise.resolve({ code: 0, stdout: "", stderr: "" })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: empty }), MAIN)
    ).rejects.toThrow("can't tell when it ends: (no output)");
    // EKS says the update succeeded, but the group kept its version.
    const ignored = (args: string[]) =>
      args[1] === "update-nodegroup-version" ?
        Promise.resolve({
          code: 0,
          stdout: '{"update":{"id":"u-1","status":"InProgress"}}',
          stderr: ""
        })
      : args[1] === "describe-update" ?
        Promise.resolve({
          code: 0,
          stdout: '{"update":{"id":"u-1","status":"Successful"}}',
          stderr: ""
        })
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

  it("waits for each update by its ID, not by a describe that still shows the group as it was", async () => {
    const world = createJourneyWorld();
    const cluster = world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`);
    if (cluster) cluster.version = "1.34";
    const start = world.clock.now;
    await startAwsNodeGroups(nodePorts(world), MAIN);
    expect(mainGroup(world, "default")).toMatchObject({
      version: "1.34",
      desiredSize: 2
    });
    expect(
      world.calls.filter((args) => args[1] === "describe-update")
    ).not.toHaveLength(0);
    // Two version updates, then the two scale-ups together.
    expect(world.clock.now - start).toBeGreaterThanOrEqual(
      3 * world.aws.nodegroupUpdateMs
    );
  });

  it("waits out an update it didn't start, even when a describe still shows the group ACTIVE", async () => {
    const world = createJourneyWorld();
    // Something else scales isolated just as this run scales default, so the
    // run's next describe of isolated still shows it ACTIVE.
    let raced = false;
    const race = (args: string[]) => {
      if (!raced && args[1] === "update-nodegroup-config") {
        raced = true;
        world.aws.run([
          "eks",
          "update-nodegroup-config",
          "--region",
          MAIN.region,
          "--cluster-name",
          MAIN.name,
          "--nodegroup-name",
          "isolated",
          "--scaling-config",
          "minSize=0,maxSize=1,desiredSize=0"
        ]);
      }
      return null;
    };
    await startAwsNodeGroups(nodePorts(world, { runAws: race }), MAIN);
    expect(
      world.calls.filter((args) => args[1] === "update-nodegroup-config").length
    ).toBeGreaterThan(2);
    expect(groups(world).isolated.desiredSize).toBe(1);
  });

  it("waits for an update EKS doesn't list yet", async () => {
    const world = createJourneyWorld();
    let unlisted = 2;
    const lagging = (args: string[]) =>
      args[1] === "describe-update" && unlisted-- > 0 ?
        Promise.resolve(EKS_UPDATE_NOT_FOUND)
      : null;
    await startAwsNodeGroups(nodePorts(world, { runAws: lagging }), MAIN);
    expect(groups(world).default.desiredSize).toBe(2);
  });

  it("stops, naming EKS's reason, when an update fails, and scales back to zero", async () => {
    const world = createJourneyWorld();
    world.aws.nodegroupUpdateFailure = {
      errorCode: "AsgInstanceLaunchFailures",
      errorMessage: "Could not launch On-Demand Instances."
    };
    await expect(startAwsNodeGroups(nodePorts(world), MAIN)).rejects.toThrow(
      /^Scaling node group default on cluster .* to 2 ended Failed \(update UPDFAKE\d+\): AsgInstanceLaunchFailures: Could not launch On-Demand Instances\. This is an infrastructure failure, not a product one\. The node groups were scaled back to zero\.$/
    );
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("says when EKS gives no reason for a failed update", async () => {
    const world = createJourneyWorld();
    const failed = (args: string[]) =>
      args[1] === "describe-update" ?
        Promise.resolve({
          code: 0,
          stdout: '{"update":{"status":"Cancelled"}}',
          stderr: ""
        })
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(world, { runAws: failed }), MAIN)
    ).rejects.toThrow(
      /to 2 ended Cancelled \(update UPDFAKE\d+\): EKS gave no reason\. This is an infrastructure failure/
    );
  });

  it("stops when an update never ends, or EKS never lists it", async () => {
    const world = createJourneyWorld();
    world.aws.nodegroupUpdateMs = Infinity;
    await expect(startAwsNodeGroups(nodePorts(world), MAIN)).rejects.toThrow(
      /^Scaling node group default on cluster .* to 2 is still in progress after 15 minutes \(update UPDFAKE\d+\)\./
    );
    const unlisted = createJourneyWorld();
    const never = (args: string[]) =>
      args[1] === "describe-update" ?
        Promise.resolve(EKS_UPDATE_NOT_FOUND)
      : null;
    await expect(
      startAwsNodeGroups(nodePorts(unlisted, { runAws: never }), MAIN)
    ).rejects.toThrow(
      /^Scaling node group default on cluster .* to 2 is still not listed by EKS after 15 minutes/
    );
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
      `Scaling node group default on cluster ${MAIN_LABEL} to zero from 2.`,
      `Scaling node group isolated on cluster ${MAIN_LABEL} to zero from 1.`
    ]);
  });

  it("scales down a group whose scale-up is still running, though a read shows it at zero", async () => {
    const world = createJourneyWorld();
    const { update } = JSON.parse(
      world.aws.run([
        "eks",
        "update-nodegroup-config",
        "--region",
        MAIN.region,
        "--cluster-name",
        MAIN.name,
        "--nodegroup-name",
        "default",
        "--scaling-config",
        "minSize=0,maxSize=2,desiredSize=2"
      ]).stdout
    );
    const updates: AwsNodeGroupUpdates = new Map([["default", update.id]]);
    await scaleAwsNodeGroupsToZero(nodePorts(world), MAIN, updates);
    expect(groups(world).default.desiredSize).toBe(0);
    expect(updates.size).toBe(0);
  });

  it("names a group whose update is still running when the wait ends, without waiting per group", async () => {
    const world = createJourneyWorld();
    world.aws.nodegroupUpdateMs = Infinity;
    const updates: AwsNodeGroupUpdates = new Map();
    const start = world.clock.now;
    const error = startAwsNodeGroups(nodePorts(world), MAIN, { updates });
    await expect(error).rejects.toThrow(
      /^Scaling node group default .* is still in progress after 15 minutes .* Scaling the node groups back to zero also failed: Could not scale the node groups on cluster .* to zero \(default: update UPDFAKE\d+ is still in progress after 15 minutes, so the group could not be scaled to zero; isolated: update UPDFAKE\d+ is still in progress after 15 minutes, so the group could not be scaled to zero\)/
    );
    // The scale-up's own wait, then one shared wait, not one per group.
    expect(world.clock.now - start).toBeLessThan(31 * 60_000);
    expect([...updates.keys()]).toEqual(["default", "isolated"]);
  });

  it("names a scale-down EKS started but couldn't finish", async () => {
    const world = createJourneyWorld();
    await startAwsNodeGroups(nodePorts(world), MAIN);
    world.aws.nodegroupUpdateFailure = {
      errorCode: "InternalFailure",
      errorMessage: "Try again."
    };
    await expect(
      scaleAwsNodeGroupsToZero(nodePorts(world), MAIN)
    ).rejects.toThrow(
      /\(default: Scaling node group default on cluster .* to 0 ended Failed \(update UPDFAKE\d+\): InternalFailure: Try again\.\)/
    );
    expect(groups(world).isolated.desiredSize).toBe(0);
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
      `Could not scale the node groups on cluster ${MAIN_LABEL} to zero (default: Scaling node group default on cluster ${MAIN_LABEL} to 0 failed: An error occurred (AccessDeniedException) when calling the UpdateNodegroupConfig operation: Refused by the test.). They keep costing until they are. Run the Cloud E2E cleanup workflow, which scales them down.`
    );
    expect(groups(world).isolated.desiredSize).toBe(0);
  });
});

describe("createAwsNodeGroupRun", () => {
  // A run whose start calls `hook` before each AWS call, so a test can begin
  // the teardown at any point. The hook may answer the call itself.
  function hooked(
    world: JourneyWorld,
    hook: (
      args: string[],
      run: AwsNodeGroupRun
    ) => Promise<AwsCommandResult> | null,
    held?: ReadonlySet<string>
  ) {
    let run: AwsNodeGroupRun | null = null;
    const created = createAwsNodeGroupRun(
      nodePorts(world, {
        held,
        runAws: (args) => (run ? hook(args, run) : null)
      }),
      MAIN
    );
    run = created;
    return created;
  }

  const configWrites = (world: JourneyWorld) =>
    world.calls
      .filter((args) => args[1] === "update-nodegroup-config")
      .map(
        (args) => `${args[args.indexOf("--nodegroup-name") + 1]} ${args.at(-1)}`
      );

  // Starts the run and returns its outcome once both it and the teardown
  // ended. A hook began the teardown, or it begins after the start ends.
  async function startThenStop(
    run: AwsNodeGroupRun,
    teardown: () => Promise<void> | null
  ) {
    const started = await run.start().then(
      () => null,
      (error: unknown) => error
    );
    await (teardown() ?? run.stop());
    return { started };
  }

  // An AWS call held open until `release()`, as a slow answer is.
  function held() {
    let release = () => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { open, release };
  }

  // Whether `promise` has settled, after letting every pending step run.
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true)
    );
    for (let step = 0; step < 20; step += 1)
      await new Promise((resolve) => setImmediate(resolve));
    return done;
  }

  it("doesn't finish the teardown until the start's call in flight answers", async () => {
    const world = createJourneyWorld();
    world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`)!.version = "1.34";
    const call = held();
    let teardown: Promise<void> | null = null;
    const run = hooked(world, (args, self) => {
      if (teardown || args[1] !== "update-nodegroup-version") return null;
      teardown = self.stop();
      return call.open.then(() => world.ports.runAws(args));
    });
    const start = run.start();
    expect(await settled(start)).toBe(false);
    expect(teardown).not.toBeNull();
    expect(await settled(teardown!)).toBe(false);
    call.release();
    await expect(start).rejects.toThrow("stopped, because the teardown began");
    await teardown;
    expect(groups(world).default.desiredSize).toBe(0);
  });

  it("ends at zero when the teardown starts during the version update", async () => {
    const world = createJourneyWorld();
    world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`)!.version = "1.34";
    let teardown: Promise<void> | null = null;
    const run = hooked(world, (args, self) => {
      if (!teardown && args[1] === "update-nodegroup-version")
        teardown = self.stop();
      return null;
    });
    const { started } = await startThenStop(run, () => teardown);
    // The start leaves the scale-down to the teardown rather than racing it.
    expect((started as Error).message).toBe(
      `Starting the node groups on cluster ${MAIN_LABEL} stopped, because the teardown began.`
    );
    expect(
      world.calls.filter((args) => args[1] === "update-nodegroup-version")
    ).toHaveLength(1);
    expect(configWrites(world)).toEqual([]);
    expect(groups(world)).toEqual({
      default: { version: "1.34", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("scales down a scale-up AWS accepted while the teardown began", async () => {
    const world = createJourneyWorld();
    let teardown: Promise<void> | null = null;
    // The teardown begins while the request is on its way; AWS accepts it
    // and its answer arrives after.
    const run = hooked(world, (args, self) => {
      if (!teardown && args[1] === "update-nodegroup-config")
        teardown = self.stop();
      return null;
    });
    const { started } = await startThenStop(run, () => teardown);
    // A stopped start doesn't run its own rollback alongside the teardown's.
    expect((started as Error).message).toBe(
      `Starting the node groups on cluster ${MAIN_LABEL} stopped, because the teardown began.`
    );
    expect(configWrites(world)).toEqual([
      "default minSize=0,maxSize=2,desiredSize=2",
      ...Array(configWrites(world).length - 1).fill(
        "default minSize=0,maxSize=2,desiredSize=0"
      )
    ]);
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("sends nothing more when the teardown begins between the two groups' scale-ups", async () => {
    const world = createJourneyWorld();
    let teardown: Promise<void> | null = null;
    const run = hooked(world, (args, self) => {
      if (
        !teardown &&
        args[1] === "describe-nodegroup" &&
        args.includes("isolated") &&
        configWrites(world).length === 1
      )
        teardown = self.stop();
      return null;
    });
    await startThenStop(run, () => teardown);
    expect(
      configWrites(world).filter((write) => write.startsWith("isolated"))
    ).toEqual([]);
    expect(groups(world).default.desiredSize).toBe(0);
  });

  it("stops waiting for a group to be ACTIVE, and writes nothing, when the teardown begins", async () => {
    const world = createJourneyWorld();
    const group = world.aws.clusters
      .get(`${MAIN.region}:${MAIN.name}`)!
      .nodegroups.get("default")!;
    group.status = "UPDATING";
    group.updatingReads = 1000;
    let teardown: Promise<void> | null = null;
    let reads = 0;
    const run = hooked(world, (args, self) => {
      if (!teardown && args[1] === "describe-nodegroup" && ++reads === 3)
        teardown = self.stop();
      return null;
    });
    const start = world.clock.now;
    const { started } = await startThenStop(run, () => teardown);
    // The start leaves the scale-down to the teardown rather than racing it.
    expect((started as Error).message).toBe(
      `Starting the node groups on cluster ${MAIN_LABEL} stopped, because the teardown began.`
    );
    expect(awsWrites(world)).toEqual([]);
    expect(world.clock.now - start).toBeLessThan(5 * 60_000);
  });

  it("lets a start that failed on its own scale back, then ends at zero", async () => {
    const world = createJourneyWorld();
    const run = hooked(world, () => null);
    // The isolated group's scale-up is refused.
    let refused = false;
    const runAws = world.aws.run.bind(world.aws);
    world.aws.run = (args) => {
      if (
        !refused &&
        args[1] === "update-nodegroup-config" &&
        args.includes("isolated")
      ) {
        refused = true;
        return {
          code: 254,
          stdout: "",
          stderr:
            "\nAn error occurred (AccessDeniedException) when calling the UpdateNodegroupConfig operation: denied\n"
        };
      }
      return runAws(args);
    };
    const { started } = await startThenStop(run, () => null);
    expect(String(started)).toContain(
      "The node groups were scaled back to zero."
    );
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("scales down a group whose scale-up AWS accepted but never answered", async () => {
    const world = createJourneyWorld();
    let lost = false;
    const run = hooked(world, (args) => {
      if (lost || args[1] !== "update-nodegroup-config") return null;
      lost = true;
      world.aws.run(args);
      // The start's own scale-back is refused too, so the teardown must
      // still not trust the group's read at zero.
      world.aws.refuseOnce(
        "eks update-nodegroup-config",
        "ThrottlingException"
      );
      return Promise.resolve({
        code: 255,
        stdout: "",
        stderr: "Read timeout on endpoint URL",
        timedOut: true
      });
    });
    const { started } = await startThenStop(run, () => null);
    expect(String(started)).toMatch(
      /Read timeout on endpoint URL\. This is an infrastructure failure, not a product one\. Scaling the node groups back to zero also failed: .*ThrottlingException/
    );
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("scales down a group whose accepted scale-up was answered as in use, when the teardown begins during the retry", async () => {
    const world = createJourneyWorld();
    let teardown: Promise<void> | null = null;
    // The CLI's first try reached AWS but its answer was lost; its retry was
    // refused, because that first try now holds the group.
    const run = hooked(world, (args, self) => {
      if (teardown || args[1] !== "update-nodegroup-config") return null;
      world.aws.run(args);
      teardown = self.stop();
      return Promise.resolve({
        code: 254,
        stdout: "",
        stderr:
          "\nAn error occurred (ResourceInUseException) when calling the UpdateNodegroupConfig operation: Nodegroup default is in UPDATING state and cannot be updated.\n"
      });
    });
    await startThenStop(run, () => teardown);
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("stops a start that runs past its limit, and scales back to zero", async () => {
    const world = createJourneyWorld();
    world.aws.nodegroupUpdateMs = 11 * 60_000;
    const run = hooked(world, () => null, new Set(["isolated"]));
    const start = world.clock.now;
    const { started } = await startThenStop(run, () => null);
    expect(String(started)).toMatch(
      /took longer than 20 minutes, the limit that keeps it inside the preflight stage\. This is an infrastructure failure, not a product one\. The node groups were scaled back to zero\.$/
    );
    expect(world.clock.now - start).toBeLessThan(
      AWS_NODE_GROUP_START_TIMEOUT_MS + 20 * 60_000
    );
    expect(groups(world)).toEqual({
      default: { version: "1.33", desiredSize: 0 },
      isolated: { version: "1.33", desiredSize: 0 }
    });
  });

  it("refuses a start after the teardown began, or a second start", async () => {
    const world = createJourneyWorld();
    const stopped = hooked(world, () => null);
    await stopped.stop();
    await expect(stopped.start()).rejects.toThrow(
      "don't start, because the teardown already began"
    );
    expect(world.calls).toEqual([]);
    const twice = hooked(world, () => null);
    const first = twice.start();
    await expect(twice.start()).rejects.toThrow("were already started");
    await first;
    await twice.stop();
    expect(groups(world).default.desiredSize).toBe(0);
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
