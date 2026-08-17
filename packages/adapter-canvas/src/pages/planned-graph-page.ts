// Canvas adapter — the planned application graph page: the infrastructure a
// deployment to the selected environment would provision.

import { type CanvasState } from "../shared.js";
import { isWorkspaceSelection } from "../workspace.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { inlineJson, inlineJsString } from "./encoding.js";

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

  const resourcesJson = inlineJson(plannedResources);

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
  <button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Loading…</button>
</div>
<div id="plan-status" class="status info">Generating the planned application graph…</div>
<div id="graph-container-wrapper"></div>
<script>
var CONTEXT_REPO = '${inlineJsString(targetRepo)}';
var CONTEXT_BRANCH = '${inlineJsString(graphBranch)}';
var CONTEXT_ENV = '${inlineJsString(defaultEnvironment)}';
var ENV_PROVIDERS = {};

function runPlan(isCurrent) {
    var repo = CONTEXT_REPO;
    // Sub-tab navigation swaps this page's content out client-side, so a
    // scheduled plan can fire after these elements are gone.
    var branchEl = document.getElementById('planned-branch');
    var envEl = document.getElementById('planned-env');
    if (!branchEl || !envEl) return Promise.resolve();
    var branch = branchEl.value.trim();
    var env = envEl.value;
    var provider = ENV_PROVIDERS[env] || '${inlineJsString(provider)}';
    var statusEl0 = document.getElementById('plan-status');
    if (RADIUS_PLAN_ENVS_STALE) {
        if (statusEl0) { statusEl0.style.display=''; statusEl0.textContent='Environments could not be loaded. Try again before planning a deployment.'; statusEl0.className='status error'; }
        return Promise.resolve();
    }
    if (!repo || !branch) {
        if (statusEl0) { statusEl0.style.display=''; statusEl0.textContent='Select a branch to preview the planned deployment.'; statusEl0.className='status info'; }
        return Promise.resolve();
    }
    if (!RADIUS_PLAN_HAS_ENV || !env) {
        if (statusEl0) { statusEl0.style.display=''; statusEl0.textContent='Create an environment to preview the planned deployment for this application.'; statusEl0.className='status info'; }
        var wrapper0 = document.getElementById('graph-container-wrapper');
        if (wrapper0) wrapper0.innerHTML = '';
        return Promise.resolve();
    }
    if (statusEl0) statusEl0.style.display = 'none';
    RADIUS_PLAN_REQUEST_FAILED = false;
    var wrapper = document.getElementById('graph-container-wrapper');
    if (!wrapper) return Promise.resolve();
    wrapper.innerHTML = '<div id="graph-container"></div>';
    var container = document.getElementById('graph-container');
    if (!container) return Promise.resolve();
    container.innerHTML = '<div id="progress-panel" style="padding:20px; max-width:500px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--rad-text);">Planning Deployment</span>' +
        '</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--rad-stroke);border-top-color:var(--rad-success);border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-success);margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--rad-text);font-weight:500}</style>';
    var stepsEl = document.getElementById('progress-steps');
    var shownSteps = 0;
    var pollInterval = setInterval(function() {
        fetch('/api/progress').then(function(r) { return r.json(); }).then(function(d) {
            if (!isCurrent()) return;
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
    return fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch, provider: provider, environment: env}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            clearInterval(pollInterval);
            if (!isCurrent()) return;
            if (d.reload) {
                var prev = stepsEl.querySelector('.step-active');
                if (prev) prev.className = 'step-done';
                var doneDiv = document.createElement('div');
                doneDiv.className = 'step-done';
                doneDiv.textContent = 'Deployment plan ready!';
                stepsEl.appendChild(doneDiv);
                setTimeout(function() { window.location.reload(); }, 600);
            } else if (d.error) {
                RADIUS_PLAN_REQUEST_FAILED = true;
                clearInterval(pollInterval);
                container.innerHTML = '';
                if (statusEl0) { statusEl0.style.display = ''; statusEl0.textContent = 'Error: ' + d.error; statusEl0.className = 'status error'; }
            } else {
                RADIUS_PLAN_REQUEST_FAILED = true;
                if (statusEl0) { statusEl0.style.display = ''; statusEl0.textContent = 'The planned deployment response was incomplete. Try again.'; statusEl0.className = 'status error'; }
            }
        })
        .catch(function() {
            clearInterval(pollInterval);
            if (isCurrent() && statusEl0) {
                RADIUS_PLAN_REQUEST_FAILED = true;
                statusEl0.style.display = '';
                statusEl0.textContent = 'The planned deployment could not be generated. Try again.';
                statusEl0.className = 'status error';
            }
        });
}

var schedulePlan = radiusCreatePlanScheduler(runPlan, function() {
    radiusApplyPlanEnvState(RADIUS_PLAN_HAS_ENV, RADIUS_PLAN_ENVS_STALE);
});
function requestPlan(immediate) {
    RADIUS_PLAN_REQUEST_FAILED = false;
    var btn = document.getElementById('plan-btn');
    if (btn && btn.dataset.mode === 'deploy') btn.disabled = true;
    schedulePlan(immediate);
}

// Auto-generate the planned graph as soon as sensible defaults settle, then
// re-generate it whenever the Application, Branch, or Environment selection
// changes so the graph always reflects what's currently selected.
radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH, CONTEXT_ENV).then(function() {
    requestPlan(true);
});
['planned-app', 'planned-branch', 'planned-env'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
        radiusApplyPlanEnvState(RADIUS_PLAN_HAS_ENV, RADIUS_PLAN_ENVS_STALE);
        requestPlan(false);
    });
});

