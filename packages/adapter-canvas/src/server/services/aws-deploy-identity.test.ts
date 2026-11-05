import { describe, expect, it } from "vitest";
import {
  buildGitHubTrustPolicy,
  buildAwsEnvironmentPermissionPolicy,
  trustedGitHubSubjects,
  parsePolicyDocument,
  repositoryLessSubjectMessage
} from "@radius-project/core";
import {
  CLUSTER_ACTIVE_WAIT_DELAYS_MS,
  removeAwsEnvironmentFromRole,
  repairAwsEnvironmentTrust,
  setupAwsDeployIdentity,
  type AwsCommandResult,
  type AwsDeployIdentityRequest,
  type AwsDeployIdentityRemovalRequest,
  type AwsEnvironmentListing,
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

const unexpectedListing = async (): Promise<never> => {
  throw new Error("unexpected environment listing");
};

// A delete request for `dev` on cluster shop, and the answer for a cluster
// with no access entry for the role.
const removalRequest: AwsDeployIdentityRemovalRequest = {
  repo: "octo/shop",
  roleArn: ROLE_ARN,
  environment: "dev",
  subjects: [DEV],
  region: "us-west-2",
  cluster: "shop"
};
const NO_ACCESS_ENTRY: AwsCommandResult = {
  code: 254,
  stdout: "",
  stderr:
    "An error occurred (ResourceNotFoundException) when calling DescribeAccessEntry"
};
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
  const identities: Array<{
    roleArn: string;
    policyName: string;
    after: number;
  }> = [];
  return {
    calls,
    steps,
    sleeps,
    locks,
    identities,
    ports: {
      async recordPolicyIdentity(identity: {
        roleArn: string;
        policyName: string;
      }) {
        identities.push({ ...identity, after: calls.length });
      },
      async isRecordedForeignPolicy(): Promise<never> {
        throw new Error("unexpected foreign policy lookup");
      },
      listOtherEnvironments: unexpectedListing,
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
  "iam get-role-policy": fail("NoSuchEntity"),
  "iam list-role-policies": ok({
    PolicyNames: ["radius-deploy-dev-f5fb7acf8f59"]
  }),
  "--version": ok("aws-cli/2.17.0 Python/3.11 Darwin/23"),
  "sts get-caller-identity": ok({ Account: ACCOUNT }),
  "eks describe-cluster": ok({
    cluster: {
      status: "ACTIVE",
      accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" }
    }
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

describe("legacy environment policy migration", () => {
  it.each(["iam get-role-policy", "iam list-role-policies"])(
    "retains trust and policies when %s is denied",
    async (command) => {
      const aws = fakeAws({ ...legacy, [command]: fail("AccessDenied") });
      expect(
        await removeAwsEnvironmentFromRole(removalRequest, aws.ports)
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining("AccessDenied")
      });
      expect(aws.find("iam delete-role-policy")).toBeUndefined();
      expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
    }
  );

  it("rejects a recorded policy for another environment before calling AWS", async () => {
    const aws = fakeAws({});
    expect(
      await setupAwsDeployIdentity(
        { ...request, policyName: "radius-deploy-prod-111111111111" },
        aws.ports
      )
    ).toMatchObject({ ok: false, code: "aws-policy-name-invalid" });
    expect(aws.calls).toEqual([]);
  });

  const legacyDocument = buildAwsEnvironmentPermissionPolicy("us-west-2");
  const legacyResponse = ok({
    PolicyName: "radius-deploy-dev",
    PolicyDocument: legacyDocument
  });
  const legacy: Script = {
    ...happyPath,
    ...existingProvider,
    "iam get-role": ok(managedRole([DEV, PROD])),
    "iam get-role-policy": legacyResponse,
    "iam update-assume-role-policy": ok(),
    "iam delete-role-policy": ok()
  };

  it("writes the scoped policy before deleting an owned legacy policy", async () => {
    const aws = fakeAws(legacy);
    expect(await setupAwsDeployIdentity(request, aws.ports)).toMatchObject({
      ok: true
    });
    const commands = aws.calls.map((args) => args.slice(0, 2).join(" "));
    expect(commands.indexOf("iam put-role-policy")).toBeLessThan(
      commands.indexOf("iam delete-role-policy")
    );
    expect(aws.find("iam delete-role-policy")).toContain("radius-deploy-dev");
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("restores the original policy when a quota migration still cannot fit", async () => {
    const aws = fakeAws({
      ...legacy,
      "iam put-role-policy": [
        fail("LimitExceeded"),
        fail("LimitExceeded"),
        ok()
      ]
    });
    expect(await setupAwsDeployIdentity(request, aws.ports)).toMatchObject({
      ok: false
    });
    expect(aws.find("iam delete-role-policy")).toContain("radius-deploy-dev");
    expect(
      aws.calls.filter((args) => args[1] === "put-role-policy").at(-1)
    ).toContain(JSON.stringify(legacyDocument));
    expect(aws.find("eks create-access-entry")).toBeUndefined();
  });

  it("reports a remaining broad legacy grant when its deletion is denied", async () => {
    const aws = fakeAws({
      ...legacy,
      "iam delete-role-policy": fail("AccessDenied: DeleteRolePolicy")
    });
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain("AccessDenied");
    expect(aws.find("eks create-access-entry")).toBeUndefined();
  });

  it.each([
    [
      "picked role without evidence of this environment",
      ok({ Role: { ...managedRole([PROD]).Role, Tags: [] } }),
      legacyResponse
    ],
    [
      "ambiguous environment",
      ok(managedRole([DEV, "repo:octo/shop:environment:dev!"])),
      legacyResponse
    ],
    [
      "other repository",
      ok(managedRole([DEV, "repo:octo/other:environment:dev"])),
      legacyResponse
    ],
    [
      "wildcard trust",
      ok(managedRole([DEV, "repo:octo/shop:environment:*"])),
      legacyResponse
    ],
    [
      "unreadable trust",
      ok({
        Role: {
          ...managedRole([DEV]).Role,
          AssumeRolePolicyDocument: "invalid"
        }
      }),
      legacyResponse
    ],
    [
      "denied read",
      ok(managedRole([DEV])),
      fail("AccessDenied: GetRolePolicy")
    ],
    [
      "malformed response",
      ok(managedRole([DEV])),
      ok({ PolicyName: "different" })
    ]
  ])(
    "stops a legacy migration before writes for %s",
    async (_label, role, policy) => {
      const aws = fakeAws({
        ...legacy,
        "iam get-role": role,
        "iam get-role-policy": policy
      });
      const result = await setupAwsDeployIdentity(
        { ...request, existingRoleArn: ROLE_ARN },
        aws.ports
      );
      expect(result).toMatchObject({ ok: false });
      expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
      expect(aws.find("iam put-role-policy")).toBeUndefined();
      expect(aws.find("iam delete-role-policy")).toBeUndefined();
    }
  );

  it("deletes only the owned environment's current and legacy policies", async () => {
    const aws = fakeAws({
      ...legacy,
      "eks describe-access-entry": NO_ACCESS_ENTRY
    });
    expect(
      await removeAwsEnvironmentFromRole(removalRequest, aws.ports)
    ).toMatchObject({ ok: true });
    expect(
      aws.calls
        .filter((args) => args[1] === "delete-role-policy")
        .map((args) => args[args.indexOf("--policy-name") + 1])
    ).toEqual(["radius-deploy-dev-f5fb7acf8f59", "radius-deploy-dev"]);
    const update = aws.find("iam update-assume-role-policy") ?? [];
    expect(
      trustedGitHubSubjects(
        parsePolicyDocument(update[update.indexOf("--policy-document") + 1]),
        ACCOUNT
      )
    ).toEqual([PROD]);
  });

  it.each(["setup", "delete"])(
    "supports legacy %s on a picked role with unambiguous subjects",
    async (action) => {
      const aws = fakeAws({
        ...legacy,
        "iam get-role": ok({
          Role: { ...managedRole([DEV, PROD]).Role, Tags: [] }
        })
      });
      const result =
        action === "setup" ?
          await setupAwsDeployIdentity(
            { ...request, existingRoleArn: ROLE_ARN },
            aws.ports
          )
        : await removeAwsEnvironmentFromRole(removalRequest, aws.ports);
      expect(result).toMatchObject({ ok: true });
      expect(aws.find("iam delete-role-policy")).toBeDefined();
      expect(aws.find("iam delete-role")).toBeUndefined();
    }
  );

  it("preserves trust evidence when legacy deletion fails after removing the new policy, allowing a retry", async () => {
    const removal = removalRequest;
    const picked = ok({ Role: { ...managedRole([DEV, PROD]).Role, Tags: [] } });
    const first = fakeAws({
      ...legacy,
      "iam get-role": picked,
      "iam delete-role-policy": [ok(), fail("AccessDenied")]
    });
    expect(
      await removeAwsEnvironmentFromRole(removal, first.ports)
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "Removed policy radius-deploy-dev-f5fb7acf8f59."
      )
    });
    expect(first.find("iam update-assume-role-policy")).toBeUndefined();
    const retry = fakeAws({
      ...legacy,
      "iam get-role": picked,
      "iam delete-role-policy": [fail("NoSuchEntity"), ok()]
    });
    expect(
      await removeAwsEnvironmentFromRole(removal, retry.ports)
    ).toMatchObject({ ok: true });
    expect(retry.find("iam update-assume-role-policy")).toBeDefined();
  });

  it("deletes the recorded hash after a rename without inspecting another repository's legacy policy", async () => {
    const other = "repo:octo/other:environment:dev";
    const aws = fakeAws({
      "--version": freeChecks["--version"],
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok({
        Role: { ...managedRole([DEV, other]).Role, Tags: [] }
      }),
      "iam delete-role-policy": ok(),
      "iam update-assume-role-policy": ok(),
      "eks describe-access-entry": NO_ACCESS_ENTRY
    });
    expect(
      await removeAwsEnvironmentFromRole(
        {
          ...removalRequest,
          repo: "renamed/repo",
          environment: "dev",
          roleArn: ROLE_ARN,
          subjects: [DEV],
          policyName: "radius-deploy-dev-f5fb7acf8f59"
        },
        aws.ports
      )
    ).toMatchObject({ ok: true });
    expect(aws.find("iam get-role-policy")).toBeUndefined();
    expect(aws.find("iam delete-role-policy")).toContain(
      "radius-deploy-dev-f5fb7acf8f59"
    );
    const update = aws.find("iam update-assume-role-policy") ?? [];
    expect(
      trustedGitHubSubjects(
        parsePolicyDocument(update[update.indexOf("--policy-document") + 1]),
        ACCOUNT
      )
    ).toEqual([other]);
  });
});

describe("setupAwsDeployIdentity", () => {
  it("records the exact policy identity before attaching its grant", async () => {
    const aws = fakeAws(happyPath);
    expect(await setupAwsDeployIdentity(request, aws.ports)).toMatchObject({
      ok: true
    });
    expect(aws.identities).toEqual([
      {
        roleArn: ROLE_ARN,
        policyName: "radius-deploy-dev-f5fb7acf8f59",
        after: aws.calls.findIndex((args) => args[1] === "put-role-policy")
      }
    ]);
  });

  it("does not attach permissions when durable identity recording fails", async () => {
    const aws = fakeAws(happyPath);
    await expect(
      setupAwsDeployIdentity(request, {
        ...aws.ports,
        recordPolicyIdentity: async () => {
          throw new Error("Disk full");
        }
      })
    ).rejects.toThrow("Disk full");
    expect(aws.find("iam put-role-policy")).toBeUndefined();
    expect(aws.find("eks create-access-entry")).toBeUndefined();
  });

  it("refuses a fresh setup when an older grant cannot be reconciled", async () => {
    const aws = fakeAws({
      ...happyPath,
      "iam get-role": ok(managedRole([DEV])),
      "iam list-role-policies": ok({
        PolicyNames: ["radius-deploy-dev-111111111111"]
      })
    });
    expect(await setupAwsDeployIdentity(request, aws.ports)).toMatchObject({
      ok: false,
      code: "aws-policy-name-unresolved"
    });
    expect(aws.find("iam put-role-policy")).toBeUndefined();
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("creates the provider, role, policy, and cluster access on a fresh account", async () => {
    const aws = fakeAws(happyPath);
    const result = await setupAwsDeployIdentity(request, aws.ports);
    expect(result).toEqual({
      ok: true,
      roleArn: ROLE_ARN,
      roleCreated: true,
      policyName: "radius-deploy-dev-f5fb7acf8f59"
    });
    expect(aws.steps).toEqual([
      "✅ AWS CLI 2.17.0 meets the 2.15.3 minimum.",
      "✅ Cluster shop accepts access entries (API_AND_CONFIG_MAP).",
      `✅ Created the GitHub identity provider in account ${ACCOUNT}.`,
      `ℹ️ Deploy identity will trust ${DEV}`,
      `✅ Created IAM role ${ROLE}.`,
      "✅ Attached deploy permission policy radius-deploy-dev-f5fb7acf8f59, limited to us-west-2.",
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
    const createEntry = aws.find("eks create-access-entry") ?? [];
    expect(createEntry[createEntry.indexOf("--tags") + 1]).toBe(
      "radius-managed=true"
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
    expect(result).toEqual({
      ok: true,
      roleArn: ROLE_ARN,
      roleCreated: false,
      policyName: "radius-deploy-dev-f5fb7acf8f59"
    });
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
    expect(result).toEqual({
      ok: true,
      roleArn: ROLE_ARN,
      roleCreated: true,
      policyName: "radius-deploy-dev-f5fb7acf8f59"
    });
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
      "The AWS CLI executable is not available"
    ],
    [
      "no CLI session",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": fail("Token has expired")
      },
      "aws-verification-failed",
      "The AWS credentials have expired"
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
      "aws-verification-failed",
      "The AWS CLI call timed out"
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
      "aws-verification-failed",
      "The AWS CLI call timed out"
    ],
    [
      "a session in another account",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": ok({ Account: "999988887777" })
      },
      "aws-account-mismatch",
      "signed in to account 999988887777, but the requested account is 123456789012"
    ],
    [
      "a CONFIG_MAP cluster",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": freeChecks["sts get-caller-identity"],
        "eks describe-cluster": ok({
          cluster: {
            status: "ACTIVE",
            accessConfig: { authenticationMode: "CONFIG_MAP" }
          }
        })
      },
      "aws-cluster-config-map",
      "Cluster shop uses CONFIG_MAP authentication"
    ],
    [
      "a cluster that is being deleted",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": freeChecks["sts get-caller-identity"],
        "eks describe-cluster": ok({
          cluster: {
            status: "DELETING",
            accessConfig: { authenticationMode: "API" }
          }
        })
      },
      "aws-cluster-not-active",
      "Cluster shop in us-west-2 is DELETING. Setup needs an ACTIVE cluster"
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
      expect(aws.sleeps).toEqual([]);
      expect(aws.locks).toEqual([]);
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
        `policy radius-deploy-dev-f5fb7acf8f59 on ${ROLE}`
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
        `policy radius-deploy-dev-f5fb7acf8f59 on ${ROLE}`,
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
      "AWS CLI verification failed."
    ],
    [
      "the CLI session answers no readable account",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": raw("not json")
      },
      "aws-identity-invalid",
      "did not return a valid account ID"
    ],
    [
      "the cluster reports no access configuration",
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": freeChecks["sts get-caller-identity"],
        "eks describe-cluster": ok({ cluster: { status: "ACTIVE" } })
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
        `IAM role ${ROLE} has reached the 10,240-character inline-policy limit`
      );
      expect(message).toContain(
        "10,240-character inline-policy limit, which cannot be raised"
      );
      expect(message).toContain("about 17 environments");
      expect(message).toContain("Maximum policy size of 10240 bytes exceeded");
      expect(message).toContain(
        "Delete an unused environment or choose another role."
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
        roleCreated: true,
        policyName: "radius-deploy-dev-f5fb7acf8f59"
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
    expect(result).toEqual({
      ok: true,
      roleArn: ROLE_ARN,
      roleCreated: false,
      policyName: "radius-deploy-dev-f5fb7acf8f59"
    });
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
      "--version": freeChecks["--version"],
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok({})
    });
    expect(
      await removeAwsEnvironmentFromRole(removalRequest, {
        ...removal.ports,
        listOtherEnvironments: unexpectedListing
      })
    ).toMatchObject({ ok: false });
    expect(removal.calls).toHaveLength(3);
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
  const removal = removalRequest;
  const KEPT = [`IAM role ${ROLE}`, "the account's GitHub identity provider"];
  const ENTRY = `the access entry for ${ROLE} on shop`;
  const BY_HAND = `If nothing else uses it, run: aws eks delete-access-entry --cluster-name shop --principal-arn ${ROLE_ARN} --region us-west-2`;
  const OTHER_REPO = "repo:octo/other:environment:dev";
  const signedIn: Script = {
    "--version": freeChecks["--version"],
    "iam get-role-policy": freeChecks["iam get-role-policy"],
    "iam list-role-policies": freeChecks["iam list-role-policies"],
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "eks describe-access-entry": NO_ACCESS_ENTRY
  };
  const taggedEntry: Script = {
    "eks describe-access-entry": ok({
      accessEntry: {
        principalArn: ROLE_ARN,
        tags: { "radius-managed": "true" }
      }
    })
  };
  const prod = {
    name: "prod",
    accountId: ACCOUNT,
    region: "us-east-1",
    cluster: "storefront",
    trustSubjects: [PROD]
  };

  function remove(
    aws: ReturnType<typeof fakeAws>,
    listing: AwsEnvironmentListing | null = null,
    request: Partial<typeof removal> = {}
  ) {
    return removeAwsEnvironmentFromRole(
      { ...removal, ...request },
      {
        ...aws.ports,
        listOtherEnvironments: listing ? async () => listing : unexpectedListing
      }
    );
  }

  function writtenTrust(aws: ReturnType<typeof fakeAws>) {
    const update = aws.find("iam update-assume-role-policy") ?? [];
    return parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
  }

  it("removes only this environment's subject and policy", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    });
    expect(await remove(aws)).toEqual({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ],
      kept: KEPT,
      warnings: []
    });
    expect(trustedGitHubSubjects(writtenTrust(aws), ACCOUNT)).toEqual([PROD]);
    expect(aws.calls.map((args) => args[1])).not.toContain("delete-role");
  });

  it("removes every subject the environment recorded in one update", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([DEV, PROD, DEV_ID])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    });
    const result = await remove(aws, null, { subjects: [DEV, DEV_ID] });
    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ]
    });
    expect(
      aws.calls.filter((args) => args[1] === "update-assume-role-policy")
    ).toHaveLength(1);
    expect(trustedGitHubSubjects(writtenTrust(aws), ACCOUNT)).toEqual([PROD]);
  });

  it("says what is still there when the trust update fails", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam delete-role-policy": ok(),
      "iam get-role": ok(managedRole([DEV_ID, PROD])),
      "iam update-assume-role-policy": fail("AccessDenied")
    });
    expect(await remove(aws, null, { subjects: [DEV, DEV_ID] })).toEqual({
      ok: false,
      message: `Removed policy radius-deploy-dev-f5fb7acf8f59. Could not update the trust policy of IAM role ${ROLE} (AccessDenied). Trust subjects were retained so deletion can be retried.`
    });
    expect(aws.find("iam delete-role-policy")).toContain(
      "radius-deploy-dev-f5fb7acf8f59"
    );
  });

  it("retains trust evidence when the policy delete fails", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": fail("AccessDenied")
    });
    expect(await remove(aws)).toEqual({
      ok: false,
      message: `Failed to delete policy radius-deploy-dev-f5fb7acf8f59 from ${ROLE}: AccessDenied. Trust subjects were retained so deletion can be retried.`
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("removes only what is still there on a retry", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([PROD])),
      "iam delete-role-policy": ok()
    });
    expect(await remove(aws)).toMatchObject({
      ok: true,
      removed: ["policy radius-deploy-dev-f5fb7acf8f59"]
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("warns that a role already gone held nothing, and continues", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": fail("NoSuchEntity")
    });
    expect(await remove(aws)).toEqual({
      ok: true,
      removed: [],
      kept: [],
      warnings: [
        `IAM role ${ROLE} was already gone, so there was nothing to remove from it.`
      ]
    });
  });

  // EKS keeps an access entry after its role is deleted. It grants nothing,
  // since a role created later with the same name is a new principal.
  describe("when the role is already gone", () => {
    const GONE = `IAM role ${ROLE} was already gone, so there was nothing to remove from it.`;
    const ORPHAN = `It grants nothing now that the role is gone. To remove it, run: aws eks delete-access-entry --cluster-name shop --principal-arn ${ROLE_ARN} --region us-west-2`;
    const roleGone: Script = {
      ...signedIn,
      "iam get-role": fail("NoSuchEntity")
    };

    it("removes the entry setup tagged on the environment's cluster", async () => {
      const aws = fakeAws({
        ...roleGone,
        ...taggedEntry,
        "eks delete-access-entry": ok()
      });
      expect(await remove(aws)).toEqual({
        ok: true,
        removed: [`access entry for ${ROLE} on shop`],
        kept: [],
        warnings: [GONE]
      });
      expect(aws.find("eks delete-access-entry")).toContain(ROLE_ARN);
    });

    it.each([
      [
        "it has no Radius tag",
        ok({ accessEntry: { tags: {} } }),
        `Kept ${ENTRY}, because it doesn't have the Radius tag. ${ORPHAN}`
      ],
      [
        "it can't be read",
        fail("AccessDeniedException"),
        `Kept ${ENTRY}, because Radius couldn't read it (AccessDeniedException). ${ORPHAN}`
      ]
    ])(
      "keeps the entry and says how to remove it when %s",
      async (_label, described, warning) => {
        const aws = fakeAws({
          ...roleGone,
          "eks describe-access-entry": described
        });
        expect(await remove(aws)).toEqual({
          ok: true,
          removed: [],
          kept: [],
          warnings: [GONE, warning]
        });
        expect(aws.find("eks delete-access-entry")).toBeUndefined();
      }
    );

    it("doesn't look for an entry when the environment recorded no cluster", async () => {
      const aws = fakeAws(roleGone);
      await remove(aws, null, { cluster: "" });
      expect(aws.find("eks describe-access-entry")).toBeUndefined();
    });

    it("says the entry is still there when deleting it fails", async () => {
      const aws = fakeAws({
        ...roleGone,
        ...taggedEntry,
        "eks delete-access-entry": fail("AccessDeniedException")
      });
      expect(await remove(aws)).toEqual({
        ok: false,
        message: `Could not delete ${ENTRY} (AccessDeniedException). Nothing was removed. Still there: ${ENTRY}. Retry removes what's still there.`
      });
    });
  });

  describe("a subject other environments or repositories present too", () => {
    const SHARED = "repository_id:22";
    const sharedWarning = (subject: string) =>
      `Kept trust subject ${subject}, because it doesn't name one repository and the environment dev, so other environments or repositories may present it too. If nothing else needs it, remove it from the role's trust policy by hand.`;

    it.each([
      ["has no environment", SHARED],
      ["has no repository", "repository_owner:octo:environment:dev"],
      ["names another environment", "repo:octo/shop:environment:prod"],
      ["is a wildcard", "repo:octo/shop:environment:*"]
    ])(
      "keeps a trusted subject that %s, and warns",
      async (_label, subject) => {
        const aws = fakeAws({
          ...signedIn,
          "iam get-role": ok(managedRole([DEV, subject])),
          "iam update-assume-role-policy": ok(),
          "iam delete-role-policy": ok()
        });
        const result = await remove(aws, null, { subjects: [DEV, subject] });
        expect(result).toMatchObject({
          ok: true,
          removed: [
            `trust subject ${DEV}`,
            "policy radius-deploy-dev-f5fb7acf8f59"
          ],
          warnings: [sharedWarning(subject)]
        });
        expect(trustedGitHubSubjects(writtenTrust(aws), ACCOUNT)).toEqual([
          subject
        ]);
      }
    );

    it("doesn't change the trust or warn about a shared subject the role doesn't trust", async () => {
      const aws = fakeAws({
        ...signedIn,
        "iam get-role": ok(managedRole([PROD])),
        "iam delete-role-policy": ok()
      });
      expect(await remove(aws, null, { subjects: [SHARED] })).toMatchObject({
        ok: true,
        removed: ["policy radius-deploy-dev-f5fb7acf8f59"],
        warnings: []
      });
      expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
    });

    it("removes a subject from before a rename that names this environment", async () => {
      const renamed = "repo:octo/old-shop:environment:DEV";
      const aws = fakeAws({
        ...signedIn,
        "iam get-role": ok(managedRole([renamed, PROD])),
        "iam update-assume-role-policy": ok(),
        "iam delete-role-policy": ok()
      });
      expect(await remove(aws, null, { subjects: [renamed] })).toMatchObject({
        ok: true,
        removed: [
          `trust subject ${renamed}`,
          "policy radius-deploy-dev-f5fb7acf8f59"
        ]
      });
    });

    it("names only this environment's subjects to remove by hand when the trust policy is unreadable", async () => {
      const aws = fakeAws({
        ...signedIn,
        "iam get-role": ok({
          Role: { Arn: ROLE_ARN, AssumeRolePolicyDocument: "{not json" }
        })
      });
      const result = await remove(aws, null, { subjects: [SHARED] });
      expect(!result.ok && result.message).toMatch(
        /retry, or by hand delete its policy radius-deploy-dev\.$/
      );
    });
  });

  it("stops without writing and names what to remove by hand when the trust policy is unreadable", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok({
        Role: { Arn: ROLE_ARN, AssumeRolePolicyDocument: "{not json" }
      })
    });
    const result = await remove(aws, null, { subjects: [DEV, DEV_ID] });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toMatch(
      new RegExp(
        `^Could not read the trust policy of IAM role ${ROLE} \\(.+\\)\\. Nothing was changed\\.`
      )
    );
    expect(!result.ok && result.message).toContain(
      `by hand remove ${DEV}, ${DEV_ID} from its trust policy and delete its policy radius-deploy-dev.`
    );
    expect(aws.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "--version",
      "sts get-caller-identity",
      "iam get-role"
    ]);
  });

  it.each([
    ["signed in to another account", ok({ Account: "999988887777" })],
    ["not signed in", fail("Unable to locate credentials")],
    ["answering no account", ok("not json")]
  ])("changes nothing when the CLI session is %s", async (_label, identity) => {
    const aws = fakeAws({
      "--version": freeChecks["--version"],
      "sts get-caller-identity": identity,
      "iam get-role": ok(managedRole([DEV]))
    });
    expect(await remove(aws)).toMatchObject({ ok: false });
    expect(aws.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "--version",
      "sts get-caller-identity"
    ]);
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
    expect(await remove(aws)).toMatchObject({ ok: false });
    expect(aws.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "--version",
      "sts get-caller-identity",
      "iam get-role"
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
    expect(await remove(aws)).toMatchObject({ ok: true });
  });

  it("refuses a role outside the commercial partition without calling AWS", async () => {
    const aws = fakeAws({});
    expect(
      await remove(aws, null, {
        roleArn: `arn:aws-us-gov:iam::${ACCOUNT}:role/${ROLE}`
      })
    ).toMatchObject({ ok: false });
    expect(aws.calls).toEqual([]);
  });

  it("treats a missing policy as already removed", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": ok(managedRole([PROD])),
      "iam delete-role-policy": fail("NoSuchEntity")
    });
    expect(await remove(aws)).toMatchObject({ ok: true, removed: [] });
  });

  it("changes nothing when the role is unreadable", async () => {
    const aws = fakeAws({
      ...signedIn,
      "iam get-role": fail("AccessDenied")
    });
    expect(await remove(aws)).toEqual({
      ok: false,
      message: `Could not read IAM role ${ROLE} (AccessDenied). Nothing was changed.`
    });
  });

  it("refuses a value that is not a role ARN", async () => {
    const aws = fakeAws({});
    expect(await remove(aws, null, { roleArn: "" })).toMatchObject({
      ok: false
    });
    expect(aws.calls).toEqual([]);
  });

  describe("the access entry", () => {
    const lastEnvironment: Script = {
      ...signedIn,
      ...taggedEntry,
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok(),
      "eks delete-access-entry": ok()
    };

    it("removes a tagged entry that no other environment or repository uses", async () => {
      const aws = fakeAws(lastEnvironment);
      expect(await remove(aws, { ok: true, environments: [prod] })).toEqual({
        ok: true,
        removed: [
          `trust subject ${DEV}`,
          "policy radius-deploy-dev-f5fb7acf8f59",
          `access entry for ${ROLE} on shop`
        ],
        kept: KEPT,
        warnings: []
      });
      expect(aws.find("eks delete-access-entry")).toEqual([
        "eks",
        "delete-access-entry",
        "--cluster-name",
        "shop",
        "--principal-arn",
        ROLE_ARN,
        "--region",
        "us-west-2"
      ]);
    });

    it("removes the entry when the last environment leaves only the deny statement", async () => {
      const aws = fakeAws({
        ...lastEnvironment,
        "iam get-role": ok(managedRole([DEV]))
      });
      expect(await remove(aws, { ok: true, environments: [] })).toMatchObject({
        ok: true,
        removed: expect.arrayContaining([`access entry for ${ROLE} on shop`])
      });
    });

    it("addresses the entry by the role ARN IAM returns", async () => {
      const pathArn = `arn:aws:iam::${ACCOUNT}:role/team/${ROLE}`;
      const aws = fakeAws({
        ...lastEnvironment,
        "iam get-role": ok({
          Role: { ...managedRole([DEV]).Role, Arn: pathArn }
        })
      });
      await remove(aws, { ok: true, environments: [] });
      const deleteEntry = aws.find("eks delete-access-entry") ?? [];
      expect(deleteEntry[deleteEntry.indexOf("--principal-arn") + 1]).toBe(
        pathArn
      );
    });

    it.each([
      ["the same cluster", prod.accountId, "us-west-2", "shop"],
      ["the same cluster named in another case", ACCOUNT, "US-WEST-2", "Shop"],
      ["a cluster with no recorded account", "", "us-west-2", "shop"],
      ["a cluster with no recorded region", ACCOUNT, "", "shop"]
    ])(
      "keeps the entry while another environment uses %s",
      async (_label, accountId, region, cluster) => {
        const aws = fakeAws(lastEnvironment);
        const result = await remove(aws, {
          ok: true,
          environments: [{ ...prod, accountId, region, cluster }]
        });
        expect(result).toMatchObject({
          ok: true,
          kept: [
            ...KEPT,
            `${ENTRY}, because environment prod still uses that cluster`
          ]
        });
        expect(aws.find("eks delete-access-entry")).toBeUndefined();
      }
    );

    it("names every environment that still uses the cluster", async () => {
      const aws = fakeAws(lastEnvironment);
      const onShop = { ...prod, region: "us-west-2", cluster: "shop" };
      const result = await remove(aws, {
        ok: true,
        environments: [onShop, { ...onShop, name: "qa" }]
      });
      expect(result.ok && result.kept).toContain(
        `${ENTRY}, because environments prod, qa still use that cluster`
      );
    });

    it.each([
      [
        "a subject from another repository",
        managedRole([DEV, PROD, OTHER_REPO]),
        [prod]
      ],
      [
        "a subject an older environment did not record",
        managedRole([DEV, PROD]),
        [{ ...prod, trustSubjects: [] }]
      ],
      [
        "another principal",
        {
          Role: {
            ...managedRole([DEV]).Role,
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                ...buildGitHubTrustPolicy(ACCOUNT, [DEV]).Statement,
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole"
                }
              ]
            }
          }
        },
        []
      ]
    ])(
      "keeps the entry while the trust lets in %s",
      async (_label, role, environments) => {
        const aws = fakeAws({ ...lastEnvironment, "iam get-role": ok(role) });
        const result = await remove(aws, { ok: true, environments });
        expect(result.ok && result.kept).toContain(
          `${ENTRY}, because the role's trust policy lets in more than this repository's other environments. ${BY_HAND}`
        );
        expect(aws.find("eks delete-access-entry")).toBeUndefined();
      }
    );

    it.each([
      ["has no tags", { accessEntry: { principalArn: ROLE_ARN } }],
      [
        "is tagged by someone else",
        { accessEntry: { tags: { "radius-managed": "false" } } }
      ],
      ["answers no entry", {}]
    ])(
      "keeps an entry that %s, without reading the environments",
      async (_label, described) => {
        const aws = fakeAws({
          ...lastEnvironment,
          "eks describe-access-entry": ok(described)
        });
        const result = await remove(aws);
        expect(result.ok && result.kept).toContain(
          `${ENTRY}, because it doesn't have the Radius tag. Entries created before Radius tagged them are kept too. ${BY_HAND}`
        );
        expect(aws.find("eks delete-access-entry")).toBeUndefined();
      }
    );

    it.each([
      ["a picked role with no tags", { Arn: ROLE_ARN }],
      [
        "a role Radius created for another repository",
        {
          Arn: ROLE_ARN,
          Tags: [
            { Key: "radius-managed", Value: "true" },
            { Key: "radius-repository", Value: "octo/renamed" }
          ]
        }
      ]
    ])("never touches the entry of %s", async (_label, role) => {
      const aws = fakeAws({
        ...lastEnvironment,
        "iam get-role": ok({
          Role: {
            ...role,
            AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [DEV])
          }
        })
      });
      const result = await remove(aws);
      expect(result.ok && result.kept).toContain(
        `any access entry for ${ROLE} on shop, because Radius didn't create this role for octo/shop, and other repositories may use it`
      );
      expect(
        aws.calls.filter((args) => args[0] === "eks").map((args) => args[1])
      ).toEqual([]);
    });

    it("never touches the entry of a picked role whose environment recorded no cluster", async () => {
      const aws = fakeAws({
        ...lastEnvironment,
        "iam get-role": ok({
          Role: {
            Arn: ROLE_ARN,
            AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [DEV])
          }
        })
      });
      const result = await remove(aws, null, { cluster: "" });
      expect(result.ok && result.kept).toContain(
        `any access entry for ${ROLE}, because Radius didn't create this role for octo/shop, and other repositories may use it`
      );
    });

    it.each([
      ["cluster", { cluster: "" }],
      ["region", { region: " " }]
    ])(
      "keeps the entry and warns when the environment recorded no %s",
      async (_label, request) => {
        const aws = fakeAws(lastEnvironment);
        expect(await remove(aws, null, request)).toMatchObject({
          ok: true,
          warnings: [
            `Kept any access entry for ${ROLE}, because this environment doesn't record its cluster. Remove it in the EKS console if nothing else uses it.`
          ]
        });
        expect(aws.find("eks describe-access-entry")).toBeUndefined();
      }
    );

    it("keeps the entry and warns when it can't be read", async () => {
      const aws = fakeAws({
        ...lastEnvironment,
        "eks describe-access-entry": fail("AccessDeniedException")
      });
      expect(await remove(aws)).toMatchObject({
        ok: true,
        warnings: [
          `Kept ${ENTRY}, because Radius couldn't read it (AccessDeniedException). ${BY_HAND}`
        ]
      });
    });

    it("keeps the entry and warns when the environments can't be read", async () => {
      const aws = fakeAws(lastEnvironment);
      expect(
        await remove(aws, { ok: false, reason: "HTTP 403" })
      ).toMatchObject({
        ok: true,
        warnings: [
          `Kept ${ENTRY}, because Radius couldn't read this repository's environments (HTTP 403). ${BY_HAND}`
        ]
      });
      expect(aws.find("eks delete-access-entry")).toBeUndefined();
    });

    it("reports nothing about an entry that doesn't exist", async () => {
      const aws = fakeAws({
        ...lastEnvironment,
        ...signedIn
      });
      expect(await remove(aws)).toEqual({
        ok: true,
        removed: [
          `trust subject ${DEV}`,
          "policy radius-deploy-dev-f5fb7acf8f59"
        ],
        kept: KEPT,
        warnings: []
      });
    });

    it("treats an entry deleted meanwhile as gone", async () => {
      const aws = fakeAws({
        ...lastEnvironment,
        "eks delete-access-entry": fail("ResourceNotFoundException")
      });
      expect(await remove(aws, { ok: true, environments: [prod] })).toEqual({
        ok: true,
        removed: [
          `trust subject ${DEV}`,
          "policy radius-deploy-dev-f5fb7acf8f59"
        ],
        kept: KEPT,
        warnings: []
      });
    });

    it("says what is still there when the entry delete fails", async () => {
      const aws = fakeAws({
        ...lastEnvironment,
        "eks delete-access-entry": fail("AccessDeniedException")
      });
      expect(await remove(aws, { ok: true, environments: [prod] })).toEqual({
        ok: false,
        message: `Could not delete ${ENTRY} (AccessDeniedException). Removed trust subject ${DEV}, policy radius-deploy-dev-f5fb7acf8f59. Still there: ${ENTRY}. Retry removes what's still there.`
      });
    });
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
      { "eks describe-cluster": ok({ cluster: { status: "ACTIVE" } }) }
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
      "--version": freeChecks["--version"],
      "iam get-role-policy": freeChecks["iam get-role-policy"],
      "iam list-role-policies": freeChecks["iam list-role-policies"],
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok(),
      "eks describe-access-entry": NO_ACCESS_ENTRY
    });
    await removeAwsEnvironmentFromRole(removalRequest, {
      ...aws.ports,
      listOtherEnvironments: unexpectedListing
    });
    expect(aws.locks).toEqual([{ roleName: ROLE, after: 2 }]);
  });

  it("changes nothing on delete when the lock cannot be taken", async () => {
    const aws = fakeAws(
      {
        "--version": freeChecks["--version"],
        "sts get-caller-identity": ok({ Account: ACCOUNT })
      },
      LOCK_DENIED
    );
    expect(
      await removeAwsEnvironmentFromRole(removalRequest, {
        ...aws.ports,
        listOtherEnvironments: unexpectedListing
      })
    ).toEqual({ ok: false, message: "not allowed iam:CreatePolicy" });
    expect(aws.calls).toHaveLength(2);
  });

  it("takes no delete lock when the session is in another account", async () => {
    const aws = fakeAws({
      "--version": freeChecks["--version"],
      "sts get-caller-identity": ok({ Account: "999999999999" })
    });
    await removeAwsEnvironmentFromRole(removalRequest, {
      ...aws.ports,
      listOtherEnvironments: unexpectedListing
    });
    expect(aws.locks).toEqual([]);
  });
});

