export function isGitHubAppBotLogin(login: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\[bot\]$/i.test(login.trim());
}

export function isGitHubAppUserEndpointFailure(detail: string): boolean {
  return /resource not accessible by integration/i.test(detail);
}
