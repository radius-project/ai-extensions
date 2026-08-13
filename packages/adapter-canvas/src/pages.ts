// Canvas adapter — HTML page renderers. Each function is a `state => html`
// builder for one canvas page; together they are the entire server-side view
// layer. Browser behaviour lives in the embedded client JS (./client.ts) and
// vendored libraries (./vendor.ts); cross-cutting helpers/state come from
// ./shared.ts. No I/O, routing, or business logic here.

import {
  cloudCredential,
  escapeHtml,
  sharedCredentials,
  type CanvasState
} from "./shared.js";
import { formatServesReposLabel, discoverStatusText } from "./azure-oidc.js";
import { getInlineVendorScripts, getInlineVendorStyles } from "./vendor.js";
import {
  CLIENT_REPO_BRANCH_JS,
  CLIENT_GRAPH_JS,
  CLIENT_HEARTBEAT_JS,
  CLIENT_OPCHIP_JS,
  CLIENT_DELETE_DIALOG_JS
} from "./client.js";
import { topNav, radiusMark, feedbackWidget } from "./ui.js";
import { isWorkspaceSelection } from "./workspace.js";

export function serializeBrowserFunction(
  exportName: string,
  fn: (...args: any[]) => unknown
): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw new Error(`Invalid browser function name "${exportName}".`);
  }
  return `var ${exportName} = ${fn.toString()};`;
}

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
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Ccircle cx='64' cy='64' r='64' fill='%23da4c2a'/%3E%3Ccircle cx='64' cy='64' r='56' fill='%23bb311e' opacity='0.3'/%3E%3Cline x1='64' y1='64' x2='34' y2='28' stroke='white' stroke-width='7' stroke-linecap='round'/%3E%3Ccircle cx='64' cy='64' r='8' fill='white'/%3E%3C/svg%3E" />
<title>${title} — Radius</title>
${getInlineVendorStyles()}
<style>
  /* ─── Radius design tokens (from Figma variables) ─────────────────────── */
  :root {
    /* The Copilot host owns theme selection and injects these semantic tokens.
       Radius keeps no competing preference; all theme-sensitive colors flow
       through this layer so host changes update the open canvas immediately. */
    color-scheme: var(--color-scheme, inherit);
    --rad-brand: #da4c2a;
    --rad-brand-dark: #bb311e;
    --rad-primary: #238741;
    --rad-primary-hover: #1f7539;
    --rad-bg: var(--background-color-default, Canvas);
    --rad-surface: var(--background-color-default, Canvas);
    --rad-text: var(--text-color-default, CanvasText);
    --rad-text-secondary: var(--text-color-default, CanvasText);
    --rad-text-tertiary: var(--text-color-muted, color-mix(in srgb, CanvasText 70%, Canvas));
    /* Some host segmented-control tokens retain their light palette in a dark
       canvas. Derive neutral layers from the active host surface and text so
       navigation, graph wells, and secondary buttons always stay in-theme. */
    --rad-bg-subtle: color-mix(in srgb, var(--rad-text) 6%, var(--rad-bg));
    --rad-bg-selected: color-mix(in srgb, var(--rad-text) 12%, var(--rad-bg));
    --rad-bg-hover: color-mix(in srgb, var(--rad-text) 16%, var(--rad-bg));
    --rad-stroke: var(--border-color-default, color-mix(in srgb, var(--rad-text) 20%, var(--rad-bg)));
    --rad-stroke-strong: var(--border-color-muted, color-mix(in srgb, var(--rad-text) 45%, var(--rad-bg)));
    --rad-neutral-bg: var(--rad-bg-subtle);
    --rad-neutral-bg-hover: var(--rad-bg-selected);
    --rad-neutral-border: var(--rad-stroke);
    --rad-neutral-text: var(--rad-text);
    --rad-link: var(--text-color-accent, #0969da);
    --rad-link-hover: var(--text-color-accent-emphasis, #0550ae);
    --rad-info: var(--text-color-accent, #0969da);
    --rad-success: var(--text-color-success, color-mix(in srgb, #1a7f37 70%, CanvasText));
    --rad-warning: var(--text-color-warning, color-mix(in srgb, #9a6700 70%, CanvasText));
    --rad-danger: var(--text-color-danger, color-mix(in srgb, #cf222e 70%, CanvasText));
    --rad-success-solid: #1a7f37;
    --rad-danger-text: var(--rad-danger);
    --rad-danger-solid: #c72222;
    --rad-danger-solid-border: #a61a1a;
    --rad-info-bg: color-mix(in srgb, var(--rad-info) 14%, var(--rad-surface));
    --rad-success-bg: color-mix(in srgb, var(--rad-success) 14%, var(--rad-surface));
    --rad-warning-bg: color-mix(in srgb, var(--rad-warning) 16%, var(--rad-surface));
    --rad-danger-bg: color-mix(in srgb, var(--rad-danger) 14%, var(--rad-surface));
    --rad-node-bg: var(--rad-surface);
    /* Graph lines are data, not chrome, so they deliberately do NOT flow
       through the host's border tokens: --border-color-muted is *fainter*
       than --border-color-default in Primer, which made --rad-stroke-strong
       resolve to the weakest line on the canvas. Mixing the active text
       colour into the active background instead keeps a consistent contrast
       ratio and inverts correctly in dark mode (light lines on a dark
       canvas) without needing a second palette. */
    --rad-node-border: color-mix(in srgb, var(--rad-text) 45%, var(--rad-bg));
    --rad-edge: color-mix(in srgb, var(--rad-text) 55%, var(--rad-bg));
    --rad-edge-muted: color-mix(in srgb, var(--rad-text) 38%, var(--rad-bg));
    --rad-grid: color-mix(in srgb, var(--rad-text) 14%, var(--rad-bg));
    --rad-code-bg: var(--rad-bg-subtle);
    --rad-code-text: var(--rad-text);
    --rad-shadow: color-mix(in srgb, var(--rad-text) 18%, transparent);
    --rad-radius: 6px;
    --rad-radius-lg: 10px;
    --rad-font: 'Mona Sans', var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --rad-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: var(--rad-font);
    font-size: 14px;
    line-height: 20px;
    background: var(--rad-bg);
    color: var(--rad-text);
    display: flex;
    flex-direction: column;
  }

  /* ─── Top nav (Figma TabBar) ──────────────────────────────────────────── */
  .rad-topnav {
    display: flex;
    align-items: stretch;
    gap: 40px;
    padding: 0 20px;
    background: var(--rad-bg-subtle);
    border-bottom: 1px solid var(--rad-stroke);
    flex: 0 0 auto;
  }
  .rad-topnav__tab {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 4px 11px;
    color: var(--rad-text-tertiary);
    text-decoration: none;
    font-weight: 600;
    font-size: 15px;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
    transition: color 0.15s;
  }
  .rad-topnav__tab:hover { color: var(--rad-text); }
  .rad-topnav__tab--active { color: var(--rad-text); font-weight: 700; border-bottom-color: var(--rad-brand); }
  .rad-topnav__icon {
    flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    border-radius: 8px;
    background: transparent;
  }
  .rad-topnav__label { white-space: nowrap; }
  /* Ambient operation chip. Sits at the far end of the nav bar, deliberately
     quiet: it is a signal, not a summons. Nothing here moves the page or takes
     focus. */
  .rad-opchip {
    margin-left: auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 280px;
    padding: 5px 12px;
    border: 1px solid var(--rad-stroke);
    border-radius: 999px;
    background: var(--rad-surface);
    color: var(--rad-text-secondary);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }
  .rad-opchip[hidden] { display: none; }
  .rad-opchip:hover { border-color: var(--rad-brand); color: var(--rad-text); }
  .rad-opchip__label { overflow: hidden; text-overflow: ellipsis; }
  .rad-opchip__dot {
    flex: 0 0 auto;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--rad-text-tertiary);
  }
  .rad-opchip--running .rad-opchip__dot { background: var(--rad-brand); animation: rad-opchip-pulse 1.6s ease-in-out infinite; }
  .rad-opchip--done .rad-opchip__dot { background: var(--rad-success-solid, var(--rad-info)); }
  .rad-opchip--warn .rad-opchip__dot { background: var(--rad-warning); }
  .rad-opchip--failed .rad-opchip__dot { background: var(--rad-danger); }
  @keyframes rad-opchip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) {
    .rad-opchip--running .rad-opchip__dot { animation: none; }
  }

  .main-content {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px;
    min-width: 0;
  }

  /* ─── Headings ────────────────────────────────────────────────────────── */
  .rad-heading { margin-bottom: 20px; }
  .rad-heading h1, h1 {
    display: flex; align-items: center; gap: 10px;
    font-size: 24px; font-weight: 700; letter-spacing: -0.01em;
    color: var(--rad-text); margin-bottom: 8px;
  }
  .rad-lede { color: var(--rad-text-tertiary); font-weight: 300; font-size: 15px; line-height: 22px; max-width: 720px; }
  .rad-lede strong, .rad-lede b { font-weight: 500; color: var(--rad-text-secondary); }
  .rad-lede-link { color: var(--rad-link); text-decoration: none; border-bottom: 1px solid transparent; }
  .rad-lede-link strong { color: inherit; }
  .rad-lede-link:hover, .rad-lede-link:focus-visible { color: var(--rad-link-hover); border-bottom-color: currentColor; }
  .rad-lede-link:focus-visible { outline: 2px solid var(--rad-link); outline-offset: 2px; border-radius: 2px; }
  h2 { font-size: 16px; font-weight: 600; margin: 16px 0 8px; }

  /* ─── Sub-tabs (underlined) ───────────────────────────────────────────── */
  .rad-subtabs { display: flex; gap: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--rad-stroke); }
  .rad-subtab {
    padding: 0 2px 8px; font-size: 15px; font-weight: 500; cursor: pointer;
    color: var(--rad-text-tertiary); text-decoration: none;
    border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s;
  }
  .rad-subtab:hover { color: var(--rad-text); }
  .rad-subtab--active { color: var(--rad-text); font-weight: 700; border-bottom-color: var(--rad-brand); }

  /* ─── Status banners ──────────────────────────────────────────────────── */
  .status, .rad-status { padding: 12px 14px; border-radius: var(--rad-radius); margin: 12px 0; font-size: 13px; }
  .status.info, .rad-status--info { background: var(--rad-info-bg); border: 1px solid var(--rad-info); color: var(--rad-text); }
  .status.success, .rad-status--success { background: var(--rad-success-bg); border: 1px solid var(--rad-success); color: var(--rad-text); }
  .status.error, .rad-status--error { background: var(--rad-danger-bg); border: 1px solid var(--rad-danger); color: var(--rad-text); }

  /* ─── Legacy tabs (kept for pages not yet migrated) ───────────────────── */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--rad-stroke); margin-bottom: 16px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; user-select: none; }
  .tab.active { border-bottom-color: var(--rad-brand); color: var(--rad-text); }

  code { font-family: var(--rad-mono); font-size: 12px; background: var(--rad-code-bg); color: var(--rad-code-text); padding: 2px 6px; border-radius: 4px; }
  pre { background: var(--rad-code-bg); color: var(--rad-code-text); padding: 12px; border-radius: var(--rad-radius); overflow-x: auto; font-size: 12px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }

  /* ─── Fields, inputs, selects ─────────────────────────────────────────── */
  label { display: block; font-weight: 600; font-size: 12px; color: var(--rad-text-tertiary); margin: 10px 0 4px; }
  .rad-field { display: flex; flex-direction: column; gap: 4px; }
  .rad-field label { margin: 0; }
  input:not([type="radio"]):not([type="checkbox"]), select, .rad-select {
    width: 100%; padding: 8px 10px;
    border: 1px solid var(--rad-stroke-strong);
    border-radius: var(--rad-radius); font-size: 13px;
    background: var(--rad-bg); color: var(--rad-text);
    font-family: var(--rad-font);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--rad-text) 2%, transparent);
  }
  input:focus, select:focus, .rad-select:focus { outline: 2px solid var(--rad-brand); outline-offset: 1px; border-color: var(--rad-brand); }
  select.radius-select, .rad-select { appearance: auto; cursor: pointer; min-width: 180px; }

  /* ─── Buttons ─────────────────────────────────────────────────────────── */
  button, .verify-btn, .rad-btn {
    display: inline-block; margin-top: 16px; padding: 8px 16px;
    border: none; border-radius: var(--rad-radius);
    font-weight: 600; font-size: 13px; cursor: pointer; font-family: var(--rad-font);
    transition: background 0.15s, opacity 0.15s;
  }
  button, .verify-btn, .rad-btn--primary { background: var(--rad-primary); color: #fff; }
  button:hover, .verify-btn:hover, .rad-btn--primary:hover { background: var(--rad-primary-hover); }
  .rad-btn--brand { background: var(--rad-brand); color: #fff; }
  .rad-btn--brand:hover { background: var(--rad-brand-dark); }
  .rad-btn--neutral { background: var(--rad-neutral-bg); color: var(--rad-neutral-text); border: 1px solid var(--rad-neutral-border); }
  .rad-btn--neutral:hover { background: var(--rad-neutral-bg-hover); border-color: var(--rad-stroke-strong); }
  .rad-btn--info { background: var(--rad-info); color: #fff; }
  /* Delete buttons: neutral fill + red text, flip to a solid red on hover (Figma DeleteButton). */
  .rad-btn--danger,
  .rad-btn--danger-outline { background: var(--rad-neutral-bg); color: var(--rad-danger-text); border: 1px solid var(--rad-neutral-border); }
  .rad-btn--danger:hover,
  .rad-btn--danger-outline:hover { background: var(--rad-danger-solid); border-color: var(--rad-danger-solid-border); color: #fff; }
  .rad-select-wrap { position: relative; display: inline-block; }
  .rad-select-wrap select {
    appearance: none; -webkit-appearance: none; min-width: 230px; padding: 9px 40px 9px 12px;
    font-size: 14px; color: var(--rad-text); background: var(--rad-surface);
    border: 1px solid var(--rad-stroke); border-radius: 8px; cursor: pointer;
  }
  .rad-select-wrap::after {
    content: ""; position: absolute; right: 14px; top: 50%; width: 8px; height: 8px;
    border-right: 2px solid var(--rad-text-tertiary); border-bottom: 2px solid var(--rad-text-tertiary);
    transform: translateY(-70%) rotate(45deg); pointer-events: none;
  }
  .rad-spinner-lg { flex: 0 0 auto; width: 34px; height: 34px; border: 4px solid var(--rad-stroke); border-top-color: var(--rad-info); border-radius: 50%; animation: rad-spin 0.8s linear infinite; }
  @keyframes rad-spin { to { transform: rotate(360deg); } }
  .rad-btn--info:hover { background: var(--rad-link-hover); }
  button:disabled, .rad-btn:disabled { opacity: 0.6; cursor: default; }
  .rad-btn--primary:disabled { background: var(--rad-stroke, #d1d9e0); color: var(--rad-text-tertiary, #656d76); opacity: 1; }
  .resolved-name { font-weight: 400; color: var(--rad-primary); font-size: 12px; }

  /* ─── Cards, sections, tables (Environments/Deployments) ──────────────── */
  .rad-card {
    background: var(--rad-surface); border: 1px solid var(--rad-stroke);
    border-radius: var(--rad-radius-lg); padding: 20px 24px; margin: 0 0 20px;
  }
  .rad-card__title { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; color: var(--rad-text); margin-bottom: 4px; }
  .rad-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--rad-stroke); }
  .rad-section:first-of-type { border-top: none; padding-top: 0; margin-top: 16px; }
  .rad-section__title { font-size: 15px; font-weight: 600; color: var(--rad-text); margin-bottom: 4px; }
  .rad-section__desc { font-size: 13px; color: var(--rad-text-tertiary); margin-bottom: 8px; }
  /* Lead-in sentence under a card title. */
  .rad-card__lede { font-size: 13px; line-height: 19px; color: var(--rad-text-tertiary); margin: 6px 0 0; max-width: 640px; }
  /* Helper text tucked under a form control. */
  .rad-field__help { font-size: 12px; color: var(--rad-text-tertiary); }
  /* ─── Connection layout (GitHub ⇒ cloud federation) ─────────────────────── */
  /* Presents the two identities as the two ends of a trust: a GitHub side and a
     cloud side, joined by a direction arrow. Collapses to a stack on narrow
     panels, where the arrow rotates to point downward. */
  .rad-conn { display: grid; grid-template-columns: 1fr auto 1fr; align-items: stretch; gap: 12px; margin-top: 12px; }
  .rad-conn__side {
    display: flex; flex-direction: column; gap: 8px;
    border: 1px solid var(--rad-stroke); border-radius: var(--rad-radius);
    background: var(--rad-bg-subtle); padding: 12px 14px;
  }
  .rad-conn__badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--rad-text-tertiary);
  }
  .rad-conn__badge svg { width: 15px; height: 15px; display: block; }
  .rad-conn__arrow {
    display: flex; align-items: center; justify-content: center;
    color: var(--rad-text-tertiary); font-size: 20px; line-height: 1; padding: 0 2px;
  }
  @media (max-width: 620px) {
    .rad-conn { grid-template-columns: 1fr; }
    .rad-conn__arrow { transform: rotate(90deg); padding: 2px 0; }
  }
  .rad-link { color: var(--rad-link); text-decoration: underline; cursor: pointer; font-size: 13px; }
  .rad-link:hover { color: var(--rad-link-hover); }

  .rad-table-wrap { border: 1px solid var(--rad-stroke); border-radius: var(--rad-radius-lg); overflow-x: auto; background: var(--rad-surface); }
  .rad-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .rad-table thead th {
    text-align: left; padding: 12px 14px; font-size: 12px; font-weight: 600;
    letter-spacing: 0.03em; text-transform: uppercase; color: var(--rad-text-tertiary);
    border-bottom: 1px solid var(--rad-stroke); background: var(--rad-bg);
  }
  .rad-table thead th:last-child, .rad-table__actions { text-align: right; }
  .rad-table tbody td { padding: 12px 14px; border-top: 1px solid var(--rad-stroke); vertical-align: middle; }
  .rad-table tbody tr:first-child td { border-top: none; }
  .rad-table__env { font-weight: 700; color: var(--rad-text); }
  .rad-table__provider { color: var(--rad-text-tertiary); }
  .rad-table__creds { color: var(--rad-text-secondary); }
  .rad-table__actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; white-space: nowrap; }
  .rad-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .rad-dot--success { background: var(--rad-success); }
  .rad-dot--failed { background: var(--rad-danger); }
  .rad-dot--pending { background: var(--rad-text-tertiary); }
  .rad-dot--deleting { background: var(--rad-warning); }
  .rad-status-label { vertical-align: middle; }

  /* ─── Graph + node cards ──────────────────────────────────────────────── */
  #graph-container { width: 100%; height: 450px; border-radius: var(--rad-radius-lg); position: relative; background: var(--rad-bg-subtle); }
  #graph-container:empty { background: transparent; }
  .legend { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  .legend-swatch { width: 14px; height: 12px; border-radius: 3px; border: 2px solid var(--rad-node-border); box-sizing: border-box; }
  .rad-node {
    position: relative; width: 220px; min-height: 104px;
    background: var(--rad-surface); border: 2.5px solid var(--rad-node-border);
    border-radius: 16px; padding: 16px 18px;
    pointer-events: auto; cursor: pointer;
  }
  .rad-node__head { display: flex; align-items: center; gap: 10px; }
  .rad-node__icon { width: 40px; height: 40px; flex: none; object-fit: contain; }
  .rad-node__badge { position: absolute; right: 12px; top: 12px; width: 22px; height: 22px; object-fit: contain; pointer-events: none; }
  .rad-node__badge--progress { animation: rad-node-spin 1s linear infinite; }
  @keyframes rad-node-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .rad-node__badge--progress { animation: none; } }
  .rad-node__title { font-weight: 600; font-size: 16px; color: var(--rad-text); }
  .rad-node__type {
    width: 100%; min-width: 0; overflow: hidden; white-space: nowrap;
    font-size: 13px; line-height: 18px; color: var(--rad-text-tertiary); margin-top: 6px;
  }
  .rad-node__source {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 8px;
    font-size: 12px; font-weight: 500; color: var(--rad-link); text-decoration: none; cursor: pointer;
    pointer-events: auto; background: none; border: none; padding: 0; font-family: inherit;
  }
  .rad-node__source:hover { text-decoration: underline; }
  .rad-node__source-glyph { font-family: var(--rad-mono); font-weight: 600; }
  .rad-node__dots {
    position: absolute; right: 10px; bottom: 10px; margin: 0; padding: 2px 4px;
    font-size: 12px; font-weight: 700; letter-spacing: 1px; line-height: 1;
    color: var(--rad-text-tertiary); background: none; border: none; border-radius: 4px;
    cursor: pointer; pointer-events: auto;
  }
  .rad-node__dots:hover { background: var(--rad-bg-subtle); color: var(--rad-text); }

  .field { margin: 8px 0; }
  .field-label { font-weight: 500; color: var(--rad-text-tertiary); font-size: 12px; }
  .field-value { font-family: var(--rad-mono); font-size: 13px; margin-top: 2px; }
  .field-value.placeholder { color: var(--rad-text-tertiary); font-style: italic; }

  /* ─── Feedback widget (Figma feedback-widget) ─────────────────────────── */
  .rad-feedback { position: fixed; right: 16px; bottom: 16px; z-index: 900; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .rad-feedback__btn {
    margin: 0; width: 36px; height: 36px; border-radius: 10px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--rad-text); color: var(--rad-bg); border: none; cursor: pointer; box-shadow: 0 2px 8px var(--rad-shadow);
  }
  .rad-feedback__btn:hover { background: color-mix(in srgb, var(--rad-text) 82%, var(--rad-bg)); }
  .rad-feedback__pop {
    flex-direction: column; min-width: 180px; background: var(--rad-surface);
    border: 1px solid var(--rad-stroke); border-radius: 8px; overflow: hidden;
    box-shadow: 0 6px 20px var(--rad-shadow);
  }
  .rad-feedback__link {
    padding: 10px 14px; font-size: 13px; color: var(--rad-link); text-decoration: none; white-space: nowrap;
  }
  .rad-feedback__link + .rad-feedback__link { border-top: 1px solid var(--rad-stroke); }
  .rad-feedback__link:hover { background: var(--rad-bg-subtle); text-decoration: underline; }

  /* ─── React Flow overrides ────────────────────────────────────────────────
     React Flow ships opinionated defaults (node chrome, visible connection
     handles, a light canvas). We render our own figma .rad-node cards, so strip
     React Flow's node box and hide the handles; the card supplies all visuals. */
  .rad-flow-host { width: 100%; height: 100%; }
  .react-flow, .react-flow__renderer, .react-flow__pane {
    width: 100%; height: 100%; background: transparent;
  }
  .react-flow__node { font-family: var(--rad-font); font-size: 13px; }
  /* Custom "rad" node type: no default background/border/padding — the card owns it. */
  .react-flow__node-rad {
    background: transparent; border: none; border-radius: 0; padding: 0;
    box-shadow: none; width: auto;
  }
  .react-flow__node-rad.selected, .react-flow__node-rad:focus, .react-flow__node-rad:focus-visible {
    outline: none; box-shadow: none;
  }
  .rad-node-shell { position: relative; }
  /* Edge handles exist only so React Flow can route edges; make them invisible
     and non-interactive so they never intercept card clicks. */
  .react-flow__handle.rad-handle {
    width: 1px; height: 1px; min-width: 0; min-height: 0;
    background: transparent; border: none; opacity: 0; pointer-events: none;
  }
  .react-flow__attribution { background: transparent; font-size: 10px; }
  .react-flow__attribution a { color: var(--rad-text-tertiary); }
  .react-flow__controls { box-shadow: 0 1px 4px var(--rad-shadow); border-radius: 6px; overflow: hidden; }
  .react-flow__controls-button {
    background: var(--rad-surface); border-bottom: 1px solid var(--rad-stroke);
    color: var(--rad-text); width: 26px; height: 26px;
  }
  .react-flow__controls-button:hover { background: var(--rad-bg-subtle); }
  .react-flow__controls-button svg { fill: currentColor; }
  .react-flow__minimap { background: var(--rad-surface); border: 1px solid var(--rad-stroke); border-radius: 6px; }
  /* The dot grid is painted by React Flow onto an SVG <circle fill> PRESENTATION
     ATTRIBUTE, and Chromium does not substitute var() there — a var() passed via
     the Background "color" prop is discarded and the dots fall back to black.
     Theme it as a CSS property instead, which does resolve var(). */
  .react-flow__background circle { fill: var(--rad-grid); }
  .react-flow__background path { stroke: var(--rad-grid); }
  /* Delete confirmation dialog (Figma type-to-confirm flow). Global because
     every surface that can delete a deployment shares this one dialog. */
  .rad-ddlg { max-width:480px; width:90%; margin:0; padding:0; background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 24px var(--rad-shadow); overflow:hidden; }
  .rad-ddlg__header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--rad-stroke); }
  .rad-ddlg__title { font-size:16px; font-weight:600; color:var(--rad-text); }
  .rad-ddlg__close { background:none; border:none; cursor:pointer; font-size:14px; line-height:1; color:var(--rad-text-tertiary); padding:6px; border-radius:6px; }
  .rad-ddlg__close:hover { background:var(--rad-neutral-bg); }
  .rad-ddlg__info { display:flex; flex-direction:column; align-items:center; gap:4px; padding:24px 24px 16px; text-align:center; }
  .rad-ddlg__info-icon { width:40px; height:40px; display:flex; align-items:center; justify-content:center; color:var(--rad-text); }
  .rad-ddlg__app { font-size:18px; font-weight:700; color:var(--rad-text); }
  .rad-ddlg__env { font-size:14px; color:var(--rad-text-secondary); }
  .rad-ddlg__content { display:flex; flex-direction:column; gap:16px; padding:24px; }
  .rad-ddlg__text { font-size:14px; line-height:1.5; color:var(--rad-text-secondary); margin:0; }
  .rad-ddlg__btn { width:100%; box-sizing:border-box; display:flex; align-items:center; justify-content:center; padding:12px 16px; border-radius:6px; font-size:14px; cursor:pointer; border:1px solid var(--rad-stroke); background:var(--rad-neutral-bg); color:var(--rad-text); }
  .rad-ddlg__btn:hover { background:var(--rad-neutral-bg-hover); }
  .rad-ddlg__warn { display:flex; gap:10px; align-items:flex-start; background:var(--rad-warning-bg); border:1px solid var(--rad-warning); border-radius:6px; padding:12px; color:var(--rad-text); font-size:14px; line-height:1.4; }
  .rad-ddlg__bullet { display:flex; gap:12px; font-size:14px; line-height:1.5; color:var(--rad-text-secondary); }
  .rad-ddlg__bullet::before { content:""; flex:0 0 2px; align-self:stretch; background:var(--rad-stroke); border-radius:1px; }
  .rad-ddlg__confirm-label { font-size:13px; line-height:1.4; color:var(--rad-text); margin:0; }
  .rad-ddlg__input { width:100%; box-sizing:border-box; height:36px; padding:0 12px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:14px; color:var(--rad-text); background:var(--rad-surface); }
  .rad-ddlg__input:focus { outline:2px solid var(--rad-info); outline-offset:1px; border-color:var(--rad-info); }
  .rad-ddlg__delete { width:100%; box-sizing:border-box; padding:10px 20px; border-radius:6px; border:none; font-size:14px; font-weight:600; color:#fff; background:var(--rad-danger-solid); cursor:pointer; }
  .rad-ddlg__delete:hover { background:var(--rad-danger-solid-border); }
  .rad-ddlg__delete:disabled { background:color-mix(in srgb, var(--rad-danger) 35%, var(--rad-surface)); cursor:default; }
</style>
</head>
<body>
${topNav(active)}
<script>
${CLIENT_REPO_BRANCH_JS}
</script>
${getInlineVendorScripts()}
<script>
${CLIENT_GRAPH_JS}
</script>
<script>
${CLIENT_DELETE_DIALOG_JS}
</script>
<div class="main-content">
${bodyContent}
</div>
${feedbackWidget()}
<div id="radius-reconnect-overlay" style="display:none; position:fixed; inset:0; z-index:9999; background:color-mix(in srgb, var(--rad-bg) 92%, transparent); align-items:center; justify-content:center; flex-direction:column; gap:12px; font-family:var(--rad-font);">
  <div style="width:28px; height:28px; border:3px solid var(--rad-stroke); border-top-color:var(--rad-brand); border-radius:50%; animation:radius-spin 0.8s linear infinite;"></div>
  <div style="font-size:13px; color:var(--rad-text-tertiary);">Reconnecting to Radius…</div>
</div>
<style>@keyframes radius-spin { to { transform: rotate(360deg); } }</style>
<script>
${CLIENT_HEARTBEAT_JS}
</script>
<script>
${CLIENT_OPCHIP_JS}
</script>
</body>
</html>`;
}

export function oidcPage(state: CanvasState = {}): string {
  const azureResult = state?.oidcAzure;
  const awsResult = state?.oidcAws;
  const savedAzure = cloudCredential(sharedCredentials.azure);

  const azureResultHtml =
    azureResult ?
      `<div class="status success">${escapeHtml(azureResult.message)}</div>
<div class="field"><span class="field-label">Tenant</span><div class="field-value">${escapeHtml(
        azureResult.tenantName || ""
      )}${azureResult.tenantName ? " — " : ""}${escapeHtml(
        azureResult.tenantId
      )}</div></div>
<div class="field"><span class="field-label">Subscription</span><div class="field-value">${escapeHtml(
        azureResult.subscriptionName || ""
      )}${azureResult.subscriptionName ? " — " : ""}${escapeHtml(
        azureResult.subscriptionId
      )}</div></div>
<div class="field"><span class="field-label">App Registration</span><div class="field-value">${escapeHtml(
        azureResult.clientName || ""
      )}${azureResult.clientName ? " — " : ""}${escapeHtml(
        azureResult.clientId
      )}</div></div>
`
    : "";

  const awsResultHtml =
    awsResult ?
      `<div class="status success">${escapeHtml(awsResult.message)}</div>
<div class="field"><span class="field-label">Account</span><div class="field-value">${escapeHtml(
        awsResult.accountName || ""
      )}${awsResult.accountName ? " — " : ""}${escapeHtml(
        awsResult.accountId
      )}</div></div>
<div class="field"><span class="field-label">Region</span><div class="field-value">${escapeHtml(
        awsResult.region
      )}</div></div>`
    : "";

  return pageShell(
    "Accounts",
    `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#da4c2a"/><circle cx="64" cy="64" r="56" fill="#bb311e" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Cloud Accounts</h1>
<p style="margin-bottom:16px; color:var(--rad-text-tertiary);">
  Set up OpenID Connect federation so GitHub Actions can authenticate to your cloud provider without long-lived secrets.
</p>
<div class="tabs">
  <div class="tab active" id="tab-azure">Azure</div>
  <div class="tab" id="tab-aws">AWS</div>
</div>
<div id="panel-azure">
  <label>Tenant ID</label>
  <input id="az-tenant" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(
    azureResult?.tenantId || savedAzure.tenantId || ""
  )}" />
  <label>Subscription ID</label>
  <input id="az-sub" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(
    azureResult?.subscriptionId || savedAzure.subscriptionId || ""
  )}" />
  <label>Client ID (App Registration)</label>
  <input id="az-client" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(
    azureResult?.clientId || savedAzure.clientId || ""
  )}" />
  <button id="btn-azure">Confirm authentication</button>
  <div id="result-azure">${azureResultHtml}</div>
