import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerMutationOutcomeUnknown } from "./server/services/provider-mutation-recovery.js";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn()
}));

vi.mock("node:child_process", () => childProcess);

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

interface LoadGhOptions {
  withToken?: string;
  keyring?: string;
  token?: string | null;
  githubToken?: string | null;
  userTokens?: Record<string, string>;
  userTokenErrors?: Record<string, Error>;
  apiLogin?: string;
  commandResult?: {
    error?: string;
    stdout?: string;
    stderr?: string;
  };
  ghVersion?: string;
  prime?: boolean;
}

function restorePlatform(): void {
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

// Realistic `gh auth status` fixtures. gh reports the env-token account with a
// `GITHUB_TOKEN`/`GH_TOKEN` source, a keyring account with a `keyring` source,
// and a credential stored in hosts.yml (secure storage disabled) with an
// `oauth_token` source.
const STATUS = {
  empty: "",
  tokenNoWorkflow: `github.com
  ✓ Logged in to github.com account tokuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'read:org'`,
  tokenWithWorkflow: `github.com
  ✓ Logged in to github.com account tokuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow'`,
  keyringWithWorkflow: `github.com
  ✓ Logged in to github.com account keyuser (keyring)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow'`,
  // Multi-account machine: the injected token is the public account, which is
  // ALSO present in the keyring, while a different (enterprise/EMU) keyring
  // account is the active one. Mirrors the reported GHCR-denial setup.
  tokenPubActive: `github.com
  ✓ Logged in to github.com account pubuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow'`,
  keyringPubAndEmu: `github.com
  ✓ Logged in to github.com account pubuser (keyring)
    - Active account: false
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'
  ✓ Logged in to github.com account emuuser (keyring)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'`,
  // An injected GH_TOKEN for `pubuser` minted WITHOUT workflow, shadowing a
  // keyring credential for the SAME login that DOES have workflow. gh switch/
  // refresh mutate the keyring credential; the env token can't be changed.
  tokenPubNoWorkflow: `github.com
  ✓ Logged in to github.com account pubuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'gist', 'repo', 'user'`,
  keyringPubWithWorkflow: `github.com
  ✓ Logged in to github.com account pubuser (keyring)
    - Active account: true
    - Token scopes: 'gist', 'read:org', 'repo', 'workflow', 'write:packages'`,
  // Mirror of the above: the injected GH_TOKEN for `pubuser` HAS workflow, but
  // its same-login keyring credential does NOT. The strategy keeps the token
  // (token-has-workflow), so the acting credential already has the scope —
  // scope reporting must not read the keyring credential and warn.
  tokenPubWithWorkflow: `github.com
  ✓ Logged in to github.com account pubuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'gist', 'repo', 'workflow'`,
  keyringPubNoWorkflow: `github.com
  ✓ Logged in to github.com account pubuser (keyring)
    - Active account: true
    - Token scopes: 'gist', 'repo'`,
  tokenPubFull: `github.com
  ✓ Logged in to github.com account pubuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'workflow', 'write:packages'`,
  keyringPubFull: `github.com
  ✓ Logged in to github.com account pubuser (keyring)
    - Active account: true
    - Token scopes: 'repo', 'workflow', 'write:packages'`,
  // One login signed in TWICE: once as the host-injected session token and once
  // as a stored keyring credential, each with its own scopes. gh prints both
  // blocks under the same host, so the two credentials are indistinguishable by
  // login alone — only the source says which scopes belong to which.
  tokenDuplicateLogin: `github.com
  ✓ Logged in to github.com account dupuser (GITHUB_TOKEN)
    - Active account: true
    - Git operations protocol: https
    - Token: ghu_************************************
    - Token scopes: 'repo', 'read:org'
  ✓ Logged in to github.com account dupuser (keyring)
    - Active account: false
    - Git operations protocol: https
    - Token: gho_************************************
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'`,
  keyringDuplicateLogin: `github.com
  ✓ Logged in to github.com account dupuser (keyring)
    - Active account: true
    - Git operations protocol: https
    - Token: gho_************************************
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'`,
  // The same duplicated login, but this time the injected token is the one that
  // carries `workflow` and the stored credential is the narrower of the two.
  tokenDuplicateLoginTokenWins: `github.com
  ✓ Logged in to github.com account dupuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow'
  ✓ Logged in to github.com account dupuser (keyring)
    - Active account: false
    - Token scopes: 'repo'`,
  keyringDuplicateLoginNarrow: `github.com
  ✓ Logged in to github.com account dupuser (keyring)
    - Active account: true
    - Token scopes: 'repo'`,
  // Secure storage disabled: the stored credential is reported as `oauth_token`
  // and gh lists it BEFORE the injected env-token account.
  tokenAfterStoredOauth: `github.com
  ✓ Logged in to github.com account storeduser (oauth_token)
    - Active account: false
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'
  ✓ Logged in to github.com account tokuser (GH_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow'`,
  keyringStoredOauth: `github.com
  ✓ Logged in to github.com account storeduser (oauth_token)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'`,
  oauthBeforeSameLoginToken: `github.com
  ✓ Logged in to github.com account dupuser (oauth_token)
    - Active account: false
    - Token scopes: 'repo', 'workflow', 'write:packages'
  ✓ Logged in to github.com account dupuser (GH_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'workflow'`
};

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
}

