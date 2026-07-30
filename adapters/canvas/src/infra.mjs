// Canvas adapter — cloud infrastructure wrappers: OIDC bootstrap, Azure CLI
// credential validation/login, and GitHub Actions workflow + portal-URL
// generation. Provider-specific logic is delegated to the radius-core
// ComputePlatform; this module only orchestrates the local `az` login flow and
// adapts core outputs for the canvas routes.

import {
  getPlatform,
  generatePortalUrl as coreGeneratePortalUrl,
  generateVerifyWorkflow as coreGenerateVerifyWorkflow,
  generateDeployWorkflow as coreGenerateDeployWorkflow,
  verifyTemplateFile,
  REPO_RADIUS_PINSET,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  pinActionRefs,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeleteWorkflow as coreGenerateDeleteWorkflow,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE,
} from "@radius-project/core";
import {
  cliExec,
  fetchFileFromRepoResult,
  fetchFileFromRepo,
  getDefaultBranch,
} from "./gh.mjs";

export { DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE };
export { DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE, DELETE_AWS_FILE };

export function generateAzureOIDC(data) {
    return getPlatform('azure').generateOidc(data);
}

export function validateAzureCredentials(data) {
    return new Promise((resolve) => {
        const tenantId = data.tenantId || '';
        const subscriptionId = data.subscriptionId || '';
        // First check if already logged in
        cliExec("az", ["account", "show", "--output", "json"], { timeout: 10000 }, (err, stdout) => {
            if (err) {
                // Not logged in — trigger login (with tenant if provided)
                const loginArgs = ["login", "--output", "json"];
                if (tenantId) loginArgs.splice(1, 0, "--tenant", tenantId);
                cliExec("az", loginArgs, { timeout: 120000 }, (loginErr, loginOut) => {
                    if (loginErr) {
                        resolve({ success: false, error: 'Azure login failed. Please ensure Azure CLI is installed and try again.' });
                        return;
                    }
                    finishAuth(subscriptionId, tenantId, resolve);
                });
                return;
            }
            // Already logged in
            try {
                const account = JSON.parse(stdout);
                if (tenantId && account.tenantId !== tenantId) {
                    // Different tenant — re-login
                    cliExec("az", ["login", "--tenant", tenantId, "--output", "json"], { timeout: 120000 }, (loginErr) => {
                        if (loginErr) {
                            resolve({ success: false, error: `Failed to login to tenant ${tenantId}.` });
                            return;
                        }
                        finishAuth(subscriptionId, tenantId, resolve);
                    });
                } else {
                    finishAuth(subscriptionId, tenantId || account.tenantId, resolve);
                }
            } catch (e) {
                finishAuth(subscriptionId, tenantId, resolve);
            }
        });
    });
}

export function finishAuth(subscriptionId, tenantId, resolve) {
    if (subscriptionId) {
        setSubscription(subscriptionId, tenantId, resolve);
    } else {
        // No subscription specified — just read current account
        cliExec("az", ["account", "show", "--output", "json"], { timeout: 10000 }, (err, stdout) => {
            if (err) { resolve({ success: false, error: 'Failed to read account info.' }); return; }
            try {
                const info = JSON.parse(stdout);
                resolve({
                    success: true,
                    tenantId: info.tenantId || tenantId,
                    subscriptionId: info.id || '',
                    subscriptionName: info.name || '',
                    userName: info.user?.name || ''
                });
            } catch (e) {
                resolve({ success: true, tenantId, subscriptionId: '', subscriptionName: '', userName: '' });
            }
        });
    }
}

export function setSubscription(subscriptionId, tenantId, resolve) {
    cliExec("az", ["account", "set", "--subscription", subscriptionId], { timeout: 15000 }, (err) => {
        if (err) {
            resolve({ success: false, error: `Subscription ${subscriptionId} not found or not accessible.` });
            return;
        }
        // Verify by showing account info
        cliExec("az", ["account", "show", "--output", "json"], { timeout: 10000 }, (err2, stdout2) => {
            if (err2) {
                resolve({ success: false, error: 'Failed to verify subscription.' });
                return;
            }
            try {
                const info = JSON.parse(stdout2);
                resolve({
                    success: true,
                    tenantId: info.tenantId || tenantId,
                    subscriptionId: info.id || subscriptionId,
                    subscriptionName: info.name || '',
                    userName: info.user?.name || ''
                });
            } catch (e) {
                resolve({ success: true, tenantId, subscriptionId, subscriptionName: '', userName: '' });
            }
        });
    });
}

