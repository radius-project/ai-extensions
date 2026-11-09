import { describe, expect, it } from "vitest";
import { awsCommand, FakeAws, isFakeAwsWrite } from "./fake-aws.js";

const ACCOUNT = "123456789012";
const TRUST = { Version: "2012-10-17", Statement: [] };

function aws() {
  const fake = new FakeAws({ accountId: ACCOUNT });
  fake.addCluster("shop", "us-west-2");
  return fake;
}

function json(stdout: string): Record<string, any> {
  return JSON.parse(stdout);
}

const createRole = [
  "iam",
  "create-role",
  "--role-name",
  "deploy",
  "--assume-role-policy-document",
  JSON.stringify(TRUST),
  "--tags",
  "Key=radius-managed,Value=true",
  "Key=radius-operation,Value=op-1",
  "--output",
  "json"
];

describe("FakeAws", () => {
  it("answers the CLI version and the signed-in account", () => {
    const fake = aws();
    expect(fake.run(["--version"]).stdout).toMatch(/^aws-cli\/2\./);
    expect(json(fake.run(["sts", "get-caller-identity"]).stdout).Account).toBe(
      ACCOUNT
    );
  });

  it("refuses every call but the version once the sign-in expires", () => {
    const fake = aws();
    fake.sessionExpired = true;
    expect(fake.run(["--version"]).code).toBe(0);
    expect(fake.run(["sts", "get-caller-identity"])).toMatchObject({
      code: 254,
      stderr: expect.stringContaining("(ExpiredToken)")
    });
  });

  it("creates a role once, with its tags and trust, and shows it to later reads", () => {
    const fake = aws();
    const created = json(fake.run(createRole).stdout).Role;
    expect(created).toMatchObject({
      RoleName: "deploy",
      Arn: `arn:aws:iam::${ACCOUNT}:role/deploy`,
      RoleId: expect.stringMatching(/^AROA/)
    });
    expect(
      json(fake.run(["iam", "get-role", "--role-name", "DEPLOY"]).stdout).Role
    ).toMatchObject({
      RoleId: created.RoleId,
      AssumeRolePolicyDocument: TRUST,
      Tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-operation", Value: "op-1" }
      ]
    });
    expect(fake.run(createRole)).toMatchObject({
      code: 254,
      stderr: expect.stringContaining("(EntityAlreadyExists)")
    });
  });

  it("refuses a tag it cannot read", () => {
    expect(() =>
      aws().run(["iam", "create-role", "--role-name", "x", "--tags", "bad"])
    ).toThrow("unreadable tag bad");
  });

  it("changes a role's trust and inline policies, and deletes it only once they are gone", () => {
    const fake = aws();
    fake.run(createRole);
    const role = ["--role-name", "deploy"];
    const trust = { Version: "2012-10-17", Statement: [{ Sid: "x" }] };
    fake.run([
      "iam",
      "update-assume-role-policy",
      ...role,
      "--policy-document",
      JSON.stringify(trust)
    ]);
    expect(fake.role("deploy")?.AssumeRolePolicyDocument).toEqual(trust);
    fake.run([
      "iam",
      "put-role-policy",
      ...role,
      "--policy-name",
      "p",
      "--policy-document",
      "{}"
    ]);
    expect(
      json(fake.run(["iam", "list-role-policies", ...role]).stdout).PolicyNames
    ).toEqual(["p"]);
    expect(
      json(
        fake.run(["iam", "get-role-policy", ...role, "--policy-name", "p"])
          .stdout
      ).PolicyDocument
    ).toEqual({});
    expect(fake.run(["iam", "delete-role", ...role]).stderr).toContain(
      "(DeleteConflict)"
    );
    expect(
      fake.run(["iam", "delete-role-policy", ...role, "--policy-name", "p"])
        .code
    ).toBe(0);
    expect(
      fake.run(["iam", "delete-role-policy", ...role, "--policy-name", "p"])
        .stderr
    ).toContain("(NoSuchEntity)");
    expect(
      fake.run(["iam", "get-role-policy", ...role, "--policy-name", "p"]).stderr
    ).toContain("(NoSuchEntity)");
    expect(
      json(fake.run(["iam", "list-attached-role-policies", ...role]).stdout)
        .AttachedPolicies
    ).toEqual([]);
    expect(fake.run(["iam", "delete-role", ...role]).code).toBe(0);
    expect(fake.run(["iam", "get-role", ...role]).stderr).toContain(
      "(NoSuchEntity)"
    );
  });

  it("lists the managed policies attached to a role it was given", () => {
    const fake = aws();
    fake.addRole({ name: "shared", trust: TRUST, attached: ["arn:p/admin"] });
    expect(
      json(
        fake.run([
          "iam",
          "list-attached-role-policies",
          "--role-name",
          "shared"
        ]).stdout
      ).AttachedPolicies
    ).toEqual([{ PolicyName: "admin", PolicyArn: "arn:p/admin" }]);
  });

  it("lets one caller create a lock policy, whatever the name's case", () => {
    const fake = aws();
    const create = (name: string) =>
      fake.run([
        "iam",
        "create-policy",
        "--policy-name",
        name,
        "--description",
        "holder",
        "--policy-document",
        "{}"
      ]);
    const lock = json(create("radius-lock-deploy").stdout).Policy;
    expect(create("RADIUS-LOCK-DEPLOY").stderr).toContain(
      "(EntityAlreadyExists)"
    );
    const arn = ["--policy-arn", lock.Arn];
    expect(json(fake.run(["iam", "get-policy", ...arn]).stdout).Policy).toEqual(
      lock
    );
    expect(fake.locks().map((policy) => policy.PolicyId)).toEqual([
      lock.PolicyId
    ]);
    expect(fake.run(["iam", "delete-policy", ...arn]).code).toBe(0);
    expect(fake.run(["iam", "delete-policy", ...arn]).stderr).toContain(
      "(NoSuchEntity)"
    );
    expect(fake.run(["iam", "get-policy", ...arn]).stderr).toContain(
      "(NoSuchEntity)"
    );
  });

  it("creates the GitHub identity provider once and describes it", () => {
    const fake = aws();
    const arn = fake.providerArn();
    const get = ["iam", "get-open-id-connect-provider"];
    expect(
      fake.run([...get, "--open-id-connect-provider-arn", arn]).stderr
    ).toContain("(NoSuchEntity)");
    const create = [
      "iam",
      "create-open-id-connect-provider",
      "--client-id-list",
      "sts.amazonaws.com"
    ];
    expect(json(fake.run(create).stdout).OpenIDConnectProviderArn).toBe(arn);
    expect(fake.run(create).stderr).toContain("(EntityAlreadyExists)");
    expect(
      json(fake.run(["iam", "list-open-id-connect-providers"]).stdout)
    ).toEqual({ OpenIDConnectProviderList: [{ Arn: arn }] });
    expect(
      json(fake.run([...get, "--open-id-connect-provider-arn", arn]).stdout)
        .ClientIDList
    ).toEqual(["sts.amazonaws.com"]);
  });

  it("describes a cluster it has and refuses one it does not", () => {
    const fake = aws();
    expect(
      json(
        fake.run([
          "eks",
          "describe-cluster",
          "--name",
          "shop",
          "--region",
          "us-west-2"
        ]).stdout
      ).cluster
    ).toEqual({
      name: "shop",
      status: "ACTIVE",
      accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" }
    });
    expect(
      fake.run([
        "eks",
        "describe-cluster",
        "--name",
        "other",
        "--region",
        "us-west-2"
      ]).stderr
    ).toContain("(ResourceNotFoundException)");
  });

  it("keeps an access entry for a role that exists, with its tags and policies", () => {
    const fake = aws();
    const principal = `arn:aws:iam::${ACCOUNT}:role/deploy`;
    const entry = (
      verb: string,
      cluster = "shop",
      ...extra: string[]
    ): string[] => [
      "eks",
      verb,
      "--cluster-name",
      cluster,
      "--principal-arn",
      principal,
      "--region",
      "us-west-2",
      ...extra
    ];
    const create = entry(
      "create-access-entry",
      "shop",
      "--tags",
      "radius-managed=true,radius-operation=op-1"
    );
    expect(fake.run(create).stderr).toContain("(InvalidParameterException)");
    expect(fake.run(entry("create-access-entry", "gone")).stderr).toContain(
      "(ResourceNotFoundException)"
    );
    fake.run(createRole);
    expect(json(fake.run(create).stdout).accessEntry.tags).toEqual({
      "radius-managed": "true",
      "radius-operation": "op-1"
    });
    expect(fake.run(create).stderr).toContain("(ResourceInUseException)");
    fake.run(entry("associate-access-policy", "shop", "--policy-arn", "admin"));
    fake.run(entry("associate-access-policy", "shop", "--policy-arn", "admin"));
    expect(fake.snapshot().entries).toEqual([
      {
        cluster: "us-west-2:shop",
        principalArn: principal,
        tags: { "radius-managed": "true", "radius-operation": "op-1" },
        policies: ["admin"]
      }
    ]);
    expect(
      json(fake.run(entry("describe-access-entry")).stdout).accessEntry
        .principalArn
    ).toBe(principal);
    expect(fake.run(entry("delete-access-entry")).code).toBe(0);
    expect(fake.run(entry("describe-access-entry")).stderr).toContain(
      "(ResourceNotFoundException)"
    );
  });

  it("refuses an entry on a cluster it was never given", () => {
    expect(() => aws().addAccessEntry("eu-west-1", "x", "arn")).toThrow(
      "no cluster eu-west-1:x"
    );
  });

  it("refuses a command once when asked, changing nothing", () => {
    const fake = aws();
    fake.refuseOnce("iam create-role", "Throttling");
    expect(fake.run(createRole).stderr).toContain("(Throttling)");
    expect(fake.role("deploy")).toBeUndefined();
    expect(fake.run(createRole).code).toBe(0);
  });

  it("throws on a command it has no answer for, so a test sees it", () => {
    expect(() => aws().run(["s3", "ls"])).toThrow("no answer for aws s3 ls");
  });

  it("names its commands and tells writes from reads", () => {
    expect(awsCommand(["--version"])).toBe("--version");
    expect(awsCommand(["iam", "get-role", "--role-name", "x"])).toBe(
      "iam get-role"
    );
    expect(isFakeAwsWrite(["iam", "create-role"])).toBe(true);
    expect(isFakeAwsWrite(["eks", "associate-access-policy"])).toBe(true);
    expect(isFakeAwsWrite(["iam", "get-role"])).toBe(false);
    expect(isFakeAwsWrite(["--version"])).toBe(false);
  });

  it("stamps each creation later than the last on its default clock", () => {
    const fake = new FakeAws();
    const first = fake.addRole({ name: "a", trust: TRUST });
    const second = fake.addRole({ name: "b", trust: TRUST });
    expect(Date.parse(second.CreateDate)).toBeGreaterThan(
      Date.parse(first.CreateDate)
    );
    expect(fake.snapshot().roles.map((role) => role.RoleName)).toEqual([
      "a",
      "b"
    ]);
  });
});