// Load gh.ts with a controlled environment. `withToken`/`keyring` are the
// `gh auth status` texts returned for the injected-token vs token-stripped
// probes; `token` sets the ambient injected GH_TOKEN the strategy evaluates.
// `userTokens` maps a login to the token `gh auth token --user <login>` yields.
// `prime: true` awaits the async identity probe (so the token-stripping strategy
// is resolved) and clears the recorded probe calls, leaving the next spawn as
// mock.calls[0] — mirroring gh commands that run after identity resolution.
async function loadGh(platform: NodeJS.Platform, opts: LoadGhOptions = {}) {
  const {
    withToken = "",
    keyring = "",
    token = null,
    githubToken,
    userTokens = {},
    userTokenErrors = {},
    apiLogin = "",
    commandResult,
    ghVersion = "gh version 2.96.0",
    prime = false
  } = opts;
  setPlatform(platform);
  if (token === null) {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GH_TOKEN = token;
  }
  if (githubToken === null) delete process.env.GITHUB_TOKEN;
  else if (githubToken !== undefined) process.env.GITHUB_TOKEN = githubToken;
  // The identity layer now drives `gh auth status` and `gh auth token` through
  // async execFile (the read-only probes used to be synchronous execFileSync),
  // so one router serves them all.
  childProcess.execFile.mockImplementation((_file, args, options, cb) => {
    const a = args || [];
    const done = (err: Error | null, out: string, errOut = "") => {
      cb(
        err,
        out || "",
        errOut || (err ? String((err && err.message) || err) : "")
      );
      return { stdin: { end() {} } };
    };
    if (a[0] === "auth" && a[1] === "token") {
      const ui = a.indexOf("--user");
      if (ui !== -1) {
        const login = a[ui + 1];
        if (Object.prototype.hasOwnProperty.call(userTokenErrors, login))
          return done(userTokenErrors[login], "");
        if (Object.prototype.hasOwnProperty.call(userTokens, login))
          return done(null, userTokens[login]);
        return done(new Error("no token for user"), "");
      }
    }
    if (a[0] === "auth" && a[1] === "status") {
      const env = (options && options.env) || {};
      const hasTok = !!(env.GH_TOKEN || env.GITHUB_TOKEN);
      return done(null, hasTok ? withToken : keyring);
    }
    if (a[0] === "--version") {
      return done(null, ghVersion);
    }
    if (a[0] === "api" && a[1] === "user" && a[2] === "--jq") {
      return done(null, apiLogin);
    }
    if (commandResult) {
      return done(
        commandResult.error ? new Error(commandResult.error) : null,
        commandResult.stdout || "",
        commandResult.stderr || ""
      );
    }
    return done(null, "");
  });
  vi.resetModules();
  const gh = await import("./gh.js");
  if (prime) {
    await gh.primeGhIdentity();
    childProcess.execFile.mockClear();
  }
  return gh;
}