export function generateAWSOIDC(data) {
    return getPlatform('aws').generateOidc(data);
}

/**
 * Fetch a workflow template from radius-project/radius `.github/extension/` at
 * the pinned template-source commit. radius-project/radius is the single source
 * of truth, so a fetch failure (offline, transient API error, or the ref/file
 * missing) is a hard error rather than a fall back to a bundled copy. The
 * underlying cause (gh stderr, 404, decode error) is surfaced in the thrown
 * message.
 *
 * The ref is a commit SHA, not a branch: a workflow whose actions are pinned but
 * whose body comes from a moving branch is still not reproducible.
 */
const TEMPLATE_CACHE_TTL_MS = 60_000;
const templateCache = new Map(); // `${ref}\0${fileName}` -> { at, body }

async function fetchRadiusTemplate(fileName, ref = REPO_RADIUS_PINSET.templateSource.sha) {
    // Cache decoded template bodies briefly so a single drift-sync pass (which
    // regenerates workflows for every managed environment) fetches each upstream
    // template once instead of once per environment.
    const cacheKey = `${ref}\u0000${fileName}`;
    const cached = templateCache.get(cacheKey);
    if (cached && Date.now() - cached.at < TEMPLATE_CACHE_TTL_MS) {
        return cached.body;
    }
    const source = `${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR}/${fileName} at "${ref}"`;
    const { content, error } = await fetchFileFromRepoResult(
        RADIUS_WORKFLOW_REPO,
        `${RADIUS_WORKFLOW_DIR}/${fileName}`,
        ref,
    );
    if (error) {
        throw new Error(`Failed to fetch workflow template ${source}: ${error}`);
    }
    if (!content || !content.trim()) {
        throw new Error(`Workflow template ${source} is empty.`);
    }
    templateCache.set(cacheKey, { at: Date.now(), body: content });
    return content;
}

export async function generateVerifyWorkflow(env, provider) {
    const platform = getPlatform(provider);
    if (!platform) throw new Error(`Unknown provider "${provider}". Supported providers: azure, aws.`);
    // Always use the upstream template from radius-project/radius; no fallback.
    const fileName = verifyTemplateFile(platform);
    if (!fileName) throw new Error(`No verify template for provider "${provider}".`);
    const upstream = await fetchRadiusTemplate(fileName);
    return pinActionRefs(coreGenerateVerifyWorkflow(env, platform, upstream), REPO_RADIUS_PINSET);
}

/**
 * Generate the deploy workflow files (dispatcher + both provider workflows).
 * Returns an object mapping bare workflow filename -> YAML content; the caller
 * commits each under `.github/workflows/`. The provider is auto-detected at
 * runtime by the dispatcher, so all three files are emitted regardless of the
 * environment's cloud.
 *
 * The templates are fetched from radius-project/radius `.github/extension/` at
 * the pinned template-source commit so user repos always get the reviewed
 * upstream version; there is no bundled fallback, so a fetch failure surfaces as
 * an error. Every `uses:` the pinset governs is rewritten to its pinned SHA.
 */
export async function generateDeployWorkflow(env, appFile) {
    // Only the dispatcher + the Azure provider workflow are fetched and committed;
    // the AWS provider workflow is intentionally never fetched or committed. The
    // dispatcher's `aws:` job (which `uses:` the absent AWS provider file) is
    // stripped below so GitHub can still parse the committed workflow.
    const files = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
    const bodies = await Promise.all(files.map((f) => fetchRadiusTemplate(f)));
    const templates = {};
    files.forEach((f, i) => {
        templates[f] = bodies[i];
    });
    // Satisfy core's "all files required" contract without a network lookup for
    // the AWS template; the generated AWS output is dropped below and never
    // committed.
    templates[DEPLOY_AWS_FILE] = templates[DEPLOY_AZURE_FILE];
    const generated = coreGenerateDeployWorkflow(env, appFile, templates);
    delete generated[DEPLOY_AWS_FILE];
    // Creating an environment should ONLY run the verify-credentials workflow.
    // The upstream dispatcher auto-triggers the deploy via a `workflow_run`
    // trigger once verify completes; strip it so `run-rad-commands` runs only on
    // explicit `workflow_dispatch` (the Deploy button), never on env creation.
    if (generated && typeof generated[DEPLOY_DISPATCHER_FILE] === 'string') {
        generated[DEPLOY_DISPATCHER_FILE] = stripWorkflowRunTrigger(generated[DEPLOY_DISPATCHER_FILE]);
        generated[DEPLOY_DISPATCHER_FILE] = stripAwsDispatcherJob(generated[DEPLOY_DISPATCHER_FILE]);
    }
    return generated;
}

