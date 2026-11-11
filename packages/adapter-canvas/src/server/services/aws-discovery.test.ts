import { describe, expect, it } from "vitest";
import { buildGitHubTrustPolicy } from "@radius-project/core";
import {
  discoverAwsResources,
  listAwsRoles,
  parseAwsCluster
} from "./aws-discovery.js";
import type { DiscoveryDependencies } from "./discovery.js";

type Answer = string | Error;

function fakes(answers: Record<string, Answer>) {
  const calls: string[] = [];
  let removed = 0;
  const dependencies: DiscoveryDependencies = {
    async runCli(command, args) {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const key = Object.keys(answers).find((prefix) =>
        line.startsWith(prefix)
      );
      if (key === undefined) throw new Error(`unexpected ${line}`);
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    isUuid: () => true,
    createTemporaryKubeconfig: () => ({
      path: "/tmp/radius-kubeconfig",
      remove: () => {
        removed += 1;
      }
    })
  };
  return { calls, dependencies, removed: () => removed };
}

function cluster(
  vpcId: string,
  status = "ACTIVE",
  authenticationMode = "API"
): string {
  return JSON.stringify({
    cluster: {
      status,
      resourcesVpcConfig: { vpcId },
      accessConfig: { authenticationMode }
    }
  });
}

const SESSION_ENDED =
  "Error when retrieving token from sso: Token has expired and refresh failed";
const network = {
  "aws ec2 describe-vpcs": JSON.stringify({
    Vpcs: [{ VpcId: "vpc-1", Tags: [{ Key: "Name", Value: "main" }] }]
  }),
  "aws ec2 describe-subnets": JSON.stringify({
    Subnets: [
      { SubnetId: "subnet-a", VpcId: "vpc-1", AvailabilityZone: "us-west-2a" },
      {
        SubnetId: "subnet-l",
        VpcId: "vpc-1",
        AvailabilityZone: "us-west-2-lax-1a"
      }
    ]
  }),
  "aws ec2 describe-route-tables": JSON.stringify({
    RouteTables: [
      {
        VpcId: "vpc-1",
        Associations: [{ Main: true }],
        Routes: [{ GatewayId: "local", State: "active" }]
      }
    ]
  }),
  "aws ec2 describe-availability-zones": JSON.stringify({
    AvailabilityZones: [
      { ZoneName: "us-west-2a", ZoneType: "availability-zone" },
      { ZoneName: "us-west-2-lax-1a", ZoneType: "local-zone" }
    ]
  })
};
const SUBNET_A = {
  id: "subnet-a",
  name: "",
  vpcId: "vpc-1",
  availabilityZone: "us-west-2a",
  routing: "private",
  zoneKind: "standard"
};

describe("discoverAwsResources", () => {
  it("scopes every query to the profile's region and reads the single cluster's namespaces", async () => {
    const { calls, dependencies, removed } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": cluster("vpc-1"),
      "aws eks update-kubeconfig": "",
      "kubectl --kubeconfig": "default shop-dev",
      ...network
    });
    const result = await discoverAwsResources(
      { accountId: "123456789012", region: "us-west-2" },
      dependencies
    );
    expect(result).toEqual({
      clusters: [
        {
          id: "shop",
          name: "shop",
          vpcId: "vpc-1",
          authenticationMode: "API",
          status: "ACTIVE",
          usable: true
        }
      ],
      resourceGroups: [],
      namespaces: ["default", "shop-dev"],
      vpcs: [{ id: "vpc-1", name: "main (vpc-1)" }],
      subnets: [
        SUBNET_A,
        {
          id: "subnet-l",
          name: "",
          vpcId: "vpc-1",
          availabilityZone: "us-west-2-lax-1a",
          routing: "private",
          zoneKind: "local-zone"
        }
      ]
    });
    expect(
      calls
        .filter((line) => line.startsWith("aws "))
        .every((line) => line.includes("--region us-west-2"))
    ).toBe(true);
    expect(removed()).toBe(1);
  });

  it("makes no EC2 call when the region has no clusters", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": "[]"
    });
    const result = await discoverAwsResources(
      { region: "us-east-1" },
      dependencies
    );
    expect(result).toEqual({
      clusters: [],
      resourceGroups: [],
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    });
    expect(calls).toEqual([
      "aws eks list-clusters --query clusters --region us-east-1 --output json"
    ]);
  });

  it("reads only the usable clusters' VPCs and their subnets", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["a", "b", "legacy", 3]),
      "aws eks describe-cluster --name a": cluster("vpc-1"),
      "aws eks describe-cluster --name b": cluster("vpc-2", "UPDATING"),
      "aws eks describe-cluster --name legacy": cluster(
        "vpc-3",
        "ACTIVE",
        "CONFIG_MAP"
      ),
      ...network
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.clusters.map((item) => [item.name, item.usable])).toEqual([
      ["a", true],
      ["b", true],
      ["legacy", false]
    ]);
    expect(calls.filter((line) => line.startsWith("aws ec2 "))).toEqual([
      "aws ec2 describe-vpcs --vpc-ids vpc-1 vpc-2 --region us-west-2 --output json",
      "aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-1,vpc-2 --region us-west-2 --output json",
      "aws ec2 describe-route-tables --filters Name=vpc-id,Values=vpc-1,vpc-2 --region us-west-2 --output json",
      "aws ec2 describe-availability-zones --region us-west-2 --output json"
    ]);
    // Two usable clusters: the browser picks one, so no namespace read runs.
    expect(calls.some((line) => line.includes("update-kubeconfig"))).toBe(
      false
    );
  });

  it("reads namespaces for a requested cluster that is usable", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["a", "b"]),
      "aws eks describe-cluster --name a": cluster("vpc-1"),
      "aws eks describe-cluster --name b": cluster("vpc-1"),
      "aws eks update-kubeconfig --name b": "",
      "kubectl --kubeconfig": "default b-dev",
      ...network
    });
    const result = await discoverAwsResources(
      { region: "us-west-2", cluster: "b" },
      dependencies
    );
    expect(result.namespaces).toEqual(["default", "b-dev"]);
    expect(calls.filter((line) => line.includes("--vpc-ids"))).toEqual([
      "aws ec2 describe-vpcs --vpc-ids vpc-1 --region us-west-2 --output json"
    ]);
  });

  it("marks a cluster it cannot describe as not described, with the error kind", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["locked", "shop"]),
      "aws eks describe-cluster --name locked": new Error(
        "An error occurred (AccessDeniedException) when calling the DescribeCluster operation"
      ),
      "aws eks describe-cluster --name shop": cluster(
        "vpc-1",
        "DELETING",
        "CONFIG_MAP"
      )
    });
    const result = await discoverAwsResources(
      { region: "us-west-2", cluster: "locked" },
      dependencies
    );
    expect(result.clusters).toEqual([
      {
        id: "locked",
        name: "locked",
        vpcId: "",
        authenticationMode: "",
        status: "",
        usable: false,
        unusableReason: "not-described",
        describeErrorKind: "denied"
      },
      {
        id: "shop",
        name: "shop",
        vpcId: "vpc-1",
        authenticationMode: "CONFIG_MAP",
        status: "DELETING",
        usable: false,
        unusableReason: "status"
      }
    ]);
    expect(result.remediation).toBeUndefined();
    // No usable cluster: no EC2 read, and no namespace read for the
    // requested cluster that is not usable.
    expect(calls.map((line) => line.split(" ").slice(0, 3).join(" "))).toEqual([
      "aws eks list-clusters",
      "aws eks describe-cluster",
      "aws eks describe-cluster"
    ]);
  });

  it("keeps listing subnets when the route-table, VPC, and zone reads fail", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": cluster("vpc-1"),
      "aws eks update-kubeconfig": "",
      "kubectl --kubeconfig": "",
      "aws ec2 describe-vpcs": new Error(
        "An error occurred (UnauthorizedOperation) when calling the DescribeVpcs operation"
      ),
      "aws ec2 describe-subnets": network["aws ec2 describe-subnets"],
      "aws ec2 describe-route-tables": new Error(
        "An error occurred (UnauthorizedOperation) when calling the DescribeRouteTables operation"
      ),
      "aws ec2 describe-availability-zones": new Error("Read timeout")
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.vpcs).toEqual([]);
    expect(result.subnets).toEqual([
      { ...SUBNET_A, routing: "unknown" },
      {
        id: "subnet-l",
        name: "",
        vpcId: "vpc-1",
        availabilityZone: "us-west-2-lax-1a",
        routing: "unknown",
        zoneKind: "local-zone"
      }
    ]);
    expect(result.errorKinds).toEqual({
      vpcs: "denied",
      routeTables: "denied",
      zones: "other"
    });
    expect(Object.keys(result.errors || {})).toEqual([
      "vpcs",
      "routeTables",
      "zones"
    ]);
    expect(result.remediation).toBeUndefined();
  });

  it("reports a subnet failure and still reads namespaces", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": cluster("vpc-1"),
      "aws eks update-kubeconfig": new Error("no access"),
      ...network,
      "aws ec2 describe-subnets": new Error(SESSION_ENDED)
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.subnets).toEqual([]);
    expect(result.vpcs).toEqual([{ id: "vpc-1", name: "main (vpc-1)" }]);
    expect(result.errorKinds).toEqual({
      subnets: "credentials",
      namespaces: "other"
    });
    expect(result.errors?.namespaces).toBe("no access");
    expect(result.remediation).toMatchObject({
      id: "aws-cli-login",
      params: { nextStep: "refresh-discovery" }
    });
  });

  it("offers sign-in and makes no other call when the cluster list needs a session", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": new Error(
        'Unable to locate credentials. You can configure credentials by running "aws configure".'
      )
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(calls).toHaveLength(1);
    expect(result.errorKinds).toEqual({ clusters: "credentials" });
    expect(result.remediation).toMatchObject({
      id: "aws-cli-login",
      params: { nextStep: "refresh-discovery" }
    });
  });

  it("offers sign-in when the session ends while describing a cluster", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": new Error(SESSION_ENDED)
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.errorKinds).toBeUndefined();
    expect(result.clusters[0]).toMatchObject({
      unusableReason: "not-described",
      describeErrorKind: "credentials"
    });
    expect(result.remediation).toMatchObject({
      id: "aws-cli-login",
      params: { nextStep: "refresh-discovery" }
    });
  });

  it.each([
    [
      "rejected",
      "An error occurred (UnrecognizedClientException) when calling the ListClusters operation: The security token included in the request is invalid."
    ],
    [
      "other",
      "Error when retrieving credentials from custom-process: Token has expired"
    ]
  ])("offers no sign-in for a %s cluster-list error", async (kind, message) => {
    const { dependencies } = fakes({
      "aws eks list-clusters": new Error(message)
    });
    const result = await discoverAwsResources(
      { region: "af-south-1" },
      dependencies
    );
    expect(result.errorKinds).toEqual({ clusters: kind });
    expect(result.errors).toEqual({ clusters: message });
    expect(result.remediation).toBeUndefined();
  });

  it.each([
    [{ region: "" }, 'Invalid AWS region ""'],
    [{}, 'Invalid AWS region ""'],
    [{ region: "us-west-2", cluster: "bad name!" }, "Invalid EKS cluster name."]
  ])(
    "rejects invalid input %j before running anything",
    async (data, error) => {
      const { calls, dependencies } = fakes({});
      const result = await discoverAwsResources(data, dependencies);
      expect(result).toMatchObject({ error: expect.stringContaining(error) });
      expect(calls).toEqual([]);
    }
  );
});

