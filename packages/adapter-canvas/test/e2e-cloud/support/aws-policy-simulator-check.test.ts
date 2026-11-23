import { describe, expect, it } from "vitest";
import { buildAwsEnvironmentPermissionPolicy } from "@radius-project/core";
import { awsEnvironmentPolicyName } from "../../../src/aws-deploy-role-name.js";
import {
  MAIN,
  REPO_ID,
  ROLE,
  ROLE_ARN,
  SECOND
} from "../../support/aws/cleanup-scenario.js";
import {
  addLiveEnvironment,
  createJourneyWorld,
  liveEnvironment,
  removeLiveEnvironment
} from "../../support/aws/journey-scenario.js";
import { lagging } from "../../support/aws/lagging.js";
import {
  checkDeployRoleRegionScope,
  requestedRegionContext
} from "./aws-policy-simulator-check.js";
import { AWS_SETTLE_MS, AWS_SETTLE_POLL_MS } from "./aws-timeout-budget.js";

const REGIONS = [MAIN.region, SECOND.region];
const FIRST = liveEnvironment("radtest-aws-run1-main");
const SECOND_ENV = liveEnvironment("radtest-aws-run1-second", SECOND);

function scripted(results: unknown) {
  const calls: string[][] = [];
  const clock = { now: 0 };
  return {
    calls,
    sleep: async (milliseconds: number) => {
      clock.now += milliseconds;
    },
    now: () => clock.now,
    runAws: async (args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ EvaluationResults: results }),
        stderr: ""
      };
    }
  };
}

describe("requestedRegionContext", () => {
  it("is the CLI's JSON form of an aws:RequestedRegion context entry", () => {
    expect(JSON.parse(requestedRegionContext("us-east-2"))).toEqual([
      {
        ContextKeyName: "aws:RequestedRegion",
        ContextKeyValues: ["us-east-2"],
        ContextKeyType: "string"
      }
    ]);
  });
});

