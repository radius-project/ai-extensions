export interface DeploymentBranchPorts {
  isCurrent(): boolean;
  head(repo: string, branch: string): Promise<string | null>;
  defaultBranch(repo: string): Promise<string | null>;
  errorMessage(error: unknown): string;
}

export type DeploymentBranchCheck =
  | { readonly kind: "ready" | "missing" }
  | { readonly kind: "refused" | "cancelled"; readonly message: string };

export async function checkDeploymentBranch(
  repo: string,
  branch: string,
  ports: DeploymentBranchPorts
): Promise<DeploymentBranchCheck> {
  const cancelled = (): DeploymentBranchCheck => ({
    kind: "cancelled",
    message: "Deployment preparation stopped; no workflow was dispatched."
  });
  if (!ports.isCurrent()) return cancelled();
  if (!repo.trim() || !branch.trim()) {
    return {
      kind: "refused",
      message:
        "A repository and resolved branch are required before deployment."
    };
  }
  try {
    const sha = await ports.head(repo, branch);
    if (!ports.isCurrent()) return cancelled();
    if (sha) return { kind: "ready" };
    // Only confirmed repository access makes a missing ref an unpushed branch.
    const defaultBranch = await ports.defaultBranch(repo);
    if (!ports.isCurrent()) return cancelled();
    if (!defaultBranch?.trim()) {
      return {
        kind: "refused",
        message: `Could not confirm repository access for ${repo}; deployment was not started.`
      };
    }
    return { kind: "missing" };
  } catch (error) {
    if (!ports.isCurrent()) return cancelled();
    return {
      kind: "refused",
      message:
        "Could not confirm the deployment branch: " + ports.errorMessage(error)
    };
  }
}