describe.sequential("cliExec", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    childProcess.execFileSync.mockReset();
  });

  afterEach(() => {
    restorePlatform();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it.each([
    ["win32", "gh.exe"],
    ["linux", "gh"],
    ["darwin", "gh"]
  ] as const)(
    "invokes gh by bare name on %s so the inherited PATH resolves it",
    async (platform, expected) => {
      const { cliExec } = await loadGh(platform);

      cliExec("gh", ["auth", "status"], {}, vi.fn());

      const [file] = childProcess.execFile.mock.calls[0];
      expect(file).toBe(expected);
    }
  );

  it("keeps an explicit non-Windows gh path instead of rewriting it to a bare name", async () => {
    const { cliExec } = await loadGh("linux");

    cliExec("/usr/local/bin/gh", ["auth", "status"], {}, vi.fn());

    const [file] = childProcess.execFile.mock.calls[0];
    expect(file).toBe("/usr/local/bin/gh");
  });

  it("adds the inherited search path to a caller env that omits it", async () => {
    const { cliExec } = await loadGh("linux");

    cliExec("gh", ["auth", "status"], { env: { KEEP_ME: "yes" } }, vi.fn());

    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(options.env.KEEP_ME).toBe("yes");
  });

  it("does not overwrite a search path the caller supplied", async () => {
    const { cliExec } = await loadGh("linux");

    cliExec("gh", ["auth", "status"], { env: { PATH: "/only/here" } }, vi.fn());

    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env.PATH).toBe("/only/here");
  });

  it.each([
    ["linux", "Path"],
    ["darwin", "path"]
  ] as const)(
    "inherits uppercase PATH when a %s caller supplies unrelated %s",
    async (platform, key) => {
      const { cliExec } = await loadGh(platform);

      cliExec(
        "gh",
        ["auth", "status"],
        { env: { [key]: "/caller-only" } },
        vi.fn()
      );

      const [, , options] = childProcess.execFile.mock.calls[0];
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(options.env[key]).toBe("/caller-only");
    }
  );

  it("matches a caller's Windows search path key case-insensitively", async () => {
    const { cliExec } = await loadGh("win32");

    cliExec(
      "gh",
      ["auth", "status"],
      { env: { Path: "C:\\caller-only" } },
      vi.fn()
    );

    const [, , options] = childProcess.execFile.mock.calls[0];
    const searchPaths = Object.entries(options.env).filter(
      ([key]) => key.toLowerCase() === "path"
    );
    expect(searchPaths).toEqual([["Path", "C:\\caller-only"]]);
  });

  it("does not re-add unrelated ambient variables to a caller-supplied env", async () => {
    const { cliExec } = await loadGh("linux");
    process.env.RADIUS_AMBIENT_PROBE = "leak";
    try {
      cliExec("gh", ["auth", "status"], { env: { KEEP_ME: "yes" } }, vi.fn());
    } finally {
      delete process.env.RADIUS_AMBIENT_PROBE;
    }

    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env.RADIUS_AMBIENT_PROBE).toBeUndefined();
  });

  it("passes a Windows gh query string containing an ampersand as one literal argument", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();
    const apiPath =
      "/repos/acme/widgets/deployments?environment=test&per_page=10";

    cliExec("gh", ["api", apiPath, "--jq", ".[].id"], {}, callback);

    expect(childProcess.execFile).toHaveBeenCalledOnce();
    const [file, args, options, receivedCallback] =
      childProcess.execFile.mock.calls[0];
    expect(file).toBe("gh.exe");
    expect(args).toEqual(["api", apiPath, "--jq", ".[].id"]);
    expect(args[1]).toBe(apiPath);
    expect(options.windowsHide).toBe(true);
    expect(receivedCallback).toBe(callback);
  });

  it("keeps normal non-Windows gh invocation behavior", async () => {
    const { cliExec } = await loadGh("linux");
    const callback = vi.fn();

    cliExec(
      "gh",
      ["repo", "view", "acme/widgets"],
      { timeout: 1000 },
      callback
    );

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "gh",
      ["repo", "view", "acme/widgets"],
      expect.objectContaining({ timeout: 1000, windowsHide: true }),
      callback
    );
  });

  it("treats 'gh.exe' as a gh invocation on Windows (no cmd.exe wrapper)", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();
    const apiPath =
      "/repos/acme/widgets/deployments?environment=test&per_page=10";

    cliExec("gh.exe", ["api", apiPath, "--jq", ".[].id"], {}, callback);

    const [file, args] = childProcess.execFile.mock.calls[0];
    expect(file).toBe("gh.exe");
    expect(args).toEqual(["api", apiPath, "--jq", ".[].id"]);
  });

  it("treats a full path to gh.exe as a gh invocation on Windows (no cmd.exe wrapper)", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();

    cliExec(
      "C:\\Program Files\\gh\\bin\\gh.exe",
      ["auth", "status"],
      {},
      callback
    );

    const [file, args] = childProcess.execFile.mock.calls[0];
    expect(file).toBe("gh.exe");
    expect(args).toEqual(["auth", "status"]);
  });

  it("strips ambient tokens for a full-path gh invocation when the token lacks workflow and a keyring login has it", async () => {
    const { cliExec } = await loadGh("linux", {
      prime: true,
      token: "tok",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const callback = vi.fn();

    cliExec(
      "/usr/local/bin/gh",
      ["auth", "status"],
      {
        env: { GH_TOKEN: "tok", KEEP_ME: "yes" }
      },
      callback
    );

    const [file, , options] = childProcess.execFile.mock.calls[0];
    expect(file).toBe("/usr/local/bin/gh");
    expect(options.env).toEqual(
      expect.objectContaining({
        PATH: process.env.PATH,
        KEEP_ME: "yes"
      })
    );
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("quotes Windows CLI arguments while leaving a simple executable unquoted", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();

    cliExec("az", ["account", "show"], {}, callback);

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "cmd.exe",
      ["/c", 'az "account" "show"'],
      expect.objectContaining({
        windowsHide: true,
        windowsVerbatimArguments: true
      }),
      callback
    );
  });

  it("keeps a parenthesized Graph URL and JSON body inside separate quoted arguments", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();
    const url =
      "https://graph.microsoft.com/v1.0/applications(appId='11111111-2222-3333-4444-555555555555')";
    const body = '{"tags":["radius-managed","radius-repo:octo/app"]}';

    cliExec(
      "az",
      ["rest", "--method", "PATCH", "--url", url, "--body", body],
      {},
      callback
    );

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "cmd.exe",
      [
        "/c",
        `az "rest" "--method" "PATCH" "--url" "${url}" "--body" "{\\"tags\\":[\\"radius-managed\\",\\"radius-repo:octo/app\\"]}"`
      ],
      expect.objectContaining({ windowsVerbatimArguments: true }),
      callback
    );
  });

  it("wraps a quoted Windows executable path in an outer pair of quotes", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();
    const executable =
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd";

    cliExec(executable, ["version", "-o", "json"], {}, callback);

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "cmd.exe",
      ["/c", `""${executable}" "version" "-o" "json""`],
      expect.objectContaining({ windowsVerbatimArguments: true }),
      callback
    );
  });

  it("preserves embedded quotes and trailing backslashes in Windows arguments", async () => {
    const { cliExec } = await loadGh("win32");
    const callback = vi.fn();

    cliExec("aws", ["two words", 'say "hello"', "C:\\temp\\"], {}, callback);

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "cmd.exe",
      ["/c", 'aws "two words" "say \\"hello\\"" "C:\\temp\\\\"'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
      callback
    );
  });

  it("removes ambient GitHub tokens when the token lacks workflow and a keyring login has it", async () => {
    const { cliExec } = await loadGh("win32", {
      prime: true,
      token: "ambient-gh",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const callback = vi.fn();

    cliExec(
      "gh",
      ["auth", "status"],
      {
        env: {
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github",
          KEEP_ME: "yes"
        }
      },
      callback
    );

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "gh.exe",
      ["auth", "status"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: process.env.PATH,
          KEEP_ME: "yes"
        })
      }),
      callback
    );
    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("keeps ambient GitHub tokens when the injected token already has workflow (even with a keyring login)", async () => {
    const { cliExec } = await loadGh("win32", {
      prime: true,
      token: "ambient-gh",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const callback = vi.fn();

    cliExec(
      "gh",
      ["auth", "status"],
      {
        env: {
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github"
        }
      },
      callback
    );

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "gh.exe",
      ["auth", "status"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: process.env.PATH,
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github"
        })
      }),
      callback
    );
  });

  it("preserves ambient GitHub tokens when no keyring login exists", async () => {
    const { cliExec } = await loadGh("win32", {
      prime: true,
      token: "ambient-gh",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.empty
    });
    const callback = vi.fn();

    cliExec(
      "gh",
      ["auth", "status"],
      {
        env: {
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github"
        }
      },
      callback
    );

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "gh.exe",
      ["auth", "status"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: process.env.PATH,
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github"
        })
      }),
      callback
    );
  });

  it("strips COPILOT_AGENT_SESSION_ID from a non-gh (az) child env while preserving PATH", async () => {
    const { cliExec } = await loadGh("linux");
    const callback = vi.fn();
    const saved = process.env.COPILOT_AGENT_SESSION_ID;
    process.env.COPILOT_AGENT_SESSION_ID = "test-session-id";
    try {
      cliExec("az", ["account", "show"], {}, callback);
    } finally {
      if (saved === undefined) delete process.env.COPILOT_AGENT_SESSION_ID;
      else process.env.COPILOT_AGENT_SESSION_ID = saved;
    }

    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it("strips COPILOT_AGENT_SESSION_ID on the gh path (on top of ghChildEnv)", async () => {
    const { cliExec } = await loadGh("linux", {
      prime: true,
      token: "ambient-gh",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const callback = vi.fn();

    cliExec(
      "gh",
      ["auth", "status"],
      {
        env: {
          GH_TOKEN: "ambient-gh",
          COPILOT_AGENT_SESSION_ID: "test-session-id",
          KEEP_ME: "yes"
        }
      },
      callback
    );

    const [, , options] = childProcess.execFile.mock.calls[0];
    // ghChildEnv strips GH_TOKEN (token lacks workflow, keyring has it) and
    // withoutAgentSession strips the agent session var; KEEP_ME survives.
    expect(options.env).toEqual(
      expect.objectContaining({
        PATH: process.env.PATH,
        KEEP_ME: "yes"
      })
    );
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
  });

  it("merges keyring-only overrides with the inherited app environment", async () => {
    const { runGhKeyringCommand } = await loadGh("linux", {
      token: "ambient-gh",
      githubToken: "ambient-github"
    });

    await runGhKeyringCommand(["auth", "token"], {
      env: { GH_CONFIG_DIR: "isolated-config" }
    });

    const options = childProcess.execFile.mock.calls.at(-1)?.[2];
    expect(options?.env).toEqual(
      expect.objectContaining({
        PATH: process.env.PATH,
        GH_CONFIG_DIR: "isolated-config"
      })
    );
    expect(options?.env.GH_TOKEN).toBeUndefined();
    expect(options?.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("produces a valid env with PATH when COPILOT_AGENT_SESSION_ID is unset", async () => {
    const { cliExec } = await loadGh("linux");
    const callback = vi.fn();
    const saved = process.env.COPILOT_AGENT_SESSION_ID;
    delete process.env.COPILOT_AGENT_SESSION_ID;
    try {
      cliExec("az", ["account", "show"], {}, callback);
    } finally {
      if (saved !== undefined) process.env.COPILOT_AGENT_SESSION_ID = saved;
    }

    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env).toBeTypeOf("object");
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
  });
});

describe.sequential("ghApiJson", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    childProcess.execFileSync.mockReset();
  });

  afterEach(() => {
    restorePlatform();
  });

  const stubChild = () => ({ stdin: { end() {} } });

  it("parses a successful JSON body as ok/200", async () => {
    const { ghApiJson } = await loadGh("linux");
    childProcess.execFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, '{"full_name":"o/r"}', "");
      return stubChild();
    });
    const res = await ghApiJson("/repos/o/r");
    expect(res).toEqual({
      ok: true,
      status: 200,
      json: { full_name: "o/r" },
      stderr: ""
    });
  });

  it("extracts an HTTP status from gh stderr on failure", async () => {
    const { ghApiJson } = await loadGh("linux");
    childProcess.execFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(new Error("gh: exit 1"), "", "gh: Not Found (HTTP 404)");
      return stubChild();
    });
    const res = await ghApiJson("/repos/o/missing");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.stderr).toContain("404");
  });

  it("returns a null status when no HTTP code is present (transport error)", async () => {
    const { ghApiJson } = await loadGh("linux");
    childProcess.execFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(new Error("ECONNRESET"), "", "ECONNRESET");
      return stubChild();
    });
    const res = await ghApiJson("/x");
    expect(res.status).toBe(null);
    expect(res.ok).toBe(false);
  });

  it("reports a JSON parse failure as not-ok with status 200", async () => {
    const { ghApiJson } = await loadGh("linux");
    childProcess.execFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "not json", "");
      return stubChild();
    });
    const res = await ghApiJson("/x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(res.stderr).toMatch(/failed to parse/);
  });

  it("passes custom headers through as -H args", async () => {
    const { ghApiJson } = await loadGh("linux");
    childProcess.execFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "null", "");
      return stubChild();
    });
    await ghApiJson("/x", {
      headers: { "X-GitHub-Api-Version": "2022-11-28" }
    });
    const [, args] = childProcess.execFile.mock.calls[0];
    expect(args).toEqual([
      "api",
      "/x",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28"
    ]);
  });
});

