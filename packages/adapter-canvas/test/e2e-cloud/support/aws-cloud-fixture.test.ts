import { describe, expect, it } from "vitest";
import {
  buildAwsLockPolicyDocument,
  buildAwsLockPolicyName,
  stateRegistryForEnvironment
} from "@radius-project/core";
import { awsAppBoundary } from "../../../src/aws-deploy-role-name.js";
import {
  ACCOUNT,
  databaseName,
  deployRoleTrust,
  MAIN,
  MAIN_VPC,
  recipeTags,
  REPO,
  REPO_ID,
  ROLE,
  ROLE_ARN,
  SECOND
} from "../../support/aws/cleanup-scenario.js";
import { FakeKubernetes } from "../../support/aws/fake-kubernetes.js";
import {
  addLiveEnvironment,
  awsWrites,
  BOUNDARY_ARN,
  CLUSTERS,
  createJourneyWorld,
  ISOLATED_TEMPLATE,
  liveEnvironment,
  type JourneyWorld
} from "../../support/aws/journey-scenario.js";
import {
  collectAwsPreflightFindings,
  createAwsCloudFixture,
  type AwsCloudFixtureOptions,
  type AwsPreflightConfig
} from "./aws-cloud-fixture.js";
import {
  createFakeFixturePorts,
  type FakeCommandStub
} from "./fake-cloud-commands.js";
import {
  FIXTURE_AWS_BASELINE_SHA,
  FIXTURE_BASELINE_SHA
} from "./fixture-repository.js";

const MAIN_LABEL = `${MAIN.name} (${MAIN.region})`;
const SECOND_LABEL = `${SECOND.name} (${SECOND.region})`;
const TEST_ROLE = `arn:aws:iam::${ACCOUNT}:role/ai-extensions-cloud-e2e`;
const CLEANUP =
  "Run the Cloud E2E cleanup workflow (cloud-e2e-cleanup.yml), which removes what an earlier run left.";
const RUNBOOK = "the AWS one-time setup in docs/eng/CLOUD_E2E_RUNBOOK.md";
const NAMESPACE = "default-cloud-e2e";
const CONFIG: AwsPreflightConfig = {
  accountId: ACCOUNT,
  repository: REPO,
  repositoryId: REPO_ID,
  deployRoleName: ROLE,
  clusters: [MAIN, SECOND],
  application: "cloud-e2e",
  namespace: NAMESPACE,
  environmentPrefix: "radtest-aws-"
};

interface World extends JourneyWorld {
  readonly kube: FakeKubernetes;
  readonly events: string[];
  readonly aws: JourneyWorld["aws"];
  readonly preflightPorts: AwsCloudFixtureOptions["aws"];
}

function world(): World {
  const base = createJourneyWorld();
  const kube = new FakeKubernetes();
  for (const cluster of CLUSTERS)
    kube.addCluster(`${cluster.region}/${cluster.name}`);
  const events: string[] = [];
  const key = (cluster: { region: string; name: string }) =>
    `${cluster.region}/${cluster.name}`;
  return {
    ...base,
    kube,
    events,
    preflightPorts: {
      ...base.ports,
      runAws: (args) => {
        events.push(`aws ${args.slice(0, 2).join(" ")}`);
        return base.ports.runAws(args);
      },
      log: () => {},
      kubernetes: {
        listWorkloads: async (cluster) => kube.list(key(cluster)),
        namespaceExists: async (cluster, namespace) =>
          kube.namespaceExists(key(cluster), namespace),
        listNodes: async (cluster, selector) => {
          const pool = selector.split("=")[1] ?? "";
          const count =
            base.aws.clusters
              .get(`${cluster.region}:${cluster.name}`)
              ?.nodegroups.get(pool)?.desiredSize ?? 0;
          return {
            items: Array.from({ length: count }, () => ({
              status: { conditions: [{ type: "Ready", status: "True" }] }
            }))
          };
        }
      }
    }
  };
}

function findings(w: World) {
  return collectAwsPreflightFindings(CONFIG, w.preflightPorts);
}

function main(w: World) {
  const cluster = w.aws.clusters.get(`${MAIN.region}:${MAIN.name}`);
  if (!cluster) throw new Error("No main cluster");
  return cluster;
}

function second(w: World) {
  const cluster = w.aws.clusters.get(`${SECOND.region}:${SECOND.name}`);
  if (!cluster) throw new Error("No second cluster");
  return cluster;
}

function group(w: World, name: string) {
  const found = main(w).nodegroups.get(name);
  if (!found) throw new Error(`No node group ${name}`);
  return found;
}

