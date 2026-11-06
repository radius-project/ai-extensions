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
import { verifyAwsCliSession } from "./aws-cli-session.js";

// The lock a Radius run takes before it reads and rewrites a deploy identity's
// trust policy. Setup and delete take it today, and Repair takes it in the
// change that adds Repair. Rollback (#1096) is reserved for it. It is an IAM
// policy that only one caller can create.
//
// Radius never takes a lock over on its own. A run that was suspended, say by
// a sleeping laptop, could resume after a takeover and send a write it had
// already prepared, and nothing in IAM would refuse it. So once the lock is 10
// minutes old the waiting run offers **Remove lock**, and a person confirms
// the holder stopped. When the holder is an operation this extension knows has
// stopped, Remove lock is offered at once, still for a person to confirm.
//
// The one lock a run takes back by itself is its own: an operation that
// recorded its lock's policy ID and finds that same lock naming it holds it
// again, since IAM never reuses a policy ID.
//
// Each holder records its lock's policy ID, which IAM makes new on every
// create, and checks it before every write and before releasing. That catches
// a run that resumes long after its lock was removed. It does not close every
// gap: the check and the write, or the check and the delete on release, are
// separate calls to an eventually consistent service. A write already past its
// check still lands, and a release can delete a newer lock taken in between.
// Two people removing the same stuck lock can also delete a lock the next run
// just took. #1152 tracks a strongly consistent lock that closes these.

export const AWS_LOCK_POLL_MS = 5000;
// Waits while a lock this run just created is not yet readable in IAM.
export const LOCK_VISIBLE_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
// Waits between tries of a lock check or release that failed in a way a retry
// can fix: throttling, an IAM service error, a dropped connection, or a CLI
// call that ran past its time limit.
export const LOCK_TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// How many waits in a row may fail that way before waiting gives up. Each
// failed wait backs off from the poll interval, up to a minute.
export const LOCK_WAIT_TRANSIENT_LIMIT = 6;
const LOCK_WAIT_BACKOFF_MAX_MS = 60000;

export interface AwsLockWait {
  readonly policyArn: string;
  readonly policyId: string;
  // Who holds the lock, as a sentence subject.
  readonly holder: string;
  // The Radius operation that holds the lock, or "" when it names none.
  readonly holderOperationId: string;
  // When IAM created the lock, as IAM reported it.
  readonly since: string;
  // Whether the holder is a Radius operation that has stopped, so the lock is
  // left from an earlier attempt rather than held by a running one.
  readonly stopped: boolean;
  // Whether to offer Remove lock: the holder stopped, or the lock is old.
  readonly removable: boolean;
}

export interface AwsLockPorts {
  // Run `aws <args>`. Never throws; a spawn failure is a non-zero result.
  runAws(args: string[]): Promise<AwsCommandResult>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  // Whether the caller asked to stop waiting.
  shouldStop(): boolean;
  // Whether `operationId` names a Radius operation known to have stopped.
  isStoppedOperation(operationId: string): boolean;
  // Called on every poll while another run holds the lock.
  waiting(wait: AwsLockWait): void | Promise<void>;
}

// Why a run no longer knows it holds its lock. `reason` is a sentence about
// the lock only; the caller says what that means for its own writes.
export type AwsLockLoss =
  | { readonly kind: "removed" | "replaced"; readonly reason: string }
  | { readonly kind: "unconfirmed"; readonly reason: string };

export interface AwsDeployIdentityLock {
  readonly policyArn: string;
  readonly policyId: string;
  /** Null while this run still holds the lock, otherwise why it does not. */
  verify(): Promise<AwsLockLoss | null>;
  /**
   * Delete the lock if this run still holds it. Safe to call again after a
   * failure: the lock stays this run's until it is released or known gone.
   */
  release(): Promise<AwsLockReleaseResult>;
}

export type AwsLockReleaseResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      // True when the lock is no longer this run's to release, so a retry
      // would do nothing.
      readonly gone: boolean;
      readonly message: string;
    };

export type AwsLockAcquireResult =
  | {
      readonly ok: true;
      readonly lock: AwsDeployIdentityLock;
      // Set when the lock was this operation's recorded lock, held again.
      readonly adopted?: true;
    }
  | { readonly ok: false; readonly code: string; readonly message: string }
  | { readonly ok: false; readonly stopped: true }
  // Only without waiting: another run holds the lock. `holder` is null when
  // IAM said the lock exists but could not say who holds it.
  | {
      readonly ok: false;
      readonly busy: true;
      readonly holder: AwsLockWait | null;
    };