describe("waiting for an ACTIVE cluster", () => {
  const described = (status: string, authenticationMode: string) =>
    ok({ cluster: { status, accessConfig: { authenticationMode } } });

  it("waits while the cluster switches to access entries, then sets it up", async () => {
    const aws = fakeAws({
      ...happyPath,
      "eks describe-cluster": [
        described("UPDATING", "CONFIG_MAP"),
        described("UPDATING", "API_AND_CONFIG_MAP"),
        described("ACTIVE", "API_AND_CONFIG_MAP")
      ]
    });

    const result = await setupAwsDeployIdentity(request, aws.ports);

    expect(result.ok).toBe(true);
    expect(
      aws.calls.slice(0, 5).map((args) => args.slice(0, 2).join(" "))
    ).toEqual([
      "--version",
      "sts get-caller-identity",
      "eks describe-cluster",
      "eks describe-cluster",
      "eks describe-cluster"
    ]);
    expect(aws.locks).toEqual([{ roleName: ROLE, after: 5 }]);
    expect(aws.sleeps).toEqual([15000, 15000]);
    expect(aws.steps).toContain(
      "ℹ️ Cluster shop is UPDATING. Setup waits for it to be ACTIVE before it changes anything."
    );
  });

  it("changes nothing when the cluster stays UPDATING", async () => {
    const aws = fakeAws({
      ...happyPath,
      "eks describe-cluster": described("UPDATING", "API")
    });

    const result = await setupAwsDeployIdentity(request, aws.ports);

    expect(result).toEqual({
      ok: false,
      code: "aws-cluster-not-active",
      message:
        "Cluster shop in us-west-2 is UPDATING. Setup needs an ACTIVE cluster, so nothing was changed. Retry when the cluster is ACTIVE.",
      created: []
    });
    expect(aws.sleeps).toEqual(CLUSTER_ACTIVE_WAIT_DELAYS_MS);
    expect(aws.locks).toEqual([]);
    expect(aws.calls.some((args) => args[0] === "iam")).toBe(false);
  });

  it("changes nothing when the cluster can't be read during the wait", async () => {
    const aws = fakeAws({
      ...happyPath,
      "eks describe-cluster": [
        described("UPDATING", "API"),
        fail("ThrottlingException")
      ]
    });

    const result = await setupAwsDeployIdentity(request, aws.ports);

    expect(result).toMatchObject({
      ok: false,
      code: "aws-cluster-unreadable",
      created: []
    });
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
      "--version": freeChecks["--version"],
      "iam get-role-policy": freeChecks["iam get-role-policy"],
      "iam list-role-policies": freeChecks["iam list-role-policies"],
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok(managedRole([DEV, PROD])),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok(),
      "eks describe-access-entry": NO_ACCESS_ENTRY
    };
    const remove = (aws: ReturnType<typeof fakeAws>) =>
      removeAwsEnvironmentFromRole(removalRequest, {
        ...aws.ports,
        listOtherEnvironments: unexpectedListing
      });

    const settled = fakeAws(script, { ok: true }, { staleReads: 1 });
    expect(await remove(settled)).toMatchObject({ ok: true });
    expect(settled.sleeps).toEqual([1000]);

    const never = fakeAws(script, { ok: true }, { staleReads: 99 });
    expect(await remove(never)).toEqual({
      ok: false,
      message: `Removed policy radius-deploy-dev-f5fb7acf8f59. IAM did not show the updated trust policy of IAM role ${ROLE} after the update, so Radius stopped. Retry the deletion.`
    });
    expect(never.find("iam delete-role-policy")).toContain(
      "radius-deploy-dev-f5fb7acf8f59"
    );
  });
});

