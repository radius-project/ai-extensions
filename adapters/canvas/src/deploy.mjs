// Canvas adapter — deploy monitoring + log parsing.
// Polls GitHub Actions run status/steps and reads the workflow job log while a
// run is still in progress to drive per-Radius-resource state on the Deployed
// graph. Reads GitHub via the gh CLI.

import { cliExec } from "./gh.mjs";

export function ghJson(args, fallback = null, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", args, { timeout }, (err, stdout) => {
            if (err) { resolve(fallback); return; }
            try { resolve(JSON.parse(stdout.trim())); } catch (e) { resolve(fallback); }
        });
    });
}

export async function findWorkflowRun(repo, workflowFile, sinceMs, knownId) {
    if (knownId) return knownId;
    const runs = await ghJson(
        ["run", "list", "--workflow=" + workflowFile, "--limit", "5",
         "--json", "databaseId,status,createdAt", "--repo", repo],
        []
    );
    if (!Array.isArray(runs)) return null;
    // Newest first; accept the first run created within ~60s before dispatch
    // (clock skew tolerance) to avoid picking up stale prior runs.
    const cutoff = (sinceMs || 0) - 60000;
    for (const r of runs) {
        const created = Date.parse(r.createdAt || '') || 0;
        if (created >= cutoff) return r.databaseId;
    }
    return null;
}

export async function getRunDetail(repo, runId) {
    let data = await ghJson(
        ["run", "view", String(runId), "--json", "status,conclusion,jobs", "--repo", repo],
        null
    );
    // The jobs sub-resource (/actions/runs/<id>/jobs) is intermittently flaky
    // (HTTP 503) and, when included, fails the whole `gh run view` call — which
    // would otherwise report the run's status/conclusion just fine. The jobs
    // (steps) are only needed for progress/failure detail, not for detecting
    // completion, so fall back to a status-only read when the combined call
    // fails. This keeps completion detection (e.g. verify-status → success)
    // working even while the jobs endpoint is unavailable.
    if (!data) {
        data = await ghJson(
            ["run", "view", String(runId), "--json", "status,conclusion", "--repo", repo],
            null
        );
        if (!data) return null;
        return { status: data.status, conclusion: data.conclusion, jobs: [], steps: [] };
    }
    const steps = [];
    for (const job of (data.jobs || [])) {
        for (const s of (job.steps || [])) {
            steps.push({ name: s.name, status: s.status, conclusion: s.conclusion });
        }
    }
    return { status: data.status, conclusion: data.conclusion, jobs: data.jobs || [], steps };
}

export function fetchRunLog(repo, runId) {
    return new Promise((resolve) => {
        cliExec("gh", ["run", "view", String(runId), "--log", "--repo", repo],
            { timeout: 30000, maxBuffer: 1024 * 1024 * 20 }, (err, stdout) => {
            if (err || !stdout) { resolve(null); return; }
            resolve(stdout);
        });
    });
}

// Fetch the plain-text log for a single Actions job while the run is still in
// flight. `gh run view <id> --log` only works after the run completes; this
// endpoint returns the running job's log and grows as the job writes it.
export function fetchJobLog(repo, jobId) {
    return new Promise((resolve) => {
        if (!repo || !jobId) { resolve(null); return; }
        cliExec("gh", ["api", `/repos/${repo}/actions/jobs/${jobId}/logs`],
            { timeout: 30000, maxBuffer: 1024 * 1024 * 20 }, (err, stdout) => {
            if (err || !stdout) { resolve(null); return; }
            resolve(stdout);
        });
    });
}

// Pick the job that runs the named step (default: the `Run rad commands` step
// in the run-rad-commands provider workflow — the composite action's outer
// step whose stdout carries `rad deploy` output). `detail` is the shape
// getRunDetail returns: { jobs: [{ id, steps: [{ name }] }] }. Pure lookup —
// no I/O.
export function findDeployJobId(detail, stepName = "Run rad commands") {
    if (!detail || !Array.isArray(detail.jobs)) return null;
    for (const job of detail.jobs) {
        if (!job || !Array.isArray(job.steps)) continue;
        if (job.steps.some(s => s && s.name === stepName)) {
            return job.id || job.databaseId || null;
        }
    }
    return null;
}

