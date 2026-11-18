import { describe, expect, it } from "vitest";
import { AWS_LOCK_REMOVABLE_AFTER_MS } from "@radius-project/core";
import {
  ACCOUNT,
  addAwsEnvironment,
  appBoundaryArn,
  appResources,
  APPLICATION,
  cleanupConfig,
  createCleanupScenario,
  databaseName,
  environmentId,
  MAIN,
  MAIN_VPC,
  NAMESPACE,
  nextDay,
  recipeTags,
  REPO,
  retryInputs,
  ROLE,
  runSweep,
  runVerify,
  SECOND,
  type CleanupScenario
} from "../../support/aws/cleanup-scenario.js";
import {
  AWS_MAIN_NODE_GROUPS,
  appPathRoot,
  awsEnvironmentFromTag,
  awsStatePackagePrefix,
  findAwsLeftovers,
  LEFTOVER_SETTLE_MS,
  RDS_DELETE_TIMEOUT_MS,
  recipeEnvironment,
  resolveAwsCleanupConfig,
  selectAppBoundaries,
  selectAwsDeployments,
  selectFinalSnapshots,
  selectRecipeDbInstances,
  selectRecipeParameterGroupCandidates,
  selectRecipeSubnetGroupCandidates,
  statePackageName,
  sweepAwsCloudE2E
} from "./aws-cloud-cleanup.js";
import { selectStaleStatePackages } from "./cloud-cleanup.js";
import { AWS_ENVIRONMENT_NAME_PREFIX } from "./fixture-repository.js";

const PREFIX = AWS_ENVIRONMENT_NAME_PREFIX;
const OLD = "radtest-aws-aaaa11112222";
const SECOND_ENV = "radtest-aws-bbbb33334444";
const REGION = MAIN.region;
const SCOPE = { region: REGION, vpcIds: new Set([MAIN_VPC]), prefix: PREFIX };
const ARN = (type: string, name: string, region = REGION) =>
  `arn:aws:rds:${region}:${ACCOUNT}:${type}:${name}`;

