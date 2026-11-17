import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AWS_MANAGED_TAG,
  AWS_REPOSITORY_ID_TAG,
  AWS_REPOSITORY_TAG,
  awsLockPolicyArn,
  buildAwsAppRolesPolicy,
  buildAwsEnvironmentPermissionPolicy,
  buildGitHubTrustPolicy,
  removeGitHubTrustSubject
} from "@radius-project/core";
import { awsAppBoundary } from "../../src/aws-deploy-role-name.js";
import { AWS_MAIN_NODE_GROUPS } from "../e2e-cloud/support/aws-cloud-cleanup.js";
import {
  addAwsEnvironment,
  createCleanupScenario,
  MAIN_VPC,
  recipeTags,
  runSweep,
  runVerify
} from "../support/aws/cleanup-scenario.js";
import {
  evaluateIam,
  type IamDecision,
  type IamRequest
} from "../support/aws/iam-policy-evaluator.js";

// The one-time AWS setup an administrator runs, committed so it is reviewed
// and can be recreated. The files hold ${NAME} placeholders that envsubst
// fills in (see the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md). These
// checks keep them in step with what the product and the cleanup sweep
// expect.

const DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../build/cloud-e2e/aws"
);

const VALUES: Record<string, string> = {
  ACCOUNT: "123456789012",
  CI_REPO: "radius-project/ai-extensions",
  MAIN_REGION: "us-east-2",
  SECOND_REGION: "us-west-1",
  MAIN_CLUSTER: "ai-extensions-e2e-use2",
  SECOND_CLUSTER: "ai-extensions-e2e-usw1",
  DEPLOY_ROLE: "radius-deploy-radius-project-ai-extensions-fixture",
  FIXTURE_REPO: "radius-project/ai-extensions-fixture",
  FIXTURE_REPO_ID: "1361595003",
  BUDGET_EMAIL: "owner@example.com"
};

async function raw(file: string): Promise<string> {
  return readFile(path.join(DIRECTORY, file), "utf8");
}

// What `envsubst` makes of a file.
function render(text: string): string {
  return text.replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => {
    const value = VALUES[name];
    if (value === undefined) throw new Error(`No value for \${${name}}`);
    return value;
  });
}

async function rendered(file: string): Promise<any> {
  const text = render(await raw(file));
  return file.endsWith(".json") ? JSON.parse(text) : parse(text);
}

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
}

function list(value: string | string[] | undefined): string[] {
  return (
    value === undefined ? []
    : Array.isArray(value) ? value
    : [value]
  );
}

const IAM = `arn:aws:iam::${VALUES.ACCOUNT}:`;
// IAM is a global service, so its requests name us-east-1.
const GLOBAL = "us-east-1";
const NODEGROUP_ID = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const APP_BOUNDARY = awsAppBoundary(
  VALUES.ACCOUNT!,
  Number(VALUES.FIXTURE_REPO_ID),
  "radtest-aws-1"
).arn;
// The containers Recipe puts an app role at its boundary's path.
const APP_ROLE_NAME = "radius-app-web-1";
const APP_ROLE = `${IAM}role${APP_BOUNDARY.slice(`${IAM}policy`.length).replace(/[^/]+$/, "")}${APP_ROLE_NAME}`;
const MAIN_CLUSTER_ARN = `arn:aws:eks:${VALUES.MAIN_REGION}:${VALUES.ACCOUNT}:cluster/${VALUES.MAIN_CLUSTER}`;
const MAIN_ASSOCIATION = `arn:aws:eks:${VALUES.MAIN_REGION}:${VALUES.ACCOUNT}:podidentityassociation/${VALUES.MAIN_CLUSTER}/a-1`;
const CLUSTERS = [
  [VALUES.MAIN_REGION!, VALUES.MAIN_CLUSTER!],
  [VALUES.SECOND_REGION!, VALUES.SECOND_CLUSTER!]
] as const;

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

