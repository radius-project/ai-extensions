// Canvas adapter — shell + GitHub access primitives.
// Thin wrappers over the gh/az/aws CLIs plus the concrete GitHub port object
// (`github`) injected into @radius-project/core use-cases. This is the adapter's only
// process-spawning surface besides the deploy monitor and infra modules.

import { execFile } from "node:child_process";
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
  ExecFileOptionsWithStringEncoding
} from "node:child_process";

export interface GhAccount {
  login: string;
  source: string;
  active: boolean;
  scopes: string[];
}

interface GhSnapshot {
  hasToken: boolean;
  withTokenAccts: GhAccount[];
  keyringAccts: GhAccount[];
  tokenAcct: GhAccount | null;
  keyringActive: GhAccount | null;
}

export interface GhTokenStrategyInput {
  hasToken: boolean;
  tokenLogin?: string;
  tokenHasWorkflow?: boolean;
  keyringLogin?: string;
  keyringHasWorkflow?: boolean;
  preferredLogin?: string | null;
}

export interface GhTokenStrategy {
  useKeyring: boolean;
  reason: string;
}

export interface GitHubIdentityAccount {
  login: string;
  hasWorkflow: boolean;
  hasPackages: boolean;
  switchable: boolean;
  acting: boolean;
}

export interface GitHubIdentity {
  actingLogin: string;
  displayLogin: string;
  mismatch: boolean;
  actingHasWorkflow: boolean;
  actingHasPackages: boolean;
  preferredLogin: string | null;
  reason: string;
  accounts: GitHubIdentityAccount[];
  repoAccess?: string;
}

type CliCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string
) => void;

export interface CliOptions extends ExecFileOptions {
  env?: NodeJS.ProcessEnv;
}

export interface CommandOptions extends CliOptions {
  stdin?: string;
}

export interface ContentResult {
  content: string | null;
  error: string | null;
}

export interface ContentBytesTooLarge {
  tooLarge: true;
  size?: number;
}

export interface BranchRefResult {
  ok: boolean;
  stderr: string;
}

export interface PullRequestResult {
  ok: boolean;
  url?: string;
  number?: number;
  stderr?: string;
}

export interface GhApiResult {
  ok: boolean;
  status: number | null;
  json: unknown;
  stderr: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The host app injects a GH_TOKEN/GITHUB_TOKEN into the session environment, and
// gh always prefers that env token over the user's stored (keyring) login. That
// token is the identity the host UI shows, but it was historically minted
// WITHOUT the `workflow` scope, so `gh api ... PUT /contents/.github/workflows/...`
// was rejected with a 403. We therefore resolve a per-process token strategy
// (see decideGhTokenStrategy): keep the injected token when it already carries
// `workflow` (so setup acts as the identity the user sees), and fall back to a
// stored keyring login only when we must for scope — or when the user explicitly
// picks an account. The snapshot of `gh auth status` is memoized.
function ghExecutable() {
  return process.platform === "win32" ? "gh.exe" : "gh";
}

// The login the user explicitly chose in the UI (via switchGhAccount). Sticky
// for the process lifetime and always wins over the scope-based default. null
// means "no explicit choice — decide automatically".
let _preferredLogin: string | null = null;

// Memoized snapshot of `gh auth status` (default env + token-stripped env) and
// the derived token strategy. `_ghSnapshotPromise` is the in-flight/settled
// single-flight probe; `_ghSnapshot` is its resolved value, readable
// synchronously by the hot path once primed. Reset by resetGhIdentityCache()
// after a switch.
let _ghSnapshot: GhSnapshot | null = null;
let _ghSnapshotPromise: Promise<GhSnapshot> | null = null;
let _ghStrategy: GhTokenStrategy | null = null;

// Parse `gh auth status` text into structured accounts. Pure so it can be unit
// tested against real gh output across versions. Each account block looks like:
//   ✓ Logged in to github.com account <login> (<source>)
//     - Active account: true|false
//     - Token scopes: 'a', 'b', ...
export function parseGhAuthStatus(text: unknown): GhAccount[] {
  const accounts: GhAccount[] = [];
  let cur: GhAccount | null = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const acct = line.match(/Logged in to \S+ account (\S+) \(([^)]+)\)/);
    if (acct) {
      cur = { login: acct[1], source: acct[2], active: false, scopes: [] };
      accounts.push(cur);
      continue;
    }
    if (!cur) continue;
    const active = line.match(/Active account:\s*(true|false)/i);
    if (active) {
      cur.active = active[1].toLowerCase() === "true";
      continue;
    }
    const scopes = line.match(/Token scopes:\s*(.+)$/);
    if (scopes) {
      cur.scopes = scopes[1]
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
  }
  return accounts;
}

