import { describe, expect, it, vi } from "vitest";
import {
  buildAwsEnvironmentPermissionPolicy,
  buildGitHubTrustPolicy,
  parsePolicyDocument,
  trustedGitHubSubjects
} from "@radius-project/core";
import { awsEnvironmentPolicyName } from "../../aws-deploy-role-name.js";
import type { GitHubJsonResponse } from "../../azure-oidc.js";
import type { SelectedGhExecutor } from "../../gh.js";
import type { AwsCommandResult } from "./aws-deploy-identity.js";
import { createAwsEnvironmentAccess } from "./aws-environment-access.js";
import type { AwsSetupJournal } from "./aws-setup-journal.js";
import {
  addLegacyStep,
  buildStages,
  createOperation,
  finishSucceeded,
  toPersistedOperation,
  fromPersistedOperation
} from "../../operations.js";

const ACCOUNT = "123456789012";
const ROLE = "radius-deploy-octo-shop";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
const DEV = "repo:octo/shop:environment:dev";
const PROD = "repo:octo/shop:environment:prod";
// The ID-based form GitHub issues for octo (owner 7) / shop (repository 42).
const DEV_ID = "repo:octo@7/shop@42:environment:dev";
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

const LOCK_ARN = `arn:aws:iam::${ACCOUNT}:policy/radius-lock-${ROLE}`;
const lockPolicy = (policyId: string, extra: Record<string, unknown> = {}) =>
  ok({ Policy: { PolicyId: policyId, Arn: LOCK_ARN, ...extra } });

// A list answers successive calls in order, repeating its last entry.
type Answer = AwsCommandResult | AwsCommandResult[];

const lockFree: Record<string, Answer> = {
  "iam get-role-policy": fail("NoSuchEntity"),
  "iam list-role-policies": ok({
    PolicyNames: ["radius-deploy-dev-f5fb7acf8f59"]
  }),
  "iam create-policy": lockPolicy("LOCK1"),
  "iam get-policy": lockPolicy("LOCK1"),
  "iam delete-policy": ok()
};

const happyPath: Record<string, Answer> = {
  ...lockFree,
  "--version": ok("aws-cli/2.17.0 Python/3.11 Darwin/23"),
  "sts get-caller-identity": ok({ Account: ACCOUNT }),
  "eks describe-cluster": ok({
    cluster: { status: "ACTIVE", accessConfig: { authenticationMode: "API" } }
  }),
  "iam get-role": fail("An error occurred (NoSuchEntity) when calling GetRole"),
  "iam list-open-id-connect-providers": ok({ OpenIDConnectProviderList: [] }),
  "iam create-open-id-connect-provider": ok(),
  "iam create-role": ok({ Role: { Arn: ROLE_ARN } }),
  "iam put-role-policy": ok(),
  "eks create-access-entry": ok(),
  "eks associate-access-policy": ok()
};

// GitHub answers for octo/shop with the default subject, as github.com
// reports it: an older repository has `use_immutable_subject: false` and its
// tokens may carry either form, a new one has `true` and only the ID-based form.
function githubSubjects(
  useImmutableSubject: boolean
): Record<string, GitHubJsonResponse> {
  return {
    "/repos/octo/shop/environments/prod/variables?per_page=100": {
      ok: true,
      status: 200,
      json: { variables: [] }
    },
    "/repos/octo/shop/environments/dev/variables?per_page=100": {
      ok: true,
      status: 200,
      json: { variables: [] }
    },
    "/repos/octo/shop": {
      ok: true,
      status: 200,
      json: { full_name: "octo/shop", id: 42, owner: { id: 7 } }
    },
    "/repos/octo/shop/actions/oidc/customization/sub": {
      ok: true,
      status: 200,
      json: {
        use_default: true,
        use_immutable_subject: useImmutableSubject,
        ...(useImmutableSubject ?
          { sub_claim_prefix: "repo:octo@7/shop@42" }
        : {})
      }
    },
    // GitHub's stored spelling, which Repair builds the subjects from.
    "/repos/octo/shop/environments/dev": {
      ok: true,
      status: 200,
      json: { name: "dev" }
    }
  };
}
const defaultSubject = githubSubjects(false);

// GitHub answers for octo/shop with a subject customized to these claim keys.
function customTemplate(
  includeClaimKeys: string[]
): Record<string, GitHubJsonResponse> {
  return {
    ...defaultSubject,
    "/repos/octo/shop/actions/oidc/customization/sub": {
      ok: true,
      status: 200,
      json: {
        use_default: false,
        include_claim_keys: includeClaimKeys,
        use_immutable_subject: false
      }
    }
  };
}

interface Operation {
  id: string;
}

// The repository's GitHub environments: each one's variables, or the reason
// reading them fails. A string in place of the whole map fails the listing.
type Environments = Record<string, Record<string, string> | string> | string;

