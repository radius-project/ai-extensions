// Proof that the setup pull request landed, for the one retry that depends on
// it. Kept out of the route so the decision is testable without HTTP and so the
// route keeps a single narrow port instead of a GitHub client.

import {
  isMergedPullRequestBody,
  parsePullRequestUrl
} from "./pull-request-url.js";

export interface PullRequestJsonResponse {
  ok: boolean;
  json: unknown;
}

export type PullRequestJsonFetch = (
  apiPath: string
) => Promise<PullRequestJsonResponse>;

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
  const reference = parsePullRequestUrl(pullRequestUrl, operationRepo);
  if (!reference) return false;
  const result = await fetchJson(
    `repos/${reference.repo}/pulls/${reference.number}`
  );
  if (!result?.ok) return false;
  return isMergedPullRequestBody(result.json);
}
