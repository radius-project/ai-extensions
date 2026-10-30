import {
  AWS_LOCK_REMOVABLE_AFTER_MS,
  awsLockHolderLabel,
  awsLockPolicyArn,
  buildAwsLockPolicyDocument,
  buildAwsLockPolicyName,
  describeAwsLockHolder,
  parseAwsLockHolder,
  type AwsLockHolder
} from "@radius-project/core";
import type { AwsCommandResult } from "./aws-deploy-identity.js";

// The lock every Radius run takes before it reads and rewrites a deploy
// identity's trust policy: setup, delete, rollback, and Repair. It is an IAM
// policy that only one caller can create.
//
// Radius never takes a lock over on its own. A run that was suspended, say by
// a sleeping laptop, could resume after a takeover and send a write it had
// already prepared, and nothing in IAM would refuse it. So after 10 minutes the
// waiting run offers **Remove lock**, and a person confirms the holder stopped.
//
// Each holder records its lock's policy ID, which IAM makes new on every
// create, and checks it before every write and before releasing. A run that
// resumes after its lock was removed then stops instead of writing, and never
// deletes the next holder's lock. The check is read-then-act on an eventually
// consistent service, so it narrows the window rather than closing it; the
// person confirming the holder stopped is what closes it.

export const AWS_LOCK_POLL_MS = 5000;

export interface AwsLockWait {
  readonly policyArn: string;
  readonly policyId: string;
  // Who holds the lock, as a sentence subject.
  readonly holder: string;
  // When IAM created the lock, as IAM reported it.
  readonly since: string;
  // Whether the lock is old enough to offer Remove lock.
  readonly removable: boolean;
}

export interface AwsLockPorts {
  // Run `aws <args>`. Never throws; a spawn failure is a non-zero result.
  runAws(args: string[]): Promise<AwsCommandResult>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  // Whether the caller asked to stop waiting.
  shouldStop(): boolean;
  // Called on every poll while another run holds the lock.
  waiting(wait: AwsLockWait): void | Promise<void>;
}

export interface AwsDeployIdentityLock {
  readonly policyArn: string;
  readonly policyId: string;
  /** Null while this run still holds the lock, otherwise why it does not. */
  verify(): Promise<string | null>;
  /** Delete the lock if this run still holds it. Safe to call twice. */
  release(): Promise<AwsLockReleaseResult>;
}

export type AwsLockReleaseResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type AwsLockAcquireResult =
  | { readonly ok: true; readonly lock: AwsDeployIdentityLock }
  | { readonly ok: false; readonly code: string; readonly message: string }
  | { readonly ok: false; readonly stopped: true };

export type AwsLockRemovalResult =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

const ACCESS_DENIED = /AccessDenied|UnauthorizedOperation|not authorized/i;
const NO_SUCH_ENTITY = /NoSuchEntity/;
const ALREADY_EXISTS = /EntityAlreadyExists/;
// Every verb that changes IAM or EKS. A command added to setup or delete later
// is checked against the lock without anyone having to remember to.
const WRITE_VERB =
  /^(?:create|update|put|delete|associate|disassociate|attach|detach|tag|untag|add|remove)-/;

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function detail(result: AwsCommandResult): string {
  return (result.stderr || result.stdout || "").trim() || "no output";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPolicy(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout || "null");
    return isRecord(parsed) && isRecord(parsed.Policy) ? parsed.Policy : null;
  } catch {
    return null;
  }
}

