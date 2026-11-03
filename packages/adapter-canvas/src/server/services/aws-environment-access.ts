import {
  AWS_TRUST_SUBJECTS_VARIABLE,
  namesRepositoryEnvironment,
  type GitHubRepositoryIdentity,
  buildEnvironmentSuffix,
  formatAwsLockTime,
  type AwsLockAction
} from "@radius-project/core";
import { defaultAwsDeployRoleName } from "../../aws-deploy-role-name.js";
import {
  resolveOidcSubject,
  type GitHubJsonResponse,
  type ResolveOidcSubjectResult
} from "../../azure-oidc.js";
import type { SelectedGhExecutor } from "../../gh.js";
import {
  claimantFromVariables,
  type NamespaceClaimsPorts
} from "../routes/create-environment-namespace-claims.js";
import {
  removeAwsEnvironmentFromRole,
  setupAwsDeployIdentity,
  type AwsCommandResult,
  type AwsDeployIdentityRemovalResult,
  type AwsEnvironmentListing,
  type AwsEnvironmentUsage,
  type AwsLockResult
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
  operationId(operation: Operation): string;
  operations: {
    enterStage(operation: Operation, stage: string): void;
    addLegacyStep(operation: Operation, text: string, stage: string): void;
    setContext(operation: Operation, patch: Record<string, unknown>): void;
    // Record activity without a step, so a long wait is not taken as stale.
    touch(operation: Operation): void;
  };
  // Saves every operation durably.
  store: { persist(): Promise<void> };
  stageAuthorizeIdentity: string;
  errorMessage(error: unknown): string;
}