// Decide whether to strip the app-injected GH_TOKEN and fall back to the stored
// keyring account for a gh invocation. Pure so every branch is unit tested.
//
// The injected host token is the identity the UI shows, but historically it was
// minted WITHOUT the `workflow` scope, so writing `.github/workflows/*` failed
// with a 403. The old heuristic — "strip whenever any keyring login exists" —
// over-corrected: when the injected token DID have `workflow`, stripping it
// silently switched the acting identity to whatever keyring account happened to
// be active (e.g. an enterprise/EMU account that may lack access to the target
// repo or cloud tenant). We now strip only when we actually must, and an
// explicit user selection always wins.
export function decideGhTokenStrategy({
  hasToken,
  tokenLogin,
  tokenHasWorkflow,
  keyringLogin,
  keyringHasWorkflow,
  preferredLogin
}: GhTokenStrategyInput): GhTokenStrategy {
  // 1. An explicit user choice is authoritative. Keep the injected token only
  //    when the chosen login IS the token account; otherwise strip so gh uses
  //    the (already switched-to) keyring account.
  if (preferredLogin) {
    if (tokenLogin && preferredLogin === tokenLogin) {
      return { useKeyring: false, reason: "user-selected-token-account" };
    }
    return { useKeyring: true, reason: "user-selected-keyring-account" };
  }
  // 2. No injected token → the keyring account is all we have.
  if (!hasToken) return { useKeyring: true, reason: "no-injected-token" };
  // 3. Injected token already carries `workflow` → keep it (and its identity).
  if (tokenHasWorkflow)
    return { useKeyring: false, reason: "token-has-workflow" };
  // 4. Token lacks `workflow` but a keyring login has it → fall back for scope.
  if (keyringLogin && keyringHasWorkflow)
    return { useKeyring: true, reason: "token-missing-workflow" };
  // 5. Nothing better available → keep the token; a later 403 explains the gap.
  return { useKeyring: false, reason: "no-workflow-scope-available" };
}

// Run `gh auth status` asynchronously, returning its combined output. gh exits
// non-zero when not logged in but still prints useful text, so execFile's
// callback hands us stdout/stderr even on a non-zero exit — we recover the text
// rather than treating it as empty. Async on purpose: a synchronous spawn here
// froze the whole event loop for up to the timeout (twice, so ~16s worst case)
// on a slow/locked-down network.
function ghAuthStatusText(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      ghExecutable(),
      ["auth", "status"],
      {
        env,
        timeout: 8000,
        windowsHide: true
      },
      (_e, stdout, stderr) => {
        resolve(((stdout || "") + (stderr || "")).toString());
      }
    );
  });
}

