import { afterEach, describe, expect, it } from "vitest";
import {
  configureOperationStore,
  operations,
  prepareProviderMutation,
  setContext
} from "../../../src/operations.js";
import { disabledOperationStore } from "../../../src/operation-store.js";
import {
  callsAfterCrash,
  lostLocks,
  readOwnership,
  unsavedRollbackResults,
  unsavedSetupChanges
} from "./checks.js";
import {
  completedSetup,
  createAwsScenario,
  createSetupOperation,
  LOCK_ARN,
  ROLE,
  runAwsRollback
} from "./scenarios.js";

// Each check must fail when the rule it guards is broken, or the stop-point
// matrix passing would prove nothing.

afterEach(async () => {
  operations.clear();
  await configureOperationStore(disabledOperationStore());
});

describe("unsavedSetupChanges", () => {
  it("finds nothing lost after a setup that saved everything", async () => {
    const s = await createAwsScenario("new");
    const before = readOwnership(s);
    const op = await completedSetup(s);
    expect(unsavedSetupChanges(s, op.operationId, before)).toEqual([]);
  });

  it("names every change in AWS and GitHub the record lost", async () => {
    const s = await createAwsScenario("new");
    const before = readOwnership(s);
    const op = await completedSetup(s);
    const ledger = op.setupArtifacts;
    ledger.awsRole.state = "not_started";
    ledger.awsTrustSubjects = [];
    ledger.awsRolePolicies = [];
    ledger.awsAccessEntries = [];
    ledger.githubEnvironmentVariables = [];

    const lost = unsavedSetupChanges(s, op.operationId, before);

    expect(lost).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^IAM role radius-deploy-octo-shop/),
        "trust subject repo:octo/shop:environment:dev",
        expect.stringMatching(/^policy radius-deploy-dev-/),
        "access entry for radius-deploy-octo-shop on shop",
        "GitHub variable AWS_ROLE_ARN"
      ])
    );
  });

  it("accepts a change the record holds as a write still to settle", async () => {
    const s = await createAwsScenario("new");
    const before = readOwnership(s);
    const op = await completedSetup(s);
    op.setupArtifacts.awsRole.state = "not_started";
    op.setupArtifacts.awsTrustSubjects = [];
    prepareProviderMutation(op, {
      kind: "aws_role.create",
      target: "attempt-1|role",
      intent: {}
    });

    expect(unsavedSetupChanges(s, op.operationId, before)).toEqual([]);
  });

  it("does not count what was there before the setup", async () => {
    const s = await createAwsScenario("reused");
    const op = await completedSetup(s);
    expect(unsavedSetupChanges(s, op.operationId, readOwnership(s))).toEqual(
      []
    );
  });

  it("needs a restored record", async () => {
    const s = await createAwsScenario("new");
    expect(() =>
      unsavedSetupChanges(s, "op-missing", readOwnership(s))
    ).toThrow("No restored record for op-missing");
  });
});

describe("unsavedRollbackResults", () => {
  it("finds nothing lost when every removal was saved", async () => {
    const s = await createAwsScenario("new");
    const op = await completedSetup(s);
    const from = s.outside.calls.length;
    await runAwsRollback(s, op, 1);
    expect(unsavedRollbackResults(s, op.operationId, from)).toEqual([]);
  });

  it("names each removal AWS confirmed that the record still lists", async () => {
    const s = await createAwsScenario("new");
    const op = await completedSetup(s);
    const from = s.outside.calls.length;
    await runAwsRollback(s, op, 1);
    const ledger = op.setupArtifacts;
    for (const entry of [
      ledger.awsRole,
      ...ledger.awsTrustSubjects,
      ...ledger.awsRolePolicies,
      ...ledger.awsAccessEntries
    ]) {
      entry.state = "created";
    }

    expect(unsavedRollbackResults(s, op.operationId, from)).toEqual(
      expect.arrayContaining([
        "access entry",
        expect.stringMatching(/^policy radius-deploy-dev-/),
        "trust subject repo:octo/shop:environment:dev",
        `IAM role ${ROLE}`
      ])
    );
  });
});

describe("lostLocks", () => {
  const holder = (operationId: string) =>
    JSON.stringify({
      repo: "octo/shop",
      environment: "dev",
      action: "setup",
      operationId
    });

  async function lockedBy(operationId: string) {
    const s = await createAwsScenario("new");
    await s.outside.runAws([
      "iam",
      "create-policy",
      "--policy-name",
      `radius-lock-${ROLE}`,
      "--description",
      holder(operationId),
      "--policy-document",
      "{}"
    ]);
    const [lock] = s.aws.locks();
    if (!lock) throw new Error("No lock was created.");
    return { s, lock };
  }

  it("accepts a lock a record names", async () => {
    const { s, lock } = await lockedBy("op-1");
    const op = createSetupOperation(s);
    setContext(op, {
      awsDeployIdentityLock: { policyArn: LOCK_ARN, policyId: lock.PolicyId }
    });
    expect(lostLocks(s, "op-1", "crash-before", s.disk.saves)).toEqual([]);
  });

  it("accepts an unsaved lock only after a crash, before any save, naming the operation", async () => {
    const { s } = await lockedBy("op-1");
    expect(lostLocks(s, "op-1", "crash-after", 0)).toEqual([]);
    expect(lostLocks(s, "op-1", "stop", 0)).toHaveLength(1);
    expect(lostLocks(s, "op-2", "crash-after", 0)).toHaveLength(1);
    expect(lostLocks(s, "op-1", "crash-after", 1)).toEqual([
      expect.stringContaining("held by setup op-1")
    ]);
  });

  it("names a lock nobody created through the run", async () => {
    const s = await createAwsScenario("new");
    s.aws.policies.set(LOCK_ARN, {
      PolicyName: `radius-lock-${ROLE}`,
      PolicyId: "ANPAHAND",
      Arn: LOCK_ARN,
      Path: "/",
      CreateDate: "2026-11-09T12:00:00Z",
      Description: "",
      Tags: [],
      document: {}
    });
    expect(lostLocks(s, "op-1", "crash-before", 0)).toEqual([
      `radius-lock-${ROLE} (ANPAHAND) held by ? (no operation)`
    ]);
  });
});

describe("callsAfterCrash", () => {
  it("names a call sent after the process crashed", async () => {
    const s = await createAwsScenario("new");
    s.outside.arm(0, "crash-before");
    await s.outside.until(() =>
      s.outside.runAws(["sts", "get-caller-identity"])
    );
    void s.outside.runAws(["iam", "get-role", "--role-name", ROLE]);
    expect(callsAfterCrash(s)).toEqual(["1: iam get-role"]);
  });
});
