import { buildGitHubTrustPolicy } from "@radius-project/core";
import { describe, expect, it, vi } from "vitest";
import {
  beginRetryAttempt,
  createOperation,
  prepareProviderMutation,
  requestStop
} from "../../operations.js";
import type {
  AwsCommandResult,
  AwsSetupChange
} from "./aws-deploy-identity.js";
import {
  awsSetupChangeFromIntent,
  awsSetupChangeIntent,
  awsSetupChangeTarget,
  AwsSessionUnavailableError,
  createAwsSetupJournal,
  reconcileAwsSetupChange,
  recordAwsSetupChange
} from "./aws-setup-journal.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";

const ACCOUNT = "123456789012";
const ROLE = "radius-deploy-octo-shop";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
const SUBJECTS = ["repo:octo/shop:environment:dev"];
const REQUESTED = "2026-10-30T12:00:00.000Z";

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
const SESSION = {
  "--version": ok("aws-cli/2.17.0 Python/3.11 Linux/6"),
  "sts get-caller-identity": ok({ Account: ACCOUNT })
};

const CHANGES: Record<AwsSetupChange["kind"], AwsSetupChange> = {
  "aws_role.create": {
    kind: "aws_role.create",
    accountId: ACCOUNT,
    roleArn: ROLE_ARN,
    roleName: ROLE,
    subjects: SUBJECTS
  },
  "aws_trust.add": {
    kind: "aws_trust.add",
    accountId: ACCOUNT,
    roleArn: ROLE_ARN,
    roleName: ROLE,
    roleId: "AROA1",
    subjects: SUBJECTS
  },
  "aws_role_policy.put": {
    kind: "aws_role_policy.put",
    accountId: ACCOUNT,
    roleArn: ROLE_ARN,
    roleName: ROLE,
    roleId: "AROA1",
    policyName: "radius-deploy-dev-1"
  },
  "aws_access_entry.create": {
    kind: "aws_access_entry.create",
    accountId: ACCOUNT,
    roleArn: ROLE_ARN,
    roleName: ROLE,
    roleId: "AROA1",
    cluster: "shop",
    region: "us-west-2"
  }
};

// Answers by the first two words of the command; anything else throws.
function fakeAws(script: Record<string, AwsCommandResult>) {
  const calls: string[] = [];
  const runAws = vi.fn(async (args: string[]) => {
    const key = args.slice(0, 2).join(" ");
    calls.push(key);
    const answer =
      script[key] ?? (args[0] === "--version" && script["--version"]);
    if (!answer) throw new Error(`unexpected aws ${args.join(" ")}`);
    return answer;
  });
  return { runAws, calls };
}

function operation() {
  return createOperation({
    operationId: "op_journal",
    repo: "octo/shop",
    environment: "dev",
    provider: "aws"
  });
}

describe("AWS setup change identity", () => {
  it.each(Object.values(CHANGES))(
    "round-trips $kind through the saved intent",
    (change) => {
      const intent = awsSetupChangeIntent(change, REQUESTED);
      expect(intent.requestedAt).toBe(REQUESTED);
      expect(awsSetupChangeFromIntent(change.kind, intent)).toEqual(change);
    }
  );

  it("scopes each target to the setup attempt", () => {
    expect(
      Object.values(CHANGES).map((change) => awsSetupChangeTarget(change, 2))
    ).toEqual([
      `attempt-2|${ROLE_ARN}`,
      `attempt-2|${ROLE_ARN}#trust`,
      `attempt-2|${ROLE_ARN}#radius-deploy-dev-1`,
      `attempt-2|us-west-2:shop:${ROLE_ARN}`
    ]);
  });

  it.each([
    [
      "an unknown kind",
      "aws_other.create",
      { accountId: ACCOUNT, roleArn: ROLE_ARN, roleName: ROLE }
    ],
    ["no intent", "aws_role.create", undefined],
    ["no role", "aws_role.create", { accountId: ACCOUNT, roleArn: ROLE_ARN }],
    [
      "unreadable subjects",
      "aws_trust.add",
      { accountId: ACCOUNT, roleArn: ROLE_ARN, roleName: ROLE, subjects: "x" }
    ],
    [
      "an empty subject",
      "aws_trust.add",
      {
        accountId: ACCOUNT,
        roleArn: ROLE_ARN,
        roleName: ROLE,
        subjects: '[""]'
      }
    ],
    [
      "no policy name",
      "aws_role_policy.put",
      { accountId: ACCOUNT, roleArn: ROLE_ARN, roleName: ROLE }
    ],
    [
      "no region",
      "aws_access_entry.create",
      { accountId: ACCOUNT, roleArn: ROLE_ARN, roleName: ROLE, cluster: "c" }
    ]
  ])("reads no change from %s", (_label, kind, intent) => {
    expect(awsSetupChangeFromIntent(kind, intent)).toBeNull();
  });
});

