import {
  AWS_TRUST_SUBJECTS_VARIABLE,
  namesRepositoryEnvironment,
  repositoryLessSubjectMessage,
  subjectNamesRepository,
  type GitHubRepositoryIdentity,
  type OidcSubjectConfig,
  buildEnvironmentSuffix,
  AWS_PERMISSION_POLICY_NAME_VARIABLE,
  awsLockPolicyArn,
  awsRoleArn,
  isAwsEnvironmentPolicyName,
  formatAwsLockTime,
  readRecordedAwsLock,
  assertSetupExecutionActive,
  isSetupExecutionInterrupted,
  type AwsLockAction
} from "@radius-project/core";
import { defaultAwsDeployRoleName } from "../../aws-deploy-role-name.js";
import {
  resolveOidcSubject,
  parseServedReposFromSubjects,
  type GitHubJsonResponse,
  type ResolveOidcSubjectResult
} from "../../azure-oidc.js";
import type { SelectedGhExecutor } from "../../gh.js";
import {
  loadEnvironmentClaims,
  type NamespaceClaimsPorts
} from "../routes/create-environment-namespace-claims.js";
import {
  removeAwsEnvironmentFromRole,
  repairAwsEnvironmentTrust,
  rollbackAwsSetupChanges,
  setupAwsDeployIdentity,
  type AwsCommandResult,
  type AwsDeployIdentityPorts,
  type AwsDeployIdentityRemovalResult,
  type AwsEnvironmentListing,
  type AwsLockResult,
  type AwsRepositoryIdLookup,
  type AwsSetupRollbackOutcome,
  type AwsSetupRollbackTarget,
  type AwsTrustRepairResult
} from "./aws-deploy-identity.js";
import { parseTrustSubjects } from "./environment-target.js";
import {
  acquireAwsDeployIdentityLock,
  isAwsWrite,
  awsLockRecoveryCommand,
  type AwsDeployIdentityLock,
  type AwsLockLoss,
  type AwsLockReleaseResult,
  type AwsLockWait
} from "./aws-deploy-identity-lock.js";
import {
  AwsSessionUnavailableError,
  type AwsSetupJournal
} from "./aws-setup-journal.js";

// Connects the AWS deploy identity to an environment operation: it resolves the
// GitHub OIDC subjects the environment's workflows may present, reports
// progress on the operation, and turns a failure into the answer the setup
// workflow shows.

export interface AwsEnvironmentAccessDependencies<Operation> {
  // Run `aws <args>`. Never throws; a spawn failure is a non-zero result.
  runAws(args: string[]): Promise<AwsCommandResult>;
  runGitHubJson(
    apiPath: string,
    executor?: SelectedGhExecutor
  ): Promise<GitHubJsonResponse>;
  // Reads the repository's GitHub environments, so delete can tell which
  // clusters they still use.
  environments: NamespaceClaimsPorts;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  // Whether the customer asked to pause this operation.
  isStopRequested(operation: Operation): boolean;
  // Whether `operationId` names an operation in this store that has stopped,
  // so a lock it holds is left from an earlier attempt.
  isStoppedOperation(operationId: string): boolean;
  operationId(operation: Operation): string;
  operations: {
    getContext(operation: Operation): Record<string, unknown>;
    enterStage(operation: Operation, stage: string): void;
    // Record a stage's verdict, which settling the operation keeps.
    setStageState(operation: Operation, stage: string, state: string): void;
    addLegacyStep(operation: Operation, text: string, stage: string): void;
    setContext(operation: Operation, patch: Record<string, unknown>): void;
    // Record activity without a step, so a long wait is not taken as stale.
    touch(operation: Operation): void;
  };
  // Saves every operation durably.
  store: { persist(): Promise<void> };
  // Records each AWS change setup makes, so it can be listed and rolled back.
  // Without it setup records nothing.
  journal?: AwsSetupJournal<Operation>;
  stageAuthorizeIdentity: string;
  errorMessage(error: unknown): string;
}

export type AwsEnvironmentSetupResult =
  | {
      ok: true;
      roleArn: string;
      subjects: readonly string[];
      policyName: string;
    }
  | { ok: false; status: number; error: string; code: string }
  // A pause was requested. Every AWS change made before it is recorded on the
  // operation; the caller honors the pause at its next boundary.
  | { ok: false; stopped: true };

// What a refused command answers. Setup treats it as a failure and stops before
// any later command, so nothing after the pause is written.
const PAUSED: AwsCommandResult = {
  code: 1,
  stdout: "",
  stderr: "Radius did not run this AWS command because setup was paused."
};

