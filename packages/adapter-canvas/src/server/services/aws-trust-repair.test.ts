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
  trustSubjects: [SUBJECT]
};

function service(
  state: AwsTrustRepairState | undefined,
  overrides: Partial<AwsTrustRepairDependencies> = {}
) {
  const reads: unknown[] = [];
  const repairs: unknown[] = [];
  const repair = createAwsTrustRepairService({
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
        roleArn: ROLE_ARN
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