describe("checkDeployRoleRegionScope", () => {
  it("allows each live environment's region and denies the rest, through every stage", async () => {
    const world = createJourneyWorld();
    const start = world.clock.now;
    const run = (liveRegions: string[]) =>
      checkDeployRoleRegionScope(world.ports, {
        roleArn: ROLE_ARN,
        testRegions: REGIONS,
        liveRegions
      });

    expect((await run([])).failures).toEqual([]);
    addLiveEnvironment(world, FIRST);
    const one = await run([MAIN.region]);
    expect(one).toEqual({
      failures: [],
      decisions: [
        {
          region: MAIN.region,
          action: "rds:CreateDBInstance",
          decision: "allowed"
        },
        {
          region: MAIN.region,
          action: "eks:DescribeCluster",
          decision: "allowed"
        },
        {
          region: SECOND.region,
          action: "rds:CreateDBInstance",
          decision: "implicitDeny"
        },
        {
          region: SECOND.region,
          action: "eks:DescribeCluster",
          decision: "implicitDeny"
        }
      ]
    });
    addLiveEnvironment(world, SECOND_ENV);
    expect((await run(REGIONS)).failures).toEqual([]);
    removeLiveEnvironment(world, SECOND_ENV.name);
    expect((await run([MAIN.region])).failures).toEqual([]);
    // Each answer was as expected the first time, so nothing waited.
    expect(world.clock.now).toBe(start);
    expect(world.calls.at(-1)?.slice(0, 8)).toEqual([
      "iam",
      "simulate-principal-policy",
      "--policy-source-arn",
      ROLE_ARN,
      "--action-names",
      "rds:CreateDBInstance",
      "eks:DescribeCluster",
      "--context-entries"
    ]);
  });

  it("fails when the second region is still allowed after its environment is deleted", async () => {
    const world = createJourneyWorld();
    addLiveEnvironment(world, FIRST);
    addLiveEnvironment(world, SECOND_ENV);
    const { failures } = await checkDeployRoleRegionScope(world.ports, {
      roleArn: ROLE_ARN,
      testRegions: REGIONS,
      liveRegions: [MAIN.region]
    });
    expect(failures).toEqual([
      `The policy simulator gave deploy role ${ROLE_ARN} allowed for rds:CreateDBInstance in ${SECOND.region}, but expected denied: no environment is there.`,
      `The policy simulator gave deploy role ${ROLE_ARN} allowed for eks:DescribeCluster in ${SECOND.region}, but expected denied: no environment is there.`
    ]);
  });

  it("fails when setup scoped an environment's policy to the wrong region", async () => {
    const world = createJourneyWorld();
    addLiveEnvironment(world, FIRST);
    world.aws
      .role(ROLE)
      ?.inline.set(
        awsEnvironmentPolicyName(REPO_ID, FIRST.name),
        buildAwsEnvironmentPermissionPolicy(SECOND.region)
      );
    const { failures } = await checkDeployRoleRegionScope(world.ports, {
      roleArn: ROLE_ARN,
      testRegions: REGIONS,
      liveRegions: [MAIN.region]
    });
    expect(failures).toEqual([
      `The policy simulator gave deploy role ${ROLE_ARN} implicitDeny for rds:CreateDBInstance in ${MAIN.region}, but expected allowed: an environment there needs it.`,
      `The policy simulator gave deploy role ${ROLE_ARN} implicitDeny for eks:DescribeCluster in ${MAIN.region}, but expected allowed: an environment there needs it.`,
      `The policy simulator gave deploy role ${ROLE_ARN} allowed for rds:CreateDBInstance in ${SECOND.region}, but expected denied: no environment is there.`,
      `The policy simulator gave deploy role ${ROLE_ARN} allowed for eks:DescribeCluster in ${SECOND.region}, but expected denied: no environment is there.`
    ]);
  });

  it("counts an explicit deny as denied, and a missing or unknown decision as a failure", async () => {
    const port = scripted([
      { EvalActionName: "rds:CreateDBInstance", EvalDecision: "explicitDeny" },
      { EvalActionName: "eks:DescribeCluster", EvalDecision: "maybe" }
    ]);
    const denied = await checkDeployRoleRegionScope(port, {
      roleArn: ROLE_ARN,
      testRegions: [SECOND.region],
      liveRegions: []
    });
    expect(denied.failures).toEqual([
      `The policy simulator gave deploy role ${ROLE_ARN} maybe for eks:DescribeCluster in ${SECOND.region}, but expected denied: no environment is there.`
    ]);
    const empty = await checkDeployRoleRegionScope(scripted(undefined), {
      roleArn: ROLE_ARN,
      testRegions: [MAIN.region],
      liveRegions: [MAIN.region]
    });
    expect(empty.failures).toEqual([
      `The policy simulator returned no decision for rds:CreateDBInstance in ${MAIN.region}.`,
      `The policy simulator returned no decision for eks:DescribeCluster in ${MAIN.region}.`
    ]);
  });

  it("refuses a live region it doesn't test, before calling AWS", async () => {
    const port = scripted([]);
    await expect(
      checkDeployRoleRegionScope(port, {
        roleArn: ROLE_ARN,
        testRegions: [MAIN.region],
        liveRegions: ["us-west-2"]
      })
    ).rejects.toThrow("Live environments are in us-west-2");
    expect(port.calls).toEqual([]);
  });

  it("fails when the simulator can't be called", async () => {
    const world = createJourneyWorld();
    await expect(
      checkDeployRoleRegionScope(world.ports, {
        roleArn: `${ROLE_ARN}-missing`,
        testRegions: REGIONS,
        liveRegions: []
      })
    ).rejects.toThrow("aws iam simulate-principal-policy");
  });

  describe("after a delete that takes a while to show", () => {
    // Both environments, then the second's inline policy deleted through IAM,
    // whose simulator answers as before it for `stale` calls.
    async function deleteSlowly(stale: number) {
      const world = createJourneyWorld();
      addLiveEnvironment(world, FIRST);
      addLiveEnvironment(world, SECOND_ENV);
      const lag = lagging(
        world,
        "delete-role-policy",
        "simulate-principal-policy",
        stale
      );
      const run = (liveRegions: string[]) =>
        checkDeployRoleRegionScope(world.ports, {
          roleArn: ROLE_ARN,
          testRegions: REGIONS,
          liveRegions
        });
      expect((await run(REGIONS)).failures).toEqual([]);
      world.aws.run([
        "iam",
        "delete-role-policy",
        "--role-name",
        ROLE,
        "--policy-name",
        awsEnvironmentPolicyName(REPO_ID, SECOND_ENV.name)
      ]);
      removeLiveEnvironment(world, SECOND_ENV.name);
      return { world, lag, run, start: world.clock.now };
    }

    it("passes once the second region is denied", async () => {
      const { world, lag, run, start } = await deleteSlowly(2);
      expect((await run([MAIN.region])).failures).toEqual([]);
      expect(lag.left()).toBe(0);
      expect(world.clock.now - start).toBe(AWS_SETTLE_POLL_MS);
    });

    it("reports the last decisions when the allow outlasts the window", async () => {
      const { world, lag, run, start } = await deleteSlowly(1000);
      expect((await run([MAIN.region])).failures).toEqual([
        `The policy simulator gave deploy role ${ROLE_ARN} allowed for rds:CreateDBInstance in ${SECOND.region}, but expected denied: no environment is there.`,
        `The policy simulator gave deploy role ${ROLE_ARN} allowed for eks:DescribeCluster in ${SECOND.region}, but expected denied: no environment is there.`
      ]);
      expect(lag.left()).toBeGreaterThan(0);
      expect(world.clock.now - start).toBeGreaterThanOrEqual(AWS_SETTLE_MS);
    });
  });
});
