export function isGitHubAppBotLogin(login: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\[bot\]$/i.test(login.trim());
}

export function isGitHubAppUserEndpointFailure(detail: string): boolean {
  return /resource not accessible by integration/i.test(detail);
}

/**
 * The resource an App installation must be able to read before Radius claims it
 * can configure deployments.
 *
 * An installation token reports no OAuth scopes, and `GET /installation` is
 * JWT-only, so the granted permissions cannot be read back directly. No GitHub
 * endpoint proves *write* access without performing the write, so this probes
 * the exact resource the readiness check reports on. Listing deployment
 * environments requires a granted repository permission and is never readable
 * anonymously through an installation token, so a failure separates a usable
 * installation from one that merely has a bot-shaped login. GitHub still
 * enforces the write permission when the environment is actually created.
 */
export function gitHubAppAccessProbePath(repo: string): string {
  return `repos/${repo}/environments`;
}

export function describeMissingGitHubAppAccess(
  login: string,
  repo: string
): string {
  return `@${login} is a GitHub App installation that cannot read deployment environments for ${repo}. Install the app on ${repo} and grant it the Actions, Environments, Secrets, Variables, and Workflows repository permissions, then retry.`;
}
