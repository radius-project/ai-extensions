import type { CanvasState } from "./shared.js";

export interface AppModelAuthoringFailure {
  readonly attemptToken: string;
  readonly error: string;
  readonly commit?: string;
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
 * Ends a recorded failure when the branch is at a new commit. It keeps the
 * failure when the commit is unknown, cannot be read, or is unchanged. It also
 * keeps a failure that was replaced while the commit was being read.
 */
export async function reconcileAppModelAuthoringFailure(
  state: CanvasState,
  repo: string,
  branch: string,
  readCommit: () => Promise<string>
): Promise<void> {
  const failure = appModelAuthoringFailure(state, repo, branch);
  if (!failure?.commit) return;
  let current: string;
  try {
    current = await readCommit();
  } catch {
    return;
  }
  if (!current || current === failure.commit) return;
  if (appModelAuthoringFailure(state, repo, branch) !== failure) return;
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
