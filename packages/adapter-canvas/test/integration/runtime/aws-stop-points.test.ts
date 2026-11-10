import { afterEach, describe, expect, it } from "vitest";
import { readRecordedAwsLock } from "@radius-project/core";
import {
  applyDeletionRetry,
  beginRetryAttempt,
  configureOperationStore,
  operations,
  projectOperationActions,
  provenOwnedCleanupTargets,
  requestStop,
  unresolvedProviderMutations
} from "../../../src/operations.js";
import { disabledOperationStore } from "../../../src/operation-store.js";
import { removeAwsDeployIdentityLock } from "../../../src/server/services/aws-deploy-identity-lock.js";
import { releaseRecordedAwsLock } from "../../../src/server/services/aws-recorded-lock.js";
import { isAwsCleanupArtifactType } from "../../../src/server/services/aws-setup-rollback.js";
import type { FakeAwsSnapshot } from "../../support/aws/fake-aws.js";
import {
  completedSetup,
  createAwsScenario,
  createDeleteOperation,
  createSetupOperation,
  ENVIRONMENT,
  ROLE,
  runAwsRollback,
  runDelete,
  runRepair,
  runSetup,
  type AwsScenario,
  type SetupRole
} from "../../support/aws/scenarios.js";
import {
  callsAfterCrash,
  lostLocks,
  readOwnership,
  unsavedRollbackResults,
  unsavedSetupChanges
} from "../../support/aws/checks.js";
import {
  restart,
  writeLabels,
  writesAfterStop,
  type StopKind
} from "../../support/aws/stop-points.js";

// Every AWS-touching operation, stopped at each AWS and GitHub call in turn:
// a Stop while the call is in flight, a crash before it reaches the service,
// and, for a write, a crash after it lands with the answer lost. At each one
// the restored record must hold every confirmed change, name every lock it
// still holds, land where the design says, and lead to a clean end when the
// person picks the next step.

afterEach(async () => {
  operations.clear();
  await configureOperationStore(disabledOperationStore());
});

interface Point {
  at: number;
  command: string;
  kind: StopKind;
}

interface Prepared {
  run(): Promise<unknown>;
}

// Run the operation once without stopping, and list a stop point per call.
async function discover(
  role: SetupRole,
  prepare: (scenario: AwsScenario) => Promise<Prepared>,
  kinds: readonly StopKind[] = ["stop", "crash-before", "crash-after"]
): Promise<Point[]> {
  const scenario = await createAwsScenario(role);
  const prepared = await prepare(scenario);
  const start = scenario.outside.calls.length;
  await prepared.run();
  const points = scenario.outside.calls.slice(start).flatMap((call) =>
    kinds
      .filter((kind) => kind !== "crash-after" || call.write)
      .map((kind) => ({
        at: call.index - start,
        command: call.command,
        kind
      }))
  );
  operations.clear();
  await configureOperationStore(disabledOperationStore());
  return points;
}

// The environment policy every setup of dev in octo/shop attaches.
const SETUP_POLICY = "radius-deploy-dev-f5fb7acf8f59";

// The account's GitHub identity provider is never removed, by design.
function withoutProvider(snapshot: FakeAwsSnapshot) {
  return { ...snapshot, oidcProviders: [] };
}

function recordedLocks(): Set<string> {
  return new Set(
    operations
      .all()
      .flatMap(
        (record: { context?: unknown }) =>
          readRecordedAwsLock(record.context)?.policyId ?? []
      )
  );
}

function actionIds(operationId: string): string[] {
  return projectOperationActions(operations.get(operationId)).map(
    (action: { id: string }) => action.id
  );
}

/**
 * Delete setup from where a restart left the setup: settle any AWS write it
 * sent without an answer by reading, then roll back. A lock the record never
 * saved names this setup, so a run that needs it offers to remove it; the
 * person does, and Retry deletion finishes.
 */
