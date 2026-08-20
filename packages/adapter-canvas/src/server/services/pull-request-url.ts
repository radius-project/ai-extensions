// The one place a setup pull request URL is read and a merge is believed.
//
// Two callers ask GitHub the same two questions — "which pull request is this
// URL?" and "has it landed?" — from different seams: the verification retry
// port and the post-commit rollback port. Written twice, the two answers could
// disagree about what counts as merged, and a rollback that trusts a looser
// definition than the retry does would revert a workflow the repository is
// still running. Both are fail-closed: an unrecognised URL names nothing, and
// only a strict `merged: true` or a non-blank `merged_at` string is a merge.

const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/;

export interface PullRequestReference {
  repo: string;
  number: string;
}

/**
 * The repository and number a setup pull request URL names, or null.
 *
 * `expectedRepo` is the operation's own repository: a URL naming some other
 * repository is refused rather than followed, so a saved record cannot send a
 * read — or a revert — at a repository this operation never wrote to.
 */
export function parsePullRequestUrl(
  pullRequestUrl: string | null | undefined,
  expectedRepo?: string | null
): PullRequestReference | null {
  const match = PULL_REQUEST_URL_PATTERN.exec(
    String(pullRequestUrl || "").trim()
  );
  if (!match) return null;
  const [, repo, number] = match;
  if (expectedRepo && expectedRepo !== repo) return null;
  return { repo, number };
}

/** Whether a pull request payload proves the branch landed. */
export function isMergedPullRequestBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const detail = body as Record<string, unknown>;
  if (detail.merged === true) return true;
  return typeof detail.merged_at === "string" && detail.merged_at.trim() !== "";
}
