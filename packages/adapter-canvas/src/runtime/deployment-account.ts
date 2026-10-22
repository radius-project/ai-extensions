import {
  redactCredentials,
  selectGitHubAccount,
  type GitHubAccountSelection,
  type GitHubAccountSelectionPorts,
  type GitHubAccountSelectionTarget
} from "@radius-project/core";
import type { GitHubIdentity, SelectedGhExecutor } from "../gh.js";
import type { GitHubAccountReadinessService } from "../server/services/github-account-readiness.js";

export interface DeploymentAccountPorts {
  readIdentity(): Promise<Pick<GitHubIdentity, "accounts">>;
  readiness: GitHubAccountReadinessService;
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  choose?: GitHubAccountSelectionPorts["choose"];
  redactDiagnostic(value: string): string;
}

export type DeploymentAccountSelection =
  | Exclude<GitHubAccountSelection, { state: "selected" }>
  | { state: "selected"; login: string; executor: SelectedGhExecutor };

export function createDeploymentAccountResolver(ports: DeploymentAccountPorts) {
  const redact = (value: string) =>
    redactCredentials(ports.redactDiagnostic(value)).slice(0, 4000);
  return async (input: {
    target: GitHubAccountSelectionTarget;
    savedLogin?: string;
    isCurrent(): boolean;
  }): Promise<DeploymentAccountSelection> => {
    try {
      const selected = await selectGitHubAccount(input, {
        listLogins: async () =>
          (await ports.readIdentity()).accounts.map(({ login }) => login),
        check: async (login, target) => {
          const readiness = await ports.readiness.check({ ...target, login });
          if (readiness.ready) return { state: "eligible" };
          const failures = Object.values(readiness.checks).filter(
            (check) => check.state !== "ready"
          );
          return {
            state:
              failures.some((check) => check.state === "error") ? "unavailable"
              : "ineligible",
            message: redact(
              failures.map((check) => check.detail).join("\n") ||
                readiness.summary
            )
          };
        },
        choose: ports.choose,
        isCurrent: input.isCurrent
      });
      if (selected.state !== "selected") return selected;
      const executor = await ports.createExecutor(selected.login);
      if (!input.isCurrent()) return { state: "stopped" };
      if (executor.login !== selected.login) {
        return {
          state: "unavailable",
          message:
            "The selected GitHub credential no longer matches the authorized account. Reauthorize that account before continuing."
        };
      }

      return { ...selected, executor };
    } catch (error) {
      return {
        state: "unavailable",
        message: redact(error instanceof Error ? error.message : String(error))
      };
    }
  };
}

export type DeploymentAccountResolver = ReturnType<
  typeof createDeploymentAccountResolver
>;