function text(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function deleteCommand(policyArn: string): string {
  return `aws iam delete-policy --policy-arn ${policyArn}`;
}

/** Whether an `aws` command changes IAM or EKS. */
export function isAwsWrite(args: readonly string[]): boolean {
  return WRITE_VERB.test(args[1] ?? "");
}

function permissionsMessage(accountId: string): string {
  return `Ask an IAM administrator to allow iam:CreatePolicy, iam:GetPolicy, and iam:DeletePolicy on arn:aws:iam::${accountId}:policy/radius-lock-*.`;
}

function heldLock(
  policyArn: string,
  policyId: string,
  roleName: string,
  runAws: AwsLockPorts["runAws"]
): AwsDeployIdentityLock {
  let released = false;
  const verify = async (): Promise<string | null> => {
    const get = await runAws([
      "iam",
      "get-policy",
      "--policy-arn",
      policyArn,
      "--output",
      "json"
    ]);
    if (!succeeded(get)) {
      return NO_SUCH_ENTITY.test(get.stderr) ?
          `The lock on IAM role ${roleName} was removed while this run held it, so Radius stopped before changing the role.`
        : `Radius could not confirm it still holds the lock on IAM role ${roleName}, so it stopped before changing the role: ${detail(get)}`;
    }
    const policy = readPolicy(get.stdout);
    if (text(policy, "PolicyId") === policyId) return null;
    return `The lock on IAM role ${roleName} was removed while this run held it, and another run now holds it (${awsLockHolderLabel(parseAwsLockHolder(policy?.Description))}). Radius stopped before changing the role.`;
  };
  return {
    policyArn,
    policyId,
    verify,
    async release() {
      if (released) return { ok: true };
      const lost = await verify();
      if (lost) {
        released = true;
        return {
          ok: false,
          message: `${lost} Radius left the current lock in place.`
        };
      }
      const remove = await runAws([
        "iam",
        "delete-policy",
        "--policy-arn",
        policyArn
      ]);
      if (succeeded(remove) || NO_SUCH_ENTITY.test(remove.stderr)) {
        released = true;
        return { ok: true };
      }
      return {
        ok: false,
        message:
          ACCESS_DENIED.test(remove.stderr) ?
            `Radius could not release the lock on IAM role ${roleName} because the signed-in AWS identity is not allowed iam:DeletePolicy. Other runs wait for it until it is removed. Run: ${deleteCommand(policyArn)}`
          : `Radius could not release the lock on IAM role ${roleName}: ${detail(remove)}. Other runs wait for it until it is removed. Run: ${deleteCommand(policyArn)}`
      };
    }
  };
}

/**
 * Take the lock on one deploy identity, waiting while another run holds it.
 * The caller must already have confirmed the CLI session is in `accountId`,
 * so the lock is created next to the role it protects.
 */
export async function acquireAwsDeployIdentityLock(
  request: { accountId: string; roleName: string; holder: AwsLockHolder },
  ports: AwsLockPorts
): Promise<AwsLockAcquireResult> {
  const { accountId, roleName } = request;
  const policyArn = awsLockPolicyArn(accountId, roleName);
  // A lock whose creation time IAM did not report is timed from when this run
  // first saw it, so Remove lock is still offered eventually.
  const firstSeen = new Map<string, number>();
  for (;;) {
    if (ports.shouldStop()) return { ok: false, stopped: true };
    const create = await ports.runAws([
      "iam",
      "create-policy",
      "--policy-name",
      buildAwsLockPolicyName(roleName),
      "--description",
      describeAwsLockHolder(request.holder),
      "--policy-document",
      JSON.stringify(buildAwsLockPolicyDocument(accountId, roleName)),
      "--output",
      "json"
    ]);
    if (succeeded(create)) {
      const policyId = text(readPolicy(create.stdout), "PolicyId");
      if (!policyId) {
        return {
          ok: false,
          code: "aws-lock-unreadable",
          message: `Radius created the lock on IAM role ${roleName} but AWS did not return its ID, so it cannot tell its own lock from the next one. Nothing else was changed. Run ${deleteCommand(policyArn)}, then retry.`
        };
      }
      return {
        ok: true,
        lock: heldLock(policyArn, policyId, roleName, ports.runAws)
      };
    }
    if (ACCESS_DENIED.test(create.stderr)) {
      return {
        ok: false,
        code: "aws-lock-denied",
        message: `The signed-in AWS identity is not allowed iam:CreatePolicy, which Radius needs to lock IAM role ${roleName} so two runs cannot overwrite each other's trust policy changes. Nothing was changed. ${permissionsMessage(accountId)}`
      };
    }
    if (!ALREADY_EXISTS.test(create.stderr)) {
      return {
        ok: false,
        code: "aws-lock-failed",
        message: `Radius could not lock IAM role ${roleName}: ${detail(create)}. Nothing was changed.`
      };
    }
    const get = await ports.runAws([
      "iam",
      "get-policy",
      "--policy-arn",
      policyArn,
      "--output",
      "json"
    ]);
    // Released between the create and this read; try again after the wait.
    if (!succeeded(get) && !NO_SUCH_ENTITY.test(get.stderr)) {
      return {
        ok: false,
        code:
          ACCESS_DENIED.test(get.stderr) ? "aws-lock-denied" : (
            "aws-lock-unreadable"
          ),
        message: `Another run holds the lock on IAM role ${roleName}, and Radius could not read who: ${detail(get)}. Nothing was changed. ${permissionsMessage(accountId)}`
      };
    }
    if (succeeded(get)) {
      const policy = readPolicy(get.stdout);
      const policyId = text(policy, "PolicyId");
      const since = text(policy, "CreateDate");
      const created = Date.parse(since);
      const seen = firstSeen.get(policyId) ?? ports.now();
      firstSeen.set(policyId, seen);
      const heldFrom = isNaN(created) ? seen : created;
      await ports.waiting({
        policyArn,
        policyId,
        holder: awsLockHolderLabel(parseAwsLockHolder(policy?.Description)),
        since,
        removable: ports.now() - heldFrom >= AWS_LOCK_REMOVABLE_AFTER_MS
      });
    }
    await ports.sleep(AWS_LOCK_POLL_MS);
  }
}

/**
 * Remove a lock a person confirmed is abandoned. Only the exact lock they were
 * shown is deleted: if another run has since taken a new one, it stays.
 */
export async function removeAwsDeployIdentityLock(
  request: { policyArn: string; policyId: string },
  runAws: AwsLockPorts["runAws"]
): Promise<AwsLockRemovalResult> {
  const account = /^arn:aws:iam::(\d{12}):policy\//.exec(request.policyArn);
  if (!account || !request.policyId) {
    return {
      ok: false,
      code: "aws-lock-invalid",
      message: "Radius does not know which lock to remove."
    };
  }
  // Read in another account, the lock would look missing and the removal would
  // report success while the real lock stays.
  const identity = await runAws([
    "sts",
    "get-caller-identity",
    "--output",
    "json"
  ]);
  let sessionAccount = "";
  try {
    const caller: unknown = JSON.parse(identity.stdout || "null");
    if (isRecord(caller) && typeof caller.Account === "string") {
      sessionAccount = caller.Account;
    }
  } catch {
    sessionAccount = "";
  }
  if (!succeeded(identity) || sessionAccount !== account[1]) {
    return {
      ok: false,
      code: "aws-account-mismatch",
      message: `Sign the AWS CLI in to account ${account[1]}, where the lock is, then try again. Nothing was removed.`
    };
  }
  const get = await runAws([
    "iam",
    "get-policy",
    "--policy-arn",
    request.policyArn,
    "--output",
    "json"
  ]);
  if (!succeeded(get)) {
    if (NO_SUCH_ENTITY.test(get.stderr)) return { ok: true, removed: false };
    return {
      ok: false,
      code: "aws-lock-unreadable",
      message: `Radius could not read the lock: ${detail(get)}. Nothing was removed.`
    };
  }
  if (text(readPolicy(get.stdout), "PolicyId") !== request.policyId) {
    return {
      ok: false,
      code: "aws-lock-changed",
      message:
        "The lock changed since it was shown: another run now holds a new one. Nothing was removed."
    };
  }
  const remove = await runAws([
    "iam",
    "delete-policy",
    "--policy-arn",
    request.policyArn
  ]);
  if (succeeded(remove) || NO_SUCH_ENTITY.test(remove.stderr)) {
    return { ok: true, removed: succeeded(remove) };
  }
  return {
    ok: false,
    code:
      ACCESS_DENIED.test(remove.stderr) ? "aws-lock-denied" : (
        "aws-lock-remove-failed"
      ),
    message: `Radius could not remove the lock: ${detail(remove)}`
  };
}
