import { buildEnvironmentSuffix } from "@radius-project/core";
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
  type AwsDeployIdentityRemovalResult
} from "./aws-deploy-identity.js";

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
  // Whether the customer asked to pause this operation.
  isStopRequested(operation: Operation): boolean;
  operations: {
    enterStage(operation: Operation, stage: string): void;
    addLegacyStep(operation: Operation, text: string, stage: string): void;
    setContext(operation: Operation, patch: Record<string, unknown>): void;
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
  // Remove what one environment added to the shared deploy role. `trustSubjects`
  // are the subjects setup recorded; without them the subjects are resolved
  // from the repository's current name and IDs.
  remove(input: {
    repo: string;
    environment: string;
    roleArn: string;
    trustSubjects?: readonly string[];
  }): Promise<AwsDeployIdentityRemovalResult>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createAwsEnvironmentAccess<Operation>(
  dependencies: AwsEnvironmentAccessDependencies<Operation>
): AwsEnvironmentAccess<Operation> {
  const { operations, stageAuthorizeIdentity: stage } = dependencies;

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
      const result = await setupAwsDeployIdentity(
        {
          repo,
          environment,
          accountId: text(input.accountId),
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
            return dependencies.runAws(args);
          },
          step: (line) => {
            operations.addLegacyStep(operation, line, stage);
          },
          sleep: dependencies.sleep
        }
      );
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

    async remove({ repo, environment, roleArn, trustSubjects = [] }) {
      return removeAwsEnvironmentFromRole(
        {
          roleArn,
          environment,
          subjects:
            trustSubjects.length > 0 ?
              trustSubjects
            : await resolveSubjects(repo, environment)
        },
        { runAws: dependencies.runAws }
      );
    }
  };
}