// Column-1 keyword parser for `rad deploy` stdout captured in the job log.
// Recognizes the global lifecycle markers ("Deployment In Progress...",
// "Deployment Complete") and per-resource terminal lines ("Completed <name>
// <type>", "Failed <name> <type>"). `resources` is the modeled resource list —
// only names present there populate `byName`, so unrelated tokens can't inject
// status. Pure — no I/O.
export function parseRadDeployProgress(logText, resources) {
    const out = { global: null, byName: {} };
    if (!logText) return out;
    const names = new Set(
        (Array.isArray(resources) ? resources : []).map(r => r && r.name).filter(Boolean)
    );
    for (const raw of logText.split(/\r?\n/)) {
        // Strip the two prefix formats we can encounter, in order:
        //   1. `<job>\t<step>\t` prefix from `gh run view --log` (job/step names
        //      contain spaces so we look for the tab delimiters).
        //   2. ISO timestamp from `gh api /jobs/{id}/logs`, or the timestamp
        //      that remains after step 1 (`gh run view --log` embeds one too).
        const line = raw
            .replace(/^[^\t]+\t[^\t]+\t/, '')
            .replace(/^\d{4}-\d\d-\d\dT[^\s]+\s+/, '')
            .trim();
        if (!line) continue;
        if (/^Deployment In Progress/i.test(line)) { out.global = 'in_progress'; continue; }
        if (/^Deployment Complete\b/i.test(line))   { out.global = 'complete';    continue; }
        const m = line.match(/^(Completed|Failed)\s+(\S+)\s+(\S+)/);
        if (!m) continue;
        const status = m[1] === 'Completed' ? 'success' : 'failed';
        if (names.has(m[2])) out.byName[m[2]] = status;
    }
    return out;
}

// Extract the deployed-graph JSON block that `rad app graph <app>` prints
// after `rad deploy` on a successful run. The workflow appends the command in
// the same job (see buildAppGraphRadCommand in server.mjs), so its stdout is
// inline in the job log. Strategy: scan for the last well-formed top-level
// JSON object anywhere in `logText` — either an ApplicationGraphResponse
// (`{ "resources": [...] }`) or a bare `{ ... }` object. Returns the parsed
// object or `null` if none is found. Pure — no I/O.
export function extractAppGraphJson(logText) {
    if (!logText) return null;
    // Walk from the end so a first-attempt failure (e.g. an earlier "Error: {"
    // block) does not shadow the true final graph object.
    for (let i = logText.length - 1; i >= 0; i--) {
        if (logText[i] !== '}') continue;
        // Match this closing brace to its opening brace, respecting strings.
        let depth = 0;
        let inString = false;
        let stringQuote = '';
        for (let j = i; j >= 0; j--) {
            const c = logText[j];
            if (inString) {
                if (c === '\\') { j--; continue; } // escaped char inside string
                if (c === stringQuote) inString = false;
                continue;
            }
            if (c === '"' || c === "'") { inString = true; stringQuote = c; continue; }
            if (c === '}') depth++;
            else if (c === '{') {
                depth--;
                if (depth === 0) {
                    const candidate = logText.slice(j, i + 1);
                    try {
                        const parsed = JSON.parse(candidate);
                        // Prefer objects that look like a rad app graph response.
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            if (Array.isArray(parsed.resources)) return parsed;
                        }
                        // Keep scanning — the earlier match may not be the graph.
                    } catch (e) { /* not JSON — keep scanning */ }
                    break; // move to the next `}` further left
                }
            }
        }
    }
    return null;
}

export function extractErrorLines(logText, max = 12) {
    if (!logText) return [];
    const out = [];
    const re = /\b(error|errors|failed|failure|fatal|denied|unauthorized|forbidden|not\s+found|cannot|unable|panic|exception|invalid|timed?\s*out)\b/i;
    for (const raw of logText.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;
        if (re.test(line)) out.push(line.trim());
    }
    return out.slice(-max);
}

