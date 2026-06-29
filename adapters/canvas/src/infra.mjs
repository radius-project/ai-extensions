// Canvas adapter — cloud infrastructure wrappers: OIDC bootstrap, Azure CLI
// credential validation/login, and GitHub Actions workflow + portal-URL
// generation. Provider-specific logic is delegated to the radius-core
// ComputePlatform; this module only orchestrates the local `az` login flow and
// adapts core outputs for the canvas routes.

import { execFile } from "node:child_process";
import {
  getPlatform,
  generatePortalUrl as coreGeneratePortalUrl,
  generateVerifyWorkflow as coreGenerateVerifyWorkflow,
  generateDeployWorkflow as coreGenerateDeployWorkflow,
} from "@radius-project/core";

export function generateAzureOIDC(data) {
    return getPlatform('azure').generateOidc(data);
}

export function validateAzureCredentials(data) {
    return new Promise((resolve) => {
        const tenantId = data.tenantId || '';
        const subscriptionId = data.subscriptionId || '';
        // First check if already logged in
        execFile("az", ["account", "show", "--output", "json"], { shell: true, timeout: 10000 }, (err, stdout) => {
            if (err) {
                // Not logged in — trigger login (with tenant if provided)
                const loginArgs = ["login", "--output", "json"];
                if (tenantId) loginArgs.splice(1, 0, "--tenant", tenantId);
                execFile("az", loginArgs, { shell: true, timeout: 120000 }, (loginErr, loginOut) => {
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
                    execFile("az", ["login", "--tenant", tenantId, "--output", "json"], { shell: true, timeout: 120000 }, (loginErr) => {
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
        execFile("az", ["account", "show", "--output", "json"], { shell: true, timeout: 10000 }, (err, stdout) => {
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
    execFile("az", ["account", "set", "--subscription", subscriptionId], { shell: true, timeout: 15000 }, (err) => {
        if (err) {
            resolve({ success: false, error: `Subscription ${subscriptionId} not found or not accessible.` });
            return;
        }
        // Verify by showing account info
        execFile("az", ["account", "show", "--output", "json"], { shell: true, timeout: 10000 }, (err2, stdout2) => {
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

export function generateVerifyWorkflow(env, provider) {
    const platform = getPlatform(provider);
    if (!platform) throw new Error(`Unknown provider "${provider}". Supported providers: azure, aws.`);
    return coreGenerateVerifyWorkflow(env, platform);
}

export function generateDeployWorkflow(env, provider, appFile, creds) {
    const platform = getPlatform(provider);
    if (!platform) throw new Error(`Unknown provider "${provider}". Supported providers: azure, aws.`);
    return coreGenerateDeployWorkflow(env, platform, appFile);
}

export function generatePortalUrl(resourceType, provider, state) {
    return coreGeneratePortalUrl(resourceType, provider, state);
}