const ENV = {
  FIXTURE_REPOSITORY: REPO,
  FIXTURE_APPLICATION: APPLICATION,
  RADIUS_ENVIRONMENT_NAMESPACE: NAMESPACE,
  AWS_ENVIRONMENT_PREFIX: PREFIX,
  MAX_AGE_HOURS: "6",
  GITHUB_RUN_ID: "77",
  AWS_TEST_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/ai-extensions-cloud-e2e`,
  AWS_MAIN_REGION: MAIN.region,
  AWS_MAIN_CLUSTER: MAIN.name,
  AWS_SECOND_REGION: SECOND.region,
  AWS_SECOND_CLUSTER: SECOND.name
};

describe("resolveAwsCleanupConfig", () => {
  const NOW = Date.parse("2026-11-14T02:23:00Z");

  it("reads the scope, the cutoff, and the deploy role the product names", () => {
    expect(resolveAwsCleanupConfig(ENV, NOW)).toEqual(
      cleanupConfig({ clock: { now: NOW } })
    );
    expect(
      resolveAwsCleanupConfig(
        { ...ENV, GITHUB_RUN_ID: "", MAX_AGE_HOURS: "0" },
        NOW
      )
    ).toMatchObject({
      operationId: "cloud-e2e-cleanup-local",
      cutoff: "2026-11-14T02:23:00.000Z"
    });
  });

  it("answers null when no AWS variable is set, so the job skips", () => {
    expect(
      resolveAwsCleanupConfig(
        {
          ...ENV,
          AWS_TEST_ROLE_ARN: " ",
          AWS_MAIN_REGION: "",
          AWS_MAIN_CLUSTER: undefined,
          AWS_SECOND_REGION: "",
          AWS_SECOND_CLUSTER: ""
        },
        NOW
      )
    ).toBeNull();
  });

  it.each([
    [
      { AWS_SECOND_CLUSTER: "" },
      "must be set together. Missing: AWS_SECOND_CLUSTER"
    ],
    [{ AWS_TEST_ROLE_ARN: "arn:aws:iam::1:user/x" }, "must be an IAM role ARN"],
    [
      { AWS_TEST_ROLE_ARN: "arn:aws-cn:iam::123456789012:role/x" },
      "in the aws partition"
    ],
    [{ AWS_MAIN_REGION: "us-west-2" }, "other than us-west-2"],
    [
      { AWS_SECOND_REGION: "useast" },
      "AWS_SECOND_REGION must be an AWS region"
    ],
    [{ AWS_MAIN_CLUSTER: "-bad" }, "not a valid EKS cluster name"],
    [
      { AWS_SECOND_REGION: MAIN.region, AWS_SECOND_CLUSTER: MAIN.name },
      "must be different"
    ],
    [
      { FIXTURE_REPOSITORY: "fixture" },
      "FIXTURE_REPOSITORY must be owner/name"
    ],
    [{ AWS_ENVIRONMENT_PREFIX: "radtest-" }, "AWS environment prefix"],
    [{ MAX_AGE_HOURS: "6h" }, "MAX_AGE_HOURS must be a whole number"],
    [{ MAX_AGE_HOURS: "721" }, "MAX_AGE_HOURS must be a whole number"],
    [
      { FIXTURE_APPLICATION: "" },
      "FIXTURE_APPLICATION and RADIUS_ENVIRONMENT_NAMESPACE"
    ]
  ])("refuses %j", (change, message) => {
    expect(() => resolveAwsCleanupConfig({ ...ENV, ...change }, NOW)).toThrow(
      message
    );
  });
});

describe("AWS cleanup selectors", () => {
  it("selects only managed policies under the fixture repository's app path", () => {
    const scope = {
      accountId: ACCOUNT,
      repositoryId: 1361595003,
      prefix: "radtest-aws-"
    };
    const policy = (path: string, name: string, account = ACCOUNT) => ({
      PolicyName: name,
      Path: path,
      Arn: `arn:aws:iam::${account}:policy${path}${name}`,
      CreateDate: "2026-11-01T00:00:00Z"
    });
    const root = appPathRoot(scope.repositoryId);
    expect(root).toBe("/radius/apps/1361595003/");
    const mine = policy(`${root}radtest-aws-1/`, "b-1");
    expect(
      selectAppBoundaries(
        {
          Policies: [
            mine,
            policy("/radius/apps/42/radtest-aws-1/", "b-42"),
            policy("/radius/apps/13615950030/radtest-aws-1/", "b-prefix"),
            policy("/", "radius-lock-deploy"),
            policy(`${root}radtest-aws-1/`, "b-other", "999999999999"),
            { ...mine, Arn: `${mine.Arn}-renamed` },
            { Path: root, Arn: "" }
          ]
        },
        scope
      )
    ).toEqual([
      {
        arn: mine.Arn,
        name: "b-1",
        path: `${root}radtest-aws-1/`,
        createdAt: "2026-11-01T00:00:00Z"
      }
    ]);
    expect(() => selectAppBoundaries({}, scope)).toThrow(
      "aws iam list-policies did not include a Policies array."
    );
  });

  function instance(
    id: string,
    options: {
      region?: string;
      vpc?: string;
      tags?: Array<{ Key: string; Value: string }>;
    } = {}
  ) {
    return {
      DBInstanceIdentifier: id,
      DBInstanceArn: ARN("db", id, options.region),
      DBInstanceStatus: "available",
      DBSubnetGroup: { VpcId: options.vpc ?? MAIN_VPC },
      TagList: options.tags ?? recipeTags(OLD)
    };
  }

  it("reads the environment from the tag the recipe writes", () => {
    expect(awsEnvironmentFromTag(environmentId(OLD), PREFIX)).toBe(OLD);
    expect(
      awsEnvironmentFromTag(
        `/planes/radius/local/resourceGroups/x/providers/Applications.Core/Environments/${OLD.toUpperCase()}`,
        PREFIX
      )
    ).toBe(OLD);
    for (const value of [
      environmentId("radtest-abc123def456"),
      environmentId("prod"),
      `${environmentId(OLD)}/extra`,
      OLD,
      42
    ])
      expect(awsEnvironmentFromTag(value, PREFIX)).toBeNull();
  });

  it("never names an environment for a resource Radius's cleanup owns", () => {
    expect(
      recipeEnvironment(
        [...recipeTags(OLD), { Key: "RadiusCreationTimestamp", Value: "1" }],
        PREFIX
      )
    ).toBeNull();
    expect(recipeEnvironment(recipeTags(OLD), PREFIX)).toBe(OLD);
    expect(recipeEnvironment("not tags", PREFIX)).toBeNull();
  });

  it("selects only recipe instances of an AWS test environment in a cluster VPC", () => {
    const payload = {
      DBInstances: [
        instance("mysql-ours"),
        instance("mysql-west", { region: "us-west-2" }),
        instance("mysql-radius", {
          tags: [
            ...recipeTags(OLD),
            { Key: "RadiusCreationTimestamp", Value: "1731000000" }
          ]
        }),
        instance("postgres-ours"),
        instance("rds-mysql-ours"),
        instance("mysql-othervpc", { vpc: "vpc-radius" }),
        instance("mysql-untagged", { tags: [] }),
        instance("mysql-azure", { tags: recipeTags("radtest-abc123def456") }),
        "not an instance"
      ]
    };
    expect(selectRecipeDbInstances(payload, SCOPE)).toEqual([
      { id: "mysql-ours", status: "available", environment: OLD }
    ]);
    expect(() => selectRecipeDbInstances({}, SCOPE)).toThrow(
      "did not include a DBInstances array"
    );
  });

  it("selects recipe groups by name, region, and, for subnet groups, VPC", () => {
    const subnets = {
      DBSubnetGroups: [
        {
          DBSubnetGroupName: "mysql-a",
          DBSubnetGroupArn: ARN("subgrp", "mysql-a"),
          VpcId: MAIN_VPC
        },
        {
          DBSubnetGroupName: "mysql-b",
          DBSubnetGroupArn: ARN("subgrp", "mysql-b"),
          VpcId: "vpc-radius"
        },
        {
          DBSubnetGroupName: "mysql-c",
          DBSubnetGroupArn: ARN("subgrp", "mysql-c", "us-west-2"),
          VpcId: MAIN_VPC
        },
        {
          DBSubnetGroupName: "default",
          DBSubnetGroupArn: ARN("subgrp", "default"),
          VpcId: MAIN_VPC
        }
      ]
    };
    expect(selectRecipeSubnetGroupCandidates(subnets, SCOPE)).toEqual([
      { name: "mysql-a", arn: ARN("subgrp", "mysql-a") }
    ]);
    const parameters = {
      DBParameterGroups: [
        {
          DBParameterGroupName: "mysql-a",
          DBParameterGroupArn: ARN("pg", "mysql-a")
        },
        {
          DBParameterGroupName: "mysql-c",
          DBParameterGroupArn: ARN("pg", "mysql-c", "us-west-2")
        },
        {
          DBParameterGroupName: "default.mysql8.4",
          DBParameterGroupArn: ARN("pg", "default.mysql8.4")
        }
      ]
    };
    expect(selectRecipeParameterGroupCandidates(parameters, SCOPE)).toEqual([
      { name: "mysql-a", arn: ARN("pg", "mysql-a") }
    ]);
  });

  it("deletes tagged final snapshots and only reports untagged ones", () => {
    const snapshot = (
      id: string,
      tags: Array<{ Key: string; Value: string }>,
      extra: Record<string, unknown> = {}
    ) => ({
      DBSnapshotIdentifier: id,
      DBSnapshotArn: ARN("snapshot", id),
      SnapshotType: "manual",
      Status: "available",
      VpcId: MAIN_VPC,
      TagList: tags,
      ...extra
    });
    expect(
      selectFinalSnapshots(
        {
          DBSnapshots: [
            snapshot("rds-snapshot-ours", recipeTags(OLD)),
            snapshot("rds-snapshot-untagged", []),
            snapshot("rds-snapshot-radius", [
              { Key: "RadiusCreationTimestamp", Value: "1" }
            ]),
            snapshot("rds-snapshot-azure", recipeTags("radtest-abc123def456")),
            snapshot("rds-snapshot-auto", recipeTags(OLD), {
              SnapshotType: "automated"
            }),
            snapshot("rds-snapshot-vpc", [], { VpcId: "vpc-radius" }),
            snapshot("rds-snapshot-west", [], {
              DBSnapshotArn: ARN("snapshot", "w", "us-west-2")
            }),
            snapshot("manual-backup", recipeTags(OLD))
          ]
        },
        SCOPE
      )
    ).toEqual({
      tagged: [
        { id: "rds-snapshot-ours", status: "available", environment: OLD }
      ],
      untagged: ["rds-snapshot-untagged"]
    });
  });

  it("selects AWS deployment records across pages", () => {
    expect(
      selectAwsDeployments(
        [
          [
            { id: 1, environment: OLD, created_at: "a" },
            { id: 2, environment: "radtest-abc123def456" },
            { id: "3", environment: OLD }
          ],
          { id: 4, environment: OLD.toUpperCase(), created_at: "b" }
        ],
        PREFIX
      )
    ).toEqual([
      { id: 1, environment: OLD, createdAt: "a" },
      { id: 4, environment: OLD, createdAt: "b" }
    ]);
    expect(() => selectAwsDeployments({}, PREFIX)).toThrow("JSON array");
  });

  it("names state packages the way the stale-package selector matches them", () => {
    const config = cleanupConfig({ clock: { now: 0 } });
    const name = statePackageName(REPO, OLD);
    expect(name.startsWith(awsStatePackagePrefix(config))).toBe(true);
    expect(
      selectStaleStatePackages(
        [[{ name, updated_at: "2026-01-01T00:00:00Z" }]],
        awsStatePackagePrefix(config),
        "2026-02-01T00:00:00Z"
      )
    ).toEqual([name]);
  });
});

function writes(s: CleanupScenario): string[] {
  return s.outside.calls
    .filter((call) => call.write)
    .map((call) =>
      call.service === "aws" ? call.args.slice(0, 2).join(" ") : call.command
    );
}

async function twoEnvironments(): Promise<CleanupScenario> {
  const s = createCleanupScenario();
  await addAwsEnvironment(s, OLD, { deployed: true });
  await addAwsEnvironment(s, SECOND_ENV, { cluster: "second" });
  return s;
}

describe("sweepAwsCloudE2E", () => {
  it("deletes each stale environment's app, then its leftovers, then its access and GitHub state", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    const report = await runSweep(s);

    expect(report.failures).toEqual([]);
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
    expect(retryInputs(s, OLD)).toEqual([]);
    expect(retryInputs(s, SECOND_ENV)).toEqual([]);
    expect(s.deployments).toEqual([]);
    expect(s.aws.role(ROLE)).toBeDefined();
    expect(s.aws.oidcProviders.size).toBe(1);
    const order = writes(s);
    const lastSweep = Math.max(
      order.lastIndexOf("rds delete-db-parameter-group"),
      order.lastIndexOf(`kubectl delete namespace ${SECOND.name}`)
    );
    expect(order.indexOf(`dispatch delete-application ${OLD}`)).toBe(0);
    expect(lastSweep).toBeLessThan(order.indexOf("DELETE deployment 1000"));
    expect(order.slice(lastSweep + 1)).toEqual([
      "DELETE deployment 1000",
      `DELETE package ${statePackageName(REPO, OLD)}`,
      "iam create-policy",
      "iam delete-role-policy",
      "iam update-assume-role-policy",
      // The app boundary, then the access entry.
      "iam delete-policy",
      "eks delete-access-entry",
      `DELETE environment ${OLD}`,
      "iam delete-policy",
      `DELETE package ${statePackageName(REPO, SECOND_ENV)}`,
      "iam create-policy",
      "iam delete-role-policy",
      "iam update-assume-role-policy",
      "iam delete-policy",
      "eks delete-access-entry",
      `DELETE environment ${SECOND_ENV}`,
      "iam delete-policy"
    ]);
    const instanceDelete = s.outside.calls.find(
      (call) => call.command === "rds delete-db-instance"
    );
    expect(instanceDelete?.args).toContain("--skip-final-snapshot");
    expect(instanceDelete?.args).not.toContain(
      "--final-db-snapshot-identifier"
    );
    expect(s.aws.rds.snapshot().snapshots).toEqual([]);
  });

  it("deletes the final snapshot Cloud Control took when the app delete removed the database", async () => {
    const s = await twoEnvironments();
    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    expect(report.done).toContain(
      `Deleted RDS DB snapshot rds-snapshot-${databaseName(OLD)} in ${REGION}`
    );
    expect(writes(s)).not.toContain("rds delete-db-instance");
  });

  it("keeps everything a retry needs when the app delete fails, and finishes the next day", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "fail");
    const before = retryInputs(s, OLD);
    const report = await runSweep(s);

    expect(report.failures).toEqual([
      `Deleting the Radius application in ${OLD} failed: delete-application.yml run 9 ended failure.`
    ]);
    expect(retryInputs(s, OLD)).toEqual(before);
    expect(appResources(s, OLD)).toEqual([]);
    expect(retryInputs(s, SECOND_ENV)).toEqual([]);
    expect(s.deployments.map((item) => item.environment)).toEqual([OLD]);

    nextDay(s);
    s.appDelete.clear();
    expect((await runSweep(s)).failures).toEqual([]);
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
  });

  it("keeps a newer environment and everything it made", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, OLD, { deployed: true, ageHours: 1 });
    const before = [...retryInputs(s, OLD), ...appResources(s, OLD)];
    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    expect([...retryInputs(s, OLD), ...appResources(s, OLD)]).toEqual(before);
    expect(
      s.kube.namespaceExists(`${MAIN.region}/${MAIN.name}`, NAMESPACE)
    ).toBe(true);
    expect(writes(s)).toEqual([]);
    expect((await runVerify(s)).findings).toEqual(
      expect.arrayContaining([
        `RDS DB instance ${databaseName(OLD)} (available) in ${REGION}`,
        `Deployment ${NAMESPACE}/web on cluster ${MAIN.name}`,
        `namespace ${NAMESPACE} on cluster ${MAIN.name}`
      ])
    );
  });

  it("deletes everything at max_age_hours=0", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, OLD, { deployed: true, ageHours: 1 });
    expect((await runSweep(s, 0)).failures).toEqual([]);
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
  });

  it("never deletes resources that only look like the suite's", async () => {
    const s = await twoEnvironments();
    const rds = s.aws.rds;
    rds.addInstance({
      id: "mysql-radius",
      region: REGION,
      vpcId: MAIN_VPC,
      subnetGroup: "default",
      parameterGroup: "default.mysql8.4",
      tags: [...recipeTags(OLD), { Key: "RadiusCreationTimestamp", Value: "1" }]
    });
    rds.addRecipeDatabase({
      name: "mysql-othervpc",
      region: REGION,
      vpcId: "vpc-radius",
      tags: recipeTags(OLD)
    });
    rds.addRecipeDatabase({
      name: "mysql-azure",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: recipeTags("radtest-abc123def456")
    });
    rds.addRecipeDatabase({
      name: "mysql-untagged",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: []
    });
    rds.addRecipeDatabase({
      name: "aurora-ours",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: recipeTags(OLD)
    });
    rds.addSnapshot({
      id: "rds-snapshot-untagged",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: []
    });
    s.aws.addCluster("radius-cluster", "us-west-2", "API", "vpc-west");
    rds.addRecipeDatabase({
      name: "mysql-west",
      region: "us-west-2",
      vpcId: "vpc-west",
      tags: recipeTags(OLD)
    });
    s.kube.addWorkload(`${MAIN.region}/${MAIN.name}`, {
      kind: "Deployment",
      name: "azure-app",
      namespace: "default",
      labels: {
        "radapp.io/environment": "radtest-abc123def456",
        "radapp.io/application": APPLICATION
      },
      creationTimestamp: "2026-01-01T00:00:00Z"
    });
    const decoys = rds.snapshot();

    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([
      `RDS DB snapshot rds-snapshot-untagged in ${REGION} has no environment tag, so the sweep kept it. See the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md.`
    ]);
    const after = rds.snapshot();
    expect(after.instances).toEqual(
      decoys.instances.filter((item) => item.id !== databaseName(OLD))
    );
    expect(after.subnetGroups).toEqual(
      decoys.subnetGroups.filter((item) => !item.endsWith(databaseName(OLD)))
    );
    expect(after.parameterGroups).toEqual(
      decoys.parameterGroups.filter((item) => !item.endsWith(databaseName(OLD)))
    );
    expect(after.snapshots).toEqual([
      { region: REGION, id: "rds-snapshot-untagged", status: "available" }
    ]);
    expect(s.kube.snapshot()).toEqual([
      `${MAIN.region}/${MAIN.name} Deployment default/azure-app`
    ]);
    expect(
      s.outside.calls.some((call) => call.args.includes("us-west-2"))
    ).toBe(false);
  });

  it("reclaims an orphan whose environment is gone, and keeps a young orphan package", async () => {
    const s = createCleanupScenario();
    const orphan = "radtest-aws-cccc55556666";
    s.aws.rds.addRecipeDatabase({
      name: databaseName(orphan),
      region: SECOND.region,
      vpcId: "vpc-second",
      tags: recipeTags(orphan)
    });
    s.deployments.push({
      id: 7,
      environment: orphan,
      created_at: "2026-11-01T00:00:00Z"
    });
    s.deployments.push({
      id: 8,
      environment: orphan,
      created_at: "2026-11-14T01:00:00Z"
    });
    const old = statePackageName(REPO, orphan);
    const young = statePackageName(REPO, "radtest-aws-dddd77778888");
    s.packages.set(old, {
      name: old,
      visibility: "private",
      repository: REPO,
      updated_at: "2026-11-01T00:00:00Z"
    });
    s.packages.set(young, {
      name: young,
      visibility: "private",
      repository: REPO,
      updated_at: "2026-11-14T01:00:00Z"
    });

    expect((await runSweep(s)).failures).toEqual([]);
    expect(s.aws.rds.snapshot()).toEqual({
      instances: [],
      subnetGroups: [],
      parameterGroups: [],
      snapshots: []
    });
    expect(s.deployments.map((item) => item.id)).toEqual([8]);
    expect([...s.packages.keys()]).toEqual([young]);
  });

  it("waits for an instance RDS is already deleting instead of deleting it again", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.rds.instances.get(`${REGION}:${databaseName(OLD)}`)!.status =
      "deleting";
    s.aws.rds.instances.get(`${REGION}:${databaseName(OLD)}`)!.deletingReads =
      4;
    expect((await runSweep(s)).failures).toEqual([]);
    expect(writes(s)).not.toContain("rds delete-db-instance");
    expect(appResources(s, OLD)).toEqual([]);
  });

  it("waits for a final snapshot that is still being created", async () => {
    const s = await twoEnvironments();
    s.aws.rds.creatingReads = 3;
    s.appDelete.set(OLD, "leave");
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-x",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: recipeTags(OLD),
      status: "creating"
    });
    expect((await runSweep(s)).failures).toEqual([]);
    expect(s.aws.rds.snapshot().snapshots).toEqual([]);
  });

  it.each([
    ["deleting", "was still being deleted after 20 minutes"],
    ["creating", "was still being created after 20 minutes"],
    ["failed", "is failed, and only an available snapshot can be deleted"]
  ])(
    "keeps the environment when a final snapshot stays %s",
    async (status, message) => {
      const s = await twoEnvironments();
      s.aws.rds.creatingReads = 1_000_000;
      s.aws.rds.deletingReads = 1_000_000;
      s.aws.rds.addSnapshot({
        id: "rds-snapshot-x",
        region: REGION,
        vpcId: MAIN_VPC,
        tags: recipeTags(OLD),
        status
      });
      const report = await runSweep(s);
      expect(report.failures).toContain(
        `RDS DB snapshot rds-snapshot-x in ${REGION} ${message}.`
      );
      expect(retryInputs(s, OLD)).toHaveLength(6);
      expect(retryInputs(s, SECOND_ENV)).toHaveLength(5);
    }
  );

  it("waits for a deleted snapshot to disappear before checking what is left", async () => {
    const s = await twoEnvironments();
    // RDS takes a while to finish a snapshot delete it accepted.
    s.aws.rds.deletingReads = 8;
    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    expect(s.aws.rds.snapshot().snapshots).toEqual([]);
    expect(retryInputs(s, OLD)).toEqual([]);
  });

  it("waits out a snapshot an earlier run already started deleting", async () => {
    const s = await twoEnvironments();
    s.aws.rds.deletingReads = 8;
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-x",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: recipeTags(OLD),
      status: "deleting"
    });
    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    expect(
      s.outside.calls.filter(
        (call) =>
          call.command === "rds delete-db-snapshot" &&
          call.args.includes("rds-snapshot-x")
      )
    ).toEqual([]);
    expect(retryInputs(s, OLD)).toEqual([]);
  });

  it.each([
    ["delete-db-subnet-group", "describe-db-subnet-groups", "subnet"],
    ["delete-db-parameter-group", "describe-db-parameter-groups", "parameter"]
  ])(
    "waits for a %s to show as gone, and keeps the environment if it never does",
    async (verb, describe, kind) => {
      const s = await twoEnvironments();
      s.appDelete.set(OLD, "leave");
      // A read that still lists the group just after its delete.
      let stale = 3;
      const run = s.aws.run.bind(s.aws);
      let deleted = false;
      s.aws.run = (args) => {
        if (args[1] === verb) deleted = true;
        if (args[1] === describe && deleted && stale > 0) {
          stale -= 1;
          return run(
            args.filter(
              (arg, index, all) =>
                !arg.endsWith("-name") && !all[index - 1]?.endsWith("-name")
            )
          );
        }
        return run(args);
      };
      expect((await runSweep(s)).failures).toEqual([]);
      expect(retryInputs(s, OLD)).toEqual([]);

      const t = await twoEnvironments();
      t.appDelete.set(OLD, "leave");
      const runT = t.aws.run.bind(t.aws);
      t.aws.run = (args) =>
        args[1] === verb ? { code: 0, stdout: "", stderr: "" } : runT(args);
      const report = await runSweep(t);
      expect(report.failures).toContain(
        `RDS DB ${kind} group ${databaseName(OLD)} in ${REGION} was still there after 5 minutes.`
      );
      expect(retryInputs(t, OLD)).toHaveLength(6);
    }
  );

  it("keeps every environment when an instance outlives the delete timeout", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.rds.deletingReads = 1_000_000;
    const start = s.clock.now;
    const report = await runSweep(s);
    expect(s.clock.now - start).toBeGreaterThanOrEqual(RDS_DELETE_TIMEOUT_MS);
    expect(report.failures).toContain(
      `RDS DB instance ${databaseName(OLD)} in ${REGION} was still there after 40 minutes.`
    );
    expect(writes(s)).not.toContain("rds delete-db-subnet-group");
    expect(retryInputs(s, OLD)).toHaveLength(6);
    expect(retryInputs(s, SECOND_ENV)).toHaveLength(5);
  });

  it.each([
    "rds describe-db-instances",
    "rds list-tags-for-resource",
    "rds describe-db-snapshots",
    "eks describe-cluster"
  ])("stops the RDS sweep without deleting when %s fails", async (command) => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.refuseOnce(command, "AccessDenied");
    const report = await runSweep(s);
    expect(
      report.failures.some((line) =>
        line.startsWith("RDS sweep stopped without deleting further")
      )
    ).toBe(true);
    expect(writes(s).filter((line) => line.startsWith("rds "))).toEqual([]);
    expect(retryInputs(s, OLD)).toHaveLength(6);
  });

  it("refuses an RDS delete AWS rejects, and keeps the environment", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.refuseOnce("rds delete-db-instance", "AccessDenied");
    const report = await runSweep(s);
    expect(report.failures[0]).toMatch(
      /^Deleting RDS DB instance mysql-aaaa11112222 in us-east-2: .*\(AccessDenied\)/
    );
    expect(retryInputs(s, OLD)).toHaveLength(6);
  });

  it("doesn't wait on an instance whose delete AWS refused", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.refuseOnce("rds delete-db-instance", "AccessDenied");
    const start = s.clock.now;
    const report = await runSweep(s);
    expect(report.failures).toHaveLength(1);
    expect(s.clock.now - start).toBeLessThan(60 * 1000);
    expect(
      s.outside.calls.filter(
        (call) =>
          call.command === "rds describe-db-instances" &&
          call.args.includes("--db-instance-identifier")
      )
    ).toEqual([]);
  });

  it("fails on an instance RDS won't delete in its state, and waits on one it is already deleting", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    const instance = s.aws.rds.instances.get(`${REGION}:${databaseName(OLD)}`)!;
    instance.status = "creating";
    const run = s.aws.run.bind(s.aws);
    s.aws.run = (args) =>
      args[1] === "delete-db-instance" ?
        {
          code: 254,
          stdout: "",
          stderr:
            "An error occurred (InvalidDBInstanceState) when calling the DeleteDBInstance operation: Instance is creating"
        }
      : run(args);
    const start = s.clock.now;
    const report = await runSweep(s);
    expect(report.failures[0]).toContain(
      `Deleting RDS DB instance ${databaseName(OLD)} in ${REGION}: An error occurred (InvalidDBInstanceState)`
    );
    expect(s.clock.now - start).toBeLessThan(60 * 1000);
    expect(retryInputs(s, OLD)).toHaveLength(6);

    // The app delete started deleting it after the sweep read the list.
    const t = await twoEnvironments();
    t.appDelete.set(OLD, "leave");
    const racing = t.aws.rds.instances.get(`${REGION}:${databaseName(OLD)}`)!;
    const runT = t.aws.run.bind(t.aws);
    t.aws.run = (args) => {
      if (args[1] === "delete-db-instance") racing.status = "deleting";
      return runT(args);
    };
    expect((await runSweep(t)).failures).toEqual([]);
    expect(appResources(t, OLD)).toEqual([]);
  });

  it("reports a group AWS refuses to delete", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.refuseOnce(
      "rds delete-db-subnet-group",
      "InvalidDBSubnetGroupStateFault"
    );
    const report = await runSweep(s);
    expect(report.failures[0]).toContain(
      "Deleting RDS DB subnet group mysql-aaaa11112222"
    );
    expect(retryInputs(s, OLD)).toHaveLength(6);
    expect(retryInputs(s, SECOND_ENV)).toHaveLength(5);
  });

  it("keeps an environment whose workloads can't be deleted", async () => {
    const s = await twoEnvironments();
    s.kube.addWorkload(`${SECOND.region}/${SECOND.name}`, {
      kind: "Deployment",
      name: "web",
      namespace: NAMESPACE,
      labels: {
        "radapp.io/environment": OLD,
        "radapp.io/application": APPLICATION
      },
      creationTimestamp: "2026-11-01T00:00:00Z"
    });
    s.ports.kubernetes.deleteWorkload = async () => {
      throw new Error("forbidden");
    };
    const report = await runSweep(s);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        `Deleting Deployment ${NAMESPACE}/web on cluster ${SECOND.name} (${SECOND.region}): forbidden`,
        `Leaked workloads on cluster ${SECOND.name} (${SECOND.region}) were still there after deletion.`
      ])
    );
    expect(retryInputs(s, OLD)).toHaveLength(6);
  });

  it.each([
    ["deleteNamespace", "Deleting namespace default-cloud-e2e on cluster"],
    ["listWorkloads", "Workload sweep of cluster"]
  ] as const)(
    "keeps every environment when %s fails",
    async (method, message) => {
      const s = await twoEnvironments();
      s.ports.kubernetes[method] = async () => {
        throw new Error("timeout");
      };
      const report = await runSweep(s);
      expect(report.failures.some((line) => line.startsWith(message))).toBe(
        true
      );
      expect(retryInputs(s, OLD)).toHaveLength(6);
    }
  );

  it("keeps an environment whose namespace stays terminating", async () => {
    const s = await twoEnvironments();
    s.ports.kubernetes.deleteNamespace = async () => {};
    const report = await runSweep(s);
    expect(report.failures).toContain(
      `Namespace ${NAMESPACE} on cluster ${MAIN.name} (${MAIN.region}) is still terminating.`
    );
    expect(retryInputs(s, OLD)).toHaveLength(6);
  });

  it("keeps an environment something of which is left after the sweep", async () => {
    const s = await twoEnvironments();
    const tags = recipeTags(OLD);
    // A group without the recipe's name, so the sweep can't delete it, but
    // still tagged for the environment, as the leftover check reads tags.
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-stuck",
      region: REGION,
      vpcId: MAIN_VPC,
      tags,
      status: "available"
    });
    s.aws.refuseOnce("rds delete-db-snapshot", "InvalidDBSnapshotState");
    const report = await runSweep(s);
    expect(report.failures.some((line) => line.includes("rds-snapshot"))).toBe(
      true
    );
    expect(retryInputs(s, OLD)).toHaveLength(6);
  });

  it("keeps the GitHub environment when the leftover check finds something", async () => {
    const s = await twoEnvironments();
    let reads = 0;
    const list = s.ports.kubernetes.listWorkloads;
    s.ports.kubernetes.listWorkloads = async (cluster) => {
      reads += 1;
      // The check after the sweep sees a workload the sweep did not.
      if (reads === 3)
        return {
          items: [
            {
              kind: "Job",
              metadata: {
                name: "probe",
                namespace: NAMESPACE,
                labels: {
                  "radapp.io/environment": OLD,
                  "radapp.io/application": APPLICATION
                },
                creationTimestamp: "2026-11-14T02:00:00Z"
              }
            }
          ]
        };
      return list(cluster);
    };
    const report = await runSweep(s);
    expect(report.failures).toEqual([
      `${OLD} still has Job ${NAMESPACE}/probe on cluster ${MAIN.name}, so it keeps its access and GitHub state for a retry.`
    ]);
    expect(retryInputs(s, OLD)).toHaveLength(6);
    expect(retryInputs(s, SECOND_ENV)).toEqual([]);
  });

  it.each([
    [{ AWS_ROLE_ARN: "" }, "has no AWS_ROLE_ARN"],
    [
      { AWS_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/someone-else` },
      "not the fixture's deploy role"
    ],
    [
      { AWS_ROLE_ARN: `arn:aws:iam::999999999999:role/${ROLE}` },
      "not the fixture's deploy role"
    ],
    [
      { AWS_EKS_CLUSTER_NAME: "radius-cluster" },
      "is not one of the Cloud E2E clusters"
    ],
    [{ AWS_REGION: "us-west-2" }, "is not one of the Cloud E2E clusters"]
  ])(
    "touches nothing of an environment with variables %j",
    async (change, message) => {
      const s = await twoEnvironments();
      const variables = s.github.environment(OLD)!.variables;
      for (const [name, value] of Object.entries(change))
        variables.set(name, value);
      const before = retryInputs(s, OLD);
      const report = await runSweep(s);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]).toContain(message);
      expect(writes(s)).not.toContain(`dispatch delete-application ${OLD}`);
      expect(retryInputs(s, OLD)).toEqual(before);
      expect(retryInputs(s, SECOND_ENV)).toEqual([]);
    }
  );

  it("keeps an environment whose variables can't be read", async () => {
    const s = await twoEnvironments();
    s.ports.github.readEnvironmentVariables = async () => {
      throw new Error("HTTP 502");
    };
    const report = await runSweep(s);
    expect(report.failures[0]).toBe(
      `Could not read the variables of GitHub environment ${OLD}: HTTP 502`
    );
    expect(retryInputs(s, OLD)).toHaveLength(6);
  });

  it("deletes nothing but scales down when the environments can't be listed", async () => {
    const s = await twoEnvironments();
    s.aws.addNodegroup(MAIN.region, MAIN.name, "default", {
      minSize: 1,
      maxSize: 2,
      desiredSize: 2
    });
    s.ports.github.listEnvironments = async () => {
      throw new Error("HTTP 401");
    };
    const report = await runSweep(s);
    expect(report.failures).toEqual([
      "Could not list the fixture's GitHub environments: HTTP 401. No environment, RDS resource, or workload was deleted."
    ]);
    expect(writes(s)).toEqual(["eks update-nodegroup-config"]);
  });

  it("changes nothing in an account other than the test role's", async () => {
    const s = await twoEnvironments();
    const report = await sweepAwsCloudE2E(
      { ...cleanupConfig(s), accountId: "999999999999" },
      s.ports
    );
    expect(report.failures).toEqual([
      `AWS is signed in to account ${ACCOUNT}, not 999999999999. Nothing was changed.`
    ]);
    s.aws.sessionExpired = true;
    expect((await runSweep(s)).failures[0]).toMatch(
      /^Could not read the AWS account: .*ExpiredToken/
    );
    expect(writes(s)).toEqual([]);
  });

  it("keeps the environments when deployment records can't be listed or deleted", async () => {
    const s = await twoEnvironments();
    s.ports.github.listDeployments = async () => {
      throw new Error("HTTP 500");
    };
    const report = await runSweep(s);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "Could not list deployment records: HTTP 500",
        `${OLD} keeps its access and GitHub state, because its deployment records could not be listed.`
      ])
    );
    expect(retryInputs(s, OLD).length).toBeGreaterThanOrEqual(5);

    const t = await twoEnvironments();
    t.ports.github.deleteDeployment = async () => {
      throw new Error("HTTP 403");
    };
    const failed = await runSweep(t);
    expect(failed.failures[0]).toBe(
      `${OLD} keeps its access and GitHub environment, because removing its deployment records or state failed: HTTP 403`
    );
    expect(retryInputs(t, OLD).filter((item) => item !== "state")).toHaveLength(
      5
    );
  });

  it("tries a removal that couldn't check something once more", async () => {
    const s = await twoEnvironments();
    s.aws.refuseOnce("eks describe-access-entry", "ServerException");
    expect((await runSweep(s)).failures).toEqual([]);
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
  });

  it("fails, naming what is left, when the removal keeps something it couldn't check twice", async () => {
    const s = await twoEnvironments();
    let refusals = 0;
    const run = s.aws.run.bind(s.aws);
    s.aws.run = (args) => {
      if (args[1] === "describe-access-entry" && args.includes(MAIN.name)) {
        refusals += 1;
        return {
          code: 254,
          stdout: "",
          stderr:
            "An error occurred (ServerException) when calling the DescribeAccessEntry operation"
        };
      }
      return run(args);
    };
    const report = await runSweep(s);
    expect(refusals).toBe(2);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(
      new RegExp(
        `^${OLD}: Kept the access entry .*couldn't read it.*run: aws eks delete-access-entry --cluster-name ${MAIN.name}`
      )
    );
    // As the product's delete does: a retry could not sign in to delete the
    // app again, so the environment goes and the leftover check names the
    // entry until someone removes it.
    expect(retryInputs(s, OLD)).toEqual(["access entry"]);
    s.aws.run = run;
    expect((await runVerify(s)).findings).toEqual([
      `access entry for ${ROLE} on cluster ${MAIN.name}`
    ]);
  });

  it("keeps the GitHub environment when the removal fails, naming the runbook", async () => {
    const s = await twoEnvironments();
    s.aws.refuseOnce("iam update-assume-role-policy", "AccessDenied");
    const report = await runSweep(s);
    expect(report.failures[0]).toContain(
      `Removing ${OLD} from deploy role ${ROLE} failed, so its GitHub environment was kept`
    );
    expect(report.failures[0]).toContain("docs/eng/CLOUD_E2E_RUNBOOK.md");
    expect(retryInputs(s, OLD)).toContain("GitHub environment");
  });

  it("reports a GitHub environment the removal could not delete", async () => {
    const s = await twoEnvironments();
    s.ports.github.deleteEnvironment = async () => {
      throw new Error("HTTP 403: needs Administration write");
    };
    const report = await runSweep(s);
    expect(report.failures[0]).toBe(
      `Removed ${OLD}'s access, but kept its GitHub environment: HTTP 403: needs Administration write. The next run tries again. See the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md.`
    );
  });

  it("reports a removal that throws", async () => {
    const s = await twoEnvironments();
    s.ports.removeAccess = async () => {
      throw new Error("boom");
    };
    expect((await runSweep(s)).failures[0]).toContain(
      "failed, so its GitHub environment was kept: boom"
    );
  });

  it("waits out a young lock by the product's 10-minute rule, then removes it", async () => {
    const s = await twoEnvironments();
    s.aws.run([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`,
      "--description",
      "not a radius holder",
      "--policy-document",
      "{}"
    ]);
    const lock = s.aws.locks()[0]!;
    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    expect(report.done).toContain(
      `Removed the abandoned lock ${lock.PolicyId} on ${ROLE}`
    );
    const removedAt = Date.parse(lock.CreateDate) + AWS_LOCK_REMOVABLE_AFTER_MS;
    expect(s.clock.now).toBeGreaterThanOrEqual(removedAt);
    expect(s.aws.locks()).toEqual([]);
  });

  it("stops the removal when an abandoned lock can't be removed", async () => {
    const s = await twoEnvironments();
    s.aws.run([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`,
      "--policy-document",
      "{}"
    ]);
    s.clock.now += AWS_LOCK_REMOVABLE_AFTER_MS;
    const run = s.aws.run.bind(s.aws);
    s.aws.run = (args) =>
      args[1] === "delete-policy" ?
        {
          code: 254,
          stdout: "",
          stderr:
            "An error occurred (AccessDenied) when calling the DeletePolicy operation"
        }
      : run(args);
    const report = await runSweep(s);
    expect(report.failures[0]).toContain("Could not remove the abandoned lock");
    expect(retryInputs(s, OLD)).toContain("GitHub environment");
  });

  it.each([
    [2 * 60 * 1000, "is less than 10 minutes old, so the sweep kept it"],
    [AWS_LOCK_REMOVABLE_AFTER_MS, null]
  ])(
    "removes a lock left with nothing to clean only once it is old (%i ms)",
    async (age, failure) => {
      const s = createCleanupScenario();
      s.aws.run([
        "iam",
        "create-policy",
        "--policy-name",
        `radius-lock-${ROLE}`,
        "--description",
        JSON.stringify({
          radius: "deploy-identity-lock",
          repo: REPO,
          environment: OLD,
          action: "delete",
          operationId: "op-1"
        }),
        "--policy-document",
        "{}"
      ]);
      s.clock.now += age;
      const report = await runSweep(s);
      if (failure) {
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0]).toContain(failure);
        expect(s.aws.locks()).toHaveLength(1);
      } else {
        expect(report.failures).toEqual([]);
        expect(s.aws.locks()).toEqual([]);
      }
    }
  );

  it("reports a lock it can't read or remove", async () => {
    const s = createCleanupScenario();
    s.aws.refuseOnce("iam get-policy", "AccessDenied");
    expect((await runSweep(s)).failures[0]).toContain(
      `Could not read the lock on ${ROLE}`
    );
    s.aws.run([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`,
      "--policy-document",
      "{}"
    ]);
    s.clock.now += AWS_LOCK_REMOVABLE_AFTER_MS;
    const run = s.aws.run.bind(s.aws);
    s.aws.run = (args) =>
      args[1] === "delete-policy" ?
        {
          code: 254,
          stdout: "",
          stderr:
            "An error occurred (AccessDenied) when calling the DeletePolicy operation"
        }
      : run(args);
    expect((await runSweep(s)).failures[0]).toContain(
      `Removing the abandoned lock on ${ROLE}`
    );
  });

  it("scales the main cluster's node groups to zero, waiting out an update", async () => {
    const s = createCleanupScenario();
    s.aws.addNodegroup(MAIN.region, MAIN.name, "default", {
      minSize: 1,
      maxSize: 2,
      desiredSize: 2
    });
    const isolated = s.aws.addNodegroup(
      MAIN.region,
      MAIN.name,
      "isolated",
      { minSize: 0, maxSize: 1, desiredSize: 1 },
      "UPDATING"
    );
    isolated.updatingReads = 2;
    const report = await runSweep(s);
    expect(report.failures).toEqual([]);
    const update = s.outside.calls.filter(
      (call) => call.command === "eks update-nodegroup-config"
    );
    expect(update.map((call) => call.args.at(-1))).toEqual([
      "minSize=0,maxSize=2,desiredSize=0",
      "minSize=0,maxSize=1,desiredSize=0"
    ]);
    expect(AWS_MAIN_NODE_GROUPS).toEqual(["default", "isolated"]);
    expect((await runSweep(s)).failures).toEqual([]);
  });

  it("reports a node group it can't scale", async () => {
    const s = createCleanupScenario();
    s.aws.addNodegroup(
      MAIN.region,
      MAIN.name,
      "default",
      { minSize: 0, maxSize: 2, desiredSize: 1 },
      "DEGRADED"
    );
    s.aws.refuseOnce("eks describe-nodegroup", "ServerException");
    const report = await runSweep(s);
    expect(report.failures).toEqual([
      `Could not read node group default on ${MAIN.name}: aws eks describe-nodegroup: \nAn error occurred (ServerException) when calling the eks describe-nodegroup operation: Refused by the test.`.replace(
        "aws eks describe-nodegroup: \n",
        "aws eks describe-nodegroup: "
      )
    ]);
    const second = await runSweep(s);
    expect(second.failures).toEqual([
      `Node group default on ${MAIN.name} is DEGRADED with 1 nodes, so it could not be scaled to zero.`
    ]);
  });
});

describe("findAwsLeftovers", () => {
  it("names every kind of state the AWS stage leaves", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, OLD, { deployed: true, ageHours: 1 });
    s.aws.addNodegroup(MAIN.region, MAIN.name, "isolated", {
      minSize: 0,
      maxSize: 1,
      desiredSize: 1
    });
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-untagged",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: []
    });
    s.aws.run([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`,
      "--policy-document",
      "{}"
    ]);
    const { findings, warnings } = await runVerify(s);
    const name = databaseName(OLD);
    expect(findings).toEqual([
      `RDS DB instance ${name} (available) in ${REGION}`,
      `RDS DB subnet group ${name} in ${REGION}`,
      `RDS DB parameter group ${name} in ${REGION}`,
      `Deployment ${NAMESPACE}/web on cluster ${MAIN.name}`,
      `namespace ${NAMESPACE} on cluster ${MAIN.name}`,
      `permissions boundary ${appBoundaryArn(OLD)}`,
      `node group isolated on cluster ${MAIN.name} at 1 nodes`,
      expect.stringMatching(
        new RegExp(`^lock ANPA\\w+ on ${ROLE}, held by an unknown holder$`)
      ),
      ...s.subjects
        .get(OLD)!
        .map((subject) => `trust subject ${subject} on ${ROLE}`),
      `inline policy radius-deploy-${OLD}-1361595003 on ${ROLE}`,
      `access entry for ${ROLE} on cluster ${MAIN.name}`
    ]);
    expect(warnings).toEqual([
      `RDS DB snapshot rds-snapshot-untagged in ${REGION} has no environment tag`
    ]);
  });

  it("counts a check it can't finish as a finding", async () => {
    const s = createCleanupScenario();
    const run = s.aws.run.bind(s.aws);
    const denied = [
      "describe-db-instances",
      "describe-access-entry",
      "list-role-policies",
      "list-policies"
    ];
    s.aws.run = (args) =>
      denied.includes(args[1] ?? "") && !args.includes(SECOND.name) ?
        {
          code: 254,
          stdout: "",
          stderr: `An error occurred (AccessDenied) when calling the ${args[1]} operation`
        }
      : run(args);
    s.ports.kubernetes.namespaceExists = async () => {
      throw new Error("timeout");
    };
    const { findings } = await runVerify(s);
    expect(findings).toEqual([
      expect.stringMatching(
        /^Could not check RDS: aws rds describe-db-instances: .*AccessDenied/
      ),
      `Could not check cluster ${MAIN.name}: timeout`,
      `Could not check cluster ${SECOND.name}: timeout`,
      expect.stringMatching(
        /^Could not check app permissions boundaries: aws iam list-policies: .*AccessDenied/
      ),
      expect.stringMatching(
        new RegExp(`^Could not check deploy role ${ROLE}: .*AccessDenied`)
      ),
      expect.stringMatching(
        new RegExp(
          `^Could not check access entries on ${MAIN.name}: .*AccessDenied`
        )
      )
    ]);
  });

  it("counts app boundaries it can't check when the repository's ID can't be read", async () => {
    const s = createCleanupScenario();
    s.ports.github.readRepositoryId = async () => {
      throw new Error("Could not read the ID of the fixture (HTTP 401).");
    };
    expect((await runVerify(s)).findings).toEqual([
      "Could not check app permissions boundaries: Could not read the ID of the fixture (HTTP 401)."
    ]);
  });

  it("keeps the reset blocked while an app boundary outlives its environment", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, OLD, {
      deployed: true,
      appRoleKeepsBoundary: true
    });
    const boundary = appBoundaryArn(OLD);
    // IAM refuses the boundary while the app role uses it, so the product's
    // removal warns on both attempts, and the environment goes anyway.
    const first = await runSweep(s);
    expect(first.failures).toEqual([
      expect.stringContaining(
        `${OLD}: Kept permissions boundary ${boundary}, because IAM reported it is still in use`
      )
    ]);
    expect(s.github.environment(OLD)).toBeUndefined();
    expect(s.aws.policies.has(boundary)).toBe(true);
    // A fresh run no longer has the environment to retry, but its leftover
    // check still finds the boundary, so the fixture isn't reset.
    nextDay(s);
    expect((await runSweep(s)).failures).toEqual([]);
    expect((await runVerify(s)).findings).toEqual([
      `permissions boundary ${boundary}`
    ]);
    // Once the app role and the boundary are gone, the reset may run.
    s.aws.roles.delete(`radius-app-web-${OLD}`.toLowerCase());
    expect(
      s.aws.run(["iam", "delete-policy", "--policy-arn", boundary]).code
    ).toBe(0);
    nextDay(s);
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
  });

  it("checks again after a read that fails once", async () => {
    const s = createCleanupScenario();
    s.aws.refuseOnce("iam list-role-policies", "ServiceFailure");
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
  });

  it("checks nothing else in another account", async () => {
    const s = createCleanupScenario();
    const result = await findAwsLeftovers(
      { ...cleanupConfig(s), accountId: "999999999999" },
      s.ports
    );
    expect(result).toEqual({
      findings: [
        `Could not check the AWS account: AWS is signed in to account ${ACCOUNT}, not 999999999999.`
      ],
      warnings: []
    });
  });
});