describe("parseAwsCluster", () => {
  it.each([
    ["ACTIVE", "API", true, undefined],
    ["UPDATING", "API_AND_CONFIG_MAP", true, undefined],
    ["ACTIVE", "CONFIG_MAP", false, "config-map"],
    ["CREATING", "API", false, "status"],
    // A status reason outranks a CONFIG_MAP reason.
    ["DELETING", "CONFIG_MAP", false, "status"]
  ])(
    "a %s cluster with %s authentication: usable %s, reason %s",
    (status, mode, usable, reason) => {
      const item = parseAwsCluster(
        "c",
        JSON.parse(cluster("vpc-1", status, mode))
      );
      expect(item.usable).toBe(usable);
      expect(item.unusableReason).toBe(reason);
      expect(item.status).toBe(status);
    }
  );

  it.each([
    ["no answer", null],
    ["no cluster", {}],
    ["no status", { cluster: { accessConfig: { authenticationMode: "API" } } }]
  ])("treats an answer with %s as not described", (_label, output) => {
    expect(parseAwsCluster("c", output)).toEqual({
      id: "c",
      name: "c",
      vpcId: "",
      authenticationMode: "",
      status: "",
      usable: false,
      unusableReason: "not-described",
      describeErrorKind: "other"
    });
  });

  it("defaults a described cluster without an access config to CONFIG_MAP", () => {
    expect(parseAwsCluster("c", { cluster: { status: "ACTIVE" } })).toEqual({
      id: "c",
      name: "c",
      vpcId: "",
      authenticationMode: "CONFIG_MAP",
      status: "ACTIVE",
      usable: false,
      unusableReason: "config-map"
    });
  });
});

