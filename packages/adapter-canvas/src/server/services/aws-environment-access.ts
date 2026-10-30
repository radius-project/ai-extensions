import {
  buildEnvironmentSuffix,
  type AwsLockAction
} from "@radius-project/core";
import { defaultAwsDeployRoleName } from "../../aws-deploy-role-name.js";
import {
  resolveOidcSubject,
  type GitHubJsonResponse
} from "../../azure-oidc.js";
import type { SelectedGhExecutor } from "../../gh.js";
import {
  removeAwsEnvironmentFromRole,
  setupAwsDeployIdentity,
  type AwsCommandResult,
  type AwsDeployIdentityRemovalResult,
  type AwsLockResult
} from "./aws-deploy-identity.js";
import {
  acquireAwsDeployIdentityLock,
  isAwsWrite,
  type AwsDeployIdentityLock,
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
  // deploy identity lock. `trustSubjects` are the subjects setup recorded;
  // without them the subjects are resolved from the repository's current name
  // and IDs.
  remove(input: {
    repo: string;
    environment: string;
    roleArn: string;
    trustSubjects?: readonly string[];
    operationId?: string;
    // Called on every poll while another run holds the lock, with a progress
    // line when there is something new to say.
    waiting?(wait: AwsLockWait, line: string | null): void | Promise<void>;
  }): Promise<AwsEnvironmentRemovalResult>;
}

export type AwsEnvironmentRemovalResult =
  | (Extract<AwsDeployIdentityRemovalResult, { ok: true }> & {
      // Set when the removal finished but the lock could not be released.
      readonly lockWarning?: string;
    })
  | Extract<AwsDeployIdentityRemovalResult, { ok: false }>;

// When IAM created a lock, for a progress line.
function lockTime(since: string): string {
  const time = Date.parse(since);
  return isNaN(time) ? "an unknown time" : (
      `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`
    );
}

// A write the lock check refused. Setup and delete treat it as a failure and
// stop before any later command.
function lockLostResult(reason: string): AwsCommandResult {
  return { code: 1, stdout: "", stderr: reason };
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
            line =
              wait.removable ?
                `⚠️ The lock on IAM role ${request.roleName} has been held for more than 10 minutes. If that run has stopped, use Remove lock.`
              : `⏳ Waiting for the lock on IAM role ${request.roleName}. ${wait.holder} has held it since ${lockTime(wait.since)}.`;
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
  async function resolveSubjects(
    repo: string,
    environment: string,
    executor?: SelectedGhExecutor
  ): Promise<string[]> {
    const oidc = await resolveOidcSubject(
      {
        targetRepo: repo,
        envName: environment,
        suffix: buildEnvironmentSuffix(environment)
      },
      (apiPath) => dependencies.runGitHubJson(apiPath, executor)
    );
    return oidc.federatedCredentials.map((credential) => credential.subject);
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
      let lockLost = "";
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
                lockLost ||= lost;
                return lockLostResult(lost);
              }
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
            return { ok: true };
          }
        }
      );
      if (lockLost) {
        await dependencies.store.persist();
        return {
          ok: false,
          status: 409,
          error:
            "created" in result && result.created.length > 0 ?
              `${lockLost} Created before setup stopped: ${result.created.join(", ")}. Retry setup to finish, or remove them in the AWS console if you will not retry.`
            : `${lockLost} Nothing was created in AWS.`,
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
      held.delete(operation);
      try {
        const released = await taken.release();
        operations.setContext(operation, { awsDeployIdentityLock: null });
        if (!released.ok) {
          operations.addLegacyStep(operation, `⚠️ ${released.message}`, stage);
        }
        await dependencies.store.persist();
      } catch (error) {
        operations.addLegacyStep(
          operation,
          `⚠️ Radius could not release the lock on the deploy identity: ${dependencies.errorMessage(error)}. Other runs wait for it until it is removed. Run: aws iam delete-policy --policy-arn ${taken.policyArn}`,
          stage
        );
      }
    },

    async remove({
      repo,
      environment,
      roleArn,
      trustSubjects = [],
      operationId = "",
      waiting
    }) {
      const subjects =
        trustSubjects.length > 0 ?
          trustSubjects
        : await resolveSubjects(repo, environment);
      // Boxed so the closures below and this function see one value.
      const state: { lock: AwsDeployIdentityLock | null; lost: string } = {
        lock: null,
        lost: ""
      };
      try {
        const result = await removeAwsEnvironmentFromRole(
          { roleArn, environment, subjects },
          {
            runAws: async (args) => {
              if (state.lock && isAwsWrite(args)) {
                const lost = await state.lock.verify();
                if (lost) {
                  state.lost ||= lost;
                  return lockLostResult(lost);
                }
              }
              return dependencies.runAws(args);
            },
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
            }
          }
        );
        const taken = state.lock;
        state.lock = null;
        const released = taken ? await taken.release() : { ok: true as const };
        if (state.lost) return { ok: false, message: state.lost };
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