</div>
<div id="panel-aws" style="display:none;">
  <label>Account ID</label>
  <input id="aws-account" placeholder="123456789012" value="${escapeHtml(
    awsResult?.accountId || ""
  )}" />
  <label>Region</label>
  <input id="aws-region" placeholder="us-east-1" value="${escapeHtml(
    awsResult?.region || ""
  )}" />
  <button id="btn-aws">Validate</button>
  <div id="result-aws">${awsResultHtml}</div>
</div>
<script>
document.getElementById('tab-azure').addEventListener('click', function() {
    document.getElementById('tab-azure').classList.add('active');
    document.getElementById('tab-aws').classList.remove('active');
    document.getElementById('panel-azure').style.display = 'block';
    document.getElementById('panel-aws').style.display = 'none';
});
document.getElementById('tab-aws').addEventListener('click', function() {
    document.getElementById('tab-aws').classList.add('active');
    document.getElementById('tab-azure').classList.remove('active');
    document.getElementById('panel-aws').style.display = 'block';
    document.getElementById('panel-azure').style.display = 'none';
});
document.getElementById('btn-azure').addEventListener('click', function() {
    var data = {
        provider: 'azure',
        tenantId: document.getElementById('az-tenant').value.trim(),
        subscriptionId: document.getElementById('az-sub').value.trim(),
        clientId: document.getElementById('az-client').value.trim()
    };
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Authenticating...';
    var resultDiv = document.getElementById('result-azure');
    resultDiv.innerHTML = '<div class="status info">🔐 Signing in to Azure... A browser window may open.</div>';
    fetch('/api/oidc', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) })
        .then(function(r) { return r.json(); })
        .then(function(res) {
            btn.disabled = false;
            btn.textContent = 'Confirm authentication';
            if (res.validated) {
                resultDiv.innerHTML = '<div class="status success">' + res.message + '</div>' +
                    '<div class="field"><span class="field-label">Tenant</span><div class="field-value">' + (res.tenantId || data.tenantId) + '</div></div>' +
                    '<div class="field"><span class="field-label">Subscription</span><div class="field-value">' + (res.subscriptionName ? res.subscriptionName + ' — ' : '') + (res.subscriptionId || data.subscriptionId) + '</div></div>' +
                    (data.clientId ? '<div class="field"><span class="field-label">App Registration</span><div class="field-value">' + data.clientId + '</div></div>' : '') +
                    (res.userName ? '<div class="field"><span class="field-label">Signed in as</span><div class="field-value">' + res.userName + '</div></div>' : '');
            } else {
                resultDiv.innerHTML = '<div class="status error">' + (res.message || 'Authentication failed') + '</div>';
            }
        })
        .catch(function(e) { btn.disabled = false; btn.textContent = 'Confirm authentication'; resultDiv.innerHTML = '<div class="status error">Error: ' + e.message + '</div>'; });
});
document.getElementById('btn-aws').addEventListener('click', function() {
    var data = {
        provider: 'aws',
        accountId: document.getElementById('aws-account').value,
        region: document.getElementById('aws-region').value
    };
    var resultDiv = document.getElementById('result-aws');
    resultDiv.innerHTML = '<div class="status info">Validating...</div>';
    fetch('/api/oidc', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) })
        .then(function(r) { return r.json(); })
        .then(function(res) {
            resultDiv.innerHTML = '<div class="status success">' + res.message + '</div>' +
                '<div class="field"><span class="field-label">Account</span><div class="field-value">' + data.accountId + '</div></div>' +
                '<div class="field"><span class="field-label">Region</span><div class="field-value">' + data.region + '</div></div>';
        })
        .catch(function(e) { resultDiv.innerHTML = '<div class="status error">Error: ' + e.message + '</div>'; });
});
<\/script>`
  );
}

export function graphHeader(activePage: string): string {
  const pages = [
    { id: "graph", label: "Modeled" },
    { id: "planned", label: "Planned" },
    { id: "deployed", label: "Deployed" },
    { id: "graph-diff", label: "Diff" }
  ];
  const navLinks = pages
    .map((p) => {
      const cls =
        p.id === activePage ? "rad-subtab rad-subtab--active" : "rad-subtab";
      return `<a href="?page=${p.id}" data-page="${p.id}" class="${cls}" onclick="radiusNavTo(event, '${p.id}')">${p.label}</a>`;
    })
    .join("\n  ");
  // Each mode named in the lede links to its own sub-tab. Built from the same
  // `pages` list as the nav so the two can never point at different routes.
  const byLabel = Object.fromEntries(pages.map((p) => [p.label, p.id]));
  const ledeLink = (label: string) =>
    `<a href="?page=${byLabel[label]}" class="rad-lede-link" onclick="radiusNavTo(event, '${byLabel[label]}')"><strong>${label}</strong></a>`;
  return `
<div class="rad-heading">
  <h1>${radiusMark(26)}<span>Application Graph</span></h1>
  <p class="rad-lede">
    Visualize your application graph as you've designed it (${ledeLink(
      "Modeled"
    )}), as you want it deployed (${ledeLink(
      "Planned"
    )}), as it's running in your environments (${ledeLink(
      "Deployed"
    )}), or as it differs between branches (${ledeLink("Diff")}).
  </p>
</div>
<nav id="graph-nav" class="rad-subtabs">
  ${navLinks}
</nav>
<div id="graph-page-content">`;
}

export function graphHeaderClose() {
  return `</div>`;
}

export function graphPage(state: CanvasState = {}): string {
  const resources = state?.graphResources || [];
  const resourcesJson = JSON.stringify(resources);
  const targetRepo = state?.graphTargetRepo || state?.contextRepo || "";
  const graphBranch = state?.graphBranch || state?.contextBranch || "main";
  // Local-workspace graphs are built from the on-disk worktree checkout, so the
  // "View source code" link should open the local file in the editor canvas
  // rather than a GitHub blob URL (which 404s for an unpushed worktree branch).
  // Prefer the authoritative provenance flag persisted by the graph handler
  // (true only when the local workspace actually supplied the app.bicep); fall
  // back to repo+branch matching only for render paths that don't set it (MCP).
  const localSource =
    typeof state?.graphFromWorkspace === "boolean" ?
      state.graphFromWorkspace
    : isWorkspaceSelection(state, targetRepo, graphBranch);

  if (resources.length === 0 && !state?.graphLoaded) {
    return pageShell(
      "Application Graph",
      `
${graphHeader("graph")}
<p class="rad-lede" id="modeled-subtitle" style="margin:0 0 24px;">The modeled application graph shows the high-level architecture of your application as it is designed in code.<span id="modeled-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Application</label>
    <select id="graph-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:220px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Plan Deployment</button>
</div>
<div id="graph-status" class="status info">Select a branch to generate the application graph. If no app.bicep exists, one will be generated from the repo structure.</div>
<div id="graph-container-wrapper"></div>
<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(graphBranch)}';

// Populate the Application dropdown for the current repository.
(function() {
    var appSel = document.getElementById('graph-app');
    if (!CONTEXT_REPO) { appSel.innerHTML = '<option value="">No application context</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CONTEXT_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = d.applications || [];
            appSel.innerHTML = '';
            if (apps.length === 0) {
                var fallback = CONTEXT_REPO.split('/').pop() || CONTEXT_REPO;
                var o = document.createElement('option');
                o.value = fallback; o.textContent = fallback; appSel.appendChild(o);
                return;
            }
            apps.forEach(function(a) {
                var o = document.createElement('option');
                o.value = a.name; o.textContent = a.name; appSel.appendChild(o);
            });
        })
        .catch(function() { appSel.innerHTML = '<option value="">Unable to load applications</option>'; });
})();

// Populate the Branch dropdown, defaulting to the current worktree branch.
(function() {
    var branchSel = document.getElementById('graph-branch');
    if (!CONTEXT_REPO) { branchSel.innerHTML = '<option value="">No repository context</option>'; return; }
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: CONTEXT_REPO}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var branches = (d && d.branches) || [];
            var workspaceBranch = (d && d.workspaceBranch) || CONTEXT_BRANCH || '';
            branchSel.innerHTML = '<option value="">— Select a branch —</option>';
            branches.forEach(function(b) {
                var o = document.createElement('option');
                o.value = b.name;
                o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : ' (' + b.sha.slice(0,7) + ')');
                if (workspaceBranch && b.name === workspaceBranch) o.selected = true;
                branchSel.appendChild(o);
            });
            // Default to the current worktree branch and auto-generate its graph.
            if (workspaceBranch && branchSel.value === workspaceBranch) {
                branchSel.dispatchEvent(new Event('change'));
            }
        })
        .catch(function() { branchSel.innerHTML = '<option value="">Unable to load branches</option>'; });
})();

// Auto-generate the graph as soon as a branch is chosen, and enable the
// primary button (greyed out until a branch is selected, unless it is the
// branch-independent "Create Environment" action).
document.getElementById('graph-branch').addEventListener('change', function() {
    var deployBtn = document.getElementById('deploy-app-btn');
    if (this.value) {
        if (deployBtn) deployBtn.disabled = false;
        generateGraph();
    } else if (deployBtn && deployBtn.dataset.mode !== 'create-env') {
        deployBtn.disabled = true;
    }
});

// Primary action → Create Environment or Plan Deployment, depending on setup.
document.getElementById('deploy-app-btn').addEventListener('click', function(e) {
    radiusModeledPrimaryAction(this);
});

radiusLoadModeledEnvState(CONTEXT_REPO);

function generateGraph() {
    var repo = CONTEXT_REPO;
    var branch = document.getElementById('graph-branch').value.trim();
    if (!repo) return;
    var statusEl0 = document.getElementById('graph-status');
    if (!branch) {
        if (statusEl0) { statusEl0.textContent = 'Select a branch to generate the application graph.'; statusEl0.className = 'status info'; statusEl0.style.display = ''; }
        return;
    }
    var wrapper = document.getElementById('graph-container-wrapper');
    wrapper.innerHTML = '<div id="graph-container"></div>';
    var container = document.getElementById('graph-container');
    var statusEl = document.getElementById('graph-status');
    if (statusEl) { statusEl.style.display = 'none'; }
    if (window.radiusGraphProgressPoller) clearInterval(window.radiusGraphProgressPoller);
    if (window.radiusGraphProgressTicker) clearInterval(window.radiusGraphProgressTicker);
    if (window.radiusGraphRetryTimer) clearTimeout(window.radiusGraphRetryTimer);
    container.innerHTML = '<div id="progress-panel" style="padding:20px; max-width:560px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--rad-text);">Generating Application Graph</span>' +
        '</div>' +
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">' +
        '<strong id="progress-stage" style="font-size:13px; color:var(--rad-text);">Checking for an existing app model</strong>' +
        '<span id="progress-percent" style="font-size:12px; color:var(--rad-text-tertiary);">5%</span>' +
        '</div>' +
        '<div style="height:8px; border-radius:999px; background:var(--rad-bg-subtle); overflow:hidden; margin-bottom:10px;">' +
        '<div id="progress-bar-fill" style="height:100%; width:5%; border-radius:999px; background:var(--rad-brand); transition:width 0.4s ease, background 0.2s ease;"></div>' +
        '</div>' +
        '<div id="progress-status-text" style="font-size:13px; color:var(--rad-text); margin-bottom:4px;">Checking the selected branch for .radius/app.bicep…</div>' +
        '<div id="progress-eta" style="font-size:12px; color:var(--rad-text-tertiary); margin-bottom:14px;">Usually completes in about 5 minutes.</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--rad-stroke);border-top-color:var(--rad-brand);border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-success);margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-pending::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-bg-subtle);margin-right:8px;vertical-align:1px}.step-active{color:var(--rad-text);font-weight:500}.step-error::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-danger);margin-right:8px;vertical-align:1px}.step-error{color:var(--rad-danger);font-weight:600}</style>';

    var stepsEl = document.getElementById('progress-steps');
    var stageEl = document.getElementById('progress-stage');
    var percentEl = document.getElementById('progress-percent');
    var fillEl = document.getElementById('progress-bar-fill');
    var progressStatusTextEl = document.getElementById('progress-status-text');
    var etaEl = document.getElementById('progress-eta');
    var shownSteps = 0;
    var progressStartedAt = Date.now();
    var lastProgressPercent = 5;
    var waitingForAppBicep = false;
    var loadRequestInFlight = false;
    var graphRunFinished = false;
    var graphRunToken = Date.now().toString() + Math.random().toString(36).slice(2);
    window.radiusGraphRunToken = graphRunToken;
    var EXPECTED_GRAPH_DURATION_MS = 5 * 60 * 1000;
    var WAITING_STAGE_COPY = [
        { label: 'Checking for an existing app model', status: 'Checking the selected branch for .radius/app.bicep…' },
        { label: 'Analyzing the repository structure', status: 'Copilot is reviewing the repository so it can draft .radius/app.bicep.' },
        { label: 'Drafting .radius/app.bicep', status: 'Still working — larger repositories can take a few minutes at this stage.' },
        { label: 'Validating relationships for the graph', status: 'Finalizing the generated app model before Radius renders the graph.' }
    ];

    function clearGraphProgressTimers() {
        if (window.radiusGraphRunToken !== graphRunToken) return;
        if (window.radiusGraphProgressPoller) clearInterval(window.radiusGraphProgressPoller);
        if (window.radiusGraphProgressTicker) clearInterval(window.radiusGraphProgressTicker);
        if (window.radiusGraphRetryTimer) clearTimeout(window.radiusGraphRetryTimer);
    }

    function formatRemaining(ms) {
        if (ms <= 0) return 'Finishing up…';
        var totalSeconds = Math.ceil(ms / 1000);
        var minutes = Math.floor(totalSeconds / 60);
        if (minutes >= 2) return 'About ' + minutes + ' minutes remaining';
        if (minutes === 1) return 'About 1 minute remaining';
        return 'Less than a minute remaining';
    }

    function renderWaitingSteps(activeIndex, tone) {
        stepsEl.innerHTML = '';
        WAITING_STAGE_COPY.forEach(function(step, idx) {
            var div = document.createElement('div');
            div.className = tone === 'error'
                ? (idx === activeIndex ? 'step-error' : 'step-pending')
                : (idx < activeIndex ? 'step-done' : (idx === activeIndex ? 'step-active' : 'step-pending'));
            div.textContent = step.label;
            stepsEl.appendChild(div);
        });
    }

    function setProgressState(percent, stage, statusText, etaText, tone) {
        var clamped = Math.max(0, Math.min(100, percent));
        lastProgressPercent = clamped;
        if (fillEl) {
            fillEl.style.width = clamped + '%';
            fillEl.style.background = tone === 'error'
                ? 'var(--rad-danger)'
                : tone === 'success'
                    ? 'var(--rad-success)'
                    : 'var(--rad-brand)';
        }
        if (percentEl) percentEl.textContent = Math.round(clamped) + '%';
        if (stageEl) stageEl.textContent = stage;
        if (progressStatusTextEl) progressStatusTextEl.textContent = statusText;
        if (etaEl) etaEl.textContent = etaText;
    }

    function updateWaitingProgress() {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished || !waitingForAppBicep) return;
        var elapsed = Date.now() - progressStartedAt;
        var activeIndex = elapsed < 45000 ? 0 : elapsed < 150000 ? 1 : elapsed < 270000 ? 2 : 3;
        var percent = elapsed < EXPECTED_GRAPH_DURATION_MS
            ? 18 + ((elapsed / EXPECTED_GRAPH_DURATION_MS) * 50)
            : 72;
        renderWaitingSteps(activeIndex);
        setProgressState(
            Math.min(72, percent),
            WAITING_STAGE_COPY[activeIndex].label,
            WAITING_STAGE_COPY[activeIndex].status,
            elapsed < EXPECTED_GRAPH_DURATION_MS
                ? 'Usually completes in about 5 minutes. ' + formatRemaining(EXPECTED_GRAPH_DURATION_MS - elapsed) + '.'
                : 'Still running — complex repositories can take a little longer than 5 minutes.',
            'running'
        );
    }

    function syncProgressMessages(msgs) {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
        if (!Array.isArray(msgs)) msgs = [];
        if (msgs.length < shownSteps) {
            shownSteps = 0;
            stepsEl.innerHTML = '';
        }
        for (var i = shownSteps; i < msgs.length; i++) {
            var prev = stepsEl.querySelector('.step-active');
            if (prev) prev.className = 'step-done';
            var div = document.createElement('div');
            div.className = 'step-active';
            div.textContent = msgs[i];
            stepsEl.appendChild(div);
        }
        shownSteps = msgs.length;
        if (!msgs.length) return;
        var latest = msgs[msgs.length - 1] || '';
        if (latest.indexOf('Checking ') === 0) {
            waitingForAppBicep = false;
            setProgressState(10, 'Checking for an existing app model', latest, 'Usually completes in about 5 minutes.', 'running');
        } else if (latest.indexOf('.radius/app.bicep not present') === 0) {
            waitingForAppBicep = true;
            updateWaitingProgress();
        } else if (latest.indexOf('Found existing app.bicep') === 0) {
            waitingForAppBicep = false;
            setProgressState(82, 'Parsing .radius/app.bicep', latest, 'Final steps — less than a minute remaining.', 'running');
        } else if (latest.indexOf('Mapped ') === 0) {
            waitingForAppBicep = false;
            setProgressState(95, 'Rendering the application graph', latest, 'Almost done — preparing the final graph view.', 'running');
        } else {
            waitingForAppBicep = false;
            setProgressState(Math.max(lastProgressPercent, 88), 'Preparing the application graph', latest, 'Radius is still building the graph.', 'running');
        }
    }

    function scheduleGraphRetry(delayMs) {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
        if (window.radiusGraphRetryTimer) clearTimeout(window.radiusGraphRetryTimer);
        window.radiusGraphRetryTimer = setTimeout(function() {
            if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
            requestGraphLoad();
        }, delayMs || 10000);
    }

    function requestGraphLoad() {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished || loadRequestInFlight) return;
        loadRequestInFlight = true;
        fetch('/api/load-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch}) })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
                if (d.reload) {
                    waitingForAppBicep = false;
                    var prev = stepsEl.querySelector('.step-active');
                    if (prev) prev.className = 'step-done';
                    var doneDiv = document.createElement('div');
                    doneDiv.className = 'step-done';
                    doneDiv.textContent = 'Graph ready!';
                    stepsEl.appendChild(doneDiv);
                    setProgressState(100, 'Application graph ready', 'Application graph generated successfully.', 'Completed successfully.', 'success');
                    graphRunFinished = true;
                    clearGraphProgressTimers();
                    setTimeout(function() {
                        if (window.radiusGraphRunToken !== graphRunToken || !graphRunFinished) return;
                        window.location.reload();
                    }, 600);
                } else if (d.needsAppBicep) {
                    waitingForAppBicep = true;
                    if (!shownSteps) {
                        syncProgressMessages([
                            'Checking ' + repo + ' for existing app.bicep...',
                            '.radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill.'
                        ]);
                    } else {
                        updateWaitingProgress();
                    }
                    scheduleGraphRetry();
                } else if (d.stale) {
                    waitingForAppBicep = false;
                    setProgressState(
                        Math.max(lastProgressPercent, 88),
                        'Refreshing the application graph',
                        'A newer graph request replaced this one.',
                        'Retrying with the latest request shortly.',
                        'running'
                    );
                    scheduleGraphRetry(1000);
                } else if (d.error) {
                    waitingForAppBicep = false;
                    renderWaitingSteps(WAITING_STAGE_COPY.length - 1, 'error');
                    setProgressState(Math.min(lastProgressPercent, 95), 'Graph generation failed', 'Error: ' + d.error, 'The workflow stopped before completion.', 'error');
                    if (statusEl) { statusEl.textContent = 'Error: ' + d.error; statusEl.className = 'status error'; statusEl.style.display = ''; }
                    graphRunFinished = true;
                    clearGraphProgressTimers();
                }
            })
            .catch(function() {
                if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
                waitingForAppBicep = false;
                renderWaitingSteps(WAITING_STAGE_COPY.length - 1, 'error');
                setProgressState(Math.min(lastProgressPercent, 95), 'Graph generation failed', 'Failed to continue generating the application graph.', 'Please try again.', 'error');
                if (statusEl) { statusEl.textContent = 'Failed to generate the application graph.'; statusEl.className = 'status error'; statusEl.style.display = ''; }
                graphRunFinished = true;
                clearGraphProgressTimers();
            })
            .finally(function() {
                if (window.radiusGraphRunToken !== graphRunToken) return;
                loadRequestInFlight = false;
            });
    }

    renderWaitingSteps(0);
    window.radiusGraphProgressPoller = setInterval(function() {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
        fetch('/api/progress').then(function(r) { return r.json(); }).then(function(d) {
            if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
            syncProgressMessages(d.messages || []);
        }).catch(function() {});
    }, 800);
    window.radiusGraphProgressTicker = setInterval(updateWaitingProgress, 1000);
    requestGraphLoad();
}
<\/script>
${graphHeaderClose()}`
    );
  }

  return pageShell(
    "Application Graph",
    `
${graphHeader("graph")}
<p class="rad-lede" id="modeled-subtitle" style="margin:0 0 24px;">The modeled application graph shows the high-level architecture of your application as it is designed in code.<span id="modeled-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <input type="hidden" id="graph-repo" value="${escapeHtml(targetRepo)}">
  <div class="rad-field">
    <label>Application</label>
    <select id="graph-app" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="${escapeHtml(graphBranch)}" selected>${escapeHtml(
        graphBranch || "main"
      )}</option>
    </select>
  </div>
  <button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;">Plan Deployment</button>
</div>
<div id="graph-container"></div>
<div id="graph-refresh-status" class="status error" style="display:none;"></div>
<div style="margin-top:8px; font-size:12px; color:var(--rad-text-tertiary);">
Click a node to view source code links.
</div>

<script>
var CONTEXT_REPO = document.getElementById('graph-repo').value;
var CURRENT_BRANCH = '${escapeHtml(graphBranch || "main")}';

// Populate the Application dropdown for the current repository.
(function() {
    var appSel = document.getElementById('graph-app');
    if (!CONTEXT_REPO) { appSel.innerHTML = '<option value="">No application context</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CONTEXT_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = d.applications || [];
            appSel.innerHTML = '';
            if (apps.length === 0) {
                var f = CONTEXT_REPO.split('/').pop() || CONTEXT_REPO;
                var o = document.createElement('option'); o.value = f; o.textContent = f; appSel.appendChild(o);
                return;
            }
            apps.forEach(function(a) { var o = document.createElement('option'); o.value = a.name; o.textContent = a.name; appSel.appendChild(o); });
        })
        .catch(function() { appSel.innerHTML = '<option value="">Unable to load applications</option>'; });
})();

// Populate the Branch dropdown, keeping the current branch selected.
(function() {
    var branchSel = document.getElementById('graph-branch');
    if (!CONTEXT_REPO) return;
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: CONTEXT_REPO}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var branches = (d && d.branches) || [];
            if (!branches.length) return;
            branchSel.innerHTML = '';
            branches.forEach(function(b) {
                var o = document.createElement('option');
                o.value = b.name;
                o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : ' (' + b.sha.slice(0,7) + ')');
                if (b.name === CURRENT_BRANCH) o.selected = true;
                branchSel.appendChild(o);
            });
        })
        .catch(function() {});
})();

// Regenerate the graph when a different branch is selected.
document.getElementById('graph-branch').addEventListener('change', function() {
    var repo = CONTEXT_REPO;
    var branch = this.value.trim();
    if (!repo || !branch) return;
    var container = document.getElementById('graph-container');
    container.innerHTML = '<div style="padding:20px; color:var(--rad-text-tertiary);">⏳ Regenerating graph for ' + branch + '…</div>';
    fetch('/api/load-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.reload) { window.location.reload(); }
            else if (d.needsAppBicep) { container.innerHTML = '<div class="status info">Copilot is generating .radius/app.bicep with the Radius app-bicep skill\u2026 the graph will appear once it is saved.</div>'; }
            else if (d.error) { container.innerHTML = '<div class="status error"></div>'; container.firstChild.textContent = 'Error: ' + d.error; }
        })
        .catch(function() { container.innerHTML = '<div class="status error">Failed to regenerate graph.</div>'; });
});

// Primary action → Create Environment or Plan Deployment, depending on setup.
document.getElementById('deploy-app-btn').addEventListener('click', function(e) {
    radiusModeledPrimaryAction(this);
});

radiusLoadModeledEnvState(CONTEXT_REPO);

var resources = ${resourcesJson};
var repoUrl = 'https://github.com/' + document.getElementById('graph-repo').value.trim();
var branch = document.getElementById('graph-branch').value.trim() || 'main';
var graphOptions = {
    repoUrl: repoUrl,
    branch: branch,
    localSource: ${localSource ? "true" : "false"}
};
var graphController = radiusRenderGraph('graph-container', resources, graphOptions);

// Rebuild from app.bicep whenever the panel is loaded. This keeps a reopened
// panel current after a merge without requiring a new canvas instance.
fetch('/api/load-graph', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({repo: CONTEXT_REPO, branch: branch, refresh: true})
})
    .then(function(r) { return r.json(); })
    .then(function(d) {
        if (Array.isArray(d.resources)) {
            if (graphController) graphController = graphController.update(d.resources) || graphController;
            else graphController = radiusRenderGraph('graph-container', d.resources, graphOptions);
        } else if (d.needsAppBicep) {
            var generatingStatus = document.getElementById('graph-refresh-status');
            generatingStatus.className = 'status info';
            generatingStatus.textContent = 'Copilot is rebuilding the application graph from .radius/app.bicep with the Radius app-bicep skill.';
            generatingStatus.style.display = '';
        } else if (d.error) {
            var status = document.getElementById('graph-refresh-status');
            status.textContent = 'Unable to refresh the application graph: ' + d.error;
            status.style.display = '';
        }
    })
    .catch(function() {
        var status = document.getElementById('graph-refresh-status');
        status.textContent = 'Unable to refresh the application graph.';
        status.style.display = '';
    });
<\/script>
${graphHeaderClose()}`
  );
}

export function plannedGraphPage(state: CanvasState = {}): string {
  const targetRepo =
    state?.plannedRepo || state?.graphTargetRepo || state?.contextRepo || "";
  const provider = state?.plannedProvider || state?.deployProvider || "azure";
  const plannedResources = state?.plannedResources || [];
  const graphBranch = state?.plannedBranch || state?.contextBranch || "main";
  // Default the Environment selector to the one last used for planning/deploying
  // this repo, so re-opening the tab (or refreshing after a plan) keeps the
  // same environment selected instead of falling back to the first option.
  const defaultEnvironment = state?.plannedEnvironment || state?.envName || "";
  // Same provenance rule as graphPage: open local files in the editor canvas
  // when the planned graph was resolved against the local workspace checkout.
  // Prefer the authoritative persisted flag; fall back to repo+branch matching.
  const localSource =
    typeof state?.plannedFromWorkspace === "boolean" ?
      state.plannedFromWorkspace
    : isWorkspaceSelection(state, targetRepo, graphBranch);

  const resourcesJson = JSON.stringify(plannedResources);

  if (plannedResources.length === 0) {
    return pageShell(
      "Planned Graph",
      `
${graphHeader("planned")}
<p class="rad-lede" id="planned-subtitle" style="margin:0 0 20px;">The planned application graph previews the infrastructure that will be provisioned for each component of your application if deployed to a given environment.<span id="planned-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Application</label>
    <select id="planned-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="planned-branch" class="rad-select" style="min-width:200px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Environment</label>
    <select id="planned-env" class="rad-select" style="min-width:180px;">
      <option value="">Loading environments...</option>
    </select>
  </div>
  <button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Loading…</button>
</div>
<div id="plan-status" class="status info">Generating the planned application graph…</div>
<div id="graph-container-wrapper"></div>
<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(graphBranch)}';
var CONTEXT_ENV = '${escapeHtml(defaultEnvironment)}';
var ENV_PROVIDERS = {};

function runPlan(isInitial) {
    var repo = CONTEXT_REPO;
    var branch = document.getElementById('planned-branch').value.trim();
    var env = document.getElementById('planned-env').value;
    var provider = ENV_PROVIDERS[env] || '${provider}';
    var statusEl0 = document.getElementById('plan-status');
    if (!repo || !branch) {
        if (statusEl0) { statusEl0.style.display=''; statusEl0.textContent='Select a branch to preview the planned deployment.'; statusEl0.className='status info'; }
        return;
    }
    if (!RADIUS_PLAN_HAS_ENV || !env) {
        if (statusEl0) { statusEl0.style.display=''; statusEl0.textContent='Create an environment to preview the planned deployment for this application.'; statusEl0.className='status info'; }
        var wrapper0 = document.getElementById('graph-container-wrapper');
        if (wrapper0) wrapper0.innerHTML = '';
        return;
    }
    if (statusEl0) statusEl0.style.display = 'none';
    var wrapper = document.getElementById('graph-container-wrapper');
    wrapper.innerHTML = '<div id="graph-container"></div>';
    var container = document.getElementById('graph-container');
    container.innerHTML = '<div id="progress-panel" style="padding:20px; max-width:500px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--rad-text);">Planning Deployment</span>' +
        '</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--rad-stroke);border-top-color:var(--rad-success);border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-success);margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--rad-text);font-weight:500}</style>';
    var stepsEl = document.getElementById('progress-steps');
    var shownSteps = 0;
    var pollInterval = setInterval(function() {
        fetch('/api/progress').then(function(r) { return r.json(); }).then(function(d) {
            var msgs = d.messages || [];
            for (var i = shownSteps; i < msgs.length; i++) {
                var prev = stepsEl.querySelector('.step-active');
                if (prev) prev.className = 'step-done';
                var div = document.createElement('div');
                div.className = 'step-active';
                div.textContent = msgs[i];
                stepsEl.appendChild(div);
            }
            shownSteps = msgs.length;
        }).catch(function() {});
    }, 800);
    fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch, provider: provider, environment: env}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            clearInterval(pollInterval);
            if (d.reload) {
                var prev = stepsEl.querySelector('.step-active');
                if (prev) prev.className = 'step-done';
                var doneDiv = document.createElement('div');
                doneDiv.className = 'step-done';
                doneDiv.textContent = 'Deployment plan ready!';
                stepsEl.appendChild(doneDiv);
                setTimeout(function() { window.location.reload(); }, 600);
            } else if (d.error) {
                clearInterval(pollInterval);
                container.innerHTML = '';
                if (statusEl0) { statusEl0.style.display = ''; statusEl0.textContent = 'Error: ' + d.error; statusEl0.className = 'status error'; }
            }
        })
        .catch(function() { clearInterval(pollInterval); });
}

// Auto-generate the planned graph as soon as sensible defaults settle, then
// re-generate it whenever the Application, Branch, or Environment selection
// changes so the graph always reflects what's currently selected.
radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH, CONTEXT_ENV).then(function() {
    runPlan(true);
});
['planned-app', 'planned-branch', 'planned-env'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() { radiusApplyPlanEnvState(RADIUS_PLAN_HAS_ENV); runPlan(false); });
});

