import {
  awsAppRolesPolicyRepositoryId,
  trustedGitHubSubjects,
  parsePolicyDocument
} from "@radius-project/core";
import {
  getOperationControl,
  type OperationControlRecord,
  recordAwsAccessEntry,
  recordAwsAppBoundary,
  recordAwsRole,
  recordAwsRolePolicy,
  recordAwsTrustSubject,
  settleProviderMutation,
  unresolvedProviderMutations
} from "../../operations.js";
import { verifyAwsCliSession } from "./aws-cli-session.js";
import {
  AWS_OPERATION_TAG,
  type AwsCommandResult,
  type AwsSetupChange
} from "./aws-deploy-identity.js";
import {
  executeRecoverableMutation,
  ProviderMutationRecoveryError,
  type ProviderMutationReconciliation
} from "./provider-mutation-recovery.js";

// Records each AWS change setup makes in the operation's provider journal and
// setup ledger. A write is journaled before it is sent, so a run that stops
// before the answer arrives leaves a record that the next run settles by
// reading AWS, never by sending the write again.

export const AWS_SETUP_MUTATION_KINDS: readonly AwsSetupChange["kind"][] = [
  "aws_role.create",
  "aws_trust.add",
  "aws_role_policy.put",
  "aws_app_boundary.create",
  "aws_access_entry.create"
];

type Intent = Record<string, string | number | boolean | null>;

export interface AwsSetupJournalOperation {
  operationId: string;
}

export interface AwsSetupJournalDependencies {
  runAws(args: string[]): Promise<AwsCommandResult>;
  persist(): Promise<void>;
  now(): number;
}

export interface AwsSetupWriteSender {
  // Run a read the way setup runs it, so a pause stops it too.
  read(args: string[]): Promise<AwsCommandResult>;
  // A refusal to send this write, such as a pause or a lost lock, or null.
  guard(args: string[]): Promise<AwsCommandResult | null>;
  run(args: string[]): Promise<AwsCommandResult>;
}

export interface AwsSetupJournal<Operation> {
  /**
   * Settle every AWS write an earlier run of this operation sent without an
   * answer. True when one was settled.
   */
  reconcile(operation: Operation): Promise<boolean>;
  write(
    operation: Operation,
    change: AwsSetupChange,
    args: string[],
    sender: AwsSetupWriteSender
  ): Promise<AwsCommandResult>;
}

// Thrown when a write was refused before it was sent, so the journal records
// it as not applied without reading AWS.
class WriteNotSent extends Error {}

/**
 * The AWS CLI session failed before the journal could read AWS, such as an
 * expired sign-in. It says nothing about the change, so it costs the change no
 * reconciliation attempt: the caller reports it and tries again once the
 * person signs in.
 */
export class AwsSessionUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AwsSessionUnavailableError";
    this.code = code;
  }
}

const isSessionUnavailable = (error: unknown): boolean =>
  error instanceof AwsSessionUnavailableError;

// The AWS CLI retries a call after a 5xx reply or a dropped connection by
// default. A create that landed the first time is then refused as already
// there, by this very request. The operation tag on what is there tells.
const CREATED_BY_A_RETRY: Partial<Record<AwsSetupChange["kind"], RegExp>> = {
  "aws_role.create": /\(EntityAlreadyExists\)/,
  "aws_app_boundary.create": /\(EntityAlreadyExists\)/,
  "aws_access_entry.create": /\(ResourceInUseException\)/
};

// The AWS CLI exits 254 when the service answered the request with an error.
// The journal reads any exit of 128 or more as a killed process, so the
// answer is passed on with an ordinary failure code.
function serviceAnswer(result: AwsCommandResult): AwsCommandResult {
  return result.code === 254 || result.code === "254" ?
      { ...result, code: 1 }
    : result;
}

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function detail(result: AwsCommandResult): string {
  return (result.stderr || result.stdout || "").trim() || "no output";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      Object.fromEntries(Object.entries(value))
    : {};
}

