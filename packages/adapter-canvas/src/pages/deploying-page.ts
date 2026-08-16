// Canvas adapter — the deployments page: application, environment, and branch
// selection, the deployment listing, and the delete confirmation dialog.

import { escapeHtml, type CanvasState } from "../shared.js";
import { radiusMark } from "../ui.js";
import { pageShell } from "./shell.js";
import { DELETE_DEPLOYMENT_DIALOG_HTML } from "./fragments.js";
import { DEPLOYING_CLIENT_JS } from "./deploying/client-deployments.js";
import { inlineJson } from "./encoding.js";

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
var CTX_REPO = ${inlineJson(ctxRepo)};
var CTX_BRANCH = ${inlineJson(ctxBranch)};

${DEPLOYING_CLIENT_JS}
<\/script>`,
    "deployments"
  );
}
