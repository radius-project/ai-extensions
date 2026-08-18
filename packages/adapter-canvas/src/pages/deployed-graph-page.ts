// Canvas adapter — the deployed application graph page: what is running in an
// environment, including live deployment progress and log streaming.

import { type CanvasState } from "../shared.js";
import { pageShell } from "./shell.js";
import { graphHeader, graphHeaderClose } from "./graph-header.js";
import { DELETE_DEPLOYMENT_DIALOG_HTML } from "./fragments.js";
import { inlineJson } from "./encoding.js";

export function deployedGraphPage(state: CanvasState = {}): string {
  const targetRepo =
    state?.contextRepo ||
    state?.deployingRepo ||
    state?.plannedRepo ||
    state?.graphTargetRepo ||
    "";
  // Branch the "Deploy Application" mode dispatches against. The Deployed pane
  // has no branch selector (it shows what's already running), so fall back to
  // the session/worktree branch the rest of the canvas is pinned to.
  const deployBranch =
    state?.contextBranch ||
    state?.plannedBranch ||
    state?.graphBranch ||
    "main";
  const deployProvider =
    state?.plannedProvider || state?.deployProvider || "azure";
  // The branch "View source code" links resolve against. The server returns the
  // authoritative branch with the graph; this is only the value used before the
  // first response lands. Previously this page hardcoded 'main', which broke
  // source links for anyone working on a session worktree branch.
  const targetBranch =
    state?.contextBranch ||
    state?.deployingBranch ||
    state?.plannedBranch ||
    state?.graphBranch ||
    "main";
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
  <div id="deployed-graph-label" style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:12px; line-height:1.5;"></div>
  <div id="deployed-mode-note" style="display:none; font-size:12px; color:var(--rad-text-secondary); margin-bottom:12px;"></div>
  <div id="deployed-status" class="status info">Loading deployed application graph…</div>
  <div id="graph-container"></div>
</div>

<div id="deployed-log-section" class="rad-card" style="margin:16px 0 0; display:none;">
  <div style="font-size:15px; font-weight:600; color:var(--rad-text); margin-bottom:10px;">Deployment Logs</div>
  <div id="deployed-log-output" style="background:var(--rad-code-bg); color:var(--rad-code-text); border:1px solid var(--rad-stroke); font-family:var(--rad-mono); font-size:12px; padding:12px; border-radius:6px; max-height:280px; overflow-y:auto; white-space:pre-wrap; line-height:1.6;"></div>
</div>

<!-- Delete confirmation: the same 3-step type-to-confirm dialog the Deployments
     tab uses, so deleting from the graph is gated exactly as heavily. -->
${DELETE_DEPLOYMENT_DIALOG_HTML}

<!-- Deleting (transition) modal -->
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
  /* Keep the adaptive primary button baseline-aligned with the selects it sits
     beside, rather than stretching to the row's full height. */
  .rad-deployed-controls .rad-btn { align-self:flex-end; flex:0 0 auto; }
</style>
<script>
var CONTEXT_REPO = ${inlineJson(targetRepo)};
var CONTEXT_BRANCH = ${inlineJson(deployBranch)};
var GRAPH_BRANCH = ${inlineJson(targetBranch)};
var FALLBACK_PROVIDER = ${inlineJson(deployProvider)};
var ENV_PROVIDERS = {};
// Creation status per environment, as /api/list-environments reports it. An
// environment whose credential verification did not succeed cannot receive a
// deployment, so it must not enable "Deploy Application" here either.
var ENV_STATUS = {};

function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}