// Snapshot the accounts gh sees with the injected token present vs stripped.
// Single-flight and memoized: the FIRST caller starts one probe; every caller
// (including ones that arrive while it is still in flight) awaits that same
// Promise, so concurrent gh work never spawns duplicate `gh auth status` runs.
// The resolved value is also cached in _ghSnapshot for the synchronous hot path.
function ensureGhSnapshot(): Promise<GhSnapshot> {
  if (_ghSnapshotPromise) return _ghSnapshotPromise;
  _ghSnapshotPromise = (async () => {
    const base = process.env;
    const hasToken = !!(base.GH_TOKEN || base.GITHUB_TOKEN);
    const stripped = { ...base };
    delete stripped.GH_TOKEN;
    delete stripped.GITHUB_TOKEN;
    const [withTokenText, keyringText] = await Promise.all([
      ghAuthStatusText(base),
      ghAuthStatusText(stripped)
    ]);
    const withTokenAccts = parseGhAuthStatus(withTokenText);
    const keyringAccts = parseGhAuthStatus(keyringText);
    const tokenAcct =
      hasToken ?
        withTokenAccts.find((a) => /TOKEN/i.test(a.source)) || null
      : null;
    const keyringActive =
      keyringAccts.find((a) => a.active) || keyringAccts[0] || null;
    _ghSnapshot = {
      hasToken,
      withTokenAccts,
      keyringAccts,
      tokenAcct,
      keyringActive
    };
    return _ghSnapshot;
  })();
  return _ghSnapshotPromise;
}

// Resolve (memoized) the token strategy from the current snapshot + preference.
async function ensureGhStrategy(): Promise<GhTokenStrategy> {
  if (_ghStrategy) return _ghStrategy;
  const s = await ensureGhSnapshot();
  _ghStrategy = decideGhTokenStrategy({
    hasToken: s.hasToken,
    tokenLogin: s.tokenAcct ? s.tokenAcct.login : "",
    tokenHasWorkflow: !!(
      s.tokenAcct && s.tokenAcct.scopes.includes("workflow")
    ),
    keyringLogin: s.keyringActive ? s.keyringActive.login : "",
    keyringHasWorkflow: !!(
      s.keyringActive && s.keyringActive.scopes.includes("workflow")
    ),
    preferredLogin: _preferredLogin
  });
  return _ghStrategy;
}

// Synchronous read of the resolved strategy for the hot path (ghChildEnv, called
// on every gh spawn). Returns the safe default (keep the injected token — the
// identity the host UI shows) until the async probe has resolved, so a spawn
// never blocks on the network. The default is superseded the moment the strategy
// resolves, which always happens before any workflow-scope write in the deploy
// flow (that flow resolves the identity up front).
function ghStrategyCached(): GhTokenStrategy {
  return (
    _ghStrategy || { useKeyring: false, reason: "identity-not-yet-resolved" }
  );
}

// Kick off (and await) the async `gh auth status` probes backing the identity
// strategy. Callers that need the token-stripping decision in effect for the gh
// calls that follow (the deploy flow, the identity endpoints, server startup)
// await this first. Single-flight/memoized, so calling it repeatedly is cheap.
export function primeGhIdentity(): Promise<GhTokenStrategy> {
  return ensureGhStrategy();
}

// Restore a previously chosen account (see server startup). Sets the sticky
// preference in memory only — persistence is owned by the server/shared layer,
// so this module stays free of disk I/O. Resets the identity cache so the next
// resolution honors the restored choice. A blank login clears the preference
// (back to "decide automatically").
export function setPreferredGhLogin(login: string): void {
  const next = (login || "").trim() || null;
  if (next === _preferredLogin) return;
  _preferredLogin = next;
  resetGhIdentityCache();
}

// Drop the memoized snapshot/strategy so the next gh call re-reads `gh auth
// status`. Call after anything that changes the active account (a switch). The
// sticky user preference is intentionally preserved across resets.
export function resetGhIdentityCache(): void {
  _ghSnapshot = null;
  _ghSnapshotPromise = null;
  _ghStrategy = null;
}

