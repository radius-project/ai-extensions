import { escapeHtml, type CanvasState } from "../shared.js";
import { browserScriptTag } from "../browser/scripts.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { DELETE_DEPLOYMENT_DIALOG_HTML } from "./fragments.js";
import { inlineJson } from "./encoding.js";

export function deployedGraphPage(state: CanvasState = {}): string {
  const targetRepo =
    state.contextRepo ||
    state.deployingRepo ||
    state.plannedRepo ||
    state.graphTargetRepo ||
    "";
  const deployBranch =
    state.contextBranch || state.plannedBranch || state.graphBranch || "main";
  const targetBranch =
    state.contextBranch ||
    state.deployingBranch ||
    state.plannedBranch ||
    state.graphBranch ||
    "main";
  const provider = state.plannedProvider || state.deployProvider || "azure";

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
  <div id="deployed-graph-label" style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:12px; line-height:1.5; white-space:pre-line;"></div>
  <div id="deployed-mode-note" style="display:none; font-size:12px; color:var(--rad-text-secondary); margin-bottom:12px;"></div>
  <div id="deployed-status" class="status info">Loading deployed application graph…</div>
  <div id="deployed-progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>
  <div id="graph-container"></div>
</div>
<div id="deployed-log-section" class="rad-card" style="margin:16px 0 0; display:none;">
  <div style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:10px;">Deployment Logs</div>
  <div id="deployed-log-output" style="background:var(--rad-code-bg); color:var(--rad-code-text); border:1px solid var(--rad-stroke); font-family:var(--rad-mono); font-size:12px; padding:12px; border-radius:6px; max-height:280px; overflow-y:auto; white-space:pre-wrap; line-height:1.6;"></div>
</div>
${DELETE_DEPLOYMENT_DIALOG_HTML}
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
  .rad-deployed-controls .rad-btn { align-self:flex-end; flex:0 0 auto; }
</style>
<div hidden id="radius-deployed-graph-state">${escapeHtml(
      inlineJson({
        repo: targetRepo,
        branch: deployBranch,
        graphBranch: targetBranch,
        provider
      })
    )}</div>
${browserScriptTag("deployed-graph-page")}
${graphHeaderClose()}`
  );
}
