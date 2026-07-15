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
function ghHasKeyringLogin() {
    if (_ghKeyringChecked) return _ghHasKeyring;
    _ghKeyringChecked = true;
    try {
        const isWindows = process.platform === "win32";
        const file = isWindows ? "cmd.exe" : "gh";
        const args = isWindows ? ["/c", "gh", "auth", "token"] : ["auth", "token"];
        const env = { ...process.env };
        delete env.GH_TOKEN;
        delete env.GITHUB_TOKEN;
        const out = execFileSync(file, args, {
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

// Run a CLI (gh/az/aws) without a shell so that argument values (repo/env names,
// API paths, …) are passed verbatim as argv and can never be interpreted as
// shell syntax. On Windows these CLIs are usually `.cmd` shims that cannot be
// spawned directly, so we invoke them via `cmd.exe /c` — but the arguments are
// still passed as a separate argv array (never concatenated into a single
// string), which preserves per-argument escaping and avoids command injection.
export function cliExec(cmd, args, opts, cb) {
    const isWindows = process.platform === "win32";
    const file = isWindows ? "cmd.exe" : cmd;
    const finalArgs = isWindows ? ["/c", cmd, ...args] : args;
    const execOpts = { maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...opts };
    if (cmd === "gh") execOpts.env = ghChildEnv(execOpts.env);
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
