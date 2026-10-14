import { describe, expect, it } from "vitest";
import {
  buildGitHubTrustPolicy,
  trustedGitHubSubjects,
  parsePolicyDocument
} from "@radius-project/core";
import {
  removeAwsEnvironmentFromRole,
  setupAwsDeployIdentity,
  type AwsCommandResult,
  type AwsDeployIdentityRequest
} from "./aws-deploy-identity.js";

const ACCOUNT = "123456789012";
const ROLE = "radius-deploy-octo-shop";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
const DEV = "repo:octo/shop:environment:dev";
const PROD = "repo:octo/shop:environment:prod";

const ok = (stdout: unknown = ""): AwsCommandResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: ""
});
const fail = (stderr: string): AwsCommandResult => ({
  code: 254,
  stdout: "",
  stderr
});

const request: AwsDeployIdentityRequest = {
  repo: "octo/shop",
  environment: "dev",
  accountId: ACCOUNT,
  region: "us-west-2",
  cluster: "shop",
  roleName: ROLE,
  existingRoleArn: "",
  subject: DEV
};

const managedRole = (subjects: string[]) => ({
  Role: {
    Arn: ROLE_ARN,
    AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects),
    Tags: [
      { Key: "radius-managed", Value: "true" },
      { Key: "radius-repository", Value: "octo/shop" }
    ]
  }
});

type Script = Record<string, AwsCommandResult>;

// Answers each `aws` command by its first three words, and throws on any
// command the scenario did not script.
function fakeAws(script: Script) {
  const calls: string[][] = [];
  const steps: string[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    steps,
    sleeps,
    ports: {
      async runAws(args: string[]) {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        const result = script[key];
        if (!result) throw new Error(`unexpected aws ${args.join(" ")}`);
        return result;
      },
      step(text: string) {
        steps.push(text);
      },
      async sleep(milliseconds: number) {
        sleeps.push(milliseconds);
      }
    },
    find(command: string) {
      return calls.find((args) => args.slice(0, 2).join(" ") === command);
    }
  };
}

