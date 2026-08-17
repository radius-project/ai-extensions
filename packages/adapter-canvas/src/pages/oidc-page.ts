// Canvas adapter — the standalone cloud-accounts (OIDC federation) page. Kept
// beside the environment and credential pages it belongs to.

import {
  cloudCredential,
  escapeHtml,
  sharedCredentials,
  type CanvasState
} from "../shared.js";
import { pageShell } from "./shell.js";

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
function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}
function renderAzureOidcResult(resultDiv, res, data) {
    if (res.validated) {
        resultDiv.innerHTML = '<div class="status success">' + escapeHtmlClient(res.message) + '</div>' +
            '<div class="field"><span class="field-label">Tenant</span><div class="field-value">' + escapeHtmlClient(res.tenantId || data.tenantId) + '</div></div>' +
            '<div class="field"><span class="field-label">Subscription</span><div class="field-value">' + (res.subscriptionName ? escapeHtmlClient(res.subscriptionName) + ' — ' : '') + escapeHtmlClient(res.subscriptionId || data.subscriptionId) + '</div></div>' +
            (data.clientId ? '<div class="field"><span class="field-label">App Registration</span><div class="field-value">' + escapeHtmlClient(data.clientId) + '</div></div>' : '') +
            (res.userName ? '<div class="field"><span class="field-label">Signed in as</span><div class="field-value">' + escapeHtmlClient(res.userName) + '</div></div>' : '');
    } else {
        resultDiv.innerHTML = '<div class="status error">' + escapeHtmlClient(res.message || 'Authentication failed') + '</div>';
    }
}
function renderAwsOidcResult(resultDiv, res, data) {
    resultDiv.innerHTML = '<div class="status success">' + escapeHtmlClient(res.message) + '</div>' +
        '<div class="field"><span class="field-label">Account</span><div class="field-value">' + escapeHtmlClient(data.accountId) + '</div></div>' +
        '<div class="field"><span class="field-label">Region</span><div class="field-value">' + escapeHtmlClient(data.region) + '</div></div>';
}
function renderOidcError(resultDiv, error) {
    resultDiv.innerHTML = '<div class="status error">Error: ' + escapeHtmlClient(error.message) + '</div>';
}
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
            renderAzureOidcResult(resultDiv, res, data);
        })
        .catch(function(e) { btn.disabled = false; btn.textContent = 'Confirm authentication'; renderOidcError(resultDiv, e); });
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
            renderAwsOidcResult(resultDiv, res, data);
        })
        .catch(function(e) { renderOidcError(resultDiv, e); });
});
<\/script>`,
    "environments"
  );
}
