import { describe, expect, it } from "vitest";
import { FakeAws, isFakeAwsWrite } from "./fake-aws.js";

const REGION = "us-east-2";
const TAGS = [{ Key: "radapp.io/environment", Value: "env-id" }];

function aws() {
  const fake = new FakeAws();
  fake.rds.addRecipeDatabase({
    name: "mysql-abc",
    region: REGION,
    vpcId: "vpc-1",
    tags: TAGS
  });
  return fake;
}

function rds(fake: FakeAws, verb: string, ...args: string[]) {
  return fake.run(["rds", verb, "--region", REGION, ...args]);
}

function json(stdout: string): Record<string, any> {
  return JSON.parse(stdout);
}

describe("FakeRds", () => {
  it("counts every RDS delete as a write", () => {
    for (const verb of [
      "delete-db-instance",
      "delete-db-subnet-group",
      "delete-db-parameter-group",
      "delete-db-snapshot"
    ])
      expect(isFakeAwsWrite(["rds", verb])).toBe(true);
    expect(isFakeAwsWrite(["rds", "describe-db-instances"])).toBe(false);
  });

  it.each([
    [[], "FinalDBSnapshotIdentifier is required"],
    [
      ["--skip-final-snapshot", "--final-db-snapshot-identifier", "snap"],
      "Cannot specify both"
    ]
  ])(
    "requires exactly one of the final-snapshot flags (%j)",
    (flags, message) => {
      const fake = aws();
      const result = rds(
        fake,
        "delete-db-instance",
        "--db-instance-identifier",
        "mysql-abc",
        ...flags
      );
      expect(result.code).toBe(254);
      expect(result.stderr).toContain("(InvalidParameterCombination)");
      expect(result.stderr).toContain(message);
      expect(fake.rds.snapshot().instances[0]?.status).toBe("available");
    }
  );

  it("deletes an instance asynchronously and refuses a second delete while it runs", () => {
    const fake = aws();
    fake.rds.deletingReads = 1;
    const deleted = rds(
      fake,
      "delete-db-instance",
      "--db-instance-identifier",
      "MYSQL-ABC",
      "--skip-final-snapshot"
    );
    expect(json(deleted.stdout).DBInstance.DBInstanceStatus).toBe("deleting");
    expect(
      rds(
        fake,
        "delete-db-instance",
        "--db-instance-identifier",
        "mysql-abc",
        "--skip-final-snapshot"
      ).stderr
    ).toContain("(InvalidDBInstanceState)");
    const describe = () =>
      rds(
        fake,
        "describe-db-instances",
        "--db-instance-identifier",
        "mysql-abc"
      );
    expect(json(describe().stdout).DBInstances[0].DBInstanceStatus).toBe(
      "deleting"
    );
    expect(describe().stderr).toContain("(DBInstanceNotFound)");
    expect(fake.rds.snapshot().snapshots).toEqual([]);
  });

  it("takes a tagged final snapshot that becomes available, and refuses a taken name", () => {
    const fake = aws();
    rds(
      fake,
      "delete-db-instance",
      "--db-instance-identifier",
      "mysql-abc",
      "--final-db-snapshot-identifier",
      "rds-snapshot-1"
    );
    const listed = () =>
      json(
        rds(fake, "describe-db-snapshots", "--snapshot-type", "manual").stdout
      ).DBSnapshots[0];
    expect(
      rds(
        fake,
        "delete-db-snapshot",
        "--db-snapshot-identifier",
        "rds-snapshot-1"
      ).stderr
    ).toContain("(InvalidDBSnapshotState)");
    expect(listed()).toMatchObject({
      Status: "creating",
      TagList: TAGS,
      VpcId: "vpc-1"
    });
    expect(listed().Status).toBe("available");
    fake.rds.addInstance({
      id: "mysql-two",
      region: REGION,
      vpcId: "vpc-1",
      subnetGroup: "mysql-abc",
      parameterGroup: "mysql-abc",
      tags: []
    });
    expect(
      rds(
        fake,
        "delete-db-instance",
        "--db-instance-identifier",
        "mysql-two",
        "--final-db-snapshot-identifier",
        "rds-snapshot-1"
      ).stderr
    ).toContain("(DBSnapshotAlreadyExists)");
    expect(
      rds(
        fake,
        "delete-db-snapshot",
        "--db-snapshot-identifier",
        "rds-snapshot-1"
      ).code
    ).toBe(0);
    expect(
      rds(
        fake,
        "delete-db-snapshot",
        "--db-snapshot-identifier",
        "rds-snapshot-1"
      ).stderr
    ).toContain("(DBSnapshotNotFound)");
  });

  it("deletes a failed instance only without a final snapshot", () => {
    const fake = new FakeAws();
    fake.rds.addRecipeDatabase({
      name: "mysql-bad",
      region: REGION,
      vpcId: "vpc-1",
      tags: [],
      status: "failed"
    });
    expect(
      rds(
        fake,
        "delete-db-instance",
        "--db-instance-identifier",
        "mysql-bad",
        "--final-db-snapshot-identifier",
        "snap"
      ).stderr
    ).toContain("(InvalidDBInstanceState)");
    expect(
      rds(
        fake,
        "delete-db-instance",
        "--db-instance-identifier",
        "mysql-bad",
        "--skip-final-snapshot"
      ).code
    ).toBe(0);
  });

  it.each([
    [
      "delete-db-subnet-group",
      "--db-subnet-group-name",
      "InvalidDBSubnetGroupStateFault",
      "DBSubnetGroupNotFoundFault"
    ],
    [
      "delete-db-parameter-group",
      "--db-parameter-group-name",
      "InvalidDBParameterGroupState",
      "DBParameterGroupNotFound"
    ]
  ])(
    "refuses %s while an instance uses the group, then deletes it once",
    (verb, nameFlag, inUse, notFound) => {
      const fake = aws();
      fake.rds.deletingReads = 0;
      expect(rds(fake, verb, nameFlag, "mysql-abc").stderr).toContain(
        `(${inUse})`
      );
      rds(
        fake,
        "delete-db-instance",
        "--db-instance-identifier",
        "mysql-abc",
        "--skip-final-snapshot"
      );
      expect(rds(fake, verb, nameFlag, "mysql-abc").stderr).toContain(
        `(${inUse})`
      );
      rds(fake, "describe-db-instances");
      expect(rds(fake, verb, nameFlag, "mysql-abc").code).toBe(0);
      expect(rds(fake, verb, nameFlag, "mysql-abc").stderr).toContain(
        `(${notFound})`
      );
    }
  );

  it("lists groups without tags, and gives their tags only through ListTagsForResource", () => {
    const fake = aws();
    const subnets = json(rds(fake, "describe-db-subnet-groups").stdout)
      .DBSubnetGroups[0];
    const parameters = json(rds(fake, "describe-db-parameter-groups").stdout)
      .DBParameterGroups[0];
    expect(subnets).toEqual({
      DBSubnetGroupName: "mysql-abc",
      VpcId: "vpc-1",
      SubnetGroupStatus: "Complete",
      DBSubnetGroupArn: `arn:aws:rds:${REGION}:123456789012:subgrp:mysql-abc`
    });
    expect(parameters).not.toHaveProperty("TagList");
    for (const arn of [
      subnets.DBSubnetGroupArn,
      parameters.DBParameterGroupArn
    ])
      expect(
        json(rds(fake, "list-tags-for-resource", "--resource-name", arn).stdout)
          .TagList
      ).toEqual(TAGS);
    expect(
      rds(
        fake,
        "list-tags-for-resource",
        "--resource-name",
        "arn:aws:rds:us-west-1:123456789012:subgrp:mysql-abc"
      ).code
    ).toBe(254);
  });

  it("keeps each region's resources apart", () => {
    const fake = aws();
    expect(
      json(
        fake.run(["rds", "describe-db-instances", "--region", "us-west-1"])
          .stdout
      ).DBInstances
    ).toEqual([]);
    expect(
      fake.run([
        "rds",
        "delete-db-instance",
        "--region",
        "us-west-1",
        "--db-instance-identifier",
        "mysql-abc",
        "--skip-final-snapshot"
      ]).stderr
    ).toContain("(DBInstanceNotFound)");
  });
});

