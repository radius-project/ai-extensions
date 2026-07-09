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
} from "@radius-project/core";
import { cliExec, fetchFileFromRepo } from "./gh.mjs";

export { DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE };

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
 * a hard error rather than a fall back to a bundled copy.
 */
async function fetchRadiusTemplate(fileName) {
    let body;
    try {
        body = await fetchFileFromRepo(
            RADIUS_WORKFLOW_REPO,
            `${RADIUS_WORKFLOW_DIR}/${fileName}`,
            RADIUS_REF,
        );
    } catch (err) {
        throw new Error(
            `Failed to fetch workflow template "${fileName}" from ${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR} at "${RADIUS_REF}": ${err?.message ?? err}`,
        );
    }
    if (!body || !body.trim()) {
        throw new Error(
            `Workflow template "${fileName}" not found in ${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR} at "${RADIUS_REF}".`,
        );
    }
    return body;
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
    return coreGenerateDeployWorkflow(env, appFile, templates);
}
export function generatePortalUrl(resourceType, provider, state) {
    return coreGeneratePortalUrl(resourceType, provider, state);
}
