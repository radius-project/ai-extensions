// Canvas adapter — shell + GitHub access primitives.
// Thin wrappers over the gh/az/aws CLIs plus the concrete GitHub port object
// (`github`) injected into radius-core use-cases. This is the adapter's only
// process-spawning surface besides the deploy monitor and infra modules.

import { execFile, execFileSync } from "node:child_process";

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
let _preferredLogin = null;

// Memoized snapshot of `gh auth status` (default env + token-stripped env) and
// the derived token strategy. Reset by resetGhIdentityCache() after a switch.
let _ghSnapshot = null;
let _ghStrategy = null;

// Parse `gh auth status` text into structured accounts. Pure so it can be unit
// tested against real gh output across versions. Each account block looks like:
//   ✓ Logged in to github.com account <login> (<source>)
//     - Active account: true|false
//     - Token scopes: 'a', 'b', ...
export function parseGhAuthStatus(text) {
    const accounts = [];
    let cur = null;
    for (const line of String(text || "").split(/\r?\n/)) {
        const acct = line.match(/Logged in to \S+ account (\S+) \(([^)]+)\)/);
        if (acct) {
            cur = { login: acct[1], source: acct[2], active: false, scopes: [] };
            accounts.push(cur);
            continue;
        }
        if (!cur) continue;
        const active = line.match(/Active account:\s*(true|false)/i);
        if (active) { cur.active = active[1].toLowerCase() === "true"; continue; }
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
    preferredLogin,
}) {
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
    if (tokenHasWorkflow) return { useKeyring: false, reason: "token-has-workflow" };
    // 4. Token lacks `workflow` but a keyring login has it → fall back for scope.
    if (keyringLogin && keyringHasWorkflow) return { useKeyring: true, reason: "token-missing-workflow" };
    // 5. Nothing better available → keep the token; a later 403 explains the gap.
    return { useKeyring: false, reason: "no-workflow-scope-available" };
}

// Run `gh auth status` synchronously, returning its combined output. gh exits
// non-zero when not logged in but still prints useful text, so we recover it
// from the thrown error rather than treating it as empty.
function ghAuthStatusTextSync(env) {
    try {
        return execFileSync(ghExecutable(), ["auth", "status"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 8000,
            windowsHide: true,
        }).toString();
    } catch (e) {
        const out = e && e.stdout ? e.stdout.toString() : "";
        const err = e && e.stderr ? e.stderr.toString() : "";
        return out + err;
    }
}

// Snapshot the accounts gh sees with the injected token present vs stripped.
// Memoized: the first gh call in the process pays the (network) cost once.
function ghSnapshot() {
    if (_ghSnapshot) return _ghSnapshot;
    const base = process.env;
    const hasToken = !!(base.GH_TOKEN || base.GITHUB_TOKEN);
    const stripped = { ...base };
    delete stripped.GH_TOKEN;
    delete stripped.GITHUB_TOKEN;
    const withTokenAccts = parseGhAuthStatus(ghAuthStatusTextSync(base));
    const keyringAccts = parseGhAuthStatus(ghAuthStatusTextSync(stripped));
    const tokenAcct = hasToken
        ? withTokenAccts.find((a) => /TOKEN/i.test(a.source)) || null
        : null;
    const keyringActive = keyringAccts.find((a) => a.active) || keyringAccts[0] || null;
    _ghSnapshot = { hasToken, withTokenAccts, keyringAccts, tokenAcct, keyringActive };
    return _ghSnapshot;
}

// Resolve (memoized) the token strategy from the current snapshot + preference.
function ghStrategy() {
    if (_ghStrategy) return _ghStrategy;
    const s = ghSnapshot();
    _ghStrategy = decideGhTokenStrategy({
        hasToken: s.hasToken,
        tokenLogin: s.tokenAcct ? s.tokenAcct.login : "",
        tokenHasWorkflow: !!(s.tokenAcct && s.tokenAcct.scopes.includes("workflow")),
        keyringLogin: s.keyringActive ? s.keyringActive.login : "",
        keyringHasWorkflow: !!(s.keyringActive && s.keyringActive.scopes.includes("workflow")),
        preferredLogin: _preferredLogin,
    });
    return _ghStrategy;
}