document.getElementById('plan-btn').addEventListener('click', function() {
    if (this.dataset.mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
    radiusDeployPlannedApp(this, CONTEXT_REPO, ENV_PROVIDERS, '${provider}');
});
<\/script>
${graphHeaderClose()}`
    );
  }

  // Render the planned graph with real resources
  return pageShell(
    "Planned Graph",
    `
${graphHeader("planned")}
<p class="rad-lede" id="planned-subtitle" style="margin:0 0 20px;">The planned application graph previews the infrastructure that will be provisioned for each component of your application if deployed to a given environment.<span id="planned-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Application</label>
    <select id="planned-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="planned-branch" class="rad-select" style="min-width:200px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Environment</label>
    <select id="planned-env" class="rad-select" style="min-width:180px;">
      <option value="">Loading environments...</option>
    </select>
  </div>
  <button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Loading…</button>
</div>
<div id="graph-container"></div>

<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(graphBranch)}';
var CONTEXT_ENV = '${escapeHtml(defaultEnvironment)}';
var ENV_PROVIDERS = {};
var radiusPlannedSelectorsReady = radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH, CONTEXT_ENV);

// Re-generate the planned graph whenever the Application, Branch, or
// Environment selection changes, so the graph always reflects what's
// currently selected without requiring a separate "Re-Plan" click.
function runPlan() {
    var repo = CONTEXT_REPO;
    var branch = document.getElementById('planned-branch').value.trim() || CONTEXT_BRANCH;
    var env = document.getElementById('planned-env').value;
    var provider = ENV_PROVIDERS[env] || '${provider}';
    if (!repo) return;
    var container = document.getElementById('graph-container');
    if (!RADIUS_PLAN_HAS_ENV || !env) {
        container.innerHTML = '<div class="status info">Create an environment to preview the planned deployment for this application.</div>';
        return;
    }
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--rad-text-tertiary);gap:10px;"><div class="spinner" style="width:20px;height:20px;border:3px solid var(--rad-stroke);border-top-color:var(--rad-primary);border-radius:50%;animation:spin 0.8s linear infinite;"></div><span>Planning deployment...</span></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch, provider: provider, environment: env}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.reload) { window.location.reload(); }
            else if (d.needsAppBicep) { container.innerHTML = '<div class="status info">Copilot is generating .radius/app.bicep with the Radius app-bicep skill\u2026 the planned graph will appear once it is saved.</div>'; }
            else if (d.error) { container.innerHTML = '<div class="status error"></div>'; container.firstChild.textContent = 'Error: ' + d.error; }
        });
}
['planned-app', 'planned-branch', 'planned-env'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() { radiusApplyPlanEnvState(RADIUS_PLAN_HAS_ENV); runPlan(); });
});

document.getElementById('plan-btn').addEventListener('click', function() {
    if (this.dataset.mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
    radiusDeployPlannedApp(this, CONTEXT_REPO, ENV_PROVIDERS, '${provider}');
});

var resources = ${resourcesJson};
radiusRenderGraph('graph-container', resources, {
    repoUrl: 'https://github.com/' + CONTEXT_REPO,
    branch: CONTEXT_BRANCH,
    localSource: ${localSource ? "true" : "false"},
    plannedMode: true
});
// The graph above reflects the last-persisted plan. If it turns out the repo
// no longer has (or never had) a Radius-managed environment, replace it with
// the "create an environment first" message rather than leaving a stale or
// misleading plan on screen.
radiusPlannedSelectorsReady.then(function() {
    if (!RADIUS_PLAN_HAS_ENV) {
        var container0 = document.getElementById('graph-container');
        if (container0) container0.innerHTML = '<div class="status info">Create an environment to preview the planned deployment for this application.</div>';
    }
});
<\/script>
${graphHeaderClose()}`
  );
}

// Shared by both render paths of the Diff pane (empty selection and rendered
// graph) so the two copies of the markup cannot drift apart.
// Delete confirmation dialog (Figma 3-step type-to-confirm flow), shared by
// every page that can delete a deployment. Tearing down live infrastructure is
// irreversible, so a page must never ship a lighter-weight confirmation of its
// own — that would quietly lower the bar for the whole product. The step
// behaviour lives in radiusCreateDeleteDeploymentDialog (client.ts).
const DELETE_DEPLOYMENT_DIALOG_HTML = `<div id="deploy-delete-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:50; align-items:center; justify-content:center;">
  <div class="rad-ddlg" role="dialog" aria-modal="true" aria-labelledby="deploy-delete-title">
    <div class="rad-ddlg__header">
      <span class="rad-ddlg__title" id="deploy-delete-title">Delete Deployment</span>
      <button type="button" class="rad-ddlg__close" id="deploy-delete-close" aria-label="Close">✕</button>
    </div>
    <div class="rad-ddlg__info">
      <span class="rad-ddlg__info-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg></span>
      <span class="rad-ddlg__app" id="deploy-delete-app"></span>
      <span class="rad-ddlg__env">Environment: <strong id="deploy-delete-env"></strong></span>
    </div>
    <div class="rad-ddlg__content" id="deploy-delete-body"></div>
  </div>
</div>`;

const GRAPH_DIFF_SUBTITLE = `<p class="rad-lede" id="graph-diff-subtitle" style="margin:0 0 20px;">The application graph diff compares the application model between branches, allowing you to visualize changes in your application to reveal added, removed, or modified components. Use it to review the impact of a pull request before it is merged.</p>`;

export function graphDiffPage(state: CanvasState = {}): string {
  const resources = state?.diffResources || [];
  const baseBranch = state?.diffBase || "main";
  const headBranch = state?.diffHead || "";
  const branches = state?.branches || [];
  const branchShas = state?.branchShas || {};

  const branchOptionsBase = branches
    .map((b) => {
      const sha = branchShas[b] ? ` (${branchShas[b].slice(0, 7)})` : "";
      return `<option value="${b}"${
        b === baseBranch ? " selected" : ""
      }>${b}${sha}</option>`;
    })
    .join("");
  const branchOptionsHead = branches
    .map((b) => {
      const sha = branchShas[b] ? ` (${branchShas[b].slice(0, 7)})` : "";
      return `<option value="${b}"${
        b === headBranch ? " selected" : ""
      }>${b}${sha}</option>`;
    })
    .join("");

  if (resources.length === 0) {
    const targetRepo = state?.diffTargetRepo || state?.contextRepo || "";
    return pageShell(
      "Graph Diff",
      `
${graphHeader("graph-diff")}
${GRAPH_DIFF_SUBTITLE}
<input type="hidden" id="diff-repo-select" value="${escapeHtml(targetRepo)}">
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);">Application</label>
    <select id="diff-app" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:200px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);">Base</label>
    <select id="base-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <span aria-label="from base branch to head branch" style="font-size:18px; color:var(--rad-text-tertiary);">→</span>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);">Head</label>
    <select id="head-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
</div>
<div id="diff-status" class="status ${state?.diffError ? "error" : "info"}">${
        state?.diffError ? escapeHtml(state.diffError) : "Loading branches…"
      }</div>
<script>
var STATE_BASE = '${escapeHtml(baseBranch)}';
var STATE_HEAD = '${escapeHtml(headBranch)}';
var CONTEXT_REPO = document.getElementById('diff-repo-select').value;

radiusPopulateApplications(CONTEXT_REPO, 'diff-app');
radiusPopulateDiffBranches(CONTEXT_REPO, STATE_BASE, STATE_HEAD);

function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}

// Auto-load the diff graph when branch selection changes, but debounce
// to prevent rapid-fire requests if the user is just browsing the list.
var diffTimeout = null;
function queueDiff() {
    if (diffTimeout) clearTimeout(diffTimeout);
    diffTimeout = setTimeout(runDiff, 500);
}

function runDiff() {
    var base = document.getElementById('base-branch').value;
    var head = document.getElementById('head-branch').value;
    var repo = document.getElementById('diff-repo-select').value;
    if (!repo || !base || !head) return;
    var statusEl = document.getElementById('diff-status');
    statusEl.className = 'status info';
    statusEl.innerHTML = 'Comparing <strong>' + escapeHtmlClient(base) + '</strong> &rarr; <strong>' + escapeHtmlClient(head) + '</strong>&hellip;';
    fetch('/api/diff-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({base: base, head: head, repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.needsAppBicep) { statusEl.innerHTML = 'Copilot is generating <strong>.radius/app.bicep</strong> with the Radius app-bicep skill&hellip; the diff will appear once it is saved.'; statusEl.className = 'status info'; }
            else if (d.error) { statusEl.innerHTML = 'Error computing diff: <strong>' + escapeHtmlClient(d.error) + '</strong>. Please ensure both branches exist and contain a valid <code>.radius/app.bicep</code>.'; statusEl.className = 'status error'; }
            else if (d.reload) { window.location.reload(); }
            else if (d.message) { statusEl.textContent = d.message; }
        })
        .catch(function() { statusEl.innerHTML = 'Failed to compute diff. Please verify network connectivity and that <code>.radius/app.bicep</code> is valid on both branches.'; statusEl.className = 'status error'; });
}

document.getElementById('head-branch').addEventListener('change', queueDiff);
document.getElementById('base-branch').addEventListener('change', function() {
    if (document.getElementById('head-branch').value) queueDiff();
});
<\/script>
${graphHeaderClose()}`
    );
  }
  const resourcesJson = JSON.stringify(resources);
  const added = resources.filter((r) => r.diffStatus === "added").length;
  const removed = resources.filter((r) => r.diffStatus === "removed").length;
  const modified = resources.filter((r) => r.diffStatus === "modified").length;
  const unchanged = resources.filter(
    (r) => r.diffStatus === "unchanged"
  ).length;
  const targetRepo = state?.diffTargetRepo || state?.contextRepo || "";
  return pageShell(
    "Graph Diff",
    `
${graphHeader("graph-diff")}
${GRAPH_DIFF_SUBTITLE}
<input type="hidden" id="diff-repo-select" value="${escapeHtml(targetRepo)}">
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);">Application</label>
    <select id="diff-app" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:200px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);">Base</label>
    <select id="base-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      ${branchOptionsBase}
    </select>
  </div>
  <span aria-label="from base branch to head branch" style="font-size:18px; color:var(--rad-text-tertiary);">→</span>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);">Head</label>
    <select id="head-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      ${branchOptionsHead}
    </select>
  </div>
</div>
<div id="diff-status" class="status ${
      state?.diffError ? "error" : "info"
    }" style="${state?.diffError ? "" : "display:none;"}">${
      state?.diffError ? escapeHtml(state.diffError) : ""
    }</div>
<div id="graph-container"></div>
<div style="margin-top:12px; font-size:13px;">
  <strong>Changes:</strong>
  <span style="color:var(--rad-success)">+${added} added</span>,
  <span style="color:var(--rad-danger)">-${removed} removed</span>,
  <span style="color:var(--rad-warning)">~${modified} modified</span>,
  ${unchanged} unchanged
</div>
${
  added === 0 && removed === 0 && modified === 0 ?
    `<div style="margin-top:12px; padding:10px 14px; background:var(--rad-bg-subtle); border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; color:var(--rad-text-tertiary);">✅ No application graph changes detected in this PR. The application model is identical between <strong>${escapeHtml(
      baseBranch
    )}</strong> and <strong>${escapeHtml(headBranch)}</strong>.</div>`
  : ""
}

<script>
var resources = ${resourcesJson};
var DIFF_REPO_URL = 'https://github.com/' + document.getElementById('diff-repo-select').value.trim();
radiusRenderGraph('graph-container', resources, {
    diffMode: true,
    repoUrl: DIFF_REPO_URL,
    branch: '${escapeHtml(headBranch)}',
    baseBranch: '${escapeHtml(baseBranch)}'
});

var DIFF_BASE = '${escapeHtml(baseBranch)}';
var DIFF_HEAD = '${escapeHtml(headBranch)}';

radiusPopulateApplications(document.getElementById('diff-repo-select').value, 'diff-app');

// Refresh the branch lists from GitHub on load (so newly-pushed branches
// appear) while preserving the currently-compared base/head selection. Do not
// auto-compare — the diff is already rendered.
radiusPopulateDiffBranches(document.getElementById('diff-repo-select').value, DIFF_BASE || 'main', DIFF_HEAD, false);

function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}

// Auto-load the diff graph when branch selection changes, but debounce
// to prevent rapid-fire requests if the user is just browsing the list.
var diffTimeout = null;
function queueDiff() {
    if (diffTimeout) clearTimeout(diffTimeout);
    diffTimeout = setTimeout(runDiff, 500);
}

function runDiff() {
    var base = document.getElementById('base-branch').value;
    var head = document.getElementById('head-branch').value;
    var repo = document.getElementById('diff-repo-select').value;
    if (!repo || !base || !head) return;
    var statusEl = document.getElementById('diff-status');
    statusEl.style.display = '';
    statusEl.className = 'status info';
    statusEl.innerHTML = 'Comparing <strong>' + escapeHtmlClient(base) + '</strong> &rarr; <strong>' + escapeHtmlClient(head) + '</strong>&hellip;';
    fetch('/api/diff-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({base: base, head: head, repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.needsAppBicep) { statusEl.innerHTML = 'Copilot is generating <strong>.radius/app.bicep</strong> with the Radius app-bicep skill&hellip; the diff will appear once it is saved.'; statusEl.className = 'status info'; }
            else if (d.error) { statusEl.innerHTML = 'Error computing diff: <strong>' + escapeHtmlClient(d.error) + '</strong>. Please ensure both branches exist and contain a valid <code>.radius/app.bicep</code>.'; statusEl.className = 'status error'; }
            else if (d.reload) { window.location.reload(); }
            else if (d.message) { statusEl.textContent = d.message; }
        })
        .catch(function() { statusEl.innerHTML = 'Failed to compute diff. Please verify network connectivity and that <code>.radius/app.bicep</code> is valid on both branches.'; statusEl.className = 'status error'; });
}

document.getElementById('head-branch').addEventListener('change', queueDiff);
document.getElementById('base-branch').addEventListener('change', function() {
    if (document.getElementById('head-branch').value) queueDiff();
});
<\/script>
${graphHeaderClose()}`
  );
}

export function deployedGraphPage(state: CanvasState = {}): string {
  const targetRepo =
    state?.contextRepo ||
    state?.deployingRepo ||
    state?.plannedRepo ||
    state?.graphTargetRepo ||
    "";
  // Branch the "Deploy Application" mode dispatches against. The Deployed pane
  // has no branch selector (it shows what's already running), so fall back to
  // the session/worktree branch the rest of the canvas is pinned to.
  const deployBranch =
    state?.contextBranch ||
    state?.plannedBranch ||
    state?.graphBranch ||
    "main";
  const deployProvider =
    state?.plannedProvider || state?.deployProvider || "azure";
  return pageShell(
    "Deployed Graph",
    `
${graphHeader("deployed")}
<p class="rad-lede" id="deployed-subtitle" style="margin:0 0 20px;">The deployed application graph depicts the selected application as it is currently deployed and running in a given environment.<span id="deployed-subtitle-hint"></span></p>
<div class="rad-deployed-controls">
  <div class="rad-field">
    <label for="deployed-app-select">Application:</label>
    <div class="rad-select-wrap"><select id="deployed-app-select"><option value="">Loading…</option></select></div>
  </div>
  <div class="rad-field">
    <label for="deployed-env-select">Environment:</label>
    <div class="rad-select-wrap"><select id="deployed-env-select"><option value="">Loading…</option></select></div>
  </div>
  <button id="deployed-delete-btn" class="rad-btn rad-btn--danger-outline" style="margin:0;" disabled>Delete Deployment</button>
</div>

<div id="deployed-inline-status" style="display:none; margin:0 0 14px; padding:10px 12px; border-radius:8px; font-size:13px;"></div>

<div class="rad-card" style="margin:0;">
  <div id="deployed-graph-label" style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:12px; line-height:1.5;"></div>
  <div id="deployed-status" class="status info">Loading deployed application graph…</div>
  <div id="graph-container"></div>
</div>

<div id="deployed-log-section" class="rad-card" style="margin:16px 0 0; display:none;">
  <div style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:10px;">Deployment Logs</div>
  <div id="deployed-log-output" style="background:var(--rad-code-bg); color:var(--rad-code-text); border:1px solid var(--rad-stroke); font-family:var(--rad-mono); font-size:12px; padding:12px; border-radius:6px; max-height:280px; overflow-y:auto; white-space:pre-wrap; line-height:1.6;"></div>
</div>

<!-- Delete confirmation: the same 3-step type-to-confirm dialog the Deployments
     tab uses, so deleting from the graph is gated exactly as heavily. -->
${DELETE_DEPLOYMENT_DIALOG_HTML}

<!-- Deleting (transition) modal -->
<div id="deployed-deleting-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:60; align-items:center; justify-content:center;">
  <div class="rad-card" style="max-width:520px; width:90%; margin:0; display:flex; align-items:center; gap:18px;">
    <div class="rad-spinner-lg" aria-hidden="true"></div>
    <div>
      <div style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:4px;">Deleting Deployment…</div>
      <div id="deployed-deleting-text" style="font-size:13px; color:var(--rad-text-secondary);"></div>
    </div>
  </div>
</div>

<style>
  .rad-deployed-controls { display:flex; align-items:flex-end; gap:20px; flex-wrap:wrap; margin:8px 0 16px; }
  .rad-deployed-controls .rad-field label { font-size:15px; font-weight:600; color:var(--rad-text); }
  /* Keep the adaptive primary button baseline-aligned with the selects it sits
     beside, rather than stretching to the row's full height. */
  .rad-deployed-controls .rad-btn { align-self:flex-end; flex:0 0 auto; }
</style>
<script>
var CONTEXT_REPO = ${JSON.stringify(targetRepo)};
var CONTEXT_BRANCH = ${JSON.stringify(deployBranch)};
var FALLBACK_PROVIDER = ${JSON.stringify(deployProvider)};
var ENV_PROVIDERS = {};

function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}

(function() {
    var params = new URLSearchParams(window.location.search);
    var wantEnv = params.get('environment') || '';
    var wantApp = params.get('application') || '';

    var appSelect = document.getElementById('deployed-app-select');
    var envSelect = document.getElementById('deployed-env-select');
    var deleteBtn = document.getElementById('deployed-delete-btn');
    var statusEl = document.getElementById('deployed-status');
    var labelEl = document.getElementById('deployed-graph-label');
    var container = document.getElementById('graph-container');
    var inlineStatus = document.getElementById('deployed-inline-status');
    var pollTimer = null;

    // Adaptive primary-button state. HAS_ENVS gates "Create Environment";
    // DEPLOYMENTS_BY_ENV (env name → status from /api/list-deployments) decides
    // between "Deploy Application" and "Delete Deployment" for the selection.
    var HAS_ENVS = false;
    var DEPLOYMENTS_BY_ENV = {};
    // Set when the deployment listing could not be read, so the button can be
    // held disabled rather than acting on state we cannot confirm.
    var DEPLOYMENT_STATES_STALE = false;

    // A deployment "exists" for the selection when the environment has any
    // row at all, including a failed one: a failed deploy can leave partially
    // provisioned infrastructure behind, so the user still needs "Delete
    // Deployment" to clean it up.
    function deploymentExists(app, env) {
        if (!CONTEXT_REPO || !app || !env) return false;
        return !!DEPLOYMENTS_BY_ENV[env];
    }

    // The selected environment's deployment status, or '' when nothing is
    // deployed there. "deleting" means a delete run is still in flight.
    function deploymentStatus(app, env) {
        if (!deploymentExists(app, env)) return '';
        return DEPLOYMENTS_BY_ENV[env] || '';
    }

    // --- Deployment log streaming (shown under the graph while a deploy runs) ---
    var logSection = document.getElementById('deployed-log-section');
    var logOutput = document.getElementById('deployed-log-output');
    var logTimer = null;
    var LOG_TOTAL = 0;
    var logStreamStarted = false;

    function stopLogStream() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

    function pollLogs() {
        fetch('/api/deploy-status?since=' + LOG_TOTAL).then(function(r) { return r.json(); }).then(function(d) {
            if (d.logsNew && d.logsNew.length) {
                for (var i = 0; i < d.logsNew.length; i++) { logOutput.textContent += d.logsNew[i] + '\\n'; }
                logOutput.scrollTop = logOutput.scrollHeight;
            }
            if (typeof d.logTotal === 'number') { LOG_TOTAL = d.logTotal; }
            if (d.status === 'complete' || d.status === 'success' || d.status === 'failed') { stopLogStream(); }
        }).catch(function() {});
    }

    function startLogStream() {
        if (logStreamStarted) return;
        logStreamStarted = true;
        logSection.style.display = 'block';
        // Pull the full buffer once (since=0), then stream incrementally.
        fetch('/api/deploy-status?since=0').then(function(r) { return r.json(); }).then(function(d) {
            var lines = (d && d.logs) || (d && d.logsNew) || [];
            for (var i = 0; i < lines.length; i++) { logOutput.textContent += lines[i] + '\\n'; }
            logOutput.scrollTop = logOutput.scrollHeight;
            if (typeof d.logTotal === 'number') { LOG_TOTAL = d.logTotal; }
            else { LOG_TOTAL = lines.length; }
            if (d && (d.status === 'complete' || d.status === 'success' || d.status === 'failed')) return;
            logTimer = setInterval(pollLogs, 1500);
        }).catch(function() {});
    }

    function showInline(kind, msg) {
        inlineStatus.style.display = 'block';
        inlineStatus.textContent = msg;
        if (kind === 'error') { inlineStatus.style.background = 'var(--rad-danger-bg)'; inlineStatus.style.color = 'var(--rad-text)'; inlineStatus.style.border = '1px solid var(--rad-danger)'; }
        else { inlineStatus.style.background = 'var(--rad-info-bg)'; inlineStatus.style.color = 'var(--rad-text)'; inlineStatus.style.border = '1px solid var(--rad-info)'; }
    }

    function refreshControls() {
        var app = appSelect.value, env = envSelect.value;
        radiusApplyDeployedEnvState(HAS_ENVS, deploymentExists(app, env), deploymentStatus(app, env), DEPLOYMENT_STATES_STALE);
        labelEl.innerHTML = (app && env)
            ? 'Application: <strong>' + escapeHtmlClient(app) + '</strong><br>Environment: <strong>' + escapeHtmlClient(env) + '</strong>'
            : '';
        // Both a delete in flight and an unreadable listing are transient, and
        // both leave the button disabled — so poll until they resolve, or the
        // button would stay stuck until a manual reload.
        scheduleStatePoll(deploymentStatus(app, env) === 'deleting' || DEPLOYMENT_STATES_STALE);
    }

    // Refresh the deployment listing while a delete runs, or while the listing
    // is unreadable, so the button recovers on its own once real state arrives.
    // Bounded so a stuck delete or a persistent outage never polls forever; on
    // timeout the real status is whatever the listing last reported.
    var statePollTimer = null;
    var statePollTries = 0;
    function scheduleStatePoll(active) {
        if (!active) {
            if (statePollTimer) { clearTimeout(statePollTimer); statePollTimer = null; }
            statePollTries = 0;
            return;
        }
        if (statePollTimer || statePollTries > 45) return; // ~3 min at 4s
        statePollTimer = setTimeout(function() {
            statePollTimer = null;
            statePollTries++;
            loadDeploymentStates().then(refreshControls);
        }, 4000);
    }

    function showNothing(msg) {
        if (statusEl) { statusEl.style.display = 'none'; }
        container.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; min-height:240px; color:var(--rad-text-tertiary,#656d76); font-size:14px; border:1px dashed var(--rad-stroke,#d1d9e0); border-radius:6px;">' + (msg || 'Nothing deployed yet') + '</div>';
    }

    function renderGraph(resources, showDeployStatus) {
        if (statusEl) { statusEl.style.display = 'none'; }
        radiusRenderGraph('graph-container', resources, {
            repoUrl: 'https://github.com/' + CONTEXT_REPO,
            branch: 'main',
            showLegend: true,
            deployedMode: !showDeployStatus,
            deployMode: !!showDeployStatus
        });
    }

    function loadGraph() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (!CONTEXT_REPO) { showNothing('Nothing deployed yet'); return; }
        if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Loading deployed application graph…'; }
        // Prefer a live/in-progress deployment so the graph fills in as it deploys.
        fetch('/api/deploy-status').then(function(r) { return r.json(); }).then(function(s) {
            var liveRes = (s && s.resources) || [];
            var st = s && s.status;
            // Stream deployment logs under the graph whenever a deploy is running
            // or has produced log output.
            if (st === 'in_progress' || st === 'success' || st === 'complete' || st === 'failed' || (s && s.logTotal)) {
                startLogStream();
            }
            if (liveRes.length && (st === 'in_progress' || st === 'success' || st === 'failed')) {
                renderGraph(liveRes, true);
                if (st === 'in_progress') { pollTimer = setTimeout(loadGraph, 3000); }
                return;
            }
            // Fall back to the terminal deployed graph from the status branch.
            fetch('/api/deployed-graph?repo=' + encodeURIComponent(CONTEXT_REPO)).then(function(r) { return r.json(); }).then(function(d) {
                var resources = (d && d.resources) || [];
                if (!resources.length) { showNothing('Nothing deployed yet'); return; }
                renderGraph(resources, false);
            }).catch(function() { showNothing('Nothing deployed yet'); });
        }).catch(function() { showNothing('Nothing deployed yet'); });
    }

    function loadApplications() {
        return fetch('/api/list-applications?repo=' + encodeURIComponent(CONTEXT_REPO))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var apps = (d && d.applications) || [];
                if (!apps.length) { appSelect.innerHTML = '<option value="">No applications</option>'; return; }
                appSelect.innerHTML = apps.map(function(a) { return '<option value="' + escapeHtmlClient(a.name) + '">' + escapeHtmlClient(a.name) + '</option>'; }).join('');
                if (wantApp) { appSelect.value = wantApp; }
            })
            .catch(function() { appSelect.innerHTML = '<option value="">Could not load</option>'; });
    }

    function loadEnvironments() {
        return fetch('/api/list-environments?repo=' + encodeURIComponent(CONTEXT_REPO))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var envs = (d && d.environments) || [];
                if (!envs.length) { HAS_ENVS = false; envSelect.innerHTML = '<option value="">No environments</option>'; return; }
                HAS_ENVS = true;
                envs.forEach(function(e) { ENV_PROVIDERS[e.name] = e.provider || FALLBACK_PROVIDER; });
                envSelect.innerHTML = envs.map(function(e) { return '<option value="' + escapeHtmlClient(e.name) + '">' + escapeHtmlClient(e.name) + '</option>'; }).join('');
                if (wantEnv) { envSelect.value = wantEnv; }
            })
            .catch(function() { HAS_ENVS = false; envSelect.innerHTML = '<option value="">Could not load</option>'; });
    }

    // Resolve which environments currently hold a deployment, so the primary
    // button can choose between deploying and deleting for the selection.
    //
    // /api/list-deployments answers a transient GitHub failure with HTTP 200 and
    // { deployments: [], error } rather than a rejection. Treating that as "no
    // deployments" would clear an environment that actually has a deploy or
    // delete in flight, flipping the button back to "Deploy Application" and
    // letting the user start a conflicting operation. So keep the last-known
    // map and flag it stale; refreshControls disables the button until a
    // subsequent poll reads real state. The Deployments tab handles the same
    // shape the same way (see its load-error row).
    function loadDeploymentStates() {
        return fetch('/api/list-deployments?repo=' + encodeURIComponent(CONTEXT_REPO))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d && d.error) { DEPLOYMENT_STATES_STALE = true; return; }
                DEPLOYMENT_STATES_STALE = false;
                DEPLOYMENTS_BY_ENV = {};
                ((d && d.deployments) || []).forEach(function(dep) {
                    if (dep && dep.environment) DEPLOYMENTS_BY_ENV[dep.environment] = dep.status || 'unknown';
                });
            })
            .catch(function() { DEPLOYMENT_STATES_STALE = true; });
    }

    appSelect.addEventListener('change', function() { refreshControls(); loadGraph(); });
    envSelect.addEventListener('change', function() { refreshControls(); loadGraph(); });

    // --- Delete deployment (shared 3-step type-to-confirm dialog) ---
    var deleteDialog = radiusCreateDeleteDeploymentDialog({ onConfirm: runDelete });

    deleteBtn.addEventListener('click', function() {
        // The primary button is adaptive — route by the mode the current
        // environment/deployment state selected.
        var mode = this.dataset.mode;
        if (mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
        if (mode === 'deploy') {
            radiusDeployDeployedApp(this, CONTEXT_REPO, CONTEXT_BRANCH, ENV_PROVIDERS, FALLBACK_PROVIDER);
            return;
        }
        var app = appSelect.value, env = envSelect.value;
        if (!app || !env || !deleteDialog) return;
        deleteDialog.open(app, env);
    });

    // Unlike the Deployments table, this page has no row to annotate with a
    // "Deleting…" status, so it shows a transition modal and then hands the user
    // to the Deployments tab to watch the workflow run.
    function runDelete(app, env) {
        if (!app || !env) return;
        document.getElementById('deployed-deleting-text').innerHTML = 'Deleting application <strong>' + escapeHtmlClient(app) + '</strong> from <strong>' + escapeHtmlClient(env) + '</strong> with <code>rad app delete</code>. This may take a few minutes.';
        document.getElementById('deployed-deleting-modal').style.display = 'flex';
        fetch('/api/delete-deployment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CONTEXT_REPO, environment: env, application: app }) })
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
            .then(function(res) {
                document.getElementById('deployed-deleting-modal').style.display = 'none';
                if (!res.ok) { showInline('error', (res.d && res.d.error) || 'Could not start the delete workflow.'); return; }
                window.location.href = '/?page=deploying';
            })
            .catch(function() {
                document.getElementById('deployed-deleting-modal').style.display = 'none';
                showInline('error', 'Could not delete the deployment. Please try again.');
            });
    }

    Promise.all([loadApplications(), loadEnvironments(), loadDeploymentStates()]).then(function() {
        refreshControls();
        loadGraph();
    });
})();
<\/script>
${graphHeaderClose()}`
  );
}

export function environmentPage(state: CanvasState = {}): string {
  const envName = state?.envName || "dev";
  // Default to the active session branch. A worktree session's branch may
  // exist only locally (branchShas[b] === 'worktree' means it isn't pushed to
  // GitHub yet), but we no longer fall back to 'main' for that case: the deploy
  // path fails fast with a clear "push this branch" message when the ref is
  // absent on GitHub, so silently substituting 'main' would only deploy the
  // wrong (or empty) branch. The branch stays user-overridable in the UI.
  const deployContextBranch = state?.contextBranch || "main";
  const deployDefaultBranch = deployContextBranch;

  // If deployment result exists, show it
  if (state?.deployResult) {
    const r = state.deployResult;
    return pageShell(
      r.error ? "Deployment Failed" : "Deployment Initiated",
      `
<h1>${r.error ? "⚠ Deployment Failed" : "🚀 Deployment Initiated"}</h1>
<div class="status ${r.error ? "error" : "success"}">${escapeHtml(
        r.error || r.message
      )}</div>
