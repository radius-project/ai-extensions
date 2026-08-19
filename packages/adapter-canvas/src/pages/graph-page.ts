import { escapeHtml, type CanvasState } from "../shared.js";
import { isWorkspaceSelection } from "../workspace.js";
import { browserScriptTag } from "../browser/scripts.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { inlineJson } from "./encoding.js";

export function graphPage(state: CanvasState = {}): string {
  const resources = state.graphResources || [];
  const targetRepo = state.graphTargetRepo || state.contextRepo || "";
  const graphBranch = state.graphBranch || state.contextBranch || "main";
  const localSource =
    typeof state.graphFromWorkspace === "boolean" ?
      state.graphFromWorkspace
    : isWorkspaceSelection(state, targetRepo, graphBranch);
  const loaded = resources.length > 0 || state.graphLoaded === true;

  const controls =
    loaded ?
      `<input type="hidden" id="graph-repo" value="${escapeHtml(targetRepo)}">
  <div class="rad-field">
    <label for="graph-app">Application</label>
    <select id="graph-app" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label for="graph-branch">Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="${escapeHtml(graphBranch)}" selected>${escapeHtml(graphBranch)}</option>
    </select>
  </div>`
    : `<div class="rad-field">
    <label for="graph-app">Application</label>
    <select id="graph-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label for="graph-branch">Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:220px;">
      <option value="">Loading branches...</option>
    </select>
  </div>`;

  const graphBody =
    loaded ?
      `<div id="graph-container"></div>
<div id="graph-refresh-status" class="status error" style="display:none;"></div>
<div style="margin-top:8px; font-size:12px; color:var(--rad-text-tertiary);">
  Click a node to view source code links.
</div>`
    : `<div id="graph-status" class="status info">Select a branch to generate the application graph. If no app.bicep exists, one will be generated from the repo structure.</div>
<div id="graph-container-wrapper"></div>`;

  return pageShell(
    "Application Graph",
    `
${graphHeader("graph")}
<p class="rad-lede" id="modeled-subtitle" style="margin:0 0 24px;">The modeled application graph shows the high-level architecture of your application as it is designed in code.<span id="modeled-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  ${controls}
  <button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;"${loaded ? "" : " disabled"}>Plan Deployment</button>
</div>
${graphBody}
<div hidden id="radius-graph-page-state">${escapeHtml(
      inlineJson({
        repo: targetRepo,
        branch: graphBranch,
        resources,
        loaded,
        localSource
      })
    )}</div>
${browserScriptTag("graph-page")}
${graphHeaderClose()}`
  );
}
