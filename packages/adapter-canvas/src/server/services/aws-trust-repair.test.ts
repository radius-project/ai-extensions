import { describe, expect, it } from "vitest";
import {
  createAwsTrustRepairService,
  type AwsTrustRepairDependencies,
  type AwsTrustRepairState
} from "./aws-trust-repair.js";
import type { EnvironmentTarget } from "./environment-target.js";

const DRIFT = "cloud-auth-drift";
const ROLE_ARN = "arn:aws:iam::123456789012:role/radius-deploy-octo-shop";
const SUBJECT = "repo:octo/shop:environment:dev";

const failedSignIn: AwsTrustRepairState = {
  deployStatus: "failed",
  deployErrorKind: DRIFT,
  deployAttempt: { targetRepo: "octo/shop", environment: "dev" },
  deployGeneration: 4
};

const awsTarget: EnvironmentTarget = {
  provider: "aws",
  clientId: "",
  tenantId: "",
  repoId: 0,
  roleArn: ROLE_ARN,
  trustSubjects: [SUBJECT],
  region: "us-west-2",
  cluster: "shop"
};

function service(
  state: AwsTrustRepairState | undefined,
  overrides: Partial<AwsTrustRepairDependencies> = {}
) {
  const reads: unknown[] = [];
  const repairs: unknown[] = [];
  const repair = createAwsTrustRepairService({
    awsEnabled: true,
    readInstanceState: (instanceId) => {
      expect(instanceId).toBe("panel-a");
      return state;
    },
    cloudAuthDriftKind: DRIFT,
    readEnvironmentTarget: async (repo, environment) => {
      reads.push([repo, environment]);
      return awsTarget;
    },
    repair: async (input) => {
      repairs.push(input);
      return { ok: true, roleName: "radius-deploy-octo-shop", added: [] };
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  });
  return {
    reads,
    repairs,
    run: (generation = 4) =>
      repair.repair({ instanceId: "panel-a", generation })
  };
}

describe("AWS trust repair service", () => {
  it("refuses while the AWS developer switch is off, without reading anything", async () => {
    const test = service(failedSignIn, {
      awsEnabled: false,
      readInstanceState: () => {
        throw new Error("Unexpected state read");
      }
    });
    expect(await test.run()).toEqual({
      status: 400,
      body: {
        code: "provider-unsupported",
        error:
          "AWS environments aren't supported yet, so Radius repaired nothing."
      }
    });
    expect(test.reads).toEqual([]);
    expect(test.repairs).toEqual([]);
  });

  it.each([
    ["an earlier deploy", 3],
    ["no deploy", -1]
  ])(
    "refuses a panel that shows %s, without reading GitHub or AWS",
    async (_label, generation) => {
      const test = service(failedSignIn);
      expect(await test.run(generation)).toEqual({
        status: 409,
        body: {
          code: "repair-stale",
          error:
            "This failure is no longer the canvas's latest deploy, so Radius changed nothing. Repair from the current result."
        }
      });
      expect(test.reads).toEqual([]);
      expect(test.repairs).toEqual([]);
    }
  );

  it("treats a canvas that has never counted a deploy as generation 0", async () => {
    const { deployGeneration: _unused, ...uncounted } = failedSignIn;
    const test = service(uncounted);
    expect((await test.run(0)).status).toBe(200);
  });

  it.each([
    ["no canvas state", undefined],
    [
      "a deploy still running",
      { ...failedSignIn, deployStatus: "in_progress" }
    ],
    [
      "a deploy that failed another way",
      { ...failedSignIn, deployErrorKind: "run-unconfirmed" }
    ],
    [
      "a failure with no repository",
      { deployStatus: "failed", deployErrorKind: DRIFT, deployEnvName: "dev" }
    ],
    [
      "a failure with no environment",
      {
        deployStatus: "failed",
        deployErrorKind: DRIFT,
        deployingRepo: "octo/shop"
      }
    ]
  ])("refuses %s without reading GitHub or AWS", async (_label, state) => {
    const test = service(state);
    expect(await test.run()).toMatchObject({
      status: 409,
      body: { code: "repair-not-applicable" }
    });
    expect(test.reads).toEqual([]);
    expect(test.repairs).toEqual([]);
  });

  it("repairs the attempt's environment without passing the recorded subjects", async () => {
    const test = service(
      { ...failedSignIn, deployingRepo: "octo/old", deployEnvName: "old" },
      {
        repair: async (input) => {
          test.repairs.push(input);
          return {
            ok: true,
            roleName: "radius-deploy-octo-shop",
            added: [SUBJECT, "repo:octo@7/shop@42:environment:dev"]
          };
        }
      }
    );

    expect(await test.run()).toEqual({
      status: 200,
      body: {
        code: "aws-trust-repaired",
        added: [SUBJECT, "repo:octo@7/shop@42:environment:dev"],
        message: `IAM role radius-deploy-octo-shop trusts environment dev again. Radius added back ${SUBJECT}, repo:octo@7/shop@42:environment:dev. Deploy again.`
      }
    });
    expect(test.reads).toEqual([["octo/shop", "dev"]]);
    expect(test.repairs).toEqual([
      {
        repo: "octo/shop",
        environment: "dev",
        roleArn: ROLE_ARN,
        confirmTarget: expect.any(Function)
      }
    ]);
  });

  it("falls back to the deploy's repository and environment without an attempt", async () => {
    const test = service({
      deployStatus: "failed",
      deployErrorKind: DRIFT,
      deployingRepo: "octo/shop",
      deployEnvName: "dev"
    });
    await test.run(0);
    expect(test.reads).toEqual([["octo/shop", "dev"]]);
  });

  // A fake access layer that, like the real one, runs the re-check after it
  // takes the lock and stops with its answer.
  const lockedRepair =
    (writes: string[]): AwsTrustRepairDependencies["repair"] =>
    async (input) => {
      const changed = await input.confirmTarget();
      if (changed) return { ok: false, ...changed };
      writes.push(input.roleArn);
      return {
        ok: true,
        roleName: "radius-deploy-octo-shop",
        added: [SUBJECT]
      };
    };

  it("repairs when the environment still names the same role under the lock", async () => {
    const writes: string[] = [];
    const test = service(failedSignIn, { repair: lockedRepair(writes) });
    expect((await test.run()).status).toBe(200);
    expect(test.reads).toEqual([
      ["octo/shop", "dev"],
      ["octo/shop", "dev"]
    ]);
    expect(writes).toEqual([ROLE_ARN]);
  });

  it("passes the exact saved policy name to Repair", async () => {
    const policyName = "radius-deploy-dev-111111111111";
    const test = service(failedSignIn, {
      readEnvironmentTarget: async () => ({ ...awsTarget, policyName })
    });
    expect((await test.run()).status).toBe(200);
    expect(test.repairs).toEqual([expect.objectContaining({ policyName })]);
  });

  it("refuses a policy identity changed while Repair takes the lock", async () => {
    const writes: string[] = [];
    let reads = 0;
    const test = service(failedSignIn, {
      readEnvironmentTarget: async () => ({
        ...awsTarget,
        policyName:
          ++reads === 1 ?
            "radius-deploy-dev-111111111111"
          : "radius-deploy-dev-222222222222"
      }),
      repair: lockedRepair(writes)
    });
    expect(await test.run()).toMatchObject({
      status: 409,
      body: { code: "repair-target-changed" }
    });
    expect(writes).toEqual([]);
  });

  it("changes nothing when the environment was deleted before the lock", async () => {
    const writes: string[] = [];
    let reads = 0;
    const test = service(failedSignIn, {
      readEnvironmentTarget: async () => {
        reads += 1;
        if (reads > 1) throw new Error("gh: Not Found (HTTP 404)");
        return awsTarget;
      },
      repair: lockedRepair(writes)
    });

    expect(await test.run()).toEqual({
      status: 409,
      body: {
        code: "repair-target-changed",
        error:
          'Radius could not read GitHub environment "dev" again after it locked the role, so it changed nothing. The environment may have been deleted. gh: Not Found (HTTP 404)'
      }
    });
    expect(writes).toEqual([]);
  });

  it.each([
    [
      "another role",
      { ...awsTarget, roleArn: `${ROLE_ARN}-new` },
      `GitHub environment "dev" changed while Repair took the lock: it now names ${ROLE_ARN}-new instead of ${ROLE_ARN}. Radius changed nothing. Deploy again to see the current result.`
    ],
    [
      "no AWS role",
      { ...awsTarget, roleArn: "" },
      'GitHub environment "dev" no longer names an AWS deploy role, so Radius changed nothing. Deploy again to see the current result.'
    ],
    [
      "another provider",
      { ...awsTarget, provider: "azure" },
      'GitHub environment "dev" no longer names an AWS deploy role, so Radius changed nothing. Deploy again to see the current result.'
    ]
  ])(
    "changes nothing when the environment names %s by the time of the lock",
    async (_label, changedTarget, error) => {
      const writes: string[] = [];
      let reads = 0;
      const test = service(failedSignIn, {
        readEnvironmentTarget: async () => {
          reads += 1;
          return reads > 1 ? changedTarget : awsTarget;
        },
        repair: lockedRepair(writes)
      });

      expect(await test.run()).toEqual({
        status: 409,
        body: { code: "repair-target-changed", error }
      });
      expect(writes).toEqual([]);
    }
  );

  it("says the trust is intact when nothing was missing", async () => {
    expect(await service(failedSignIn).run()).toEqual({
      status: 200,
      body: {
        code: "aws-trust-intact",
        added: [],
        message:
          "IAM role radius-deploy-octo-shop already trusts environment dev, so the sign-in failure has another cause, such as the role's permissions. Re-verify the environment to find it."
      }
    });
  });

  it.each([
    [
      {
        ok: true as const,
        roleName: "r",
        added: [],
        lockWarning: "Lock kept."
      },
      "Re-verify the environment to find it. Lock kept."
    ],
    [
      {
        ok: true as const,
        roleName: "r",
        added: [SUBJECT],
        lockWarning: "Lock kept."
      },
      "Deploy again. Lock kept."
    ]
  ])("appends a lock left behind to the message", async (result, ending) => {
    const test = service(failedSignIn, { repair: async () => result });
    const response = await test.run();
    expect(String(response.body.message).endsWith(ending)).toBe(true);
  });

  it("answers a repair refusal with its code and message", async () => {
    const test = service(failedSignIn, {
      repair: async () => ({
        ok: false,
        code: "aws-lock-busy",
        message: "Another run is changing the role."
      })
    });
    expect(await test.run()).toEqual({
      status: 409,
      body: {
        code: "aws-lock-busy",
        error: "Another run is changing the role."
      }
    });
  });

  it("fails closed when the GitHub environment cannot be read", async () => {
    const test = service(failedSignIn, {
      readEnvironmentTarget: async () => {
        throw new Error("HTTP 502");
      }
    });
    expect(await test.run()).toEqual({
      status: 502,
      body: {
        code: "github-environment-variables-unreadable",
        error:
          'Radius could not read the variables of GitHub environment "dev", so it changed nothing: HTTP 502'
      }
    });
    expect(test.repairs).toEqual([]);
  });

  it.each([
    ["an Azure environment", { ...awsTarget, provider: "azure" }],
    ["an AWS environment with no role", { ...awsTarget, roleArn: "" }]
  ])("refuses %s", async (_label, target) => {
    const test = service(failedSignIn, {
      readEnvironmentTarget: async () => target
    });
    expect(await test.run()).toMatchObject({
      status: 409,
      body: { code: "repair-not-aws" }
    });
    expect(test.repairs).toEqual([]);
  });

  it("reports a repair that throws", async () => {
    const test = service(failedSignIn, {
      repair: async () => {
        throw new Error("spawn aws ENOENT");
      }
    });
    expect(await test.run()).toEqual({
      status: 502,
      body: {
        code: "aws-trust-repair-failed",
        error: "Radius could not repair the deploy role: spawn aws ENOENT"
      }
    });
  });
});
