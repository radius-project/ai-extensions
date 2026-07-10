// Canvas adapter — HTML page renderers. Each function is a `state => html`
// builder for one canvas page; together they are the entire server-side view
// layer. Browser behaviour lives in the embedded client JS (./client.mjs) and
// vendored libraries (./vendor.mjs); cross-cutting helpers/state come from
// ./shared.mjs. No I/O, routing, or business logic here.

import { escapeHtml, sharedCredentials } from "./shared.mjs";
import { getInlineVendorScripts } from "./vendor.mjs";
import { CLIENT_REPO_BRANCH_JS, CLIENT_GRAPH_JS, CLIENT_HEARTBEAT_JS } from "./client.mjs";
import { topNav, radiusMark } from "./ui.mjs";

// Pick the active top-nav section from a page title.
function navFromTitle(title) {
    const t = String(title || '').toLowerCase();
    if (t.includes('environment')) return 'environments';
    if (t.includes('deploying') || t.includes('deployment')) return 'deployments';
    return 'applications';
}

export function pageShell(title, bodyContent, activeNav) {
    const active = activeNav || navFromTitle(title);
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Ccircle cx='64' cy='64' r='64' fill='%23da4c2a'/%3E%3Ccircle cx='64' cy='64' r='56' fill='%23bb311e' opacity='0.3'/%3E%3Cline x1='64' y1='64' x2='34' y2='28' stroke='white' stroke-width='7' stroke-linecap='round'/%3E%3Ccircle cx='64' cy='64' r='8' fill='white'/%3E%3C/svg%3E" />
<title>${title} — Radius</title>
<style>
  /* ─── Radius design tokens (from Figma variables) ─────────────────────── */
  :root {
    /* Follow the host app's theme. Radius brand accents stay constant across
       light/dark; every neutral surface/text/border binds to the Copilot app's
       injected semantic tokens (with light-mode fallbacks for standalone use). */
    color-scheme: light dark;
    --rad-brand: #da4c2a;
    --rad-brand-dark: #bb311e;
    --rad-primary: #1a7f37;
    --rad-primary-hover: #218a3f;
    --rad-bg: var(--background-color-default, #ffffff);
    --rad-surface: var(--background-color-default, #ffffff);
    --rad-bg-subtle: var(--background-color-segmented, #f1f1f1);
    --rad-bg-selected: var(--background-color-segmentedControl-bg-emphasis, #e1e1e1);
    --rad-bg-hover: var(--background-color-control-transparent-hover, #d5d5d5);
    --rad-stroke: var(--border-color-default, #d8d8d8);
    --rad-stroke-strong: var(--border-color-default, #919191);
    --rad-text: var(--text-color-default, #000000);
    --rad-text-secondary: var(--text-color-default, #1a1a1a);
    --rad-text-tertiary: var(--text-color-muted, #6e6e6e);
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

  /* ─── Top segmented pill nav ──────────────────────────────────────────── */
  .rad-topnav {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rad-stroke);
    flex: 0 0 auto;
  }
  .rad-topnav__pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-radius: var(--rad-radius-lg);
    background: var(--rad-bg-subtle);
    color: var(--rad-text-secondary);
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    transition: background 0.15s, color 0.15s;
  }
  .rad-topnav__pill:hover { background: var(--rad-bg-selected); }
  .rad-topnav__pill--active { background: var(--rad-bg-selected); color: var(--rad-text); font-weight: 700; }
  .rad-topnav__pill svg { flex: 0 0 auto; }

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
  .status.info, .rad-status--info { background: color-mix(in srgb, var(--rad-brand) 14%, transparent); border: 1px solid var(--rad-brand); color: var(--rad-text); }
  .status.success, .rad-status--success { background: color-mix(in srgb, var(--rad-primary) 16%, transparent); border: 1px solid var(--rad-primary); color: var(--rad-text); }
  .status.error, .rad-status--error { background: color-mix(in srgb, #cf222e 16%, transparent); border: 1px solid #cf222e; color: var(--rad-text); }

  /* ─── Legacy tabs (kept for pages not yet migrated) ───────────────────── */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--rad-stroke); margin-bottom: 16px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; user-select: none; }
  .tab.active { border-bottom-color: var(--rad-brand); color: var(--rad-text); }

  code { font-family: var(--rad-mono); font-size: 12px; background: var(--rad-bg-subtle); padding: 2px 6px; border-radius: 4px; }
  pre { background: var(--rad-bg-subtle); padding: 12px; border-radius: var(--rad-radius); overflow-x: auto; font-size: 12px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }

  /* ─── Fields, inputs, selects ─────────────────────────────────────────── */
  label { display: block; font-weight: 600; font-size: 12px; color: var(--rad-text-tertiary); margin: 10px 0 4px; }
  .rad-field { display: flex; flex-direction: column; gap: 4px; }
  .rad-field label { margin: 0; }
  input, select, .rad-select {
    width: 100%; padding: 8px 10px;
    border: 1px solid var(--rad-stroke-strong);
    border-radius: var(--rad-radius); font-size: 13px;
    background: var(--rad-bg); color: var(--rad-text);
    font-family: var(--rad-font);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.02);
  }
  input:focus, select:focus, .rad-select:focus { outline: 2px solid var(--rad-brand); outline-offset: -1px; border-color: var(--rad-brand); }
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
  .rad-btn--neutral { background: var(--rad-bg-selected); color: var(--rad-text); }
  .rad-btn--neutral:hover { background: var(--rad-bg-hover); }
  .rad-btn--info { background: #1f6feb; color: #fff; }
  .rad-btn--danger { background: #c93c37; color: #fff; }
  .rad-btn--danger:hover { background: #b52f2a; }
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
  .rad-spinner-lg { flex: 0 0 auto; width: 34px; height: 34px; border: 4px solid var(--rad-stroke, #e1e4e8); border-top-color: #1f6feb; border-radius: 50%; animation: rad-spin 0.8s linear infinite; }
  @keyframes rad-spin { to { transform: rotate(360deg); } }
  .rad-btn--info:hover { background: #388bfd; }
  button:disabled, .rad-btn:disabled { opacity: 0.6; cursor: default; }
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
  .rad-link { color: #1f6feb; text-decoration: underline; cursor: pointer; font-size: 13px; }
  .rad-link:hover { color: #388bfd; }

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
  .rad-table__actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; white-space: nowrap; }
  .rad-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .rad-dot--success { background: #1a7f37; }
  .rad-dot--failed { background: #cf222e; }
  .rad-dot--pending { background: var(--rad-text-tertiary); }
  .rad-status-label { vertical-align: middle; }

  /* ─── Graph + node cards ──────────────────────────────────────────────── */
  #graph-container { width: 100%; height: 450px; border-radius: var(--rad-radius-lg); position: relative; background: var(--rad-bg-subtle); }
  #graph-container:empty { background: transparent; }
  .legend { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  .legend-swatch { width: 14px; height: 12px; border-radius: 3px; border: 2px solid var(--rad-stroke-strong); box-sizing: border-box; }
  .rad-node {
    position: relative; width: 220px; min-height: 92px;
    background: var(--rad-surface); border: 2px solid var(--rad-stroke-strong);
    border-radius: 8px; padding: 12px 14px;
  }
  .rad-node__icon { width: 32px; height: 32px; }
  .rad-node__title { font-weight: 500; font-size: 16px; color: var(--rad-text); margin-top: 6px; }
  .rad-node__type { font-size: 12px; color: var(--rad-text-tertiary); margin-top: 2px; }

  .field { margin: 8px 0; }
  .field-label { font-weight: 500; color: var(--rad-text-tertiary); font-size: 12px; }
  .field-value { font-family: var(--rad-mono); font-size: 13px; margin-top: 2px; }
  .field-value.placeholder { color: var(--rad-text-tertiary); font-style: italic; }
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
<div class="main-content">
${bodyContent}
</div>
<div id="radius-reconnect-overlay" style="display:none; position:fixed; inset:0; z-index:9999; background:color-mix(in srgb, var(--rad-bg) 92%, transparent); align-items:center; justify-content:center; flex-direction:column; gap:12px; font-family:var(--rad-font);">
  <div style="width:28px; height:28px; border:3px solid var(--rad-stroke); border-top-color:var(--rad-brand); border-radius:50%; animation:radius-spin 0.8s linear infinite;"></div>
  <div style="font-size:13px; color:var(--rad-text-tertiary);">Reconnecting to Radius…</div>
</div>
<style>@keyframes radius-spin { to { transform: rotate(360deg); } }</style>
<script>
${CLIENT_HEARTBEAT_JS}
</script>
</body>
</html>`;
}

export function oidcPage(state) {
    const azureResult = state?.oidcAzure;
    const awsResult = state?.oidcAws;
    const savedAzure = sharedCredentials.azure || {};
    const savedAws = sharedCredentials.aws || {};

    const azureResultHtml = azureResult
        ? `<div class="status success">${escapeHtml(azureResult.message)}</div>
<div class="field"><span class="field-label">Tenant</span><div class="field-value">${escapeHtml(azureResult.tenantName || "")}${azureResult.tenantName ? " — " : ""}${escapeHtml(azureResult.tenantId)}</div></div>
<div class="field"><span class="field-label">Subscription</span><div class="field-value">${escapeHtml(azureResult.subscriptionName || "")}${azureResult.subscriptionName ? " — " : ""}${escapeHtml(azureResult.subscriptionId)}</div></div>
<div class="field"><span class="field-label">App Registration</span><div class="field-value">${escapeHtml(azureResult.clientName || "")}${azureResult.clientName ? " — " : ""}${escapeHtml(azureResult.clientId)}</div></div>
` : "";

    const awsResultHtml = awsResult
        ? `<div class="status success">${escapeHtml(awsResult.message)}</div>
<div class="field"><span class="field-label">Account</span><div class="field-value">${escapeHtml(awsResult.accountName || "")}${awsResult.accountName ? " — " : ""}${escapeHtml(awsResult.accountId)}</div></div>
<div class="field"><span class="field-label">Region</span><div class="field-value">${escapeHtml(awsResult.region)}</div></div>` : "";

    return pageShell("Accounts", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#da4c2a"/><circle cx="64" cy="64" r="56" fill="#bb311e" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Cloud Accounts</h1>
<p style="margin-bottom:16px; color: var(--text-color-muted, #656d76);">
  Set up OpenID Connect federation so GitHub Actions can authenticate to your cloud provider without long-lived secrets.
</p>
<div class="tabs">
  <div class="tab active" id="tab-azure">Azure</div>
  <div class="tab" id="tab-aws">AWS</div>
</div>
<div id="panel-azure">
  <label>Tenant ID</label>
  <input id="az-tenant" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(azureResult?.tenantId || savedAzure.tenantId || "")}" />
  <label>Subscription ID</label>
  <input id="az-sub" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(azureResult?.subscriptionId || savedAzure.subscriptionId || "")}" />
  <label>Client ID (App Registration)</label>
  <input id="az-client" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(azureResult?.clientId || savedAzure.clientId || "")}" />
  <button id="btn-azure">Confirm authentication</button>
  <div id="result-azure">${azureResultHtml}</div>
</div>
<div id="panel-aws" style="display:none;">
  <label>Account ID</label>
  <input id="aws-account" placeholder="123456789012" value="${escapeHtml(awsResult?.accountId || "")}" />
  <label>Region</label>
  <input id="aws-region" placeholder="us-east-1" value="${escapeHtml(awsResult?.region || "")}" />
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
<\/script>`);
}

export function appGeneratePage(state) {
    const targetRepo = state?.generateTargetRepo || state?.contextRepo || '';
    const targetBranch = state?.generateBranch || state?.contextBranch || 'main';
    if (state && state.generatedContent) {
        return pageShell("Generated app.bicep", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#da4c2a"/><circle cx="64" cy="64" r="56" fill="#bb311e" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>✓ app.bicep Generated</h1>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="gen-repo" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="gen-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px;">
      <option value="">Select repo first</option>
    </select>
  </div>
  <button id="gen-btn" class="rad-btn rad-btn--neutral" style="margin-top:0;">Regenerate</button>
</div>
<div class="status success">Successfully generated application model for ${escapeHtml(targetRepo)}</div>
${state.generatedWarning ? `<div class="status info">Generated content is available below, but it could not be committed to the selected remote branch: ${escapeHtml(state.generatedWarning)}</div>` : ''}
<h2>Generated app.bicep</h2>
<pre>${escapeHtml(state.generatedContent)}</pre>
<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(targetBranch)}';
radiusSetupRepoBranch('gen-repo', 'gen-branch', CONTEXT_REPO, CONTEXT_BRANCH);
document.getElementById('gen-btn').addEventListener('click', function() {
    var repo = document.getElementById('gen-repo').value.trim();
    if (!repo) return;
    this.textContent = 'Generating...';
    this.disabled = true;
    var btn = this;
    fetch('/api/generate-bicep', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: document.getElementById('gen-branch').value || CONTEXT_BRANCH}) })
        .then(function(r) { return r.json(); })
        .then(function(d) { btn.textContent = 'Regenerate'; btn.disabled = false; if (d.reload) window.location.reload(); });
});
<\/script>`);
    }
    return pageShell("Generate app.bicep", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#da4c2a"/><circle cx="64" cy="64" r="56" fill="#bb311e" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Generate Application Model</h1>
<p style="margin-bottom:16px; color: var(--text-color-muted, #656d76);">
  Analyze your repository and generate a Radius <code>app.bicep</code> file using the app-modeling skill.
</p>
<div style="display:flex; gap:16px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="gen-repo" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="gen-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; min-width:180px; background:var(--background-color-default, #fff);"><option value="">Select repo first</option></select>
  </div>
  <button id="gen-btn" style="margin-top:18px; padding:6px 14px; background:#1a7f37; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Generate app.bicep</button>
</div>
<div id="gen-status" class="status info">
  Enter a repository to analyze. The Radius skill will inspect the repo structure and generate an <code>app.bicep</code> that models the application.
</div>
<div id="gen-log" style="display:none; margin-top:12px;">
  <h2>Generation Log</h2>
  <pre id="gen-output" style="max-height:300px; overflow-y:auto;"></pre>
</div>
<script>
document.getElementById('gen-btn').addEventListener('click', function() {
    var repo = document.getElementById('gen-repo').value.trim();
    if (!repo) return;
    this.textContent = 'Generating...';
    this.disabled = true;
    var btn = this;
    document.getElementById('gen-log').style.display = 'block';
    document.getElementById('gen-output').textContent = 'Analyzing repository ' + repo + '...\\n';
    fetch('/api/generate-bicep', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: document.getElementById('gen-branch').value}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            btn.textContent = 'Generate app.bicep';
            btn.disabled = false;
            if (d.reload) { window.location.reload(); }
            else if (d.error) {
                document.getElementById('gen-status').textContent = 'Error: ' + d.error;
                document.getElementById('gen-status').className = 'status error';
            }
        })
        .catch(function() { btn.textContent = 'Generate app.bicep'; btn.disabled = false; });
});
radiusSetupRepoBranch('gen-repo', 'gen-branch', '${escapeHtml(targetRepo)}', '${escapeHtml(targetBranch)}');
<\/script>`);
}

export function graphHeader(activePage) {
    const pages = [
        { id: 'graph', label: 'Modeled' },
        { id: 'planned', label: 'Planned' },
        { id: 'deployed', label: 'Deployed' },
        { id: 'graph-diff', label: 'Diff' }
    ];
    const navLinks = pages.map(p => {
        const cls = p.id === activePage ? 'rad-subtab rad-subtab--active' : 'rad-subtab';
        return `<a href="?page=${p.id}" data-page="${p.id}" class="${cls}" onclick="radiusNavTo(event, '${p.id}')">${p.label}</a>`;
    }).join('\n  ');
    return `
<div class="rad-heading">
  <h1>${radiusMark(26)}<span>Application Graph</span></h1>
  <p class="rad-lede">
    Visualize your application as you've designed it (<strong>Modeled</strong>), as you want it deployed (<strong>Planned</strong>), and as it's running in your environments (<strong>Deployed</strong>) &mdash; plus the differences between branches (<strong>Diff</strong>).
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

export function graphPage(state) {
    const resources = state?.graphResources || [];
    const resourcesJson = JSON.stringify(resources);
    const targetRepo = state?.graphTargetRepo || state?.contextRepo || '';
    const graphBranch = state?.graphBranch || state?.contextBranch || 'main';

    if (resources.length === 0) {
        return pageShell("Application Graph", `
${graphHeader('graph')}
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Repository</label>
    <select id="graph-repo" class="rad-select" style="min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="graph-branch" class="rad-select">
      <option value="">Select repo first</option>
    </select>
  </div>
  <button id="load-graph-btn" class="rad-btn rad-btn--primary" style="margin-top:0;">Generate Graph</button>
</div>
<div id="graph-status" class="status info">Select a repository and click Generate Graph. If no app.bicep exists, one will be generated from the repo structure.</div>
<div id="graph-container-wrapper"></div>
<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(graphBranch)}';
radiusSetupRepoBranch('graph-repo', 'graph-branch', CONTEXT_REPO, CONTEXT_BRANCH);

document.getElementById('load-graph-btn').addEventListener('click', function() {
    var repo = document.getElementById('graph-repo').value.trim();
    var branch = document.getElementById('graph-branch').value.trim() || 'main';
    if (!repo) return;
    this.textContent = '⏳ Generating...';
    this.disabled = true;
    var btn = this;
    var wrapper = document.getElementById('graph-container-wrapper');
    wrapper.innerHTML = '<div id="graph-container"></div>';
    var container = document.getElementById('graph-container');
    var statusEl = document.getElementById('graph-status');
    if (statusEl) { statusEl.style.display = 'none'; }
    container.innerHTML = '<div id="progress-panel" style="padding:20px; max-width:500px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--text-color-default, #1f2328);">Generating Application Graph</span>' +
        '</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--text-color-muted, #656d76); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--border-color-default,#d0d7de);border-top-color:var(--rad-brand, #da4c2a);border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand, #da4c2a);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--text-color-default,#1f2328);font-weight:500}</style>';

    var stepsEl = document.getElementById('progress-steps');
    var shownSteps = 0;

    // Poll for progress updates
    var pollInterval = setInterval(function() {
        fetch('/api/progress').then(function(r) { return r.json(); }).then(function(d) {
            var msgs = d.messages || [];
            for (var i = shownSteps; i < msgs.length; i++) {
                // Mark previous as done
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

    // Start the generation
    fetch('/api/load-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            clearInterval(pollInterval);
            btn.textContent = 'Generate Graph';
            btn.disabled = false;
            if (d.reload) {
                // Final progress update
                var prev = stepsEl.querySelector('.step-active');
                if (prev) prev.className = 'step-done';
                var doneDiv = document.createElement('div');
                doneDiv.className = 'step-done';
                doneDiv.textContent = 'Graph ready!';
                stepsEl.appendChild(doneDiv);
                setTimeout(function() { window.location.reload(); }, 600);
            } else if (d.error) {
                container.innerHTML = '';
                if (statusEl) { statusEl.textContent = 'Error: ' + d.error; statusEl.className = 'status error'; statusEl.style.display = ''; }
            }
        })
        .catch(function() { clearInterval(pollInterval); btn.textContent = 'Generate Graph'; btn.disabled = false; container.innerHTML = ''; });
});
<\/script>
${graphHeaderClose()}`);
    }

    return pageShell("Application Graph", `
${graphHeader('graph')}
${''/* bicepGenerated note moved below graph container */}
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Repository</label>
    <select id="graph-repo" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="${escapeHtml(targetRepo)}" selected>${escapeHtml(targetRepo)}</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="${escapeHtml(graphBranch)}" selected>${escapeHtml(graphBranch || 'main')}</option>
    </select>
  </div>
  <button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;">Deploy Application</button>
</div>
<div id="graph-container"></div>
<div style="margin-top:8px; font-size:12px; color:var(--text-color-muted, #656d76);">
${state.bicepGenerated ? 'Generated from repo analysis — no existing app.bicep was found. ' : ''}Click a node to view source code links.
</div>

<script>
// Auto-populate repos dropdown
radiusSetupRepoBranch('graph-repo', 'graph-branch', document.getElementById('graph-repo').value, document.getElementById('graph-branch').value);

// Deploy Application → move to the planned deployment flow.
document.getElementById('deploy-app-btn').addEventListener('click', function(e) {
    radiusNavTo(e, 'planned');
});

var resources = ${resourcesJson};
var repoUrl = 'https://github.com/' + document.getElementById('graph-repo').value.trim();
var branch = document.getElementById('graph-branch').value.trim() || 'main';
radiusRenderGraph('graph-container', resources, {
    repoUrl: repoUrl,
    branch: branch,
    bicepGenerated: ${state.bicepGenerated ? 'true' : 'false'}
});
<\/script>
${graphHeaderClose()}`);
}

export function plannedGraphPage(state) {
    const targetRepo = state?.plannedRepo || state?.graphTargetRepo || state?.contextRepo || '';
    const provider = state?.plannedProvider || state?.deployProvider || 'azure';
    const plannedResources = state?.plannedResources || [];
    const graphBranch = state?.plannedBranch || state?.contextBranch || 'main';
    const hasCredentials = !!(state?.oidcAzure || state?.oidcAws);
    const bicepGenerated = !!state?.plannedBicepGenerated;

    const resourcesJson = JSON.stringify(plannedResources);

    if (plannedResources.length === 0) {
        return pageShell("Planned Graph", `
${graphHeader('planned')}
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="planned-repo" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="planned-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px;">
      <option value="">Select repo first</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Cloud Provider</label>
    <select id="planned-provider" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:140px;">
      <option value="azure"${provider === 'azure' ? ' selected' : ''}>Azure</option>
      <option value="aws"${provider === 'aws' ? ' selected' : ''}>AWS</option>
    </select>
  </div>
  <button id="plan-btn" style="padding:6px 14px; background:#1a7f37; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Plan Deployment</button>
</div>
<div id="plan-status" class="status info">Configure your target environment and click "Plan Deployment" to see what resources will be created.</div>
<div id="graph-container-wrapper"></div>
<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(graphBranch)}';
radiusSetupRepoBranch('planned-repo', 'planned-branch', CONTEXT_REPO, CONTEXT_BRANCH);

document.getElementById('plan-btn').addEventListener('click', function() {
    var repo = document.getElementById('planned-repo').value.trim();
    var branch = document.getElementById('planned-branch').value.trim() || 'main';
    var provider = document.getElementById('planned-provider').value;
    if (!repo) return;
    this.textContent = '⏳ Planning...';
    this.disabled = true;
    var btn = this;
    var statusEl = document.getElementById('plan-status');
    if (statusEl) statusEl.style.display = 'none';
    var wrapper = document.getElementById('graph-container-wrapper');
    wrapper.innerHTML = '<div id="graph-container"></div>';
    var container = document.getElementById('graph-container');
    container.innerHTML = '<div id="progress-panel" style="padding:20px; max-width:500px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--text-color-default, #1f2328);">Planning Deployment</span>' +
        '</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--text-color-muted, #656d76); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--border-color-default,#d0d7de);border-top-color:#1a7f37;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand, #da4c2a);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--text-color-default,#1f2328);font-weight:500}</style>';
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
    fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch, provider: provider}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            clearInterval(pollInterval);
            btn.textContent = 'Plan Deployment';
            btn.disabled = false;
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
                if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Error: ' + d.error; statusEl.className = 'status error'; }
            }
        })
        .catch(function() { clearInterval(pollInterval); btn.textContent = 'Plan Deployment'; btn.disabled = false; });
});
<\/script>
${graphHeaderClose()}`);
    }

    // Render the planned graph with real resources
    return pageShell("Planned Graph", `
${graphHeader('planned')}
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="planned-repo" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="planned-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px;">
      <option value="">Select repo first</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Cloud Provider</label>
    <select id="planned-provider" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:140px;">
      <option value="azure"${provider === 'azure' ? ' selected' : ''}>Azure</option>
      <option value="aws"${provider === 'aws' ? ' selected' : ''}>AWS</option>
    </select>
  </div>
  <button id="plan-btn" style="padding:6px 14px; background:#1a7f37; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Re-Plan</button>
</div>
<div class="legend" style="margin-bottom:12px;">
  <div class="legend-item"><svg width="18" height="14" style="vertical-align:middle"><rect x="1" y="3" width="16" height="9" rx="3" fill="#e8f0fe" stroke="#326ce5" stroke-width="1.5"/></svg> Compute</div>
  <div class="legend-item"><svg width="18" height="15" style="vertical-align:middle"><path d="M2 4 a6 2 0 0 1 12 0 v6 a6 2 0 0 1 -12 0 z" fill="#fdf0e3" stroke="#e48400" stroke-width="1.5"/><ellipse cx="8" cy="4" rx="6" ry="2" fill="#fdf0e3" stroke="#e48400" stroke-width="1.5"/></svg> Data Store</div>
  <div class="legend-item"><svg width="18" height="15" style="vertical-align:middle"><polygon points="5,2 13,2 17,7.5 13,13 5,13 1,7.5" fill="#fdeceb" stroke="#d82c20" stroke-width="1.5"/></svg> Cache</div>
  <div class="legend-item"><svg width="18" height="14" style="vertical-align:middle"><polygon points="4,2 14,2 17,5 17,9 14,12 4,12 1,9 1,5" fill="#e9f5ee" stroke="#1a7f37" stroke-width="1.5"/></svg> Secrets</div>
  <div class="legend-item"><svg width="18" height="14" style="vertical-align:middle"><polygon points="1,2 12,2 17,7 12,12 1,12" fill="#f2ecfb" stroke="#8250df" stroke-width="1.5"/></svg> Networking</div>
  <div class="legend-item"><svg width="18" height="14" style="vertical-align:middle"><rect x="1" y="3" width="16" height="9" rx="3" fill="#ede9f7" stroke="#6639ba" stroke-width="1.5"/></svg> Other</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--rad-bg-subtle); border:1px dashed var(--rad-stroke-strong); border-radius:3px;"></div> Cloud Resource</div>
</div>
<div id="graph-container"></div>

<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
var CONTEXT_BRANCH = '${escapeHtml(graphBranch)}';
radiusSetupRepoBranch('planned-repo', 'planned-branch', CONTEXT_REPO, CONTEXT_BRANCH);

document.getElementById('plan-btn').addEventListener('click', function() {
    var repo = document.getElementById('planned-repo').value.trim();
    var branch = document.getElementById('planned-branch').value.trim() || 'main';
    var provider = document.getElementById('planned-provider').value;
    if (!repo) return;
    this.textContent = 'Planning...';
    this.disabled = true;
    var btn = this;
    // Clear existing graph
    var container = document.getElementById('graph-container');
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--text-color-muted,#656d76);gap:10px;"><div class="spinner" style="width:20px;height:20px;border:3px solid var(--rad-stroke,#e1e4e8);border-top-color:var(--rad-primary,#1a7f37);border-radius:50%;animation:spin 0.8s linear infinite;"></div><span>Planning deployment...</span></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch, provider: provider}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            btn.textContent = 'Re-Plan';
            btn.disabled = false;
            if (d.reload) { window.location.reload(); }
            else if (d.error) { container.innerHTML = '<div class="status error">' + d.error + '</div>'; }
        });
});

var resources = ${resourcesJson};
radiusRenderGraph('graph-container', resources, {
    repoUrl: 'https://github.com/' + CONTEXT_REPO,
    branch: CONTEXT_BRANCH,
    bicepGenerated: ${bicepGenerated ? 'true' : 'false'}
});
<\/script>
${graphHeaderClose()}`);
}

export function graphDiffPage(state) {
    const resources = state?.diffResources || [];
    const baseBranch = state?.diffBase || 'main';
    const headBranch = state?.diffHead || '';
    const branches = state?.branches || [];
    const branchShas = state?.branchShas || {};

    const branchOptionsBase = branches.map(b => {
        const sha = branchShas[b] ? ` (${branchShas[b].slice(0,7)})` : '';
        return `<option value="${b}"${b === baseBranch ? ' selected' : ''}>${b}${sha}</option>`;
    }).join('');
    const branchOptionsHead = branches.map(b => {
        const sha = branchShas[b] ? ` (${branchShas[b].slice(0,7)})` : '';
        return `<option value="${b}"${b === headBranch ? ' selected' : ''}>${b}${sha}</option>`;
    }).join('');

    if (resources.length === 0) {
        const targetRepo = state?.diffTargetRepo || state?.contextRepo || '';
        return pageShell("Graph Diff", `
${graphHeader('graph-diff')}
<div style="display:flex; gap:16px; align-items:flex-start; margin-bottom:12px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="diff-repo-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
</div>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Base</label>
    <select id="base-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px; width:auto; max-width:400px;">
      <option value="">Select repo first</option>
    </select>
  </div>
  <span style="font-size:18px; color:var(--text-color-muted, #656d76);">→</span>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Head</label>
    <select id="head-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px; width:auto; max-width:400px;">
      <option value="">Select repo first</option>
    </select>
  </div>
  <button id="compare-btn" style="padding:6px 14px; background:#1a7f37; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Compare</button>
</div>
<div id="diff-status" class="status info">Select a repository to load branches.</div>
<script>
var STATE_BASE = '${escapeHtml(baseBranch)}';
var STATE_HEAD = '${escapeHtml(headBranch)}';
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';

// Load repos and auto-select context repo
radiusPopulateRepos('diff-repo-select', CONTEXT_REPO).then(function() {
    var sel = document.getElementById('diff-repo-select');
    if (sel.value) loadBranches(sel.value);
});

document.getElementById('diff-repo-select').addEventListener('change', function() {
    if (this.value) loadBranches(this.value);
});

function loadBranches(repo) {
    document.getElementById('diff-status').textContent = 'Loading branches...';
    radiusPopulateBranches(['base-branch', 'head-branch'], repo, [STATE_BASE || 'main', STATE_HEAD || '']).then(function() {
        document.getElementById('diff-status').textContent = 'Ready — select base and head branches, then click Compare.';
        if (STATE_BASE && STATE_HEAD) {
            document.getElementById('compare-btn').click();
        }
    });
}

document.getElementById('compare-btn').addEventListener('click', function() {
    var base = document.getElementById('base-branch').value;
    var head = document.getElementById('head-branch').value;
    var repo = document.getElementById('diff-repo-select').value;
    if (!repo || !base || !head) return;
    this.textContent = 'Comparing...';
    this.disabled = true;
    var btn = this;
    document.getElementById('diff-status').textContent = 'Fetching app.bicep (or generating from repo structure if not found)...';
    fetch('/api/diff-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({base: base, head: head, repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            btn.textContent = 'Compare';
            btn.disabled = false;
            if (d.error) { document.getElementById('diff-status').textContent = d.error; document.getElementById('diff-status').className = 'status error'; }
            else if (d.reload) { window.location.reload(); }
            else if (d.message) { document.getElementById('diff-status').textContent = d.message; }
        });
});
<\/script>
${graphHeaderClose()}`);
    }
    const resourcesJson = JSON.stringify(resources);
    const added = resources.filter(r => r.diffStatus === "added").length;
    const removed = resources.filter(r => r.diffStatus === "removed").length;
    const modified = resources.filter(r => r.diffStatus === "modified").length;
    const unchanged = resources.filter(r => r.diffStatus === "unchanged").length;
    const targetRepo = state?.diffTargetRepo || state?.contextRepo || '';
    return pageShell("Graph Diff", `
${graphHeader('graph-diff')}
<div style="display:flex; gap:16px; align-items:flex-start; margin-bottom:12px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="diff-repo-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="${escapeHtml(targetRepo)}" selected>${escapeHtml(targetRepo)}</option>
    </select>
  </div>
</div>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Base</label>
    <select id="base-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px; width:auto; max-width:400px;">
      ${branchOptionsBase}
    </select>
  </div>
  <span style="font-size:18px; color:var(--text-color-muted, #656d76);">→</span>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Head</label>
    <select id="head-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px; width:auto; max-width:400px;">
      ${branchOptionsHead}
    </select>
  </div>
  <button id="compare-btn" style="padding:6px 14px; background:#1a7f37; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Compare</button>
</div>
<div id="graph-container"></div>
<div style="margin-top:12px; font-size:13px;">
  <strong>Changes:</strong>
  <span style="color:#1a7f37">+${added} added</span>,
  <span style="color:#cf222e">-${removed} removed</span>,
  <span style="color:#bf8700">~${modified} modified</span>,
  ${unchanged} unchanged
</div>
${(added === 0 && removed === 0 && modified === 0) ? `<div style="margin-top:12px; padding:10px 14px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; color:var(--text-color-muted, #656d76);">✅ No application graph changes detected in this PR. The application model is identical between <strong>${escapeHtml(baseBranch)}</strong> and <strong>${escapeHtml(headBranch)}</strong>.</div>` : ''}

<script>
var resources = ${resourcesJson};
radiusRenderGraph('graph-container', resources, { diffMode: true });

var DIFF_BASE = '${escapeHtml(baseBranch)}';
var DIFF_HEAD = '${escapeHtml(headBranch)}';

// Auto-populate repos dropdown
radiusPopulateRepos('diff-repo-select', document.getElementById('diff-repo-select').value);

// Refresh the branch lists from GitHub on load so newly-created branches (e.g. a
// PR branch pushed after this diff was last cached) appear in the dropdowns,
// while preserving the currently-compared base/head selection.
radiusPopulateBranches(['base-branch', 'head-branch'], document.getElementById('diff-repo-select').value, [DIFF_BASE || 'main', DIFF_HEAD || '']);

document.getElementById('diff-repo-select').addEventListener('change', function() {
    if (this.value) {
        radiusPopulateBranches(['base-branch', 'head-branch'], this.value, [document.getElementById('base-branch').value || 'main', document.getElementById('head-branch').value || '']);
    }
});

document.getElementById('compare-btn').addEventListener('click', function() {
    var base = document.getElementById('base-branch').value;
    var head = document.getElementById('head-branch').value;
    var repo = document.getElementById('diff-repo-select').value;
    if (!repo || !base || !head) return;
    this.textContent = 'Comparing...';
    this.disabled = true;
    var btn = this;
    fetch('/api/diff-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({base: base, head: head, repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            btn.textContent = 'Compare';
            btn.disabled = false;
            if (d.error) { alert(d.error); }
            else if (d.reload) { window.location.reload(); }
        });
});
<\/script>
${graphHeaderClose()}`);
}

export function deployedGraphPage(state) {
    const targetRepo = state?.contextRepo || state?.deployingRepo || state?.plannedRepo || state?.graphTargetRepo || '';
    return pageShell("Deployed Graph", `
${graphHeader('deployed')}
<div class="rad-deployed-controls">
  <div class="rad-field">
    <label for="deployed-app-select">Application:</label>
    <div class="rad-select-wrap"><select id="deployed-app-select"><option value="">Loading…</option></select></div>
  </div>
  <div class="rad-field">
    <label for="deployed-env-select">Environment:</label>
    <div class="rad-select-wrap"><select id="deployed-env-select"><option value="">Loading…</option></select></div>
  </div>
</div>
<button id="deployed-delete-btn" class="rad-btn rad-btn--danger" style="margin:0 0 18px;" disabled>Delete Deployment</button>

<div id="deployed-inline-status" style="display:none; margin:0 0 14px; padding:10px 12px; border-radius:8px; font-size:13px;"></div>

<div class="rad-card" style="margin:0;">
  <div id="deployed-graph-label" style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:12px; line-height:1.5;"></div>
  <div id="deployed-status" class="status info">Loading deployed application graph…</div>
  <div id="graph-container"></div>
</div>

<!-- Delete confirmation modal -->
<div id="deployed-delete-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:50; align-items:center; justify-content:center;">
  <div class="rad-card" style="max-width:460px; width:90%; margin:0;">
    <div class="rad-card__title" style="margin-bottom:8px;">Delete Deployment</div>
    <p id="deployed-delete-text" style="margin:0 0 18px; font-size:14px; color:var(--rad-text-secondary); line-height:1.5;"></p>
    <div style="display:flex; justify-content:flex-end; gap:10px;">
      <button id="deployed-delete-cancel" class="rad-btn rad-btn--neutral" style="margin:0;">Cancel</button>
      <button id="deployed-delete-confirm" class="rad-btn rad-btn--danger" style="margin:0;">Delete Deployment</button>
    </div>
  </div>
</div>

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
</style>
<script>
var CONTEXT_REPO = ${JSON.stringify(targetRepo)};

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

    function showInline(kind, msg) {
        inlineStatus.style.display = 'block';
        inlineStatus.textContent = msg;
        if (kind === 'error') { inlineStatus.style.background = '#ffebe9'; inlineStatus.style.color = '#82071e'; inlineStatus.style.border = '1px solid #cf222e'; }
        else { inlineStatus.style.background = '#ddf4ff'; inlineStatus.style.color = '#0a3069'; inlineStatus.style.border = '1px solid #54aeff'; }
    }

    function refreshControls() {
        var app = appSelect.value, env = envSelect.value;
        deleteBtn.disabled = !(CONTEXT_REPO && app && env);
        labelEl.innerHTML = (app && env)
            ? 'Application: <strong>' + escapeHtmlClient(app) + '</strong><br>Environment: <strong>' + escapeHtmlClient(env) + '</strong>'
            : '';
    }

    function showNothing(msg) {
        if (statusEl) { statusEl.style.display = 'none'; }
        container.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; min-height:240px; color:var(--rad-text-tertiary,#656d76); font-size:14px; border:1px dashed var(--rad-stroke,#d1d9e0); border-radius:6px;">' + (msg || 'Nothing deployed yet') + '</div>';
    }

    function renderGraph(resources) {
        if (statusEl) { statusEl.style.display = 'none'; }
        radiusRenderGraph('graph-container', resources, {
            repoUrl: 'https://github.com/' + CONTEXT_REPO,
            branch: 'main',
            showLegend: true
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
            if (liveRes.length && (st === 'in_progress' || st === 'success')) {
                renderGraph(liveRes);
                if (st === 'in_progress') { pollTimer = setTimeout(loadGraph, 3000); }
                return;
            }
            // Fall back to the terminal deployed graph from the status branch.
            fetch('/api/deployed-graph?repo=' + encodeURIComponent(CONTEXT_REPO)).then(function(r) { return r.json(); }).then(function(d) {
                var resources = (d && d.resources) || [];
                if (!resources.length) { showNothing('Nothing deployed yet'); return; }
                renderGraph(resources);
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
                if (!envs.length) { envSelect.innerHTML = '<option value="">No environments</option>'; return; }
                envSelect.innerHTML = envs.map(function(e) { return '<option value="' + escapeHtmlClient(e.name) + '">' + escapeHtmlClient(e.name) + '</option>'; }).join('');
                if (wantEnv) { envSelect.value = wantEnv; }
            })
            .catch(function() { envSelect.innerHTML = '<option value="">Could not load</option>'; });
    }

    appSelect.addEventListener('change', function() { refreshControls(); loadGraph(); });
    envSelect.addEventListener('change', function() { refreshControls(); loadGraph(); });

    // --- Delete deployment ---
    var delModal = document.getElementById('deployed-delete-modal');
    var delText = document.getElementById('deployed-delete-text');
    var delConfirm = document.getElementById('deployed-delete-confirm');
    var delCancel = document.getElementById('deployed-delete-cancel');

    deleteBtn.addEventListener('click', function() {
        var app = appSelect.value, env = envSelect.value;
        if (!app || !env) return;
        delText.innerHTML = 'Are you sure you want to delete the deployment of application <strong>' + escapeHtmlClient(app) + '</strong> in environment <strong>' + escapeHtmlClient(env) + '</strong>?';
        delModal.style.display = 'flex';
    });
    delCancel.addEventListener('click', function() { delModal.style.display = 'none'; });
    delModal.addEventListener('click', function(e) { if (e.target === delModal) { delModal.style.display = 'none'; } });
    delConfirm.addEventListener('click', function() {
        var app = appSelect.value, env = envSelect.value;
        if (!app || !env) return;
        delModal.style.display = 'none';
        document.getElementById('deployed-deleting-text').innerHTML = 'Removing <strong>' + escapeHtmlClient(app) + '</strong> from <strong>' + escapeHtmlClient(env) + '</strong>. This may take a moment.';
        document.getElementById('deployed-deleting-modal').style.display = 'flex';
        fetch('/api/delete-deployment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CONTEXT_REPO, environment: env }) })
            .then(function(r) { return r.json(); })
            .then(function() { window.location.href = '/?page=deploying'; })
            .catch(function() {
                document.getElementById('deployed-deleting-modal').style.display = 'none';
                showInline('error', 'Could not delete the deployment. Please try again.');
            });
    });

    Promise.all([loadApplications(), loadEnvironments()]).then(function() {
        refreshControls();
        loadGraph();
    });
})();
<\/script>
${graphHeaderClose()}`);
}

export function environmentPage(state) {
    const oidcAzure = state?.oidcAzure || sharedCredentials.azure;
    const oidcAws = state?.oidcAws || sharedCredentials.aws;
    const hasAzure = !!oidcAzure;
    const hasAws = !!oidcAws;
    const provider = state?.deployProvider || (hasAzure ? 'azure' : hasAws ? 'aws' : 'azure');
    const envName = state?.envName || 'dev';
    const appFile = state?.appFile || 'app.bicep';
    const existingEnvs = state?.existingEnvs || ['dev', 'staging', 'production'];
    // Deployment reads files and dispatches workflows via GitHub, so an unpushed
    // worktree-only branch cannot be deployed. Default to 'main' in that case so
    // the branch dropdown does not silently mislead the user.
    const deployContextBranch = state?.contextBranch || 'main';
    const deployWorkspaceBranch = state?.workspaceBranch || '';
    const deployBranchShas = state?.branchShas || {};
    const deployDefaultBranch = (deployWorkspaceBranch && deployContextBranch === deployWorkspaceBranch && deployBranchShas[deployWorkspaceBranch] === 'worktree')
        ? 'main'
        : deployContextBranch;

    // If deployment result exists, show it
    if (state?.deployResult) {
        const r = state.deployResult;
        return pageShell(r.error ? "Deployment Failed" : "Deployment Initiated", `
<h1>${r.error ? "⚠ Deployment Failed" : "🚀 Deployment Initiated"}</h1>
<div class="status ${r.error ? "error" : "success"}">${escapeHtml(r.error || r.message)}</div>
${r.workflowUrl ? `<p style="margin-top:12px;"><a href="${escapeHtml(r.workflowUrl)}" target="_blank" style="color:var(--rad-brand, #da4c2a);">View GitHub Actions workflow run →</a></p>` : ""}
${r.workflow ? `<h2>Generated Workflow</h2><pre style="max-height:400px; overflow:auto;">${escapeHtml(r.workflow)}</pre>` : ""}
<button id="back-btn" style="margin-top:16px; padding:8px 16px; background:var(--border-color-default, #d1d9e0); color:var(--text-color-default, #1f2328); border:none; border-radius:6px; font-size:13px; cursor:pointer;">← Back to Deploy</button>
<script>
document.getElementById('back-btn').addEventListener('click', function() {
    fetch('/api/deploy-reset', { method: 'POST' }).then(function() { window.location.reload(); });
});
<\/script>`);
    }

    const ctxRepo = state?.targetRepo || state?.contextRepo || '';
    const ctxBranch = state?.contextBranch || state?.plannedBranch || state?.graphBranch || 'main';

    return pageShell("Environments", `
<div class="rad-heading">
  <h1>${radiusMark(26)}<span>Environments</span></h1>
  <p class="rad-lede">An Environment defines where applications are deployed, i.e. a landing zone for applications. Deploy your application into an environment to run it with a specific infrastructure configuration.</p>
</div>

<!-- Landing: New Environment button + environments table -->
<div id="env-landing">
  <button id="new-env-btn" class="rad-btn rad-btn--primary" style="margin:0 0 16px;">New Environment</button>
  <div class="rad-table-wrap">
    <table class="rad-table">
      <thead><tr><th>Environment</th><th>Status</th><th>Provider</th><th>Actions</th></tr></thead>
      <tbody id="env-table-body">
        <tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Create Environment form (revealed by New Environment / Deploy Apps / edit) -->
<div id="env-form" style="display:none;">
  <div class="rad-card">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <div class="rad-card__title" style="margin:0;">Create Environment</div>
      <button id="cancel-env-btn" type="button" class="rad-link" style="background:none; border:none; padding:0; margin:0; font-size:12px; font-weight:500; color:var(--rad-info,#0969da); cursor:pointer;">← Back to environments</button>
    </div>
    <div class="rad-section">
      <div class="rad-field"><label>Provider</label>
        <select id="env-provider-select" class="rad-select" style="max-width:280px;">
          <option value="azure" selected>Azure</option>
        </select>
      </div>
      <div class="rad-field" style="margin-top:12px;"><label>Environment Name</label>
        <input id="env-name-input" type="text" placeholder="e.g. aks-prod" value="${escapeHtml(envName)}" style="max-width:280px;" />
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; max-width:580px;">
        <div class="rad-field"><label>Target Repository</label>
          <select id="deploy-repo-select" class="rad-select">
            <option value="${escapeHtml(ctxRepo)}" selected>${escapeHtml(ctxRepo || 'Loading...')}</option>
          </select>
          <input type="hidden" id="target-repo" value="${escapeHtml(ctxRepo)}" />
        </div>
        <div class="rad-field"><label>Branch</label>
          <select id="deploy-branch-select" class="rad-select">
            <option value="" disabled selected>Loading...</option>
          </select>
        </div>
      </div>
    </div>

<!-- Azure Panel -->
<div id="panel-azure" style="${provider === 'azure' ? '' : 'display:none;'}">
  <div style="margin-bottom:16px; padding:12px 16px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px;">
    <h3 style="margin:0 0 8px 0; font-size:15px; font-weight:600;">Account</h3>
    <p style="font-size:12px; color:var(--text-color-muted, #656d76); margin:0 0 10px 0;">
      Enter your Azure tenant and subscription, then verify your CLI login to ensure you have the necessary credentials.
    </p>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:10px;">
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Tenant ID</label>
        <input id="az-tenant-id" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(oidcAzure?.tenantId || '')}" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px;" />
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Subscription ID</label>
        <input id="az-sub-id" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(oidcAzure?.subscriptionId || '')}" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px;" />
      </div>
    </div>
    <input type="hidden" id="az-client-id" value="${escapeHtml(oidcAzure?.clientId || '')}" />
    <button id="btn-verify-azure" class="rad-btn rad-btn--info" style="margin-top:0; padding:6px 14px; font-size:12px;">Verify Credentials</button>
    <div id="verify-azure-status" style="margin-top:8px; font-size:12px; display:none;"></div>
  </div>

  <div style="margin-bottom:16px; padding:12px 16px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px;">
    <h3 style="margin:0 0 4px 0; font-size:15px; font-weight:600;">Infrastructure</h3>
    <div id="azure-discover-status" style="font-size:11px; color:var(--text-color-muted, #656d76); margin-bottom:10px;">Discovering resources...</div>
    <div style="display:flex; flex-direction:column; gap:4px; max-width:410px; margin-bottom:12px;">
      <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Resource Group</label>
      <select id="azure-rg-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
        <option value="" disabled selected>Loading...</option>
      </select>
      <input id="azure-rg-custom" type="text" placeholder="Enter resource group" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Cluster</label>
        <select id="azure-cluster-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="azure-cluster-custom" type="text" placeholder="Enter cluster name" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Namespace</label>
        <select id="azure-namespace-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="azure-namespace-custom" type="text" placeholder="Enter namespace" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
    </div>
  </div>
  </div>

<!-- AWS Panel -->
<div id="panel-aws" style="${provider === 'aws' ? '' : 'display:none;'}">
  <div style="margin-bottom:16px; padding:12px 16px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px;">
    <h3 style="margin:0 0 4px 0; font-size:15px; font-weight:600;">Infrastructure</h3>
    <div id="aws-discover-status" style="font-size:11px; color:var(--text-color-muted, #656d76); margin-bottom:10px;">Discovering resources...</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">EKS Cluster</label>
        <select id="aws-cluster-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="aws-cluster-custom" type="text" placeholder="Enter cluster name" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Namespace</label>
        <select id="aws-namespace-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="aws-namespace-custom" type="text" placeholder="Enter namespace" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">VPC</label>
        <select id="aws-vpc-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="aws-vpc-custom" type="text" placeholder="vpc-xxxxxxxx" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Subnets</label>
        <select id="aws-subnets-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="aws-subnets-custom" type="text" placeholder="subnet-xxx,subnet-yyy" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
    </div>
  </div>
</div>

<div id="deploy-status" style="margin-top:12px; display:none;"></div>
<div id="deploy-log" style="display:none; margin-top:16px;">
  <h3 style="font-size:13px; font-weight:600; margin-bottom:8px;">Deployment Log</h3>
  <div id="log-output" style="background:#1e1e1e; color:#d4d4d4; font-family:var(--font-mono, monospace); font-size:12px; padding:12px; border-radius:6px; max-height:350px; overflow-y:auto; white-space:pre-wrap; line-height:1.6;"></div>
</div>

<div class="rad-section">
  <div style="display:flex;">
    <button id="deploy-btn" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;">Create Environment</button>
  </div>
</div>
  </div>
</div>

<div id="env-creating-modal" style="display:none; position:fixed; inset:0; z-index:1000; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
  <div style="display:flex; align-items:center; gap:16px; background:var(--background-color-default,#fff); color:var(--text-color-default,#1f2328); border:1px solid var(--border-color-muted,#d8dee4); border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,0.18); padding:22px 26px; max-width:340px;">
    <div class="env-pie-spinner" style="flex:0 0 auto; width:34px; height:34px; border-radius:50%; background:conic-gradient(var(--rad-info,#0969da) 0turn 0.75turn, var(--border-color-muted,#d8dee4) 0.75turn 1turn); animation:spin 1s linear infinite;"></div>
    <div style="min-width:0;">
      <div id="env-creating-title" style="font-size:14px; line-height:1.4;">Creating environment…</div>
      <div style="font-size:12px; color:var(--text-color-muted,#656d76); margin-top:2px;">This may take a few moments</div>
    </div>
  </div>
</div>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>

<script>
var CTX_REPO = '${escapeHtml(ctxRepo)}';
var CTX_BRANCH = '${escapeHtml(ctxBranch)}';

// --- Landing table <-> Create Environment form toggle ---------------------
var envLanding = document.getElementById('env-landing');
var envForm = document.getElementById('env-form');
var envNameInput = document.getElementById('env-name-input');

function showEnvForm(preset) {
    preset = preset || {};
    if (preset.name !== undefined) envNameInput.value = preset.name;
    if (preset.provider) {
        var ps = document.getElementById('env-provider-select');
        ps.value = preset.provider;
        applyProvider(preset.provider);
    }
    envLanding.style.display = 'none';
    envForm.style.display = '';
    envNameInput.focus();
}
function showEnvLanding() {
    envForm.style.display = 'none';
    envLanding.style.display = '';
    loadEnvTable();
}
document.getElementById('new-env-btn').addEventListener('click', function() { showEnvForm({ name: '' }); });
document.getElementById('cancel-env-btn').addEventListener('click', showEnvLanding);

// --- Environments table (best-effort real data from GitHub) ---------------
function statusCell(status) {
    var map = { success: ['success','Success'], failed: ['failed','Failed'], pending: ['pending','Pending'] };
    var m = map[status] || map.pending;
    return '<span class="rad-dot rad-dot--' + m[0] + '"></span><span class="rad-status-label">' + m[1] + '</span>';
}
function loadEnvTable() {
    var body = document.getElementById('env-table-body');
    if (!CTX_REPO) {
        body.innerHTML = '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td>' +
            '<td class="rad-table__actions"><button class="rad-btn rad-btn--info js-create-env" style="margin:0;">Create New Environment</button></td></tr>';
        wireEmptyState();
        return;
    }
    body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>';
    fetch('/api/list-environments?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var envs = (data && data.environments) || [];
            if (envs.length === 0) {
                body.innerHTML = '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td>' +
                    '<td class="rad-table__actions"><button class="rad-btn rad-btn--info js-create-env" style="margin:0;">Create New Environment</button></td></tr>';
                wireEmptyState();
                return;
            }
            body.innerHTML = envs.map(function(e) {
                var prov = e.provider || '—';
                var editHref = e.webUrl || ('https://github.com/' + CTX_REPO + '/settings/environments');
                return '<tr>' +
                    '<td class="rad-table__env">' + escapeHtmlClient(e.name) + '</td>' +
                    '<td>' + statusCell(e.status) + '</td>' +
                    '<td class="rad-table__provider">' + escapeHtmlClient(prov) + '</td>' +
                    '<td class="rad-table__actions">' +
                        '<a class="rad-link" href="' + escapeHtmlClient(editHref) + '" target="_blank" rel="noopener noreferrer">edit</a>' +
                        '<button class="rad-btn rad-btn--info js-deploy-apps" data-env="' + escapeHtmlClient(e.name) + '" data-provider="' + escapeHtmlClient(e.provider || '') + '" style="margin:0;">Deploy Apps</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
            wireRowActions();
        })
        .catch(function() {
            body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Could not load environments.</td></tr>';
        });
}
function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}
function wireEmptyState() {
    var b = document.querySelector('.js-create-env');
    if (b) b.addEventListener('click', function() { showEnvForm({ name: '' }); });
}
function wireRowActions() {
    document.querySelectorAll('.js-deploy-apps').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var b = this;
            var envName = b.dataset.env;
            var provider = b.dataset.provider || 'azure';
            b.disabled = true;
            var prevLabel = b.textContent;
            b.textContent = 'Deploying…';
            fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    environment: envName,
                    provider: provider,
                    targetRepo: CTX_REPO,
                    branch: CTX_BRANCH,
                    appFile: '.radius/app.bicep'
                })
            }).then(function(r) { return r.json().catch(function() { return {}; }); })
              .then(function() { window.location.href = '/?page=deploying'; })
              .catch(function() {
                  b.disabled = false;
                  b.textContent = prevLabel;
                  alert('Could not start the deployment. Please try again.');
              });
        });
    });
}
loadEnvTable();

