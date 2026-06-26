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
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const __dirname_ext = typeof import.meta.url !== 'undefined' ? dirname(fileURLToPath(import.meta.url)) : '.';
const CREDS_FILE = join(__dirname_ext, '.radius-credentials.json');

export let sharedCredentials = {};
try { sharedCredentials = JSON.parse(readFileSync(CREDS_FILE, 'utf8')); } catch {}

export function saveCredentials() {
    try { writeFileSync(CREDS_FILE, JSON.stringify(sharedCredentials, null, 2)); } catch {}
}
