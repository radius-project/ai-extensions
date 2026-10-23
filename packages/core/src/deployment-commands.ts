export interface DeploymentCommandTarget {
  readonly repo: string;
  readonly branch: string;
  readonly environment: string;
  readonly appFile?: string;
}

export interface DeploymentCommandPorts {
  isCurrent(): boolean;
  readFile(
    target: DeploymentCommandTarget,
    path: string
  ): Promise<string | null>;
  parameters(source: string): {
    public: Readonly<Record<string, string>>;
    secret: Readonly<Record<string, string>>;
  };
  applicationName(source: string): string;
  deployCommand(
    path: string,
    environment: string,
    parameters: Readonly<Record<string, string>>
  ): string;
  graphCommand(application: string): string;
  ensureSecret(
    parameters: Readonly<Record<string, string>>
  ): Promise<string | null>;
  errorMessage(error: unknown): string;
}

export type DeploymentCommandPreparation =
  | {
      readonly kind: "ready";
      readonly appFile: string;
      readonly application: string;
      readonly commands: readonly string[];
    }
  | { readonly kind: "refused" | "cancelled"; readonly message: string };

export function deploymentApplicationPaths(appFile?: string): string[] {
  if (
    appFile !== undefined &&
    (!/^[A-Za-z0-9_.][A-Za-z0-9_.\/-]*\.bicep$/.test(appFile) ||
      appFile.split("/").some((part) => !part || part === "." || part === ".."))
  ) {
    throw new Error(
      "The application file must be a repository-relative Bicep path without traversal or command delimiters."
    );
  }
  return appFile === undefined ? [".radius/app.bicep", "app.bicep"] : [appFile];
}

export async function prepareDeploymentCommands(
  target: DeploymentCommandTarget,
  ports: DeploymentCommandPorts
): Promise<DeploymentCommandPreparation> {
  const selected = { ...target };
  const cancelled = (): DeploymentCommandPreparation => ({
    kind: "cancelled",
    message: "Deployment preparation stopped; no workflow was dispatched."
  });
  if (!ports.isCurrent()) return cancelled();
  if (
    !selected.repo.trim() ||
    !selected.branch.trim() ||
    !selected.environment.trim()
  ) {
    return {
      kind: "refused",
      message: "A repository, branch and environment are required."
    };
  }
  let paths: string[];
  try {
    paths = deploymentApplicationPaths(selected.appFile);
  } catch (error) {
    return {
      kind: "refused",
      message: ports.errorMessage(error)
    };
  }
  try {
    for (const path of paths) {
      const source = await ports.readFile(selected, path);
      if (!ports.isCurrent()) return cancelled();
      // Only confirmed absence permits the legacy root-file lookup.
      if (source === null) continue;
      if (!source.trim()) {
        return {
          kind: "refused",
          message: `The application file "${path}" is empty.`
        };
      }
      const parameters = ports.parameters(source);
      const application = ports.applicationName(source);
      const commands = [
        ports.deployCommand(path, selected.environment, parameters.public)
      ];
      if (application) commands.push(ports.graphCommand(application));
      if (!ports.isCurrent()) return cancelled();
      if (Object.keys(parameters.secret).length > 0) {
        const failure = await ports.ensureSecret(parameters.secret);
        if (!ports.isCurrent()) return cancelled();
        if (failure) return { kind: "refused", message: failure };
      }
      return { kind: "ready", appFile: path, application, commands };
    }
    return {
      kind: "refused",
      message: `Could not read ${paths.join(" or ")} on ${selected.repo}@${selected.branch}; deployment was not started.`
    };
  } catch (error) {
    if (!ports.isCurrent()) return cancelled();
    return {
      kind: "refused",
      message:
        "Could not prepare deployment commands: " + ports.errorMessage(error)
    };
  }
}