function harness(
  aws: Record<string, Answer>,
  github: Record<string, GitHubJsonResponse> = defaultSubject,
  // The customer pauses while this AWS command, or the last GitHub read, runs.
  pauseDuring?: string,
  persistError?: Error,
  environments?: Environments,
  journal?: AwsSetupJournal<Operation>
) {
  const environmentReads: string[] = [];
  let stopRequested = false;
  const stoppedOperations = new Set<string>();
  const awsCalls: string[][] = [];
  const githubCalls: Array<{
    path: string;
    executor: SelectedGhExecutor | undefined;
  }> = [];
  const events: unknown[][] = [];
  const contexts = new Map<string, Record<string, unknown>>();
  const persistedContexts = new Map<string, Record<string, unknown>>();
  let clock = Date.parse("2026-10-30T12:00:00Z");
  let writtenTrust: unknown = undefined;
  const access = createAwsEnvironmentAccess<Operation>({
    async runAws(args) {
      awsCalls.push(args);
      const command = args.slice(0, 2).join(" ");
      const scripted = aws[command];
      const result =
        Array.isArray(scripted) ?
          scripted.length > 1 ?
            scripted.shift()
          : scripted[0]
        : scripted;
      if (!result) throw new Error(`unexpected aws ${args.join(" ")}`);
      // `command@n` pauses during the nth call of that command.
      const count = awsCalls.filter(
        (call) => call.slice(0, 2).join(" ") === command
      ).length;
      if (command === pauseDuring || `${command}@${count}` === pauseDuring) {
        stopRequested = true;
      }
      // IAM shows a trust update to the reads that follow it.
      if (command === "iam update-assume-role-policy" && result.code === 0) {
        writtenTrust = JSON.parse(
          args[args.indexOf("--policy-document") + 1] ?? "null"
        );
      }
      if (command === "iam get-role" && writtenTrust !== undefined) {
        const record = JSON.parse(result.stdout || "{}");
        return ok({
          ...record,
          Role: { ...record.Role, AssumeRolePolicyDocument: writtenTrust }
        });
      }
      return result;
    },
    async runGitHubJson(path, executor) {
      githubCalls.push({ path, executor });
      const response = github[path];
      if (!response) throw new Error(`unexpected GitHub read ${path}`);
      if (
        (pauseDuring === "github" && path.endsWith("/customization/sub")) ||
        (pauseDuring === "saved-policy" &&
          path.endsWith("/variables?per_page=100"))
      ) {
        stopRequested = true;
      }
      return response;
    },
    environments: {
      async listEnvironmentNames(repo) {
        if (environments === undefined) {
          throw new Error(`unexpected environment listing for ${repo}`);
        }
        return typeof environments === "string" ?
            { ok: false, reason: environments }
          : { ok: true, names: Object.keys(environments) };
      },
      async readEnvironmentVariables(_repo, name) {
        environmentReads.push(name);
        const variables =
          typeof environments === "object" ? environments[name] : undefined;
        if (variables === undefined) {
          throw new Error(`unexpected variable read for ${name}`);
        }
        return typeof variables === "string" ?
            { ok: false, reason: variables }
          : { ok: true, variables };
      }
    },
    isStopRequested: () => stopRequested,
    isStoppedOperation: (operationId) => stoppedOperations.has(operationId),
    operationId: (operation) => operation.id,
    now: () => clock,
    async sleep(milliseconds) {
      events.push(["sleep", milliseconds]);
      clock += milliseconds;
      if (pauseDuring === "sleep") stopRequested = true;
    },
    operations: {
      getContext: (operation) => contexts.get(operation.id) ?? {},
      enterStage: (operation, stage) => {
        events.push(["enterStage", operation.id, stage]);
      },
      setStageState: (operation, stage, state) => {
        events.push(["setStageState", operation.id, stage, state]);
      },
      addLegacyStep: (operation, text, stage) => {
        events.push(["step", operation.id, text, stage]);
      },
      setContext: (operation, patch) => {
        events.push(["setContext", operation.id, patch]);
        contexts.set(operation.id, { ...contexts.get(operation.id), ...patch });
      },
      touch: (operation) => {
        events.push(["touch", operation.id]);
      }
    },
    store: {
      persist: async () => {
        events.push(["persist"]);
        if (persistError) throw persistError;
        for (const [id, context] of contexts) {
          persistedContexts.set(id, JSON.parse(JSON.stringify(context)));
        }
      }
    },
    stageAuthorizeIdentity: STAGE,
    ...(journal ? { journal } : {}),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  });
  const find = (command: string) =>
    awsCalls.find((args) => args.slice(0, 2).join(" ") === command);
  const commands = () => awsCalls.map((args) => args.slice(0, 2).join(" "));
  const steps = () =>
    events.filter(([kind]) => kind === "step").map(([, , text]) => text);
  // Whether setup recorded the role on the operation.
  const roleRecorded = () =>
    events.some(
      ([kind, , patch]) =>
        kind === "setContext" &&
        typeof patch === "object" &&
        patch !== null &&
        "awsRoleArn" in patch
    );
  return {
    access,
    awsCalls,
    githubCalls,
    events,
    contexts,
    persistedContexts,
    environmentReads,
    find,
    commands,
    steps,
    roleRecorded,
    stoppedOperations,
    requestStop: () => {
      stopRequested = true;
    }
  };
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
  it.each([
    "legacy deletion failed",
    "quota replacement restored the legacy grant"
  ])("finishes legacy migration on retry after %s", async (failure) => {
    const quota = failure.startsWith("quota");
    const script = {
      ...happyPath,
      "iam get-role": ok({
        Role: {
          Arn: ROLE_ARN,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
            DEV,
            DEV_ID
          ])
        }
      }),
      "iam get-role-policy": ok({
        PolicyName: "radius-deploy-dev",
        PolicyDocument: buildAwsEnvironmentPermissionPolicy("us-west-2")
      }),
      "iam list-role-policies": ok({ PolicyNames: ["radius-deploy-dev"] })
    };
    const first = harness(
      {
        ...script,
        "iam put-role-policy":
          quota ? [fail("LimitExceeded"), fail("AccessDenied"), ok()] : ok(),
        "iam delete-role-policy": quota ? ok() : fail("AccessDenied")
      },
      defaultSubject
    );
    const setup = { ...input, existingRoleArn: ROLE_ARN };
    expect(await first.access.setup(operation, setup, EXECUTOR)).toMatchObject({
      ok: false
    });
    await first.access.release(operation);
    const saved = first.persistedContexts.get(operation.id);
    if (!saved) throw new Error("Missing persisted policy identity");
    const retry = harness(
      {
        ...script,
        "iam put-role-policy": quota ? [fail("LimitExceeded"), ok()] : ok(),
        "iam delete-role-policy": ok()
      },
      defaultSubject
    );
    retry.contexts.set(operation.id, saved);
    expect(await retry.access.setup(operation, setup, EXECUTOR)).toMatchObject({
      ok: true
    });
    expect(retry.find("iam get-role-policy")).toContain("radius-deploy-dev");
    expect(retry.find("iam delete-role-policy")).toContain("radius-deploy-dev");
    expect(retry.find("iam put-role-policy")).toContain(
      "radius-deploy-dev-f5fb7acf8f59"
    );
  });

  it.each(["failure", "pause"])(
    "recovers the policy identity after an EKS %s and a repository rename",
    async (outcome) => {
      const role = ok({
        Role: {
          Arn: ROLE_ARN,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
            DEV,
            DEV_ID
          ])
        }
      });
      const first = harness(
        {
          ...happyPath,
          "iam get-role": role,
          "iam list-role-policies": ok({ PolicyNames: [] }),
          "eks create-access-entry": fail("AccessDenied")
        },
        defaultSubject,
        outcome === "pause" ? "eks create-access-entry" : undefined
      );
      const setup = { ...input, existingRoleArn: ROLE_ARN };
      expect(
        await first.access.setup(operation, setup, EXECUTOR)
      ).toMatchObject({ ok: false });
      await first.access.release(operation);
      const saved = first.persistedContexts.get(operation.id);
      expect(saved).toMatchObject({
        awsPolicyIdentity: {
          repoId: 42,
          environment: "dev",
          roleArn: ROLE_ARN,
          policyName: "radius-deploy-dev-f5fb7acf8f59"
        }
      });
      if (!saved) throw new Error("The partial setup was not persisted");
      const retry = harness(
        {
          ...happyPath,
          "iam get-role": role,
          "iam update-assume-role-policy": ok()
        },
        {
          "/repos/octo/renamed": {
            ok: true,
            status: 200,
            json: { full_name: "octo/renamed", id: 42, owner: { id: 7 } }
          },
          "/repos/octo/renamed/actions/oidc/customization/sub": {
            ok: true,
            status: 200,
            json: { use_default: true, use_immutable_subject: false }
          },
          "/repos/octo/renamed/environments/dev/variables?per_page=100": {
            ok: true,
            status: 200,
            json: { variables: [] }
          }
        }
      );
      const persisted = toPersistedOperation({
        ...createOperation({
          provider: "aws",
          repo: "octo/shop",
          environment: "dev"
        }),
        context: saved
      });
      const restored = fromPersistedOperation(
        JSON.parse(JSON.stringify(persisted))
      );
      retry.contexts.set(operation.id, restored.context);
      expect(
        await retry.access.setup(
          operation,
          { ...setup, repo: "octo/renamed" },
          EXECUTOR
        )
      ).toMatchObject({
        ok: true,
        policyName: "radius-deploy-dev-f5fb7acf8f59"
      });
      expect(retry.find("iam put-role-policy")).toContain(
        "radius-deploy-dev-f5fb7acf8f59"
      );
      expect(retry.find("iam put-role-policy")).not.toContain(
        awsEnvironmentPolicyName("octo/renamed", "dev")
      );
    }
  );

  const recordedPolicyIdentity = {
    repoId: 42,
    environment: "dev",
    roleArn: ROLE_ARN,
    policyName: "radius-deploy-dev-f5fb7acf8f59"
  };
  it.each([
    null,
    {},
    { ...recordedPolicyIdentity, repoId: 99 },
    { ...recordedPolicyIdentity, environment: "prod" },
    { ...recordedPolicyIdentity, roleArn: `${ROLE_ARN}-other` },
    { ...recordedPolicyIdentity, policyName: "unrelated" }
  ])(
    "rejects a partial policy binding that does not match setup: %j",
    async (identity) => {
      const h = harness(happyPath, defaultSubject);
      h.contexts.set(operation.id, {
        awsPolicyIdentity: identity
      });
      expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
        ok: false,
        code: "aws-policy-name-unresolved"
      });
      expect(h.awsCalls).toEqual([]);
    }
  );

  it("refuses conflicting GitHub and partial-operation policy identities", async () => {
    const h = harness(happyPath, {
      ...defaultSubject,
      "/repos/octo/shop/environments/dev/variables?per_page=100": {
        ok: true,
        status: 200,
        json: {
          variables: [
            { name: "AWS_ROLE_ARN", value: ROLE_ARN },
            {
              name: "AWS_PERMISSION_POLICY_NAME",
              value: "radius-deploy-dev-111111111111"
            }
          ]
        }
      }
    });
    h.contexts.set(operation.id, { awsPolicyIdentity: recordedPolicyIdentity });
    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: false,
      code: "aws-policy-name-unresolved"
    });
    expect(h.awsCalls).toEqual([]);
  });

  it.each([42, 77])(
    "uses immutable ownership without access to the other GitHub repository (%s)",
    async (foreignId) => {
      const h = harness(
        {
          ...happyPath,
          "iam get-role": ok({
            Role: {
              Arn: ROLE_ARN,
              AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
                `repo:octo@7/other@${foreignId}:environment:dev`
              ])
            }
          }),
          "iam list-role-policies": ok({
            PolicyNames: [awsEnvironmentPolicyName("octo/other", "dev")]
          }),
          "iam update-assume-role-policy": ok()
        },
        defaultSubject
      );
      expect(
        await h.access.setup(
          operation,
          { ...input, existingRoleArn: ROLE_ARN },
          EXECUTOR
        )
      ).toMatchObject({ ok: foreignId !== 42 });
      expect(
        h.githubCalls.some((call) => call.path.includes("/octo/other"))
      ).toBe(false);
      if (foreignId === 42)
        expect(h.find("iam put-role-policy")).toBeUndefined();
    }
  );

  it.each([42, 77])(
    "checks another grant's GitHub repository ID and saved binding (%s)",
    async (foreignId) => {
      const foreignName = awsEnvironmentPolicyName("octo/other", "dev");
      const h = harness(
        {
          ...happyPath,
          "iam get-role": ok({
            Role: {
              Arn: ROLE_ARN,
              AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
                "repo:octo/other:environment:dev"
              ])
            }
          }),
          "iam list-role-policies": ok({ PolicyNames: [foreignName] }),
          "iam update-assume-role-policy": ok()
        },
        {
          ...defaultSubject,
          "/repos/octo/other": {
            ok: true,
            status: 200,
            json: { full_name: "octo/other", id: foreignId, owner: { id: 7 } }
          },
          "/repos/octo/other/actions/oidc/customization/sub": {
            ok: false,
            status: 404,
            json: null
          },
          "/repos/octo/other/environments/dev/variables?per_page=100": {
            ok: true,
            status: 200,
            json: {
              variables: [
                { name: "AWS_ROLE_ARN", value: ROLE_ARN },
                { name: "AWS_PERMISSION_POLICY_NAME", value: foreignName }
              ]
            }
          }
        }
      );
      const result = await h.access.setup(
        operation,
        { ...input, existingRoleArn: ROLE_ARN },
        EXECUTOR
      );
      expect(result).toMatchObject({ ok: foreignId !== 42 });
      if (foreignId === 42) {
        expect(h.find("iam put-role-policy")).toBeUndefined();
        expect(h.find("iam update-assume-role-policy")).toBeUndefined();
      } else {
        expect(h.find("iam put-role-policy")).toContain(
          "radius-deploy-dev-f5fb7acf8f59"
        );
      }
    }
  );

  it("reuses a saved policy from before a rename instead of creating a second grant", async () => {
    const policyName = awsEnvironmentPolicyName("octo/old", "dev");
    const h = harness(
      {
        ...happyPath,
        "iam get-role": ok({
          Role: {
            Arn: ROLE_ARN,
            AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
              DEV,
              DEV_ID
            ])
          }
        })
      },
      {
        ...defaultSubject,
        "/repos/octo/shop/environments/dev/variables?per_page=100": {
          ok: true,
          status: 200,
          json: {
            variables: [
              { name: "AWS_PERMISSION_POLICY_NAME", value: policyName },
              { name: "AWS_ROLE_ARN", value: ROLE_ARN }
            ]
          }
        }
      }
    );
    expect(
      await h.access.setup(
        operation,
        { ...input, existingRoleArn: ROLE_ARN },
        EXECUTOR
      )
    ).toMatchObject({ ok: true, policyName });
    expect(h.find("iam put-role-policy")).toContain(policyName);
    expect(h.find("iam get-role-policy")).toBeUndefined();
  });

  it.each([
    { ok: false, status: 403 },
    { ok: true, status: 200, json: {} },
    { ok: true, status: 200, json: { variables: [null] } },
    {
      ok: true,
      status: 200,
      json: { variables: [{ name: "AWS_PERMISSION_POLICY_NAME", value: 42 }] }
    },
    {
      ok: true,
      status: 200,
      json: {
        variables: [
          { name: "AWS_PERMISSION_POLICY_NAME", value: "invalid" },
          { name: "AWS_ROLE_ARN", value: ROLE_ARN }
        ]
      }
    },
    {
      ok: true,
      status: 200,
      json: {
        variables: [
          {
            name: "AWS_PERMISSION_POLICY_NAME",
            value: "radius-deploy-dev-111111111111"
          },
          { name: "AWS_ROLE_ARN", value: `${ROLE_ARN}-other` }
        ]
      }
    }
  ])(
    "stops before AWS for denied, damaged or conflicting saved policy metadata: %j",
    async (response) => {
      const h = harness(happyPath, {
        ...defaultSubject,
        "/repos/octo/shop/environments/dev/variables?per_page=100": response
      });
      expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
        ok: false,
        code: "aws-policy-name-unresolved"
      });
      expect(h.awsCalls).toEqual([]);
    }
  );

  it("allows a new environment without saved configuration", async () => {
    const h = harness(happyPath, {
      ...defaultSubject,
      "/repos/octo/shop/environments/dev/variables?per_page=100": {
        ok: false,
        status: 404
      }
    });
    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });
  });

  it("honors a pause during the saved-policy read before making any AWS call", async () => {
    const h = harness(happyPath, defaultSubject, "saved-policy");
    expect(await h.access.setup(operation, input, EXECUTOR)).toEqual({
      ok: false,
      stopped: true
    });
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toContainEqual([
      "setStageState",
      operation.id,
      STAGE,
      "paused"
    ]);
  });

  it("keeps the identity stage paused when its saved-policy read fails during Stop", async () => {
    const h = harness(
      happyPath,
      {
        ...defaultSubject,
        "/repos/octo/shop/environments/dev/variables?per_page=100": {
          ok: false,
          status: 403,
          stderr: "Access denied"
        }
      },
      "saved-policy"
    );
    expect(await h.access.setup(operation, input, EXECUTOR)).toEqual({
      ok: false,
      stopped: true
    });
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toContainEqual([
      "setStageState",
      operation.id,
      STAGE,
      "paused"
    ]);
  });

  it("hashes GitHub's canonical repository name rather than a stale alias", async () => {
    const h = harness(happyPath, {
      "/repos/octo/shop": {
        ok: true,
        status: 200,
        json: { full_name: "octo/renamed", id: 42, owner: { id: 7 } }
      },
      "/repos/octo/renamed/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: { use_default: true, use_immutable_subject: false }
      },
      "/repos/octo/renamed/environments/dev/variables?per_page=100": {
        ok: true,
        status: 200,
        json: { variables: [] }
      }
    });
    const result = await h.access.setup(operation, input, EXECUTOR);
    const policyName = awsEnvironmentPolicyName("octo/renamed", "dev");
    expect(result).toMatchObject({ ok: true, policyName });
    expect(h.find("iam put-role-policy")).toContain(policyName);
    expect(h.find("iam put-role-policy")).not.toContain(
      awsEnvironmentPolicyName("octo/shop", "dev")
    );
    expect(h.events).toContainEqual([
      "setContext",
      "op-1",
      expect.objectContaining({ awsPolicyName: policyName })
    ]);
  });

  it("reports an interrupted quota migration without restoring through a pause", async () => {
    const h = harness(
      {
        ...happyPath,
        "iam get-role": ok({
          Role: {
            Arn: ROLE_ARN,
            AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [
              DEV,
              DEV_ID
            ])
          }
        }),
        "iam get-role-policy": ok({
          PolicyName: "radius-deploy-dev",
          PolicyDocument: buildAwsEnvironmentPermissionPolicy("us-west-2")
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
        "iam put-role-policy": fail("LimitExceeded"),
        "iam delete-role-policy": ok()
      },
      defaultSubject,
      "iam delete-role-policy"
    );
    expect(
      await h.access.setup(
        operation,
        { ...input, existingRoleArn: ROLE_ARN },
        EXECUTOR
      )
    ).toEqual({ ok: false, stopped: true });
    expect(
      h.commands().filter((command) => command === "iam put-role-policy")
    ).toHaveLength(1);
    expect(h.steps().join("\n")).toContain(
      "This environment's grant may be missing"
    );
    expect(h.steps().join("\n")).toContain("Paused after AWS policy changes");
    expect(h.roleRecorded()).toBe(false);
    expect(h.events).toContainEqual([
      "setStageState",
      operation.id,
      STAGE,
      "paused"
    ]);
  });

  it("preserves partial progress when paused during the EKS retry delay", async () => {
    const h = harness(
      {
        ...happyPath,
        "eks create-access-entry": fail("InvalidParameterException")
      },
      defaultSubject,
      "sleep"
    );

    await expect(h.access.setup(operation, input, EXECUTOR)).resolves.toEqual({
      ok: false,
      stopped: true
    });

    expect(h.events).toContainEqual(["sleep", 2000]);
    expect(
      h.awsCalls.filter(
        (args) => args.slice(0, 2).join(" ") === "eks create-access-entry"
      )
    ).toHaveLength(1);
    expect(h.find("eks associate-access-policy")).toBeUndefined();
    expect(h.events).toContainEqual([
      "step",
      operation.id,
      `⏸️ Paused before the next AWS change. Created before the pause: the GitHub identity provider in account ${ACCOUNT}, IAM role ${ROLE}, policy radius-deploy-dev-f5fb7acf8f59 on ${ROLE}.`,
      STAGE
    ]);
    expect(h.events.at(-1)).toEqual(["persist"]);
  });

  it.each([
    "github",
    "iam create-role",
    "eks associate-access-policy",
    undefined
  ])(
    "propagates persistence failure rather than claiming a saved pause or success (%s)",
    async (pauseDuring) => {
      const error = new Error("AWS progress storage unavailable");
      const h = harness(happyPath, defaultSubject, pauseDuring, error);

      await expect(h.access.setup(operation, input, EXECUTOR)).rejects.toBe(
        error
      );
      expect(h.events.at(-1)).toEqual(["persist"]);
      if (pauseDuring === "github") expect(h.awsCalls).toEqual([]);
      if (pauseDuring === "iam create-role")
        expect(h.find("iam put-role-policy")).toBeUndefined();
    }
  );

  it.each([
    [false, [DEV, DEV_ID]],
    [true, [DEV_ID]]
  ])(
    "authorizes a new role for every subject GitHub may present (use_immutable_subject %s)",
    async (useImmutableSubject, subjects) => {
      const h = harness(happyPath, githubSubjects(useImmutableSubject));

      const result = await h.access.setup(operation, input, EXECUTOR);

      expect(result).toEqual({
        ok: true,
        roleArn: ROLE_ARN,
        subjects,
        policyName: "radius-deploy-dev-f5fb7acf8f59"
      });
      expect(h.githubCalls).toEqual([
        { path: "/repos/octo/shop", executor: EXECUTOR },
        {
          path: "/repos/octo/shop/actions/oidc/customization/sub",
          executor: EXECUTOR
        },
        {
          path: "/repos/octo/shop/environments/dev/variables?per_page=100",
          executor: EXECUTOR
        }
      ]);
      // No role name was given, so the repository's default role is created,
      // tagged with this operation.
      expect(h.find("iam create-role")).toEqual(
        expect.arrayContaining([
          "--role-name",
          ROLE,
          "Key=radius-operation,Value=op-1"
        ])
      );
      const createRole = h.find("iam create-role") ?? [];
      const trust = parsePolicyDocument(
        JSON.parse(
          createRole[createRole.indexOf("--assume-role-policy-document") + 1] ??
            "{}"
        )
      );
      expect(trustedGitHubSubjects(trust, ACCOUNT)).toEqual(subjects);
      expect(h.events[0]).toEqual(["enterStage", "op-1", STAGE]);
      expect(h.events).toContainEqual([
        "step",
        "op-1",
        `ℹ️ Deploy identity will trust ${subjects.join(", ")}`,
        STAGE
      ]);
      // The exact cleanup identity is durable before configuration starts.
      expect(h.events.slice(-2)).toEqual([
        [
          "setContext",
          "op-1",
          {
            awsRoleArn: ROLE_ARN,
            awsTrustSubjects: subjects,
            awsPolicyName: "radius-deploy-dev-f5fb7acf8f59"
          }
        ],
        ["persist"]
      ]);
    }
  );

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

    expect(result).toEqual({
      ok: true,
      roleArn: picked,
      subjects: [DEV, DEV_ID],
      policyName: "radius-deploy-dev-f5fb7acf8f59"
    });
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
    expect("error" in result && result.error).toContain(
      'Could not read repository "octo/shop"'
    );
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toEqual([["enterStage", "op-1", STAGE]]);
  });

  it("refuses a subject without the repository before any AWS call, naming the claim keys", async () => {
    const h = harness(
      happyPath,
      customTemplate(["repository_owner", "context"])
    );

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: "aws-subject-not-repository-specific",
      error:
        "GitHub's OIDC subject for this environment, repository_owner:octo:environment:dev, does not name the repository, because the OIDC subject customization for octo/shop, set on the repository or its organization, includes only the claims repository_owner, context. Other repositories with the same claim values present the same subject, so trusting it would let their workflows sign in to the deploy role. This attempt changed nothing in AWS. Add repo or repository_id to the customization's include_claim_keys, then retry."
    });
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toEqual([["enterStage", "op-1", STAGE]]);
  });

  it.each([
    [
      ["repository_owner_id", "environment"],
      "repository_owner_id:7:environment:dev"
    ],
    [["context"], "environment:dev"]
  ])(
    "refuses the subject a %j template gives before any AWS call",
    async (keys, subject) => {
      const h = harness(happyPath, customTemplate(keys));

      const result = await h.access.setup(operation, input, EXECUTOR);

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        code: "aws-subject-not-repository-specific"
      });
      expect("error" in result && result.error).toContain(
        `this environment, ${subject}, does not name the repository`
      );
      expect("error" in result && result.error).toContain(
        `includes only the claims ${keys.join(", ")}.`
      );
      expect(h.awsCalls).toEqual([]);
    }
  );

  it.each([
    [["repository_id", "context"], "repository_id:42:environment:dev"],
    [["repo", "context"], "repo:octo/shop:environment:dev"]
  ])(
    "authorizes the subject a %j template gives, since it names the repository",
    async (keys, subject) => {
      const h = harness(happyPath, customTemplate(keys));

      const result = await h.access.setup(operation, input, EXECUTOR);

      expect(result).toMatchObject({
        ok: true,
        roleArn: ROLE_ARN,
        subjects: [subject]
      });
      const createRole = h.find("iam create-role") ?? [];
      const trust = parsePolicyDocument(
        JSON.parse(
          createRole[createRole.indexOf("--assume-role-policy-document") + 1] ??
            "{}"
        )
      );
      expect(trustedGitHubSubjects(trust, ACCOUNT)).toEqual([subject]);
    }
  );

  it("authorizes an environment whose name has a colon, which GitHub encodes", async () => {
    const h = harness(happyPath, {
      ...defaultSubject,
      "/repos/octo/shop/environments/prod%3Aeu/variables?per_page=100": {
        ok: true,
        status: 200,
        json: { variables: [] }
      }
    });

    const result = await h.access.setup(
      operation,
      { ...input, environment: "prod:eu" },
      EXECUTOR
    );

    expect(result).toMatchObject({
      ok: true,
      roleArn: ROLE_ARN,
      subjects: [
        "repo:octo/shop:environment:prod%3Aeu",
        "repo:octo@7/shop@42:environment:prod%3Aeu"
      ]
    });
  });

  it("says nothing was created when setup stops before writing to AWS", async () => {
    const h = harness({
      ...happyPath,
      "--version": fail("aws: command not found")
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect("error" in result && result.error).toMatch(
      / Nothing was created in AWS\.$/
    );
    expect(h.events.at(-1)).toEqual(["persist"]);
    expect(h.roleRecorded()).toBe(false);
  });

  it("names what setup created before it stopped", async () => {
    const h = harness({
      ...happyPath,
      "iam put-role-policy": fail("AccessDenied: iam:PutRolePolicy")
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain(
      `Created before setup stopped: the GitHub identity provider in account ${ACCOUNT}, IAM role ${ROLE}. Remove them in the AWS console if you will not retry.`
    );
    expect(h.roleRecorded()).toBe(false);
  });
});

describe("pausing AWS environment access setup", () => {
  const WRITES = [
    "iam create-open-id-connect-provider",
    "iam create-role",
    "iam put-role-policy",
    "eks create-access-entry",
    "eks associate-access-policy"
  ];
  const writesRun = (h: ReturnType<typeof harness>) =>
    h.awsCalls
      .map((args) => args.slice(0, 2).join(" "))
      .filter((command) => WRITES.includes(command));
  const steps = (h: ReturnType<typeof harness>) =>
    h.events.filter(([kind]) => kind === "step").map(([, , text]) => text);

  it.each([
    ["while GitHub reports the subjects", "github"],
    ["during a preflight read", "eks describe-cluster"],
    [
      "during the last read before the first write",
      "iam list-open-id-connect-providers"
    ]
  ])("stops with nothing written in AWS when paused %s", async (_label, at) => {
    const h = harness(happyPath, defaultSubject, at);

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toEqual({ ok: false, stopped: true });
    expect(writesRun(h)).toEqual([]);
    expect(steps(h).at(-1)).toBe(
      "⏸️ Paused before any AWS change. Nothing was created in AWS."
    );
    expect(h.events.slice(-3)).toEqual([
      ["setStageState", "op-1", STAGE, "paused"],
      [
        "step",
        "op-1",
        "⏸️ Paused before any AWS change. Nothing was created in AWS.",
        STAGE
      ],
      ["persist"]
    ]);
    expect(h.roleRecorded()).toBe(false);
  });

  it("finishes the write in flight, records it, and runs no later write", async () => {
    const h = harness(
      happyPath,
      defaultSubject,
      "iam create-open-id-connect-provider"
    );

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toEqual({ ok: false, stopped: true });
    expect(writesRun(h)).toEqual(["iam create-open-id-connect-provider"]);
    expect(steps(h).at(-1)).toBe(
      `⏸️ Paused before the next AWS change. Created before the pause: the GitHub identity provider in account ${ACCOUNT}.`
    );
    expect(h.events).toContainEqual(["setStageState", "op-1", STAGE, "paused"]);
    expect(h.events.at(-1)).toEqual(["persist"]);
    expect(h.roleRecorded()).toBe(false);
  });

  it("records the role when the pause arrives during the last write", async () => {
    const h = harness(happyPath, defaultSubject, "eks associate-access-policy");

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toEqual({ ok: false, stopped: true });
    expect(writesRun(h)).toEqual(WRITES);
    expect(h.events).toContainEqual([
      "setContext",
      "op-1",
      {
        awsRoleArn: ROLE_ARN,
        awsTrustSubjects: [DEV, DEV_ID],
        awsPolicyName: "radius-deploy-dev-f5fb7acf8f59"
      }
    ]);
    expect(steps(h).at(-1)).toBe(
      `⏸️ Paused after AWS setup finished. ${ROLE_ARN} is ready for this environment.`
    );
    // The deploy identity is ready, so its stage stays done.
    expect(h.events.map(([kind]) => kind)).not.toContain("setStageState");
    expect(h.events.at(-1)).toEqual(["persist"]);
  });

  it("runs every write when no pause is requested", async () => {
    const h = harness(happyPath);
    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });
    expect(writesRun(h)).toEqual(WRITES);
  });
});

