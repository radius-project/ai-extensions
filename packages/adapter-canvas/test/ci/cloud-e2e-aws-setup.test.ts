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
  buildGitHubTrustPolicy,
  removeGitHubTrustSubject
} from "@radius-project/core";
import { AWS_MAIN_NODE_GROUPS } from "../e2e-cloud/support/aws-cloud-cleanup.js";
import {
  addAwsEnvironment,
  createCleanupScenario,
  runSweep,
  runVerify
} from "../support/aws/cleanup-scenario.js";

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

// IAM action names ignore case, and `*` matches any run of characters.
function allows(statements: Statement[], action: string): boolean {
  return statements.some(
    (statement) =>
      statement.Effect === "Allow" &&
      list(statement.Action).some((pattern) =>
        new RegExp(
          `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
          "i"
        ).test(action)
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
    for (const action of [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:PutRolePermissionsBoundary",
      "iam:CreateOpenIDConnectProvider",
      "eks:DeleteCluster",
      "eks:DeleteNodegroup",
      "ec2:DeleteVpc"
    ])
      expect(allows(policy.Statement, action)).toBe(false);
  });

  it("lets the test role make every AWS call the sweep and its check make", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, "radtest-aws-aaaa11112222", { deployed: true });
    await addAwsEnvironment(s, "radtest-aws-bbbb33334444", {
      cluster: "second"
    });
    s.appDelete.set("radtest-aws-aaaa11112222", "leave");
    s.aws.addNodegroup(VALUES.MAIN_REGION!, VALUES.MAIN_CLUSTER!, "default", {
      minSize: 0,
      maxSize: 2,
      desiredSize: 1
    });
    expect((await runSweep(s)).failures).toEqual([]);
    expect((await runVerify(s)).findings).toEqual([]);
    const policy = await rendered("test-role-policy.json");
    const actions = [
      ...new Set(
        s.outside.calls
          .filter(
            (call) => call.service === "aws" && call.command !== "--version"
          )
          .map((call) => `${call.args[0]}:${call.args[1]?.replace(/-/g, "")}`)
      )
    ].sort();
    expect(actions).toContain("rds:deletedbinstance");
    expect(actions).toContain("eks:updatenodegroupconfig");
    expect(actions).toContain("iam:updateassumerolepolicy");
    expect(
      actions.filter((action) => !allows(policy.Statement, action))
    ).toEqual([]);
  });

  it("keeps the deploy role away from IAM, account settings, and other regions", async () => {
    const boundary = await rendered("deploy-role-boundary.json");
    const deny = boundary.Statement.find(
      (item: Statement) => item.Effect === "Deny"
    );
    expect(list(deny.Action)).toEqual(
      expect.arrayContaining(["iam:*", "s3:PutAccountPublicAccessBlock"])
    );
    const recipes = boundary.Statement.find(
      (item: Statement) => item.Sid === "RecipeServicesInTestRegions"
    );
    expect(recipes.Condition.StringEquals["aws:RequestedRegion"]).toEqual([
      VALUES.MAIN_REGION,
      VALUES.SECOND_REGION
    ]);
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