// `--tags Key=a,Value=b Key=c,Value=d` as aws:RequestTag context keys.
function requestTags(args: readonly string[]): Record<string, string> {
  const index = args.indexOf("--tags");
  const context: Record<string, string> = {};
  if (index < 0) return context;
  for (const item of args.slice(index + 1)) {
    if (item.startsWith("--")) break;
    const match = /^Key=([^,]+),Value=(.*)$/.exec(item);
    if (!match) throw new Error(`Unexpected tag ${item}`);
    context[`aws:RequestTag/${match[1]}`] = match[2]!;
  }
  return context;
}

// The request IAM authorizes for one AWS CLI call: its action, the resource
// it names, and the context keys the committed policies' conditions read.
// A command it doesn't know fails the test, so a new sweep call gets mapped.
function cliRequest(args: readonly string[]): IamRequest {
  const [service, operation] = args;
  const command = `${service} ${operation}`;
  const region = flag(args, "--region") || GLOBAL;
  const eks = `arn:aws:eks:${region}:${VALUES.ACCOUNT}:`;
  const rds = `arn:aws:rds:${region}:${VALUES.ACCOUNT}:`;
  const cluster = flag(args, "--cluster-name") || flag(args, "--name");
  const named = (prefix: string, option: string) =>
    flag(args, option) ? `${rds}${prefix}:${flag(args, option)}` : "*";
  let resource: string;
  let context: Record<string, string> = {};
  switch (command) {
    case "sts get-caller-identity":
    case "iam list-roles":
    case "iam list-policies":
      resource = "*";
      break;
    case "eks describe-cluster":
    case "eks list-nodegroups":
    case "eks list-access-entries":
      resource = `${eks}cluster/${cluster}`;
      break;
    case "eks describe-nodegroup":
    case "eks update-nodegroup-config":
      resource = `${eks}nodegroup/${cluster}/${flag(args, "--nodegroup-name")}/${NODEGROUP_ID}`;
      break;
    case "eks describe-access-entry":
    case "eks delete-access-entry":
      resource = `${eks}access-entry/${cluster}/role/${VALUES.ACCOUNT}/${flag(args, "--principal-arn").split("/").pop()}/${NODEGROUP_ID}`;
      break;
    case "rds describe-db-instances":
    case "rds delete-db-instance":
      resource = named("db", "--db-instance-identifier");
      break;
    case "rds describe-db-subnet-groups":
    case "rds delete-db-subnet-group":
      resource = named("subgrp", "--db-subnet-group-name");
      break;
    case "rds describe-db-parameter-groups":
    case "rds delete-db-parameter-group":
      resource = named("pg", "--db-parameter-group-name");
      break;
    case "rds describe-db-snapshots":
    case "rds delete-db-snapshot":
      resource = named("snapshot", "--db-snapshot-identifier");
      break;
    case "rds list-tags-for-resource":
      resource = flag(args, "--resource-name");
      break;
    case "iam get-role":
    case "iam list-role-policies":
    case "iam get-role-policy":
    case "iam put-role-policy":
    case "iam delete-role-policy":
    case "iam update-assume-role-policy":
      resource = `${IAM}role/${flag(args, "--role-name")}`;
      break;
    case "iam get-policy":
    case "iam get-policy-version":
    case "iam delete-policy":
      resource = flag(args, "--policy-arn");
      break;
    case "iam create-policy":
      resource = `${IAM}policy${flag(args, "--path") || "/"}${flag(args, "--policy-name")}`;
      context = requestTags(args);
      break;
    default:
      throw new Error(`No IAM request is mapped for aws ${command}.`);
  }
  return {
    action: `${service}:${operation!.replace(/-/g, "")}`,
    resource,
    context: { "aws:RequestedRegion": region, ...context }
  };
}

