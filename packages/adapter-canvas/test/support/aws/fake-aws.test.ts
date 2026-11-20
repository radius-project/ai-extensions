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

  it("lists customer managed policies by path, without their tags", () => {
    const fake = aws();
    fake.addManagedPolicy({
      path: "/radius/apps/7/env-a/",
      name: "boundary-a",
      document: TRUST,
      tags: [{ Key: "radius-managed", Value: "true" }]
    });
    fake.addManagedPolicy({ path: "/other/", name: "other", document: TRUST });
    const listed = json(
      fake.run([
        "iam",
        "list-policies",
        "--scope",
        "Local",
        "--path-prefix",
        "/radius/apps/7/",
        "--output",
        "json"
      ]).stdout
    );
    expect(listed.Policies).toEqual([
      {
        PolicyName: "boundary-a",
        PolicyId: expect.stringMatching(/^ANPA/),
        Arn: `arn:aws:iam::${ACCOUNT}:policy/radius/apps/7/env-a/boundary-a`,
        Path: "/radius/apps/7/env-a/",
        DefaultVersionId: "v1",
        AttachmentCount: 0,
        PermissionsBoundaryUsageCount: 0,
        IsAttachable: true,
        CreateDate: expect.any(String)
      }
    ]);
    expect(listed.IsTruncated).toBe(false);
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
    ).toMatchObject({
      name: "shop",
      status: "ACTIVE",
      accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
      resourcesVpcConfig: { vpcId: "vpc-shop" }
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

describe("FakeAws app roles and boundaries", () => {
  const BOUNDARY_PATH = "/radius/apps/7/dev/";
  const boundaryArn = `arn:aws:iam::${ACCOUNT}:policy${BOUNDARY_PATH}radius-app-boundary-7-dev`;

  function withBoundary() {
    const fake = aws();
    fake.addManagedPolicy({
      path: BOUNDARY_PATH,
      name: "radius-app-boundary-7-dev",
      document: TRUST,
      tags: [{ Key: "radius-repository-id", Value: "7" }]
    });
    return fake;
  }

  const createAppRole = (boundary: string, path = BOUNDARY_PATH) => [
    "iam",
    "create-role",
    "--role-name",
    "radius-app-web-1",
    "--path",
    path,
    "--permissions-boundary",
    boundary,
    "--assume-role-policy-document",
    JSON.stringify(TRUST)
  ];

  it("creates a role under a path with its boundary, and shows both", () => {
    const fake = withBoundary();
    const created = json(fake.run(createAppRole(boundaryArn)).stdout).Role;
    expect(created.Arn).toBe(
      `arn:aws:iam::${ACCOUNT}:role${BOUNDARY_PATH}radius-app-web-1`
    );
    const read = json(
      fake.run(["iam", "get-role", "--role-name", "radius-app-web-1"]).stdout
    ).Role;
    expect(read).toMatchObject({
      Path: BOUNDARY_PATH,
      PermissionsBoundary: {
        PermissionsBoundaryType: "Policy",
        PermissionsBoundaryArn: boundaryArn
      }
    });
  });

  it("refuses a boundary that doesn't exist, a bad path, and a name taken under another path", () => {
    const fake = withBoundary();
    expect(fake.run(createAppRole(`${boundaryArn}-gone`)).stderr).toContain(
      "(NoSuchEntity)"
    );
    expect(
      fake.run(createAppRole(boundaryArn, "radius/apps")).stderr
    ).toContain("(ValidationError)");
    fake.addRole({ name: "RADIUS-APP-WEB-1", trust: TRUST });
    expect(fake.run(createAppRole(boundaryArn)).stderr).toContain(
      "(EntityAlreadyExists)"
    );
  });

  it("lists roles and policies under a path, without tags or boundaries", () => {
    const fake = withBoundary();
    fake.run(createAppRole(boundaryArn));
    fake.addRole({ name: "elsewhere", trust: TRUST });
    const roles = json(
      fake.run(["iam", "list-roles", "--path-prefix", "/radius/apps/7/"]).stdout
    ).Roles;
    expect(roles.map((role: { RoleName: string }) => role.RoleName)).toEqual([
      "radius-app-web-1"
    ]);
    expect(roles[0]).not.toHaveProperty("PermissionsBoundary");
    expect(roles[0]).not.toHaveProperty("Tags");
    expect(json(fake.run(["iam", "list-roles"]).stdout).Roles.length).toBe(2);
    const policies = json(
      fake.run([
        "iam",
        "list-policies",
        "--scope",
        "Local",
        "--path-prefix",
        "/radius/apps/7/"
      ]).stdout
    ).Policies;
    expect(policies).toEqual([
      expect.objectContaining({
        Arn: boundaryArn,
        AttachmentCount: 0,
        PermissionsBoundaryUsageCount: 1
      })
    ]);
    expect(policies[0]).not.toHaveProperty("Tags");
    expect(
      json(
        fake.run([
          "iam",
          "list-policies",
          "--scope",
          "Local",
          "--path-prefix",
          "/other/"
        ]).stdout
      ).Policies
    ).toEqual([]);
    expect(() => fake.run(["iam", "list-policies"])).toThrow("--scope Local");
  });

  it("lists a role's tags", () => {
    const fake = aws();
    fake.addRole({
      name: "tagged",
      trust: TRUST,
      tags: [{ Key: "radapp.io/environment", Value: "/x/dev" }]
    });
    expect(
      json(fake.run(["iam", "list-role-tags", "--role-name", "tagged"]).stdout)
    ).toEqual({
      Tags: [{ Key: "radapp.io/environment", Value: "/x/dev" }],
      IsTruncated: false
    });
    expect(
      fake.run(["iam", "list-role-tags", "--role-name", "gone"]).stderr
    ).toContain("(NoSuchEntity)");
  });

  it("still lists a deleted role and its tags for a while, though GetRole and writes see it gone", () => {
    const fake = withBoundary();
    fake.lingeringReads = 1;
    fake.run(createAppRole(boundaryArn));
    expect(
      fake.run(["iam", "delete-role", "--role-name", "radius-app-web-1"]).code
    ).toBe(0);
    const listed = () =>
      json(
        fake.run(["iam", "list-roles", "--path-prefix", "/radius/apps/7/"])
          .stdout
      ).Roles.map((role: { RoleName: string }) => role.RoleName);
    const tags = () =>
      fake.run(["iam", "list-role-tags", "--role-name", "radius-app-web-1"]);
    expect(listed()).toEqual(["radius-app-web-1"]);
    expect(tags().code).toBe(0);
    expect(
      fake.run(["iam", "get-role", "--role-name", "radius-app-web-1"]).stderr
    ).toContain("(NoSuchEntity)");
    expect(
      fake.run(["iam", "delete-role", "--role-name", "radius-app-web-1"]).stderr
    ).toContain("(NoSuchEntity)");
    expect(listed()).toEqual([]);
    expect(tags().stderr).toContain("(NoSuchEntity)");

    // A role made again with the name is listed once, and settle ends a
    // delete at once.
    fake.lingeringReads = 5;
    fake.run(createAppRole(boundaryArn));
    fake.run(["iam", "delete-role", "--role-name", "radius-app-web-1"]);
    fake.run(createAppRole(boundaryArn));
    expect(listed()).toEqual(["radius-app-web-1"]);
    fake.run(["iam", "delete-role", "--role-name", "radius-app-web-1"]);
    fake.settle();
    expect(listed()).toEqual([]);
  });

  it("deletes a boundary only once no role uses it, and a policy only without extra versions or attachments", () => {
    const fake = withBoundary();
    fake.run(createAppRole(boundaryArn));
    const deletePolicy = (arn: string) =>
      fake.run(["iam", "delete-policy", "--policy-arn", arn]);
    expect(
      json(fake.run(["iam", "get-policy", "--policy-arn", boundaryArn]).stdout)
        .Policy
    ).toMatchObject({ PermissionsBoundaryUsageCount: 1, AttachmentCount: 0 });
    expect(deletePolicy(boundaryArn).stderr).toContain("(DeleteConflict)");
    // A boundary doesn't stop the role's own delete.
    expect(
      fake.run(["iam", "delete-role", "--role-name", "radius-app-web-1"]).code
    ).toBe(0);
    expect(deletePolicy(boundaryArn).code).toBe(0);

    const versioned = fake.addManagedPolicy({
      path: "/",
      name: "versioned",
      document: TRUST,
      extraVersions: 1
    });
    expect(
      json(
        fake.run(["iam", "get-policy", "--policy-arn", versioned.Arn]).stdout
      ).Policy.DefaultVersionId
    ).toBe("v2");
    expect(
      fake.run([
        "iam",
        "get-policy-version",
        "--policy-arn",
        versioned.Arn,
        "--version-id",
        "v2"
      ]).code
    ).toBe(0);
    expect(deletePolicy(versioned.Arn).stderr).toContain("(DeleteConflict)");

    const attached = fake.addManagedPolicy({
      path: "/",
      name: "attached",
      document: TRUST
    });
    fake.addRole({ name: "user", trust: TRUST, attached: [attached.Arn] });
    expect(deletePolicy(attached.Arn).stderr).toContain("(DeleteConflict)");
  });
});

describe("FakeAws Pod Identity associations", () => {
  const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/radius/apps/7/dev/radius-app-web-1`;

  function withAssociation() {
    const fake = aws();
    const association = fake.addPodIdentityAssociation("us-west-2", "shop", {
      namespace: "default-app",
      serviceAccount: "radius-app-web",
      roleArn: ROLE_ARN,
      tags: { "radapp.io/environment": "/x/dev" }
    });
    return { fake, association };
  }

  const target = (id: string, cluster = "shop") => [
    "--cluster-name",
    cluster,
    "--region",
    "us-west-2",
    "--association-id",
    id
  ];

  it("lists associations without their role or tags, and describes them with both", () => {
    const { fake, association } = withAssociation();
    const listed = json(
      fake.run([
        "eks",
        "list-pod-identity-associations",
        "--cluster-name",
        "shop",
        "--region",
        "us-west-2"
      ]).stdout
    ).associations;
    expect(listed).toEqual([
      {
        clusterName: "shop",
        namespace: "default-app",
        serviceAccount: "radius-app-web",
        associationArn: association.associationArn,
        associationId: association.associationId
      }
    ]);
    expect(association.associationArn).toBe(
      `arn:aws:eks:us-west-2:${ACCOUNT}:podidentityassociation/shop/${association.associationId}`
    );
    expect(
      json(
        fake.run([
          "eks",
          "list-pod-identity-associations",
          "--cluster-name",
          "shop",
          "--region",
          "us-west-2",
          "--namespace",
          "other"
        ]).stdout
      ).associations
    ).toEqual([]);
    expect(
      json(
        fake.run([
          "eks",
          "describe-pod-identity-association",
          ...target(association.associationId)
        ]).stdout
      ).association
    ).toMatchObject({
      roleArn: ROLE_ARN,
      tags: { "radapp.io/environment": "/x/dev" }
    });
  });

  it("deletes an association once, and refuses an unknown one or cluster", () => {
    const { fake, association } = withAssociation();
    const remove = (id: string, cluster?: string) =>
      fake.run([
        "eks",
        "delete-pod-identity-association",
        ...target(id, cluster)
      ]);
    expect(isFakeAwsWrite(["eks", "delete-pod-identity-association"])).toBe(
      true
    );
    expect(
      json(remove(association.associationId).stdout).association.roleArn
    ).toBe(ROLE_ARN);
    expect(remove(association.associationId).stderr).toContain(
      "(ResourceNotFoundException)"
    );
    expect(remove("a-1", "gone").stderr).toContain(
      "(ResourceNotFoundException)"
    );
    expect(
      fake.run([
        "eks",
        "list-pod-identity-associations",
        "--cluster-name",
        "gone",
        "--region",
        "us-west-2"
      ]).stderr
    ).toContain("(ResourceNotFoundException)");
  });

  it("still lists and describes a deleted association for a while", () => {
    const { fake, association } = withAssociation();
    fake.lingeringReads = 1;
    const id = association.associationId;
    const list = () =>
      json(
        fake.run([
          "eks",
          "list-pod-identity-associations",
          "--cluster-name",
          "shop",
          "--region",
          "us-west-2"
        ]).stdout
      ).associations.map(
        (item: { associationId: string }) => item.associationId
      );
    const describe = () =>
      fake.run(["eks", "describe-pod-identity-association", ...target(id)]);
    expect(
      fake.run(["eks", "delete-pod-identity-association", ...target(id)]).code
    ).toBe(0);
    expect(json(describe().stdout).association.roleArn).toBe(ROLE_ARN);
    expect(list()).toEqual([id]);
    expect(list()).toEqual([]);
    expect(describe().stderr).toContain("(ResourceNotFoundException)");

    const again = fake.addPodIdentityAssociation("us-west-2", "shop", {
      namespace: "default-app",
      serviceAccount: "radius-app-web",
      roleArn: ROLE_ARN
    });
    fake.run([
      "eks",
      "delete-pod-identity-association",
      ...target(again.associationId)
    ]);
    fake.settle();
    expect(list()).toEqual([]);
  });

  it("allows one association per service account in a namespace", () => {
    const { fake } = withAssociation();
    expect(() =>
      fake.addPodIdentityAssociation("us-west-2", "shop", {
        namespace: "default-app",
        serviceAccount: "radius-app-web",
        roleArn: ROLE_ARN
      })
    ).toThrow("already has an association");
    expect(() =>
      fake.addPodIdentityAssociation("us-east-1", "shop", {
        namespace: "default-app",
        serviceAccount: "radius-app-web",
        roleArn: ROLE_ARN
      })
    ).toThrow("no cluster");
  });
});

describe("FakeAws policy simulator", () => {
  const regional = (region: string) => ({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "rds:*",
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": region } }
      }
    ]
  });

  function simulate(fake: FakeAws, region: string, role = "deploy") {
    return fake.run([
      "iam",
      "simulate-principal-policy",
      "--policy-source-arn",
      fake.roleArn(role),
      "--action-names",
      "rds:CreateDBInstance",
      "eks:DescribeCluster",
      "--context-entries",
      JSON.stringify([
        {
          ContextKeyName: "aws:RequestedRegion",
          ContextKeyValues: [region],
          ContextKeyType: "string"
        }
      ])
    ]);
  }

  it("decides with the role's own policies capped by its boundary", () => {
    const fake = aws();
    const boundary = fake.addManagedPolicy({
      path: "/",
      name: "boundary",
      document: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["rds:*", "eks:*"], Resource: "*" }
        ]
      }
    });
    fake.addRole({
      name: "deploy",
      trust: TRUST,
      boundary: boundary.Arn,
      inline: { east: regional("us-east-2") }
    });
    const decisions = (region: string) =>
      json(simulate(fake, region).stdout).EvaluationResults.map(
        (item: { EvalActionName: string; EvalDecision: string }) =>
          `${item.EvalActionName} ${item.EvalDecision}`
      );
    expect(decisions("us-east-2")).toEqual([
      "rds:CreateDBInstance allowed",
      "eks:DescribeCluster implicitDeny"
    ]);
    expect(decisions("us-west-1")).toEqual([
      "rds:CreateDBInstance implicitDeny",
      "eks:DescribeCluster implicitDeny"
    ]);
    expect(simulate(fake, "us-east-2", "gone").stderr).toContain(
      "(NoSuchEntity)"
    );
  });

  it("counts attached policies, and a role with no boundary", () => {
    const fake = aws();
    const attached = fake.addManagedPolicy({
      path: "/",
      name: "west",
      document: regional("us-west-1")
    });
    fake.addRole({ name: "deploy", trust: TRUST, attached: [attached.Arn] });
    expect(
      json(simulate(fake, "us-west-1").stdout).EvaluationResults[0].EvalDecision
    ).toBe("allowed");
  });
});

describe("FakeAws EKS clusters and node groups", () => {
  const MAIN = ["--region", "us-east-2", "--cluster-name", "main"];

  function cluster() {
    const fake = new FakeAws({ accountId: ACCOUNT });
    const main = fake.addCluster("main", "us-east-2", "API", "vpc-main");
    const group = fake.addNodegroup("us-east-2", "main", "isolated", {
      minSize: 0,
      maxSize: 1,
      desiredSize: 0
    });
    return { fake, main, group };
  }

  it("describes the version, endpoint, security group, and upgrade policy", () => {
    const { fake, main } = cluster();
    main.supportType = "EXTENDED";
    expect(
      json(
        fake.run([
          "eks",
          "describe-cluster",
          "--region",
          "us-east-2",
          "--name",
          "main"
        ]).stdout
      ).cluster
    ).toEqual({
      name: "main",
      status: "ACTIVE",
      version: "1.33",
      accessConfig: { authenticationMode: "API" },
      resourcesVpcConfig: {
        vpcId: "vpc-main",
        clusterSecurityGroupId: "sg-cluster-main",
        endpointPublicAccess: true
      },
      upgradePolicy: { supportType: "EXTENDED" }
    });
  });

  it("answers the Pod Identity add-on's status, and not found once it is gone", () => {
    const { fake, main } = cluster();
    const describe = [
      "eks",
      "describe-addon",
      "--cluster-name",
      "main",
      "--addon-name",
      "eks-pod-identity-agent",
      "--region",
      "us-east-2"
    ];
    main.podIdentityAgent = "DEGRADED";
    expect(json(fake.run(describe).stdout).addon.status).toBe("DEGRADED");
    main.podIdentityAgent = null;
    expect(fake.run(describe).stderr).toContain("(ResourceNotFoundException)");
  });

  it("lists node groups, and refuses an unknown cluster", () => {
    const { fake } = cluster();
    expect(json(fake.run(["eks", "list-nodegroups", ...MAIN]).stdout)).toEqual({
      nodegroups: ["isolated"]
    });
    expect(
      fake.run([
        "eks",
        "list-nodegroups",
        "--region",
        "us-west-1",
        "--cluster-name",
        "main"
      ]).stderr
    ).toContain("(ResourceNotFoundException)");
  });

  it("describes a node group's version, labels, taints, and launch template", () => {
    const { fake, group } = cluster();
    group.labels = { "radius-e2e/pool": "isolated" };
    group.taints = [
      { key: "radius-e2e/isolated", value: "true", effect: "NO_SCHEDULE" }
    ];
    group.launchTemplate = { id: "lt-1", version: "2" };
    expect(
      json(
        fake.run([
          "eks",
          "describe-nodegroup",
          ...MAIN,
          "--nodegroup-name",
          "isolated"
        ]).stdout
      ).nodegroup
    ).toMatchObject({
      version: "1.33",
      releaseVersion: "1.33.0-20261101",
      labels: { "radius-e2e/pool": "isolated" },
      taints: [
        { key: "radius-e2e/isolated", value: "true", effect: "NO_SCHEDULE" }
      ],
      launchTemplate: { id: "lt-1", version: "2" }
    });
  });

  it("updates a node group to the control plane's version late: a stale read, then UPDATING, then done", () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const fake = new FakeAws({ accountId: ACCOUNT, now: () => now });
    const main = fake.addCluster("main", "us-east-2", "API", "vpc-main");
    fake.addNodegroup("us-east-2", "main", "isolated", {
      minSize: 0,
      maxSize: 1,
      desiredSize: 0
    });
    main.version = "1.34";
    const update = [
      "eks",
      "update-nodegroup-version",
      ...MAIN,
      "--nodegroup-name",
      "isolated"
    ];
    const describe = [
      "eks",
      "describe-nodegroup",
      ...MAIN,
      "--nodegroup-name",
      "isolated"
    ];
    expect(isFakeAwsWrite(update)).toBe(true);
    const started = json(fake.run(update).stdout).update;
    expect(started).toMatchObject({
      type: "VersionUpdate",
      status: "InProgress"
    });
    const progress = [
      "eks",
      "describe-update",
      "--region",
      "us-east-2",
      "--name",
      "main",
      "--nodegroup-name",
      "isolated",
      "--update-id",
      started.id
    ];
    expect(json(fake.run(describe).stdout).nodegroup).toMatchObject({
      status: "ACTIVE",
      version: "1.33"
    });
    expect(json(fake.run(describe).stdout).nodegroup).toMatchObject({
      status: "UPDATING",
      version: "1.33"
    });
    expect(fake.run(update).stderr).toContain(
      "(ResourceInUseException) when calling the UpdateNodegroupVersion operation: Nodegroup isolated is in UPDATING state"
    );
    expect(json(fake.run(progress).stdout).update.status).toBe("InProgress");
    now += fake.nodegroupUpdateMs;
    expect(json(fake.run(progress).stdout).update.status).toBe("Successful");
    expect(json(fake.run(describe).stdout).nodegroup).toMatchObject({
      status: "ACTIVE",
      version: "1.34"
    });
    expect(fake.run([...progress.slice(0, -1), "UPD-other"]).stderr).toContain(
      "(ResourceNotFoundException) when calling the DescribeUpdate operation: No update found for ID: UPD-other"
    );
  });

  it("ends a node group update Failed, keeping the group as it was", () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const fake = new FakeAws({ accountId: ACCOUNT, now: () => now });
    fake.addCluster("main", "us-east-2", "API", "vpc-main");
    const group = fake.addNodegroup("us-east-2", "main", "isolated", {
      minSize: 0,
      maxSize: 1,
      desiredSize: 0
    });
    fake.nodegroupUpdateFailure = { errorCode: "Code", errorMessage: "No." };
    const { id } = json(
      fake.run([
        "eks",
        "update-nodegroup-config",
        ...MAIN,
        "--nodegroup-name",
        "isolated",
        "--scaling-config",
        "desiredSize=1"
      ]).stdout
    ).update;
    now += fake.nodegroupUpdateMs;
    expect(
      json(
        fake.run([
          "eks",
          "describe-update",
          "--region",
          "us-east-2",
          "--name",
          "main",
          "--nodegroup-name",
          "isolated",
          "--update-id",
          id
        ]).stdout
      ).update
    ).toMatchObject({
      status: "Failed",
      errors: [{ errorCode: "Code", errorMessage: "No.", resourceIds: [] }]
    });
    expect(group.desiredSize).toBe(0);
    expect(fake.nodegroupUpdateFailure).toBeNull();
  });

  it("names the API operation a refused or expired call was for", () => {
    const { fake } = cluster();
    fake.refuseOnce("rds describe-db-snapshots", "AccessDenied");
    expect(fake.run(["rds", "describe-db-snapshots"]).stderr).toContain(
      "when calling the DescribeDBSnapshots operation: Refused by the test."
    );
    fake.sessionExpired = true;
    expect(fake.run(["iam", "get-role", "--role-name", "x"]).stderr).toBe(
      "\nAn error occurred (ExpiredToken) when calling the GetRole operation: The security token included in the request is expired\n"
    );
  });

  it("refuses to roll a node group back to an earlier version", () => {
    const { fake, group } = cluster();
    const result = fake.run([
      "eks",
      "update-nodegroup-version",
      ...MAIN,
      "--nodegroup-name",
      "isolated",
      "--kubernetes-version",
      "1.32"
    ]);
    expect(result.stderr).toContain("(InvalidParameterException)");
    expect(group).toMatchObject({ version: "1.33", status: "ACTIVE" });
  });

  it("refuses a node group version newer than the control plane's", () => {
    const { fake, group } = cluster();
    const result = fake.run([
      "eks",
      "update-nodegroup-version",
      ...MAIN,
      "--nodegroup-name",
      "isolated",
      "--kubernetes-version",
      "1.34"
    ]);
    expect(result.stderr).toContain("(InvalidParameterException)");
    expect(group).toMatchObject({ version: "1.33", status: "ACTIVE" });
  });

  it("describes launch template versions by number, $Default, and $Latest", () => {
    const fake = new FakeAws({ accountId: ACCOUNT });
    fake.addLaunchTemplate("us-east-2", "lt-1", {
      "1": { SecurityGroupIds: ["sg-a"] },
      "2": { NetworkInterfaces: [{ Groups: ["sg-b"] }] }
    });
    const read = (...versions: string[]) =>
      fake.run([
        "ec2",
        "describe-launch-template-versions",
        "--region",
        "us-east-2",
        "--launch-template-id",
        "lt-1",
        ...(versions.length > 0 ? ["--versions", ...versions] : [])
      ]);
    expect(json(read("2").stdout).LaunchTemplateVersions).toEqual([
      {
        LaunchTemplateId: "lt-1",
        VersionNumber: 2,
        DefaultVersion: false,
        LaunchTemplateData: { NetworkInterfaces: [{ Groups: ["sg-b"] }] }
      }
    ]);
    expect(
      json(read("$Default", "$Latest").stdout).LaunchTemplateVersions.map(
        (item: { VersionNumber: number }) => item.VersionNumber
      )
    ).toEqual([1, 2]);
    expect(json(read().stdout).LaunchTemplateVersions).toHaveLength(2);
    expect(read("3").stderr).toContain(
      "(InvalidLaunchTemplateId.VersionNotFound)"
    );
    expect(
      fake.run([
        "ec2",
        "describe-launch-template-versions",
        "--region",
        "us-west-1",
        "--launch-template-id",
        "lt-1"
      ]).stderr
    ).toContain("(InvalidLaunchTemplateId.NotFound)");
  });
});
