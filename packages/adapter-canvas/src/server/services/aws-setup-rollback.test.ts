import { assertSetupExecutionActive } from "@radius-project/core";
import { describe, expect, it, vi } from "vitest";
import {
  createOperation,
  provenOwnedCleanupTargets,
  recordAwsAccessEntry,
  recordAwsRole,
  recordAwsTrustSubject,
  recordGitHubEnvironment,
  setContext
} from "../../operations.js";
import type { AwsSetupRollbackOutcome } from "./aws-deploy-identity.js";
import {
  isAwsCleanupArtifactType,
  rollbackAwsSetupArtifacts
} from "./aws-setup-rollback.js";

const ROLE = "radius-deploy-octo-shop";
const ROLE_ARN = `arn:aws:iam::123456789012:role/${ROLE}`;
const LOCK_ARN = `arn:aws:iam::123456789012:policy/radius-lock-${ROLE}`;
const persist = async () => {};

// The error an ended execution raises before its next AWS command.
function interruption(): unknown {
  try {
    assertSetupExecutionActive(() => true);
  } catch (error) {
    return error;
  }
  return null;
}

function setupWithChanges() {
  const op = createOperation({
    operationId: "op_rollback",
    repo: "octo/shop",
    environment: "Dev",
    provider: "aws"
  });
  setContext(op, { canonicalEnvironment: "dev" });
  recordGitHubEnvironment(op, {
    state: "created",
    repo: "octo/shop",
    name: "dev",
    providerId: "17"
  });
  recordAwsRole(op, {
    state: "created",
    roleArn: ROLE_ARN,
    roleName: ROLE,
    roleId: "AROA1"
  });
  recordAwsTrustSubject(op, {
    roleArn: ROLE_ARN,
    roleName: ROLE,
    subject: "repo:octo/shop:environment:dev"
  });
  recordAwsAccessEntry(op, {
    roleArn: ROLE_ARN,
    roleName: ROLE,
    cluster: "shop",
    region: "us-west-2"
  });
  return op;
}

function fakeAccess(
  outcome: (key: string) => AwsSetupRollbackOutcome | null,
  {
    released = true,
    warnings = [] as string[],
    // The lock the fake rollback takes, if any.
    lock = null as { policyArn: string; policyId: string } | null,
    fails = null as unknown
  } = {}
) {
  return {
    rollback: vi.fn(
      async (input: {
        targets: readonly { key: string; artifactType: string }[];
        onLocked?(lock: { policyArn: string; policyId: string }): Promise<void>;
      }) => {
        if (lock) await input.onLocked?.(lock);
        if (fails) throw fails;
        return {
          outcomes: input.targets.flatMap((target) => {
            const result = outcome(target.key);
            return result ? [result] : [];
          }),
          warnings,
          released
        };
      }
    )
  };
}

const deleted = (key: string): AwsSetupRollbackOutcome => ({
  key,
  outcome: "deleted",
  detail: null
});

