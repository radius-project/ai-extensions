import { describe, expect, it } from "vitest";
import {
  buildGitHubTrustPolicy,
  parsePolicyDocument,
  trustedGitHubSubjects
} from "@radius-project/core";
import type { GitHubJsonResponse } from "../../azure-oidc.js";
import type { SelectedGhExecutor } from "../../gh.js";
import type { AwsCommandResult } from "./aws-deploy-identity.js";
import { createAwsEnvironmentAccess } from "./aws-environment-access.js";

const ACCOUNT = "123456789012";
const ROLE = "radius-deploy-octo-shop";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
const DEV = "repo:octo/shop:environment:dev";
const PROD = "repo:octo/shop:environment:prod";
const STAGE = "authorize-identity";
const EXECUTOR = { login: "saved-account" } as unknown as SelectedGhExecutor;

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

const happyPath: Record<string, AwsCommandResult> = {
  "--version": ok("aws-cli/2.17.0 Python/3.11 Darwin/23"),
  "sts get-caller-identity": ok({ Account: ACCOUNT }),
  "eks describe-cluster": ok({
    cluster: { accessConfig: { authenticationMode: "API" } }
  }),
  "iam get-role": fail("An error occurred (NoSuchEntity) when calling GetRole"),
  "iam list-open-id-connect-providers": ok({ OpenIDConnectProviderList: [] }),
  "iam create-open-id-connect-provider": ok(),
  "iam create-role": ok({ Role: { Arn: ROLE_ARN } }),
  "iam put-role-policy": ok(),
  "eks create-access-entry": ok(),
  "eks associate-access-policy": ok()
};

// GitHub answers for octo/shop with the default (not customized) subject.
const defaultSubject: Record<string, GitHubJsonResponse> = {
  "/repos/octo/shop": {
    ok: true,
    status: 200,
    json: { full_name: "octo/shop", id: 42, owner: { id: 7 } }
  },
  "/repos/octo/shop/actions/oidc/customization/sub": {
    ok: false,
    status: 404,
    json: null
  }
};

interface Operation {
  id: string;
}

function harness(
  aws: Record<string, AwsCommandResult>,
  github: Record<string, GitHubJsonResponse> = defaultSubject
) {
  const awsCalls: string[][] = [];
  const githubCalls: Array<{
    path: string;
    executor: SelectedGhExecutor | undefined;
  }> = [];
  const events: unknown[][] = [];
  const access = createAwsEnvironmentAccess<Operation>({
    async runAws(args) {
      awsCalls.push(args);
      const result = aws[args.slice(0, 2).join(" ")];
      if (!result) throw new Error(`unexpected aws ${args.join(" ")}`);
      return result;
    },
    async runGitHubJson(path, executor) {
      githubCalls.push({ path, executor });
      const response = github[path];
      if (!response) throw new Error(`unexpected GitHub read ${path}`);
      return response;
    },
    async sleep(milliseconds) {
      events.push(["sleep", milliseconds]);
    },
    operations: {
      enterStage: (operation, stage) => {
        events.push(["enterStage", operation.id, stage]);
      },
      addLegacyStep: (operation, text, stage) => {
        events.push(["step", operation.id, text, stage]);
      },
      setContext: (operation, patch) => {
        events.push(["setContext", operation.id, patch]);
      }
    },
    store: {
      persist: async () => {
        events.push(["persist"]);
      }
    },
    stageAuthorizeIdentity: STAGE,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  });
  const find = (command: string) =>
    awsCalls.find((args) => args.slice(0, 2).join(" ") === command);
  return { access, awsCalls, githubCalls, events, find };
}

const operation: Operation = { id: "op-1" };
const input = {
  repo: " octo/shop ",
  environment: "dev",
  accountId: ACCOUNT,
  region: "us-west-2",
  cluster: "shop",
  roleName: ""
};

