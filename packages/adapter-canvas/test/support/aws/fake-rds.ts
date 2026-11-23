import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";

// The RDS state the Cloud E2E cleanup sweep reads and deletes: DB instances,
// DB subnet groups, DB parameter groups, and manual DB snapshots, each in one
// region. It enforces the rules the RDS API reference documents, so a sweep
// that sends a call the real service refuses fails here too:
//
// - DeleteDBInstance takes exactly one of SkipFinalSnapshot or
//   FinalDBSnapshotIdentifier. Without SkipFinalSnapshot the identifier is
//   required, and the two together are an error. Deletion is asynchronous: the
//   instance reports `deleting` until RDS removes it, and a second delete of a
//   `deleting` instance is refused with InvalidDBInstanceState.
//   https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DeleteDBInstance.html
// - DeleteDBSubnetGroup refuses a group any DB instance uses
//   (InvalidDBSubnetGroupStateFault), and an unknown group is
//   DBSubnetGroupNotFoundFault.
//   https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DeleteDBSubnetGroup.html
// - DeleteDBParameterGroup refuses a group any DB instance uses
//   (InvalidDBParameterGroupState), and an unknown group is
//   DBParameterGroupNotFound.
//   https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DeleteDBParameterGroup.html
// - DeleteDBSnapshot deletes only an `available` snapshot
//   (InvalidDBSnapshotState otherwise), and an unknown one is
//   DBSnapshotNotFound. Accepting the delete doesn't remove the snapshot at
//   once: until RDS finishes, it is still listed, as `deleting`.
//   https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DeleteDBSnapshot.html
// - A describe filtered to one name answers that resource's NotFound fault
//   when it doesn't exist: DBInstanceNotFound, DBSubnetGroupNotFoundFault,
//   DBParameterGroupNotFound, or DBSnapshotNotFound.
// - DescribeDBInstances and DescribeDBSnapshots return each resource's
//   TagList. DescribeDBSubnetGroups and DescribeDBParameterGroups do not, so
//   their tags come from ListTagsForResource.
//   https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DBSubnetGroup.html
//   https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DBParameterGroup.html
// - A DB instance created with CopyTagsToSnapshot copies its tags to the
//   final snapshot.

export type RdsTag = { Key: string; Value: string };

export interface FakeDbInstance {
  id: string;
  region: string;
  status: string;
  vpcId: string;
  subnetGroup: string;
  parameterGroup: string;
  tags: RdsTag[];
  copyTagsToSnapshot: boolean;
  createTime: string;
  // Describe reads left before a `deleting` instance is gone.
  deletingReads: number;
}

export interface FakeDbSubnetGroup {
  name: string;
  region: string;
  vpcId: string;
  tags: RdsTag[];
}

export interface FakeDbParameterGroup {
  name: string;
  region: string;
  tags: RdsTag[];
}

export interface FakeDbSnapshot {
  id: string;
  region: string;
  instanceId: string;
  vpcId: string;
  status: string;
  tags: RdsTag[];
  createTime: string;
  // Describe reads left before a `creating` snapshot is `available`.
  creatingReads: number;
  // Describe reads left before a `deleting` snapshot is gone.
  deletingReads: number;
}

export interface FakeRdsSnapshot {
  instances: Array<{ region: string; id: string; status: string }>;
  subnetGroups: string[];
  parameterGroups: string[];
  snapshots: Array<{ region: string; id: string; status: string }>;
}

function serviceError(
  code: string,
  operation: string,
  message: string
): AwsCommandResult {
  return {
    code: 254,
    stdout: "",
    stderr: `\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n`
  };
}