describe("rollbackAwsSetupArtifacts", () => {
  it("names the AWS artifact types", () => {
    expect(
      [
        "aws_role",
        "aws_trust_subject",
        "aws_role_policy",
        "aws_access_entry",
        "github_environment",
        "aws_deploy_identity_lock"
      ].map(isAwsCleanupArtifactType)
    ).toEqual([true, true, true, true, false, false]);
  });

  it("rolls back the selected AWS changes on their role and records them removed", async () => {
    const op = setupWithChanges();
    const access = fakeAccess(deleted);
    const steps: string[] = [];

    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps
    });

    expect(access.rollback).toHaveBeenCalledExactlyOnceWith({
      repo: "octo/shop",
      environment: "dev",
      operationId: "op_rollback",
      roleArn: ROLE_ARN,
      onLocked: expect.any(Function),
      targets: [
        expect.objectContaining({
          artifactType: "aws_access_entry",
          cluster: "shop",
          region: "us-west-2"
        }),
        expect.objectContaining({
          artifactType: "aws_trust_subject",
          subject: "repo:octo/shop:environment:dev"
        }),
        expect.objectContaining({
          artifactType: "aws_role",
          roleId: "AROA1"
        })
      ]
    });
    expect(pass.attempted).toBe(true);
    expect(pass.warnings).toEqual([]);
    expect(
      pass.results.map((entry) => [entry.artifactType, entry.outcome])
    ).toEqual([
      ["aws_access_entry", "deleted"],
      ["aws_trust_subject", "deleted"],
      ["aws_role", "deleted"]
    ]);
    expect(op.setupArtifacts.awsRole.state).toBe("deleted");
    expect(op.setupArtifacts.awsAccessEntries[0].state).toBe("deleted");
    expect(steps).toContain(`✅ Removed IAM role ${ROLE}.`);
    expect(
      provenOwnedCleanupTargets(op).map((target) => target.artifactType)
    ).toEqual(["github_environment"]);
  });

  it("takes back the setup's own lock and forgets it once released", async () => {
    const op = setupWithChanges();
    setContext(op, {
      awsDeployIdentityLock: { policyArn: LOCK_ARN, policyId: "LOCK0" }
    });
    const access = fakeAccess(deleted, {
      lock: { policyArn: LOCK_ARN, policyId: "LOCK0" }
    });

    await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });

    expect(access.rollback.mock.calls[0]?.[0]).toMatchObject({
      adopt: "LOCK0"
    });
    expect(op.context.awsDeployIdentityLock).toBeNull();
  });

  it("keeps the recorded lock when the rollback could not release it", async () => {
    const op = setupWithChanges();
    setContext(op, {
      awsDeployIdentityLock: { policyArn: LOCK_ARN, policyId: "LOCK0" }
    });
    const steps: string[] = [];

    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess(deleted, {
        released: false,
        warnings: ["Radius could not release its lock."],
        lock: { policyArn: LOCK_ARN, policyId: "LOCK0" }
      }),
      steps
    });

    expect(op.context.awsDeployIdentityLock).toEqual({
      policyArn: LOCK_ARN,
      policyId: "LOCK0"
    });
    expect(pass.warnings).toEqual(["Radius could not release its lock."]);
    expect(steps).toContain("⚠️ Radius could not release its lock.");
  });

  it("leaves a role alone while the lock on another role is still recorded", async () => {
    const op = setupWithChanges();
    const other = {
      policyArn: "arn:aws:iam::123456789012:policy/radius-lock-other",
      policyId: "LOCK0"
    };
    setContext(op, { awsDeployIdentityLock: other });
    const access = fakeAccess(deleted);
    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });
    expect(access.rollback).not.toHaveBeenCalled();
    expect(pass.results.every((entry) => entry.outcome === "warning")).toBe(
      true
    );
    expect(pass.warnings[0]).toBe(
      `Radius still holds the lock on IAM role other, so it did not change IAM role ${ROLE} on EKS cluster shop (us-west-2) yet. Retry deletion to try again.`
    );
    expect(op.context.awsDeployIdentityLock).toEqual(other);
  });

  it("records a lock the rollback takes before any change, and forgets it once released", async () => {
    const op = setupWithChanges();
    const saved: unknown[] = [];
    const lock = { policyArn: LOCK_ARN, policyId: "LOCK7" };
    await rollbackAwsSetupArtifacts(op, {
      persist: async () => {
        saved.push(structuredClone(op.context.awsDeployIdentityLock));
      },
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess(deleted, { lock }),
      steps: []
    });
    expect(saved).toEqual([lock]);
    expect(op.context.awsDeployIdentityLock).toBeNull();
  });

  it("keeps a lock the rollback took when its release fails", async () => {
    const op = setupWithChanges();
    const lock = { policyArn: LOCK_ARN, policyId: "LOCK7" };
    await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess(deleted, { lock, released: false }),
      steps: []
    });
    expect(op.context.awsDeployIdentityLock).toEqual(lock);
  });

  it("keeps a recorded lock it could not take back", async () => {
    const op = setupWithChanges();
    const recorded = { policyArn: LOCK_ARN, policyId: "LOCK0" };
    setContext(op, { awsDeployIdentityLock: recorded });
    await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess(() => null),
      steps: []
    });
    expect(op.context.awsDeployIdentityLock).toEqual(recorded);
  });

  it("sends nothing once the execution has ended", async () => {
    const op = setupWithChanges();
    const access = fakeAccess(deleted);
    expect(
      await rollbackAwsSetupArtifacts(op, {
        persist,
        isStopped: () => true,
        attempt: 1,
        awsEnabled: true,
        selected: provenOwnedCleanupTargets(op),
        access,
        steps: []
      })
    ).toEqual({
      attempted: true,
      results: [],
      warnings: [],
      interrupted: true
    });
    expect(access.rollback).not.toHaveBeenCalled();
  });

  it("stops when the execution ends during a rollback, keeping the lock it recorded", async () => {
    const op = setupWithChanges();
    const lock = { policyArn: LOCK_ARN, policyId: "LOCK7" };
    const isStopped = vi.fn(() => false);
    const access = fakeAccess(deleted, { lock, fails: interruption() });
    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      isStopped,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });
    expect(pass).toMatchObject({ interrupted: true, results: [] });
    expect(access.rollback.mock.calls[0]?.[0]).toMatchObject({ isStopped });
    expect(op.context.awsDeployIdentityLock).toEqual(lock);
    expect(op.setupArtifacts.awsRole.state).toBe("created");
  });

  it.each([
    ["released", true, null],
    ["not released", false, { policyArn: LOCK_ARN, policyId: "LOCK7" }]
  ])(
    "keeps and saves what finished on a role when the execution ends part way, with the lock %s",
    async (_label, released, lockAfter) => {
      const op = setupWithChanges();
      const lock = { policyArn: LOCK_ARN, policyId: "LOCK7" };
      const saved: unknown[] = [];
      const access = {
        rollback: vi.fn(
          async (input: {
            onLocked?(lock: {
              policyArn: string;
              policyId: string;
            }): Promise<void>;
          }) => {
            await input.onLocked?.(lock);
            return {
              outcomes: [deleted(provenOwnedCleanupTargets(op)[0]!.key)],
              warnings: released ? [] : ["Radius could not release its lock."],
              released,
              interrupted: true as const
            };
          }
        )
      };

      const pass = await rollbackAwsSetupArtifacts(op, {
        persist: async () => {
          saved.push({
            lock: structuredClone(op.context.awsDeployIdentityLock),
            entries: structuredClone(op.setupArtifacts.awsAccessEntries)
          });
        },
        attempt: 1,
        awsEnabled: true,
        selected: provenOwnedCleanupTargets(op),
        access,
        steps: []
      });

      expect(pass.interrupted).toBe(true);
      // Only the change AWS answered; the rest are tried again.
      expect(
        pass.results.map((entry) => [entry.artifactType, entry.outcome])
      ).toEqual([["aws_access_entry", "deleted"]]);
      expect(op.setupArtifacts.awsRole.state).toBe("created");
      expect(op.context.awsDeployIdentityLock).toEqual(lockAfter);
      // Saved after the role, with the deletion and the lock's state.
      expect(saved.at(-1)).toEqual({
        lock: lockAfter,
        entries: [expect.objectContaining({ state: "deleted" })]
      });
    }
  );

  it("passes on any other rollback error", async () => {
    const op = setupWithChanges();
    await expect(
      rollbackAwsSetupArtifacts(op, {
        persist,
        attempt: 1,
        awsEnabled: true,
        selected: provenOwnedCleanupTargets(op),
        access: fakeAccess(deleted, { fails: new Error("boom") }),
        steps: []
      })
    ).rejects.toThrow("boom");
  });

  it("keeps an artifact it was kept from removing, and says why", async () => {
    const op = setupWithChanges();
    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess((key) =>
        key.startsWith("aws_role#") ?
          { key, outcome: "skipped", detail: "Kept the role." }
        : null
      ),
      steps: []
    });
    expect(
      pass.results.map((entry) => [entry.artifactType, entry.outcome])
    ).toEqual([
      ["aws_access_entry", "warning"],
      ["aws_trust_subject", "warning"],
      ["aws_role", "skipped"]
    ]);
    expect(pass.warnings).toContain("Kept the role.");
    expect(op.setupArtifacts.awsRole.state).toBe("created");
  });

  it("runs no AWS command while AWS is turned off", async () => {
    const op = setupWithChanges();
    const access = fakeAccess(deleted);
    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: false,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });
    expect(access.rollback).not.toHaveBeenCalled();
    expect(pass.results.every((entry) => entry.outcome === "warning")).toBe(
      true
    );
    expect(pass.warnings[0]).toBe(
      `AWS environments are turned off, so Radius did not remove IAM role ${ROLE} on EKS cluster shop (us-west-2).`
    );
  });

  it("does nothing when no AWS change is selected", async () => {
    const op = setupWithChanges();
    const access = fakeAccess(deleted);
    expect(
      await rollbackAwsSetupArtifacts(op, {
        persist,
        attempt: 1,
        awsEnabled: true,
        selected: provenOwnedCleanupTargets(op).filter(
          (target) => target.artifactType === "github_environment"
        ),
        access,
        steps: []
      })
    ).toEqual({ attempted: false, results: [], warnings: [] });
    expect(access.rollback).not.toHaveBeenCalled();
  });

  it("uses the requested environment name when no canonical one was saved", async () => {
    const op = setupWithChanges();
    op.context = {};
    const access = fakeAccess(deleted);
    await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });
    expect(access.rollback.mock.calls[0]?.[0]).toMatchObject({
      environment: "Dev"
    });
  });

  it("rolls back a role saved without its name by its ARN alone", async () => {
    const op = setupWithChanges();
    op.setupArtifacts.awsRole.roleName = null;
    const access = fakeAccess(deleted);
    await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });
    expect(access.rollback.mock.calls[0]?.[0].targets).toContainEqual(
      expect.objectContaining({ artifactType: "aws_role", roleName: "" })
    );
  });

  it("records a change that was already gone without a Removed line", async () => {
    const op = setupWithChanges();
    const steps: string[] = [];
    const pass = await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess((key) => ({
        key,
        outcome: "not_found",
        detail: null
      })),
      steps
    });
    expect(pass.warnings).toEqual([]);
    expect(steps).toEqual([]);
    expect(pass.results.every((entry) => entry.outcome === "not_found")).toBe(
      true
    );
    expect(op.setupArtifacts.awsRole.state).toBe("deleted");
    expect(op.setupArtifacts.awsAccessEntries).toEqual([
      expect.objectContaining({ state: "deleted" })
    ]);
  });

  it("skips a selected target the ledger no longer holds", async () => {
    const op = setupWithChanges();
    const selected = provenOwnedCleanupTargets(op);
    op.setupArtifacts.awsRole.state = "deleted";
    op.setupArtifacts.awsAccessEntries = [];
    const access = fakeAccess(deleted);
    await rollbackAwsSetupArtifacts(op, {
      persist,
      attempt: 1,
      awsEnabled: true,
      selected: [
        ...selected,
        { artifactType: "aws_role_policy", key: "x", identity: "missing" },
        { artifactType: "aws_trust_subject", key: "y", identity: "missing" },
        { artifactType: "aws_access_entry", key: "z", identity: null }
      ],
      access,
      steps: []
    });
    expect(
      access.rollback.mock.calls[0]?.[0].targets.map(
        (target: { artifactType: string }) => target.artifactType
      )
    ).toEqual(["aws_trust_subject"]);
  });
});
