// Canvas adapter — the modeled application graph page: the architecture as it
// is designed in code, rendered from the repository's app.bicep.

import { escapeHtml, type CanvasState } from "../shared.js";
import { isWorkspaceSelection } from "../workspace.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { inlineJson, inlineJsString } from "./encoding.js";

export function graphPage(state: CanvasState = {}): string {
  const resources = state?.graphResources || [];
  const resourcesJson = inlineJson(resources);
  const targetRepo = state?.graphTargetRepo || state?.contextRepo || "";
  const graphBranch = state?.graphBranch || state?.contextBranch || "main";
  // Local-workspace graphs are built from the on-disk worktree checkout, so the
  // "View source code" link should open the local file in the editor canvas
  // rather than a GitHub blob URL (which 404s for an unpushed worktree branch).
  // Prefer the authoritative provenance flag persisted by the graph handler
  // (true only when the local workspace actually supplied the app.bicep); fall
  // back to repo+branch matching only for render paths that don't set it (MCP).
  const localSource =
    typeof state?.graphFromWorkspace === "boolean" ?
      state.graphFromWorkspace
    : isWorkspaceSelection(state, targetRepo, graphBranch);

  if (resources.length === 0 && !state?.graphLoaded) {
    return pageShell(
      "Application Graph",
      `
${graphHeader("graph")}
<p class="rad-lede" id="modeled-subtitle" style="margin:0 0 24px;">The modeled application graph shows the high-level architecture of your application as it is designed in code.<span id="modeled-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <div class="rad-field">
    <label>Application</label>
    <select id="graph-app" class="rad-select" style="min-width:280px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:220px;">
      <option value="">Loading branches...</option>
    </select>
  </div>
  <button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Plan Deployment</button>
</div>
<div id="graph-status" class="status info">Select a branch to generate the application graph. If no app.bicep exists, one will be generated from the repo structure.</div>
<div id="graph-container-wrapper"></div>
<script>
var CONTEXT_REPO = '${inlineJsString(targetRepo)}';
var CONTEXT_BRANCH = '${inlineJsString(graphBranch)}';

// Populate the Application dropdown for the current repository.
(function() {
    var appSel = document.getElementById('graph-app');
    if (!CONTEXT_REPO) { appSel.innerHTML = '<option value="">No application context</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CONTEXT_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = d.applications || [];
            appSel.innerHTML = '';
            if (apps.length === 0) {
                var fallback = CONTEXT_REPO.split('/').pop() || CONTEXT_REPO;
                var o = document.createElement('option');
                o.value = fallback; o.textContent = fallback; appSel.appendChild(o);
                return;
            }
            apps.forEach(function(a) {
                var o = document.createElement('option');
                o.value = a.name; o.textContent = a.name; appSel.appendChild(o);
            });
        })
        .catch(function() { appSel.innerHTML = '<option value="">Unable to load applications</option>'; });
})();

// Populate the Branch dropdown, defaulting to the current worktree branch.
(function() {
    var branchSel = document.getElementById('graph-branch');
    if (!CONTEXT_REPO) { branchSel.innerHTML = '<option value="">No repository context</option>'; return; }
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: CONTEXT_REPO}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var branches = (d && d.branches) || [];
            var workspaceBranch = (d && d.workspaceBranch) || CONTEXT_BRANCH || '';
            branchSel.innerHTML = '<option value="">— Select a branch —</option>';
            branches.forEach(function(b) {
                var o = document.createElement('option');
                o.value = b.name;
                o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : ' (' + b.sha.slice(0,7) + ')');
                if (workspaceBranch && b.name === workspaceBranch) o.selected = true;
                branchSel.appendChild(o);
            });
            // Default to the current worktree branch and auto-generate its graph.
            if (workspaceBranch && branchSel.value === workspaceBranch) {
                branchSel.dispatchEvent(new Event('change'));
            }
        })
        .catch(function() { branchSel.innerHTML = '<option value="">Unable to load branches</option>'; });
})();

// Auto-generate the graph as soon as a branch is chosen, and enable the
// primary button (greyed out until a branch is selected, unless it is the
// branch-independent "Create Environment" action).
document.getElementById('graph-branch').addEventListener('change', function() {
    var deployBtn = document.getElementById('deploy-app-btn');
    if (this.value) {
        if (deployBtn) deployBtn.disabled = false;
        generateGraph();
    } else if (deployBtn && deployBtn.dataset.mode !== 'create-env') {
        deployBtn.disabled = true;
    }
});

// Primary action → Create Environment or Plan Deployment, depending on setup.
document.getElementById('deploy-app-btn').addEventListener('click', function(e) {
    radiusModeledPrimaryAction(this);
});

radiusLoadModeledEnvState(CONTEXT_REPO);

function generateGraph() {
    var repo = CONTEXT_REPO;
    var branch = document.getElementById('graph-branch').value.trim();
    if (!repo) return;
    var statusEl0 = document.getElementById('graph-status');
    if (!branch) {
        if (statusEl0) { statusEl0.textContent = 'Select a branch to generate the application graph.'; statusEl0.className = 'status info'; statusEl0.style.display = ''; }
        return;
    }
    var wrapper = document.getElementById('graph-container-wrapper');
    wrapper.innerHTML = '<div id="graph-container"></div>';
    var container = document.getElementById('graph-container');
    var statusEl = document.getElementById('graph-status');
    if (statusEl) { statusEl.style.display = 'none'; }
    if (window.radiusGraphProgressPoller) clearInterval(window.radiusGraphProgressPoller);
    if (window.radiusGraphProgressTicker) clearInterval(window.radiusGraphProgressTicker);
    if (window.radiusGraphRetryTimer) clearTimeout(window.radiusGraphRetryTimer);
    container.innerHTML = '<div id="progress-panel" style="padding:20px; max-width:560px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--rad-text);">Generating Application Graph</span>' +
        '</div>' +
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">' +
        '<strong id="progress-stage" style="font-size:13px; color:var(--rad-text);">Checking for an existing app model</strong>' +
        '<span id="progress-percent" style="font-size:12px; color:var(--rad-text-tertiary);">5%</span>' +
        '</div>' +
        '<div style="height:8px; border-radius:999px; background:var(--rad-bg-subtle); overflow:hidden; margin-bottom:10px;">' +
        '<div id="progress-bar-fill" style="height:100%; width:5%; border-radius:999px; background:var(--rad-brand); transition:width 0.4s ease, background 0.2s ease;"></div>' +
        '</div>' +
        '<div id="progress-status-text" style="font-size:13px; color:var(--rad-text); margin-bottom:4px;">Checking the selected branch for .radius/app.bicep…</div>' +
        '<div id="progress-eta" style="font-size:12px; color:var(--rad-text-tertiary); margin-bottom:14px;">Usually completes in about 5 minutes.</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--rad-text-tertiary); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--rad-stroke);border-top-color:var(--rad-brand);border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-success);margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-pending::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-bg-subtle);margin-right:8px;vertical-align:1px}.step-active{color:var(--rad-text);font-weight:500}.step-error::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rad-danger);margin-right:8px;vertical-align:1px}.step-error{color:var(--rad-danger);font-weight:600}</style>';

    var stepsEl = document.getElementById('progress-steps');
    var stageEl = document.getElementById('progress-stage');
    var percentEl = document.getElementById('progress-percent');
    var fillEl = document.getElementById('progress-bar-fill');
    var progressStatusTextEl = document.getElementById('progress-status-text');
    var etaEl = document.getElementById('progress-eta');
    var shownSteps = 0;
    var progressStartedAt = Date.now();
    var lastProgressPercent = 5;
    var waitingForAppBicep = false;
    var loadRequestInFlight = false;
    var graphRunFinished = false;
    var graphRunToken = Date.now().toString() + Math.random().toString(36).slice(2);
    window.radiusGraphRunToken = graphRunToken;
    var EXPECTED_GRAPH_DURATION_MS = 5 * 60 * 1000;
    var WAITING_STAGE_COPY = [
        { label: 'Checking for an existing app model', status: 'Checking the selected branch for .radius/app.bicep…' },
        { label: 'Analyzing the repository structure', status: 'Copilot is reviewing the repository so it can draft .radius/app.bicep.' },
        { label: 'Drafting .radius/app.bicep', status: 'Still working — larger repositories can take a few minutes at this stage.' },
        { label: 'Validating relationships for the graph', status: 'Finalizing the generated app model before Radius renders the graph.' }
    ];

    function clearGraphProgressTimers() {
        if (window.radiusGraphRunToken !== graphRunToken) return;
        if (window.radiusGraphProgressPoller) clearInterval(window.radiusGraphProgressPoller);
        if (window.radiusGraphProgressTicker) clearInterval(window.radiusGraphProgressTicker);
        if (window.radiusGraphRetryTimer) clearTimeout(window.radiusGraphRetryTimer);
    }

    function formatRemaining(ms) {
        if (ms <= 0) return 'Finishing up…';
        var totalSeconds = Math.ceil(ms / 1000);
        var minutes = Math.floor(totalSeconds / 60);
        if (minutes >= 2) return 'About ' + minutes + ' minutes remaining';
        if (minutes === 1) return 'About 1 minute remaining';
        return 'Less than a minute remaining';
    }

    function renderWaitingSteps(activeIndex, tone) {
        stepsEl.innerHTML = '';
        WAITING_STAGE_COPY.forEach(function(step, idx) {
            var div = document.createElement('div');
            div.className = tone === 'error'
                ? (idx === activeIndex ? 'step-error' : 'step-pending')
                : (idx < activeIndex ? 'step-done' : (idx === activeIndex ? 'step-active' : 'step-pending'));
            div.textContent = step.label;
            stepsEl.appendChild(div);
        });
    }

    function setProgressState(percent, stage, statusText, etaText, tone) {
        var clamped = Math.max(0, Math.min(100, percent));
        lastProgressPercent = clamped;
        if (fillEl) {
            fillEl.style.width = clamped + '%';
            fillEl.style.background = tone === 'error'
                ? 'var(--rad-danger)'
                : tone === 'success'
                    ? 'var(--rad-success)'
                    : 'var(--rad-brand)';
        }
        if (percentEl) percentEl.textContent = Math.round(clamped) + '%';
        if (stageEl) stageEl.textContent = stage;
        if (progressStatusTextEl) progressStatusTextEl.textContent = statusText;
        if (etaEl) etaEl.textContent = etaText;
    }

    function updateWaitingProgress() {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished || !waitingForAppBicep) return;
        var elapsed = Date.now() - progressStartedAt;
        var activeIndex = elapsed < 45000 ? 0 : elapsed < 150000 ? 1 : elapsed < 270000 ? 2 : 3;
        var percent = elapsed < EXPECTED_GRAPH_DURATION_MS
            ? 18 + ((elapsed / EXPECTED_GRAPH_DURATION_MS) * 50)
            : 72;
        renderWaitingSteps(activeIndex);
        setProgressState(
            Math.min(72, percent),
            WAITING_STAGE_COPY[activeIndex].label,
            WAITING_STAGE_COPY[activeIndex].status,
            elapsed < EXPECTED_GRAPH_DURATION_MS
                ? 'Usually completes in about 5 minutes. ' + formatRemaining(EXPECTED_GRAPH_DURATION_MS - elapsed) + '.'
                : 'Still running — complex repositories can take a little longer than 5 minutes.',
            'running'
        );
    }

    function syncProgressMessages(msgs) {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
        if (!Array.isArray(msgs)) msgs = [];
        if (msgs.length < shownSteps) {
            shownSteps = 0;
            stepsEl.innerHTML = '';
        }
        for (var i = shownSteps; i < msgs.length; i++) {
            var prev = stepsEl.querySelector('.step-active');
            if (prev) prev.className = 'step-done';
            var div = document.createElement('div');
            div.className = 'step-active';
            div.textContent = msgs[i];
            stepsEl.appendChild(div);
        }
        shownSteps = msgs.length;
        if (!msgs.length) return;
        var latest = msgs[msgs.length - 1] || '';
        if (latest.indexOf('Checking ') === 0) {
            waitingForAppBicep = false;
            setProgressState(10, 'Checking for an existing app model', latest, 'Usually completes in about 5 minutes.', 'running');
        } else if (latest.indexOf('.radius/app.bicep not present') === 0) {
            waitingForAppBicep = true;
            updateWaitingProgress();
        } else if (latest.indexOf('Found existing app.bicep') === 0) {
            waitingForAppBicep = false;
            setProgressState(82, 'Parsing .radius/app.bicep', latest, 'Final steps — less than a minute remaining.', 'running');
        } else if (latest.indexOf('Mapped ') === 0) {
            waitingForAppBicep = false;
            setProgressState(95, 'Rendering the application graph', latest, 'Almost done — preparing the final graph view.', 'running');
        } else {
            waitingForAppBicep = false;
            setProgressState(Math.max(lastProgressPercent, 88), 'Preparing the application graph', latest, 'Radius is still building the graph.', 'running');
        }
    }

    function scheduleGraphRetry(delayMs) {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
        if (window.radiusGraphRetryTimer) clearTimeout(window.radiusGraphRetryTimer);
        window.radiusGraphRetryTimer = setTimeout(function() {
            if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
            requestGraphLoad();
        }, delayMs || 10000);
    }

    function requestGraphLoad() {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished || loadRequestInFlight) return;
        loadRequestInFlight = true;
        fetch('/api/load-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch}) })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
                if (d.reload) {
                    waitingForAppBicep = false;
                    var prev = stepsEl.querySelector('.step-active');
                    if (prev) prev.className = 'step-done';
                    var doneDiv = document.createElement('div');
                    doneDiv.className = 'step-done';
                    doneDiv.textContent = 'Graph ready!';
                    stepsEl.appendChild(doneDiv);
                    setProgressState(100, 'Application graph ready', 'Application graph generated successfully.', 'Completed successfully.', 'success');
                    graphRunFinished = true;
                    clearGraphProgressTimers();
                    setTimeout(function() {
                        if (window.radiusGraphRunToken !== graphRunToken || !graphRunFinished) return;
                        window.location.reload();
                    }, 600);
                } else if (d.needsAppBicep) {
                    waitingForAppBicep = true;
                    if (!shownSteps) {
                        syncProgressMessages([
                            'Checking ' + repo + ' for existing app.bicep...',
                            '.radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill.'
                        ]);
                    } else {
                        updateWaitingProgress();
                    }
                    scheduleGraphRetry();
                } else if (d.stale) {
                    waitingForAppBicep = false;
                    setProgressState(
                        Math.max(lastProgressPercent, 88),
                        'Refreshing the application graph',
                        'A newer graph request replaced this one.',
                        'Retrying with the latest request shortly.',
                        'running'
                    );
                    scheduleGraphRetry(1000);
                } else if (d.error) {
                    waitingForAppBicep = false;
                    renderWaitingSteps(WAITING_STAGE_COPY.length - 1, 'error');
                    setProgressState(Math.min(lastProgressPercent, 95), 'Graph generation failed', 'Error: ' + d.error, 'The workflow stopped before completion.', 'error');
                    if (statusEl) { statusEl.textContent = 'Error: ' + d.error; statusEl.className = 'status error'; statusEl.style.display = ''; }
                    graphRunFinished = true;
                    clearGraphProgressTimers();
                }
            })
            .catch(function() {
                if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
                waitingForAppBicep = false;
                renderWaitingSteps(WAITING_STAGE_COPY.length - 1, 'error');
                setProgressState(Math.min(lastProgressPercent, 95), 'Graph generation failed', 'Failed to continue generating the application graph.', 'Please try again.', 'error');
                if (statusEl) { statusEl.textContent = 'Failed to generate the application graph.'; statusEl.className = 'status error'; statusEl.style.display = ''; }
                graphRunFinished = true;
                clearGraphProgressTimers();
            })
            .finally(function() {
                if (window.radiusGraphRunToken !== graphRunToken) return;
                loadRequestInFlight = false;
            });
    }

    renderWaitingSteps(0);
    window.radiusGraphProgressPoller = setInterval(function() {
        if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
        fetch('/api/progress').then(function(r) { return r.json(); }).then(function(d) {
            if (window.radiusGraphRunToken !== graphRunToken || graphRunFinished) return;
            syncProgressMessages(d.messages || []);
        }).catch(function() {});
    }, 800);
    window.radiusGraphProgressTicker = setInterval(updateWaitingProgress, 1000);
    requestGraphLoad();
}
<\/script>
${graphHeaderClose()}`
    );
  }

  return pageShell(
    "Application Graph",
    `
${graphHeader("graph")}
<p class="rad-lede" id="modeled-subtitle" style="margin:0 0 24px;">The modeled application graph shows the high-level architecture of your application as it is designed in code.<span id="modeled-subtitle-hint"></span></p>
<div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:16px; flex-wrap:wrap;">
  <input type="hidden" id="graph-repo" value="${escapeHtml(targetRepo)}">
  <div class="rad-field">
    <label>Application</label>
    <select id="graph-app" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="">Loading applications...</option>
    </select>
  </div>
  <div class="rad-field">
    <label>Branch</label>
    <select id="graph-branch" class="rad-select" style="min-width:180px; width:auto; max-width:400px;">
      <option value="${escapeHtml(graphBranch)}" selected>${escapeHtml(
        graphBranch || "main"
      )}</option>
    </select>
  </div>
  <button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;">Plan Deployment</button>
</div>
<div id="graph-container"></div>
<div id="graph-refresh-status" class="status error" style="display:none;"></div>
<div style="margin-top:8px; font-size:12px; color:var(--rad-text-tertiary);">
Click a node to view source code links.
</div>

<script>
var CONTEXT_REPO = document.getElementById('graph-repo').value;
var CURRENT_BRANCH = '${inlineJsString(graphBranch || "main")}';

// Populate the Application dropdown for the current repository.
(function() {
    var appSel = document.getElementById('graph-app');
    if (!CONTEXT_REPO) { appSel.innerHTML = '<option value="">No application context</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CONTEXT_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = d.applications || [];
            appSel.innerHTML = '';
            if (apps.length === 0) {
                var f = CONTEXT_REPO.split('/').pop() || CONTEXT_REPO;
                var o = document.createElement('option'); o.value = f; o.textContent = f; appSel.appendChild(o);
                return;
            }
            apps.forEach(function(a) { var o = document.createElement('option'); o.value = a.name; o.textContent = a.name; appSel.appendChild(o); });
        })
        .catch(function() { appSel.innerHTML = '<option value="">Unable to load applications</option>'; });
})();

// Populate the Branch dropdown, keeping the current branch selected.
function populateGraphBranches() {
    var branchSel = document.getElementById('graph-branch');
    if (!CONTEXT_REPO) return;
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: CONTEXT_REPO}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var branches = (d && d.branches) || [];
            if (!branches.length) return;
            branchSel.innerHTML = '';
            branches.forEach(function(b) {
                var o = document.createElement('option');
                o.value = b.name;
                o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : ' (' + b.sha.slice(0,7) + ')');
                if (b.name === CURRENT_BRANCH) o.selected = true;
                branchSel.appendChild(o);
            });
        })
        .catch(function() {});
}
populateGraphBranches();

// Regenerate the graph when a different branch is selected.
function handleGraphBranchChange() {
    var repo = CONTEXT_REPO;
    var branch = this.value.trim();
    if (!repo || !branch) return;
    var container = document.getElementById('graph-container');
    container.innerHTML = '<div style="padding:20px; color:var(--rad-text-tertiary);">⏳ Regenerating graph for <span id="graph-regeneration-branch"></span>…</div>';
    document.getElementById('graph-regeneration-branch').textContent = branch;
    fetch('/api/load-graph', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo, branch: branch}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.reload) { window.location.reload(); }
            else if (d.needsAppBicep) { container.innerHTML = '<div class="status info">Copilot is generating .radius/app.bicep with the Radius app-bicep skill\u2026 the graph will appear once it is saved.</div>'; }
            else if (d.error) { container.innerHTML = '<div class="status error"></div>'; container.firstChild.textContent = 'Error: ' + d.error; }
        })
        .catch(function() { container.innerHTML = '<div class="status error">Failed to regenerate graph.</div>'; });
}
document.getElementById('graph-branch').addEventListener('change', handleGraphBranchChange);

// Primary action → Create Environment or Plan Deployment, depending on setup.
document.getElementById('deploy-app-btn').addEventListener('click', function(e) {
    radiusModeledPrimaryAction(this);
});

radiusLoadModeledEnvState(CONTEXT_REPO);

var resources = ${resourcesJson};
var repoUrl = 'https://github.com/' + document.getElementById('graph-repo').value.trim();
var branch = document.getElementById('graph-branch').value.trim() || 'main';
var graphOptions = {
    repoUrl: repoUrl,
    branch: branch,
    localSource: ${localSource ? "true" : "false"}
};
var graphController = radiusRenderGraph('graph-container', resources, graphOptions);

// Rebuild from app.bicep whenever the panel is loaded. This keeps a reopened
// panel current after a merge without requiring a new canvas instance.
fetch('/api/load-graph', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({repo: CONTEXT_REPO, branch: branch, refresh: true})
})
    .then(function(r) { return r.json(); })
    .then(function(d) {
        if (Array.isArray(d.resources)) {
            if (graphController) graphController = graphController.update(d.resources) || graphController;
            else graphController = radiusRenderGraph('graph-container', d.resources, graphOptions);
        } else if (d.needsAppBicep) {
            var generatingStatus = document.getElementById('graph-refresh-status');
            generatingStatus.className = 'status info';
            generatingStatus.textContent = 'Copilot is rebuilding the application graph from .radius/app.bicep with the Radius app-bicep skill.';
            generatingStatus.style.display = '';
        } else if (d.error) {
            var status = document.getElementById('graph-refresh-status');
            status.textContent = 'Unable to refresh the application graph: ' + d.error;
            status.style.display = '';
        }
    })
    .catch(function() {
        var status = document.getElementById('graph-refresh-status');
        status.textContent = 'Unable to refresh the application graph.';
        status.style.display = '';
    });
<\/script>
${graphHeaderClose()}`
  );
}
