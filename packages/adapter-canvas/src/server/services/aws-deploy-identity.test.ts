import { describe, expect, it } from "vitest";
import {
  buildGitHubTrustPolicy,
  trustedGitHubSubjects,
  parsePolicyDocument
} from "@radius-project/core";
import {
  removeAwsEnvironmentFromRole,
  repairAwsEnvironmentTrust,
  setupAwsDeployIdentity,
  type AwsCommandResult,
  type AwsDeployIdentityRequest,
  type AwsLockResult
} from "./aws-deploy-identity.js";

const ACCOUNT = "123456789012";
const ROLE = "radius-deploy-octo-shop";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
const DEV = "repo:octo/shop:environment:dev";
const PROD = "repo:octo/shop:environment:prod";
// The ID-based form a repository without immutable subjects also presents.
const DEV_ID = "repository_owner_id:11:repository_id:22:environment:dev";

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
  subjects: [DEV]
};

const ROLE_CREATED_AT = "2026-10-01T00:00:00+00:00";
const entryCreatedAt = (createdAt: string) =>
  ok({ accessEntry: { principalArn: ROLE_ARN, createdAt } });

const managedRole = (subjects: string[]) => ({
  Role: {
    Arn: ROLE_ARN,
    CreateDate: ROLE_CREATED_AT,
    AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects),
    Tags: [
      { Key: "radius-managed", Value: "true" },
      { Key: "radius-repository", Value: "octo/shop" }
    ]
  }
});

// A list answers successive calls in order, repeating its last entry.
type Script = Record<string, AwsCommandResult | AwsCommandResult[]>;

// Answers each `aws` command by its first three words, and throws on any
// command the scenario did not script.
// After a successful trust update, `iam get-role` shows the written trust, as
// IAM does once the write is visible. `staleReads` delays that by that many
// reads, the way an eventually consistent read can.
function fakeAws(
  script: Script,
  lockResult: AwsLockResult = { ok: true },
  { staleReads = 0 }: { staleReads?: number } = {}
) {
  let writtenTrust: unknown = undefined;
  let stale = staleReads;
  const calls: string[][] = [];
  const steps: string[] = [];
  const sleeps: number[] = [];
  // The roles locked, and how many AWS commands had run before each lock.
  const locks: Array<{ roleName: string; after: number }> = [];
  return {
    calls,
    steps,
    sleeps,
    locks,
    ports: {
      async acquireLock(role: { accountId: string; roleName: string }) {
        expect(role.accountId).toBe(ACCOUNT);
        locks.push({ roleName: role.roleName, after: calls.length });
        return lockResult;
      },
      async runAws(args: string[]) {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        const scripted = script[key];
        const result =
          Array.isArray(scripted) ?
            scripted.length > 1 ?
              scripted.shift()
            : scripted[0]
          : scripted;
        if (!result) throw new Error(`unexpected aws ${args.join(" ")}`);
        if (key === "iam update-assume-role-policy" && result.code === 0) {
          writtenTrust = JSON.parse(
            args[args.indexOf("--policy-document") + 1] ?? "null"
          );
          stale = staleReads;
          return result;
        }
        if (key === "iam get-role" && writtenTrust !== undefined) {
          if (stale > 0) {
            stale -= 1;
            return result;
          }
          const record = JSON.parse(result.stdout || "{}");
          return ok({
            ...record,
            Role: { ...record.Role, AssumeRolePolicyDocument: writtenTrust }
          });
        }
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

const PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

const existingProvider: Script = {
  "iam list-open-id-connect-providers": ok({
    OpenIDConnectProviderList: [{ Arn: PROVIDER_ARN }]
  }),
  "iam get-open-id-connect-provider": ok({
    ClientIDList: ["sts.amazonaws.com"]
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
      ...existingProvider,
      "iam update-assume-role-policy": ok(),
      "eks create-access-entry": fail("ResourceInUseException: exists"),
      "eks describe-access-entry": entryCreatedAt("2026-10-02T00:00:00Z"),
      "eks associate-access-policy": fail("ResourceInUseException: exists")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({ ok: true, roleArn: ROLE_ARN, roleCreated: false });
    // The entry is newer than the role, so it is the role's own and stays.
    expect(aws.find("eks delete-access-entry")).toBeUndefined();
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

  it("trusts every subject the environment may present on a new role", async () => {
    const aws = fakeAws(happyPath);
    const result = await setupAwsDeployIdentity(
      { ...request, subjects: [DEV, DEV_ID] },
      aws.ports
    );
    expect(result).toEqual({ ok: true, roleArn: ROLE_ARN, roleCreated: true });
    expect(aws.steps).toContain(
      `ℹ️ Deploy identity will trust ${DEV}, ${DEV_ID}`
    );
    const createRole = aws.find("iam create-role") ?? [];
    const trust = parsePolicyDocument(
      JSON.parse(
        createRole[createRole.indexOf("--assume-role-policy-document") + 1] ??
          "{}"
      )
    );
    expect(trustedGitHubSubjects(trust, ACCOUNT)).toEqual([DEV, DEV_ID]);
  });

  it("adds only the subjects a reused role does not trust yet", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok(managedRole([PROD, DEV])),
      ...existingProvider,
      "iam update-assume-role-policy": ok()
    });
    const result = await setupAwsDeployIdentity(
      { ...request, subjects: [DEV, DEV_ID] },
      aws.ports
    );
    expect(result).toMatchObject({ ok: true });
    expect(aws.steps).toContain(
      "ℹ️ Keeping 1 subject(s) already trusted by this role"
    );
    const update = aws.find("iam update-assume-role-policy") ?? [];
    const merged = parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
    expect(trustedGitHubSubjects(merged, ACCOUNT)).toEqual([PROD, DEV, DEV_ID]);
  });

  it("leaves a role that already trusts every subject unchanged", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok(managedRole([DEV, DEV_ID])),
      ...existingProvider
    });
    const result = await setupAwsDeployIdentity(
      { ...request, subjects: [DEV, DEV_ID] },
      aws.ports
    );
    expect(result).toMatchObject({ ok: true });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
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
      "a sign-in check that timed out",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": {
          code: 1,
          stdout: "",
          stderr: "",
          timedOut: true
        }
      },
      "aws-cli-login-required",
      "then retry. the AWS CLI call timed out"
    ],
    [
      "a sign-in check that timed out after printing",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": {
          code: 1,
          stdout: "",
          stderr: "partial",
          timedOut: true
        }
      },
      "aws-cli-login-required",
      "then retry. the AWS CLI call timed out (partial)"
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
      created: [
        `the GitHub identity provider in account ${ACCOUNT}`,
        `IAM role ${ROLE}`,
        `policy radius-deploy-dev on ${ROLE}`
      ]
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
        `the GitHub identity provider in account ${ACCOUNT}`,
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

  it("refuses a picked role Radius created for another repository", async () => {
    const other = `arn:aws:iam::${ACCOUNT}:role/radius-deploy-octo-api`;
    const aws = fakeAws({
      ...freeChecks,
      "iam get-role": ok({
        Role: {
          Arn: other,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
            "repo:octo/api:environment:dev"
          ]),
          Tags: [
            { Key: "Radius-Managed", Value: "true" },
            { Key: "radius-repository", Value: "octo/api" }
          ]
        }
      })
    });
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn: other },
      aws.ports
    );
    expect(result).toEqual({
      ok: false,
      code: "aws-role-other-repository",
      message:
        "Radius created IAM role radius-deploy-octo-api for octo/api, so it cannot be used for octo/shop. Nothing was changed. Pick another role or let Radius create one.",
      created: []
    });
    expect(aws.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "--version",
      "sts get-caller-identity",
      "eks describe-cluster",
      "iam get-role"
    ]);
  });

  it("accepts a picked role Radius created for this repository in another case", async () => {
    const aws = fakeAws({
      ...freeChecks,
      ...existingProvider,
      "iam get-role": ok({
        Role: {
          ...managedRole([PROD]).Role,
          Tags: [
            { Key: "radius-managed", Value: "true" },
            { Key: "radius-repository", Value: "Octo/Shop" }
          ]
        }
      }),
      "iam update-assume-role-policy": ok(),
      "iam put-role-policy": ok(),
      "eks create-access-entry": ok(),
      "eks associate-access-policy": ok()
    });
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn: ROLE_ARN },
      aws.ports
    );
    expect(result).toMatchObject({ ok: true, roleCreated: false });
  });
});