function ok(value: unknown): AwsCommandResult {
  return { code: 0, stdout: `${JSON.stringify(value, null, 4)}\n`, stderr: "" };
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

function key(region: string, name: string): string {
  return `${region}:${name.toLowerCase()}`;
}

export const RDS_WRITES: ReadonlySet<string> = new Set([
  "rds delete-db-instance",
  "rds delete-db-subnet-group",
  "rds delete-db-parameter-group",
  "rds delete-db-snapshot"
]);

export class FakeRds {
  readonly instances = new Map<string, FakeDbInstance>();
  readonly subnetGroups = new Map<string, FakeDbSubnetGroup>();
  readonly parameterGroups = new Map<string, FakeDbParameterGroup>();
  readonly snapshots = new Map<string, FakeDbSnapshot>();
  // How many describe reads a delete or a snapshot takes to finish.
  deletingReads = 2;
  creatingReads = 1;

  constructor(
    private readonly accountId: string,
    private readonly time: () => string
  ) {}

  /** A MySQL recipe's three resources, all named `name`, as one deploy makes. */
  addRecipeDatabase(input: {
    name: string;
    region: string;
    vpcId: string;
    tags: RdsTag[];
    status?: string;
  }): void {
    this.subnetGroups.set(key(input.region, input.name), {
      name: input.name,
      region: input.region,
      vpcId: input.vpcId,
      tags: [...input.tags]
    });
    this.parameterGroups.set(key(input.region, input.name), {
      name: input.name,
      region: input.region,
      tags: [...input.tags]
    });
    this.addInstance({
      id: input.name,
      region: input.region,
      vpcId: input.vpcId,
      subnetGroup: input.name,
      parameterGroup: input.name,
      tags: input.tags,
      ...(input.status ? { status: input.status } : {})
    });
  }

  addInstance(input: {
    id: string;
    region: string;
    vpcId: string;
    subnetGroup: string;
    parameterGroup: string;
    tags: RdsTag[];
    status?: string;
  }): void {
    this.instances.set(key(input.region, input.id), {
      id: input.id,
      region: input.region,
      status: input.status ?? "available",
      vpcId: input.vpcId,
      subnetGroup: input.subnetGroup,
      parameterGroup: input.parameterGroup,
      tags: [...input.tags],
      copyTagsToSnapshot: true,
      createTime: this.time(),
      deletingReads: this.deletingReads
    });
  }

  addSubnetGroup(group: FakeDbSubnetGroup): void {
    this.subnetGroups.set(key(group.region, group.name), {
      ...group,
      tags: [...group.tags]
    });
  }

  addParameterGroup(group: FakeDbParameterGroup): void {
    this.parameterGroups.set(key(group.region, group.name), {
      ...group,
      tags: [...group.tags]
    });
  }

  addSnapshot(input: {
    id: string;
    region: string;
    vpcId: string;
    tags: RdsTag[];
    status?: string;
    instanceId?: string;
  }): void {
    this.snapshots.set(key(input.region, input.id), {
      id: input.id,
      region: input.region,
      instanceId: input.instanceId ?? "",
      vpcId: input.vpcId,
      status: input.status ?? "available",
      tags: [...input.tags],
      createTime: this.time(),
      creatingReads: this.creatingReads,
      deletingReads: this.deletingReads
    });
  }

  snapshot(): FakeRdsSnapshot {
    const sorted = <T extends { region: string }>(
      items: Iterable<T>,
      name: (item: T) => string
    ) =>
      [...items].sort((a, b) =>
        `${a.region}:${name(a)}`.localeCompare(`${b.region}:${name(b)}`)
      );
    return {
      instances: sorted(this.instances.values(), (item) => item.id).map(
        ({ region, id, status }) => ({ region, id, status })
      ),
      subnetGroups: sorted(this.subnetGroups.values(), (item) => item.name).map(
        (group) => `${group.region}:${group.name}`
      ),
      parameterGroups: sorted(
        this.parameterGroups.values(),
        (item) => item.name
      ).map((group) => `${group.region}:${group.name}`),
      snapshots: sorted(this.snapshots.values(), (item) => item.id).map(
        ({ region, id, status }) => ({ region, id, status })
      )
    };
  }

  run(command: string, args: readonly string[]): AwsCommandResult | null {
    const region = flag(args, "--region");
    switch (command) {
      case "rds describe-db-instances":
        return this.describeInstances(
          region,
          flag(args, "--db-instance-identifier")
        );
      case "rds delete-db-instance":
        return this.deleteInstance(region, args);
      case "rds describe-db-subnet-groups":
        return (
          this.named(
            this.subnetGroups,
            region,
            flag(args, "--db-subnet-group-name"),
            "DescribeDBSubnetGroups",
            "DBSubnetGroupNotFoundFault"
          ) ??
          ok({
            DBSubnetGroups: this.inRegion(
              this.subnetGroups,
              region,
              flag(args, "--db-subnet-group-name")
            ).map((group) => ({
              DBSubnetGroupName: group.name,
              VpcId: group.vpcId,
              SubnetGroupStatus: "Complete",
              DBSubnetGroupArn: this.arn(group.region, "subgrp", group.name)
            }))
          })
        );
      case "rds describe-db-parameter-groups":
        return (
          this.named(
            this.parameterGroups,
            region,
            flag(args, "--db-parameter-group-name"),
            "DescribeDBParameterGroups",
            "DBParameterGroupNotFound"
          ) ??
          ok({
            DBParameterGroups: this.inRegion(
              this.parameterGroups,
              region,
              flag(args, "--db-parameter-group-name")
            ).map((group) => ({
              DBParameterGroupName: group.name,
              DBParameterGroupFamily: "mysql8.4",
              DBParameterGroupArn: this.arn(group.region, "pg", group.name)
            }))
          })
        );
      case "rds list-tags-for-resource":
        return this.listTags(region, flag(args, "--resource-name"));
      case "rds delete-db-subnet-group":
        return this.deleteGroup(
          region,
          flag(args, "--db-subnet-group-name"),
          this.subnetGroups,
          "DeleteDBSubnetGroup",
          "DBSubnetGroupNotFoundFault",
          "InvalidDBSubnetGroupStateFault",
          (instance) => instance.subnetGroup
        );
      case "rds delete-db-parameter-group":
        return this.deleteGroup(
          region,
          flag(args, "--db-parameter-group-name"),
          this.parameterGroups,
          "DeleteDBParameterGroup",
          "DBParameterGroupNotFound",
          "InvalidDBParameterGroupState",
          (instance) => instance.parameterGroup
        );
      case "rds describe-db-snapshots":
        return this.describeSnapshots(region, args);
      case "rds delete-db-snapshot":
        return this.deleteSnapshot(
          region,
          flag(args, "--db-snapshot-identifier")
        );
    }
    return null;
  }

  private arn(region: string, type: string, name: string): string {
    return `arn:aws:rds:${region}:${this.accountId}:${type}:${name}`;
  }

  // Every resource in `region`, or only the one named `name`.
  private inRegion<T extends { region: string }>(
    map: Map<string, T>,
    region: string,
    name = ""
  ): T[] {
    return [...map.entries()]
      .filter(
        ([mapKey, item]) =>
          item.region === region && (!name || mapKey === key(region, name))
      )
      .map(([, item]) => item);
  }

  // The NotFound fault for a describe filtered to a name that doesn't exist.
  private named<T>(
    map: Map<string, T>,
    region: string,
    name: string,
    operation: string,
    notFound: string
  ): AwsCommandResult | null {
    if (!name || map.has(key(region, name))) return null;
    return serviceError(notFound, operation, `${name} not found.`);
  }

  private instanceView(instance: FakeDbInstance) {
    return {
      DBInstanceIdentifier: instance.id,
      DBInstanceArn: this.arn(instance.region, "db", instance.id),
      DBInstanceStatus: instance.status,
      Engine: "mysql",
      InstanceCreateTime: instance.createTime,
      DBSubnetGroup: {
        DBSubnetGroupName: instance.subnetGroup,
        VpcId: instance.vpcId
      },
      DBParameterGroups: [
        {
          DBParameterGroupName: instance.parameterGroup,
          ParameterApplyStatus: "in-sync"
        }
      ],
      CopyTagsToSnapshot: instance.copyTagsToSnapshot,
      TagList: instance.tags.map((tag) => ({ ...tag }))
    };
  }

  // Each read moves a `deleting` instance one step closer to gone, as RDS
  // finishes the delete while the caller polls.
  private advance(): void {
    for (const [id, instance] of this.instances) {
      if (instance.status !== "deleting") continue;
      if (instance.deletingReads <= 0) this.instances.delete(id);
      else instance.deletingReads -= 1;
    }
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.status === "creating") {
        if (snapshot.creatingReads <= 0) snapshot.status = "available";
        else snapshot.creatingReads -= 1;
      } else if (snapshot.status === "deleting") {
        if (snapshot.deletingReads <= 0) this.snapshots.delete(id);
        else snapshot.deletingReads -= 1;
      }
    }
  }

  private describeInstances(region: string, id: string): AwsCommandResult {
    this.advance();
    if (id) {
      const instance = this.instances.get(key(region, id));
      if (!instance) {
        return serviceError(
          "DBInstanceNotFound",
          "DescribeDBInstances",
          `DBInstance ${id} not found.`
        );
      }
      return ok({ DBInstances: [this.instanceView(instance)] });
    }
    return ok({
      DBInstances: this.inRegion(this.instances, region).map((instance) =>
        this.instanceView(instance)
      )
    });
  }

  private deleteInstance(
    region: string,
    args: readonly string[]
  ): AwsCommandResult {
    const id = flag(args, "--db-instance-identifier");
    const skip = args.includes("--skip-final-snapshot");
    const finalSnapshot = flag(args, "--final-db-snapshot-identifier");
    if (skip && finalSnapshot) {
      return serviceError(
        "InvalidParameterCombination",
        "DeleteDBInstance",
        "Cannot specify both SkipFinalSnapshot and FinalDBSnapshotIdentifier."
      );
    }
    if (!skip && !finalSnapshot) {
      return serviceError(
        "InvalidParameterCombination",
        "DeleteDBInstance",
        "FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified."
      );
    }
    const instance = this.instances.get(key(region, id));
    if (!instance) {
      return serviceError(
        "DBInstanceNotFound",
        "DeleteDBInstance",
        `DBInstance ${id} not found.`
      );
    }
    if (instance.status === "deleting") {
      return serviceError(
        "InvalidDBInstanceState",
        "DeleteDBInstance",
        `Instance ${id} is already being deleted.`
      );
    }
    if (
      ["failed", "incompatible-restore", "incompatible-network"].includes(
        instance.status
      ) &&
      !skip
    ) {
      return serviceError(
        "InvalidDBInstanceState",
        "DeleteDBInstance",
        `Instance ${id} is ${instance.status}; only SkipFinalSnapshot can delete it.`
      );
    }
    if (finalSnapshot) {
      if (this.snapshots.has(key(region, finalSnapshot))) {
        return serviceError(
          "DBSnapshotAlreadyExists",
          "DeleteDBInstance",
          `Cannot create the snapshot because a snapshot with the identifier ${finalSnapshot} already exists.`
        );
      }
      this.addSnapshot({
        id: finalSnapshot,
        region,
        instanceId: instance.id,
        vpcId: instance.vpcId,
        status: "creating",
        tags: instance.copyTagsToSnapshot ? instance.tags : []
      });
    }
    instance.status = "deleting";
    instance.deletingReads = this.deletingReads;
    return ok({ DBInstance: this.instanceView(instance) });
  }

  private listTags(region: string, arn: string): AwsCommandResult {
    const match =
      /^arn:aws:rds:([^:]+):\d{12}:(db|subgrp|pg|snapshot):(.+)$/.exec(arn);
    const tags =
      match?.[1] === region ?
        match[2] === "subgrp" ?
          this.subnetGroups.get(key(region, match[3] ?? ""))?.tags
        : match[2] === "pg" ?
          this.parameterGroups.get(key(region, match[3] ?? ""))?.tags
        : match[2] === "db" ?
          this.instances.get(key(region, match[3] ?? ""))?.tags
        : this.snapshots.get(key(region, match[3] ?? ""))?.tags
      : undefined;
    if (!tags) {
      return serviceError(
        "DBInstanceNotFound",
        "ListTagsForResource",
        `Resource ${arn} not found.`
      );
    }
    return ok({ TagList: tags.map((tag) => ({ ...tag })) });
  }

  private deleteGroup<T>(
    region: string,
    name: string,
    groups: Map<string, T>,
    operation: string,
    notFound: string,
    inUse: string,
    usedBy: (instance: FakeDbInstance) => string
  ): AwsCommandResult {
    if (!groups.has(key(region, name))) {
      return serviceError(notFound, operation, `Group ${name} not found.`);
    }
    const user = this.inRegion(this.instances, region).find(
      (instance) => usedBy(instance).toLowerCase() === name.toLowerCase()
    );
    if (user) {
      return serviceError(
        inUse,
        operation,
        `Group ${name} is in use by DB instance ${user.id}.`
      );
    }
    groups.delete(key(region, name));
    return { code: 0, stdout: "", stderr: "" };
  }

  private describeSnapshots(
    region: string,
    args: readonly string[]
  ): AwsCommandResult {
    this.advance();
    const type = flag(args, "--snapshot-type");
    const id = flag(args, "--db-snapshot-identifier");
    const missing = this.named(
      this.snapshots,
      region,
      id,
      "DescribeDBSnapshots",
      "DBSnapshotNotFound"
    );
    if (missing) return missing;
    return ok({
      DBSnapshots: this.inRegion(this.snapshots, region, id)
        // Every snapshot here is manual, as a final snapshot is.
        .filter(() => type === "" || type === "manual")
        .map((snapshot) => ({
          DBSnapshotIdentifier: snapshot.id,
          DBSnapshotArn: this.arn(snapshot.region, "snapshot", snapshot.id),
          DBInstanceIdentifier: snapshot.instanceId,
          SnapshotType: "manual",
          Status: snapshot.status,
          VpcId: snapshot.vpcId,
          SnapshotCreateTime: snapshot.createTime,
          TagList: snapshot.tags.map((tag) => ({ ...tag }))
        }))
    });
  }

  private deleteSnapshot(region: string, id: string): AwsCommandResult {
    const snapshot = this.snapshots.get(key(region, id));
    if (!snapshot) {
      return serviceError(
        "DBSnapshotNotFound",
        "DeleteDBSnapshot",
        `DBSnapshot ${id} not found.`
      );
    }
    if (snapshot.status !== "available") {
      return serviceError(
        "InvalidDBSnapshotState",
        "DeleteDBSnapshot",
        `Snapshot ${id} is ${snapshot.status}, not available.`
      );
    }
    snapshot.status = "deleting";
    snapshot.deletingReads = this.deletingReads;
    return ok({ DBSnapshot: { DBSnapshotIdentifier: id, Status: "deleted" } });
  }
}
