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
  // Advanced on every deploy, including a redeploy in a repair loop.
  deployGeneration?: number;
}

export interface AwsTrustRepairDependencies {
  // The AWS developer switch. Repair changes an IAM role through the
  // developer's AWS CLI, so it is refused when AWS is off, like every other
  // AWS route.
  awsEnabled: boolean;
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
    confirmTarget(): Promise<{ code: string; message: string } | null>;
  }): Promise<AwsEnvironmentRepairResult>;
  errorMessage(error: unknown): string;
}

export interface AwsTrustRepairResponse {
  status: number;
  body: Record<string, unknown>;
}

export function createAwsTrustRepairService(
  dependencies: AwsTrustRepairDependencies
): {
  repair(input: {
    instanceId: string;
    generation: number;
  }): Promise<AwsTrustRepairResponse>;
} {
  return {
    async repair({ instanceId, generation }) {
      if (!dependencies.awsEnabled) {
        return {
          status: 400,
          body: {
            code: "provider-unsupported",
            error:
              "AWS environments aren't supported yet, so Radius repaired nothing."
          }
        };
      }
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
      // The panel names the deploy it showed. Another deploy since then
      // could have failed for another environment.
      if (generation !== (state.deployGeneration || 0)) {
        return {
          status: 409,
          body: {
            code: "repair-stale",
            error:
              "This failure is no longer the canvas's latest deploy, so Radius changed nothing. Repair from the current result."
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
        const roleArn = target.roleArn;
        result = await dependencies.repair({
          repo,
          environment,
          roleArn,
          confirmTarget: async () => {
            let current: EnvironmentTarget;
            try {
              current = await dependencies.readEnvironmentTarget(
                repo,
                environment
              );
            } catch (error) {
              return {
                code: "repair-target-changed",
                message: `Radius could not read GitHub environment "${environment}" again after it locked the role, so it changed nothing. The environment may have been deleted. ${dependencies.errorMessage(error)}`
              };
            }
            if (current.provider !== "aws" || !current.roleArn) {
              return {
                code: "repair-target-changed",
                message: `GitHub environment "${environment}" no longer names an AWS deploy role, so Radius changed nothing. Deploy again to see the current result.`
              };
            }
            if (current.roleArn.trim() !== roleArn.trim()) {
              return {
                code: "repair-target-changed",
                message: `GitHub environment "${environment}" changed while Repair took the lock: it now names ${current.roleArn} instead of ${roleArn}. Radius changed nothing. Deploy again to see the current result.`
              };
            }
            return null;
          }
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
