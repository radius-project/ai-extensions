import { isValidRepoSlug } from "./platforms/setup-azure-identity.js";

export interface DeploymentTarget {
  repo: string;
  branch: string;
  environment: string;
  provider: string;
  appFile: string;
}

export interface DeploymentWorkspace {
  readonly repo: string;
  readonly branch: string;
  readonly workspacePath?: string;
}

export interface DeploymentStartInput {
  repo?: string;
  branch?: string;
  environment?: string;
  provider?: string;
  appFile?: string;
  attemptId?: string;
}

export function resolveDeploymentTarget(
  input: DeploymentStartInput,
  options: {
    previous?: Readonly<DeploymentTarget>;
    /** Prior explicit request intent, never an automatically selected filename. */
    previousAppFile?: string;
    workspace?: DeploymentWorkspace;
    awsEnabled: boolean;
    normalizeAppFile(path: string): string;
  }
): { target: DeploymentTarget } | { error: string; status: 400 | 409 } {
  const prior = options.previous;
  const repo = input.repo || prior?.repo || options.workspace?.repo || "";
  const sameRepository = prior?.repo.toLowerCase() === repo.toLowerCase();
  const eligiblePrior =
    sameRepository &&
    (!input.environment || input.environment === prior?.environment);
  const branch =
    input.branch ||
    (eligiblePrior ? prior?.branch : "") ||
    (options.workspace?.repo.toLowerCase() === repo.toLowerCase() ?
      options.workspace.branch
    : "");
  if (input.appFile !== undefined && !input.appFile.trim())
    return {
      status: 400,
      error: "An explicit application model path must not be empty."
    };
  const target: DeploymentTarget = {
    repo,
    branch,
    environment:
      input.environment || (eligiblePrior ? prior?.environment : "") || "",
    provider:
      input.provider || (eligiblePrior ? prior?.provider : "") || "azure",
    appFile:
      input.appFile ??
      (eligiblePrior && branch === prior?.branch ?
        input.attemptId ?
          prior.appFile
        : options.previousAppFile
      : undefined) ??
      ".radius/app.bicep"
  };
  if (!isValidRepoSlug(repo) || !target.environment.trim())
    return {
      status: 400,
      error: "A valid repo (owner/repo) and environment are required."
    };
  if (
    target.provider !== "azure" &&
    (target.provider !== "aws" || !options.awsEnabled)
  )
    return {
      status: 400,
      error: "The requested deployment provider is not enabled."
    };
  target.appFile = options.normalizeAppFile(target.appFile);
  if (input.attemptId && prior) {
    const fields: readonly (keyof DeploymentTarget)[] = [
      "repo",
      "branch",
      "environment",
      "provider",
      "appFile"
    ];
    if (fields.some((field) => target[field] !== prior[field]))
      return {
        status: 409,
        error: "A repair attempt cannot be retargeted. Nothing was deployed."
      };
  }
  return { target };
}
export function deploymentStatusBlocksMutation(status: unknown): boolean {
  return (
    status === "pending" || status === "in_progress" || status === "deleting"
  );
}
