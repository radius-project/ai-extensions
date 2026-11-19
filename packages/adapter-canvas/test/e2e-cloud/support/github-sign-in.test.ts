import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubAppTokenConfig } from "./github-app-token.js";
import {
  applyGhSessionCredentials,
  createGitHubTokenRefresh,
  prepareCloudRun,
  readGhSessionCredentials,
  runGhSync,
  selectGitHubSignIn,
  type GhCommandResult,
  type RunGh
} from "./github-sign-in.js";
import { PINNED_FIXTURE, type FixtureSelection } from "./fixture-repository.js";

// Synthetic, and long enough that redaction treats it as a credential.
const SESSION_TOKEN = "gho_SyntheticSessionToken0123456789abcdef";
const LOGIN = "octo-cat";

const copy = (repository: string): FixtureSelection => ({
  repository,
  baselineSha: "a".repeat(40),
  awsBaselineSha: "b".repeat(40),
  awsFailedDeploySha: "c".repeat(40),
  overridden: true
});

const OVERRIDE = {
  RADIUS_CLOUD_E2E: "1",
  RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY: "octo-cat/ai-extensions-fixture",
  RADIUS_CLOUD_E2E_FIXTURE_BASELINE_SHA: "a".repeat(40),
  RADIUS_CLOUD_E2E_FIXTURE_AWS_BASELINE_SHA: "b".repeat(40),
  RADIUS_CLOUD_E2E_FIXTURE_AWS_FAILED_DEPLOY_SHA: "c".repeat(40)
};

interface RecordedGh {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

// What `gh api user --include` prints: the status line, the headers, a blank
// line, and the body. gh ends the status line with \n and headers with \r\n.
function userResponse(headers: Record<string, string> = {}, login = LOGIN) {
  const lines = Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    "X-Oauth-Scopes": "repo, workflow",
    ...headers
  }).map(([name, value]) => `${name}: ${value}\r\n`);
  return `HTTP/2.0 200 OK\n${lines.join("")}\r\n${JSON.stringify({ login, id: 1 })}`;
}

/** A `gh` that answers the two sign-in calls and records how it was run. */
function fakeGh(
  responses: {
    readonly token?: Partial<GhCommandResult>;
    readonly user?: Partial<GhCommandResult>;
  } = {}
): { readonly runGh: RunGh; readonly calls: RecordedGh[] } {
  const calls: RecordedGh[] = [];
  const runGh: RunGh = (args, env) => {
    calls.push({ args: [...args], env: { ...env } });
    const response =
      args[0] === "auth" ?
        { stdout: `${SESSION_TOKEN}\n`, ...responses.token }
      : { stdout: userResponse(), ...responses.user };
    return { status: 0, stderr: "", ...response };
  };
  return { runGh, calls };
}

describe("selectGitHubSignIn", () => {
  it("uses the GitHub App for the pinned fixture", () => {
    expect(selectGitHubSignIn(PINNED_FIXTURE, {})).toBe("github-app");
  });

  it("uses the gh session for a local run against a copy outside radius-project", () => {
    expect(selectGitHubSignIn(copy("octo-cat/ai-extensions-fixture"), {})).toBe(
      "gh-session"
    );
  });

  // Refused for the shared fixture, however the override names it.
  it.each([
    "radius-project/ai-extensions-fixture",
    "Radius-Project/AI-Extensions-Fixture",
    "radius-project/some-other-copy"
  ])("keeps the GitHub App for %s", (repository) => {
    expect(selectGitHubSignIn(copy(repository), {})).toBe("github-app");
  });

  it.each(["true", "1", "false"])(
    "keeps the GitHub App when CI is %j, even for a copy",
    (ci) => {
      expect(
        selectGitHubSignIn(copy("octo-cat/ai-extensions-fixture"), { CI: ci })
      ).toBe("github-app");
    }
  );
});

