// How a cloud run signs in to GitHub.
//
// CI signs in as the fixture's GitHub App and renews its token between stages.
// The App is installed only on the shared fixture repository, so a developer
// running locally against their own fixture copy signs in with their own `gh`
// session instead. That is allowed only outside CI, and only for a copy outside
// `radius-project`, so it can never reach the shared fixture.
//
// The session token goes only into this process's environment. It is never
// passed as a command argument, and every error built here is redacted.
//
// The journey runs for hours on the token read at the start, so a session
// whose token expires is refused before the run starts. GitHub names the
// expiry of an expiring token in the GitHub-Authentication-Token-Expiration
// header of every API response:
// https://github.blog/changelog/2021-07-26-expiration-options-for-personal-access-tokens/
import { spawnSync } from "node:child_process";
import { redactCredentials } from "../../../src/credential-redaction.js";
import { describeError } from "./cloud-command-port.js";
import {
  refreshProcessGitHubToken,
  type GitHubAppTokenConfig
} from "./github-app-token.js";
import {
  FIXTURE_REPO_OWNER,
  isContinuousIntegration,
  PINNED_FIXTURE,
  resolveFixtureSelection,
  type FixtureSelection
} from "./fixture-repository.js";

/** CI's GitHub App, or a developer's own `gh` session. */
export type GitHubSignIn = "github-app" | "gh-session";

export interface GhCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh` with exactly the environment given. */
export type RunGh = (
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => GhCommandResult;

export interface GhSessionCredentials {
  readonly token: string;
  readonly login: string;
}

/** The fixture a run uses and how it signs in. */
export interface CloudRunPreparation {
  readonly fixture: FixtureSelection;
  readonly signIn: GitHubSignIn;
  /** Why the run cannot start. The journey's gate fails with it. */
  readonly failure?: string;
}

const UNPREPARED: CloudRunPreparation = {
  fixture: PINNED_FIXTURE,
  signIn: "github-app"
};

const GH_SESSION_TIMEOUT_MS = 30_000;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REFRESH_COMMAND =
  "gh auth refresh -h github.com -s workflow,read:packages,write:packages,delete:packages";
const TOKEN_EXPIRATION_HEADER = "github-authentication-token-expiration";

/**
 * Uses the `gh` session only outside CI and only for a fixture copy outside
 * `radius-project`. Everything else keeps the GitHub App.
 */
export function selectGitHubSignIn(
  fixture: FixtureSelection,
  env: NodeJS.ProcessEnv = process.env
): GitHubSignIn {
  if (isContinuousIntegration(env) || !fixture.overridden) return "github-app";
  const owner = fixture.repository.slice(0, fixture.repository.indexOf("/"));
  return owner.toLowerCase() === FIXTURE_REPO_OWNER.toLowerCase() ?
      "github-app"
    : "gh-session";
}

/**
 * Reads the developer's stored `gh` session for github.com and its login.
 *
 * `gh auth token` prints an inherited GH_TOKEN or GITHUB_TOKEN instead of the
 * stored session, so both are removed first, along with GH_HOST.
 */
export function readGhSessionCredentials(
  runGh: RunGh,
  env: NodeJS.ProcessEnv = process.env
): GhSessionCredentials {
  const sessionEnv: NodeJS.ProcessEnv = { ...env };
  delete sessionEnv.GH_TOKEN;
  delete sessionEnv.GITHUB_TOKEN;
  delete sessionEnv.GH_HOST;

  const tokenResult = runGh(
    ["auth", "token", "--hostname", "github.com"],
    sessionEnv
  );
  const token = tokenResult.stdout.trim();
  if (tokenResult.status !== 0 || !token || /\s/.test(token))
    throw new Error(
      "Could not read your gh session for github.com" +
        describeFailure(tokenResult, token) +
        " Run `gh auth login -h github.com`, then `" +
        GH_REFRESH_COMMAND +
        "`."
    );

  // One request reads the login and the headers that say whether the token
  // expires. Anything it can't read refuses the run.
  const userResult = runGh(["api", "user", "--include"], {
    ...sessionEnv,
    GH_TOKEN: token
  });
  const user =
    userResult.status === 0 ? parseIncludedResponse(userResult.stdout) : null;
  const login = user?.login ?? "";
  if (!user || !GITHUB_LOGIN_PATTERN.test(login))
    throw new Error(
      "Could not read the login of your gh session" +
        describeFailure(userResult, token) +
        " Check `gh auth status -h github.com`."
    );
  const expiration = user.headers.get(TOKEN_EXPIRATION_HEADER);
  if (expiration !== undefined)
    throw new Error(
      `Your gh session's token expires (${redactCredentials(expiration, [token]).trim()}), so it could stop working partway through the run. Sign in with a gh session that doesn't expire: run \`gh auth login -h github.com\` and choose to log in with a web browser, then \`${GH_REFRESH_COMMAND}\`.`
    );
  return { token, login };
}