function deployRole(w: World) {
  const role = w.aws.role(ROLE);
  if (!role) throw new Error("No deploy role");
  return role;
}

describe("collectAwsPreflightFindings", () => {
  it("finds nothing in the account setup leaves, and writes nothing", async () => {
    const w = world();
    expect(await findings(w)).toEqual([]);
    expect(awsWrites(w)).toEqual([]);
  });

  it("stops at the account when AWS is signed in elsewhere", async () => {
    const w = world();
    const result = await collectAwsPreflightFindings(
      { ...CONFIG, accountId: "999999999999" },
      w.preflightPorts
    );
    expect(result).toEqual([
      `AWS is signed in to account ${ACCOUNT}, not 999999999999, the test role's account. Sign in to the role AIEXT_CLOUD_E2E_AWS_ROLE_ARN names.`
    ]);
    expect(w.events).toEqual(["aws sts get-caller-identity"]);
  });

  it.each<[string, (w: World) => void, string[]]>([
    [
      "a cluster that isn't ACTIVE",
      (w) => {
        second(w).status = "UPDATING";
      },
      [
        `Cluster ${SECOND_LABEL} is UPDATING, not ACTIVE. Retry when it is ACTIVE.`
      ]
    ],
    [
      "a cluster without API authentication",
      (w) => {
        main(w).authenticationMode = "API_AND_CONFIG_MAP";
      },
      [
        `Cluster ${MAIN_LABEL} uses authentication mode API_AND_CONFIG_MAP, not API. Switch it: aws eks update-cluster-config --name ${MAIN.name} --region ${MAIN.region} --access-config authenticationMode=API`
      ]
    ],
    [
      "a cluster without a public endpoint",
      (w) => {
        second(w).endpointPublicAccess = false;
      },
      [
        `Cluster ${SECOND_LABEL} has no public API endpoint, so GitHub-hosted runners can't reach it. Turn it on: aws eks update-cluster-config --name ${SECOND.name} --region ${SECOND.region} --resources-vpc-config endpointPublicAccess=true`
      ]
    ],
    [
      "a cluster on extended support",
      (w) => {
        second(w).supportType = "EXTENDED";
      },
      [
        `Cluster ${SECOND_LABEL} has upgrade policy EXTENDED, not STANDARD, so it would move to extended support, which costs six times as much. Set it: aws eks update-cluster-config --name ${SECOND.name} --region ${SECOND.region} --upgrade-policy supportType=STANDARD`
      ]
    ],
    [
      "a cluster with no upgrade policy",
      (w) => {
        main(w).supportType = "";
      },
      [
        `Cluster ${MAIN_LABEL} has upgrade policy (none), not STANDARD, so it would move to extended support, which costs six times as much. Set it: aws eks update-cluster-config --name ${MAIN.name} --region ${MAIN.region} --upgrade-policy supportType=STANDARD`
      ]
    ],
    [
      "a cluster without the Pod Identity add-on",
      (w) => {
        second(w).podIdentityAgent = null;
      },
      [
        `Cluster ${SECOND_LABEL} doesn't have the eks-pod-identity-agent add-on, which gives app containers their AWS permissions. Install it: aws eks create-addon --cluster-name ${SECOND.name} --addon-name eks-pod-identity-agent --region ${SECOND.region}`
      ]
    ],
    [
      "a degraded Pod Identity add-on",
      (w) => {
        main(w).podIdentityAgent = "DEGRADED";
      },
      [
        `The eks-pod-identity-agent add-on on cluster ${MAIN_LABEL} is DEGRADED, not ACTIVE or UPDATING. Fix it in the EKS console, then retry.`
      ]
    ],
    [
      "a Pod Identity add-on with no status",
      (w) => {
        main(w).podIdentityAgent = "";
      },
      [
        `The eks-pod-identity-agent add-on on cluster ${MAIN_LABEL} is in an unknown state, not ACTIVE or UPDATING. Fix it in the EKS console, then retry.`
      ]
    ],
    [
      "a Pod Identity add-on that is updating, which the product accepts",
      (w) => {
        main(w).podIdentityAgent = "UPDATING";
      },
      []
    ],
    [
      "a node group on the second cluster",
      (w) => {
        w.aws.addNodegroup(SECOND.region, SECOND.name, "extra", {
          minSize: 0,
          maxSize: 1,
          desiredSize: 0
        });
      },
      [
        `Cluster ${SECOND_LABEL} has node groups extra, but the second cluster must have none: its deploy fails before any pod is scheduled. Delete them; see ${RUNBOOK}.`
      ]
    ],
    [
      "an isolated group without a launch template",
      (w) => {
        group(w, "isolated").launchTemplate = null;
      },
      [
        `node group isolated on cluster ${MAIN_LABEL} has no launch template, so EKS puts its node in the cluster security group and the isolated probe would connect. Recreate it with its own security group (step 2 of ${RUNBOOK}).`
      ]
    ],
    [
      "an isolated launch template with the cluster security group",
      (w) => {
        w.aws.addLaunchTemplate(MAIN.region, ISOLATED_TEMPLATE, {
          "1": {
            SecurityGroupIds: ["sg-isolated", main(w).clusterSecurityGroupId]
          }
        });
      },
      [
        `Launch template ${ISOLATED_TEMPLATE} version 1 of node group isolated on cluster ${MAIN_LABEL} puts the node in the cluster security group sg-cluster-${MAIN.name}, so the isolated probe would connect. Recreate it with its own security group (step 2 of ${RUNBOOK}).`
      ]
    ],
    [
      "an isolated launch template with the cluster security group on its network interface",
      (w) => {
        w.aws.addLaunchTemplate(MAIN.region, ISOLATED_TEMPLATE, {
          "1": {
            NetworkInterfaces: [{ Groups: [main(w).clusterSecurityGroupId] }]
          }
        });
      },
      [
        `Launch template ${ISOLATED_TEMPLATE} version 1 of node group isolated on cluster ${MAIN_LABEL} puts the node in the cluster security group sg-cluster-${MAIN.name}, so the isolated probe would connect. Recreate it with its own security group (step 2 of ${RUNBOOK}).`
      ]
    ],
    [
      "an isolated launch template with no security group",
      (w) => {
        w.aws.addLaunchTemplate(MAIN.region, ISOLATED_TEMPLATE, { "1": {} });
      },
      [
        `Launch template ${ISOLATED_TEMPLATE} version 1 of node group isolated on cluster ${MAIN_LABEL} sets no security group, so EKS puts the node in the cluster security group and the isolated probe would connect. Recreate it with its own security group (step 2 of ${RUNBOOK}).`
      ]
    ],
    [
      "an isolated group without its taint",
      (w) => {
        group(w, "isolated").taints = [
          { key: "radius-e2e/isolated", value: "true", effect: "NO_EXECUTE" }
        ];
      },
      [
        `Node group isolated on cluster ${MAIN_LABEL} has no radius-e2e/isolated=true:NoSchedule taint, so app pods could run on the isolated node. Add it: aws eks update-nodegroup-config --cluster-name ${MAIN.name} --nodegroup-name isolated --region ${MAIN.region} --taints 'addOrUpdateTaints=[{key=radius-e2e/isolated,value=true,effect=NO_SCHEDULE}]'`
      ]
    ],
    [
      "a node group without its pool label",
      (w) => {
        group(w, "default").labels = {};
        group(w, "isolated").labels = { "radius-e2e/pool": "default" };
      },
      [
        `Node group default on cluster ${MAIN_LABEL} has label radius-e2e/pool=(none), not default, so the connection probe can't select its nodes. Fix it: aws eks update-nodegroup-config --cluster-name ${MAIN.name} --nodegroup-name default --region ${MAIN.region} --labels 'addOrUpdateLabels={radius-e2e/pool=default}'`,
        `Node group isolated on cluster ${MAIN_LABEL} has label radius-e2e/pool=default, not isolated, so the connection probe can't select its nodes. Fix it: aws eks update-nodegroup-config --cluster-name ${MAIN.name} --nodegroup-name isolated --region ${MAIN.region} --labels 'addOrUpdateLabels={radius-e2e/pool=isolated}'`
      ]
    ],
    [
      "node groups an earlier run left up",
      (w) => {
        group(w, "default").desiredSize = 2;
        group(w, "isolated").minSize = 1;
        group(w, "isolated").desiredSize = 1;
      },
      [
        `Node group default on cluster ${MAIN_LABEL} is at 2 nodes (minimum 0), left from an earlier run. Run the Cloud E2E cleanup workflow, which scales it to zero.`,
        `Node group isolated on cluster ${MAIN_LABEL} is at 1 nodes (minimum 1), left from an earlier run. Run the Cloud E2E cleanup workflow, which scales it to zero.`
      ]
    ],
    [
      "a missing deploy role",
      (w) => {
        w.aws.roles.clear();
      },
      [
        `Deploy role ${ROLE} doesn't exist in account ${ACCOUNT}. An administrator creates it once (step 4 of ${RUNBOOK}); the test role can't.`,
        `Could not check deploy role ${ROLE}'s environments: aws iam get-role: \nAn error occurred (NoSuchEntity) when calling the GetRole operation: The role with name ${ROLE} cannot be found.`.replace(
          ": \n",
          ": "
        )
      ]
    ],
    [
      "deploy role tags that don't name the fixture",
      (w) => {
        deployRole(w).Tags = [
          { Key: "Radius-Managed", Value: "true" },
          { Key: "radius-repository", Value: "someone/else" }
        ];
      },
      [
        `Deploy role ${ROLE} has tag radius-repository=someone/else, not ${REPO}, so setup won't reuse it. Fix it: aws iam tag-role --role-name ${ROLE} --tags Key=radius-repository,Value=${REPO}`,
        `Deploy role ${ROLE} has tag radius-repository-id=(none), not ${REPO_ID}, so setup won't reuse it. Fix it: aws iam tag-role --role-name ${ROLE} --tags Key=radius-repository-id,Value=${REPO_ID}`
      ]
    ],
    [
      "a deploy role Radius doesn't manage",
      (w) => {
        deployRole(w).Tags = [
          { Key: "radius-managed", Value: "false" },
          { Key: "radius-repository", Value: REPO },
          { Key: "radius-repository-id", Value: String(REPO_ID) }
        ];
      },
      [
        `Deploy role ${ROLE} has tag radius-managed=false, not true, so setup won't reuse it. Fix it: aws iam tag-role --role-name ${ROLE} --tags Key=radius-managed,Value=true`
      ]
    ],
    [
      "a deploy role without the boundary",
      (w) => {
        deployRole(w).boundary = "";
      },
      [
        `Deploy role ${ROLE} has permissions boundary (none), not ${BOUNDARY_ARN}, so nothing caps what setup lets it do. Set it: aws iam put-role-permissions-boundary --role-name ${ROLE} --permissions-boundary ${BOUNDARY_ARN}`
      ]
    ],
    [
      "a deploy role with another boundary",
      (w) => {
        deployRole(w).boundary = `arn:aws:iam::${ACCOUNT}:policy/other`;
      },
      [
        `Deploy role ${ROLE} has permissions boundary arn:aws:iam::${ACCOUNT}:policy/other, not ${BOUNDARY_ARN}, so nothing caps what setup lets it do. Set it: aws iam put-role-permissions-boundary --role-name ${ROLE} --permissions-boundary ${BOUNDARY_ARN}`
      ]
    ],
    [
      "a deploy role trusting something other than the deny-only statement",
      (w) => {
        deployRole(w).AssumeRolePolicyDocument = {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole"
            }
          ]
        };
      },
      [
        `Deploy role ${ROLE}'s trust policy isn't the single RadiusNoTrustedEnvironments deny statement setup leaves when no environment uses the role. Restore build/cloud-e2e/aws/deploy-role-trust.json (step 4 of ${RUNBOOK}).`
      ]
    ],
    [
      "a deploy role trust with the statement's keys in another order",
      (w) => {
        const [statement] = (
          deployRoleTrust([]) as { Statement: Array<Record<string, unknown>> }
        ).Statement;
        deployRole(w).AssumeRolePolicyDocument = encodeURIComponent(
          JSON.stringify({
            Statement: [
              Object.fromEntries(Object.entries(statement ?? {}).reverse())
            ],
            Version: "2012-10-17"
          })
        );
      },
      []
    ],
    [
      "a lock on the deploy role",
      (w) => {
        w.aws.addManagedPolicy({
          path: "/",
          name: buildAwsLockPolicyName(ROLE),
          document: buildAwsLockPolicyDocument(ACCOUNT, ROLE)
        }).Description = JSON.stringify({
          repo: REPO,
          environment: "radtest-aws-old",
          action: "setup"
        });
      },
      [
        `Deploy role ${ROLE} is locked: The setup of environment radtest-aws-old in ${REPO} has held it since 2026-11-17T04:23:00.000Z. A run or cleanup is still using it, or one stopped; the cleanup workflow removes a lock 10 or more minutes old.`
      ]
    ],
    [
      "an earlier run's database, workload, and namespace",
      (w) => {
        const name = "radtest-aws-old-main";
        w.aws.rds.addRecipeDatabase({
          name: databaseName(name),
          region: MAIN.region,
          vpcId: MAIN_VPC,
          tags: recipeTags(name)
        });
        w.kube.addWorkload(`${MAIN.region}/${MAIN.name}`, {
          kind: "Job",
          name: "radius-probe-default-0-old",
          namespace: "default",
          labels: {
            "radapp.io/environment": name,
            "radapp.io/application": "cloud-e2e"
          },
          creationTimestamp: "2026-11-17T04:00:00Z"
        });
        w.kube.addNamespace(`${SECOND.region}/${SECOND.name}`, NAMESPACE);
      },
      [
        `RDS DB instance ${databaseName("radtest-aws-old-main")} (available) in ${MAIN.region} is left from an earlier run. ${CLEANUP}`,
        `RDS DB subnet group ${databaseName("radtest-aws-old-main")} in ${MAIN.region} is left from an earlier run. ${CLEANUP}`,
        `RDS DB parameter group ${databaseName("radtest-aws-old-main")} in ${MAIN.region} is left from an earlier run. ${CLEANUP}`,
        `Job default/radius-probe-default-0-old on cluster ${MAIN_LABEL} is left from an earlier run. ${CLEANUP}`,
        `Namespace ${NAMESPACE} on cluster ${SECOND_LABEL} is left from an earlier run. ${CLEANUP}`
      ]
    ],
    [
      "an earlier run's environment on the deploy role",
      (w) => {
        addLiveEnvironment(
          w,
          liveEnvironment("radtest-aws-old-second", SECOND)
        );
      },
      [
        `Deploy role ${ROLE} trusts repo:${REPO}:environment:radtest-aws-old-second, which no live environment uses. ${CLEANUP}`,
        `Deploy role ${ROLE} has inline policy radius-app-roles-${REPO_ID}, which no live environment uses. ${CLEANUP}`,
        `Deploy role ${ROLE} has inline policy radius-deploy-radtest-aws-old-second-${REPO_ID}, which no live environment uses. ${CLEANUP}`,
        `Cluster ${SECOND_LABEL} has an access entry for ${ROLE}, but no live environment uses that cluster. ${CLEANUP}`,
        `App boundary ${awsAppBoundary(ACCOUNT, REPO_ID, "radtest-aws-old-second").arn} is there, but no live environment uses it. ${CLEANUP}`
      ]
    ]
  ])("names %s", async (_case, change, expected) => {
    const w = world();
    change(w);
    expect(await findings(w)).toEqual(expected);
    expect(awsWrites(w)).toEqual([]);
  });

  it("names an app role and a Pod Identity association an earlier run left, including one whose role is gone", async () => {
    const w = world();
    const folder = `/radius/apps/${REPO_ID}/radtest-aws-old/`;
    const tags = recipeTags("radtest-aws-old");
    const role = w.aws.addRole({
      name: "radius-app-web-1",
      trust: {},
      path: folder,
      boundary: awsAppBoundary(ACCOUNT, REPO_ID, "radtest-aws-old").arn,
      tags
    });
    const gone = `arn:aws:iam::${ACCOUNT}:role${folder}radius-app-api-1`;
    const kept = w.aws.addPodIdentityAssociation(MAIN.region, MAIN.name, {
      namespace: NAMESPACE,
      serviceAccount: "radius-app-web",
      roleArn: role.Arn,
      tags: Object.fromEntries(tags.map((tag) => [tag.Key, tag.Value]))
    });
    const orphan = w.aws.addPodIdentityAssociation(SECOND.region, SECOND.name, {
      namespace: NAMESPACE,
      serviceAccount: "radius-app-api",
      roleArn: gone
    });
    // Neither is the fixture repository's: another repository's path, and a
    // role outside the app path.
    w.aws.addRole({
      name: "radius-app-other",
      trust: {},
      path: "/radius/apps/42/radtest-aws-old/"
    });
    w.aws.addPodIdentityAssociation(MAIN.region, MAIN.name, {
      namespace: NAMESPACE,
      serviceAccount: "unrelated",
      roleArn: `arn:aws:iam::${ACCOUNT}:role/unrelated`
    });
    expect(await findings(w)).toEqual([
      `App role ${role.Arn} is left from an earlier run. ${CLEANUP}`,
      `Pod Identity association ${kept.associationId} (${NAMESPACE}/radius-app-web) on cluster ${MAIN.name}, for ${role.Arn} is left from an earlier run. ${CLEANUP}`,
      `Pod Identity association ${orphan.associationId} (${NAMESPACE}/radius-app-api) on cluster ${SECOND.name}, for ${gone} is left from an earlier run. ${CLEANUP}`
    ]);
    expect(awsWrites(w)).toEqual([]);
  });

  it("names values AWS left out", async () => {
    const w = world();
    second(w).status = "";
    const runAws = w.preflightPorts.runAws;
    const ports = {
      ...w.preflightPorts,
      runAws: async (args: string[]) =>
        args[1] === "get-policy" ?
          { code: 0, stdout: '{"Policy":{}}', stderr: "" }
        : runAws(args)
    };
    expect(await collectAwsPreflightFindings(CONFIG, ports)).toEqual([
      `Cluster ${SECOND_LABEL} is in an unknown state, not ACTIVE. Retry when it is ACTIVE.`,
      `Deploy role ${ROLE} is locked: Another run has held it since an unknown time. A run or cleanup is still using it, or one stopped; the cleanup workflow removes a lock 10 or more minutes old.`
    ]);
    const anonymous = {
      ...w.preflightPorts,
      runAws: async (args: string[]) =>
        args[0] === "sts" ? { code: 0, stdout: "{}", stderr: "" } : runAws(args)
    };
    expect(await collectAwsPreflightFindings(CONFIG, anonymous)).toEqual([
      `AWS is signed in to account (unknown), not ${ACCOUNT}, the test role's account. Sign in to the role AIEXT_CLOUD_E2E_AWS_ROLE_ARN names.`
    ]);
  });

  it("turns each read that fails into a finding, and checks the rest", async () => {
    const w = world();
    w.aws.refuseOnce("eks describe-addon", "AccessDeniedException");
    w.aws.refuseOnce("eks list-nodegroups", "AccessDeniedException");
    w.aws.refuseOnce(
      "ec2 describe-launch-template-versions",
      "UnauthorizedOperation"
    );
    w.aws.refuseOnce("iam get-policy", "AccessDenied");
    w.aws.refuseOnce("rds describe-db-instances", "AccessDenied");
    expect(await findings(w)).toEqual([
      `Could not check cluster ${MAIN_LABEL}: aws eks describe-addon: An error occurred (AccessDeniedException) when calling the eks describe-addon operation: Refused by the test.`,
      expect.stringMatching(
        /^Could not check the node groups of cluster .*: aws eks list-nodegroups: .*AccessDeniedException/
      ),
      expect.stringMatching(
        /^Could not check the node groups of cluster .*: aws ec2 describe-launch-template-versions: .*UnauthorizedOperation/
      ),
      expect.stringMatching(
        /^Could not check deploy role .*: aws iam get-policy: .*AccessDenied/
      ),
      expect.stringMatching(
        /^Could not check what earlier runs left: aws rds describe-db-instances: .*AccessDenied/
      )
    ]);
  });

  it("reports a read it couldn't make of the account, the role, or the cluster security group", async () => {
    const w = world();
    w.aws.refuseOnce("sts get-caller-identity", "ExpiredToken");
    expect(await findings(w)).toEqual([
      expect.stringMatching(
        /^Could not check the AWS account: aws sts get-caller-identity: .*ExpiredToken/
      )
    ]);
    w.aws.refuseOnce("iam get-role", "AccessDenied");
    main(w).clusterSecurityGroupId = "";
    const result = await findings(w);
    expect(result).toContain(
      `Could not check the node groups of cluster ${MAIN_LABEL}: EKS reported no cluster security group for cluster ${MAIN_LABEL}.`
    );
    expect(
      result.some((line) =>
        line.startsWith(
          `Could not check deploy role ${ROLE}: aws iam get-role:`
        )
      )
    ).toBe(true);
  });
});