export type AwsEnvironmentSetupResult =
  | { ok: true; roleArn: string; subjects: readonly string[] }
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
  const { operations, stageAuthorizeIdentity: stage } = dependencies;
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
    },
    shouldStop: () => boolean,
    waiting: (wait: AwsLockWait, line: string | null) => Promise<void>
  ): Promise<
    | { ok: true; lock: AwsDeployIdentityLock }
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
        }
      },
      {
        runAws: dependencies.runAws,
        sleep: dependencies.sleep,
        now: dependencies.now,
        shouldStop,
        waiting: async (wait) => {
          const key = `${wait.policyId}:${wait.removable}`;
          let line: string | null = null;
          if (!announced.has(key)) {
            announced.add(key);
            // Not a warning: the wait is normal, and a warning step would
            // outlive it and mark a setup that then succeeds as warned.
            line =
              wait.removable ?
                `⏳ The lock on IAM role ${request.roleName} is 10 or more minutes old. ${lockHolder(wait)} has held it since ${formatAwsLockTime(wait.since)}. If that run has stopped, use Remove lock.`
              : `⏳ Waiting for the lock on IAM role ${request.roleName}. ${lockHolder(wait)} has held it since ${formatAwsLockTime(wait.since)}.`;
          }
          await waiting(wait, line);
        }
      }
    );
    if (result.ok) return result;
    if ("stopped" in result) {
      return {
        ok: false,
        code: "aws-setup-paused",
        message: "Setup was paused while it waited for the lock."
      };
    }
    return result;
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

  async function resolveSubjects(
    repo: string,
    environment: string,
    executor?: SelectedGhExecutor
  ): Promise<string[]> {
    const oidc = await resolveOidc(repo, environment, executor);
    return oidc.federatedCredentials.map((credential) => credential.subject);
  }

  // The repository's AWS environments other than `environment`. Any read that
  // fails, or an environment Radius manages whose cluster can't be read, makes
  // the answer unknown, because that environment may use the same cluster.
  async function listOtherAwsEnvironments(
    repo: string,
    environment: string,
    repository: GitHubRepositoryIdentity
  ): Promise<AwsEnvironmentListing> {
    const names = await dependencies.environments.listEnvironmentNames(repo);
    if (!names.ok) return names;
    const others: AwsEnvironmentUsage[] = [];
    for (const name of names.names) {
      if (name.toLowerCase() === environment.toLowerCase()) continue;
      const read = await dependencies.environments.readEnvironmentVariables(
        repo,
        name
      );
      if (!read.ok) return read;
      const reading = claimantFromVariables(name, read.variables);
      if (reading.kind === "indeterminate") {
        return {
          ok: false,
          reason: `environment "${name}" does not record ${reading.missing}.`
        };
      }
      if (reading.kind === "claim" && reading.claimant.provider === "aws") {
        others.push({
          name,
          accountId: reading.claimant.accountId,
          region: reading.claimant.region,
          cluster: reading.claimant.cluster,
          // Only subjects proven to be this repository's. Another may be
          // presented by other repositories too, so the access entry has to
          // stay while the role trusts it.
          trustSubjects: parseTrustSubjects(
            read.variables[AWS_TRUST_SUBJECTS_VARIABLE]
          ).filter((subject) => namesRepositoryEnvironment(subject, repository))
        });
      }
    }
    return { ok: true, environments: others };
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

  function pausedLine(created: readonly string[]): string {
    return created.length > 0 ?
        `⏸️ Paused before the next AWS change. Created before the pause: ${created.join(", ")}.`
      : "⏸️ Paused before any AWS change. Nothing was created in AWS.";
  }

  return {
    async setup(operation, input, executor) {
      operations.enterStage(operation, stage);
      const repo = text(input.repo);
      const environment = text(input.environment);
      let subjects: string[];
      try {
        subjects = await resolveSubjects(repo, environment, executor);
        if (dependencies.isStopRequested(operation)) {
          return paused(operation, pausedLine([]));
        }
      } catch (error) {
        return {
          ok: false,
          status: 400,
          error: dependencies.errorMessage(error),
          code: "oidc-subject-unresolved"
        };
      }
      const accountId = text(input.accountId);
      let current: AwsDeployIdentityLock | null = null;
      let lockLost: AwsLockLoss | null = null;
      // Writes that ran while this run held the lock, for a lost-lock message.
      const writes: string[] = [];
      const result = await setupAwsDeployIdentity(
        {
          repo,
          environment,
          accountId,
          region: text(input.region),
          cluster: text(input.cluster),
          roleName: text(input.roleName) || defaultAwsDeployRoleName(repo),
          existingRoleArn: text(input.existingRoleArn),
          subjects
        },
        {
          // Checked before every AWS command, including after setup's waits,
          // so a pause lets the command in flight finish and runs nothing
          // after it. No rollback: what already exists is recorded below.
          runAws: async (args) => {
            if (dependencies.isStopRequested(operation)) return PAUSED;
            if (current && isAwsWrite(args)) {
              const lost = await current.verify();
              if (lost) {
                lockLost ??= lost;
                return lockLostResult(lost.reason);
              }
              // A pause that arrived during the check still stops this write.
              if (dependencies.isStopRequested(operation)) return PAUSED;
              const result = await dependencies.runAws(args);
              if (result.code === 0 || result.code === "0") {
                writes.push(`aws ${args[0]} ${args[1]}`);
              }
              return result;
            }
            return dependencies.runAws(args);
          },
          step: (line) => {
            operations.addLegacyStep(operation, line, stage);
          },
          sleep: dependencies.sleep,
          acquireLock: async ({ roleName }): Promise<AwsLockResult> => {
            const taken = await lock(
              {
                accountId,
                roleName,
                repo,
                environment,
                action: "setup",
                operationId: dependencies.operationId(operation)
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
              `🔒 Locked IAM role ${roleName}, so no other Radius run changes its trust policy until this setup finishes.`,
              stage
            );
            // Saved before the first write, so a record left by a stopped
            // extension still names the lock it held.
            await dependencies.store.persist();
            return { ok: true };
          }
        }
      );
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
            awsTrustSubjects: subjects
          });
          return paused(
            operation,
            `⏸️ Paused after AWS setup finished. ${result.roleArn} is ready for this environment.`
          );
        }
        return paused(operation, pausedLine(result.created));
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
        awsTrustSubjects: subjects
      });
      return { ok: true, roleArn: result.roleArn, subjects };
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
      operationId = "",
      waiting,
      whileLocked
    }) {
      // The recorded list covers a repository renamed since setup. The
      // current subjects cover what Repair added after an OIDC subject
      // change, which the recorded list doesn't name. They are removed only
      // when the template names this repository and environment, because
      // otherwise other environments or repositories present them too. A
      // GitHub read failure throws, so the delete stops with the GitHub
      // environment kept.
      const oidc = await resolveOidc(repo, environment);
      const current = oidc.federatedCredentials
        .map((credential) => credential.subject)
        .filter((subject) => !trustSubjects.includes(subject));
      const own = current.filter((subject) =>
        namesRepositoryEnvironment(subject, oidc)
      );
      const subjects = [...new Set([...trustSubjects, ...own])];
      const shared = current
        .filter((subject) => !own.includes(subject))
        .map(
          (subject) =>
            `Radius didn't remove trust subject ${subject}, because it doesn't name both this repository and an environment, so other environments or repositories may use it. If nothing else needs it, remove it from the role's trust policy by hand.`
        );
      // Boxed so the closures below and this function see one value.
      const state: {
        lock: AwsDeployIdentityLock | null;
        lost: AwsLockLoss | null;
        writes: string[];
      } = { lock: null, lost: null, writes: [] };
      try {
        const removal = await removeAwsEnvironmentFromRole(
          { repo, roleArn, environment, subjects, region, cluster },
          {
            runAws: async (args) => {
              if (state.lock && isAwsWrite(args)) {
                const lost = await state.lock.verify();
                if (lost) {
                  state.lost ??= lost;
                  return lockLostResult(lost.reason);
                }
                const result = await dependencies.runAws(args);
                if (result.code === 0 || result.code === "0") {
                  state.writes.push(`aws ${args[0]} ${args[1]}`);
                }
                return result;
              }
              return dependencies.runAws(args);
            },
            sleep: dependencies.sleep,
            acquireLock: async ({ accountId, roleName }) => {
              const taken = await lock(
                {
                  accountId,
                  roleName,
                  repo,
                  environment,
                  action: "delete",
                  operationId
                },
                () => false,
                async (wait, line) => {
                  await waiting?.(wait, line);
                }
              );
              if (!taken.ok) return taken;
              state.lock = taken.lock;
              return { ok: true };
            },
            listOtherEnvironments: () =>
              listOtherAwsEnvironments(repo, environment, oidc)
          }
        );
        const result =
          removal.ok && shared.length > 0 ?
            { ...removal, warnings: [...removal.warnings, ...shared] }
          : removal;
        if (result.ok && !state.lost && whileLocked) {
          state.lost = (await state.lock?.verify()) ?? null;
          if (!state.lost) await whileLocked(result);
        }
        const taken = state.lock;
        state.lock = null;
        const released = taken ? await taken.release() : { ok: true as const };
        if (state.lost) {
          return {
            ok: false,
            message: lockLostMessage(state.lost, state.writes)
          };
        }
        if (released.ok) return result;
        return result.ok ?
            { ...result, lockWarning: released.message }
          : { ok: false, message: `${result.message} ${released.message}` };
      } finally {
        // Only set when the removal threw before the release above.
        if (state.lock) await state.lock.release();
      }
    }
  };
}