describe("discoverAwsResources edge cases", () => {
  it("treats empty CLI output as nothing found and keeps the default namespace", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": cluster("vpc-1"),
      "aws eks update-kubeconfig": "",
      "kubectl --kubeconfig": "",
      "aws ec2 describe-vpcs": "",
      "aws ec2 describe-subnets": "",
      "aws ec2 describe-route-tables": "",
      "aws ec2 describe-availability-zones": ""
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.vpcs).toEqual([]);
    expect(result.subnets).toEqual([]);
    expect(result.namespaces).toEqual(["default"]);
    expect(result.errors).toBeUndefined();
  });

  it("treats a cluster list that is not an array as no clusters", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": ""
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.clusters).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("skips the network reads when the usable cluster reports no VPC", async () => {
    const { calls, dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": JSON.stringify({
        cluster: {
          status: "ACTIVE",
          accessConfig: { authenticationMode: "API" }
        }
      }),
      "aws eks update-kubeconfig": "",
      "kubectl --kubeconfig": "default"
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.namespaces).toEqual(["default"]);
    expect(calls.some((line) => line.startsWith("aws ec2 "))).toBe(false);
  });

  it("reports a failure that is not an Error by its text", async () => {
    const { dependencies } = fakes({});
    dependencies.runCli = async () => {
      throw "aws exited with 255";
    };
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.errors).toEqual({ clusters: "aws exited with 255" });
    expect(result.errorKinds).toEqual({ clusters: "other" });
  });

  it("classifies a describe failure that is not an Error by its text", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"])
    });
    const runCli = dependencies.runCli;
    dependencies.runCli = async (command, args, options) => {
      if (args[1] === "describe-cluster") throw "ExpiredToken";
      return runCli(command, args, options);
    };
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.clusters[0].describeErrorKind).toBe("credentials");
  });

  it("cuts long error text to 800 characters", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": new Error("x".repeat(900))
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.errors?.clusters).toHaveLength(800);
  });
});

