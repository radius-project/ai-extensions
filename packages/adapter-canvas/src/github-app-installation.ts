export function isGitHubAppBotLogin(login: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\[bot\]$/i.test(login.trim());
}

export function isGitHubAppUserEndpointFailure(detail: string): boolean {
  return /resource not accessible by integration/i.test(detail);
}

/**
 * The resources an App installation must be able to read before Radius claims
 * it can configure deployments.
 *
 * An installation token reports no OAuth scopes, and `GET /installation` is
 * JWT-only, so the granted permissions cannot be read back directly. No GitHub
 * endpoint proves *write* access without performing the write, so each entry
 * below reads the cheapest resource gated on a distinct repository permission
 * that this setup path later writes. A read failure proves the permission is
 * absent; a read success proves only that the category was granted, and GitHub
 * still enforces the write level at the mutation.
 *
 * Probing every category matters because the categories are independent. An
 * installation granted only Actions can list deployment environments while
 * being unable to create one, set a secret, set a variable, or commit a
 * workflow, so a single environments probe would pass and setup would still
 * fail at its first mutation.
 *
 * `workflows` has no read-only resource to probe and is therefore the one
 * permission that stays unproven until publication attempts it.
 */
export const GITHUB_APP_ACCESS_PROBES: readonly {
  readonly path: (repo: string) => string;
  readonly permission: string;
  readonly capability: string;
}[] = [
  {
    path: (repo) => `repos/${repo}/actions/permissions`,
    permission: "Administration",
    capability: "create deployment environments"
  },
  {
    path: (repo) => `repos/${repo}/environments`,
    permission: "Environments",
    capability: "read deployment environments"
  },
  {
    path: (repo) => `repos/${repo}/actions/secrets`,
    permission: "Secrets",
    capability: "manage environment secrets"
  },
  {
    path: (repo) => `repos/${repo}/actions/variables`,
    permission: "Variables",
    capability: "manage environment variables"
  },
  {
    path: (repo) => `repos/${repo}/commits?per_page=1`,
    permission: "Contents",
    capability: "publish workflows"
  },
  {
    path: (repo) => `repos/${repo}/pulls?per_page=1`,
    permission: "Pull requests",
    capability: "open a workflow publication fallback"
  }
];

export function gitHubAppAccessProbePaths(repo: string): string[] {
  return GITHUB_APP_ACCESS_PROBES.map((probe) => probe.path(repo));
}

/**
 * The complete repository-permission union this setup path exercises.
 *
 * Listing only the permissions Radius can probe would be worse than listing
 * none: an operator would follow the message, grant exactly those, retry, and
 * fail at the first mutation the message never mentioned.
 */
const REQUIRED_GITHUB_APP_PERMISSIONS =
  "Actions (write), Administration (write), Contents (write), Deployments (read), Environments (write), Pull requests (write), Secrets (write), Variables (write), and Workflows (write)";

export function describeMissingGitHubAppAccess(
  login: string,
  repo: string,
  permission?: string
): string {
  const failed =
    permission ?
      `cannot exercise its ${permission} permission on ${repo}`
    : `cannot read ${repo}`;
  return `@${login} is a GitHub App installation that ${failed}. Install the app on ${repo} and grant it ${REQUIRED_GITHUB_APP_PERMISSIONS}, then retry.`;
}
