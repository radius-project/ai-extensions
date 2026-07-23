// Canvas adapter — shell + GitHub access primitives.
// Thin wrappers over the gh/az/aws CLIs plus the concrete GitHub port object
// (`github`) injected into radius-core use-cases. This is the adapter's only
// process-spawning surface besides the deploy monitor and infra modules.

import { execFile, execFileSync } from "node:child_process";

// The host app injects a GH_TOKEN/GITHUB_TOKEN into the session environment.
// gh always prefers that env token over the user's stored (keyring) login, but
// the injected token is an OAuth token minted WITHOUT the `workflow` scope, so
// any `gh api ... PUT /contents/.github/workflows/...` is rejected with a 403.
// When the user has a stored gh login (which the gh CLI requests with the
// `workflow` scope), we drop the injected env tokens for `gh` invocations so gh
// falls back to that full-scope credential. Detection is memoized and, if no
// stored login exists, we leave the env untouched so the injected token is
// still used.
let _ghKeyringChecked = false;
let _ghHasKeyring = false;

function ghExecutable() {
    return process.platform === "win32" ? "gh.exe" : "gh";
}

function ghHasKeyringLogin() {
    if (_ghKeyringChecked) return _ghHasKeyring;
    _ghKeyringChecked = true;
    try {
        const env = { ...process.env };
        delete env.GH_TOKEN;
        delete env.GITHUB_TOKEN;
        const out = execFileSync(ghExecutable(), ["auth", "token"], {
            env,
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
            windowsHide: true,
        })
            .toString()
            .trim();
        _ghHasKeyring = out.length > 0;
    } catch {
        _ghHasKeyring = false;
    }
    return _ghHasKeyring;
}

// Build the child environment for a `gh` invocation. When a stored gh login is
// available, strip the app-injected GH_TOKEN/GITHUB_TOKEN so gh uses the
// full-scope keyring credential; otherwise pass the environment through
// unchanged so the injected token still authenticates gh.
function ghChildEnv(baseEnv) {
    const env = { ...(baseEnv || process.env) };
    if (ghHasKeyringLogin()) {
        delete env.GH_TOKEN;
        delete env.GITHUB_TOKEN;
    }
    return env;
}

// Returns true when cmd refers to the gh CLI regardless of whether the caller
// passes "gh", "gh.exe", or an absolute path to the executable.
function isGhCmd(cmd) {
    return /(?:^|[\\/])gh(?:\.exe)?$/i.test(cmd);
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
