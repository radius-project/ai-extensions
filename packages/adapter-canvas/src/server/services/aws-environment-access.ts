import {
  buildAwsDeployRoleName,
  buildEnvironmentSuffix,
  buildOidcSubject
} from "@radius-project/core";
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
// GitHub OIDC subject the environment's workflows present, reports progress on
// the operation, and turns a failure into the answer the setup workflow shows.

export interface AwsEnvironmentAccessDependencies<Operation> {
  // Run `aws <args>`. Never throws; a spawn failure is a non-zero result.
  runAws(args: string[]): Promise<AwsCommandResult>;
  runGitHubJson(
    apiPath: string,
    executor?: SelectedGhExecutor
  ): Promise<GitHubJsonResponse>;
  sleep(milliseconds: number): Promise<void>;
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
  | { ok: true; roleArn: string }
  | { ok: false; status: number; error: string; code: string };

export interface AwsEnvironmentAccess<Operation> {
  // `Authorize deploy identity` for an AWS environment.
  setup(
    operation: Operation,
    input: Record<string, unknown>,
    executor: SelectedGhExecutor
  ): Promise<AwsEnvironmentSetupResult>;
  // Remove what one environment added to the shared deploy role.
  remove(input: {
    repo: string;
    environment: string;
    roleArn: string;
  }): Promise<AwsDeployIdentityRemovalResult>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createAwsEnvironmentAccess<Operation>(
  dependencies: AwsEnvironmentAccessDependencies<Operation>
): AwsEnvironmentAccess<Operation> {
  const { operations, stageAuthorizeIdentity: stage } = dependencies;

  // The same subject string Azure's federated credential trusts.
  async function resolveSubject(
    repo: string,
    environment: string,
    executor?: SelectedGhExecutor
  ): Promise<string> {
    const suffix = buildEnvironmentSuffix(environment);
    const oidc = await resolveOidcSubject(
      { targetRepo: repo, envName: environment, suffix },
      (apiPath) => dependencies.runGitHubJson(apiPath, executor)
    );
    return buildOidcSubject({
      repoFullName: oidc.fullName,
      ownerId: oidc.ownerId,
      repoId: oidc.repoId,
      suffix,
      subjectConfig: oidc.subjectConfig
    });
  }

  return {
    async setup(operation, input, executor) {
      operations.enterStage(operation, stage);
      const repo = text(input.repo);
      const environment = text(input.environment);
      let subject: string;
      try {
        subject = await resolveSubject(repo, environment, executor);
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
          roleName: text(input.roleName) || buildAwsDeployRoleName(repo),
          existingRoleArn: text(input.existingRoleArn),
          subject
        },
        {
          runAws: dependencies.runAws,
          step: (line) => {
            operations.addLegacyStep(operation, line, stage);
          },
          sleep: dependencies.sleep
        }
      );
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
      operations.setContext(operation, { awsRoleArn: result.roleArn });
      return { ok: true, roleArn: result.roleArn };
    },

    async remove({ repo, environment, roleArn }) {
      return removeAwsEnvironmentFromRole(
        {
          roleArn,
          environment,
          subject: await resolveSubject(repo, environment)
        },
        { runAws: dependencies.runAws }
      );
    }
  };
}