describe("listAwsRoles", () => {
  it.each([
    ["no output", ""],
    ["no role list", JSON.stringify({ Roles: "none" })],
    ["a non-object answer", JSON.stringify(["role"])]
  ])("returns no roles for %s", async (_label, output) => {
    const { dependencies } = fakes({ "aws iam list-roles": output });
    expect(await listAwsRoles({}, dependencies)).toEqual({ roles: [] });
  });

  it("skips malformed role entries", async () => {
    const { dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [
          "role",
          { Arn: "arn:aws:iam::123456789012:role/nameless" },
          { RoleName: "arnless" },
          {
            RoleName: "deploy",
            Arn: "arn:aws:iam::123456789012:role/deploy"
          }
        ]
      })
    });
    expect((await listAwsRoles({}, dependencies)).roles).toEqual([
      {
        arn: "arn:aws:iam::123456789012:role/deploy",
        name: "deploy",
        trustedSubjects: []
      }
    ]);
  });

  it("lists assumable roles with the GitHub subjects they trust", async () => {
    const { dependencies } = fakes({
      "aws iam get-role --role-name zeta --output json": JSON.stringify({
        Role: { RoleName: "zeta" }
      }),
      "aws iam list-roles": JSON.stringify({
        Roles: [
          {
            RoleName: "zeta",
            Arn: "arn:aws:iam::123456789012:role/zeta",
            Path: "/",
            AssumeRolePolicyDocument: encodeURIComponent(
              JSON.stringify({
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: {
                      Federated:
                        "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
                    },
                    Action: "sts:AssumeRoleWithWebIdentity",
                    Condition: {
                      StringEquals: {
                        "token.actions.githubusercontent.com:sub":
                          "repo:octo/other:environment:dev"
                      }
                    }
                  }
                ]
              })
            )
          },
          {
            RoleName: "alpha",
            Arn: "arn:aws:iam::123456789012:role/alpha",
            AssumeRolePolicyDocument: "not json"
          },
          {
            RoleName: "AWSServiceRoleForEKS",
            Arn: "arn:aws:iam::123456789012:role/aws-service-role/eks/x",
            Path: "/aws-service-role/eks.amazonaws.com/"
          },
          { RoleName: "no-arn" },
          "junk"
        ]
      })
    });
    expect(
      (await listAwsRoles({ accountId: "123456789012" }, dependencies)).roles
    ).toEqual([
      {
        arn: "arn:aws:iam::123456789012:role/zeta",
        name: "zeta",
        trustedSubjects: ["repo:octo/other:environment:dev"]
      },
      {
        arn: "arn:aws:iam::123456789012:role/alpha",
        name: "alpha",
        trustedSubjects: []
      }
    ]);
  });

  it("propagates a listing failure", async () => {
    const { dependencies } = fakes({
      "aws iam list-roles": new Error("AccessDenied")
    });
    await expect(listAwsRoles({}, dependencies)).rejects.toThrow(
      "AccessDenied"
    );
  });
});

