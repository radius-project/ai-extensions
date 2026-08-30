// Stage two of the cloud journey: deleting the environment stage one created.
//
// Every decision the stage makes lives here as a pure function, because a rule
// written in the spec could only ever be checked by a nightly run against real
// infrastructure. These are checked by `delete-environment-journey.test.ts` on
// every pull request instead.

/** The path the environments page posts to. Mirrors the browser's constant. */
export const DELETE_ENVIRONMENT_PATH = "/api/delete-environment";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined;
}

export interface DeleteEnvironmentOutcome {
  readonly status: number;
  readonly payload: unknown;
  readonly environmentName: string;
}

/**
 * Everything wrong with how the product answered a legitimate delete.
 *
 * An environment with nothing deployed to it deletes cleanly: the handler's
 * `resolveEnvDeployment` check finds no active deployment, the `app-deployed`
 * guard does not fire, and the GitHub Environment is removed. Anything other
 * than a 200 carrying `success` means the product refused, failed closed, or
 * reported an outcome the environments page cannot act on — so the reason it
 * gave is quoted rather than summarised, since a nightly run's failure message
 * is the only diagnostic anyone gets.
 */
export function findDeleteEnvironmentSuccessProblems(
  outcome: DeleteEnvironmentOutcome
): string[] {
  const record = asRecord(outcome.payload);
  if (outcome.status !== 200) {
    const error = record?.error;
    const detail =
      typeof error === "string" && error.trim() !== "" ? `: ${error}` : ".";
    const code = record?.code;
    const codeDetail =
      typeof code === "string" && code.trim() !== "" ? ` (code "${code}")` : "";
    return [
      `Deleting environment "${outcome.environmentName}" answered ${outcome.status}, not 200${codeDetail}${detail}`
    ];
  }
  if (!record)
    return [
      `Deleting environment "${outcome.environmentName}" answered 200 but its body was not a JSON object: ` +
        `${JSON.stringify(outcome.payload)}`
    ];
  if (record.success !== true)
    return [
      `Deleting environment "${outcome.environmentName}" answered 200 but did not report success: ` +
        `${JSON.stringify(outcome.payload)}`
    ];
  return [];
}

/**
 * Renders findings as an assertion message.
 *
 * Returns an empty string when there is nothing wrong, so it can be passed
 * straight to `expect(value, message)` without a conditional at the call site.
 */
export function describeProblems(
  problems: readonly string[],
  headline: string
): string {
  if (problems.length === 0) return "";
  return `${headline}\n${problems.map((problem) => `  - ${problem}`).join("\n")}`;
}
