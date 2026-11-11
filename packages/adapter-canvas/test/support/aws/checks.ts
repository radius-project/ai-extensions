import {
  parseAwsLockHolder,
  parsePolicyDocument,
  readRecordedAwsLock,
  trustedGitHubSubjects
} from "@radius-project/core";
import {
  operations,
  readSetupArtifactLedger,
  unresolvedProviderMutations
} from "../../../src/operations.js";
import {
  ACCOUNT,
  CLUSTER,
  ENVIRONMENT,
  REGION,
  ROLE,
  ROLE_ARN,
  type AwsScenario
} from "./scenarios.js";
import { argument, type OutsideCall, type StopKind } from "./stop-points.js";

// The rules every stop point is held to. Each check returns the ways the
// restored records break its rule, so a failing test names them all.

/** What the setup under test could change, read before it starts. */
export interface Ownership {
  readonly trust: ReadonlySet<string>;
  readonly inline: ReadonlySet<string>;
  readonly entry: boolean;
  readonly variables: ReadonlySet<string>;
}

function roleTrust(scenario: AwsScenario): string[] {
  const role = scenario.aws.role(ROLE);
  return role ?
      trustedGitHubSubjects(
        parsePolicyDocument(role.AssumeRolePolicyDocument),
        ACCOUNT
      )
    : [];
}

function accessEntry(scenario: AwsScenario) {
  return scenario.aws.clusters
    .get(`${REGION}:${CLUSTER}`)
    ?.entries.get(ROLE_ARN);
}

export function readOwnership(scenario: AwsScenario): Ownership {
  return {
    trust: new Set(roleTrust(scenario)),
    inline: new Set(scenario.aws.role(ROLE)?.inline.keys() ?? []),
    entry: accessEntry(scenario) !== undefined,
    variables: new Set(
      scenario.github.environment(ENVIRONMENT)?.variables.keys() ?? []
    )
  };
}

function restored(operationId: string) {
  const record = operations.get(operationId);
  if (!record) throw new Error(`No restored record for ${operationId}`);
  return record;
}

/**
 * What the setup changed in AWS or GitHub that the restored record names
 * neither as a ledger entry nor as an unsettled write. Either one lets the
 * next run find it; a change with neither is lost.
 */
export function unsavedSetupChanges(
  scenario: AwsScenario,
  operationId: string,
  before: Ownership
): string[] {
  const record = restored(operationId);
  const ledger = readSetupArtifactLedger(record.setupArtifacts);
  const pending = unresolvedProviderMutations(record);
  const unsettled = (kind: string, target = "") =>
    pending.some(
      (mutation) => mutation.kind === kind && mutation.target.endsWith(target)
    );
  const lost: string[] = [];
  const role = scenario.aws.role(ROLE);
  const createdRole =
    role?.Tags.some(
      (tag) => tag.Key === "radius-operation" && tag.Value === operationId
    ) ?? false;
  if (
    role &&
    createdRole &&
    !(
      ledger.awsRole.state === "created" &&
      ledger.awsRole.roleId === role.RoleId
    ) &&
    !unsettled("aws_role.create")
  ) {
    lost.push(`IAM role ${ROLE} (${role.RoleId})`);
  }
  for (const subject of roleTrust(scenario)) {
    if (before.trust.has(subject)) continue;
    const saved = ledger.awsTrustSubjects.some(
      (item) => item.subject === subject && item.state === "created"
    );
    if (
      !saved &&
      !unsettled("aws_role.create") &&
      !unsettled("aws_trust.add")
    ) {
      lost.push(`trust subject ${subject}`);
    }
  }
  for (const name of role?.inline.keys() ?? []) {
    if (before.inline.has(name)) continue;
    const saved = ledger.awsRolePolicies.some(
      (item) => item.policyName === name && item.state === "created"
    );
    if (!saved && !unsettled("aws_role_policy.put", `#${name}`)) {
      lost.push(`policy ${name}`);
    }
  }
  const entry = accessEntry(scenario);
  if (
    !before.entry &&
    entry?.tags["radius-operation"] === operationId &&
    !ledger.awsAccessEntries.some((item) => item.state === "created") &&
    !unsettled("aws_access_entry.create")
  ) {
    lost.push(`access entry for ${ROLE} on ${CLUSTER}`);
  }
  const variables =
    scenario.github.environment(ENVIRONMENT)?.variables.keys() ?? [];
  for (const name of variables) {
    if (before.variables.has(name)) continue;
    const saved = ledger.githubEnvironmentVariables.some(
      (item) => item.name === name && item.state === "created"
    );
    if (!saved && !unsettled("github_environment_variable.put", `:${name}`)) {
      lost.push(`GitHub variable ${name}`);
    }
  }
  return lost;
}

