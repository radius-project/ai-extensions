import type { CanvasState } from "./shared.js";

export interface AppModelAuthoringFailure {
  readonly attemptToken: string;
  readonly error: string;
  // Retained for an already-recorded commit-only failure.
  readonly commit?: string;
  readonly sourceRevision?: string;
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
 * Ends a recorded failure after a source change. If the original revision was
 * unavailable, establish a baseline first so later edits can release the fence.
 */
export async function reconcileAppModelAuthoringFailure(
  state: CanvasState,
  repo: string,
  branch: string,
  readRevision: () => Promise<string>,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const failure = appModelAuthoringFailure(state, repo, branch);
  if (!failure) return;
  let current: string;
  try {
    current = await readRevision();
  } catch {
    return;
  }
  if (!current) return;
  if (!isCurrent() || appModelAuthoringFailure(state, repo, branch) !== failure)
    return;
  const recorded = failure.sourceRevision ?? failure.commit;
  if (!recorded) {
    state.appModelFailures ??= {};
    state.appModelFailures[appModelTargetKey(repo, branch)] = {
      ...failure,
      sourceRevision: current
    };
    return;
  }
  if (current === recorded) return;
  clearAppModelAuthoringFailure(state, repo, branch);
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