describe("AWS environment access removal", () => {
  const roleTrusting = (subjects: string[]): Record<string, Answer> => ({
    ...lockFree,
    "--version": ok("aws-cli/2.39.0"),
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-role": ok({
      Role: {
        Arn: ROLE_ARN,
        AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects)
      }
    }),
    "iam update-assume-role-policy": ok(),
    "iam delete-role-policy": ok()
  });
  const remainingTrust = (h: ReturnType<typeof harness>) => {
    const update = h.find("iam update-assume-role-policy") ?? [];
    return trustedGitHubSubjects(
      parsePolicyDocument(
        JSON.parse(update[update.indexOf("--policy-document") + 1] ?? "{}")
      ),
      ACCOUNT
    );
  };
  const cluster = { region: "us-west-2", cluster: "shop" };

  it("refuses an unconfirmed fallback hash when recorded subjects do not name a repository", async () => {
    const h = harness({
      ...roleTrusting(["custom:environment:dev", PROD]),
      "iam list-role-policies": ok({
        PolicyNames: [awsEnvironmentPolicyName("octo/old", "dev")]
      })
    });
    expect(
      await h.access.remove({
        repo: "octo/shop",
        environment: "dev",
        roleArn: ROLE_ARN,
        trustSubjects: ["custom:environment:dev"],
        ...cluster
      })
    ).toMatchObject({ ok: false });
    expect(h.find("iam list-role-policies")).toBeDefined();
    expect(h.find("iam delete-role-policy")).toBeUndefined();
    expect(h.find("iam update-assume-role-policy")).toBeUndefined();
    expect(h.githubCalls.length).toBeGreaterThan(0);
  });

  it("removes the recorded subjects and the ones GitHub resolves now", async () => {
    const h = harness(roleTrusting([DEV, DEV_ID, PROD]));

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV, DEV_ID],
      ...cluster
    });

    expect(result).toEqual({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ],
      kept: [
        `IAM role ${ROLE}`,
        "the account's GitHub identity provider",
        `any access entry for ${ROLE} on shop, because Radius didn't create this role for octo/shop, and other repositories may use it`
      ],
      warnings: []
    });
    // Read with the ambient account: deletion has no selected executor.
    expect(h.githubCalls).toEqual([
      { path: "/repos/octo/shop", executor: undefined },
      {
        path: "/repos/octo/shop/actions/oidc/customization/sub",
        executor: undefined
      }
    ]);
    expect(remainingTrust(h)).toEqual([PROD]);
  });

  // Repair adds the subjects GitHub resolves for the environment, which differ
  // from the recorded list after an OIDC subject change.
  it("removes a subject Repair added that the recorded list doesn't name", async () => {
    const h = harness(roleTrusting([DEV, DEV_ID, PROD]));

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV],
      ...cluster
    });

    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ]
    });
    expect(remainingTrust(h)).toEqual([PROD]);
  });

  it("removes the recorded subjects after the repository is renamed", async () => {
    // Setup recorded octo/shop's subjects; GitHub now reports octo/store.
    const h = harness(roleTrusting([DEV, DEV_ID, PROD]), {
      "/repos/octo/store": {
        ok: true,
        status: 200,
        json: { full_name: "octo/store", id: 42, owner: { id: 7 } }
      },
      "/repos/octo/store/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: { use_default: true, use_immutable_subject: false }
      }
    });

    const result = await h.access.remove({
      repo: "octo/store",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV, DEV_ID],
      ...cluster
    });

    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ]
    });
    expect(remainingTrust(h)).toEqual([PROD]);
  });

  it("uses the setup repository encoded in an immutable subject after a rename", async () => {
    const h = harness(roleTrusting([DEV_ID, PROD]), {
      "/repos/octo/store": {
        ok: true,
        status: 200,
        json: { full_name: "octo/store", id: 42, owner: { id: 7 } }
      },
      "/repos/octo/store/actions/oidc/customization/sub":
        githubSubjects(true)["/repos/octo/shop/actions/oidc/customization/sub"]
    });
    expect(
      await h.access.remove({
        repo: "octo/store",
        environment: "dev",
        roleArn: ROLE_ARN,
        trustSubjects: [DEV_ID],
        ...cluster
      })
    ).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ]
    });
    expect(remainingTrust(h)).toEqual([PROD]);
    expect(h.githubCalls.length).toBeGreaterThan(0);
  });

  it("refuses ambiguous saved repository identities before any AWS call", async () => {
    const h = harness(roleTrusting([DEV, PROD]));
    expect(
      await h.access.remove({
        repo: "octo/shop",
        environment: "dev",
        roleArn: ROLE_ARN,
        trustSubjects: [DEV, "repo:octo/other:environment:dev"],
        ...cluster
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("multiple repositories")
    });
    expect(h.commands()).toEqual([]);
  });

  it.each([
    ["has no recorded subjects", { trustSubjects: [] }],
    ["predates recorded subjects", {}]
  ])(
    "resolves both subjects from GitHub when the environment %s",
    async (_label, recorded) => {
      const h = harness(roleTrusting([DEV, DEV_ID, PROD]));

      const result = await h.access.remove({
        repo: "octo/shop",
        environment: "dev",
        roleArn: ROLE_ARN,
        ...cluster,
        ...recorded
      });

      expect(result).toMatchObject({
        ok: true,
        removed: [
          `trust subject ${DEV}`,
          `trust subject ${DEV_ID}`,
          "policy radius-deploy-dev-f5fb7acf8f59"
        ]
      });
      expect(remainingTrust(h)).toEqual([PROD]);
    }
  );

  const sharedWarning = (subject: string) =>
    `Kept trust subject ${subject}, because it doesn't name one repository and the environment dev, so other environments or repositories may present it too. If nothing else needs it, remove it from the role's trust policy by hand.`;

  it.each([
    ["the environment", ["repo"], "repo:octo/shop"],
    [
      "the repository",
      ["repository_owner", "environment"],
      "repository_owner:octo:environment:dev"
    ]
  ])(
    "keeps a current subject whose template leaves out %s, and warns",
    async (_label, keys, shared) => {
      const h = harness(
        roleTrusting([DEV, shared, PROD]),
        customTemplate(keys)
      );

      const result = await h.access.remove({
        repo: "octo/shop",
        environment: "dev",
        roleArn: ROLE_ARN,
        trustSubjects: [DEV],
        ...cluster
      });

      expect(result).toMatchObject({
        ok: true,
        removed: [
          `trust subject ${DEV}`,
          "policy radius-deploy-dev-f5fb7acf8f59"
        ],
        warnings: [sharedWarning(shared)]
      });
      expect(remainingTrust(h)).toEqual([shared, PROD]);
    }
  );

  it("removes a current subject whose custom template names the repository and the environment", async () => {
    const custom = "repository_id:42:environment:dev";
    const h = harness(
      roleTrusting([DEV, custom, PROD]),
      customTemplate(["repository_id", "context"])
    );

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV],
      ...cluster
    });

    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${custom}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ],
      warnings: []
    });
  });

  // Two environments set up under the `repository_id` template both record
  // `repository_id:42`, and both use it to assume the role.
  it("keeps a recorded subject another environment records too", async () => {
    const h = harness(
      roleTrusting(["repository_id:42", PROD]),
      customTemplate(["repository_id"])
    );

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: ["repository_id:42"],
      ...cluster
    });

    expect(result).toMatchObject({
      ok: true,
      removed: ["policy radius-deploy-dev-f5fb7acf8f59"],
      warnings: [sharedWarning("repository_id:42")]
    });
    expect(h.find("iam update-assume-role-policy")).toBeUndefined();
  });

  it("doesn't warn about a shared subject the role doesn't trust", async () => {
    const h = harness(
      roleTrusting([DEV, PROD]),
      customTemplate(["repository_owner"])
    );

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV],
      ...cluster
    });

    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ],
      warnings: []
    });
  });

  it("passes the shared-subject warning to the work run under the lock", async () => {
    const h = harness(
      roleTrusting([DEV, "repo:octo/shop", PROD]),
      customTemplate(["repo"])
    );
    const seen: unknown[] = [];

    await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV],
      ...cluster,
      whileLocked: async (removed) => {
        seen.push(removed.warnings.length);
      }
    });

    expect(seen).toEqual([1]);
  });

  it("changes nothing in AWS when GitHub can't resolve the current subjects", async () => {
    const h = harness(roleTrusting([DEV, PROD]), {
      "/repos/octo/shop": { ok: false, status: 404, json: null }
    });

    await expect(
      h.access.remove({
        repo: "octo/shop",
        environment: "dev",
        roleArn: ROLE_ARN,
        trustSubjects: [DEV],
        ...cluster
      })
    ).rejects.toThrow('Could not read repository "octo/shop" from GitHub');
    expect(h.awsCalls).toEqual([]);
  });
});