// --- Provider dropdown drives which infra panel is shown ------------------
var activeProvider = '${provider}';
function applyProvider(p) {
    activeProvider = p === 'aws' ? 'aws' : 'azure';
    document.getElementById('panel-azure').style.display = activeProvider === 'azure' ? '' : 'none';
    document.getElementById('panel-aws').style.display = activeProvider === 'aws' ? '' : 'none';
}
document.getElementById('env-provider-select').addEventListener('change', function() { applyProvider(this.value); });
applyProvider(activeProvider);

// Combo select: show custom input when "__custom__" is chosen
function setupCombo(selectId, customId) {
    var sel = document.getElementById(selectId);
    var inp = document.getElementById(customId);
    sel.addEventListener('change', function() {
        inp.style.display = this.value === '__custom__' ? '' : 'none';
        if (this.value === '__custom__') inp.focus();
    });
}
setupCombo('azure-cluster-select', 'azure-cluster-custom');
setupCombo('azure-rg-select', 'azure-rg-custom');
setupCombo('azure-namespace-select', 'azure-namespace-custom');
setupCombo('aws-cluster-select', 'aws-cluster-custom');
setupCombo('aws-namespace-select', 'aws-namespace-custom');
setupCombo('aws-vpc-select', 'aws-vpc-custom');
setupCombo('aws-subnets-select', 'aws-subnets-custom');

