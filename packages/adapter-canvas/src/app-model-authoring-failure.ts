import type { CanvasState } from "./shared.js";

export interface AppModelAuthoringFailure {
  readonly attemptToken: string;
  readonly error: string;
  readonly sourceRevision?: string;
  readonly environmentKey?: string;
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

/**
 * Releases a current failure after a source or environment change, or an
 * explicit retry. Missing or different-kind source evidence sets a baseline.
 */
export async function reconcileAppModelAuthoringFailure(
  state: CanvasState,
  repo: string,
  branch: string,
  readRevision: () => Promise<string>,
  isCurrent: () => boolean = () => true,
  retry: { userRequested?: boolean; environmentKey?: string } = {}
): Promise<"checked" | "unavailable"> {
  const failure = appModelAuthoringFailure(state, repo, branch);
  if (!failure) return "checked";
  if (!isCurrent()) return "checked";
  // Graph and diff attempts record an empty key because they plan for no
  // environment, so opening the planned view is not a new target.
  if (
    retry.userRequested === true ||
    (retry.environmentKey !== undefined &&
      failure.environmentKey &&
      retry.environmentKey !== failure.environmentKey)
  ) {
    clearAppModelAuthoringFailure(state, repo, branch);
    return "checked";
  }
  let current: string;
  try {
    current = await readRevision();
  } catch {
    return "unavailable";
  }
  if (!current) return "unavailable";
  if (!isCurrent() || appModelAuthoringFailure(state, repo, branch) !== failure)
    return "checked";
  const recorded = failure.sourceRevision;
  // A workspace fingerprint and a remote commit are different kinds of
  // evidence. A context switch establishes a baseline, not proof of an edit.
  if (
    !recorded ||
    recorded.match(/^(workspace|remote):/)?.[1] !==
      current.match(/^(workspace|remote):/)?.[1]
  ) {
    state.appModelFailures ??= {};
    state.appModelFailures[appModelTargetKey(repo, branch)] = {
      ...failure,
      sourceRevision: current
    };
    return "checked";
  }
  if (current === recorded) return "checked";
  clearAppModelAuthoringFailure(state, repo, branch);
  return "checked";
}

export function clearAppModelAuthoringFailure(
  state: CanvasState,
  repo: string,
  branch: string
): void {
  const target = appModelTargetKey(repo, branch);
  if (state.appModelFailures) delete state.appModelFailures[target];
  if (state.appModelAttemptTokens) delete state.appModelAttemptTokens[target];
  if (state.appModelAttemptEnvironments)
    delete state.appModelAttemptEnvironments[target];
}