// Build the child environment for a `gh` invocation. Strips the injected
// GH_TOKEN/GITHUB_TOKEN only when the resolved strategy says to fall back to the
// keyring credential; otherwise passes the token through so gh keeps the
// identity the user sees. Stays synchronous (cliExec spawns synchronously) and
// reads only the cached strategy — it never blocks a spawn on the networked
// probe. Until the strategy resolves it uses the safe default (keep the token);
// priming happens at server startup and whenever the identity is resolved
// (the identity endpoints and the deploy flow), which is before any
// workflow-scope write, so the strategy is in effect when it matters.
function ghChildEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(baseEnv || process.env) };
  if (ghStrategyCached().useKeyring) {
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
  }
  return env;
}

// Resolve the effective GitHub identity for setup, plus the switchable account
// list. `actingLogin` is who gh mutates as (after the strategy decision);
// `displayLogin` is who the injected token represents (what the host UI shows).
// A mismatch means setup would act as a different account than the user thinks.
export async function getGitHubIdentity(): Promise<GitHubIdentity> {
  const s = await ensureGhSnapshot();
  const strat = await ensureGhStrategy();
  const displayLogin =
    s.hasToken && s.tokenAcct ? s.tokenAcct.login
    : s.keyringActive ? s.keyringActive.login
    : "";
  const actingLogin =
    strat.useKeyring ?
      s.keyringActive ?
        s.keyringActive.login
      : ""
    : s.tokenAcct ? s.tokenAcct.login
    : s.keyringActive ? s.keyringActive.login
    : "";
  // De-duplicated switchable account list. An account is switchable when it
  // exists in the keyring (gh auth switch operates on keyring accounts).
  const keyringLogins = new Set(s.keyringAccts.map((a) => a.login));
  // GHCR pushes authenticate with the credential getGhPackageCredentials
  // resolves: the keyring token pinned to the login when a keyring entry
  // exists, else the injected token. So the *packages* scope must be read
  // keyring-first — reading the token account first (as hasWorkflow does)
  // would misreport for a login whose keyring credential differs from its
  // injected one.
  const keyringScopesByLogin = new Map(
    s.keyringAccts.map((a) => [a.login, a.scopes])
  );
  const tokenScopesByLogin = new Map(
    s.withTokenAccts.map((a) => [a.login, a.scopes])
  );
  const packageScopesFor = (login: string): string[] =>
    keyringScopesByLogin.get(login) || tokenScopesByLogin.get(login) || [];
  const seen = new Set<string>();
  const accounts: GitHubIdentityAccount[] = [];
  for (const a of [...s.withTokenAccts, ...s.keyringAccts]) {
    if (seen.has(a.login)) continue;
    seen.add(a.login);
    accounts.push({
      login: a.login,
      hasWorkflow: a.scopes.includes("workflow"),
      hasPackages: packageScopesFor(a.login).includes("write:packages"),
      switchable: keyringLogins.has(a.login),
      acting: a.login === actingLogin
    });
  }
  const actingAcct = accounts.find((a) => a.login === actingLogin) || null;
  return {
    actingLogin,
    displayLogin,
    mismatch: !!(actingLogin && displayLogin && actingLogin !== displayLogin),
    actingHasWorkflow: !!(actingAcct && actingAcct.hasWorkflow),
    actingHasPackages: !!(actingAcct && actingAcct.hasPackages),
    preferredLogin: _preferredLogin,
    reason: strat.reason,
    accounts
  };
}

// Switch the active gh account to `login`. gh auth switch changes the keyring
// active account; because a present GH_TOKEN would still override it at call
// time, we also record the preference (so ghChildEnv strips the token when the
// chosen account is not the token account) and reset the identity cache.
// Resolves { ok, error } and never rejects.
export function switchGhAccount(
  login: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!login) {
      resolve({ ok: false, error: "A GitHub account login is required." });
      return;
    }
    const env = { ...process.env };
    execFile(
      ghExecutable(),
      ["auth", "switch", "--user", login],
      { env, timeout: 15000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: (
              (stderr || "").trim() ||
              err.message ||
              "gh auth switch failed"
            ).trim()
          });
          return;
        }
        _preferredLogin = login;
        resetGhIdentityCache();
        resolve({ ok: true });
      }
    );
  });
}

