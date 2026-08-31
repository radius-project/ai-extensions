import { DELETE_ENV_GUARD_STEP_NAME } from "@radius-project/core";

// One step of a completed delete-environment workflow run, narrowed to the two
// fields the classifier needs.
export interface DeleteEnvRunStep {
  name?: string;
  conclusion?: string | null;
}

// The mutually exclusive results of a *completed* delete-environment run.
export type DeleteEnvRunClassification =
  | { outcome: "deleted" }
  | { outcome: "apps_present"; detail: string }
  | { outcome: "failed"; detail: string };

// Classify a finished delete-environment workflow run. A "success" conclusion is
// a clean delete. Otherwise, when the named guard step is the failure the
// environment still has deployed applications and was left untouched
// (fail-closed): the user must delete their application(s) first. Any other
// non-success conclusion is a generic failure.
export function classifyCompletedDeleteEnvRun(
  conclusion: string | null | undefined,
  steps: readonly DeleteEnvRunStep[]
): DeleteEnvRunClassification {
  if (conclusion === "success") return { outcome: "deleted" };
  const guardFailed = steps.some(
    (step) =>
      step &&
      step.name === DELETE_ENV_GUARD_STEP_NAME &&
      step.conclusion === "failure"
  );
  if (guardFailed) {
    return {
      outcome: "apps_present",
      detail:
        "The environment still has one or more deployed applications. Delete the application(s) first, then delete the environment."
    };
  }
  return {
    outcome: "failed",
    detail: `The delete-environment workflow finished with conclusion "${
      conclusion || "unknown"
    }".`
  };
}