async function deleteSetup(
  scenario: AwsScenario,
  operationId: string
): Promise<void> {
  const op = operations.get(operationId);
  const settling = scenario.outside.calls.length;
  await scenario.journal.reconcile(op);
  expect(writeLabels(scenario.outside.callsAfter(settling - 1))).toEqual([]);
  const recorded = recordedLocks();
  const stray = scenario.aws
    .locks()
    .filter((lock) => !recorded.has(lock.PolicyId));
  const changesAws = provenOwnedCleanupTargets(op).some((target) =>
    isAwsCleanupArtifactType(target.artifactType)
  );
  await runAwsRollback(scenario, op, 1);
  for (const lock of stray) {
    // Delete setup offers it when it has AWS changes to undo. Otherwise the
    // next run that needs the lock does, as Continue setup would.
    if (changesAws) {
      expect(
        (op.setupArtifacts.cleanup.results ?? []).some(
          (result: { detail: string | null }) =>
            result.detail?.includes(`prints ${lock.PolicyId}`)
        )
      ).toBe(true);
    }
    await removeAwsDeployIdentityLock(
      { policyArn: lock.Arn, policyId: lock.PolicyId },
      scenario.outside.runAws
    );
  }
  if (stray.length > 0 && changesAws) await runAwsRollback(scenario, op, 2);
}

const setupPoints = {
  new: await discover("new", async (s) => {
    const op = createSetupOperation(s);
    return { run: () => runSetup(s, op) };
  }),
  reused: await discover("reused", async (s) => {
    const op = createSetupOperation(s);
    return { run: () => runSetup(s, op) };
  })
};

describe.each(["new", "reused"] as const)(
  "AWS setup with a %s role, stopped at each outside call",
  (role) => {
    it.each(setupPoints[role])("$at $command ($kind)", async ({ at, kind }) => {
      const s = await createAwsScenario(role);
      const baseline = s.aws.snapshot();
      const before = readOwnership(s);
      const op = createSetupOperation(s);
      await operations.persist();
      const index = s.outside.arm(at, kind, () => requestStop(op));
      const outcome = await s.outside.until(() => runSetup(s, op));
      expect(outcome).toBe(kind === "stop" ? "done" : "crashed");
      if (kind === "stop") {
        expect(writeLabels(writesAfterStop(s.outside, index))).toEqual([]);
      }
      const savesAtCrash = s.disk.saves;
      const restarting = s.outside.calls.length;
      await restart(s.outside);
      expect(s.outside.calls.length).toBe(restarting);
      expect(callsAfterCrash(s)).toEqual([]);
      expect(unsavedSetupChanges(s, op.operationId, before)).toEqual([]);
      expect(lostLocks(s, op.operationId, kind, savesAtCrash)).toEqual([]);

      // A restarted AWS setup never rolls back by itself. It pauses for
      // Continue setup or Delete setup, once any unanswered write is settled.
      const restored = operations.get(op.operationId);
      expect(restored.providerRecovery?.state).not.toBe("rollback_pending");
      if (kind === "stop") {
        expect(actionIds(op.operationId)).toEqual(
          expect.arrayContaining(["continue-setup", "rollback"])
        );
      } else if (unresolvedProviderMutations(restored).length > 0) {
        expect(restored.recoveryState).toBe("provider_reconciliation_pending");
      } else {
        expect(actionIds(op.operationId)).toEqual(["continue-setup", "stop"]);
      }

      await deleteSetup(s, op.operationId);
      expect(withoutProvider(s.aws.snapshot())).toEqual(
        withoutProvider(baseline)
      );
    });
  }
);

const rollbackPoints = {
  new: await discover("new", async (s) => {
    const op = await completedSetup(s);
    return { run: () => runAwsRollback(s, op, 1) };
  }),
  reused: await discover("reused", async (s) => {
    const op = await completedSetup(s);
    return { run: () => runAwsRollback(s, op, 1) };
  })
};