describe("setupAwsDeployIdentity failure paths", () => {
  const raw = (
    stdout: string,
    code: number | string = 0
  ): AwsCommandResult => ({ code, stdout, stderr: "" });
  const managedRoleWithout = (
    patch: Record<string, unknown>
  ): AwsCommandResult => ok({ Role: { ...managedRole([DEV]).Role, ...patch } });

  it.each<[string, Script, string, string]>([
    [
      "the CLI exits non-zero after printing a supported version",
      { "--version": raw("aws-cli/2.17.0 Python/3.11", 1) },
      "aws-cli-unsupported",
      "Could not run the AWS CLI: aws-cli/2.17.0 Python/3.11"
    ],
    [
      "the CLI session answers no readable account",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": raw("not json")
      },
      "aws-account-mismatch",
      "signed in to account (unknown)"
    ],
    [
      "the cluster reports no access configuration",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": freeChecks["sts get-caller-identity"],
        "eks describe-cluster": ok({})
      },
      "aws-cluster-config-map",
      "shop"
    ],
    [
      "the role cannot be read for a reason other than its absence",
      { ...freeChecks, "iam get-role": raw("", 254) },
      "aws-role-unreadable",
      `Could not read IAM role ${ROLE}: no output`
    ],
    [
      "the identity providers cannot be listed",
      {
        ...happyPath,
        "iam list-open-id-connect-providers": fail("Throttling")
      },
      "aws-oidc-provider-unreadable",
      "Throttling"
    ],
    [
      "the identity provider cannot be created",
      {
        ...happyPath,
        "iam create-open-id-connect-provider": fail("LimitExceeded")
      },
      "aws-oidc-provider-failed",
      "LimitExceeded"
    ],
    [
      "the identity is denied creating the identity provider",
      {
        ...happyPath,
        "iam create-open-id-connect-provider": fail("AccessDenied")
      },
      "aws-oidc-provider-denied",
      "Ask an IAM administrator to run"
    ],
    [
      "the role cannot be created",
      { ...happyPath, "iam create-role": fail("MalformedPolicyDocument") },
      "aws-role-create-failed",
      `Failed to create IAM role ${ROLE}: MalformedPolicyDocument`
    ],
    [
      "the existing role's trust policy is unreadable",
      {
        ...happyPath,
        "iam get-role": managedRoleWithout({
          AssumeRolePolicyDocument: "{not json"
        })
      },
      "aws-role-trust-unreadable",
      `Could not read the trust policy of IAM role ${ROLE}`
    ],
    [
      "the existing role's trust cannot be updated",
      {
        ...happyPath,
        "iam get-role": ok(managedRole([PROD])),
        "iam update-assume-role-policy": fail("AccessDenied")
      },
      "aws-role-trust-denied",
      "Failed to update the role's trust policy: AccessDenied"
    ],
    [
      "the deploy permission policy cannot be attached",
      {
        ...happyPath,
        "iam put-role-policy": fail("MalformedPolicyDocument: bad")
      },
      "aws-role-policy-failed",
      "Failed to attach the deploy permission policy: MalformedPolicyDocument"
    ]
  ])("fails when %s", async (_label, script, code, message) => {
    const aws = fakeAws(script);
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({ ok: false, code });
    expect(!result.ok && result.message).toContain(message);
  });

  describe("a role at IAM's size limits", () => {
    it.each([[[DEV]], [[DEV, DEV_ID]]])(
      "reports a full trust policy with next steps and writes nothing else (subjects %j)",
      async (subjects) => {
        const aws = fakeAws({
          ...happyPath,
          "iam get-role": ok(managedRole([PROD])),
          ...existingProvider,
          "iam update-assume-role-policy": fail(
            "An error occurred (LimitExceeded) when calling the UpdateAssumeRolePolicy operation: Cannot exceed quota for ACLSizePerRole: 2048"
          )
        });
        const result = await setupAwsDeployIdentity(
          { ...request, subjects },
          aws.ports
        );
        expect(result).toMatchObject({
          ok: false,
          code: "aws-role-limit-exceeded",
          created: []
        });
        const message = !result.ok ? result.message : "";
        expect(message).toContain(
          `IAM role ${ROLE} cannot trust another environment`
        );
        expect(message).toContain("ACLSizePerRole: 2048");
        expect(message).toContain(
          "Delete an environment that no longer uses this role"
        );
        expect(message).toContain("choose another role");
        expect(message).toContain(
          '"Role trust policy length" quota (up to 8,192 characters)'
        );
        expect(aws.find("iam put-role-policy")).toBeUndefined();
      }
    );

    it("reports full inline policies after naming the trust it already added", async () => {
      const aws = fakeAws({
        ...happyPath,
        "iam get-role": ok(managedRole([PROD])),
        ...existingProvider,
        "iam update-assume-role-policy": ok(),
        "iam put-role-policy": fail(
          "An error occurred (LimitExceeded) when calling the PutRolePolicy operation: Maximum policy size of 10240 bytes exceeded for role radius-deploy-octo-shop"
        )
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({
        ok: false,
        code: "aws-role-limit-exceeded",
        created: [`trust for ${DEV} on ${ROLE}`]
      });
      const message = !result.ok ? result.message : "";
      expect(message).toContain(
        `IAM role ${ROLE} cannot hold another environment's permission policy`
      );
      expect(message).toContain(
        "10,240-character limit, which cannot be raised"
      );
      expect(message).toContain("Maximum policy size of 10240 bytes exceeded");
      expect(message).toContain(
        "Delete an environment that no longer uses this role, or choose another role."
      );
      expect(aws.find("eks create-access-entry")).toBeUndefined();
    });
  });

  describe("an access entry that already exists", () => {
    const inUse = fail(
      "ResourceInUseException: The specified access entry resource is already in use on this cluster."
    );

    it("replaces the entry left by an earlier role when setup created the role", async () => {
      const aws = fakeAws({
        ...happyPath,
        "eks create-access-entry": [inUse, ok()],
        "eks delete-access-entry": ok()
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toEqual({
        ok: true,
        roleArn: ROLE_ARN,
        roleCreated: true
      });
      expect(aws.find("eks describe-access-entry")).toBeUndefined();
      expect(aws.find("eks delete-access-entry")).toEqual(
        expect.arrayContaining([
          "--principal-arn",
          ROLE_ARN,
          "--region",
          "us-west-2"
        ])
      );
      expect(
        aws.calls.filter((args) => args[1] === "create-access-entry")
      ).toHaveLength(2);
      expect(aws.steps).toContain(
        `ℹ️ Deleted the access entry on shop left by an earlier IAM role named ${ROLE}.`
      );
      expect(aws.steps.at(-1)).toBe(
        "✅ Granted the role cluster-admin on shop."
      );
    });

    it("replaces an entry older than an existing role", async () => {
      const aws = fakeAws({
        ...happyPath,
        "iam get-role": ok(managedRole([DEV])),
        ...existingProvider,
        "eks create-access-entry": [inUse, ok()],
        "eks describe-access-entry": entryCreatedAt("2026-09-01T00:00:00.000Z"),
        "eks delete-access-entry": ok()
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({ ok: true, roleCreated: false });
      expect(aws.find("eks delete-access-entry")).toBeDefined();
      expect(aws.steps).toContain(
        `ℹ️ Deleted the access entry on shop left by an earlier IAM role named ${ROLE}.`
      );
    });

    it.each([
      ["the entry cannot be read", fail("AccessDeniedException")],
      ["the entry has no creation time", ok({ accessEntry: {} })]
    ])("does not report success when %s", async (_label, describeEntry) => {
      const aws = fakeAws({
        ...happyPath,
        "iam get-role": ok(managedRole([DEV])),
        ...existingProvider,
        "eks create-access-entry": inUse,
        "eks describe-access-entry": describeEntry
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({
        ok: false,
        code: "aws-access-entry-unverified"
      });
      expect(!result.ok && result.message).toContain(
        `aws eks delete-access-entry --cluster-name shop --principal-arn ${ROLE_ARN} --region us-west-2`
      );
      expect(aws.find("eks delete-access-entry")).toBeUndefined();
      expect(aws.find("eks associate-access-policy")).toBeUndefined();
    });

    it("does not report success when a role without a creation time finds an entry", async () => {
      const role = managedRole([DEV]);
      const aws = fakeAws({
        ...happyPath,
        "iam get-role": ok({ Role: { ...role.Role, CreateDate: undefined } }),
        ...existingProvider,
        "eks create-access-entry": inUse,
        "eks describe-access-entry": entryCreatedAt("2026-10-02T00:00:00Z")
      });
      expect(await setupAwsDeployIdentity(request, aws.ports)).toMatchObject({
        ok: false,
        code: "aws-access-entry-unverified"
      });
    });

    it("stops when the stale entry cannot be deleted", async () => {
      const aws = fakeAws({
        ...happyPath,
        "eks create-access-entry": inUse,
        "eks delete-access-entry": fail("AccessDeniedException: denied")
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({
        ok: false,
        code: "aws-access-entry-failed"
      });
      expect(!result.ok && result.message).toContain(
        `left by an earlier IAM role named ${ROLE}, and Radius could not delete it: AccessDeniedException: denied`
      );
    });

    it("stops when an entry is still in use after the stale one was deleted", async () => {
      const aws = fakeAws({
        ...happyPath,
        "eks create-access-entry": inUse,
        "eks delete-access-entry": ok()
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({
        ok: false,
        code: "aws-access-entry-failed"
      });
      expect(aws.find("eks associate-access-policy")).toBeUndefined();
    });
  });

  it("does not write the role's trust when it already trusts the environment", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok(managedRole([DEV]))
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({ ok: true, roleArn: ROLE_ARN, roleCreated: false });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("derives the role ARN when IAM does not report one", async () => {
    const created = fakeAws({ ...happyPath, "iam create-role": ok({}) });
    expect(await setupAwsDeployIdentity(request, created.ports)).toMatchObject({
      ok: true,
      roleArn: ROLE_ARN
    });
    const reused = fakeAws({
      ...happyPath,
      "iam get-role": managedRoleWithout({ Arn: undefined })
    });
    expect(await setupAwsDeployIdentity(request, reused.ports)).toMatchObject({
      ok: true,
      roleArn: ROLE_ARN
    });
  });
});

describe("setupAwsDeployIdentity safety gates", () => {
  const MUTATIONS = new Set([
    "create-open-id-connect-provider",
    "create-role",
    "update-assume-role-policy",
    "put-role-policy",
    "create-access-entry",
    "associate-access-policy"
  ]);
  const writes = (calls: string[][]): string[] =>
    calls.map((args) => args[1]).filter((command) => MUTATIONS.has(command));

  it.each(["us-gov-west-1", "cn-north-1"])(
    "refuses region %s before running the AWS CLI",
    async (region) => {
      const aws = fakeAws({});
      const result = await setupAwsDeployIdentity(
        { ...request, region },
        aws.ports
      );
      expect(result).toMatchObject({
        ok: false,
        code: "aws-partition-unsupported",
        created: []
      });
      expect(aws.calls).toEqual([]);
    }
  );

  it("refuses a picked role outside the commercial partition", async () => {
    const aws = fakeAws(freeChecks);
    const result = await setupAwsDeployIdentity(
      {
        ...request,
        existingRoleArn: `arn:aws-us-gov:iam::${ACCOUNT}:role/${ROLE}`
      },
      aws.ports
    );
    expect(result).toMatchObject({
      ok: false,
      code: "aws-partition-unsupported"
    });
    expect(writes(aws.calls)).toEqual([]);
  });

  it("reads an existing role's trust before creating the identity provider", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok({
        Role: { ...managedRole([DEV]).Role, AssumeRolePolicyDocument: "{bad" }
      })
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({
      ok: false,
      code: "aws-role-trust-unreadable",
      created: []
    });
    expect(writes(aws.calls)).toEqual([]);
    expect(aws.find("iam list-open-id-connect-providers")).toBeUndefined();
  });

  it.each([
    ["empty output", ok("")],
    ["malformed output", ok("not json")],
    ["no provider list", ok({ Providers: [] })]
  ])(
    "stops on an unreadable provider inventory with %s",
    async (_label, answer) => {
      const aws = fakeAws({
        ...happyPath,
        "iam list-open-id-connect-providers": answer
      });
      const result = await setupAwsDeployIdentity(request, aws.ports);
      expect(result).toMatchObject({
        ok: false,
        code: "aws-oidc-provider-unreadable"
      });
      expect(writes(aws.calls)).toEqual([]);
    }
  );

  it("changes nothing when IAM answers with no role", async () => {
    const removal = fakeAws({
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok({})
    });
    expect(
      await removeAwsEnvironmentFromRole(
        { roleArn: ROLE_ARN, environment: "dev", subjects: [DEV] },
        removal.ports
      )
    ).toMatchObject({ ok: false });
    expect(removal.calls).toHaveLength(2);
  });

  it("does not claim a provider another setup created first", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam create-open-id-connect-provider": fail("EntityAlreadyExists")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({ ok: true });
    const failing = fakeAws({
      ...happyPath,
      "iam create-open-id-connect-provider": fail("EntityAlreadyExists"),
      "iam put-role-policy": fail("MalformedPolicyDocument")
    });
    expect(await setupAwsDeployIdentity(request, failing.ports)).toMatchObject({
      ok: false,
      created: [`IAM role ${ROLE}`]
    });
  });

  it("recognizes only this account's GitHub provider", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam list-open-id-connect-providers": ok({
        OpenIDConnectProviderList: [
          {
            Arn: "arn:aws:iam::999988887777:oidc-provider/token.actions.githubusercontent.com"
          },
          { Arn: `${PROVIDER_ARN}/enterprise` }
        ]
      })
    });
    await setupAwsDeployIdentity(request, aws.ports);
    expect(aws.find("iam create-open-id-connect-provider")).toBeDefined();
  });

  it.each([
    [
      "does not accept GitHub's AWS audience",
      ok({ ClientIDList: ["custom"] }),
      "aws-oidc-provider-audience"
    ],
    ["cannot be read", fail("AccessDenied"), "aws-oidc-provider-unreadable"],
    ["answers no client list", ok({}), "aws-oidc-provider-unreadable"]
  ])("stops when the existing provider %s", async (_label, answer, code) => {
    const aws = fakeAws({
      ...happyPath,
      ...existingProvider,
      "iam get-open-id-connect-provider": answer
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({ ok: false, code, created: [] });
    expect(writes(aws.calls)).toEqual([]);
    if (code === "aws-oidc-provider-audience") {
      expect(!result.ok && result.message).toContain(
        `aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${PROVIDER_ARN} --client-id sts.amazonaws.com`
      );
    }
  });

  it("trusts the environment on a picked role that restricts the subject with two operators", async () => {
    const restricted = {
      Effect: "Allow",
      Principal: { Federated: PROVIDER_ARN },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": PROD
        },
        StringLike: { "token.actions.githubusercontent.com:sub": PROD }
      }
    };
    const aws = fakeAws({
      ...happyPath,
      ...existingProvider,
      "iam get-role": ok({
        Role: {
          Arn: ROLE_ARN,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [restricted]
          }
        }
      }),
      "iam update-assume-role-policy": ok()
    });
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn: ROLE_ARN },
      aws.ports
    );
    expect(result).toMatchObject({ ok: true });
    const update = aws.find("iam update-assume-role-policy") ?? [];
    const written = JSON.parse(
      update[update.indexOf("--policy-document") + 1] ?? "{}"
    );
    expect(written.Statement).toEqual([
      restricted,
      {
        Effect: "Allow",
        Principal: { Federated: PROVIDER_ARN },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": [DEV]
          }
        }
      }
    ]);
  });

  it("adds trust to a picked role whose existing statement uses another audience", async () => {
    const picked = {
      Role: {
        Arn: ROLE_ARN,
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Federated: PROVIDER_ARN },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: {
                StringEquals: {
                  "token.actions.githubusercontent.com:aud": "custom",
                  "token.actions.githubusercontent.com:sub": DEV
                }
              }
            }
          ]
        }
      }
    };
    const aws = fakeAws({
      ...happyPath,
      ...existingProvider,
      "iam get-role": ok(picked),
      "iam update-assume-role-policy": ok()
    });
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn: ROLE_ARN },
      aws.ports
    );
    expect(result).toMatchObject({ ok: true });
    const update = aws.find("iam update-assume-role-policy") ?? [];
    const written = JSON.parse(
      update[update.indexOf("--policy-document") + 1] ?? "{}"
    );
    expect(written.Statement).toHaveLength(2);
    expect(written.Statement[1].Condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": [DEV]
    });
  });
});

