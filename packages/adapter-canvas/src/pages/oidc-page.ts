// Canvas adapter — the standalone cloud-accounts (OIDC federation) page. Kept
// beside the environment and credential pages it belongs to.

import {
  cloudCredential,
  escapeHtml,
  sharedCredentials,
  type CanvasState
} from "../shared.js";
import { browserScriptTag } from "../browser/scripts.js";
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
${browserScriptTag("oidc-page")}`,
    "environments"
  );
}