// GitHub, as the fixture repository answers a clean run.
function githubStubs(head: string): FakeCommandStub[] {
  const notFound = { code: 1, stderr: "gh: Not Found (HTTP 404)" };
  return [
    {
      tool: "gh",
      match: ["api", "--method", "POST", `repos/${REPO}/git/refs`],
      respond: {}
    },
    {
      tool: "gh",
      match: [
        "api",
        "--method",
        "DELETE",
        `repos/${REPO}/git/refs/heads/radius/cloud-e2e-lease`
      ],
      respond: {}
    },
    {
      tool: "gh",
      match: ["api", `repos/${REPO}`, "--jq", ".id"],
      respond: { stdout: `${REPO_ID}\n` }
    },
    { tool: "gh", match: ["repo", "clone"], respond: {} },
    {
      tool: "git",
      match: ["reset", "--hard", FIXTURE_AWS_BASELINE_SHA],
      respond: {}
    },
    {
      tool: "gh",
      match: [
        "api",
        "--paginate",
        "--slurp",
        `repos/${REPO}/environments?per_page=100`
      ],
      respond: {
        stdout: JSON.stringify([{ total_count: 0, environments: [] }])
      }
    },
    {
      tool: "gh",
      match: [
        "api",
        "--paginate",
        "--slurp",
        `repos/${REPO}/pulls?state=open&per_page=100`
      ],
      respond: { stdout: "[[]]" }
    },
    {
      tool: "gh",
      match: ["api", `repos/${REPO}/git/matching-refs/heads/radius/setup-`],
      respond: { stdout: "[]" }
    },
    {
      tool: "gh",
      match: ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"],
      respond: { stdout: head }
    },
    {
      tool: "gh",
      match: ["api", "--method", "PATCH", `repos/${REPO}/git/refs/heads/main`],
      respond: { stdout: FIXTURE_AWS_BASELINE_SHA }
    },
    { tool: "gh", match: ["api"], respond: notFound },
    {
      tool: "gh-package",
      match: ["api", "users/radius-project", "--jq", ".type"],
      respond: { stdout: "Organization" }
    },
    { tool: "gh-package", match: ["api"], respond: notFound }
  ];
}