export interface AwsEnvironmentAccess<Operation> {
  // `Authorize deploy identity` for an AWS environment.
  setup(
    operation: Operation,
    input: Record<string, unknown>,
    executor: SelectedGhExecutor
  ): Promise<AwsEnvironmentSetupResult>;
  // Release the lock `setup` took. Setup holds it until Configure environment
  // has written the GitHub environment, so the coordinator calls this once
  // both are done. Never throws; a lock left behind is reported as a step.
  release(operation: Operation): Promise<void>;
  // Remove what one environment added to the shared deploy role, under the
  // deploy identity lock. It removes `trustSubjects`, the subjects setup
  // recorded, and the subjects GitHub resolves for the environment now.
  remove(input: {
    repo: string;
    environment: string;
    roleArn: string;
    trustSubjects?: readonly string[];
    // The environment's cluster. Empty when it did not record one.
    region: string;
    cluster: string;
    policyName?: string;
    operationId?: string;
    // Called on every poll while another run holds the lock, with a progress
    // line when there is something new to say.
    waiting?(wait: AwsLockWait, line: string | null): void | Promise<void>;
    // Runs after a successful removal and before the lock is released, once
    // the lock is confirmed still held. Delete retires the GitHub environment
    // here: Repair reads that environment under the same lock, so it can't
    // add the subjects back between the two steps.
    whileLocked?(
      removal: Extract<AwsDeployIdentityRemovalResult, { ok: true }>
    ): Promise<void>;
  }): Promise<AwsEnvironmentRemovalResult>;
  // Undo the AWS changes a setup recorded on one role, under the deploy
  // identity lock. Does not wait for a lock another run holds: every target
  // then reports that, and Retry deletion tries again.
  rollback(input: {
    repo: string;
    environment: string;
    operationId: string;
    roleArn: string;
    targets: readonly AwsSetupRollbackTarget[];
    // The policy ID of the lock this setup still records, to take back.
    adopt?: string;
    // True once the execution running this rollback has ended. Checked before
    // every AWS command; the lock is still released.
    isStopped?(): boolean;
    // Called with the lock once it is held and before the first change, so the
    // operation can record it in case the release never happens.
    onLocked?(lock: { policyArn: string; policyId: string }): Promise<void>;
  }): Promise<{
    outcomes: AwsSetupRollbackOutcome[];
    // Sentences about the lock, such as one that could not be released.
    warnings: string[];
    // Whether the lock this rollback took is gone.
    released: boolean;
    // The run ended part way. `outcomes` holds each change that finished.
    interrupted?: true;
  }>;
  // Add back the subjects GitHub presents for this environment's deploys but
  // the role no longer trusts, under the deploy identity lock. Does not wait
  // for a lock another run holds.
  repair(input: {
    repo: string;
    environment: string;
    roleArn: string;
    policyName?: string;
    // Run once the lock is held, before any write: null when the environment
    // still names `roleArn`, otherwise why Repair must stop.
    confirmTarget(): Promise<{ code: string; message: string } | null>;
  }): Promise<AwsEnvironmentRepairResult>;
}

export type AwsEnvironmentRepairResult =
  | (Extract<AwsTrustRepairResult, { ok: true }> & {
      // Set when the repair finished but the lock could not be released.
      readonly lockWarning?: string;
    })
  | Extract<AwsTrustRepairResult, { ok: false }>;

interface AwsRoleChangePorts extends Pick<
  AwsDeployIdentityPorts,
  "runAws" | "acquireLock" | "sleep"
> {
  // Whether this run still holds the lock it took. False records the loss, so
  // the caller reports it as it would a lost lock before a write.
  stillLocked(): Promise<boolean>;
}

// Another run holds the role's lock, and this run does not wait for it.
function lockBusy(
  roleName: string,
  wait: AwsLockWait | null
): { ok: false; code: string; message: string } {
  if (!wait) {
    return {
      ok: false,
      code: "aws-lock-busy",
      message: `IAM reports a lock on IAM role ${roleName} but could not say who holds it, so Radius changed nothing. Try again in a moment.`
    };
  }
  return {
    ok: false,
    code: "aws-lock-busy",
    message:
      `${lockHolder(wait)} is changing IAM role ${roleName} (it has held the role's lock since ${formatAwsLockTime(wait.since)}), so Radius changed nothing. Try again once it finishes.` +
      (wait.removable ?
        ` If that run has stopped, check that "aws iam get-policy --policy-arn ${wait.policyArn} --query Policy.PolicyId --output text" prints ${wait.policyId}, the lock shown here, and only then run: aws iam delete-policy --policy-arn ${wait.policyArn}`
      : "")
  };
}

export type AwsEnvironmentRemovalResult =
  | (Extract<AwsDeployIdentityRemovalResult, { ok: true }> & {
      // Set when the removal finished but the lock could not be released.
      readonly lockWarning?: string;
    })
  | Extract<AwsDeployIdentityRemovalResult, { ok: false }>;

// A write the lock check refused. Setup and delete treat it as a failure and
// stop before any later command.
function lockLostResult(reason: string): AwsCommandResult {
  return { code: 1, stdout: "", stderr: reason };
}