// The ledger entry a rollback's delete call removes, if it is one.
function deletedArtifact(
  call: OutsideCall,
  ledger: ReturnType<typeof readSetupArtifactLedger>
): { label: string; state: string } | null {
  switch (call.command) {
    case "iam delete-role-policy": {
      const name = argument(call, "--policy-name");
      const item = ledger.awsRolePolicies.find(
        (entry) => entry.policyName === name
      );
      return item ? { label: `policy ${name}`, state: item.state } : null;
    }
    case "eks delete-access-entry": {
      const item = ledger.awsAccessEntries[0];
      return item ? { label: "access entry", state: item.state } : null;
    }
    case "iam delete-role":
      return { label: `IAM role ${ROLE}`, state: ledger.awsRole.state };
    default:
      return null;
  }
}

/**
 * Deletions AWS answered from call `from` on that the restored record still
 * lists as created. A trust change counts once IAM showed it, which is when
 * the rollback treats it as done.
 */
export function unsavedRollbackResults(
  scenario: AwsScenario,
  operationId: string,
  from: number
): string[] {
  const ledger = readSetupArtifactLedger(restored(operationId).setupArtifacts);
  const answered = scenario.outside.calls.filter(
    (call) => call.index >= from && call.answered && call.succeeded
  );
  const lost: string[] = [];
  for (const call of answered) {
    const artifact = deletedArtifact(call, ledger);
    if (artifact?.state === "created") lost.push(artifact.label);
    const shown =
      call.command === "iam update-assume-role-policy" &&
      answered.some(
        (later) => later.index > call.index && later.command === "iam get-role"
      );
    if (!shown) continue;
    const trusted = roleTrust(scenario);
    for (const item of ledger.awsTrustSubjects) {
      if (item.state === "created" && !trusted.includes(item.subject)) {
        lost.push(`trust subject ${item.subject}`);
      }
    }
  }
  return [...new Set(lost)];
}

/**
 * Locks in IAM that no restored record names. One is allowed only in the
 * window between its `create-policy` and the save that records it, after a
 * crash: it must name `operationId`, so the next run of that operation finds
 * it left by a stopped attempt and offers Remove lock.
 */
export function lostLocks(
  scenario: AwsScenario,
  operationId: string,
  kind: StopKind,
  savesAtCrash: number
): string[] {
  const recorded = new Set(
    operations
      .all()
      .map(
        (record: { context?: unknown }) =>
          readRecordedAwsLock(record.context)?.policyId
      )
      .filter(Boolean)
  );
  const lost: string[] = [];
  for (const lock of scenario.aws.locks()) {
    if (recorded.has(lock.PolicyId)) continue;
    const created = scenario.outside.calls.find(
      (call) =>
        call.command === "iam create-policy" &&
        call.applied &&
        call.stdout.includes(lock.PolicyId)
    );
    const holder = parseAwsLockHolder(lock.Description);
    const inWindow =
      kind !== "stop" &&
      created !== undefined &&
      created.savesBefore === savesAtCrash &&
      holder?.operationId === operationId;
    if (!inWindow) {
      lost.push(
        `${lock.PolicyName} (${lock.PolicyId}) held by ${holder?.action ?? "?"} ${holder?.operationId || "(no operation)"}`
      );
    }
  }
  return lost;
}

/** Calls a crashed process sent, which a real crash makes impossible. */
export function callsAfterCrash(scenario: AwsScenario): string[] {
  return scenario.outside.calls
    .filter((call) => call.afterCrash)
    .map((call) => `${call.index}: ${call.command}`);
}
