// Canvas adapter — shell + GitHub access primitives.
// Thin wrappers over the gh/az/aws CLIs plus the concrete GitHub port object
// (`github`) injected into radius-core use-cases. This is the adapter's only
// process-spawning surface besides the deploy monitor and infra modules.

import { execFile } from "node:child_process";

// Run a CLI (gh/az/aws) without a shell so that argument values (repo/env names,
// API paths, …) are passed verbatim as argv and can never be interpreted as
// shell syntax. On Windows these CLIs are usually `.cmd` shims that cannot be
// spawned directly, so we invoke them via `cmd.exe /c` — but the arguments are
// still passed as a separate argv array (never concatenated into a single
// string), which preserves per-argument escaping and avoids command injection.
function cliExec(cmd, args, opts, cb) {
    const isWindows = process.platform === "win32";
    const file = isWindows ? "cmd.exe" : cmd;
    const finalArgs = isWindows ? ["/c", cmd, ...args] : args;
    return execFile(
        file,
        finalArgs,
        { maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...opts },
        cb,
    );
}

export function runCommand(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        cliExec(cmd, args, opts, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
        });
    });
}

export function execShell(command, timeout = 30000) {
    return new Promise((resolve, reject) => {
        execFile(command, {
            shell: true,
            timeout,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
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