// One request for each action and resource of each `effect` statement of a
// product policy, with the context its condition asks for. A wildcard in a
// resource or condition becomes an app role's environment and name.
function productRequests(
  policy: ReturnType<typeof buildAwsAppRolesPolicy>,
  effect: "Allow" | "Deny"
): IamRequest[] {
  const sample = (pattern: string) =>
    pattern.replace(/\*/g, "radtest-aws-1/radius-app-web-1");
  return policy.Statement.filter((item) => item.Effect === effect).flatMap(
    (statement) => {
      const context: Record<string, string> = {
        "aws:RequestedRegion": GLOBAL
      };
      const condition = (statement.Condition ?? {}) as Record<
        string,
        Record<string, string>
      >;
      for (const [operator, keys] of Object.entries(condition))
        for (const [key, value] of Object.entries(keys)) {
          if (operator !== "ArnLike" && operator !== "StringEquals")
            throw new Error(`No sample value for ${operator}.`);
          context[key] = sample(value);
        }
      return list(statement.Action as string | string[]).flatMap((action) =>
        list(statement.Resource as string | string[]).map((resource) => ({
          action: action.replace(/\*/g, "CreatePolicy"),
          resource: sample(resource),
          context
        }))
      );
    }
  );
}

// What the deploy role's own policies grant while both environments exist.
function deployRoleIdentity(): unknown[] {
  return [
    buildAwsEnvironmentPermissionPolicy(VALUES.MAIN_REGION!),
    buildAwsEnvironmentPermissionPolicy(VALUES.SECOND_REGION!),
    buildAwsAppRolesPolicy(VALUES.ACCOUNT!, Number(VALUES.FIXTURE_REPO_ID))
  ];
}

function request(
  action: string,
  resource: string,
  decision: IamDecision,
  context: Record<string, string> = {}
) {
  return {
    action,
    resource,
    decision,
    context: { "aws:RequestedRegion": GLOBAL, ...context }
  };
}

function inRegion(
  action: string,
  resource: string,
  region: string,
  decision: IamDecision
) {
  return request(action, resource, decision, { "aws:RequestedRegion": region });
}

// The cases `aws iam simulate-custom-policy` was run with on these files
// (see the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md), with the product's
// policies as the deploy role's own.
const DEPLOY_ROLE_CASES = [
  request("iam:CreateRole", APP_ROLE, "allowed", {
    "iam:PermissionsBoundary": APP_BOUNDARY
  }),
  request("iam:DeleteRole", APP_ROLE, "allowed", {
    "iam:PermissionsBoundary": APP_BOUNDARY
  }),
  request("iam:GetRole", `${IAM}role/${APP_ROLE_NAME}`, "allowed"),
  request("iam:PassRole", APP_ROLE, "allowed", {
    "iam:PassedToService": "pods.eks.amazonaws.com"
  }),
  inRegion(
    "eks:CreatePodIdentityAssociation",
    MAIN_CLUSTER_ARN,
    VALUES.MAIN_REGION!,
    "allowed"
  ),
  inRegion(
    "eks:DeletePodIdentityAssociation",
    MAIN_ASSOCIATION,
    VALUES.MAIN_REGION!,
    "allowed"
  ),
  inRegion("cloudformation:DescribeType", "*", VALUES.MAIN_REGION!, "allowed"),
  inRegion("rds:CreateDBInstance", "*", VALUES.SECOND_REGION!, "allowed"),
  request("iam:CreateRole", APP_ROLE, "explicitDeny"),
  request("iam:CreateRole", APP_ROLE, "explicitDeny", {
    "iam:PermissionsBoundary": `${IAM}policy/radius/apps/42/radtest-aws-1/b`
  }),
  request(
    "iam:CreateRole",
    `${IAM}role/radius/apps/42/radtest-aws-1/radius-app-web-1`,
    "explicitDeny",
    { "iam:PermissionsBoundary": APP_BOUNDARY }
  ),
  request("iam:DeleteRole", `${IAM}role/radius-app-web-1`, "explicitDeny"),
  request("iam:PassRole", APP_ROLE, "explicitDeny", {
    "iam:PassedToService": "ec2.amazonaws.com"
  }),
  request("iam:DeleteRolePermissionsBoundary", APP_ROLE, "explicitDeny", {
    "iam:PermissionsBoundary": APP_BOUNDARY
  }),
  request("iam:CreatePolicy", APP_BOUNDARY, "explicitDeny"),
  request("iam:CreatePolicyVersion", APP_BOUNDARY, "explicitDeny"),
  request("iam:DeletePolicy", APP_BOUNDARY, "explicitDeny"),
  request(
    "iam:PutRolePolicy",
    `${IAM}role/${VALUES.DEPLOY_ROLE}`,
    "explicitDeny"
  ),
  request(
    "iam:CreateServiceLinkedRole",
    `${IAM}role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS`,
    "explicitDeny"
  ),
  inRegion(
    "s3:PutAccountPublicAccessBlock",
    "*",
    VALUES.MAIN_REGION!,
    "explicitDeny"
  ),
  inRegion("rds:CreateDBInstance", "*", "us-west-2", "implicitDeny"),
  inRegion(
    "eks:CreatePodIdentityAssociation",
    `arn:aws:eks:us-west-2:${VALUES.ACCOUNT}:cluster/other`,
    "us-west-2",
    "implicitDeny"
  )
];

