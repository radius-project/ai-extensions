import { readRecordedAwsLock } from "@radius-project/core";
import { addLegacyStep, setContext } from "../../operations.js";
import {
  awsLockRecoveryCommand,
  type AwsLockRemovalResult
} from "./aws-deploy-identity-lock.js";

/**
 * Release the deploy identity lock a stopped setup still records, when the
 * customer closes or deletes that setup.
 *
 * Only the recorded lock goes: the removal checks the policy ID first, so a
 * newer lock another run took on the same role stays. A lock Radius could not
 * release stays recorded and named, and a later setup that waits on it is
 * told it comes from a stopped attempt and offered Remove lock at once.
 * Never throws. True when it changed the record, so the caller saves it.
 */
export async function releaseRecordedAwsLock(
  operation: Record<string, unknown>,
  {
    awsEnabled,
    remove,
    errorMessage
  }: {
    // The AWS developer switch. While it is off Radius runs no AWS command,
    // so the lock stays recorded and named.
    awsEnabled: boolean;
    remove(lock: {
      policyArn: string;
      policyId: string;
    }): Promise<AwsLockRemovalResult>;
    errorMessage(error: unknown): string;
  }
): Promise<boolean> {
  if (operation.provider !== "aws") return false;
  const lock = readRecordedAwsLock(operation.context);
  if (!lock) return false;
  const role = `IAM role ${lock.roleName}`;
  if (!awsEnabled) {
    addLegacyStep(
      operation,
      `⚠️ AWS environments are turned off, so Radius did not release the lock this setup holds on ${role}. Other Radius runs that change this role wait for it, and can remove it with Remove lock. ${awsLockRecoveryCommand(lock.policyArn, lock.policyId)}`
    );
    return true;
  }
  let result: AwsLockRemovalResult;
  try {
    result = await remove({
      policyArn: lock.policyArn,
      policyId: lock.policyId
    });
  } catch (error) {
    result = {
      ok: false,
      code: "aws-lock-remove-failed",
      message: `Radius could not remove the lock: ${errorMessage(error)}`
    };
  }
  if (result.ok) {
    setContext(operation, { awsDeployIdentityLock: null });
    addLegacyStep(
      operation,
      result.removed ?
        `🔓 Released the lock this setup held on ${role} (policy ID ${lock.policyId}).`
      : `ℹ️ The lock this setup held on ${role} was already gone.`
    );
    return true;
  }
  if (result.code === "aws-lock-changed") {
    setContext(operation, { awsDeployIdentityLock: null });
    addLegacyStep(
      operation,
      `ℹ️ The lock on ${role} is no longer the one this setup took (policy ID ${lock.policyId}), so Radius left it in place.`
    );
    return true;
  }
  addLegacyStep(
    operation,
    `⚠️ Radius did not release the lock this setup holds on ${role}. ${result.message.replace(/\.?$/, ".")} Other Radius runs that change this role wait for it, and can remove it with Remove lock. ${awsLockRecoveryCommand(lock.policyArn, lock.policyId)}`
  );
  return true;
}
