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
  "iam create-policy": lockPolicy("LOCK1"),
  "iam get-policy": lockPolicy("LOCK1"),
  "iam delete-policy": ok()
};

const happyPath: Record<string, Answer> = {
  ...lockFree,
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

// GitHub answers for octo/shop with the default subject, as github.com
// reports it: an older repository has `use_immutable_subject: false` and its
// tokens may carry either form, a new one has `true` and only the ID-based form.
function githubSubjects(
  useImmutableSubject: boolean
): Record<string, GitHubJsonResponse> {
  return {
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
    }
  };
}
const defaultSubject = githubSubjects(false);

interface Operation {
  id: string;
}

function harness(
  aws: Record<string, Answer>,
  github: Record<string, GitHubJsonResponse> = defaultSubject,
  // The customer pauses while this AWS command, or the last GitHub read, runs.
  pauseDuring?: string
) {
  let stopRequested = false;
  const awsCalls: string[][] = [];
  const githubCalls: Array<{
    path: string;
    executor: SelectedGhExecutor | undefined;
  }> = [];
  const events: unknown[][] = [];
  let clock = Date.parse("2026-10-30T12:00:00Z");
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
      if (command === pauseDuring) stopRequested = true;
      return result;
    },
    async runGitHubJson(path, executor) {
      githubCalls.push({ path, executor });
      const response = github[path];
      if (!response) throw new Error(`unexpected GitHub read ${path}`);
      if (pauseDuring === "github" && path.endsWith("/customization/sub")) {
        stopRequested = true;
      }
      return response;
    },
    isStopRequested: () => stopRequested,
    operationId: (operation) => operation.id,
    now: () => clock,
    async sleep(milliseconds) {
      events.push(["sleep", milliseconds]);
      clock += milliseconds;
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
      },
      touch: (operation) => {
        events.push(["touch", operation.id]);
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
    find,
    commands,
    steps,
    roleRecorded,
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
    [false, [DEV, DEV_ID]],
    [true, [DEV_ID]]
  ])(
    "authorizes a new role for every subject GitHub may present (use_immutable_subject %s)",
    async (useImmutableSubject, subjects) => {
      const h = harness(happyPath, githubSubjects(useImmutableSubject));

      const result = await h.access.setup(operation, input, EXECUTOR);

      expect(result).toEqual({ ok: true, roleArn: ROLE_ARN, subjects });
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
      expect(trustedGitHubSubjects(trust, ACCOUNT)).toEqual(subjects);
      expect(h.events[0]).toEqual(["enterStage", "op-1", STAGE]);
      expect(h.events).toContainEqual([
        "step",
        "op-1",
        `ℹ️ Deploy identity will trust ${subjects.join(", ")}`,
        STAGE
      ]);
      // Progress is saved before the role and its subjects are recorded.
      expect(h.events.slice(-2)).toEqual([
        ["persist"],
        [
          "setContext",
          "op-1",
          { awsRoleArn: ROLE_ARN, awsTrustSubjects: subjects }
        ]
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
      subjects: [DEV, DEV_ID]
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
    expect(h.events.at(-1)).toEqual(["persist"]);
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
      { awsRoleArn: ROLE_ARN, awsTrustSubjects: [DEV, DEV_ID] }
    ]);
    expect(steps(h).at(-1)).toBe(
      `⏸️ Paused after AWS setup finished. ${ROLE_ARN} is ready for this environment.`
    );
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

  it("removes exactly the subjects setup recorded without asking GitHub", async () => {
    const h = harness(roleTrusting([DEV, DEV_ID, PROD]));

    const result = await h.access.remove({
      repo: "octo/shop",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV, DEV_ID]
    });

    expect(result).toEqual({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev"
      ],
      kept: [`IAM role ${ROLE}`, "the account's GitHub identity provider"]
    });
    expect(h.githubCalls).toEqual([]);
    expect(remainingTrust(h)).toEqual([PROD]);
  });

  it("removes the recorded subjects after the repository is renamed", async () => {
    // Setup recorded octo/shop's subjects; GitHub now reports octo/store.
    const h = harness(roleTrusting([DEV, DEV_ID, PROD]), {
      "/repos/octo/store": {
        ok: true,
        status: 200,
        json: { full_name: "octo/store", id: 42, owner: { id: 7 } }
      }
    });

    const result = await h.access.remove({
      repo: "octo/store",
      environment: "dev",
      roleArn: ROLE_ARN,
      trustSubjects: [DEV, DEV_ID]
    });

    expect(result).toMatchObject({
      ok: true,
      removed: [
        `trust subject ${DEV}`,
        `trust subject ${DEV_ID}`,
        "policy radius-deploy-dev"
      ]
    });
    expect(remainingTrust(h)).toEqual([PROD]);
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
        ...recorded
      });

      expect(result).toMatchObject({
        ok: true,
        removed: [
          `trust subject ${DEV}`,
          `trust subject ${DEV_ID}`,
          "policy radius-deploy-dev"
        ]
      });
      // Read with the ambient account: deletion has no selected executor.
      expect(h.githubCalls.map(({ executor }) => executor)).toEqual([
        undefined,
        undefined
      ]);
      expect(remainingTrust(h)).toEqual([PROD]);
    }
  );
});

