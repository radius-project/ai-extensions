import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  userTokens?: Record<string, string>;
  switchError?: string | null;
  prime?: boolean;
}

function restorePlatform(): void {
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

// Realistic `gh auth status` fixtures. gh reports the env-token account with a
// `GITHUB_TOKEN`/`GH_TOKEN` source and a keyring account with a `keyring` source.
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
    - Token scopes: 'repo', 'read:org', 'workflow', 'read:packages', 'write:packages'`
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
// `switchError`, when set, makes `gh auth switch` fail with that message.
// `prime: true` awaits the async identity probe (so the token-stripping strategy
// is resolved) and clears the recorded probe calls, leaving the next spawn as
// mock.calls[0] — mirroring gh commands that run after identity resolution.
async function loadGh(platform: NodeJS.Platform, opts: LoadGhOptions = {}) {
  const {
    withToken = "",
    keyring = "",
    token = null,
    userTokens = {},
    switchError = null,
    prime = false
  } = opts;
  setPlatform(platform);
  if (token === null) {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GH_TOKEN = token;
  }
  // The identity layer now drives `gh auth status`, `gh auth token`, and
  // `gh auth switch` through async execFile (the read-only probes used to be
  // synchronous execFileSync), so one router serves them all.
  childProcess.execFile.mockImplementation((_file, args, options, cb) => {
    const a = args || [];
    const done = (err: Error | null, out: string) => {
      cb(err, out || "", err ? String((err && err.message) || err) : "");
      return { stdin: { end() {} } };
    };
    if (a[0] === "auth" && a[1] === "switch") {
      return done(switchError ? new Error(switchError) : null, "");
    }
    if (a[0] === "auth" && a[1] === "token") {
      const ui = a.indexOf("--user");
      if (ui !== -1) {
        const login = a[ui + 1];
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

    const [, , options] = childProcess.execFile.mock.calls[0];
    expect(options.env).toEqual({ KEEP_ME: "yes" });
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
      expect.objectContaining({ env: { KEEP_ME: "yes" } }),
      callback
    );
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
        env: {
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github"
        }
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
        env: {
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github"
        }
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
    expect(options.env).toEqual({ KEEP_ME: "yes" });
    expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
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
        tokenLogin: "a",
        tokenHasWorkflow: true,
        keyringLogin: "b",
        keyringHasWorkflow: true
      })
    ).toEqual({ useKeyring: false, reason: "token-has-workflow" });
  });

  it("strips the token only when it lacks workflow and a keyring login has it", () => {
    expect(
      decide({
        hasToken: true,
        tokenLogin: "a",
        tokenHasWorkflow: false,
        keyringLogin: "b",
        keyringHasWorkflow: true
      })
    ).toEqual({ useKeyring: true, reason: "token-missing-workflow" });
  });

  it("keeps the token when it lacks workflow but no keyring login has it", () => {
    expect(
      decide({
        hasToken: true,
        tokenLogin: "a",
        tokenHasWorkflow: false,
        keyringLogin: "",
        keyringHasWorkflow: false
      })
    ).toEqual({ useKeyring: false, reason: "no-workflow-scope-available" });
  });

  it("falls back to the keyring when there is no injected token", () => {
    expect(
      decide({ hasToken: false, keyringLogin: "b", keyringHasWorkflow: true })
    ).toEqual({ useKeyring: true, reason: "no-injected-token" });
  });

  it("honors an explicit preference for the token account", () => {
    expect(
      decide({
        hasToken: true,
        tokenLogin: "a",
        tokenHasWorkflow: false,
        keyringLogin: "b",
        keyringHasWorkflow: true,
        preferredLogin: "a"
      })
    ).toEqual({ useKeyring: false, reason: "user-selected-token-account" });
  });

  it("honors an explicit preference for a keyring account over the token", () => {
    expect(
      decide({
        hasToken: true,
        tokenLogin: "a",
        tokenHasWorkflow: true,
        keyringLogin: "b",
        keyringHasWorkflow: true,
        preferredLogin: "b"
      })
    ).toEqual({ useKeyring: true, reason: "user-selected-keyring-account" });
  });
});

describe.sequential("getGitHubIdentity / switchGhAccount", () => {
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
    expect(id.accounts.every((a) => a.hasPackages === false)).toBe(true);
  });

  it("reads the packages scope keyring-first, matching the credential GHCR pushes use", async () => {
    // pubuser's INJECTED token lacks write:packages, but its KEYRING entry
    // has it. getGhPackageCredentials pins the keyring token, so the identity
    // must report the keyring scope — not the token account's — or the
    // dialog and preflight would wrongly block a push that would succeed.
    const { getGitHubIdentity } = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenPubActive,
      keyring: STATUS.keyringPubAndEmu
    });
    const id = await getGitHubIdentity();
    expect(id.actingLogin).toBe("pubuser");
    expect(id.actingHasPackages).toBe(true);
    const pub = id.accounts.find((a) => a.login === "pubuser");
    expect(pub).toBeDefined();
    if (!pub) throw new Error("pubuser account missing");
    expect(pub.hasPackages).toBe(true);
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

  it("switches the active account, records the preference, and re-resolves acting identity", async () => {
    const gh = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    expect((await gh.getGitHubIdentity()).actingLogin).toBe("tokuser");

    // loadGh's router already answers `gh auth switch` (plus the re-primed
    // status probes after the cache reset). Clear the prime's recorded calls
    // so the switch spawn is calls[0].
    childProcess.execFile.mockClear();
    const res = await gh.switchGhAccount("keyuser");
    expect(res).toEqual({ ok: true });
    const [, args] = childProcess.execFile.mock.calls[0];
    expect(args).toEqual(["auth", "switch", "--user", "keyuser"]);

    const id = await gh.getGitHubIdentity();
    expect(id.preferredLogin).toBe("keyuser");
    expect(id.actingLogin).toBe("keyuser");
  });

  it("returns an error when gh auth switch fails", async () => {
    const gh = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow,
      switchError: "no such account"
    });
    const res = await gh.switchGhAccount("ghost");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no such account");
  });

  it("restores a persisted account choice via setPreferredGhLogin so it survives a restart", async () => {
    // Simulate a fresh process (post-restart): the injected token has the
    // workflow scope, so with no preference the strategy would act as the
    // token account (tokuser). Restoring the persisted choice must override
    // that and make setup act as the chosen keyring account instead — the
    // fix for the silent revert on restart.
    const gh = await loadGh("linux", {
      token: "tok",
      withToken: STATUS.tokenWithWorkflow,
      keyring: STATUS.keyringWithWorkflow
    });
    expect((await gh.getGitHubIdentity()).actingLogin).toBe("tokuser");

    gh.setPreferredGhLogin("keyuser");
    const id = await gh.getGitHubIdentity();
    expect(id.preferredLogin).toBe("keyuser");
    expect(id.actingLogin).toBe("keyuser");

    // A blank login clears the preference back to automatic resolution.
    gh.setPreferredGhLogin("");
    const cleared = await gh.getGitHubIdentity();
    expect(cleared.preferredLogin).toBe(null);
    expect(cleared.actingLogin).toBe("tokuser");
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
      userTokens: { pubuser: "keyring-pub-token", emuuser: "keyring-emu-token" }
    });
    // Acting identity is pubuser (token has workflow → token kept). GHCR
    // creds must pin to pubuser's keyring token, never the active EMU one.
    expect(await getGhPackageCredentials()).toEqual({
      token: "keyring-pub-token",
      username: "pubuser"
    });
  });

  it("honors an explicit switch to a keyring account for package auth", async () => {
    const gh = await loadGh("linux", {
      token: "injected-pub",
      withToken: STATUS.tokenPubActive,
      keyring: STATUS.keyringPubAndEmu,
      userTokens: { pubuser: "keyring-pub-token", emuuser: "keyring-emu-token" }
    });
    await gh.switchGhAccount("emuuser");
    expect(await gh.getGhPackageCredentials()).toEqual({
      token: "keyring-emu-token",
      username: "emuuser"
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
      username: "tokuser"
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