${
  r.workflowUrl ?
    `<p style="margin-top:12px;"><a href="${escapeHtml(
      r.workflowUrl
    )}" target="_blank" style="color:var(--rad-brand, #da4c2a);">View GitHub Actions workflow run →</a></p>`
  : ""
}
${
  r.workflow ?
    `<h2>Generated Workflow</h2><pre style="max-height:400px; overflow:auto;">${escapeHtml(
      r.workflow
    )}</pre>`
  : ""
}
<button id="back-btn" style="margin-top:16px; padding:8px 16px; background:var(--rad-neutral-bg); color:var(--rad-neutral-text); border:1px solid var(--rad-neutral-border); border-radius:6px; font-size:13px; cursor:pointer;">← Back to Deploy</button>
<script>
document.getElementById('back-btn').addEventListener('click', function() {
    fetch('/api/deploy-reset', { method: 'POST' }).then(function() { window.location.reload(); });
});
<\/script>`
    );
  }

  const ctxRepo = state?.targetRepo || state?.contextRepo || "";
  const ctxBranch =
    state?.contextBranch ||
    state?.plannedBranch ||
    state?.graphBranch ||
    "main";
  const activeSubtab =
    state?.activeSubtab === "credentials" ? "credentials" : "environments";

  return pageShell(
    "Environments",
    `
<div class="rad-heading">
  <h1>${radiusMark(26)}<span>Environments</span></h1>
</div>
<nav class="rad-subtabs" id="env-subtabs">
  <a href="/?page=environment" data-subtab="environments" class="rad-subtab${
    activeSubtab === "environments" ? " rad-subtab--active" : ""
  }">Environments</a>
  <a href="/?page=credentials" data-subtab="credentials" class="rad-subtab${
    activeSubtab === "credentials" ? " rad-subtab--active" : ""
  }">Credentials</a>
</nav>

<!-- ══════════════ ENVIRONMENTS SUBTAB ══════════════ -->
<section id="pane-environments" style="${
      activeSubtab === "environments" ? "" : "display:none;"
    }">
<p class="rad-lede" style="margin-bottom:20px;">An Environment defines where applications are deployed, i.e. a landing zone for applications. Deploy your application into an environment to run it with a specific infrastructure configuration.</p>

<!-- Landing: New Environment button + environments table -->
<div id="env-landing">
  <div id="env-success-banner" role="status" style="display:none;">
    <span class="env-success-banner__check" aria-hidden="true">✓</span>
    <span id="env-success-banner-text" class="env-success-banner__text"></span>
    <button type="button" id="env-success-banner-close" class="env-success-banner__close" aria-label="Dismiss">×</button>
  </div>
  <div id="env-error-banner" role="alert" style="display:none;">
    <span class="env-error-banner__icon" aria-hidden="true">⚠</span>
    <span id="env-error-banner-text" class="env-error-banner__text"></span>
    <button type="button" id="env-error-banner-close" class="env-error-banner__close" aria-label="Dismiss">×</button>
  </div>
  <div id="env-warning-banner" role="status" style="display:none;">
    <span class="env-warning-banner__icon" aria-hidden="true">⚠</span>
    <span id="env-warning-banner-text" class="env-warning-banner__text"></span>
    <button type="button" id="env-warning-banner-close" class="env-warning-banner__close" aria-label="Dismiss">×</button>
  </div>
  <!-- "Ready, action required": the pull-request path, which is neither success
       nor failure. Setup completed, but the workflows landed on a branch, so
       credential verification cannot run until the PR merges. -->
  <div id="env-action-banner" role="status" style="display:none;">
    <span class="env-action-banner__icon" aria-hidden="true">→</span>
    <span id="env-action-banner-text" class="env-action-banner__text"></span>
    <button type="button" id="env-action-banner-close" class="env-action-banner__close" aria-label="Dismiss">×</button>
  </div>
  <!-- Progress panel. This replaced a full-screen blocking overlay that showed a
       spinner and the words "This may take a few moments" for up to eight
       minutes. It is inline and non-blocking on purpose: the operation runs for
       minutes, and trapping the user behind a modal for that long is the one
       thing every comparable product avoids. It lives on the environments
       landing, above the table the operation will eventually add a row to.

       No percentage. The step count varies with branching — credentials are
       skipped when they already exist, verification never runs on the pull
       request path — so any percentage would be derived from an assumed shape.
       Stage, current step and elapsed time are honest and sufficient. -->
  <div id="env-progress-panel" style="display:none;" role="region" aria-label="Environment setup progress" tabindex="-1">
    <div class="env-progress__head">
      <div class="env-progress__spinner" aria-hidden="true"></div>
      <div class="env-progress__headtext">
        <div id="env-progress-title" class="env-progress__title"></div>
        <div id="env-progress-activity" class="env-progress__activity" role="status" aria-live="polite"></div>
      </div>
      <div id="env-progress-elapsed" class="env-progress__elapsed" aria-label="Elapsed time"></div>
    </div>
    <ol id="env-progress-stages" class="env-progress__stages"></ol>
    <div id="env-progress-failure" class="env-progress__failure" style="display:none;" role="alert">
      <div class="env-progress__failure-title">Setup didn’t finish</div>
      <div id="env-progress-failure-message" class="env-progress__failure-copy"></div>
      <div id="env-progress-cleanup-status" class="env-progress__failure-copy"></div>
      <div id="env-progress-retry" class="env-progress__failure-copy"></div>
      <div id="env-progress-cleanup-removed-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Removed resources</div>
        <ul id="env-progress-cleanup-removed" class="env-progress__failure-list"></ul>
      </div>
      <div id="env-progress-cleanup-retained-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Retained reusable artifacts</div>
        <ul id="env-progress-cleanup-retained" class="env-progress__failure-list"></ul>
      </div>
      <div id="env-progress-cleanup-warnings-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Cleanup warnings / manual guidance</div>
        <ul id="env-progress-cleanup-warnings" class="env-progress__failure-list"></ul>
      </div>
    </div>
    <details id="env-progress-details" class="env-progress__details">
      <summary>Show details</summary>
      <ol id="env-progress-steps" class="env-progress__steps"></ol>
    </details>
    <div id="env-progress-actions" class="env-progress__actions" style="display:none;">
      <a id="env-progress-resume" class="rad-btn rad-btn--secondary" href="#">View planned graph</a>
      <button type="button" id="env-progress-dismiss" class="rad-btn rad-btn--secondary" aria-label="Dismiss completed environment setup progress">Dismiss</button>
    </div>
  </div>
  <button id="new-env-btn" class="rad-btn rad-btn--primary" style="margin:0 0 16px;">New Environment</button>
  <div class="rad-table-wrap">
    <table class="rad-table">
      <thead><tr><th>Environment</th><th>Status</th><th>Provider</th><th>Credentials</th><th>Actions</th></tr></thead>
      <tbody id="env-table-body">
        <tr><td colspan="5" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Create Environment form (revealed by New Environment / Deploy Apps / edit) -->
<div id="env-form" style="display:none;">
  <div class="rad-card">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <div class="rad-card__title" style="margin:0;">Create Environment</div>
      <button id="cancel-env-btn" type="button" class="rad-link" style="background:none; border:none; padding:0; margin:0; font-size:12px; font-weight:500; cursor:pointer;">← Back to environments</button>
    </div>
    <!-- 1 · Name this environment -->
    <div class="rad-section">
      <div class="rad-section__title">1 · Name this environment</div>
      <div class="rad-field" style="max-width:420px;">
        <label>Environment name</label>
        <input id="env-name-input" type="text" placeholder="e.g. prod, test, eastus-prod" value="${escapeHtml(
          envName
        )}" />
        <div class="rad-field__help">The deployment target you'll deploy apps into by name.</div>
      </div>
      <!-- Repository and branch are assumed from the current workspace. -->
      <input type="hidden" id="target-repo" value="${escapeHtml(ctxRepo)}" />
      <input type="hidden" id="deploy-branch-select" value="${escapeHtml(
        deployDefaultBranch || "main"
      )}" />
      <input type="hidden" id="az-client-id" value="" />
      <input type="hidden" id="env-selected-provider" value="" />
    </div>

    <!-- 2 · Connect GitHub to a cloud -->
    <div class="rad-section">
      <div class="rad-section__title">2 · Connect GitHub to a cloud</div>
      <div class="rad-section__desc">Radius wires a passwordless OIDC trust so GitHub Actions can deploy into this environment — no secrets stored in the repo.</div>

      <div class="rad-conn">
        <!-- GitHub side of the trust. The account combo is populated by
             loadGitHubIdentity() when the env form opens; it warns when the
             acting account differs from the one the app shows, or lacks the
             workflow scope needed to write the deploy workflow file. -->
        <div class="rad-conn__side">
          <div class="rad-conn__badge">
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            GitHub
          </div>
          <div class="rad-field" id="env-gh-identity-field" style="display:none;">
            <label>Account</label>
            <div class="rad-combo" id="env-gh-account-combo">
              <button type="button" class="rad-combo__button" id="env-gh-account-button" aria-haspopup="listbox" aria-expanded="false">
                <span class="rad-combo__value" id="env-gh-account-value">Detecting…</span>
                <span class="rad-combo__chevron" aria-hidden="true"></span>
              </button>
              <div class="rad-combo__menu" id="env-gh-account-menu" role="listbox" style="display:none;">
                <div class="rad-combo__options" id="env-gh-account-options"></div>
                <div class="rad-combo__empty" id="env-gh-account-empty" style="display:none;">No GitHub accounts detected.</div>
              </div>
            </div>
            <div class="rad-field__help" id="env-gh-account-note" style="margin-top:6px;">Choosing a different account runs <code>gh auth switch</code> which changes the active GitHub account for every terminal and tool on this machine, remaining changed even after Radius closes. Switch back anytime with <code>gh auth switch -u &lt;account&gt;</code>.</div>
            <div id="env-gh-identity-note" style="margin-top:6px; font-size:13px; display:none;"></div>
            <button type="button" id="env-gh-recheck" style="display:none; margin-top:6px; font-size:12px; padding:2px 10px; cursor:pointer;">Re-check</button>
          </div>
        </div>

        <div class="rad-conn__arrow" aria-hidden="true">→</div>

        <!-- Cloud side of the trust. The provider (Azure/AWS) comes from the
             selected credential profile; the profile detail below the combo
             reflects what the connection does and where deploys land. -->
        <div class="rad-conn__side">
          <div class="rad-conn__badge">
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 13a3.5 3.5 0 01-.36-6.98A4 4 0 0111.9 6.1 3 3 0 0111.5 13h-7z"/></svg>
            Cloud credentials
          </div>
          <div class="rad-field">
            <label>Credential profile</label>
            <div class="rad-combo" id="env-profile-combo">
              <button type="button" class="rad-combo__button" id="env-profile-button" aria-haspopup="listbox" aria-expanded="false">
                <span class="rad-combo__value" id="env-profile-value">Select a credential profile…</span>
                <span class="rad-combo__chevron" aria-hidden="true"></span>
              </button>
              <div class="rad-combo__menu" id="env-profile-menu" role="listbox" style="display:none;">
                <div class="rad-combo__options" id="env-profile-options"></div>
                <div class="rad-combo__empty" id="env-profile-empty" style="display:none;">No credential profiles yet.</div>
                <button type="button" class="rad-combo__action" id="env-create-profile-link">+ Create new profile</button>
              </div>
            </div>
            <!-- Holds the selected profile name; read by the create flow. -->
            <input type="hidden" id="env-profile-select" value="" />
            <div id="env-profile-status" style="margin-top:6px; font-size:13px; line-height:1.6; display:none;"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3 · Deploy identity -->
    <div class="rad-section" id="env-identity-section">
      <div class="rad-section__title">3 · Deploy identity</div>
      <div class="rad-section__desc">The Microsoft Entra app GitHub Actions signs in as — over OIDC, no stored secrets.</div>
      <div class="rad-field" id="env-identity-azure" style="max-width:560px;">
        <label>Azure app registration</label>
        <input id="az-app-name-input" type="text" autocomplete="off" spellcheck="false" placeholder="radius-deploy-owner-repo" value="radius-deploy-${escapeHtml(
          (ctxRepo || "").replace("/", "-")
        )}" data-default-name="radius-deploy-${escapeHtml(
          (ctxRepo || "").replace("/", "-")
        )}" />
        <input type="hidden" id="az-selected-app-id" value="" />
        <div class="rad-field__help">
          Created in your tenant, federated to <code>repo:${escapeHtml(
            ctxRepo
          )}</code>, and granted <strong>Contributor</strong> on the selected resource group below, plus <strong>Azure Kubernetes Service RBAC Cluster Admin</strong> on the target cluster (required for clusters using Azure RBAC for Kubernetes, the default for AKS Automatic). If one already exists, you may
         <a href="#" id="az-use-existing-link">use an existing application…</a>
        </div>
        <div id="az-selected-app-note" style="display:none; font-size:11px; color:var(--rad-info,#0969da); margin-top:4px;"></div>
        <a href="#" id="az-clear-pin-link" style="display:none; font-size:11px; margin-top:2px;">Use a per-repo identity instead</a>
      </div>
      <div class="rad-field__help" id="env-identity-aws" style="display:none;">GitHub Actions assumes the IAM role from your credential profile — no extra identity to configure here.</div>
    </div>

    <!-- 4 · Infrastructure -->
    <div class="rad-section" id="env-infra-section">
      <div class="rad-section__title">4 · Infrastructure</div>
      <div class="rad-section__desc">Configure the compute infrastructure for your environment.</div>

      <!-- Azure infra -->
      <div id="panel-azure">
        <div style="display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin:8px 0;">
          <div id="azure-discover-status" style="font-size:12px; color:var(--rad-text-tertiary);">Select a credential profile to discover resources.</div>
          <button type="button" id="azure-refresh-btn" class="rad-btn rad-btn--ghost" style="font-size:12px; padding:2px 10px;" disabled>↻ Refresh</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">
          <div class="rad-field">
            <label>Resource Group</label>
            <select id="azure-rg-select"><option value="" disabled selected>Loading…</option></select>
            <input id="azure-rg-custom" type="text" placeholder="Enter resource group" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label>Cluster</label>
            <select id="azure-cluster-select"><option value="" disabled selected>Loading…</option></select>
            <input id="azure-cluster-custom" type="text" placeholder="Enter cluster name" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label>Namespace</label>
            <select id="azure-namespace-select"><option value="" disabled selected>Loading…</option></select>
            <input id="azure-namespace-custom" type="text" placeholder="Enter namespace" style="display:none; margin-top:4px;" />
          </div>
        </div>
      </div>

      <!-- AWS infra -->
      <div id="panel-aws" style="display:none;">
        <div style="display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin:8px 0;">
          <div id="aws-discover-status" style="font-size:12px; color:var(--rad-text-tertiary);">Select a credential profile to discover resources.</div>
          <button type="button" id="aws-refresh-btn" class="rad-btn rad-btn--ghost" style="font-size:12px; padding:2px 10px;" disabled>↻ Refresh</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="rad-field">
            <label>EKS Cluster</label>
            <select id="aws-cluster-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-cluster-custom" type="text" placeholder="Enter cluster name" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label>Namespace</label>
            <select id="aws-namespace-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-namespace-custom" type="text" placeholder="Enter namespace" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label>VPC</label>
            <select id="aws-vpc-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-vpc-custom" type="text" placeholder="vpc-xxxxxxxx" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label>Subnets</label>
            <select id="aws-subnets-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-subnets-custom" type="text" placeholder="subnet-xxx,subnet-yyy" style="display:none; margin-top:4px;" />
          </div>
        </div>
      </div>
    </div>

    <div id="deploy-status" style="margin-top:12px; display:none;"></div>

    <div class="rad-section">
      <button id="deploy-btn" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;" disabled>Create Environment</button>
    </div>
  </div>
</div>
</section>
<!-- ══════════════ CREDENTIALS SUBTAB ══════════════ -->
<section id="pane-credentials" style="${
      activeSubtab === "credentials" ? "" : "display:none;"
    }">
<p class="rad-lede" style="margin-bottom:20px;">Configure and manage the credentials needed to connect to your cloud account. Each environment requires credentials to deploy infrastructure.</p>

<div id="cred-landing">
  <div id="cred-success-banner" class="rad-cred-banner" role="status" style="display:none;">
    <span class="rad-cred-banner__check" aria-hidden="true">✓</span>
    <span id="cred-success-banner-text" class="rad-cred-banner__text"></span>
    <button type="button" id="cred-success-banner-close" class="rad-cred-banner__close" aria-label="Dismiss">×</button>
  </div>
  <button id="new-cred-btn" class="rad-btn rad-btn--primary" style="margin:0 0 16px;">New Credential Profile</button>
  <div class="rad-table-wrap">
    <table class="rad-table">
      <thead><tr><th>Profile Name</th><th>Provider</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody id="cred-table-body">
        <tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading credential profiles…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div id="cred-form" style="display:none;">
  <div class="rad-card">
    <div class="rad-card__title" style="margin:0 0 8px;">Create Credential Profile</div>
    <div class="rad-section">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <div class="rad-field">
          <label>Profile Name</label>
          <input id="cred-name-input" type="text" placeholder="e.g. azure-production" />
        </div>
        <div class="rad-field">
          <label>Provider</label>
          <div class="rad-select-wrap" style="display:block;">
            <select id="cred-provider-select" style="width:100%; min-width:0;">
              <option value="azure">Azure</option>
              <option value="aws">AWS</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="rad-section" id="cred-ghcr-section">
      <div class="rad-section__title">GitHub Packages access</div>
      <div class="rad-section__desc">Radius stores deployment state in a private GHCR package. Verify that the active GitHub account can publish packages before saving this profile.</div>
      <div id="cred-ghcr-status" style="margin-top:12px; font-size:13px; color:var(--rad-text-tertiary);">Checking GitHub Packages access…</div>
      <div id="cred-ghcr-command-row" style="display:none; margin-top:10px; align-items:center; gap:8px; background:var(--rad-code-bg); border:1px solid var(--rad-stroke); border-radius:6px; padding:8px 10px;">
        <code id="cred-ghcr-command" style="flex:1; font-family:var(--font-mono, monospace); font-size:12px; color:var(--rad-text); white-space:pre-wrap; overflow-wrap:anywhere;"></code>
        <button type="button" id="cred-ghcr-copy" class="rad-btn rad-btn--neutral" style="margin:0; padding:2px 10px; font-size:12px; flex:none;">Copy command</button>
      </div>
      <button type="button" id="cred-ghcr-retry" class="rad-btn rad-btn--neutral" style="display:none; margin:10px 0 0;">I’ve updated permissions — retry</button>
    </div>

    <!-- Azure account -->
    <div id="cred-panel-azure" class="rad-section">
      <div class="rad-section__title">Account</div>
      <div class="rad-section__desc">Enter your Azure tenant and subscription, then verify your CLI login to ensure you have the necessary credentials.</div>
      <div class="rad-field" style="margin-top:14px;">
        <label>Tenant ID</label>
        <input id="az-tenant-id" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </div>
      <div class="rad-field" style="margin-top:14px;">
        <label>Subscription ID</label>
        <input id="az-sub-id" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </div>
      <button id="btn-verify-azure" class="rad-btn rad-btn--primary" style="margin-top:16px;">Verify Credentials</button>
    </div>

    <!-- AWS account -->
    <div id="cred-panel-aws" class="rad-section" style="display:none;">
      <div class="rad-section__title">Account</div>
      <div class="rad-section__desc">Enter your AWS account details, then verify your CLI login to ensure you have the necessary credentials.</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px;">
        <div class="rad-field"><label>Account ID</label><input id="aws-account-id" type="text" placeholder="123456789012" /></div>
        <div class="rad-field"><label>Region</label><input id="aws-region" type="text" placeholder="us-east-1" /></div>
      </div>
      <div class="rad-field" style="margin-top:14px;"><label>Role ARN (optional)</label><input id="aws-role-arn" type="text" placeholder="arn:aws:iam::123456789012:role/radius-deploy" /></div>
      <button id="btn-verify-aws" class="rad-btn rad-btn--primary" style="margin-top:16px;">Verify Credentials</button>
    </div>

    <div id="cred-verify-status" class="rad-verified-line" style="margin-top:14px; display:none;"></div>

    <div class="rad-section">
      <div id="cred-verify-hint" style="font-size:13px; color:var(--rad-text-tertiary); padding:12px 14px; background:var(--rad-bg-subtle); border-radius:8px; margin-bottom:16px;">Verify your credentials above to continue profile setup.</div>
      <div style="display:flex; align-items:center; gap:16px;">
        <button id="save-cred-btn" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;" disabled>Save Credential Profile</button>
        <button id="cancel-cred-btn" type="button" class="rad-link" style="background:none; border:none; padding:0; font-size:12px; font-weight:500; cursor:pointer;">← Back to credentials</button>
      </div>
    </div>
  </div>
</div>
</section>


<div id="env-smr-modal" style="display:none; position:fixed; inset:0; z-index:1001; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
  <div style="background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 30px var(--rad-shadow); padding:22px 26px; max-width:420px; width:90%;">
    <div style="font-size:14px; font-weight:600; line-height:1.4; margin-bottom:6px;">Service Management Reference required</div>
    <div style="font-size:12px; color:var(--rad-text-tertiary); line-height:1.5; margin-bottom:12px;">This Entra tenant requires a Service Management Reference on new App Registrations. Enter your Service Management Reference (Microsoft-internal: your Service Tree ID GUID) and retry.</div>
    <input id="env-smr-input" type="text" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off" spellcheck="false" style="width:100%; box-sizing:border-box; padding:8px 10px; font-size:13px; border:1px solid var(--rad-stroke); border-radius:6px; background:var(--rad-surface); color:var(--rad-text);" />
    <div id="env-smr-error" style="display:none; font-size:12px; color:var(--rad-danger); margin-top:6px;"></div>
    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
      <button id="env-smr-cancel" type="button" style="padding:6px 14px; font-size:13px; border:1px solid var(--rad-stroke); border-radius:6px; background:transparent; color:var(--rad-text); cursor:pointer;">Cancel</button>
      <button id="env-smr-retry" type="button" style="padding:6px 14px; font-size:13px; border:1px solid var(--rad-info); border-radius:6px; background:var(--rad-info); color:#fff; cursor:pointer;">Retry</button>
    </div>
  </div>
</div>

<!-- App Registration picker: shown when multiple owned identities match this
     repo (app-selection-required), or via the opt-in "Use an existing
     application" advanced action. Rows are built dynamically in JS. -->
<div id="env-appselect-modal" style="display:none; position:fixed; inset:0; z-index:1002; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
  <div style="background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 30px var(--rad-shadow); padding:22px 26px; max-width:560px; width:92%; max-height:80vh; overflow:auto;">
    <div id="env-appselect-title" style="font-size:14px; font-weight:600; line-height:1.4; margin-bottom:6px;">Choose a deploy identity</div>
    <div id="env-appselect-intro" style="font-size:12px; color:var(--rad-text-tertiary); line-height:1.5; margin-bottom:12px;"></div>
    <div id="env-appselect-caution" style="display:none; font-size:11px; color:var(--rad-danger); line-height:1.5; margin-bottom:10px;"></div>
    <div id="env-appselect-list" style="display:flex; flex-direction:column; gap:6px;"></div>
    <div id="env-appselect-error" style="display:none; font-size:12px; color:var(--rad-danger); margin-top:8px;"></div>
    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
      <button id="env-appselect-cancel" type="button" style="padding:6px 14px; font-size:13px; border:1px solid var(--rad-stroke); border-radius:6px; background:transparent; color:var(--rad-text); cursor:pointer;">Cancel</button>
      <button id="env-appselect-confirm" type="button" style="padding:6px 14px; font-size:13px; border:1px solid var(--rad-info); border-radius:6px; background:var(--rad-info); color:#fff; cursor:pointer;">Use selected</button>
    </div>
  </div>
</div>

<div id="env-verify-modal" style="display:none; position:fixed; inset:0; z-index:1000; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
  <div style="display:flex; align-items:center; gap:16px; background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 30px var(--rad-shadow); padding:22px 26px; max-width:360px;">
    <div class="env-pie-spinner" style="flex:0 0 auto; width:34px; height:34px; border-radius:50%; background:conic-gradient(var(--rad-info) 0turn 0.75turn, var(--rad-stroke) 0.75turn 1turn); animation:spin 1s linear infinite;"></div>
    <div style="min-width:0;">
      <div id="env-verify-title" style="font-size:14px; font-weight:600; line-height:1.4;">Verifying authentication to Azure…</div>
      <div style="font-size:12px; color:var(--rad-text-tertiary); margin-top:2px;">This may take a few moments</div>
    </div>
  </div>
</div>

<div id="azure-cli-assist-modal" role="dialog" aria-modal="true" aria-labelledby="azure-cli-assist-title" style="display:none; position:fixed; inset:0; z-index:1003; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
  <div style="background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 30px var(--rad-shadow); padding:22px 26px; max-width:440px; width:90%;">
    <div id="azure-cli-assist-title" style="font-size:16px; font-weight:600; line-height:1.4; margin-bottom:8px;"></div>
    <div id="azure-cli-assist-message" style="font-size:13px; color:var(--rad-text-tertiary); line-height:1.5;"></div>
    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
      <button id="azure-cli-assist-cancel" type="button" class="rad-btn rad-btn--neutral" style="margin:0;">Cancel</button>
      <button id="azure-cli-assist-confirm" type="button" class="rad-btn rad-btn--primary" style="margin:0;"></button>
    </div>
  </div>