/**
 * Generate the application-delete workflow files (dispatcher + Azure provider
 * workflow). Returns an object mapping bare workflow filename -> YAML content;
 * the caller commits each under `.github/workflows/`. As with deploy, the AWS
 * provider workflow is never fetched or committed and the dispatcher's `aws:`
 * job is stripped.
 */
export async function generateDeleteWorkflow(env) {
    const files = [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE];
    const bodies = await Promise.all(files.map((f) => fetchRadiusTemplate(f)));
    const templates = {};
    files.forEach((f, i) => {
        templates[f] = bodies[i];
    });
    templates[DELETE_AWS_FILE] = templates[DELETE_AZURE_FILE];
    const generated = coreGenerateDeleteWorkflow(env, templates);
    delete generated[DELETE_AWS_FILE];
    if (generated && typeof generated[DELETE_APP_DISPATCHER_FILE] === 'string') {
        generated[DELETE_APP_DISPATCHER_FILE] = stripAwsDispatcherJob(generated[DELETE_APP_DISPATCHER_FILE]);
    }
    return generated;
}

/**
 * Remove the `aws:` job (and any contiguous comment lines directly above it)
 * from a dispatcher workflow. The extension only commits the Azure provider
 * workflow, so the dispatcher's `aws:` job — which `uses:` the never-committed
 * AWS provider file — would otherwise make GitHub reject the whole workflow with
 * a parse error (HTTP 422). Jobs are indented two spaces; the block runs until
 * the next two-space-indented key, a top-level key, or EOF.
 */
function stripAwsDispatcherJob(yaml) {
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => /^  aws:\s*$/.test(l));
    if (start === -1) return yaml;
    let from = start;
    while (from > 0 && /^  #/.test(lines[from - 1])) from--;
    // Drop a single blank separator line above the block, if present.
    if (from > 0 && lines[from - 1].trim() === '') from--;
    let to = start + 1;
    while (to < lines.length && !/^  \S/.test(lines[to]) && !/^\S/.test(lines[to])) {
        to++;
    }
    lines.splice(from, to - from);
    return lines.join('\n');
}

/**
 * Remove the top-level `workflow_run:` trigger (and its preceding comment block)
 * from a GitHub Actions workflow YAML, leaving `workflow_dispatch` as the only
 * trigger. Operates on the `on:` mapping where triggers are indented two spaces
 * and their children deeper.
 */
function stripWorkflowRunTrigger(yaml) {
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => /^  workflow_run:\s*$/.test(l));
    if (start === -1) return yaml;
    // Include any contiguous comment lines directly above the trigger.
    let from = start;
    while (from > 0 && /^  #/.test(lines[from - 1])) from--;
    // Drop the trigger line and all more-deeply-indented child lines.
    let to = start + 1;
    while (to < lines.length && (/^    /.test(lines[to]) || lines[to].trim() === '')) {
        // Stop at a blank line that is followed by a non-child (keeps section spacing).
        if (lines[to].trim() === '' && !(to + 1 < lines.length && /^    /.test(lines[to + 1]))) break;
        to++;
    }
    lines.splice(from, to - from);
    return lines.join('\n');
}
export function generatePortalUrl(resourceType, provider, state) {
    return coreGeneratePortalUrl(resourceType, provider, state);
}

// Repo path of the shared verify-credentials workflow the extension commits.
const VERIFY_WORKFLOW_PATH = ".github/workflows/radius-verify-credentials.yml";