// Detects the Entra "enterprise claim" rejection (AADSTS7002381) that GitHub
// Actions OIDC hits when a repo is NOT owned by an org in a GitHub Enterprise.
// Tenant-agnostic: the accepted enterprise values and the actual value are parsed
// out of the error text itself, so this works for any tenant policy, not just
// Microsoft's. Returns a friendly multi-line explanation, or '' if not applicable.
export function explainOidcEnterpriseClaim(logText) {
    if (!logText) return '';
    if (!/AADSTS7002381/.test(logText) && !/must contain the enterprise claim/i.test(logText)) return '';
    // Parse: "...enterprise claim with value 'a', 'b' or 'c' but actual value is 'x'..."
    let accepted = [];
    let actual = null;
    const m = /enterprise claim with value\s+(.+?)\s+but actual value is\s+'([^']*)'/i.exec(logText);
    if (m) {
        accepted = (m[1].match(/'([^']*)'/g) || []).map(s => s.replace(/'/g, ''));
        actual = m[2];
    }
    const acceptedLabel = accepted.length ? accepted.join(', ') : 'a value required by the target Azure tenant';
    let leadLine, actualLabel;
    if (actual === '') {
        // Claim present in the issuer config but empty — the classic personal-repo case.
        leadLine = 'Azure Login (OIDC) was rejected because this repository\u2019s GitHub OIDC token is missing the required "enterprise" claim.';
        actualLabel = 'empty (this repository is not part of a GitHub Enterprise)';
    } else if (actual) {
        // Claim present but not one the tenant trusts.
        leadLine = 'Azure Login (OIDC) was rejected because this repository\u2019s GitHub "enterprise" OIDC claim ("' + actual + '") is not trusted by the target Azure tenant.';
        actualLabel = '"' + actual + '"';
    } else {
        // Could not parse the actual value from the error text.
        leadLine = 'Azure Login (OIDC) was rejected by the target Azure tenant over the GitHub OIDC "enterprise" claim.';
        actualLabel = 'not reported';
    }
    return [
        leadLine,
        'The target Azure tenant only trusts GitHub Actions tokens whose enterprise claim is one of: ' + acceptedLabel + ' (actual: ' + actualLabel + ').',
        'GitHub only includes the enterprise claim for repositories owned by an organization that belongs to a GitHub Enterprise \u2014 personal-account repositories cannot satisfy this policy.',
        'Fix: host this repository under an organization that is part of one of the accepted GitHub Enterprises (' + acceptedLabel + '), then re-run Create Environment so the federated credential is recreated for the new owner/repo.',
    ].join('\n');
}

// Given the outcome of reading `gh api repos/{repo}` plus the acting gh login,
// return a clear, actionable error string, or '' when the account can read the
// repo AND has admin. Pure — no I/O, never throws. Catches the two bare-404
// failure modes GitHub returns for auth/permission problems during environment
// setup: (1) the wrong gh account is active (repo invisible → read 404), and
// (2) the account can read the repo but lacks the admin needed to create a
// deployment environment (PUT /repos/{repo}/environments → 404).
export function explainRepoAccessForEnvSetup({ repo, login, readFailed, permissions } = {}) {
    const who = login || 'the active gh account';
    if (readFailed) {
        return 'Can\u2019t read repository "' + repo + '" as GitHub account "' + who + '". ' +
            'Either this account lacks access, or the wrong account is active (for example a personal account instead of your enterprise one). ' +
            'Switch accounts with: gh auth switch --user <account>  (or sign in the account that has access), then retry.';
    }
    if (permissions && permissions.admin === true) return '';
    // Read OK but not admin — report the current best role so the user knows
    // exactly what they have and what to ask for. When none of the role flags is
    // truthy (e.g. jq emitted `{admin:null,...}`) we don't actually know the
    // role, so we avoid claiming a specific "no direct access".
    let role = '';
    if (permissions) {
        if (permissions.maintain) role = 'Maintain';
        else if (permissions.push) role = 'Write';
        else if (permissions.triage) role = 'Triage';
        else if (permissions.pull) role = 'Read';
    }
    const account = login || 'you';
    const haveClause = role
        ? 'account "' + account + '" currently has ' + role + ' access'
        : 'account "' + account + '" does not have Admin access (its exact role could not be determined)';
    return 'Environment setup needs Admin permission on "' + repo + '", but ' + haveClause + '. ' +
        'Ask a repository or organization admin to grant you Admin (repo Settings \u2192 Collaborators and teams), then retry.';
}

