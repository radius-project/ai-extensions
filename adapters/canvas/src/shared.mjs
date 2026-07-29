// Canvas adapter — shared state + small presentation utilities used by both the
// page renderers and the request/route handlers.
//
// `sharedCredentials` is the adapter's persistent OIDC credential cache, keyed by
// provider; it is loaded once at module init and mutated in place (never
// reassigned by callers), so importers see a live view of the same object.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const __dirname_ext = typeof import.meta.url !== 'undefined' ? dirname(fileURLToPath(import.meta.url)) : '.';
const CREDS_FILE = join(__dirname_ext, '.radius-credentials.json');

export let sharedCredentials = {};
try { sharedCredentials = JSON.parse(readFileSync(CREDS_FILE, 'utf8')); } catch {}

export function saveCredentials() {
    try { writeFileSync(CREDS_FILE, JSON.stringify(sharedCredentials, null, 2)); } catch {}
}

// ── Credential profiles ──────────────────────────────────────────────────────
// Reusable per-repo credential profiles backing the Environments → Credentials
// tab. Each profile captures a verified cloud account (provider + tenant/
// subscription or AWS account/region) that environment creation then references.
// Persisted alongside the OIDC cache in `.radius-credentials.json` under a
// `profiles` map keyed by "owner/repo".
function profilesRoot() {
    if (!sharedCredentials.profiles || typeof sharedCredentials.profiles !== 'object') {
        sharedCredentials.profiles = {};
    }
    return sharedCredentials.profiles;
}

export function listCredentialProfiles(repo) {
    const root = profilesRoot();
    const list = root[repo];
    return Array.isArray(list) ? list : [];
}

// Upsert a profile by name (case-insensitive) for a repo, then persist.
export function saveCredentialProfile(repo, profile) {
    if (!repo || !profile) return null;
    // Trim first so a whitespace-only name (e.g. "   ") is rejected rather than
    // persisted as an empty-string profile name.
    const name = String(profile.name || '').trim();
    if (!name) return null;
    const root = profilesRoot();
    const list = Array.isArray(root[repo]) ? root[repo] : (root[repo] = []);
    const entry = {
        name,
        provider: profile.provider === 'aws' ? 'aws' : 'azure',
        status: 'verified',
        user: profile.user || '',
        tenantId: profile.tenantId || '',
        tenantName: profile.tenantName || '',
        subscriptionId: profile.subscriptionId || '',
        subscriptionName: profile.subscriptionName || '',
        accountId: profile.accountId || '',
        region: profile.region || '',
        roleArn: profile.roleArn || '',
        updatedAt: new Date().toISOString(),
    };
    const idx = list.findIndex(p => String(p.name).toLowerCase() === name.toLowerCase());
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    saveCredentials();
    return entry;
}

export function deleteCredentialProfile(repo, name) {
    const root = profilesRoot();
    const list = root[repo];
    if (!Array.isArray(list)) return false;
    const lower = String(name || '').toLowerCase();
    const next = list.filter(p => String(p.name).toLowerCase() !== lower);
    root[repo] = next;
    saveCredentials();
    return next.length !== list.length;
}