</div>
<style>@keyframes spin{to{transform:rotate(360deg)}}
/* Match Figma: the environments/credentials table's ACTIONS column is left-aligned. */
#env-landing .rad-table thead th:last-child,
#cred-landing .rad-table thead th:last-child { text-align: left; }
#env-landing .rad-table__actions,
#cred-landing .rad-table__actions { justify-content: flex-start; }
/* Success banner shown above the environments list after a successful create. */
#env-success-banner { display:flex; align-items:center; gap:8px; padding:8px 10px 8px 14px; margin:0 0 12px; border-radius:8px; background:var(--rad-success-bg); border:1px solid var(--rad-success); box-shadow:0 1px 2px var(--rad-shadow); }
.env-success-banner__check { flex:0 0 auto; width:20px; height:20px; border-radius:10px; background:var(--rad-success-solid); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.env-success-banner__text { flex:1 1 auto; font-size:13px; color:var(--rad-text); }
.env-success-banner__text strong { font-weight:600; color:var(--rad-text); }
.env-success-banner__close { flex:0 0 auto; background:none; border:none; padding:0 4px; font-size:16px; line-height:1; color:var(--rad-text-tertiary); cursor:pointer; }
.env-success-banner__close:hover { color:var(--rad-text); }
#env-error-banner { display:flex; align-items:center; gap:8px; padding:8px 10px 8px 14px; margin:0 0 12px; border-radius:8px; background:var(--rad-danger-bg); border:1px solid var(--rad-danger); box-shadow:0 1px 2px var(--rad-shadow); }
.env-error-banner__icon { flex:0 0 auto; width:20px; height:20px; border-radius:10px; background:var(--rad-danger-solid); color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.env-error-banner__text { flex:1 1 auto; font-size:13px; color:var(--rad-text); line-height:1.4; }
.env-error-banner__text strong { font-weight:600; }
.env-error-banner__close { flex:0 0 auto; background:none; border:none; padding:0 4px; font-size:16px; line-height:1; color:var(--rad-text-tertiary); cursor:pointer; }
.env-error-banner__close:hover { color:var(--rad-text); }
#env-warning-banner { display:flex; align-items:flex-start; gap:8px; padding:8px 10px 8px 14px; margin:0 0 12px; border-radius:8px; background:var(--rad-warning-bg); border:1px solid var(--rad-warning); box-shadow:0 1px 2px var(--rad-shadow); }
.env-warning-banner__icon { flex:0 0 auto; width:20px; height:20px; border-radius:10px; background:var(--rad-warning); color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.env-warning-banner__text { flex:1 1 auto; font-size:13px; color:var(--rad-text); line-height:1.4; white-space:pre-wrap; }
.env-warning-banner__text strong { font-weight:600; }
.env-warning-banner__close { flex:0 0 auto; background:none; border:none; padding:0 4px; font-size:16px; line-height:1; color:var(--rad-text-tertiary); cursor:pointer; }
.env-warning-banner__close:hover { color:var(--rad-text); }
/* "Ready, action required" banner — the pull-request terminal state. Reads as
   informational rather than as a failure, because nothing went wrong. */
#env-action-banner { display:flex; align-items:flex-start; gap:8px; padding:8px 10px 8px 14px; margin:0 0 12px; border-radius:8px; background:color-mix(in srgb, var(--rad-primary) 8%, transparent); border:1px solid var(--rad-primary); box-shadow:0 1px 2px var(--rad-shadow); }
.env-action-banner__icon { flex:0 0 auto; width:20px; height:20px; border-radius:10px; background:var(--rad-primary); color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.env-action-banner__text { flex:1 1 auto; font-size:13px; color:var(--rad-text); line-height:1.5; }
.env-action-banner__text strong { font-weight:600; }
.env-action-banner__text a { color:var(--rad-primary); }
.env-action-banner__close { flex:0 0 auto; background:none; border:none; padding:0 4px; font-size:16px; line-height:1; color:var(--rad-text-tertiary); cursor:pointer; }
.env-action-banner__close:hover { color:var(--rad-text); }
/* Progress panel — inline, non-blocking, and deliberately not a progress bar. */
#env-progress-panel { margin:0 0 16px; padding:14px 16px; border:1px solid var(--rad-stroke); border-radius:10px; background:var(--rad-surface); box-shadow:0 1px 2px var(--rad-shadow); }
.env-progress__head { display:flex; align-items:flex-start; gap:12px; }
.env-progress__spinner { flex:0 0 auto; width:22px; height:22px; margin-top:1px; border-radius:50%; background:conic-gradient(var(--rad-info) 0turn 0.75turn, var(--rad-stroke) 0.75turn 1turn); animation:spin 1s linear infinite; }
.env-progress--done .env-progress__spinner { animation:none; background:var(--rad-success-solid, var(--rad-info)); }
.env-progress--failed .env-progress__spinner { animation:none; background:var(--rad-danger); }
/* State is never carried by motion or color alone. */
@media (prefers-reduced-motion: reduce) { .env-progress__spinner { animation:none; } }
.env-progress__headtext { flex:1 1 auto; min-width:0; }
.env-progress__title { font-size:14px; font-weight:600; color:var(--rad-text); line-height:1.4; }
.env-progress__activity { font-size:12px; color:var(--rad-text-tertiary); margin-top:2px; line-height:1.4; }
.env-progress__elapsed { flex:0 0 auto; font-size:12px; color:var(--rad-text-tertiary); font-variant-numeric:tabular-nums; }
.env-progress__stages { list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
.env-progress__stage { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--rad-text-tertiary); }
.env-progress__stage--running { color:var(--rad-text); font-weight:600; }
.env-progress__stage--succeeded { color:var(--rad-text); }
.env-progress__glyph { flex:0 0 auto; width:16px; text-align:center; font-size:11px; }
.env-progress__failure { margin-top:12px; padding:12px 14px; border-radius:8px; background:var(--rad-danger-bg); border:1px solid color-mix(in srgb, var(--rad-danger) 55%, transparent); display:flex; flex-direction:column; gap:8px; }
.env-progress__failure-title { font-size:13px; font-weight:600; color:var(--rad-text); }
.env-progress__failure-copy { font-size:12px; color:var(--rad-text); line-height:1.5; }
.env-progress__failure-label { font-size:12px; font-weight:600; color:var(--rad-text); margin-bottom:4px; }
.env-progress__failure-block { display:flex; flex-direction:column; gap:4px; }
.env-progress__failure-list { margin:0; padding-left:18px; font-size:12px; color:var(--rad-text); line-height:1.5; }
.env-progress__details { margin-top:12px; }
.env-progress__details > summary { font-size:12px; color:var(--rad-text-tertiary); cursor:pointer; }
.env-progress__steps { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; max-height:220px; overflow:auto; }
.env-progress__step { display:flex; gap:8px; font-size:12px; color:var(--rad-text-tertiary); line-height:1.45; }
.env-progress__step--warning { color:var(--rad-text); }
.env-progress__step--failed { color:var(--rad-danger); }
.env-progress__actions { display:flex; gap:8px; margin-top:12px; }
/* Credentials success banner (green outline, Figma "Successfully created credential profile"). */
.rad-cred-banner { display:flex; align-items:center; gap:8px; padding:12px 14px; margin:0 0 16px; border-radius:8px; background:color-mix(in srgb, var(--rad-primary) 8%, transparent); border:1px solid var(--rad-primary); }
.rad-cred-banner__check { flex:0 0 auto; color:var(--rad-primary); font-weight:700; }
.rad-cred-banner__text { flex:1 1 auto; font-size:13px; font-weight:600; color:var(--rad-primary); }
.rad-cred-banner__close { flex:0 0 auto; background:none; border:none; padding:0 4px; font-size:16px; line-height:1; color:var(--rad-primary); cursor:pointer; }
/* "Verified · Logged in as …" line (Figma credential-verified). */
.rad-verified-line { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.rad-verified-pill { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border:1px solid var(--rad-primary); border-radius:8px; color:var(--rad-primary); font-weight:600; font-size:13px; }
.rad-verified-meta { font-size:13px; color:var(--rad-text-tertiary); }
.rad-verified-meta strong { color:var(--rad-text); font-weight:600; }
/* Custom combo dropdown (Figma credential-profile picker with pinned action). */
.rad-combo { position: relative; }
.rad-combo__button {
  margin: 0; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 12px; font-size: 14px; font-weight: 400; text-align: left;
  background: var(--rad-surface); color: var(--rad-text);
  border: 1px solid var(--rad-stroke); border-radius: 8px; cursor: pointer;
}
.rad-combo__button:hover { background: var(--rad-surface); }
.rad-combo__value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rad-combo__value.rad-combo__value--placeholder { color: var(--rad-text-tertiary); }
.rad-combo__chevron {
  flex: 0 0 auto; width: 8px; height: 8px; margin-right: 2px;
  border-right: 2px solid var(--rad-text-tertiary); border-bottom: 2px solid var(--rad-text-tertiary);
  transform: translateY(-2px) rotate(45deg);
}
.rad-combo__menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 30;
  background: var(--rad-surface); border: 1px solid var(--rad-stroke); border-radius: 10px;
  box-shadow: 0 8px 24px var(--rad-shadow); overflow: hidden;
}
.rad-combo__option {
  display: block; width: 100%; text-align: left; margin: 0; padding: 12px 16px;
  background: none; border: none; font-size: 14px; color: var(--rad-text); cursor: pointer;
}
.rad-combo__option:hover, .rad-combo__option--active { background: var(--rad-bg-subtle); }
.rad-combo__empty { padding: 12px 16px; font-size: 14px; color: var(--rad-text-tertiary); }
.rad-combo__action {
  display: block; width: 100%; text-align: left; margin: 0; padding: 12px 16px;
  background: none; border: none; border-top: 1px solid var(--rad-stroke);
  font-size: 14px; font-weight: 600; color: var(--rad-primary); cursor: pointer;
}
.rad-combo__action:hover { background: var(--rad-bg-subtle); }
/* Custom credential-profile dropdown (Figma: open panel with options + "+ Create new profile"). */
.rad-combo { position:relative; }
.rad-combo__button { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; margin:0; padding:9px 12px; background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:8px; font-size:14px; font-weight:400; font-family:var(--rad-font); cursor:pointer; }
.rad-combo__button:hover { background:var(--rad-bg-subtle); }
.rad-combo--open .rad-combo__button { border-color:var(--rad-brand); }
.rad-combo__value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rad-combo__value--placeholder { color:var(--rad-text-tertiary); }
.rad-combo__chevron { flex:0 0 auto; width:8px; height:8px; border-right:2px solid var(--rad-text-tertiary); border-bottom:2px solid var(--rad-text-tertiary); transform:translateY(-2px) rotate(45deg); transition:transform 0.15s; }
.rad-combo--open .rad-combo__chevron { transform:translateY(1px) rotate(-135deg); }
.rad-combo__menu { margin-top:6px; background:var(--rad-surface); border:1px solid var(--rad-stroke); border-radius:8px; overflow:hidden; box-shadow:0 6px 20px var(--rad-shadow); }
.rad-combo__options:empty { display:none; }
.rad-combo__option { display:block; width:100%; text-align:left; padding:11px 14px; background:none; border:none; margin:0; font-size:14px; color:var(--rad-text); font-family:var(--rad-font); cursor:pointer; }
.rad-combo__option:hover, .rad-combo__option--active { background:var(--rad-bg-subtle); }
.rad-combo__empty { padding:14px; font-size:13px; color:var(--rad-text-tertiary); }
.rad-combo__action { display:block; width:100%; text-align:left; margin:0; padding:12px 14px; background:none; border:none; border-top:1px solid var(--rad-stroke); font-size:13px; font-weight:600; color:var(--rad-primary); font-family:var(--rad-font); cursor:pointer; }
.rad-combo__action:hover { background:var(--rad-bg-subtle); }
</style>

<script>
var CTX_REPO = '${escapeHtml(ctxRepo)}';
var CTX_BRANCH = '${escapeHtml(ctxBranch)}';

function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}
function providerLabel(p) { return p === 'aws' ? 'AWS' : (p === 'azure' ? 'Azure' : (p || '—')); }

// ============================ Subtab switching ============================
function switchSubtab(name) {
    var isCred = name === 'credentials';
    document.getElementById('pane-environments').style.display = isCred ? 'none' : '';
    document.getElementById('pane-credentials').style.display = isCred ? '' : 'none';
    var links = document.querySelectorAll('#env-subtabs .rad-subtab');
    for (var i = 0; i < links.length; i++) {
        links[i].classList.toggle('rad-subtab--active', links[i].getAttribute('data-subtab') === name);
    }
    try { history.replaceState(null, '', '/?page=' + (isCred ? 'credentials' : 'environment')); } catch (e) {}
    if (isCred) {
        loadCredTable();
    } else {
        loadEnvTable();
        // If the user is returning to an already-open Create Environment form
        // (e.g. they opened it, hit the combo's "+ Create new profile" action to
        // add a profile on the Credentials subtab, then came back), the combo
        // still holds the PROFILES snapshot from when the form opened — so a
        // just-created profile is missing until a full canvas reload. Re-sync it
        // here, preserving the current selection. Skipped on the landing view:
        // the combo is hidden there, New Environment re-fetches via showEnvForm(),
        // and refreshing would fire resource discovery on a hidden form.
        if (envForm && envForm.style.display !== 'none') loadProfilesIntoEnvSelect(envProfileSelect.value);
    }
}
(function() {
    var links = document.querySelectorAll('#env-subtabs .rad-subtab');
    for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function(e) { e.preventDefault(); switchSubtab(this.getAttribute('data-subtab')); });
    }
})();

// ============================ Environments =============================
var envLanding = document.getElementById('env-landing');
var envForm = document.getElementById('env-form');
var envNameInput = document.getElementById('env-name-input');
var envProfileSelect = document.getElementById('env-profile-select'); // hidden input holding selected name
var deployBtn = document.getElementById('deploy-btn');
var PROFILES = [];
var selectedProfile = null;

function statusCell(status) {
    var map = { success: ['success','Success'], verified: ['success','Verified'], failed: ['failed','Failed'], pending: ['pending','Pending'], unverified: ['pending','Unverified'] };
    var m = map[status] || map.pending;
    return '<span class="rad-dot rad-dot--' + m[0] + '"></span><span class="rad-status-label">' + m[1] + '</span>';
}

var envPollTimer = null;
function loadEnvTable() {
    var body = document.getElementById('env-table-body');
    if (!CTX_REPO) {
        body.innerHTML = '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td><td></td><td class="rad-table__actions"></td></tr>';
        return;
    }
    body.innerHTML = '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>';
    fetch('/api/list-environments?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var envs = (data && data.environments) || [];
            if (envs.length === 0) {
                body.innerHTML = '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td><td></td><td class="rad-table__actions"></td></tr>';
                return;
            }
            body.innerHTML = envs.map(function(e) {
                var prov = e.provider || '—';
                var creds = e.credentialProfile || '—';
                var editHref = e.webUrl || ('https://github.com/' + CTX_REPO + '/settings/environments');
                return '<tr>' +
                    '<td class="rad-table__env">' + escapeHtmlClient(e.name) + '</td>' +
                    '<td>' + statusCell(e.status) + '</td>' +
                    '<td class="rad-table__provider">' + escapeHtmlClient(prov) + '</td>' +
                    '<td class="rad-table__creds">' + escapeHtmlClient(creds) + '</td>' +
                    '<td class="rad-table__actions">' +
                        '<a class="rad-link" href="' + escapeHtmlClient(editHref) + '" target="_blank" rel="noopener noreferrer">edit</a>' +
                        '<button class="rad-btn rad-btn--neutral js-deploy-apps" data-env="' + escapeHtmlClient(e.name) + '" style="margin:0;">Deploy Apps</button>' +
                        '<button class="rad-btn rad-btn--danger-outline js-delete-env" data-env="' + escapeHtmlClient(e.name) + '" style="margin:0;">Delete Env</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
            wireRowActions();
            if (envPollTimer) { clearTimeout(envPollTimer); envPollTimer = null; }
            if (envs.some(function(e) { return e.status === 'pending'; })) {
                envPollTimer = setTimeout(loadEnvTable, 10000);
            }
        })
        .catch(function() {
            body.innerHTML = '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Could not load environments.</td></tr>';
        });
}
function wireRowActions() {
    document.querySelectorAll('.js-deploy-apps').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var envName = this.getAttribute('data-env') || '';
            window.location.href = '/?page=deploying' + (envName ? '&env=' + encodeURIComponent(envName) : '');
        });
    });
    document.querySelectorAll('.js-delete-env').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var envName = this.getAttribute('data-env') || '';
            if (!envName || !confirm('Delete environment "' + envName + '"? This removes the GitHub environment and its Radius configuration.')) return;
            this.disabled = true; this.textContent = 'Deleting…';
            var delBtn = this;
            fetch('/api/delete-environment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, environment: envName }) })
                .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
                .then(function(res) {
                    if (!res.ok) {
                        delBtn.disabled = false; delBtn.textContent = 'Delete Env';
                        // An environment can't be deleted while an app is still
                        // deployed to it — show the error and send the user to the
                        // application-deletion flow (Deployments page) to remove it.
                        if (res.d && res.d.code === 'app-deployed') {
                            showEnvError((res.d.error || 'Delete the application deployment first.') + ' Redirecting you to delete the application…');
                            var target = (res.d && res.d.redirect) || '/?page=deploying';
                            setTimeout(function() { window.location.href = target; }, 2000);
                            return;
                        }
                        alert((res.d && res.d.error) || 'Could not delete the environment.');
                        return;
                    }
                    loadEnvTable();
                })
                .catch(function() {
                    delBtn.disabled = false; delBtn.textContent = 'Delete Env';
                    alert('Could not delete the environment. Please try again.');
                });
        });
    });
}

function showEnvForm(preset) {
    preset = preset || {};
    hideEnvTerminalBanners();
    envNameInput.value = preset.name !== undefined ? preset.name : '';
    document.getElementById('az-client-id').value = '';
    clearSharedAppPin();
    document.getElementById('deploy-status').style.display = 'none';
    envLanding.style.display = 'none';
    envForm.style.display = '';
    loadProfilesIntoEnvSelect(preset.profile);
    loadGitHubIdentity();
    envNameInput.focus();
}
function showEnvLanding() {
    envForm.style.display = 'none';
    envLanding.style.display = '';
    loadEnvTable();
}
function showEnvSuccessBanner(provider, name) {
    var banner = document.getElementById('env-success-banner');
    var text = document.getElementById('env-success-banner-text');
    if (!banner || !text) return;
    text.innerHTML = 'Successfully created <strong>' + escapeHtmlClient(providerLabel(provider)) +
        '</strong> Environment <strong>' + escapeHtmlClient(name) + '</strong>';
    banner.style.display = 'flex';
}
var envSuccessClose = document.getElementById('env-success-banner-close');
if (envSuccessClose) envSuccessClose.addEventListener('click', function() {
    document.getElementById('env-success-banner').style.display = 'none';
});

function hideEnvTerminalBanners() {
    ['env-success-banner', 'env-error-banner', 'env-warning-banner', 'env-action-banner'].forEach(function(id) {
        var banner = document.getElementById(id);
        if (banner) banner.style.display = 'none';
    });
}

// Show a red error banner on the environments landing (e.g. when an environment
// can't be deleted because an app is still deployed to it). Message may contain
// intentionally-built escaped markup from the caller.
function showEnvError(msg) {
    var banner = document.getElementById('env-error-banner');
    var text = document.getElementById('env-error-banner-text');
    if (!banner || !text) return;
    text.textContent = msg;
    banner.style.display = 'flex';
    banner.scrollIntoView({ block: 'nearest' });
}
var envErrorClose = document.getElementById('env-error-banner-close');
if (envErrorClose) envErrorClose.addEventListener('click', function() {
    document.getElementById('env-error-banner').style.display = 'none';
});

// Surface non-fatal auto-setup warnings (steps prefixed with "⚠️") on the
// SUCCESS path. Auto-setup returns a 'steps' log; the AKS Cluster Admin grant is
// best-effort and only pushes a warning into that log, so without this the user
// would never see (on success) that they must grant the role manually before the
// deploy will pass "Verify AKS Access". Renders nothing when there are no
// warnings. Steps are server-built plain text; render as text, not markup.
function showEnvSetupWarnings(steps) {
    var banner = document.getElementById('env-warning-banner');
    var text = document.getElementById('env-warning-banner-text');
    if (!banner || !text) return;
    var warnings = (steps || []).filter(function(s) { return typeof s === 'string' && s.indexOf('⚠️') === 0; });
    if (!warnings.length) { banner.style.display = 'none'; return; }
    text.textContent = warnings.join('\\n\\n');
    banner.style.display = 'flex';
    banner.scrollIntoView({ block: 'nearest' });
}
var envWarningClose = document.getElementById('env-warning-banner-close');
if (envWarningClose) envWarningClose.addEventListener('click', function() {
    document.getElementById('env-warning-banner').style.display = 'none';
});

// The pull-request terminal state. When Radius lacks push access to the default
// branch it commits the workflows to a branch and opens a PR instead — and it
// deliberately does NOT dispatch credential verification, because the workflow
// file does not exist on the default branch yet and the dispatch would 404.
// Nothing failed, and nothing is still running; the operation is finished and
// waiting on the user. Before this existed the client polled for a verify run
// that was never going to appear and, eight minutes later, reported this
// correct outcome as "Timed out waiting for credential verification".
function showEnvActionRequired(provider, name, pullRequestUrl, terminal) {
    var banner = document.getElementById('env-action-banner');
    var text = document.getElementById('env-action-banner-text');
    if (!banner || !text) return;
    var hasPr = typeof pullRequestUrl === 'string' && pullRequestUrl.indexOf('https://github.com/') === 0;
    var html = '<strong>' + escapeHtmlClient(providerLabel(provider)) + '</strong> Environment <strong>' +
        escapeHtmlClient(name) + '</strong> is set up, but one step is left for you. ';
    if (hasPr) {
        html += 'Radius could not push the deploy workflows to the default branch, so it opened a pull request. ' +
            'Credential verification and deploys start working once it merges.';
    } else {
        var branch = terminal && terminal.branch ? terminal.branch : 'the setup branch';
        var base = terminal && terminal.baseBranch ? terminal.baseBranch : 'the default branch';
        html += 'Radius committed the deploy workflows to <code>' + escapeHtmlClient(branch) +
            '</code>, but could not open a pull request automatically. Open a pull request into <code>' +
            escapeHtmlClient(base) + '</code> and merge it to finish setup.';
    }
    // Only render a link for a URL we recognise; anything else is shown as text
    // so a malformed value can never become an anchor target.
    if (hasPr) {
        html += ' <a href="' + escapeHtmlClient(pullRequestUrl) + '" target="_blank" rel="noopener noreferrer">Review the pull request →</a>';
    }
    text.innerHTML = html;
    banner.style.display = 'flex';
    banner.scrollIntoView({ block: 'nearest' });
}
var envActionClose = document.getElementById('env-action-banner-close');
if (envActionClose) envActionClose.addEventListener('click', function() {
    document.getElementById('env-action-banner').style.display = 'none';
});

// ---------------- Environment setup progress (non-blocking) ----------------
//
// The panel is a view over the server's operation record, not over the fetch
// that started it. That indirection is the whole point: the record outlives the
// request, so closing the page, navigating to the graph, or reloading the canvas
// mid-operation all rejoin the same operation instead of losing it.
var envProgressTimer = null;
var envProgressElapsedTimer = null;
// The Actions step the verify run is on. Held here rather than in the record
// because it comes from a different poll on a slower cadence, and the panel
// re-renders faster than that poll refreshes.
var envVerifyActivity = '';

function formatElapsed(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

var ENV_STAGE_GLYPH = { pending: '○', running: '◐', succeeded: '✓', warning: '⚠', failed: '✗', skipped: '–' };

function setFailureList(items, listId, blockId) {
    var list = document.getElementById(listId);
    var block = document.getElementById(blockId);
    if (!list || !block) return;
    list.innerHTML = '';
    if (!items || !items.length) {
        block.style.display = 'none';
        return;
    }
    items.forEach(function(item) {
        var li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
    });
    block.style.display = '';
}

function renderEnvFailureCard(op) {
    var card = document.getElementById('env-progress-failure');
    var messageEl = document.getElementById('env-progress-failure-message');
    var cleanupEl = document.getElementById('env-progress-cleanup-status');
    var retryEl = document.getElementById('env-progress-retry');
    if (!card || !messageEl || !cleanupEl || !retryEl) return;
    var failed = op && (op.terminalState === 'failed' || op.terminalState === 'failed_partial');
    if (!failed) {
        card.style.display = 'none';
        return;
    }

    var cleanup = op.cleanup || {};
    var retry = cleanup.retry || {};
    var removed = (cleanup.removed || []).map(function(entry) {
        return entry && entry.target ? entry.target : '';
    }).filter(Boolean);
    var retained = (cleanup.retained || []).map(function(entry) {
        return entry && entry.target ? entry.target : '';
    }).filter(Boolean);
    var warnings = (cleanup.warnings || []).filter(Boolean);
    var cleanupStatus = cleanup.state === 'running' ? 'Cleanup is still running.' :
        cleanup.state === 'pending' ? 'Cleanup has not started yet.' :
        cleanup.rollbackBeforeCommit === false ? 'Cleanup stopped at the commit point, so reusable artifacts were left in place.' :
        cleanup.state === 'succeeded_with_warnings' ? 'Cleanup finished with warnings.' :
        cleanup.state === 'succeeded' ? 'Cleanup finished.' :
        'Cleanup was not needed.';

    messageEl.textContent = op.failure && op.failure.message ? op.failure.message : 'The setup request failed.';
    cleanupEl.textContent = cleanupStatus;
    retryEl.textContent = retry.guidance ? ('Retry starts cleanly: ' + (retry.startsCleanly ? 'Yes' : 'No') + '. ' + retry.guidance) : '';
    setFailureList(removed, 'env-progress-cleanup-removed', 'env-progress-cleanup-removed-block');
    setFailureList(retained, 'env-progress-cleanup-retained', 'env-progress-cleanup-retained-block');
    setFailureList(warnings, 'env-progress-cleanup-warnings', 'env-progress-cleanup-warnings-block');
    card.style.display = '';
}

function renderEnvProgress(op) {
    var panel = document.getElementById('env-progress-panel');
    if (!panel) return;
    if (!op) {
        panel.style.display = 'none';
        renderEnvFailureCard(null);
        return;
    }
    panel.style.display = '';
    panel.classList.toggle('env-progress--done', op.terminalState === 'succeeded' || op.terminalState === 'succeeded_with_warnings' || op.terminalState === 'action_required');
    panel.classList.toggle('env-progress--failed', op.terminalState === 'failed' || op.terminalState === 'failed_partial');

    document.getElementById('env-progress-title').textContent = op.summary || '';

    // The current step doubles as the activity line. When the record has nothing
    // to say we clear it rather than substitute filler.
    var activity = '';
    for (var i = op.steps.length - 1; i >= 0; i--) {
        if (op.steps[i].state === 'running') { activity = op.steps[i].label; break; }
    }
    if (!activity && op.steps.length) activity = op.steps[op.steps.length - 1].label;
    if (op.currentStage === 'verify' && envVerifyActivity && !op.terminalState) {
        activity = 'Verifying credentials — ' + envVerifyActivity;
    }
    if (op.failure && op.failure.message) activity = op.failure.message;
    document.getElementById('env-progress-activity').textContent = activity;

    var stagesEl = document.getElementById('env-progress-stages');
    stagesEl.innerHTML = '';
    op.stages.forEach(function(stage) {
        var li = document.createElement('li');
        li.className = 'env-progress__stage env-progress__stage--' + stage.state;
        var glyph = document.createElement('span');
        glyph.className = 'env-progress__glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = ENV_STAGE_GLYPH[stage.state] || '○';
        var label = document.createElement('span');
        // The glyph is decorative, so the state has to reach a screen reader as
        // words. Color and shape alone would not.
        label.textContent = stage.label + ' — ' + stage.state;
        li.appendChild(glyph);
        li.appendChild(label);
        stagesEl.appendChild(li);
    });

    var stepsEl = document.getElementById('env-progress-steps');
    stepsEl.innerHTML = '';
    op.steps.forEach(function(step) {
        var li = document.createElement('li');
        li.className = 'env-progress__step env-progress__step--' + step.state;
        // Server-built copy, but it still goes in as text: a step label can
        // quote an Azure CLI error, and that is not ours to trust as markup.
        li.textContent = (ENV_STAGE_GLYPH[step.state] || '·') + ' ' + step.label;
        stepsEl.appendChild(li);
    });
    renderEnvFailureCard(op);
    document.getElementById('env-progress-details').style.display = op.steps.length ? '' : 'none';
    var actions = document.getElementById('env-progress-actions');
    var resume = document.getElementById('env-progress-resume');
    var dismiss = document.getElementById('env-progress-dismiss');
    var target = op.journey && op.journey.resumeTarget;
    var canResume = op.terminalState && target && target.page === 'planned' && target.repo;
    if (resume && canResume) {
        var href = '/?page=planned&repo=' + encodeURIComponent(target.repo);
        if (target.branch) href += '&branch=' + encodeURIComponent(target.branch);
        resume.href = href;
        resume.textContent = op.journey.resumeReason || 'View planned graph';
    }
    if (resume) resume.style.display = canResume ? '' : 'none';
    if (dismiss) dismiss.style.display = op.terminalState ? '' : 'none';
    if (actions) actions.style.display = op.terminalState ? 'flex' : 'none';
}

function stopEnvProgress() {
    envVerifyActivity = '';
    if (envProgressTimer) { clearTimeout(envProgressTimer); envProgressTimer = null; }
    if (envProgressElapsedTimer) { clearInterval(envProgressElapsedTimer); envProgressElapsedTimer = null; }
}

function hideEnvProgress() {
    stopEnvProgress();
    var panel = document.getElementById('env-progress-panel');
    if (panel) panel.style.display = 'none';
}

var envProgressDismiss = document.getElementById('env-progress-dismiss');
if (envProgressDismiss) envProgressDismiss.addEventListener('click', function() {
    hideEnvProgress();
});

function focusEnvProgressPanel() {
    var panel = document.getElementById('env-progress-panel');
    if (!panel) return;
    try { panel.focus({ preventScroll: true }); }
    catch (e) { panel.focus(); }
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

function syncEnvFailureOperation(data) {
    var operationId = data && typeof data.operationId === 'string' ? data.operationId : '';
    var url = operationId ? '/api/operations/' + encodeURIComponent(operationId) : '';
    if (!url) return Promise.resolve(false);
    return fetch(url)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(payload) {
            var op = payload && payload.operation;
            if (!op) return false;
            renderEnvProgress(op);
            var detailsEl = document.getElementById('env-progress-details');
            if (detailsEl && (op.terminalState === 'failed' || op.terminalState === 'failed_partial')) {
                detailsEl.open = true;
            }
            var errorBanner = document.getElementById('env-error-banner');
            if (errorBanner) errorBanner.style.display = 'none';
            return true;
        })
        .catch(function() { return false; });
}

// Poll the record for the given repo. Returns nothing — the panel is driven entirely by
// what the server reports, so a caller that also holds the POST promise and this
// poller can never show two different truths.
function trackEnvProgress(repo, environment, provider, onTerminal) {
    stopEnvProgress();
    var startedAtMs = Date.now();
    var observedOperation = false;
    var operationId = '';
    var verifyDispatchedAtMs = 0;
    var verifyDeadlineMs = 45 * 60 * 1000;
    var promptingRequestedAt = '';
    var elapsedEl = document.getElementById('env-progress-elapsed');
    envProgressElapsedTimer = setInterval(function() {
        if (elapsedEl) elapsedEl.textContent = formatElapsed(Date.now() - startedAtMs);
    }, 1000);

    function tick() {
        fetch('/api/operations?repo=' + encodeURIComponent(repo))
            .then(function(r) { return r.json(); })
            .then(function(payload) {
                var op = payload && payload.operation;
                // The registry retains the latest terminal operation for this
                // repository. During the short gap before a new POST registers,
                // that record belongs to the previous environment and must not
                // replace the optimistic panel for the setup just requested.
                if (!observedOperation && op && (op.environment !== environment || op.terminalState)) {
                    envProgressTimer = setTimeout(tick, 1500);
                    return;
                }
                if (!op) {
                    // A just-started setup has not necessarily reached the server
                    // operation registry yet. Verification status is historical
                    // and can still report the previous successful run for this
                    // environment name, so only use it for restart recovery after
                    // this poller has first observed the current operation.
                    if (!observedOperation) {
                        envProgressTimer = setTimeout(tick, 1500);
                        return;
                    }
                    // Verification is tracked separately from the process-local
                    // operation registry. If the extension restarts after
                    // dispatch, the record can disappear while the Actions run
                    // still reaches a terminal result.
                    if (!environment) { envProgressTimer = setTimeout(tick, 1500); return; }
                    fetch('/api/verify-status?repo=' + encodeURIComponent(repo) + '&environment=' + encodeURIComponent(environment) + '&operationId=' + encodeURIComponent(operationId))
                        .then(function(r) { return r.json(); })
                        .then(function(v) {
                            if (v.state === 'expired' || v.terminal) {
                                stopEnvProgress();
                                var expiredActivity = document.getElementById('env-progress-activity');
                                if (expiredActivity) expiredActivity.textContent = v.error || 'Credential verification is no longer being tracked.';
                                return;
                            }
                            if (verifyDispatchedAtMs && Date.now() - verifyDispatchedAtMs > verifyDeadlineMs) {
                                stopEnvProgress();
                                var timedOutActivity = document.getElementById('env-progress-activity');
                                if (timedOutActivity) timedOutActivity.textContent = 'Credential verification exceeded its tracking window. Check the GitHub Actions run before retrying.';
                                return;
                            }
                            if (v.state === 'success') {
                                hideEnvProgress();
                                showEnvSuccessBanner(provider || 'azure', environment);
                                loadEnvTable();
                                return;
                            }
                            if (v.state === 'failed') {
                                stopEnvProgress();
                                var panel = document.getElementById('env-progress-panel');
                                if (panel) {
                                    panel.style.display = 'block';
                                    panel.classList.remove('env-progress--done');
                                    panel.classList.add('env-progress--failed');
                                }
                                var activity = document.getElementById('env-progress-activity');
                                if (activity) activity.textContent = 'Credential verification failed. ' + (v.error || '');
                                var details = document.getElementById('env-progress-details');
                                if (details && v.runUrl) details.textContent = 'View the run: ' + v.runUrl;
                                return;
                            }
                            if (v.activity) envVerifyActivity = v.activity;
                            envProgressTimer = setTimeout(tick, 1500);
                        })
                        .catch(function() { envProgressTimer = setTimeout(tick, 3000); });
                    return;
                }
                observedOperation = true;
                operationId = op.operationId || operationId;
                if (op.verification && op.verification.dispatchedAt) verifyDispatchedAtMs = Number(op.verification.dispatchedAt);
                startedAtMs = new Date(op.startedAt).getTime();
                if (elapsedEl) {
                    elapsedEl.textContent = formatElapsed((op.endedAt ? new Date(op.endedAt).getTime() : Date.now()) - startedAtMs);
                }
                renderEnvProgress(op);
                if (op.terminalState) {
                    stopEnvProgress();
                    if (onTerminal) onTerminal(op);
                    return;
                }
                if (op.state === 'input_required' && op.inputRequired && op.inputRequired.requestedAt !== promptingRequestedAt) {
                    promptingRequestedAt = op.inputRequired.requestedAt;
                    var prompt = op.inputRequired;
                    var answer;
                    if (prompt.code === 'service-management-reference-required') {
                        answer = promptSmr().then(function(smr) {
                            return { serviceManagementReference: smr };
                        });
                    } else if (prompt.code === 'app-selection-required') {
                        answer = showAppPicker({
                            title: 'Choose a deploy identity',
                            intro: 'You own more than one App Registration matching this repository. Choose which identity to use for GitHub Actions deployments, or create a new one.',
                            candidates: (prompt.metadata && prompt.metadata.candidates) || [],
                            defaultAppId: prompt.metadata && prompt.metadata.defaultAppId,
                            allowCreateNew: true
                        }).then(function(choice) {
                            return choice.createNew ? { createNew: true } : { appId: choice.appId };
                        });
                    }
                    if (answer) {
                        answer.then(function(values) {
                            values.checkpoint = prompt.checkpoint;
                            values.repo = repo;
                            values.environment = environment;
                            values.provider = provider;
                            return fetch('/api/operations/' + encodeURIComponent(operationId) + '/resume/' + encodeURIComponent(prompt.code), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(values)
                            }).then(function(response) {
                                if (response.ok) return response;
                                return response.json().catch(function() { return {}; }).then(function(payload) {
                                    var error = new Error(payload.error || payload.message || 'Unable to resume environment setup.');
                                    error.retryPrompt = payload.code !== 'operation-input-expired';
                                    error.operation = payload.operation;
                                    throw error;
                                });
                            });
                        }).then(function() {
                            envProgressTimer = setTimeout(tick, 0);
                        }).catch(function(error) {
                            if (error && error.abandonOperation) {
                                fetch('/api/operations/' + encodeURIComponent(operationId) + '/abandon', { method: 'POST' })
                                    .then(function(response) {
                                        if (!response.ok) {
                                            promptingRequestedAt = '';
                                            throw new Error('Unable to cancel environment setup.');
                                        }
                                        envProgressTimer = setTimeout(tick, 0);
                                    })
                                    .catch(function() { envProgressTimer = setTimeout(tick, 1500); });
                                return;
                            }
                            if (error && error.operation && error.operation.failure && error.operation.failure.code === 'operation-input-expired') {
                                stopEnvProgress();
                                applyEnvTerminal(error.operation);
                                return;
                            }
                            if (error && error.retryPrompt) promptingRequestedAt = '';
                            envProgressTimer = setTimeout(tick, 1500);
                        });
                        return;
                    }
                }
                envProgressTimer = setTimeout(tick, 1500);
            })
            .catch(function() {
                // A dropped poll is routine — the server respawns after an idle
                // reap and the next tick reconnects. Never surface it as failure.
                envProgressTimer = setTimeout(tick, 3000);
            });
    }
    tick();
}