// The pinned containers Recipe (resource-types-contrib 581148d9,
// Compute/containers/recipes/aws/bicep/aws-eks-containers.bicep) creates an
// AWS::IAM::Role and an AWS::EKS::PodIdentityAssociation through Cloud
// Control, with the deploy role's credentials. These are the permissions each
// handler lists in AWS's CloudFormation resource schema (`aws cloudformation
// describe-type --type RESOURCE --type-name <type>`). Radius never lists
// either type, so the list handlers are left out. The association's handlers
// also list four iam:*WorkloadIdentity* actions for workload identity
// templates. The Recipe sets none, and the product grants none of them.
const RECIPE_HANDLER_PERMISSIONS: Record<string, readonly string[]> = {
  "AWS::IAM::Role": [
    // create
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:GetRolePolicy",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:GetRole",
    // read
    "iam:ListAttachedRolePolicies",
    "iam:ListRolePolicies",
    // update
    "iam:UpdateRole",
    "iam:UpdateRoleDescription",
    "iam:UpdateAssumeRolePolicy",
    "iam:DetachRolePolicy",
    "iam:DeleteRolePermissionsBoundary",
    "iam:PutRolePermissionsBoundary",
    "iam:DeleteRolePolicy",
    // delete
    "iam:DeleteRole"
  ],
  "AWS::EKS::PodIdentityAssociation": [
    // create, read, update, and delete
    "eks:CreatePodIdentityAssociation",
    "eks:DescribePodIdentityAssociation",
    "eks:UpdatePodIdentityAssociation",
    "eks:DeletePodIdentityAssociation",
    "eks:TagResource",
    "eks:UntagResource",
    "iam:PassRole",
    "iam:GetRole"
  ]
};

// The IAM role actions whose requests carry the role's boundary in
// iam:PermissionsBoundary, from the Service Authorization Reference.
const BOUNDARY_KEY_ACTIONS = new Set([
  "iam:CreateRole",
  "iam:DeleteRole",
  "iam:GetRole",
  "iam:PutRolePolicy",
  "iam:DeleteRolePolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:PutRolePermissionsBoundary",
  "iam:DeleteRolePermissionsBoundary",
  "iam:UpdateRole",
  "iam:UpdateRoleDescription",
  "iam:UpdateAssumeRolePolicy"
]);