describe("AWS environment access setup", () => {
  it("authorizes a new role for the subject the environment's workflows present", async () => {
    const h = harness(happyPath);

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toEqual({ ok: true, roleArn: ROLE_ARN });
    expect(h.githubCalls).toEqual([
      { path: "/repos/octo/shop", executor: EXECUTOR },
      {
        path: "/repos/octo/shop/actions/oidc/customization/sub",
        executor: EXECUTOR
      }
    ]);
    // No role name was given, so the repository's default role is created.
    expect(h.find("iam create-role")).toEqual(
      expect.arrayContaining(["--role-name", ROLE])
    );
    const createRole = h.find("iam create-role") ?? [];
    const trust = parsePolicyDocument(
      JSON.parse(
        createRole[createRole.indexOf("--assume-role-policy-document") + 1] ??
          "{}"
      )
    );
    expect(trustedGitHubSubjects(trust, ACCOUNT)).toEqual([DEV]);
    expect(h.events[0]).toEqual(["enterStage", "op-1", STAGE]);
    expect(h.events).toContainEqual([
      "step",
      "op-1",
      `ℹ️ Deploy identity will trust ${DEV}`,
      STAGE
    ]);
    // Progress is saved before the role is recorded on the operation.
    expect(h.events.slice(-2)).toEqual([
      ["persist"],
      ["setContext", "op-1", { awsRoleArn: ROLE_ARN }]
    ]);
  });

  it("adds the environment to a role the developer picked", async () => {
    const picked = `arn:aws:iam::${ACCOUNT}:role/team-deployer`;
    const h = harness({
      ...happyPath,
      "iam get-role": ok({
        Role: {
          Arn: picked,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [PROD])
        }
      }),
      "iam list-open-id-connect-providers": ok({
        OpenIDConnectProviderList: [
          {
            Arn: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
          }
        ]
      }),
      "iam get-open-id-connect-provider": ok({
        ClientIDList: ["sts.amazonaws.com"]
      }),
      "iam update-assume-role-policy": ok()
    });

    const result = await h.access.setup(
      operation,
      { ...input, roleName: "ignored", existingRoleArn: ` ${picked} ` },
      EXECUTOR
    );

    expect(result).toEqual({ ok: true, roleArn: picked });
    expect(h.find("iam get-role")).toEqual(
      expect.arrayContaining(["--role-name", "team-deployer"])
    );
    expect(h.find("iam create-role")).toBeUndefined();
  });

  it("stops before AWS when GitHub cannot resolve the subject", async () => {
    const h = harness(happyPath, {
      "/repos/octo/shop": { ok: false, status: 404, json: null }
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "oidc-subject-unresolved"
    });
    expect(result.ok === false && result.error).toContain(
      'Could not read repository "octo/shop"'
    );
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toEqual([["enterStage", "op-1", STAGE]]);
  });

  it("says nothing was created when setup stops before writing to AWS", async () => {
    const h = harness({
      ...happyPath,
      "--version": fail("aws: command not found")
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.ok === false && result.error).toMatch(
      / Nothing was created in AWS\.$/
    );
    expect(h.events.at(-1)).toEqual(["persist"]);
    expect(h.events.some(([kind]) => kind === "setContext")).toBe(false);
  });

  it("names what setup created before it stopped", async () => {
    const h = harness({
      ...happyPath,
      "iam put-role-policy": fail("AccessDenied: iam:PutRolePolicy")
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(
      `Created before setup stopped: the GitHub identity provider in account ${ACCOUNT}, IAM role ${ROLE}. Remove them in the AWS console if you will not retry.`
    );
    expect(h.events.some(([kind]) => kind === "setContext")).toBe(false);
  });
});

describe("AWS environment access removal", () => {
  it("removes the subject the environment's workflows present, read with the ambient account", async () => {
    const h = harness({
      "sts get-caller-identity": ok({ Account: ACCOUNT }),
      "iam get-role": ok({
        Role: {
          Arn: ROLE_ARN,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [DEV, PROD])
        }
      }),
      "iam update-assume-role-policy": ok(),
      "iam delete-role-policy": ok()
    });

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN
    });

    expect(result).toEqual({
      ok: true,
      removed: [`trust subject ${DEV}`, "policy radius-deploy-dev"],
      kept: [`IAM role ${ROLE}`, "the account's GitHub identity provider"]
    });
    expect(h.githubCalls.map(({ executor }) => executor)).toEqual([
      undefined,
      undefined
    ]);
    const update = h.find("iam update-assume-role-policy") ?? [];
    const remaining = parsePolicyDocument(
      JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
    );
    expect(trustedGitHubSubjects(remaining, ACCOUNT)).toEqual([PROD]);
  });
});