// Names the holder by operation too, so a person can find that run, or see it
// is their own earlier attempt.
function lockHolder(wait: AwsLockWait): string {
  return wait.holderOperationId ?
      `${wait.holder} (operation ${wait.holderOperationId})`
    : wait.holder;
}

// The progress line for one lock another run holds.
function lockWaitLine(roleName: string, wait: AwsLockWait): string {
  if (wait.stopped) {
    return `⏳ The lock on IAM role ${roleName} is from an earlier attempt that stopped: ${lockHolder(wait)}, which took it at ${formatAwsLockTime(wait.since)}. Use Remove lock to continue.`;
  }
  return wait.removable ?
      `⏳ The lock on IAM role ${roleName} is 10 or more minutes old. ${lockHolder(wait)} has held it since ${formatAwsLockTime(wait.since)}. If that run has stopped, use Remove lock.`
    : `⏳ Waiting for the lock on IAM role ${roleName}. ${lockHolder(wait)} has held it since ${formatAwsLockTime(wait.since)}.`;
}

// What a lost lock means for this run. Before any write nothing changed; after
// one, the changes it made may since have been changed again by the run that
// took the lock.
function lockLostMessage(
  loss: AwsLockLoss,
  changes: readonly string[]
): string {
  return changes.length === 0 ?
      `${loss.reason}, so Radius stopped before changing the role.`
    : `${loss.reason}, so Radius stopped. Before it stopped, this run made these AWS changes: ${changes.join(", ")}. Another run may have changed them since, so check the role before you retry.`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createAwsEnvironmentAccess<Operation>(
  dependencies: AwsEnvironmentAccessDependencies<Operation>
): AwsEnvironmentAccess<Operation> {
  const { operations, stageAuthorizeIdentity: stage, journal } = dependencies;
  // Locks setup took and still holds, until the coordinator releases them.
  const held = new Map<Operation, AwsDeployIdentityLock>();

  // Take the lock on `roleName` in the role's account. `waiting` hears every
  // poll, with a progress line for each new holder and again once it becomes
  // removable.
  async function lock(
    request: {
      accountId: string;
      roleName: string;
      repo: string;
      environment: string;
      action: AwsLockAction;
      operationId: string;
      // The policy ID of the lock this operation recorded earlier.
      adopt?: string;
    },
    shouldStop: () => boolean,
    // Null: do not wait for another run's lock; refuse, naming the holder.
    waiting: ((wait: AwsLockWait, line: string | null) => Promise<void>) | null
  ): Promise<
    | { ok: true; lock: AwsDeployIdentityLock; adopted?: true }
    | { ok: false; code: string; message: string }
  > {
    const announced = new Set<string>();
    const result = await acquireAwsDeployIdentityLock(
      {
        accountId: request.accountId,
        roleName: request.roleName,
        holder: {
          repo: request.repo,
          environment: request.environment,
          action: request.action,
          operationId: request.operationId
        },
        wait: waiting !== null,
        ...(request.adopt ? { adopt: request.adopt } : {})
      },
      {
        runAws: dependencies.runAws,
        sleep: dependencies.sleep,
        now: dependencies.now,
        shouldStop,
        // A lock naming this operation that it cannot take back was left by
        // an earlier attempt of it, which therefore stopped.
        isStoppedOperation: (operationId) =>
          operationId === request.operationId ||
          dependencies.isStoppedOperation(operationId),
        waiting: async (wait) => {
          const key = `${wait.policyId}:${wait.stopped}:${wait.removable}`;
          let line: string | null = null;
          if (!announced.has(key)) {
            announced.add(key);
            // Not a warning: the wait is normal, and a warning step would
            // outlive it and mark a setup that then succeeds as warned.
            line = lockWaitLine(request.roleName, wait);
          }
          await waiting?.(wait, line);
        }
      }
    );
    if (result.ok) return result;
    if ("busy" in result) return lockBusy(request.roleName, result.holder);
    if ("stopped" in result) {
      return {
        ok: false,
        code: "aws-setup-paused",
        message: "Setup was paused while it waited for the lock."
      };
    }
    return result;
  }

  // Run `work` on one role under its lock: every IAM or EKS write is checked
  // against the lock first, and the lock is released afterwards, including
  // when `work` throws. With no `waiting`, a lock another run holds is not
  // waited for: `work` gets a refusal naming the holder instead.
  async function runUnderLock<T>(
    holder: {
      repo: string;
      environment: string;
      action: AwsLockAction;
      operationId: string;
      // The policy ID of a lock this operation recorded, to take back.
      adopt?: string;
    },
    waiting: ((wait: AwsLockWait, line: string | null) => unknown) | null,
    work: (ports: AwsRoleChangePorts) => Promise<T>,
    onAcquired?: (lock: AwsDeployIdentityLock) => Promise<void>,
    // Called right before each AWS command is sent, after any lock check it
    // waits on. Throws to stop the run; the lock is still released.
    beforeSend: () => void = () => {}
  ): Promise<{ result: T; lost: string; released: AwsLockReleaseResult }> {
    // Boxed so the closures below and this function see one value.
    const state: {
      lock: AwsDeployIdentityLock | null;
      lost: AwsLockLoss | null;
      // Writes that ran while this run held the lock, for a lost-lock message.
      writes: string[];
    } = { lock: null, lost: null, writes: [] };
    try {
      const result = await work({
        runAws: async (args) => {
          if (state.lock && isAwsWrite(args)) {
            const lost = await state.lock.verify();
            if (lost) {
              state.lost ??= lost;
              return lockLostResult(lost.reason);
            }
            beforeSend();
            const result = await dependencies.runAws(args);
            if (result.code === 0 || result.code === "0") {
              state.writes.push(`aws ${args[0]} ${args[1]}`);
            }
            return result;
          }
          beforeSend();
          return dependencies.runAws(args);
        },
        sleep: dependencies.sleep,
        stillLocked: async () => {
          state.lost ??= (await state.lock?.verify()) ?? null;
          return state.lost === null;
        },
        acquireLock: async ({ accountId, roleName }) => {
          const taken = await lock(
            { accountId, roleName, ...holder },
            () => false,
            waiting &&
              (async (wait, line) => {
                await waiting(wait, line);
              })
          );
          if (!taken.ok) return taken;
          state.lock = taken.lock;
          await onAcquired?.(taken.lock);
          return { ok: true };
        }
      });
      const taken = state.lock;
      state.lock = null;
      const released = taken ? await taken.release() : { ok: true as const };
      return {
        result,
        lost: state.lost ? lockLostMessage(state.lost, state.writes) : "",
        released
      };
    } finally {
      // Only set when `work` threw before the release above.
      if (state.lock) await state.lock.release();
    }
  }

  // The same subjects Azure's federated credentials trust: one for a
  // repository that uses immutable subjects, otherwise the name-based and the
  // ID-based form.
  async function resolveOidc(
    repo: string,
    environment: string,
    executor?: SelectedGhExecutor
  ): Promise<ResolveOidcSubjectResult> {
    return resolveOidcSubject(
      {
        targetRepo: repo,
        envName: environment,
        suffix: buildEnvironmentSuffix(environment)
      },
      (apiPath) => dependencies.runGitHubJson(apiPath, executor)
    );
  }

  async function resolveIdentity(
    repo: string,
    environment: string,
    executor?: SelectedGhExecutor
  ): Promise<{
    repo: string;
    repoId: number;
    subjects: string[];
    subjectConfig: OidcSubjectConfig;
  }> {
    const oidc = await resolveOidc(repo, environment, executor);
    return {
      repo: oidc.fullName,
      repoId: oidc.repoId,
      subjects: oidc.federatedCredentials.map(
        (credential) => credential.subject
      ),
      subjectConfig: oidc.subjectConfig
    };
  }

  // The repository's AWS environments other than `environment`. Any read that
  // fails, or an environment Radius manages whose cluster can't be read, makes
  // the answer unknown, because that environment may use the same cluster.
  async function listOtherAwsEnvironments(
    repo: string,
    environment: string,
    repository: GitHubRepositoryIdentity
  ): Promise<AwsEnvironmentListing> {
    const loaded = await loadEnvironmentClaims(repo, dependencies.environments);
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      environments: loaded.claims
        .filter(
          ({ claimant }) =>
            claimant.provider === "aws" &&
            claimant.environment.toLowerCase() !== environment.toLowerCase()
        )
        .map(({ claimant, variables }) => ({
          name: claimant.environment,
          accountId: claimant.accountId,
          region: claimant.region,
          cluster: claimant.cluster,
          // Only subjects proven to be this repository's. Another may be
          // presented by other repositories too, so the access entry has to
          // stay while the role trusts it.
          trustSubjects: parseTrustSubjects(
            variables[AWS_TRUST_SUBJECTS_VARIABLE]
          ).filter((subject) => namesRepositoryEnvironment(subject, repository))
        }))
    };
  }

  // Record what exists in AWS, save it, and hand the pause to the caller.
  async function paused(
    operation: Operation,
    line: string
  ): Promise<AwsEnvironmentSetupResult> {
    operations.addLegacyStep(operation, line, stage);
    await dependencies.store.persist();
    return { ok: false, stopped: true };
  }

  async function savedPolicyName(
    repo: string,
    environment: string,
    roleArn: string,
    executor?: SelectedGhExecutor
  ): Promise<string | undefined> {
    const response = await dependencies.runGitHubJson(
      `/repos/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
      executor
    );
    if (response.status === 404) return undefined;
    const data: unknown = response.json;
    if (
      !response.ok ||
      typeof data !== "object" ||
      data === null ||
      !("variables" in data) ||
      !Array.isArray(data.variables)
    ) {
      throw new Error(
        "Could not read the environment's saved AWS policy identity. Nothing was changed."
      );
    }
    const values = new Map<string, string>();
    const variables: unknown[] = data.variables;
    for (const variable of variables) {
      if (
        typeof variable !== "object" ||
        variable === null ||
        !("name" in variable) ||
        typeof variable.name !== "string" ||
        !("value" in variable) ||
        typeof variable.value !== "string"
      ) {
        throw new Error(
          "GitHub returned unreadable environment variables. Nothing was changed."
        );
      }
      values.set(variable.name, variable.value);
    }
    const name = values.get(AWS_PERMISSION_POLICY_NAME_VARIABLE);
    if (name === undefined) return undefined;
    if (
      values.get("AWS_ROLE_ARN") !== roleArn ||
      !isAwsEnvironmentPolicyName(name, environment)
    ) {
      throw new Error(
        "The saved AWS permission policy does not match this environment and selected role. Repair its saved configuration before setup. Nothing was changed."
      );
    }
    return name;
  }

  function pausedLine(created: readonly string[]): string {
    return created.length > 0 ?
        `⏸️ Paused before the next AWS change. Created before the pause: ${created.join(", ")}.`
      : "⏸️ Paused before any AWS change. Nothing was created in AWS.";
  }

  // The deploy identity is not ready, so the stage is paused rather than done,
  // and Continue runs it again.
  function pausedBeforeReady(
    operation: Operation,
    created: readonly string[]
  ): Promise<AwsEnvironmentSetupResult> {
    operations.setStageState(operation, stage, "paused");
    return paused(operation, pausedLine(created));
  }

  // A session that failed while the journal read AWS, as a setup failure
  // with the session's own code. The setup coordinator waits for sign-in on
  // that code rather than charge the unsettled write.
  function sessionFailure(error: unknown): AwsEnvironmentSetupResult {
    if (!(error instanceof AwsSessionUnavailableError)) throw error;
    return { ok: false, status: 400, error: error.message, code: error.code };
  }

  return {
    async setup(operation, input, executor) {
      operations.enterStage(operation, stage);
      // An earlier run may have sent an AWS write and stopped before the
      // answer. Settle it from AWS first. During restart reconciliation that
      // asks for a pause, so the customer chooses Continue or Delete setup.
      let reconciled: boolean;
      try {
        reconciled = Boolean(await journal?.reconcile(operation));
      } catch (error) {
        return sessionFailure(error);
      }
      if (reconciled && dependencies.isStopRequested(operation)) {
        operations.setStageState(operation, stage, "paused");
        return paused(
          operation,
          "⏸️ Radius checked the AWS change the interrupted setup was making and paused. Continue setup, or delete it to remove what it created."
        );
      }
      let repo = text(input.repo);
      const environment = text(input.environment);
      let subjects: string[];
      let repoId: number;
      let subjectConfig: OidcSubjectConfig;
      try {
        const identity = await resolveIdentity(repo, environment, executor);
        repo = identity.repo;
        repoId = identity.repoId;
        subjects = identity.subjects;
        subjectConfig = identity.subjectConfig;
        if (dependencies.isStopRequested(operation)) {
          return pausedBeforeReady(operation, []);
        }
      } catch (error) {
        return {
          ok: false,
          status: 400,
          error: dependencies.errorMessage(error),
          code: "oidc-subject-unresolved"
        };
      }
      // The same check Repair makes, but before the lock, which is the first
      // AWS write. Only a customized subject can leave the repository out, and
      // the claim keys that did it are known only here.
      const shared = subjects.filter(
        (subject) => !subjectNamesRepository(subject)
      );
      if (shared.length > 0) {
        return {
          ok: false,
          status: 400,
          error: repositoryLessSubjectMessage(shared, repo, subjectConfig),
          code: "aws-subject-not-repository-specific"
        };
      }
      const accountId = text(input.accountId);
      const roleName = text(input.roleName) || defaultAwsDeployRoleName(repo);
      const existingRoleArn = text(input.existingRoleArn);
      let policyName: string | undefined;
      let reconcileLegacyPolicy = false;
      try {
        policyName = await savedPolicyName(
          repo,
          environment,
          existingRoleArn || awsRoleArn(accountId, roleName),
          executor
        );
        const recovery = operations.getContext(operation).awsPolicyIdentity;
        if (recovery !== undefined) {
          if (
            typeof recovery !== "object" ||
            recovery === null ||
            !("repoId" in recovery) ||
            recovery.repoId !== repoId ||
            !("environment" in recovery) ||
            recovery.environment !== environment ||
            !("roleArn" in recovery) ||
            recovery.roleArn !==
              (existingRoleArn || awsRoleArn(accountId, roleName)) ||
            !("policyName" in recovery) ||
            typeof recovery.policyName !== "string" ||
            !isAwsEnvironmentPolicyName(recovery.policyName, environment) ||
            (policyName !== undefined && policyName !== recovery.policyName)
          ) {
            throw new Error(
              "The recorded partial AWS policy identity does not match this setup. Reconcile its grant before retrying. Nothing was changed."
            );
          }
          reconcileLegacyPolicy = policyName === undefined;
          policyName = recovery.policyName;
        }
      } catch (error) {
        if (dependencies.isStopRequested(operation))
          return pausedBeforeReady(operation, []);
        return {
          ok: false,
          status: 400,
          code: "aws-policy-name-unresolved",
          error: dependencies.errorMessage(error)
        };
      }
      if (dependencies.isStopRequested(operation))
        return pausedBeforeReady(operation, []);
      let current: AwsDeployIdentityLock | null = null;
      let lockLost: AwsLockLoss | null = null;
      // Writes that ran while this run held the lock, for a lost-lock message.
      const writes: string[] = [];
      // Why this command must not run now: a pause, or a write this run no
      // longer holds the lock for. Null when it may run.
      const guard = async (
        args: string[]
      ): Promise<AwsCommandResult | null> => {
        if (dependencies.isStopRequested(operation)) return PAUSED;
        if (!current || !isAwsWrite(args)) return null;
        const lost = await current.verify();
        if (lost) {
          lockLost ??= lost;
          return lockLostResult(lost.reason);
        }
        // A pause that arrived during the check still stops this write.
        return dependencies.isStopRequested(operation) ? PAUSED : null;
      };
      const send = async (args: string[]): Promise<AwsCommandResult> => {
        const result = await dependencies.runAws(args);
        if (result.code === 0 || result.code === "0") {
          writes.push(`aws ${args[0]} ${args[1]}`);
        }
        return result;
      };
      let result: Awaited<ReturnType<typeof setupAwsDeployIdentity>>;
      try {
        result = await setupAwsDeployIdentity(
          {
            repo,
            repoId,
            operationId: dependencies.operationId(operation),
            environment,
            accountId,
            region: text(input.region),
            cluster: text(input.cluster),
            roleName,
            existingRoleArn,
            policyName,
            reconcileLegacyPolicy,
            subjects
          },
          {
            // Checked before every AWS command, including after setup's waits,
            // so a pause lets the command in flight finish and runs nothing
            // after it. No rollback: what already exists is recorded below.
            runAws: async (args) => {
              const refused = await guard(args);
              if (refused) return refused;
              return isAwsWrite(args) ? send(args) : dependencies.runAws(args);
            },
            ...(journal ?
              {
                write: (change, args) =>
                  journal.write(operation, change, args, {
                    read: async (read) =>
                      (await guard(read)) ?? dependencies.runAws(read),
                    guard,
                    run: send
                  })
              }
            : {}),
            step: (line) => {
              operations.addLegacyStep(operation, line, stage);
            },
            recordPolicyIdentity: async (identity) => {
              operations.setContext(operation, {
                awsPolicyIdentity: { repoId, environment, ...identity }
              });
              await dependencies.store.persist();
            },
            isRecordedForeignPolicy: async (candidate) => {
              if (candidate.repoId !== undefined)
                return candidate.repoId !== repoId;
              const identity = await resolveIdentity(
                candidate.repo,
                environment,
                executor
              );
              return (
                identity.repoId !== repoId &&
                (await savedPolicyName(
                  identity.repo,
                  environment,
                  candidate.roleArn,
                  executor
                )) === candidate.policyName
              );
            },
            sleep: dependencies.sleep,
            acquireLock: async ({ roleName }): Promise<AwsLockResult> => {
              const recorded = readRecordedAwsLock(
                operations.getContext(operation)
              );
              const taken = await lock(
                {
                  accountId,
                  roleName,
                  repo,
                  environment,
                  action: "setup",
                  operationId: dependencies.operationId(operation),
                  ...((
                    recorded?.policyArn ===
                    awsLockPolicyArn(accountId, roleName)
                  ) ?
                    { adopt: recorded.policyId }
                  : {})
                },
                () => dependencies.isStopRequested(operation),
                async (wait, line) => {
                  operations.touch(operation);
                  operations.setContext(operation, { awsLockWait: wait });
                  if (line) {
                    operations.addLegacyStep(operation, line, stage);
                    await dependencies.store.persist();
                  }
                }
              );
              operations.setContext(operation, { awsLockWait: null });
              if (!taken.ok) return taken;
              current = taken.lock;
              held.set(operation, taken.lock);
              operations.setContext(operation, {
                awsDeployIdentityLock: {
                  policyArn: taken.lock.policyArn,
                  policyId: taken.lock.policyId
                }
              });
              operations.addLegacyStep(
                operation,
                taken.adopted ?
                  `🔒 Took back the lock this setup holds on IAM role ${roleName} from its earlier attempt.`
                : `🔒 Locked IAM role ${roleName}, so no other Radius run changes its trust policy until this setup finishes.`,
                stage
              );
              // Saved before the first write, so a record left by a stopped
              // extension still names the lock it held.
              await dependencies.store.persist();
              return { ok: true };
            }
          }
        );
      } catch (error) {
        return sessionFailure(error);
      }
      if (lockLost) {
        await dependencies.store.persist();
        const created = "created" in result ? result.created : [];
        return {
          ok: false,
          status: 409,
          error: lockLostMessage(
            lockLost,
            created.length > 0 ? created : writes
          ),
          code: "aws-lock-lost"
        };
      }
      if (dependencies.isStopRequested(operation)) {
        if (result.ok) {
          operations.setContext(operation, {
            awsRoleArn: result.roleArn,
            awsTrustSubjects: subjects,
            awsPolicyName: result.policyName
          });
          return paused(
            operation,
            `⏸️ Paused after AWS setup finished. ${result.roleArn} is ready for this environment.`
          );
        }
        if (writes.includes("aws iam delete-role-policy")) {
          operations.setStageState(operation, stage, "paused");
          return paused(
            operation,
            `Paused after AWS policy changes. ${result.message}`
          );
        }
        return pausedBeforeReady(operation, result.created);
      }
      await dependencies.store.persist();
      if (!result.ok) {
        return {
          ok: false,
          status: 400,
          error:
            result.created.length > 0 ?
              `${result.message} Created before setup stopped: ${result.created.join(", ")}. Remove them in the AWS console if you will not retry.`
            : `${result.message} Nothing was created in AWS.`,
          code: result.code
        };
      }
      operations.setContext(operation, {
        awsRoleArn: result.roleArn,
        awsTrustSubjects: subjects,
        awsPolicyName: result.policyName
      });
      await dependencies.store.persist();
      return {
        ok: true,
        roleArn: result.roleArn,
        subjects,
        policyName: result.policyName
      };
    },

    async release(operation) {
      const taken = held.get(operation);
      if (!taken) return;
      let released: AwsLockReleaseResult;
      try {
        released = await taken.release();
      } catch (error) {
        // Still this run's: kept so the saved record names it.
        operations.addLegacyStep(
          operation,
          `⚠️ Radius could not release the lock on the deploy identity: ${dependencies.errorMessage(error)}. Other runs wait for this lock until it is removed. ${awsLockRecoveryCommand(taken.policyArn, taken.policyId)}`,
          stage
        );
        return;
      }
      if (released.ok || released.gone) {
        held.delete(operation);
        operations.setContext(operation, { awsDeployIdentityLock: null });
      }
      if (!released.ok) {
        operations.addLegacyStep(operation, `⚠️ ${released.message}`, stage);
      }
      try {
        await dependencies.store.persist();
      } catch (error) {
        operations.addLegacyStep(
          operation,
          `⚠️ Radius could not save this setup after it ${released.ok ? "released" : "tried to release"} the lock on the deploy identity: ${dependencies.errorMessage(error)}`,
          stage
        );
      }
    },

    async remove({
      repo,
      environment,
      roleArn,
      trustSubjects = [],
      region,
      cluster,
      policyName,
      operationId = "",
      waiting,
      whileLocked
    }) {
      // The recorded list covers a repository renamed since setup. The
      // current subjects cover what Repair added after an OIDC subject
      // change, which the recorded list doesn't name. The removal keeps any
      // that other environments or repositories may present too. A GitHub
      // read failure throws, so the delete stops with the GitHub environment
      // kept.
      const oidc = await resolveOidc(repo, environment);
      const subjects = [
        ...new Set([
          ...trustSubjects,
          ...oidc.federatedCredentials.map((credential) => credential.subject)
        ])
      ];
      // Recorded subjects retain the pre-rename repository for older grants.
      const policyRepositories = new Set(
        parseServedReposFromSubjects(
          trustSubjects.length > 0 ? trustSubjects : subjects
        ).map((name) => name.toLowerCase())
      );
      if (policyRepositories.size > 1) {
        return {
          ok: false,
          message:
            "Recorded AWS trust subjects name multiple repositories, so Radius did not change the deploy identity. Review the environment's saved AWS configuration before retrying."
        };
      }
      const policyRepository = [...policyRepositories][0] ?? oidc.fullName;
      const { result, lost, released } = await runUnderLock(
        { repo, environment, action: "delete", operationId },
        waiting ?? (() => undefined),
        async (ports) => {
          const removal = await removeAwsEnvironmentFromRole(
            {
              repo: policyRepository,
              repoId: oidc.repoId,
              roleArn,
              environment,
              subjects,
              region,
              cluster,
              policyName
            },
            {
              ...ports,
              listOtherEnvironments: () =>
                listOtherAwsEnvironments(repo, environment, oidc)
            }
          );
          if (removal.ok && whileLocked && (await ports.stillLocked())) {
            await whileLocked(removal);
          }
          return removal;
        }
      );
      if (lost) return { ok: false, message: lost };
      if (released.ok) return result;
      return result.ok ?
          { ...result, lockWarning: released.message }
        : { ok: false, message: `${result.message} ${released.message}` };
    },

    async rollback({
      repo,
      environment,
      operationId,
      roleArn,
      targets,
      adopt,
      isStopped,
      onLocked
    }) {
      const active = () => assertSetupExecutionActive(isStopped);
      active();
      const outcomes: AwsSetupRollbackOutcome[] = [];
      let interrupted = false;
      const { lost, released } = await runUnderLock(
        {
          repo,
          environment,
          action: "rollback",
          operationId,
          ...(adopt ? { adopt } : {})
        },
        null,
        async (ports) => {
          // Read once, for the access entry's ownership check and its listing
          // of the other environments.
          let identity: Promise<ResolveOidcSubjectResult> | undefined;
          const readIdentity = () =>
            (identity ??= resolveOidc(repo, environment));
          try {
            let repository: AwsRepositoryIdLookup;
            try {
              repository = { ok: true, repoId: (await readIdentity()).repoId };
            } catch (error) {
              repository = {
                ok: false,
                reason: dependencies.errorMessage(error)
              };
            }
            await rollbackAwsSetupChanges(
              { repo, repository, environment, roleArn, targets },
              {
                ...ports,
                acquireLock: async (role) => {
                  active();
                  return ports.acquireLock(role);
                },
                // Only the access entry needs this, so a GitHub read that fails
                // keeps that entry rather than stopping the whole rollback.
                listOtherEnvironments: async () => {
                  active();
                  try {
                    const oidc = await readIdentity();
                    return await listOtherAwsEnvironments(
                      repo,
                      environment,
                      oidc
                    );
                  } catch (error) {
                    return {
                      ok: false,
                      reason: dependencies.errorMessage(error)
                    };
                  }
                }
              },
              outcomes
            );
          } catch (error) {
            // The changes that finished stay in `outcomes`, and the lock is
            // released below as on any other return.
            if (!isSetupExecutionInterrupted(error)) throw error;
            interrupted = true;
          }
        },
        onLocked &&
          ((lock) =>
            onLocked({ policyArn: lock.policyArn, policyId: lock.policyId })),
        active
      );
      return {
        outcomes,
        warnings: [lost, released.ok ? "" : released.message].filter(Boolean),
        released: released.ok || released.gone,
        ...(interrupted ? { interrupted: true as const } : {})
      };
    },

    async repair({
      repo,
      environment: requested,
      roleArn,
      policyName,
      confirmTarget
    }) {
      // GitHub finds an environment by name in any casing, but its tokens
      // carry the stored spelling, so the subjects are built from that.
      const lookup = await dependencies.runGitHubJson(
        `/repos/${repo}/environments/${encodeURIComponent(requested)}`
      );
      const stored = lookup.ok ? text(lookup.json?.name) : "";
      if (!stored) {
        return {
          ok: false,
          code: "github-environment-unreadable",
          message: `Radius could not read GitHub environment "${requested}" (${lookup.ok ? "GitHub reported no name" : lookup.stderr || `HTTP ${lookup.status ?? "unknown"}`}), so it changed nothing.`
        };
      }
      const environment = stored;
      // Always from GitHub: AWS_TRUST_SUBJECTS is editable by anyone with
      // admin on the repository, so it cannot decide what Repair trusts.
      const { repoId, subjects, subjectConfig } = await resolveIdentity(
        repo,
        environment
      );
      const { result, lost, released } = await runUnderLock(
        { repo, environment, action: "repair", operationId: "" },
        null,
        (ports) =>
          repairAwsEnvironmentTrust(
            {
              repo,
              repoId,
              environment,
              roleArn,
              subjects,
              subjectConfig,
              policyName
            },
            {
              ...ports,
              // A delete can run between the first read of the environment and
              // this lock. Read it again under the lock, so Repair never adds
              // trust back for an environment that is gone or moved roles.
              acquireLock: async (request) => {
                const taken = await ports.acquireLock(request);
                if (!taken.ok) return taken;
                const changed = await confirmTarget();
                return changed ? { ok: false, ...changed } : taken;
              }
            }
          )
      );
      if (lost) return { ok: false, code: "aws-lock-lost", message: lost };
      if (released.ok) return result;
      return result.ok ?
          { ...result, lockWarning: released.message }
        : { ...result, message: `${result.message} ${released.message}` };
    }
  };
}
