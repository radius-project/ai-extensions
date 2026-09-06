import type { CanvasState } from "./shared.js";

export interface AppModelAuthoringFailure {
  readonly attemptToken: string;
  readonly error: string;
}

export function appModelTargetKey(repo: string, branch: string): string {
  return `${repo}::${branch}`;
}

export function appModelAuthoringFailure(
  state: CanvasState,
  repo: string,
  branch: string
): AppModelAuthoringFailure | null {
  const target = appModelTargetKey(repo, branch);
  const failure = state.appModelFailures?.[target];
  if (
    !failure ||
    state.appModelAttemptTokens?.[target] !== failure.attemptToken
  ) {
    return null;
  }
  return failure;
}

export function clearAppModelAuthoringFailure(
  state: CanvasState,
  repo: string,
  branch: string
): void {
  const target = appModelTargetKey(repo, branch);
  if (state.appModelFailures) delete state.appModelFailures[target];
  if (state.appModelAttemptTokens) delete state.appModelAttemptTokens[target];
}