describe("AWS answers the sweep can't use", () => {
  // Answer `verb` with `answer` instead of the fake's own reply.
  function answer(
    s: CleanupScenario,
    verb: string,
    reply: (
      args: readonly string[]
    ) => { code: number; stdout: string; stderr: string } | null
  ) {
    const run = s.aws.run.bind(s.aws);
    s.aws.run = (args) =>
      args[1] === verb ? (reply(args) ?? run(args)) : run(args);
  }

  it("stops the RDS sweep on output that isn't JSON or names no VPC", async () => {
    const s = await twoEnvironments();
    answer(s, "describe-db-instances", () => ({
      code: 0,
      stdout: "<html>",
      stderr: ""
    }));
    expect((await runSweep(s)).failures).toContain(
      "RDS sweep stopped without deleting further: aws rds describe-db-instances did not return JSON."
    );
    const t = await twoEnvironments();
    answer(t, "describe-cluster", () => ({
      code: 0,
      stdout: "{}",
      stderr: ""
    }));
    expect((await runSweep(t)).failures).toContain(
      `RDS sweep stopped without deleting further: EKS reported no VPC for cluster ${MAIN.name}.`
    );
  });

  it("accepts a final snapshot that is gone by the time it is ready", async () => {
    const s = await twoEnvironments();
    s.appDelete.set(OLD, "leave");
    s.aws.rds.creatingReads = 100;
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-x",
      region: REGION,
      vpcId: MAIN_VPC,
      tags: recipeTags(OLD),
      status: "creating"
    });
    let reads = 0;
    answer(s, "describe-db-snapshots", (args) => {
      // The first read lists it; by the next, someone else deleted it.
      if (args.includes(REGION) && (reads += 1) === 2)
        s.aws.rds.snapshots.clear();
      return null;
    });
    expect((await runSweep(s)).failures).toEqual([]);
    expect(writes(s)).not.toContain("rds delete-db-snapshot");
  });

  it("warns when the removal could not release its lock, and fails on the lock it left", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, OLD);
    let releases = 0;
    answer(s, "delete-policy", (args) =>
      (
        args.some((arg) => arg.includes(`radius-lock-${ROLE}`)) &&
        (releases += 1) === 1
      ) ?
        {
          code: 254,
          stdout: "",
          stderr:
            "An error occurred (AccessDenied) when calling the DeletePolicy operation"
        }
      : null
    );
    const report = await runSweep(s);
    expect(
      report.warnings.some(
        (line) => line.startsWith(`${OLD}: `) && line.includes("lock")
      )
    ).toBe(true);
    expect(
      report.failures.some((line) =>
        line.includes("is less than 10 minutes old")
      )
    ).toBe(true);
  });

  it("reports a node group whose size EKS doesn't say, and one that finished updating at zero", async () => {
    const s = createCleanupScenario();
    answer(s, "describe-nodegroup", () => ({
      code: 0,
      stdout: JSON.stringify({
        nodegroup: { status: "ACTIVE", scalingConfig: {} }
      }),
      stderr: ""
    }));
    expect((await runSweep(s)).failures).toEqual([
      `Could not read node group default on ${MAIN.name}: EKS reported no minSize for node group default.`,
      `Could not read node group isolated on ${MAIN.name}: EKS reported no minSize for node group isolated.`
    ]);
    const t = createCleanupScenario();
    const group = t.aws.addNodegroup(
      MAIN.region,
      MAIN.name,
      "default",
      { minSize: 0, maxSize: 2, desiredSize: 1 },
      "UPDATING"
    );
    let reads = 0;
    answer(t, "describe-nodegroup", (args) => {
      // The update that was running scales the group to zero.
      if (args.includes("default") && (reads += 1) === 2) group.desiredSize = 0;
      return null;
    });
    expect((await runSweep(t)).failures).toEqual([]);
    expect(writes(t)).not.toContain("eks update-nodegroup-config");
  });

  it("names a tagged final snapshot as a leftover, and fails on an unreadable role policy list", async () => {
    const s = createCleanupScenario();
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-x",
      region: SECOND.region,
      vpcId: "vpc-second",
      tags: recipeTags(OLD)
    });
    answer(s, "list-role-policies", () => ({
      code: 0,
      stdout: "{}",
      stderr: ""
    }));
    expect((await runVerify(s)).findings).toEqual([
      `RDS DB snapshot rds-snapshot-x (available) in ${SECOND.region}`,
      `Could not check deploy role ${ROLE}: IAM returned no PolicyNames.`
    ]);
  });
});