// Each handler permission as the Recipe's resources request it on each
// cluster: role actions on the app role at its boundary's path, with that
// boundary, and EKS actions on the cluster or the association in its region.
// Cloud Control also reads the role by name, which IAM checks against the
// role's ARN without its path.
function recipeRequests(): IamRequest[] {
  return CLUSTERS.flatMap(([region, cluster]) =>
    Object.values(RECIPE_HANDLER_PERMISSIONS).flatMap((actions) =>
      actions.flatMap((action): IamRequest[] => {
        if (action.startsWith("eks:")) {
          const eks = `arn:aws:eks:${region}:${VALUES.ACCOUNT}:`;
          return [
            {
              action,
              resource:
                action === "eks:CreatePodIdentityAssociation" ?
                  `${eks}cluster/${cluster}`
                : `${eks}podidentityassociation/${cluster}/a-1`,
              context: { "aws:RequestedRegion": region }
            }
          ];
        }
        const context: Record<string, string> = {
          "aws:RequestedRegion": GLOBAL
        };
        if (BOUNDARY_KEY_ACTIONS.has(action))
          context["iam:PermissionsBoundary"] = APP_BOUNDARY;
        if (action === "iam:PassRole")
          context["iam:PassedToService"] = "pods.eks.amazonaws.com";
        const role = { action, resource: APP_ROLE, context };
        return action === "iam:GetRole" ?
            [role, { ...role, resource: `${IAM}role/${APP_ROLE_NAME}` }]
          : [role];
      })
    )
  );
}