describe("AWS environment access removal of the cluster's access entry", () => {
  const ENTRY = `the access entry for ${ROLE} on shop`;
  const BY_HAND = `If nothing else uses it, run: aws eks delete-access-entry --cluster-name shop --principal-arn ${ROLE_ARN} --region us-west-2`;
  const radiusRole = (subjects: string[]): Record<string, Answer> => ({
    ...lockFree,
    "--version": ok("aws-cli/2.17.0 Python/3.11 Darwin/23"),
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-role": ok({
      Role: {
        Arn: ROLE_ARN,
        AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects),
        Tags: [
          { Key: "radius-managed", Value: "true" },
          { Key: "radius-repository", Value: "octo/shop" }
        ]
      }
    }),
    "iam update-assume-role-policy": ok(),
    "iam delete-role-policy": ok(),
    "eks describe-access-entry": ok({
      accessEntry: { tags: { "radius-managed": "true" } }
    }),
    "eks delete-access-entry": ok()
  });
  const awsEnvironment = (cluster: string, subjects?: string[]) => ({
    RADIUS_MANAGED: "",
    AWS_ROLE_ARN: ROLE_ARN,
    AWS_ACCOUNT_ID: ACCOUNT,
    AWS_REGION: "us-west-2",
    AWS_EKS_CLUSTER_NAME: cluster,
    ...(subjects ? { AWS_TRUST_SUBJECTS: JSON.stringify(subjects) } : {})
  });
  const remove = (h: ReturnType<typeof harness>) =>
    h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV],
      region: "us-west-2",
      cluster: "shop"
    });
  const withEnvironments = (environments: Environments, subjects = [DEV]) =>
    harness(
      radiusRole([...subjects, PROD]),
      githubSubjects(true),
      undefined,
      undefined,
      environments
    );

  it("removes the entry, under the lock, when the repository's other environments are elsewhere", async () => {
    const h = withEnvironments({
      // The environment being deleted still exists, and is skipped.
      DEV: awsEnvironment("shop", [DEV]),
      prod: awsEnvironment("storefront", [PROD]),
      azure: {
        RADIUS_MANAGED: "",
        AZURE_CLIENT_ID: "client",
        AZURE_AKS_CLUSTER_NAME: "shop"
      },
      handmade: { AWS_EKS_CLUSTER_NAME: "shop" }
    });

    const result = await remove(h);

    expect(result).toMatchObject({
      ok: true,
      removed: expect.arrayContaining([`access entry for ${ROLE} on shop`])
    });
    expect(h.environmentReads).toEqual(["DEV", "prod", "azure", "handmade"]);
    const commands = h.commands();
    // The lock is checked right before the entry delete, and released after.
    expect(
      commands.slice(commands.indexOf("eks delete-access-entry") - 1)
    ).toEqual([
      "iam get-policy",
      "eks delete-access-entry",
      "iam get-policy",
      "iam delete-policy"
    ]);
  });

  it("keeps the entry while another environment is on the cluster", async () => {
    const h = withEnvironments({ prod: awsEnvironment("shop", [PROD]) });
    const result = await remove(h);
    expect(result.ok && result.kept).toContain(
      `${ENTRY}, because environment prod still uses that cluster`
    );
    expect(h.find("eks delete-access-entry")).toBeUndefined();
  });

  // `repository_owner:octo:environment:prod` is presented by every
  // repository of octo, not only this one.
  it.each([
    ["an owner-wide subject", "repository_owner:octo:environment:prod"],
    ["another repository's subject", "repo:octo/other:environment:prod"],
    ["a wildcard", "repo:octo/shop:environment:prod*"]
  ])(
    "keeps the entry when another environment recorded %s",
    async (_label, recorded) => {
      const h = harness(
        radiusRole([DEV, recorded]),
        githubSubjects(true),
        undefined,
        undefined,
        { prod: awsEnvironment("storefront", [recorded]) }
      );
      const result = await remove(h);
      expect(result.ok && result.kept).toContain(
        `${ENTRY}, because the role's trust policy lets in more than this repository's other environments. ${BY_HAND}`
      );
      expect(h.find("eks delete-access-entry")).toBeUndefined();
    }
  );

  it("removes the entry when another environment recorded this repository's ID-based subject", async () => {
    const prodId = "repo:octo@7/shop@42:environment:prod";
    const h = harness(
      radiusRole([DEV, prodId]),
      githubSubjects(true),
      undefined,
      undefined,
      { prod: awsEnvironment("storefront", [prodId]) }
    );
    expect(await remove(h)).toMatchObject({
      ok: true,
      removed: expect.arrayContaining([`access entry for ${ROLE} on shop`])
    });
  });

  it("keeps the entry when another environment's subjects were never recorded", async () => {
    const h = withEnvironments({ prod: awsEnvironment("storefront") });
    const result = await remove(h);
    expect(result.ok && result.kept).toContain(
      `${ENTRY}, because the role's trust policy lets in more than this repository's other environments. ${BY_HAND}`
    );
  });

  it.each([
    ["the environment list can't be read", "HTTP 403", "HTTP 403"],
    [
      "an environment's variables can't be read",
      { prod: "HTTP 502" },
      "HTTP 502"
    ],
    [
      "an environment doesn't record its cluster",
      { prod: { RADIUS_MANAGED: "", AWS_ROLE_ARN: ROLE_ARN } },
      'environment "prod" does not record its cluster.'
    ]
  ])(
    "keeps the entry and warns when %s",
    async (_label, environments, reason) => {
      const h = withEnvironments(environments);
      expect(await remove(h)).toMatchObject({
        ok: true,
        warnings: [
          `Kept ${ENTRY}, because Radius couldn't read this repository's environments (${reason}). ${BY_HAND}`
        ]
      });
      expect(h.find("eks delete-access-entry")).toBeUndefined();
    }
  );
});