// Deploy repo + branch selects — wired via the shared repo/branch library
radiusSetupRepoBranch('deploy-repo-select', 'deploy-branch-select', '${escapeHtml(state?.targetRepo || state?.contextRepo || '')}', '${escapeHtml(deployDefaultBranch)}');

// Keep the hidden target-repo input in sync for deploy submission
(function syncTargetRepo() {
    var sel = document.getElementById('deploy-repo-select');
    var inp = document.getElementById('target-repo');
    if (!sel || !inp) { setTimeout(syncTargetRepo, 100); return; }
    var sync = function() { inp.value = sel.value; };
    sel.addEventListener('change', sync);
    sync();
})();

// Populate a select element with discovered items
function populateSelect(selectId, items, placeholder) {
    var sel = document.getElementById(selectId);
    sel.innerHTML = '';
    if (items.length === 0) {
        var opt = document.createElement('option');
        opt.value = ''; opt.disabled = true; opt.selected = true;
        opt.textContent = 'No resources found';
        sel.appendChild(opt);
    } else {
        var ph = document.createElement('option');
        ph.value = ''; ph.disabled = true; ph.selected = true;
        ph.textContent = placeholder || 'Select...';
        sel.appendChild(ph);
        for (var i = 0; i < items.length; i++) {
            var o = document.createElement('option');
            o.value = items[i].id || items[i];
            o.textContent = items[i].name || items[i].id || items[i];
            sel.appendChild(o);
        }
    }
    var custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '+ Enter custom...';
    sel.appendChild(custom);
}

