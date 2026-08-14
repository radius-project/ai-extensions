// Canvas adapter — the application graph diff page: the model compared between
// an explicit committed base branch and head branch.

import { escapeHtml, type CanvasState } from "../shared.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { GRAPH_DIFF_SUBTITLE } from "./fragments.js";
import { inlineJson, inlineJsString } from "./encoding.js";

export function graphDiffPage(state: CanvasState = {}): string {
  const resources = state?.diffResources || [];
  const baseBranch = state?.diffBase || "main";
  const headBranch = state?.diffHead || "";
  const branches = state?.branches || [];
  const branchShas = state?.branchShas || {};

  const branchOptionsBase = branches
    .map((b) => {
      const sha =
        branchShas[b] ? ` (${escapeHtml(branchShas[b].slice(0, 7))})` : "";
      return `<option value="${escapeHtml(b)}"${
        b === baseBranch ? " selected" : ""
      }>${escapeHtml(b)}${sha}</option>`;
    })
    .join("");
  const branchOptionsHead = branches
    .map((b) => {
      const sha =
        branchShas[b] ? ` (${escapeHtml(branchShas[b].slice(0, 7))})` : "";
      return `<option value="${escapeHtml(b)}"${
        b === headBranch ? " selected" : ""
      }>${escapeHtml(b)}${sha}</option>`;
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
var STATE_BASE = '${inlineJsString(baseBranch)}';
var STATE_HEAD = '${inlineJsString(headBranch)}';
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
function queueDiff() {
    if (window.__radiusDiffTimeout) clearTimeout(window.__radiusDiffTimeout);
    window.__radiusDiffTimeout = setTimeout(runDiff, 500);
}

function runDiff() {
    window.__radiusDiffTimeout = null;
    // Sub-tab navigation swaps this page's content out client-side, so a
    // pending debounced diff can fire after these elements are gone.
    var baseEl = document.getElementById('base-branch');
    var headEl = document.getElementById('head-branch');
    var repoEl = document.getElementById('diff-repo-select');
    var statusEl = document.getElementById('diff-status');
    if (!baseEl || !headEl || !repoEl || !statusEl) return;
    var base = baseEl.value;
    var head = headEl.value;
    var repo = repoEl.value;
    if (!repo || !base || !head) return;
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
  const resourcesJson = inlineJson(resources);
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
    branch: '${inlineJsString(headBranch)}',
    baseBranch: '${inlineJsString(baseBranch)}'
});

var DIFF_BASE = '${inlineJsString(baseBranch)}';
var DIFF_HEAD = '${inlineJsString(headBranch)}';

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
function queueDiff() {
    if (window.__radiusDiffTimeout) clearTimeout(window.__radiusDiffTimeout);
    window.__radiusDiffTimeout = setTimeout(runDiff, 500);
}

function runDiff() {
    window.__radiusDiffTimeout = null;
    // Sub-tab navigation swaps this page's content out client-side, so a
    // pending debounced diff can fire after these elements are gone.
    var baseEl = document.getElementById('base-branch');
    var headEl = document.getElementById('head-branch');
    var repoEl = document.getElementById('diff-repo-select');
    var statusEl = document.getElementById('diff-status');
    if (!baseEl || !headEl || !repoEl || !statusEl) return;
    var base = baseEl.value;
    var head = headEl.value;
    var repo = repoEl.value;
    if (!repo || !base || !head) return;
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