// Read the keyring token for a SPECIFIC login without changing the active
// account. GH_TOKEN/GITHUB_TOKEN/GH_HOST are stripped so gh reads the stored
// (keyring) credential, and `--user` pins the account so we never fall through
// to whichever account happens to be active. Returns "" when gh can't produce a
// token for that login (e.g. no keyring entry).
function ghKeyringTokenForUser(login: string): Promise<string> {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_HOST;
  return new Promise((resolve) => {
    execFile(
      ghExecutable(),
      ["auth", "token", "--hostname", "github.com", "--user", login],
      { env, timeout: 8000, windowsHide: true },
      (e, stdout) => {
        resolve(e ? "" : (stdout || "").toString().trim());
      }
    );
  });
}

// Resolve GitHub credentials for GHCR / GitHub Packages operations that match
// the identity setup acts as (the account shown and selected in the dialog),
// instead of whatever keyring account is merely active. This is the package
// analogue of ghChildEnv: without it, `gh auth token` returns the active
// keyring account — which on multi-account machines can be an enterprise/EMU
// login that GHCR rejects ("As an Enterprise Managed User, you cannot access
// this content") even though the rest of setup runs as the intended account.
//
// Preference order:
//   1. When the acting login has a keyring entry, use its token pinned via
//      `--user` (a full `gh auth login` credential, which carries the
//      read:packages/write:packages scopes GHCR needs).
//   2. Otherwise fall back to the injected GH_TOKEN/GITHUB_TOKEN for that same
//      identity. It may lack package scopes, in which case GHCR returns a scope
//      error the caller surfaces with refresh guidance.
// Throws when no credential can be resolved. `username` is always the acting
// login so the Basic-auth pair matches the token.
export async function getGhPackageCredentials(): Promise<{
  token: string;
  username: string;
}> {
  const id = await getGitHubIdentity();
  const login = id.actingLogin;
  if (!login) {
    throw new Error(
      "No GitHub account is available for package setup. Sign in with: gh auth login"
    );
  }
  const acct = (id.accounts || []).find((a) => a.login === login) || null;
  if (acct && acct.switchable) {
    const token = await ghKeyringTokenForUser(login);
    if (token) return { token, username: login };
  }
  const injected = (
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ""
  ).trim();
  if (injected) return { token: injected, username: login };
  throw new Error(
    `Could not obtain a GitHub token for @${login}. Sign in with: gh auth login`
  );
}

// Returns true when cmd refers to the gh CLI regardless of whether the caller
// passes "gh", "gh.exe", or an absolute path to the executable.
function isGhCmd(cmd: string): boolean {
  return /(?:^|[\\/])gh(?:\.exe)?$/i.test(cmd);
}

// Azure CLI 2.88+ "agentic session": when COPILOT_AGENT_SESSION_ID is set, az injects it as a
// `client_session` query param + a claims challenge that BYPASSES the token cache and forces a
// fresh ESTS fetch on every call. The GitHub Copilot app sets this var for all child processes,
// so the canvas's az subprocess inherits it. On locked-down tenants (e.g. Microsoft Corpnet) ESTS
// rejects the injected client_session with AADSTS901001, breaking every networked az command
// (discover, app registration, role assignment). The canvas runs az as the signed-in human user
// for infra setup, so agentic tagging is both unwanted and fatal here — strip it so az uses normal
// cache-first user auth. Applies to every child CLI (az/aws/kubectl/gh); none of them need it.
function withoutAgentSession(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(baseEnv || process.env) };
  delete env.COPILOT_AGENT_SESSION_ID;
  return env;
}

