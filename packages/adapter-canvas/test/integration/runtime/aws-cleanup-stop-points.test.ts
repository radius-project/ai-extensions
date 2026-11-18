import { describe, expect, it } from "vitest";
import {
  addAwsEnvironment,
  appBoundaryArn,
  appResources,
  createCleanupScenario,
  APPLICATION,
  MAIN,
  MAIN_VPC,
  NAMESPACE,
  SECOND,
  nextDay,
  recipeTags,
  REPO,
  retryInputs,
  runSweep,
  runVerify,
  type CleanupScenario
} from "../../support/aws/cleanup-scenario.js";
import { statePackageName } from "../../e2e-cloud/support/aws-cloud-cleanup.js";
import type { StopKind } from "../../support/aws/stop-points.js";

// The AWS cleanup sweep, stopped at each outside call in turn: the call
// failing, a crash before it reaches the service, and, for a write, a crash
// after it lands with the answer lost. The sweep keeps no state of its own, so
// the next run starts from what AWS, GitHub, and the clusters hold. At each
// stop, an environment that still has app resources keeps everything a retry
// needs, nothing outside the suite's scope is touched, and the next day's run
// finishes the job.

const OLD = "radtest-aws-aaaa11112222";
const SECOND_ENV = "radtest-aws-bbbb33334444";
const ORPHAN = "radtest-aws-cccc55556666";
const ENVIRONMENTS = [OLD, SECOND_ENV];

async function world(): Promise<CleanupScenario> {
  const s = createCleanupScenario();
  await addAwsEnvironment(s, OLD, { deployed: true });
  await addAwsEnvironment(s, SECOND_ENV, { cluster: "second" });
  // Radius lost track of the database, so the sweep deletes it.
  s.appDelete.set(OLD, "leave");
  // A final snapshot from an earlier app delete.
  s.aws.rds.addSnapshot({
    id: "rds-snapshot-earlier",
    region: MAIN.region,
    vpcId: MAIN_VPC,
    tags: recipeTags(OLD)
  });
  // State of an environment that is already gone.
  s.deployments.push({
    id: 7,
    environment: ORPHAN,
    created_at: "2026-11-01T00:00:00Z"
  });
  const orphan = statePackageName(REPO, ORPHAN);
  s.packages.set(orphan, {
    name: orphan,
    visibility: "private",
    repository: REPO,
    updated_at: "2026-11-01T00:00:00Z"
  });
  // A probe Job left on the second cluster.
  s.kube.addWorkload(`${SECOND.region}/${SECOND.name}`, {
    kind: "Job",
    name: "probe",
    namespace: NAMESPACE,
    labels: {
      "radapp.io/environment": OLD,
      "radapp.io/application": APPLICATION
    },
    creationTimestamp: "2026-11-01T00:00:00Z"
  });
  // Radius's own database, which the sweep must never touch.
  s.aws.rds.addInstance({
    id: "mysql-radius",
    region: MAIN.region,
    vpcId: MAIN_VPC,
    subnetGroup: "default",
    parameterGroup: "default.mysql8.4",
    tags: [...recipeTags(OLD), { Key: "RadiusCreationTimestamp", Value: "1" }]
  });
  s.aws.addNodegroup(MAIN.region, MAIN.name, "default", {
    minSize: 1,
    maxSize: 2,
    desiredSize: 1
  });
  return s;
}

interface Point {
  at: number;
  command: string;
  kind: StopKind;
}

const KINDS: readonly StopKind[] = ["fail", "crash-before", "crash-after"];

// The same world, where an app role the app delete left still uses the
// second environment's app boundary, so IAM refuses to delete it. Step 4
// keeps it through both removal attempts, then deletes the environment.
const KEPT_BOUNDARY = appBoundaryArn(SECOND_ENV);
const KEPT_ROLE = `radius-app-web-${SECOND_ENV}`;

async function keptBoundaryWorld(): Promise<CleanupScenario> {
  const s = await world();
  s.aws.addRole({
    name: KEPT_ROLE,
    trust: { Version: "2012-10-17", Statement: [] },
    boundary: KEPT_BOUNDARY
  });
  return s;
}

// The managed policies left under the fixture repository's app path.
function appBoundaries(s: CleanupScenario): string[] {
  return [...s.aws.policies.values()]
    .filter((policy) => policy.Path.startsWith("/radius/apps/"))
    .map((policy) => policy.Arn);
}

async function discover(
  build: () => Promise<CleanupScenario> = world,
  expectedFailures = 0
): Promise<Point[]> {
  const s = await build();
  const report = await runSweep(s);
  if (report.failures.length !== expectedFailures)
    throw new Error(
      `The first sweep had ${report.failures.length} failures, not ${expectedFailures}: ${report.failures.join("; ")}`
    );
  return s.outside.calls.flatMap((call) =>
    KINDS.filter((kind) => kind !== "crash-after" || call.write).map(
      (kind) => ({ at: call.index, command: call.command, kind })
    )
  );
}

function radiusDatabase(s: CleanupScenario): boolean {
  return s.aws.rds.instances.has(`${MAIN.region}:mysql-radius`);
}