describe("repairAwsEnvironmentTrust", () => {
  const repair = {
    repo: "octo/shop",
    environment: "dev",
    roleArn: ROLE_ARN,
    subjects: [DEV, DEV_ID],
    subjectConfig: { useDefault: true }
  };
  const ready: Script = {
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-open-id-connect-provider": ok({
      ClientIDList: ["sts.amazonaws.com"]
    }),
    "iam get-role": ok(managedRole([PROD, DEV])),
    // The permission policy setup wrote for this environment.
    "iam get-role-policy": ok({ PolicyName: "radius-deploy-dev" }),
    "iam update-assume-role-policy": ok()
  };
  const written = (aws: ReturnType<typeof fakeAws>) => {
    const update = aws.find("iam update-assume-role-policy") ?? [];
    return parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
  };

  it.each([undefined, "radius-deploy-dev-111111111111"])(
    "repairs against the exact saved policy %s",
    async (policyName) => {
      const aws = fakeAws({
        ...ready,
        "iam get-role-policy": ok({
          PolicyName: policyName ?? "radius-deploy-dev"
        })
      });
      expect(
        await repairAwsEnvironmentTrust({ ...repair, policyName }, aws.ports)
      ).toMatchObject({ ok: true, added: [DEV_ID] });
      expect(aws.find("iam get-role-policy")).toContain(
        policyName ?? "radius-deploy-dev"
      );
    }
  );

  it.each(["", "unrelated", "radius-deploy-prod-111111111111"])(
    "refuses an invalid saved Repair policy %j before writing",
    async (policyName) => {
      const aws = fakeAws(ready);
      expect(
        await repairAwsEnvironmentTrust({ ...repair, policyName }, aws.ports)
      ).toMatchObject({ ok: false, code: "aws-policy-name-invalid" });
      expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
    }
  );

  it("does not fall back to a legacy grant when the recorded Repair policy is missing", async () => {
    const policyName = "radius-deploy-dev-111111111111";
    const aws = fakeAws({
      ...ready,
      "iam get-role-policy": fail("NoSuchEntity")
    });
    expect(
      await repairAwsEnvironmentTrust({ ...repair, policyName }, aws.ports)
    ).toMatchObject({ ok: false, code: "aws-environment-not-set-up" });
    expect(
      aws.calls.filter((args) => args[1] === "get-role-policy")
    ).toHaveLength(1);
    expect(aws.find("iam get-role-policy")).toContain(policyName);
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

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
      "iam get-role-policy",
      "iam update-assume-role-policy",
      "iam get-role"
    ]);
    expect(aws.find("iam get-role-policy")).toEqual([
      "iam",
      "get-role-policy",
      "--role-name",
      ROLE,
      "--policy-name",
      "radius-deploy-dev",
      "--output",
      "json"
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

  it.each([undefined, "radius-deploy-dev-111111111111"])(
    "repairs a picked role with policy %j that still trusts this environment",
    async (policyName) => {
      const aws = fakeAws({
        ...ready,
        "iam get-role": ok(unmanagedRole([DEV])),
        "iam get-role-policy": ok({
          PolicyName: policyName ?? "radius-deploy-dev"
        })
      });
      expect(
        await repairAwsEnvironmentTrust({ ...repair, policyName }, aws.ports)
      ).toMatchObject({
        ok: true,
        added: [DEV_ID]
      });
      expect(aws.find("iam get-role-policy")).toContain(
        policyName ?? "radius-deploy-dev"
      );
    }
  );

  it("adds to a role Radius created for this repository even when it trusts nothing", async () => {
    const role = managedRole([]);
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });
    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: true,
      added: [DEV, DEV_ID]
    });
  });

  // An environment pointed at a role it was never set up on, such as rv-c at
  // the role that rv-b of the same repository uses.
  it.each([
    [
      "another environment of this repository",
      unmanagedRole(["repo:mallory/evil:environment:dev", PROD])
    ],
    [
      "only another repository",
      unmanagedRole(["repo:mallory/evil:environment:dev"])
    ],
    ["no GitHub subject", unmanagedRole([])]
  ])(
    "refuses a role Radius did not tag that trusts %s but not this environment",
    async (_label, role) => {
      const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

      expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
        ok: false,
        code: "aws-role-not-this-repository",
        message: `IAM role ${ROLE} was not created by Radius for octo/shop, and it no longer trusts environment dev in any form, so Radius cannot tell that this repository set the environment up on it. Nothing was changed. If environment dev should deploy with this role, set it up on the Environments page, which adds its trust and permissions.`
      });
      expect(aws.find("iam get-role-policy")).toBeUndefined();
      expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
    }
  );

  it("refuses a role Radius created for another repository, even one that trusts this environment", async () => {
    const role = {
      Role: {
        ...managedRole([DEV]).Role,
        Tags: [
          { Key: "radius-managed", Value: "true" },
          { Key: "radius-repository", Value: "octo/web" }
        ]
      }
    };
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
      ok: false,
      code: "aws-role-not-this-repository",
      message: `Radius created IAM role ${ROLE} for octo/web, not octo/shop, so Repair will not add trust to it. Nothing was changed. Check that the environment's AWS_ROLE_ARN names the right role.`
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it.each([
    ["its own role", managedRole([PROD])],
    ["a role Radius did not tag", unmanagedRole([DEV])]
  ])(
    "refuses an environment setup never ran for on %s",
    async (_label, role) => {
      const aws = fakeAws({
        ...ready,
        "iam get-role": ok(role),
        "iam get-role-policy": fail(
          "NoSuchEntity: The role policy was not found"
        )
      });

      expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
        ok: false,
        code: "aws-environment-not-set-up",
        message: `IAM role ${ROLE} has no permission policy radius-deploy-dev for environment dev, so setup never ran for it on this role, and Repair only restores trust that setup added. Nothing was changed. If environment dev should deploy with this role, set it up on the Environments page, which adds its trust and permissions.`
      });
      expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
    }
  );

  it("changes nothing when the environment's permission policy cannot be read", async () => {
    const aws = fakeAws({
      ...ready,
      "iam get-role-policy": fail("AccessDenied: iam:GetRolePolicy")
    });

    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
      ok: false,
      code: "aws-role-policy-unreadable",
      message: `Could not read permission policy radius-deploy-dev on IAM role ${ROLE}, so Radius cannot tell that setup ran for environment dev on it: AccessDenied: iam:GetRolePolicy. Nothing was changed.`
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("refuses a role whose ARN has another path than AWS_ROLE_ARN", async () => {
    const moved = `arn:aws:iam::${ACCOUNT}:role/new/${ROLE}`;
    const role = managedRole([PROD]);
    const aws = fakeAws({
      ...ready,
      "iam get-role": ok({ Role: { ...role.Role, Arn: moved } })
    });

    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
      ok: false,
      code: "aws-role-arn-mismatch",
      message: `This environment's AWS_ROLE_ARN is ${ROLE_ARN}, but the IAM role named ${ROLE} is ${moved}, so deploys cannot sign in to it whatever it trusts. Nothing was changed. Set AWS_ROLE_ARN to the role's ARN.`
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("refuses a subject that does not name the repository, even on its own role", async () => {
    const shared = "repository_owner:octo:environment:dev";
    const aws = fakeAws({ ...ready, "iam get-role": ok(managedRole([PROD])) });

    const subjectConfig = {
      useDefault: false,
      includeClaimKeys: ["repository_owner", "context"]
    };

    const result = await repairAwsEnvironmentTrust(
      { ...repair, subjects: [shared], subjectConfig },
      aws.ports
    );

    // The same refusal setup gives, with the same fix.
    expect(result).toEqual({
      ok: false,
      code: "aws-subject-not-repository-specific",
      message: repositoryLessSubjectMessage(
        [shared],
        "octo/shop",
        subjectConfig
      )
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("refuses to widen a subject the role covers by a pattern under a source IP condition", async () => {
    const role = managedRole([PROD]);
    role.Role.AssumeRolePolicyDocument.Statement.push({
      Effect: "Allow",
      Principal: {
        Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub":
            "repo:octo/shop:environment:*"
        },
        IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
      }
    });
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

    expect(
      await repairAwsEnvironmentTrust({ ...repair, subjects: [DEV] }, aws.ports)
    ).toMatchObject({ ok: false, code: "aws-role-trust-restricted" });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("refuses to widen a subject the role names under conditions it cannot check", async () => {
    const role = managedRole([PROD]);
    role.Role.AssumeRolePolicyDocument.Statement.push({
      Effect: "Allow",
      Principal: {
        Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": [DEV, DEV_ID]
        },
        IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
      }
    });
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toEqual({
      ok: false,
      code: "aws-role-trust-restricted",
      message: `IAM role ${ROLE} still covers ${DEV}, ${DEV_ID} in its trust policy, under conditions Radius cannot check, so Repair would widen access rather than restore it. Nothing was changed. Check those conditions in the role's trust policy.`
    });
    expect(aws.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("does not count a subject the role names but excludes with another condition", async () => {
    const role = unmanagedRole([PROD]);
    const statement = role.Role.AssumeRolePolicyDocument.Statement[0] as {
      Condition: Record<string, unknown>;
    };
    statement.Condition.StringLike = {
      "token.actions.githubusercontent.com:sub": "repo:octo/web:*"
    };
    const aws = fakeAws({ ...ready, "iam get-role": ok(role) });

    expect(await repairAwsEnvironmentTrust(repair, aws.ports)).toMatchObject({
      ok: false,
      code: "aws-role-not-this-repository"
    });
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
      ok({ Role: { Arn: ROLE_ARN, AssumeRolePolicyDocument: "%7Bnot json" } }),
      "aws-role-trust-unreadable"
    ],
    [ok({ Role: { Arn: ROLE_ARN } }), "aws-role-trust-unreadable"],
    [ok({}), "aws-role-arn-mismatch"]
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