// On load, rejoin an operation that is already running for this repo. This is
// what makes navigating away safe: the user can leave the page mid-setup and
// find the same panel, with the same history, when they come back.
function resumeEnvProgress(repo) {
    if (!repo) return;
    fetch('/api/operations?repo=' + encodeURIComponent(repo))
        .then(function(r) { return r.json(); })
        .then(function(payload) {
            var op = payload && payload.operation;
            if (!op || op.terminalState) return;
            renderEnvProgress(op);
            trackEnvProgress(repo, op.environment || '', op.provider || '', function(finished) { applyEnvTerminal(finished); });
        })
        .catch(function() { /* nothing to resume */ });
}

// One place that turns a terminal record into what the landing shows, so the
// resumed path and the just-clicked path cannot disagree.
function applyEnvTerminal(op) {
    var btn = document.getElementById('deploy-btn');
    if (btn) { btn.textContent = 'Create Environment'; btn.disabled = false; }
    var warnings = op.steps.filter(function(s) { return s.state === 'warning'; })
        .map(function(s) { return '⚠️ ' + s.label; });
    if (op.terminalState === 'action_required') {
        showEnvSetupWarnings(warnings);
        showEnvActionRequired(op.provider, op.environment, op.terminal && op.terminal.pullRequestUrl, op.terminal);
    } else if (op.terminalState === 'succeeded' || op.terminalState === 'succeeded_with_warnings') {
        showEnvSuccessBanner(op.provider, op.environment);
        showEnvSetupWarnings(warnings);
    } else if (op.terminalState === 'cancelled') {
        var cancelledPanel = document.getElementById('env-progress-panel');
        if (cancelledPanel) {
            cancelledPanel.classList.remove('env-progress--done', 'env-progress--failed');
        }
        var cancelledActivity = document.getElementById('env-progress-activity');
        if (cancelledActivity) cancelledActivity.textContent = 'Environment setup cancelled.';
        showEnvSetupWarnings(warnings);
    } else {
        var message = 'Environment setup failed: ' + ((op.failure && op.failure.message) || 'unknown error');
        var panel = document.getElementById('env-progress-panel');
        if (panel) {
            panel.classList.remove('env-progress--done');
            panel.classList.add('env-progress--failed');
        }
        var activityEl = document.getElementById('env-progress-activity');
        if (activityEl) activityEl.textContent = message;
        showEnvError(message);
    }
    loadEnvTable();
}

function findProfile(name) {
    for (var i = 0; i < PROFILES.length; i++) { if (PROFILES[i].name === name) return PROFILES[i]; }
    return null;
}

// --- Custom credential-profile dropdown (Figma: options + pinned action) ---
var envProfileBtn = document.getElementById('env-profile-button');
var envProfileMenu = document.getElementById('env-profile-menu');
var envProfileValue = document.getElementById('env-profile-value');
var envProfileOptions = document.getElementById('env-profile-options');

function openProfileMenu(open) {
    var show = open === undefined ? envProfileMenu.style.display === 'none' : open;
    envProfileMenu.style.display = show ? '' : 'none';
    envProfileBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
}
function setProfileValue(name) {
    envProfileSelect.value = name || '';
    if (name) {
        var p = findProfile(name);
        envProfileValue.textContent = name + (p ? ' (' + providerLabel(p.provider) + ')' : '');
        envProfileValue.classList.remove('rad-combo__value--placeholder');
    } else {
        envProfileValue.textContent = 'Select a credential profile…';
        envProfileValue.classList.add('rad-combo__value--placeholder');
    }
    onEnvProfileSelected();
}
function renderProfileOptions() {
    envProfileOptions.innerHTML = '';
    PROFILES.forEach(function(p) {
        var o = document.createElement('button');
        o.type = 'button';
        o.className = 'rad-combo__option';
        o.setAttribute('role', 'option');
        o.setAttribute('data-name', p.name);
        o.textContent = p.name + ' (' + providerLabel(p.provider) + ')';
        o.addEventListener('click', function() { setProfileValue(this.getAttribute('data-name')); openProfileMenu(false); });
        envProfileOptions.appendChild(o);
    });
    document.getElementById('env-profile-empty').style.display = PROFILES.length ? 'none' : '';
}
envProfileBtn.addEventListener('click', function(e) { e.stopPropagation(); openProfileMenu(); });
document.addEventListener('click', function(e) {
    var combo = document.getElementById('env-profile-combo');
    if (combo && !combo.contains(e.target)) openProfileMenu(false);
});

function loadProfilesIntoEnvSelect(preselectName) {
    fetch('/api/credential-profiles?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            PROFILES = (d && d.profiles) || [];
            renderProfileOptions();
            setProfileValue(preselectName && findProfile(preselectName) ? preselectName : '');
        })
        .catch(function() {
            PROFILES = [];
            renderProfileOptions();
            setProfileValue('');
        });
}

// --- GitHub identity for setup (acting account + switcher) ---
// Setup mutations (App Registration create, environment PUT, workflow-file
// commit) run as an effective GitHub account that is NOT always the one the
// host app shows. Surface it, and let the user switch, so a wrong account
// (e.g. an enterprise/EMU login without repo or tenant access) is caught here
// rather than as a confusing mid-setup permission error.
var GH_IDENTITY = null;
var envGhField = document.getElementById('env-gh-identity-field');
var envGhBtn = document.getElementById('env-gh-account-button');
var envGhMenu = document.getElementById('env-gh-account-menu');
var envGhValue = document.getElementById('env-gh-account-value');
var envGhOptions = document.getElementById('env-gh-account-options');
var envGhNote = document.getElementById('env-gh-identity-note');
var envGhRecheck = document.getElementById('env-gh-recheck');
// True while the identity note is showing a missing-scope warning the user must
// fix out-of-band (run a gh command). Gates the auto re-check on window refocus
// so we only re-poll gh when there is actually something to clear.
var envGhScopeWarn = false;
// Guards against overlapping re-checks (rapid focus events / button spam).
var envGhChecking = false;

function openGhAccountMenu(open) {
    if (!envGhMenu) return;
    var show = open === undefined ? envGhMenu.style.display === 'none' : open;
    envGhMenu.style.display = show ? '' : 'none';
    if (envGhBtn) envGhBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
}
if (envGhBtn) envGhBtn.addEventListener('click', function(e) { e.stopPropagation(); openGhAccountMenu(); });
document.addEventListener('click', function(e) {
    var combo = document.getElementById('env-gh-account-combo');
    if (combo && !combo.contains(e.target)) openGhAccountMenu(false);
});

function renderGitHubIdentity() {
    if (!envGhField || !GH_IDENTITY) return;
    var id = GH_IDENTITY;
    if (id.error || !id.actingLogin) {
        // Detection failed or no account — keep the field hidden rather than
        // showing a misleading control. Setup still runs with whatever gh uses.
        envGhField.style.display = 'none';
        envGhScopeWarn = false;
        if (envGhRecheck) envGhRecheck.style.display = 'none';
        return;
    }
    envGhField.style.display = '';
    if (envGhValue) envGhValue.textContent = '@' + id.actingLogin;
    var accounts = id.accounts || [];
    if (envGhOptions) {
        envGhOptions.innerHTML = '';
        accounts.forEach(function(a) {
            var o = document.createElement('button');
            o.type = 'button';
            o.className = 'rad-combo__option';
            o.setAttribute('role', 'option');
            var label = '@' + a.login;
            var missingScopes = [];
            if (!a.hasWorkflow) missingScopes.push('workflow');
            if (!a.hasPackages) missingScopes.push('packages');
            if (missingScopes.length) label += ' — missing ' + missingScopes.join(' + ') + ' scope' + (missingScopes.length > 1 ? 's' : '');
            if (!a.switchable) label += ' (not switchable)';
            else if (a.login === id.actingLogin) label += ' ✓';
            o.textContent = label;
            if (a.switchable && a.login !== id.actingLogin) {
                o.setAttribute('data-login', a.login);
                o.addEventListener('click', function() {
                    switchGitHubAccount(this.getAttribute('data-login'));
                    openGhAccountMenu(false);
                });
            } else {
                o.disabled = true;
                o.style.opacity = '0.6';
                o.style.cursor = 'default';
            }
            envGhOptions.appendChild(o);
        });
    }
    var emptyEl = document.getElementById('env-gh-account-empty');
    if (emptyEl) emptyEl.style.display = accounts.length ? 'none' : '';

    if (envGhNote) {
        var warn = '';
        var scopeWarn = false;
        var repoWarn = false;
        if (id.repoAccess) {
            // The acting account can't admin (or can't read) the target repo, so
            // Create Environment would 403 at submit. Surface it HERE at open,
            // next to the account it concerns, rather than after the user fills
            // in all four steps. The submit-time preflight stays authoritative;
            // this is an early, additive heads-up. Offer Re-check so switching
            // accounts (or being granted access) clears it without reopening.
            warn = id.repoAccess;
            repoWarn = true;
        } else if (id.mismatch && id.displayLogin) {
            warn = 'The app shows @' + id.displayLogin + ' but setup will act as @' + id.actingLogin +
                '. If deployment fails with a permission error, switch to the account that has access to this repo and your Azure tenant.';
        } else if (!id.actingHasWorkflow || !id.actingHasPackages) {
            // Both scopes are needed to complete setup: 'workflow' to commit the
            // deploy workflow, 'write:packages' to publish the private state
            // package to GHCR. Name whichever is missing and build the exact
            // refresh command (read:packages accompanies write:packages).
            var missNames = [], refreshScopes = [];
            if (!id.actingHasWorkflow) { missNames.push('workflow'); refreshScopes.push('workflow'); }
            if (!id.actingHasPackages) { missNames.push('write:packages'); refreshScopes.push('read:packages'); refreshScopes.push('write:packages'); }
            // gh auth refresh has no --user flag: it refreshes whichever
            // account is ACTIVE for the host. In a multi-account (EMU/enterprise)
            // setup the active account may not be the one we act as, so first
            // switch to it with "gh auth switch -u" (which does take --user), then
            // run a bare refresh. Adding a -u flag to the refresh call errors
            // with "unknown shorthand flag: 'u'".
            var refreshScopeFlags = refreshScopes.map(function(s){ return ' -s ' + s; }).join('');
            var refreshCmd = 'gh auth switch -h github.com -u ' + id.actingLogin +
                ' && gh auth refresh -h github.com' + refreshScopeFlags;
            warn = 'The active account @' + id.actingLogin + ' is missing the ' + missNames.join(' and ') + ' scope' + (missNames.length > 1 ? 's' : '') +
                ' environment setup needs. Run "' + refreshCmd + '" or switch accounts. Note: gh auth switch changes your active GitHub account machine-wide for every tool in this terminal until you switch back.';
            scopeWarn = true;
        }
        // Remember whether a fixable scope warning is on screen, and offer the
        // manual Re-check control only in that case. Returning from the terminal
        // (window refocus) auto re-checks while this is true; see below.
        envGhScopeWarn = scopeWarn || repoWarn;
        if (envGhRecheck) envGhRecheck.style.display = (scopeWarn || repoWarn) ? '' : 'none';
        if (warn) {
            envGhNote.textContent = warn;
            envGhNote.style.color = 'var(--rad-warning, #9a6700)';
            envGhNote.style.display = '';
        } else {
            envGhNote.innerHTML = 'Acts as <strong>@' + id.actingLogin + '</strong> to commit the deploy workflow to your repo and publish the state package. Needs the <code>workflow</code> and <code>write:packages</code> scopes.';
            envGhNote.style.color = 'var(--rad-text-tertiary)';
            envGhNote.style.display = '';
        }
    }
}

function loadGitHubIdentity(fresh) {
    if (envGhChecking) return;
    envGhChecking = true;
    // On the very first load show the neutral "Detecting…" placeholder; on a
    // re-check the account value is already shown, so give feedback on the
    // button instead of blanking the field.
    if (fresh && envGhRecheck) { envGhRecheck.disabled = true; envGhRecheck.textContent = 'Checking…'; }
    else if (envGhValue) envGhValue.textContent = 'Detecting…';
    // fresh=1 asks the server to drop its memoized gh snapshot so newly added
    // scopes (e.g. write:packages) are actually observed. repo lets the server
    // fold in the repo admin/read preflight so a non-admin account is flagged
    // here at open, not only at submit.
    var idUrl = '/api/github-identity?repo=' + encodeURIComponent(CTX_REPO || '');
    if (fresh) idUrl += '&fresh=1';
    fetch(idUrl)
        .then(function(r) { return r.json(); })
        .then(function(d) { GH_IDENTITY = d || {}; renderGitHubIdentity(); })
        .catch(function() { if (envGhField) envGhField.style.display = 'none'; })
        .then(function() {
            envGhChecking = false;
            if (envGhRecheck) { envGhRecheck.disabled = false; envGhRecheck.textContent = 'Re-check'; }
        });
}

// Manual re-check: the user ran the gh command and wants the warning re-evaluated.
if (envGhRecheck) envGhRecheck.addEventListener('click', function() { loadGitHubIdentity(true); });

// Auto re-check when the canvas regains focus. The user leaves to a terminal to
// run the remediation command and comes back; refocus is the natural signal to
// re-poll. Only fire while a fixable scope warning is showing so we do not run
// gh on every unrelated focus.
function envGhAutoRecheck() {
    if (envGhScopeWarn && !envGhChecking && envGhField && envGhField.style.display !== 'none') {
        loadGitHubIdentity(true);
    }
}
document.addEventListener('visibilitychange', function() { if (!document.hidden) envGhAutoRecheck(); });
window.addEventListener('focus', envGhAutoRecheck);

function switchGitHubAccount(login) {
    if (!login) return;
    if (envGhValue) envGhValue.textContent = 'Switching…';
    fetch('/api/github-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login }),
    })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
        .then(function(res) {
            if (res.ok) {
                // Re-fetch identity WITH the repo so the admin/read preflight
                // re-runs for the freshly switched account — the switch response
                // resolves identity without the repo, so it carries no repoAccess.
                loadGitHubIdentity(true);
                return;
            }
            renderGitHubIdentity();
            if (envGhNote) {
                envGhNote.textContent = (res.d && res.d.error) || 'Could not switch account.';
                envGhNote.style.color = 'var(--rad-danger, #cf222e)';
                envGhNote.style.display = '';
            }
        })
        .catch(function() { renderGitHubIdentity(); });
}

function onEnvProfileSelected() {
    // A credential-profile / tenant change is a context change: never let a
    // shared-identity pin from a previous context silently carry over.
    selectedProfile = findProfile(envProfileSelect.value);
    var statusEl = document.getElementById('env-profile-status');
    var idAz = document.getElementById('env-identity-azure');
    var idAws = document.getElementById('env-identity-aws');
    if (!selectedProfile) {
        statusEl.style.display = 'none';
        deployBtn.disabled = true;
        var azRb0 = document.getElementById('azure-refresh-btn'); if (azRb0) azRb0.disabled = true;
        var awsRb0 = document.getElementById('aws-refresh-btn'); if (awsRb0) awsRb0.disabled = true;
        return;
    }
    var prov = selectedProfile.provider === 'aws' ? 'aws' : 'azure';
    document.getElementById('env-selected-provider').value = prov;
    // Provider-aware profile detail: what the connection does, where deploys
    // land (subscription / account), and the verified identity behind it.
    var detail = '';
    if (prov === 'aws') {
        detail += '<div style="color:var(--rad-text-tertiary);margin-bottom:4px;">GitHub Actions assumes the IAM role in this profile over OIDC to deploy — no stored secrets.</div>';
        var awsDest = escapeHtmlClient(selectedProfile.accountId || '') + (selectedProfile.region ? ' · ' + escapeHtmlClient(selectedProfile.region) : '');
        if (awsDest.trim()) detail += '<div><span style="color:var(--rad-text-tertiary);">Account:</span> <strong style="color:var(--rad-text);">' + awsDest + '</strong></div>';
    } else {
        detail += '<div style="color:var(--rad-text-tertiary);margin-bottom:4px;">Creates the Entra app, the OIDC trust to your repo, and grants it Contributor on the resource group and AKS RBAC Cluster Admin on the cluster.</div>';
        var sub = selectedProfile.subscriptionName || selectedProfile.subscriptionId || '';
        if (sub) detail += '<div><span style="color:var(--rad-text-tertiary);">Subscription:</span> <strong style="color:var(--rad-text);">' + escapeHtmlClient(sub) + '</strong></div>';
    }
    if (selectedProfile.user) detail += '<div><span style="color:var(--rad-text-tertiary);">Signed in as</span> <strong style="color:var(--rad-text);">' + escapeHtmlClient(selectedProfile.user) + '</strong> <span style="color:var(--rad-primary);font-weight:600;">· ✓ Verified</span></div>';
    else detail += '<div><span style="color:var(--rad-primary);font-weight:600;">✓ Verified</span></div>';
    statusEl.style.display = '';
    statusEl.innerHTML = detail;
    if (idAz) idAz.style.display = prov === 'azure' ? '' : 'none';
    if (idAws) idAws.style.display = prov === 'aws' ? '' : 'none';
    document.getElementById('panel-azure').style.display = prov === 'azure' ? '' : 'none';
    document.getElementById('panel-aws').style.display = prov === 'aws' ? '' : 'none';
    deployBtn.disabled = false;
    var rb = document.getElementById(prov === 'aws' ? 'aws-refresh-btn' : 'azure-refresh-btn');
    if (rb) rb.disabled = false;
    discoverResources(prov, selectedProfile.subscriptionId, selectedProfile.tenantId);
}
['azure-refresh-btn','aws-refresh-btn'].forEach(function(id){
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function(){
        if (!selectedProfile) return;
        var prov = selectedProfile.provider === 'aws' ? 'aws' : 'azure';
        discoverResources(prov, selectedProfile.subscriptionId, selectedProfile.tenantId);
    });
});
// Shared-identity pin helpers. The pin (az-selected-app-id) makes this repo
// reuse another app's identity — deliberately wider blast radius, so it must
// be cleared on any fresh form or context change and be explicitly reversible.
function clearSharedAppPin() {
    var hid = document.getElementById('az-selected-app-id');
    if (hid) hid.value = '';
    var note = document.getElementById('az-selected-app-note');
    if (note) { note.style.display = 'none'; note.textContent = ''; }
    var clearLink = document.getElementById('az-clear-pin-link');
    if (clearLink) clearLink.style.display = 'none';
    var nameEl = document.getElementById('az-app-name-input');
    if (nameEl) {
        nameEl.value = nameEl.getAttribute('data-default-name') || '';
        nameEl.disabled = false;
        nameEl.style.opacity = '';
    }
}
(function(){
    var clearLink = document.getElementById('az-clear-pin-link');
    if (clearLink) clearLink.addEventListener('click', function(e){ e.preventDefault(); clearSharedAppPin(); });
})();
// Opt-in "use an existing application" (advanced, non-default): lists ALL
// App Registrations the user owns and lets them deliberately share one across
// repos. A shared deploy identity has a wider blast radius, so this is never
// reached automatically — only via this explicit action.
(function(){
    var link = document.getElementById('az-use-existing-link');
    if (!link) return;
    link.addEventListener('click', function(e){
        e.preventDefault();
        var note = document.getElementById('az-selected-app-note');
        link.textContent = 'Loading applications…';
        fetch('/api/list-azure-app-registrations').then(function(r){ return r.json(); }).then(function(data){
            link.textContent = 'Use an existing application…';
            if (data.error) { if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-danger,#cf222e)'; note.textContent = 'Could not list applications: ' + data.error; } return; }
            var apps = data.apps || [];
            if (!apps.length) { if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-danger,#cf222e)'; note.textContent = 'You do not own any App Registrations yet — create one instead.'; } return; }
            showAppPicker({
                title: 'Use an existing application',
                intro: 'Select an App Registration you already own to reuse as this repository\u2019s deploy identity.',
                caution: 'Sharing one identity across repositories means every wired repository can use its Azure permissions. Only do this for repos that belong to the same product.',
                candidates: apps,
                defaultAppId: '',
                allowCreateNew: false
            }).then(function(choice){
                var hid = document.getElementById('az-selected-app-id');
                if (hid && choice.appId) hid.value = choice.appId;
                var picked = apps.filter(function(a){ return a.appId === choice.appId; })[0];
                if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-info,#0969da)'; note.textContent = 'Will reuse: ' + ((picked && picked.displayName) || choice.appId) + ' (' + choice.appId + ').'; }
                var clearLink = document.getElementById('az-clear-pin-link');
                if (clearLink) clearLink.style.display = 'inline';
                var nameEl = document.getElementById('az-app-name-input');
                if (nameEl) {
                    nameEl.value = (picked && picked.displayName) || choice.appId;
                    nameEl.disabled = true;
                    nameEl.style.opacity = '0.6';
                }
            }).catch(function(){ /* cancelled */ });
        }).catch(function(err){
            link.textContent = 'Use an existing application…';
            if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-danger,#cf222e)'; note.textContent = 'Could not list applications: ' + (err && err.message || err); }
        });
    });
})();
document.getElementById('new-env-btn').addEventListener('click', function() { showEnvForm({ name: '' }); });
document.getElementById('cancel-env-btn').addEventListener('click', showEnvLanding);
document.getElementById('env-create-profile-link').addEventListener('click', function(e) {
    e.preventDefault(); openProfileMenu(false); switchSubtab('credentials'); showCredForm();
});

// combo select: reveal custom input on "__custom__"
function setupCombo(selectId, customId) {
    var sel = document.getElementById(selectId);
    var inp = document.getElementById(customId);
    if (!sel || !inp) return;
    sel.addEventListener('change', function() {
        inp.style.display = this.value === '__custom__' ? '' : 'none';
        if (this.value === '__custom__') inp.focus();
    });
}
['azure-cluster-select|azure-cluster-custom','azure-rg-select|azure-rg-custom','azure-namespace-select|azure-namespace-custom',
 'aws-cluster-select|aws-cluster-custom','aws-namespace-select|aws-namespace-custom','aws-vpc-select|aws-vpc-custom','aws-subnets-select|aws-subnets-custom']
 .forEach(function(pair) { var p = pair.split('|'); setupCombo(p[0], p[1]); });

function populateSelect(selectId, items, placeholder) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    if (items.length === 0) {
        var opt = document.createElement('option');
        opt.value = ''; opt.disabled = true; opt.selected = true; opt.textContent = 'No resources found';
        sel.appendChild(opt);
    } else {
        var ph = document.createElement('option');
        ph.value = ''; ph.disabled = true; ph.selected = true; ph.textContent = placeholder || 'Select...';
        sel.appendChild(ph);
        for (var i = 0; i < items.length; i++) {
            var o = document.createElement('option');
            o.value = items[i].id || items[i];
            o.textContent = items[i].name || items[i].id || items[i];
            sel.appendChild(o);
        }
    }
    var custom = document.createElement('option');
    custom.value = '__custom__'; custom.textContent = '+ Enter custom...';
    sel.appendChild(custom);
}
// Case-insensitive sort by display name so discovered resource lists render in
// a predictable order in the dropdowns.
function sortByName(items) {
    return (items || []).slice().sort(function(a, b) {
        var an = String((a && (a.name || a.id)) || a).toLowerCase();
        var bn = String((b && (b.name || b.id)) || b).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
    });
}
// Populate the AKS cluster dropdown from a (possibly RG-filtered) list, keeping
// the current selection when it is still present in the new list.
function renderAzureClusters(list, keepValue) {
    populateSelect('azure-cluster-select', list, 'Select AKS cluster…');
    if (!keepValue) return;
    var sel = document.getElementById('azure-cluster-select');
    for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === keepValue) { sel.value = keepValue; break; }
    }
}
function setupAzureInfraFilter() {
    var clusterSel = document.getElementById('azure-cluster-select');
    var rgSel = document.getElementById('azure-rg-select');
    if (!clusterSel || !rgSel || clusterSel.__filterWired) return;
    clusterSel.__filterWired = true;
    function findCluster(cid) {
        var list = window.__azureClusters || [];
        for (var i = 0; i < list.length; i++) { if ((list[i].id || list[i].name) === cid) return list[i]; }
        return null;
    }
    // Selecting a resource group limits the cluster dropdown to the AKS clusters
    // that live in that resource group. A custom-typed or empty RG shows them all.
    rgSel.addEventListener('change', function() {
        var rg = rgSel.value;
        var all = window.__azureClusters || [];
        if (rg === '' || rg === '__custom__') { renderAzureClusters(all, clusterSel.value); return; }
        var filtered = [];
        for (var i = 0; i < all.length; i++) { if ((all[i].resourceGroup || '') === rg) filtered.push(all[i]); }
        var keep = '';
        for (var j = 0; j < filtered.length; j++) { if ((filtered[j].id || filtered[j].name) === clusterSel.value) { keep = clusterSel.value; break; } }
        renderAzureClusters(filtered, keep);
    });
    // Selecting a cluster back-fills its resource group so the two stay linked.
    clusterSel.addEventListener('change', function() {
        var cid = clusterSel.value;
        if (cid === '__custom__' || cid === '') return;
        var cluster = findCluster(cid);
        if (!cluster || !cluster.resourceGroup) return;
        var hasRg = false, customOpt = null;
        for (var i = 0; i < rgSel.options.length; i++) {
            if (rgSel.options[i].value === cluster.resourceGroup) hasRg = true;
            if (rgSel.options[i].value === '__custom__') customOpt = rgSel.options[i];
        }
        if (!hasRg) {
            var opt = document.createElement('option');
            opt.value = cluster.resourceGroup; opt.textContent = cluster.resourceGroup;
            if (customOpt) rgSel.insertBefore(opt, customOpt); else rgSel.appendChild(opt);
        }
        rgSel.value = cluster.resourceGroup;
    });
}
function discoverResources(provider, subId, tenantId) {
    var payload = { provider: provider };
    if (subId) payload.subscriptionId = subId;
    if (tenantId) payload.tenantId = tenantId;
    var statusId = provider === 'azure' ? 'azure-discover-status' : 'aws-discover-status';
    var statusEl = document.getElementById(statusId);
    if (statusEl) statusEl.textContent = 'Discovering resources…';
    fetch('/api/discover', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (provider === 'azure') {
                if (statusEl) statusEl.textContent = discoverStatusText(data, 'azure');
                window.__azureClusters = sortByName(data.clusters || []);
                renderAzureClusters(window.__azureClusters, '');
                populateSelect('azure-rg-select', sortByName(data.resourceGroups || []), 'Select resource group…');
                populateSelect('azure-namespace-select', sortByName(data.namespaces || ['default','kube-system','radius-system']), 'Select namespace…');
                setupAzureInfraFilter();
            } else {
                if (statusEl) statusEl.textContent = discoverStatusText(data, 'aws');
                populateSelect('aws-cluster-select', sortByName(data.clusters || []), 'Select EKS cluster…');
                populateSelect('aws-namespace-select', sortByName(data.namespaces || ['default','kube-system','radius-system']), 'Select namespace…');
                populateSelect('aws-vpc-select', [{id:'', name:'None (optional)'}].concat(data.vpcs || []), 'Select VPC…');
                populateSelect('aws-subnets-select', [{id:'', name:'None (optional)'}].concat(data.subnets || []), 'Select subnets…');
            }
        })
        .catch(function(e) { if (statusEl) statusEl.textContent = 'Discovery error: ' + e.message; });
}
function getComboValue(selectId, customId) {
    var sel = document.getElementById(selectId);
    if (sel.value === '__custom__') return document.getElementById(customId).value;
    return sel.value;
}
// Look up a discovered AKS cluster's own resource group by its selected id/name.
// Returns '' when the cluster was typed by hand (not in the discovery list), so
// the server falls back to the deployment resource group.
function findAzureClusterResourceGroup(clusterId) {
    var list = window.__azureClusters || [];
    for (var i = 0; i < list.length; i++) {
        if ((list[i].id || list[i].name) === clusterId) return list[i].resourceGroup || '';
    }
    return '';
}
// Prompt for a Service Management Reference (GUID) via the modal; resolves the
// entered GUID or rejects if the user cancels.
function promptSmr() {
    var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    var modal = document.getElementById('env-smr-modal');
    var input = document.getElementById('env-smr-input');
    var errEl = document.getElementById('env-smr-error');
    var retryBtn = document.getElementById('env-smr-retry');
    var cancelBtn = document.getElementById('env-smr-cancel');
    input.value = ''; errEl.style.display = 'none';
    modal.style.display = 'flex';
    input.focus();
    return new Promise(function(resolve, reject) {
        function cleanup() {
            modal.style.display = 'none';
            retryBtn.removeEventListener('click', onRetry);
            cancelBtn.removeEventListener('click', onCancel);
        }
        function onRetry() {
            var smr = input.value.trim();
            if (!UUID_RE.test(smr)) {
                errEl.textContent = 'Enter a valid GUID.';
                errEl.style.display = 'block';
                return;
            }
            cleanup();
            resolve(smr);
        }
        function onCancel() { cleanup(); var error = new Error('Service Management Reference is required to continue.'); error.abandonOperation = true; reject(error); }
        retryBtn.addEventListener('click', onRetry);
        cancelBtn.addEventListener('click', onCancel);
    });
}

// Single source of truth: these two pure helpers are authored and unit-tested
// in azure-oidc.ts, then serialized into this browser bundle so the SHIPPING
// client runs the exact tested code instead of a hand-copied twin. Assign each
// helper to its stable browser name explicitly: the Node bundle is minified, so
// Function#toString returns mangled declaration names even with keepNames=true.
// Function declarations inside the assigned expression remain self-contained.
${serializeBrowserFunction("formatServesReposLabel", formatServesReposLabel)}
${serializeBrowserFunction("discoverStatusText", discoverStatusText)}

