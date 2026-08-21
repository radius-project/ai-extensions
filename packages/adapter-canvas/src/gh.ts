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
  tokenHasWorkflow?: boolean;
  keyringLogin?: string;
  keyringHasWorkflow?: boolean;
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

export type GhPackageCredentialSource =
  "keyring" | "injected-token" | "unavailable";

export interface GitHubIdentity {
  actingLogin: string;
  displayLogin: string;
  mismatch: boolean;
  actingHasWorkflow: boolean;
  actingHasPackages: boolean;
  packagesLogin: string;
  packagesHasWrite: boolean;
  // The credential GHCR pushes will ACTUALLY use, resolved by the same code
  // path as getGhPackageCredentials (including its keyring-lookup failure
  // fallback) rather than predicted from the account list.
  packagesCredentialSource: GhPackageCredentialSource;
  reason: string;
  accounts: GitHubIdentityAccount[];
  repoAccess?: string;
}

export interface GhPackageCredentials {
  token: string;
  username: string;
  source: Exclude<GhPackageCredentialSource, "unavailable">;
}

type GhPackageCredentialResolution =
  | { ok: true; credentials: GhPackageCredentials }
  | { ok: false; error: string };

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

export interface SelectedGhCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export type SelectedGhCredentialSource = "injected" | "keyring";

