import type { DeploymentRow } from "./deployment-resolver.js";

export interface DeploymentInspectionPorts {
  ghOrThrow(args: string[]): Promise<string>;
  resolveRepoAppName(repo: string, branch: string): Promise<string>;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    application: string
  ): Promise<DeploymentRow | null>;
}

export async function listDeployments(
  source: { repo: string; branch: string },
  ports: DeploymentInspectionPorts
): Promise<DeploymentRow[]> {
  const names = await ports.ghOrThrow([
    "api",
    "--paginate",
    `/repos/${source.repo}/environments?per_page=100`,
    "--jq",
    ".environments[].name"
  ]);
  const application = await ports.resolveRepoAppName(
    source.repo,
    source.branch
  );
  const environments =
    names ? [...new Set(names.split("\n").filter(Boolean))] : [];
  const deployments = await Promise.all(
    environments.map((environment) =>
      ports.resolveEnvDeployment(source.repo, environment, application)
    )
  );
  return deployments.filter((row): row is DeploymentRow => row !== null);
}

export async function listApplications(
  source: { repo: string; branch: string },
  ports: Pick<DeploymentInspectionPorts, "resolveRepoAppName">
): Promise<{ name: string }[]> {
  return [{ name: await ports.resolveRepoAppName(source.repo, source.branch) }];
}