describe("parseGhAuthStatus", () => {
  it("parses login, source, active flag, and scopes for multiple accounts", async () => {
    const { parseGhAuthStatus } = await import("./gh.js");
    const text = `github.com
  ✓ Logged in to github.com account tokuser (GITHUB_TOKEN)
    - Active account: true
    - Token scopes: 'repo', 'read:org', 'workflow'
  ✓ Logged in to github.com account keyuser (keyring)
    - Active account: false
    - Token scopes: 'repo'`;
    expect(parseGhAuthStatus(text)).toEqual([
      {
        login: "tokuser",
        source: "GITHUB_TOKEN",
        active: true,
        scopes: ["repo", "read:org", "workflow"]
      },
      { login: "keyuser", source: "keyring", active: false, scopes: ["repo"] }
    ]);
  });

  it("returns an empty array for empty or unrecognized text", async () => {
    const { parseGhAuthStatus } = await import("./gh.js");
    expect(parseGhAuthStatus("")).toEqual([]);
    expect(parseGhAuthStatus("not logged in")).toEqual([]);
    expect(parseGhAuthStatus(null)).toEqual([]);
  });
});

describe("decideGhTokenStrategy", () => {
  let decide: typeof import("./gh.js").decideGhTokenStrategy;
  beforeEach(async () => {
    ({ decideGhTokenStrategy: decide } = await import("./gh.js"));
  });

  it("keeps the token when it already has workflow", () => {
    expect(
      decide({
        hasToken: true,
        tokenHasWorkflow: true,
        keyringLogin: "b",
        keyringHasWorkflow: true
      })
    ).toEqual({
      useKeyring: false,
      reason: "token-has-workflow"
    });
  });

  it("strips the token only when it lacks workflow and a keyring login has it", () => {
    expect(
      decide({
        hasToken: true,
        tokenHasWorkflow: false,
        keyringLogin: "b",
        keyringHasWorkflow: true
      })
    ).toEqual({
      useKeyring: true,
      reason: "token-missing-workflow"
    });
  });

  it("keeps the token when it lacks workflow but no keyring login has it", () => {
    expect(
      decide({
        hasToken: true,
        tokenHasWorkflow: false,
        keyringLogin: "",
        keyringHasWorkflow: false
      })
    ).toEqual({
      useKeyring: false,
      reason: "no-workflow-scope-available"
    });
  });

  it("falls back to the keyring when there is no injected token", () => {
    expect(
      decide({ hasToken: false, keyringLogin: "b", keyringHasWorkflow: true })
    ).toEqual({
      useKeyring: true,
      reason: "no-injected-token"
    });
  });
});