// Render the identity picker. opts.candidates is a list of
// {appId, displayName, createdDateTime, servesRepos?}. Resolves with
// {appId} or {createNew:true}; rejects on cancel.
function showAppPicker(opts) {
    var modal = document.getElementById('env-appselect-modal');
    var titleEl = document.getElementById('env-appselect-title');
    var introEl = document.getElementById('env-appselect-intro');
    var cautionEl = document.getElementById('env-appselect-caution');
    var listEl = document.getElementById('env-appselect-list');
    var errEl = document.getElementById('env-appselect-error');
    var confirmBtn = document.getElementById('env-appselect-confirm');
    var cancelBtn = document.getElementById('env-appselect-cancel');
    titleEl.textContent = opts.title || 'Choose a deploy identity';
    introEl.textContent = opts.intro || '';
    if (opts.caution) { cautionEl.textContent = opts.caution; cautionEl.style.display = 'block'; }
    else { cautionEl.style.display = 'none'; }
    errEl.style.display = 'none';
    listEl.innerHTML = '';
    var candidates = opts.candidates || [];
    var chosen = { value: opts.defaultAppId || (candidates[0] && candidates[0].appId) || '' };
    // appId -> row body element still awaiting its lazy "Serves:" label.
    var servesSlots = {};
    function appendServes(bodyEl, text) {
        var line3 = document.createElement('div');
        line3.style.cssText = 'font-size:11px; color:var(--rad-info,#0969da); margin-top:2px; word-break:break-all;';
        line3.textContent = text;
        bodyEl.appendChild(line3);
    }

    function row(value, primary, secondary, serves) {
        var id = 'appsel-' + (value || 'create');
        var label = document.createElement('label');
        label.setAttribute('for', id);
        label.style.cssText = 'display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--rad-stroke); border-radius:8px; cursor:pointer;';
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'appsel'; radio.id = id; radio.value = value;
        radio.style.marginTop = '2px';
        if (value === chosen.value) radio.checked = true;
        radio.addEventListener('change', function() { chosen.value = value; });
        var body = document.createElement('div');
        body.style.minWidth = '0';
        var line1 = document.createElement('div');
        line1.style.cssText = 'font-size:13px; font-weight:600; color:var(--rad-text); word-break:break-all;';
        line1.textContent = primary;
        body.appendChild(line1);
        if (secondary) {
            var line2 = document.createElement('div');
            line2.style.cssText = 'font-size:11px; color:var(--rad-text-tertiary); margin-top:2px; word-break:break-all;';
            line2.textContent = secondary;
            body.appendChild(line2);
        }
        var servesText = formatServesReposLabel(serves);
        if (servesText) {
            appendServes(body, servesText);
        } else if (value && value !== '__create__') {
            // No server-provided label: remember the row so it can be filled
            // lazily once /api/azure-app-serves-repos resolves for this app.
            servesSlots[value] = body;
        }
        label.appendChild(radio);
        label.appendChild(body);
        listEl.appendChild(label);
    }

    candidates.forEach(function(c) {
        var created = c.createdDateTime ? ('created ' + String(c.createdDateTime).slice(0, 10) + ' · ') : '';
        row(c.appId, c.displayName || c.appId, created + c.appId, c.servesRepos);
    });
    if (opts.allowCreateNew) {
        row('__create__', 'Create a new application instead', 'A fresh per-repo deploy identity that only this repository can use.');
        if (!chosen.value) chosen.value = '__create__';
    }

    // Lazy-load the per-app "Serves:" labels so the picker renders immediately
    // instead of blocking on one az federated-credential list per owned app.
    // Bounded concurrency; each label is best-effort and skipped on failure or
    // if its row was replaced by a later picker.
    (function loadServesLabels() {
        var pending = Object.keys(servesSlots);
        if (!pending.length) return;
        var pos = 0;
        var CONC = 6;
        function pump() {
            if (pos >= pending.length) return;
            var appId = pending[pos++];
            var bodyEl = servesSlots[appId];
            fetch('/api/azure-app-serves-repos?appId=' + encodeURIComponent(appId))
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    var text = formatServesReposLabel(d && d.servesRepos);
                    if (text && bodyEl && bodyEl.isConnected) appendServes(bodyEl, text);
                })
                .catch(function() { /* label is best-effort */ })
                .then(function() { pump(); });
        }
        for (var i = 0; i < Math.min(CONC, pending.length); i++) pump();
    })();

    modal.style.display = 'flex';
    return new Promise(function(resolve, reject) {
        function cleanup() {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        }
        function onConfirm() {
            if (!chosen.value) {
                errEl.textContent = 'Select an application or choose to create a new one.';
                errEl.style.display = 'block';
                return;
            }
            cleanup();
            if (chosen.value === '__create__') resolve({ createNew: true });
            else resolve({ appId: chosen.value });
        }
        function onCancel() { cleanup(); var error = new Error('Identity selection cancelled.'); error.abandonOperation = true; reject(error); }
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

deployBtn.addEventListener('click', function() {
    var btn = this;
    var statusEl = document.getElementById('deploy-status');
    function fail(msg) { statusEl.style.display = 'block'; statusEl.className = 'status error'; statusEl.textContent = msg; }
    if (!selectedProfile) { fail('Please select a credential profile.'); return; }
    var env = envNameInput.value.trim();
    if (!env) { fail('Please enter an environment name.'); return; }
    var provider = selectedProfile.provider === 'aws' ? 'aws' : 'azure';
    var targetRepo = document.getElementById('target-repo').value.trim();
    if (!targetRepo) { fail('Please specify a target repository (owner/repo).'); return; }
    var cluster, namespace, vpc, subnets, resourceGroup, clusterResourceGroup;
    if (provider === 'azure') {
        cluster = getComboValue('azure-cluster-select', 'azure-cluster-custom');
        namespace = getComboValue('azure-namespace-select', 'azure-namespace-custom') || 'default';
        resourceGroup = getComboValue('azure-rg-select', 'azure-rg-custom');
        if (!resourceGroup) { fail('Please specify a resource group.'); return; }
        if (!cluster) { fail('Please specify an AKS cluster.'); return; }
        // Capture the cluster's OWN resource group from discovery, independent of
        // the editable RG combo above, so the AKS Cluster Admin grant is scoped to
        // the cluster's real path even if the deployment RG differs. Empty for a
        // custom-typed cluster that never came from discovery.
        clusterResourceGroup = findAzureClusterResourceGroup(cluster);
    } else {
        cluster = getComboValue('aws-cluster-select', 'aws-cluster-custom');
        namespace = getComboValue('aws-namespace-select', 'aws-namespace-custom') || 'default';
        vpc = getComboValue('aws-vpc-select', 'aws-vpc-custom');
        subnets = getComboValue('aws-subnets-select', 'aws-subnets-custom');
        if (!cluster) { fail('Please specify an EKS cluster.'); return; }
    }

    btn.textContent = 'Creating environment…';
    btn.disabled = true;
    statusEl.style.display = 'none';
    var staleWarn = document.getElementById('env-warning-banner');
    if (staleWarn) staleWarn.style.display = 'none';
    var label = providerLabel(provider);
    // The panel and the operation record own the narration now; this only has to
    // say what went wrong. The panel is deliberately left on screen with its step
    // history intact — collapsing a twenty-five step operation into one red
    // sentence is what destroyed the context before.
    //
    // The message goes to the landing's error banner, not the form's status line:
    // by the time this runs the user is on the landing, and the form's status
    // element is hidden, so writing there would say nothing at all.
    function failEnv(msg) {
        stopEnvProgress();
        btn.textContent = 'Create Environment'; btn.disabled = false;
        statusEl.style.display = 'none';
        var panel = document.getElementById('env-progress-panel');
        if (panel) {
            panel.classList.remove('env-progress--done');
            panel.classList.add('env-progress--failed');
            var activityEl = document.getElementById('env-progress-activity');
            if (activityEl) activityEl.textContent = msg;
            var detailsEl = document.getElementById('env-progress-details');
            if (detailsEl) detailsEl.open = true;
        }
        showEnvError(msg);
    }
    if (provider === 'azure' && (!(selectedProfile.subscriptionId || '').trim() || !(selectedProfile.tenantId || '').trim())) {
        // Still a form-level error, so it belongs on the form, which is still on
        // screen: nothing has started yet.
        btn.textContent = 'Create Environment'; btn.disabled = false;
        fail('The selected profile needs both a tenant ID and subscription ID. Edit the profile before creating the environment.');
        return;
    }

    // Everything below mutates cloud and GitHub state, so this is the moment the
    // operation begins. Show the landing now: creation takes minutes, and the
    // user should be free to watch the panel, look at the graph, or leave
    // entirely — the record on the server is what lets them come back to any of
    // it.
    showEnvLanding();
    hideEnvTerminalBanners();
    renderEnvProgress({
        summary: 'Creating ' + env + '…', provider: provider, environment: env,
        stages: [], steps: [], terminalState: null, failure: null, startedAt: new Date().toISOString(),
    });
    focusEnvProgressPanel();

    var appNameEl = document.getElementById('az-app-name-input');
    var selectedAppId = (document.getElementById('az-selected-app-id') || {}).value || '';
    var envData = {
            repo: targetRepo,
            environment: env,
            provider: provider,
            cluster: cluster,
            namespace: namespace,
            profileName: selectedProfile.name,
            origin: 'environment',
            resumeTarget: { page: 'planned', repo: targetRepo, branch: CTX_BRANCH },
            resumeBranch: CTX_BRANCH,
            resumeReason: 'View planned graph'
    };
    envData.branch = (document.getElementById('deploy-branch-select') || {}).value || 'main';
    if (provider === 'azure') {
        envData.clientId = document.getElementById('az-client-id').value.trim();
        envData.tenantId = selectedProfile.tenantId || '';
        envData.subscriptionId = selectedProfile.subscriptionId || '';
        envData.resourceGroup = resourceGroup;
        envData.clusterResourceGroup = clusterResourceGroup;
        envData.appName = appNameEl ? appNameEl.value.trim() : '';
        envData.appId = selectedAppId;
    } else {
        envData.roleArn = selectedProfile.roleArn || '';
        envData.region = selectedProfile.region || '';
        envData.accountId = selectedProfile.accountId || '';
        envData.vpcId = vpc; envData.subnetIds = subnets;
    }
    fetch('/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envData) })
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
            .then(function(startResult) {
                var envResult = startResult.d || {};
                if (envResult.error) {
                    stopEnvProgress();
                    btn.textContent = 'Create Environment'; btn.disabled = false;
                    statusEl.style.display = 'none';
                    syncEnvFailureOperation(envResult)
                        .then(function(rendered) {
                            if (!rendered) failEnv('Environment setup failed: ' + envResult.error);
                        });
                    return;
                }
                envProgressTimer = setTimeout(function() {
                    trackEnvProgress(targetRepo, env, provider, function(finished) {
                        applyEnvTerminal(finished);
                    });
                }, 0);
            })
    .catch(function(err) {
        stopEnvProgress();
        btn.textContent = 'Create Environment'; btn.disabled = false;
        statusEl.style.display = 'none';
        syncEnvFailureOperation(err)
            .then(function(rendered) {
                if (!rendered) failEnv('Failed: ' + (err.message || 'unknown error'));
            });
    });
});

// ============================ Credentials =============================
var credLanding = document.getElementById('cred-landing');
var credForm = document.getElementById('cred-form');
var credProviderSelect = document.getElementById('cred-provider-select');
var credVerified = null;
var credPackagesVerified = false;
var credGhChecking = false;

function loadCredTable() {
    var body = document.getElementById('cred-table-body');
    if (!CTX_REPO) {
        body.innerHTML = '<tr><td class="rad-table__env">No credential profiles created yet.</td><td></td><td></td><td class="rad-table__actions"></td></tr>';
        return;
    }
    body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading credential profiles…</td></tr>';
    fetch('/api/credential-profiles?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var profiles = (d && d.profiles) || [];
            if (profiles.length === 0) {
                body.innerHTML = '<tr><td class="rad-table__env">No credential profiles created yet.</td><td></td><td></td><td class="rad-table__actions"></td></tr>';
                return;
            }
            body.innerHTML = profiles.map(function(p) {
                return '<tr>' +
                    '<td class="rad-table__env">' + escapeHtmlClient(p.name) + '</td>' +
                    '<td class="rad-table__provider">' + escapeHtmlClient(providerLabel(p.provider)) + '</td>' +
                    '<td>' + statusCell(p.status || 'verified') + '</td>' +
                    '<td class="rad-table__actions">' +
                        '<a class="rad-link js-cred-edit" href="#" data-name="' + escapeHtmlClient(p.name) + '">edit</a>' +
                        '<button class="rad-btn rad-btn--neutral js-cred-createenv" data-name="' + escapeHtmlClient(p.name) + '" style="margin:0;">Create Env</button>' +
                        '<button class="rad-btn rad-btn--danger-outline js-cred-delete" data-name="' + escapeHtmlClient(p.name) + '" style="margin:0;">Delete Profile</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
            wireCredRowActions(profiles);
        })
        .catch(function() {
            body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Could not load credential profiles.</td></tr>';
        });
}
function wireCredRowActions(profiles) {
    function find(name) { for (var i = 0; i < profiles.length; i++) { if (profiles[i].name === name) return profiles[i]; } return null; }
    document.querySelectorAll('.js-cred-createenv').forEach(function(btn) {
        btn.addEventListener('click', function() { switchSubtab('environments'); showEnvForm({ name: '', profile: this.getAttribute('data-name') }); });
    });
    document.querySelectorAll('.js-cred-edit').forEach(function(a) {
        a.addEventListener('click', function(e) { e.preventDefault(); showCredForm(find(this.getAttribute('data-name'))); });
    });
    document.querySelectorAll('.js-cred-delete').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var name = this.getAttribute('data-name') || '';
            if (!name || !confirm('Delete credential profile "' + name + '"?')) return;
            this.disabled = true; this.textContent = 'Deleting…';
            fetch('/api/delete-credential-profile', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, name: name }) })
                .then(function(r) { return r.json(); }).then(function() { loadCredTable(); })
                .catch(function() { loadCredTable(); });
        });
    });
}

function applyCredProvider(p) {
    var isAws = p === 'aws';
    document.getElementById('cred-panel-azure').style.display = isAws ? 'none' : '';
    document.getElementById('cred-panel-aws').style.display = isAws ? '' : 'none';
}
credProviderSelect.addEventListener('change', function() { applyCredProvider(this.value); resetCredVerify(); });

function resetCredVerify() {
    credVerified = null;
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'none'; st.innerHTML = '';
    document.getElementById('cred-verify-hint').style.display = '';
    updateCredSaveState();
}
function updateCredSaveState() {
    document.getElementById('save-cred-btn').disabled = !(credVerified && credPackagesVerified);
}
function renderCredGitHubAccess(id) {
    var status = document.getElementById('cred-ghcr-status');
    var commandRow = document.getElementById('cred-ghcr-command-row');
    var command = document.getElementById('cred-ghcr-command');
    var retry = document.getElementById('cred-ghcr-retry');
    credPackagesVerified = !!(id && id.actingLogin && id.actingHasPackages);
    commandRow.style.display = 'none';
    retry.style.display = 'none';
    if (!id || id.error || !id.actingLogin) {
        status.textContent = 'Could not detect a GitHub CLI account. Sign in with gh auth login, then retry.';
        status.style.color = 'var(--rad-danger)';
    } else if (credPackagesVerified) {
        status.innerHTML = '✓ GitHub Packages access verified for <strong>@' + escapeHtmlClient(id.actingLogin) + '</strong>.';
        status.style.color = 'var(--rad-primary)';
    } else {
        var refreshCmd = 'gh auth switch -h github.com -u ' + id.actingLogin +
            ' && gh auth refresh -h github.com -s read:packages -s write:packages';
        status.innerHTML = 'The active account <strong>@' + escapeHtmlClient(id.actingLogin) +
            '</strong> cannot publish packages. Run the command below, complete the GitHub authorization, then retry. <strong>Note:</strong> <code>gh auth switch</code> changes the active account machine-wide until you switch back.';
        status.style.color = 'var(--rad-warning, #9a6700)';
        command.textContent = refreshCmd;
        commandRow.style.display = 'flex';
        retry.style.display = '';
    }
    updateCredSaveState();
}
function loadCredGitHubAccess(fresh) {
    if (credGhChecking) return;
    credGhChecking = true;
    var status = document.getElementById('cred-ghcr-status');
    var retry = document.getElementById('cred-ghcr-retry');
    status.textContent = 'Checking GitHub Packages access…';
    status.style.color = 'var(--rad-text-tertiary)';
    if (retry) { retry.disabled = true; retry.textContent = 'Checking…'; }
    var url = '/api/github-identity' + (fresh ? '?fresh=1' : '');
    fetch(url)
        .then(function(r) { return r.json(); })
        .then(renderCredGitHubAccess)
        .catch(function(err) { renderCredGitHubAccess({ error: err && err.message ? err.message : 'GitHub identity check failed' }); })
        .then(function() {
            credGhChecking = false;
            if (retry) { retry.disabled = false; retry.textContent = 'I’ve updated permissions — retry'; }
        });
}
function showCredForm(profile) {
    document.getElementById('cred-success-banner').style.display = 'none';
    var editing = profile && profile.name;
    document.getElementById('cred-name-input').value = editing ? profile.name : '';
    credProviderSelect.value = editing ? (profile.provider || 'azure') : 'azure';
    applyCredProvider(credProviderSelect.value);
    document.getElementById('az-tenant-id').value = editing ? (profile.tenantId || '') : '';
    document.getElementById('az-sub-id').value = editing ? (profile.subscriptionId || '') : '';
    var acc = document.getElementById('aws-account-id'); if (acc) acc.value = editing ? (profile.accountId || '') : '';
    var reg = document.getElementById('aws-region'); if (reg) reg.value = editing ? (profile.region || '') : '';
    var role = document.getElementById('aws-role-arn'); if (role) role.value = editing ? (profile.roleArn || '') : '';
    resetCredVerify();
    credPackagesVerified = false;
    updateCredSaveState();
    credLanding.style.display = 'none';
    credForm.style.display = '';
    loadCredGitHubAccess(true);
    document.getElementById('cred-name-input').focus();
}
function showCredLanding() {
    credForm.style.display = 'none';
    credLanding.style.display = '';
    loadCredTable();
}
function showCredSuccessBanner(name) {
    var banner = document.getElementById('cred-success-banner');
    document.getElementById('cred-success-banner-text').innerHTML = 'Successfully created credential profile ' + escapeHtmlClient(name);
    banner.style.display = 'flex';
}
document.getElementById('new-cred-btn').addEventListener('click', function() { showCredForm(); });
document.getElementById('cancel-cred-btn').addEventListener('click', showCredLanding);
var credSuccessClose = document.getElementById('cred-success-banner-close');
if (credSuccessClose) credSuccessClose.addEventListener('click', function() { document.getElementById('cred-success-banner').style.display = 'none'; });

function markVerified(user, extra) {
    credVerified = extra || {};
    credVerified.user = user || '';
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'flex';
    st.innerHTML = '<span class="rad-verified-pill">✓ Credentials verified</span>' +
        (user ? '<span class="rad-verified-meta">Logged in as <strong>' + escapeHtmlClient(user) + '</strong></span>' : '');
    document.getElementById('cred-verify-hint').style.display = 'none';
    updateCredSaveState();
}

var credGhRetry = document.getElementById('cred-ghcr-retry');
if (credGhRetry) credGhRetry.addEventListener('click', function() { loadCredGitHubAccess(true); });
var credGhCopy = document.getElementById('cred-ghcr-copy');
if (credGhCopy) credGhCopy.addEventListener('click', function() {
    var command = document.getElementById('cred-ghcr-command').textContent || '';
    var done = function() {
        credGhCopy.textContent = 'Copied';
        setTimeout(function() { credGhCopy.textContent = 'Copy command'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(done).catch(function() {});
    }
});

function credVerifyError(msg) {
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'block';
    st.innerHTML = '<span style="color:var(--rad-danger);">' + escapeHtmlClient(msg) + '</span>';
}

function credVerifyInfo(msg) {
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'block';
    st.innerHTML = '<span>' + escapeHtmlClient(msg) + '</span>';
}

function requestAzureCliAssist(action, tenantId, fallbackMessage) {
    fetch('/api/azure-cli-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, tenantId: tenantId || '' })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.error) {
            credVerifyError(data.error + (fallbackMessage ? ' ' + fallbackMessage : ''));
            return;
        }
        credVerifyInfo((data && data.message) || 'Copilot is helping with Azure CLI setup. After it finishes, click Verify Credentials again.');
    }).catch(function(err) {
        credVerifyError('Error: ' + err.message + (fallbackMessage ? ' ' + fallbackMessage : ''));
    });
}

var pendingAzureCliAssist = null;
function showAzureCliAssistPrompt(action, tenantId, fallbackMessage) {
    pendingAzureCliAssist = {
        action: action,
        tenantId: tenantId || '',
        fallbackMessage: fallbackMessage || ''
    };
    var isInstall = action === 'install';
    document.getElementById('azure-cli-assist-title').textContent = isInstall ? 'Install Azure CLI?' : 'Start Azure login?';
    document.getElementById('azure-cli-assist-message').textContent = isInstall
        ? 'Azure CLI is not installed. Would you like Copilot to attempt to install it and then start Azure login?'
        : 'No active Azure session was found. Would you like Copilot to start the Azure login flow?';
    document.getElementById('azure-cli-assist-confirm').textContent = isInstall ? 'Ask Copilot to install' : 'Start Azure login';
    document.getElementById('azure-cli-assist-modal').style.display = 'flex';
    document.getElementById('azure-cli-assist-confirm').focus();
}

function closeAzureCliAssistPrompt() {
    document.getElementById('azure-cli-assist-modal').style.display = 'none';
    pendingAzureCliAssist = null;
}

document.getElementById('azure-cli-assist-cancel').addEventListener('click', function() {
    var fallbackMessage = pendingAzureCliAssist && pendingAzureCliAssist.fallbackMessage;
    closeAzureCliAssistPrompt();
    if (fallbackMessage) credVerifyError(fallbackMessage);
});

document.getElementById('azure-cli-assist-confirm').addEventListener('click', function() {
    var request = pendingAzureCliAssist;
    closeAzureCliAssistPrompt();
    if (request) requestAzureCliAssist(request.action, request.tenantId, request.fallbackMessage);
});

document.getElementById('btn-verify-azure').addEventListener('click', function() {
    var btn = this;
    var profileName = document.getElementById('cred-name-input').value.trim();
    var tenantId = document.getElementById('az-tenant-id').value.trim();
    var subId = document.getElementById('az-sub-id').value.trim();
    var modal = document.getElementById('env-verify-modal');
    var titleEl = document.getElementById('env-verify-title');
    resetCredVerify();
    if (!profileName) { credVerifyError('Please enter a Profile Name before verifying.'); return; }
    if (!tenantId || !subId) { credVerifyError('Please enter both a Tenant ID and a Subscription ID before verifying.'); return; }
    btn.disabled = true; btn.textContent = '⏳ Verifying…';
    if (titleEl) titleEl.textContent = 'Verifying authentication to Azure…';
    modal.style.display = 'flex';
    fetch('/api/verify-azure-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: tenantId, subscriptionId: subId }) })
        .then(function(r) { return r.json(); }).then(function(data) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            if (data.error) {
                if (data.code === 'az-login-required') {
                    showAzureCliAssistPrompt('login', data.tenantId || tenantId, data.error);
                    return;
                }
                if (data.code === 'az-cli-missing') {
                    showAzureCliAssistPrompt('install', data.tenantId || tenantId, data.error);
                    return;
                }
                credVerifyError(data.error);
                return;
            }
            if (data.tenantId) document.getElementById('az-tenant-id').value = data.tenantId;
            if (data.subscriptionId) document.getElementById('az-sub-id').value = data.subscriptionId;
            markVerified(data.user, { tenantId: data.tenantId || tenantId, subscriptionId: data.subscriptionId || subId, subscriptionName: data.subscriptionName || '' });
        }).catch(function(err) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            credVerifyError('Error: ' + err.message);
        });
});

var verifyAwsBtn = document.getElementById('btn-verify-aws');
if (verifyAwsBtn) verifyAwsBtn.addEventListener('click', function() {
    var btn = this;
    var profileName = document.getElementById('cred-name-input').value.trim();
    var accountId = document.getElementById('aws-account-id').value.trim();
    var region = document.getElementById('aws-region').value.trim();
    var modal = document.getElementById('env-verify-modal');
    var titleEl = document.getElementById('env-verify-title');
    resetCredVerify();
    if (!profileName) { credVerifyError('Please enter a Profile Name before verifying.'); return; }
    btn.disabled = true; btn.textContent = '⏳ Verifying…';
    if (titleEl) titleEl.textContent = 'Verifying authentication to AWS…';
    modal.style.display = 'flex';
    fetch('/api/verify-aws-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: accountId, region: region }) })
        .then(function(r) { return r.json(); }).then(function(data) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            if (data.error) { credVerifyError(data.error); return; }
            if (data.accountId) document.getElementById('aws-account-id').value = data.accountId;
            markVerified(data.user || data.arn || '', { accountId: data.accountId || accountId, region: region });
        }).catch(function(err) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            credVerifyError('Error: ' + err.message);
        });
});

document.getElementById('save-cred-btn').addEventListener('click', function() {
    var btn = this;
    var name = document.getElementById('cred-name-input').value.trim();
    if (!name) { alert('Please enter a profile name.'); return; }
    if (!credVerified) { alert('Please verify your credentials first.'); return; }
    var provider = credProviderSelect.value;
    var profile = { repo: CTX_REPO, name: name, provider: provider, user: credVerified.user || '' };
    if (provider === 'azure') { profile.tenantId = credVerified.tenantId || ''; profile.subscriptionId = credVerified.subscriptionId || ''; profile.subscriptionName = credVerified.subscriptionName || ''; }
    else { profile.accountId = credVerified.accountId || ''; profile.region = credVerified.region || ''; profile.roleArn = document.getElementById('aws-role-arn').value.trim(); }
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch('/api/save-credential-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })
        .then(function(r) { return r.json(); }).then(function(d) {
            btn.disabled = false; btn.textContent = 'Save Credential Profile';
            if (d && d.error) { alert('Could not save profile: ' + d.error); return; }
            showCredLanding(); showCredSuccessBanner(name);
        }).catch(function(err) {
            btn.disabled = false; btn.textContent = 'Save Credential Profile';
            alert('Could not save profile: ' + err.message);
        });
});

// ============================ Init =============================
if (document.getElementById('pane-credentials').style.display !== 'none') { loadCredTable(); } else { loadEnvTable(); }
// Rejoin an operation already in flight. Without this the panel would only ever
// exist for the tab that started the work, and a reload — or a trip to the graph
// and back — would look exactly like nothing was happening.
resumeEnvProgress(CTX_REPO);

// Deep link: '/?page=environment&new=1' opens the creation form directly
// (used by the Modeled graph's "Create Environment" call to action) rather
// than landing on the environments table. This runs after the resume call, but
// that call is asynchronous, so an operation still in flight wins and replaces
// the form with its progress once the lookup returns.
(function() {
    var wantsNew = false;
    try { wantsNew = new URLSearchParams(window.location.search).get('new') === '1'; } catch (e) { /* URLSearchParams unavailable */ }
    if (!wantsNew) return;
    switchSubtab('environments');
    showEnvForm({ name: '' });
})();
<\/script>`
  );
}

export function deployingPage(state: CanvasState = {}): string {
  // The Deployments tab is always the landing page (application + environment
  // selectors, a Deploy button, and a table of existing deployments). Live
  // deployment progress (graph + logs) is shown on the Applications → Deployed
  // tab instead, so navigating back here always shows the listing view.
  return deployLandingView(state);
}

function deployLandingView(state: CanvasState): string {
  const ctxRepo =
    state?.contextRepo ||
    state?.plannedRepo ||
    state?.graphTargetRepo ||
    state?.deployingRepo ||
    "";
  const ctxBranch =
    state?.contextBranch ||
    state?.plannedBranch ||
    state?.graphBranch ||
    "main";

  return pageShell(
    "Deployments",
    `
<div class="rad-heading">
  <h1>${radiusMark(26)}<span>Deployments</span></h1>
  <p class="rad-lede">Deploy your application to one of your configured environments. Radius will provision the necessary cloud infrastructure required to run your application.</p>
</div>

<div class="rad-deploy-controls">
  <div class="rad-field">
    <label for="deploy-app-select">Application:</label>
    <div class="rad-select-wrap"><select id="deploy-app-select"><option value="">Loading…</option></select></div>
  </div>
  <div class="rad-field">
    <label for="deploy-env-select">Environment:</label>
    <div class="rad-select-wrap"><select id="deploy-env-select"><option value="">Loading…</option></select></div>
  </div>
  <div class="rad-field">
    <label for="deploy-branch-select">Branch:</label>
    <div class="rad-select-wrap"><select id="deploy-branch-select"><option value="${escapeHtml(
      ctxBranch
    )}">${escapeHtml(ctxBranch)}</option></select></div>
  </div>
  <button id="deploy-now-btn" class="rad-btn rad-btn--primary" style="margin:0;" disabled>Deploy</button>
</div>

<div id="deploy-inline-status" class="rad-inline" style="display:none; margin:0 0 14px; padding:10px 14px; border-radius:8px; font-size:14px;"></div>

<div class="rad-table-wrap">
  <table class="rad-table">
    <thead><tr><th>Application</th><th>Environment</th><th>Status</th><th>Deployment</th><th>Workflow</th><th>Action</th></tr></thead>
    <tbody id="deploy-table-body">
      <tr><td colspan="6" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>
    </tbody>
  </table>
</div>

<!-- Deploying (transition) modal -->
<div id="deploy-progress-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:60; align-items:center; justify-content:center;">
  <div class="rad-card" style="max-width:520px; width:90%; margin:0; display:flex; align-items:flex-start; gap:18px;">
    <div id="deploy-progress-spinner" class="rad-spinner-lg" aria-hidden="true"></div>
    <div id="deploy-progress-failicon" style="display:none; flex:none; font-size:26px; line-height:1;" aria-hidden="true">❌</div>
    <div style="min-width:0; flex:1;">
      <div id="deploy-progress-title" style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:4px;"></div>
      <div id="deploy-progress-subtitle" style="font-size:13px; color:var(--rad-text-secondary);">This may take a few minutes…</div>
      <div id="deploy-progress-fail-actions" style="display:none; margin-top:16px;">
        <button id="deploy-fail-back" class="rad-btn rad-btn--neutral" style="margin:0;">Back to Deployments</button>
        <div id="deploy-fail-repair-note" style="display:none; margin-top:10px; font-size:12px; color:var(--rad-text-secondary);"></div>
      </div>
    </div>
  </div>
</div>

<!-- Delete confirmation dialog (Figma 3-step type-to-confirm flow). The
     "deleting" transition is shown inline on the row (status → Deleting…),
     not as a blocking modal. -->
${DELETE_DEPLOYMENT_DIALOG_HTML}

