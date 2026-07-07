// Canvas adapter — HTML page renderers. Each function is a `state => html`
// builder for one canvas page; together they are the entire server-side view
// layer. Browser behaviour lives in the embedded client JS (./client.mjs) and
// vendored libraries (./vendor.mjs); cross-cutting helpers/state come from
// ./shared.mjs. No I/O, routing, or business logic here.

import { escapeHtml, sharedCredentials } from "./shared.mjs";
import { getInlineVendorScripts } from "./vendor.mjs";
import { CLIENT_REPO_BRANCH_JS, CLIENT_GRAPH_JS, CLIENT_HEARTBEAT_JS } from "./client.mjs";

export function pageShell(title, bodyContent) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Ccircle cx='64' cy='64' r='64' fill='%23C9452B'/%3E%3Ccircle cx='64' cy='64' r='56' fill='%23BF3E24' opacity='0.3'/%3E%3Cline x1='64' y1='64' x2='34' y2='28' stroke='white' stroke-width='7' stroke-linecap='round'/%3E%3Ccircle cx='64' cy='64' r='8' fill='white'/%3E%3C/svg%3E" />
<title>${title} — Radius</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
    background: var(--background-color-default, #ffffff);
    color: var(--text-color-default, #1f2328);
    display: flex;
  }
  .sidebar {
    width: 48px;
    min-width: 48px;
    background: transparent;
    border-right: 1px solid var(--border-color-default, #d1d9e0);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 0;
    gap: 4px;
    height: 100vh;
  }
  .sidebar a {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    text-decoration: none;
    font-size: 18px;
    color: var(--text-color-muted, #656d76);
    transition: all 0.15s;
    position: relative;
  }
  .sidebar a:hover { background: var(--background-color-inset, #f6f8fa); }
  .sidebar a.active { background: var(--background-color-inset, #f6f8fa); color: #0969da; }
  .sidebar a .tooltip {
    display: none;
    position: absolute;
    left: 52px;
    top: 50%;
    transform: translateY(-50%);
    background: #24292f;
    color: #fff;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    white-space: nowrap;
    z-index: 100;
  }
  .sidebar a:hover .tooltip { display: block; }
  .main-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
    height: 100vh;
    min-width: 0;
  }
  h1 { font-size: var(--text-title-large, 22px); font-weight: var(--font-weight-semibold, 600); margin-bottom: 16px; }
  h2 { font-size: 16px; font-weight: 600; margin: 16px 0 8px; }
  .status { padding: 12px; border-radius: 6px; margin: 12px 0; }
  .status.info { background: #ddf4ff; border: 1px solid #54aeff; }
  .status.success { background: #dcffe4; border: 1px solid #2da44e; }
  .status.error { background: #ffebe9; border: 1px solid #cf222e; }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-color-default, #d1d9e0); margin-bottom: 16px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; user-select: none; }
  .tab.active { border-bottom-color: #0969da; color: #0969da; }
  code { font-family: var(--font-mono, monospace); font-size: 12px; background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }
  label { display: block; font-weight: 500; margin: 10px 0 4px; }
  input, select {
    width: 100%; padding: 8px 10px;
    border: 1px solid var(--border-color-default, #d1d9e0);
    border-radius: 6px; font-size: 13px;
    background: var(--background-color-default, #fff);
    color: var(--text-color-default, #1f2328);
    font-family: var(--font-mono, monospace);
  }
  input:focus, select:focus { outline: 2px solid var(--color-focus-outline, #0969da); }
  button, .verify-btn {
    display: inline-block; margin-top: 16px; padding: 8px 16px;
    background: #238636; color: #fff; border: none; border-radius: 6px;
    font-weight: 600; font-size: 13px; cursor: pointer;
  }
  button:hover, .verify-btn:hover { background: #2ea043; }
  .resolved-name { font-weight: 400; color: #1a7f37; font-size: 12px; }
  #graph-container { width: 100%; height: 450px; border: 1px solid var(--border-color-default, #d1d9e0); border-radius: 6px; position: relative; }
  #graph-container:empty { border-color: transparent; }
  .legend { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  .legend-swatch { width: 14px; height: 12px; border-radius: 3px; border: 2px solid #999; box-sizing: border-box; }
  .field { margin: 8px 0; }
  .field-label { font-weight: 500; color: var(--text-color-muted, #656d76); font-size: 12px; }
  .field-value { font-family: var(--font-mono, monospace); font-size: 13px; margin-top: 2px; }
  .field-value.placeholder { color: var(--text-color-muted, #656d76); font-style: italic; }
  select.radius-select { width: 100%; padding: 6px 10px; border: 1px solid var(--border-color-default, #d1d9e0); border-radius: 6px; font-size: 13px; appearance: auto; cursor: pointer; background: var(--background-color-default, #fff); min-width: 180px; }
</style>
</head>
<body>
<nav class="sidebar">
  <a href="/?page=graph" class="${title.includes('Application Graph') && !title.includes('Diff') && !title.includes('Planned') ? 'active' : ''}">📊<span class="tooltip">Model Graph</span></a>
  <a href="/?page=environment" class="${title.includes('Deploy') || title.includes('Environment') || title.includes('Accounts') || title.includes('Configure') ? 'active' : ''}">🚀<span class="tooltip">Environment</span></a>
</nav>
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
<div id="radius-reconnect-overlay" style="display:none; position:fixed; inset:0; z-index:9999; background:rgba(255,255,255,0.92); align-items:center; justify-content:center; flex-direction:column; gap:12px; font-family:var(--font-sans, -apple-system, sans-serif);">
  <div style="width:28px; height:28px; border:3px solid #d1d9e0; border-top-color:#C9452B; border-radius:50%; animation:radius-spin 0.8s linear infinite;"></div>
  <div style="font-size:13px; color:#656d76;">Reconnecting to Radius…</div>
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
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#C9452B"/><circle cx="64" cy="64" r="56" fill="#BF3E24" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Cloud Accounts</h1>
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
    if (state && state.generatedContent) {
        return pageShell("Generated app.bicep", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#C9452B"/><circle cx="64" cy="64" r="56" fill="#BF3E24" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>✓ app.bicep Generated</h1>
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
  <button id="gen-btn" style="padding:6px 14px; background:#0969da; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Regenerate</button>
</div>
<div class="status success">Successfully generated application model for ${escapeHtml(targetRepo)}</div>
<h2>Generated app.bicep</h2>
<pre>${escapeHtml(state.generatedContent)}</pre>
<script>
var CONTEXT_REPO = '${escapeHtml(targetRepo)}';
radiusSetupRepoBranch('gen-repo', 'gen-branch', CONTEXT_REPO, 'main');
document.getElementById('gen-btn').addEventListener('click', function() {
    var repo = document.getElementById('gen-repo').value.trim();
    if (!repo) return;
    this.textContent = 'Generating...';
    this.disabled = true;
    var btn = this;
    fetch('/api/generate-bicep', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: document.getElementById('gen-branch').value || 'main'}) })
        .then(function(r) { return r.json(); })
        .then(function(d) { btn.textContent = 'Regenerate'; btn.disabled = false; if (d.reload) window.location.reload(); });
});
<\/script>`);
    }
    return pageShell("Generate app.bicep", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#C9452B"/><circle cx="64" cy="64" r="56" fill="#BF3E24" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Generate Application Model</h1>
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
radiusSetupRepoBranch('gen-repo', 'gen-branch', '${escapeHtml(targetRepo)}', 'main');
<\/script>`);
}

export function graphHeader(activePage) {
    const pages = [
        { id: 'graph', label: 'Model' },
        { id: 'planned', label: 'Plan' },
        { id: 'graph-diff', label: 'Diff' },
        { id: 'deployed', label: 'Deployed' }
    ];
    const navLinks = pages.map(p => {
        const isActive = p.id === activePage;
        const style = isActive
            ? 'font-weight:600; color:var(--text-color-default, #1f2328); text-decoration:none; border-bottom:2px solid #0969da; padding-bottom:2px;'
            : 'color:var(--text-color-muted, #656d76); text-decoration:none; padding-bottom:2px; cursor:pointer;';
        return `<a href="?page=${p.id}" data-page="${p.id}" style="${style}" onclick="radiusNavTo(event, '${p.id}')">${p.label}</a>`;
    }).join('\n  ');
    return `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#C9452B"/><circle cx="64" cy="64" r="56" fill="#BF3E24" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Application Graph</h1>
<p style="margin-bottom:12px; color: var(--text-color-muted, #656d76);">
  Visualize your application as you've designed it (<strong>Model</strong>), as you want it deployed (<strong>Plan</strong>), and as it's running in your environments (<strong>Deployed</strong>) &mdash; plus the differences between branches (<strong>Diff</strong>).
</p>
<nav id="graph-nav" style="display:flex; gap:12px; margin-bottom:16px; font-size:13px;">
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
    const graphBranch = state?.graphBranch || 'main';

    if (resources.length === 0) {
        return pageShell("Application Graph", `
${graphHeader('graph')}
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="graph-repo" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="graph-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:180px;">
      <option value="">Select repo first</option>
    </select>
  </div>
  <button id="load-graph-btn" style="padding:6px 14px; background:#0969da; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Load Graph</button>
</div>
<div id="graph-status" class="status info">Select a repository and click Load Graph. If no app.bicep exists, one will be generated from the repo structure.</div>
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
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--border-color-default,#d0d7de);border-top-color:#0969da;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid #0969da;box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--text-color-default,#1f2328);font-weight:500}</style>';

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
            btn.textContent = 'Load Graph';
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
        .catch(function() { clearInterval(pollInterval); btn.textContent = 'Load Graph'; btn.disabled = false; container.innerHTML = ''; });
});
// Auto-load when context repo is provided
if (CONTEXT_REPO) {
    // Wait for radiusSetupRepoBranch to finish populating, then auto-click
    radiusPopulateRepos('graph-repo', CONTEXT_REPO).then(function() {
        var repoSel = document.getElementById('graph-repo');
        if (repoSel && repoSel.value) {
            return radiusPopulateBranches('graph-branch', repoSel.value, CONTEXT_BRANCH);
        }
    }).then(function() {
        document.getElementById('load-graph-btn').click();
    });
}
<\/script>
${graphHeaderClose()}`);
    }

    return pageShell("Application Graph", `
${graphHeader('graph')}
${''/* bicepGenerated note moved below graph container */}
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="graph-repo" style="padding:6px 10px; border:1px solid var(--border-color-default, #d0d7de); border-radius:6px; font-size:13px; min-width:180px; width:auto; max-width:400px; background:var(--background-color-default, #fff); color:var(--text-color-default, #1f2328);">
      <option value="${escapeHtml(targetRepo)}" selected>${escapeHtml(targetRepo)}</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="graph-branch" style="padding:6px 10px; border:1px solid var(--border-color-default, #d0d7de); border-radius:6px; font-size:13px; min-width:180px; width:auto; max-width:400px; background:var(--background-color-default, #fff); color:var(--text-color-default, #1f2328);">
      <option value="${escapeHtml(graphBranch)}" selected>${escapeHtml(graphBranch || 'main')}</option>
    </select>
  </div>
  <button id="load-graph-btn" style="padding:6px 14px; background:#0969da; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Reload</button>
</div>
<div id="graph-container"></div>
<div style="margin-top:8px; font-size:12px; color:var(--text-color-muted, #656d76);">
${state.bicepGenerated ? 'Generated from repo analysis — no existing app.bicep was found. ' : ''}Click a node to view source code links.
</div>

<script>
// Auto-populate repos dropdown
radiusSetupRepoBranch('graph-repo', 'graph-branch', document.getElementById('graph-repo').value, document.getElementById('graph-branch').value);

document.getElementById('load-graph-btn').addEventListener('click', function() {
    var repo = document.getElementById('graph-repo').value.trim();
    var branch = document.getElementById('graph-branch').value.trim() || 'main';
    if (!repo) return;
    this.textContent = '⏳ Generating...';
    this.disabled = true;
    var btn = this;
    radiusSetGraphLoading('graph-container');
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
    fetch('/api/load-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            clearInterval(pollInterval);
            btn.textContent = 'Reload';
            btn.disabled = false;
            if (d.reload) {
                var prev = stepsEl.querySelector('.step-active');
                if (prev) prev.className = 'step-done';
                var doneDiv = document.createElement('div');
                doneDiv.className = 'step-done';
                doneDiv.textContent = 'Graph ready!';
                stepsEl.appendChild(doneDiv);
                setTimeout(function() { window.location.reload(); }, 600);
            }
        })
        .catch(function() { clearInterval(pollInterval); btn.textContent = 'Reload'; btn.disabled = false; });
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
    const graphBranch = state?.plannedBranch || 'main';
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
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--border-color-default,#d0d7de);border-top-color:#1a7f37;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid #0969da;box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--text-color-default,#1f2328);font-weight:500}</style>';
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
  <div class="legend-item"><div class="legend-dot" style="background:#f6f8fa; border:1px dashed #8c959f; border-radius:3px;"></div> Cloud Resource</div>
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
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--text-color-muted,#656d76);gap:10px;"><div class="spinner" style="width:20px;height:20px;border:3px solid #e1e4e8;border-top-color:#1a7f37;border-radius:50%;animation:spin 0.8s linear infinite;"></div><span>Planning deployment...</span></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
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
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Repository</label>
    <select id="deployed-repo-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff); min-width:280px;">
      <option value="">Loading repos...</option>
    </select>
  </div>
</div>
<div id="deployed-status" class="status info">Loading deployed application graph…</div>
<div id="graph-container"></div>
<script>
var CONTEXT_REPO = ${JSON.stringify(targetRepo)};

(function() {
    var statusEl = document.getElementById('deployed-status');
    var container = document.getElementById('graph-container');

    function showNothing(msg) {
        if (statusEl) { statusEl.style.display = 'none'; }
        container.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; min-height:240px; color:var(--text-color-muted,#656d76); font-size:14px; border:1px dashed var(--border-color-default,#d1d9e0); border-radius:6px;">' + (msg || 'Nothing deployed yet') + '</div>';
    }

    function loadDeployedGraph(repo) {
        if (!repo) { showNothing('Nothing deployed yet'); return; }
        if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Loading deployed application graph…'; }
        container.innerHTML = '';
        fetch('/api/deployed-graph?repo=' + encodeURIComponent(repo)).then(function(r) { return r.json(); }).then(function(d) {
            if (d.error) { showNothing('Nothing deployed yet'); return; }
            var resources = d.resources || [];
            if (resources.length === 0) { showNothing('Nothing deployed yet'); return; }
            if (statusEl) { statusEl.style.display = 'none'; }
            radiusRenderGraph('graph-container', resources, {
                repoUrl: 'https://github.com/' + repo,
                branch: d.branch || 'main',
                showLegend: true
            });
        }).catch(function() { showNothing('Nothing deployed yet'); });
    }

    radiusPopulateRepos('deployed-repo-select', CONTEXT_REPO).then(function() {
        var sel = document.getElementById('deployed-repo-select');
        loadDeployedGraph(sel.value);
    });

    document.getElementById('deployed-repo-select').addEventListener('change', function() {
        loadDeployedGraph(this.value);
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

    // If deployment result exists, show it
    if (state?.deployResult) {
        const r = state.deployResult;
        return pageShell(r.error ? "Deployment Failed" : "Deployment Initiated", `
<h1>${r.error ? "⚠ Deployment Failed" : "🚀 Deployment Initiated"}</h1>
<div class="status ${r.error ? "error" : "success"}">${escapeHtml(r.error || r.message)}</div>
${r.workflowUrl ? `<p style="margin-top:12px;"><a href="${escapeHtml(r.workflowUrl)}" target="_blank" style="color:#0969da;">View GitHub Actions workflow run →</a></p>` : ""}
${r.workflow ? `<h2>Generated Workflow</h2><pre style="max-height:400px; overflow:auto;">${escapeHtml(r.workflow)}</pre>` : ""}
<button id="back-btn" style="margin-top:16px; padding:8px 16px; background:var(--border-color-default, #d1d9e0); color:var(--text-color-default, #1f2328); border:none; border-radius:6px; font-size:13px; cursor:pointer;">← Back to Deploy</button>
<script>
document.getElementById('back-btn').addEventListener('click', function() {
    fetch('/api/deploy-reset', { method: 'POST' }).then(function() { window.location.reload(); });
});
<\/script>`);
    }

    const envOptions = existingEnvs.map(e => `<option value="${e}"${e === envName ? ' selected' : ''}>${e}</option>`).join('');

    return pageShell("Radius Environment", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#C9452B"/><circle cx="64" cy="64" r="56" fill="#BF3E24" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Radius Environment</h1>
<p style="margin-bottom:16px; color: var(--text-color-muted, #656d76);">
  Configure your cloud provider, credentials, and deploy your Radius application.
</p>

<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Environment</label>
    <div style="display:flex; gap:8px;">
      <select id="env-select" style="flex:1; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
        ${envOptions}
        <option value="__new__">+ Create new...</option>
      </select>
    </div>
  </div>
  <div id="new-env-row" style="display:none; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">New Environment Name</label>
    <input id="new-env-name" type="text" placeholder="e.g. dev, staging, prod" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px;" />
  </div>
</div>

<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Target Repository</label>
    <select id="deploy-repo-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
      <option value="${escapeHtml(state?.targetRepo || state?.contextRepo || '')}" selected>${escapeHtml(state?.targetRepo || state?.contextRepo || 'Loading...')}</option>
    </select>
    <input type="hidden" id="target-repo" value="${escapeHtml(state?.targetRepo || state?.contextRepo || '')}" />
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Branch</label>
    <select id="deploy-branch-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
      <option value="" disabled selected>Loading...</option>
    </select>
  </div>
</div>

<div class="tabs">
  <div class="tab${provider === 'azure' ? ' active' : ''}" id="tab-azure">Azure</div>
  <div class="tab${provider === 'aws' ? ' active' : ''}" id="tab-aws">AWS</div>
</div>

<!-- Azure Panel -->
<div id="panel-azure" style="${provider === 'azure' ? '' : 'display:none;'}">
  <div style="margin-bottom:16px; padding:12px 16px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px;">
    <h3 style="margin:0 0 8px 0; font-size:13px; font-weight:600;">🔑 Cloud Accounts</h3>
    <p style="font-size:12px; color:var(--text-color-muted, #656d76); margin:0 0 10px 0;">
      Enter your Azure tenant and subscription, then verify your CLI login.
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
    <button id="btn-verify-azure" style="padding:6px 14px; background:#1f883d; color:#fff; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">✓ Verify Azure Login</button>
    <div id="verify-azure-status" style="margin-top:8px; font-size:12px; display:none;"></div>
  </div>

  <div style="margin-bottom:16px; padding:12px 16px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px;">
    <h3 style="margin:0 0 4px 0; font-size:13px; font-weight:600;">☸️ Azure Infrastructure</h3>
    <div id="azure-discover-status" style="font-size:11px; color:var(--text-color-muted, #656d76); margin-bottom:10px;">Discovering resources...</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Resource Group</label>
        <select id="azure-rg-select" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-default, #fff);">
          <option value="" disabled selected>Loading...</option>
        </select>
        <input id="azure-rg-custom" type="text" placeholder="Enter resource group" style="display:none; padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; margin-top:4px;" />
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">AKS Cluster</label>
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

  <div id="auto-setup-section" style="margin-bottom:12px; padding:8px 12px; background:var(--background-color-inset, #eff2f5); border-radius:8px; border:1px dashed var(--border-color-default, #d1d9e0); display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
    <p style="font-size:11px; margin:0; color:var(--text-color-muted, #656d76); flex:1; min-width:200px;">
      <strong>Auto-create credentials</strong> creates a new App Registration, a federated credential for GitHub OIDC, and a Contributor role assignment using your <code>az</code> CLI login. The generated Client ID appears below.
    </p>
    <button id="btn-auto-setup" style="padding:6px 14px; background:#0969da; color:#fff; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap;">⚡ Auto-create credentials</button>
    <div style="display:flex; flex-direction:column; gap:4px; flex-basis:100%;">
      <label style="font-size:12px; font-weight:600; color:var(--text-color-muted, #656d76);">Client ID <span style="font-weight:400;">(auto-created)</span></label>
      <input id="az-client-id" type="text" readonly placeholder="Auto-created when you click Auto-create credentials" value="${escapeHtml(oidcAzure?.clientId || '')}" style="padding:6px 10px; border:1px solid var(--border-color-default, #d1d9e0); border-radius:6px; font-size:13px; background:var(--background-color-inset, #eff2f5);" />
    </div>
    <div id="auto-setup-status" style="flex-basis:100%; font-size:12px; display:none;"></div>
  </div>
</div>

<!-- AWS Panel -->
<div id="panel-aws" style="${provider === 'aws' ? '' : 'display:none;'}">
  <div style="margin-bottom:16px; padding:12px 16px; background:var(--background-color-default, #f6f8fa); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px;">
    <h3 style="margin:0 0 4px 0; font-size:13px; font-weight:600;">☸️ AWS Infrastructure</h3>
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

<div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border-color-default, #d1d9e0);">
  <button id="deploy-btn" style="display:block; box-sizing:border-box; margin:0; padding:12px 32px; background:#1a7f37; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; width:100%;">🚀 Deploy Application</button>
</div>

<script>
var envSelect = document.getElementById('env-select');
var newEnvRow = document.getElementById('new-env-row');
envSelect.addEventListener('change', function() {
    newEnvRow.style.display = this.value === '__new__' ? 'flex' : 'none';
});

// Tab switching logic
var activeProvider = '${provider}';
document.getElementById('tab-azure').addEventListener('click', function() {
    activeProvider = 'azure';
    this.classList.add('active');
    document.getElementById('tab-aws').classList.remove('active');
    document.getElementById('panel-azure').style.display = '';
    document.getElementById('panel-aws').style.display = 'none';
});
document.getElementById('tab-aws').addEventListener('click', function() {
    activeProvider = 'aws';
    this.classList.add('active');
    document.getElementById('tab-azure').classList.remove('active');
    document.getElementById('panel-aws').style.display = '';
    document.getElementById('panel-azure').style.display = 'none';
});

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
radiusSetupRepoBranch('deploy-repo-select', 'deploy-branch-select', '${escapeHtml(state?.targetRepo || state?.contextRepo || '')}', 'main');

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
        btn.textContent = '✓ Verify Azure Login';
        if (data.error) {
            btn.style.background = '#cf222e';
            btn.textContent = '✗ Verify Azure Login';
            statusEl.innerHTML = '<span style="color:#cf222e;">❌ ' + data.error + '</span>';
        } else {
            btn.style.background = '#1f883d';
            btn.textContent = '✓ Verify Azure Login';
            statusEl.innerHTML = '<span style="color:#1a7f37;">✅ Logged in as <strong>' + (data.user || 'unknown') + '</strong> — ' + (data.subscriptionName || data.subscriptionId || '') + '</span>';
            // Auto-fill tenant/sub if returned
            if (data.tenantId && !tenantId) document.getElementById('az-tenant-id').value = data.tenantId;
            if (data.subscriptionId && !subId) document.getElementById('az-sub-id').value = data.subscriptionId;
            // Re-discover resources with verified credentials
            discoverResources('azure');
        }
    }).catch(function(err) {
        btn.disabled = false;
        btn.style.background = '#cf222e';
        btn.textContent = '✗ Verify Azure Login';
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

// Auto-setup button handler
document.getElementById('btn-auto-setup').addEventListener('click', function() {
    var btn = this;
    var statusEl = document.getElementById('auto-setup-status');
    var targetRepo = document.getElementById('target-repo').value.trim();
    var env = envSelect.value === '__new__' ? document.getElementById('new-env-name').value : envSelect.value;
    var resourceGroup = getComboValue('azure-rg-select', 'azure-rg-custom');
    var cluster = getComboValue('azure-cluster-select', 'azure-cluster-custom');

    if (!targetRepo) { statusEl.style.display = 'block'; statusEl.innerHTML = '<span style="color:#cf222e;">Please specify a target repository first.</span>'; return; }
    if (!resourceGroup) { statusEl.style.display = 'block'; statusEl.innerHTML = '<span style="color:#cf222e;">Please select a Resource Group first.</span>'; return; }
    if (!cluster) { statusEl.style.display = 'block'; statusEl.innerHTML = '<span style="color:#cf222e;">Please select an AKS Cluster first.</span>'; return; }
    if (!env) { statusEl.style.display = 'block'; statusEl.innerHTML = '<span style="color:#cf222e;">Please select an environment first.</span>'; return; }

    btn.disabled = true;
    btn.textContent = '⏳ Creating credentials...';
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span style="color:var(--text-color-muted, #656d76);">Running Azure CLI commands... this may take a moment.</span>';

    fetch('/api/azure-auto-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repo: targetRepo,
            environment: env,
            resourceGroup: resourceGroup,
            cluster: cluster,
            subscriptionId: document.getElementById('az-sub-id') ? document.getElementById('az-sub-id').value.trim() : '',
            tenantId: document.getElementById('az-tenant-id') ? document.getElementById('az-tenant-id').value.trim() : ''
        })
    }).then(function(r) { return r.json(); }).then(function(data) {
        btn.disabled = false;
        btn.textContent = '⚡ Auto-create credentials';
        if (data.error) {
            statusEl.innerHTML = '<span style="color:#cf222e;">❌ ' + data.error + '</span>' +
                (data.steps ? '<br><small style="color:var(--text-color-muted, #656d76);">' + data.steps.join('<br>') + '</small>' : '');
            return;
        }
        // Populate the credential fields
        if (data.clientId) document.getElementById('az-client-id').value = data.clientId;
        if (data.tenantId) document.getElementById('az-tenant-id').value = data.tenantId;
        if (data.subscriptionId) document.getElementById('az-sub-id').value = data.subscriptionId;
        // Clear the highlight if it was set
        document.getElementById('auto-setup-section').style.border = '1px dashed var(--border-color-default, #d1d9e0)';
        statusEl.innerHTML = '<span style="color:#1a7f37;">✅ Credentials created successfully!</span><br><small style="color:var(--text-color-muted, #656d76);">' + (data.steps || []).join('<br>') + '</small>';
    }).catch(function(err) {
        btn.disabled = false;
        btn.textContent = '⚡ Auto-create credentials';
        statusEl.innerHTML = '<span style="color:#cf222e;">❌ Error: ' + err.message + '</span>';
    });
});

document.getElementById('deploy-btn').addEventListener('click', function() {
    var btn = this;
    var statusEl = document.getElementById('deploy-status');
    var env = envSelect.value === '__new__' ? document.getElementById('new-env-name').value : envSelect.value;
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
    statusEl.style.display = 'block';
    statusEl.className = 'status';
    statusEl.textContent = 'Setting up GitHub environment and workflows...';

    // First create the GitHub environment with secrets, variables, and workflows
    var envData = { repo: targetRepo, environment: env, provider: provider, cluster: cluster };
    envData.branch = (document.getElementById('deploy-branch-select') || {}).value || 'main';
    // Application parameters are no longer collected from the UI. Send an empty
    // object so the server still auto-generates values for params without a
    // Bicep default (e.g. the app's @secure() password) and inlines the rest.
    envData.deployParams = {};
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

    fetch('/api/create-environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envData)
    }).then(function(r) { return r.json(); }).then(function(envResult) {
        if (envResult.error) {
            btn.textContent = '🚀 Deploy Application';
            btn.disabled = false;
            statusEl.className = 'status error';
            statusEl.textContent = 'Environment setup failed: ' + envResult.error;
            return;
        }
        statusEl.textContent = '✅ Environment created. Starting deployment...';
        btn.textContent = 'Deploying...';

        // Now trigger the deploy
        var branch = document.getElementById('deploy-branch-select').value || 'main';
        return fetch('/api/deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ environment: env, provider: provider, appFile: appFile, targetRepo: targetRepo, branch: branch, cluster: cluster, namespace: namespace, resourceGroup: resourceGroup, vpc: vpc, subnets: subnets })
        }).then(function() {
            window.location.href = '/?page=deploying';
        });
    }).catch(function(err) {
        btn.textContent = '🚀 Deploy Application';
        btn.disabled = false;
        statusEl.style.display = 'block';
        statusEl.className = 'status error';
        statusEl.textContent = 'Failed: ' + (err.message || 'unknown error');
    });
});
<\/script>`);
}

export function deployingPage(state) {
    const resources = state?.deployingResources || state?.plannedResources || [];
    const targetRepo = state?.deployingRepo || state?.deployParams?.targetRepo || state?.plannedRepo || state?.contextRepo || '';
    const targetBranch = state?.deployingBranch || state?.deployParams?.branch || state?.plannedBranch || 'main';
    const provider = state?.deployingProvider || state?.deployParams?.provider || state?.plannedProvider || 'azure';
    const logs = state?.deployLogs || [];
    const deployStatus = state?.deployStatus || 'pending';
    const deployError = state?.deployError || '';
    const resourcesJson = JSON.stringify(resources);
    const logsJson = JSON.stringify(logs);

    return pageShell("Deploying", `
<h1 style="display:flex; align-items:center; gap:10px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28"><circle cx="64" cy="64" r="64" fill="#C9452B"/><circle cx="64" cy="64" r="56" fill="#BF3E24" opacity="0.3"/><line x1="64" y1="64" x2="34" y2="28" stroke="white" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="white"/></svg>Deployment Progress</h1>
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
        emptyMsg.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-color-muted,#656d76);flex-direction:column;gap:8px;"><div class="spinner" style="width:20px;height:20px;border:3px solid #e1e4e8;border-top-color:#0969da;border-radius:50%;animation:spin 0.8s linear infinite;"></div><p style="font-size:14px;">' + msg + '</p></div>';
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