describe("isInjectedTokenSource", () => {
  it.each([["GH_TOKEN"], ["GITHUB_TOKEN"], [" GH_TOKEN "]])(
    "treats %s as the host-injected credential",
    async (source) => {
      const { isInjectedTokenSource } = await import("./gh.js");
      expect(isInjectedTokenSource(source)).toBe(true);
    }
  );

  it.each([
    ["oauth_token", "a credential stored in hosts.yml"],
    ["keyring", "a credential in the OS keyring"],
    ["GH_ENTERPRISE_TOKEN", "an unrelated token variable"],
    ["", "an absent source"]
  ])("does not treat %s (%s) as injected", async (source) => {
    const { isInjectedTokenSource } = await import("./gh.js");
    expect(isInjectedTokenSource(source)).toBe(false);
  });
});

describe("getInjectedGhToken", () => {
  it.each([
    [{ GH_TOKEN: "gh-token" }, "gh-token"],
    [{ GITHUB_TOKEN: "github-token" }, "github-token"],
    [{ GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" }, "gh-token"],
    [{ GH_TOKEN: "  ", GITHUB_TOKEN: "github-token" }, "github-token"],
    [{ GH_TOKEN: " gh-token ", GITHUB_TOKEN: "github-token" }, "gh-token"],
    [{}, ""]
  ])(
    "selects the documented injected-token precedence for %o",
    async (env, expected) => {
      const { getInjectedGhToken } = await import("./gh.js");
      expect(getInjectedGhToken(env)).toBe(expected);
    }
  );
});

describe.sequential("ghCommandCredentialSource", () => {
  it("reports the injected credential when the resolved strategy keeps it", async () => {
    const gh = await loadGh("linux", {
      token: "session-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      prime: true
    });

    expect(gh.ghCommandCredentialSource()).toBe("injected");
  });

  it("reports the stored credential when strategy strips an ambient token", async () => {
    const gh = await loadGh("linux", {
      token: "session-token",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      prime: true
    });

    expect(gh.ghCommandCredentialSource()).toBe("keyring");
  });

  it("reports the stored credential when no injected token exists", async () => {
    const gh = await loadGh("linux", {
      token: null,
      withToken: STATUS.empty,
      keyring: STATUS.keyringWithWorkflow,
      prime: true
    });

    expect(gh.ghCommandCredentialSource({})).toBe("keyring");
  });
});

describe("GitHub diagnostic redaction", () => {
  it("redacts injected and credential-shaped tokens from surfaced errors", async () => {
    const { redactGhCredentials } = await import("./gh.js");
    expect(
      redactGhCredentials(
        "gh failed with placeholder-token and ghp_fixture_secret",
        { GH_TOKEN: "  placeholder-token  " }
      )
    ).toBe("gh failed with [REDACTED] and [REDACTED]");
  });

  it("does not replace incidental text matching a short injected value", async () => {
    const { redactGhCredentials } = await import("./gh.js");
    expect(
      redactGhCredentials("authentication token unavailable", {
        GH_TOKEN: "token"
      })
    ).toBe("authentication token unavailable");
  });
});

describe("GitHub CLI version compatibility", () => {
  it.each([
    ["gh version 2.39.1 (2024-01-01)", [2, 39]],
    ["gh version 2.40.0 (2024-01-01)", [2, 40]],
    ["gh version 3.0.0", [3, 0]],
    ["unexpected", null]
  ] as const)("parses %s", async (text, parsed) => {
    const { parseGhVersion } = await import("./gh.js");
    expect(parseGhVersion(text)).toEqual(parsed);
  });

  it.each([
    [[2, 86], false],
    [[2, 87], true],
    [[3, 0], true]
  ] as const)(
    "classifies workflow dispatch support for %j",
    async (version, supported) => {
      const { supportsWorkflowDispatchRunDetails } = await import("./gh.js");
      expect(supportsWorkflowDispatchRunDetails([...version])).toBe(supported);
    }
  );
});

describe.sequential("selected GitHub executor", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    childProcess.execFileSync.mockReset();
  });

  afterEach(() => {
    restorePlatform();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_HOST;
  });

  it("pins the injected credential after removing ambient alternatives", async () => {
    process.env.GITHUB_TOKEN = "lower-priority-token";
    process.env.GH_HOST = "example.test";
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      apiLogin: "tokuser"
    });

    const executor = await gh.createSelectedGhExecutor("tokuser");
    childProcess.execFile.mockClear();
    await executor.verifyIdentity();

    const [, args, options] = childProcess.execFile.mock.calls[0];
    expect(args).toEqual(["api", "user", "--jq", ".login"]);
    expect(options.env.GH_TOKEN).toBe("selected-injected-token");
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(options.env.GH_HOST).toBeUndefined();
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(executor.credentialSource).toBe("injected");
  });

  it("uses an account-qualified keyring token without falling through to ambient credentials", async () => {
    process.env.GITHUB_TOKEN = "lower-priority-token";
    process.env.GH_HOST = "example.test";
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      userTokens: { keyuser: "opaque-keyring-secret" },
      apiLogin: "keyuser"
    });

    const executor = await gh.createSelectedGhExecutor("keyuser");
    const tokenLookup = childProcess.execFile.mock.calls.find(
      ([, args]) => args[0] === "auth" && args[1] === "token"
    );
    expect(tokenLookup?.[1]).toEqual([
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "keyuser"
    ]);
    expect(tokenLookup?.[2].env.GH_TOKEN).toBeUndefined();
    expect(tokenLookup?.[2].env.GITHUB_TOKEN).toBeUndefined();
    expect(tokenLookup?.[2].env.GH_HOST).toBeUndefined();
    expect(tokenLookup?.[2].timeout).toBe(8000);

    childProcess.execFile.mockClear();
    await executor.verifyIdentity();
    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env.GH_TOKEN).toBe("opaque-keyring-secret");
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(executor.credentialSource).toBe("keyring");
  });

  it("pins the injected credential when the selected keyring lookup times out", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenDuplicateLogin,
      keyring: STATUS.keyringDuplicateLogin,
      userTokenErrors: {
        dupuser: Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGTERM"
        })
      },
      apiLogin: "dupuser"
    });

    const executor = await gh.createSelectedGhExecutor("dupuser");
    childProcess.execFile.mockClear();
    await executor.verifyIdentity();

    expect(executor.credentialSource).toBe("injected");
    expect(childProcess.execFile.mock.calls[0]?.[2].env.GH_TOKEN).toBe(
      "selected-injected-token"
    );
  });

  it("reports an actionable error when GitHub CLI predates dispatch run details", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      ghVersion: "gh version 2.86.1"
    });

    await expect(gh.createSelectedGhExecutor("keyuser")).rejects.toThrow(
      "GitHub CLI 2.87 or newer"
    );
  });

  it("fails closed when the GitHub CLI version is unreadable", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      ghVersion: "unexpected output"
    });

    await expect(gh.createSelectedGhExecutor("tokuser")).rejects.toThrow(
      "could not determine the installed GitHub CLI version"
    );
  });

  it("reports a missing account token on a modern multi-account GitHub CLI", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      ghVersion: "gh version 2.96.0"
    });

    await expect(gh.createSelectedGhExecutor("keyuser")).rejects.toThrow(
      "Could not obtain a GitHub credential for @keyuser"
    );
  });

  it("uses a stronger same-login keyring credential when the injected token lacks required access", async () => {
    const gh = await loadGh("linux", {
      token: "limited-injected-token",
      withToken: STATUS.tokenPubNoWorkflow,
      keyring: STATUS.keyringPubWithWorkflow,
      userTokens: { pubuser: "full-keyring-token" },
      apiLogin: "pubuser"
    });

    const executor = await gh.createSelectedGhExecutor("pubuser");
    childProcess.execFile.mockClear();
    await executor.verifyIdentity();

    expect(executor.credentialSource).toBe("keyring");
    expect(childProcess.execFile.mock.calls[0]?.[2].env.GH_TOKEN).toBe(
      "full-keyring-token"
    );
  });

  it("prefers the injected credential when same-login scope metadata ties", async () => {
    const gh = await loadGh("linux", {
      token: "injected-token",
      withToken: STATUS.tokenPubFull,
      keyring: STATUS.keyringPubFull,
      userTokens: { pubuser: "same-scope-keyring-token" },
      apiLogin: "pubuser"
    });

    const executor = await gh.createSelectedGhExecutor("pubuser");
    childProcess.execFile.mockClear();
    await executor.verifyIdentity();

    expect(executor.credentialSource).toBe("injected");
    expect(executor.requiresKeyringSwitch).toBe(false);
    expect(childProcess.execFile.mock.calls[0]?.[2].env.GH_TOKEN).toBe(
      "injected-token"
    );
  });

  it("uses the injected account entry rather than a same-login oauth_token entry", async () => {
    const gh = await loadGh("linux", {
      token: "injected-token",
      withToken: STATUS.oauthBeforeSameLoginToken,
      keyring: STATUS.keyringDuplicateLoginNarrow,
      userTokens: { dupuser: "narrow-keyring-token" },
      apiLogin: "dupuser"
    });

    const executor = await gh.createSelectedGhExecutor("dupuser");

    expect(executor.credentialSource).toBe("injected");
    expect(executor.scopes).toEqual(["repo", "workflow"]);
  });

  it("treats a hosts.yml oauth_token as a stored credential", async () => {
    const gh = await loadGh("linux", {
      token: "host-injected-token",
      withToken: STATUS.tokenAfterStoredOauth,
      keyring: STATUS.keyringStoredOauth,
      userTokens: { storeduser: "stored-oauth-secret" },
      apiLogin: "storeduser"
    });

    const executor = await gh.createSelectedGhExecutor("storeduser");

    expect(executor.credentialSource).toBe("keyring");
    expect(executor.scopes).toContain("write:packages");
  });

  it("fails closed when the selected login has no matching credential", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });

    await expect(gh.createSelectedGhExecutor("missinguser")).rejects.toThrow(
      "Could not obtain a GitHub credential for @missinguser"
    );
  });

  it("fails closed when the pinned command resolves to another login", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      apiLogin: "someone-else"
    });

    const executor = await gh.createSelectedGhExecutor("tokuser");

    await expect(executor.verifyIdentity()).rejects.toThrow(
      "expected @tokuser, received @someone-else"
    );
  });

  it("verifies the selected identity once before all executor commands", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      apiLogin: "tokuser",
      commandResult: { stdout: "{}" }
    });
    const executor = await gh.createSelectedGhExecutor("tokuser");
    childProcess.execFile.mockClear();

    await executor.run([
      "api",
      "--method",
      "PUT",
      "repos/octo/app/environments/dev"
    ]);
    await executor.run(["api", "repos/octo/app"]);

    expect(childProcess.execFile.mock.calls.map(([, args]) => args)).toEqual([
      ["api", "user", "--jq", ".login"],
      ["api", "--method", "PUT", "repos/octo/app/environments/dev"],
      ["api", "repos/octo/app"]
    ]);
  });

  it("preserves timeout state from selected-account commands", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      apiLogin: "tokuser"
    });
    const executor = await gh.createSelectedGhExecutor("tokuser");
    await executor.verifyIdentity();
    const timeout = Object.assign(new Error("terminated"), {
      code: null,
      killed: true,
      signal: "SIGTERM"
    });
    childProcess.execFile.mockImplementationOnce(
      (_file, _args, _options, callback) => {
        callback(timeout, "", "terminated");
        return { stdin: { end() {} } };
      }
    );

    const result = await executor.run(["api", "/repos/octo/app"]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "terminated",
      timedOut: true
    });
    expect(providerMutationOutcomeUnknown(result)).toBe(true);
  });

  it("redacts a materialized non-prefixed keyring token from results and errors", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      userTokens: { keyuser: "opaque-keyring-secret" },
      apiLogin: "keyuser",
      commandResult: {
        error: "failed with opaque-keyring-secret",
        stderr: "denied opaque-keyring-secret"
      }
    });
    const executor = await gh.createSelectedGhExecutor("keyuser");

    await expect(executor.run(["api", "repos/octo/app"])).resolves.toEqual({
      code: 1,
      stdout: "",
      stderr: "denied [REDACTED]"
    });
    await expect(
      executor.runOrThrow(["api", "repos/octo/app"], "Repository check failed")
    ).rejects.toThrow("Repository check failed: denied [REDACTED]");
  });

  it("keeps the selected credential out of serialized executor state", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      userTokens: { keyuser: "opaque-selected-credential" }
    });
    const executor = await gh.createSelectedGhExecutor("keyuser");

    expect(JSON.stringify(executor)).not.toContain(
      "opaque-selected-credential"
    );
  });

  it("preserves bounded timeouts on selected-account repository reads", async () => {
    const gh = await loadGh("linux", {
      token: "selected-injected-token",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      apiLogin: "tokuser",
      commandResult: { stdout: "bWFpbg==" }
    });
    const executor = await gh.createSelectedGhExecutor("tokuser");
    childProcess.execFile.mockClear();

    await gh.selectedFetchFileFromRepo(
      executor,
      "octo/app",
      "app.bicep",
      "main"
    );
    await gh.selectedGetDefaultBranch(executor, "octo/app");
    await gh.selectedGetBranchHeadSha(executor, "octo/app", "main");

    expect(
      childProcess.execFile.mock.calls.map(([, , options]) => options.timeout)
    ).toEqual([15000, 15000, 15000, 15000]);
  });
});