describe("listAwsRoles exclusions", () => {
  const ACCOUNT = "123456789012";
  const PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
  const roleArn = (name: string, account = ACCOUNT) =>
    `arn:aws:iam::${account}:role/${name}`;
  const githubRole = (name: string, subjects: string[]) => ({
    RoleName: name,
    Arn: roleArn(name),
    AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects)
  });
  const getRole = (name: string) =>
    `aws iam get-role --role-name ${name} --output json`;
  // octo/shop's GitHub ID is 22.
  const READ_REPO_ID = "gh api /repos/octo/shop --jq .id";
  const tagged = (repo: string, id: number | null) =>
    JSON.stringify({
      Role: {
        Tags: [
          { Key: "Radius-Managed", Value: "true" },
          { Key: "radius-repository", Value: repo },
          ...(id === null ?
            []
          : [{ Key: "radius-repository-id", Value: String(id) }])
        ]
      }
    });

  it("reads tags only for GitHub roles, leaves out another repository's, and lists GitHub roles first", async () => {
    const { calls, dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [
          {
            RoleName: "app-runtime",
            Arn: roleArn("app-runtime"),
            AssumeRolePolicyDocument: {
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole"
                }
              ]
            }
          },
          {
            RoleName: "radius-deploy-octo-old",
            Arn: roleArn("radius-deploy-octo-old"),
            AssumeRolePolicyDocument: {
              Statement: [
                {
                  Effect: "Deny",
                  Principal: { Federated: PROVIDER },
                  Action: "sts:AssumeRoleWithWebIdentity"
                }
              ]
            }
          },
          githubRole("zeta-ci", ["repo:octo/shop:environment:ci"]),
          githubRole("radius-deploy-octo-shop", [
            "repo:octo/shop:environment:dev"
          ]),
          githubRole("radius-deploy-octo-api", [
            "repo:octo/api:environment:dev"
          ])
        ]
      }),
      [getRole("radius-deploy-octo-old")]: tagged("octo/old", 33),
      [getRole("zeta-ci")]: JSON.stringify({ Role: { Tags: [] } }),
      [getRole("radius-deploy-octo-shop")]: tagged("octo/old-shop", 22),
      [getRole("radius-deploy-octo-api")]: tagged("octo/api", 44),
      [READ_REPO_ID]: "22\n"
    });
    const list = await listAwsRoles(
      { accountId: ACCOUNT, repo: "octo/shop" },
      dependencies
    );
    expect(list.hiddenReason).toBeUndefined();
    expect(list.roles.map((role) => role.name)).toEqual([
      "radius-deploy-octo-shop",
      "zeta-ci",
      "app-runtime"
    ]);
    expect(calls.filter((line) => line.includes("get-role"))).toEqual([
      getRole("radius-deploy-octo-old"),
      getRole("zeta-ci"),
      getRole("radius-deploy-octo-shop"),
      getRole("radius-deploy-octo-api")
    ]);
    expect(calls.filter((line) => line === READ_REPO_ID)).toHaveLength(1);
  });

  it("leaves out a role tagged with this repository's name but another repository's ID", async () => {
    // A repository created at the old name of a renamed one.
    const { dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [githubRole("radius-deploy-octo-shop", ["repo:octo/shop:x"])]
      }),
      [getRole("radius-deploy-octo-shop")]: tagged("octo/shop", 99),
      [READ_REPO_ID]: "22"
    });
    expect(
      await listAwsRoles(
        { accountId: ACCOUNT, repo: "octo/shop" },
        dependencies
      )
    ).toEqual({ roles: [] });
  });

  it("lists a role an earlier build tagged only by name, without reading GitHub", async () => {
    const { calls, dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [githubRole("radius-deploy-octo-api", ["repo:octo/api:x"])]
      }),
      [getRole("radius-deploy-octo-api")]: tagged("octo/api", null)
    });
    const list = await listAwsRoles(
      { accountId: ACCOUNT, repo: "octo/shop" },
      dependencies
    );
    expect(list.roles.map((role) => role.name)).toEqual([
      "radius-deploy-octo-api"
    ]);
    expect(list.hiddenReason).toBeUndefined();
    expect(calls.some((line) => line.startsWith("gh "))).toBe(false);
  });

  it("leaves out every role Radius tagged with a repository ID when the repository is unknown", async () => {
    const { calls, dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [githubRole("radius-deploy-octo-api", ["repo:octo/api:x"])]
      }),
      [getRole("radius-deploy-octo-api")]: tagged("octo/api", 44)
    });
    expect(await listAwsRoles({ accountId: ACCOUNT }, dependencies)).toEqual({
      roles: [],
      hiddenReason:
        "Radius left out 1 role it created, because GitHub didn't return the ID of this repository (\"\" is not an owner/name repository), so it can't tell which repository it belongs to. Check that the default GitHub CLI account can read the repository and try again, or type the role name."
    });
    expect(calls.some((line) => line.startsWith("gh "))).toBe(false);
  });

  it.each([
    ["GitHub fails", new Error("HTTP 404: Not Found"), "HTTP 404: Not Found"],
    ["GitHub fails with a non-Error", "throw", "offline"],
    ["GitHub returns no ID", "null", "GitHub returned no repository ID"],
    ["GitHub returns zero", "0", "GitHub returned no repository ID"],
    [
      "GitHub returns an unsafe ID",
      "9007199254740992",
      "GitHub returned no repository ID"
    ]
  ])(
    "leaves out only the roles Radius tagged, and says why, when %s",
    async (_label, answer, reason) => {
      const { calls, dependencies } = fakes({
        "aws iam list-roles": JSON.stringify({
          Roles: [
            githubRole("radius-deploy-octo-shop", ["repo:octo/shop:x"]),
            githubRole("radius-deploy-octo-api", ["repo:octo/api:x"]),
            githubRole("zeta-ci", ["repo:octo/shop:ci"])
          ]
        }),
        [getRole("radius-deploy-octo-shop")]: tagged("octo/shop", 22),
        [getRole("radius-deploy-octo-api")]: tagged("octo/api", 44),
        [getRole("zeta-ci")]: JSON.stringify({ Role: { Tags: [] } }),
        [READ_REPO_ID]: answer
      });
      if (answer === "throw") {
        const runCli = dependencies.runCli;
        dependencies.runCli = async (command, args, options) => {
          const out = await runCli(command, args, options);
          if (command === "gh") throw "offline";
          return out;
        };
      }
      const list = await listAwsRoles(
        { accountId: ACCOUNT, repo: "octo/shop" },
        dependencies
      );
      expect(list.roles.map((role) => role.name)).toEqual(["zeta-ci"]);
      expect(list.hiddenReason).toBe(
        `Radius left out 2 roles it created, because GitHub didn't return the ID of octo/shop (${reason}), so it can't tell which repository they belong to. Check that the default GitHub CLI account can read the repository and try again, or type the role name.`
      );
      expect(calls.filter((line) => line === READ_REPO_ID)).toHaveLength(1);
    }
  );

  it("leaves out the roles Radius tagged, without asking GitHub, for a repository that isn't owner/name", async () => {
    const { calls, dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [githubRole("deploy", ["repo:octo/shop:x"])]
      }),
      [getRole("deploy")]: tagged("octo/shop", 22)
    });
    const list = await listAwsRoles(
      { accountId: ACCOUNT, repo: "octo/shop/../../user" },
      dependencies
    );
    expect(list.roles).toEqual([]);
    expect(list.hiddenReason).toContain(
      '"octo/shop/../../user" is not an owner/name repository'
    );
    expect(calls.some((line) => line.startsWith("gh "))).toBe(false);
  });

  it.each([
    ["an AWS error", new Error("AccessDenied"), "AccessDenied"],
    ["unreadable JSON", "{", SyntaxError],
    ["a non-object answer", "[]", "get-role returned no role for deploy."],
    ["no role", '{"Role":null}', "get-role returned no role for deploy."]
  ])(
    "fails the listing when %s hides a GitHub role's tags",
    async (_label, answer, error) => {
      const { dependencies } = fakes({
        "aws iam list-roles": JSON.stringify({
          Roles: [githubRole("deploy", ["repo:octo/shop:x"])]
        }),
        [getRole("deploy")]: answer
      });
      await expect(
        listAwsRoles({ accountId: ACCOUNT, repo: "octo/shop" }, dependencies)
      ).rejects.toThrow(error);
    }
  );

  it.each([
    ["another account", roleArn("deploy", "999988887777")],
    ["an ARN that is not a role ARN", "arn:aws:iam::123456789012:user/deploy"]
  ])(
    "leaves out a role in %s without reading its tags",
    async (_label, arn) => {
      const { calls, dependencies } = fakes({
        "aws iam list-roles": JSON.stringify({
          Roles: [{ ...githubRole("deploy", ["repo:octo/shop:x"]), Arn: arn }]
        })
      });
      expect(
        await listAwsRoles(
          { accountId: ACCOUNT, repo: "octo/shop" },
          dependencies
        )
      ).toEqual({ roles: [] });
      expect(calls).toEqual(["aws iam list-roles --output json"]);
    }
  );

  it("reads at most four roles' tags at once", async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fourStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fourStarted = resolve;
    });
    const names = ["a", "b", "c", "d", "e", "f"];
    const listing = listAwsRoles(
      { accountId: ACCOUNT, repo: "octo/shop" },
      {
        ...fakes({}).dependencies,
        async runCli(_command, args) {
          if (args[1] === "list-roles") {
            return JSON.stringify({
              Roles: names.map((name) => githubRole(name, ["repo:o/r:x"]))
            });
          }
          running += 1;
          peak = Math.max(peak, running);
          if (running === 4) fourStarted();
          await gate;
          running -= 1;
          return JSON.stringify({ Role: {} });
        }
      }
    );
    await started;
    release();
    expect((await listing).roles.map((role) => role.name)).toEqual(names);
    expect(peak).toBe(4);
  });
});