function parse(stdout: string): Record<string, unknown> {
  try {
    return record(JSON.parse(stdout || "null"));
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Scoped to the setup attempt, so a later attempt that has to write the same
// thing again is a new journal entry rather than a reread of a settled one.
export function awsSetupChangeTarget(
  change: AwsSetupChange,
  attempt: number
): string {
  const scope = `attempt-${attempt}`;
  switch (change.kind) {
    case "aws_role.create":
      return `${scope}|${change.roleArn}`;
    case "aws_trust.add":
      return `${scope}|${change.roleArn}#trust`;
    case "aws_role_policy.put":
      return `${scope}|${change.roleArn}#${change.policyName}`;
    case "aws_app_boundary.create":
      return `${scope}|${change.policyArn}`;
    case "aws_access_entry.create":
      return `${scope}|${change.region}:${change.cluster}:${change.roleArn}`;
  }
}

/** What the journal saves, so a later run can read AWS for this change. */
export function awsSetupChangeIntent(
  change: AwsSetupChange,
  requestedAt: string
): Intent {
  const base = {
    requestedAt,
    accountId: change.accountId,
    roleArn: change.roleArn,
    roleName: change.roleName
  };
  switch (change.kind) {
    case "aws_role.create":
      return { ...base, subjects: JSON.stringify(change.subjects) };
    case "aws_trust.add":
      return {
        ...base,
        roleId: change.roleId,
        subjects: JSON.stringify(change.subjects)
      };
    case "aws_role_policy.put":
      return { ...base, roleId: change.roleId, policyName: change.policyName };
    case "aws_app_boundary.create":
      return { ...base, roleId: change.roleId, policyArn: change.policyArn };
    case "aws_access_entry.create":
      return {
        ...base,
        roleId: change.roleId,
        cluster: change.cluster,
        region: change.region
      };
  }
}

function stringList(value: unknown): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text(value));
    return (
        Array.isArray(parsed) &&
          parsed.every((entry) => typeof entry === "string" && entry)
      ) ?
        parsed
      : null;
  } catch {
    return null;
  }
}

/** The change a saved intent describes, or null when it is incomplete. */
export function awsSetupChangeFromIntent(
  kind: string,
  intent: Intent | undefined
): AwsSetupChange | null {
  const accountId = text(intent?.accountId);
  const roleArn = text(intent?.roleArn);
  const roleName = text(intent?.roleName);
  if (!accountId || !roleArn || !roleName) return null;
  const base = { accountId, roleArn, roleName };
  // Optional: a missing id is kept, and a rollback refuses the entry.
  const roleId = text(intent?.roleId) || null;
  switch (kind) {
    case "aws_role.create": {
      const subjects = stringList(intent?.subjects);
      return subjects ? { kind, ...base, subjects } : null;
    }
    case "aws_trust.add": {
      const subjects = stringList(intent?.subjects);
      return subjects ? { kind, ...base, roleId, subjects } : null;
    }
    case "aws_role_policy.put": {
      const policyName = text(intent?.policyName);
      return policyName ? { kind, ...base, roleId, policyName } : null;
    }
    case "aws_app_boundary.create": {
      const policyArn = text(intent?.policyArn);
      return policyArn ? { kind, ...base, roleId, policyArn } : null;
    }
    case "aws_access_entry.create": {
      const cluster = text(intent?.cluster);
      const region = text(intent?.region);
      return cluster && region ?
          { kind, ...base, roleId, cluster, region }
        : null;
    }
    default:
      return null;
  }
}

// IAM lists a role's or policy's tags as Key and Value pairs.
function tagValue(resource: Record<string, unknown>, key: string): string {
  const tags = Array.isArray(resource.Tags) ? resource.Tags : [];
  for (const tag of tags) {
    const entry = record(tag);
    if (entry.Key === key) return text(entry.Value);
  }
  return "";
}

/**
 * Read AWS to learn whether `change` happened. A role, boundary policy, or
 * access entry is this request's only when it carries `operationId` in its
 * operation tag, which nothing else writes. A read that fails throws, so the journal keeps the
 * outcome unknown instead of guessing.
 */
