export interface GitHubAccountSelectionTarget {
  readonly repo: string;
  readonly environment: string;
}

export type GitHubAccountEligibility =
  | { state: "eligible" }
  | { state: "ineligible"; message: string }
  | { state: "unavailable"; message: string };

export interface GitHubAccountSelectionPorts {
  listLogins(): Promise<readonly string[]>;
  check(
    login: string,
    target: GitHubAccountSelectionTarget
  ): Promise<GitHubAccountEligibility>;
  choose?(input: {
    target: GitHubAccountSelectionTarget;
    logins: readonly string[];
  }): Promise<string | null>;
  isCurrent(): boolean;
}

export type GitHubAccountSelection =
  | { state: "selected"; login: string }
  | { state: "choice-required"; logins: readonly string[] }
  | { state: "reauthorization-required"; login?: string; message: string }
  | { state: "unavailable"; message: string }
  | { state: "stopped" | "declined" | "stale-choice" };

export async function selectGitHubAccount(
  input: { target: GitHubAccountSelectionTarget; savedLogin?: string },
  ports: GitHubAccountSelectionPorts
): Promise<GitHubAccountSelection> {
  const target = Object.freeze({ ...input.target });
  const verify = async (login: string): Promise<GitHubAccountSelection> => {
    const result = await ports.check(login, target);
    if (!ports.isCurrent()) return { state: "stopped" };
    if (result.state === "eligible") return { state: "selected", login };
    if (result.state === "unavailable") return result;
    return {
      state: "reauthorization-required",
      login,
      message: result.message
    };
  };
  if (!ports.isCurrent()) return { state: "stopped" };
  if (input.savedLogin !== undefined) {
    if (!input.savedLogin.trim()) {
      return {
        state: "reauthorization-required",
        message:
          "The saved GitHub account is missing. Reauthorize the original account before continuing."
      };
    }
    return verify(input.savedLogin);
  }
  const logins = await ports.listLogins();
  if (!ports.isCurrent()) return { state: "stopped" };
  const distinct = new Map<string, string>();
  for (const login of logins) {
    if (!login.trim())
      throw new Error("GitHub account discovery returned an empty login.");
    if (!distinct.has(login.toLowerCase()))
      distinct.set(login.toLowerCase(), login);
  }
  const eligible: string[] = [];
  for (const login of distinct.values()) {
    const result = await ports.check(login, target);
    if (!ports.isCurrent()) return { state: "stopped" };
    if (result.state === "unavailable") return result;
    if (result.state === "eligible") eligible.push(login);
  }
  if (eligible.length === 0) {
    return {
      state: "reauthorization-required",
      message:
        "No GitHub account has verified access to this target. Authenticate or reauthorize an account and retry."
    };
  }
  if (eligible.length === 1) return verify(eligible[0]);
  if (!ports.choose) return { state: "choice-required", logins: eligible };
  const selected = await ports.choose({
    target,
    logins: Object.freeze(eligible)
  });
  if (!ports.isCurrent()) return { state: "stopped" };
  if (selected === null) return { state: "declined" };
  if (!eligible.includes(selected)) return { state: "stale-choice" };
  return verify(selected);
}