// Run a CLI (gh/az/aws). GitHub CLI ships as gh.exe on Windows, so invoke that
// executable directly: passing it through cmd.exe would let metacharacters in an
// API path (for example, '&' in a query string) be interpreted as shell syntax.
// Other Windows CLIs may only provide `.cmd` shims, so retain the existing
// cmd.exe wrapper for those commands.
export function cliExec(
  cmd: string,
  args: string[],
  opts: CliOptions,
  cb: CliCallback
): ChildProcess {
  const isWindows = process.platform === "win32";
  const isWindowsGh = isWindows && isGhCmd(cmd);
  const file =
    isWindowsGh ? ghExecutable()
    : isWindows ? "cmd.exe"
    : cmd;
  const finalArgs = isWindows && !isWindowsGh ? ["/c", cmd, ...args] : args;
  const execOpts: ExecFileOptionsWithStringEncoding = {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...opts,
    encoding: "utf8"
  };
  if (isGhCmd(cmd)) execOpts.env = ghChildEnv(execOpts.env);
  execOpts.env = withoutAgentSession(execOpts.env);
  return execFile(file, finalArgs, execOpts, cb);
}

// Runs a CLI and resolves with trimmed stdout. Pass `opts.stdin` to feed a value
// (e.g. a secret) over stdin instead of exposing it on the argv/process list.
export function runCommand(
  cmd: string,
  args: string[],
  opts: CommandOptions = {}
): Promise<string> {
  const { stdin, ...execOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = cliExec(cmd, args, execOpts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

// Run gh with only its stored keyring credential. This is intentionally stricter
// than cliExec's normal fallback because package bootstrap must never inherit an
// ambient workflow/app token whose package visibility semantics may differ.
// Deleting GH_HOST pins these calls to github.com. That is intentional: the GHCR
// and GitHub Packages API paths in this feature are hardcoded to ghcr.io/github.com,
// so package bootstrap is github.com-only and does not support GHES today.
export function runGhKeyringCommand(
  args: string[],
  opts: CommandOptions = {}
): Promise<string> {
  const env = { ...(opts.env || process.env) };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_HOST;
  return runCommand("gh", args, { ...opts, env });
}

export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "sa-east-1",
  "ca-central-1"
];

export function ghApiGetContent(
  apiPath: string,
  timeout = 15000
): Promise<string | null> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", apiPath, "--jq", ".content"],
      { timeout },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(Buffer.from(stdout.trim(), "base64").toString("utf8"));
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

// Fetch a file's raw bytes from the GitHub contents API. Resolves a Buffer on
// success, null when the file is absent or unreadable, or { tooLarge: true }
// when the file exceeds the contents API inline limit (~1MB): GitHub then
// returns an empty `content` with `encoding` "none", and the blob/raw API would
// be needed. Used to stage binary extension artifacts (e.g. custom-types.tgz)
// from a committed branch, which ghApiGetContent would corrupt by decoding as
// UTF-8.
export function ghApiGetContentBytes(
  apiPath: string,
  timeout = 20000
): Promise<Buffer | ContentBytesTooLarge | null> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", apiPath, "--jq", "{content: .content, encoding: .encoding}"],
      { timeout },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && parsed.encoding === "base64" && parsed.content) {
            resolve(Buffer.from(parsed.content, "base64"));
            return;
          }
          // encoding "none" with empty content == file too large for the
          // contents API's inline response.
          resolve({ tooLarge: true });
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

export function ghApiListNames(
  apiPath: string,
  timeout = 15000
): Promise<string[]> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", apiPath, "--jq", `[.[].name]`],
      { timeout },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve([]);
        }
      }
    );
  });
}

export function fetchFileFromRepo(
  repo: string,
  path: string,
  branch = "main"
): Promise<string | null> {
  return ghApiGetContent(`/repos/${repo}/contents/${path}?ref=${branch}`);
}

/**
 * Like ghApiGetContent, but surfaces the underlying failure instead of
 * collapsing everything to null. Resolves `{ content, error }`: on success
 * `content` is the decoded file body and `error` is null; on failure `content`
 * is null and `error` is a human-readable cause (gh stderr, a decode error, or
 * an empty-response note). Never rejects.
 */