// Drop the memoized snapshot/strategy so the next gh call re-reads `gh auth
// status`. Call after anything that changes the active account (a switch). The
// sticky user preference is intentionally preserved across resets.
export function resetGhIdentityCache() {
    _ghSnapshot = null;
    _ghStrategy = null;
}

// Build the child environment for a `gh` invocation. Strips the injected
// GH_TOKEN/GITHUB_TOKEN only when the resolved strategy says to fall back to the
// keyring credential; otherwise passes the token through so gh keeps the
// identity the user sees.
function ghChildEnv(baseEnv) {
    const env = { ...(baseEnv || process.env) };
    if (ghStrategy().useKeyring) {
        delete env.GH_TOKEN;
        delete env.GITHUB_TOKEN;
    }
    return env;
}

// Resolve the effective GitHub identity for setup, plus the switchable account
// list. `actingLogin` is who gh mutates as (after the strategy decision);
// `displayLogin` is who the injected token represents (what the host UI shows).
// A mismatch means setup would act as a different account than the user thinks.
export function getGitHubIdentity() {
    const s = ghSnapshot();
    const strat = ghStrategy();
    const displayLogin = s.hasToken && s.tokenAcct
        ? s.tokenAcct.login
        : (s.keyringActive ? s.keyringActive.login : "");
    const actingLogin = strat.useKeyring
        ? (s.keyringActive ? s.keyringActive.login : "")
        : (s.tokenAcct ? s.tokenAcct.login : (s.keyringActive ? s.keyringActive.login : ""));
    // De-duplicated switchable account list. An account is switchable when it
    // exists in the keyring (gh auth switch operates on keyring accounts).
    const keyringLogins = new Set(s.keyringAccts.map((a) => a.login));
    const seen = new Set();
    const accounts = [];
    for (const a of [...s.withTokenAccts, ...s.keyringAccts]) {
        if (seen.has(a.login)) continue;
        seen.add(a.login);
        accounts.push({
            login: a.login,
            hasWorkflow: a.scopes.includes("workflow"),
            switchable: keyringLogins.has(a.login),
            acting: a.login === actingLogin,
        });
    }
    const actingAcct = accounts.find((a) => a.login === actingLogin) || null;
    return {
        actingLogin,
        displayLogin,
        mismatch: !!(actingLogin && displayLogin && actingLogin !== displayLogin),
        actingHasWorkflow: !!(actingAcct && actingAcct.hasWorkflow),
        preferredLogin: _preferredLogin,
        reason: strat.reason,
        accounts,
    };
}

// Switch the active gh account to `login`. gh auth switch changes the keyring
// active account; because a present GH_TOKEN would still override it at call
// time, we also record the preference (so ghChildEnv strips the token when the
// chosen account is not the token account) and reset the identity cache.
// Resolves { ok, error } and never rejects.
export function switchGhAccount(login) {
    return new Promise((resolve) => {
        if (!login) { resolve({ ok: false, error: "A GitHub account login is required." }); return; }
        const env = { ...process.env };
        execFile(
            ghExecutable(),
            ["auth", "switch", "--user", login],
            { env, timeout: 15000, windowsHide: true },
            (err, _stdout, stderr) => {
                if (err) {
                    resolve({ ok: false, error: ((stderr || "").trim() || err.message || "gh auth switch failed").trim() });
                    return;
                }
                _preferredLogin = login;
                resetGhIdentityCache();
                resolve({ ok: true });
            },
        );
    });
}