describe("the deploy identity lock during setup", () => {
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
    expect(commands.filter((c) => c === "iam get-policy")).toHaveLength(
      writes.length
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

  it("reports a lock it could not release, with the command to remove it", async () => {
    const h = harness({
      ...happyPath,
      "iam delete-policy": fail("AccessDenied: iam:DeletePolicy")
    });
    await h.access.setup(operation, input, EXECUTOR);

    await h.access.release(operation);

    expect(h.steps().at(-1)).toBe(
      `⚠️ Radius could not release the lock on IAM role ${ROLE} because the signed-in AWS identity is not allowed iam:DeletePolicy. Other runs wait for it until it is removed. Run: aws iam delete-policy --policy-arn ${LOCK_ARN}`
    );
  });

  it("reports rather than throws when releasing fails unexpectedly", async () => {
    const h = harness({ ...happyPath, "iam delete-policy": [] });
    await h.access.setup(operation, input, EXECUTOR);

    await expect(h.access.release(operation)).resolves.toBeUndefined();

    expect(h.steps().at(-1)).toBe(
      `⚠️ Radius could not release the lock on the deploy identity: unexpected aws iam delete-policy --policy-arn ${LOCK_ARN}. Other runs wait for it until it is removed. Run: aws iam delete-policy --policy-arn ${LOCK_ARN}`
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
      `⏳ Waiting for the lock on IAM role ${ROLE}. The setup of environment prod in octo/shop has held it since 2026-10-30 11:58 UTC.`
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
          since: "2026-10-30T11:58:30Z",
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
      `⚠️ The lock on IAM role ${ROLE} has been held for more than 10 minutes. If that run has stopped, use Remove lock.`
    );
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
  });

  it("stops before the next write when its lock is removed, naming what it created", async () => {
    const h = harness({
      ...happyPath,
      "iam get-policy": [
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
      `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds it (The setup of environment prod in octo/shop). Radius stopped before changing the role. Created before setup stopped: the GitHub identity provider in account ${ACCOUNT}. Retry setup to finish, or remove them in the AWS console if you will not retry.`
    );
    expect(h.commands()).not.toContain("iam create-role");
    expect(h.roleRecorded()).toBe(false);
  });

  it("says nothing was created when the lock is lost before the first write", async () => {
    const h = harness({
      ...happyPath,
      "iam get-policy": fail("NoSuchEntity: gone")
    });

    const result = await h.access.setup(operation, input, EXECUTOR);

    expect(result).toMatchObject({ ok: false, code: "aws-lock-lost" });
    expect("error" in result && result.error).toMatch(
      /Nothing was created in AWS\.$/
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
    operationId: "del-1"
  };
  const signedIn: Record<string, Answer> = {
    ...lockFree,
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
      "sts get-caller-identity",
      "iam create-policy",
      "iam get-role",
      "iam get-policy",
      "iam update-assume-role-policy",
      "iam get-policy",
      "iam delete-role-policy",
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
      "sts get-caller-identity",
      "iam create-policy"
    ]);
  });

  it("stops and reports when the lock is lost before a write", async () => {
    const h = harness({
      ...signedIn,
      "iam get-policy": [lockPolicy("LOCK2")]
    });

    const result = await h.access.remove(removal);

    expect(result).toEqual({
      ok: false,
      message: `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds it (Another run). Radius stopped before changing the role.`
    });
    expect(h.commands()).not.toContain("iam update-assume-role-policy");
    expect(h.commands()).not.toContain("iam delete-policy");
  });

  it("finishes the removal but warns when the lock cannot be released", async () => {
    const h = harness({
      ...signedIn,
      "iam delete-policy": fail("AccessDenied")
    });

    const result = await h.access.remove(removal);

    expect(result).toMatchObject({
      ok: true,
      removed: [`trust subject ${DEV}`, "policy radius-deploy-dev"],
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
      /^Failed to remove .* Throttling Radius could not release the lock/
    );
  });

  it("releases the lock when the removal throws", async () => {
    const h = harness({ ...signedIn, "iam delete-role-policy": [] });

    await expect(h.access.remove(removal)).rejects.toThrow(
      "unexpected aws iam delete-role-policy"
    );

    expect(h.commands().at(-1)).toBe("iam delete-policy");
  });
});

// IAM as two concurrent setups see it: one account, one role, and the lock's
// name uniqueness. Every call yields first, so the setups interleave.
function sharedIam() {
  let role: { trust: unknown } | null = {
    trust: buildGitHubTrustPolicy(ACCOUNT, [])
  };
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
        return ok({ cluster: { accessConfig: { authenticationMode: "API" } } });
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
      case "iam get-role":
        return role ?
            ok({
              Role: {
                Arn: ROLE_ARN,
                CreateDate: "2026-10-01T00:00:00Z",
                AssumeRolePolicyDocument: role.trust,
                Tags: [
                  { Key: "radius-managed", Value: "true" },
                  { Key: "radius-repository", Value: "octo/shop" }
                ]
              }
            })
          : fail("NoSuchEntity");
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
      case "iam update-assume-role-policy":
        writes.push(command);
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
        isStopRequested: () => false,
        operationId: (operation) => operation.id,
        now: () => Date.parse("2026-10-30T12:00:00Z"),
        async sleep() {
          await new Promise((resolve) => setImmediate(resolve));
        },
        operations: {
          enterStage: () => {},
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
  it("keeps both environments' subjects in the trust policy", async () => {
    const iam = sharedIam();
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
  });
});
