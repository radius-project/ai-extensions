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
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeleteWorkflow as coreGenerateDeleteWorkflow,
  DELETE_RADIUS_REF,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE,
} from "@radius-project/core";
import { cliExec, fetchFileFromRepoResult } from "./gh.mjs";

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
 * the pinned RADIUS_REF. radius-project/radius is the single source of truth,
 * so a fetch failure (offline, transient API error, or the ref/file missing) is
 * a hard error rather than a fall back to a bundled copy. The underlying cause
 * (gh stderr, 404, decode error) is surfaced in the thrown message.
 */
async function fetchRadiusTemplate(fileName, ref = RADIUS_REF) {
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
    return content;
}

export async function generateVerifyWorkflow(env, provider) {
    const platform = getPlatform(provider);
    if (!platform) throw new Error(`Unknown provider "${provider}". Supported providers: azure, aws.`);
    // Always use the upstream template from radius-project/radius; no fallback.
    const fileName = verifyTemplateFile(platform);
    if (!fileName) throw new Error(`No verify template for provider "${provider}".`);
    const upstream = await fetchRadiusTemplate(fileName);
    return coreGenerateVerifyWorkflow(env, platform, upstream);
}

/**
 * Generate the deploy workflow files (dispatcher + both provider workflows).
 * Returns an object mapping bare workflow filename -> YAML content; the caller
 * commits each under `.github/workflows/`. The provider is auto-detected at
 * runtime by the dispatcher, so all three files are emitted regardless of the
 * environment's cloud.
 *
 * The templates are fetched from radius-project/radius `.github/extension/` at
 * the pinned RADIUS_REF so user repos always get the reviewed upstream version;
 * there is no bundled fallback, so a fetch failure surfaces as an error.
 */
export async function generateDeployWorkflow(env, appFile) {
    const files = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE];
    const bodies = await Promise.all(files.map((f) => fetchRadiusTemplate(f)));
    const templates = {};
    files.forEach((f, i) => {
        templates[f] = bodies[i];
    });
    const generated = coreGenerateDeployWorkflow(env, appFile, templates);
    // Creating an environment should ONLY run the verify-credentials workflow.
    // The upstream dispatcher auto-triggers the deploy via a `workflow_run`
    // trigger once verify completes; strip it so `run-rad-commands` runs only on
    // explicit `workflow_dispatch` (the Deploy button), never on env creation.
    if (generated && typeof generated[DEPLOY_DISPATCHER_FILE] === 'string') {
        generated[DEPLOY_DISPATCHER_FILE] = stripWorkflowRunTrigger(generated[DEPLOY_DISPATCHER_FILE]);
    }
    return generated;
}

/**
 * Generate the application-delete workflow files (dispatcher + both provider
 * workflows). Returns an object mapping bare workflow filename -> YAML content;
 * the caller commits each under `.github/workflows/`. The provider is
 * auto-detected at runtime by the dispatcher, so all files are emitted.
 *
 * The templates + the `delete-resource` composite action they reference live in
 * radius-project/radius PR #12367 (not yet on `main`), so both the fetch and the
 * `{{RADIUS_REF}}` pinned into the provider workflows use DELETE_RADIUS_REF.
 */
export async function generateDeleteWorkflow(env) {
    const files = [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE, DELETE_AWS_FILE];
    const bodies = await Promise.all(files.map((f) => fetchRadiusTemplate(f, DELETE_RADIUS_REF)));
    const templates = {};
    files.forEach((f, i) => {
        templates[f] = bodies[i];
    });
    return coreGenerateDeleteWorkflow(env, templates);
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