describe("reads that lag a delete", () => {
  // After `deleteVerb`, the next `stale` reads by `readVerb` still answer as
  // they did before it, as an eventually consistent service does.
  function lagging(
    s: CleanupScenario,
    deleteVerb: string,
    readVerb: string,
    stale: number
  ): { left: () => number } {
    const run = s.aws.run.bind(s.aws);
    let before: ReturnType<typeof run> | null = null;
    let remaining = 0;
    s.aws.run = (args) => {
      if (args[1] === readVerb && remaining > 0 && before) {
        remaining -= 1;
        return before;
      }
      const result = run(args);
      if (args[1] === readVerb) before = result;
      if (args[1] === deleteVerb && result.code === 0) remaining = stale;
      return result;
    };
    return { left: () => remaining };
  }

  it("waits for a removed lock to show as gone", async () => {
    const s = createCleanupScenario();
    s.aws.run([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`,
      "--policy-document",
      "{}"
    ]);
    s.clock.now += AWS_LOCK_REMOVABLE_AFTER_MS;
    const lag = lagging(s, "delete-policy", "get-policy", 3);
    expect((await runSweep(s)).failures).toEqual([]);
    expect(lag.left()).toBe(0);
    expect((await runVerify(s)).findings).toEqual([]);
  });

  it("gives the leftover check time to see the deploy role's deletes", async () => {
    const s = await twoEnvironments();
    expect((await runSweep(s)).failures).toEqual([]);
    // IAM still lists a policy the removal just deleted.
    s.aws.role(ROLE)!.inline.set("radius-deploy-stale", {});
    const run = s.aws.run.bind(s.aws);
    let reads = 0;
    s.aws.run = (args) => {
      if (args[1] === "list-role-policies" && (reads += 1) === 3)
        s.aws.role(ROLE)!.inline.delete("radius-deploy-stale");
      return run(args);
    };
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
    expect(reads).toBe(3);
  });

  it("reports what is still left once the leftover check stops waiting", async () => {
    const s = createCleanupScenario();
    s.aws.role(ROLE)!.inline.set("radius-deploy-stuck", {});
    const start = s.clock.now;
    expect((await runVerify(s)).findings).toEqual([
      `inline policy radius-deploy-stuck on ${ROLE}`
    ]);
    expect(s.clock.now - start).toBeGreaterThanOrEqual(LEFTOVER_SETTLE_MS);
  });
});
