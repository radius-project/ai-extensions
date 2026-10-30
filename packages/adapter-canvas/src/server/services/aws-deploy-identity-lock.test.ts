import { describe, expect, it } from "vitest";
import type { AwsCommandResult } from "./aws-deploy-identity.js";
import {
  AWS_LOCK_POLL_MS,
  acquireAwsDeployIdentityLock,
  isAwsWrite,
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

const acquire = (iam: ReturnType<typeof fakeIam>) =>
  acquireAwsDeployIdentityLock(
    { accountId: ACCOUNT, roleName: ROLE, holder: HOLDER },
    iam.ports
  );

async function held(
  script: Record<string, AwsCommandResult | AwsCommandResult[]>
) {
  const iam = fakeIam({ "iam create-policy": policy("LOCK1"), ...script });
  const result = await acquire(iam);
  if (!result.ok) throw new Error("expected the lock");
  return { iam, lock: result.lock };
}

describe("acquireAwsDeployIdentityLock", () => {
  it("creates the lock policy naming its holder and keeps its ID", async () => {
    const iam = fakeIam({ "iam create-policy": policy("LOCK1") });

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
    expect(iam.waits).toEqual([]);
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
    const iam = fakeIam({ "iam create-policy": fail("Throttling: slow down") });
    expect(await acquire(iam)).toEqual({
      ok: false,
      code: "aws-lock-failed",
      message: `Radius could not lock IAM role ${ROLE}: Throttling: slow down. Nothing was changed.`
    });
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
      "iam get-policy": policy("LOCK1", {
        Description: OTHER,
        CreateDate: "2026-10-30T11:58:00Z"
      })
    });

    const result = await acquire(iam);

    expect(result).toMatchObject({ ok: true, lock: { policyId: "LOCK2" } });
    expect(iam.sleeps).toEqual([AWS_LOCK_POLL_MS, AWS_LOCK_POLL_MS]);
    expect(iam.waits[0]).toEqual({
      policyArn: LOCK_ARN,
      policyId: "LOCK1",
      holder: "The setup of environment prod in octo/shop",
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

    expect(iam.waits[0]).toMatchObject({ holder: "Another run", since: "" });
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
      "iam get-policy": MISSING
    });
    expect(await acquire(iam)).toMatchObject({ ok: true });
    expect(iam.waits).toEqual([]);
    expect(iam.sleeps).toEqual([AWS_LOCK_POLL_MS]);
  });

  it.each([
    [DENIED, "aws-lock-denied"],
    [fail("ServiceFailure"), "aws-lock-unreadable"]
  ])("fails when it cannot read who holds the lock", async (answer, code) => {
    const iam = fakeIam({
      "iam create-policy": EXISTS,
      "iam get-policy": answer
    });
    const result = await acquire(iam);
    expect(result).toMatchObject({ ok: false, code });
    expect("message" in result && result.message).toContain(
      `Another run holds the lock on IAM role ${ROLE}`
    );
  });

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

describe("a held deploy identity lock", () => {
  it("is still held while the lock has its ID", async () => {
    const { lock } = await held({ "iam get-policy": policy("LOCK1") });
    expect(await lock.verify()).toBeNull();
  });

  it("is lost when the lock was removed", async () => {
    const { lock } = await held({ "iam get-policy": MISSING });
    expect(await lock.verify()).toBe(
      `The lock on IAM role ${ROLE} was removed while this run held it, so Radius stopped before changing the role.`
    );
  });

  it("is lost, naming the new holder, when another run took a new lock", async () => {
    const { lock } = await held({
      "iam get-policy": policy("LOCK2", { Description: OTHER })
    });
    expect(await lock.verify()).toBe(
      `The lock on IAM role ${ROLE} was removed while this run held it, and another run now holds it (The setup of environment prod in octo/shop). Radius stopped before changing the role.`
    );
  });

  it("is treated as lost when its ID cannot be read", async () => {
    const { lock } = await held({ "iam get-policy": fail("ServiceFailure") });
    expect(await lock.verify()).toBe(
      `Radius could not confirm it still holds the lock on IAM role ${ROLE}, so it stopped before changing the role: ServiceFailure`
    );
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

    const released = await lock.release();

    expect(released.ok).toBe(false);
    expect("message" in released && released.message).toMatch(
      /Radius left the current lock in place\.$/
    );
    expect(iam.commands()).not.toContain("iam delete-policy");
    expect(await lock.release()).toEqual({ ok: true });
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
    [fail("ServiceFailure"), "could not release the lock on IAM role"]
  ])(
    "reports a lock it could not delete with the command to remove it",
    async (answer, text) => {
      const { iam, lock } = await held({
        "iam get-policy": policy("LOCK1"),
        "iam delete-policy": [answer, ok()]
      });

      const released = await lock.release();

      expect(released.ok).toBe(false);
      expect("message" in released && released.message).toContain(text);
      expect("message" in released && released.message).toContain(
        `aws iam delete-policy --policy-arn ${LOCK_ARN}`
      );
      // A failed release can be retried.
      expect(await lock.release()).toEqual({ ok: true });
      expect(
        iam.commands().filter((c) => c === "iam delete-policy")
      ).toHaveLength(2);
    }
  );
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
  const signedIn = { "sts get-caller-identity": ok({ Account: ACCOUNT }) };
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

  it.each([
    ["another account", ok({ Account: "999999999999" })],
    ["no session", fail("Unable to locate credentials")],
    ["unreadable identity", ok("{")]
  ])(
    "refuses when the CLI is signed in to %s, where the lock would look missing",
    async (_label, answer) => {
      const { iam, result } = remove({ "sts get-caller-identity": answer });
      expect(await result).toMatchObject({
        ok: false,
        code: "aws-account-mismatch"
      });
      expect(iam.commands()).toEqual(["sts get-caller-identity"]);
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
