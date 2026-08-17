// Canvas adapter — the shared HTML document shell. Owns the document head,
// theme tokens, top navigation, vendored graph libraries, always-on client
// scripts (repo/branch context, graph rendering, delete dialog, heartbeat,
// operation chip), and the feedback widget that every page renders inside.

import { getInlineVendorScripts, getInlineVendorStyles } from "../vendor.js";
import { browserScriptTag } from "../browser/scripts.js";
import { escapeHtml } from "../shared.js";
import { topNav, feedbackWidget } from "../ui.js";
import { SHELL_STYLE_CSS } from "./shell-styles.js";

// Pick the active top-nav section from a page title.
function navFromTitle(title: string): string {
  const t = String(title || "").toLowerCase();
  if (t.includes("environment")) return "environments";
  if (t.includes("deploying") || t.includes("deployment")) return "deployments";
  return "applications";
}

export function pageShell(
  title: string,
  bodyContent: string,
  activeNav?: string
): string {
  const active = activeNav || navFromTitle(title);
  // The title is a caller-supplied label and is escaped here; `bodyContent` is
  // markup a page renderer has already composed (and escaped its own state
  // into), so it is inserted as trusted HTML.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Ccircle cx='64' cy='64' r='64' fill='%23da4c2a'/%3E%3Ccircle cx='64' cy='64' r='56' fill='%23bb311e' opacity='0.3'/%3E%3Cline x1='64' y1='64' x2='34' y2='28' stroke='white' stroke-width='7' stroke-linecap='round'/%3E%3Ccircle cx='64' cy='64' r='8' fill='white'/%3E%3C/svg%3E" />
<title>${escapeHtml(title)} — Radius</title>
${getInlineVendorStyles()}
<style>
${SHELL_STYLE_CSS}
</style>
</head>
<body>
${topNav(active)}
${getInlineVendorScripts()}
${browserScriptTag("graph")}
${browserScriptTag("delete-dialog")}
<div class="main-content">
${bodyContent}
</div>
${feedbackWidget()}
<div id="radius-reconnect-overlay" style="display:none; position:fixed; inset:0; z-index:9999; background:color-mix(in srgb, var(--rad-bg) 92%, transparent); align-items:center; justify-content:center; flex-direction:column; gap:12px; font-family:var(--rad-font);">
  <div style="width:28px; height:28px; border:3px solid var(--rad-stroke); border-top-color:var(--rad-brand); border-radius:50%; animation:radius-spin 0.8s linear infinite;"></div>
  <div style="font-size:13px; color:var(--rad-text-tertiary);">Reconnecting to Radius…</div>
</div>
<style>@keyframes radius-spin { to { transform: rotate(360deg); } }</style>
${browserScriptTag("heartbeat")}
${browserScriptTag("operation-chip")}
</body>
</html>`;
}
