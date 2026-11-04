import {
  AWS_TRUST_SUBJECTS_VARIABLE,
  AWS_PERMISSION_POLICY_NAME_VARIABLE
} from "@radius-project/core";
import {
  classifyProvider,
  parseGitHubEnvironmentVariables,
  type ClassifiedProvider
} from "../../provider-classification.js";

// What environment deletion needs to know about a GitHub environment: its
// provider, and the identity cleanup targets for it.
export interface EnvironmentTarget {
  provider: string;
  clientId: string;
  tenantId: string;
  repoId: number;
  // AWS only: the shared deploy role the environment's trust lives on.
  roleArn: string;
  // AWS only: the subjects setup added to that role's trust. Empty for an
  // environment created before setup recorded them, or when the variable is
  // unreadable; deletion then resolves them from the repository.
  trustSubjects: string[];
  // AWS only: the cluster whose access entry deletion may remove. Empty for an
  // environment that did not record it.
  region: string;
  cluster: string;
  policyName?: string;
}

export function parseTrustSubjects(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return (
        Array.isArray(parsed) &&
          parsed.every((subject) => typeof subject === "string" && subject)
      ) ?
        parsed
      : [];
  } catch {
    return [];
  }
}

export type EnvironmentTargetCommandRunner = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<string>;

async function readEnvironmentVariables(
  runCommand: EnvironmentTargetCommandRunner,
  repo: string,
  environment: string
): Promise<Record<string, string>> {
  return parseGitHubEnvironmentVariables(
    await runCommand(
      "gh",
      [
        "api",
        `/repos/${repo}/environments/${encodeURIComponent(
          environment
        )}/variables?per_page=100`,
        "--jq",
        '.variables[] | .name + "\\t" + (.value // "")'
      ],
      { timeout: 15000 }
    )
  );
}

/**
 * Reads the provider whose job the dispatcher workflows run. They test the
 * marker variables with `-n`, so empty values are ignored here too. Throws on
 * an API or permission failure.
 */
export function createEnvironmentProviderReader(
  runCommand: EnvironmentTargetCommandRunner
): (repo: string, environment: string) => Promise<ClassifiedProvider> {
  return async (repo, environment) => {
    const vars = await readEnvironmentVariables(runCommand, repo, environment);
    return classifyProvider(
      Object.fromEntries(Object.entries(vars).filter(([, value]) => value))
    );
  };
}

/**
 * Reads the environment's stored GitHub variables to determine its provider and
 * the identity the delete cleanup targets. Throws on an API or permission
 * failure so the delete route fails closed.
 */
export function createEnvironmentTargetReader(
  runCommand: EnvironmentTargetCommandRunner
): (repo: string, environment: string) => Promise<EnvironmentTarget> {
  return async (repo, environment) => {
    const vars = await readEnvironmentVariables(runCommand, repo, environment);
    // Classify the provider by the presence of a canonical, exact-named
    // configuration variable (see classifyProvider) rather than a regex over
    // every variable name, and share that logic with the environment listing so
    // the two paths never disagree about the same environment.
    const provider = classifyProvider(vars);
    let repoId = 0;
    if (provider === "azure") {
      const repoIdOutput = await runCommand(
        "gh",
        ["api", `/repos/${repo}`, "--jq", ".id"],
        { timeout: 15000 }
      );
      repoId = Number(repoIdOutput.trim());
      if (!Number.isFinite(repoId) || repoId <= 0) {
        throw new Error("GitHub returned an invalid repository id.");
      }
    }
    return {
      provider,
      clientId: vars.AZURE_CLIENT_ID || "",
      tenantId: vars.AZURE_TENANT_ID || "",
      repoId,
      roleArn: vars.AWS_ROLE_ARN || "",
      trustSubjects: parseTrustSubjects(vars[AWS_TRUST_SUBJECTS_VARIABLE]),
      region: vars.AWS_REGION || "",
      cluster: vars.AWS_EKS_CLUSTER_NAME || "",
      ...(vars[AWS_PERMISSION_POLICY_NAME_VARIABLE] !== undefined ?
        { policyName: vars[AWS_PERMISSION_POLICY_NAME_VARIABLE] }
      : {})
    };
  };
}