/**
 * Report which workflow files the extension previously committed to `repo` have
 * drifted from the pinned upstream templates (radius-project/radius
 * `.github/extension/`).
 *
 * **Detection only — this function never writes.** Rewriting a user's workflows
 * changes which code runs with their cloud credentials, so it only ever happens
 * through the confirmed path in workflow-pins.mjs. This pass exists so the
 * Environments listing can surface drift, not to fix it.
 *
 * Files are checked on the repo's default branch (where the verify/deploy
 * Actions run from) AND on the caller's working branch (`opts.workingBranch`,
 * the session worktree branch) when supplied and different — worktree-consistent
 * deploys check out the selected branch's workflow files, so a stale copy there
 * would deploy an out-of-date workflow. A working branch that isn't pushed to
 * the remote (no ref, so its files can't be read) is silently skipped rather
 * than treated as an error.
 *
 * `environments` is the list of Radius-managed environments (`{ name, provider }`)
 * for the repo. Because the committed workflow files are shared across
 * environments (only the `{{ENV}}` dispatch default varies), a file is treated
 * as in-sync when it matches the freshly generated content for ANY managed
 * environment — so a repo with several environments never reports churn on the
 * baked-in default. Drift is only flagged when the committed copy matches none
 * of them, i.e. the pinned upstream template itself changed.
 *
 * `opts.only` (optional) restricts the pass to a set of bare workflow filenames
 * (e.g. `["run-rad-commands.yml", "run-rad-commands-azure.yml"]`).
 *
 * Only files that already exist on a branch are considered; missing files are
 * left to environment creation to author. Returns `{ drifted, branches, skipped }`.
 */
export async function syncRepoWorkflows(repo, environments, opts = {}) {
    const log = typeof opts.log === "function" ? opts.log : () => {};
    const envs = (environments || []).filter((e) => e && e.name);
    if (!repo || envs.length === 0) return { drifted: [], skipped: true };

    // Optional allow-list of bare workflow filenames to sync. When set, only
    // those files are considered (see opts.only above).
    const onlySet =
        opts.only && opts.only.length
            ? new Set(opts.only.map((f) => String(f).split("/").pop()))
            : null;

    const defaultBranch = (await getDefaultBranch(repo)) || "main";
    // Check the default branch (Actions run from it) plus the working branch a
    // worktree-consistent deploy would check out. Dedupe so the same branch is
    // never scanned twice when the working branch IS the default branch.
    const workingBranch = (opts.workingBranch || "").trim();
    const branches = [defaultBranch];
    if (workingBranch && workingBranch !== defaultBranch) branches.push(workingBranch);

    // path -> acceptable (upstream-matching) contents, one candidate per managed
    // environment. Branch-independent, so it's built once and reused per branch.
    const byPath = new Map();
    const add = (path, content) => {
        if (typeof content !== "string" || !content) return;
        if (onlySet && !onlySet.has(path.split("/").pop())) return;
        const list = byPath.get(path) || [];
        list.push({ content });
        byPath.set(path, list);
    };
    const wf = (name) => `.github/workflows/${name}`;

    for (const env of envs) {
        // Which providers to generate verify candidates for. An environment whose
        // provider couldn't be inferred (server.mjs passes "") gets BOTH, so a
        // committed AWS verify file is never reported as drifted merely because
        // the provider was unknown and it was compared to the Azure template.
        const providers =
            env.provider === "azure" || env.provider === "aws"
                ? [env.provider]
                : ["azure", "aws"];
        for (const provider of providers) {
            try {
                add(VERIFY_WORKFLOW_PATH, await generateVerifyWorkflow(env.name, provider));
            } catch (e) {
                log(`skipped verify template for "${env.name}" (${provider}): ${e.message}`);
            }
        }
        // Deploy + delete workflows are provider-agnostic (only the Azure provider
        // file is committed and the content doesn't vary by env provider), so
        // they're generated once per environment.
        try {
            const deploy = await generateDeployWorkflow(env.name, ".radius/app.bicep");
            for (const [file, content] of Object.entries(deploy)) add(wf(file), content);
        } catch (e) {
            log(`skipped deploy templates for "${env.name}": ${e.message}`);
        }
        try {
            const del = await generateDeleteWorkflow(env.name);
            for (const [file, content] of Object.entries(del)) add(wf(file), content);
        } catch (e) {
            log(`skipped delete templates for "${env.name}": ${e.message}`);
        }
    }

    const drifted = new Set();
    for (const branch of branches) {
        for (const [path, candidates] of byPath.entries()) {
            const committed = await fetchFileFromRepo(repo, path, branch);
            // Only consider files the extension previously committed on this
            // branch; don't author missing ones here (environment creation owns
            // that), and an unpushed working branch simply reads as "missing".
            if (committed == null || committed === "") continue;
            // In sync if the committed copy matches any environment's generated
            // content — the only per-env difference is the cosmetic dispatch default.
            if (candidates.some((c) => c.content === committed)) continue;
            drifted.add(path);
            log(`${path} on "${branch}" differs from the pinned upstream template`);
        }
    }

    return { drifted: [...drifted], branches, skipped: false };
}
