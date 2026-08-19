// Canvas adapter — the environment page. Serves both the Environments and
// Credentials sub-tabs, plus the terminal deployment-result view, composing the
// pane markup and inline browser scripts owned by ./environment/.

import { escapeHtml, type CanvasState } from "../shared.js";
import { radiusMark } from "../ui.js";
import { browserScriptTag } from "../browser/scripts.js";
import {
  DEPLOY_RESULT_STATE_ID,
  ENVIRONMENT_PAGE_STATE_ID
} from "./browser-state-ids.js";
import { pageShell } from "./shell.js";
import { inlineJson, safeExternalHref } from "./encoding.js";
import { environmentsPaneMarkup } from "./environment/environments-pane.js";
import { credentialsPaneMarkup } from "./environment/credentials-pane.js";
import { confirmDialogMarkup } from "./environment/confirm-dialog.js";

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
    // Only an http(s) workflow run is linkable. A `javascript:`/`data:` value —
    // or anything else that would smuggle script into the href — drops the link
    // instead of rendering an executable one.
    const workflowHref = safeExternalHref(r.workflowUrl);
    return pageShell(
      r.error ? "Deployment Failed" : "Deployment Initiated",
      `
<h1>${r.error ? "⚠ Deployment Failed" : "🚀 Deployment Initiated"}</h1>
<div class="status ${r.error ? "error" : "success"}">${escapeHtml(
        r.error || r.message
      )}</div>
${
  workflowHref ?
    `<p style="margin-top:12px;"><a href="${workflowHref}" target="_blank" style="color:var(--rad-brand, #da4c2a);">View GitHub Actions workflow run →</a></p>`
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
<div id="deploy-reset-status" class="status error" role="alert" style="display:none; margin-top:12px;"></div>
<div hidden id="${DEPLOY_RESULT_STATE_ID}">${escapeHtml(
        inlineJson({ attemptId: state?.deployAttempt?.id || "" })
      )}</div>
${browserScriptTag("deploy-result-page")}`
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

${environmentsPaneMarkup({
  activeSubtab,
  envName,
  ctxRepo,
  deployDefaultBranch
})}
${credentialsPaneMarkup(activeSubtab)}

${confirmDialogMarkup()}

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
/* Motion belongs to work in progress only: the spinner animates while the
   operation is still running and settles the moment it reaches any terminal
   state, including a completed rollback. */
.env-progress__spinner { flex:0 0 auto; width:22px; height:22px; margin-top:1px; border-radius:50%; background:var(--rad-stroke); }
.env-progress--active .env-progress__spinner { background:conic-gradient(var(--rad-info) 0turn 0.75turn, var(--rad-stroke) 0.75turn 1turn); animation:spin 1s linear infinite; }
.env-progress--done .env-progress__spinner { animation:none; background:var(--rad-success-solid, var(--rad-info)); }
.env-progress--failed .env-progress__spinner { animation:none; background:var(--rad-danger); }
/* State is never carried by motion or color alone. */
@media (prefers-reduced-motion: reduce) { .env-progress--active .env-progress__spinner { animation:none; } }
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
.env-progress__state { margin-top:10px; padding:10px 12px; border-radius:8px; background:var(--rad-bg-subtle); border:1px solid var(--rad-stroke); display:flex; flex-direction:column; gap:8px; }
.env-progress__details { margin-top:12px; }
.env-progress__details > summary { font-size:12px; color:var(--rad-text-tertiary); cursor:pointer; }
.env-progress__steps { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; max-height:220px; overflow:auto; }
.env-progress__step { display:flex; gap:8px; font-size:12px; color:var(--rad-text-tertiary); line-height:1.45; }
.env-progress__step--warning { color:var(--rad-text); }
.env-progress__step--failed { color:var(--rad-danger); }
.env-progress__actions { display:flex; gap:8px; margin-top:12px; }
.env-progress__bottom-buttons { display:flex; gap:8px; flex-wrap:wrap; }
.env-progress__commands { display:flex; flex-direction:column; gap:6px; margin-top:12px; }
.env-progress__command-buttons { display:flex; gap:8px; flex-wrap:wrap; }
.env-progress__command-note { font-size:12px; color:var(--rad-text-tertiary); line-height:1.5; }
.env-progress__command-guidance { margin:0; padding-left:18px; font-size:12px; color:var(--rad-text-tertiary); line-height:1.5; }
.env-progress__command-status { font-size:12px; color:var(--rad-text); line-height:1.5; }
.env-progress__command-error { font-size:12px; color:var(--rad-danger); line-height:1.5; }
/* The stopped and rollback states get their own heading line: a stop is neither
   a success nor a failure, and a rollback that left something behind is not a
   failed setup. */
.env-progress__headline-note { font-size:12px; color:var(--rad-text-tertiary); margin-top:4px; line-height:1.5; }
.env-progress--active.env-progress--cleaning .env-progress__spinner { background:conic-gradient(var(--rad-danger) 0turn 0.75turn, var(--rad-stroke) 0.75turn 1turn); }
/* Rollback confirmation dialog. Destructive cloud deletions are confirmed
   against the server's own preview before anything is sent. */
.env-rollback__panel { background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 30px var(--rad-shadow); padding:22px 26px; max-width:520px; width:92%; max-height:80vh; overflow:auto; display:flex; flex-direction:column; gap:10px; }
.env-rollback__title { font-size:15px; font-weight:600; line-height:1.4; color:var(--rad-text); }
.env-rollback__intro { font-size:12px; color:var(--rad-text-tertiary); line-height:1.5; }
.env-rollback__buttons { display:flex; justify-content:flex-end; gap:8px; margin-top:6px; }
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
/* An option list that has not loaded yet must not draw an empty menu row. */
.rad-combo__options:empty { display: none; }
/* Two-step New Environment wizard: credentials, then the environment itself. */
.rad-wizard-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 14px;
}
.rad-wizard { display: flex; align-items: center; gap: 10px; list-style: none; margin: 0; padding: 0; }
.rad-wizard__step {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 500; color: var(--rad-text-tertiary);
}
.rad-wizard__num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--rad-stroke); font-size: 12px; font-weight: 600;
}
.rad-wizard__step--active { color: var(--rad-text); }
.rad-wizard__step--active .rad-wizard__num {
  background: var(--rad-primary); border-color: var(--rad-primary); color: #fff;
}
.rad-wizard__step--done .rad-wizard__num { border-color: var(--rad-primary); color: var(--rad-primary); }
.rad-wizard__sep { width: 28px; height: 1px; background: var(--rad-stroke); }
/* Read-only echo of a choice made in an earlier step. */
.rad-chosen {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 12px; background: var(--rad-bg-subtle);
  border: 1px solid var(--rad-stroke); border-radius: 8px;
}
.rad-chosen__value {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 14px; color: var(--rad-text);
}
</style>

<div hidden id="${ENVIRONMENT_PAGE_STATE_ID}">${escapeHtml(
      inlineJson({
        repo: ctxRepo,
        branch: ctxBranch,
        activeSubtab,
        mutationNonce:
          typeof state.browserMutationNonce === "string" ?
            state.browserMutationNonce
          : ""
      })
    )}</div>
${browserScriptTag("environment-page")}`
  );
}