// Cross-filter the Azure Resource Group and AKS Cluster combos:
//  - selecting a Resource Group narrows the cluster list to that group
//  - selecting a cluster narrows the Resource Group box to the cluster's group
function setupAzureInfraFilter() {
    var clusterSel = document.getElementById('azure-cluster-select');
    var rgSel = document.getElementById('azure-rg-select');
    if (!clusterSel || !rgSel || clusterSel.__filterWired) return;
    clusterSel.__filterWired = true;

    function rebuild(selectId, items, placeholder, keepValue) {
        populateSelect(selectId, items, placeholder);
        if (!keepValue) return;
        var sel = document.getElementById(selectId);
        for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === keepValue) { sel.value = keepValue; return; }
        }
    }
    function findCluster(cid) {
        var list = window.__azureClusters || [];
        for (var i = 0; i < list.length; i++) {
            if ((list[i].id || list[i].name) === cid) return list[i];
        }
        return null;
    }

    rgSel.addEventListener('change', function() {
        var rg = rgSel.value;
        if (rg === '__custom__' || rg === '') {
            rebuild('azure-cluster-select', window.__azureClusters || [], 'Select AKS cluster...', clusterSel.value);
            return;
        }
        var filtered = (window.__azureClusters || []).filter(function(c) { return c.resourceGroup === rg; });
        rebuild('azure-cluster-select', filtered, 'Select AKS cluster...', clusterSel.value);
    });

    clusterSel.addEventListener('change', function() {
        var cid = clusterSel.value;
        if (cid === '__custom__' || cid === '') return;
        var cluster = findCluster(cid);
        if (!cluster || !cluster.resourceGroup) return;
        var matchRg = (window.__azureRgs || []).filter(function(g) { return (g.id || g.name) === cluster.resourceGroup; });
        if (matchRg.length === 0) matchRg = [{ id: cluster.resourceGroup, name: cluster.resourceGroup }];
        rebuild('azure-rg-select', matchRg, 'Select resource group...', cluster.resourceGroup);
    });
}

