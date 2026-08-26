// Proof that the setup pull request landed, for the one retry that depends on
// it. Kept out of the route so the decision is testable without HTTP and so the
// route keeps a single narrow port instead of a GitHub client.

import {
  isMergedPullRequestBody,
  parsePullRequestUrl
} from "./pull-request-url.js";
import type { SelectedGhExecutor } from "../../gh.js";

export interface PullRequestJsonResponse {
  ok: boolean;
  json: unknown;
  error?: string;
}

export type PullRequestJsonFetch = (
  apiPath: string
) => Promise<PullRequestJsonResponse>;

export type SetupPullRequestMergeCheck =
  | { state: "merged" }
  | { state: "open" }
  | { state: "unavailable"; detail: string };

export type SelectedAccountSetupPullRequestMergeCheck =
  | { state: "merged" }
  | { state: "open" }
  | { state: "unavailable"; login: string; detail: string };

export interface SetupPullRequestOperation {
  repo?: unknown;
  context?: unknown;
  [key: string]: unknown;
}

export interface SelectedAccountPullRequestPorts {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  fetchJson(
    executor: SelectedGhExecutor,
    apiPath: string
  ): Promise<PullRequestJsonResponse>;
  errorMessage(error: unknown): string;
}

export async function checkSetupPullRequestMerge(
  operationRepo: string,
  pullRequestUrl: string | null | undefined,
  fetchJson: PullRequestJsonFetch
): Promise<SetupPullRequestMergeCheck> {
  const reference = parsePullRequestUrl(pullRequestUrl, operationRepo);
  if (!reference) {
    return {
      state: "unavailable",
      detail:
        "The saved setup pull request URL is missing, invalid, or names another repository."
    };
  }

  const result = await fetchJson(
    `repos/${reference.repo}/pulls/${reference.number}`
  );
  if (!result?.ok) {
    return {
      state: "unavailable",
      detail:
        result?.error ||
        "The selected GitHub account could not read the setup pull request."
    };
  }
  return isMergedPullRequestBody(result.json) ?
      { state: "merged" }
    : { state: "open" };
}

export async function checkSetupPullRequestMergeForOperation(
  operation: SetupPullRequestOperation,
  pullRequestUrl: string | null | undefined,
  ports: SelectedAccountPullRequestPorts
): Promise<SelectedAccountSetupPullRequestMergeCheck> {
  const context = operation.context;
  const login =
    (
      typeof context === "object" &&
      context !== null &&
      "githubLogin" in context &&
      typeof context.githubLogin === "string"
    ) ?
      context.githubLogin.trim()
    : "";
  if (!login) {
    return {
      state: "unavailable",
      login: "",
      detail: "The operation has no saved GitHub account."
    };
  }

  try {
    const executor = await ports.createExecutor(login);
    const check = await checkSetupPullRequestMerge(
      String(operation.repo || ""),
      pullRequestUrl,
      (apiPath) => ports.fetchJson(executor, apiPath)
    );
    return check.state === "unavailable" ? { ...check, login } : check;
  } catch (error) {
    return {
      state: "unavailable",
      login,
      detail: ports.errorMessage(error)
    };
  }
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
  return (
    (await checkSetupPullRequestMerge(operationRepo, pullRequestUrl, fetchJson))
      .state === "merged"
  );
}
