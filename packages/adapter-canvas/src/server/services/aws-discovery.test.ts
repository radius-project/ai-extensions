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

const network = {
  "aws ec2 describe-vpcs": JSON.stringify({
    Vpcs: [{ VpcId: "vpc-1", Tags: [{ Key: "Name", Value: "main" }] }]
  }),
  "aws ec2 describe-subnets": JSON.stringify({
    Subnets: [
      { SubnetId: "subnet-a", VpcId: "vpc-1", AvailabilityZone: "us-west-2a" }
    ]
  }),
  "aws ec2 describe-route-tables": JSON.stringify({ RouteTables: [] })
};

describe("discoverAwsResources", () => {
  it("scopes every query to the profile's region and reads the single cluster's namespaces", async () => {
    const { calls, dependencies, removed } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": JSON.stringify({
        cluster: {
          resourcesVpcConfig: { vpcId: "vpc-1" },
          accessConfig: { authenticationMode: "API" }
        }
      }),
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
          usable: true
        }
      ],
      resourceGroups: [],
      namespaces: ["default", "shop-dev"],
      vpcs: [{ id: "vpc-1", name: "main (vpc-1)" }],
      subnets: [
        {
          id: "subnet-a",
          name: "",
          vpcId: "vpc-1",
          availabilityZone: "us-west-2a",
          public: false
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

  it("keeps default namespaces and reports each facet that fails", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": new Error("AccessDeniedException"),
      "aws ec2 describe-vpcs": new Error("UnauthorizedOperation"),
      "aws ec2 describe-subnets": new Error("UnauthorizedOperation"),
      "aws ec2 describe-route-tables": "{}"
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.clusters).toEqual([]);
    expect(result.namespaces).toEqual([
      "default",
      "kube-system",
      "radius-system"
    ]);
    expect(result.errors).toEqual({
      clusters: "AccessDeniedException",
      vpcs: "UnauthorizedOperation",
      subnets: "UnauthorizedOperation"
    });
  });

  it("still offers a cluster it cannot describe, and reports namespace failures", async () => {
    const { dependencies, removed } = fakes({
      "aws eks list-clusters": JSON.stringify(["a", "b", 3]),
      "aws eks describe-cluster": new Error("throttled"),
      "aws eks update-kubeconfig": new Error("no access"),
      ...network
    });
    const result = await discoverAwsResources(
      { region: "us-west-2", cluster: "a" },
      dependencies
    );
    expect(result.clusters.map((cluster) => cluster.id)).toEqual(["a", "b"]);
    expect(result.clusters[0]).toMatchObject({ usable: true });
    expect(result.errors?.namespaces).toBe("no access");
    expect(removed()).toBe(1);
  });

  it.each([
    [{ region: "" }, 'Invalid AWS region ""'],
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

  it("marks CONFIG_MAP and unconfigured clusters unusable", () => {
    expect(parseAwsCluster("c", { cluster: {} })).toEqual({
      id: "c",
      name: "c",
      vpcId: "",
      authenticationMode: "CONFIG_MAP",
      usable: false
    });
    expect(parseAwsCluster("c", null).usable).toBe(false);
  });
});

describe("discoverAwsResources edge cases", () => {
  it("treats empty CLI output as nothing found and keeps the default namespaces", async () => {
    const { dependencies } = fakes({
      "aws eks list-clusters": JSON.stringify(["shop"]),
      "aws eks describe-cluster --name shop": "",
      "aws eks update-kubeconfig": "",
      "kubectl --kubeconfig": "",
      "aws ec2 describe-vpcs": "",
      "aws ec2 describe-subnets": "",
      "aws ec2 describe-route-tables": ""
    });
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.vpcs).toEqual([]);
    expect(result.subnets).toEqual([]);
    expect(result.namespaces).toEqual([
      "default",
      "kube-system",
      "radius-system"
    ]);
  });

  it("reports a failure that is not an Error by its text", async () => {
    const { dependencies } = fakes({
      "aws ec2 describe-vpcs": "{}",
      "aws ec2 describe-subnets": "{}",
      "aws ec2 describe-route-tables": "{}"
    });
    const runCli = dependencies.runCli;
    dependencies.runCli = async (command, args, options) => {
      if (args[0] === "eks") throw "aws exited with 255";
      return runCli(command, args, options);
    };
    const result = await discoverAwsResources(
      { region: "us-west-2" },
      dependencies
    );
    expect(result.errors).toEqual({ clusters: "aws exited with 255" });
  });
});

describe("listAwsRoles", () => {
  it.each([
    ["no output", ""],
    ["no role list", JSON.stringify({ Roles: "none" })],
    ["a non-object answer", JSON.stringify(["role"])]
  ])("returns no roles for %s", async (_label, output) => {
    const { dependencies } = fakes({ "aws iam list-roles": output });
    expect(await listAwsRoles({}, dependencies)).toEqual([]);
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
    expect(await listAwsRoles({}, dependencies)).toEqual([
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
      await listAwsRoles({ accountId: "123456789012" }, dependencies)
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
  const tagged = (repo: string) =>
    JSON.stringify({
      Role: {
        Tags: [
          { Key: "Radius-Managed", Value: "true" },
          { Key: "radius-repository", Value: repo }
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
      [getRole("radius-deploy-octo-old")]: tagged("octo/old"),
      [getRole("zeta-ci")]: JSON.stringify({ Role: { Tags: [] } }),
      [getRole("radius-deploy-octo-shop")]: tagged("Octo/Shop"),
      [getRole("radius-deploy-octo-api")]: tagged("octo/api")
    });
    const roles = await listAwsRoles(
      { accountId: ACCOUNT, repo: "octo/shop" },
      dependencies
    );
    expect(roles.map((role) => role.name)).toEqual([
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
  });

  it("leaves out every Radius role when the repository is unknown", async () => {
    const { dependencies } = fakes({
      "aws iam list-roles": JSON.stringify({
        Roles: [githubRole("radius-deploy-octo-api", ["repo:octo/api:x"])]
      }),
      [getRole("radius-deploy-octo-api")]: tagged("octo/api")
    });
    expect(await listAwsRoles({ accountId: ACCOUNT }, dependencies)).toEqual(
      []
    );
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
      ).toEqual([]);
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
    expect((await listing).map((role) => role.name)).toEqual(names);
    expect(peak).toBe(4);
  });
});