describe("FakeAws node groups", () => {
  function cluster() {
    const fake = new FakeAws();
    fake.addCluster("main", REGION, "API", "vpc-main");
    fake.addNodegroup(REGION, "main", "default", {
      minSize: 1,
      maxSize: 2,
      desiredSize: 2
    });
    return fake;
  }

  const update = (fake: FakeAws, config: string) =>
    fake.run([
      "eks",
      "update-nodegroup-config",
      "--region",
      REGION,
      "--cluster-name",
      "main",
      "--nodegroup-name",
      "default",
      "--scaling-config",
      config
    ]);
  const describe = (fake: FakeAws) =>
    json(
      fake.run([
        "eks",
        "describe-nodegroup",
        "--region",
        REGION,
        "--cluster-name",
        "main",
        "--nodegroup-name",
        "default"
      ]).stdout
    ).nodegroup;

  it("reports the cluster's VPC", () => {
    expect(
      json(
        cluster().run([
          "eks",
          "describe-cluster",
          "--region",
          REGION,
          "--name",
          "main"
        ]).stdout
      ).cluster.resourcesVpcConfig
    ).toEqual({ vpcId: "vpc-main" });
  });

  it.each([
    "minSize=0,maxSize=0,desiredSize=0",
    "minSize=2,maxSize=2,desiredSize=1",
    "desiredSize=3",
    "minSize=-1",
    "nodes=0"
  ])("refuses the scaling config %s", (config) => {
    const fake = cluster();
    expect(update(fake, config).stderr).toContain(
      "(InvalidParameterException)"
    );
    expect(describe(fake)).toMatchObject({
      status: "ACTIVE",
      scalingConfig: { minSize: 1, maxSize: 2, desiredSize: 2 }
    });
  });

  it("scales to zero, merging unset sizes, and refuses another update until ACTIVE", () => {
    const fake = cluster();
    expect(update(fake, "minSize=0,desiredSize=0").code).toBe(0);
    expect(update(fake, "minSize=0,desiredSize=0").stderr).toContain(
      "(ResourceInUseException)"
    );
    expect(describe(fake)).toMatchObject({
      status: "UPDATING",
      scalingConfig: { minSize: 0, maxSize: 2, desiredSize: 0 }
    });
    expect(describe(fake).status).toBe("ACTIVE");
  });

  it("answers ResourceNotFoundException for a group that does not exist", () => {
    expect(
      cluster().run([
        "eks",
        "describe-nodegroup",
        "--region",
        REGION,
        "--cluster-name",
        "main",
        "--nodegroup-name",
        "gpu"
      ]).stderr
    ).toContain("(ResourceNotFoundException)");
    expect(() =>
      new FakeAws().addNodegroup(REGION, "none", "x", {
        minSize: 0,
        maxSize: 1,
        desiredSize: 0
      })
    ).toThrow(/no cluster/);
  });
});
