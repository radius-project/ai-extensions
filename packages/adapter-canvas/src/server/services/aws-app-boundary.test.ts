import { describe, expect, it } from "vitest";
import { buildAwsAppBoundaryPolicy } from "@radius-project/core";
import { ensureAppBoundary, removeAppRoles } from "./aws-app-boundary.js";
import type { AwsCommandResult } from "./aws-deploy-identity.js";

const ACCOUNT = "123456789012";
const POLICY = "radius-deploy-dev-0123456789ab";
const NAME = "radius-app-dev-0123456789ab";
const PATH = "/radius/apps/dev-0123456789ab/";
const ARN = `arn:aws:iam::${ACCOUNT}:policy${PATH}${NAME}`;
const input = {
  repo: "octo/shop",
  environment: "dev",
  accountId: ACCOUNT,
  region: "us-west-2",
  policyName: POLICY
};

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
const versions = ok({
  Versions: [
    { VersionId: "v3", IsDefaultVersion: true },
    { VersionId: "v2", IsDefaultVersion: false },
    { VersionId: "v1", IsDefaultVersion: false },
    "not a version"
  ]
});

// Answers each `aws iam` command by its name, and throws on any other.
function fakeAws(script: Record<string, AwsCommandResult>) {
  const calls: string[][] = [];
  return {
    calls,
    commands: () => calls.map((args) => args[1]),
    ports: {
      async runAws(args: string[]) {
        calls.push(args);
        const result = script[args[1] ?? ""];
        if (!result) throw new Error(`unexpected aws ${args.join(" ")}`);
        return result;
      }
    }
  };
}

describe("ensureAppBoundary", () => {
  it("creates the boundary under the environment's role path", async () => {
    const aws = fakeAws({ "create-policy": ok() });
    expect(await ensureAppBoundary(input, aws.ports)).toEqual({
      ok: true,
      name: NAME,
      created: true
    });
    const args = aws.calls[0] ?? [];
    expect(args[args.indexOf("--policy-name") + 1]).toBe(NAME);
    expect(args[args.indexOf("--path") + 1]).toBe(PATH);
    expect(
      JSON.parse(args[args.indexOf("--policy-document") + 1] ?? "")
    ).toEqual(buildAwsAppBoundaryPolicy(ACCOUNT, "us-west-2"));
  });

  it("replaces an existing boundary's document, deleting old versions first", async () => {
    const aws = fakeAws({
      "create-policy": fail("EntityAlreadyExists"),
      "list-policy-versions": versions,
      "delete-policy-version": ok(),
      "create-policy-version": ok()
    });
    expect(await ensureAppBoundary(input, aws.ports)).toEqual({
      ok: true,
      name: NAME,
      created: false
    });
    expect(aws.commands()).toEqual([
      "create-policy",
      "list-policy-versions",
      "delete-policy-version",
      "delete-policy-version",
      "create-policy-version"
    ]);
    expect(aws.calls[2]).toContain("v2");
    expect(aws.calls[3]).toContain("v1");
    expect(aws.calls[4]).toEqual(
      expect.arrayContaining(["--policy-arn", ARN, "--set-as-default"])
    );
  });

  it("names the permissions to ask for when IAM denies the create", async () => {
    const aws = fakeAws({
      "create-policy": fail(
        "AccessDenied: not authorized to perform iam:CreatePolicy"
      )
    });
    const result = await ensureAppBoundary(input, aws.ports);
    expect(result).toMatchObject({
      ok: false,
      code: "aws-app-boundary-denied"
    });
    expect(!result.ok && result.message).toContain(
      `iam:CreatePolicy, iam:CreatePolicyVersion, iam:ListPolicyVersions, and iam:DeletePolicyVersion on arn:aws:iam::${ACCOUNT}:policy/radius/apps/*`
    );
  });

  it("reports other create failures without a permissions hint", async () => {
    const aws = fakeAws({ "create-policy": fail("ServiceFailure") });
    expect(await ensureAppBoundary(input, aws.ports)).toEqual({
      ok: false,
      code: "aws-app-boundary-failed",
      message: `Could not create permissions boundary ${NAME} for the environment's app roles: ServiceFailure.`
    });
  });

  it("reports a timed out create", async () => {
    const aws = fakeAws({
      "create-policy": { ...fail(""), timedOut: true }
    });
    const result = await ensureAppBoundary(input, aws.ports);
    expect(!result.ok && result.message).toContain(
      "the AWS CLI call timed out"
    );
  });

  it("stops when the existing versions cannot be listed", async () => {
    const aws = fakeAws({
      "create-policy": fail("EntityAlreadyExists"),
      "list-policy-versions": ok("not json")
    });
    expect(await ensureAppBoundary(input, aws.ports)).toEqual({
      ok: false,
      code: "aws-app-boundary-failed",
      message: `Could not list the versions of ${ARN}: not json.`
    });
  });

  it("stops when an old version cannot be deleted", async () => {
    const aws = fakeAws({
      "create-policy": fail("EntityAlreadyExists"),
      "list-policy-versions": versions,
      "delete-policy-version": fail("ServiceFailure")
    });
    expect(await ensureAppBoundary(input, aws.ports)).toMatchObject({
      ok: false,
      message: `Could not delete version v2 of ${ARN}: ServiceFailure.`
    });
    expect(aws.commands()).not.toContain("create-policy-version");
  });

  it("goes on when another run deleted an old version first", async () => {
    const aws = fakeAws({
      "create-policy": fail("EntityAlreadyExists"),
      "list-policy-versions": versions,
      "delete-policy-version": fail("NoSuchEntity"),
      "create-policy-version": ok()
    });
    expect(await ensureAppBoundary(input, aws.ports)).toMatchObject({
      ok: true
    });
  });

  it("names the permissions to ask for when IAM denies the update", async () => {
    const aws = fakeAws({
      "create-policy": fail("EntityAlreadyExists"),
      "list-policy-versions": ok({ Versions: [] }),
      "create-policy-version": fail("AccessDenied")
    });
    expect(await ensureAppBoundary(input, aws.ports)).toMatchObject({
      ok: false,
      code: "aws-app-boundary-denied",
      message: expect.stringContaining(
        `Could not update permissions boundary ${NAME}: AccessDenied.`
      )
    });
  });
});

