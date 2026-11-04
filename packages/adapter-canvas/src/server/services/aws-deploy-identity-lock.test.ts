import type { AwsLockHolder } from "@radius-project/core";
import { describe, expect, it } from "vitest";
import type { AwsCommandResult } from "./aws-deploy-identity.js";
import {
  AWS_LOCK_POLL_MS,
  LOCK_TRANSIENT_RETRY_DELAYS_MS,
  acquireAwsDeployIdentityLock,
  awsLockRecoveryCommand,
  isAwsWrite,
  isTransientAwsFailure,
  removeAwsDeployIdentityLock,
  type AwsLockWait
} from "./aws-deploy-identity-lock.js";

const ACCOUNT = "123456789012";
const ROLE = "radius-deploy-octo-shop";
const LOCK_ARN = `arn:aws:iam::${ACCOUNT}:policy/radius-lock-${ROLE}`;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOLDER = {
  repo: "octo/shop",
  environment: "dev",
  action: "setup" as const,
  operationId: "op-1"
};
const OTHER =
  '{"repo":"octo/shop","environment":"prod","action":"setup","operationId":"op-2"}';

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
const policy = (policyId: string, extra: Record<string, unknown> = {}) =>
  ok({ Policy: { PolicyId: policyId, Arn: LOCK_ARN, ...extra } });
const EXISTS = fail(
  "An error occurred (EntityAlreadyExists) when calling the CreatePolicy operation"
);
const MISSING = fail(
  "An error occurred (NoSuchEntity) when calling the GetPolicy operation"
);
const DENIED = fail("An error occurred (AccessDenied): not authorized");
const THROTTLED = fail(
  "An error occurred (Throttling) when calling the GetPolicy operation: Rate exceeded"
);
const TIMED_OUT: AwsCommandResult = {
  code: 1,
  stdout: "",
  stderr: "",
  timedOut: true
};
const RECOVERY = `Check that "aws iam get-policy --policy-arn ${LOCK_ARN} --query Policy.PolicyId --output text" prints LOCK1, which is this run's lock, and only then run: aws iam delete-policy --policy-arn ${LOCK_ARN}`;

// A list answers successive calls in order, repeating its last entry. Any
// command the scenario did not script throws.
function fakeIam(
  script: Record<string, AwsCommandResult | AwsCommandResult[]>,
  stopAfterSleeps = Infinity
) {
  const calls: string[][] = [];
  const waits: AwsLockWait[] = [];
  const sleeps: number[] = [];
  let clock = NOW;
  const runAws = async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const scripted = script[key];
    const result =
      Array.isArray(scripted) ?
        scripted.length > 1 ?
          scripted.shift()
        : scripted[0]
      : scripted;
    if (!result) throw new Error(`unexpected aws ${args.join(" ")}`);
    return result;
  };
  return {
    calls,
    waits,
    sleeps,
    commands: () => calls.map((args) => args.slice(0, 2).join(" ")),
    runAws,
    ports: {
      runAws,
      now: () => clock,
      shouldStop: () => sleeps.length >= stopAfterSleeps,
      async sleep(milliseconds: number) {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      waiting(wait: AwsLockWait) {
        waits.push(wait);
      }
    }
  };
}

const acquire = (
  iam: ReturnType<typeof fakeIam>,
  holder: AwsLockHolder = HOLDER
) =>
  acquireAwsDeployIdentityLock(
    { accountId: ACCOUNT, roleName: ROLE, holder },
    iam.ports
  );

// A run holding LOCK1. Acquiring reads the lock back once; `script` answers
// every read after that.
async function held(
  script: Record<string, AwsCommandResult | AwsCommandResult[]>,
  holder: Parameters<typeof acquire>[1] = HOLDER
) {
  const later = script["iam get-policy"];
  const iam = fakeIam({
    "iam create-policy": policy("LOCK1"),
    ...script,
    "iam get-policy": [
      policy("LOCK1"),
      ...(later === undefined ? []
      : Array.isArray(later) ? later
      : [later])
    ]
  });
  const result = await acquire(iam, holder);
  if (!result.ok) throw new Error("expected the lock");
  iam.sleeps.length = 0;
  return { iam, lock: result.lock };
}