(function() {
    var params = new URLSearchParams(window.location.search);
    var wantEnv = params.get('environment') || '';
    var wantApp = params.get('application') || '';

    var appSelect = document.getElementById('deployed-app-select');
    var envSelect = document.getElementById('deployed-env-select');
    var deleteBtn = document.getElementById('deployed-delete-btn');
    var statusEl = document.getElementById('deployed-status');
    var labelEl = document.getElementById('deployed-graph-label');
    var modeNote = document.getElementById('deployed-mode-note');
    var container = document.getElementById('graph-container');
    var inlineStatus = document.getElementById('deployed-inline-status');
    var pollTimer = null;
    var controller = null;
    var LAST_MODE = '';
    var graphFetchController = null;
    // Artifact uploads take several seconds, so a faster poll returns the same
    // bytes. The deploy log below the graph streams at 1.5s and carries the
    // moment-to-moment liveness.
    var POLL_MS = 15000;

    // Adaptive primary-button state. HAS_ENVS gates "Create Environment";
    // DEPLOYMENTS_BY_TARGET (application + environment → status from
    // /api/list-deployments) decides between "Deploy Application" and "Delete
    // Deployment" for the exact selection.
    var HAS_ENVS = false;
    var DEPLOYMENTS_BY_TARGET = {};
    // Set when the deployment listing could not be read, so the button can be
    // held disabled rather than acting on state we cannot confirm.
    var DEPLOYMENT_STATES_STALE = false;

    function deploymentKey(app, env) {
        return encodeURIComponent(app) + '|' + encodeURIComponent(env);
    }

    // A deployment "exists" for the selection when the environment has any
    // row at all, including a failed one: a failed deploy can leave partially
    // provisioned infrastructure behind, so the user still needs "Delete
    // Deployment" to clean it up.
    function deploymentExists(app, env) {
        if (!CONTEXT_REPO || !app || !env) return false;
        return !!DEPLOYMENTS_BY_TARGET[deploymentKey(app, env)];
    }

    // The selected environment's deployment status, or '' when nothing is
    // deployed there. "deleting" means a delete run is still in flight.
    function deploymentStatus(app, env) {
        if (!deploymentExists(app, env)) return '';
        return DEPLOYMENTS_BY_TARGET[deploymentKey(app, env)] || '';
    }

    // --- Deployment log streaming (shown under the graph while a deploy runs) ---
    var logSection = document.getElementById('deployed-log-section');
    var logOutput = document.getElementById('deployed-log-output');
    var logTimer = null;
    var LOG_TOTAL = 0;
    var logStreamStarted = false;

    function stopLogStream() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

    function pollLogs() {
        fetch('/api/deploy-status?since=' + LOG_TOTAL).then(function(r) { return r.json(); }).then(function(d) {
            if (d.logsNew && d.logsNew.length) {
                for (var i = 0; i < d.logsNew.length; i++) { logOutput.textContent += d.logsNew[i] + '\\n'; }
                logOutput.scrollTop = logOutput.scrollHeight;
            }
            if (typeof d.logTotal === 'number') { LOG_TOTAL = d.logTotal; }
            if (d.status === 'complete' || d.status === 'success' || d.status === 'failed') { stopLogStream(); }
        }).catch(function() {});
    }

    function startLogStream() {
        if (logStreamStarted) return;
        logStreamStarted = true;
        logSection.style.display = 'block';
        // Pull the full buffer once (since=0), then stream incrementally.
        fetch('/api/deploy-status?since=0').then(function(r) { return r.json(); }).then(function(d) {
            var lines = (d && d.logs) || (d && d.logsNew) || [];
            for (var i = 0; i < lines.length; i++) { logOutput.textContent += lines[i] + '\\n'; }
            logOutput.scrollTop = logOutput.scrollHeight;
            if (typeof d.logTotal === 'number') { LOG_TOTAL = d.logTotal; }
            else { LOG_TOTAL = lines.length; }
            if (d && (d.status === 'complete' || d.status === 'success' || d.status === 'failed')) return;
            logTimer = setInterval(pollLogs, 1500);
        }).catch(function() {});
    }

    // Show the deploy feed whenever this session has produced one, including
    // after the run finished — that log is where a failure explains itself.
    function maybeStartLogStream() {
        fetch('/api/deploy-status').then(function(r) { return r.json(); }).then(function(d) {
            if (!d) return;
            if (d.status === 'in_progress' || d.status === 'complete' || d.status === 'success' || d.status === 'failed' || d.logTotal) {
                startLogStream();
            }
        }).catch(function() {});
    }

    function showInline(kind, msg) {
        inlineStatus.style.display = 'block';
        inlineStatus.textContent = msg;
        if (kind === 'error') { inlineStatus.style.background = 'var(--rad-danger-bg)'; inlineStatus.style.color = 'var(--rad-text)'; inlineStatus.style.border = '1px solid var(--rad-danger)'; }
        else { inlineStatus.style.background = 'var(--rad-info-bg)'; inlineStatus.style.color = 'var(--rad-text)'; inlineStatus.style.border = '1px solid var(--rad-info)'; }
    }

    function refreshControls() {
        var app = appSelect.value, env = envSelect.value;
        radiusApplyDeployedEnvState(HAS_ENVS, deploymentExists(app, env), deploymentStatus(app, env), DEPLOYMENT_STATES_STALE, env ? ENV_STATUS[env] : '');
        labelEl.innerHTML = (app && env)
            ? 'Application: <strong>' + escapeHtmlClient(app) + '</strong><br>Environment: <strong>' + escapeHtmlClient(env) + '</strong>'
            : '';
        // Both a delete in flight and an unreadable listing are transient, and
        // both leave the button disabled — so poll until they resolve, or the
        // button would stay stuck until a manual reload.
        var status = deploymentStatus(app, env);
        scheduleStatePoll(status === 'pending' || status === 'deleting' || DEPLOYMENT_STATES_STALE);
    }

    // Refresh the deployment listing while a delete runs, or while the listing
    // is unreadable, so the button recovers on its own once real state arrives.
    // Bounded so a stuck delete or a persistent outage never polls forever; on
    // timeout the real status is whatever the listing last reported.
    var statePollTimer = null;
    var statePollTries = 0;
    function scheduleStatePoll(active) {
        if (!active) {
            if (statePollTimer) { clearTimeout(statePollTimer); statePollTimer = null; }
            statePollTries = 0;
            return;
        }
        if (statePollTimer || statePollTries > 45) return; // ~3 min at 4s
        statePollTimer = setTimeout(function() {
            statePollTimer = null;
            statePollTries++;
            loadDeploymentStates().then(refreshControls);
        }, 4000);
    }

    function showNothing(msg) {
        if (statusEl) { statusEl.style.display = 'none'; }
        if (controller) { try { controller.destroy(); } catch (e) {} controller = null; }
        container.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; min-height:240px; color:var(--rad-text-tertiary,#656d76); font-size:14px; border:1px dashed var(--rad-stroke,#d1d9e0); border-radius:6px;">' + (msg || 'Nothing deployed yet') + '</div>';
    }

    // Render (or update in place). Updating through the controller preserves
    // React Flow's viewport, so a status refresh never resets the user's pan
    // or zoom mid-deploy.
    function renderGraph(resources, branch) {
        if (statusEl) { statusEl.style.display = 'none'; }
        if (controller) { controller.update(resources); return; }
        controller = radiusRenderGraph('graph-container', resources, {
            repoUrl: 'https://github.com/' + CONTEXT_REPO,
            branch: branch || GRAPH_BRANCH || 'main',
            showLegend: true,
            deployMode: true
        });
    }

    // Describe what the graph is showing. The freshness suffix reports the age
    // of the DATA (the producer's updatedAt), not the age of our last fetch --
    // polling more often does not make a three-day-old deployment newer.
    function describeMode(mode, updatedAt, shownApp) {
        if (mode === 'greyed') return 'Not deployed yet — showing the modeled application.';
        var suffix = '';
        var at = updatedAt ? Date.parse(updatedAt) : 0;
        if (at) {
            var secs = Math.max(0, Math.round((Date.now() - at) / 1000));
            suffix = ' · updated ' + (secs < 60 ? secs + 's' : secs < 3600 ? Math.round(secs / 60) + 'm' : Math.round(secs / 3600) + 'h') + ' ago';
        }
        // The selected app may have no artifact yet, so the server falls back to
        // an env-only match and returns which app it actually resolved. When that
        // differs from the selection, say so rather than labeling app B's status
        // as app A.
        var appNote = (shownApp && appSelect.value && String(shownApp).toLowerCase() !== appSelect.value.toLowerCase())
            ? ' · showing ' + shownApp
            : '';
        if (mode === 'live') {
            // Be honest about the cadence: each artifact upload takes seconds,
            // so a graph that looks static usually means "no new data yet".
            return 'Deploying' + suffix + appNote + ' · refreshes every ' + Math.round(POLL_MS / 1000) + 's';
        }
        return 'Last deployment' + suffix + appNote + '.';
    }

    function setModeNote(text) {
        if (!modeNote) return;
        modeNote.textContent = text || '';
        modeNote.style.display = text ? 'block' : 'none';
    }

    function loadGraph() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (!CONTEXT_REPO) { showNothing('Nothing deployed yet'); return; }
        if (statusEl && !controller) { statusEl.style.display = ''; statusEl.textContent = 'Loading deployed application graph…'; }
        var query = '/api/deployed-graph?repo=' + encodeURIComponent(CONTEXT_REPO);
        if (appSelect.value) { query += '&application=' + encodeURIComponent(appSelect.value); }
        if (envSelect.value) { query += '&environment=' + encodeURIComponent(envSelect.value); }
        // Abort any fetch still in flight so a slow response from a previous
        // load (or one issued before the tab was hidden) cannot land and
        // re-render after this one.
        if (graphFetchController) { try { graphFetchController.abort(); } catch (e) {} }
        graphFetchController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var fetchOpts = graphFetchController ? { signal: graphFetchController.signal } : undefined;
        fetch(query, fetchOpts).then(function(r) { return r.json(); }).then(function(d) {
            var resources = (d && d.resources) || [];
            var mode = (d && d.mode) || 'greyed';
            LAST_MODE = mode;
            // Stream the deploy feed whenever there is one to show.
            if (mode === 'live') { startLogStream(); }
            if (!resources.length) {
                // Genuinely nothing to draw: no deployed graph AND no modeled
                // application to fall back to.
                showNothing('Nothing deployed yet');
                setModeNote('');
            } else {
                renderGraph(resources, d && d.branch);
                setModeNote(describeMode(mode, d && d.updatedAt, d && d.application));
            }
            if (mode === 'live') { pollTimer = setTimeout(loadGraph, POLL_MS); }
        }).catch(function(err) {
            // A fetch aborted on tab-hide (or superseded by a newer load) must
            // not repaint or reschedule — that is the pause working.
            if (err && err.name === 'AbortError') { return; }
            if (!controller) { showNothing('Nothing deployed yet'); }
            // Keep polling through a transient failure. Dropping the timer here
            // would freeze the graph mid-deploy for the life of the page while
            // the note still promised a refresh. Do not reschedule while hidden.
            if (LAST_MODE === 'live' && document.visibilityState !== 'hidden') { pollTimer = setTimeout(loadGraph, POLL_MS); }
        });
    }

    // Pause polling while the panel is hidden; resume (and refresh once) when it
    // comes back, but only for a live deploy -- a terminal or greyed view never
    // scheduled a poll, so tabbing back to it must not start hitting the API.
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') {
            if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
            if (graphFetchController) { try { graphFetchController.abort(); } catch (e) {} graphFetchController = null; }
        } else if (LAST_MODE === 'live' && !pollTimer) {
            loadGraph();
        }
    });

    function loadApplications() {
        return fetch('/api/list-applications?repo=' + encodeURIComponent(CONTEXT_REPO))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var apps = (d && d.applications) || [];
                if (!apps.length) { appSelect.innerHTML = '<option value="">No applications</option>'; return; }
                appSelect.innerHTML = apps.map(function(a) { return '<option value="' + escapeHtmlClient(a.name) + '">' + escapeHtmlClient(a.name) + '</option>'; }).join('');
                if (wantApp) { appSelect.value = wantApp; }
            })
            .catch(function() { appSelect.innerHTML = '<option value="">Could not load</option>'; });
    }

    function loadEnvironments() {
        return fetch('/api/list-environments?repo=' + encodeURIComponent(CONTEXT_REPO))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var envs = (d && d.environments) || [];
                if (!envs.length) { HAS_ENVS = false; envSelect.innerHTML = '<option value="">No environments</option>'; return; }
                HAS_ENVS = true;
                envs.forEach(function(e) {
                    ENV_PROVIDERS[e.name] = e.provider || FALLBACK_PROVIDER;
                    ENV_STATUS[e.name] = e.status || '';
                });
                envSelect.innerHTML = envs.map(function(e) {
                    return '<option value="' + escapeHtmlClient(e.name) + '">' + escapeHtmlClient(radiusEnvOptionLabel(e)) + '</option>';
                }).join('');
                // Land on an environment that can actually be deployed to, unless
                // the caller asked for a specific one.
                var firstReady = radiusFirstReadyEnvName(envs);
                if (firstReady) { envSelect.value = firstReady; }
                if (wantEnv) { envSelect.value = wantEnv; }
            })
            .catch(function() { HAS_ENVS = false; envSelect.innerHTML = '<option value="">Could not load</option>'; });
    }

    // Resolve which environments currently hold a deployment, so the primary
    // button can choose between deploying and deleting for the selection.
    //
    // /api/list-deployments answers a transient GitHub failure with HTTP 200 and
    // { deployments: [], error } rather than a rejection. Treating that as "no
    // deployments" would clear an environment that actually has a deploy or
    // delete in flight, flipping the button back to "Deploy Application" and
    // letting the user start a conflicting operation. So keep the last-known
    // map and flag it stale; refreshControls disables the button until a
    // subsequent poll reads real state. The Deployments tab handles the same
    // shape the same way (see its load-error row).
    function loadDeploymentStates() {
        return fetch('/api/list-deployments?repo=' + encodeURIComponent(CONTEXT_REPO))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d && d.error) { DEPLOYMENT_STATES_STALE = true; return; }
                DEPLOYMENT_STATES_STALE = false;
                DEPLOYMENTS_BY_TARGET = {};
                ((d && d.deployments) || []).forEach(function(dep) {
                    if (dep && dep.app && dep.environment) {
                        DEPLOYMENTS_BY_TARGET[deploymentKey(dep.app, dep.environment)] = dep.status || 'unknown';
                    }
                });
            })
            .catch(function() { DEPLOYMENT_STATES_STALE = true; });
    }

    appSelect.addEventListener('change', function() { refreshControls(); loadGraph(); });
    envSelect.addEventListener('change', function() { refreshControls(); loadGraph(); });

    // --- Delete deployment (shared 3-step type-to-confirm dialog) ---
    var deleteDialog = radiusCreateDeleteDeploymentDialog({ onConfirm: runDelete });

    deleteBtn.addEventListener('click', function() {
        // The primary button is adaptive — route by the mode the current
        // environment/deployment state selected.
        var mode = this.dataset.mode;
        if (mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
        if (mode === 'deploy') {
            radiusDeployDeployedApp(this, CONTEXT_REPO, CONTEXT_BRANCH, ENV_PROVIDERS, FALLBACK_PROVIDER);
            return;
        }
        var app = appSelect.value, env = envSelect.value;
        if (!app || !env || !deleteDialog) return;
        deleteDialog.open(app, env);
    });

    // Unlike the Deployments table, this page has no row to annotate with a
    // "Deleting…" status, so it shows a transition modal and then hands the user
    // to the Deployments tab to watch the workflow run.
    function runDelete(app, env) {
        if (!app || !env) return;
        document.getElementById('deployed-deleting-text').innerHTML = 'Deleting application <strong>' + escapeHtmlClient(app) + '</strong> from <strong>' + escapeHtmlClient(env) + '</strong> with <code>rad app delete</code>. This may take a few minutes.';
        document.getElementById('deployed-deleting-modal').style.display = 'flex';
        fetch('/api/delete-deployment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CONTEXT_REPO, environment: env, application: app }) })
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
            .then(function(res) {
                document.getElementById('deployed-deleting-modal').style.display = 'none';
                if (!res.ok) { showInline('error', (res.d && res.d.error) || 'Could not start the delete workflow.'); return; }
                window.location.href = '/?page=deploying';
            })
            .catch(function() {
                document.getElementById('deployed-deleting-modal').style.display = 'none';
                showInline('error', 'Could not delete the deployment. Please try again.');
            });
    }

    Promise.all([loadApplications(), loadEnvironments(), loadDeploymentStates()]).then(function() {
        refreshControls();
        maybeStartLogStream();
        loadGraph();
    });
})();
<\/script>
${graphHeaderClose()}`
  );
}
