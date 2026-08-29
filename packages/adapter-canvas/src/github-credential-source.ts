export function githubCredentialSourceLabel(source: string): string {
  return source === "injected" || source === "injected-token" ?
      "the Copilot session token"
    : "the stored GitHub CLI credential";
}