export interface SelectedGhExecutor {
  readonly login: string;
  readonly credentialSource: SelectedGhCredentialSource;
  readonly requiresKeyringSwitch: boolean;
  readonly scopes: readonly string[];
  run(
    args: string[],
    options?: CommandOptions
  ): Promise<SelectedGhCommandResult>;
  runOrThrow(
    args: string[],
    message: string,
    options?: CommandOptions
  ): Promise<SelectedGhCommandResult>;
  verifyIdentity(): Promise<void>;
  packageCredentials(): GhPackageCredentials;
  redact(value: string): string;
  errorMessage(error: unknown): string;
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

export function getInjectedGhToken(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || "";
}

export function parseGhVersion(
  text: string
): [major: number, minor: number] | null {
  const match = text.match(/\bgh version (\d+)\.(\d+)\./i);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function supportsGhMultiAccount(version: [number, number]): boolean {
  return version[0] > 2 || (version[0] === 2 && version[1] >= 40);
}

const MIN_OPAQUE_TOKEN_REDACTION_LENGTH = 12;

// This module is the gh process boundary, so every diagnostic leaving it must
// redact both recognizable GitHub credentials and opaque injected tokens.
export function redactGhCredentials(
  value: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let redacted = value;
  for (const token of [env.GH_TOKEN?.trim(), env.GITHUB_TOKEN?.trim()]) {
    if (token && token.length >= MIN_OPAQUE_TOKEN_REDACTION_LENGTH)
      redacted = redacted.replaceAll(token, "[REDACTED]");
  }
  return redacted.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
    "[REDACTED]"
  );
}

function errorMessage(error: unknown): string {
  return redactGhCredentials(
    error instanceof Error ? error.message : String(error)
  );
}

// The host app injects a GH_TOKEN/GITHUB_TOKEN into the session environment, and
// gh always prefers that env token over the user's stored (keyring) login. That
// token is the identity the host UI shows, but it was historically minted
// WITHOUT the `workflow` scope, so `gh api ... PUT /contents/.github/workflows/...`
// was rejected with a 403. We therefore resolve a per-process token strategy
// (see decideGhTokenStrategy): keep the injected token when it already carries
// `workflow` (so setup acts as the identity the user sees), and fall back to a
// stored keyring login only when we must for scope. The snapshot of `gh auth
// status` is memoized.
function ghExecutable() {
  return process.platform === "win32" ? "gh.exe" : "gh";
}

// Memoized snapshot of `gh auth status` (default env + token-stripped env) and
// the derived token strategy. `_ghSnapshotPromise` is the in-flight/settled
// single-flight probe; `_ghSnapshot` is its resolved value, readable
// synchronously by the hot path once primed. Reset by resetGhIdentityCache()
// after a switch.
let _ghSnapshot: GhSnapshot | null = null;
let _ghSnapshotPromise: Promise<GhSnapshot> | null = null;
let _ghStrategy: GhTokenStrategy | null = null;

// Single-flight resolution of the credential GHCR/GitHub Packages calls use.
// Memoized alongside the snapshot (and cleared by the same reset) so the
// identity endpoints can report the credential that will ACTUALLY be used —
// including the injected-token fallback taken when the keyring lookup fails —
// without spawning a second `gh auth token` per read.
let _ghPackageCredentialPromise: Promise<GhPackageCredentialResolution> | null =
  null;
const GH_KEYRING_TOKEN_TIMEOUT_MS = 3000;

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
// repo or cloud tenant). We now strip only when we actually must.
export function decideGhTokenStrategy({
  hasToken,
  tokenHasWorkflow,
  keyringLogin,
  keyringHasWorkflow
}: GhTokenStrategyInput): GhTokenStrategy {
  // 1. No injected token → the keyring account is all we have.
  if (!hasToken) return { useKeyring: true, reason: "no-injected-token" };
  // 2. Injected token already carries `workflow` → keep it (and its identity).
  if (tokenHasWorkflow)
    return { useKeyring: false, reason: "token-has-workflow" };
  // 3. Token lacks `workflow` but a keyring login has it → fall back for scope.
  if (keyringLogin && keyringHasWorkflow)
    return { useKeyring: true, reason: "token-missing-workflow" };
  // 4. Nothing better available → keep the token; a later 403 explains the gap.
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
      ["auth", "status", "--hostname", "github.com"],
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

// The `gh auth status` source strings that identify the host-injected
// environment token. gh prints the exact environment variable name it read the
// credential from, so the match is exact: a `/TOKEN/i` substring test also
// matched `oauth_token`, which is how gh reports a STORED credential kept in
// hosts.yml rather than the OS keyring. Treating that stored login as the
// injected token made setup resolve the wrong identity (and the wrong package
// credential) on every machine with secure storage disabled.
const INJECTED_TOKEN_SOURCES = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

export function isInjectedTokenSource(source: string): boolean {
  const value = (source || "").trim();
  return INJECTED_TOKEN_SOURCES.some((name) => name === value);
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
    const hasToken = !!getInjectedGhToken(base);
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
        withTokenAccts.find((a) => isInjectedTokenSource(a.source)) || null
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
    tokenHasWorkflow: !!(
      s.tokenAcct && s.tokenAcct.scopes.includes("workflow")
    ),
    keyringLogin: s.keyringActive ? s.keyringActive.login : "",
    keyringHasWorkflow: !!(
      s.keyringActive && s.keyringActive.scopes.includes("workflow")
    )
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

// Drop the memoized snapshot/strategy so the next gh call re-reads `gh auth
// status`. Call after anything that changes the active account.
export function resetGhIdentityCache(): void {
  _ghSnapshot = null;
  _ghSnapshotPromise = null;
  _ghStrategy = null;
  _ghPackageCredentialPromise = null;
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

export function ghCommandCredentialSource(
  env: NodeJS.ProcessEnv = process.env
): SelectedGhCredentialSource {
  return getInjectedGhToken(env) !== "" && !ghStrategyCached().useKeyring ?
      "injected"
    : "keyring";
}

// Which login gh will actually act as, given the snapshot and the resolved
// strategy. Shared by the identity report and the package-credential resolver so
// the two can never disagree about who setup runs as.
function resolveActingLogin(
  snapshot: GhSnapshot,
  strategy: GhTokenStrategy
): string {
  if (strategy.useKeyring) {
    return snapshot.keyringActive ? snapshot.keyringActive.login : "";
  }
  if (snapshot.tokenAcct) return snapshot.tokenAcct.login;
  return snapshot.keyringActive ? snapshot.keyringActive.login : "";
}

// Resolve (single-flight, memoized) the credential GHCR / GitHub Packages
// operations will use, together with WHICH credential it turned out to be.
//
// Preference order:
//   1. When the acting login has a keyring entry, use its token pinned via
//      `--user` (a full `gh auth login` credential, which carries the
//      read:packages/write:packages scopes GHCR needs).
//   2. Otherwise — including when that keyring lookup yields nothing — fall back
//      to the injected GH_TOKEN/GITHUB_TOKEN for that same identity. It may lack
//      package scopes, in which case GHCR returns a scope error the caller
//      surfaces with refresh guidance.
// The resolved `source` is what the dialog and the GHCR preflight report, so a
// failed keyring lookup is never presented as a keyring credential.
function ensurePackageCredential(): Promise<GhPackageCredentialResolution> {
  if (_ghPackageCredentialPromise) return _ghPackageCredentialPromise;
  _ghPackageCredentialPromise = (async () => {
    const snapshot = await ensureGhSnapshot();
    const strategy = await ensureGhStrategy();
    const login = resolveActingLogin(snapshot, strategy);
    if (!login) {
      return {
        ok: false,
        error:
          "No GitHub account is available for package setup. Sign in with: gh auth login"
      };
    }
    const hasKeyringEntry = snapshot.keyringAccts.some(
      (a) => a.login === login
    );
    if (hasKeyringEntry) {
      const token = await ghKeyringTokenForUser(login);
      if (token) {
        return {
          ok: true,
          credentials: { token, username: login, source: "keyring" }
        };
      }
    }
    const injected = getInjectedGhToken();
    if (injected) {
      return {
        ok: true,
        credentials: {
          token: injected,
          username: login,
          source: "injected-token"
        }
      };
    }
    return {
      ok: false,
      error: `Could not obtain a GitHub token for @${login}. Sign in with: gh auth login`
    };
  })();
  return _ghPackageCredentialPromise;
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
  const actingLogin = resolveActingLogin(s, strat);
  // De-duplicated switchable account list. An account is switchable when it
  // exists in the keyring (gh auth switch operates on keyring accounts).
  const keyringLogins = new Set(s.keyringAccts.map((a) => a.login));
  // GHCR pushes authenticate with the credential ensurePackageCredential
  // resolves: the keyring token pinned to the login when a keyring entry
  // exists, else the injected token. So the *packages* scope must be read
  // keyring-first — reading the token account first (as the gh CLI strategy
  // does) would misreport for a login whose keyring credential differs from its
  // injected one.
  const keyringScopesByLogin = new Map(
    s.keyringAccts.map((a) => [a.login, a.scopes])
  );
  const tokenScopesByLogin = new Map(
    s.withTokenAccts.map((a) => [a.login, a.scopes])
  );
  // The injected token's scopes for a login. One login can be signed in twice
  // — once as the host-injected session token and once as a stored credential
  // — and gh prints both blocks under the same host, so `tokenScopesByLogin`
  // keeps only the last. The parsed token account is the authoritative reading
  // of the injected credential, so it wins whenever it names this login.
  const injectedScopesFor = (login: string): string[] | undefined =>
    s.tokenAcct && s.tokenAcct.login === login ?
      s.tokenAcct.scopes
    : tokenScopesByLogin.get(login);
  // Prefer the keyring scopes for a login, else the injected token's. Keys off
  // Map.has, not the value's truthiness: parseGhAuthStatus yields scopes: [] for
  // an account whose "Token scopes:" line is absent/unparsed, and an empty array
  // is truthy — a `get(login) || …` chain would treat that as "resolved" and
  // never consult the other credential. has() makes presence explicit instead.
  const preferKeyring = (login: string): string[] =>
    keyringScopesByLogin.has(login) ?
      keyringScopesByLogin.get(login)!
    : (injectedScopesFor(login) ?? []);
  // Packages auth is independent of the workflow token strategy, so the
  // write:packages scope is always resolved keyring-first.
  const packagesScopesFor = (login: string): string[] => preferKeyring(login);
  // The workflow scope must be read from the credential that will ACTUALLY act
  // as a login — the one decideGhTokenStrategy selects — not blanket
  // keyring-first. gh keeps the injected token when it already carries workflow
  // (so the token's scopes are in effect) and falls back to the keyring
  // credential only when the token lacks workflow. Reading keyring-first
  // unconditionally misreports in both directions: it clears the warning when a
  // keyring credential has MORE scopes than a shadowing same-login token (issue
  // #213), but would wrongly report workflow missing in the mirror case where
  // the injected token has workflow and its same-login keyring credential does
  // not — telling the user to run a refresh for a scope the acting credential
  // already has.
  //   - Acting login: read exactly the credential the resolved strategy selected
  //     (strat.useKeyring ? keyring : token) — what gh will run as. Do NOT cross
  //     to the other credential when the selected one is present; its scopes are
  //     what runs, even if empty. Only fall back if the selected credential has
  //     no entry for the login at all (unusual).
  //   - Any other switchable account is a keyring login; switching to it sets a
  //     preference other than the token login, which forces the keyring
  //     credential (decideGhTokenStrategy), so its keyring scopes apply.
  const workflowScopesFor = (login: string): string[] => {
    if (login === actingLogin) {
      if (strat.useKeyring) {
        if (keyringScopesByLogin.has(login)) {
          return keyringScopesByLogin.get(login)!;
        }
      } else {
        const injected = injectedScopesFor(login);
        if (injected !== undefined) return injected;
      }
    }
    return preferKeyring(login);
  };
  // Resolve the credential that will really publish, so the page can name it
  // and give guidance that applies to it. An injected session token overrides
  // stored gh logins, and telling a customer to run `gh auth refresh` for a
  // credential gh cannot change is a dead end.
  const packagesResolution = await ensurePackageCredential();
  const packagesLogin =
    packagesResolution.ok ?
      packagesResolution.credentials.username
    : actingLogin;
  const packagesCredentialSource: GhPackageCredentialSource =
    packagesResolution.ok ?
      packagesResolution.credentials.source
    : "unavailable";
  const resolvedPackagesScopes =
    (packagesCredentialSource === "keyring" ?
      keyringScopesByLogin.get(packagesLogin)
    : packagesCredentialSource === "injected-token" ?
      injectedScopesFor(packagesLogin)
    : undefined) || [];
  const packagesHasWrite = resolvedPackagesScopes.includes("write:packages");
  const seen = new Set<string>();
  const accounts: GitHubIdentityAccount[] = [];
  for (const a of [...s.withTokenAccts, ...s.keyringAccts]) {
    if (seen.has(a.login)) continue;
    seen.add(a.login);
    accounts.push({
      login: a.login,
      hasWorkflow: workflowScopesFor(a.login).includes("workflow"),
      // The account the packages credential resolved for reports the scopes of
      // that exact credential; every other account keeps the keyring-first
      // prediction of what selecting it would use.
      hasPackages:
        (
          a.login === packagesLogin &&
          packagesCredentialSource !== "unavailable"
        ) ?
          packagesHasWrite
        : packagesScopesFor(a.login).includes("write:packages"),
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
    packagesLogin,
    packagesHasWrite,
    packagesCredentialSource,
    reason: strat.reason,
    accounts
  };
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
      { env, timeout: GH_KEYRING_TOKEN_TIMEOUT_MS, windowsHide: true },
      (e, stdout) => {
        resolve(e ? "" : (stdout || "").toString().trim());
      }
    );
  });
}

function ghVersion(): Promise<[major: number, minor: number] | null> {
  return new Promise((resolve) => {
    execFile(
      ghExecutable(),
      ["--version"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : parseGhVersion((stdout || "").toString()));
      }
    );
  });
}

function selectedCredentialRedactor(token: string): (value: string) => string {
  return (value) => {
    const selectedRedacted =
      token === "" ? value : value.replaceAll(token, "[REDACTED]");
    return redactGhCredentials(selectedRedacted);
  };
}

function selectedErrorMessage(
  error: unknown,
  redact: (value: string) => string
): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function selectedExecError(
  error: ExecFileException,
  redact: (value: string) => string
): ExecFileException {
  const safe = Object.assign(new Error(redact(error.message)), {
    code: error.code,
    killed: error.killed,
    signal: error.signal,
    cmd: redact(error.cmd || "")
  });
  safe.name = error.name;
  if (error.stack) safe.stack = redact(error.stack);
  if (error.cause !== undefined) {
    safe.cause =
      error.cause instanceof Error ?
        new Error(selectedErrorMessage(error.cause, redact))
      : redact(String(error.cause));
  }
  return safe;
}

function pinnedGhExec(
  token: string,
  args: string[],
  options: CliOptions,
  callback: CliCallback,
  redact: (value: string) => string
): ChildProcess {
  const env = withoutAgentSession(options.env);
  delete env.GITHUB_TOKEN;
  delete env.GH_HOST;
  env.GH_TOKEN = token;
  const execOptions: ExecFileOptionsWithStringEncoding = {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...options,
    env,
    encoding: "utf8"
  };
  return execFile(
    ghExecutable(),
    args,
    execOptions,
    (error, stdout, stderr) => {
      callback(
        error ? selectedExecError(error, redact) : null,
        redact((stdout || "").toString()),
        redact((stderr || "").toString())
      );
    }
  );
}

export async function createSelectedGhExecutor(
  selectedLogin: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<SelectedGhExecutor> {
  const login = selectedLogin.trim();
  if (!login) throw new Error("A GitHub account login is required.");

  const snapshot = await ensureGhSnapshot();
  const injectedToken = getInjectedGhToken(env);
  const injectedAccount = snapshot.withTokenAccts.find(
    (account) =>
      account.login === login && isInjectedTokenSource(account.source)
  );
  const keyringAccount = snapshot.keyringAccts.find(
    (account) => account.login === login
  );
  const requiredScopeScore = (account: GhAccount | undefined): number =>
    Number(account?.scopes.includes("workflow") === true) +
    Number(account?.scopes.includes("write:packages") === true);
  let keyringCredential: {
    token: string;
    account: GhAccount;
    source: "keyring";
  } | null = null;
  if (keyringAccount) {
    const keyringToken = await ghKeyringTokenForUser(login);
    if (keyringToken) {
      keyringCredential = {
        token: keyringToken,
        account: keyringAccount,
        source: "keyring"
      };
    } else {
      const version = await ghVersion();
      if (version && !supportsGhMultiAccount(version)) {
        throw new Error(
          `GitHub CLI 2.40 or newer is required to select @${login} without relying on the active account. Upgrade GitHub CLI and retry.`
        );
      }
    }
  }
  const injectedCredential =
    injectedToken !== "" && snapshot.tokenAcct?.login === login ?
      {
        token: injectedToken,
        account: snapshot.tokenAcct,
        source: "injected" as const
      }
    : null;
  const useInjected =
    injectedCredential !== null &&
    (keyringCredential === null ||
      requiredScopeScore(injectedAccount) >
        requiredScopeScore(keyringCredential.account));
  const selectedCredential =
    useInjected ? injectedCredential : keyringCredential;
  if (!selectedCredential) {
    throw new Error(
      `Could not obtain a GitHub credential for @${login}. Authenticate that account with GitHub CLI, then re-check. Note: gh auth login changes the machine-wide active account for github.com.`
    );
  }
  const token = selectedCredential.token;
  const credentialSource: SelectedGhCredentialSource =
    selectedCredential.source;
  const scopes = selectedCredential.account.scopes;
  const redact = selectedCredentialRedactor(token);

  const runRaw = (
    args: string[],
    options: CommandOptions = {}
  ): Promise<SelectedGhCommandResult> => {
    const { stdin, ...execOptions } = options;
    return new Promise((resolve) => {
      const child = pinnedGhExec(
        token,
        args,
        execOptions,
        (error, stdout, stderr) => {
          resolve({
            code: error ? error.code || 1 : 0,
            stdout,
            stderr
          });
        },
        redact
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
  };
  const verifyIdentityRaw = async (): Promise<void> => {
    const result = await runRaw(["api", "user", "--jq", ".login"], {
      timeout: 15000
    });
    const actingLogin = result.stdout.trim();
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        detail ?
          `GitHub identity verification failed for @${login}: ${detail}`
        : `GitHub identity verification failed for @${login}.`
      );
    }
    if (actingLogin !== login) {
      throw new Error(
        `GitHub identity verification failed: expected @${login}, received @${
          actingLogin || "unknown"
        }.`
      );
    }
  };
  let identityVerification: Promise<void> | null = null;
  const verifyIdentity = (): Promise<void> => {
    if (!identityVerification) {
      identityVerification = verifyIdentityRaw().catch((error) => {
        identityVerification = null;
        throw error;
      });
    }
    return identityVerification;
  };
  const run = async (
    args: string[],
    options: CommandOptions = {}
  ): Promise<SelectedGhCommandResult> => {
    await verifyIdentity();
    return await runRaw(args, options);
  };

  const runOrThrow = async (
    args: string[],
    message: string,
    options: CommandOptions = {}
  ): Promise<SelectedGhCommandResult> => {
    const result = await run(args, options);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail ? `${message}: ${detail}` : message);
    }
    return result;
  };

  return {
    login,
    credentialSource,
    requiresKeyringSwitch:
      credentialSource === "keyring" && snapshot.tokenAcct?.login !== login,
    scopes: [...scopes],
    run,
    runOrThrow,
    verifyIdentity,
    // The executor pins one credential, so it also names which one it is: a
    // `gh auth refresh` can repair a keyring login but never an injected
    // session token, and the GHCR preflight's guidance turns on that.
    packageCredentials: () => ({
      username: login,
      token,
      source: credentialSource === "keyring" ? "keyring" : "injected-token"
    }),
    redact,
    errorMessage: (error) => selectedErrorMessage(error, redact)
  };
}

export async function selectedGhApiJson(
  executor: SelectedGhExecutor,
  apiPath: string
): Promise<GhApiResult> {
  const result = await executor.run(["api", apiPath], { timeout: 15000 });
  let json: unknown = null;
  if (result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      return {
        ok: false,
        status: null,
        json: null,
        stderr: "GitHub returned an invalid JSON response."
      };
    }
  }
  const statusMatch = result.stderr.match(/\bHTTP\s+(\d{3})\b/i);
  return {
    ok: result.code === 0,
    status:
      result.code === 0 ? 200
      : statusMatch ? Number(statusMatch[1])
      : null,
    json,
    stderr: result.stderr
  };
}

export async function selectedFetchFileFromRepo(
  executor: SelectedGhExecutor,
  repo: string,
  path: string,
  branch = "main"
): Promise<string | null> {
  const result = await executor.run(
    [
      "api",
      `/repos/${repo}/contents/${path}?ref=${branch}`,
      "--jq",
      ".content"
    ],
    { timeout: 15000 }
  );
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
}

export async function selectedGetDefaultBranch(
  executor: SelectedGhExecutor,
  repo: string
): Promise<string> {
  const result = await executor.run(
    ["api", `/repos/${repo}`, "--jq", ".default_branch"],
    { timeout: 15000 }
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function selectedGetBranchHeadSha(
  executor: SelectedGhExecutor,
  repo: string,
  branch: string
): Promise<string> {
  const result = await executor.run(
    [
      "api",
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      "--jq",
      ".object.sha"
    ],
    { timeout: 15000 }
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function selectedCreateBranchRef(
  executor: SelectedGhExecutor,
  repo: string,
  newBranch: string,
  fromSha: string
): Promise<BranchRefResult> {
  const result = await executor.run(
    ["api", "--method", "POST", `/repos/${repo}/git/refs`, "--input", "-"],
    {
      timeout: 20000,
      stdin: JSON.stringify({
        ref: `refs/heads/${newBranch}`,
        sha: fromSha
      })
    }
  );
  return {
    ok: result.code === 0,
    stderr: (result.stderr || result.stdout).trim()
  };
}

export async function selectedCreatePullRequest(
  executor: SelectedGhExecutor,
  repo: string,
  head: string,
  base: string,
  title: string,
  prBody: string
): Promise<PullRequestResult> {
  const result = await executor.run(
    ["api", "--method", "POST", `/repos/${repo}/pulls`, "--input", "-"],
    {
      timeout: 20000,
      stdin: JSON.stringify({ title, head, base, body: prBody || "" })
    }
  );
  if (result.code !== 0) {
    return {
      ok: false,
      stderr: (result.stderr || result.stdout).trim()
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      html_url?: unknown;
      number?: unknown;
    };
    return {
      ok: true,
      url: typeof parsed.html_url === "string" ? parsed.html_url : undefined,
      number: typeof parsed.number === "number" ? parsed.number : undefined
    };
  } catch (error) {
    return {
      ok: false,
      stderr: `Could not parse PR response: ${executor.errorMessage(error)}`
    };
  }
}

export async function getActiveKeyringLogin(): Promise<string> {
  resetGhIdentityCache();
  const snapshot = await ensureGhSnapshot();
  return snapshot.keyringActive?.login || "";
}

export function switchGhKeyringAccount(
  login: string
): Promise<{ ok: boolean; error?: string }> {
  const selectedLogin = login.trim();
  if (!selectedLogin) {
    return Promise.resolve({
      ok: false,
      error: "A GitHub account login is required."
    });
  }
  const env = withoutAgentSession(process.env);
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_HOST;
  return new Promise((resolve) => {
    execFile(
      ghExecutable(),
      ["auth", "switch", "--hostname", "github.com", "--user", selectedLogin],
      { env, timeout: 15000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: redactGhCredentials(
              (stderr || error.message || "gh auth switch failed").trim()
            )
          });
          return;
        }
        resetGhIdentityCache();
        resolve({ ok: true });
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
// See ensurePackageCredential for the resolution order. Throws when no
// credential can be resolved. `username` is always the acting login so the
// Basic-auth pair matches the token, and `source` names the credential that was
// actually resolved so callers can give guidance that applies to it.
export async function getGhPackageCredentials(): Promise<GhPackageCredentials> {
  const resolution = await ensurePackageCredential();
  if (!resolution.ok) throw new Error(resolution.error);
  return resolution.credentials;
}

// Returns true when cmd refers to the gh CLI regardless of whether the caller
// passes "gh", "gh.exe", or an absolute path to the executable.
function isGhCmd(cmd: string): boolean {
  return /(?:^|[\\/])gh(?:\.exe)?$/i.test(cmd);
}

function quoteWindowsCmdArgument(value: string): string {
  const escaped = value
    .replace(/(\\*)"/g, (_match, backslashes: string) => {
      return `${backslashes}${backslashes}\\"`;
    })
    .replace(/(\\*)$/, (_match, backslashes: string) => {
      return `${backslashes}${backslashes}`;
    });
  return `"${escaped}"`;
}

function windowsCmdCommandLine(command: string, args: string[]): string {
  const executableNeedsQuoting = /[\s"&|<>^()%!]/.test(command);
  const executable =
    executableNeedsQuoting ? quoteWindowsCmdArgument(command) : command;
  const commandLine = [executable, ...args.map(quoteWindowsCmdArgument)].join(
    " "
  );
  return executableNeedsQuoting ? `"${commandLine}"` : commandLine;
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
// Other Windows CLIs may only provide `.cmd` shims. Route those through cmd.exe
// with one verbatim command line so the validated argument shapes used here
// retain their boundaries. A simple executable name must stay unquoted because
// cmd.exe's first-token quote stripping breaks Azure CLI's batch launcher.
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
  const finalArgs =
    isWindows && !isWindowsGh ? ["/c", windowsCmdCommandLine(cmd, args)] : args;
  const execOpts: ExecFileOptionsWithStringEncoding = {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...opts,
    encoding: "utf8"
  };
  if (isWindows && !isWindowsGh) {
    execOpts.windowsVerbatimArguments = true;
  }
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
      if (err) reject(new Error(redactGhCredentials(stderr || err.message)));
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
          const detail = redactGhCredentials(
            (stderr && stderr.trim()) || err.message || String(err)
          );
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

// Repo-relative paths of the FILES on a branch.
//
// Resolves an empty array for every failure, and callers must therefore treat an
// empty result as "could not establish", never as "the repository is empty".
// A truncated tree is one of those failures: GitHub caps a recursive listing, and
// a partial listing that happens to omit a file is indistinguishable from one
// that proves the file is absent, so it must not be used as evidence.
export function fetchRepoTree(
  repo: string,
  branch = "main"
): Promise<string[]> {
  return new Promise((resolve) => {
    const args = [
      "api",
      `/repos/${repo}/git/trees/${branch}?recursive=1`,
      "--jq",
      // Blobs only: a directory named `Dockerfile` is not a build file, and a
      // consumer deciding what a repository contains must not count one.
      `{truncated: (.truncated // false), paths: [.tree[] | select(.type == "blob") | .path]}`
    ];
    cliExec("gh", args, { timeout: 30000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        const value: unknown = JSON.parse(stdout);
        if (value === null || typeof value !== "object") {
          resolve([]);
          return;
        }
        const { truncated, paths } = value as {
          truncated?: unknown;
          paths?: unknown;
        };
        resolve(
          truncated !== true && Array.isArray(paths) ?
            paths.filter((item): item is string => typeof item === "string")
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
        if (err)
          reject(
            new Error(
              redactGhCredentials((stderr && stderr.trim()) || err.message)
            )
          );
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
          stderr: redactGhCredentials(
            ((stderr && stderr.trim()) || err?.message || "").trim()
          )
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
            stderr: redactGhCredentials(
              ((stderr && stderr.trim()) || err.message || "").trim()
            )
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
      const detail = redactGhCredentials(
        ((stderr && stderr.trim()) || err.message || "").trim()
      );
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
