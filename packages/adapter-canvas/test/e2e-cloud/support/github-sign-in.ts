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
  "gh auth refresh -h github.com -s read:packages,delete:packages";

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

  const loginResult = runGh(["api", "user", "--jq", ".login"], {
    ...sessionEnv,
    GH_TOKEN: token
  });
  const login = loginResult.stdout.trim();
  if (loginResult.status !== 0 || !GITHUB_LOGIN_PATTERN.test(login))
    throw new Error(
      "Could not read the login of your gh session" +
        describeFailure(loginResult, token) +
        " Check `gh auth status -h github.com`."
    );
  return { token, login };
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
 * to renew: the session outlives the run.
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