// Returns true when cmd refers to the gh CLI regardless of whether the caller
// passes "gh", "gh.exe", or an absolute path to the executable.
function isGhCmd(cmd) {
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
function withoutAgentSession(baseEnv) {
    const env = { ...(baseEnv || process.env) };
    delete env.COPILOT_AGENT_SESSION_ID;
    return env;
}

// Run a CLI (gh/az/aws). GitHub CLI ships as gh.exe on Windows, so invoke that
// executable directly: passing it through cmd.exe would let metacharacters in an
// API path (for example, '&' in a query string) be interpreted as shell syntax.
// Other Windows CLIs may only provide `.cmd` shims, so retain the existing
// cmd.exe wrapper for those commands.
export function cliExec(cmd, args, opts, cb) {
    const isWindows = process.platform === "win32";
    const isWindowsGh = isWindows && isGhCmd(cmd);
    const file = isWindowsGh ? ghExecutable() : isWindows ? "cmd.exe" : cmd;
    const finalArgs = isWindows && !isWindowsGh ? ["/c", cmd, ...args] : args;
    const execOpts = { maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...opts };
    if (isGhCmd(cmd)) execOpts.env = ghChildEnv(execOpts.env);
    execOpts.env = withoutAgentSession(execOpts.env);
    return execFile(file, finalArgs, execOpts, cb);
}

// Runs a CLI and resolves with trimmed stdout. Pass `opts.stdin` to feed a value
// (e.g. a secret) over stdin instead of exposing it on the argv/process list.
export function runCommand(cmd, args, opts = {}) {
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
export function runGhKeyringCommand(args, opts = {}) {
    const env = { ...(opts.env || process.env) };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GH_HOST;
    return runCommand("gh", args, { ...opts, env });
}

export const AWS_REGIONS = [
    "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
    "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
    "ap-south-1", "sa-east-1", "ca-central-1",
];

export function ghApiGetContent(apiPath, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", ["api", apiPath, "--jq", ".content"], { timeout }, (err, stdout) => {
            if (err || !stdout || !stdout.trim()) { resolve(null); return; }
            try { resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8')); }
            catch (e) { resolve(null); }
        });
    });
}

export function ghApiListNames(apiPath, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", ["api", apiPath, "--jq", `[.[].name]`], { timeout }, (err, stdout) => {
            if (err) { resolve([]); return; }
            try { resolve(JSON.parse(stdout)); } catch (e) { resolve([]); }
        });
    });
}

export function fetchFileFromRepo(repo, path, branch = 'main') {
    return ghApiGetContent(`/repos/${repo}/contents/${path}?ref=${branch}`);
}

/**
 * Like ghApiGetContent, but surfaces the underlying failure instead of
 * collapsing everything to null. Resolves `{ content, error }`: on success
 * `content` is the decoded file body and `error` is null; on failure `content`
 * is null and `error` is a human-readable cause (gh stderr, a decode error, or
 * an empty-response note). Never rejects.
 */
export function ghApiGetContentResult(apiPath, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", ["api", apiPath, "--jq", ".content"], { timeout }, (err, stdout, stderr) => {
            if (err) {
                const detail = (stderr && stderr.trim()) || err.message || String(err);
                resolve({ content: null, error: detail.trim() });
                return;
            }
            if (!stdout || !stdout.trim()) {
                resolve({ content: null, error: "empty response from gh api" });
                return;
            }
            try {
                resolve({ content: Buffer.from(stdout.trim(), 'base64').toString('utf8'), error: null });
            } catch (e) {
                resolve({ content: null, error: `failed to decode response: ${e?.message ?? e}` });
            }
        });
    });
}

/** Repo-file variant of ghApiGetContentResult. Resolves `{ content, error }`. */
export function fetchFileFromRepoResult(repo, path, branch = 'main') {
    return ghApiGetContentResult(`/repos/${repo}/contents/${path}?ref=${branch}`);
}

export function fetchRepoTree(repo, branch = 'main') {
    return new Promise((resolve) => {
        const args = ["api", `/repos/${repo}/git/trees/${branch}?recursive=1`, "--jq", `[.tree[].path]`];
        cliExec("gh", args, { timeout: 30000 }, (err, stdout) => {
            if (err) { resolve([]); return; }
            try { resolve(JSON.parse(stdout)); } catch (e) { resolve([]); }
        });
    });
}

export const github = {
    getContent: (apiPath) => ghApiGetContent(apiPath),
    listNames: (apiPath) => ghApiListNames(apiPath),
    treePaths: (repo, branch = 'main') => fetchRepoTree(repo, branch),
};

// Look up a file's blob SHA on a branch; resolves '' when the file is absent.
function getRepoFileSha(repo, path, branch, timeout = 10000) {
    return new Promise((resolve) => {
        cliExec("gh", ["api", `/repos/${repo}/contents/${path}?ref=${branch}`, "--jq", ".sha"], { timeout }, (err, stdout) => {
            resolve(err ? "" : (stdout || "").trim());
        });
    });
}