describe("acquireAwsDeployIdentityLock", () => {
  it("creates the lock policy naming its holder and keeps its ID", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": policy("LOCK1")
    });

    const result = await acquire(iam);

    expect(result).toMatchObject({
      ok: true,
      lock: { policyArn: LOCK_ARN, policyId: "LOCK1" }
    });
    const create = iam.calls[0] ?? [];
    expect(create.slice(0, 4)).toEqual([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`
    ]);
    expect(
      JSON.parse(create[create.indexOf("--description") + 1] ?? "")
    ).toEqual(HOLDER);
    expect(
      JSON.parse(create[create.indexOf("--policy-document") + 1] ?? "")
    ).toMatchObject({ Statement: [{ Effect: "Deny", Resource: LOCK_ARN }] });
    expect(iam.commands()).toEqual(["iam create-policy", "iam get-policy"]);
    expect(iam.waits).toEqual([]);
  });

  it("waits until IAM can read a lock it just created", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": [MISSING, MISSING, policy("LOCK1")]
    });

    expect(await acquire(iam)).toMatchObject({
      ok: true,
      lock: { policyId: "LOCK1" }
    });
    expect(iam.sleeps).toEqual([500, 1000]);
  });

  it("stops without deleting a lock IAM never shows", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": MISSING
    });

    const result = await acquire(iam);

    expect(result).toMatchObject({ ok: false, code: "aws-lock-unconfirmed" });
    expect("message" in result && result.message).toContain(
      `aws iam delete-policy --policy-arn ${LOCK_ARN}`
    );
    expect(iam.sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(iam.commands()).not.toContain("iam delete-policy");
  });

  it("retries a new lock that a throttled call could not read", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": [THROTTLED, policy("LOCK1")]
    });
    expect(await acquire(iam)).toMatchObject({ ok: true });
    expect(iam.sleeps).toEqual([500]);
  });

  it("names the policy ID to check when it stops on a lock it cannot read back", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": DENIED
    });
    const result = await acquire(iam);
    expect("message" in result && result.message).toContain(RECOVERY);
  });

  it("stops at once when the new lock cannot be read for another reason", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": DENIED
    });
    expect(await acquire(iam)).toMatchObject({
      ok: false,
      code: "aws-lock-unconfirmed"
    });
    expect(iam.sleeps).toEqual([]);
  });

  it("stops when the new lock was already replaced by another run's", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": policy("LOCK2")
    });
    expect(await acquire(iam)).toMatchObject({
      ok: false,
      code: "aws-lock-lost"
    });
    expect(iam.commands()).not.toContain("iam delete-policy");
  });

  it("stops before any write and names the permissions when CreatePolicy is denied", async () => {
    const iam = fakeIam({ "iam create-policy": DENIED });

    const result = await acquire(iam);

    expect(result).toMatchObject({ ok: false, code: "aws-lock-denied" });
    expect("message" in result && result.message).toContain(
      "not allowed iam:CreatePolicy"
    );
    expect("message" in result && result.message).toContain(
      `iam:CreatePolicy, iam:GetPolicy, and iam:DeletePolicy on arn:aws:iam::${ACCOUNT}:policy/radius-lock-*`
    );
    expect(iam.commands()).toEqual(["iam create-policy"]);
  });

  it("fails on any other create error", async () => {
    const iam = fakeIam({
      "iam create-policy": fail("MalformedPolicyDocument: bad statement")
    });
    expect(await acquire(iam)).toEqual({
      ok: false,
      code: "aws-lock-failed",
      message: `Radius could not lock IAM role ${ROLE}: MalformedPolicyDocument: bad statement. Nothing was changed.`
    });
  });

  it.each([
    ["throttled", THROTTLED],
    ["timed out", TIMED_OUT],
    ["cut off", fail("Could not connect to the endpoint URL")]
  ])(
    "backs off and tries again when creating the lock is %s",
    async (_label, answer) => {
      const iam = fakeIam({
        "iam create-policy": [answer, answer, policy("LOCK1")],
        "iam get-policy": policy("LOCK1")
      });
      expect(await acquire(iam)).toMatchObject({ ok: true });
      expect(iam.sleeps).toEqual([2 * AWS_LOCK_POLL_MS, 4 * AWS_LOCK_POLL_MS]);
    }
  );

  it("gives up after six failures in a row a retry could fix, saying the call timed out", async () => {
    const iam = fakeIam({ "iam create-policy": TIMED_OUT });

    expect(await acquire(iam)).toEqual({
      ok: false,
      code: "aws-lock-unreachable",
      message: `Radius could not reach IAM to lock IAM role ${ROLE} after 6 tries (the AWS CLI call timed out). Nothing was changed. Retry.`
    });
    expect(iam.sleeps).toEqual([10000, 20000, 40000, 60000, 60000]);
  });

  it("gives up when reading the holder keeps failing in a way a retry could fix", async () => {
    const iam = fakeIam({
      "iam create-policy": EXISTS,
      "iam get-policy": fail("An error occurred (ServiceUnavailable)")
    });
    expect(await acquire(iam)).toMatchObject({
      ok: false,
      code: "aws-lock-unreachable"
    });
    expect(iam.sleeps).toEqual([10000, 20000, 40000, 60000, 60000]);
  });

  it("names a missing operation plainly when a created lock has no ID", async () => {
    const iam = fakeIam({ "iam create-policy": ok("") });
    const result = await acquireAwsDeployIdentityLock(
      {
        accountId: ACCOUNT,
        roleName: ROLE,
        holder: { ...HOLDER, operationId: "" }
      },
      iam.ports
    );
    expect("message" in result && result.message).toContain(
      "names operation (none);"
    );
  });

  it("keeps what a timed-out call printed in the message", async () => {
    const iam = fakeIam({
      "iam create-policy": { ...TIMED_OUT, stderr: "partial reply" }
    });
    const result = await acquire(iam);
    expect("message" in result && result.message).toContain(
      "(the AWS CLI call timed out (partial reply))"
    );
  });

  it("counts only failures in a row, so a long wait survives occasional throttling", async () => {
    const holderRead = policy("LOCK0", { Description: OTHER });
    const throttledFive = Array.from({ length: 5 }, () => THROTTLED);
    const iam = fakeIam({
      "iam create-policy": [
        ...Array.from({ length: 12 }, () => EXISTS),
        policy("LOCK1")
      ],
      "iam get-policy": [
        ...throttledFive,
        holderRead,
        ...throttledFive,
        holderRead,
        policy("LOCK1")
      ]
    });

    expect(await acquire(iam)).toMatchObject({ ok: true });
    const backOff = [10000, 20000, 40000, 60000, 60000];
    expect(iam.sleeps).toEqual([
      ...backOff,
      AWS_LOCK_POLL_MS,
      ...backOff,
      AWS_LOCK_POLL_MS
    ]);
  });

  it.each([
    [{ code: 1, stdout: "", stderr: "" }, "no output"],
    [{ code: 1, stdout: "partial reply", stderr: "" }, "partial reply"]
  ])(
    "names what the CLI printed when create fails: %j",
    async (answer, text) => {
      const iam = fakeIam({ "iam create-policy": answer });
      const result = await acquire(iam);
      expect("message" in result && result.message).toBe(
        `Radius could not lock IAM role ${ROLE}: ${text}. Nothing was changed.`
      );
    }
  );

  it.each([
    ["no output", ok("")],
    ["no policy ID", ok({ Policy: { Arn: LOCK_ARN } })],
    ["unparseable output", ok("{")]
  ])(
    "refuses a created lock with %s, since it cannot tell its own lock apart",
    async (_label, answer) => {
      const iam = fakeIam({ "iam create-policy": answer });
      const result = await acquire(iam);
      expect(result).toMatchObject({ ok: false, code: "aws-lock-unreadable" });
      expect("message" in result && result.message).toContain(
        `aws iam delete-policy --policy-arn ${LOCK_ARN}`
      );
    }
  );

  it("waits while another run holds the lock, then takes it", async () => {
    const iam = fakeIam({
      "iam create-policy": [EXISTS, EXISTS, policy("LOCK2")],
      "iam get-policy": [
        policy("LOCK1", {
          Description: OTHER,
          CreateDate: "2026-10-30T11:58:00Z"
        }),
        policy("LOCK1", {
          Description: OTHER,
          CreateDate: "2026-10-30T11:58:00Z"
        }),
        policy("LOCK2")
      ]
    });

    const result = await acquire(iam);

    expect(result).toMatchObject({ ok: true, lock: { policyId: "LOCK2" } });
    expect(iam.sleeps).toEqual([AWS_LOCK_POLL_MS, AWS_LOCK_POLL_MS]);
    expect(iam.waits[0]).toEqual({
      policyArn: LOCK_ARN,
      policyId: "LOCK1",
      holder: "The setup of environment prod in octo/shop",
      holderOperationId: "op-2",
      since: "2026-10-30T11:58:00Z",
      removable: false
    });
  });

  it.each([
    ["9 minutes 59 seconds", "2026-10-30T11:50:01Z", false],
    ["exactly 10 minutes", "2026-10-30T11:50:00Z", true],
    ["an hour", "2026-10-30T11:00:00Z", true]
  ])(
    "offers removal by the lock's age: held %s",
    async (_label, createDate, removable) => {
      const iam = fakeIam(
        {
          "iam create-policy": EXISTS,
          "iam get-policy": policy("LOCK1", { CreateDate: createDate })
        },
        1
      );
      expect(await acquire(iam)).toEqual({ ok: false, stopped: true });
      expect(iam.waits[0]?.removable).toBe(removable);
    }
  );

  it("times a lock with no creation date from when this run first saw it", async () => {
    const polls = 600000 / AWS_LOCK_POLL_MS;
    const iam = fakeIam(
      {
        "iam create-policy": EXISTS,
        "iam get-policy": policy("LOCK1")
      },
      polls + 1
    );

    await acquire(iam);

    expect(iam.waits[0]).toMatchObject({
      holder: "Another run",
      holderOperationId: "",
      since: ""
    });
    expect(iam.waits[polls - 1]?.removable).toBe(false);
    expect(iam.waits[polls]?.removable).toBe(true);
  });

  it("restarts the removal clock when a new lock replaces the old one", async () => {
    const iam = fakeIam(
      {
        "iam create-policy": EXISTS,
        "iam get-policy": [policy("LOCK1"), policy("LOCK2")]
      },
      2
    );
    await acquire(iam);
    expect(iam.waits.map(({ policyId }) => policyId)).toEqual([
      "LOCK1",
      "LOCK2"
    ]);
    expect(iam.waits.every(({ removable }) => !removable)).toBe(true);
  });

  it("tries again without reporting a holder when the lock vanished between create and read", async () => {
    const iam = fakeIam({
      "iam create-policy": [EXISTS, policy("LOCK2")],
      "iam get-policy": [MISSING, policy("LOCK2")]
    });
    expect(await acquire(iam)).toMatchObject({ ok: true });
    expect(iam.waits).toEqual([]);
    expect(iam.sleeps).toEqual([AWS_LOCK_POLL_MS]);
  });

  it.each([
    [DENIED, "aws-lock-denied", "not allowed to read who"],
    [
      fail("ValidationError: bad ARN"),
      "aws-lock-unreadable",
      "could not read who: ValidationError: bad ARN"
    ]
  ])(
    "fails when it cannot read who holds the lock: %#",
    async (answer, code, text) => {
      const iam = fakeIam({
        "iam create-policy": EXISTS,
        "iam get-policy": answer
      });
      const result = await acquire(iam);
      expect(result).toMatchObject({ ok: false, code });
      expect("message" in result && result.message).toContain(
        `Another run holds the lock on IAM role ${ROLE}`
      );
      expect("message" in result && result.message).toContain(text);
      // Only an access denial asks for permissions.
      expect(
        "message" in result && result.message.includes("iam:CreatePolicy")
      ).toBe(code === "aws-lock-denied");
    }
  );

  it("stops before creating anything when a stop is already requested", async () => {
    const iam = fakeIam({}, 0);
    expect(await acquire(iam)).toEqual({ ok: false, stopped: true });
    expect(iam.calls).toEqual([]);
  });

  it("stops waiting when a stop is requested between polls", async () => {
    const iam = fakeIam(
      { "iam create-policy": EXISTS, "iam get-policy": policy("LOCK1") },
      2
    );
    expect(await acquire(iam)).toEqual({ ok: false, stopped: true });
    expect(
      iam.commands().filter((c) => c === "iam create-policy")
    ).toHaveLength(2);
  });
});

describe("acquireAwsDeployIdentityLock without waiting", () => {
  const acquireNow = (iam: ReturnType<typeof fakeIam>) =>
    acquireAwsDeployIdentityLock(
      { accountId: ACCOUNT, roleName: ROLE, holder: HOLDER, wait: false },
      iam.ports
    );

  it("returns the holder at once instead of waiting", async () => {
    const iam = fakeIam({
      "iam create-policy": EXISTS,
      "iam get-policy": policy("LOCK0", {
        Description: OTHER,
        CreateDate: "2026-10-30T11:00:00Z"
      })
    });

    expect(await acquireNow(iam)).toEqual({
      ok: false,
      busy: true,
      holder: {
        policyArn: LOCK_ARN,
        policyId: "LOCK0",
        holder: "The setup of environment prod in octo/shop",
        holderOperationId: "op-2",
        since: "2026-10-30T11:00:00Z",
        removable: true
      }
    });
    expect(iam.sleeps).toEqual([]);
    expect(iam.waits).toEqual([]);
  });

  it("tries a lock released between create and read once more, at once", async () => {
    const iam = fakeIam({
      "iam create-policy": [EXISTS, policy("LOCK1")],
      "iam get-policy": [MISSING, policy("LOCK1")]
    });
    expect(await acquireNow(iam)).toMatchObject({ ok: true });
    expect(iam.sleeps).toEqual([]);
  });

  it("names no holder when IAM keeps saying the lock exists but cannot read it", async () => {
    const iam = fakeIam({
      "iam create-policy": EXISTS,
      "iam get-policy": MISSING
    });
    expect(await acquireNow(iam)).toEqual({
      ok: false,
      busy: true,
      holder: null
    });
    expect(iam.commands()).toEqual([
      "iam create-policy",
      "iam get-policy",
      "iam create-policy",
      "iam get-policy"
    ]);
    expect(iam.sleeps).toEqual([]);
  });

  it.each([
    ["creating", { "iam create-policy": THROTTLED }],
    [
      "reading the holder",
      { "iam create-policy": EXISTS, "iam get-policy": THROTTLED }
    ]
  ])(
    "stops without backing off when IAM is unreachable while %s",
    async (_label, script) => {
      const iam = fakeIam(script);
      expect(await acquireNow(iam)).toMatchObject({
        ok: false,
        code: "aws-lock-unreachable"
      });
      expect(iam.sleeps).toEqual([]);
    }
  );

  it("passes through a lock it created that IAM never shows", async () => {
    const iam = fakeIam({
      "iam create-policy": policy("LOCK1"),
      "iam get-policy": MISSING
    });
    expect(await acquireNow(iam)).toMatchObject({
      ok: false,
      code: "aws-lock-unconfirmed"
    });
  });
});

describe("a held deploy identity lock", () => {
  it("is still held while the lock has its ID", async () => {
    const { lock } = await held({ "iam get-policy": policy("LOCK1") });
    expect(await lock.verify()).toBeNull();
  });

  it("is lost when the lock was removed", async () => {
    const { lock } = await held({ "iam get-policy": MISSING });
    expect(await lock.verify()).toEqual({
      kind: "removed",
      reason: `The lock on IAM role ${ROLE} was removed while this run held it`
    });
  });

  it("is lost, naming the new holder, when another run took a new lock", async () => {
    const { lock } = await held({
      "iam get-policy": policy("LOCK2", { Description: OTHER })
    });
    expect(await lock.verify()).toEqual({
      kind: "replaced",
      reason: `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds a new one (The setup of environment prod in octo/shop)`
    });
  });

  it("is unconfirmed when its ID cannot be read, even after retries", async () => {
    const { iam, lock } = await held({
      "iam get-policy": fail("ServiceFailure")
    });
    expect(await lock.verify()).toEqual({
      kind: "unconfirmed",
      reason: `Radius could not confirm it still holds the lock on IAM role ${ROLE} (ServiceFailure)`
    });
    expect(iam.sleeps).toEqual(LOCK_TRANSIENT_RETRY_DELAYS_MS);
  });

  it("is still held when a throttled check succeeds on retry", async () => {
    const { iam, lock } = await held({
      "iam get-policy": [THROTTLED, TIMED_OUT, policy("LOCK1")]
    });
    expect(await lock.verify()).toBeNull();
    expect(iam.sleeps).toEqual([1000, 2000]);
  });

  it("does not retry a check that a retry cannot fix", async () => {
    const { iam, lock } = await held({ "iam get-policy": DENIED });
    expect(await lock.verify()).toMatchObject({ kind: "unconfirmed" });
    expect(iam.sleeps).toEqual([]);
  });

  it("releases by checking its ID, deleting once, and doing nothing the second time", async () => {
    const { iam, lock } = await held({
      "iam get-policy": policy("LOCK1"),
      "iam delete-policy": ok()
    });

    expect(await lock.release()).toEqual({ ok: true });
    expect(await lock.release()).toEqual({ ok: true });

    expect(iam.commands()).toEqual([
      "iam create-policy",
      "iam get-policy",
      "iam get-policy",
      "iam delete-policy"
    ]);
    expect(iam.calls.at(-1)).toEqual([
      "iam",
      "delete-policy",
      "--policy-arn",
      LOCK_ARN
    ]);
  });

  it("leaves another run's lock in place when its own was taken over", async () => {
    const { iam, lock } = await held({
      "iam get-policy": policy("LOCK2", { Description: OTHER })
    });

    expect(await lock.release()).toEqual({
      ok: false,
      gone: true,
      message: `This setup is done with IAM role ${ROLE}. The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds a new one (The setup of environment prod in octo/shop), so Radius left that lock in place. Another run may have changed the role while this one held it.`
    });
    expect(iam.commands()).not.toContain("iam delete-policy");
    expect(await lock.release()).toEqual({ ok: true });
  });

  it.each([
    [HOLDER, "This setup"],
    [{ ...HOLDER, action: "delete" as const }, "This deletion"]
  ])(
    "says a lock removed before release had nothing to release: %#",
    async (holder, subject) => {
      const { iam, lock } = await held({ "iam get-policy": MISSING }, holder);

      expect(await lock.release()).toEqual({
        ok: false,
        gone: true,
        message: `${subject} is done with IAM role ${ROLE}, but its lock had already been removed, so there was nothing to release. Another run may have changed the role while this one held it.`
      });
      expect(iam.commands()).not.toContain("iam delete-policy");
    }
  );

  it("keeps a lock it could not check, so a later release can delete it", async () => {
    const { iam, lock } = await held({
      "iam get-policy": [DENIED, policy("LOCK1")],
      "iam delete-policy": ok()
    });

    expect(await lock.release()).toEqual({
      ok: false,
      gone: false,
      message: `This setup is done with IAM role ${ROLE}, but Radius could not confirm it still holds the lock on IAM role ${ROLE} (An error occurred (AccessDenied): not authorized), so Radius did not delete the lock. Other runs wait for this lock until it is removed. ${RECOVERY}`
    });
    expect(iam.commands()).not.toContain("iam delete-policy");
    expect(await lock.release()).toEqual({ ok: true });
    expect(iam.commands()).toContain("iam delete-policy");
  });

  it("retries a throttled delete", async () => {
    const { iam, lock } = await held({
      "iam get-policy": policy("LOCK1"),
      "iam delete-policy": [THROTTLED, ok()]
    });
    expect(await lock.release()).toEqual({ ok: true });
    expect(iam.sleeps).toEqual([1000]);
  });

  it("treats a lock already deleted between the check and the delete as released", async () => {
    const { lock } = await held({
      "iam get-policy": policy("LOCK1"),
      "iam delete-policy": MISSING
    });
    expect(await lock.release()).toEqual({ ok: true });
  });

  it.each([
    [DENIED, "not allowed iam:DeletePolicy"],
    [
      fail("DeleteConflict: still attached"),
      "could not release its lock: DeleteConflict: still attached"
    ]
  ])(
    "reports a lock it could not delete with the command to remove it",
    async (answer, text) => {
      const { iam, lock } = await held({
        "iam get-policy": policy("LOCK1"),
        "iam delete-policy": [answer, ok()]
      });

      const released = await lock.release();

      expect(released).toMatchObject({ ok: false, gone: false });
      expect("message" in released && released.message).toContain(text);
      expect("message" in released && released.message).toContain(RECOVERY);
      // A failed release can be retried.
      expect(await lock.release()).toEqual({ ok: true });
      expect(
        iam.commands().filter((c) => c === "iam delete-policy")
      ).toHaveLength(2);
    }
  );
});

describe("isTransientAwsFailure", () => {
  it.each([
    [THROTTLED, true],
    [TIMED_OUT, true],
    [fail("An error occurred (ServiceFailure)"), true],
    [fail("Connection was reset"), true],
    [fail("read ECONNRESET"), true],
    [DENIED, false],
    [MISSING, false],
    [EXISTS, false],
    [ok(), false],
    [{ code: 0, stdout: "", stderr: "", timedOut: true }, false]
  ])("classifies %j: %s", (result, transient) => {
    expect(isTransientAwsFailure(result)).toBe(transient);
  });
});

describe("awsLockRecoveryCommand", () => {
  it("names the policy ID to check before the delete", () => {
    expect(awsLockRecoveryCommand(LOCK_ARN, "LOCK1")).toBe(RECOVERY);
  });
});

describe("isAwsWrite", () => {
  it.each([
    [["iam", "create-role"], true],
    [["iam", "update-assume-role-policy"], true],
    [["iam", "put-role-policy"], true],
    [["iam", "delete-role-policy"], true],
    [["eks", "associate-access-policy"], true],
    [["eks", "disassociate-access-policy"], true],
    [["iam", "attach-role-policy"], true],
    [["iam", "detach-role-policy"], true],
    [["iam", "tag-role"], true],
    [["iam", "untag-role"], true],
    [["iam", "add-client-id-to-open-id-connect-provider"], true],
    [["iam", "remove-client-id-from-open-id-connect-provider"], true],
    [["iam", "get-role"], false],
    [["iam", "list-open-id-connect-providers"], false],
    [["eks", "describe-cluster"], false],
    [["sts", "get-caller-identity"], false],
    [["--version"], false],
    [[], false]
  ])("classifies %j as a write: %s", (args, write) => {
    expect(isAwsWrite(args)).toBe(write);
  });
});

describe("removeAwsDeployIdentityLock", () => {
  const signedIn = {
    "--version": ok("aws-cli/2.39.0"),
    "sts get-caller-identity": ok({ Account: ACCOUNT })
  };
  const remove = (
    script: Record<string, AwsCommandResult | AwsCommandResult[]>,
    request = { policyArn: LOCK_ARN, policyId: "LOCK1" }
  ) => {
    const iam = fakeIam(script);
    return {
      iam,
      result: removeAwsDeployIdentityLock(request, iam.runAws)
    };
  };

  it("deletes exactly the lock the developer was shown", async () => {
    const { iam, result } = remove({
      ...signedIn,
      "iam get-policy": policy("LOCK1"),
      "iam delete-policy": ok()
    });
    expect(await result).toEqual({ ok: true, removed: true });
    expect(iam.commands()).toEqual([
      "--version",
      "sts get-caller-identity",
      "iam get-policy",
      "iam delete-policy"
    ]);
  });

  it("keeps a new lock another run took after the screen was shown", async () => {
    const { iam, result } = remove({
      ...signedIn,
      "iam get-policy": policy("LOCK2")
    });
    expect(await result).toMatchObject({ ok: false, code: "aws-lock-changed" });
    expect(iam.commands()).not.toContain("iam delete-policy");
  });

  it.each([
    ["is already gone", { "iam get-policy": MISSING }],
    [
      "disappears before the delete",
      { "iam get-policy": policy("LOCK1"), "iam delete-policy": MISSING }
    ]
  ])("succeeds without removing anything when the lock %s", async (_l, s) => {
    expect(await remove({ ...signedIn, ...s }).result).toEqual({
      ok: true,
      removed: false
    });
  });

  it.each([
    [{ policyArn: "not-an-arn", policyId: "LOCK1" }],
    [{ policyArn: LOCK_ARN, policyId: "" }]
  ])("refuses a lock it cannot identify: %j", async (request) => {
    const { iam, result } = remove({}, request);
    expect(await result).toMatchObject({ ok: false, code: "aws-lock-invalid" });
    expect(iam.calls).toEqual([]);
  });

  it("offers sign-in without echoing provider output when there is no session", async () => {
    const { iam, result } = remove({
      ...signedIn,
      "sts get-caller-identity": fail("Unable to locate credentials")
    });
    expect(await result).toEqual({
      ok: false,
      code: "aws-cli-login-required",
      message:
        'No active AWS CLI session. Sign in with "aws sso login", or refresh your configured credential provider, then verify again.'
    });
    expect(iam.commands()).toEqual(["--version", "sts get-caller-identity"]);
  });

  it.each([
    [
      "another account",
      ok({ Account: "999999999999" }),
      "aws-account-mismatch"
    ],
    ["unreadable identity", ok("{"), "aws-identity-invalid"]
  ])(
    "refuses when the CLI is signed in to %s, where the lock would look missing",
    async (_label, answer, code) => {
      const { iam, result } = remove({
        ...signedIn,
        "sts get-caller-identity": answer
      });
      expect(await result).toMatchObject({
        ok: false,
        code
      });
      expect(iam.commands()).toEqual(["--version", "sts get-caller-identity"]);
    }
  );

  it("fails when the lock cannot be read", async () => {
    expect(
      await remove({ ...signedIn, "iam get-policy": fail("ServiceFailure") })
        .result
    ).toMatchObject({ ok: false, code: "aws-lock-unreadable" });
  });

  it.each([
    [DENIED, "aws-lock-denied"],
    [fail("ServiceFailure"), "aws-lock-remove-failed"]
  ])("fails when the delete is refused", async (answer, code) => {
    expect(
      await remove({
        ...signedIn,
        "iam get-policy": policy("LOCK1"),
        "iam delete-policy": answer
      }).result
    ).toMatchObject({ ok: false, code });
  });
});