describe.each(["new", "reused"] as const)(
  "Delete setup, Exit setup, and Retry deletion of a %s role, stopped at each outside call",
  (role) => {
    it.each(rollbackPoints[role])(
      "$at $command ($kind)",
      async ({ at, kind }) => {
        const s = await createAwsScenario(role);
        const baseline = s.aws.snapshot();
        const op = await completedSetup(s);
        const from = s.outside.calls.length;
        const index = s.outside.arm(at, kind, () => {
          s.stopped = true;
        });
        const outcome = await s.outside.until(() => runAwsRollback(s, op, 1));
        expect(outcome).toBe(kind === "stop" ? "done" : "crashed");
        if (kind === "stop") {
          expect(writeLabels(writesAfterStop(s.outside, index))).toEqual([]);
        }
        const savesAtCrash = s.disk.saves;
        await restart(s.outside);
        expect(callsAfterCrash(s)).toEqual([]);
        expect(unsavedRollbackResults(s, op.operationId, from)).toEqual([]);
        expect(lostLocks(s, op.operationId, kind, savesAtCrash)).toEqual([]);

        // Retry deletion repeats nothing AWS confirmed and finishes the job.
        s.stopped = false;
        await deleteSetup(s, op.operationId);
        expect(withoutProvider(s.aws.snapshot())).toEqual(
          withoutProvider(baseline)
        );
      }
    );
  }
);

// What a clean delete leaves, to compare a delete that was cut short with.
async function cleanDeleteResult(role: SetupRole) {
  const s = await createAwsScenario(role);
  await completedSetup(s, "succeeded");
  await runDelete(s, createDeleteOperation(s));
  const result = {
    aws: withoutProvider(s.aws.snapshot()),
    github: s.github.snapshot()
  };
  operations.clear();
  await configureOperationStore(disabledOperationStore());
  return result;
}

const deleteKinds = ["crash-before", "crash-after"] as const;
const deletePoints = {
  new: await discover(
    "new",
    async (s) => {
      await completedSetup(s, "succeeded");
      const op = createDeleteOperation(s);
      return { run: () => runDelete(s, op) };
    },
    deleteKinds
  ),
  reused: await discover(
    "reused",
    async (s) => {
      await completedSetup(s, "succeeded");
      const op = createDeleteOperation(s);
      return { run: () => runDelete(s, op) };
    },
    deleteKinds
  )
};
const cleanDelete = {
  new: await cleanDeleteResult("new"),
  reused: await cleanDeleteResult("reused")
};

describe.each(["new", "reused"] as const)(
  "environment delete of an environment on a %s role, crashed at each outside call",
  (role) => {
    it.each(deletePoints[role])(
      "$at $command ($kind)",
      async ({ at, kind }) => {
        const s = await createAwsScenario(role);
        await completedSetup(s, "succeeded");
        const op = createDeleteOperation(s);
        await operations.persist();
        s.outside.arm(at, kind);
        expect(await s.outside.until(() => runDelete(s, op))).toBe("crashed");
        const savesAtCrash = s.disk.saves;
        await restart(s.outside);
        expect(callsAfterCrash(s)).toEqual([]);
        expect(lostLocks(s, op.operationId, kind, savesAtCrash)).toEqual([]);

        // Retry deletion takes back the lock this deletion recorded by itself.
        // Only one it never saved needs the person's Remove lock.
        const recorded = recordedLocks();
        const stray = new Set(
          s.aws
            .locks()
            .filter((lock) => !recorded.has(lock.PolicyId))
            .map((lock) => lock.PolicyId)
        );
        s.onSleep = async () => {
          const wait = operations.get(op.operationId)?.context?.awsLockWait;
          if (!wait) return;
          expect(stray.has(wait.policyId)).toBe(true);
          expect(wait.removable).toBe(true);
          await removeAwsDeployIdentityLock(wait, s.outside.runAws);
        };
        await runDelete(s, operations.get(op.operationId));
        expect(withoutProvider(s.aws.snapshot())).toEqual(
          cleanDelete[role].aws
        );
        expect(s.github.snapshot()).toEqual(cleanDelete[role].github);
        expect(recordedLocks()).toEqual(new Set());
      }
    );
  }
);

