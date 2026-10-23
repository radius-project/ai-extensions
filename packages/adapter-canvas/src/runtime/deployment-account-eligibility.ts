import {
  redactCredentials,
  type GitHubAccountSelectionPorts
} from "@radius-project/core";
import {
  selectedGhApiJson,
  SelectedGhIdentityError,
  type SelectedGhExecutor
} from "../gh.js";
import { isGitHubAppBotLogin } from "../github-app-installation.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const installationReads = [
  {
    path: (repo: string) => `repos/${repo}/contents`,
    capability: "repository contents",
    valid: (value: unknown) => Array.isArray(value)
  },
  {
    path: (repo: string) => `repos/${repo}/actions/workflows?per_page=1`,
    capability: "Actions workflows",
    valid: (value: unknown) => record(value) && Array.isArray(value.workflows)
  },
  {
    path: (repo: string) => `repos/${repo}/environments?per_page=1`,
    capability: "deployment environments",
    valid: (value: unknown) =>
      record(value) && Array.isArray(value.environments)
  },
  {
    path: (repo: string) => `repos/${repo}/deployments?per_page=1`,
    capability: "deployment history",
    valid: (value: unknown) => Array.isArray(value)
  }
];

export function createDeploymentAccountEligibility(ports: {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  redactDiagnostic(value: string): string;
}): GitHubAccountSelectionPorts["check"] {
  return async (login, target) => {
    let executor: SelectedGhExecutor | undefined;
    const failure = (
      state: "ineligible" | "unavailable",
      detail: string
    ): Awaited<ReturnType<GitHubAccountSelectionPorts["check"]>> => ({
      state,
      message: redactCredentials(
        ports.redactDiagnostic(executor ? executor.redact(detail) : detail)
      ).slice(0, 4000)
    });
    try {
      const selectedExecutor = await ports.createExecutor(login);
      executor = selectedExecutor;
      if (executor.login !== login)
        return failure(
          "ineligible",
          "The deployment credential does not match the selected GitHub account."
        );
      const inspect = async (path: string, capability: string) => {
        const result = await selectedGhApiJson(selectedExecutor, path);
        if (result.ok) return result;
        return failure(
          (
            result.status === 401 ||
              result.status === 403 ||
              result.status === 404
          ) ?
            "ineligible"
          : "unavailable",
          `Could not verify deployment access to ${capability} for @${login} on ${target.repo}. ${result.stderr}`
        );
      };
      const repository = await inspect(
        `repos/${target.repo}`,
        "the repository"
      );
      if ("state" in repository) return repository;
      if (!record(repository.json))
        return failure(
          "unavailable",
          "GitHub returned invalid deployment repository evidence."
        );
      if (isGitHubAppBotLogin(login)) {
        for (const probe of installationReads) {
          const result = await inspect(
            probe.path(target.repo),
            probe.capability
          );
          if ("state" in result) return result;
          if (!probe.valid(result.json))
            return failure(
              "unavailable",
              `GitHub returned invalid ${probe.capability} evidence for deployment.`
            );
        }
        // Read access is not write authorization: dispatch and conditional
        // workflow/secret mutations remain subject to GitHub enforcement.
        return { state: "eligible" };
      }
      const permissions = repository.json.permissions;
      if (!record(permissions))
        return failure(
          "unavailable",
          "GitHub did not provide repository write permissions for deployment."
        );
      if (permissions.push === true || permissions.admin === true)
        return { state: "eligible" };
      if (permissions.push === false)
        return failure(
          "ineligible",
          `@${login} needs repository write access to deploy to ${target.repo}.`
        );
      return failure(
        "unavailable",
        "GitHub returned invalid repository write permissions for deployment."
      );
    } catch (error) {
      return failure(
        error instanceof SelectedGhIdentityError && error.authorizationDenied ?
          "ineligible"
        : "unavailable",
        `Could not verify the selected deployment account: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}
