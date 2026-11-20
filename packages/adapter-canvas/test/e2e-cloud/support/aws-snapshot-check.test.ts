import { describe, expect, it } from "vitest";
import {
  MAIN,
  MAIN_VPC,
  recipeTags
} from "../../support/aws/cleanup-scenario.js";
import {
  awsWrites,
  createJourneyWorld,
  type JourneyWorld
} from "../../support/aws/journey-scenario.js";
import { RDS_SNAPSHOT_NOT_FOUND } from "../../support/aws/recorded-errors.js";
import { AWS_ENVIRONMENT_NAME_PREFIX } from "./fixture-repository.js";
import { checkAndDeleteFinalSnapshot } from "./aws-snapshot-check.js";

const ENVIRONMENT = "radtest-aws-run1-main";
const INSTANCE = "mysql-run1main";
const SNAPSHOT = `rds-snapshot-${INSTANCE}-final`;
const SCOPE = {
  region: MAIN.region,
  vpcIds: new Set([MAIN_VPC]),
  prefix: AWS_ENVIRONMENT_NAME_PREFIX
};
const TAGS = Object.fromEntries(
  recipeTags(ENVIRONMENT).map((tag) => [tag.Key, tag.Value])
);
const WHERE = `RDS DB instance ${INSTANCE} in ${MAIN.region}`;

function addSnapshot(
  world: JourneyWorld,
  overrides: Partial<{
    id: string;
    instanceId: string;
    vpcId: string;
    status: string;
    tags: Array<{ Key: string; Value: string }>;
  }> = {}
) {
  world.aws.rds.addSnapshot({
    id: SNAPSHOT,
    region: MAIN.region,
    instanceId: INSTANCE,
    vpcId: MAIN_VPC,
    tags: recipeTags(ENVIRONMENT),
    ...overrides
  });
}

function check(world: JourneyWorld, tags = TAGS) {
  return checkAndDeleteFinalSnapshot(world.ports, {
    scope: SCOPE,
    instanceId: INSTANCE,
    tags
  });
}

function snapshots(world: JourneyWorld): string[] {
  return world.aws.rds.snapshot().snapshots.map((item) => item.id);
}