describe("the deploy identity lock during setup", () => {
  const RECOVERY = `Check that "aws iam get-policy --policy-arn ${LOCK_ARN} --query Policy.PolicyId --output text" prints LOCK1, which is this run's lock, and only then run: aws iam delete-policy --policy-arn ${LOCK_ARN}`;
  const OTHER_HOLDER =
    '{"repo":"octo/shop","environment":"prod","action":"setup","operationId":"op-2"}';
  const EXISTS = fail("EntityAlreadyExists: radius-lock exists");

  it("locks the role, records the lock, and keeps it after setup returns", async () => {
    const h = harness(happyPath);

    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });

    expect(h.commands().slice(0, 4)).toEqual([
      "--version",
      "sts get-caller-identity",
      "eks describe-cluster",
      "iam create-policy"
    ]);
    expect(h.commands()).not.toContain("iam delete-policy");
    expect(h.events).toContainEqual([
      "setContext",
      "op-1",
      { awsDeployIdentityLock: { policyArn: LOCK_ARN, policyId: "LOCK1" } }
    ]);
    expect(h.steps()).toContain(
      `🔒 Locked IAM role ${ROLE}, so no other Radius run changes its trust policy until this setup finishes.`
    );
  });

  it("saves the lock on the operation before its first write", async () => {
    const persistsAtFirstWrite: number[] = [];
    const script: Record<string, Answer> = { ...happyPath };
    const firstWrite = script["iam create-open-id-connect-provider"];
    Object.defineProperty(script, "iam create-open-id-connect-provider", {
      get() {
        persistsAtFirstWrite.push(
          h.events.filter(([kind]) => kind === "persist").length
        );
        return firstWrite;
      }
    });
    const h = harness(script);

    await h.access.setup(operation, input, EXECUTOR);

    const lockRecorded = h.events.findIndex(
      ([kind, , patch]) =>
        kind === "setContext" &&
        typeof patch === "object" &&
        patch !== null &&
        "awsDeployIdentityLock" in patch
    );
    expect(h.events[lockRecorded + 2]).toEqual(["persist"]);
    expect(persistsAtFirstWrite[0]).toBeGreaterThan(0);
  });

  it("checks the lock before every write", async () => {
    const h = harness(happyPath);
    await h.access.setup(operation, input, EXECUTOR);
    const commands = h.commands();
    const writes = [
      "iam create-open-id-connect-provider",
      "iam create-role",
      "iam put-role-policy",
      "eks create-access-entry",
      "eks associate-access-policy"
    ];
    for (const write of writes) {
      expect(commands[commands.indexOf(write) - 1]).toBe("iam get-policy");
    }
    // One read confirms the new lock, then one before each write.
    expect(commands.filter((c) => c === "iam get-policy")).toHaveLength(
      writes.length + 1
    );
  });

  it("runs no write when the pause arrives during the lock check before it", async () => {
    // The first read confirms the new lock; the second is the check before
    // the first write.
    const h = harness(happyPath, defaultSubject, "iam get-policy@2");

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toEqual({ ok: false, stopped: true });
    expect(h.commands()).not.toContain("iam create-open-id-connect-provider");
    expect(h.steps().at(-1)).toBe(
      "⏸️ Paused before any AWS change. Nothing was created in AWS."
    );
  });

  it("releases the lock once, clearing it from the operation", async () => {
    const h = harness(happyPath);
    await h.access.setup(operation, input, EXECUTOR);

    await h.access.release(operation);
    await h.access.release(operation);

    expect(h.commands().filter((c) => c === "iam delete-policy")).toHaveLength(
      1
    );
    expect(h.events.slice(-2)).toEqual([
      ["setContext", "op-1", { awsDeployIdentityLock: null }],
      ["persist"]
    ]);
  });

  it("releases nothing for an operation that took no lock", async () => {
    const h = harness(happyPath);
    await h.access.release(operation);
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("reports a lock it could not release with the policy ID to check, and keeps it to release later", async () => {
    const h = harness({
      ...happyPath,
      "iam delete-policy": [fail("AccessDenied: iam:DeletePolicy"), ok()]
    });
    await h.access.setup(operation, input, EXECUTOR);

    await h.access.release(operation);

    expect(h.steps().at(-1)).toBe(
      `⚠️ This setup is done with IAM role ${ROLE}, but Radius could not release its lock because the signed-in AWS identity is not allowed iam:DeletePolicy. Other runs wait for this lock until it is removed. ${RECOVERY}`
    );
    expect(h.events).not.toContainEqual([
      "setContext",
      "op-1",
      { awsDeployIdentityLock: null }
    ]);

    await h.access.release(operation);

    expect(h.commands().filter((c) => c === "iam delete-policy")).toHaveLength(
      2
    );
    expect(h.events.slice(-2)).toEqual([
      ["setContext", "op-1", { awsDeployIdentityLock: null }],
      ["persist"]
    ]);
  });

  it("clears a lock that was removed before release, saying so", async () => {
    const h = harness({
      ...happyPath,
      "iam get-policy": [
        ...Array.from({ length: 6 }, () => lockPolicy("LOCK1")),
        fail("NoSuchEntity: gone")
      ]
    });
    await h.access.setup(operation, input, EXECUTOR);

    await h.access.release(operation);

    expect(h.commands()).not.toContain("iam delete-policy");
    expect(h.steps().at(-1)).toBe(
      `⚠️ This setup is done with IAM role ${ROLE}, but its lock had already been removed, so there was nothing to release. Another run may have changed the role while this one held it.`
    );
    expect(h.events.slice(-3)).toEqual([
      ["setContext", "op-1", { awsDeployIdentityLock: null }],
      ["step", "op-1", h.steps().at(-1), STAGE],
      ["persist"]
    ]);
  });

  it("reports a failure to save after a release that did not finish", async () => {
    const h = harness(
      { ...happyPath, "iam delete-policy": fail("AccessDenied") },
      defaultSubject,
      undefined,
      new Error("disk full")
    );
    await expect(h.access.setup(operation, input, EXECUTOR)).rejects.toThrow(
      "disk full"
    );

    await h.access.release(operation);

    expect(h.steps().slice(-2)).toEqual([
      expect.stringContaining("but Radius could not release its lock"),
      "⚠️ Radius could not save this setup after it tried to release the lock on the deploy identity: disk full"
    ]);
  });

  it("reports rather than throws when releasing fails unexpectedly", async () => {
    const h = harness({ ...happyPath, "iam delete-policy": [] });
    await h.access.setup(operation, input, EXECUTOR);

    await expect(h.access.release(operation)).resolves.toBeUndefined();

    expect(h.steps().at(-1)).toBe(
      `⚠️ Radius could not release the lock on the deploy identity: unexpected aws iam delete-policy --policy-arn ${LOCK_ARN}. Other runs wait for this lock until it is removed. ${RECOVERY}`
    );
  });

  it("reports a failure to save after a release on its own", async () => {
    const h = harness(
      happyPath,
      defaultSubject,
      undefined,
      new Error("disk full")
    );
    // The save right after locking fails, so setup stops before any write,
    // still holding the lock for the release.
    await expect(h.access.setup(operation, input, EXECUTOR)).rejects.toThrow(
      "disk full"
    );
    expect(h.commands()).not.toContain("iam create-open-id-connect-provider");

    await h.access.release(operation);

    expect(h.commands().at(-1)).toBe("iam delete-policy");
    expect(h.steps().at(-1)).toBe(
      "⚠️ Radius could not save this setup after it released the lock on the deploy identity: disk full"
    );
  });

  it("stops with nothing created when iam:CreatePolicy is denied", async () => {
    const h = harness({
      ...happyPath,
      "iam create-policy": fail("AccessDenied: iam:CreatePolicy")
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "aws-lock-denied"
    });
    expect("error" in result && result.error).toContain(
      "not allowed iam:CreatePolicy"
    );
    expect("error" in result && result.error).toMatch(
      / Nothing was created in AWS\.$/
    );
    expect(h.commands().at(-1)).toBe("iam create-policy");
    expect(h.roleRecorded()).toBe(false);
  });

  it("waits for another run's lock, reporting it once, then takes it", async () => {
    const h = harness({
      ...happyPath,
      "iam create-policy": [EXISTS, EXISTS, lockPolicy("LOCK1")],
      "iam get-policy": [
        lockPolicy("LOCK0", {
          Description: OTHER_HOLDER,
          CreateDate: "2026-10-30T11:58:30Z"
        }),
        lockPolicy("LOCK0", {
          Description: OTHER_HOLDER,
          CreateDate: "2026-10-30T11:58:30Z"
        }),
        lockPolicy("LOCK1")
      ]
    });

    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });

    const waiting = h.steps().filter((text) => String(text).startsWith("⏳"));
    expect(waiting).toEqual([
      `⏳ Waiting for the lock on IAM role ${ROLE}. The setup of environment prod in octo/shop (operation op-2) has held it since 2026-10-30 11:58 UTC.`
    ]);
    expect(h.events).toContainEqual(["touch", "op-1"]);
    expect(h.events).toContainEqual([
      "setContext",
      "op-1",
      {
        awsLockWait: {
          policyArn: LOCK_ARN,
          policyId: "LOCK0",
          holder: "The setup of environment prod in octo/shop",
          holderOperationId: "op-2",
          since: "2026-10-30T11:58:30Z",
          stopped: false,
          removable: false
        }
      }
    ]);
    expect(h.events).toContainEqual([
      "setContext",
      "op-1",
      { awsLockWait: null }
    ]);
  });

  it("takes back the lock this setup recorded in an earlier attempt", async () => {
    const MINE = JSON.stringify({
      repo: "octo/shop",
      environment: "dev",
      action: "setup",
      operationId: "op-1"
    });
    const h = harness({
      ...happyPath,
      "iam create-policy": [EXISTS, lockPolicy("LOCK1")],
      "iam get-policy": [
        lockPolicy("LOCK0", { Description: MINE }),
        lockPolicy("LOCK1")
      ]
    });
    h.contexts.set("op-1", {
      awsDeployIdentityLock: { policyArn: LOCK_ARN, policyId: "LOCK0" }
    });

    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });

    expect(h.steps()).toContain(
      `🔒 Took back the lock this setup holds on IAM role ${ROLE} from its earlier attempt.`
    );
    expect(h.steps().some((text) => String(text).startsWith("⏳"))).toBe(false);
    // Replaced, so the lock's creation time is this run's.
    expect(
      h.commands().filter((command) => command === "iam create-policy")
    ).toHaveLength(2);
    expect(h.commands()).toContain("iam delete-policy");
    await h.access.release(operation);
    expect(h.commands().at(-1)).toBe("iam delete-policy");
    expect(h.contexts.get("op-1")).toMatchObject({
      awsDeployIdentityLock: null
    });
  });

  it("does not take back a recorded lock on another role", async () => {
    const MINE = JSON.stringify({
      repo: "octo/shop",
      environment: "dev",
      action: "setup",
      operationId: "op-1"
    });
    const h = harness({
      ...happyPath,
      "iam create-policy": [EXISTS, lockPolicy("LOCK1")],
      "iam get-policy": [
        lockPolicy("LOCK0", { Description: MINE }),
        lockPolicy("LOCK1")
      ]
    });
    h.contexts.set("op-1", {
      awsDeployIdentityLock: {
        policyArn: `arn:aws:iam::${ACCOUNT}:policy/radius-lock-other-role`,
        policyId: "LOCK0"
      }
    });

    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });
    expect(h.steps()).toContain(
      `🔒 Locked IAM role ${ROLE}, so no other Radius run changes its trust policy until this setup finishes.`
    );
  });

  it.each([
    ["another operation that stopped", OTHER_HOLDER, "op-2"],
    [
      "this setup's earlier attempt, unrecorded",
      JSON.stringify({
        repo: "octo/shop",
        environment: "dev",
        action: "setup",
        operationId: "op-1"
      }),
      null
    ]
  ])(
    "offers Remove lock at once for a lock left by %s",
    async (_label, description, stopped) => {
      const h = harness({
        ...happyPath,
        "iam create-policy": [EXISTS, lockPolicy("LOCK1")],
        "iam get-policy": [
          lockPolicy("LOCK0", {
            Description: description,
            CreateDate: "2026-10-30T11:59:00Z"
          }),
          lockPolicy("LOCK1")
        ]
      });
      if (stopped) h.stoppedOperations.add(stopped);

      await h.access.setup(operation, input, EXECUTOR);

      const holder =
        stopped ?
          "The setup of environment prod in octo/shop (operation op-2)"
        : "The setup of environment dev in octo/shop (operation op-1)";
      expect(h.steps()).toContain(
        `⏳ The lock on IAM role ${ROLE} is from an earlier attempt that stopped: ${holder}, which took it at 2026-10-30 11:59 UTC. Use Remove lock to continue.`
      );
      expect(h.events).toContainEqual([
        "setContext",
        "op-1",
        {
          awsLockWait: expect.objectContaining({
            stopped: true,
            removable: true
          })
        }
      ]);
    }
  );

  it("tells the developer when Remove lock becomes available", async () => {
    const h = harness({
      ...happyPath,
      "iam create-policy": [EXISTS, lockPolicy("LOCK1")],
      "iam get-policy": [
        lockPolicy("LOCK0", { CreateDate: "2026-10-30T11:00:00Z" }),
        lockPolicy("LOCK1")
      ]
    });

    await h.access.setup(operation, input, EXECUTOR);

    expect(h.steps()).toContain(
      `⏳ The lock on IAM role ${ROLE} is 10 or more minutes old. Another run has held it since 2026-10-30 11:00 UTC. If that run has stopped, use Remove lock.`
    );
  });

  it("finishes a setup that waited past 10 minutes as succeeded, with no warning", async () => {
    const h = harness({
      ...happyPath,
      "iam create-policy": [EXISTS, EXISTS, lockPolicy("LOCK1")],
      "iam get-policy": [
        lockPolicy("LOCK0", {
          Description: OTHER_HOLDER,
          CreateDate: "2026-10-30T11:55:00Z"
        }),
        lockPolicy("LOCK0", {
          Description: OTHER_HOLDER,
          CreateDate: "2026-10-30T11:45:00Z"
        }),
        lockPolicy("LOCK1")
      ]
    });

    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });
    await h.access.release(operation);

    expect(h.steps()).toContain(
      `⏳ The lock on IAM role ${ROLE} is 10 or more minutes old. The setup of environment prod in octo/shop (operation op-2) has held it since 2026-10-30 11:45 UTC. If that run has stopped, use Remove lock.`
    );
    // The same lines on a real operation record.
    const record = createOperation({
      provider: "aws",
      repo: "octo/shop",
      environment: "dev",
      stages: buildStages({ includeIdentity: true })
    });
    for (const text of h.steps()) addLegacyStep(record, text, STAGE);
    finishSucceeded(record);
    expect(record.state).toBe("succeeded");
    expect(
      record.steps.filter((step: { state: string }) => step.state === "warning")
    ).toEqual([]);
  });

  it("names an unknown time when IAM reports none", async () => {
    const h = harness({
      ...happyPath,
      "iam create-policy": [EXISTS, lockPolicy("LOCK1")],
      "iam get-policy": [lockPolicy("LOCK0"), lockPolicy("LOCK1")]
    });

    await h.access.setup(operation, input, EXECUTOR);

    expect(h.steps()).toContain(
      `⏳ Waiting for the lock on IAM role ${ROLE}. Another run has held it since an unknown time.`
    );
  });

  it("pauses while waiting without creating anything", async () => {
    const h = harness({
      ...happyPath,
      "iam create-policy": EXISTS,
      "iam get-policy": lockPolicy("LOCK0")
    });
    const pending = h.access.setup(operation, input, EXECUTOR);
    h.requestStop();

    expect(await pending).toEqual({ ok: false, stopped: true });

    expect(h.commands()).not.toContain("iam get-role");
    expect(h.steps().at(-1)).toBe(
      "⏸️ Paused before any AWS change. Nothing was created in AWS."
    );
    // The lock was never taken, so Authorize deploy identity has not started.
    expect(h.events.slice(-3)).toEqual([
      ["setStageState", "op-1", STAGE, "paused"],
      [
        "step",
        "op-1",
        "⏸️ Paused before any AWS change. Nothing was created in AWS.",
        STAGE
      ],
      ["persist"]
    ]);
  });

  it("stops before the next write when its lock is removed, naming what it created", async () => {
    const h = harness({
      ...happyPath,
      "iam get-policy": [
        lockPolicy("LOCK1"),
        lockPolicy("LOCK1"),
        lockPolicy("LOCK2", { Description: OTHER_HOLDER })
      ]
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "aws-lock-lost"
    });
    expect("error" in result && result.error).toBe(
      `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds a new one (The setup of environment prod in octo/shop), so Radius stopped. Before it stopped, this run made these AWS changes: the GitHub identity provider in account ${ACCOUNT}. Another run may have changed them since, so check the role before you retry.`
    );
    expect(h.commands()).not.toContain("iam create-role");
    expect(h.roleRecorded()).toBe(false);
  });

  it("says nothing was created when the lock is lost before the first write", async () => {
    const h = harness({
      ...happyPath,
      "iam get-policy": [lockPolicy("LOCK1"), fail("NoSuchEntity: gone")]
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({ ok: false, code: "aws-lock-lost" });
    expect("error" in result && result.error).toBe(
      `The lock on IAM role ${ROLE} was removed while this run held it, so Radius stopped before changing the role.`
    );
    expect(h.commands()).not.toContain("iam create-open-id-connect-provider");
  });
});

