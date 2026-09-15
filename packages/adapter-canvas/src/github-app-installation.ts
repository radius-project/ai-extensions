export interface GitHubAppInstallation {
  readonly login: string;
  readonly permissions: Readonly<Record<string, string>>;
}

const REQUIRED_SETUP_PERMISSIONS = {
  actions: "write",
  actions_variables: "write",
  contents: "write",
  deployments: "read",
  environments: "write",
  pull_requests: "write",
  secrets: "write",
  workflows: "write"
} as const;

function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null) return null;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

export function parseGitHubAppInstallation(
  value: unknown
): GitHubAppInstallation | null {
  if (typeof value !== "object" || value === null) return null;
  const appSlug = Reflect.get(value, "app_slug");
  const permissions = stringRecord(Reflect.get(value, "permissions"));
  if (typeof appSlug !== "string" || appSlug.trim() === "" || !permissions)
    return null;
  return {
    login: `${appSlug.trim()}[bot]`,
    permissions
  };
}

export function missingGitHubAppSetupPermissions(
  installation: GitHubAppInstallation
): string[] {
  return Object.entries(REQUIRED_SETUP_PERMISSIONS)
    .filter(([permission, access]) => {
      const granted = installation.permissions[permission];
      return access === "write" ? granted !== "write" : !granted;
    })
    .map(([permission]) => permission);
}