// A sweep that removed some of an environment's deploy-role access but kept
// its GitHub environment leaves an app delete that can't sign in. By the
// approved design that run fails and a person finishes it by hand.
function accessPartlyRemoved(s: CleanupScenario, name: string): boolean {
  const inputs = retryInputs(s, name);
  return inputs.includes("GitHub environment") && inputs.length < 5;
}

const points = await discover();
const keptBoundaryPoints = await discover(keptBoundaryWorld, 1);

describe("AWS cleanup sweep, stopped at each outside call", () => {
  it("has a write of every kind the sweep makes", () => {
    const writes = new Set(
      points
        .filter((point) => point.kind === "crash-after")
        .map((point) => point.command)
    );
    expect([...writes].sort()).toEqual(
      [
        "DELETE deployment 1000",
        "DELETE deployment 7",
        `DELETE environment ${OLD}`,
        `DELETE environment ${SECOND_ENV}`,
        `DELETE package ${statePackageName(REPO, OLD)}`,
        `DELETE package ${statePackageName(REPO, SECOND_ENV)}`,
        `DELETE package ${statePackageName(REPO, ORPHAN)}`,
        `dispatch delete-application ${OLD}`,
        `dispatch delete-application ${SECOND_ENV}`,
        "eks delete-access-entry",
        "eks update-nodegroup-config",
        "iam create-policy",
        "iam delete-policy",
        "iam delete-role-policy",
        "iam update-assume-role-policy",
        `kubectl delete Job probe ${SECOND.name}`,
        `kubectl delete namespace ${MAIN.name}`,
        `kubectl delete namespace ${SECOND.name}`,
        "rds delete-db-instance",
        "rds delete-db-parameter-group",
        "rds delete-db-snapshot",
        "rds delete-db-subnet-group"
      ].sort()
    );
  });

  it.each(points)("$at $command ($kind)", async ({ at, kind }) => {
    const s = await world();
    const before = new Map(
      ENVIRONMENTS.map((name) => [name, retryInputs(s, name)])
    );
    s.outside.arm(at, kind);
    let failures: string[] = [];
    const outcome = await s.outside.until(async () => {
      failures = (await runSweep(s)).failures;
    });
    expect(outcome).toBe(kind === "fail" ? "done" : "crashed");
    expect(s.outside.calls.filter((call) => call.afterCrash)).toEqual([]);

    for (const name of ENVIRONMENTS) {
      // Cleanup never removes what a retry needs.
      if (appResources(s, name).length > 0)
        expect(retryInputs(s, name)).toEqual(before.get(name));
      // The GitHub environment goes last, so nothing is stranded without it.
      if (!s.github.environment(name)) expect(retryInputs(s, name)).toEqual([]);
    }
    expect(radiusDatabase(s)).toBe(true);
    // A refused call fails the job, unless a retry inside the product absorbed
    // it and the run still finished.
    if (kind === "fail" && failures.length === 0)
      expect((await runVerify(s)).findings).toEqual([]);

    nextDay(s);
    const stuck = ENVIRONMENTS.filter((name) => accessPartlyRemoved(s, name));
    const rerun = await runSweep(s);
    expect(radiusDatabase(s)).toBe(true);
    if (stuck.length > 0) {
      expect(rerun.failures).toEqual(
        stuck.map(
          (name) =>
            `Deleting the Radius application in ${name} failed: delete-application.yml run 9 ended failure: Could not assume the deploy role.`
        )
      );
      for (const name of stuck)
        expect(s.github.environment(name)).toBeDefined();
      return;
    }
    expect(rerun.failures).toEqual([]);
    expect(await runVerify(s)).toEqual({ findings: [], warnings: [] });
    // A clean check means the outside world holds nothing of the suite.
    expect(s.deployments).toEqual([]);
    expect([...s.packages.keys()]).toEqual([]);
    expect(appBoundaries(s)).toEqual([]);
    for (const name of ENVIRONMENTS) {
      expect(retryInputs(s, name)).toEqual([]);
      expect(appResources(s, name)).toEqual([]);
    }
  });
});

describe("AWS cleanup sweep with an app boundary step 4 must keep, stopped at each outside call", () => {
  it.each(keptBoundaryPoints)("$at $command ($kind)", async ({ at, kind }) => {
    const s = await keptBoundaryWorld();
    s.outside.arm(at, kind);
    await s.outside.until(async () => {
      await runSweep(s);
    });
    // Whatever the stop, the boundary stays while its app role uses it, and
    // no later run's check passes until it is gone.
    for (let day = 0; day < 2; day += 1) {
      nextDay(s);
      await runSweep(s);
      expect(appBoundaries(s)).toContain(KEPT_BOUNDARY);
      expect((await runVerify(s)).findings).toContain(
        `permissions boundary ${KEPT_BOUNDARY}`
      );
    }
    // Once a person deletes the app role and the boundary, the check no
    // longer reports it. A stop partway through step 4 can leave other state
    // that a person finishes by hand, which the matrix above covers.
    s.aws.roles.delete(KEPT_ROLE.toLowerCase());
    expect(
      s.aws.run(["iam", "delete-policy", "--policy-arn", KEPT_BOUNDARY]).code
    ).toBe(0);
    nextDay(s);
    expect((await runVerify(s)).findings).not.toContain(
      `permissions boundary ${KEPT_BOUNDARY}`
    );
  });
});
