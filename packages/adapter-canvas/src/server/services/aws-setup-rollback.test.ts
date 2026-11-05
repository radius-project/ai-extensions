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
  { released = true, warnings = [] as string[] } = {}
) {
  return {
    rollback: vi.fn(
      async (input: {
        targets: readonly { key: string; artifactType: string }[];
      }) => ({
        outcomes: input.targets.flatMap((target) => {
          const result = outcome(target.key);
          return result ? [result] : [];
        }),
        warnings,
        released
      })
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
    const access = fakeAccess(deleted);

    await rollbackAwsSetupArtifacts(op, {
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
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access: fakeAccess(deleted, {
        released: false,
        warnings: ["Radius could not release its lock."]
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

  it("does not take back a lock recorded for another role", async () => {
    const op = setupWithChanges();
    setContext(op, {
      awsDeployIdentityLock: {
        policyArn: "arn:aws:iam::123456789012:policy/radius-lock-other",
        policyId: "LOCK0"
      }
    });
    const access = fakeAccess(deleted);
    await rollbackAwsSetupArtifacts(op, {
      attempt: 1,
      awsEnabled: true,
      selected: provenOwnedCleanupTargets(op),
      access,
      steps: []
    });
    expect(access.rollback.mock.calls[0]?.[0]).not.toHaveProperty("adopt");
  });

  it("keeps an artifact it was kept from removing, and says why", async () => {
    const op = setupWithChanges();
    const pass = await rollbackAwsSetupArtifacts(op, {
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
