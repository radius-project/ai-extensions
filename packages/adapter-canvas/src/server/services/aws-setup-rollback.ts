import {
  assertSetupExecutionActive,
  isSetupExecutionInterrupted,
  readRecordedAwsLock
} from "@radius-project/core";
import {
  cleanupArtifactIdentity,
  readSetupArtifactLedger,
  recordCleanupDeletion,
  setContext,
  type SetupCleanupArtifactType,
  type SetupCleanupResult
} from "../../operations.js";
import type {
  AwsSetupRollbackOutcome,
  AwsSetupRollbackTarget
} from "./aws-deploy-identity.js";
import type { AwsEnvironmentAccess } from "./aws-environment-access.js";

// Runs the AWS part of a setup's rollback, retried cleanup, or exit: it turns
// the selected ledger entries into one rollback per role, and their outcomes
// into cleanup results.

const AWS_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  "aws_access_entry",
  "aws_role_policy",
  "aws_trust_subject",
  "aws_role"
]);

export function isAwsCleanupArtifactType(artifactType: string): boolean {
  return AWS_ARTIFACT_TYPES.has(artifactType);
}

// A cleanup target as the cleanup command selected it.
interface SelectedTarget {
  artifactType: string;
  key: string;
  [field: string]: unknown;
}

interface Operation {
  operationId: string;
  repo: string;
  environment: string;
  context?: unknown;
  setupArtifacts?: unknown;
}

// The ledger entry each selected AWS target names, with what a rollback
// needs to find it in AWS.
function rollbackTargets(
  operation: Operation,
  selected: readonly SelectedTarget[]
): Array<AwsSetupRollbackTarget & { label: string; identity: string }> {
  const ledger = readSetupArtifactLedger(operation.setupArtifacts);
  const found: Array<
    AwsSetupRollbackTarget & { label: string; identity: string }
  > = [];
  for (const target of selected) {
    const identity = typeof target.identity === "string" ? target.identity : "";
    const matches = (artifact: unknown) =>
      cleanupArtifactIdentity(target.artifactType, artifact) === identity;
    const base = {
      key: target.key,
      label: String(target.target || ""),
      identity
    };
    switch (target.artifactType) {
      case "aws_role": {
        const role = ledger.awsRole;
        if (role.state !== "created" || !matches(role) || !role.roleArn) break;
        found.push({
          ...base,
          artifactType: "aws_role",
          roleArn: role.roleArn,
          roleName: role.roleName || "",
          roleId: role.roleId
        });
        break;
      }
      case "aws_trust_subject": {
        const entry = ledger.awsTrustSubjects.find(
          (item) => item.state === "created" && matches(item)
        );
        if (entry)
          found.push({ ...base, ...entry, artifactType: "aws_trust_subject" });
        break;
      }
      case "aws_role_policy": {
        const entry = ledger.awsRolePolicies.find(
          (item) => item.state === "created" && matches(item)
        );
        if (entry)
          found.push({ ...base, ...entry, artifactType: "aws_role_policy" });
        break;
      }
      case "aws_access_entry": {
        const entry = ledger.awsAccessEntries.find(
          (item) => item.state === "created" && matches(item)
        );
        if (entry)
          found.push({ ...base, ...entry, artifactType: "aws_access_entry" });
        break;
      }
    }
  }
  return found;
}