// Create or update a single UTF-8 text file on a repo branch via the GitHub
// contents API. Reuses the existing blob SHA so a re-commit is an update rather
// than a rejected create. The commit body is fed over stdin (never argv) so the
// base64 payload can't collide with shell/CLI parsing. Rejects on failure.
export async function commitFileToRepo(repo, path, content, branch, message, timeout = 30000) {
    const sha = await getRepoFileSha(repo, path, branch);
    const body = JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
    });
    return new Promise((resolve, reject) => {
        const child = cliExec(
            "gh",
            ["api", "--method", "PUT", `/repos/${repo}/contents/${path}`, "--input", "-"],
            { timeout },
            (err, stdout, stderr) => {
                if (err) reject(new Error((stderr && stderr.trim()) || err.message));
                else resolve(true);
            },
        );
        try { child.stdin?.end(body); } catch { /* best-effort */ }
    });
}

// Resolve a repo's default branch name (e.g. "main"). Resolves '' on failure.
export function getDefaultBranch(repo, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", ["api", `/repos/${repo}`, "--jq", ".default_branch"], { timeout }, (err, stdout) => {
            resolve(err ? "" : (stdout || "").trim());
        });
    });
}

// Get the head commit SHA of a branch. Resolves '' when the branch is absent.
export function getBranchHeadSha(repo, branch, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", ["api", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, "--jq", ".object.sha"], { timeout }, (err, stdout) => {
            resolve(err ? "" : (stdout || "").trim());
        });
    });
}

// Create a new branch ref (refs/heads/<newBranch>) pointing at fromSha.
// Resolves { ok, stderr }; never rejects.
export function createBranchRef(repo, newBranch, fromSha, timeout = 20000) {
    const body = JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: fromSha });
    return new Promise((resolve) => {
        const child = cliExec(
            "gh",
            ["api", "--method", "POST", `/repos/${repo}/git/refs`, "--input", "-"],
            { timeout },
            (err, stdout, stderr) => {
                resolve({ ok: !err, stderr: ((stderr && stderr.trim()) || err?.message || "").trim() });
            },
        );
        try { child.stdin?.end(body); } catch { /* best-effort */ }
    });
}

// Open a pull request from `head` into `base`. Resolves
// { ok, url, number, stderr }; never rejects. The body is fed over stdin so
// arbitrary title/body text can't collide with CLI parsing.
export function createPullRequestApi(repo, head, base, title, prBody, timeout = 20000) {
    const body = JSON.stringify({ title, head, base, body: prBody || "" });
    return new Promise((resolve) => {
        const child = cliExec(
            "gh",
            ["api", "--method", "POST", `/repos/${repo}/pulls`, "--input", "-"],
            { timeout },
            (err, stdout, stderr) => {
                if (err) { resolve({ ok: false, stderr: ((stderr && stderr.trim()) || err.message || "").trim() }); return; }
                try {
                    const j = JSON.parse(stdout);
                    resolve({ ok: true, url: j.html_url, number: j.number });
                } catch (e) {
                    resolve({ ok: false, stderr: `Could not parse PR response: ${e?.message ?? e}` });
                }
            },
        );
        try { child.stdin?.end(body); } catch { /* best-effort */ }
    });
}

// GET a GitHub JSON resource, surfacing the HTTP status so callers can
// distinguish "not found" (404) from access/other failures. `gh api` exits
// non-zero on HTTP errors and prints e.g. "gh: Not Found (HTTP 404)" to stderr;
// we parse that status out. Optional `headers` are passed as `-H k: v` (used to
// pin X-GitHub-Api-Version). Resolves `{ ok, status, json, stderr }`; never
// rejects. stdin is closed so gh can never block on an interactive prompt.
export function ghApiJson(apiPath, { headers = {}, timeout = 15000 } = {}) {
    const args = ["api", apiPath];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    return new Promise((resolve) => {
        const child = cliExec("gh", args, { timeout }, (err, stdout, stderr) => {
            if (!err) {
                try {
                    resolve({ ok: true, status: 200, json: JSON.parse(stdout || "null"), stderr: "" });
                } catch (e) {
                    resolve({ ok: false, status: 200, json: null, stderr: `failed to parse response: ${e?.message ?? e}` });
                }
                return;
            }
            const detail = ((stderr && stderr.trim()) || err.message || "").trim();
            const m = detail.match(/\(HTTP (\d{3})\)/) || detail.match(/\bHTTP (\d{3})\b/);
            resolve({ ok: false, status: m ? Number(m[1]) : null, json: null, stderr: detail });
        });
        try { child.stdin?.end(); } catch { /* best-effort */ }
    });
}
