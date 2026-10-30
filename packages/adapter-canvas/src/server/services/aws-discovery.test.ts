import { describe, expect, it } from "vitest";
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
        arn: "arn:aws:iam::123456789012:role/alpha",
        name: "alpha",
        trustedSubjects: []
      },
      {
        arn: "arn:aws:iam::123456789012:role/zeta",
        name: "zeta",
        trustedSubjects: ["repo:octo/other:environment:dev"]
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