describe.each(["new", "reused"] as const)(
  "environment delete on a %s role whose lock release landed but was never saved",
  (role) => {
    it("releases only the lock on Retry deletion, keeping an environment created again since", async () => {
      const s = await createAwsScenario(role);
      await completedSetup(s, "succeeded");
      const op = createDeleteOperation(s);
      await operations.persist();
      s.outside.armWhen(
        (call) =>
          call.command === "iam delete-policy" &&
          call.args.join(" ").includes(":policy/radius-lock-"),
        "crash-after"
      );
      expect(await s.outside.until(() => runDelete(s, op))).toBe("crashed");
      await restart(s.outside);
      expect(recordedLocks()).toEqual(new Set([expect.any(String)]));

      // Another setup creates the environment again before the retry.
      s.github.addEnvironment(ENVIRONMENT);
      const again = createSetupOperation(s, "op_setup_again");
      await runSetup(s, again);
      const recreated = withoutProvider(s.aws.snapshot());
      expect(recreated.roles[0]?.inline).toContain(SETUP_POLICY);

      await runDelete(s, operations.get(op.operationId));

      expect(withoutProvider(s.aws.snapshot())).toEqual(recreated);
      expect(recordedLocks()).toEqual(new Set());
      expect(operations.get(op.operationId).state).toBe("succeeded");
    });
  }
);

describe.each(["new", "reused"] as const)(
  "environment delete on a %s role whose lock release IAM refused",
  (role) => {
    it.each([
      ["the person removed the lock by hand", true],
      ["the lock is still there", false]
    ])(
      "retries only the lock after a restart, when %s, keeping an environment created again since",
      async (_label, removedByHand) => {
        const s = await createAwsScenario(role);
        await completedSetup(s, "succeeded");
        const op = createDeleteOperation(s);
        await operations.persist();
        // IAM refuses the release, and the deletion finishes without it.
        s.aws.refuseOnce("iam delete-policy", "AccessDenied");
        await runDelete(s, op);
        expect(op.state).toBe("succeeded_with_warnings");
        const [held] = s.aws.locks();
        expect(held).toBeDefined();

        await restart(s.outside);
        expect(recordedLocks()).toEqual(new Set([held?.PolicyId]));
        expect(actionIds(op.operationId)).toEqual(["retry-deletion"]);
        if (removedByHand && held) {
          await removeAwsDeployIdentityLock(
            { policyArn: held.Arn, policyId: held.PolicyId },
            s.outside.runAws
          );
        }

        // Another setup creates the environment again before the retry.
        // While the old lock is still there, it waits; the old deletion has
        // stopped, so the person removes that lock to let it go on.
        s.github.addEnvironment(ENVIRONMENT);
        const again = createSetupOperation(s, "op_setup_again");
        s.onSleep = async () => {
          const wait = operations.get(again.operationId)?.context?.awsLockWait;
          if (wait?.policyId === held?.PolicyId) {
            await removeAwsDeployIdentityLock(wait, s.outside.runAws);
          }
        };
        await runSetup(s, again);
        s.onSleep = null;
        const recreated = withoutProvider(s.aws.snapshot());
        expect(recreated.roles[0]?.inline).toContain(SETUP_POLICY);

        const retrying = s.outside.calls.length;
        const restored = operations.get(op.operationId);
        beginRetryAttempt(restored, "deletion");
        applyDeletionRetry(restored);
        await runDelete(s, restored);

        expect(withoutProvider(s.aws.snapshot())).toEqual(recreated);
        expect(
          writeLabels(s.outside.calls.slice(retrying)).filter(
            (label) => !label.endsWith("iam delete-policy")
          )
        ).toEqual([]);
        expect(recordedLocks()).toEqual(new Set());
        expect(restored.state).toBe("succeeded");
      }
    );
  }
);

const DRIFTED_SUBJECT = "repo:octo@7/shop@42:environment:dev";

// Someone removed the ID-based subject from the role's trust by hand.
async function driftedEnvironment(s: AwsScenario): Promise<void> {
  await completedSetup(s, "succeeded");
  const role = s.aws.role(ROLE);
  if (!role) throw new Error("Setup created no role.");
  role.AssumeRolePolicyDocument = JSON.parse(
    JSON.stringify(role.AssumeRolePolicyDocument).replace(
      `,"${DRIFTED_SUBJECT}"`,
      ""
    )
  );
}

const repairPoints = await discover(
  "new",
  async (s) => {
    await driftedEnvironment(s);
    return { run: () => runRepair(s) };
  },
  ["crash-before", "crash-after"]
);