// True when a gh error text indicates the repo/API path was Not Found (HTTP 404) —
// the signal that the active account can't see the repo. Pure, never throws.
//
// The bare `not found` alternate is INTENTIONAL, not an oversight: gh surfaces
// this condition with variable wording (e.g. "gh: Not Found (HTTP 404)" but also
// plain "the repository was not found"), and both must match. The match is
// deliberately allowed to be broad because the sole caller (server.mjs, the repo
// preflight) is fail-open — a match only flips an advisory `readFailed` flag and
// GitHub still enforces real permissions server-side — so a false positive here
// costs nothing while a false negative would misdirect the preflight. Narrowing
// to `HTTP 404` only would drop the tested bare-phrase case (deploy_test.mjs).
export function isRepoNotFoundError(errText) {
    if (!errText) return false;
    return /\bHTTP 404\b/i.test(errText) || /\bnot found\b/i.test(errText);
}

export function extractRadDeployError(logText, maxChars = 4000) {
    if (!logText) return '';
    // Strip the "job\tstep\ttimestamp " prefix `gh run view --log` adds, if present,
    // so the structured block is detectable regardless of the log source.
    const lines = logText.split(/\r?\n/).map(raw => {
        let l = raw.replace(/\s+$/, '');
        // gh run log prefix: tabs separate job/step, then "<ISO timestamp> <text>".
        const m = l.match(/^[^\t]*\t[^\t]*\t\S+\s(.*)$/);
        if (m) l = m[1];
        return l;
    });
    // Find the LAST structured rad error block ("Error: {").
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s*Error:\s*\{/.test(lines[i])) { start = i; break; }
    }
    if (start >= 0) {
        const block = [];
        for (let i = start; i < lines.length; i++) {
            const l = lines[i];
            if (/^\s*Error:\s*Process completed/.test(l)) break; // GitHub Actions wrapper line
            block.push(l);
            if (/^\s*TraceId:/.test(l)) break; // end of the rad error
        }
        const out = block.join('\n').trim();
        if (out) return out.slice(0, maxChars);
    }
    // Fallback: collect trailing error-ish lines.
    return extractErrorLines(lines.join('\n'), 20).join('\n').slice(0, maxChars);
}

export function parseResourceProgress(logText, resources) {
    const result = {};
    if (!logText) return result;
    const names = resources.map(r => r.name).filter(Boolean);
    const lines = logText.split(/\r?\n/);
    for (const line of lines) {
        const lower = line.toLowerCase();
        const isFail  = /\b(failed|failure|error|errored)\b/.test(lower);
        const isDone  = /\b(succeeded|completed|complete|created|provisioned|creation complete)\b/.test(lower);
        const isStart = /\b(creating|provisioning|processing|started|deploying|updating|accepted|in progress|inprogress|postponed|waiting|apply(ing)?)\b/.test(lower);
        if (!isFail && !isDone && !isStart) continue;
        for (const name of names) {
            const re = new RegExp('(^|[^A-Za-z0-9_-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_-]|$)');
            if (!re.test(line)) continue;
            if (isFail) result[name] = 'failed';
            else if (isDone) { if (result[name] !== 'failed') result[name] = 'success'; }
            else if (isStart) { if (!result[name]) result[name] = 'in_progress'; }
        }
    }
    return result;
}

export function parseRadDeployLog(logText, resources, opts = {}) {
    const stripPrefix = opts.stripPrefix !== false;
    const result = {};
    if (!logText) return result;
    const names = resources.map(r => r.name).filter(Boolean);
    const lines = logText.split(/\r?\n/);
    for (const raw of lines) {
        const line = stripPrefix ? raw.replace(/^\S+\s+\S+\s+/, '') : raw; // strip GH "job\tstep\t" prefix
        const lower = line.toLowerCase();
        const isDone = /\bcompleted\b/.test(lower) || /\bsucceeded\b/.test(lower);
        const isFail = /\bfailed\b/.test(lower) || /\berror\b/.test(lower);
        if (!isDone && !isFail) continue;
        for (const name of names) {
            // Match the resource name as a whole word in the status line
            const re = new RegExp('(^|[^A-Za-z0-9_-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_-]|$)');
            if (re.test(line)) {
                if (isFail) result[name] = 'failed';
                else if (!result[name]) result[name] = 'success';
            }
        }
    }
    return result;
}
