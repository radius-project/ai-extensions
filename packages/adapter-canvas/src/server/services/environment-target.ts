import {
  classifyProvider,
  parseGitHubEnvironmentVariables
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
}

export type EnvironmentTargetCommandRunner = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<string>;

/**
 * Reads the environment's stored GitHub variables to determine its provider and
 * the identity the delete cleanup targets. Throws on an API or permission
 * failure so the delete route fails closed.
 */
export function createEnvironmentTargetReader(
  runCommand: EnvironmentTargetCommandRunner
): (repo: string, environment: string) => Promise<EnvironmentTarget> {
  return async (repo, environment) => {
    const out = await runCommand(
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
    );
    const vars = parseGitHubEnvironmentVariables(out);
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
      roleArn: vars.AWS_ROLE_ARN || ""
    };
  };
}