describe("the deploy identity lock during removal", () => {
  const removal = {
    repo: "octo/shop",
    environment: "dev",
    roleArn: ROLE_ARN,
    trustSubjects: [DEV],
    region: "us-west-2",
    cluster: "shop",
    operationId: "del-1"
  };
  const signedIn: Record<string, Answer> = {
    ...lockFree,
    "--version": ok("aws-cli/2.39.0"),
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-role": ok({
      Role: {
        Arn: ROLE_ARN,
        AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [DEV, PROD])
      }
    }),
    "iam update-assume-role-policy": ok(),
    "iam delete-role-policy": ok()
  };

  it("locks the role, checks the lock before each write, and releases it", async () => {
    const h = harness(signedIn);

    expect(await h.access.remove(removal)).toMatchObject({ ok: true });

    expect(h.commands()).toEqual([
      "--version",
      "sts get-caller-identity",
      "iam create-policy",
      "iam get-policy",
      "iam get-role",
      "iam get-role-policy",
      "iam list-role-policies",
      "iam get-policy",
      "iam delete-role-policy",
      "iam get-policy",
      "iam update-assume-role-policy",
      // IAM shows the write before the lock can be handed on.
      "iam get-role",
      "iam get-policy",
      "iam delete-policy"
    ]);
    const create = h.find("iam create-policy") ?? [];
    expect(
      JSON.parse(create[create.indexOf("--description") + 1] ?? "")
    ).toEqual({
      repo: "octo/shop",
      environment: "dev",
      action: "delete",
      operationId: "del-1"
    });
  });

  it("reports each wait to the deletion", async () => {
    const waits: unknown[] = [];
    const h = harness({
      ...signedIn,
      "iam create-policy": [
        fail("EntityAlreadyExists"),
        fail("EntityAlreadyExists"),
        lockPolicy("LOCK1")
      ],
      "iam get-policy": [
        lockPolicy("LOCK0"),
        lockPolicy("LOCK0"),
        lockPolicy("LOCK1")
      ]
    });

    await h.access.remove({
      ...removal,
      waiting: (wait, line) => {
        waits.push([wait.policyId, line]);
      }
    });

    expect(waits).toEqual([
      [
        "LOCK0",
        `⏳ Waiting for the lock on IAM role ${ROLE}. Another run has held it since an unknown time.`
      ],
      ["LOCK0", null]
    ]);
  });

  it("waits without a listener", async () => {
    const h = harness({
      ...signedIn,
      "iam create-policy": [fail("EntityAlreadyExists"), lockPolicy("LOCK1")],
      "iam get-policy": [lockPolicy("LOCK0"), lockPolicy("LOCK1")]
    });
    expect(await h.access.remove(removal)).toMatchObject({ ok: true });
  });

  it("changes nothing when the lock cannot be taken", async () => {
    const h = harness({
      ...signedIn,
      "iam create-policy": fail("AccessDenied")
    });

    const result = await h.access.remove(removal);

    expect(result.ok).toBe(false);
    expect("message" in result && result.message).toContain(
      "not allowed iam:CreatePolicy"
    );
    expect(h.commands()).toEqual([
      "--version",
      "sts get-caller-identity",
      "iam create-policy"
    ]);
  });

  it("stops and reports when the lock is lost before a write", async () => {
    const h = harness({
      ...signedIn,
      "iam get-policy": [lockPolicy("LOCK1"), lockPolicy("LOCK2")]
    });

    const result = await h.access.remove(removal);

    expect(result).toEqual({
      ok: false,
      message: `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds a new one (Another run), so Radius stopped before changing the role.`
    });
    expect(h.commands()).not.toContain("iam update-assume-role-policy");
    expect(h.commands()).not.toContain("iam delete-policy");
  });

  it("lists the writes that ran when the lock is lost after one", async () => {
    const h = harness({
      ...signedIn,
      "iam get-policy": [
        lockPolicy("LOCK1"),
        lockPolicy("LOCK1"),
        lockPolicy("LOCK2")
      ]
    });

    const result = await h.access.remove(removal);

    expect(result).toEqual({
      ok: false,
      message: `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds a new one (Another run), so Radius stopped. Before it stopped, this run made these AWS changes: aws iam delete-role-policy. Another run may have changed them since, so check the role before you retry.`
    });
    expect(h.commands()).not.toContain("iam update-assume-role-policy");
  });

  it("warns, naming the lock, when it was already gone at release", async () => {
    const h = harness({
      ...signedIn,
      "iam get-policy": [
        lockPolicy("LOCK1"),
        lockPolicy("LOCK1"),
        lockPolicy("LOCK1"),
        fail("NoSuchEntity: gone")
      ]
    });

    expect(await h.access.remove(removal)).toMatchObject({
      ok: true,
      lockWarning: `This deletion is done with IAM role ${ROLE}, but its lock had already been removed, so there was nothing to release. Another run may have changed the role while this one held it.`
    });
  });

  it("finishes the removal but warns when the lock cannot be released", async () => {
    const h = harness({
      ...signedIn,
      "iam delete-policy": fail("AccessDenied")
    });

    const result = await h.access.remove(removal);

    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        "policy radius-deploy-dev-f5fb7acf8f59"
      ],
      lockWarning: expect.stringContaining("not allowed iam:DeletePolicy")
    });
  });

  it("names both problems when the removal and the release fail", async () => {
    const h = harness({
      ...signedIn,
      "iam update-assume-role-policy": fail("Throttling"),
      "iam delete-policy": fail("ServiceFailure")
    });

    const result = await h.access.remove(removal);

    expect(result.ok).toBe(false);
    expect("message" in result && result.message).toMatch(
      new RegExp(
        `^Removed policy .* Could not update the trust policy of IAM role ${ROLE} \\(Throttling\\)\\. .* This deletion is done with IAM role ${ROLE}, but Radius could not release its lock: ServiceFailure\\.`
      )
    );
  });

  it("releases the lock when the removal throws", async () => {
    const h = harness({ ...signedIn, "iam delete-role-policy": [] });

    await expect(h.access.remove(removal)).rejects.toThrow(
      "unexpected aws iam delete-role-policy"
    );

    expect(h.commands().at(-1)).toBe("iam delete-policy");
  });

  describe("work the deletion runs before the lock is released", () => {
    it("runs it with the removal, after confirming the lock, before releasing", async () => {
      const h = harness(signedIn);
      const seen: unknown[] = [];

      const result = await h.access.remove({
        ...removal,
        whileLocked: async (removed) => {
          seen.push([removed.removed, h.commands().slice(-2)]);
        }
      });

      expect(result).toMatchObject({ ok: true });
      expect(seen).toEqual([
        [
          [`trust subject ${DEV}`, "policy radius-deploy-dev-f5fb7acf8f59"],
          ["iam get-role", "iam get-policy"]
        ]
      ]);
      expect(h.commands().slice(-2)).toEqual([
        "iam get-policy",
        "iam delete-policy"
      ]);
    });

    it("doesn't run it when the removal fails", async () => {
      const h = harness({
        ...signedIn,
        "iam delete-role-policy": fail("AccessDenied")
      });
      const whileLocked = async () => {
        throw new Error("unexpected whileLocked");
      };

      expect(await h.access.remove({ ...removal, whileLocked })).toMatchObject({
        ok: false
      });
    });

    it("doesn't run it, and stops, when the lock is lost after the removal", async () => {
      const h = harness({
        ...signedIn,
        "iam get-policy": [
          lockPolicy("LOCK1"),
          lockPolicy("LOCK1"),
          lockPolicy("LOCK1"),
          lockPolicy("LOCK2")
        ]
      });
      const whileLocked = async () => {
        throw new Error("unexpected whileLocked");
      };

      const result = await h.access.remove({ ...removal, whileLocked });

      expect(result).toEqual({
        ok: false,
        message: `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds a new one (Another run), so Radius stopped. Before it stopped, this run made these AWS changes: aws iam delete-role-policy, aws iam update-assume-role-policy. Another run may have changed them since, so check the role before you retry.`
      });
    });

    it("releases the lock when it throws", async () => {
      const h = harness(signedIn);

      await expect(
        h.access.remove({
          ...removal,
          whileLocked: async () => {
            throw new Error("GitHub is down");
          }
        })
      ).rejects.toThrow("GitHub is down");

      expect(h.commands().at(-1)).toBe("iam delete-policy");
    });
  });
});

// IAM as two concurrent setups see it: one account, one role, and the lock's
// name uniqueness. Every call yields first, so the setups interleave.
// `staleReads` makes the reads right after each trust write still return the
// trust from before it, as IAM's eventually consistent reads can.
function sharedIam({ staleReads = 0 }: { staleReads?: number } = {}) {
  let role: { trust: unknown } | null = {
    trust: buildGitHubTrustPolicy(ACCOUNT, [])
  };
  let previousTrust: unknown = role.trust;
  let stale = 0;
  const locks = new Map<string, { id: string; description: string }>();
  let created = 0;
  const writes: string[] = [];
  const answer = (args: string[]): AwsCommandResult => {
    const command = args.slice(0, 2).join(" ");
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    switch (command) {
      case "--version":
        return ok("aws-cli/2.17.0 Python/3.11");
      case "sts get-caller-identity":
        return ok({ Account: ACCOUNT });
      case "eks describe-cluster":
        return ok({
          cluster: {
            status: "ACTIVE",
            accessConfig: { authenticationMode: "API" }
          }
        });
      case "iam create-policy": {
        const name = value("--policy-name");
        if (locks.has(name)) return fail("EntityAlreadyExists");
        const id = `LOCK${++created}`;
        locks.set(name, { id, description: value("--description") });
        return ok({ Policy: { PolicyId: id, Arn: LOCK_ARN } });
      }
      case "iam get-policy": {
        const lock = locks.get(`radius-lock-${ROLE}`);
        return lock ?
            ok({
              Policy: { PolicyId: lock.id, Description: lock.description }
            })
          : fail("NoSuchEntity");
      }
      case "iam delete-policy":
        locks.delete(`radius-lock-${ROLE}`);
        return ok();
      case "iam get-role": {
        const trust = stale > 0 ? previousTrust : role?.trust;
        if (stale > 0) stale -= 1;
        return role ?
            ok({
              Role: {
                Arn: ROLE_ARN,
                CreateDate: "2026-10-01T00:00:00Z",
                AssumeRolePolicyDocument: trust,
                Tags: [
                  { Key: "radius-managed", Value: "true" },
                  { Key: "radius-repository", Value: "octo/shop" }
                ]
              }
            })
          : fail("NoSuchEntity");
      }
      case "iam list-open-id-connect-providers":
        return ok({
          OpenIDConnectProviderList: [
            {
              Arn: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
            }
          ]
        });
      case "iam get-open-id-connect-provider":
        return ok({ ClientIDList: ["sts.amazonaws.com"] });
      case "iam get-role-policy":
        return fail("NoSuchEntity");
      case "iam list-role-policies":
        return ok({ PolicyNames: [] });
      case "iam update-assume-role-policy":
        writes.push(command);
        previousTrust = role?.trust;
        stale = staleReads;
        role = { trust: JSON.parse(value("--policy-document")) };
        return ok();
      case "iam put-role-policy":
      case "eks associate-access-policy":
        return ok();
      case "eks create-access-entry":
        return fail("ResourceInUseException");
      case "eks describe-access-entry":
        return ok({ accessEntry: { createdAt: "2030-01-01T00:00:00Z" } });
      default:
        throw new Error(`unexpected aws ${args.join(" ")}`);
    }
  };
  return {
    writes,
    trusted: () =>
      trustedGitHubSubjects(parsePolicyDocument(role?.trust), ACCOUNT),
    access: () =>
      createAwsEnvironmentAccess<Operation>({
        async runAws(args) {
          await new Promise((resolve) => setImmediate(resolve));
          return answer(args);
        },
        async runGitHubJson(path) {
          const response = githubSubjects(true)[path];
          if (!response) throw new Error(`unexpected GitHub read ${path}`);
          return response;
        },
        environments: {
          listEnvironmentNames: async () => {
            throw new Error("unexpected environment listing");
          },
          readEnvironmentVariables: async () => {
            throw new Error("unexpected variable read");
          }
        },
        isStopRequested: () => false,
        isStoppedOperation: () => false,
        operationId: (operation) => operation.id,
        now: () => Date.parse("2026-10-30T12:00:00Z"),
        async sleep() {
          await new Promise((resolve) => setImmediate(resolve));
        },
        operations: {
          getContext: () => ({}),
          enterStage: () => {},
          setStageState: () => {},
          addLegacyStep: () => {},
          setContext: () => {},
          touch: () => {}
        },
        store: { persist: async () => {} },
        stageAuthorizeIdentity: STAGE,
        errorMessage: (error) => String(error)
      })
  };
}