export async function rollbackAwsSetupArtifacts(
  operation: Operation,
  {
    attempt,
    awsEnabled,
    selected,
    access,
    steps,
    persist,
    isStopped
  }: {
    attempt: number;
    // The AWS developer switch. While it is off Radius runs no AWS command.
    awsEnabled: boolean;
    selected: readonly SelectedTarget[];
    access: Pick<AwsEnvironmentAccess<unknown>, "rollback">;
    steps: string[];
    persist(): Promise<void>;
    // True once this execution has ended; nothing further is sent.
    isStopped?(): boolean;
  }
): Promise<{
  attempted: boolean;
  results: SetupCleanupResult[];
  warnings: string[];
  // The execution ended part way. `results` holds what finished before it.
  interrupted?: boolean;
}> {
  const targets = rollbackTargets(
    operation,
    selected.filter((target) => isAwsCleanupArtifactType(target.artifactType))
  );
  const results: SetupCleanupResult[] = [];
  const warnings: string[] = [];
  if (targets.length === 0) return { attempted: false, results, warnings };
  const result = (
    target: (typeof targets)[number],
    entry: AwsSetupRollbackOutcome
  ): void => {
    results.push({
      attempt,
      artifactType: target.artifactType as SetupCleanupArtifactType,
      target: target.label,
      identity: target.identity,
      outcome: entry.outcome,
      detail: entry.detail
    });
    if (entry.detail === null) {
      recordCleanupDeletion(operation, {
        artifactType: target.artifactType,
        identity: target.identity
      });
      if (entry.outcome === "deleted") {
        steps.push(`✅ Removed ${target.label}.`);
      }
    } else {
      warnings.push(entry.detail);
      steps.push(`⚠️ ${entry.detail}`);
    }
  };
  if (!awsEnabled) {
    for (const target of targets) {
      result(target, {
        key: target.key,
        outcome: "warning",
        detail: `AWS environments are turned off, so Radius did not remove ${target.label}.`
      });
    }
    return { attempted: true, results, warnings };
  }
  const context = operation.context;
  const environment =
    (
      typeof context === "object" &&
      context !== null &&
      "canonicalEnvironment" in context &&
      typeof context.canonicalEnvironment === "string" &&
      context.canonicalEnvironment
    ) ?
      context.canonicalEnvironment
    : operation.environment;
  for (const roleArn of new Set(targets.map((target) => target.roleArn))) {
    const forRole = targets.filter((target) => target.roleArn === roleArn);
    const roleName = forRole[0]?.roleName;
    // The operation records one lock. One still held on another role must
    // stay recorded until it is released, so this role waits for a retry.
    const recorded = readRecordedAwsLock(operation.context);
    if (recorded && recorded.roleName !== roleName) {
      for (const target of forRole) {
        result(target, {
          key: target.key,
          outcome: "warning",
          detail: `Radius still holds the lock on IAM role ${recorded.roleName}, so it did not change ${target.label} yet. Retry deletion to try again.`
        });
      }
      continue;
    }
    let locked = false;
    let rolledBack: Awaited<ReturnType<typeof access.rollback>>;
    try {
      assertSetupExecutionActive(isStopped);
      rolledBack = await access.rollback({
        repo: operation.repo,
        environment,
        operationId: operation.operationId,
        roleArn,
        targets: forRole,
        ...(recorded ? { adopt: recorded.policyId } : {}),
        ...(isStopped ? { isStopped } : {}),
        // Saved before the first change, so a crash or a failed release
        // still leaves the lock listed, released on exit, and adoptable.
        onLocked: async (lock) => {
          locked = true;
          setContext(operation, { awsDeployIdentityLock: lock });
          await persist();
        }
      });
    } catch (error) {
      if (!isSetupExecutionInterrupted(error)) throw error;
      return { attempted: true, results, warnings, interrupted: true };
    }
    if (locked && rolledBack.released) {
      setContext(operation, { awsDeployIdentityLock: null });
    }
    for (const line of rolledBack.warnings) {
      warnings.push(line);
      steps.push(`⚠️ ${line}`);
    }
    for (const target of forRole) {
      const outcome = rolledBack.outcomes.find(
        (entry) => entry.key === target.key
      );
      result(
        target,
        outcome ?? {
          key: target.key,
          outcome: "warning",
          detail: `Radius did not get a result for ${target.label}, so it may still be there.`
        }
      );
    }
  }
  return { attempted: true, results, warnings };
}