// Discover resources from the cloud provider
function discoverResources(provider) {
    var payload = { provider: provider };
    if (provider === 'azure') {
        var subId = document.getElementById('az-sub-id') ? document.getElementById('az-sub-id').value.trim() : '';
    var tenantId = document.getElementById('az-tenant-id') ? document.getElementById('az-tenant-id').value.trim() : '';
    if (subId) payload.subscriptionId = subId;
    if (tenantId) payload.tenantId = tenantId;
}
    fetch('/api/discover', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (provider === 'azure') {
                document.getElementById('azure-discover-status').textContent = data.error ? 'Discovery failed: ' + data.error : 'Found ' + (data.clusters||[]).length + ' cluster(s), ' + (data.resourceGroups||[]).length + ' resource group(s)';
                window.__azureClusters = data.clusters || [];
                window.__azureRgs = data.resourceGroups || [];
                populateSelect('azure-cluster-select', window.__azureClusters, 'Select AKS cluster...');
                populateSelect('azure-rg-select', window.__azureRgs, 'Select resource group...');
                populateSelect('azure-namespace-select', data.namespaces || ['default', 'kube-system', 'radius-system'], 'Select namespace...');
                setupAzureInfraFilter();
            } else {
                document.getElementById('aws-discover-status').textContent = data.error ? 'Discovery failed: ' + data.error : 'Found ' + (data.clusters||[]).length + ' cluster(s), ' + (data.vpcs||[]).length + ' VPC(s)';
                populateSelect('aws-cluster-select', data.clusters || [], 'Select EKS cluster...');
                populateSelect('aws-namespace-select', data.namespaces || ['default', 'kube-system', 'radius-system'], 'Select namespace...');
                populateSelect('aws-vpc-select', [{id:'', name:'None (optional)'}].concat(data.vpcs || []), 'Select VPC...');
                populateSelect('aws-subnets-select', [{id:'', name:'None (optional)'}].concat(data.subnets || []), 'Select subnets...');
            }
        })
        .catch(function(e) {
            if (provider === 'azure') {
                document.getElementById('azure-discover-status').textContent = 'Discovery error: ' + e.message;
            } else {
                document.getElementById('aws-discover-status').textContent = 'Discovery error: ' + e.message;
            }
        });
}

