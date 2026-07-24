// Canvas adapter — browser-side client JavaScript, served as inline <script>
// text inside the page shell. Three cohesive blocks: the shared repo/branch
// dropdown library, the shared React Flow / dagre graph renderer, and the client
// heartbeat / auto-reconnect watchdog. Authored as ES5 the webview runs
// directly; embedded verbatim by pageShell. No server-side interpolation here.

export const CLIENT_REPO_BRANCH_JS = `
// ─── Shared Repo/Branch Library ───────────────────────────────────────────────
// Provides consistent repo/branch dropdowns across all panes (matches diff pane style).

function radiusPopulateRepos(selectId, defaultRepo) {
    var sel = document.getElementById(selectId);
    if (!sel) return Promise.resolve();
    function doFetch() {
        return fetch('/api/user-repos?_t=' + Date.now()).then(function(r) { return r.json(); }).then(function(d) {
            sel.innerHTML = '<option value="">-- Select repository --</option>';
            var found = false;
            (d.repos || []).forEach(function(r) {
                var o = document.createElement('option');
                o.value = r; o.textContent = r;
                if (r === defaultRepo) { o.selected = true; found = true; }
                sel.appendChild(o);
            });
            if (defaultRepo && !found) {
                var o = document.createElement('option');
                o.value = defaultRepo; o.textContent = defaultRepo; o.selected = true;
                sel.insertBefore(o, sel.children[1]);
            }
        });
    }
    return doFetch().catch(function() { return new Promise(function(r) { setTimeout(r, 1000); }).then(doFetch); });
}

function radiusPopulateBranches(selectIds, repo, defaults) {
    if (!repo) return Promise.resolve();
    if (typeof selectIds === 'string') { selectIds = [selectIds]; defaults = [defaults]; }
    return fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.error) return;
            var branches = data.branches || [];
            var workspaceBranch = data.workspaceBranch || '';
            for (var i = 0; i < selectIds.length; i++) {
                var sel = document.getElementById(selectIds[i]);
                if (!sel) continue;
                var defaultVal = (defaults && defaults[i]) || 'main';
                sel.innerHTML = '';
                var found = false;
                for (var j = 0; j < branches.length; j++) {
                    var o = document.createElement('option');
                    o.value = branches[j].name;
                    o.textContent = branches[j].name + (branches[j].sha === 'worktree' ? ' (worktree)' : ' (' + branches[j].sha.slice(0,7) + ')');
                    if (branches[j].name === defaultVal) { o.selected = true; found = true; }
                    sel.appendChild(o);
                }
                if (!found && defaultVal && defaultVal === workspaceBranch) {
                    var local = document.createElement('option');
                    local.value = defaultVal;
                    local.textContent = defaultVal + ' (worktree)';
                    local.selected = true;
                    sel.insertBefore(local, sel.firstChild);
                } else if (!found && branches.length > 0) {
                    sel.selectedIndex = 0;
                }
            }
        });
}

function radiusSetupRepoBranch(repoSelectId, branchSelectIds, defaultRepo, defaultBranches) {
    if (typeof branchSelectIds === 'string') { branchSelectIds = [branchSelectIds]; defaultBranches = [defaultBranches]; }
    radiusPopulateRepos(repoSelectId, defaultRepo).then(function() {
        var repoSel = document.getElementById(repoSelectId);
        if (repoSel && repoSel.value) {
            radiusPopulateBranches(branchSelectIds, repoSel.value, defaultBranches);
        }
    });
    var repoSel = document.getElementById(repoSelectId);
    if (repoSel) {
        repoSel.addEventListener('change', function() {
            if (this.value) radiusPopulateBranches(branchSelectIds, this.value, defaultBranches);
        });
    }
}

// Populate the Application / Branch / Environment selectors on the Planned
// Graph pane. The repository is assumed from the workspace, so it is not a
// selectable field. Fills the passed envProviders map so the caller can derive
// the cloud provider from the chosen environment. When defaultBranch is given
// (loaded state) it is pre-selected; otherwise no branch is pre-selected.
function radiusPopulatePlannedSelectors(repo, envProviders, defaultBranch) {
    var appSel = document.getElementById('planned-app');
    var branchSel = document.getElementById('planned-branch');
    var envSel = document.getElementById('planned-env');
    if (!repo) {
        if (appSel) appSel.innerHTML = '<option value="">No repository</option>';
        if (branchSel) branchSel.innerHTML = '<option value="">No repository</option>';
        if (envSel) envSel.innerHTML = '<option value="">No repository</option>';
        return;
    }
    if (appSel) {
        fetch('/api/list-applications?repo=' + encodeURIComponent(repo))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var apps = (d && d.applications) || [];
                appSel.innerHTML = '';
                if (!apps.length) {
                    var fallback = repo.split('/').pop() || repo;
                    var o = document.createElement('option'); o.value = fallback; o.textContent = fallback; appSel.appendChild(o);
                    return;
                }
                apps.forEach(function(a) { var o = document.createElement('option'); o.value = a.name; o.textContent = a.name; appSel.appendChild(o); });
            })
            .catch(function() { appSel.innerHTML = '<option value="">Unable to load applications</option>'; });
    }
    if (branchSel) {
        fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo}) })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var branches = (d && d.branches) || [];
                branchSel.innerHTML = '<option value="">— Select a branch —</option>';
                branches.forEach(function(b) {
                    var o = document.createElement('option');
                    o.value = b.name;
                    o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : ' (' + b.sha.slice(0,7) + ')');
                    if (defaultBranch && b.name === defaultBranch) o.selected = true;
                    branchSel.appendChild(o);
                });
            })
            .catch(function() { branchSel.innerHTML = '<option value="">Unable to load branches</option>'; });
    }
    if (envSel) {
        fetch('/api/list-environments?repo=' + encodeURIComponent(repo))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var envs = (d && d.environments) || [];
                if (!envs.length) {
                    envSel.innerHTML = '<option value="">No environments</option>';
                    radiusApplyPlanEnvState(false);
                    return;
                }
                envSel.innerHTML = '';
                envs.forEach(function(e) {
                    if (envProviders) envProviders[e.name] = e.provider || 'azure';
                    var o = document.createElement('option'); o.value = e.name; o.textContent = e.name; envSel.appendChild(o);
                });
                radiusApplyPlanEnvState(true);
            })
            .catch(function() { envSel.innerHTML = '<option value="">Unable to load environments</option>'; });
    }
}

// Toggle the planned-graph primary button between "Create Environment" (when the
// repo has no Radius-managed environment) and its normal plan label. When there
// is no environment the button navigates to the environment page instead of
// planning, and an explanatory note is shown.
function radiusApplyPlanEnvState(hasEnv) {
    var btn = document.getElementById('plan-btn');
    var note = document.getElementById('plan-env-note');
    if (btn) {
        if (hasEnv) {
            btn.dataset.mode = 'plan';
            btn.textContent = btn.dataset.planLabel || 'Plan Deployment';
        } else {
            btn.dataset.mode = 'create-env';
            btn.textContent = 'Create Environment';
        }
    }
    if (note) note.style.display = hasEnv ? 'none' : '';
}

// Populate the Base/Head selectors on the Graph Diff pane. Base defaults to
// "main" and Head defaults to the current worktree branch when it has been
// pushed; if the worktree branch is not pushed (or there is none), Head is left
// unselected so the user can pick a branch. Only pushed branches are offered
// (a diff is computed from GitHub refs). When autoCompare is not false and a
// head resolves, the Compare button is clicked automatically.
function radiusPopulateDiffBranches(repo, preferBase, preferHead, autoCompare) {
    var baseSel = document.getElementById('base-branch');
    var headSel = document.getElementById('head-branch');
    var statusEl = document.getElementById('diff-status');
    if (!repo) { if (statusEl) statusEl.textContent = 'No repository context.'; return; }
    if (statusEl) statusEl.textContent = 'Loading branches…';
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.error) { if (statusEl) { statusEl.textContent = 'Error: ' + d.error; statusEl.className = 'status error'; } return; }
            var branches = d.branches || [];
            var workspaceBranch = d.workspaceBranch || '';
            // Base must be a real GitHub ref (the diff is computed against a
            // pushed base). Head may additionally be the local worktree branch —
            // the backend reads its app.bicep straight from the workspace, so an
            // unpushed worktree can be compared without being pushed first.
            var pushed = branches.filter(function(b) { return b.sha && b.sha !== 'worktree'; });
            var headBranches = branches.filter(function(b) { return b.sha && (b.sha !== 'worktree' || b.name === workspaceBranch); });
            var worktreePushed = pushed.some(function(b) { return b.name === workspaceBranch; });

            var desiredBase = preferBase || 'main';
            // Default head to the current worktree branch whether or not it is
            // pushed, now that unpushed worktrees are selectable.
            var desiredHead = preferHead || workspaceBranch;

            baseSel.innerHTML = '';
            headSel.innerHTML = '<option value="">— Select a branch —</option>';
            pushed.forEach(function(b) {
                var label = b.name + ' (' + b.sha.slice(0,7) + ')';
                var ob = document.createElement('option'); ob.value = b.name; ob.textContent = label;
                if (b.name === desiredBase) ob.selected = true;
                baseSel.appendChild(ob);
            });
            headBranches.forEach(function(b) {
                var label = b.name + (b.sha === 'worktree' ? ' (worktree)' : ' (' + b.sha.slice(0,7) + ')');
                var oh = document.createElement('option'); oh.value = b.name; oh.textContent = label;
                if (desiredHead && b.name === desiredHead) oh.selected = true;
                headSel.appendChild(oh);
            });
            if (!baseSel.value && baseSel.options.length) baseSel.selectedIndex = 0;

            if (headSel.value) {
                if (statusEl) { statusEl.className = 'status info'; statusEl.textContent = 'Comparing ' + baseSel.value + ' → ' + headSel.value + '…'; }
                // Auto-load the diff for the resolved head branch.
                if (autoCompare !== false) headSel.dispatchEvent(new Event('change'));
            } else if (statusEl) {
                statusEl.className = 'status info';
                statusEl.textContent = 'Select a head branch to compare against ' + (baseSel.value || 'main') + '.';
            }
        })
        .catch(function() { if (statusEl) { statusEl.textContent = 'Failed to load branches.'; statusEl.className = 'status error'; } });
}

// Populate an Application <select> for the given repository. A repo hosts a
// single Radius application in this model; falls back to the repo short name.
function radiusPopulateApplications(repo, selectId) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    if (!repo) { sel.innerHTML = '<option value="">No application context</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(repo))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = (d && d.applications) || [];
            sel.innerHTML = '';
            if (!apps.length) {
                var f = repo.split('/').pop() || repo;
                var o = document.createElement('option'); o.value = f; o.textContent = f; sel.appendChild(o);
                return;
            }
            apps.forEach(function(a) { var o = document.createElement('option'); o.value = a.name; o.textContent = a.name; sel.appendChild(o); });
        })
        .catch(function() { sel.innerHTML = '<option value="">Unable to load applications</option>'; });
}
`;