export async function reconcileAwsSetupChange(
  change: AwsSetupChange,
  operationId: string,
  runAws: (args: string[]) => Promise<AwsCommandResult>
): Promise<ProviderMutationReconciliation<string>> {
  // IAM names roles per account, so a read in another account would report
  // the role as missing.
  const session = await verifyAwsCliSession(
    { accountId: change.accountId },
    runAws
  );
  if (!session.ok) {
    throw new AwsSessionUnavailableError(session.code, session.message);
  }
  if (change.kind === "aws_access_entry.create") {
    const read = await runAws([
      "eks",
      "describe-access-entry",
      "--cluster-name",
      change.cluster,
      "--principal-arn",
      change.roleArn,
      "--region",
      change.region,
      "--output",
      "json"
    ]);
    if (!succeeded(read)) {
      if (/ResourceNotFoundException/.test(read.stderr)) {
        return { state: "not_applied", evidence: "EKS has no such entry." };
      }
      throw new Error(`Could not read the access entry: ${detail(read)}`);
    }
    const entry = record(parse(read.stdout).accessEntry);
    return record(entry.tags)[AWS_OPERATION_TAG] === operationId ?
        { state: "applied", value: read.stdout }
      : {
          state: "not_applied",
          evidence:
            "The access entry does not carry this setup's operation tag, so another request created it."
        };
  }
  if (change.kind === "aws_role_policy.put") {
    const read = await runAws([
      "iam",
      "get-role-policy",
      "--role-name",
      change.roleName,
      "--policy-name",
      change.policyName,
      "--output",
      "json"
    ]);
    if (!succeeded(read)) {
      if (/NoSuchEntity/.test(read.stderr)) {
        return { state: "not_applied", evidence: "IAM has no such policy." };
      }
      throw new Error(`Could not read the policy: ${detail(read)}`);
    }
    return { state: "applied", value: "" };
  }
  if (change.kind === "aws_app_boundary.create") {
    const read = await runAws([
      "iam",
      "get-policy",
      "--policy-arn",
      change.policyArn,
      "--output",
      "json"
    ]);
    if (!succeeded(read)) {
      if (/NoSuchEntity/.test(read.stderr)) {
        return { state: "not_applied", evidence: "IAM has no such policy." };
      }
      throw new Error(`Could not read the policy: ${detail(read)}`);
    }
    const policy = record(parse(read.stdout).Policy);
    return tagValue(policy, AWS_OPERATION_TAG) === operationId ?
        {
          state: "applied",
          value: read.stdout,
          providerId: text(policy.PolicyId) || null
        }
      : {
          state: "not_applied",
          evidence:
            "The policy does not carry this setup's operation tag, so another request created it."
        };
  }
  const read = await runAws([
    "iam",
    "get-role",
    "--role-name",
    change.roleName,
    "--output",
    "json"
  ]);
  if (!succeeded(read)) {
    if (/NoSuchEntity/.test(read.stderr)) {
      return { state: "not_applied", evidence: "IAM has no such role." };
    }
    throw new Error(`Could not read the role: ${detail(read)}`);
  }
  const role = record(parse(read.stdout).Role);
  if (change.kind === "aws_role.create") {
    return tagValue(role, AWS_OPERATION_TAG) === operationId ?
        {
          state: "applied",
          value: read.stdout,
          providerId: text(role.RoleId) || null
        }
      : {
          state: "not_applied",
          evidence:
            "The role does not carry this setup's operation tag, so another request created it."
        };
  }
  const trusted = trustedGitHubSubjects(
    parsePolicyDocument(role.AssumeRolePolicyDocument),
    change.accountId
  );
  return change.subjects.every((subject) => trusted.includes(subject)) ?
      { state: "applied", value: "" }
    : {
        state: "not_applied",
        evidence: "The role does not trust every subject this setup added."
      };
}

/** Add what one confirmed change created to the setup ledger. */
export function recordAwsSetupChange(
  operation: object,
  change: AwsSetupChange,
  stdout: string
): void {
  const { roleArn, roleName } = change;
  switch (change.kind) {
    case "aws_role.create": {
      const roleId = text(record(parse(stdout).Role).RoleId) || null;
      recordAwsRole(operation, {
        state: "created",
        origin: "this_operation",
        // The ARN the trust subjects below use, so a rollback finds them all
        // under one role.
        roleArn,
        roleName,
        roleId
      });
      for (const subject of change.subjects) {
        recordAwsTrustSubject(operation, {
          roleArn,
          roleName,
          roleId,
          subject
        });
      }
      return;
    }
    case "aws_trust.add":
      for (const subject of change.subjects) {
        recordAwsTrustSubject(operation, {
          roleArn,
          roleName,
          roleId: change.roleId,
          subject
        });
      }
      return;
    case "aws_role_policy.put":
      recordAwsRolePolicy(operation, {
        roleArn,
        roleName,
        roleId: change.roleId,
        policyName: change.policyName
      });
      return;
    case "aws_app_boundary.create":
      recordAwsAppBoundary(operation, {
        roleArn,
        roleName,
        roleId: change.roleId,
        policyArn: change.policyArn,
        policyId: text(record(parse(stdout).Policy).PolicyId) || null
      });
      return;
    case "aws_access_entry.create":
      recordAwsAccessEntry(operation, {
        roleArn,
        roleId: change.roleId,
        roleName,
        cluster: change.cluster,
        region: change.region
      });
  }
}

export function createAwsSetupJournal<
  Operation extends AwsSetupJournalOperation