// Discovery is intentionally NOT run on load or while typing Tenant/Subscription
// IDs. It only runs when the user clicks "Verify Azure Login" (see handler below),
// which keeps the server responsive and avoids firing cloud-CLI calls per keystroke.

// Verify Azure Login button handler
document.getElementById('btn-verify-azure').addEventListener('click', function() {
    var btn = this;
    var statusEl = document.getElementById('verify-azure-status');
    var tenantId = document.getElementById('az-tenant-id').value.trim();
    var subId = document.getElementById('az-sub-id').value.trim();

    btn.disabled = true;
    btn.textContent = '⏳ Verifying...';
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span style="color:var(--text-color-muted, #656d76);">Logging into Azure CLI...</span>';

    fetch('/api/verify-azure-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantId, subscriptionId: subId })
    }).then(function(r) { return r.json(); }).then(function(data) {
        btn.disabled = false;
        btn.textContent = 'Verify Credentials';
        if (data.error) {
            statusEl.innerHTML = '<span style="color:#cf222e;">❌ ' + data.error + '</span>';
        } else {
            statusEl.innerHTML = '<span style="color:#1a7f37;">✅ Logged in as <strong>' + (data.user || 'unknown') + '</strong> — ' + (data.subscriptionName || data.subscriptionId || '') + '</span>';
            // Auto-fill tenant/sub if returned
            if (data.tenantId && !tenantId) document.getElementById('az-tenant-id').value = data.tenantId;
            if (data.subscriptionId && !subId) document.getElementById('az-sub-id').value = data.subscriptionId;
            // Re-discover resources with verified credentials
            discoverResources('azure');
        }
    }).catch(function(err) {
        btn.disabled = false;
        btn.textContent = 'Verify Credentials';
        statusEl.innerHTML = '<span style="color:#cf222e;">❌ Error: ' + err.message + '</span>';
    });
});

function getComboValue(selectId, customId) {
    var sel = document.getElementById(selectId);
    if (sel.value === '__custom__') return document.getElementById(customId).value;
    return sel.value;
}

function appendLog(text, color) {
    var logEl = document.getElementById('log-output');
    var line = document.createElement('div');
    line.style.color = color || '#d4d4d4';
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

// Creates Azure OIDC credentials (App Registration + federated credential +
// Contributor role) via the az CLI, then populates the credential fields.
// Returns a Promise that resolves with the created credentials or rejects with
// an Error. Invoked as part of the "Create Environment" flow when no client ID
// has been provided yet.
function runAzureAutoSetup(params) {
    return fetch('/api/azure-auto-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repo: params.repo,
            environment: params.environment,
            resourceGroup: params.resourceGroup,
            cluster: params.cluster,
            subscriptionId: document.getElementById('az-sub-id') ? document.getElementById('az-sub-id').value.trim() : '',
            tenantId: document.getElementById('az-tenant-id') ? document.getElementById('az-tenant-id').value.trim() : ''
        })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
            var detail = data.steps && data.steps.length ? ' — ' + data.steps.join('; ') : '';
            throw new Error(data.error + detail);
        }
        if (data.clientId) document.getElementById('az-client-id').value = data.clientId;
        if (data.tenantId) document.getElementById('az-tenant-id').value = data.tenantId;
        if (data.subscriptionId) document.getElementById('az-sub-id').value = data.subscriptionId;
        return data;
    });
}

document.getElementById('deploy-btn').addEventListener('click', function() {
    var btn = this;
    var statusEl = document.getElementById('deploy-status');
    var env = envNameInput.value.trim();
    if (!env) { statusEl.style.display = 'block'; statusEl.className = 'status error'; statusEl.textContent = 'Please enter an environment name.'; return; }
    var provider = activeProvider;
    var appFile = 'app.bicep';
    var targetRepo = document.getElementById('target-repo').value.trim();
    if (!targetRepo) { statusEl.style.display = 'block'; statusEl.className = 'status error'; statusEl.textContent = 'Please specify a target repository (owner/repo).'; return; }
    var cluster, namespace, vpc, subnets, resourceGroup;

    if (provider === 'azure') {
        cluster = getComboValue('azure-cluster-select', 'azure-cluster-custom');
        namespace = getComboValue('azure-namespace-select', 'azure-namespace-custom') || 'default';
        resourceGroup = getComboValue('azure-rg-select', 'azure-rg-custom');
        if (!cluster) { statusEl.style.display = 'block'; statusEl.className = 'status error'; statusEl.textContent = 'Please specify an AKS cluster.'; return; }
    } else {
        cluster = getComboValue('aws-cluster-select', 'aws-cluster-custom');
        namespace = getComboValue('aws-namespace-select', 'aws-namespace-custom') || 'default';
        vpc = getComboValue('aws-vpc-select', 'aws-vpc-custom');
        subnets = getComboValue('aws-subnets-select', 'aws-subnets-custom');
        if (!cluster) { statusEl.style.display = 'block'; statusEl.className = 'status error'; statusEl.textContent = 'Please specify an EKS cluster.'; return; }
    }

    btn.textContent = 'Creating environment...';
    btn.disabled = true;
    statusEl.style.display = 'none';

    // Show the Figma-style "Creating … Environment …" modal overlay.
    var creatingModal = document.getElementById('env-creating-modal');
    var creatingTitle = document.getElementById('env-creating-title');
    var providerLabel = provider === 'aws' ? 'AWS' : 'Azure';

    function failEnv(msg) {
        creatingModal.style.display = 'none';
        btn.textContent = 'Create Environment';
        btn.disabled = false;
        statusEl.style.display = 'block';
        statusEl.className = 'status error';
        statusEl.textContent = msg;
    }

    // For Azure, create OIDC credentials as part of "Create Environment" when no
    // client ID has been provided yet (verified/entered manually or from a prior
    // auto-setup). This folds the old separate "Auto-create credentials" step in.
    var needsAzureCreds = provider === 'azure' && !document.getElementById('az-client-id').value.trim();
    var preflight;
    if (needsAzureCreds) {
        creatingTitle.innerHTML = 'Creating credentials for <strong>' + escapeHtmlClient(env) + '</strong>…';
        creatingModal.style.display = 'flex';
        preflight = runAzureAutoSetup({ repo: targetRepo, environment: env, resourceGroup: resourceGroup, cluster: cluster });
    } else {
        creatingTitle.innerHTML = 'Creating <strong>' + providerLabel + '</strong> Environment <strong>' + escapeHtmlClient(env) + '</strong>…';
        creatingModal.style.display = 'flex';
        preflight = Promise.resolve(null);
    }

    preflight.then(function() {
        creatingTitle.innerHTML = 'Creating <strong>' + providerLabel + '</strong> Environment <strong>' + escapeHtmlClient(env) + '</strong>…';

        // Build the environment payload with the (possibly just-created) credentials.
        var envData = { repo: targetRepo, environment: env, provider: provider, cluster: cluster };
        envData.branch = (document.getElementById('deploy-branch-select') || {}).value || 'main';
        if (provider === 'azure') {
            envData.clientId = document.getElementById('az-client-id').value.trim();
            envData.tenantId = document.getElementById('az-tenant-id').value.trim();
            envData.subscriptionId = document.getElementById('az-sub-id').value.trim();
            envData.resourceGroup = resourceGroup;
        } else {
            envData.roleArn = document.querySelector('[data-aws-role-arn]')?.dataset?.awsRoleArn || '';
            envData.region = document.querySelector('[data-aws-region]')?.dataset?.awsRegion || '';
            envData.accountId = document.querySelector('[data-aws-account-id]')?.dataset?.awsAccountId || '';
            envData.vpcId = vpc;
            envData.subnetIds = subnets;
        }

        return fetch('/api/create-environment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envData)
        }).then(function(r) { return r.json(); }).then(function(envResult) {
            if (envResult.error) {
                failEnv('Environment setup failed: ' + envResult.error);
                return;
            }
            // Environment (credentials + workflows) is created and the verify
            // workflow was dispatched. Wait for verification to complete before
            // returning to the list — the environment isn't "ready" until both
            // the GitHub environment exists AND credentials verify successfully.
            creatingTitle.innerHTML = 'Verifying credentials for <strong>' + escapeHtmlClient(env) + '</strong>…';
            btn.textContent = 'Verifying credentials...';

            var pollStart = Date.now();
            var VERIFY_TIMEOUT_MS = 8 * 60 * 1000;
            function pollVerify() {
                fetch('/api/verify-status?repo=' + encodeURIComponent(targetRepo) + '&environment=' + encodeURIComponent(env))
                    .then(function(r) { return r.json(); })
                    .then(function(v) {
                        if (v.state === 'success') {
                            creatingModal.style.display = 'none';
                            btn.textContent = 'Create Environment';
                            btn.disabled = false;
                            statusEl.style.display = 'none';
                            showEnvLanding();
                            loadEnvTable();
                            return;
                        }
                        if (v.state === 'failed') {
                            failEnv('Credential verification failed. ' + (v.error || '') + (v.runUrl ? '\\nView the run: ' + v.runUrl : ''));
                            return;
                        }
                        if (Date.now() - pollStart > VERIFY_TIMEOUT_MS) {
                            failEnv('Timed out waiting for credential verification to complete.' + (v.runUrl ? ' It may still be running — view it at ' + v.runUrl : ''));
                            return;
                        }
                        setTimeout(pollVerify, 5000);
                    })
                    .catch(function() {
                        if (Date.now() - pollStart > VERIFY_TIMEOUT_MS) {
                            failEnv('Timed out waiting for credential verification to complete.');
                            return;
                        }
                        setTimeout(pollVerify, 5000);
                    });
            }
            pollVerify();
        });
    }).catch(function(err) {
        failEnv('Failed: ' + (err.message || 'unknown error'));
    });
});
<\/script>`);
}

export function deployingPage(state) {
    // The Deployments tab is a landing page (application + environment
    // selectors, a Deploy button, and a table of existing deployments). While a
    // deployment is actively running we swap in the live progress view instead.
    if (state?.deployStatus === 'in_progress') {
        return deployProgressView(state);
    }
    return deployLandingView(state);
}

function deployLandingView(state) {
    const ctxRepo = state?.contextRepo || state?.plannedRepo || state?.graphTargetRepo || state?.deployingRepo || '';
    const ctxBranch = state?.contextBranch || state?.plannedBranch || state?.graphBranch || 'main';

    return pageShell("Deployments", `
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
  <button id="deploy-now-btn" class="rad-btn rad-btn--primary" style="margin:0;" disabled>Deploy</button>