// What `gh api --include` prints for a 200: the status line, headers, a
// blank line, and the JSON body. Null for anything else. Header names are
// lowercased, because HTTP header names ignore case.
function parseIncludedResponse(
  stdout: string
): { headers: Map<string, string>; login: string } | null {
  const lines = stdout.split(/\r?\n/);
  if (!/^HTTP\/[\d.]+ 200\b/.test(lines[0] ?? "")) return null;
  const end = lines.indexOf("", 1);
  if (end < 0) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim()
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(lines.slice(end + 1).join("\n"));
  } catch {
    return null;
  }
  const login = (body as { login?: unknown } | null)?.login;
  return { headers, login: typeof login === "string" ? login : "" };
}

/**
 * Sets the session for everything this process runs: the product, the
 * fixture's `gh` calls, and the package calls. The session is for github.com,
 * so an inherited GH_HOST is removed too.
 */
export function applyGhSessionCredentials(
  credentials: GhSessionCredentials,
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.GH_HOST;
  env.GH_TOKEN = credentials.token;
  env.GITHUB_TOKEN = credentials.token;
  env.GH_PACKAGES_TOKEN = credentials.token;
  env.GH_PACKAGES_USER = credentials.login;
}

/**
 * Resolves the fixture and signs in with the `gh` session when that applies.
 * A run that didn't set RADIUS_CLOUD_E2E reads nothing and runs nothing.
 */
export function prepareCloudRun(
  runGh: RunGh,
  env: NodeJS.ProcessEnv = process.env
): CloudRunPreparation {
  if (!env.RADIUS_CLOUD_E2E?.trim()) return UNPREPARED;
  let fixture: FixtureSelection;
  try {
    fixture = resolveFixtureSelection(env);
  } catch (error) {
    return { ...UNPREPARED, failure: describeError(error) };
  }
  const signIn = selectGitHubSignIn(fixture, env);
  if (signIn === "gh-session")
    try {
      applyGhSessionCredentials(readGhSessionCredentials(runGh, env), env);
    } catch (error) {
      return { fixture, signIn, failure: describeError(error) };
    }
  return { fixture, signIn };
}

/**
 * Renews the GitHub App token between stages. A `gh` session run has nothing
 * to renew: sign-in refused a session whose token expires.
 */
export function createGitHubTokenRefresh(
  signIn: GitHubSignIn,
  appConfig: GitHubAppTokenConfig | null,
  refresh: (
    config: GitHubAppTokenConfig
  ) => Promise<void> = refreshProcessGitHubToken
): () => Promise<void> {
  if (signIn === "gh-session") return () => Promise.resolve();
  return async () => {
    if (!appConfig)
      throw new Error(
        "GitHub App refresh credentials are required for the cloud lifecycle journey."
      );
    await refresh(appConfig);
  };
}

/** The production `gh` runner. It never inherits stdin, so it can't prompt. */
export function runGhSync(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): GhCommandResult {
  const result = spawnSync("gh", [...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_SESSION_TIMEOUT_MS,
    windowsHide: true
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || ""
  };
}

function describeFailure(result: GhCommandResult, token: string): string {
  // stdout is never echoed: on success it is the token itself.
  const detail = redactCredentials(result.stderr, [token]).trim();
  return detail ? `: ${detail}.` : ".";
}
