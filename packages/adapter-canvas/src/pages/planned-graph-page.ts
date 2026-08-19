// Canvas adapter — the planned application graph page: the infrastructure a
// deployment to the selected environment would provision.

import { escapeHtml, type CanvasState } from "../shared.js";
import { isWorkspaceSelection } from "../workspace.js";
import { browserScriptTag } from "../browser/scripts.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { inlineJson } from "./encoding.js";

export function plannedGraphPage(state: CanvasState = {}): string {
  const targetRepo =
    state?.plannedRepo || state?.graphTargetRepo || state?.contextRepo || "";
  const provider = state?.plannedProvider || state?.deployProvider || "azure";
  const plannedResources = state?.plannedResources || [];
  const graphBranch = state?.plannedBranch || state?.contextBranch || "main";
  // Default the Environment selector to the one last used for planning/deploying
  // this repo, so re-opening the tab (or refreshing after a plan) keeps the
  // same environment selected instead of falling back to the first option.
  const defaultEnvironment = state?.plannedEnvironment || state?.envName || "";
  // Same provenance rule as graphPage: open local files in the editor canvas
  // when the planned graph was resolved against the local workspace checkout.
  // Prefer the authoritative persisted flag; fall back to repo+branch matching.
  const localSource =
    typeof state?.plannedFromWorkspace === "boolean" ?
      state.plannedFromWorkspace
    : isWorkspaceSelection(state, targetRepo, graphBranch);

  if (plannedResources.length === 0) {
    return pageShell(
      "Planned Graph",
      `
${graphHeader("planned")}
<p class="rad-lede" id="planned-subtitle" style="margin:0 0 20px;">The planned application graph previews the infrastructure that will be provisioned for each component of your application if deployed to a given environment.<span id="planned-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Application</label>
    <select id="planned-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="planned-branch" class="rad-select" style="min-width:200px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Environment</label>
    <select id="planned-env" class="rad-select" style="min-width:180px;">
      <option value="">Loading environments...</option>
    </select>
  </div>
  <button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Plan Deployment</button>
</div>
<div id="plan-status" class="status info">Generating the planned application graph…</div>
<div id="graph-container-wrapper"></div>
<div hidden id="radius-planned-graph-state">${escapeHtml(
        inlineJson({
          repo: targetRepo,
          branch: graphBranch,
          environment: defaultEnvironment,
          provider,
          resources: [],
          localSource
        })
      )}</div>
${browserScriptTag("planned-graph-page")}
${graphHeaderClose()}`
    );
  }

  // Render the planned graph with real resources
  return pageShell(
    "Planned Graph",
    `
${graphHeader("planned")}
<p class="rad-lede" id="planned-subtitle" style="margin:0 0 20px;">The planned application graph previews the infrastructure that will be provisioned for each component of your application if deployed to a given environment.<span id="planned-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Application</label>
    <select id="planned-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="planned-branch" class="rad-select" style="min-width:200px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Environment</label>
    <select id="planned-env" class="rad-select" style="min-width:180px;">
      <option value="">Loading environments...</option>
    </select>
  </div>
  <button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Plan Deployment</button>
</div>
<div id="plan-status" class="status error" style="display:none;"></div>
<div id="graph-container"></div>

<div hidden id="radius-planned-graph-state">${escapeHtml(
      inlineJson({
        repo: targetRepo,
        branch: graphBranch,
        environment: defaultEnvironment,
        provider,
        resources: plannedResources,
        localSource
      })
    )}</div>
${browserScriptTag("planned-graph-page")}
${graphHeaderClose()}`
  );
}
