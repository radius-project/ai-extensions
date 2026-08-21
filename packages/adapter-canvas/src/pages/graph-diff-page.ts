// Canvas adapter — the application graph diff page: the model compared between
// an explicit committed base branch and head branch.

import { escapeHtml, type CanvasState } from "../shared.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { GRAPH_DIFF_SUBTITLE } from "./fragments.js";
import { inlineJson } from "./encoding.js";
import { browserScriptTag } from "../browser/scripts.js";

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
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);" for="diff-app">Application</label>
    <select id="diff-app" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:200px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);" for="base-branch">Base</label>
    <select id="base-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <span aria-label="from base branch to head branch" style="font-size:18px; color:var(--rad-text-tertiary);">→</span>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);" for="head-branch">Head</label>
    <select id="head-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
</div>
<div id="diff-status" class="status ${state?.diffError ? "error" : "info"}">${
        state?.diffError ? escapeHtml(state.diffError) : "Loading branches…"
      }</div>
<div id="diff-progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>
<div hidden id="radius-graph-diff-state">${escapeHtml(
        inlineJson({
          repo: targetRepo,
          base: baseBranch,
          head: headBranch,
          resources: []
        })
      )}</div>
${browserScriptTag("graph-diff-page")}
${graphHeaderClose()}`
    );
  }
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
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);" for="diff-app">Application</label>
    <select id="diff-app" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:200px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);" for="base-branch">Base</label>
    <select id="base-branch" style="padding:6px 10px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:13px; background:var(--rad-surface); color:var(--rad-text); min-width:180px; width:auto; max-width:400px;">
      ${branchOptionsBase}
    </select>
  </div>
  <span aria-label="from base branch to head branch" style="font-size:18px; color:var(--rad-text-tertiary);">→</span>
  <div style="display:flex; flex-direction:column; gap:4px;">
    <label style="font-size:12px; font-weight:600; color:var(--rad-text-tertiary);" for="head-branch">Head</label>
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
<div id="diff-progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>
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

<div hidden id="radius-graph-diff-state">${escapeHtml(
      inlineJson({
        repo: targetRepo,
        base: baseBranch,
        head: headBranch,
        resources
      })
    )}</div>
${browserScriptTag("graph-diff-page")}
${graphHeaderClose()}`
  );
}