export type AwsLockRemovalResult =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

const ACCESS_DENIED = /AccessDenied|UnauthorizedOperation|not authorized/i;
const TRANSIENT =
  /Throttl|RequestLimitExceeded|TooManyRequests|Rate exceeded|ServiceFailure|ServiceUnavailable|InternalFailure|InternalError|RequestTimeout|EndpointConnectionError|Could not connect|Connection (?:was )?(?:reset|refused|closed|aborted)|Read timeout|connect timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i;
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
  const output = (result.stderr || result.stdout || "").trim();
  if (result.timedOut) {
    return output ?
        `the AWS CLI call timed out (${output})`
      : "the AWS CLI call timed out";
  }
  return output || "no output";
}

/** The command a person runs to remove one lock safely, by its policy ID. */
export function awsLockRecoveryCommand(
  policyArn: string,
  policyId: string
): string {
  return recoveryCommand(policyArn, policyId);
}

/** Whether a failed `aws` call may succeed if it is tried again. */
export function isTransientAwsFailure(result: AwsCommandResult): boolean {
  return (
    !succeeded(result) &&
    (result.timedOut === true || TRANSIENT.test(result.stderr))
  );
}

// Run one `aws` call, trying it again after a failure a retry can fix.
async function runRetrying(
  ports: Pick<AwsLockPorts, "runAws" | "sleep">,
  args: string[]
): Promise<AwsCommandResult> {
  let result = await ports.runAws(args);
  for (const delay of LOCK_TRANSIENT_RETRY_DELAYS_MS) {
    if (!isTransientAwsFailure(result)) break;
    await ports.sleep(delay);
    result = await ports.runAws(args);
  }
  return result;
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

// Every lock on one role has the same ARN, so the delete must be checked
// against the policy ID first, or it can remove another run's newer lock.
function recoveryCommand(policyArn: string, policyId: string): string {
  return `Check that "aws iam get-policy --policy-arn ${policyArn} --query Policy.PolicyId --output text" prints ${policyId}, which is this run's lock, and only then run: aws iam delete-policy --policy-arn ${policyArn}`;
}

/** Whether an `aws` command changes IAM or EKS. */
export function isAwsWrite(args: readonly string[]): boolean {
  return WRITE_VERB.test(args[1] ?? "");
}

function permissionsMessage(accountId: string): string {
  return `Ask an IAM administrator to allow iam:CreatePolicy, iam:GetPolicy, and iam:DeletePolicy on arn:aws:iam::${accountId}:policy/radius-lock-*.`;
}

// What the run that held the lock was, for release messages.
const ACTION_LABEL: Readonly<Record<AwsLockHolder["action"], string>> = {
  setup: "This setup",
  delete: "This deletion",
  repair: "This repair",
  rollback: "This rollback"
};

function heldLock(
  policyArn: string,
  policyId: string,
  roleName: string,
  action: AwsLockHolder["action"],
  ports: Pick<AwsLockPorts, "runAws" | "sleep">
): AwsDeployIdentityLock {
  let released = false;
  const done = `${ACTION_LABEL[action]} is done with IAM role ${roleName}`;
  const verify = async (): Promise<AwsLockLoss | null> => {
    const get = await runRetrying(ports, [
      "iam",
      "get-policy",
      "--policy-arn",
      policyArn,
      "--output",
      "json"
    ]);
    if (!succeeded(get)) {
      return NO_SUCH_ENTITY.test(get.stderr) ?
          {
            kind: "removed",
            reason: `The lock on IAM role ${roleName} was removed while this run held it`
          }
        : {
            kind: "unconfirmed",
            reason: `Radius could not confirm it still holds the lock on IAM role ${roleName} (${detail(get)})`
          };
    }
    const policy = readPolicy(get.stdout);
    if (text(policy, "PolicyId") === policyId) return null;
    return {
      kind: "replaced",
      reason: `The lock on IAM role ${roleName} was removed while this run held it, and another run now holds a new one (${awsLockHolderLabel(parseAwsLockHolder(policy?.Description))})`
    };
  };
  return {
    policyArn,
    policyId,
    verify,
    async release() {
      if (released) return { ok: true };
      const lost = await verify();
      if (lost?.kind === "removed") {
        released = true;
        return {
          ok: false,
          gone: true,
          message: `${done}, but its lock had already been removed, so there was nothing to release. Another run may have changed the role while this one held it.`
        };
      }
      if (lost?.kind === "replaced") {
        released = true;
        return {
          ok: false,
          gone: true,
          message: `${done}. ${lost.reason}, so Radius left that lock in place. Another run may have changed the role while this one held it.`
        };
      }
      if (lost) {
        return {
          ok: false,
          gone: false,
          message: `${done}, but ${lost.reason}, so Radius did not delete the lock. Other runs wait for this lock until it is removed. ${recoveryCommand(policyArn, policyId)}`
        };
      }
      const remove = await runRetrying(ports, [
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
        gone: false,
        message:
          ACCESS_DENIED.test(remove.stderr) ?
            `${done}, but Radius could not release its lock because the signed-in AWS identity is not allowed iam:DeletePolicy. Other runs wait for this lock until it is removed. ${recoveryCommand(policyArn, policyId)}`
          : `${done}, but Radius could not release its lock: ${detail(remove)}. Other runs wait for this lock until it is removed. ${recoveryCommand(policyArn, policyId)}`
      };
    }
  };
}

// IAM is eventually consistent, so a policy it just created can read as
// missing for a few seconds. Every later check reads the lock, so it has to be
// readable first, or the first write would stop as if the lock were removed.
async function awaitLockVisible(
  policyArn: string,
  policyId: string,
  roleName: string,
  ports: AwsLockPorts
): Promise<{ code: string; message: string } | null> {
  for (let attempt = 0; ; attempt++) {
    const get = await ports.runAws([
      "iam",
      "get-policy",
      "--policy-arn",
      policyArn,
      "--output",
      "json"
    ]);
    if (succeeded(get)) {
      if (text(readPolicy(get.stdout), "PolicyId") === policyId) return null;
      return {
        code: "aws-lock-lost",
        message: `The lock Radius just created on IAM role ${roleName} was replaced before it could be confirmed. Nothing else was changed. Retry.`
      };
    }
    const delay = LOCK_VISIBLE_RETRY_DELAYS_MS[attempt];
    const retryable =
      NO_SUCH_ENTITY.test(get.stderr) || isTransientAwsFailure(get);
    if (!retryable || delay === undefined) {
      return {
        code: "aws-lock-unconfirmed",
        message: `Radius created the lock on IAM role ${roleName} but could not read it back (${detail(get)}), so it stopped before changing the role. Other runs wait for this lock until it is removed. ${recoveryCommand(policyArn, policyId)} Then retry.`
      };
    }
    await ports.sleep(delay);
  }
}

/**
 * Take the lock on one deploy identity, waiting while another run holds it.
 * With `wait: false`, answers at once with the holder instead, for a caller
 * that answers inside one request. The caller must already have confirmed the
 * CLI session is in `accountId`, so the lock is created next to the role it
 * protects.
 */
export async function acquireAwsDeployIdentityLock(
  request: {
    accountId: string;
    roleName: string;
    holder: AwsLockHolder;
    wait?: boolean;
    // The policy ID of a lock this operation took in an earlier attempt and
    // recorded. If the lock still has that ID and names this operation, it is
    // this operation's lock, so it is replaced instead of waited for. The new
    // lock's creation time is when this run took it, which is what waiting
    // runs measure the 10-minute removal age from.
    adopt?: string;
  },
  ports: AwsLockPorts
): Promise<AwsLockAcquireResult> {
  const { accountId, roleName } = request;
  const wait = request.wait !== false;
  // Without waiting, a lock released between IAM's create and read is tried
  // once more at once; a second time, IAM is not settled, and the run stops.
  let vanished = false;
  const policyArn = awsLockPolicyArn(accountId, roleName);
  // A lock whose creation time IAM did not report is timed from when this run
  // first saw it, so Remove lock is still offered eventually.
  const firstSeen = new Map<string, number>();
  // Failures a retry can fix, in a row. A wait can last many minutes, so one
  // throttled or timed-out call must not end the run.
  let transient = 0;
  // Set once this run deleted its own earlier lock to take a fresh one.
  let replaced = false;
  const backOff = async (result: AwsCommandResult) => {
    transient += 1;
    if (!wait) {
      return {
        ok: false as const,
        code: "aws-lock-unreachable",
        message: `Radius could not reach IAM to lock IAM role ${roleName} (${detail(result)}). Nothing was changed. Retry.`
      };
    }
    if (transient >= LOCK_WAIT_TRANSIENT_LIMIT) {
      return {
        ok: false as const,
        code: "aws-lock-unreachable",
        message: `Radius could not reach IAM to lock IAM role ${roleName} after ${transient} tries (${detail(result)}). Nothing was changed. Retry.`
      };
    }
    await ports.sleep(
      Math.min(AWS_LOCK_POLL_MS * 2 ** transient, LOCK_WAIT_BACKOFF_MAX_MS)
    );
    return null;
  };
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
          message: `Radius created the lock on IAM role ${roleName} but AWS did not return its ID, so it cannot tell its own lock from the next one. Nothing else was changed. Run "aws iam get-policy --policy-arn ${policyArn}" and check that its description names operation ${request.holder.operationId || "(none)"}; only then run: aws iam delete-policy --policy-arn ${policyArn}. Then retry.`
        };
      }
      const visible = await awaitLockVisible(
        policyArn,
        policyId,
        roleName,
        ports
      );
      if (visible) return { ok: false, ...visible };
      return {
        ok: true,
        lock: heldLock(
          policyArn,
          policyId,
          roleName,
          request.holder.action,
          ports
        ),
        ...(replaced ? { adopted: true as const } : {})
      };
    }
    if (ACCESS_DENIED.test(create.stderr)) {
      return {
        ok: false,
        code: "aws-lock-denied",
        message: `The signed-in AWS identity is not allowed iam:CreatePolicy, which Radius needs to lock IAM role ${roleName} so two runs cannot overwrite each other's trust policy changes. Nothing was changed. ${permissionsMessage(accountId)}`
      };
    }
    if (isTransientAwsFailure(create)) {
      const gaveUp = await backOff(create);
      if (gaveUp) return gaveUp;
      continue;
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
    if (isTransientAwsFailure(get)) {
      const gaveUp = await backOff(get);
      if (gaveUp) return gaveUp;
      continue;
    }
    // Released between the create and this read; try again after the wait.
    if (!succeeded(get) && !NO_SUCH_ENTITY.test(get.stderr)) {
      return ACCESS_DENIED.test(get.stderr) ?
          {
            ok: false,
            code: "aws-lock-denied",
            message: `Another run holds the lock on IAM role ${roleName}, and the signed-in AWS identity is not allowed to read who: ${detail(get)}. Nothing was changed. ${permissionsMessage(accountId)}`
          }
        : {
            ok: false,
            code: "aws-lock-unreadable",
            message: `Another run holds the lock on IAM role ${roleName}, and Radius could not read who: ${detail(get)}. Nothing was changed.`
          };
    }
    transient = 0;
    if (!succeeded(get) && !wait) {
      if (vanished) return { ok: false, busy: true, holder: null };
      vanished = true;
      continue;
    }
    if (succeeded(get)) {
      const policy = readPolicy(get.stdout);
      const policyId = text(policy, "PolicyId");
      const since = text(policy, "CreateDate");
      const created = Date.parse(since);
      const seen = firstSeen.get(policyId) ?? ports.now();
      firstSeen.set(policyId, seen);
      const heldFrom = isNaN(created) ? seen : created;
      const holder = parseAwsLockHolder(policy?.Description);
      const holderOperationId = holder?.operationId ?? "";
      if (
        !replaced &&
        request.adopt &&
        policyId === request.adopt &&
        holderOperationId !== "" &&
        holderOperationId === request.holder.operationId
      ) {
        // Held again as is, it would keep the earlier attempt's creation
        // time, and a waiting run could be offered Remove lock while this
        // run changes the role. So it is deleted and taken again.
        const remove = await runRetrying(ports, [
          "iam",
          "delete-policy",
          "--policy-arn",
          policyArn
        ]);
        if (!succeeded(remove) && !NO_SUCH_ENTITY.test(remove.stderr)) {
          return {
            ok: false,
            code:
              ACCESS_DENIED.test(remove.stderr) ? "aws-lock-denied" : (
                "aws-lock-failed"
              ),
            message: `Radius could not replace the lock this setup holds on IAM role ${roleName} from its earlier attempt: ${detail(remove)}. Nothing else was changed. ${awsLockRecoveryCommand(policyArn, policyId)}`
          };
        }
        replaced = true;
        continue;
      }
      const stopped =
        holderOperationId !== "" && ports.isStoppedOperation(holderOperationId);
      const current: AwsLockWait = {
        policyArn,
        policyId,
        holder: awsLockHolderLabel(holder),
        holderOperationId,
        since,
        stopped,
        removable:
          stopped || ports.now() - heldFrom >= AWS_LOCK_REMOVABLE_AFTER_MS
      };
      if (!wait) return { ok: false, busy: true, holder: current };
      await ports.waiting(current);
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
  const session = await verifyAwsCliSession({ accountId: account[1] }, runAws);
  if (!session.ok)
    return { ok: false, code: session.code, message: session.message };
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