</div>

<div id="deploy-inline-status" style="display:none; margin:0 0 14px; padding:10px 12px; border-radius:8px; font-size:13px;"></div>

<div class="rad-table-wrap">
  <table class="rad-table">
    <thead><tr><th>Application</th><th>Environment</th><th>Status</th><th>Action</th></tr></thead>
    <tbody id="deploy-table-body">
      <tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>
    </tbody>
  </table>
</div>

<!-- Deploying (transition) modal -->
<div id="deploy-progress-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:60; align-items:center; justify-content:center;">
  <div class="rad-card" style="max-width:520px; width:90%; margin:0; display:flex; align-items:center; gap:18px;">
    <div class="rad-spinner-lg" aria-hidden="true"></div>
    <div>
      <div id="deploy-progress-title" style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:4px;"></div>
      <div style="font-size:13px; color:var(--rad-text-secondary);">This may take a few moments, redirecting to deployment status view…</div>
    </div>
  </div>
</div>

<!-- Deleting (transition) modal -->
<div id="deploy-deleting-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:60; align-items:center; justify-content:center;">
  <div class="rad-card" style="max-width:520px; width:90%; margin:0; display:flex; align-items:center; gap:18px;">
    <div class="rad-spinner-lg" aria-hidden="true"></div>
    <div>
      <div style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:4px;">Deleting Deployment…</div>
      <div id="deploy-deleting-text" style="font-size:13px; color:var(--rad-text-secondary);"></div>
    </div>
  </div>
</div>

<!-- Delete confirmation modal -->
<div id="deploy-delete-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:50; align-items:center; justify-content:center;">
  <div class="rad-card" style="max-width:460px; width:90%; margin:0;">
    <div class="rad-card__title" style="margin-bottom:8px;">Delete Deployment</div>
    <p id="deploy-delete-text" style="margin:0 0 18px; font-size:14px; color:var(--rad-text-secondary); line-height:1.5;"></p>
    <div style="display:flex; justify-content:flex-end; gap:10px;">
      <button id="deploy-delete-cancel" class="rad-btn rad-btn--neutral" style="margin:0;">Cancel</button>
      <button id="deploy-delete-confirm" class="rad-btn rad-btn--danger" style="margin:0;">Delete Deployment</button>
    </div>
  </div>