export function ghApiGetContentResult(
  apiPath: string,
  timeout = 15000
): Promise<ContentResult> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", apiPath, "--jq", ".content"],
      { timeout },
      (err, stdout, stderr) => {
        if (err) {
          const detail =
            (stderr && stderr.trim()) || err.message || String(err);
          resolve({ content: null, error: detail.trim() });
          return;
        }
        if (!stdout || !stdout.trim()) {
          resolve({ content: null, error: "empty response from gh api" });
          return;
        }
        try {
          resolve({
            content: Buffer.from(stdout.trim(), "base64").toString("utf8"),
            error: null
          });
        } catch (e) {
          resolve({
            content: null,
            error: `failed to decode response: ${errorMessage(e)}`
          });
        }
      }
    );
  });
}

/** Repo-file variant of ghApiGetContentResult. Resolves `{ content, error }`. */
export function fetchFileFromRepoResult(
  repo: string,
  path: string,
  branch = "main"
): Promise<ContentResult> {
  return ghApiGetContentResult(`/repos/${repo}/contents/${path}?ref=${branch}`);
}

export function fetchRepoTree(
  repo: string,
  branch = "main"
): Promise<string[]> {
  return new Promise((resolve) => {
    const args = [
      "api",
      `/repos/${repo}/git/trees/${branch}?recursive=1`,
      "--jq",
      `[.tree[].path]`
    ];
    cliExec("gh", args, { timeout: 30000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        const value: unknown = JSON.parse(stdout);
        resolve(
          Array.isArray(value) ?
            value.filter((item): item is string => typeof item === "string")
          : []
        );
      } catch (e) {
        resolve([]);
      }
    });
  });
}

export const github = {
  getContent: (apiPath: string) => ghApiGetContent(apiPath),
  getContentBytes: (apiPath: string) => ghApiGetContentBytes(apiPath),
  listNames: (apiPath: string) => ghApiListNames(apiPath),
  treePaths: (repo: string, branch = "main") => fetchRepoTree(repo, branch)
};

// Look up a file's blob SHA on a branch; resolves '' when the file is absent.
function getRepoFileSha(
  repo: string,
  path: string,
  branch: string,
  timeout = 10000
): Promise<string> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", `/repos/${repo}/contents/${path}?ref=${branch}`, "--jq", ".sha"],
      { timeout },
      (err, stdout) => {
        resolve(err ? "" : (stdout || "").trim());
      }
    );
  });
}

// Create or update a single UTF-8 text file on a repo branch via the GitHub
// contents API. Reuses the existing blob SHA so a re-commit is an update rather
// than a rejected create. The commit body is fed over stdin (never argv) so the
// base64 payload can't collide with shell/CLI parsing. Rejects on failure.
export async function commitFileToRepo(
  repo: string,
  path: string,
  content: string,
  branch: string,
  message: string,
  timeout = 30000
): Promise<boolean> {
  const sha = await getRepoFileSha(repo, path, branch);
  const body = JSON.stringify({
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    ...(sha ? { sha } : {})
  });
  return new Promise((resolve, reject) => {
    const child = cliExec(
      "gh",
      [
        "api",
        "--method",
        "PUT",
        `/repos/${repo}/contents/${path}`,
        "--input",
        "-"
      ],
      { timeout },
      (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr && stderr.trim()) || err.message));
        else resolve(true);
      }
    );
    try {
      child.stdin?.end(body);
    } catch {
      /* best-effort */
    }
  });
}

// Resolve a repo's default branch name (e.g. "main"). Resolves '' on failure.
export function getDefaultBranch(
  repo: string,
  timeout = 15000
): Promise<string> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", `/repos/${repo}`, "--jq", ".default_branch"],
      { timeout },
      (err, stdout) => {
        resolve(err ? "" : (stdout || "").trim());
      }
    );
  });
}