function fixtureOptions(
  w: World,
  stubs: FakeCommandStub[] = githubStubs(FIXTURE_BASELINE_SHA)
) {
  const fake = createFakeFixturePorts({ stubs, uniqueId: "Run-1" });
  const runGh = fake.ports.commands.runGh;
  const options: AwsCloudFixtureOptions = {
    ports: {
      ...fake.ports,
      commands: {
        ...fake.ports.commands,
        runGh: (args) => {
          w.events.push(`gh ${args.join(" ")}`);
          return runGh(args);
        }
      }
    },
    aws: w.preflightPorts,
    testRoleArn: TEST_ROLE,
    clusters: [MAIN, SECOND]
  };
  return { fake, options };
}

const MOVE_MAIN = `gh api --method PATCH repos/${REPO}/git/refs/heads/main -f sha=${FIXTURE_AWS_BASELINE_SHA} -F force=true --jq .object.sha`;

describe("createAwsCloudFixture", () => {
  it("takes the lease, reads the repository ID, and clones at the AWS baseline", async () => {
    const w = world();
    const { fake, options } = fixtureOptions(w);
    const fixture = await createAwsCloudFixture(options);
    expect(fixture).toMatchObject({
      uniqueId: "run1",
      repository: REPO,
      repositoryId: REPO_ID,
      baselineSha: FIXTURE_AWS_BASELINE_SHA,
      workspacePath: "/tmp/radtest-workspace",
      accountId: ACCOUNT,
      deployRoleName: ROLE,
      deployRoleArn: ROLE_ARN,
      environmentNames: ["radtest-aws-run1-main", "radtest-aws-run1-second"]
    });
    expect(fake.commands.commandLines("git")).toEqual([
      `reset --hard ${FIXTURE_AWS_BASELINE_SHA}`
    ]);
    expect(w.events.filter((line) => line.startsWith("aws"))).toEqual([]);
  });

  it("moves main to the AWS baseline only after every check passed, then starts and stops the nodes", async () => {
    const w = world();
    const { fake, options } = fixtureOptions(w);
    const fixture = await createAwsCloudFixture(options);
    await fixture.prepareCleanSlate();
    const moved = w.events.indexOf(MOVE_MAIN);
    expect(moved).toBe(w.events.length - 1);
    expect(
      w.events.slice(0, moved).some((line) => line.startsWith("aws"))
    ).toBe(true);
    expect(awsWrites(w)).toEqual([]);
    for (const name of fixture.environmentNames)
      expect(fake.commands.commandLines("gh-package")).toContain(
        `api orgs/radius-project/packages/container/${stateRegistryForEnvironment(REPO, name).split("/").at(-1)}`
      );

    await fixture.startNodeGroups();
    expect(group(w, "default").desiredSize).toBe(2);
    await fixture.dispose();
    await fixture.dispose();
    expect(group(w, "default").desiredSize).toBe(0);
    expect(group(w, "isolated").desiredSize).toBe(0);
    expect(
      fake.commands.commandLines("gh").filter((line) => line.includes("DELETE"))
    ).toHaveLength(1);
    expect(fake.removed).toEqual(["/tmp/radtest-workspace"]);
  });

  it("leaves main where it is when main is already at the AWS baseline", async () => {
    const w = world();
    const { options } = fixtureOptions(
      w,
      githubStubs(FIXTURE_AWS_BASELINE_SHA)
    );
    const fixture = await createAwsCloudFixture(options);
    await fixture.prepareCleanSlate();
    expect(w.events).not.toContain(MOVE_MAIN);
  });

  it("fails before any write when AWS isn't ready, naming every problem", async () => {
    const w = world();
    second(w).supportType = "EXTENDED";
    group(w, "default").desiredSize = 1;
    const { options } = fixtureOptions(w);
    const fixture = await createAwsCloudFixture(options);
    const failure = fixture.prepareCleanSlate();
    await expect(failure).rejects.toThrow(
      "The AWS Cloud E2E preflight failed, so nothing was changed. This is an infrastructure failure or something an earlier run left, not a product regression:\n" +
        `  - Cluster ${SECOND_LABEL} has upgrade policy EXTENDED`
    );
    await expect(failure).rejects.toThrow(
      `  - Node group default on cluster ${MAIN_LABEL} is at 1 nodes`
    );
    expect(w.events).not.toContain(MOVE_MAIN);
    expect(awsWrites(w)).toEqual([]);
    await expect(fixture.startNodeGroups()).rejects.toThrow(
      "The node groups start only after prepareCleanSlate() passes."
    );
    await fixture.dispose();
    expect(awsWrites(w)).toEqual([]);
  });

  it("fails before any write when GitHub isn't clean, naming each finding once", async () => {
    const w = world();
    const stubs = githubStubs(FIXTURE_BASELINE_SHA).map((stub) =>
      (
        stub.match.includes(
          `repos/${REPO}/git/matching-refs/heads/radius/setup-`
        )
      ) ?
        {
          ...stub,
          respond: { stdout: '[{"ref":"refs/heads/radius/setup-old"}]' }
        }
      : stub
    );
    const { options } = fixtureOptions(w, stubs);
    const fixture = await createAwsCloudFixture(options);
    const failure = fixture.prepareCleanSlate();
    await expect(failure).rejects.toThrow(
      `nothing was changed. This is an infrastructure failure or something an earlier run left, not a product regression:\n  - workflow fallback branch "radius/setup-old" in ${REPO}`
    );
    await expect(failure).rejects.not.toThrow(
      /radius\/setup-old.*radius\/setup-old/s
    );
    expect(w.events).not.toContain(MOVE_MAIN);
  });

  it("refuses a test role ARN it can't read and a cluster in Radius's region, before any call", async () => {
    const w = world();
    const { fake, options } = fixtureOptions(w);
    await expect(
      createAwsCloudFixture({
        ...options,
        testRoleArn: "arn:aws-cn:iam::123456789012:role/x"
      })
    ).rejects.toThrow(
      "The AWS test role must be an IAM role ARN in the aws partition"
    );
    await expect(
      createAwsCloudFixture({ ...options, testRoleArn: "not-an-arn" })
    ).rejects.toThrow('got "not-an-arn"');
    await expect(
      createAwsCloudFixture({
        ...options,
        clusters: [MAIN, { region: "us-west-2", name: "radius" }]
      })
    ).rejects.toThrow("can't be in us-west-2");
    expect(fake.commands.calls).toEqual([]);
  });

  it("releases the lease when construction fails, and reports a release that fails too", async () => {
    const w = world();
    const badId = githubStubs(FIXTURE_BASELINE_SHA).map((stub) =>
      stub.match.includes(".id") ?
        { ...stub, respond: { stdout: "null" } }
      : stub
    );
    const { fake, options } = fixtureOptions(w, badId);
    await expect(createAwsCloudFixture(options)).rejects.toThrow(
      `gh api repos/${REPO} returned no repository ID: "null".`
    );
    expect(fake.commands.commandLines("gh").at(-1)).toContain("DELETE");

    const stuck = badId.map((stub) =>
      stub.match.includes("DELETE") ?
        { ...stub, respond: { code: 1, stderr: "HTTP 500" } }
      : stub
    );
    await expect(
      createAwsCloudFixture(fixtureOptions(w, stuck).options)
    ).rejects.toThrow(
      /^AWS cloud fixture construction failed: .*no repository ID.*\nCleanup after the construction failure also failed:\n {2}- release repository lease/s
    );
  });

  it("reports a scale-down that fails at teardown and still releases the lease", async () => {
    const w = world();
    const { fake, options } = fixtureOptions(w);
    const fixture = await createAwsCloudFixture(options);
    await fixture.prepareCleanSlate();
    await fixture.startNodeGroups();
    w.aws.refuseOnce("eks update-nodegroup-config", "AccessDeniedException");
    await expect(fixture.dispose()).rejects.toThrow(
      /^AWS cloud fixture teardown failed:\n {2}- Could not scale the node groups on cluster .* to zero/
    );
    expect(
      fake.commands.commandLines("gh").filter((line) => line.includes("DELETE"))
    ).toHaveLength(1);
    expect(fake.removed).toEqual(["/tmp/radtest-workspace"]);
  });
});
