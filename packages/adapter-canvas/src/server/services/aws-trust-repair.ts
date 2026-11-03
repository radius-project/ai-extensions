import type { EnvironmentTarget } from "./environment-target.js";
import type { AwsEnvironmentRepairResult } from "./aws-environment-access.js";

// Repair for an AWS deploy that could not sign in. The canvas's own failed
// deploy decides which environment is repaired, so the browser only asks; it
// never names a role or a repository.

export interface AwsTrustRepairState {
  deployStatus?: string;
  deployErrorKind?: string | null;
  deployingRepo?: string;
  deployEnvName?: string;
  deployAttempt?: { targetRepo?: string; environment?: string };
}

export interface AwsTrustRepairDependencies {
  readInstanceState(instanceId: string): AwsTrustRepairState | undefined;
  // The failure kind for a deploy that failed at cloud sign-in.
  cloudAuthDriftKind: string;
  // Reads the GitHub environment's variables. Throws when they cannot be read.
  readEnvironmentTarget(
    repo: string,
    environment: string
  ): Promise<EnvironmentTarget>;
  repair(input: {
    repo: string;
    environment: string;
    roleArn: string;
  }): Promise<AwsEnvironmentRepairResult>;
  errorMessage(error: unknown): string;
}

export interface AwsTrustRepairResponse {
  status: number;
  body: Record<string, unknown>;
}

export function createAwsTrustRepairService(
  dependencies: AwsTrustRepairDependencies
): { repair(input: { instanceId: string }): Promise<AwsTrustRepairResponse> } {
  return {
    async repair({ instanceId }) {
      const state = dependencies.readInstanceState(instanceId);
      const repo = state?.deployAttempt?.targetRepo || state?.deployingRepo;
      const environment =
        state?.deployAttempt?.environment || state?.deployEnvName;
      if (
        state?.deployStatus !== "failed" ||
        state.deployErrorKind !== dependencies.cloudAuthDriftKind ||
        !repo ||
        !environment
      ) {
        return {
          status: 409,
          body: {
            code: "repair-not-applicable",
            error:
              "Repair is for a deploy that could not sign in to AWS, and this canvas has no such deploy now. Deploy again to see the current result."
          }
        };
      }
      let target: EnvironmentTarget;
      try {
        target = await dependencies.readEnvironmentTarget(repo, environment);
      } catch (error) {
        return {
          status: 502,
          body: {
            code: "github-environment-variables-unreadable",
            error: `Radius could not read the variables of GitHub environment "${environment}", so it changed nothing: ${dependencies.errorMessage(error)}`
          }
        };
      }
      if (target.provider !== "aws" || !target.roleArn) {
        return {
          status: 409,
          body: {
            code: "repair-not-aws",
            error: `GitHub environment "${environment}" has no AWS_ROLE_ARN, so there is no AWS deploy role to repair. Re-verify the environment instead.`
          }
        };
      }
      let result: AwsEnvironmentRepairResult;
      try {
        result = await dependencies.repair({
          repo,
          environment,
          roleArn: target.roleArn
        });
      } catch (error) {
        return {
          status: 502,
          body: {
            code: "aws-trust-repair-failed",
            error: `Radius could not repair the deploy role: ${dependencies.errorMessage(error)}`
          }
        };
      }
      if (!result.ok) {
        return {
          status: 409,
          body: { code: result.code, error: result.message }
        };
      }
      const warning = result.lockWarning ? ` ${result.lockWarning}` : "";
      if (result.added.length === 0) {
        return {
          status: 200,
          body: {
            code: "aws-trust-intact",
            added: [],
            message: `IAM role ${result.roleName} already trusts environment ${environment}, so the sign-in failure has another cause, such as the role's permissions. Re-verify the environment to find it.${warning}`
          }
        };
      }
      return {
        status: 200,
        body: {
          code: "aws-trust-repaired",
          added: [...result.added],
          message: `IAM role ${result.roleName} trusts environment ${environment} again. Radius added back ${result.added.join(", ")}. Deploy again.${warning}`
        }
      };
    }
  };
}