const freeChecks: Script = {
  "--version": ok("aws-cli/2.17.0 Python/3.11 Darwin/23"),
  "sts get-caller-identity": ok({ Account: ACCOUNT }),
  "eks describe-cluster": ok({
    cluster: { accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" } }
  })
};

const happyPath: Script = {
  ...freeChecks,
  "iam get-role": fail("An error occurred (NoSuchEntity) when calling GetRole"),
  "iam list-open-id-connect-providers": ok({ OpenIDConnectProviderList: [] }),
  "iam create-open-id-connect-provider": ok(),
  "iam create-role": ok({ Role: { Arn: ROLE_ARN } }),
  "iam put-role-policy": ok(),
  "eks create-access-entry": ok(),
  "eks associate-access-policy": ok()
};

describe("setupAwsDeployIdentity", () => {
  it("creates the provider, role, policy, and cluster access on a fresh account", async () => {
    const aws = fakeAws(happyPath);
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({ ok: true, roleArn: ROLE_ARN, roleCreated: true });
    expect(aws.steps).toEqual([
      "✅ AWS CLI 2.17.0 meets the 2.15.3 minimum.",
      "✅ Cluster shop accepts access entries (API_AND_CONFIG_MAP).",
      `✅ Created the GitHub identity provider in account ${ACCOUNT}.`,
      `ℹ️ Deploy identity will trust ${DEV}`,
      `✅ Created IAM role ${ROLE}.`,
      "✅ Attached deploy permission policy radius-deploy-dev, limited to us-west-2.",
      "✅ Granted the role cluster-admin on shop."
    ]);
    const createRole = aws.find("iam create-role");
    expect(createRole).toContain("Key=radius-managed,Value=true");
    expect(createRole).toContain("Key=radius-repository,Value=octo/shop");
    const trust = parsePolicyDocument(
      JSON.parse(
        createRole?.[createRole.indexOf("--assume-role-policy-document") + 1] ??
          "{}"
      )
    );
    expect(trustedGitHubSubjects(trust, ACCOUNT)).toEqual([DEV]);
    expect(aws.find("eks create-access-entry")).toEqual(
      expect.arrayContaining([
        "--principal-arn",
        ROLE_ARN,
        "--region",
        "us-west-2"
      ])
    );
  });

  it("reuses the Radius-managed role and merges the new subject", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok(managedRole([PROD])),
      "iam list-open-id-connect-providers": ok({
        OpenIDConnectProviderList: [
          {
            Arn: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
          }
        ]
      }),
      "iam update-assume-role-policy": ok(),
      "eks create-access-entry": fail("ResourceInUseException: exists"),
      "eks associate-access-policy": fail("ResourceInUseException: exists")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({ ok: true, roleArn: ROLE_ARN, roleCreated: false });
    expect(aws.steps).toContain(
      `✅ Reusing the Radius-managed IAM role ${ROLE}`
    );
    expect(aws.steps).toContain(
      "ℹ️ Keeping 1 subject(s) already trusted by this role"
    );
    expect(aws.find("iam create-role")).toBeUndefined();
    expect(aws.find("iam create-open-id-connect-provider")).toBeUndefined();
    const update = aws.find("iam update-assume-role-policy") ?? [];
    const merged = parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
    expect(trustedGitHubSubjects(merged, ACCOUNT)).toEqual([PROD, DEV]);
  });

  it("adds to a picked existing role without requiring Radius tags", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT}:role/platform-deploy`,
          AssumeRolePolicyDocument: { Statement: [] }
        }
      }),
      "iam update-assume-role-policy": ok()
    });
    const result = await setupAwsDeployIdentity(
      {
        ...request,
        existingRoleArn: `arn:aws:iam::${ACCOUNT}:role/platform-deploy`
      },
      aws.ports
    );
    expect(result).toMatchObject({ ok: true, roleCreated: false });
    expect(aws.steps).toContain(
      "✅ Using the selected IAM role platform-deploy."
    );
    expect(aws.find("iam get-role")).toContain("platform-deploy");
  });

  it("never modifies a same-named role Radius did not create", async () => {
    const aws = fakeAws({
      ...freeChecks,
      "iam get-role": ok({ Role: { Arn: ROLE_ARN, Tags: [] } })
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({
      ok: false,
      code: "aws-role-not-radius-managed",
      message: expect.stringContaining(
        `An IAM role named ${ROLE} already exists, but Radius did not create it for octo/shop. No change was made.`
      ),
      created: []
    });
    expect(aws.calls.map((args) => args[1])).not.toContain(
      "update-assume-role-policy"
    );
  });

  it.each([
    [
      "an old CLI",
      { "--version": ok("aws-cli/2.7.31 Python/3.9") },
      "aws-cli-unsupported",
      "AWS CLI 2.7.31 is installed"
    ],
    [
      "a CLI that cannot run",
      { "--version": fail("spawn aws ENOENT") },
      "aws-cli-unsupported",
      "Could not run the AWS CLI: spawn aws ENOENT"
    ],
    [
      "no CLI session",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": fail("Token has expired")
      },
      "aws-cli-login-required",
      "No active AWS CLI session"
    ],
    [
      "a session in another account",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": ok({ Account: "999988887777" })
      },
      "aws-account-mismatch",
      "signed in to account 999988887777, but this environment's profile is for account 123456789012"
    ],
    [
      "a CONFIG_MAP cluster",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": freeChecks["sts get-caller-identity"],
        "eks describe-cluster": ok({
          cluster: { accessConfig: { authenticationMode: "CONFIG_MAP" } }
        })
      },
      "aws-cluster-config-map",
      "Cluster shop uses CONFIG_MAP authentication"
    ],
    [
      "an unreadable cluster",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": freeChecks["sts get-caller-identity"],
        "eks describe-cluster": fail("ResourceNotFoundException")
      },
      "aws-cluster-unreadable",
      "Could not read EKS cluster shop in us-west-2"
    ]
  ])(
    "stops before writing anything for %s",
    async (_label, script, code, message) => {
      const aws = fakeAws(script);
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({
        ok: false,
        code,
        message: expect.stringContaining(message),
        created: []
      });
    }
  );

  it("hands over the provider command when the identity cannot create it", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam create-open-id-connect-provider": fail(
        "AccessDenied: not authorized to perform iam:CreateOpenIDConnectProvider"
      )
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({
      ok: false,
      code: "aws-oidc-provider-denied",
      message: expect.stringContaining(
        "aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com"
      )
    });
  });

  it("offers the existing-role path when role creation is denied", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam create-role": fail("AccessDenied: iam:CreateRole")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({
      ok: false,
      code: "aws-role-create-denied",
      message: expect.stringContaining(
        "The signed-in AWS identity is not permitted to create IAM roles."
      )
    });
  });

  it("retries the access entry while EKS cannot see the new role yet", async () => {
    const aws = fakeAws(happyPath);
    let attempts = 0;
    const runAws = aws.ports.runAws;
    aws.ports.runAws = async (args: string[]) => {
      if (args[1] === "create-access-entry" && attempts++ < 2) {
        return fail(
          "An error occurred (InvalidParameterException) when calling the CreateAccessEntry operation: The specified principalArn is invalid: invalid principal"
        );
      }
      return runAws(args);
    };
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({ ok: true, roleCreated: true });
    expect(aws.sleeps).toEqual([2000, 4000]);
    expect(aws.steps).toContain(
      `ℹ️ EKS does not see role ${ROLE} yet. Retrying in 2s.`
    );
  });

  it("gives up after the last retry and names what it created", async () => {
    const aws = fakeAws({
      ...happyPath,
      "eks create-access-entry": fail(
        "InvalidParameterException: invalid principal"
      )
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({
      ok: false,
      code: "aws-access-entry-failed",
      created: [`IAM role ${ROLE}`, `policy radius-deploy-dev on ${ROLE}`]
    });
    expect(aws.sleeps).toEqual([2000, 4000, 8000, 15000, 30000]);
  });

  it("does not retry other access entry failures", async () => {
    const aws = fakeAws({
      ...happyPath,
      "eks create-access-entry": fail("AccessDeniedException")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({
      ok: false,
      code: "aws-access-entry-failed"
    });
    expect(aws.sleeps).toEqual([]);
  });

  it("names what it created when a later step fails", async () => {
    const aws = fakeAws({
      ...happyPath,
      "eks associate-access-policy": fail("AccessDeniedException")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({
      ok: false,
      code: "aws-access-entry-failed",
      message: "Failed to grant cluster-admin on shop: AccessDeniedException",
      created: [
        `IAM role ${ROLE}`,
        `policy radius-deploy-dev on ${ROLE}`,
        `access entry for ${ROLE} on shop`
      ]
    });
  });

  it.each([
    ["not-an-arn", "aws-role-invalid"],
    ["arn:aws:iam::999988887777:role/other", "aws-role-wrong-account"]
  ])("rejects the picked role %s", async (existingRoleArn, code) => {
    const aws = fakeAws(freeChecks);
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn },
      aws.ports
    );
    expect(result).toMatchObject({ ok: false, code });
  });

  it("reports a picked role that does not exist", async () => {
    const aws = fakeAws({
      ...freeChecks,
      "iam get-role": fail("NoSuchEntity")
    });
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn: `arn:aws:iam::${ACCOUNT}:role/gone` },
      aws.ports
    );
    expect(result).toMatchObject({ ok: false, code: "aws-role-missing" });
  });
});

describe("removeAwsEnvironmentFromRole", () => {
  const removal = { roleArn: ROLE_ARN, environment: "dev", subject: DEV };

  it("removes only this environment's subject and policy", async () => {
    const aws = fakeAws({
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    });
    const result = await removeAwsEnvironmentFromRole(removal, aws.ports);
    expect(result).toEqual({
      ok: true,
      removed: [`trust subject ${DEV}`, "policy radius-deploy-dev"],
      kept: [`IAM role ${ROLE}`, "the account's GitHub identity provider"]
    });
    const update = aws.find("iam update-assume-role-policy") ?? [];
    const remaining = parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
    expect(trustedGitHubSubjects(remaining, ACCOUNT)).toEqual([PROD]);
    expect(aws.calls.map((args) => args[1])).not.toContain("delete-role");
  });

  it("reports a role that is already gone and continues", async () => {
    const aws = fakeAws({ "iam get-role": fail("NoSuchEntity") });
    expect(await removeAwsEnvironmentFromRole(removal, aws.ports)).toEqual({
      ok: true,
      removed: [],
      kept: [`IAM role ${ROLE} was already gone`]
    });
  });

  it("treats a missing policy as already removed", async () => {
    const aws = fakeAws({
      "iam get-role": ok(managedRole([PROD])),
      "iam delete-role-policy": fail("NoSuchEntity")
    });
    expect(
      await removeAwsEnvironmentFromRole(removal, aws.ports)
    ).toMatchObject({ ok: true, removed: [] });
  });

  it.each([
    ["an unreadable role", { "iam get-role": fail("AccessDenied") }],
    [
      "a denied trust update",
      {
        "iam get-role": ok(managedRole([DEV])),
        "iam update-assume-role-policy": fail("AccessDenied")
      }
    ],
    [
      "a denied policy delete",
      {
        "iam get-role": ok(managedRole([PROD])),
        "iam delete-role-policy": fail("AccessDenied")
      }
    ]
  ])("fails closed on %s", async (_label, script) => {
    const aws = fakeAws(script);
    expect(
      await removeAwsEnvironmentFromRole(removal, aws.ports)
    ).toMatchObject({ ok: false });
  });

  it("refuses a value that is not a role ARN", async () => {
    const aws = fakeAws({});
    expect(
      await removeAwsEnvironmentFromRole({ ...removal, roleArn: "" }, aws.ports)
    ).toMatchObject({ ok: false });
    expect(aws.calls).toEqual([]);
  });
});