describe("removeAwsEnvironmentFromRole", () => {
  const removal = { roleArn: ROLE_ARN, environment: "dev", subjects: [DEV] };
  const signedIn: Script = {
    "sts get-caller-identity": ok({ Account: ACCOUNT })
  };

  it("removes only this environment's subject and policy", async () => {
    const aws = fakeAws({
      ...signedIn,
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

  it("removes every subject the environment recorded in one update", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([DEV, PROD, DEV_ID])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    });
    const result = await removeAwsEnvironmentFromRole(
      { ...removal, subjects: [DEV, DEV_ID] },
      aws.ports
    );
    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev"
      ]
    });
    expect(
      aws.calls.filter((args) => args[1] === "update-assume-role-policy")
    ).toHaveLength(1);
    const update = aws.find("iam update-assume-role-policy") ?? [];
    const remaining = parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
    expect(trustedGitHubSubjects(remaining, ACCOUNT)).toEqual([PROD]);
  });

  it("names only the subjects it removed when one was already gone", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([DEV_ID, PROD])),
      "iam update-assume-role-policy": fail("AccessDenied")
    });
    const result = await removeAwsEnvironmentFromRole(
      { ...removal, subjects: [DEV, DEV_ID] },
      aws.ports
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain(
      `Failed to remove ${DEV_ID} from the role's trust policy`
    );
  });

  it("reports a role that is already gone and continues", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": fail("NoSuchEntity")
    });
    expect(await removeAwsEnvironmentFromRole(removal, aws.ports)).toEqual({
      ok: true,
      removed: [],
      kept: [`IAM role ${ROLE} was already gone`]
    });
  });

  it("fails without writing when the role's trust policy is unreadable", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok({
        Role: { Arn: ROLE_ARN, AssumeRolePolicyDocument: "{not json" }
      })
    });
    const result = await removeAwsEnvironmentFromRole(removal, aws.ports);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain(
      `Could not read the trust policy of IAM role ${ROLE}`
    );
    expect(aws.calls.map((args) => args[1])).toEqual([
      "get-caller-identity",
      "get-role"
    ]);
  });

  it.each([
    ["signed in to another account", ok({ Account: "999988887777" })],
    ["not signed in", fail("Unable to locate credentials")],
    ["answering no account", ok("not json")]
  ])("changes nothing when the CLI session is %s", async (_label, identity) => {
    const aws = fakeAws({
      "sts get-caller-identity": identity,
      "iam get-role": ok(managedRole([DEV]))
    });
    const result = await removeAwsEnvironmentFromRole(removal, aws.ports);
    expect(result).toMatchObject({ ok: false });
    expect(aws.calls.map((args) => args[1])).toEqual(["get-caller-identity"]);
  });

  it.each([
    ["a role in another account", `arn:aws:iam::999988887777:role/${ROLE}`],
    ["a differently named role", `arn:aws:iam::${ACCOUNT}:role/other`],
    ["no role ARN", undefined],
    ["a malformed role ARN", "role/radius-deploy-octo-shop"]
  ])("changes nothing when IAM returns %s", async (_label, arn) => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok({ Role: { ...managedRole([DEV]).Role, Arn: arn } })
    });
    const result = await removeAwsEnvironmentFromRole(removal, aws.ports);
    expect(result).toMatchObject({ ok: false });
    expect(aws.calls.map((args) => args[1])).toEqual([
      "get-caller-identity",
      "get-role"
    ]);
  });

  it("accepts the role ARN IAM returns with a path and different case", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok({
        Role: {
          ...managedRole([PROD]).Role,
          Arn: `arn:aws:iam::${ACCOUNT}:role/team/${ROLE.toUpperCase()}`
        }
      }),
      "iam delete-role-policy": ok()
    });
    expect(
      await removeAwsEnvironmentFromRole(removal, aws.ports)
    ).toMatchObject({ ok: true });
  });

  it("refuses a role outside the commercial partition without calling AWS", async () => {
    const aws = fakeAws({});
    expect(
      await removeAwsEnvironmentFromRole(
        { ...removal, roleArn: `arn:aws-us-gov:iam::${ACCOUNT}:role/${ROLE}` },
        aws.ports
      )
    ).toMatchObject({ ok: false });
    expect(aws.calls).toEqual([]);
  });

  it("treats a missing policy as already removed", async () => {
    const aws = fakeAws({
      ...signedIn,
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
    const aws = fakeAws({ ...signedIn, ...script });
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

describe("deploy identity lock order", () => {
  const LOCK_DENIED: AwsLockResult = {
    ok: false,
    code: "aws-lock-denied",
    message: "not allowed iam:CreatePolicy"
  };

  it("locks the role after the read-only checks and before reading its trust policy", async () => {
    const aws = fakeAws(happyPath);
    await setupAwsDeployIdentity(request, aws.ports);
    expect(aws.locks).toEqual([{ roleName: ROLE, after: 3 }]);
    expect(
      aws.calls.slice(0, 3).map((args) => args.slice(0, 2).join(" "))
    ).toEqual(["--version", "sts get-caller-identity", "eks describe-cluster"]);
    expect(aws.calls[3]?.slice(0, 2)).toEqual(["iam", "get-role"]);
  });

  it("locks the picked role by its own name", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT}:role/platform/team-deployer`,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [PROD])
        }
      }),
      ...existingProvider,
      "iam update-assume-role-policy": ok()
    });
    await setupAwsDeployIdentity(
      {
        ...request,
        existingRoleArn: `arn:aws:iam::${ACCOUNT}:role/platform/team-deployer`
      },
      aws.ports
    );
    expect(aws.locks.map(({ roleName }) => roleName)).toEqual([
      "team-deployer"
    ]);
  });

  it("stops with nothing created when the lock cannot be taken", async () => {
    const aws = fakeAws(happyPath, LOCK_DENIED);
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({
      ok: false,
      code: "aws-lock-denied",
      message: "not allowed iam:CreatePolicy",
      created: []
    });
    expect(aws.calls).toHaveLength(3);
  });

  it.each([
    ["the CLI is too old", { "--version": ok("aws-cli/2.7.0 Python/3") }],
    [
      "the session is in another account",
      { "sts get-caller-identity": ok({ Account: "999999999999" }) }
    ],
    [
      "the cluster uses CONFIG_MAP",
      { "eks describe-cluster": ok({ cluster: {} }) }
    ]
  ])("takes no lock when %s", async (_label, override) => {
    const aws = fakeAws({ ...happyPath, ...override });
    expect((await setupAwsDeployIdentity(request, aws.ports)).ok).toBe(false);
    expect(aws.locks).toEqual([]);
  });

  it("takes no lock for a picked role in another account", async () => {
    const aws = fakeAws(happyPath);
    const result = await setupAwsDeployIdentity(
      { ...request, existingRoleArn: "arn:aws:iam::999999999999:role/other" },
      aws.ports
    );
    expect(result).toMatchObject({ ok: false, code: "aws-role-wrong-account" });
    expect(aws.locks).toEqual([]);
  });

  it("locks delete after the account check and before reading the role", async () => {
    const aws = fakeAws({
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    });
    await removeAwsEnvironmentFromRole(
      { roleArn: ROLE_ARN, environment: "dev", subjects: [DEV] },
      aws.ports
    );
    expect(aws.locks).toEqual([{ roleName: ROLE, after: 1 }]);
  });

  it("changes nothing on delete when the lock cannot be taken", async () => {
    const aws = fakeAws(
      { "sts get-caller-identity": ok({ Account: ACCOUNT }) },
      LOCK_DENIED
    );
    expect(
      await removeAwsEnvironmentFromRole(
        { roleArn: ROLE_ARN, environment: "dev", subjects: [DEV] },
        aws.ports
      )
    ).toEqual({ ok: false, message: "not allowed iam:CreatePolicy" });
    expect(aws.calls).toHaveLength(1);
  });

  it("takes no delete lock when the session is in another account", async () => {
    const aws = fakeAws({
      "sts get-caller-identity": ok({ Account: "999999999999" })
    });
    await removeAwsEnvironmentFromRole(
      { roleArn: ROLE_ARN, environment: "dev", subjects: [DEV] },
      aws.ports
    );
    expect(aws.locks).toEqual([]);
  });
});

describe("waiting for IAM to show a trust policy write", () => {
  const reusedRole: Script = {
    ...happyPath,
    "iam get-role": ok(managedRole([PROD])),
    ...existingProvider,
    "iam update-assume-role-policy": ok(),
    "eks create-access-entry": fail("ResourceInUseException: exists"),
    "eks describe-access-entry": entryCreatedAt("2026-10-02T00:00:00Z"),
    "eks associate-access-policy": fail("ResourceInUseException: exists")
  };
  const getRoleCount = (aws: ReturnType<typeof fakeAws>) =>
    aws.calls.filter((args) => args[1] === "get-role").length;

  it("rereads the role until IAM shows the write before setup goes on", async () => {
    const aws = fakeAws(reusedRole, { ok: true }, { staleReads: 2 });

    const result = await setupAwsDeployIdentity(request, aws.ports);

    expect(result).toMatchObject({ ok: true });
    expect(aws.sleeps).toEqual([1000, 2000]);
    // One read before the write, then two stale reads and the fresh one.
    expect(getRoleCount(aws)).toBe(4);
    const commands = aws.calls.map((args) => args.slice(0, 2).join(" "));
    expect(commands.indexOf("iam put-role-policy")).toBeGreaterThan(
      commands.lastIndexOf("iam get-role")
    );
  });

  it("stops setup when IAM never shows the write", async () => {
    const aws = fakeAws(reusedRole, { ok: true }, { staleReads: 99 });

    const result = await setupAwsDeployIdentity(request, aws.ports);

    expect(result).toMatchObject({
      ok: false,
      code: "aws-role-trust-unconfirmed",
      message: `IAM did not show the updated trust policy of IAM role ${ROLE} after the update, so Radius stopped. Retry setup.`,
      created: [`trust for ${DEV} on ${ROLE}`]
    });
    expect(aws.sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(aws.find("iam put-role-policy")).toBeUndefined();
  });

  it("keeps waiting when a reread fails or returns no trust policy", async () => {
    const aws = fakeAws(
      {
        ...reusedRole,
        "iam get-role": [
          ok(managedRole([PROD])),
          fail("Throttling"),
          ok({ Role: { AssumeRolePolicyDocument: "%7Bnot json" } }),
          ok(managedRole([PROD]))
        ]
      },
      { ok: true },
      { staleReads: 2 }
    );

    const result = await setupAwsDeployIdentity(request, aws.ports);

    expect(result).toMatchObject({ ok: true });
    expect(aws.sleeps).toEqual([1000, 2000]);
  });

  it("waits on delete too, and stops the deletion when IAM never shows the write", async () => {
    const script: Script = {
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    };
    const removal = { roleArn: ROLE_ARN, environment: "dev", subjects: [DEV] };

    const settled = fakeAws(script, { ok: true }, { staleReads: 1 });
    expect(
      await removeAwsEnvironmentFromRole(removal, settled.ports)
    ).toMatchObject({ ok: true });
    expect(settled.sleeps).toEqual([1000]);

    const never = fakeAws(script, { ok: true }, { staleReads: 99 });
    expect(await removeAwsEnvironmentFromRole(removal, never.ports)).toEqual({
      ok: false,
      message: `IAM did not show the updated trust policy of IAM role ${ROLE} after the update, so Radius stopped. Retry the deletion.`
    });
    expect(never.find("iam delete-role-policy")).toBeUndefined();
  });
});

describe("repairAwsEnvironmentTrust", () => {
  const repair = {
    repo: "octo/shop",
    roleArn: ROLE_ARN,
    subjects: [DEV, DEV_ID]
  };
  const ready: Script = {
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-open-id-connect-provider": ok({
      ClientIDList: ["sts.amazonaws.com"]
    }),
    "iam get-role": ok(managedRole([PROD, DEV])),
    "iam update-assume-role-policy": ok()
  };
  const written = (aws: ReturnType<typeof fakeAws>) => {
    const update = aws.find("iam update-assume-role-policy") ?? [];
    return parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
  };

  it("adds back only the missing subjects and keeps everything else", async () => {
    const aws = fakeAws(ready);

    const result = await repairAwsEnvironmentTrust(repair, aws.ports);

    expect(result).toEqual({ ok: true, roleName: ROLE, added: [DEV_ID] });
    expect(trustedGitHubSubjects(written(aws), ACCOUNT)).toEqual([
      PROD,
      DEV,
      DEV_ID
    ]);
    // Read-only checks first, then the lock, then the role.
    expect(aws.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "sts get-caller-identity",
      "iam get-open-id-connect-provider",
      "iam get-role",
      "iam update-assume-role-policy",
      "iam get-role"
    ]);
    expect(aws.locks).toEqual([{ roleName: ROLE, after: 2 }]);
  });

  it("keeps trust statements Radius did not add", async () => {
    const other = {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole"
    };
    const role = managedRole([PROD]);
    role.Role.AssumeRolePolicyDocument.Statement.push(other);
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

    await repairAwsEnvironmentTrust(repair, aws.ports);

    expect(written(aws).Statement).toContainEqual(other);
  });

  const unmanagedRole = (subjects: string[]) => ({
    Role: {
      Arn: ROLE_ARN,
      AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects)
    }
  });

  it("adds to a role Radius did not tag when it trusts another environment of this repository", async () => {
    const aws = fakeAws({
      ...ready,
      "iam get-role": ok(unmanagedRole([PROD]))
    });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: true,
      added: [DEV, DEV_ID]
    });
  });

  it("adds to a role Radius created for this repository even when it trusts nothing", async () => {
    const role = managedRole([]);
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: true,
      added: [DEV, DEV_ID]
    });
  });

  it.each([
    [
      "trusts only another repository",
      unmanagedRole(["repo:mallory/evil:environment:dev"])
    ],
    ["trusts no GitHub subject", unmanagedRole([])],
    [
      "Radius created for another repository",
      {
        Role: {
          ...managedRole(["repo:octo/web:environment:dev"]).Role,
          Tags: [
            { Key: "radius-managed", Value: "true" },
            { Key: "radius-repository", Value: "octo/web" }
          ]
        }
      }
    ]
  ])("refuses a role that %s, changing nothing", async (_label, role) => {
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

    const result = await repairAwsEnvironmentTrust(repair, aws.ports);

    expect(result).toEqual({
      ok: false,
      code: "aws-role-not-this-repository",
      message: `IAM role ${ROLE} was not created by Radius for octo/shop and trusts no other environment of it, so Radius will not add trust to it. Nothing was changed. Check that the environment's AWS_ROLE_ARN names the right role; if it does, add ${DEV}, ${DEV_ID} to its trust policy yourself.`
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("does not count a subject without an environment as this repository's", async () => {
    const aws = fakeAws({
      ...ready,
      "iam get-role": ok(unmanagedRole(["repo:octo/shop:ref:refs/heads/main"]))
    });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: false,
      code: "aws-role-not-this-repository"
    });
  });

  it("changes nothing when the role already trusts every subject", async () => {
    const aws = fakeAws({
      ...ready,
      "iam get-role": ok(managedRole([DEV, DEV_ID]))
    });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
      ok: true,
      roleName: ROLE,
      added: []
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it.each([
    [
      "an ARN that is not a role",
      { ...repair, roleArn: "not-an-arn" },
      ready,
      "aws-role-invalid"
    ],
    [
      "a role outside the commercial partition",
      { ...repair, roleArn: `arn:aws-cn:iam::${ACCOUNT}:role/${ROLE}` },
      ready,
      "aws-partition-unsupported"
    ],
    [
      "no AWS CLI session",
      repair,
      {
        ...ready,
        "sts get-caller-identity": fail("Unable to locate credentials")
      },
      "aws-cli-login-required"
    ],
    [
      "a session in another account",
      repair,
      { ...ready, "sts get-caller-identity": ok({ Account: "999999999999" }) },
      "aws-account-mismatch"
    ],
    [
      "no GitHub identity provider",
      repair,
      {
        ...ready,
        "iam get-open-id-connect-provider": fail("NoSuchEntity: gone")
      },
      "aws-oidc-provider-missing"
    ],
    [
      "an unreadable GitHub identity provider",
      repair,
      { ...ready, "iam get-open-id-connect-provider": fail("AccessDenied") },
      "aws-oidc-provider-unreadable"
    ],
    [
      "a provider without the AWS audience",
      repair,
      {
        ...ready,
        "iam get-open-id-connect-provider": ok({ ClientIDList: ["other"] })
      },
      "aws-oidc-provider-audience"
    ],
    [
      "a provider that answers without a client list",
      repair,
      { ...ready, "iam get-open-id-connect-provider": ok("{") },
      "aws-oidc-provider-audience"
    ]
  ])("stops before the lock for %s", async (_label, request, script, code) => {
    const aws = fakeAws(script);
    expect(await repairAwsEnvironmentTrust(request, aws.ports)).toMatchObject({
      ok: false,
      code
    });
    expect(aws.locks).toEqual([]);
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("names the command that adds the missing provider", async () => {
    const aws = fakeAws({
      ...ready,
      "iam get-open-id-connect-provider": fail("NoSuchEntity: gone")
    });
    const result = await repairAwsEnvironmentTrust(repair, aws.ports);
    expect("message" in result && result.message).toContain(
      "aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com"
    );
  });

  it("stops when the lock cannot be taken", async () => {
    const aws = fakeAws(ready, {
      ok: false,
      code: "aws-lock-busy",
      message: "busy"
    });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
      ok: false,
      code: "aws-lock-busy",
      message: "busy"
    });
    expect(aws.find("iam get-role")).toBeUndefined();
  });

  it.each([
    [fail("NoSuchEntity: no role"), "aws-role-missing"],
    [fail("Throttling"), "aws-role-unreadable"],
    [
      ok({ Role: { AssumeRolePolicyDocument: "%7Bnot json" } }),
      "aws-role-trust-unreadable"
    ],
    [ok({}), "aws-role-trust-unreadable"]
  ])("changes nothing when the role reads as %j", async (answer, code) => {
    const aws = fakeAws({ ...ready, "iam get-role": answer });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: false,
      code
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it.each([
    [fail("LimitExceeded: too long"), "aws-role-limit-exceeded"],
    [fail("AccessDenied"), "aws-role-trust-denied"]
  ])("reports a refused trust update as %s", async (answer, code) => {
    const aws = fakeAws({ ...ready, "iam update-assume-role-policy": answer });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: false,
      code
    });
  });

  it("waits for IAM to show the update, and stops when it never does", async () => {
    const settled = fakeAws(ready, { ok: true }, { staleReads: 1 });
    expect(
      await repairAwsEnvironmentTrust(repair, settled.ports)
    ).toMatchObject({ ok: true, added: [DEV_ID] });
    expect(settled.sleeps).toEqual([1000]);

    const never = fakeAws(ready, { ok: true }, { staleReads: 99 });
    expect(await repairAwsEnvironmentTrust(repair, never.ports)).toEqual({
      ok: false,
      code: "aws-role-trust-unconfirmed",
      message: `IAM did not show the updated trust policy of IAM role ${ROLE} after the update, so Radius stopped. Run Repair again.`
    });
  });
});
