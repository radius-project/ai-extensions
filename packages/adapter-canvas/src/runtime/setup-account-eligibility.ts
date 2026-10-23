import type { GitHubAccountSelectionPorts } from "@radius-project/core";
import type { GitHubAccountReadinessService } from "../server/services/github-account-readiness.js";

export function createSetupAccountEligibility(
  readiness: GitHubAccountReadinessService
): GitHubAccountSelectionPorts["check"] {
  return async (login, target) => {
    const result = await readiness.check({ ...target, login });
    if (result.ready) return { state: "eligible" };
    const failures = Object.values(result.checks).filter(
      (check) => check.state !== "ready"
    );
    return {
      state:
        failures.some((check) => check.state === "error") ? "unavailable" : (
          "ineligible"
        ),
      message:
        failures.map((check) => check.detail).join("\n") || result.summary
    };
  };
}