describe("Repair, crashed at each outside call", () => {
  it("starts from a role that no longer trusts the environment's ID-based subject", async () => {
    const s = await createAwsScenario("new");
    await driftedEnvironment(s);
    expect(
      JSON.stringify(s.aws.role(ROLE)?.AssumeRolePolicyDocument)
    ).not.toContain(DRIFTED_SUBJECT);
  });

  it.each(repairPoints)("$at $command ($kind)", async ({ at, kind }) => {
    const s = await createAwsScenario("new");
    await driftedEnvironment(s);
    s.outside.arm(at, kind);
    expect(await s.outside.until(() => runRepair(s))).toBe("crashed");
    await restart(s.outside);
    expect(callsAfterCrash(s)).toEqual([]);

    // Repair keeps no record, so a lock it left names no operation. Until a
    // follow-up records it, another run offers Remove lock once it is 10
    // minutes old, and not before.
    const [stray, ...others] = s.aws.locks();
    expect(others).toEqual([]);
    if (stray) {
      expect(stray.Description).toContain('"action":"repair"');
      expect(stray.Description).toContain('"operationId":""');
      const early = await runRepair(s);
      expect(early.status).toBe(409);
      expect(String(early.body.error)).not.toContain("aws iam delete-policy");
      s.clock.now = Date.parse(stray.CreateDate) + 10 * 60 * 1000;
      const late = await runRepair(s);
      expect(String(late.body.error)).toContain(
        `prints ${stray.PolicyId}, the lock shown here`
      );
      await removeAwsDeployIdentityLock(
        { policyArn: stray.Arn, policyId: stray.PolicyId },
        s.outside.runAws
      );
    }
    const repaired = await runRepair(s);
    expect(repaired.status).toBe(200);
    expect(
      JSON.stringify(s.aws.role(ROLE)?.AssumeRolePolicyDocument)
    ).toContain(DRIFTED_SUBJECT);
    expect(s.aws.locks()).toEqual([]);
  });
});

// The first role read comes after the lock is taken and saved.
const lockedAt =
  setupPoints.new.find((point) => point.command === "iam get-role")?.at ?? -1;

// A setup the extension crashed in while it held the lock, so its release
// never ran and the restored record still names the lock.
async function crashedHoldingLock(s: AwsScenario): Promise<string> {
  const op = createSetupOperation(s);
  await operations.persist();
  s.outside.arm(lockedAt, "crash-before");
  expect(await s.outside.until(() => runSetup(s, op))).toBe("crashed");
  await restart(s.outside);
  return op.operationId;
}

// Abandon setup and Exit setup release a lock the setup still records.
async function releaseLock(s: AwsScenario, operationId: string) {
  await releaseRecordedAwsLock(operations.get(operationId), {
    awsEnabled: true,
    remove: (lock) => removeAwsDeployIdentityLock(lock, s.outside.runAws),
    errorMessage: String
  });
  await operations.persist();
}

const releasePoints = await discover(
  "new",
  async (s) => {
    const operationId = await crashedHoldingLock(s);
    return { run: () => releaseLock(s, operationId) };
  },
  ["crash-before", "crash-after"]
);

describe("Abandon setup's lock release, crashed at each outside call", () => {
  it("starts from a lock the crashed setup recorded", async () => {
    const s = await createAwsScenario("new");
    await crashedHoldingLock(s);
    expect(recordedLocks().size).toBe(1);
    expect(s.aws.locks()).toHaveLength(1);
  });

  it.each(releasePoints)("$at $command ($kind)", async ({ at, kind }) => {
    const s = await createAwsScenario("new");
    const operationId = await crashedHoldingLock(s);
    s.outside.arm(at, kind);
    expect(await s.outside.until(() => releaseLock(s, operationId))).toBe(
      "crashed"
    );
    const savesAtCrash = s.disk.saves;
    await restart(s.outside);
    expect(callsAfterCrash(s)).toEqual([]);
    expect(lostLocks(s, operationId, kind, savesAtCrash)).toEqual([]);

    // Released or still named, the next release ends with neither.
    await releaseLock(s, operationId);
    expect(s.aws.locks()).toEqual([]);
    expect(recordedLocks()).toEqual(new Set());
  });
});
