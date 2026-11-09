import {
  assertSetupExecutionActive,
  isSetupExecutionInterrupted,
  redactCredentials,
  selectGitHubAccount,
  type GitHubAccountSelection,
  type GitHubAccountSelectionPorts,
  type GitHubAccountSelectionTarget
} from "@radius-project/core";
import type { GitHubIdentity, SelectedGhExecutor } from "../gh.js";
import type { GitHubAccountReadinessService } from "../server/services/github-account-readiness.js";
import type { EnvironmentExecutionOwner } from "./environment-execution-owner.js";

export interface DeploymentAccountPorts {
  readIdentity(): Promise<Pick<GitHubIdentity, "accounts">>;
  readiness: GitHubAccountReadinessService;
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  choose?: GitHubAccountSelectionPorts["choose"];
  redactDiagnostic(value: string): string;
  readinessOwner: Pick<
    EnvironmentExecutionOwner,
    "runReadiness" | "isShuttingDown"
  >;
  logDiagnostic(message: string): void;
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
          const readiness = await ports.readinessOwner.runReadiness(
            async (reportRestorationFailure) => {
              let reported = false;
              return ports.readiness.check({
                ...target,
                login,
                assertActive: () =>
                  assertSetupExecutionActive(
                    () =>
                      !input.isCurrent() ||
                      ports.readinessOwner.isShuttingDown()
                  ),
                reportRestoration: (restoration) => {
                  if (reported) return;
                  reported = true;
                  if (restoration.state === "failed")
                    reportRestorationFailure();
                  try {
                    ports.logDiagnostic(
                      redact(
                        restoration.guidance ||
                          (restoration.state === "failed" ?
                            "GitHub account restoration failed"
                          : "GitHub CLI account changed externally")
                      )
                    );
                  } catch {
                    // Diagnostics cannot replace restoration evidence or settlement.
                  }
                }
              });
            }
          );
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
      if (
        isSetupExecutionInterrupted(error) ||
        !input.isCurrent() ||
        ports.readinessOwner.isShuttingDown()
      )
        return { state: "stopped" };
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
