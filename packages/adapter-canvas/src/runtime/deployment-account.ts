import {
  redactCredentials,
  selectGitHubAccount,
  type GitHubAccountSelection,
  type GitHubAccountSelectionPorts,
  type GitHubAccountSelectionTarget
} from "@radius-project/core";
import type { GitHubIdentity, SelectedGhExecutor } from "../gh.js";

export interface DeploymentAccountPorts {
  readIdentity(): Promise<Pick<GitHubIdentity, "accounts">>;
  check: GitHubAccountSelectionPorts["check"];
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
          const result = await ports.check(login, target);
          return result.state === "eligible" ?
              result
            : { ...result, message: redact(result.message) };
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
