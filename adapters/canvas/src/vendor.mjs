// Canvas adapter — vendored CDN script cache.
//
// Fetches the browser graph libraries (cytoscape + dagre) once and inlines them
// directly into rendered HTML pages, avoiding CSP/loading issues in the canvas
// webview that block external scripts. Pre-fetched at module load so the first
// page render already has them cached.

import https from "node:https";

const VENDOR_URLS = {
    'cytoscape': 'https://unpkg.com/cytoscape@3.28.1/dist/cytoscape.min.js',
    'dagre': 'https://unpkg.com/dagre@0.8.5/dist/dagre.min.js',
    'cytoscape-dagre': 'https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js',
};
const vendorCache = new Map(); // name → content string

function fetchVendorScript(url) {
    return new Promise((resolve) => {
        https.get(url, { timeout: 15000 }, (resp) => {
            // Follow redirects
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                https.get(resp.headers.location, { timeout: 15000 }, (resp2) => {
                    let data = '';
                    resp2.on('data', c => data += c);
                    resp2.on('end', () => resolve(data));
                    resp2.on('error', () => resolve(null));
                }).on('error', () => resolve(null));
                return;
            }
            let data = '';
            resp.on('data', c => data += c);
            resp.on('end', () => resolve(data));
            resp.on('error', () => resolve(null));
        }).on('error', () => resolve(null));
    });
}

// Ensure all vendor scripts are loaded (called before rendering pages)
export async function ensureVendorScripts() {
    for (const [name, url] of Object.entries(VENDOR_URLS)) {
        if (!vendorCache.has(name)) {
            const content = await fetchVendorScript(url);
            if (content) vendorCache.set(name, content);
        }
    }
}

// Returns inline <script> tags with the library code embedded
export function getInlineVendorScripts() {
    // Escape </script> inside lib code to prevent premature tag closure
    const esc = (s) => (s || '').replace(/<\/script>/gi, '<\\/script>');
    const cy = esc(vendorCache.get('cytoscape'));
    const dg = esc(vendorCache.get('dagre'));
    const cd = esc(vendorCache.get('cytoscape-dagre'));
    return `<script>${cy}</script>\n<script>${dg}</script>\n<script>${cd}</script>`;
}

// Pre-fetch all vendor scripts at extension startup
(async () => { await ensureVendorScripts(); })();