describe.sequential("getGitHubIdentity", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    childProcess.execFileSync.mockReset();
  });

  afterEach(() => {
    restorePlatform();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it("reports acting == display with no mismatch when the token keeps its identity", async () => {
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const id = await getGitHubIdentity();
    expect(id.actingLogin).toBe("tokuser");
    expect(id.displayLogin).toBe("tokuser");
    expect(id.mismatch).toBe(false);
    expect(id.actingHasWorkflow).toBe(true);
    expect(id.accounts.map((a) => a.login).sort()).toEqual([
      "keyuser",
      "tokuser"
    ]);
  });

  it("reports actingHasPackages=false and per-account hasPackages when no account holds write:packages", async () => {
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const id = await getGitHubIdentity();
    expect(id.actingHasPackages).toBe(false);
    expect(id.packagesHasWrite).toBe(false);
    expect(id.packagesCredentialSource).toBe("injected-token");
    expect(id.accounts.every((a) => a.hasPackages === false)).toBe(true);
  });

  it("reads the packages scope keyring-first, matching the credential GHCR pushes use", async () => {
    // pubuser's INJECTED token lacks write:packages, but its KEYRING entry
    // has it. getGhPackageCredentials pins the keyring token, so the identity
    // must report the keyring scope — not the token account's — or the
    // dialog and preflight would wrongly block a push that would succeed.
    // `userTokens` supplies the keyring token that pinning actually returns:
    // without it the resolved credential would be the injected token, which is
    // its own (separately covered) case.
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenPubActive,
      keyring: STATUS.keyringPubAndEmu,
      userTokens: {
        pubuser: "keyring-pub-token",
        emuuser: "keyring-emu-token"
      }
    });
    const id = await getGitHubIdentity();
    expect(id.actingLogin).toBe("pubuser");
    expect(id.actingHasPackages).toBe(true);
    expect(id.packagesLogin).toBe("pubuser");
    expect(id.packagesHasWrite).toBe(true);
    expect(id.packagesCredentialSource).toBe("keyring");
    const pub = id.accounts.find((a) => a.login === "pubuser");
    expect(pub).toBeDefined();
    if (!pub) throw new Error("pubuser account missing");
    expect(pub.hasPackages).toBe(true);
  });

  it("reads the workflow scope keyring-first when an injected token shadows a same-login keyring credential", async () => {
    // pubuser's INJECTED token was minted without workflow, but its KEYRING
    // credential has it. gh auth switch/refresh mutate the keyring credential,
    // so the identity must report workflow from the keyring entry — reading the
    // shadowing env token (which no gh command can change) would leave the
    // Create Environment warning permanently stuck. Regression test for #213.
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenPubNoWorkflow,
      keyring: STATUS.keyringPubWithWorkflow
    });
    const id = await getGitHubIdentity();
    expect(id.actingLogin).toBe("pubuser");
    // Pin the configuration under test: pubuser is the active keyring account,
    // so the strategy falls back to it (reporting and the acting credential
    // agree here). Guards against the fixture drifting into a case where they
    // diverge without the test noticing.
    expect(id.reason).toBe("token-missing-workflow");
    expect(id.actingHasWorkflow).toBe(true);
    const pub = id.accounts.find((a) => a.login === "pubuser");
    expect(pub).toBeDefined();
    if (!pub) throw new Error("pubuser account missing");
    expect(pub.hasWorkflow).toBe(true);
  });

  it("reports workflow from the injected token when it has the scope but its same-login keyring credential does not", async () => {
    // Mirror of #213: the injected token HAS workflow, its same-login keyring
    // credential does NOT. decideGhTokenStrategy keeps the token
    // (token-has-workflow), so gh acts as the token and setup would succeed.
    // Reporting must follow the acting credential (the token) — a blanket
    // keyring-first read would wrongly warn that workflow is missing and tell
    // the user to run a refresh the acting credential does not need.
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenPubWithWorkflow,
      keyring: STATUS.keyringPubNoWorkflow
    });
    const id = await getGitHubIdentity();
    expect(id.actingLogin).toBe("pubuser");
    expect(id.reason).toBe("token-has-workflow");
    expect(id.actingHasWorkflow).toBe(true);
    const pub = id.accounts.find((a) => a.login === "pubuser");
    expect(pub).toBeDefined();
    if (!pub) throw new Error("pubuser account missing");
    expect(pub.hasWorkflow).toBe(true);
  });

  it("flags a mismatch when setup falls back to a different keyring account", async () => {
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    const id = await getGitHubIdentity();
    expect(id.displayLogin).toBe("tokuser");
    expect(id.actingLogin).toBe("keyuser");
    expect(id.mismatch).toBe(true);
  });
});

