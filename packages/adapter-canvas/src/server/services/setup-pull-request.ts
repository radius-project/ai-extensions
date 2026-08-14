// Proof that the setup pull request landed, for the one retry that depends on
// it. Kept out of the route so the decision is testable without HTTP and so the
// route keeps a single narrow port instead of a GitHub client.

export interface PullRequestJsonResponse {
  ok: boolean;
  json: unknown;
}

export type PullRequestJsonFetch = (
  apiPath: string
) => Promise<PullRequestJsonResponse>;

const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/;

function readMergeState(value: unknown): {
  merged: unknown;
  mergedAt: unknown;
} {
  if (!value || typeof value !== "object")
    return { merged: null, mergedAt: null };
  const detail = value as Record<string, unknown>;
  return { merged: detail.merged, mergedAt: detail.merged_at };
}

/**
 * Whether the setup pull request has landed on the target branch.
 *
 * Fails closed: an unrecognised URL, a pull request in some other repository,
 * an unreadable response, or a GitHub error all mean "not merged". Retrying
 * verification against a branch that does not yet carry the workflow only
 * produces a second, more confusing failure.
 */
export async function isSetupPullRequestMerged(
  operationRepo: string,
  pullRequestUrl: string | null | undefined,
  fetchJson: PullRequestJsonFetch
): Promise<boolean> {
  const url = String(pullRequestUrl || "").trim();
  const match = PULL_REQUEST_URL_PATTERN.exec(url);
  if (!match) return false;
  const [, repo, number] = match;
  if (operationRepo && operationRepo !== repo) return false;
  const result = await fetchJson(`repos/${repo}/pulls/${number}`);
  if (!result?.ok) return false;
  const { merged, mergedAt } = readMergeState(result.json);
  return merged === true || (mergedAt != null && mergedAt !== "");
}