</div>

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
  .rad-btn--danger { background:#c93c37; color:#fff; }
  .rad-btn--danger:hover { background:#b52f2a; }
  .rad-deploy-applink { display:inline-flex; align-items:center; gap:6px; color:#1f6feb; text-decoration:underline; font-weight:600; font-size:14px; }
  .rad-deploy-applink:hover { color:#388bfd; }
  .rad-spinner-lg { flex:0 0 auto; width:34px; height:34px; border:4px solid var(--rad-stroke,#e1e4e8); border-top-color:#1f6feb; border-radius:50%; animation:spin 0.8s linear infinite; }
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
var inlineStatus = document.getElementById('deploy-inline-status');
var ENV_PROVIDERS = {};

function showInline(kind, msg) {
    inlineStatus.style.display = 'block';
    inlineStatus.textContent = msg;
    if (kind === 'error') { inlineStatus.style.background = '#ffebe9'; inlineStatus.style.color = '#82071e'; inlineStatus.style.border = '1px solid #cf222e'; }
    else { inlineStatus.style.background = '#ddf4ff'; inlineStatus.style.color = '#0a3069'; inlineStatus.style.border = '1px solid #54aeff'; }
}

function refreshDeployBtn() {
    deployBtn.disabled = !(CTX_REPO && appSelect.value && envSelect.value);
}

function loadApplications() {
    if (!CTX_REPO) { appSelect.innerHTML = '<option value="">No repository</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = (d && d.applications) || [];
            if (apps.length === 0) { appSelect.innerHTML = '<option value="">No applications</option>'; return; }
            appSelect.innerHTML = apps.map(function(a) { return '<option value="' + escapeHtmlClient(a.name) + '">' + escapeHtmlClient(a.name) + '</option>'; }).join('');
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
            if (envs.length === 0) { envSelect.innerHTML = '<option value="">No environments</option>'; return; }
            ENV_PROVIDERS = {};
            envs.forEach(function(e) { ENV_PROVIDERS[e.name] = e.provider || 'azure'; });
            envSelect.innerHTML = envs.map(function(e) { return '<option value="' + escapeHtmlClient(e.name) + '">' + escapeHtmlClient(e.name) + '</option>'; }).join('');
            refreshDeployBtn();
        })
        .catch(function() { envSelect.innerHTML = '<option value="">Could not load</option>'; });
}

function statusCell(status) {
    var map = { success: ['success','Success'], failed: ['failed','Failed'], pending: ['pending','Pending'] };
    var m = map[status] || map.pending;
    return '<span class="rad-dot rad-dot--' + m[0] + '"></span><span class="rad-status-label">' + m[1] + '</span>';
}

function loadDeployments() {
    var body = document.getElementById('deploy-table-body');
    if (!CTX_REPO) { body.innerHTML = '<tr><td class="rad-table__env" colspan="4">No application deployments yet.</td></tr>'; return; }
    body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>';
    fetch('/api/list-deployments?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var deps = (d && d.deployments) || [];
            if (deps.length === 0) { body.innerHTML = '<tr><td class="rad-table__env" colspan="4">No application deployments yet.</td></tr>'; return; }
            var appHref = 'https://github.com/' + CTX_REPO;
            body.innerHTML = deps.map(function(dep) {
                return '<tr>' +
                    '<td class="rad-table__env"><a class="rad-deploy-applink" href="' + escapeHtmlClient(appHref) + '" target="_blank" rel="noopener noreferrer">↗ ' + escapeHtmlClient(dep.app) + '</a></td>' +
                    '<td>' + escapeHtmlClient(dep.environment) + '</td>' +
                    '<td>' + statusCell(dep.status) + '</td>' +
                    '<td class="rad-table__actions"><button class="rad-btn rad-btn--danger js-del-dep" data-env="' + escapeHtmlClient(dep.environment) + '" data-app="' + escapeHtmlClient(dep.app) + '" style="margin:0;">Delete Deployment</button></td>' +
                '</tr>';
            }).join('');
            wireDeleteButtons();
        })
        .catch(function() { body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Could not load deployments.</td></tr>'; });
}

// --- Delete deployment modal ---
var delModal = document.getElementById('deploy-delete-modal');
var delText = document.getElementById('deploy-delete-text');
var delConfirm = document.getElementById('deploy-delete-confirm');
var delCancel = document.getElementById('deploy-delete-cancel');
var pendingDelete = null;

function wireDeleteButtons() {
    document.querySelectorAll('.js-del-dep').forEach(function(btn) {
        btn.addEventListener('click', function() {
            pendingDelete = { environment: this.dataset.env, app: this.dataset.app };
            delText.innerHTML = 'Are you sure you want to delete the deployment of application <strong>' + escapeHtmlClient(pendingDelete.app) + '</strong> in environment <strong>' + escapeHtmlClient(pendingDelete.environment) + '</strong>?';
            delModal.style.display = 'flex';
        });
    });
}
delCancel.addEventListener('click', function() { delModal.style.display = 'none'; pendingDelete = null; });
delModal.addEventListener('click', function(e) { if (e.target === delModal) { delModal.style.display = 'none'; pendingDelete = null; } });
delConfirm.addEventListener('click', function() {
    if (!pendingDelete) return;
    var dep = pendingDelete;
    delModal.style.display = 'none';
    document.getElementById('deploy-deleting-text').innerHTML = 'Removing <strong>' + escapeHtmlClient(dep.app) + '</strong> from <strong>' + escapeHtmlClient(dep.environment) + '</strong>. This may take a moment.';
    document.getElementById('deploy-deleting-modal').style.display = 'flex';
    fetch('/api/delete-deployment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, environment: dep.environment }) })
        .then(function(r) { return r.json(); })
        .then(function() {
            document.getElementById('deploy-deleting-modal').style.display = 'none';
            pendingDelete = null;
            loadDeployments();
        })
        .catch(function() {
            document.getElementById('deploy-deleting-modal').style.display = 'none';
            pendingDelete = null;
            showInline('error', 'Could not delete the deployment. Please try again.');
        });
});

appSelect.addEventListener('change', refreshDeployBtn);
envSelect.addEventListener('change', refreshDeployBtn);

deployBtn.addEventListener('click', function() {
    var env = envSelect.value;
    var app = appSelect.value;
    if (!CTX_REPO || !env || !app) return;
    var provider = ENV_PROVIDERS[env] || 'azure';
    deployBtn.disabled = true;
    deployBtn.textContent = 'Deploying…';
    var progTitle = document.getElementById('deploy-progress-title');
    progTitle.innerHTML = 'Deploying <strong>' + escapeHtmlClient(app) + '</strong> to environment <strong>' + escapeHtmlClient(env) + '</strong>';
    document.getElementById('deploy-progress-modal').style.display = 'flex';
    fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: env, provider: provider, targetRepo: CTX_REPO, branch: CTX_BRANCH, appFile: '.radius/app.bicep' })
    }).then(function(r) { return r.json().catch(function() { return {}; }); })
      .then(function() { window.location.href = '/?page=deployed&environment=' + encodeURIComponent(env) + '&application=' + encodeURIComponent(app); })
      .catch(function() {
          document.getElementById('deploy-progress-modal').style.display = 'none';
          deployBtn.disabled = false;
          deployBtn.textContent = 'Deploy';
          showInline('error', 'Could not start the deployment. Please try again.');
      });
});

loadApplications();
loadEnvironmentsDropdown();
loadDeployments();
<\/script>`, 'deployments');
}

function deployProgressView(state) {
    const resources = state?.deployingResources || state?.plannedResources || [];
    const targetRepo = state?.deployingRepo || state?.deployParams?.targetRepo || state?.plannedRepo || state?.contextRepo || '';
    const targetBranch = state?.deployingBranch || state?.deployParams?.branch || state?.plannedBranch || state?.contextBranch || 'main';
    const provider = state?.deployingProvider || state?.deployParams?.provider || state?.plannedProvider || 'azure';
    const logs = state?.deployLogs || [];
    const deployStatus = state?.deployStatus || 'pending';
    const deployError = state?.deployError || '';
    const resourcesJson = JSON.stringify(resources);
    const logsJson = JSON.stringify(logs);

    return pageShell("Deploying", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#da4c2a"/><circle cx="64" cy="64" r="56" fill="#bb311e" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Deployment Progress</h1>
<p style="margin-bottom:12px; color: var(--text-color-muted, #656d76);">
  Deploying <strong>${escapeHtml(targetRepo)}</strong> (branch: <code>${escapeHtml(targetBranch)}</code>) to ${provider === 'aws' ? 'AWS' : 'Azure'}
</p>
<div id="deploy-error" style="display:${deployStatus === 'failed' && deployError ? 'block' : 'none'}; margin-bottom:12px; padding:12px 14px; background:#ffebe9; border:1px solid #cf222e; border-radius:6px;">
  <div style="font-size:13px; font-weight:600; color:#cf222e; margin-bottom:6px;">❌ Deployment failed</div>
  <pre id="deploy-error-text" style="margin:0; white-space:pre-wrap; word-break:break-word; font-family:var(--font-mono, monospace); font-size:12px; color:#82071e; max-height:220px; overflow-y:auto;">${escapeHtml(deployError)}</pre>
</div>
<div class="legend" style="margin-bottom:12px;">
  <div class="legend-item"><div class="legend-dot" style="background:#8b949e;"></div> Not Started</div>
  <div class="legend-item"><div class="legend-dot" style="background:#d29922;"></div> In Progress</div>
  <div class="legend-item"><div class="legend-dot" style="background:#1a7f37;"></div> Deployed</div>
  <div class="legend-item"><div class="legend-dot" style="background:#cf222e;"></div> Failed</div>
</div>
<h2 style="font-size:14px; font-weight:600; margin-bottom:8px;">Planned Application Graph</h2>
<div id="graph-container" style="height:400px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; margin-bottom:16px;"></div>
<div id="deploy-log-section">
  <h2 style="font-size:14px; font-weight:600; margin-bottom:8px;">Deployment Logs</h2>
  <div id="deploy-log-output" style="background:#1e1e1e; color:#d4d4d4; font-family:var(--font-mono, monospace); font-size:12px; padding:12px; border-radius:6px; max-height:250px; overflow-y:auto; white-space:pre-wrap; line-height:1.6;"></div>
</div>

${getInlineVendorScripts()}
<script>
cytoscape.use(cytoscapeDagre);

var STATUS_COLORS = {
    pending: { border: '#8b949e', bg: '#f6f8fa' },
    in_progress: { border: '#d29922', bg: '#fff8c5' },
    postponed: { border: '#d29922', bg: '#fff8c5' },
    waiting: { border: '#d29922', bg: '#fff8c5' },
    success: { border: '#1a7f37', bg: '#dcffe4' },
    failed: { border: '#cf222e', bg: '#ffebe9' }
};

function getStatusColor(status) {
    return STATUS_COLORS[status] || STATUS_COLORS.pending;
}

var resources = ${resourcesJson};
var DEPLOY_REPO = ${JSON.stringify(targetRepo)};
var DEPLOY_BRANCH = ${JSON.stringify(targetBranch)};
var DEPLOY_PROVIDER = ${JSON.stringify(provider)};

if (resources.length === 0) {
    var emptyMsg = document.getElementById('graph-container');
    function showPlanningSpinner(msg) {
        emptyMsg.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-color-muted,#656d76);flex-direction:column;gap:8px;"><div class="spinner" style="width:20px;height:20px;border:3px solid #e1e4e8;border-top-color:var(--rad-brand, #da4c2a);border-radius:50%;animation:spin 0.8s linear infinite;"></div><p style="font-size:14px;">' + msg + '</p></div>';
    }
    showPlanningSpinner('Loading deployment resources...');
    fetch('/api/deploy-status').then(function(r) { return r.json(); }).then(function(d) {
        if (d.resources && d.resources.length > 0) {
            window.location.reload();
            return;
        }
        // No planned graph yet — generate it on the fly from the target repo.
        if (DEPLOY_REPO) {
            showPlanningSpinner('Generating planned application graph for ' + DEPLOY_REPO + '...');
            fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: DEPLOY_REPO, branch: DEPLOY_BRANCH, provider: DEPLOY_PROVIDER }) })
                .then(function(r) { return r.json(); })
                .then(function(p) {
                    if (p && p.reload) { window.location.reload(); }
                    else {
                        emptyMsg.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-color-muted,#656d76);flex-direction:column;gap:8px;"><p style="font-size:14px;">Could not generate the planned graph.</p><p style="font-size:12px;">' + ((p && p.error) ? p.error : 'Unknown error') + '</p></div>';
                    }
                })
                .catch(function() {
                    emptyMsg.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-color-muted,#656d76);flex-direction:column;gap:8px;"><p style="font-size:14px;">Could not generate the planned graph.</p></div>';
                });
        } else {
            emptyMsg.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-color-muted,#656d76);flex-direction:column;gap:8px;"><p style="font-size:14px;">No resources to display.</p><p style="font-size:12px;">Navigate to the <strong>Planned Graph</strong> page first to plan your application, then deploy from the <strong>Environment</strong> page.</p></div>';
        }
    });
}

// Use the shared radiusRenderGraph renderer for consistent graph display
var cy = radiusRenderGraph('graph-container', resources, { enablePopup: true });

// After rendering, apply deployment status colors to nodes
if (cy) {
    cy.nodes().forEach(function(node) {
        var nodeId = node.id();
        // Find the matching resource by id/name
        var r = resources.find(function(res) { return (res.id || res.name) === nodeId; });
        if (r) {
            var status = r.deployStatus || 'pending';
            var colors = getStatusColor(status);
            node.style('border-color', colors.border);
            node.style('border-width', 3);
            node.style('background-color', colors.bg);
            node.data('status', status);
        }
        // Check if it's an output resource node
        if (nodeId.includes('/output/')) {
            var parentId = nodeId.split('/output/')[0];
            var parentRes = resources.find(function(res) { return (res.id || res.name) === parentId; });
            if (parentRes && parentRes.outputResources) {
                var outName = nodeId.split('/output/')[1];
                var out = parentRes.outputResources.find(function(o) { return o.name === outName; });
                if (out) {
                    var outStatus = out.deployStatus || 'pending';
                    var outColors = getStatusColor(outStatus);
                    node.style('border-color', outColors.border);
                    node.style('border-width', 2);
                    node.style('background-color', outColors.bg);
                    node.data('status', outStatus);
                    if (out.portalUrl) node.data('portalUrl', out.portalUrl);
                }
            }
        }
    });
}

// Log output
var logOutput = document.getElementById('deploy-log-output');
var logs = ${logsJson};
// Absolute count of log lines already rendered (base offset + embedded lines),
// so polls can request only new lines via ?since= and never re-pull the whole buffer.
var LOG_TOTAL = ${(state?.deployLogBase || 0)} + logs.length;
for (var l = 0; l < logs.length; l++) {
    logOutput.textContent += logs[l] + '\\n';
}
logOutput.scrollTop = logOutput.scrollHeight;

// Poll for deployment status updates
var deployPoll = setInterval(function() {
    fetch('/api/deploy-status?since=' + LOG_TOTAL).then(function(r) { return r.json(); }).then(function(d) {
        if (d.resources && cy) {
            for (var i = 0; i < d.resources.length; i++) {
                var r = d.resources[i];
                var nodeId = r.id || r.name;
                var node = cy.getElementById(nodeId);
                if (node.length) {
                    var colors = getStatusColor(r.deployStatus || 'pending');
                    node.style('border-color', colors.border);
                    node.style('background-color', colors.bg);
                    node.data('status', r.deployStatus);
                }
                if (r.outputResources) {
                    for (var k = 0; k < r.outputResources.length; k++) {
                        var out = r.outputResources[k];
                        var outNode = cy.getElementById(nodeId + '/output/' + out.name);
                        if (outNode.length) {
                            var outColors = getStatusColor(out.deployStatus || 'pending');
                            outNode.style('border-color', outColors.border);
                            outNode.style('background-color', outColors.bg);
                            outNode.data('status', out.deployStatus);
                            if (out.portalUrl) outNode.data('portalUrl', out.portalUrl);
                        }
                    }
                }
            }
        }
        // Append new logs (incremental — server sends only lines past LOG_TOTAL)
        if (d.logsNew && d.logsNew.length) {
            for (var l = 0; l < d.logsNew.length; l++) {
                logOutput.textContent += d.logsNew[l] + '\\n';
            }
            logOutput.scrollTop = logOutput.scrollHeight;
        }
        if (typeof d.logTotal === 'number') { LOG_TOTAL = d.logTotal; }
        // Stop polling when deployment is complete
        if (d.status === 'complete' || d.status === 'failed') {
            clearInterval(deployPoll);
        }
        // Surface deployment error banner on failure
        if (d.status === 'failed' && d.error) {
            var errBox = document.getElementById('deploy-error');
            var errText = document.getElementById('deploy-error-text');
            if (errBox && errText) {
                errText.textContent = d.error;
                errBox.style.display = 'block';
            }
        }
    }).catch(function() {});
}, 1500);

// Do NOT auto-start a new deploy — the workflow was already triggered from the environment page.
// Just poll for status updates on the existing run.

// Node click handler for deep links to Azure Portal / AWS Console
if (cy) {
    cy.on('tap', 'node', function(e) {
        var node = e.target;
        var d = node.data();
        if (d.portalUrl) {
            window.open(d.portalUrl, '_blank');
        }
    });
    cy.on('mouseover', 'node', function(e) {
        var d = e.target.data();
        if (d.status === 'success' && d.portalUrl) {
            document.getElementById('graph-container').style.cursor = 'pointer';
            e.target.style('border-width', 4);
        }
    });
    cy.on('mouseout', 'node', function(e) {
        document.getElementById('graph-container').style.cursor = 'default';
        e.target.style('border-width', e.target.data('borderWidth') || 3);
    });
}
<\/script>`);
}