export const CLIENT_GRAPH_JS = `
// ─── Shared Graph Renderer (React Flow) ──────────────────────────────────────
// The graph libraries are loaded from a CDN (see vendor.mjs): React, ReactDOM,
// React Flow (UMD global window.ReactFlow) and dagre. React Flow renders the
// application graph (modeled / planned / deployed / diff) as pixel-exact
// .rad-node cards (styled in pages.mjs); dagre computes the top-to-bottom
// hierarchical layout.
window.__radRoots = window.__radRoots || {}; // containerId → ReactDOM root

// Deploy-status → card colors, applied when radiusRenderGraph runs with
// { deployMode: true } (the live "Deploying" page). Folds what used to be set
// imperatively onto graph nodes into the declarative React Flow renderer.
// Keys/colors mirror the deploying page's former STATUS_COLORS map.
var RADIUS_DEPLOY_STATUS_COLORS = {
    pending:     { bg: '#f6f8fa', border: '#8b949e' },
    in_progress: { bg: '#fff8c5', border: '#d29922' },
    postponed:   { bg: '#fff8c5', border: '#d29922' },
    waiting:     { bg: '#fff8c5', border: '#d29922' },
    success:     { bg: '#dcffe4', border: '#1a7f37' },
    failed:      { bg: '#ffebe9', border: '#cf222e' }
};

function radiusGetIconSvg(type) {
    if (!type) return '';
    var t = type.toLowerCase();
    var svg;
    if (t.includes('container') && !t.includes('image') && !t.includes('registry')) {
        // Container / K8s Deployment
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#326ce5"><path d="M10.204 14.35l.007.01-.999 2.413a5.171 5.171 0 01-2.075-2.597l2.578-.437.489.611zm4.159.613l-.502.504-.467-.467 2.528.46a5.18 5.18 0 01-2.12 2.63l-.95-2.326.511-.801zm-2.246 1.807l.006-.007 1.06 2.594a5.275 5.275 0 01-3.381.015l1.074-2.59.627-.019.614.007zm3.63-5.017l-.564.396-.6-.395 2.68.124a5.18 5.18 0 01-.694 3.304l-1.822-2.028v-1.401zm-7.88-.598l-.598.396 .002 1.396-1.822 2.03a5.18 5.18 0 01-.694-3.305l2.548-.121.564.404v-.8zm4.318-2.834l.6.393-.006 1.393.564.397-2.55.122a5.18 5.18 0 01.694-3.305l.698 1zm-1.64.027l.696-.998a5.18 5.18 0 01.694 3.304l-2.55-.122.564-.396-.005-1.394.601-.394zm-.948-.652l-.627.019-.614-.007.006.007-1.06-2.594a5.275 5.275 0 013.381-.015l-1.074 2.59h-.012zM12 6.042a5.97 5.97 0 015.958 5.958A5.97 5.97 0 0112 17.958 5.97 5.97 0 016.042 12 5.97 5.97 0 0112 6.042M12 4a8 8 0 100 16 8 8 0 000-16z"/></svg>';
    } else if (t.includes('image') || t.includes('registry') || /(^|[^a-z])ecr([^a-z]|$)/.test(t)) {
        // Container Registry (ACR / ECR). 'ecr' matched as a delimited token so
        // it does not match words like "secrets".
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="var(--rad-brand, #da4c2a)"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-6a1 1 0 00-1 1v6.708A2.486 2.486 0 017.5 9h5V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>';
    } else if (t.includes('gateway') || t.includes('applicationgateway')) {
        // Gateway / App Gateway
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8250df"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM2.07 7.5h3.46c.05-1.2.24-2.3.56-3.18.15-.43.34-.8.56-1.1A5.96 5.96 0 002.07 7.5zm4.47 0h2.92c-.05-1.07-.22-2.03-.49-2.78-.27-.75-.6-1.22-.89-1.47-.29.25-.62.72-.89 1.47-.27.75-.44 1.71-.49 2.78H6.54zm2.92 1H6.54c.05 1.07.22 2.03.49 2.78.27.75.6 1.22.89 1.47.29-.25.62-.72.89-1.47.27-.75.44-1.71.49-2.78zm.91 0c-.05 1.2-.24 2.3-.56 3.18-.15.43-.34.8-.56 1.1a5.96 5.96 0 004.58-4.28h-3.46zm3.46-1h-3.46c-.05-1.2-.24-2.3-.56-3.18a3.9 3.9 0 00-.56-1.1 5.96 5.96 0 014.58 4.28zM6.65 3.22c-.22.3-.41.67-.56 1.1-.32.88-.51 1.98-.56 3.18H2.07a5.96 5.96 0 014.58-4.28zm-3.58 5.28h3.46c.05 1.2.24 2.3.56 3.18.15.43.34.8.56 1.1a5.96 5.96 0 01-4.58-4.28z"/></svg>';
    } else if (t.includes('route') || t.includes('ingress') || t.includes('lb') || t.includes('loadbalancer')) {
        // Route / Ingress / Load Balancer
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8250df"><path d="M4 2a2 2 0 100 4 2 2 0 000-4zm-1 2a1 1 0 112 0 1 1 0 01-2 0zm9 6a2 2 0 100 4 2 2 0 000-4zm-1 2a1 1 0 112 0 1 1 0 01-2 0zM6 4h4.5a2.5 2.5 0 010 5H5.5a1.5 1.5 0 000 3H10v-1l2.5 1.5L10 14v-1H5.5a2.5 2.5 0 010-5h5a1.5 1.5 0 000-3H6V4z"/></svg>';
    } else if (t.includes('mysql') || t.includes('dbformysql')) {
        // MySQL
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#00758f"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
    } else if (t.includes('postgres') || t.includes('dbforpostgresql')) {
        // PostgreSQL
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#336791"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
    } else if (t.includes('redis') || t.includes('cache') || t.includes('elasticache') || t.includes('memorydb')) {
        // Redis / Cache — stacked diamond shape
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#d82c20"><path d="M8 2L14 5.5 8 9 2 5.5 8 2z"/><path d="M2 7.5L8 11l6-3.5L8 4 2 7.5z" opacity="0.7"/><path d="M2 10L8 13.5 14 10 8 6.5 2 10z" opacity="0.5"/></svg>';
    } else if (t.includes('sql') || t.includes('rds') || t.includes('db_instance')) {
        // SQL / RDS generic
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#e48400"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
    } else if (t.includes('mongo') || t.includes('cosmos') || t.includes('documentdb') || t.includes('docdb')) {
        // MongoDB / CosmosDB / DocumentDB
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#13aa52"><path d="M8.5 1.2c-.2-.3-.5-.3-.7 0C6.5 3 5 5 5 7.5c0 1.4.7 2.6 1.7 3.3l-.2 3.5c0 .4.3.7.7.7h1.6c.4 0 .7-.3.7-.7l-.2-3.5c1-.7 1.7-1.9 1.7-3.3 0-2.5-1.5-4.5-2.5-6.3zM8 9.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>';
    } else if (t.includes('neo4j')) {
        // Neo4j graph database
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#018bff"><circle cx="5" cy="4" r="2"/><circle cx="11" cy="4" r="2"/><circle cx="8" cy="11" r="2"/><line x1="5" y1="4" x2="11" y2="4" stroke="#018bff" stroke-width="1.2"/><line x1="5" y1="4" x2="8" y2="11" stroke="#018bff" stroke-width="1.2"/><line x1="11" y1="4" x2="8" y2="11" stroke="#018bff" stroke-width="1.2"/></svg>';
    } else if (t.includes('rabbit') || t.includes('amqp') || t.includes('servicebus') || t.includes('sqs')) {
        // Messaging (RabbitMQ / Service Bus / SQS)
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#ff6600"><path d="M14 4H2a1 1 0 00-1 1v6a1 1 0 001 1h12a1 1 0 001-1V5a1 1 0 00-1-1zM5 10H3V6h2v4zm4 0H7V6h2v4zm4 0h-2V6h2v4z"/></svg>';
    } else if (t.includes('secret') || t.includes('keyvault') || t.includes('secretsmanager')) {
        // Secrets / Key Vault / Secrets Manager
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#1a7f37"><path d="M8 1a4 4 0 00-4 4v2H3a1 1 0 00-1 1v6a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1V5a4 4 0 00-4-4zm-3 6V5a3 3 0 116 0v2H5zm3 3a1.5 1.5 0 01.5 2.91V13.5a.5.5 0 01-1 0v-.59A1.5 1.5 0 018 10z"/></svg>';
    } else if (t.includes('volume') || t.includes('persistent') || t.includes('disk') || t.includes('ebs')) {
        // Storage / Volumes / Disks
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8764b8"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v2A1.5 1.5 0 0112.5 7h-9A1.5 1.5 0 012 5.5v-2zm1.5-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 00-.5-.5h-9zM2 9.5A1.5 1.5 0 013.5 8h9A1.5 1.5 0 0114 9.5v2a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-2zm1.5-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 00-.5-.5h-9zM11 4.5a.5.5 0 11-1 0 .5.5 0 011 0zm1 0a.5.5 0 11-1 0 .5.5 0 011 0zm-1 6a.5.5 0 11-1 0 .5.5 0 011 0zm1 0a.5.5 0 11-1 0 .5.5 0 011 0z"/></svg>';
    } else if (t.includes('subnet') || t.includes('security_group') || t.includes('securitygroup') || t.includes('vpc') || t.includes('network')) {
        // Networking / Security Groups / Subnets
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#0078d4"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8z"/><path d="M8 4a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 018 4z"/></svg>';
    } else if (t.includes('service') && !t.includes('servicebus')) {
        // K8s Service
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#326ce5"><path d="M1 8a7 7 0 1114 0A7 7 0 011 8zm7-6a6 6 0 100 12A6 6 0 008 2zm0 2a1 1 0 110 2 1 1 0 010-2zm0 3.5a1 1 0 110 2 1 1 0 010-2zm0 3.5a1 1 0 110 2 1 1 0 010-2z"/></svg>';
    } else if (t.includes('deployment')) {
        // K8s Deployment
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#326ce5"><path d="M8 1l6.5 3.75v7.5L8 16l-6.5-3.75v-7.5L8 1zm0 1.15L2.5 5.25v6.5L8 14.85l5.5-3.1v-6.5L8 2.15z"/><path d="M8 5l3.5 2v3.5L8 12.5 4.5 10.5V7L8 5z"/></svg>';
    } else {
        // Generic/fallback — cloud resource cube
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#6639ba"><path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7L8 1.5zm0 1.2L3.5 5.5v5.4L8 13.3l4.5-2.4V5.5L8 2.7z"/><path d="M8 5.8L5.5 7.2v2.6L8 11.2l2.5-1.4V7.2L8 5.8z"/></svg>';
    }
    // Inject explicit width/height so the SVG rasterizes crisply as an <img>.
    svg = svg.replace('<svg ', '<svg width="64" height="64" ');
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// Maps a resource type to a legend category (and a nominal fill/border/shape
// retained for the type legend). Color encodes the category and matches the
// graph legend. Substring matching mirrors radiusGetIconSvg so icon + category
// always agree.
function radiusGetTypeStyle(type) {
    var t = (type || '').toLowerCase();
    // Compute / workloads
    if ((t.includes('container') && !t.includes('image') && !t.includes('registry'))
        || t.includes('deployment') || (t.includes('service') && !t.includes('servicebus'))) {
        return { bg: '#e8f0fe', border: '#326ce5', shape: 'roundrectangle', category: 'Compute' };
    }
    // Container registry (ACR / ECR). The 'ecr' token is matched only as a
    // delimited segment so it does not trip on words like "secrets" (s-ecr-ets).
    if (t.includes('image') || t.includes('registry') || /(^|[^a-z])ecr([^a-z]|$)/.test(t)) {
        return { bg: '#ddf4ff', border: '#0969da', shape: 'roundrectangle', category: 'Registry' };
    }
    // Cache (Redis / ElastiCache / MemoryDB)
    if (t.includes('redis') || t.includes('cache') || t.includes('elasticache') || t.includes('memorydb')) {
        return { bg: '#fdeceb', border: '#d82c20', shape: 'hexagon', category: 'Cache' };
    }
    // Databases / data stores (relational, document, graph)
    if (t.includes('mysql') || t.includes('dbformysql') || t.includes('postgres') || t.includes('dbforpostgresql')
        || t.includes('sql') || t.includes('rds') || t.includes('db_instance')
        || t.includes('mongo') || t.includes('cosmos') || t.includes('documentdb') || t.includes('docdb')
        || t.includes('neo4j')) {
        return { bg: '#fdf0e3', border: '#e48400', shape: 'barrel', category: 'Data Store' };
    }
    // Secrets / Key Vault / Secrets Manager
    if (t.includes('secret') || t.includes('keyvault') || t.includes('secretsmanager')) {
        return { bg: '#e9f5ee', border: '#1a7f37', shape: 'cut-rectangle', category: 'Secrets' };
    }
    // Networking (gateways, routes, ingress, load balancers, VPC/subnets)
    if (t.includes('gateway') || t.includes('applicationgateway') || t.includes('route') || t.includes('ingress')
        || t.includes('lb') || t.includes('loadbalancer') || t.includes('subnet') || t.includes('security_group')
        || t.includes('securitygroup') || t.includes('vpc') || t.includes('network')) {
        return { bg: '#f2ecfb', border: '#8250df', shape: 'tag', category: 'Networking' };
    }
    // Messaging (RabbitMQ / Service Bus / SQS)
    if (t.includes('rabbit') || t.includes('amqp') || t.includes('servicebus') || t.includes('sqs')) {
        return { bg: '#fff1e6', border: '#ff6600', shape: 'tag', category: 'Messaging' };
    }
    // Storage / volumes / disks
    if (t.includes('volume') || t.includes('persistent') || t.includes('disk') || t.includes('ebs')) {
        return { bg: '#f0ebf9', border: '#8764b8', shape: 'barrel', category: 'Storage' };
    }
    // Fallback / other cloud resource
    return { bg: '#ede9f7', border: '#6639ba', shape: 'roundrectangle', category: 'Other' };
}

// Normalizes an icon supplied by a type/recipe pack into a usable image source
// for the node card <img>. Packs may express an icon as a ready data
// URI, an http(s) URL, or a raw <svg> markup string; anything unrecognized
// returns '' so the caller falls back to the built-in glyph map.
function radiusNormalizeIcon(icon) {
    if (!icon || typeof icon !== 'string') return '';
    var s = icon.trim();
    if (!s) return '';
    if (s.indexOf('data:') === 0 || s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return s;
    if (s.indexOf('<svg') === 0) {
        if (s.indexOf('width=') === -1) s = s.replace('<svg ', '<svg width="64" height="64" ');
        return 'data:image/svg+xml,' + encodeURIComponent(s);
    }
    return '';
}

// Resolves the icon for a resource. The artwork is owned by the resource's
// type/recipe pack, so a pack-supplied icon (r.icon) wins; the built-in
// type->glyph map is only a fallback for types whose pack omits an icon.
function radiusResolveIcon(r) {
    r = r || {};
    var packIcon = radiusNormalizeIcon(r.icon);
    if (packIcon) return packIcon;
    return radiusGetIconSvg(r.type || r.displayType || '');
}

// Formats a resource type into the "Namespace/typeName" label shown under the
// node name, e.g. "Radius.Compute/containers@2023-10-01-preview" becomes
// "Compute/containers". Strips the vendor prefix and API version.
function radiusFormatTypeLabel(type) {
    if (!type) return '';
    var t = String(type).split('@')[0];
    var slash = t.indexOf('/');
    if (slash === -1) return t;
    var ns = t.substring(0, slash);
    var name = t.substring(slash + 1);
    var dot = ns.lastIndexOf('.');
    if (dot !== -1) ns = ns.substring(dot + 1);
    return ns + '/' + name;
}

function radiusRenderGraph(containerId, resources, options) {
    options = options || {};
    var container = document.getElementById(containerId);
    if (!container) return null;

    // The graph libraries are loaded from a CDN (see vendor.mjs): React,
    // ReactDOM and React Flow. If that fetch failed (offline / blocked network)
    // any of these globals is undefined — surface a recoverable message instead
    // of throwing and breaking the whole panel.
    var RF = window.ReactFlow;
    if (!window.React || !window.ReactDOM || !RF) {
        container.innerHTML = '<div style="padding:16px;color:#cf222e;font-size:13px;">Graph library failed to load (network unavailable). Reopen the panel once connectivity is restored to render the graph.</div>';
        return null;
    }
    var React = window.React;
    var ReactDOM = window.ReactDOM;
    var h = React.createElement;
    var ReactFlowComp = RF.default;
    var Background = RF.Background, Controls = RF.Controls;
    var Handle = RF.Handle, Position = RF.Position;
    var useNodesState = RF.useNodesState, useEdgesState = RF.useEdgesState;

    // Tear down a previous React root mounted on this container. radiusRenderGraph
    // can run more than once against the same container (repo switch on the
    // deployed page, SPA navigation between graph sub-pages).
    if (window.__radRoots[containerId]) {
        try { window.__radRoots[containerId].unmount(); } catch (e) {}
        delete window.__radRoots[containerId];
    }
    // Clear any DOM we created on a prior render (the React host + popup) so a
    // re-render on the same container never stacks duplicate hosts/popups.
    var priorHosts = container.querySelectorAll('.rad-flow-host, #node-popup');
    for (var ph = 0; ph < priorHosts.length; ph++) priorHosts[ph].parentNode.removeChild(priorHosts[ph]);
    // React Flow's absolutely-positioned host anchors to the container, so the
    // container must establish a positioning context (all graph pages set this
    // via CSS, but be defensive for any caller that doesn't).
    if (container.currentStyle || window.getComputedStyle) {
        var pos = window.getComputedStyle(container).position;
        if (!pos || pos === 'static') container.style.position = 'relative';
    }

    // Remove any legend(s) left over from a previous render so re-rendering the
    // same container (e.g. switching repos on the deployed page) doesn't stack
    // multiple legends.
    if (container.parentNode) {
        var oldLegends = container.parentNode.querySelectorAll('.legend');
        for (var ol = 0; ol < oldLegends.length; ol++) oldLegends[ol].parentNode.removeChild(oldLegends[ol]);
    }

    var diffMode = options.diffMode || false;
    var deployMode = options.deployMode || false;
    var repoUrl = options.repoUrl || '';
    var branch = options.branch || 'main';
    // In diff mode a "removed" resource's source file lived on the base
    // branch (it may no longer exist on head at all), so its source link
    // must point at baseBranch while everything else (added/modified/
    // unchanged) points at the page's normal branch (head).
    var diffBaseBranch = options.baseBranch || branch;
    var localSource = !!options.localSource;
    var escLocal = function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };

    // Map an (optional) line-type hint to a React Flow edge type. Bezier
    // ("default") is the figma default; a few elbow-ish aliases map to smoothstep.
    function radiusMapLineType(lt) {
        switch (String(lt || '').toLowerCase()) {
            case 'straight': return 'straight';
            case 'step': return 'step';
            case 'smoothstep':
            case 'taxi':
            case 'segments': return 'smoothstep';
            default: return 'default';
        }
    }
    var edgeType = radiusMapLineType(options.lineType || options.curveStyle);

    if (!resources || resources.length === 0) {
        container.innerHTML = '';
        // A minimal controller so callers can still repopulate later.
        return { update: function(nr) { if (nr && nr.length) radiusRenderGraph(containerId, nr, options); }, destroy: function() {} };
    }

    container.innerHTML = '';
    container.style.position = 'relative';
    container.style.display = 'block';
    container.style.minHeight = '450px';

    // Build the "View source code" URL for a node. When a precise code reference
    // was discovered, deep-link straight to that file (and line). Otherwise fall
    // back to the repo tree at the current branch so the link always resolves to
    // a real page instead of a dead affordance. Empty only when there is no repo
    // context at all.
    //
    // NOTE on the backslash regex below: this file is a template literal, so the
    // engine halves escapes before the browser ever sees this code. The /\\\\/g
    // written here becomes /\\/g at runtime, i.e. a regex that matches a SINGLE
    // backslash — exactly what a Windows-generated codeReference contains. Do NOT
    // "simplify" it to /\\/g in the source: that would emit the invalid regex
    // /\/g in the browser. (The client_test behavioral test locks this in.)
    function buildSourceUrl(codeRef, branchOverride) {
        if (!repoUrl) return '';
        var br = branchOverride || branch;
        if (codeRef) {
            var path = codeRef.split('#')[0].replace(/\\\\/g, '/');
            if (path.charAt(0) === '/') path = path.slice(1);
            var frag = codeRef.indexOf('#L') !== -1 ? '#L' + codeRef.split('#L')[1] : '';
            return repoUrl + '/blob/' + br + '/' + path + frag;
        }
        return repoUrl + '/tree/' + br;
    }

    // Split a codeReference ("path#L31") into its repo-relative path and line.
    // Used when localSource is set to open the on-disk file in the editor canvas.
    // Backslashes are normalized so a Windows-generated codeReference is
    // consistent in the DOM, in transport, and with the POSIX server contract.
    // (See buildSourceUrl above for why the source keeps /\\\\/g, not /\\/g.)
    function srcPathFromRef(codeRef) {
        if (!codeRef) return '';
        var p = codeRef.split('#')[0].replace(/\\\\/g, '/');
        if (p.charAt(0) === '/') p = p.slice(1);
        return p;
    }
    function srcLineFromRef(codeRef) {
        if (!codeRef || codeRef.indexOf('#L') === -1) return 0;
        return parseInt(codeRef.split('#L')[1], 10) || 0;
    }

    // Open an external URL (a GitHub blob/tree link) the way clicking a native
    // target="_blank" anchor would, which the host opens in the system browser.
    // Used as the fallback whenever a local open is not possible.
    function radiusOpenExternal(url) {
        if (!url) return;
        try {
            var a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        } catch (e) {
            try { window.open(url, '_blank', 'noopener'); } catch (e2) { /* best-effort */ }
        }
    }

    // Open a repo-relative worktree file in the Copilot editor canvas (side pane).
    // The webview has no SDK session handle, so it asks the local canvas server
    // (POST /api/open-source), which calls canvas.open({canvasId:"editor",
    // scope:"repo", path}). Used for local-workspace graphs (localSource): the
    // graphed files are the on-disk checkout, so this opens exactly what was
    // graphed — including uncommitted edits — instead of a GitHub blob URL that
    // would 404 on an unpushed branch. It is a same-origin fetch (the page is
    // served by this same server), so unlike window.open / cross-origin
    // navigation it is not blocked in the embedded webview.
    //
    // localSource is a coarse, page-level flag (repo + branch match the
    // workspace), so it can be true for a node whose file is NOT actually on this
    // checkout. In that case the server returns a non-2xx (NOT_ON_WORKTREE) and we
    // fall back to opening the file's GitHub URL, so the link is never a dead end
    // and a remote graph always resolves to a real https://github.com/... page.
    function radiusOpenLocalSource(relPath, line, fallbackUrl) {
        if (!relPath) { radiusOpenExternal(fallbackUrl); return; }
        try {
            fetch('/api/open-source', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: relPath, line: line || 0 })
            }).then(function(r) {
                if (!r || !r.ok) radiusOpenExternal(fallbackUrl);
            }).catch(function() { radiusOpenExternal(fallbackUrl); });
        } catch (e) { radiusOpenExternal(fallbackUrl); }
    }

    function getNodeColors(r) {
        // Diff mode keeps the same white card surface as the Modeled/Planned
        // graphs — only the border color encodes the diff status, so the
        // resource card itself is visually identical everywhere else.
        if (diffMode && r.diffStatus) {
            switch (r.diffStatus) {
                case 'added': return { bg: '#ffffff', border: '#16a34a' };
                case 'removed': return { bg: '#ffffff', border: '#dc2626' };
                case 'modified': return { bg: '#ffffff', border: '#ca8a04' };
                default: return { bg: '#ffffff', border: '#d0d7de' };
            }
        }
        // Live deployment status colors (the "Deploying" page passes deployMode).
        if (deployMode) {
            var sc = RADIUS_DEPLOY_STATUS_COLORS[r.deployStatus || 'pending'] || RADIUS_DEPLOY_STATUS_COLORS.pending;
            return { bg: sc.bg, border: sc.border };
        }
        // Non-diff nodes use the clean "modeled graph" card style: a white
        // surface with a thin neutral border. Category is conveyed by the icon
        // (owned by the type/recipe pack), not by node fill/shape.
        return { bg: '#ffffff', border: '#d0d7de' };
    }

    // The figma .rad-node card is rendered natively by the RadNode React
    // component below (real elements + real onClick), so there is no HTML-string
    // card template here. React auto-escapes text children, so no manual escaper
    // is needed either.

    // ── Build React Flow nodes + edges from the resource list ────────────────
    // Pure builder: returns fresh arrays plus a data-by-id map (used by the
    // click-to-open popup delegation). Called once up front and again on every
    // controller.update() so the live "Deploying" graph can recolor in place.
    function buildGraph(resList) {
        var nodes = [];
        var edges = [];
        var dataById = {};
        var edgeSeen = {};

        function pushEdge(source, target, dashed, connStatus) {
            var id = source + '-->' + target;
            if (edgeSeen[id]) return;
            edgeSeen[id] = true;
            var stroke = dashed ? '#57606a' : '#8c959f';
            // Diff mode colors the edge by whether the CONNECTION itself changed
            // between base and head (computeGraphDiff tags each rendered
            // connection): added=green, removed=red, unchanged=neutral gray. A
            // removed edge between two still-present nodes is carried as a
            // synthetic removed connection, so it is drawn here too. Only edges
            // with no connection-level status (e.g. output-resource edges) fall
            // back to the endpoints' own diff statuses.
            if (diffMode) {
                var cs = connStatus || '';
                if (cs === 'removed') stroke = '#dc2626';
                else if (cs === 'added') stroke = '#16a34a';
                else if (cs === 'unchanged') stroke = '#8c959f';
                else {
                    var sStatus = diffStatusById[source] || '';
                    var tStatus = diffStatusById[target] || '';
                    if (sStatus === 'removed' || tStatus === 'removed') stroke = '#dc2626';
                    else if (sStatus === 'added' || tStatus === 'added') stroke = '#16a34a';
                    else stroke = '#8c959f';
                }
            }
            var style = { stroke: stroke, strokeWidth: 1.5 };
            if (dashed) style.strokeDasharray = '6 4';
            edges.push({
                id: id,
                source: source,
                target: target,
                type: edgeType,
                style: style
            });
        }
        function pushNode(id, data) {
            data.id = id;
            dataById[id] = data;
            nodes.push({ id: id, type: 'rad', data: data, position: { x: 0, y: 0 }, draggable: true });
        }

        // Map a concrete outputResource id → the top-level resource that "owns"
        // it (its name matches the output's name). Used to skip rendering that
        // same concrete resource as a duplicate output child under OTHER
        // resources, which otherwise produces two nodes for one secret.
        var ownedOutputIds = {};
        // Diff mode looks up each edge endpoint's diffStatus by id/name to
        // decide the edge color (see pushEdge above).
        var diffStatusById = {};
        for (var oi = 0; oi < resList.length; oi++) {
            var orr = resList[oi];
            var oid = orr.id || orr.name;
            diffStatusById[oid] = orr.diffStatus || '';
            var oouts = orr.outputResources || [];
            for (var oj = 0; oj < oouts.length; oj++) {
                if (oouts[oj] && oouts[oj].id && oouts[oj].name === orr.name) {
                    ownedOutputIds[oouts[oj].id] = oid;
                }
            }
        }

        for (var i = 0; i < resList.length; i++) {
            var r = resList[i];
            var colors = getNodeColors(r);
            var shortType = radiusFormatTypeLabel(r.type);
            // Collect any cloud (ARM) output resources so the node popup can link
            // to the live resource in the Azure portal.
            var cloudOutputs = [];
            if (r.outputResources) {
                for (var ci = 0; ci < r.outputResources.length; ci++) {
                    var co = r.outputResources[ci];
                    if (co.id && co.id.indexOf('/subscriptions/') === 0) {
                        cloudOutputs.push({ name: co.name || '', type: co.type || '', id: co.id });
                    }
                }
            }
            var srcBranch = (diffMode && r.diffStatus === 'removed') ? diffBaseBranch : branch;
            pushNode(r.id || r.name, {
                borderColor: colors.border,
                borderWidth: diffMode ? 2 : (deployMode ? 3 : 1),
                bgColor: colors.bg,
                icon: radiusResolveIcon(r),
                nodeName: r.name,
                typeLabel: shortType,
                codeRef: r.codeReference || '',
                sourceUrl: buildSourceUrl(r.codeReference || '', srcBranch),
                sourceBranch: srcBranch,
                srcPath: srcPathFromRef(r.codeReference || ''),
                srcLine: srcLineFromRef(r.codeReference || ''),
                defFile: r.definitionFile || '.radius/app.bicep',
                defLine: r.definitionLine || 0,
                resourceType: r.type || '',
                diffStatus: r.diffStatus || '',
                deployStatus: r.deployStatus || '',
                portalUrl: r.portalUrl || '',
                cloudResources: JSON.stringify(cloudOutputs)
            });
            if (r.connections) {
                for (var j = 0; j < r.connections.length; j++) {
                    var conn = r.connections[j];
                    var dir = conn.direction || 'Outbound';
                    if (dir === 'Outbound') {
                        var connTarget = conn.id || conn.name;
                        var targetExists = resList.some(function(x) { return (x.id || x.name) === connTarget; });
                        if (targetExists) pushEdge(r.id || r.name, connTarget, false, conn.diffStatus || '');
                    }
                }
            }
            // Render output resources (concrete cloud types from recipes)
            if (r.outputResources && r.outputResources.length > 0) {
                for (var k = 0; k < r.outputResources.length; k++) {
                    var out = r.outputResources[k];
                    // Skip a concrete resource another top-level resource owns.
                    if (out.id && ownedOutputIds[out.id] && ownedOutputIds[out.id] !== (r.id || r.name)) {
                        continue;
                    }
                    var outId = (r.id || r.name) + '/output/' + k + '/' + out.name;
                    var outLabel = out.displayType || out.type || out.name;
                    // Output nodes stay neutral grey unless a live deploy status
                    // is available (deployMode), in which case they take the same
                    // status colors as their parent.
                    var outColors = (deployMode && out.deployStatus) ? getNodeColors(out) : { bg: '#f6f8fa', border: '#8c959f' };
                    pushNode(outId, {
                        borderColor: outColors.border,
                        borderWidth: (deployMode && out.deployStatus) ? 2 : 1,
                        bgColor: outColors.bg,
                        icon: radiusResolveIcon(out),
                        nodeName: out.name || outLabel,
                        typeLabel: outLabel,
                        codeRef: '',
                        sourceUrl: '',
                        srcPath: '',
                        srcLine: 0,
                        defFile: '',
                        defLine: 0,
                        resourceType: out.type || '',
                        diffStatus: '',
                        deployStatus: out.deployStatus || '',
                        portalUrl: out.portalUrl || '',
                        cloudId: (out.id && out.id.indexOf('/subscriptions/') === 0) ? out.id : '',
                        cloudResources: '[]'
                    });
                    pushEdge(r.id || r.name, outId, true);
                }
            }
        }
        return { nodes: nodes, edges: edges, dataById: dataById };
    }

    // ── Hierarchical layout via dagre (top-to-bottom) ────────────────────────
    // React Flow renders the nodes/edges; dagre only computes node positions.
    // Node size is fixed to the .rad-node card footprint so layout is stable
    // before the DOM is measured.
    var NODE_W = 220, NODE_H = 118;
    function layout(nodes, edges) {
        if (typeof dagre === 'undefined' || !dagre.graphlib) {
            for (var s = 0; s < nodes.length; s++) nodes[s].position = { x: 0, y: s * (NODE_H + 48) };
            return;
        }
        try {
            var g = new dagre.graphlib.Graph();
            g.setGraph({ rankdir: 'TB', nodesep: 55, ranksep: 80, marginx: 24, marginy: 24, ranker: 'network-simplex' });
            g.setDefaultEdgeLabel(function() { return {}; });
            for (var n = 0; n < nodes.length; n++) g.setNode(nodes[n].id, { width: NODE_W, height: NODE_H });
            for (var e = 0; e < edges.length; e++) {
                if (g.hasNode(edges[e].source) && g.hasNode(edges[e].target)) g.setEdge(edges[e].source, edges[e].target);
            }
            dagre.layout(g);
            for (var m = 0; m < nodes.length; m++) {
                var gn = g.node(nodes[m].id);
                if (gn) nodes[m].position = { x: gn.x - NODE_W / 2, y: gn.y - NODE_H / 2 };
            }
        } catch (err) {
            for (var f = 0; f < nodes.length; f++) if (!nodes[f].position) nodes[f].position = { x: 0, y: f * (NODE_H + 48) };
        }
    }

    var built = buildGraph(resources);
    layout(built.nodes, built.edges);

    // Shared details-popup controller. The popup itself is wired up imperatively
    // as a sibling overlay further below (only when enablePopup is not false); the
    // React node calls popupCtl.open() so a card click shows it. Stays a no-op
    // until that setup runs, and when popups are disabled.
    var popupCtl = { open: function() {}, close: function() {} };

    // ── Custom node: the figma .rad-node card, rendered natively ─────────────
    // Real React elements (not an HTML-string overlay) so the "View source code"
    // link and the "..." details button are genuinely clickable. Interactive
    // children carry React Flow's nodrag/nopan classes so the pane's drag layer
    // never swallows their clicks — the flakiness that forced the previous canvas
    // build to bolt a node-html-label DOM overlay onto its graph nodes.
    function RadNode(props) {
        var d = props.data;
        var iconEl = d.icon ? h('img', { className: 'rad-node__icon', src: d.icon, alt: '' }) : null;
        var glyph = h('span', { className: 'rad-node__source-glyph' }, '</' + '>');
        var label = h('span', null, 'View source code');
        var srcRow;
        // "View source code" behavior depends on where the graph was resolved from:
        //   • local-workspace graph (localSource) with a code reference → open the
        //     on-disk worktree file in the Copilot editor canvas (side pane) via the
        //     local server. The node's GitHub blob URL rides along as the href /
        //     fallback: if the file isn't actually on this checkout the server
        //     returns non-2xx and the click falls back to opening GitHub, so a graph
        //     whose coarse localSource flag was wrong still resolves to a real page.
        //   • remote-branch graph → native GitHub anchor (target="_blank"), which the
        //     host opens in the system browser.
        // Only stopPropagation, so the card's own click (opening the details popup)
        // doesn't also fire. Local graphs with no reference for this node show a
        // disabled row.
        if (localSource && d.srcPath) {
            srcRow = h('a', {
                className: 'rad-node__source nodrag nopan', href: d.sourceUrl || '#',
                onClick: function(e) { e.preventDefault(); e.stopPropagation(); radiusOpenLocalSource(d.srcPath, d.srcLine, d.sourceUrl); }
            }, glyph, label);
        } else if (localSource) {
            srcRow = h('span', {
                className: 'rad-node__source', role: 'button', 'aria-disabled': 'true',
                title: 'No source reference found', style: { opacity: 0.5, cursor: 'default' }
            }, glyph, label);
        } else if (d.sourceUrl) {
            srcRow = h('a', {
                className: 'rad-node__source nodrag nopan', href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer',
                onClick: function(e) { e.stopPropagation(); }
            }, glyph, label);
        } else {
            srcRow = h('span', { className: 'rad-node__source', role: 'button' }, glyph, label);
        }
        var dots = h('button', {
            type: 'button', className: 'rad-node__dots nodrag nopan', 'aria-label': 'Show details',
            onClick: function(e) { e.preventDefault(); e.stopPropagation(); popupCtl.open(d, e.currentTarget.closest('.rad-node')); }
        }, '\u2022\u2022\u2022');
        var card = h('div', {
            className: 'rad-node', 'data-node-id': d.id,
            style: { boxSizing: 'border-box', background: d.bgColor || '#ffffff', borderStyle: 'solid', borderWidth: (d.borderWidth || 1) + 'px', borderColor: d.borderColor || '#d0d7de' },
            onClick: function(e) { popupCtl.open(d, e.currentTarget); }
        },
            dots,
            h('div', { className: 'rad-node__head' }, iconEl, h('span', { className: 'rad-node__title' }, d.nodeName)),
            h('div', { className: 'rad-node__type' }, d.typeLabel),
            srcRow
        );
        return h('div', { className: 'rad-node-shell' },
            h(Handle, { type: 'target', position: Position.Top, isConnectable: false, className: 'rad-handle' }),
            card,
            h(Handle, { type: 'source', position: Position.Bottom, isConnectable: false, className: 'rad-handle' })
        );
    }
    var nodeTypes = { rad: RadNode };

    // updater.fn is bound by the mounted App (via useEffect) so controller.update
    // can push new nodes/edges into React state and preserve the current viewport.
    var updater = { fn: null };
    function bindUpdater(fn) { updater.fn = fn; }

    function RadGraphApp(props) {
        var ns = useNodesState(props.initialNodes);
        var nodes = ns[0], setNodes = ns[1], onNodesChange = ns[2];
        var es = useEdgesState(props.initialEdges);
        var edges = es[0], setEdges = es[1], onEdgesChange = es[2];
        var instRef = React.useRef(null);

        React.useEffect(function() {
            bindUpdater(function(newNodes, newEdges) {
                setNodes(newNodes);
                setEdges(newEdges);
                var inst = instRef.current;
                if (inst) setTimeout(function() { try { inst.fitView({ padding: 0.18, duration: 200 }); } catch (e) {} }, 40);
            });
            return function() { bindUpdater(null); };
        }, []);

        return h(ReactFlowComp, {
            nodes: nodes,
            edges: edges,
            onNodesChange: onNodesChange,
            onEdgesChange: onEdgesChange,
            nodeTypes: nodeTypes,
            fitView: true,
            fitViewOptions: { padding: 0.18 },
            minZoom: 0.2,
            maxZoom: 2,
            nodesDraggable: true,
            nodesConnectable: false,
            elementsSelectable: true,
            proOptions: { hideAttribution: true },
            onInit: function(inst) {
                instRef.current = inst;
                setTimeout(function() { try { inst.fitView({ padding: 0.18 }); } catch (e) {} }, 30);
            }
        },
            h(Background, { gap: 16, size: 1, color: '#e1e4e8' }),
            h(Controls, { showInteractive: false })
        );
    }

    // Mount React into a child host so the popup/legend (siblings of the
    // container) are never clobbered by React's DOM reconciliation.
    var flowHost = document.createElement('div');
    flowHost.className = 'rad-flow-host';
    flowHost.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
    container.appendChild(flowHost);

    var root = ReactDOM.createRoot(flowHost);
    window.__radRoots[containerId] = root;
    root.render(h(RadGraphApp, { initialNodes: built.nodes, initialEdges: built.edges }));

    // Node click popup
    if (options.enablePopup !== false) {
        var popup = document.createElement('div');
        popup.id = 'node-popup';
        popup.style.cssText = 'display:none; position:absolute; z-index:1000; background:var(--rad-surface,#ffffff); border:1px solid var(--rad-stroke,#d0d7de); border-radius:8px; padding:6px 8px; box-shadow:0 4px 12px rgba(0,0,0,0.15); font-size:13px; min-width:220px; max-width:380px; font-family:var(--rad-font);';
        container.appendChild(popup);

        // Monochrome octicon glyphs (currentColor) so links match the flat
        // white-card node styling instead of the old colored emoji.
        var ICON_DEF = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex:none;"><path d="M2 4a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4Zm0 4a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm.75 3.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z"></path></svg>';
        var ICON_LINK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex:none;"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path></svg>';
        var ICON_SRC = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex:none;"><path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"></path></svg>';

        // Build + show the links popup for a node's data, positioned next to its
        // on-screen card. Reached from the container click delegation below.
        function openNodePopup(d, cardEl) {
            if (!d) return;
            var links = [];
            // A link row: monochrome glyph + blue label, with the target URL shown
            // as a muted subtitle beneath (matches the node popup mock).
            var linkRow = function(iconSvg, label, href, showUrl) {
                var sub = showUrl ? '<div style="color:var(--rad-text-tertiary,#656d76); font-size:11px; margin-top:2px; margin-left:20px; word-break:break-all;">' + escLocal(href) + '</div>' : '';
                return '<div style="padding:6px 4px;">' +
                    '<a href="' + escLocal(href) + '" target="_blank" rel="noopener noreferrer" style="color:var(--rad-link,#0969da); text-decoration:none; font-weight:500; display:flex; align-items:center; gap:6px; font-size:13px;">' +
                    iconSvg + '<span>' + label + '</span></a>' + sub + '</div>';
            };
            // A local link row: same look as linkRow, but opens an on-disk worktree
            // file in the editor canvas instead of navigating. The repo-relative
            // path/line and a GitHub fallback URL ride on data attributes; the
            // container click delegation reads them and calls radiusOpenLocalSource
            // (which falls back to the GitHub URL when the file is not on this
            // checkout). The fallback URL is also the anchor href so the row is a
            // real link (copyable / right-clickable). A muted "path:line" subtitle
            // mirrors linkRow's URL subtitle.
            var localLinkRow = function(iconSvg, label, relPath, line, fallbackUrl) {
                var subText = escLocal(relPath) + (line ? ':' + line : '');
                var sub = '<div style="color:var(--rad-text-tertiary,#656d76); font-size:11px; margin-top:2px; margin-left:20px; word-break:break-all;">' + subText + '</div>';
                return '<div style="padding:6px 4px;">' +
                    '<a href="' + escLocal(fallbackUrl || '#') + '" data-local-src="' + escLocal(relPath) + '" data-local-line="' + (line || 0) + '" data-fallback-url="' + escLocal(fallbackUrl || '') + '" style="color:var(--rad-link,#0969da); text-decoration:none; font-weight:500; display:flex; align-items:center; gap:6px; font-size:13px;">' +
                    iconSvg + '<span>' + label + '</span></a>' + sub + '</div>';
            };
            // Source + app-definition links. For a local-workspace graph
            // (localSource) they open the on-disk worktree file in the editor canvas
            // (side pane), with the file's GitHub URL as a fallback if it is not on
            // this checkout; for a remote-branch graph they are native GitHub
            // anchors. The source row shows only when a real code reference exists;
            // the app definition (.radius/app.bicep) shows whenever it is known.
            if (localSource) {
                if (d.srcPath) links.push(localLinkRow(ICON_SRC, 'View source code', d.srcPath, d.srcLine, d.sourceUrl));
                if (d.defFile) {
                    var defUrlLocal = repoUrl ? (repoUrl + '/blob/' + (d.sourceBranch || branch) + '/' + d.defFile + (d.defLine ? '#L' + d.defLine : '')) : '';
                    links.push(localLinkRow(ICON_DEF, 'View app definition', d.defFile, d.defLine, defUrlLocal));
                }
            } else {
                if (d.sourceUrl) {
                    links.push(linkRow(ICON_SRC, 'View source code', d.sourceUrl, true));
                }
                if (repoUrl && d.defFile) {
                    var defUrl = repoUrl + '/blob/' + (d.sourceBranch || branch) + '/' + d.defFile + (d.defLine ? '#L' + d.defLine : '');
                    links.push(linkRow(ICON_DEF, 'View app definition', defUrl, true));
                }
            }
            // Live portal link surfaced during deployment (Azure portal / AWS console).
            if (d.portalUrl) {
                links.push(linkRow(ICON_LINK, 'View in portal', d.portalUrl, false));
            }
            // Azure portal links for live cloud resources (from the deployed graph).
            function azurePortalUrl(armId) { return 'https://portal.azure.com/#@/resource' + armId + '/overview'; }
            if (d.cloudId) {
                links.push(linkRow(ICON_LINK, 'View in Azure portal', azurePortalUrl(d.cloudId), false));
            }
            if (d.cloudResources) {
                try {
                    var cloudList = JSON.parse(d.cloudResources);
                    for (var ci = 0; ci < cloudList.length; ci++) {
                        var cr = cloudList[ci];
                        var crLabel = cr.name || (cr.type ? cr.type.split('/').pop() : 'resource');
                        links.push(linkRow(ICON_LINK, escLocal(crLabel) + ' in Azure portal', azurePortalUrl(cr.id), false));
                    }
                } catch (err) { /* ignore */ }
            }
            if (!links.length) {
                links.push('<div style="padding:6px 4px; color:var(--rad-text-tertiary,#656d76); font-size:12px;">No links available.</div>');
            }
            popup.innerHTML = links.join('');
            // Position next to the card using its on-screen rect, relative to the
            // (position:relative) container, from each card's bounding box.
            var crect = container.getBoundingClientRect();
            var nrect = cardEl.getBoundingClientRect();
            var left = nrect.right - crect.left + 8;
            var top = nrect.top - crect.top;
            if (left + 240 > crect.width) left = Math.max(4, nrect.left - crect.left - 232);
            popup.style.left = Math.max(0, left) + 'px';
            popup.style.top = Math.max(0, top) + 'px';
            popup.style.display = '';
        }

        // Delegate clicks from the HTML node cards. The card body opens the popup;
        // the in-card "View source code" anchor and the popup's own links are native
        // anchors that handle their own clicks (they stopPropagation), so they're not
        // handled here. Clicking the empty pane hides the popup.
        //
        // radiusRenderGraph can run more than once against the same container.
        // Removing the previously-stored handler before adding the current one
        // keeps exactly ONE listener that always closes over the latest state.
        if (container._radiusClickHandler) {
            container.removeEventListener('click', container._radiusClickHandler);
        }
        container._radiusClickHandler = function(e) {
            // A "View source code" / "View app definition" row for a local-workspace
            // graph carries data-local-src: open that on-disk file in the editor
            // canvas instead of navigating. Checked before the popup early-return
            // below because these rows live inside the popup.
            var localEl = e.target.closest && e.target.closest('[data-local-src]');
            if (localEl) {
                e.preventDefault();
                radiusOpenLocalSource(
                    localEl.getAttribute('data-local-src'),
                    parseInt(localEl.getAttribute('data-local-line'), 10) || 0,
                    localEl.getAttribute('data-fallback-url') || ''
                );
                return;
            }
            // Clicks inside the popup, or on a node card, are handled by their own
            // React/imperative handlers (card onClick opens the popup, links
            // navigate themselves). Any other click on empty canvas closes it.
            if (e.target.closest && e.target.closest('#node-popup')) return;
            if (e.target.closest && e.target.closest('.rad-node[data-node-id]')) return;
            popup.style.display = 'none';
        };
        container.addEventListener('click', container._radiusClickHandler);
        popupCtl.open = openNodePopup;
        popupCtl.close = function() { popup.style.display = 'none'; };
    }

    // Diff mode intentionally shows NO legend — the graph must look
    // identical to the Planned graph aside from node border / edge colors.
    if (options.showLegend && !diffMode) {
        // Build a resource-type legend from the categories actually present in
        // the graph. Nodes render as uniform white cards, so category is conveyed
        // by the icon (owned by the type/recipe pack); the legend shows that same
        // icon next to the category name. Order is first-seen so it only lists
        // what's on screen.
        var seen = {};
        var cats = [];
        function noteCategory(r) {
            var type = (r && (r.type || r.displayType)) || '';
            var st = radiusGetTypeStyle(type);
            if (!st.category || seen[st.category]) return;
            seen[st.category] = true;
            cats.push({ name: st.category, icon: radiusResolveIcon(r) });
        }
        for (var li = 0; li < resources.length; li++) {
            noteCategory(resources[li]);
            var oR = resources[li].outputResources || [];
            for (var lo = 0; lo < oR.length; lo++) noteCategory(oR[lo]);
        }
        if (cats.length > 0) {
            var legend2 = document.createElement('div');
            legend2.className = 'legend';
            var html = '';
            for (var lc = 0; lc < cats.length; lc++) {
                html += '<div class="legend-item"><img src="' + escLocal(cats[lc].icon) + '" width="14" height="14" style="vertical-align:middle;" alt="" />' + escLocal(cats[lc].name) + '</div>';
            }
            legend2.innerHTML = html;
            container.parentNode.insertBefore(legend2, container);
        }
    }

    // Controller returned to callers. update() rebuilds + re-lays out the graph
    // and pushes it into React state (preserving the viewport); destroy() unmounts.
    var controller = {
        update: function(newResources) {
            if (!newResources) return;
            var b = buildGraph(newResources);
            layout(b.nodes, b.edges);
            if (updater.fn) updater.fn(b.nodes, b.edges);
        },
        destroy: function() {
            updater.fn = null;
            try { root.unmount(); } catch (e) {}
            if (window.__radRoots[containerId] === root) delete window.__radRoots[containerId];
        }
    };
    return controller;
}

function radiusSetGraphLoading(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div style="padding:20px; max-width:500px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--text-color-default, #1f2328);">Generating Application Graph</span>' +
        '</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--text-color-muted, #656d76); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--border-color-default,#d0d7de);border-top-color:var(--rad-brand, #da4c2a);border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid var(--rad-brand, #da4c2a);box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--text-color-default,#1f2328);font-weight:500}</style>';
}

function radiusSetGraphError(containerId, message) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div class="status error">' + message + '</div>';
}

// SPA-style navigation for graph sub-pages (no full page reload)
function radiusNavTo(e, pageId) {
    e.preventDefault();
    var contentEl = document.getElementById('graph-page-content');
    if (!contentEl) { window.location.href = '?page=' + pageId; return; }
    // Fetch the new page HTML
    fetch('/?page=' + pageId)
        .then(function(r) { return r.text(); })
        .then(function(html) {
            // Extract just the graph-page-content div's innerHTML
            var parser = new DOMParser();
            var doc = parser.parseFromString(html, 'text/html');
            var newContent = doc.getElementById('graph-page-content');
            var newNav = doc.getElementById('graph-nav');
            if (newContent) {
                contentEl.innerHTML = newContent.innerHTML;
                // Execute scripts in the new content
                var scripts = contentEl.querySelectorAll('script');
                scripts.forEach(function(oldScript) {
                    var newScript = document.createElement('script');
                    if (oldScript.src) {
                        newScript.src = oldScript.src;
                    } else {
                        newScript.textContent = oldScript.textContent;
                    }
                    oldScript.parentNode.replaceChild(newScript, oldScript);
                });
            }
            // Update nav active state
            if (newNav) {
                document.getElementById('graph-nav').innerHTML = newNav.innerHTML;
            }
            // Update URL without reload
            history.pushState(null, '', '?page=' + pageId);
        })
        .catch(function() { window.location.href = '?page=' + pageId; });
}
// Handle back/forward browser buttons
window.addEventListener('popstate', function() {
    var params = new URLSearchParams(window.location.search);
    var page = params.get('page') || 'graph';
    if (['graph', 'planned', 'graph-diff', 'deployed'].indexOf(page) !== -1) {
        radiusNavTo({preventDefault: function(){}}, page);
    }
});
`;

export const CLIENT_HEARTBEAT_JS = `
// ─── Client Heartbeat / Auto-reconnect ───────────────────────────────────────
// Each canvas instance is backed by a local HTTP server that may be suspended or
// killed after the extension goes idle. Ping it periodically; if it stops
// responding, show a reconnecting overlay and, once the server is back (it now
// rebinds the same stable port), reload once to restore a live page.
(function() {
  var overlay = document.getElementById('radius-reconnect-overlay');
  var down = false;
  var misses = 0;
  function ping() {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, 4000) : null;
    fetch('/api/ping', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function(r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('bad status');
        if (down) {
          // Server is back after an outage — reload to get fresh state.
          window.location.reload();
          return;
        }
        misses = 0;
      })
      .catch(function() {
        if (timer) clearTimeout(timer);
        misses++;
        // Require two consecutive misses before declaring an outage to avoid
        // flapping on a single slow/dropped request.
        if (misses >= 2 && !down) {
          down = true;
          if (overlay) overlay.style.display = 'flex';
        }
      });
  }
  setInterval(ping, 5000);
  // Also probe immediately when the tab/panel regains focus after idle.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') ping();
  });
  window.addEventListener('focus', ping);
})();
`;