<style>
  .rad-deploy-controls { display:flex; align-items:flex-end; gap:20px; flex-wrap:wrap; margin:0 0 20px; }
  .rad-field { display:flex; flex-direction:column; gap:8px; }
  .rad-field label { font-size:15px; font-weight:600; color:var(--rad-text); }
  .rad-select-wrap { position:relative; }
  .rad-select-wrap select {
    appearance:none; -webkit-appearance:none; min-width:230px; padding:9px 40px 9px 12px;
    font-size:14px; color:var(--rad-text); background:var(--rad-surface);
    border:1px solid var(--rad-stroke); border-radius:8px; cursor:pointer;
  }
  .rad-select-wrap::after {
    content:""; position:absolute; right:14px; top:50%; width:8px; height:8px;
    border-right:2px solid var(--rad-text-tertiary); border-bottom:2px solid var(--rad-text-tertiary);
    transform:translateY(-70%) rotate(45deg); pointer-events:none;
  }
  .rad-btn--danger, .rad-btn--danger-outline { background:var(--rad-neutral-bg); color:var(--rad-danger-text); border:1px solid var(--rad-neutral-border); }
  .rad-btn--danger:hover, .rad-btn--danger-outline:hover { background:var(--rad-danger-solid); border-color:var(--rad-danger-solid-border); color:#fff; }
  .rad-btn--danger-solid { background:var(--rad-danger-solid); color:#fff; border:1px solid var(--rad-danger-solid-border); }
  .rad-btn--danger-solid:hover { background:var(--rad-danger-solid-border); border-color:var(--rad-danger-solid-border); color:#fff; }
  .rad-deploy-applink { display:inline-flex; align-items:center; gap:6px; color:var(--rad-link); text-decoration:underline; font-weight:600; font-size:14px; }
  .rad-deploy-applink:hover { color:var(--rad-link-hover); }
  .rad-monitor-link { color:var(--rad-link); text-decoration:underline; font-weight:600; font-size:14px; cursor:pointer; }
  .rad-monitor-link:hover { color:var(--rad-link-hover); }
  .rad-cell-empty { color:var(--rad-text-tertiary); }
  /* Inline status banner (Figma: green success / red error with dismiss). */
  .rad-inline { align-items:center; gap:12px; }
  .rad-inline__icon { flex:0 0 auto; font-size:16px; line-height:1; }
  .rad-inline__msg { flex:1 1 auto; min-width:0; line-height:1.4; }
  .rad-inline__close { flex:0 0 auto; background:none; border:none; cursor:pointer; font-size:14px; line-height:1; padding:2px 4px; color:inherit; opacity:0.65; }
  .rad-inline__close:hover { opacity:1; }
  .rad-inline--success { background:var(--rad-success-bg); border:1px solid var(--rad-success); color:var(--rad-text); }
  .rad-inline--success .rad-inline__icon { color:var(--rad-success); font-weight:700; }
  .rad-inline--error { background:var(--rad-danger-bg); border:1px solid var(--rad-danger); color:var(--rad-text); }
  .rad-inline--error .rad-inline__icon { color:var(--rad-danger); }
  /* Delete confirmation dialog styling now lives in the global pageShell CSS
     so the Deployed graph page shares this exact dialog. */
  .rad-spinner-lg { flex:0 0 auto; width:34px; height:34px; border:4px solid var(--rad-stroke); border-top-color:var(--rad-info); border-radius:50%; animation:spin 0.8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>

<script>
var CTX_REPO = ${JSON.stringify(ctxRepo)};
var CTX_BRANCH = ${JSON.stringify(ctxBranch)};

function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}

var deployBtn = document.getElementById('deploy-now-btn');
var appSelect = document.getElementById('deploy-app-select');
var envSelect = document.getElementById('deploy-env-select');
var branchSelect = document.getElementById('deploy-branch-select');
var inlineStatus = document.getElementById('deploy-inline-status');
var ENV_PROVIDERS = {};
var HAS_APPS = false;
var HAS_ENVS = false;
// Optimistic per-row status overrides for in-flight operations, keyed by
// "app\\u0000env" → 'deleting' | 'pending'. Applied in loadDeployments so a row
// reflects the action just taken even before GitHub's deployment record catches
// up (or while a cached listing is still warm). Cleared when the op resolves.
var OP_STATUS = {};
function opKey(app, env) { return app + '\\u0000' + env; }
// Keys (app\u0000env) whose real GitHub deployment record was present in the
// last successful listing. Lets an in-flight deploy poll stop refreshing the
// list once the real record has replaced its optimistic synthetic row.
var DEPLOY_RECORDS_PRESENT = {};
// Environments that currently have an IN-PROGRESS operation which blocks a NEW
// deploy (status pending = a deploy run still in flight, or deleting = a delete
// run still in flight), keyed by env name → status. Rebuilt from each successful
// deployments listing. Terminal states do NOT block: a failed deploy can be
// retried, and a successful deploy can be redeployed over. Used by
// refreshDeployBtn to disable the Deploy button for the selected environment.
var DEPLOYED_ENVS = {};
function envIsBlocked(status) { return status === 'pending' || status === 'deleting'; }

// Renders an inline status banner (Figma: green success / red error with a ✓/⚠
// icon and a dismiss ✕). The message node uses textContent by default so
// server-provided strings can never inject HTML; pass isHtml=true only for
// intentionally-built, escaped markup (see the delete-success banner below).
function showInline(kind, msg, isHtml) {
    inlineStatus.style.display = 'flex';
    inlineStatus.className = 'rad-inline rad-inline--' + (kind === 'error' ? 'error' : 'success');
    inlineStatus.innerHTML = '';
    var icon = document.createElement('span');
    icon.className = 'rad-inline__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'error' ? '⚠' : '✓';
    var body = document.createElement('span');
    body.className = 'rad-inline__msg';
    if (isHtml) body.innerHTML = msg; else body.textContent = msg;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'rad-inline__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.addEventListener('click', function() { inlineStatus.style.display = 'none'; });
    inlineStatus.appendChild(icon);
    inlineStatus.appendChild(body);
    inlineStatus.appendChild(close);
}

function refreshDeployBtn() {
    // The primary button adapts to what's missing:
    //   • no application options  → "Create Application" (go model an app)
    //   • app but no environments → "Create Environment"
    //   • otherwise               → "Deploy" (enabled once app+env chosen)
    if (!HAS_APPS) {
        deployBtn.dataset.mode = 'create-app';
        deployBtn.textContent = 'Create Application';
        deployBtn.disabled = false;
    } else if (!HAS_ENVS) {
        deployBtn.dataset.mode = 'create-env';
        deployBtn.textContent = 'Create Environment';
        deployBtn.disabled = false;
    } else {
        deployBtn.dataset.mode = 'deploy';
        deployBtn.textContent = 'Deploy';
        var selEnv = envSelect.value;
        // Block deploying to an environment only while an operation is IN PROGRESS
        // (pending = a deploy run in flight, deleting = a delete run in flight).
        // Terminal states never block: switching to a free environment, or a
        // failed/successful deployment, all leave the button enabled so a
        // (re)deploy can run.
        var blockedStatus = selEnv ? DEPLOYED_ENVS[selEnv] : '';
        deployBtn.disabled = !(CTX_REPO && appSelect.value && selEnv) || !!blockedStatus;
        if (blockedStatus) {
            if (blockedStatus === 'deleting') {
                deployBtn.title = 'Application is being deleted from environment "' + selEnv + '". Wait for the delete to finish before deploying again.';
            } else {
                deployBtn.title = 'A deployment is already in progress in environment "' + selEnv + '". Wait for it to finish before deploying again.';
            }
        } else {
            deployBtn.removeAttribute('title');
        }
    }
}

function loadApplications() {
    if (!CTX_REPO) { appSelect.innerHTML = '<option value="">No repository</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = (d && d.applications) || [];
            HAS_APPS = apps.length > 0;
            if (apps.length === 0) { appSelect.innerHTML = '<option value="">No applications</option>'; refreshDeployBtn(); return; }
            appSelect.innerHTML = apps.map(function(a) { return '<option value="' + escapeHtmlClient(a.name) + '">' + escapeHtmlClient(a.name) + '</option>'; }).join('');
            // Pre-select the application passed via ?app= (e.g. from a redirect
            // that resumes an in-flight deployment).
            try {
                var preApp = new URLSearchParams(window.location.search).get('app');
                if (preApp) {
                    var hasApp = apps.some(function(a) { return a.name === preApp; });
                    if (!hasApp) {
                        var o = document.createElement('option');
                        o.value = preApp; o.textContent = preApp;
                        appSelect.insertBefore(o, appSelect.firstChild);
                    }
                    appSelect.value = preApp;
                }
            } catch (e) {}
            refreshDeployBtn();
        })
        .catch(function() { appSelect.innerHTML = '<option value="">Could not load</option>'; });
}

function loadEnvironmentsDropdown() {
    if (!CTX_REPO) { envSelect.innerHTML = '<option value="">No repository</option>'; return; }
    fetch('/api/list-environments?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var envs = (d && d.environments) || [];
            HAS_ENVS = envs.length > 0;
            if (envs.length === 0) { envSelect.innerHTML = '<option value="">No environments</option>'; refreshDeployBtn(); return; }
            ENV_PROVIDERS = {};
            envs.forEach(function(e) { ENV_PROVIDERS[e.name] = e.provider || 'azure'; });
            envSelect.innerHTML = envs.map(function(e) { return '<option value="' + escapeHtmlClient(e.name) + '">' + escapeHtmlClient(e.name) + '</option>'; }).join('');
            // Pre-select the environment passed via ?env= (e.g. from the
            // "Deploy Apps" button on the environments list).
            try {
                var preEnv = new URLSearchParams(window.location.search).get('env');
                if (preEnv && ENV_PROVIDERS.hasOwnProperty(preEnv)) { envSelect.value = preEnv; }
            } catch (e) {}
            refreshDeployBtn();
        })
        .catch(function() { envSelect.innerHTML = '<option value="">Could not load</option>'; });
}

// Populate the Branch dropdown for the deploy dispatch, defaulting to the
// current session/worktree branch. The chosen branch is the --ref the deploy
// workflow runs against, so exposing it lets the user redirect a deploy to a
// different branch (and see which branch a worktree session will deploy).
function loadBranches() {
    if (!branchSelect) return;
    if (!CTX_REPO) { branchSelect.innerHTML = '<option value="' + escapeHtmlClient(CTX_BRANCH) + '">' + escapeHtmlClient(CTX_BRANCH) + '</option>'; return; }
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO }) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var branches = (d && d.branches) || [];
            var workspaceBranch = (d && d.workspaceBranch) || CTX_BRANCH || '';
            // The branch we want selected by default (and dispatched against):
            // the server-reported worktree branch, else the session branch.
            var desired = workspaceBranch || CTX_BRANCH || '';
            if (branches.length === 0) { branchSelect.innerHTML = '<option value="' + escapeHtmlClient(CTX_BRANCH) + '">' + escapeHtmlClient(CTX_BRANCH) + '</option>'; return; }
            // The desired branch can be absent from /api/discover-branches (e.g. an
            // unpushed worktree branch the server didn't inject because the repo
            // didn't match the workspace). Insert it so the dropdown — and the
            // dispatch that reads branchSelect.value — never silently falls back to
            // the first returned branch and deploys the wrong ref.
            if (desired && !branches.some(function(b) { return b.name === desired; })) {
                branches.unshift({ name: desired, sha: 'worktree' });
            }
            branchSelect.innerHTML = '';
            branches.forEach(function(b) {
                var o = document.createElement('option');
                o.value = b.name;
                o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : (b.sha ? ' (' + b.sha.slice(0,7) + ')' : ''));
                if (b.name === desired) o.selected = true;
                branchSelect.appendChild(o);
            });
        })
        .catch(function() { branchSelect.innerHTML = '<option value="' + escapeHtmlClient(CTX_BRANCH) + '">' + escapeHtmlClient(CTX_BRANCH) + '</option>'; });
}

function statusCell(status) {
    var map = { success: ['success','Success'], failed: ['failed','Failed'], pending: ['pending','Pending'], deleting: ['deleting','Deleting…'] };
    var m = map[status] || map.pending;
    return '<span class="rad-dot rad-dot--' + m[0] + '"></span><span class="rad-status-label">' + m[1] + '</span>';
}

function loadDeployments(fresh, quiet) {
    var body = document.getElementById('deploy-table-body');
    if (!CTX_REPO) { body.innerHTML = '<tr><td class="rad-table__env" colspan="6">No application deployments yet.</td></tr>'; return; }
    // A background refresh (quiet) keeps the current rows on screen until the new
    // data arrives, so periodic in-flight polling doesn't flash the table back to
    // a "Loading…" placeholder on every tick.
    if (!quiet) body.innerHTML = '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>';
    fetch('/api/list-deployments?repo=' + encodeURIComponent(CTX_REPO) + (fresh ? '&fresh=1' : ''))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            // A transient GitHub failure returns { deployments: [], error }. Don't
            // render that as "no deployments" (which would hide real rows); show a
            // load-error row and leave any previous state to the next refresh.
            if (d && d.error) { if (!quiet) body.innerHTML = '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Could not load deployments. Retrying…</td></tr>'; return; }
            var deps = (d && d.deployments) || [];
            // Surface just-started operations GitHub hasn't recorded yet. A
            // deployment record isn't created until the deploy job starts, so an
            // optimistic "pending" OP_STATUS entry with no matching server row is
            // rendered as a synthetic row. Without this, a brand-new deployment to
            // an app+env with no prior record would stay invisible until the run
            // reached a terminal state or Refresh was clicked. "deleting" is
            // deliberately excluded: a delete always acts on an existing row, so
            // its record is recolored in place; once the record is gone the delete
            // is done, and a synthetic "Deleting…" row would be a phantom.
            var present = {};
            deps.forEach(function(dep) { present[opKey(dep.app, dep.environment)] = true; });
            DEPLOY_RECORDS_PRESENT = present;
            var synthetic = [];
            Object.keys(OP_STATUS).forEach(function(k) {
                if (present[k] || OP_STATUS[k] === 'deleting') return;
                var parts = k.split('\\u0000');
                if (parts.length !== 2 || !parts[0] || !parts[1]) return;
                // synthetic: no GitHub deployment record exists yet, so this row
                // must not offer Delete (it would dispatch against a nonexistent
                // record and falsely report success).
                synthetic.push({ app: parts[0], environment: parts[1], status: OP_STATUS[k], runUrl: '', synthetic: true });
            });
            var rows = synthetic.concat(deps);
            if (rows.length === 0) { DEPLOYED_ENVS = {}; refreshDeployBtn(); body.innerHTML = '<tr><td class="rad-table__env" colspan="6">No application deployments yet.</td></tr>'; return; }
            // Rebuild the set of environments whose deployment blocks a new deploy,
            // honoring optimistic overrides, then refresh the Deploy button state.
            DEPLOYED_ENVS = {};
            rows.forEach(function(dep) {
                var st = OP_STATUS[opKey(dep.app, dep.environment)] || dep.status;
                if (envIsBlocked(st)) DEPLOYED_ENVS[dep.environment] = st;
            });
            refreshDeployBtn();
            var arrowSvg = '<svg class="rad-applink-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            body.innerHTML = rows.map(function(dep) {
                // A GitHub deployment record is only created once the deploy/delete
                // job starts, so right after dispatch the newest record still shows
                // the previous state. Force an in-flight op's status until it clears
                // so the row reflects the action the user just took (Deleting…/Pending).
                var forced = OP_STATUS[opKey(dep.app, dep.environment)];
                var status = forced || dep.status;
                var statusHtml = statusCell(status);
                // The app name and the "Monitor Graph" link both route to the
                // Applications → Deployed tab (the live deployed app graph).
                var deployedHref = '/?page=deployed&environment=' + encodeURIComponent(dep.environment) + '&application=' + encodeURIComponent(dep.app);
                var monitorCell = '<a class="rad-monitor-link" href="' + escapeHtmlClient(deployedHref) + '" title="Monitor the deployed application graph">Monitor Graph</a>';
                // Workflow → the GitHub Actions run that produced this deployment.
                var workflowCell = dep.runUrl
                    ? '<a class="rad-deploy-applink" href="' + escapeHtmlClient(dep.runUrl) + '" target="_blank" rel="noopener noreferrer" title="View workflow run on GitHub">' + arrowSvg + 'View Run</a>'
                    : '<span class="rad-cell-empty">—</span>';
                // Failed deployments get a filled (solid) delete button; all
                // others use the subtle outline variant. A row that's mid-delete
                // disables its button to prevent a duplicate dispatch.
                var delClass = status === 'failed' ? 'rad-btn--danger-solid' : 'rad-btn--danger-outline';
                var delDisabled = (status === 'deleting' || dep.synthetic) ? ' disabled' : '';
                return '<tr>' +
                    '<td class="rad-table__env"><a class="rad-deploy-applink" href="' + escapeHtmlClient(deployedHref) + '" title="View deployed application graph">' + arrowSvg + escapeHtmlClient(dep.app) + '</a></td>' +
                    '<td>' + escapeHtmlClient(dep.environment) + '</td>' +
                    '<td>' + statusHtml + '</td>' +
                    '<td>' + monitorCell + '</td>' +
                    '<td>' + workflowCell + '</td>' +
                    '<td class="rad-table__actions"><button class="rad-btn ' + delClass + ' js-del-dep"' + delDisabled + ' data-env="' + escapeHtmlClient(dep.environment) + '" data-app="' + escapeHtmlClient(dep.app) + '" style="margin:0;">Delete Deployment</button></td>' +
                '</tr>';
            }).join('');
            wireDeleteButtons();
        })
        .catch(function() { if (!quiet) body.innerHTML = '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Could not load deployments.</td></tr>'; });
}

// --- Delete deployment: 3-step type-to-confirm dialog (shared, client.ts) ---
var deleteDialog = radiusCreateDeleteDeploymentDialog({ onConfirm: runDelete });

function openDeleteModal(app, env) { if (deleteDialog) deleteDialog.open(app, env); }

function wireDeleteButtons() {
    document.querySelectorAll('.js-del-dep').forEach(function(btn) {
        btn.addEventListener('click', function() { openDeleteModal(this.dataset.app, this.dataset.env); });
    });
}

// Dispatch the delete, then let the row reflect "Deleting…" while the workflow
// runs. When the deployment finally clears from the listing, show the green
// "successfully deleted" banner (Figma deployments-deleted state).
function runDelete(app, env) {
    var dep = { app: app, environment: env };
    // Acknowledge the action immediately: the delete workflow takes a moment to
    // start, so without an instant cue the button click looks like it did
    // nothing. Mirror the deploy flow — flip the row to "Deleting…" and show a
    // banner right away, before the dispatch round-trip resolves. The delete
    // run's deployment record doesn't exist yet, so the OP_STATUS override keeps
    // the row showing "Deleting…" until it clears; refresh quietly so the
    // existing row flips in place instead of flashing a loading placeholder.
    OP_STATUS[opKey(dep.app, dep.environment)] = 'deleting';
    loadDeployments(true, true);
    showInline('success', 'Deleting deployment of application <strong>' + escapeHtmlClient(dep.app) + '</strong> in environment <strong>' + escapeHtmlClient(dep.environment) + '</strong> has started.', true);
    fetch('/api/delete-deployment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, environment: dep.environment, application: dep.app }) })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
        .then(function(res) {
            if (!res.ok) {
                // Dispatch failed — clear the optimistic override so the row
                // reverts to its real status, then surface the error.
                delete OP_STATUS[opKey(dep.app, dep.environment)];
                loadDeployments(true, true);
                showInline('error', (res.d && res.d.error) || 'Could not start the delete workflow.');
                return;
            }
            pollDeleteCompletion(dep.app, dep.environment, 0);
        })
        .catch(function() {
            delete OP_STATUS[opKey(dep.app, dep.environment)];
            loadDeployments(true, true);
            showInline('error', 'Could not delete the deployment. Please try again.');
        });
}

// Poll the deployments listing until the target app/env is gone (a successful
// delete removes it), then show the green success banner. Refreshes the table
// quietly each cycle so the "Deleting…" status stays visible without flashing a
// loading placeholder (matching the deploy flow's in-flight polling). Bounded so
// a stuck or failed delete never polls forever — on timeout the override is
// cleared and the row reverts to its real status (a failed delete falls back to
// its deploy record, so the deployment remains visible).
function pollDeleteCompletion(app, env, tries) {
    if (tries > 45) { delete OP_STATUS[opKey(app, env)]; loadDeployments(true, true); return; } // ~3 min at 4s
    setTimeout(function() {
        fetch('/api/list-deployments?repo=' + encodeURIComponent(CTX_REPO) + '&fresh=1')
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
            .then(function(res) {
                var d = res.d || {};
                // Only trust a complete, successful listing. A transient GitHub
                // failure comes back as { deployments: [], error } (or a non-array
                // deployments field); treating that empty list as "row gone" would
                // wrongly report a successful delete, so keep polling instead.
                if (!res.ok || d.error || !Array.isArray(d.deployments)) {
                    pollDeleteCompletion(app, env, tries + 1);
                    return;
                }
                var stillThere = d.deployments.some(function(x) { return x.app === app && x.environment === env; });
                if (!stillThere) {
                    delete OP_STATUS[opKey(app, env)];
                    loadDeployments(true, true);
                    showInline('success', 'Deployment of application <strong>' + escapeHtmlClient(app) + '</strong> in environment <strong>' + escapeHtmlClient(env) + '</strong> has been successfully deleted.', true);
                    return;
                }
                loadDeployments(true, true); // keep the row showing "Deleting…" (quiet)
                pollDeleteCompletion(app, env, tries + 1);
            })
            .catch(function() { pollDeleteCompletion(app, env, tries + 1); });
    }, 4000);
}

appSelect.addEventListener('change', refreshDeployBtn);
envSelect.addEventListener('change', refreshDeployBtn);

// Restore the deploy modal to its default "in progress" (spinner) layout. The
// modal is mutated in place when a deploy fails, so we reset before each run.
function resetDeployModal() {
    var spin = document.getElementById('deploy-progress-spinner');
    var fail = document.getElementById('deploy-progress-failicon');
    var sub = document.getElementById('deploy-progress-subtitle');
    var links = document.getElementById('deploy-progress-links');
    var failActions = document.getElementById('deploy-progress-fail-actions');
    if (spin) spin.style.display = '';
    if (fail) fail.style.display = 'none';
    if (sub) { sub.textContent = 'This may take a few minutes…'; sub.style.color = 'var(--rad-text-secondary)'; }
    if (links) links.style.display = 'flex';
    if (failActions) failActions.style.display = 'none';
}

// Switch the deploy modal into a "failed" state: swap the spinner for an error
// icon, show the error message, and offer a button back to the deployments list.
// The kind argument lets us render a cleaner, tailored panel for well-known
// failures (e.g. a branch that hasn't been pushed) instead of raw CLI stderr.
function showDeployFailed(app, env, errText, runUrl, kind, branch, repairing, handoff) {
    var modal = document.getElementById('deploy-progress-modal');
    var spin = document.getElementById('deploy-progress-spinner');
    var fail = document.getElementById('deploy-progress-failicon');
    var title = document.getElementById('deploy-progress-title');
    var sub = document.getElementById('deploy-progress-subtitle');
    var links = document.getElementById('deploy-progress-links');
    var failActions = document.getElementById('deploy-progress-fail-actions');
    if (spin) spin.style.display = 'none';
    if (fail) fail.style.display = '';
    if (kind === 'branch-not-pushed') {
        var br = branch || 'your branch';
        var pushCmd = 'git push -u origin ' + br;
        if (title) title.innerHTML = 'Branch not pushed yet';
        if (sub) {
            sub.style.color = 'var(--rad-text-secondary)';
            sub.innerHTML =
                '<div style="color:var(--rad-text);">The branch <code style="background:var(--rad-code-bg); padding:1px 5px; border-radius:4px;">' + escapeHtmlClient(br) + '</code> hasn\\'t been pushed to GitHub yet, so there\\'s nothing to deploy for <strong>' + escapeHtmlClient(app) + '</strong>.</div>' +
                '<div style="margin-top:10px; color:var(--rad-text-secondary);">Push it, then deploy again:</div>' +
                '<div style="margin-top:8px; display:flex; align-items:center; gap:8px; background:var(--rad-code-bg); border:1px solid var(--rad-stroke); border-radius:6px; padding:8px 10px;">' +
                  '<code style="flex:1; font-family:var(--font-mono, monospace); font-size:12px; color:var(--rad-text); white-space:nowrap; overflow-x:auto;">' + escapeHtmlClient(pushCmd) + '</code>' +
                  '<button type="button" id="deploy-copy-push" class="rad-btn rad-btn--neutral" style="margin:0; padding:2px 10px; font-size:12px; flex:none;">Copy</button>' +
                '</div>';
        }
    } else {
        if (title) title.innerHTML = 'Deployment of <strong>' + escapeHtmlClient(app) + '</strong> to <strong>' + escapeHtmlClient(env) + '</strong> failed';
        if (sub) {
            var msg = errText ? escapeHtmlClient(errText) : 'The deploy workflow run did not complete successfully.';
            if (runUrl) msg += '<br><a href="' + escapeHtmlClient(runUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--rad-link);">View workflow run in GitHub ↗</a>';
            sub.innerHTML = msg;
            sub.style.color = 'var(--rad-danger)';
        }
    }
    if (links) links.style.display = 'none';
    if (failActions) failActions.style.display = 'block';
    if (modal) modal.style.display = 'flex';
    var repairNote = document.getElementById('deploy-fail-repair-note');
    if (repairNote) {
        var hs = (handoff && handoff.state) || 'idle';
        var msg = '';
        if (repairing) {
            msg = 'Copilot is analyzing the failure and will repair and redeploy if the app model caused it — follow along in the chat.';
        } else if (hs === 'pending' || hs === 'retryable') {
            msg = 'Handing this failure to Copilot…';
        } else if (hs === 'failed') {
            msg = 'Could not reach Copilot to repair this deploy. Ask Copilot in the chat to fix .radius/app.bicep and redeploy.';
        }
        repairNote.style.display = msg ? 'block' : 'none';
        repairNote.textContent = msg;
    }
    // Wire the copy button (present only for the branch-not-pushed panel).
    var copyBtn = document.getElementById('deploy-copy-push');
    if (copyBtn) {
        copyBtn.addEventListener('click', function() {
            var cmd = 'git push -u origin ' + (branch || '');
            var done = function() { copyBtn.textContent = 'Copied'; setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(cmd).then(done).catch(function() {});
            }
        });
    }
    deployBtn.disabled = false;
    refreshDeployBtn();
}

// "Back to Deployments" dismisses the failed dialog and refreshes the list.
(function() {
    var backBtn = document.getElementById('deploy-fail-back');
    if (backBtn) backBtn.addEventListener('click', function() {
        var modal = document.getElementById('deploy-progress-modal');
        if (modal) modal.style.display = 'none';
        resetDeployModal();
        loadDeployments();
    });
})();

deployBtn.addEventListener('click', function() {
    var mode = deployBtn.dataset.mode || 'deploy';
    if (mode === 'create-app') { window.location.href = '/?page=graph'; return; }
    if (mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
    var env = envSelect.value;
    var app = appSelect.value;
    if (!CTX_REPO || !env || !app) return;
    var provider = ENV_PROVIDERS[env] || 'azure';
    resetDeployModal();
    // Optimistically show this row as "Pending" for the duration of the run. A
    // GitHub deployment record for the new run doesn't exist until the deploy job
    // starts, so without this the row would keep showing the previous status.
    OP_STATUS[opKey(app, env)] = 'pending';
    loadDeployments(true);
    deployBtn.disabled = true;
    deployBtn.textContent = 'Deploying…';

    // Briefly acknowledge the deploy, then auto-dismiss. Progress (status,
    // Monitor Graph, View Run) is tracked in the deployments list below, so the
    // dialog no longer links out to the app graph or the workflow run.
    var progTitle = document.getElementById('deploy-progress-title');
    progTitle.innerHTML = 'Deploying <strong>' + escapeHtmlClient(app) + '</strong> to environment <strong>' + escapeHtmlClient(env) + '</strong>';
    var progSub = document.getElementById('deploy-progress-subtitle');
    if (progSub) progSub.textContent = 'Track progress in the deployments list below.';
    var progModal = document.getElementById('deploy-progress-modal');
    progModal.style.display = 'flex';
    // Green confirmation banner (matches the delete-success notification).
    showInline('success', 'Deployment of application <strong>' + escapeHtmlClient(app) + '</strong> to environment <strong>' + escapeHtmlClient(env) + '</strong> has started.', true);
    // Auto-dismiss the transient dialog after a couple of seconds. The deploy
    // keeps running (tracked in the list), so the button returns to normal.
    var autoHide = setTimeout(function() {
        progModal.style.display = 'none';
        deployBtn.disabled = false;
        refreshDeployBtn();
    }, 2500);

    // Poll deploy-status to clear the optimistic "Pending" once the run resolves,
    // and to surface a failure dialog if the deploy can't start (e.g. an unpushed
    // branch). We stay on the Deployments page throughout.
    var failedPolls = 0;
    var wfTicks = 0;
    // Once the real record replaces the synthetic row, keep polling deploy-status
    // for the terminal transition but stop the per-tick fresh=1 list fetches.
    var recordSeen = false;
    var wfPoll = setInterval(function() {
        // Safety cap so a deploy-status that never reaches a terminal state can't
        // poll forever (~30 min at 2.5s/tick); fall back to GitHub's real status.
        if (++wfTicks > 720) {
            clearInterval(wfPoll);
            clearTimeout(autoHide);
            delete OP_STATUS[opKey(app, env)];
            loadDeployments(true);
            return;
        }
        fetch('/api/deploy-status')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d && d.status === 'failed') {
                    var handoff = d.handoff || {};
                    // Delivery of the repair handoff is asynchronous, so keep
                    // polling until it lands or the server stops retrying.
                    if (handoff.pending && failedPolls < 20) {
                        failedPolls++;
                        showDeployFailed(app, env, (d && d.error) || '', (d && d.deployRunUrl) || '', (d && d.errorKind) || '', (d && d.errorBranch) || '', false, handoff);
                        return;
                    }
                    clearInterval(wfPoll);
                    clearTimeout(autoHide);
                    delete OP_STATUS[opKey(app, env)];
                    showDeployFailed(app, env, (d && d.error) || '', (d && d.deployRunUrl) || '', (d && d.errorKind) || '', (d && d.errorBranch) || '', (d && d.repairing) || false, handoff);
                    loadDeployments(true);
                    return;
                }
                if (d && (d.status === 'success' || d.status === 'complete')) {
                    clearInterval(wfPoll);
                    delete OP_STATUS[opKey(app, env)];
                    loadDeployments(true);
                    return;
                }
                // Still in flight. Quietly refresh the table only until the real
                // GitHub deployment record (with its "View Run" link) replaces the
                // optimistic synthetic row; after that the row is real and driven
                // by the OP_STATUS override, so further fresh=1 fetches (which
                // bypass the cache and fan out per-environment) are wasted.
                if (recordSeen) return;
                if (DEPLOY_RECORDS_PRESENT[opKey(app, env)]) { recordSeen = true; return; }
                loadDeployments(true, true);
            })
            .catch(function() {});
    }, 2500);

    // The deploy runs against the branch the user selected (defaults to the
    // session/worktree branch). This value becomes the workflow --ref, so the
    // dispatched branch always matches what's shown in the Branch dropdown.
    var deployBranch = (branchSelect && branchSelect.value) || CTX_BRANCH;
    fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: env, provider: provider, targetRepo: CTX_REPO, branch: deployBranch, appFile: '.radius/app.bicep' })
    }).then(function(r) { return r.json().catch(function() { return {}; }); })
      .catch(function() {
          clearInterval(wfPoll);
          clearTimeout(autoHide);
          delete OP_STATUS[opKey(app, env)];
          document.getElementById('deploy-progress-modal').style.display = 'none';
          deployBtn.disabled = false;
          refreshDeployBtn();
          showInline('error', 'Could not start the deployment. Please try again.');
          loadDeployments(true);
      });
});

// Dismiss the deploy dialog by clicking the backdrop; the deployment keeps
// running in the background and shows up in the deployments table.
(function() {
    var pm = document.getElementById('deploy-progress-modal');
    if (pm) pm.addEventListener('click', function(e) {
        if (e.target === pm) {
            pm.style.display = 'none';
            resetDeployModal();
            deployBtn.disabled = false;
            refreshDeployBtn();
            loadDeployments(true);
        }
    });
})();

loadApplications();
loadEnvironmentsDropdown();
loadBranches();
loadDeployments();
<\/script>`,
    "deployments"
  );
}