describe("readGhSessionCredentials", () => {
  it("reads the stored session, not an inherited token, and never passes it as an argument", () => {
    const { runGh, calls } = fakeGh();

    expect(
      readGhSessionCredentials(runGh, {
        PATH: "/bin",
        GH_TOKEN: "inherited-token-value-0123456789",
        GITHUB_TOKEN: "inherited-token-value-0123456789",
        GH_HOST: "ghe.example.test"
      })
    ).toEqual({ token: SESSION_TOKEN, login: LOGIN });

    expect(calls.map((call) => call.args)).toEqual([
      ["auth", "token", "--hostname", "github.com"],
      ["api", "user", "--include"]
    ]);
    expect(calls[0].env).toEqual({ PATH: "/bin" });
    expect(calls[1].env).toEqual({ PATH: "/bin", GH_TOKEN: SESSION_TOKEN });
    for (const call of calls)
      expect(call.args.join(" ")).not.toContain(SESSION_TOKEN);
  });

  it.each([
    [
      "gh can't read a session",
      { status: 1, stderr: "no oauth token found for github.com" },
      "Could not read your gh session for github.com: no oauth token found for github.com."
    ],
    ["gh prints no token", { stdout: "\n" }, "Could not read your gh session"],
    [
      "gh prints more than one token",
      { stdout: `${SESSION_TOKEN}\nsecond-line` },
      "Could not read your gh session"
    ]
  ])("fails with sign-in guidance when %s", (_label, token, expected) => {
    const { runGh, calls } = fakeGh({ token });

    expect(() => readGhSessionCredentials(runGh, {})).toThrow(expected);
    expect(() => readGhSessionCredentials(runGh, {})).toThrow(
      "gh auth refresh -h github.com -s workflow,read:packages,write:packages,delete:packages"
    );
    expect(calls.every((call) => call.args[0] === "auth")).toBe(true);
  });

  it.each([
    [
      "the user lookup fails",
      { status: 1, stderr: `HTTP 401: Bad credentials for ${SESSION_TOKEN}` }
    ],
    [
      "the login is not a GitHub login",
      { stdout: userResponse({}, "not a login") }
    ],
    ["gh prints nothing", { stdout: "" }],
    ["gh prints no headers", { stdout: JSON.stringify({ login: LOGIN }) }],
    [
      "GitHub answers another status",
      { stdout: userResponse().replace("200 OK", "203 Non-Authoritative") }
    ],
    [
      "the headers never end",
      { stdout: userResponse().replace(/\r\n\{.*$/, "") }
    ],
    [
      "the body is not JSON",
      { stdout: userResponse().replace(/\{.*$/, `oops ${SESSION_TOKEN}`) }
    ]
  ])("fails without echoing the token when %s", (_label, user) => {
    const { runGh } = fakeGh({ user });

    let message = "";
    try {
      readGhSessionCredentials(runGh, {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Could not read the login of your gh session");
    expect(message).not.toContain(SESSION_TOKEN);
  });

  // A session that expires could stop working partway through the journey,
  // which runs for hours with the token it read here.
  it.each([
    "Github-Authentication-Token-Expiration",
    "github-authentication-token-expiration"
  ])("refuses a session whose token expires (%s)", (header) => {
    const { runGh } = fakeGh({
      user: { stdout: userResponse({ [header]: "2026-12-01 00:00:00 UTC" }) }
    });

    let message = "";
    try {
      readGhSessionCredentials(runGh, {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(
      "Your gh session's token expires (2026-12-01 00:00:00 UTC), so it could stop working partway through the run. Sign in with a gh session that doesn't expire: run `gh auth login -h github.com` and choose to log in with a web browser, then `gh auth refresh -h github.com -s workflow,read:packages,write:packages,delete:packages`."
    );
  });

  it("redacts the token if GitHub echoes it in the expiration", () => {
    const { runGh } = fakeGh({
      user: {
        stdout: userResponse({
          "Github-Authentication-Token-Expiration": SESSION_TOKEN
        })
      }
    });

    expect(() => readGhSessionCredentials(runGh, {})).toThrow(
      "Your gh session's token expires"
    );
    expect(() => readGhSessionCredentials(runGh, {})).not.toThrow(
      SESSION_TOKEN
    );
  });

  it("never echoes stdout from a failed token read", () => {
    const { runGh } = fakeGh({
      token: { status: 1, stdout: SESSION_TOKEN, stderr: "" }
    });

    expect(() => readGhSessionCredentials(runGh, {})).toThrow(
      /^Could not read your gh session for github\.com\. Run/
    );
  });
});

describe("applyGhSessionCredentials", () => {
  // The session belongs to github.com, so an inherited enterprise host would
  // send every later gh call to the wrong server.
  it("sets the token for gh, the product, and package calls, on github.com", () => {
    const env: NodeJS.ProcessEnv = {
      GH_PACKAGES_TOKEN: "old",
      GH_HOST: "ghe.example.test",
      PATH: "/bin"
    };

    applyGhSessionCredentials({ token: SESSION_TOKEN, login: LOGIN }, env);

    expect(env).toEqual({
      PATH: "/bin",
      GH_TOKEN: SESSION_TOKEN,
      GITHUB_TOKEN: SESSION_TOKEN,
      GH_PACKAGES_TOKEN: SESSION_TOKEN,
      GH_PACKAGES_USER: LOGIN
    });
  });
});

describe("prepareCloudRun", () => {
  it.each([undefined, "", "  "])(
    "runs nothing and changes nothing when RADIUS_CLOUD_E2E is %j",
    (flag) => {
      const { runGh, calls } = fakeGh();
      const env = {
        ...OVERRIDE,
        RADIUS_CLOUD_E2E: flag,
        RADIUS_CLOUD_E2E_FIXTURE_BASELINE_SHA: undefined,
        CI: "true"
      };

      expect(prepareCloudRun(runGh, env)).toEqual({
        fixture: PINNED_FIXTURE,
        signIn: "github-app"
      });
      expect(calls).toEqual([]);
      expect(env).not.toHaveProperty("GH_TOKEN");
    }
  );

  it("signs a local run in with the gh session for a copy outside radius-project", () => {
    const { runGh } = fakeGh();
    const env: NodeJS.ProcessEnv = { ...OVERRIDE, GH_HOST: "ghe.example.test" };

    expect(prepareCloudRun(runGh, env)).toEqual({
      fixture: copy("octo-cat/ai-extensions-fixture"),
      signIn: "gh-session"
    });
    expect(env.GH_TOKEN).toBe(SESSION_TOKEN);
    expect(env.GH_PACKAGES_USER).toBe(LOGIN);
    expect(env).not.toHaveProperty("GH_HOST");
  });

  it("keeps the GitHub App for an override that names a radius-project repository", () => {
    const { runGh, calls } = fakeGh();
    const env: NodeJS.ProcessEnv = {
      ...OVERRIDE,
      RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY:
        "radius-project/ai-extensions-fixture"
    };

    expect(prepareCloudRun(runGh, env)).toMatchObject({
      signIn: "github-app",
      fixture: { repository: "radius-project/ai-extensions-fixture" }
    });
    expect(calls).toEqual([]);
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  it.each([
    [
      "an override in CI",
      { ...OVERRIDE, CI: "true" },
      "must not be set when CI is set"
    ],
    [
      "a half-set override",
      { ...OVERRIDE, RADIUS_CLOUD_E2E_FIXTURE_AWS_BASELINE_SHA: undefined },
      "Missing: RADIUS_CLOUD_E2E_FIXTURE_AWS_BASELINE_SHA."
    ]
  ])(
    "fails %s without signing in",
    (_label, env: NodeJS.ProcessEnv, expected) => {
      const { runGh, calls } = fakeGh();

      const prepared = prepareCloudRun(runGh, env);

      expect(prepared).toMatchObject({
        fixture: PINNED_FIXTURE,
        signIn: "github-app"
      });
      expect(prepared.failure).toContain(expected);
      expect(calls).toEqual([]);
      expect(env).not.toHaveProperty("GH_TOKEN");
    }
  );

  it("refuses to start a gh session run whose token expires", () => {
    const { runGh } = fakeGh({
      user: {
        stdout: userResponse({
          "Github-Authentication-Token-Expiration": "2026-12-01 00:00:00 UTC"
        })
      }
    });
    const env: NodeJS.ProcessEnv = { ...OVERRIDE };

    const prepared = prepareCloudRun(runGh, env);

    expect(prepared.signIn).toBe("gh-session");
    expect(prepared.failure).toContain("Your gh session's token expires");
    expect(prepared.failure).not.toContain(SESSION_TOKEN);
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  it("fails a gh session sign-in without leaking the token or setting it", () => {
    const { runGh } = fakeGh({
      user: { status: 1, stderr: `token ${SESSION_TOKEN} was rejected` }
    });
    const env: NodeJS.ProcessEnv = { ...OVERRIDE };

    const prepared = prepareCloudRun(runGh, env);

    expect(prepared.signIn).toBe("gh-session");
    expect(prepared.failure).toContain(
      "Could not read the login of your gh session"
    );
    expect(prepared.failure).not.toContain(SESSION_TOKEN);
    expect(env).not.toHaveProperty("GH_TOKEN");
  });
});

describe("createGitHubTokenRefresh", () => {
  const config: GitHubAppTokenConfig = {
    clientId: "Iv1.example",
    installationId: "1",
    privateKey: "private-key",
    repository: "radius-project/ai-extensions-fixture",
    apiUrl: "https://api.github.com"
  };

  it("never renews an App token for a gh session run", async () => {
    const refreshed: GitHubAppTokenConfig[] = [];
    const refresh = createGitHubTokenRefresh("gh-session", null, (value) => {
      refreshed.push(value);
      return Promise.resolve();
    });

    await refresh();

    expect(refreshed).toEqual([]);
  });

  it("renews the App token for a GitHub App run", async () => {
    const refreshed: GitHubAppTokenConfig[] = [];
    const refresh = createGitHubTokenRefresh("github-app", config, (value) => {
      refreshed.push(value);
      return Promise.resolve();
    });

    await refresh();

    expect(refreshed).toEqual([config]);
  });

  it("fails a GitHub App run that has no App configuration", async () => {
    await expect(
      createGitHubTokenRefresh("github-app", null)()
    ).rejects.toThrow("GitHub App refresh credentials are required");
  });
});

describe.skipIf(process.platform === "win32")("runGhSync", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  async function installGh(script: string): Promise<NodeJS.ProcessEnv> {
    directory = await mkdtemp(path.join(tmpdir(), "radtest-gh-"));
    const gh = path.join(directory, "gh");
    await writeFile(gh, `#!/bin/sh\n${script}\n`);
    await chmod(gh, 0o755);
    return { PATH: `${directory}:/usr/bin:/bin` };
  }

  it("runs gh with exactly the environment given", async () => {
    const env = await installGh(
      'printf "%s|%s" "$*" "${GH_TOKEN:-unset}"; printf "warn" >&2'
    );

    expect(runGhSync(["auth", "token"], { ...env, GH_TOKEN: "t" })).toEqual({
      status: 0,
      stdout: "auth token|t",
      stderr: "warn"
    });
    expect(runGhSync(["auth", "token"], env).stdout).toBe("auth token|unset");
  });

  it("reports a quiet success with empty streams", async () => {
    const env = await installGh("exit 0");

    expect(runGhSync(["auth", "token"], env)).toEqual({
      status: 0,
      stdout: "",
      stderr: ""
    });
  });

  it("reports gh's exit status", async () => {
    const env = await installGh('echo "denied" >&2; exit 4');

    expect(runGhSync(["api", "user"], env)).toEqual({
      status: 4,
      stdout: "",
      stderr: "denied\n"
    });
  });

  it("reports a missing gh as a failure", () => {
    const result = runGhSync(["auth", "token"], { PATH: "/nonexistent" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ENOENT/);
  });
});