describe("two setups on one deploy identity at the same time", () => {
  it.each([
    ["IAM shows each write at once", 0],
    ["IAM shows each write only after two more reads", 2]
  ])(
    "keeps both environments' subjects in the trust policy when %s",
    async (_label, staleReads) => {
      const iam = sharedIam({ staleReads });
      // Two canvas panels, each with its own server, sharing one AWS account.
      const first = iam.access();
      const second = iam.access();
      const dev = { id: "op-dev" };
      const prod = { id: "op-prod" };

      const setups = [
        first.setup(dev, { ...input, environment: "dev" }, EXECUTOR),
        second.setup(prod, { ...input, environment: "prod" }, EXECUTOR)
      ];
      // Each setup holds the lock until its caller releases it, as the
      // coordinator does after Configure environment.
      const finished = setups.map((setup, index) =>
        setup.then(async (result) => {
          await (index === 0 ? first.release(dev) : second.release(prod));
          return result;
        })
      );
      const results = await Promise.all(finished);

      expect(results.map((result) => result.ok)).toEqual([true, true]);
      expect(iam.trusted().sort()).toEqual([
        "repo:octo@7/shop@42:environment:dev",
        "repo:octo@7/shop@42:environment:prod"
      ]);
      expect(iam.writes).toHaveLength(2);
    }
  );
});

describe("repairing an environment's trust under the lock", () => {
  const repairInput = {
    repo: "octo/shop",
    environment: "dev",
    roleArn: ROLE_ARN,
    confirmTarget: async () => null
  };
  const missingId: Record<string, Answer> = {
    ...lockFree,
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-open-id-connect-provider": ok({
      ClientIDList: ["sts.amazonaws.com"]
    }),
    "iam get-role": ok({
      Role: {
        Arn: ROLE_ARN,
        AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [DEV, PROD])
      }
    }),
    // The permission policy setup wrote for this environment.
    "iam get-role-policy": ok({ PolicyName: "radius-deploy-dev" }),
    "iam update-assume-role-policy": ok()
  };
  const holder = (created: string) =>
    lockPolicy("LOCK0", {
      Description:
        '{"repo":"octo/shop","environment":"prod","action":"setup","operationId":"op-2"}',
      CreateDate: created
    });

  it("adds the missing subject under a repair lock and releases it", async () => {
    const h = harness(missingId);

    expect(await h.access.repair(repairInput)).toEqual({
      ok: true,
      roleName: ROLE,
      added: [DEV_ID]
    });

    expect(h.commands()).toEqual([
      "sts get-caller-identity",
      "iam get-open-id-connect-provider",
      "iam create-policy",
      "iam get-policy",
      "iam get-role",
      "iam get-role-policy",
      "iam get-policy",
      "iam update-assume-role-policy",
      "iam get-role",
      "iam get-policy",
      "iam delete-policy"
    ]);
    const create = h.find("iam create-policy") ?? [];
    expect(
      JSON.parse(create[create.indexOf("--description") + 1] ?? "")
    ).toMatchObject({ action: "repair", environment: "dev" });
    // The subjects come from GitHub, with the ambient account.
    expect(h.githubCalls).toEqual([
      { path: "/repos/octo/shop/environments/dev", executor: undefined },
      { path: "/repos/octo/shop", executor: undefined },
      {
        path: "/repos/octo/shop/actions/oidc/customization/sub",
        executor: undefined
      }
    ]);
  });

  it.each([
    [false, "2026-10-30T11:58:00Z", ""],
    [
      true,
      "2026-10-30T11:00:00Z",
      ` If that run has stopped, check that "aws iam get-policy --policy-arn ${LOCK_ARN} --query Policy.PolicyId --output text" prints LOCK0, the lock shown here, and only then run: aws iam delete-policy --policy-arn ${LOCK_ARN}`
    ]
  ])(
    "refuses at once, naming the holder, when another run holds the lock (removable %s)",
    async (_removable, created, ending) => {
      const h = harness({
        ...missingId,
        "iam create-policy": fail("EntityAlreadyExists"),
        "iam get-policy": holder(created)
      });

      const result = await h.access.repair(repairInput);

      expect(result).toEqual({
        ok: false,
        code: "aws-lock-busy",
        message: `The setup of environment prod in octo/shop (operation op-2) is changing IAM role ${ROLE} (it has held the role's lock since ${created.slice(0, 16).replace("T", " ")} UTC), so Radius changed nothing. Try again once it finishes.${ending}`
      });
      expect(h.events.filter(([kind]) => kind === "sleep")).toEqual([]);
      expect(h.commands()).not.toContain("iam get-role");
      expect(h.commands()).not.toContain("iam delete-policy");
    }
  );

  it("refuses a subject without the repository with setup's message and fix", async () => {
    const h = harness(
      missingId,
      customTemplate(["repository_owner", "context"])
    );

    const result = await h.access.repair(repairInput);

    expect(result).toEqual({
      ok: false,
      code: "aws-subject-not-repository-specific",
      message:
        "GitHub's OIDC subject for this environment, repository_owner:octo:environment:dev, does not name the repository, because the OIDC subject customization for octo/shop, set on the repository or its organization, includes only the claims repository_owner, context. Other repositories with the same claim values present the same subject, so trusting it would let their workflows sign in to the deploy role. This attempt changed nothing in AWS. Add repo or repository_id to the customization's include_claim_keys, then retry."
    });
    expect(h.commands()).not.toContain("iam update-assume-role-policy");
  });

  it("stops without writing when its lock is lost", async () => {
    const h = harness({
      ...missingId,
      "iam get-policy": [lockPolicy("LOCK1"), lockPolicy("LOCK2")]
    });

    const result = await h.access.repair(repairInput);

    expect(result).toMatchObject({ ok: false, code: "aws-lock-lost" });
    expect(h.commands()).not.toContain("iam update-assume-role-policy");
  });

  it("finishes the repair but warns when the lock cannot be released", async () => {
    const h = harness({
      ...missingId,
      "iam delete-policy": fail("AccessDenied")
    });
    expect(await h.access.repair(repairInput)).toMatchObject({
      ok: true,
      added: [DEV_ID],
      lockWarning: expect.stringContaining("not allowed iam:DeletePolicy")
    });
  });

  it("names both problems when the repair and the release fail", async () => {
    const h = harness({
      ...missingId,
      "iam update-assume-role-policy": fail("AccessDenied"),
      "iam delete-policy": fail("ServiceFailure")
    });
    const result = await h.access.repair(repairInput);
    expect(result).toMatchObject({ ok: false, code: "aws-role-trust-denied" });
    expect("message" in result && result.message).toMatch(
      new RegExp(
        `AccessDenied This repair is done with IAM role ${ROLE}, but Radius could not release its lock: ServiceFailure\\.`
      )
    );
  });

  it.each([
    [
      "was deleted",
      {
        code: "repair-target-changed",
        message: 'GitHub environment "dev" is gone.'
      }
    ],
    [
      "names another role",
      {
        code: "repair-target-changed",
        message: 'GitHub environment "dev" names another role.'
      }
    ]
  ])(
    "stops under the lock, changing nothing, when the environment %s",
    async (_label, changed) => {
      const h = harness(missingId);
      const checkedAfter: string[][] = [];

      const result = await h.access.repair({
        ...repairInput,
        confirmTarget: async () => {
          checkedAfter.push(h.commands());
          return changed;
        }
      });

      expect(result).toEqual({ ok: false, ...changed });
      // Checked once the lock is held and confirmed, before the role is read.
      expect(checkedAfter).toEqual([
        [
          "sts get-caller-identity",
          "iam get-open-id-connect-provider",
          "iam create-policy",
          "iam get-policy"
        ]
      ]);
      expect(h.commands()).not.toContain("iam get-role");
      expect(h.commands()).not.toContain("iam update-assume-role-policy");
      // The lock is released.
      expect(h.commands().at(-1)).toBe("iam delete-policy");
    }
  );

  it("builds the subjects from GitHub's spelling of the environment", async () => {
    const h = harness(missingId, {
      ...defaultSubject,
      "/repos/octo/shop/environments/DEV": {
        ok: true,
        status: 200,
        json: { name: "dev" }
      }
    });

    expect(
      await h.access.repair({ ...repairInput, environment: "DEV" })
    ).toMatchObject({ ok: true, added: [DEV_ID] });
    const create = h.find("iam create-policy") ?? [];
    expect(
      JSON.parse(create[create.indexOf("--description") + 1] ?? "")
    ).toMatchObject({ environment: "dev" });
  });

  it.each([
    [
      "cannot be read",
      { ok: false, status: 404, stderr: "Not Found" },
      "Not Found"
    ],
    [
      "has no name",
      { ok: true, status: 200, json: {} },
      "GitHub reported no name"
    ],
    ["fails without a message", { ok: false, status: 502 }, "HTTP 502"],
    ["fails with no status", { ok: false }, "HTTP unknown"]
  ])(
    "changes nothing when the environment %s",
    async (_label, answer, reason) => {
      const h = harness(missingId, {
        ...defaultSubject,
        "/repos/octo/shop/environments/dev": answer
      });

      expect(await h.access.repair(repairInput)).toEqual({
        ok: false,
        code: "github-environment-unreadable",
        message: `Radius could not read GitHub environment "dev" (${reason}), so it changed nothing.`
      });
      expect(h.awsCalls).toEqual([]);
    }
  );

  it("refuses at once, without sleeping, when IAM will not say who holds the lock", async () => {
    const h = harness({
      ...missingId,
      "iam create-policy": fail("EntityAlreadyExists"),
      "iam get-policy": fail("NoSuchEntity: gone")
    });

    expect(await h.access.repair(repairInput)).toEqual({
      ok: false,
      code: "aws-lock-busy",
      message: `IAM reports a lock on IAM role ${ROLE} but could not say who holds it, so Radius changed nothing. Try again in a moment.`
    });
    expect(h.events.filter(([kind]) => kind === "sleep")).toEqual([]);
    expect(h.commands().filter((c) => c === "iam create-policy")).toHaveLength(
      2
    );
    expect(h.commands()).not.toContain("iam get-role");
  });

  it("passes through a lock it created but IAM never showed, naming its policy ID", async () => {
    const h = harness({
      ...missingId,
      "iam create-policy": lockPolicy("LOCK1"),
      "iam get-policy": fail("NoSuchEntity: not yet")
    });

    const result = await h.access.repair(repairInput);

    expect(result).toMatchObject({ ok: false, code: "aws-lock-unconfirmed" });
    expect("message" in result && result.message).toContain(
      `Check that "aws iam get-policy --policy-arn ${LOCK_ARN} --query Policy.PolicyId --output text" prints LOCK1`
    );
    expect(h.commands()).not.toContain("iam get-role");
  });

  it("passes through a lock another run replaced before it was confirmed", async () => {
    const h = harness({
      ...missingId,
      "iam create-policy": lockPolicy("LOCK1"),
      "iam get-policy": lockPolicy("LOCK2")
    });
    expect(await h.access.repair(repairInput)).toMatchObject({
      ok: false,
      code: "aws-lock-lost"
    });
  });

  it("passes through IAM being unreachable, without backing off", async () => {
    const h = harness({
      ...missingId,
      "iam create-policy": fail("Throttling: Rate exceeded")
    });
    expect(await h.access.repair(repairInput)).toEqual({
      ok: false,
      code: "aws-lock-unreachable",
      message: `Radius could not reach IAM to lock IAM role ${ROLE} (Throttling: Rate exceeded). Nothing was changed. Retry.`
    });
    expect(h.events.filter(([kind]) => kind === "sleep")).toEqual([]);
  });

  it("still takes a lock released between IAM's create and read", async () => {
    const h = harness({
      ...missingId,
      "iam create-policy": [fail("EntityAlreadyExists"), lockPolicy("LOCK1")],
      "iam get-policy": [fail("NoSuchEntity: gone"), lockPolicy("LOCK1")]
    });

    expect(await h.access.repair(repairInput)).toMatchObject({ ok: true });
  });
});