describe("removeAppRoles", () => {
  const noRoles = ok({ Roles: [] });
  const unused = ok({ PolicyRoles: [] });
  const inUse = `Kept permissions boundary ${NAME}, because a role still uses it. Find the role with: aws iam list-entities-for-policy --policy-arn ${ARN} --policy-usage-filter PermissionsBoundary`;
  const remove = (aws: ReturnType<typeof fakeAws>) =>
    removeAppRoles({ accountId: ACCOUNT, policyName: POLICY }, aws.ports);

  it("deletes each role under the path, then the boundary and its old versions", async () => {
    const aws = fakeAws({
      "list-roles": ok({
        Roles: [
          { RoleName: "radius-app-web-abc" },
          "not a role",
          { RoleName: "radius-app-api-def" }
        ]
      }),
      "list-role-policies": ok({ PolicyNames: ["connections", 7] }),
      "delete-role-policy": ok(),
      "delete-role": ok(),
      "list-entities-for-policy": unused,
      "list-policy-versions": versions,
      "delete-policy-version": ok(),
      "delete-policy": ok()
    });
    expect(await remove(aws)).toEqual({
      ok: true,
      removed: [
        "IAM role radius-app-web-abc",
        "IAM role radius-app-api-def",
        `permissions boundary ${NAME}`
      ]
    });
    expect(aws.calls[0]).toEqual([
      "iam",
      "list-roles",
      "--path-prefix",
      PATH,
      "--output",
      "json"
    ]);
    expect(aws.calls.slice(1, 4)).toEqual([
      [
        "iam",
        "list-role-policies",
        "--role-name",
        "radius-app-web-abc",
        "--output",
        "json"
      ],
      [
        "iam",
        "delete-role-policy",
        "--role-name",
        "radius-app-web-abc",
        "--policy-name",
        "connections"
      ],
      ["iam", "delete-role", "--role-name", "radius-app-web-abc"]
    ]);
    expect(aws.calls).toContainEqual(
      expect.arrayContaining([
        "list-entities-for-policy",
        "--policy-arn",
        ARN,
        "--policy-usage-filter",
        "PermissionsBoundary"
      ])
    );
    expect(aws.calls.at(-1)).toEqual([
      "iam",
      "delete-policy",
      "--policy-arn",
      ARN
    ]);
  });

  it("treats a role or policy that is already gone as deleted", async () => {
    const roles = ok({ Roles: [{ RoleName: "a" }, { RoleName: "b" }] });
    const gone = fakeAws({
      "list-roles": roles,
      "list-role-policies": fail("NoSuchEntity"),
      "list-entities-for-policy": fail("NoSuchEntity")
    });
    expect(await remove(gone)).toEqual({
      ok: true,
      removed: ["IAM role a", "IAM role b"]
    });
    const raced = fakeAws({
      "list-roles": ok({ Roles: [{ RoleName: "a" }] }),
      "list-role-policies": ok({ PolicyNames: ["connections"] }),
      "delete-role-policy": fail("NoSuchEntity"),
      "delete-role": fail("NoSuchEntity"),
      "list-entities-for-policy": fail("NoSuchEntity")
    });
    expect(await remove(raced)).toEqual({ ok: true, removed: ["IAM role a"] });
  });

  it.each([
    [
      "listing the roles fails",
      { "list-roles": fail("Throttling: Rate exceeded") },
      `Could not list the IAM roles under ${PATH}: Throttling: Rate exceeded.`
    ],
    [
      "IAM returns no role list",
      { "list-roles": ok({}) },
      `Could not list the IAM roles under ${PATH}: {}.`
    ],
    [
      "a role's policies can't be listed",
      {
        "list-roles": ok({ Roles: [{ RoleName: "a" }] }),
        "list-role-policies": ok({})
      },
      "Could not list the policies of IAM role a: {}."
    ],
    [
      "a role's policy can't be deleted",
      {
        "list-roles": ok({ Roles: [{ RoleName: "a" }] }),
        "list-role-policies": ok({ PolicyNames: ["connections"] }),
        "delete-role-policy": fail("ServiceFailure")
      },
      "Could not delete policy connections from IAM role a: ServiceFailure."
    ],
    [
      "a role can't be deleted",
      {
        "list-roles": ok({ Roles: [{ RoleName: "a" }] }),
        "list-role-policies": ok({ PolicyNames: [] }),
        "delete-role": fail("DeleteConflict: attached policies")
      },
      "Could not delete IAM role a: DeleteConflict: attached policies."
    ]
  ])(
    "stops and keeps the boundary when %s",
    async (_label, script, message) => {
      const aws = fakeAws(script);
      expect(await remove(aws)).toEqual({ ok: false, removed: [], message });
      expect(aws.commands()).not.toContain("list-entities-for-policy");
    }
  );

  it("reports the roles it deleted before one failed", async () => {
    const aws = fakeAws({
      "list-roles": ok({ Roles: [{ RoleName: "a" }, { RoleName: "b" }] }),
      "list-role-policies": ok({ PolicyNames: [] }),
      "delete-role": ok()
    });
    let deletes = 0;
    const ports = {
      async runAws(args: string[]) {
        if (args[1] === "delete-role" && ++deletes === 2) {
          return fail("ServiceFailure");
        }
        return aws.ports.runAws(args);
      }
    };
    expect(
      await removeAppRoles({ accountId: ACCOUNT, policyName: POLICY }, ports)
    ).toEqual({
      ok: false,
      removed: ["IAM role a"],
      message: "Could not delete IAM role b: ServiceFailure."
    });
  });

  it("keeps the roles and boundary with a warning when IAM denies the listing", async () => {
    const aws = fakeAws({
      "list-roles": fail("AccessDenied: iam:ListRoles")
    });
    expect(await remove(aws)).toEqual({
      ok: true,
      removed: [],
      warning: `Kept any IAM roles under ${PATH} and permissions boundary ${NAME}, because the signed-in AWS identity can't list the roles (AccessDenied: iam:ListRoles). To delete them, allow iam:ListRoles and retry, or find them with: aws iam list-roles --path-prefix ${PATH}`
    });
    expect(aws.commands()).toEqual(["list-roles"]);
  });

  it("treats a missing boundary as already gone", async () => {
    const aws = fakeAws({
      "list-roles": noRoles,
      "list-entities-for-policy": fail("NoSuchEntity")
    });
    expect(await remove(aws)).toEqual({ ok: true, removed: [] });
  });

  it("keeps a boundary that a role outside the path uses, and says how to find it", async () => {
    const aws = fakeAws({
      "list-roles": noRoles,
      "list-entities-for-policy": ok({
        PolicyRoles: [{ RoleName: "someone-elses-role" }]
      })
    });
    expect(await remove(aws)).toEqual({
      ok: true,
      removed: [],
      warning: inUse
    });
    expect(aws.commands()).toEqual(["list-roles", "list-entities-for-policy"]);
  });

  // An environment set up before app roles has no boundary, and IAM denies
  // the check before it looks for one.
  it("keeps the boundary with a warning when IAM denies the check", async () => {
    const aws = fakeAws({
      "list-roles": noRoles,
      "list-entities-for-policy": fail(
        "An error occurred (AccessDenied) when calling the ListEntitiesForPolicy operation"
      )
    });
    expect(await remove(aws)).toEqual({
      ok: true,
      removed: [],
      warning: `Kept permissions boundary ${NAME} if it exists, because the signed-in AWS identity can't check which roles use it (An error occurred (AccessDenied) when calling the ListEntitiesForPolicy operation). To delete it, allow iam:ListEntitiesForPolicy and iam:DeletePolicy on arn:aws:iam::${ACCOUNT}:policy/radius/apps/*, or delete it by hand once no role uses it.`
    });
  });

  it("stops when it cannot tell which roles use the boundary", async () => {
    expect(
      await remove(
        fakeAws({
          "list-roles": noRoles,
          "list-entities-for-policy": fail("")
        })
      )
    ).toEqual({
      ok: false,
      removed: [],
      message: `Could not check which roles use permissions boundary ${NAME}: no output.`
    });
    expect(
      await remove(
        fakeAws({ "list-roles": noRoles, "list-entities-for-policy": ok({}) })
      )
    ).toEqual({
      ok: false,
      removed: [],
      message: `IAM did not return the roles that use permissions boundary ${NAME}, so Radius kept it.`
    });
  });

  it("stops when an old version cannot be deleted", async () => {
    const aws = fakeAws({
      "list-roles": noRoles,
      "list-entities-for-policy": unused,
      "list-policy-versions": fail("ServiceFailure")
    });
    expect(await remove(aws)).toEqual({
      ok: false,
      removed: [],
      message: `Could not list the versions of ${ARN}: ServiceFailure.`
    });
  });

  it.each([
    ["NoSuchEntity", { ok: true, removed: [] }],
    [
      "DeleteConflict: Cannot delete a policy attached to entities.",
      { ok: true, removed: [], warning: inUse }
    ],
    [
      "ServiceFailure",
      {
        ok: false,
        removed: [],
        message: `Could not delete permissions boundary ${NAME}: ServiceFailure.`
      }
    ]
  ])(
    "handles a boundary delete that fails with %s",
    async (stderr, expected) => {
      const aws = fakeAws({
        "list-roles": noRoles,
        "list-entities-for-policy": unused,
        "list-policy-versions": ok({ Versions: [] }),
        "delete-policy": fail(stderr)
      });
      expect(await remove(aws)).toEqual(expected);
    }
  );
});