// Get the head commit SHA of a branch. Resolves '' when the branch is absent.
export function getBranchHeadSha(
  repo: string,
  branch: string,
  timeout = 15000
): Promise<string> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      [
        "api",
        `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        "--jq",
        ".object.sha"
      ],
      { timeout },
      (err, stdout) => {
        resolve(err ? "" : (stdout || "").trim());
      }
    );
  });
}

// Create a new branch ref (refs/heads/<newBranch>) pointing at fromSha.
// Resolves { ok, stderr }; never rejects.
export function createBranchRef(
  repo: string,
  newBranch: string,
  fromSha: string,
  timeout = 20000
): Promise<BranchRefResult> {
  const body = JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: fromSha });
  return new Promise((resolve) => {
    const child = cliExec(
      "gh",
      ["api", "--method", "POST", `/repos/${repo}/git/refs`, "--input", "-"],
      { timeout },
      (err, _stdout, stderr) => {
        resolve({
          ok: !err,
          stderr: ((stderr && stderr.trim()) || err?.message || "").trim()
        });
      }
    );
    try {
      child.stdin?.end(body);
    } catch {
      /* best-effort */
    }
  });
}

// Open a pull request from `head` into `base`. Resolves
// { ok, url, number, stderr }; never rejects. The body is fed over stdin so
// arbitrary title/body text can't collide with CLI parsing.
export function createPullRequestApi(
  repo: string,
  head: string,
  base: string,
  title: string,
  prBody: string,
  timeout = 20000
): Promise<PullRequestResult> {
  const body = JSON.stringify({ title, head, base, body: prBody || "" });
  return new Promise((resolve) => {
    const child = cliExec(
      "gh",
      ["api", "--method", "POST", `/repos/${repo}/pulls`, "--input", "-"],
      { timeout },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            stderr: ((stderr && stderr.trim()) || err.message || "").trim()
          });
          return;
        }
        try {
          const j = JSON.parse(stdout);
          resolve({ ok: true, url: j.html_url, number: j.number });
        } catch (e) {
          resolve({
            ok: false,
            stderr: `Could not parse PR response: ${errorMessage(e)}`
          });
        }
      }
    );
    try {
      child.stdin?.end(body);
    } catch {
      /* best-effort */
    }
  });
}

// GET a GitHub JSON resource, surfacing the HTTP status so callers can
// distinguish "not found" (404) from access/other failures. `gh api` exits
// non-zero on HTTP errors and prints e.g. "gh: Not Found (HTTP 404)" to stderr;
// we parse that status out. Optional `headers` are passed as `-H k: v` (used to
// pin X-GitHub-Api-Version). Resolves `{ ok, status, json, stderr }`; never
// rejects. stdin is closed so gh can never block on an interactive prompt.
export function ghApiJson(
  apiPath: string,
  {
    headers = {},
    timeout = 15000
  }: { headers?: Record<string, string>; timeout?: number } = {}
): Promise<GhApiResult> {
  const args = ["api", apiPath];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  return new Promise((resolve) => {
    const child = cliExec("gh", args, { timeout }, (err, stdout, stderr) => {
      if (!err) {
        try {
          resolve({
            ok: true,
            status: 200,
            json: JSON.parse(stdout || "null"),
            stderr: ""
          });
        } catch (e) {
          resolve({
            ok: false,
            status: 200,
            json: null,
            stderr: `failed to parse response: ${errorMessage(e)}`
          });
        }
        return;
      }
      const detail = ((stderr && stderr.trim()) || err.message || "").trim();
      const m =
        detail.match(/\(HTTP (\d{3})\)/) || detail.match(/\bHTTP (\d{3})\b/);
      resolve({
        ok: false,
        status: m ? Number(m[1]) : null,
        json: null,
        stderr: detail
      });
    });
    try {
      child.stdin?.end();
    } catch {
      /* best-effort */
    }
  });
}