>(dependencies: AwsSetupJournalDependencies): AwsSetupJournal<Operation> {
  const attemptOf = (operation: Operation): number =>
    // An operation always has a control record, created on first read.
    (getOperationControl(operation) as OperationControlRecord).attempts.setup;

  async function journaled(
    operation: Operation,
    change: AwsSetupChange,
    args: string[],
    sender: AwsSetupWriteSender
  ): Promise<AwsCommandResult> {
    const requestedAt = new Date(dependencies.now()).toISOString();
    let refused: AwsCommandResult | null = null;
    const alreadyThere = CREATED_BY_A_RETRY[change.kind];
    // The answer AWS gave, kept so setup reads its own "already exists" when
    // the tag shows another request made what is there.
    const answered: { result: AwsCommandResult | null } = { result: null };
    try {
      const outcome = await executeRecoverableMutation({
        operation,
        kind: change.kind,
        target: awsSetupChangeTarget(change, attemptOf(operation)),
        intent: awsSetupChangeIntent(change, requestedAt),
        persist: dependencies.persist,
        rethrowReconciliationError: isSessionUnavailable,
        validateBeforeMutation: async () => {
          refused = await sender.guard(args);
          if (refused) throw new WriteNotSent();
        },
        mutate: async () => {
          answered.result = serviceAnswer(await sender.run(args));
          return answered.result;
        },
        ...(alreadyThere ?
          {
            ambiguousRejection: (result) =>
              alreadyThere.test(String(result.stderr))
          }
        : {}),
        accept: (result) => result.stdout,
        providerIdOf: (result) =>
          change.kind === "aws_role.create" ?
            text(record(parse(result.stdout).Role).RoleId) || null
          : change.kind === "aws_app_boundary.create" ?
            text(record(parse(result.stdout).Policy).PolicyId) || null
          : null,
        createdByOperation: () => true,
        acceptedEvidence: () => "AWS accepted the change.",
        reconcile: () =>
          reconcileAwsSetupChange(
            change,
            operation.operationId,
            dependencies.runAws
          ),
        onConfirmed: (stdout) => recordAwsSetupChange(operation, change, stdout)
      });
      if (outcome.state === "applied") {
        return { code: 0, stdout: outcome.value, stderr: "" };
      }
      const sent = answered.result;
      if (sent && alreadyThere?.test(sent.stderr)) return sent;
      return (
        outcome.result ?? {
          code: 1,
          stdout: "",
          stderr:
            outcome.diagnostic ||
            "AWS did not make the change, so Radius stopped."
        }
      );
    } catch (error) {
      if (error instanceof WriteNotSent && refused) return refused;
      throw error;
    }
  }

  return {
    async reconcile(operation) {
      const unresolved = unresolvedProviderMutations(
        operation,
        AWS_SETUP_MUTATION_KINDS
      );
      for (const mutation of unresolved) {
        const change = awsSetupChangeFromIntent(mutation.kind, mutation.intent);
        if (!change) {
          const guidance = `Radius did not save enough about ${mutation.kind} for ${mutation.target} to check it in AWS. Review the deploy identity in the IAM console, then delete this setup.`;
          settleProviderMutation(
            operation,
            mutation.mutationId,
            "manual_required",
            guidance
          );
          await dependencies.persist();
          throw new ProviderMutationRecoveryError(
            guidance,
            "provider-mutation-manual-required"
          );
        }
        await executeRecoverableMutation({
          operation,
          kind: mutation.kind,
          target: mutation.target,
          persist: dependencies.persist,
          rethrowReconciliationError: isSessionUnavailable,
          mutate: () => {
            throw new Error("A reconciled AWS change is never sent again.");
          },
          accept: (result) => result.stdout,
          reconcile: () =>
            reconcileAwsSetupChange(
              change,
              operation.operationId,
              dependencies.runAws
            ),
          onConfirmed: (stdout) =>
            recordAwsSetupChange(operation, change, stdout)
        });
      }
      return unresolved.length > 0;
    },

    async write(operation, change, args, sender) {
      // A repository's app-roles policy is shared by its environments, and
      // rollback removes it only once none of them uses it. So it is always
      // this setup's to remove, even when the role already had it.
      if (
        change.kind !== "aws_role_policy.put" ||
        awsAppRolesPolicyRepositoryId(change.policyName) !== null
      ) {
        return journaled(operation, change, args, sender);
      }
      // `put-role-policy` replaces a policy that already exists, so only an
      // environment policy the role did not have is this setup's to remove.
      const existing = await sender.read([
        "iam",
        "get-role-policy",
        "--role-name",
        change.roleName,
        "--policy-name",
        change.policyName,
        "--output",
        "json"
      ]);
      if (succeeded(existing)) {
        const refused = await sender.guard(args);
        return refused ?? sender.run(args);
      }
      if (!/NoSuchEntity/.test(existing.stderr)) {
        return {
          code: 1,
          stdout: "",
          stderr: `Could not check whether IAM role ${change.roleName} already has policy ${change.policyName}: ${detail(existing)}`
        };
      }
      return journaled(operation, change, args, sender);
    }
  };
}
