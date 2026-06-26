// Canvas adapter — shell + GitHub access primitives.
// Thin wrappers over the gh/az/aws CLIs plus the concrete GitHub port object
// (`github`) injected into radius-core use-cases. This is the adapter's only
// process-spawning surface besides the deploy monitor and infra modules.

import { execFile } from "node:child_process";

export function runCommand(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === "win32";
        const shell = isWindows ? "powershell" : "bash";
        const shellArgs = isWindows
            ? ["-NoProfile", "-Command", [cmd, ...args].join(" ")]
            : ["-c", [cmd, ...args].join(" ")];
        execFile(shell, shellArgs, { ...opts, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
        execFile("gh", ["api", apiPath, "--jq", ".content"], { shell: true, timeout }, (err, stdout) => {
            if (err || !stdout || !stdout.trim()) { resolve(null); return; }
            try { resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8')); }
            catch (e) { resolve(null); }
        });
    });
}

export function ghApiListNames(apiPath, timeout = 15000) {
    return new Promise((resolve) => {
        execFile("gh", ["api", apiPath, "--jq", `[.[].name]`], { shell: true, timeout }, (err, stdout) => {
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
        // Use simpler jq that avoids pipe issues on Windows shell
        const args = ["api", `/repos/${repo}/git/trees/${branch}?recursive=1`, "--jq", `[.tree[].path]`];
        execFile("gh", args, { shell: true, timeout: 30000 }, (err, stdout) => {
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