describe("checkAndDeleteFinalSnapshot", () => {
  it("finds the one final snapshot with the app's tags, deletes it, and confirms it is gone", async () => {
    const world = createJourneyWorld();
    addSnapshot(world);
    expect(await check(world)).toEqual({ snapshot: SNAPSHOT, failures: [] });
    expect(snapshots(world)).toEqual([]);
    expect(awsWrites(world)).toEqual(["rds delete-db-snapshot"]);
  });

  it("waits while the snapshot is being created", async () => {
    const world = createJourneyWorld();
    world.aws.rds.creatingReads = 2;
    addSnapshot(world, { status: "creating" });
    expect(await check(world)).toEqual({ snapshot: SNAPSHOT, failures: [] });
    expect(snapshots(world)).toEqual([]);
  });

  it("leaves look-alikes alone and doesn't count them", async () => {
    const world = createJourneyWorld();
    const otherTags = recipeTags("radtest-aws-run1-second");
    addSnapshot(world, { id: "rds-snapshot-other", instanceId: "mysql-other" });
    addSnapshot(world, { id: "rds-snapshot-second", tags: otherTags });
    addSnapshot(world, { id: "rds-snapshot-vpc", vpcId: "vpc-radius" });
    addSnapshot(world, { id: `manual-${INSTANCE}` });
    addSnapshot(world, {
      id: "rds-snapshot-radius",
      tags: [
        ...recipeTags(ENVIRONMENT),
        { Key: "RadiusCreationTimestamp", Value: "1" }
      ]
    });
    const before = snapshots(world);
    const result = await check(world);
    expect(result.snapshot).toBeNull();
    expect(result.failures).toEqual([
      `No final snapshot of ${WHERE} carries the app's tags. Cloud Control takes one when it deletes the instance, and the MySQL recipe copies the app's tags to it. rds-snapshot-second is from it, but has radapp.io/application=${TAGS["radapp.io/application"]}, radapp.io/environment=${otherTags[1]?.Value}, radapp.io/resource=${TAGS["radapp.io/resource"]}.`
    ]);
    addSnapshot(world);
    expect(await check(world)).toEqual({ snapshot: SNAPSHOT, failures: [] });
    expect(snapshots(world)).toEqual(before);
    expect(awsWrites(world)).toEqual(["rds delete-db-snapshot"]);
  });

  it("names a missing tag on a snapshot of the instance", async () => {
    const world = createJourneyWorld();
    addSnapshot(world, { tags: recipeTags(ENVIRONMENT).slice(0, 2) });
    expect((await check(world)).failures[0]).toContain(
      `${SNAPSHOT} is from it, but has radapp.io/application=${TAGS["radapp.io/application"]}, radapp.io/environment=${TAGS["radapp.io/environment"]}, radapp.io/resource=(none).`
    );
  });

  it("fails without deleting when there is more than one", async () => {
    const world = createJourneyWorld();
    addSnapshot(world);
    addSnapshot(world, { id: `${SNAPSHOT}-2` });
    expect(await check(world)).toEqual({
      snapshot: null,
      failures: [
        `${WHERE} has 2 final snapshots with the app's tags (${SNAPSHOT}, ${SNAPSHOT}-2), not one. None was deleted; the Cloud E2E cleanup workflow removes them.`
      ]
    });
    expect(awsWrites(world)).toEqual([]);
  });

  it("fails when there is none", async () => {
    expect((await check(createJourneyWorld())).failures).toEqual([
      `No final snapshot of ${WHERE} carries the app's tags. Cloud Control takes one when it deletes the instance, and the MySQL recipe copies the app's tags to it.`
    ]);
  });

  it("fails when the snapshot is never ready, can't be deleted, or vanishes", async () => {
    const stuck = createJourneyWorld();
    stuck.aws.rds.creatingReads = 1_000;
    addSnapshot(stuck, { status: "creating" });
    expect((await check(stuck)).failures).toEqual([
      `Final snapshot ${SNAPSHOT} of ${WHERE} was still being created after 20 minutes.`
    ]);

    const failed = createJourneyWorld();
    addSnapshot(failed, { status: "failed" });
    expect((await check(failed)).failures).toEqual([
      `Final snapshot ${SNAPSHOT} of ${WHERE} is failed, and only an available snapshot can be deleted. The Cloud E2E cleanup workflow removes it.`
    ]);

    const refused = createJourneyWorld();
    addSnapshot(refused);
    refused.aws.refuseOnce("rds delete-db-snapshot", "AccessDenied");
    expect((await check(refused)).failures[0]).toMatch(
      new RegExp(
        `^Deleting final snapshot ${SNAPSHOT} of ${WHERE} failed: .*\\(AccessDenied\\)`
      )
    );
    expect(snapshots(refused)).toEqual([SNAPSHOT]);

    const vanished = createJourneyWorld();
    addSnapshot(vanished, { status: "creating" });
    vanished.aws.rds.creatingReads = 1_000;
    const runAws = vanished.ports.runAws;
    let reads = 0;
    const ports = {
      ...vanished.ports,
      runAws: async (args: string[]) => {
        if (args[1] === "describe-db-snapshots" && ++reads === 2)
          vanished.aws.rds.snapshots.clear();
        return runAws(args);
      }
    };
    expect(
      (
        await checkAndDeleteFinalSnapshot(ports, {
          scope: SCOPE,
          instanceId: INSTANCE,
          tags: TAGS
        })
      ).failures
    ).toEqual([
      `Final snapshot ${SNAPSHOT} of ${WHERE} is gone, and only an available snapshot can be deleted. The Cloud E2E cleanup workflow removes it.`
    ]);
  });

  it("accepts a snapshot RDS already removed, and fails one that stays after its delete", async () => {
    const world = createJourneyWorld();
    addSnapshot(world);
    const runAws = world.ports.runAws;
    let deleted = false;
    const notFound = {
      ...world.ports,
      runAws: async (args: string[]) => {
        if (args[1] !== "delete-db-snapshot") return runAws(args);
        world.aws.rds.snapshots.clear();
        deleted = true;
        return RDS_SNAPSHOT_NOT_FOUND;
      }
    };
    expect(
      await checkAndDeleteFinalSnapshot(notFound, {
        scope: SCOPE,
        instanceId: INSTANCE,
        tags: TAGS
      })
    ).toEqual({ snapshot: SNAPSHOT, failures: [] });
    expect(deleted).toBe(true);

    const stays = createJourneyWorld();
    addSnapshot(stays);
    const ignored = {
      ...stays.ports,
      runAws: async (args: string[]) =>
        args[1] === "delete-db-snapshot" ?
          { code: 0, stdout: "{}", stderr: "" }
        : stays.ports.runAws(args)
    };
    expect(
      (
        await checkAndDeleteFinalSnapshot(ignored, {
          scope: SCOPE,
          instanceId: INSTANCE,
          tags: TAGS
        })
      ).failures
    ).toEqual([
      `Final snapshot ${SNAPSHOT} of ${WHERE} was still there 10 minutes after it was deleted.`
    ]);
  });

  it("throws when RDS can't be read, and refuses missing app tags", async () => {
    const world = createJourneyWorld();
    world.aws.refuseOnce("rds describe-db-snapshots", "AccessDenied");
    await expect(check(world)).rejects.toThrow("aws rds describe-db-snapshots");
    await expect(
      check(world, { "radapp.io/application": "app" })
    ).rejects.toThrow(
      "The snapshot check needs the app's radapp.io/environment, radapp.io/resource tag values."
    );
  });
});
