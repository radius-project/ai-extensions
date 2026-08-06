// Canvas adapter — vendored CDN script cache.
//
// Fetches the browser graph libraries (React, ReactDOM, React Flow + its CSS,
// and dagre) once and inlines them directly into rendered HTML pages, avoiding
// CSP/loading issues in the canvas webview that block external scripts.
// Pre-fetched at module load so the first page render already has them cached.
//
// React Flow renders the application graph (modeled / planned / deployed / diff);
// dagre computes the hierarchical node layout. The React Flow stylesheet is
// required for the pane transform and node/edge positioning to work, so it is
// inlined into the page <head> via getInlineVendorStyles().

import https from "node:https";

// Order matters for the scripts: React and ReactDOM must be defined as globals
// before the React Flow UMD bundle executes (it reads window.React / window.ReactDOM).
const VENDOR_URLS = {
  react: "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "react-dom":
    "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  reactflow: "https://unpkg.com/reactflow@11.11.4/dist/umd/index.js",
  dagre: "https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"
};
// CSS assets inlined into <head> as <style> tags.
const VENDOR_STYLE_URLS = {
  "reactflow-css": "https://unpkg.com/reactflow@11.11.4/dist/style.css"
};
const vendorCache = new Map<string, string>(); // name → content string

function fetchVendorScript(
  url: string,
  redirectsLeft = 5
): Promise<string | null> {
  return new Promise((resolve) => {
    https
      .get(url, { timeout: 15000 }, (resp) => {
        // Follow redirects. unpkg resolves floating tags (react@18 →
        // react@18.3.1) with a *relative* Location header, so resolve it
        // against the current URL and follow up to redirectsLeft hops.
        const statusCode = resp.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400 && resp.headers.location) {
          resp.resume(); // drain the redirect body
          if (redirectsLeft <= 0) {
            resolve(null);
            return;
          }
          const next = new URL(resp.headers.location, url).toString();
          resolve(fetchVendorScript(next, redirectsLeft - 1));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          resp.resume();
          resolve(null);
          return;
        }
        let data = "";
        resp.on("data", (c) => (data += c));
        resp.on("end", () => resolve(data));
        resp.on("error", () => resolve(null));
      })
      .on("error", () => resolve(null));
  });
}

// Ensure all vendor assets (scripts + styles) are loaded (called before rendering pages)
export async function ensureVendorScripts(): Promise<void> {
  const all = { ...VENDOR_URLS, ...VENDOR_STYLE_URLS };
  for (const [name, url] of Object.entries(all)) {
    if (!vendorCache.has(name)) {
      const content = await fetchVendorScript(url);
      if (content) vendorCache.set(name, content);
    }
  }
}

// Returns inline <style> tags for the vendored CSS (React Flow). Injected into
// the page <head> before our own .rad-node styles so our overrides win.
export function getInlineVendorStyles(): string {
  // Escape </style> inside the CSS to prevent premature tag closure
  const esc = (s: string | undefined) =>
    (s || "").replace(/<\/style>/gi, "<\\/style>");
  const rfCss = esc(vendorCache.get("reactflow-css"));
  return `<style>${rfCss}</style>`;
}

// Returns inline <script> tags with the library code embedded, in load order:
// React → ReactDOM → React Flow → dagre.
export function getInlineVendorScripts(): string {
  // Escape </script> inside lib code to prevent premature tag closure
  const esc = (s: string | undefined) =>
    (s || "").replace(/<\/script>/gi, "<\\/script>");
  const react = esc(vendorCache.get("react"));
  const reactDom = esc(vendorCache.get("react-dom"));
  const reactFlow = esc(vendorCache.get("reactflow"));
  const dagre = esc(vendorCache.get("dagre"));
  return `<script>${react}</script>\n<script>${reactDom}</script>\n<script>${reactFlow}</script>\n<script>${dagre}</script>`;
}

// Pre-fetch all vendor assets at extension startup
(async () => {
  await ensureVendorScripts();
})();