describe.sequential("getGhPackageCredentials", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    childProcess.execFileSync.mockReset();
  });

  afterEach(() => {
    restorePlatform();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it("uses the acting login's keyring token, not the active (EMU) keyring account", async () => {
    const { getGhPackageCredentials } = await loadGh("linux", {
      token: "injected-pub",
      withToken: STATUS.tokenPubActive,
      keyring: STATUS.keyringPubAndEmu,
      userTokens: {
        pubuser: "keyring-pub-token",
        emuuser: "keyring-emu-token"
      }
    });
    // Acting identity is pubuser (token has workflow → token kept). GHCR
    // creds must pin to pubuser's keyring token, never the active EMU one.
    expect(await getGhPackageCredentials()).toEqual({
      token: "keyring-pub-token",
      username: "pubuser",
      source: "keyring"
    });
  });

  it("falls back to the injected token when the acting login has no keyring entry", async () => {
    const { getGhPackageCredentials } = await loadGh("linux", {
      token: "injected-solo",
      withToken: STATUS.tokenNoWorkflow, // tokuser, no keyring counterpart
      keyring: STATUS.empty,
      userTokens: {}
    });
    expect(await getGhPackageCredentials()).toEqual({
      token: "injected-solo",
      username: "tokuser",
      source: "injected-token"
    });
  });

  it("reports injected credential source when keyring lookup times out", async () => {
    const { getGhPackageCredentials } = await loadGh("linux", {
      token: "injected-pub",
      withToken: STATUS.tokenPubActive,
      keyring: STATUS.keyringPubAndEmu,
      userTokenErrors: {
        pubuser: Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGTERM"
        })
      }
    });

    await expect(getGhPackageCredentials()).resolves.toEqual({
      token: "injected-pub",
      username: "pubuser",
      source: "injected-token"
    });
    const tokenLookup = childProcess.execFile.mock.calls.find(
      ([, args]) => args[0] === "auth" && args[1] === "token"
    );
    expect(tokenLookup?.[2].timeout).toBe(8000);
  });

  it("does not relabel another account's injected token when keyring lookup fails", async () => {
    const { getGhPackageCredentials } = await loadGh("linux", {
      token: "injected-token-for-tokuser",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      userTokenErrors: {
        keyuser: new Error("keyring unavailable")
      }
    });

    await expect(getGhPackageCredentials()).rejects.toThrow(
      "Could not obtain a GitHub token for @keyuser"
    );
  });

  it("ignores a whitespace-only GH_TOKEN when GITHUB_TOKEN is usable", async () => {
    const { getGhPackageCredentials } = await loadGh("linux", {
      token: "   ",
      githubToken: "github-fallback-token",
      withToken: STATUS.tokenNoWorkflow,
      keyring: STATUS.empty,
      userTokens: {}
    });

    await expect(getGhPackageCredentials()).resolves.toEqual({
      token: "github-fallback-token",
      username: "tokuser",
      source: "injected-token"
    });
  });

  it("throws when no GitHub account can be resolved", async () => {
    const { getGhPackageCredentials } = await loadGh("linux", {
      token: null,
      withToken: STATUS.empty,
      keyring: STATUS.empty,
      userTokens: {}
    });
    await expect(getGhPackageCredentials()).rejects.toThrow(
      /No GitHub account/
    );
  });
});