describe("reconcileAwsSetupChange", () => {
  const OP = "op_journal";
  const role = (operationTag: string | null, subjects = SUBJECTS) =>
    ok({
      Role: {
        Arn: ROLE_ARN,
        RoleId: "AROA1",
        CreateDate: REQUESTED,
        AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects),
        Tags: [
          { Key: "radius-managed", Value: "true" },
          ...(operationTag === null ?
            []
          : [{ Key: "radius-operation", Value: operationTag }])
        ]
      }
    });

  // Creation time is no proof: a role another setup created later under the
  // same name dates after the request just as well.
  it.each([
    ["tagged with this operation", OP, "applied"],
    ["tagged with another operation", "op_later", "not_applied"],
    ["with no operation tag", null, "not_applied"]
  ])("settles a role %s", async (_label, tag, state) => {
    const aws = fakeAws({ ...SESSION, "iam get-role": role(tag) });
    const outcome = await reconcileAwsSetupChange(
      CHANGES["aws_role.create"],
      OP,
      aws.runAws
    );
    expect(outcome.state).toBe(state);
    if (outcome.state === "applied") {
      expect(outcome.providerId).toBe("AROA1");
    }
  });

  it("settles a role IAM lists no tags for as not applied", async () => {
    const aws = fakeAws({
      ...SESSION,
      "iam get-role": ok({ Role: { Arn: ROLE_ARN, RoleId: "AROA1" } })
    });
    expect(
      (
        await reconcileAwsSetupChange(
          CHANGES["aws_role.create"],
          OP,
          aws.runAws
        )
      ).state
    ).toBe("not_applied");
  });

  it("settles a created role IAM gives no id for", async () => {
    const aws = fakeAws({
      ...SESSION,
      "iam get-role": ok({
        Role: {
          Arn: ROLE_ARN,
          Tags: [{ Key: "radius-operation", Value: OP }]
        }
      })
    });
    expect(
      await reconcileAwsSetupChange(CHANGES["aws_role.create"], OP, aws.runAws)
    ).toMatchObject({ state: "applied", providerId: null });
  });

  it.each([
    [SUBJECTS, "applied"],
    [["repo:octo/shop:environment:prod"], "not_applied"]
  ])(
    "settles a trust change by whether the role trusts %j",
    async (trusted, state) => {
      const aws = fakeAws({
        ...SESSION,
        "iam get-role": role(null, trusted)
      });
      expect(
        (
          await reconcileAwsSetupChange(
            CHANGES["aws_trust.add"],
            OP,
            aws.runAws
          )
        ).state
      ).toBe(state);
    }
  );

  it.each([
    ["aws_role.create", "iam get-role", "NoSuchEntity"],
    ["aws_trust.add", "iam get-role", "NoSuchEntity"],
    ["aws_role_policy.put", "iam get-role-policy", "NoSuchEntity"],
    [
      "aws_access_entry.create",
      "eks describe-access-entry",
      "ResourceNotFoundException"
    ]
  ] as const)(
    "settles %s as not applied when AWS has nothing",
    async (kind, read, missing) => {
      const aws = fakeAws({
        ...SESSION,
        [read]: fail(`An error occurred (${missing})`)
      });
      expect(
        await reconcileAwsSetupChange(CHANGES[kind], OP, aws.runAws)
      ).toMatchObject({ state: "not_applied" });
    }
  );

  it.each([
    ["aws_role.create", "iam get-role"],
    ["aws_role_policy.put", "iam get-role-policy"],
    ["aws_access_entry.create", "eks describe-access-entry"]
  ] as const)(
    "keeps %s unknown when AWS cannot be read",
    async (kind, read) => {
      const aws = fakeAws({ ...SESSION, [read]: fail("AccessDenied") });
      await expect(
        reconcileAwsSetupChange(CHANGES[kind], OP, aws.runAws)
      ).rejects.toThrow(/Could not read the .*AccessDenied/);
    }
  );

  it("keeps the outcome unknown when the CLI is in another account", async () => {
    const aws = fakeAws({
      ...SESSION,
      "sts get-caller-identity": ok({ Account: "999999999999" })
    });
    await expect(
      reconcileAwsSetupChange(CHANGES["aws_role.create"], OP, aws.runAws)
    ).rejects.toThrow(/999999999999/);
    expect(aws.calls).not.toContain("iam get-role");
  });

  it("settles a policy that exists as applied", async () => {
    const aws = fakeAws({ ...SESSION, "iam get-role-policy": ok("{}") });
    expect(
      await reconcileAwsSetupChange(
        CHANGES["aws_role_policy.put"],
        OP,
        aws.runAws
      )
    ).toEqual({ state: "applied", value: "" });
  });

  it.each([
    ["tagged with this operation", { "radius-operation": OP }, "applied"],
    [
      "tagged with another operation",
      { "radius-operation": "op_later" },
      "not_applied"
    ],
    ["with no operation tag", { "radius-managed": "true" }, "not_applied"],
    ["with no tags", undefined, "not_applied"]
  ])("settles an access entry %s", async (_label, tags, state) => {
    const aws = fakeAws({
      ...SESSION,
      "eks describe-access-entry": ok({
        accessEntry: { createdAt: REQUESTED, tags }
      })
    });
    expect(
      (
        await reconcileAwsSetupChange(
          CHANGES["aws_access_entry.create"],
          OP,
          aws.runAws
        )
      ).state
    ).toBe(state);
  });
});