describe("AWS environment access with a setup journal", () => {
  function journalOf(
    overrides: Partial<AwsSetupJournal<Operation>> = {}
  ): AwsSetupJournal<Operation> {
    return {
      reconcile: async () => false,
      write: async () => {
        throw new Error("unexpected journaled write");
      },
      ...overrides
    };
  }

  it("settles an interrupted write first, and pauses when reconciliation asks", async () => {
    let h: ReturnType<typeof harness>;
    const reconcile = vi.fn(async () => {
      h.requestStop();
      return true;
    });
    h = harness(
      happyPath,
      defaultSubject,
      undefined,
      undefined,
      undefined,
      journalOf({ reconcile })
    );

    expect(await h.access.setup(operation, input, EXECUTOR)).toEqual({
      ok: false,
      stopped: true
    });

    expect(reconcile).toHaveBeenCalledExactlyOnceWith(operation);
    expect(h.awsCalls).toEqual([]);
    expect(h.events).toContainEqual(["setStageState", "op-1", STAGE, "paused"]);
    expect(h.steps()).toContain(
      "⏸️ Radius checked the AWS change the interrupted setup was making and paused. Continue setup, or delete it to remove what it created."
    );
  });

  it("goes on with setup when a settled write asked for no pause", async () => {
    const write = vi.fn<AwsSetupJournal<Operation>["write"]>(
      async (_op, _change, args, sender) =>
        (await sender.guard(args)) ?? sender.run(args)
    );
    const h = harness(
      happyPath,
      defaultSubject,
      undefined,
      undefined,
      undefined,
      journalOf({ reconcile: async () => true, write })
    );

    expect(await h.access.setup(operation, input, EXECUTOR)).toMatchObject({
      ok: true
    });
    expect(write.mock.calls.map(([, change]) => change.kind)).toEqual([
      "aws_role.create",
      "aws_role_policy.put",
      "aws_access_entry.create"
    ]);
  });

  it("gives the journal the setup's own pause and lock checks", async () => {
    let h: ReturnType<typeof harness>;
    const seen: unknown[] = [];
    const write = vi.fn<AwsSetupJournal<Operation>["write"]>(
      async (_op, change, args, sender) => {
        if (change.kind !== "aws_role.create") return sender.run(args);
        seen.push(await sender.guard(args));
        seen.push(await sender.read(["iam", "get-role-policy"]));
        h.requestStop();
        seen.push(await sender.guard(args));
        seen.push(await sender.read(["iam", "get-role-policy"]));
        return sender.run(args);
      }
    );
    h = harness(
      happyPath,
      defaultSubject,
      undefined,
      undefined,
      undefined,
      journalOf({ write })
    );

    await h.access.setup(operation, input, EXECUTOR);

    expect(seen[0]).toBeNull();
    expect(seen[1]).toMatchObject({ code: 254, stderr: "NoSuchEntity" });
    expect(seen[2]).toMatchObject({
      stderr: "Radius did not run this AWS command because setup was paused."
    });
    expect(seen[3]).toEqual(seen[2]);
    // The lock was checked before the write the guard allowed.
    expect(
      h.commands().filter((command) => command === "iam get-policy").length
    ).toBeGreaterThan(1);
  });
});

describe("AWS environment access rollback", () => {
  const MINE = JSON.stringify({
    repo: "octo/shop",
    environment: "dev",
    action: "setup",
    operationId: "op-1"
  });
  const target = {
    key: "policy",
    artifactType: "aws_role_policy" as const,
    roleArn: ROLE_ARN,
    roleName: ROLE,
    policyName: "radius-deploy-dev-1"
  };
  const rollbackScript = (lock: Record<string, Answer>) => ({
    "--version": ok("aws-cli/2.17.0"),
    "sts get-caller-identity": ok({ Account: ACCOUNT }),
    "iam get-role": ok({
      Role: {
        Arn: ROLE_ARN,
        AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [DEV])
      }
    }),
    "iam delete-role-policy": ok(),
    "iam delete-policy": ok(),
    ...lock
  });

  it("takes a new lock for the rollback and releases it", async () => {
    const h = harness(
      rollbackScript({
        "iam create-policy": lockPolicy("LOCK1"),
        "iam get-policy": lockPolicy("LOCK1")
      })
    );

    expect(
      await h.access.rollback({
        repo: "octo/shop",
        environment: "dev",
        operationId: "op-1",
        roleArn: ROLE_ARN,
        targets: [target]
      })
    ).toEqual({
      outcomes: [{ key: "policy", outcome: "deleted", detail: null }],
      warnings: [],
      released: true
    });

    const create = h.find("iam create-policy");
    expect(create?.[create.indexOf("--description") + 1]).toBe(
      JSON.stringify({
        repo: "octo/shop",
        environment: "dev",
        action: "rollback",
        operationId: "op-1"
      })
    );
    expect(h.commands().at(-1)).toBe("iam delete-policy");
  });

  it("hands over the lock it takes before changing anything", async () => {
    const h = harness(
      rollbackScript({
        "iam create-policy": lockPolicy("LOCK1"),
        "iam get-policy": lockPolicy("LOCK1")
      })
    );
    const seen: Array<[unknown, string[]]> = [];

    await h.access.rollback({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op-1",
      roleArn: ROLE_ARN,
      targets: [target],
      onLocked: async (lock) => {
        seen.push([lock, h.commands()]);
      }
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual({
      policyArn: `arn:aws:iam::${ACCOUNT}:policy/radius-lock-${ROLE}`,
      policyId: "LOCK1"
    });
    expect(seen[0]?.[1]).not.toContain("iam delete-role-policy");
  });

  it("sends nothing once the execution has ended", async () => {
    const h = harness(rollbackScript({}));
    await expect(
      h.access.rollback({
        repo: "octo/shop",
        environment: "dev",
        operationId: "op-1",
        roleArn: ROLE_ARN,
        targets: [target],
        isStopped: () => true
      })
    ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
    expect(h.commands()).toEqual([]);
  });

  it.each([
    ["before the lock", "sts get-caller-identity"],
    ["while it holds the lock", "iam get-role"]
  ])(
    "stops %s once the execution ends, and still releases the lock",
    async (_label, last) => {
      const h = harness(
        rollbackScript({
          "iam create-policy": lockPolicy("LOCK1"),
          "iam get-policy": lockPolicy("LOCK1")
        })
      );
      await expect(
        h.access.rollback({
          repo: "octo/shop",
          environment: "dev",
          operationId: "op-1",
          roleArn: ROLE_ARN,
          targets: [target],
          isStopped: () => h.commands().includes(last)
        })
      ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
      expect(h.commands()).not.toContain("iam delete-role-policy");
      expect(h.commands().includes("iam create-policy")).toBe(
        h.commands().at(-1) === "iam delete-policy"
      );
    }
  );

  it("takes back the setup's recorded lock instead of waiting on it", async () => {
    const h = harness(
      rollbackScript({
        "iam create-policy": fail(
          "An error occurred (EntityAlreadyExists) when calling CreatePolicy"
        ),
        "iam get-policy": lockPolicy("LOCK0", { Description: MINE })
      })
    );

    expect(
      await h.access.rollback({
        repo: "octo/shop",
        environment: "dev",
        operationId: "op-1",
        roleArn: ROLE_ARN,
        targets: [target],
        adopt: "LOCK0"
      })
    ).toMatchObject({ released: true, warnings: [] });
    expect(h.commands()).toContain("iam delete-role-policy");
  });

  it("reports a lock another run holds, without waiting or changing anything", async () => {
    const h = harness(
      rollbackScript({
        "iam create-policy": fail(
          "An error occurred (EntityAlreadyExists) when calling CreatePolicy"
        ),
        "iam get-policy": lockPolicy("LOCK9", {
          Description: JSON.stringify({
            repo: "octo/shop",
            environment: "prod",
            action: "setup",
            operationId: "op-2"
          }),
          CreateDate: "2026-10-30T11:59:00Z"
        })
      })
    );

    const result = await h.access.rollback({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op-1",
      roleArn: ROLE_ARN,
      targets: [target]
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ key: "policy", outcome: "warning" })
    ]);
    expect(result.outcomes[0]?.detail).toContain("is changing IAM role");
    expect(h.commands()).not.toContain("iam delete-role-policy");
    expect(h.events.filter(([kind]) => kind === "sleep")).toEqual([]);
  });

  const entryTarget = {
    key: "entry",
    artifactType: "aws_access_entry" as const,
    roleArn: ROLE_ARN,
    roleName: ROLE,
    cluster: "shop",
    region: "us-west-2"
  };
  const entryScript = (lock: Record<string, Answer>) => ({
    ...rollbackScript(lock),
    "iam get-role": ok({
      Role: { ...JSON.parse(managedRoleFor([DEV])), Arn: ROLE_ARN }
    }),
    "eks describe-access-entry": ok({
      accessEntry: { tags: { "radius-managed": "true" } }
    }),
    "eks delete-access-entry": ok(),
    "iam update-assume-role-policy": ok()
  });

  it("removes an access entry no other environment of the repository uses", async () => {
    const h = harness(
      entryScript({
        "iam create-policy": lockPolicy("LOCK1"),
        "iam get-policy": lockPolicy("LOCK1")
      }),
      defaultSubject,
      undefined,
      undefined,
      { dev: {} }
    );

    const result = await h.access.rollback({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op-1",
      roleArn: ROLE_ARN,
      targets: [
        {
          key: "subject",
          artifactType: "aws_trust_subject",
          roleArn: ROLE_ARN,
          roleName: ROLE,
          subject: DEV
        },
        entryTarget
      ]
    });

    expect(result.outcomes).toEqual([
      { key: "entry", outcome: "deleted", detail: null },
      { key: "subject", outcome: "deleted", detail: null }
    ]);
    // The repository's environments were listed, so the rule could run.
    expect(h.environmentReads).toEqual(["dev"]);
  });

  it("reports a lock it could not release", async () => {
    const h = harness(
      rollbackScript({
        "iam create-policy": lockPolicy("LOCK1"),
        "iam get-policy": lockPolicy("LOCK1"),
        "iam delete-policy": fail("AccessDenied: iam:DeletePolicy")
      })
    );

    const result = await h.access.rollback({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op-1",
      roleArn: ROLE_ARN,
      targets: [target]
    });

    expect(result.released).toBe(false);
    expect(result.warnings).toEqual([
      expect.stringContaining("could not release its lock")
    ]);
  });

  it("reports a lock another run took while the rollback held it", async () => {
    const h = harness(
      rollbackScript({
        "iam create-policy": lockPolicy("LOCK1"),
        "iam get-policy": [lockPolicy("LOCK1"), lockPolicy("LOCK9")]
      })
    );

    const result = await h.access.rollback({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op-1",
      roleArn: ROLE_ARN,
      targets: [target]
    });

    expect(result.warnings[0]).toMatch(/another run now holds a new one/);
    expect(h.commands()).not.toContain("iam delete-role-policy");
  });

  it("keeps an access entry when GitHub cannot list the other environments", async () => {
    const h = harness(
      {
        ...rollbackScript({
          "iam create-policy": lockPolicy("LOCK1"),
          "iam get-policy": lockPolicy("LOCK1")
        }),
        "iam get-role": ok({
          Role: {
            ...JSON.parse(managedRoleFor([DEV])),
            Arn: ROLE_ARN
          }
        }),
        "eks describe-access-entry": ok({
          accessEntry: { tags: { "radius-managed": "true" } }
        })
      },
      {}
    );

    const result = await h.access.rollback({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op-1",
      roleArn: ROLE_ARN,
      targets: [
        {
          key: "entry",
          artifactType: "aws_access_entry",
          roleArn: ROLE_ARN,
          roleName: ROLE,
          cluster: "shop",
          region: "us-west-2"
        }
      ]
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ key: "entry", outcome: "warning" })
    ]);
    expect(h.commands()).not.toContain("eks delete-access-entry");
  });
});

function managedRoleFor(subjects: string[]): string {
  return JSON.stringify({
    AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects),
    Tags: [
      { Key: "radius-managed", Value: "true" },
      { Key: "radius-repository", Value: "octo/shop" }
    ]
  });
}