// A branch's file listing is the evidence the modeling gate refuses on, so it
// must contain only real files and must never present a partial answer as a
// complete one. Every failure resolves to an empty array, which callers read as
// "could not establish" rather than "the repository has nothing".
describe.sequential("fetchRepoTree", () => {
  afterEach(() => {
    restorePlatform();
    vi.clearAllMocks();
  });

  it("requests blobs only and carries the truncation flag", async () => {
    const { fetchRepoTree } = await loadGh("linux", {
      commandResult: {
        stdout: JSON.stringify({
          truncated: false,
          paths: ["Dockerfile", "src/index.ts"]
        })
      }
    });

    expect(await fetchRepoTree("acme/widgets", "main")).toEqual([
      "Dockerfile",
      "src/index.ts"
    ]);
    const args = childProcess.execFile.mock.calls.at(-1)?.[1] as string[];
    expect(args.join(" ")).toContain('select(.type == "blob")');
    expect(args.join(" ")).toContain("/repos/acme/widgets/git/trees/main");
  });

  it("discards a truncated listing rather than reporting a partial tree", async () => {
    const { fetchRepoTree } = await loadGh("linux", {
      commandResult: {
        stdout: JSON.stringify({ truncated: true, paths: ["src/index.ts"] })
      }
    });

    expect(await fetchRepoTree("acme/widgets", "main")).toEqual([]);
  });

  it.each([
    ["a command failure", { error: "gh unavailable" }],
    ["unparsable output", { stdout: "not json" }],
    ["a non-object payload", { stdout: "[]" }],
    ["a null payload", { stdout: "null" }],
    ["a missing paths field", { stdout: JSON.stringify({ truncated: false }) }]
  ])("resolves empty for %s", async (_label, commandResult) => {
    const { fetchRepoTree } = await loadGh("linux", { commandResult });

    expect(await fetchRepoTree("acme/widgets", "main")).toEqual([]);
  });

  it("drops non-string entries", async () => {
    const { fetchRepoTree } = await loadGh("linux", {
      commandResult: {
        stdout: JSON.stringify({ truncated: false, paths: ["a.ts", 7, null] })
      }
    });

    expect(await fetchRepoTree("acme/widgets", "main")).toEqual(["a.ts"]);
  });
});