describe("build/cloud-e2e/aws", () => {
  it("parses every file as it is and once rendered, and uses only known placeholders", async () => {
    const files = (await readdir(DIRECTORY)).sort();
    expect(files).toEqual([
      "budget-notifications.json",
      "budget.json",
      "deploy-role-boundary.json",
      "deploy-role-tags.json",
      "deploy-role-trust.json",
      "main-cluster.yaml",
      "second-cluster.yaml",
      "test-role-policy.json",
      "test-role-trust.json"
    ]);
    for (const file of files) {
      const text = await raw(file);
      if (file.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
      else expect(() => parse(text)).not.toThrow();
      expect(render(text)).not.toContain("${");
      // envsubst would also replace a bare $NAME.
      expect(text.replace(/\$\{[A-Z_]+\}/g, "")).not.toContain("$");
      await rendered(file);
    }
  });

  it("tags the deploy role exactly as the product tags a role it creates", async () => {
    expect(await rendered("deploy-role-tags.json")).toEqual([
      { Key: AWS_MANAGED_TAG, Value: "true" },
      { Key: AWS_REPOSITORY_TAG, Value: VALUES.FIXTURE_REPO },
      { Key: AWS_REPOSITORY_ID_TAG, Value: VALUES.FIXTURE_REPO_ID }
    ]);
  });

  it("gives the deploy role the trust policy the product leaves when no environment uses it", async () => {
    const last = `repo:${VALUES.FIXTURE_REPO}:environment:last`;
    expect(await rendered("deploy-role-trust.json")).toEqual(
      removeGitHubTrustSubject(
        buildGitHubTrustPolicy(VALUES.ACCOUNT!, [last]),
        VALUES.ACCOUNT!,
        last
      ).policy
    );
  });

  it("trusts only this repository's main branch for the test role", async () => {
    const trust = await rendered("test-role-trust.json");
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0].Condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub":
        "repo:radius-project/ai-extensions:ref:refs/heads/main"
    });
  });

  it("limits the test role's deletes and scaling to what the sweep may touch", async () => {
    const policy = await rendered("test-role-policy.json");
    const statement = (sid: string): Statement =>
      policy.Statement.find((item: Statement) => item.Sid === sid);
    const { ACCOUNT, MAIN_REGION, SECOND_REGION, MAIN_CLUSTER, DEPLOY_ROLE } =
      VALUES;
    expect(list(statement("ScaleAndUpdateMainNodeGroups").Resource)).toEqual(
      AWS_MAIN_NODE_GROUPS.map(
        (name) =>
          `arn:aws:eks:${MAIN_REGION}:${ACCOUNT}:nodegroup/${MAIN_CLUSTER}/${name}/*`
      )
    );
    expect(list(statement("DeployRoleLock").Resource)).toEqual([
      awsLockPolicyArn(ACCOUNT!, DEPLOY_ROLE!)
    ]);
    for (const resource of list(
      statement("DeleteRecipeMySqlLeftovers").Resource
    ))
      expect(resource).toMatch(
        new RegExp(
          `^arn:aws:rds:(${MAIN_REGION}|${SECOND_REGION}):${ACCOUNT}:((db|subgrp|pg):mysql-|snapshot:rds-snapshot-)\\*$`
        )
      );
    expect(
      statement("ReadInTestRegions").Condition?.StringEquals?.[
        "aws:RequestedRegion"
      ]
    ).toEqual([MAIN_REGION, SECOND_REGION]);
    const text = JSON.stringify(policy);
    expect(text).not.toContain("us-west-2");
    const oidc = `${IAM}oidc-provider/token.actions.githubusercontent.com`;
    for (const [action, resource, region] of [
      ["iam:CreateRole", APP_ROLE, GLOBAL],
      ["iam:CreateRole", `${IAM}role/${DEPLOY_ROLE}`, GLOBAL],
      ["iam:DeleteRole", `${IAM}role/${DEPLOY_ROLE}`, GLOBAL],
      ["iam:DeleteRole", `${IAM}role/ai-extensions-cloud-e2e`, GLOBAL],
      ["iam:PutRolePermissionsBoundary", APP_ROLE, GLOBAL],
      ["iam:DeleteRolePermissionsBoundary", APP_ROLE, GLOBAL],
      ["iam:CreateOpenIDConnectProvider", oidc, GLOBAL],
      ["iam:DeleteOpenIDConnectProvider", oidc, GLOBAL],
      ["eks:DeleteCluster", MAIN_CLUSTER_ARN, MAIN_REGION],
      [
        "eks:DeleteNodegroup",
        `arn:aws:eks:${MAIN_REGION}:${ACCOUNT}:nodegroup/${MAIN_CLUSTER}/default/${NODEGROUP_ID}`,
        MAIN_REGION
      ],
      [
        "ec2:DeleteVpc",
        `arn:aws:ec2:${MAIN_REGION}:${ACCOUNT}:vpc/vpc-0123456789abcdef0`,
        MAIN_REGION
      ]
    ] as const)
      expect(
        evaluateIam(
          { action, resource, context: { "aws:RequestedRegion": region! } },
          [policy]
        )
      ).toBe("implicitDeny");
  });

  it("lets the test role create, tag, and delete only the fixture repository's app boundaries", async () => {
    const policy = await rendered("test-role-policy.json");
    const owner = (prefix: string, repositoryId = VALUES.FIXTURE_REPO_ID!) => ({
      [`aws:${prefix}/${AWS_MANAGED_TAG}`]: "true",
      [`aws:${prefix}/${AWS_REPOSITORY_ID_TAG}`]: repositoryId
    });
    const decide = (
      action: string,
      resource: string,
      context: Record<string, string> = {},
      statements: unknown[] = policy.Statement
    ) =>
      evaluateIam(
        {
          action,
          resource,
          context: { "aws:RequestedRegion": GLOBAL, ...context }
        },
        [{ ...policy, Statement: statements }]
      );
    // The product tags the boundary it creates with these, and reads it first.
    for (const action of ["iam:CreatePolicy", "iam:TagPolicy"])
      expect(decide(action, APP_BOUNDARY, owner("RequestTag"))).toBe("allowed");
    expect(decide("iam:DeletePolicy", APP_BOUNDARY, owner("ResourceTag"))).toBe(
      "allowed"
    );
    for (const action of ["iam:GetPolicy", "iam:GetPolicyVersion"])
      expect(decide(action, APP_BOUNDARY)).toBe("allowed");
    // The lock policy's grant alone covers none of them.
    const lockOnly = policy.Statement.filter(
      (item: Statement) => item.Sid === "DeployRoleLock"
    );
    expect(
      decide("iam:CreatePolicy", APP_BOUNDARY, owner("RequestTag"), lockOnly)
    ).toBe("implicitDeny");
    expect(
      decide("iam:DeletePolicy", APP_BOUNDARY, owner("ResourceTag"), lockOnly)
    ).toBe("implicitDeny");
    for (const [action, resource, context] of [
      ["iam:CreatePolicy", APP_BOUNDARY, {}],
      ["iam:CreatePolicy", APP_BOUNDARY, owner("RequestTag", "42")],
      [
        "iam:CreatePolicy",
        APP_BOUNDARY,
        {
          [`aws:RequestTag/${AWS_REPOSITORY_ID_TAG}`]: VALUES.FIXTURE_REPO_ID!
        }
      ],
      ["iam:TagPolicy", APP_BOUNDARY, owner("RequestTag", "42")],
      ["iam:DeletePolicy", APP_BOUNDARY, {}],
      ["iam:DeletePolicy", APP_BOUNDARY, owner("ResourceTag", "42")],
      [
        "iam:CreatePolicy",
        `${IAM}policy/radius/apps/42/radtest-aws-1/b`,
        owner("RequestTag")
      ],
      [
        "iam:DeletePolicy",
        `${IAM}policy/ai-extensions-cloud-e2e-deploy-boundary`,
        owner("ResourceTag")
      ],
      ["iam:CreatePolicyVersion", APP_BOUNDARY, owner("ResourceTag")]
    ] as const)
      expect(decide(action, resource, context)).toBe("implicitDeny");
  });

  it("lets the test role delete only the fixture repository's app roles and Pod Identity associations", async () => {
    const policy = await rendered("test-role-policy.json");
    const decide = (action: string, resource: string, region = GLOBAL) =>
      evaluateIam(
        { action, resource, context: { "aws:RequestedRegion": region } },
        [policy]
      );
    for (const action of ["iam:DeleteRolePolicy", "iam:DeleteRole"])
      expect(decide(action, APP_ROLE)).toBe("allowed");
    for (const [region, cluster] of CLUSTERS)
      expect(
        decide(
          "eks:DeletePodIdentityAssociation",
          `arn:aws:eks:${region}:${VALUES.ACCOUNT}:podidentityassociation/${cluster}/a-1`,
          region
        )
      ).toBe("allowed");
    for (const [action, resource] of [
      ["iam:DeleteRole", `${IAM}role/radius/apps/42/radtest-aws-1/web`],
      ["iam:DeleteRole", `${IAM}role/${APP_ROLE_NAME}`],
      ["iam:PutRolePolicy", APP_ROLE]
    ] as const)
      expect(decide(action, resource)).toBe("implicitDeny");
    expect(
      decide(
        "eks:DeletePodIdentityAssociation",
        `arn:aws:eks:us-west-2:${VALUES.ACCOUNT}:podidentityassociation/other/a-1`,
        "us-west-2"
      )
    ).toBe("implicitDeny");
  });

  it("lets the test role make every AWS call the sweep and its check make", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, "radtest-aws-aaaa11112222", { deployed: true });
    await addAwsEnvironment(s, "radtest-aws-bbbb33334444", {
      cluster: "second"
    });
    s.appDelete.set("radtest-aws-aaaa11112222", "leave");
    s.aws.rds.addSnapshot({
      id: "rds-snapshot-mysql-aaaa11112222",
      region: VALUES.MAIN_REGION!,
      vpcId: MAIN_VPC,
      tags: recipeTags("radtest-aws-aaaa11112222")
    });
    s.aws.addNodegroup(VALUES.MAIN_REGION!, VALUES.MAIN_CLUSTER!, "default", {
      minSize: 0,
      maxSize: 2,
      desiredSize: 1
    });
    expect((await runSweep(s)).failures).toEqual([]);
    expect((await runVerify(s)).findings).toEqual([]);
    const policy = await rendered("test-role-policy.json");
    const requests = s.outside.calls
      .filter((call) => call.service === "aws" && call.command !== "--version")
      .map((call) => cliRequest(call.args));
    expect(requests.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        "rds:deletedbinstance",
        "rds:deletedbsnapshot",
        "eks:updatenodegroupconfig",
        "eks:deleteaccessentry",
        "iam:updateassumerolepolicy",
        "iam:createpolicy"
      ])
    );
    // Each call against the resource it names, in its region.
    expect(
      requests.filter((item) => evaluateIam(item, [policy]) !== "allowed")
    ).toEqual([]);
  });

  it("allows the deploy role every app-role action the product grants it, and nothing it denies", async () => {
    const boundary = await rendered("deploy-role-boundary.json");
    const granted = buildAwsAppRolesPolicy(
      VALUES.ACCOUNT!,
      Number(VALUES.FIXTURE_REPO_ID)
    );
    const allowed = productRequests(granted, "Allow");
    expect(allowed.length).toBeGreaterThan(0);
    for (const request of allowed)
      expect({
        request,
        decision: evaluateIam(request, [granted], boundary)
      }).toEqual({ request, decision: "allowed" });
    for (const request of productRequests(granted, "Deny"))
      expect(evaluateIam(request, [granted], boundary)).toBe("explicitDeny");
  });

  it("allows the deploy role what Cloud Control needs for the pinned containers Recipe", async () => {
    const boundary = await rendered("deploy-role-boundary.json");
    const decisions = recipeRequests().map((request) => ({
      request,
      decision: evaluateIam(request, deployRoleIdentity(), boundary)
    }));
    // Cloud Control removes a boundary only when the Recipe stops setting
    // one, and it always sets one.
    expect(
      decisions.filter(
        ({ request, decision }) =>
          decision !==
          (request.action === "iam:DeleteRolePermissionsBoundary" ?
            "explicitDeny"
          : "allowed")
      )
    ).toEqual([]);
  });

  it.each(DEPLOY_ROLE_CASES)(
    "gives the deploy role $decision for $action on $resource",
    async ({ action, resource, context, decision }) => {
      const boundary = await rendered("deploy-role-boundary.json");
      expect(
        evaluateIam(
          { action, resource, context },
          deployRoleIdentity(),
          boundary
        )
      ).toBe(decision);
    }
  );

  it("limits the deploy role's recipe services to the two test regions", async () => {
    const boundary = await rendered("deploy-role-boundary.json");
    const recipes = boundary.Statement.find(
      (item: Statement) => item.Sid === "RecipeServicesInTestRegions"
    );
    expect(recipes.Condition.StringEquals["aws:RequestedRegion"]).toEqual([
      VALUES.MAIN_REGION,
      VALUES.SECOND_REGION
    ]);
    expect(JSON.stringify(boundary)).not.toContain("us-west-2");
  });

  it("builds the clusters the sweep and the journey expect", async () => {
    const main = await rendered("main-cluster.yaml");
    const second = await rendered("second-cluster.yaml");
    for (const [config, name, region] of [
      [main, VALUES.MAIN_CLUSTER, VALUES.MAIN_REGION],
      [second, VALUES.SECOND_CLUSTER, VALUES.SECOND_REGION]
    ]) {
      expect(config.metadata).toMatchObject({ name, region });
      expect(config.accessConfig.authenticationMode).toBe("API");
      expect(config.vpc.clusterEndpoints).toEqual({
        publicAccess: true,
        privateAccess: false
      });
      expect(config.vpc.nat).toEqual({ gateway: "Disable" });
    }
    expect(main.addons.map((addon: { name: string }) => addon.name)).toContain(
      "eks-pod-identity-agent"
    );
    // The isolated group is added by the runbook, with its own launch template.
    expect(
      main.managedNodeGroups.map((group: { name: string }) => group.name)
    ).toEqual(AWS_MAIN_NODE_GROUPS.filter((name) => name !== "isolated"));
    expect(second.managedNodeGroups).toBeUndefined();
  });

  it("budgets only the two test regions", async () => {
    expect((await rendered("budget.json")).CostFilters).toEqual({
      Region: [VALUES.MAIN_REGION, VALUES.SECOND_REGION]
    });
    expect(
      (await rendered("budget-notifications.json")).map(
        (item: { Notification: { NotificationType: string } }) =>
          item.Notification.NotificationType
      )
    ).toEqual(["ACTUAL", "FORECASTED"]);
  });
});