describe("recordAwsSetupChange", () => {
  it("records a created role with its id and the subjects it trusts", () => {
    const op = operation();
    recordAwsSetupChange(
      op,
      CHANGES["aws_role.create"],
      JSON.stringify({ Role: { Arn: ROLE_ARN, RoleId: "AROA1" } })
    );
    expect(op.setupArtifacts.awsRole).toEqual({
      state: "created",
      origin: "this_operation",
      roleArn: ROLE_ARN,
      roleName: ROLE,
      roleId: "AROA1"
    });
    // The subjects it was created with name the same role.
    expect(op.setupArtifacts.awsTrustSubjects).toEqual([
      expect.objectContaining({ roleId: "AROA1" })
    ]);
  });

  it.each([
    ["aws_trust.add", "awsTrustSubjects"],
    ["aws_role_policy.put", "awsRolePolicies"],
    ["aws_access_entry.create", "awsAccessEntries"]
  ] as const)("records the role id %s was made on", (kind, list) => {
    const op = operation();
    recordAwsSetupChange(op, CHANGES[kind], "");
    expect(op.setupArtifacts[list]).toEqual([
      expect.objectContaining({ roleId: "AROA1" })
    ]);
  });

  it("keeps a saved role id through the intent", () => {
    for (const kind of [
      "aws_trust.add",
      "aws_role_policy.put",
      "aws_access_entry.create"
    ] as const) {
      expect(
        awsSetupChangeFromIntent(
          kind,
          awsSetupChangeIntent(CHANGES[kind], REQUESTED)
        )
      ).toEqual(CHANGES[kind]);
    }
    expect(
      awsSetupChangeFromIntent("aws_role_policy.put", {
        accountId: ACCOUNT,
        roleArn: ROLE_ARN,
        roleName: ROLE,
        policyName: "p"
      })
    ).toMatchObject({ roleId: null });
  });

  it("records the role under the ARN its trust subjects use", () => {
    const op = operation();
    recordAwsSetupChange(
      op,
      CHANGES["aws_role.create"],
      JSON.stringify({
        Role: { Arn: "arn:aws:iam::123456789012:role/other", RoleId: "AROA1" }
      })
    );
    expect(op.setupArtifacts.awsRole.roleArn).toBe(ROLE_ARN);
    expect(op.setupArtifacts.awsTrustSubjects[0]?.roleArn).toBe(ROLE_ARN);
  });

  it.each(["not json", ""])(
    "records a role CLI output %j did not describe by its request",
    (stdout) => {
      const op = operation();
      recordAwsSetupChange(op, CHANGES["aws_role.create"], stdout);
      expect(op.setupArtifacts.awsRole).toMatchObject({
        roleArn: ROLE_ARN,
        roleId: null
      });
    }
  );

  it.each([
    ["aws_trust.add", "awsTrustSubjects"],
    ["aws_role_policy.put", "awsRolePolicies"],
    ["aws_access_entry.create", "awsAccessEntries"]
  ] as const)("records %s", (kind, list) => {
    const op = operation();
    recordAwsSetupChange(op, CHANGES[kind], "");
    expect(op.setupArtifacts[list]).toHaveLength(1);
    expect(op.setupArtifacts.awsRole.state).toBe("not_started");
  });
});