document.getElementById('plan-btn').addEventListener('click', function() {
    if (this.dataset.mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
    radiusDeployPlannedApp(this, CONTEXT_REPO, ENV_PROVIDERS, '${inlineJsString(provider)}');
});
<\/script>
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
  <button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Loading…</button>
</div>
<div id="plan-status" class="status error" style="display:none;"></div>
<div id="graph-container"></div>

<script>
var CONTEXT_REPO = '${inlineJsString(targetRepo)}';
var CONTEXT_BRANCH = '${inlineJsString(graphBranch)}';
var CONTEXT_ENV = '${inlineJsString(defaultEnvironment)}';
var ENV_PROVIDERS = {};
var radiusPlannedSelectorsReady = radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH, CONTEXT_ENV);

// Re-generate the planned graph whenever the Application, Branch, or
// Environment selection changes, so the graph always reflects what's
// currently selected without requiring a separate "Re-Plan" click.
function runPlan(isCurrent) {
    var repo = CONTEXT_REPO;
    // Sub-tab navigation swaps this page's content out client-side, so a
    // scheduled plan can fire after these elements are gone.
    var branchEl = document.getElementById('planned-branch');
    var envEl = document.getElementById('planned-env');
    if (!branchEl || !envEl) return Promise.resolve();
    var branch = branchEl.value.trim() || CONTEXT_BRANCH;
    var env = envEl.value;
    var provider = ENV_PROVIDERS[env] || '${inlineJsString(provider)}';
    if (!repo) return Promise.resolve();
    var container = document.getElementById('graph-container');
    if (!container) return Promise.resolve();
    if (RADIUS_PLAN_ENVS_STALE) {
        var staleStatus = document.getElementById('plan-status');
        if (staleStatus) {
            staleStatus.style.display = '';
            staleStatus.textContent = 'Environments could not be loaded. The last planned graph is retained.';
        }
        return Promise.resolve();
    }
    if (!RADIUS_PLAN_HAS_ENV || !env) {
        container.innerHTML = '<div class="status info">Create an environment to preview the planned deployment for this application.</div>';
        return Promise.resolve();
    }
    RADIUS_PLAN_REQUEST_FAILED = false;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--rad-text-tertiary);gap:10px;"><div class="spinner" style="width:20px;height:20px;border:3px solid var(--rad-stroke);border-top-color:var(--rad-primary);border-radius:50%;animation:spin 0.8s linear infinite;"></div><span>Planning deployment...</span></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    return fetch('/api/plan-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch, provider: provider, environment: env}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (!isCurrent()) return;
            if (d.reload) { window.location.reload(); }
            else if (d.needsAppBicep) { RADIUS_PLAN_REQUEST_FAILED = true; container.innerHTML = '<div class="status info">Copilot is generating .radius/app.bicep with the Radius app-bicep skill\u2026 the planned graph will appear once it is saved.</div>'; }
            else if (d.error) { RADIUS_PLAN_REQUEST_FAILED = true; container.innerHTML = '<div class="status error"></div>'; container.firstChild.textContent = 'Error: ' + d.error; }
            else { RADIUS_PLAN_REQUEST_FAILED = true; container.innerHTML = '<div class="status error">The planned deployment response was incomplete. Try again.</div>'; }
        })
        .catch(function() {
            if (!isCurrent()) return;
            RADIUS_PLAN_REQUEST_FAILED = true;
            container.innerHTML = '<div class="status error">The planned deployment could not be generated. Try again.</div>';
        });
}
var schedulePlan = radiusCreatePlanScheduler(runPlan, function() {
    radiusApplyPlanEnvState(RADIUS_PLAN_HAS_ENV, RADIUS_PLAN_ENVS_STALE);
});
function requestPlan() {
    RADIUS_PLAN_REQUEST_FAILED = false;
    var btn = document.getElementById('plan-btn');
    if (btn && btn.dataset.mode === 'deploy') btn.disabled = true;
    schedulePlan(false);
}
['planned-app', 'planned-branch', 'planned-env'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
        radiusApplyPlanEnvState(RADIUS_PLAN_HAS_ENV, RADIUS_PLAN_ENVS_STALE);
        requestPlan();
    });
});

document.getElementById('plan-btn').addEventListener('click', function() {
    if (this.dataset.mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
    radiusDeployPlannedApp(this, CONTEXT_REPO, ENV_PROVIDERS, '${inlineJsString(provider)}');
});

var resources = ${resourcesJson};
radiusRenderGraph('graph-container', resources, {
    repoUrl: 'https://github.com/' + CONTEXT_REPO,
    branch: CONTEXT_BRANCH,
    localSource: ${localSource ? "true" : "false"},
    plannedMode: true
});
// The graph above reflects the last-persisted plan. If it turns out the repo
// no longer has (or never had) a Radius-managed environment, replace it with
// the "create an environment first" message rather than leaving a stale or
// misleading plan on screen.
radiusPlannedSelectorsReady.then(function() {
    if (!RADIUS_PLAN_HAS_ENV && !RADIUS_PLAN_ENVS_STALE) {
        var container0 = document.getElementById('graph-container');
        if (container0) container0.innerHTML = '<div class="status info">Create an environment to preview the planned deployment for this application.</div>';
    }
});
<\/script>
${graphHeaderClose()}`
  );
}