describe("createAwsSetupJournal", () => {
  function journal(script: Record<string, AwsCommandResult>) {
    const aws = fakeAws(script);
    const persist = vi.fn(async () => {});
    return {
      aws,
      persist,
      journal: createAwsSetupJournal<ReturnType<typeof operation>>({
        runAws: aws.runAws,
        persist,
        now: () => Date.parse(REQUESTED)
      })
    };
  }
  const sender = (
    run: AwsCommandResult,
    refused: AwsCommandResult | null = null
  ) => ({
    read: vi.fn(async (): Promise<AwsCommandResult> => {
      throw new Error("unexpected read");
    }),
    guard: vi.fn(async () => refused),
    run: vi.fn(async () => run)
  });
  const ARGS = ["iam", "create-role", "--role-name", ROLE];

  it("journals a write before sending it and records what it created", async () => {
    const { journal: j, persist } = journal({});
    const op = operation();
    const send = sender(ok({ Role: { Arn: ROLE_ARN, RoleId: "AROA1" } }));
    send.run.mockImplementation(async () => {
      expect(op.providerRecovery.mutations[0]).toMatchObject({
        kind: "aws_role.create",
        status: "prepared",
        intent: expect.objectContaining({ requestedAt: REQUESTED })
      });
      return ok({ Role: { Arn: ROLE_ARN, RoleId: "AROA1" } });
    });

    expect(
      await j.write(op, CHANGES["aws_role.create"], ARGS, send)
    ).toMatchObject({ code: 0 });

    expect(op.providerRecovery.mutations).toEqual([
      expect.objectContaining({
        kind: "aws_role.create",
        target: `attempt-1|${ROLE_ARN}`,
        status: "confirmed",
        providerId: "AROA1",
        createdByOperation: true
      })
    ]);
    expect(op.setupArtifacts.awsRole.state).toBe("created");
    expect(persist).toHaveBeenCalled();
  });

  it("returns a refusal without sending, and records nothing", async () => {
    const { journal: j } = journal({});
    const op = operation();
    const paused = fail("Radius did not run this AWS command.");
    const send = sender(ok(), paused);

    expect(await j.write(op, CHANGES["aws_trust.add"], ARGS, send)).toBe(
      paused
    );

    expect(send.run).not.toHaveBeenCalled();
    expect(op.providerRecovery.mutations[0].status).toBe("not_applied");
    expect(op.setupArtifacts.awsTrustSubjects).toEqual([]);
  });

  // The CLI resends a create after a lost reply, so "already exists" may be
  // about this setup's own first request. The operation tag says which.
  describe.each([
    [
      "aws_role.create",
      "An error occurred (EntityAlreadyExists) when calling the CreateRole operation: Role with name radius-deploy-octo-shop already exists.",
      "iam get-role",
      (tag: string) =>
        ok({
          Role: {
            Arn: ROLE_ARN,
            RoleId: "AROA2",
            Tags: [{ Key: "radius-operation", Value: tag }]
          }
        }),
      (op: ReturnType<typeof operation>) => op.setupArtifacts.awsRole.state
    ],
    [
      "aws_access_entry.create",
      "An error occurred (ResourceInUseException) when calling the CreateAccessEntry operation: The specified access entry resource is already in use on this cluster.",
      "eks describe-access-entry",
      (tag: string) =>
        ok({ accessEntry: { tags: { "radius-operation": tag } } }),
      (op: ReturnType<typeof operation>) =>
        op.setupArtifacts.awsAccessEntries[0]?.state ?? "not_started"
    ]
  ] as const)(
    "a %s AWS answers as already there",
    (kind, stderr, read, answer, recorded) => {
      it("records it as created when it carries this operation's tag", async () => {
        const { journal: j, aws } = journal({
          ...SESSION,
          [read]: answer("op_journal")
        });
        const op = operation();

        expect(
          await j.write(op, CHANGES[kind], ARGS, sender(fail(stderr)))
        ).toMatchObject({ code: 0 });

        expect(aws.calls).toContain(read);
        expect(op.providerRecovery.mutations[0].status).toBe("confirmed");
        expect(recorded(op)).toBe("created");
      });

      it("returns AWS's answer and records nothing when another operation's tag is on it", async () => {
        const { journal: j } = journal({
          ...SESSION,
          [read]: answer("op_other")
        });
        const op = operation();

        expect(
          await j.write(op, CHANGES[kind], ARGS, sender(fail(stderr)))
        ).toMatchObject({ code: 1, stderr });

        expect(op.providerRecovery.mutations[0].status).toBe("not_applied");
        expect(recorded(op)).toBe("not_started");
      });
    }
  );

  it("returns any other write AWS refused, and records nothing", async () => {
    const { journal: j, aws } = journal({});
    const op = operation();
    const refused = fail(
      "An error occurred (AccessDenied) when calling the CreateRole operation"
    );

    expect(
      await j.write(op, CHANGES["aws_role.create"], ARGS, sender(refused))
    ).toMatchObject({ code: 1, stderr: refused.stderr });

    expect(aws.calls).toEqual([]);
    expect(op.providerRecovery.mutations[0].status).toBe("not_applied");
    expect(op.setupArtifacts.awsRole.state).toBe("not_started");
  });

  it("reads AWS to settle a write with no clear answer", async () => {
    const { journal: j, aws } = journal({
      ...SESSION,
      "iam get-role": ok({
        Role: {
          Arn: ROLE_ARN,
          RoleId: "AROA2",
          Tags: [{ Key: "radius-operation", Value: "op_journal" }]
        }
      })
    });
    const op = operation();

    expect(
      await j.write(
        op,
        CHANGES["aws_role.create"],
        ARGS,
        sender({ code: 1, stdout: "", stderr: "", timedOut: true })
      )
    ).toMatchObject({ code: 0 });

    expect(aws.calls).toContain("iam get-role");
    expect(op.setupArtifacts.awsRole).toMatchObject({
      state: "created",
      roleId: "AROA2"
    });
  });

  it("reports a write that AWS shows did not happen", async () => {
    const { journal: j } = journal({
      ...SESSION,
      "eks describe-access-entry": fail(
        "An error occurred (ResourceNotFoundException)"
      )
    });
    const op = operation();

    const result = await j.write(
      op,
      CHANGES["aws_access_entry.create"],
      ARGS,
      sender({ code: 255, stdout: "", stderr: "Connection was closed" })
    );

    expect(result).toMatchObject({ code: 1 });
    expect(result.stderr).toContain("Connection was closed");
    expect(op.setupArtifacts.awsAccessEntries).toEqual([]);
  });

  it("scopes an operation with no control record to its first attempt", async () => {
    const { journal: j } = journal({});
    const op = { operationId: "op_plain" } as unknown as ReturnType<
      typeof operation
    >;
    await j.write(op, CHANGES["aws_trust.add"], ARGS, sender(ok()));
    expect(
      (op as { providerRecovery: { mutations: { target: string }[] } })
        .providerRecovery.mutations[0]?.target
    ).toBe(`attempt-1|${ROLE_ARN}#trust`);
  });

  it("settles a write an earlier run journaled before sending it again", async () => {
    const { journal: j } = journal({
      ...SESSION,
      "iam get-role": fail("An error occurred (NoSuchEntity)")
    });
    const op = operation();
    prepareProviderMutation(op, {
      kind: "aws_role.create",
      target: awsSetupChangeTarget(CHANGES["aws_role.create"], 1)
    });
    const send = sender(ok());

    expect(await j.write(op, CHANGES["aws_role.create"], ARGS, send)).toEqual({
      code: 1,
      stdout: "",
      stderr: "AWS did not make the change, so Radius stopped."
    });
    expect(send.run).not.toHaveBeenCalled();
  });

  it("fails the write when the journal cannot be saved", async () => {
    const aws = fakeAws({});
    const j = createAwsSetupJournal<ReturnType<typeof operation>>({
      runAws: aws.runAws,
      persist: async () => {
        throw new Error("disk full");
      },
      now: () => Date.parse(REQUESTED)
    });
    const send = sender(ok());

    await expect(
      j.write(operation(), CHANGES["aws_trust.add"], ARGS, send)
    ).rejects.toBeInstanceOf(ProviderMutationRecoveryError);
    expect(send.run).not.toHaveBeenCalled();
  });

  it("names the change a new attempt writes as a new entry", async () => {
    const { journal: j } = journal({});
    const op = operation();
    beginRetryAttempt(op, "setup");
    await j.write(op, CHANGES["aws_trust.add"], ARGS, sender(ok()));
    expect(op.providerRecovery.mutations[0].target).toBe(
      `attempt-2|${ROLE_ARN}#trust`
    );
  });

  describe("the environment's policy", () => {
    const put = ["iam", "put-role-policy", "--role-name", ROLE];

    it("is recorded when the role did not have it", async () => {
      const { journal: j } = journal({});
      const op = operation();
      const send = sender(ok());
      send.read.mockResolvedValue(fail("An error occurred (NoSuchEntity)"));

      await j.write(op, CHANGES["aws_role_policy.put"], put, send);

      expect(op.setupArtifacts.awsRolePolicies).toHaveLength(1);
      expect(op.providerRecovery.mutations).toHaveLength(1);
    });

    it("is written but not recorded when the role already had it", async () => {
      const { journal: j } = journal({});
      const op = operation();
      const send = sender(ok());
      send.read.mockResolvedValue(ok("{}"));

      expect(
        await j.write(op, CHANGES["aws_role_policy.put"], put, send)
      ).toMatchObject({ code: 0 });

      expect(send.run).toHaveBeenCalledOnce();
      expect(op.setupArtifacts.awsRolePolicies).toEqual([]);
      expect(op.providerRecovery?.mutations ?? []).toEqual([]);
    });

    it("is not written when a pause or lost lock refuses it", async () => {
      const { journal: j } = journal({});
      const send = sender(ok(), fail("paused"));
      send.read.mockResolvedValue(ok("{}"));

      expect(
        await j.write(operation(), CHANGES["aws_role_policy.put"], put, send)
      ).toMatchObject({ stderr: "paused" });
      expect(send.run).not.toHaveBeenCalled();
    });

    it("says when the existence check printed nothing", async () => {
      const { journal: j } = journal({});
      const send = sender(ok());
      send.read.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
      expect(
        (await j.write(operation(), CHANGES["aws_role_policy.put"], put, send))
          .stderr
      ).toMatch(/: no output$/);
    });

    it("is not written when Radius cannot tell whether it exists", async () => {
      const { journal: j } = journal({});
      const send = sender(ok());
      send.read.mockResolvedValue(fail("AccessDenied"));

      const result = await j.write(
        operation(),
        CHANGES["aws_role_policy.put"],
        put,
        send
      );

      expect(result.stderr).toBe(
        `Could not check whether IAM role ${ROLE} already has policy radius-deploy-dev-1: AccessDenied`
      );
      expect(send.run).not.toHaveBeenCalled();
    });
  });

  describe("reconcile", () => {
    function interrupted(kind: AwsSetupChange["kind"], intent?: object) {
      const op = operation();
      prepareProviderMutation(op, {
        kind,
        target: awsSetupChangeTarget(CHANGES[kind], 1),
        intent: (intent ??
          awsSetupChangeIntent(CHANGES[kind], REQUESTED)) as Record<
          string,
          string
        >
      });
      return op;
    }

    it("does nothing when no AWS write is unsettled", async () => {
      const { journal: j, aws } = journal({});
      expect(await j.reconcile(operation())).toBe(false);
      expect(aws.calls).toEqual([]);
    });

    it("settles an interrupted write from AWS, never sending it again", async () => {
      const { journal: j, aws } = journal({
        ...SESSION,
        "iam get-role-policy": ok("{}")
      });
      const op = interrupted("aws_role_policy.put");

      expect(await j.reconcile(op)).toBe(true);

      expect(aws.calls).toEqual([
        "--version",
        "sts get-caller-identity",
        "iam get-role-policy"
      ]);
      expect(op.providerRecovery.mutations[0].status).toBe("confirmed");
      expect(op.setupArtifacts.awsRolePolicies).toHaveLength(1);
    });

    it.each([
      ["op_journal", "created"],
      ["op_later", "not_started"]
    ])(
      "claims a role found after a restart only when it is tagged %s",
      async (tag, state) => {
        const { journal: j } = journal({
          ...SESSION,
          "iam get-role": ok({
            Role: {
              Arn: ROLE_ARN,
              RoleId: "AROA2",
              Tags: [{ Key: "radius-operation", Value: tag }]
            }
          })
        });
        const op = interrupted("aws_role.create");

        await j.reconcile(op);

        expect(op.setupArtifacts.awsRole.state).toBe(state);
      }
    );

    it("asks to pause, not roll back, during restart reconciliation", async () => {
      const { journal: j } = journal({
        ...SESSION,
        "iam get-role-policy": ok("{}")
      });
      const op = interrupted("aws_role_policy.put");
      op.recoveryState = "provider_reconciliation_pending";

      await j.reconcile(op);

      expect(op.stopRequested).toBe(true);
      expect(op.providerRecovery.state).not.toBe("rollback_pending");
    });

    it("hands an entry it cannot read in AWS to the developer", async () => {
      const { journal: j, aws, persist } = journal({});
      const op = interrupted("aws_trust.add", { accountId: ACCOUNT });

      await expect(j.reconcile(op)).rejects.toBeInstanceOf(
        ProviderMutationRecoveryError
      );

      expect(aws.calls).toEqual([]);
      expect(op.providerRecovery.mutations[0]).toMatchObject({
        status: "manual_required",
        evidence: expect.stringContaining("Review the deploy identity")
      });
      expect(persist).toHaveBeenCalled();
    });

    it("keeps an entry unknown when AWS cannot be read", async () => {
      const { journal: j } = journal({
        ...SESSION,
        "iam get-role": fail("AccessDenied")
      });
      const op = interrupted("aws_role.create");

      await expect(j.reconcile(op)).rejects.toBeInstanceOf(
        ProviderMutationRecoveryError
      );
      expect(op.providerRecovery.mutations[0].status).toBe("outcome_unknown");
    });

    // An expired sign-in says nothing about the write, so it is not counted
    // against it: the setup waits for the person to sign in again.
    it("passes on an AWS session failure without counting an attempt", async () => {
      const { journal: j, aws } = journal({
        "--version": ok("aws-cli/2.17.0 Python/3.11 Linux/6"),
        "sts get-caller-identity": fail(
          "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired"
        )
      });
      const op = interrupted("aws_role.create");

      for (const _attempt of [1, 2, 3]) {
        await expect(j.reconcile(op)).rejects.toMatchObject({
          name: "AwsSessionUnavailableError",
          code: expect.stringMatching(/^aws-/)
        });
      }

      const [mutation] = op.providerRecovery.mutations;
      expect(mutation.status).toBe("prepared");
      expect(mutation.reconcileAttempts ?? 0).toBe(0);
      expect(aws.calls).not.toContain("iam get-role");
    });

    it("passes on an AWS session failure while settling a write it sent", async () => {
      const { journal: j } = journal({
        "--version": ok("aws-cli/2.17.0 Python/3.11 Linux/6"),
        "sts get-caller-identity": fail(
          "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation"
        )
      });
      const op = operation();

      await expect(
        j.write(
          op,
          CHANGES["aws_role.create"],
          ARGS,
          sender({ code: 1, stdout: "", stderr: "", timedOut: true })
        )
      ).rejects.toBeInstanceOf(AwsSessionUnavailableError);
      expect(op.providerRecovery.mutations[0].reconcileAttempts ?? 0).toBe(0);
    });

    it("leaves a requested stop alone outside restart reconciliation", async () => {
      const { journal: j } = journal({
        ...SESSION,
        "iam get-role-policy": ok("{}")
      });
      const op = interrupted("aws_role_policy.put");
      requestStop(op);
      await j.reconcile(op);
      expect(op.providerRecovery.state).not.toBe("rollback_pending");
    });
  });
});
