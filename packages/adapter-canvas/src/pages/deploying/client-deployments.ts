// Canvas adapter — inline browser script for the deployments page: the deploy
// form, the deployment table, delete confirmation, failure reporting, and
// resume of a redirected in-flight deployment.

export const DEPLOYING_CLIENT_JS = `function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}

var deployBtn = document.getElementById('deploy-now-btn');
var appSelect = document.getElementById('deploy-app-select');
var envSelect = document.getElementById('deploy-env-select');
var branchSelect = document.getElementById('deploy-branch-select');
var inlineStatus = document.getElementById('deploy-inline-status');
var ENV_PROVIDERS = {};
// Creation status per environment, as /api/list-environments reports it:
// 'success' once credential verification passed, 'pending' while it runs,
// 'failed' when it did not. Only a verified environment can actually receive a
// deployment, so this gates the Deploy button rather than merely labelling the
// option — an environment whose creation failed has no working credentials.
var ENV_STATUS = {};
function envIsReady(name) { return ENV_STATUS[name] === 'success'; }
var HAS_APPS = false;
var HAS_ENVS = false;
// Optimistic per-row status overrides for in-flight operations, keyed by
// "app\\u0000env" → 'deleting' | 'pending'. Applied in loadDeployments so a row
// reflects the action just taken even before GitHub's deployment record catches
// up (or while a cached listing is still warm). Cleared when the op resolves.
var OP_STATUS = {};
function opKey(app, env) { return app + '\\u0000' + env; }
// Keys (app\u0000env) whose real GitHub deployment record was present in the
// last successful listing. Lets an in-flight deploy poll stop refreshing the
// list once the real record has replaced its optimistic synthetic row.
var DEPLOY_RECORDS_PRESENT = {};
// Environments that currently have an IN-PROGRESS operation which blocks a NEW
// deploy (status pending = a deploy run still in flight, or deleting = a delete
// run still in flight), keyed by env name → status. Rebuilt from each successful
// deployments listing. Terminal states do NOT block: a failed deploy can be
// retried, and a successful deploy can be redeployed over. Used by
// refreshDeployBtn to disable the Deploy button for the selected environment.
var DEPLOYED_ENVS = {};
function envIsBlocked(status) { return status === 'pending' || status === 'deleting'; }

// Renders an inline status banner (Figma: green success / red error with a ✓/⚠
// icon and a dismiss ✕). The message node uses textContent by default so
// server-provided strings can never inject HTML; pass isHtml=true only for
// intentionally-built, escaped markup (see the delete-success banner below).
function showInline(kind, msg, isHtml) {
    inlineStatus.style.display = 'flex';
    inlineStatus.className = 'rad-inline rad-inline--' + (kind === 'error' ? 'error' : 'success');
    inlineStatus.innerHTML = '';
    var icon = document.createElement('span');
    icon.className = 'rad-inline__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'error' ? '⚠' : '✓';
    var body = document.createElement('span');
    body.className = 'rad-inline__msg';
    if (isHtml) body.innerHTML = msg; else body.textContent = msg;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'rad-inline__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.addEventListener('click', function() { inlineStatus.style.display = 'none'; });
    inlineStatus.appendChild(icon);
    inlineStatus.appendChild(body);
    inlineStatus.appendChild(close);
}

function refreshDeployBtn() {
    // The primary button adapts to what's missing:
    //   • no application options  → "Create Application" (go model an app)
    //   • app but no environments → "Create Environment"
    //   • otherwise               → "Deploy" (enabled once app+env chosen)
    if (!HAS_APPS) {
        deployBtn.dataset.mode = 'create-app';
        deployBtn.textContent = 'Create Application';
        deployBtn.disabled = false;
    } else if (!HAS_ENVS) {
        deployBtn.dataset.mode = 'create-env';
        deployBtn.textContent = 'Create Environment';
        deployBtn.disabled = false;
    } else {
        deployBtn.dataset.mode = 'deploy';
        deployBtn.textContent = 'Deploy';
        var selEnv = envSelect.value;
        // Block deploying to an environment only while an operation is IN PROGRESS
        // (pending = a deploy run in flight, deleting = a delete run in flight).
        // Terminal states never block: switching to a free environment, or a
        // failed/successful deployment, all leave the button enabled so a
        // (re)deploy can run.
        var blockedStatus = selEnv ? DEPLOYED_ENVS[selEnv] : '';
        // Separately, the environment itself must have finished being created.
        // Deploying into an environment whose credential verification failed (or
        // has not finished) cannot succeed, so it never satisfies the
        // prerequisite for Deploy.
        var envNotReady = selEnv && !envIsReady(selEnv);
        deployBtn.disabled = !(CTX_REPO && appSelect.value && selEnv) || !!blockedStatus || !!envNotReady;
        if (blockedStatus) {
            if (blockedStatus === 'deleting') {
                deployBtn.title = 'Application is being deleted from environment "' + selEnv + '". Wait for the delete to finish before deploying again.';
            } else {
                deployBtn.title = 'A deployment is already in progress in environment "' + selEnv + '". Wait for it to finish before deploying again.';
            }
        } else if (envNotReady) {
            if (ENV_STATUS[selEnv] === 'pending') {
                deployBtn.title = 'Environment "' + selEnv + '" is still being created. Wait for its credential verification to finish before deploying.';
            } else {
                deployBtn.title = 'Environment "' + selEnv + '" was not created successfully, so it cannot be deployed to. Fix or recreate it first.';
            }
        } else {
            deployBtn.removeAttribute('title');
        }
    }
}

function loadApplications() {
    if (!CTX_REPO) { appSelect.innerHTML = '<option value="">No repository</option>'; return; }
    fetch('/api/list-applications?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var apps = (d && d.applications) || [];
            HAS_APPS = apps.length > 0;
            if (apps.length === 0) { appSelect.innerHTML = '<option value="">No applications</option>'; refreshDeployBtn(); return; }
            appSelect.innerHTML = apps.map(function(a) { return '<option value="' + escapeHtmlClient(a.name) + '">' + escapeHtmlClient(a.name) + '</option>'; }).join('');
            // Pre-select the application passed via ?app= (e.g. from a redirect
            // that resumes an in-flight deployment).
            try {
                var preApp = new URLSearchParams(window.location.search).get('app');
                if (preApp) {
                    var hasApp = apps.some(function(a) { return a.name === preApp; });
                    if (!hasApp) {
                        var o = document.createElement('option');
                        o.value = preApp; o.textContent = preApp;
                        appSelect.insertBefore(o, appSelect.firstChild);
                    }
                    appSelect.value = preApp;
                }
            } catch (e) {}
            refreshDeployBtn();
        })
        .catch(function() { appSelect.innerHTML = '<option value="">Could not load</option>'; });
}

function loadEnvironmentsDropdown() {
    if (!CTX_REPO) { envSelect.innerHTML = '<option value="">No repository</option>'; return; }
    fetch('/api/list-environments?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var envs = (d && d.environments) || [];
            HAS_ENVS = envs.length > 0;
            if (envs.length === 0) { envSelect.innerHTML = '<option value="">No environments</option>'; refreshDeployBtn(); return; }
            ENV_PROVIDERS = {};
            ENV_STATUS = {};
            envs.forEach(function(e) {
                ENV_PROVIDERS[e.name] = e.provider || 'azure';
                ENV_STATUS[e.name] = e.status || 'pending';
            });
            // An environment that is not (yet) usable stays in the list so the
            // user can see it exists and why it is not an option, but its label
            // says so and Deploy refuses it.
            envSelect.innerHTML = envs.map(function(e) {
                var suffix = e.status === 'success' ? '' : (e.status === 'failed' ? ' (creation failed)' : ' (being created…)');
                return '<option value="' + escapeHtmlClient(e.name) + '">' + escapeHtmlClient(e.name + suffix) + '</option>';
            }).join('');
            // Land on an environment that can actually be deployed to when there
            // is one, rather than whichever happens to be first.
            var firstReady = envs.filter(function(e) { return e.status === 'success'; })[0];
            if (firstReady) envSelect.value = firstReady.name;
            // Pre-select the environment passed via ?env= (e.g. from the
            // "Deploy Apps" button on the environments list).
            try {
                var preEnv = new URLSearchParams(window.location.search).get('env');
                if (preEnv && ENV_PROVIDERS.hasOwnProperty(preEnv)) { envSelect.value = preEnv; }
            } catch (e) {}
            refreshDeployBtn();
        })
        .catch(function() { envSelect.innerHTML = '<option value="">Could not load</option>'; });
}

// Populate the Branch dropdown for the deploy dispatch, defaulting to the
// current session/worktree branch. The chosen branch is the --ref the deploy
// workflow runs against, so exposing it lets the user redirect a deploy to a
// different branch (and see which branch a worktree session will deploy).
function loadBranches() {
    if (!branchSelect) return;
    if (!CTX_REPO) { branchSelect.innerHTML = '<option value="' + escapeHtmlClient(CTX_BRANCH) + '">' + escapeHtmlClient(CTX_BRANCH) + '</option>'; return; }
    fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO }) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var branches = (d && d.branches) || [];
            var workspaceBranch = (d && d.workspaceBranch) || CTX_BRANCH || '';
            // The branch we want selected by default (and dispatched against):
            // the server-reported worktree branch, else the session branch.
            var desired = workspaceBranch || CTX_BRANCH || '';
            if (branches.length === 0) { branchSelect.innerHTML = '<option value="' + escapeHtmlClient(CTX_BRANCH) + '">' + escapeHtmlClient(CTX_BRANCH) + '</option>'; return; }
            // The desired branch can be absent from /api/discover-branches (e.g. an
            // unpushed worktree branch the server didn't inject because the repo
            // didn't match the workspace). Insert it so the dropdown — and the
            // dispatch that reads branchSelect.value — never silently falls back to
            // the first returned branch and deploys the wrong ref.
            if (desired && !branches.some(function(b) { return b.name === desired; })) {
                branches.unshift({ name: desired, sha: 'worktree' });
            }
            branchSelect.innerHTML = '';
            branches.forEach(function(b) {
                var o = document.createElement('option');
                o.value = b.name;
                o.textContent = b.name + (b.sha === 'worktree' ? ' (worktree)' : (b.sha ? ' (' + b.sha.slice(0,7) + ')' : ''));
                if (b.name === desired) o.selected = true;
                branchSelect.appendChild(o);
            });
        })
        .catch(function() { branchSelect.innerHTML = '<option value="' + escapeHtmlClient(CTX_BRANCH) + '">' + escapeHtmlClient(CTX_BRANCH) + '</option>'; });
}

function statusCell(status) {
    var map = { success: ['success','Success'], failed: ['failed','Failed'], pending: ['pending','Pending'], deleting: ['deleting','Deleting…'] };
    var m = map[status] || map.pending;
    return '<span class="rad-dot rad-dot--' + m[0] + '"></span><span class="rad-status-label">' + m[1] + '</span>';
}

function loadDeployments(fresh, quiet) {
    var body = document.getElementById('deploy-table-body');
    if (!CTX_REPO) { body.innerHTML = '<tr><td class="rad-table__env" colspan="6">No application deployments yet.</td></tr>'; return; }
    // A background refresh (quiet) keeps the current rows on screen until the new
    // data arrives, so periodic in-flight polling doesn't flash the table back to
    // a "Loading…" placeholder on every tick.
    if (!quiet) body.innerHTML = '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>';
    fetch('/api/list-deployments?repo=' + encodeURIComponent(CTX_REPO) + (fresh ? '&fresh=1' : ''))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            // A transient GitHub failure returns { deployments: [], error }. Don't
            // render that as "no deployments" (which would hide real rows); show a
            // load-error row and leave any previous state to the next refresh.
            if (d && d.error) { if (!quiet) body.innerHTML = '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Could not load deployments. Retrying…</td></tr>'; return; }
            var deps = (d && d.deployments) || [];
            // Surface just-started operations GitHub hasn't recorded yet. A
            // deployment record isn't created until the deploy job starts, so an
            // optimistic "pending" OP_STATUS entry with no matching server row is
            // rendered as a synthetic row. Without this, a brand-new deployment to
            // an app+env with no prior record would stay invisible until the run
            // reached a terminal state or Refresh was clicked. "deleting" is
            // deliberately excluded: a delete always acts on an existing row, so
            // its record is recolored in place; once the record is gone the delete
            // is done, and a synthetic "Deleting…" row would be a phantom.
            var present = {};
            deps.forEach(function(dep) { present[opKey(dep.app, dep.environment)] = true; });
            DEPLOY_RECORDS_PRESENT = present;
            var synthetic = [];
            Object.keys(OP_STATUS).forEach(function(k) {
                if (present[k] || OP_STATUS[k] === 'deleting') return;
                var parts = k.split('\\u0000');
                if (parts.length !== 2 || !parts[0] || !parts[1]) return;
                // synthetic: no GitHub deployment record exists yet, so this row
                // must not offer Delete (it would dispatch against a nonexistent
                // record and falsely report success).
                synthetic.push({ app: parts[0], environment: parts[1], status: OP_STATUS[k], runUrl: '', synthetic: true });
            });
            var rows = synthetic.concat(deps);
            if (rows.length === 0) { DEPLOYED_ENVS = {}; refreshDeployBtn(); body.innerHTML = '<tr><td class="rad-table__env" colspan="6">No application deployments yet.</td></tr>'; return; }
            // Rebuild the set of environments whose deployment blocks a new deploy,
            // honoring optimistic overrides, then refresh the Deploy button state.
            DEPLOYED_ENVS = {};
            rows.forEach(function(dep) {
                var st = OP_STATUS[opKey(dep.app, dep.environment)] || dep.status;
                if (envIsBlocked(st)) DEPLOYED_ENVS[dep.environment] = st;
            });
            refreshDeployBtn();
            var arrowSvg = '<svg class="rad-applink-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            body.innerHTML = rows.map(function(dep) {
                // A GitHub deployment record is only created once the deploy/delete
                // job starts, so right after dispatch the newest record still shows
                // the previous state. Force an in-flight op's status until it clears
                // so the row reflects the action the user just took (Deleting…/Pending).
                var forced = OP_STATUS[opKey(dep.app, dep.environment)];
                var status = forced || dep.status;
                var statusHtml = statusCell(status);
                // The app name and the "Monitor Graph" link both route to the
                // Applications → Deployed tab (the live deployed app graph).
                var deployedHref = '/?page=deployed&environment=' + encodeURIComponent(dep.environment) + '&application=' + encodeURIComponent(dep.app);
                var monitorCell = '<a class="rad-monitor-link" href="' + escapeHtmlClient(deployedHref) + '" title="Monitor the deployed application graph">Monitor Graph</a>';
                // Workflow → the GitHub Actions run that produced this deployment.
                var workflowCell = dep.runUrl
                    ? '<a class="rad-deploy-applink" href="' + escapeHtmlClient(dep.runUrl) + '" target="_blank" rel="noopener noreferrer" title="View workflow run on GitHub">' + arrowSvg + 'View Run</a>'
                    : '<span class="rad-cell-empty">—</span>';
                // Failed deployments get a filled (solid) delete button; all
                // others use the subtle outline variant. Any in-flight operation
                // disables deletion so deploy/delete workflows cannot overlap.
                var delClass = status === 'failed' ? 'rad-btn--danger-solid' : 'rad-btn--danger-outline';
                var delDisabled = (status === 'pending' || status === 'deleting' || dep.synthetic) ? ' disabled' : '';
                return '<tr>' +
                    '<td class="rad-table__env"><a class="rad-deploy-applink" href="' + escapeHtmlClient(deployedHref) + '" title="View deployed application graph">' + arrowSvg + escapeHtmlClient(dep.app) + '</a></td>' +
                    '<td>' + escapeHtmlClient(dep.environment) + '</td>' +
                    '<td>' + statusHtml + '</td>' +
                    '<td>' + monitorCell + '</td>' +
                    '<td>' + workflowCell + '</td>' +
                    '<td class="rad-table__actions"><button class="rad-btn ' + delClass + ' js-del-dep"' + delDisabled + ' data-env="' + escapeHtmlClient(dep.environment) + '" data-app="' + escapeHtmlClient(dep.app) + '" style="margin:0;">Delete Deployment</button></td>' +
                '</tr>';
            }).join('');
            wireDeleteButtons();
        })
        .catch(function() { if (!quiet) body.innerHTML = '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Could not load deployments.</td></tr>'; });
}

// --- Delete deployment: 3-step type-to-confirm dialog (shared, client.ts) ---
var deleteDialog = radiusCreateDeleteDeploymentDialog({ onConfirm: runDelete });

function openDeleteModal(app, env) { if (deleteDialog) deleteDialog.open(app, env); }

function wireDeleteButtons() {
    document.querySelectorAll('.js-del-dep').forEach(function(btn) {
        btn.addEventListener('click', function() { openDeleteModal(this.dataset.app, this.dataset.env); });
    });
}

// Dispatch the delete, then let the row reflect "Deleting…" while the workflow
// runs. When the deployment finally clears from the listing, show the green
// "successfully deleted" banner (Figma deployments-deleted state).
function runDelete(app, env) {
    var dep = { app: app, environment: env };
    // Acknowledge the action immediately: the delete workflow takes a moment to
    // start, so without an instant cue the button click looks like it did
    // nothing. Mirror the deploy flow — flip the row to "Deleting…" and show a
    // banner right away, before the dispatch round-trip resolves. The delete
    // run's deployment record doesn't exist yet, so the OP_STATUS override keeps
    // the row showing "Deleting…" until it clears; refresh quietly so the
    // existing row flips in place instead of flashing a loading placeholder.
    OP_STATUS[opKey(dep.app, dep.environment)] = 'deleting';
    loadDeployments(true, true);
    showInline('success', 'Deleting deployment of application <strong>' + escapeHtmlClient(dep.app) + '</strong> in environment <strong>' + escapeHtmlClient(dep.environment) + '</strong> has started.', true);
    fetch('/api/delete-deployment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, environment: dep.environment, application: dep.app }) })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
        .then(function(res) {
            if (!res.ok) {
                // Dispatch failed — clear the optimistic override so the row
                // reverts to its real status, then surface the error.
                delete OP_STATUS[opKey(dep.app, dep.environment)];
                loadDeployments(true, true);
                showInline('error', (res.d && res.d.error) || 'Could not start the delete workflow.');
                return;
            }
            pollDeleteCompletion(dep.app, dep.environment, 0);
        })
        .catch(function() {
            delete OP_STATUS[opKey(dep.app, dep.environment)];
            loadDeployments(true, true);
            showInline('error', 'Could not delete the deployment. Please try again.');
        });
}

// Poll the deployments listing until the target app/env is gone (a successful
// delete removes it), then show the green success banner. Refreshes the table
// quietly each cycle so the "Deleting…" status stays visible without flashing a
// loading placeholder (matching the deploy flow's in-flight polling). Bounded so
// a stuck or failed delete never polls forever — on timeout the override is
// cleared and the row reverts to its real status (a failed delete falls back to
// its deploy record, so the deployment remains visible).
function pollDeleteCompletion(app, env, tries) {
    if (tries > 45) { delete OP_STATUS[opKey(app, env)]; loadDeployments(true, true); return; } // ~3 min at 4s
    setTimeout(function() {
        fetch('/api/list-deployments?repo=' + encodeURIComponent(CTX_REPO) + '&fresh=1')
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
            .then(function(res) {
                var d = res.d || {};
                // Only trust a complete, successful listing. A transient GitHub
                // failure comes back as { deployments: [], error } (or a non-array
                // deployments field); treating that empty list as "row gone" would
                // wrongly report a successful delete, so keep polling instead.
                if (!res.ok || d.error || !Array.isArray(d.deployments)) {
                    pollDeleteCompletion(app, env, tries + 1);
                    return;
                }
                var stillThere = d.deployments.some(function(x) { return x.app === app && x.environment === env; });
                if (!stillThere) {
                    delete OP_STATUS[opKey(app, env)];
                    loadDeployments(true, true);
                    showInline('success', 'Deployment of application <strong>' + escapeHtmlClient(app) + '</strong> in environment <strong>' + escapeHtmlClient(env) + '</strong> has been successfully deleted.', true);
                    return;
                }
                loadDeployments(true, true); // keep the row showing "Deleting…" (quiet)
                pollDeleteCompletion(app, env, tries + 1);
            })
            .catch(function() { pollDeleteCompletion(app, env, tries + 1); });
    }, 4000);
}

appSelect.addEventListener('change', refreshDeployBtn);
envSelect.addEventListener('change', refreshDeployBtn);

// Restore the deploy modal to its default "in progress" (spinner) layout. The
// modal is mutated in place when a deploy fails, so we reset before each run.
function resetDeployModal() {
    var spin = document.getElementById('deploy-progress-spinner');
    var fail = document.getElementById('deploy-progress-failicon');
    var sub = document.getElementById('deploy-progress-subtitle');
    var links = document.getElementById('deploy-progress-links');
    var failActions = document.getElementById('deploy-progress-fail-actions');
    if (spin) spin.style.display = '';
    if (fail) fail.style.display = 'none';
    if (sub) { sub.textContent = 'This may take a few minutes…'; sub.style.color = 'var(--rad-text-secondary)'; }
    if (links) links.style.display = 'flex';
    if (failActions) failActions.style.display = 'none';
}

// Switch the deploy modal into a "failed" state: swap the spinner for an error
// icon, show the error message, and offer a button back to the deployments list.
// The kind argument lets us render a cleaner, tailored panel for well-known
// failures (e.g. a branch that hasn't been pushed) instead of raw CLI stderr.
function showDeployFailed(app, env, errText, runUrl, kind, branch, repairing, handoff) {
    var modal = document.getElementById('deploy-progress-modal');
    var spin = document.getElementById('deploy-progress-spinner');
    var fail = document.getElementById('deploy-progress-failicon');
    var title = document.getElementById('deploy-progress-title');
    var sub = document.getElementById('deploy-progress-subtitle');
    var links = document.getElementById('deploy-progress-links');
    var failActions = document.getElementById('deploy-progress-fail-actions');
    if (spin) spin.style.display = 'none';
    if (fail) fail.style.display = '';
    if (kind === 'branch-not-pushed') {
        var br = branch || 'your branch';
        var pushCmd = 'git push -u origin ' + br;
        if (title) title.innerHTML = 'Branch not pushed yet';
        if (sub) {
            sub.style.color = 'var(--rad-text-secondary)';
            sub.innerHTML =
                '<div style="color:var(--rad-text);">The branch <code style="background:var(--rad-code-bg); padding:1px 5px; border-radius:4px;">' + escapeHtmlClient(br) + '</code> hasn\\'t been pushed to GitHub yet, so there\\'s nothing to deploy for <strong>' + escapeHtmlClient(app) + '</strong>.</div>' +
                '<div style="margin-top:10px; color:var(--rad-text-secondary);">Push it, then deploy again:</div>' +
                '<div style="margin-top:8px; display:flex; align-items:center; gap:8px; background:var(--rad-code-bg); border:1px solid var(--rad-stroke); border-radius:6px; padding:8px 10px;">' +
                  '<code style="flex:1; font-family:var(--font-mono, monospace); font-size:12px; color:var(--rad-text); white-space:nowrap; overflow-x:auto;">' + escapeHtmlClient(pushCmd) + '</code>' +
                  '<button type="button" id="deploy-copy-push" class="rad-btn rad-btn--neutral" style="margin:0; padding:2px 10px; font-size:12px; flex:none;">Copy</button>' +
                '</div>';
        }
    } else {
        if (title) title.innerHTML = 'Deployment of <strong>' + escapeHtmlClient(app) + '</strong> to <strong>' + escapeHtmlClient(env) + '</strong> failed';
        if (sub) {
            var msg = errText ? escapeHtmlClient(errText) : 'The deploy workflow run did not complete successfully.';
            if (runUrl) msg += '<br><a href="' + escapeHtmlClient(runUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--rad-link);">View workflow run in GitHub ↗</a>';
            sub.innerHTML = msg;
            sub.style.color = 'var(--rad-danger)';
        }
    }
    if (links) links.style.display = 'none';
    if (failActions) failActions.style.display = 'block';
    if (modal) modal.style.display = 'flex';
    var repairNote = document.getElementById('deploy-fail-repair-note');
    if (repairNote) {
        var hs = (handoff && handoff.state) || 'idle';
        var msg = '';
        if (repairing) {
            msg = 'Copilot is analyzing the failure and will repair and redeploy if the app model caused it — follow along in the chat.';
        } else if (hs === 'pending' || hs === 'retryable') {
            msg = 'Handing this failure to Copilot…';
        } else if (hs === 'failed') {
            msg = 'Could not reach Copilot to repair this deploy. Ask Copilot in the chat to fix .radius/app.bicep and redeploy.';
        }
        repairNote.style.display = msg ? 'block' : 'none';
        repairNote.textContent = msg;
    }
    // Wire the copy button (present only for the branch-not-pushed panel).
    var copyBtn = document.getElementById('deploy-copy-push');
    if (copyBtn) {
        copyBtn.addEventListener('click', function() {
            var cmd = 'git push -u origin ' + (branch || '');
            var done = function() { copyBtn.textContent = 'Copied'; setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(cmd).then(done).catch(function() {});
            }
        });
    }
    deployBtn.disabled = false;
    refreshDeployBtn();
}

// "Back to Deployments" dismisses the failed dialog and refreshes the list.
(function() {
    var backBtn = document.getElementById('deploy-fail-back');
    if (backBtn) backBtn.addEventListener('click', function() {
        var modal = document.getElementById('deploy-progress-modal');
        if (modal) modal.style.display = 'none';
        resetDeployModal();
        loadDeployments();
    });
})();

deployBtn.addEventListener('click', function() {
    var mode = deployBtn.dataset.mode || 'deploy';
    if (mode === 'create-app') { window.location.href = '/?page=graph'; return; }
    if (mode === 'create-env') { window.location.href = '/?page=environment&new=1'; return; }
    var env = envSelect.value;
    var app = appSelect.value;
    if (!CTX_REPO || !env || !app) return;
    var provider = ENV_PROVIDERS[env] || 'azure';
    resetDeployModal();
    // Optimistically show this row as "Pending" for the duration of the run. A
    // GitHub deployment record for the new run doesn't exist until the deploy job
    // starts, so without this the row would keep showing the previous status.
    OP_STATUS[opKey(app, env)] = 'pending';
    loadDeployments(true);
    deployBtn.disabled = true;
    deployBtn.textContent = 'Deploying…';

    // Briefly acknowledge the deploy, then auto-dismiss. Progress (status,
    // Monitor Graph, View Run) is tracked in the deployments list below, so the
    // dialog no longer links out to the app graph or the workflow run.
    var progTitle = document.getElementById('deploy-progress-title');
    progTitle.innerHTML = 'Deploying <strong>' + escapeHtmlClient(app) + '</strong> to environment <strong>' + escapeHtmlClient(env) + '</strong>';
    var progSub = document.getElementById('deploy-progress-subtitle');
    if (progSub) progSub.textContent = 'Track progress in the deployments list below.';
    var progModal = document.getElementById('deploy-progress-modal');
    progModal.style.display = 'flex';
    // Green confirmation banner (matches the delete-success notification).
    showInline('success', 'Deployment of application <strong>' + escapeHtmlClient(app) + '</strong> to environment <strong>' + escapeHtmlClient(env) + '</strong> has started.', true);
    // Auto-dismiss the transient dialog after a couple of seconds. The deploy
    // keeps running (tracked in the list), so the button returns to normal.
    var autoHide = setTimeout(function() {
        progModal.style.display = 'none';
        deployBtn.disabled = false;
        refreshDeployBtn();
    }, 2500);

    // Poll deploy-status to clear the optimistic "Pending" once the run resolves,
    // and to surface a failure dialog if the deploy can't start (e.g. an unpushed
    // branch). We stay on the Deployments page throughout.
    var failedPolls = 0;
    var wfTicks = 0;
    // Once the real record replaces the synthetic row, keep polling deploy-status
    // for the terminal transition but stop the per-tick fresh=1 list fetches.
    var recordSeen = false;
    var wfPoll = setInterval(function() {
        // Safety cap so a deploy-status that never reaches a terminal state can't
        // poll forever (~30 min at 2.5s/tick); fall back to GitHub's real status.
        if (++wfTicks > 720) {
            clearInterval(wfPoll);
            clearTimeout(autoHide);
            delete OP_STATUS[opKey(app, env)];
            loadDeployments(true);
            return;
        }
        fetch('/api/deploy-status')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d && d.status === 'failed') {
                    var handoff = d.handoff || {};
                    // Delivery of the repair handoff is asynchronous, so keep
                    // polling until it lands or the server stops retrying.
                    if (handoff.pending && failedPolls < 20) {
                        failedPolls++;
                        showDeployFailed(app, env, (d && d.error) || '', (d && d.deployRunUrl) || '', (d && d.errorKind) || '', (d && d.errorBranch) || '', false, handoff);
                        return;
                    }
                    clearInterval(wfPoll);
                    clearTimeout(autoHide);
                    delete OP_STATUS[opKey(app, env)];
                    showDeployFailed(app, env, (d && d.error) || '', (d && d.deployRunUrl) || '', (d && d.errorKind) || '', (d && d.errorBranch) || '', (d && d.repairing) || false, handoff);
                    loadDeployments(true);
                    return;
                }
                if (d && (d.status === 'success' || d.status === 'complete')) {
                    clearInterval(wfPoll);
                    delete OP_STATUS[opKey(app, env)];
                    loadDeployments(true);
                    return;
                }
                // Still in flight. Quietly refresh the table only until the real
                // GitHub deployment record (with its "View Run" link) replaces the
                // optimistic synthetic row; after that the row is real and driven
                // by the OP_STATUS override, so further fresh=1 fetches (which
                // bypass the cache and fan out per-environment) are wasted.
                if (recordSeen) return;
                if (DEPLOY_RECORDS_PRESENT[opKey(app, env)]) { recordSeen = true; return; }
                loadDeployments(true, true);
            })
            .catch(function() {});
    }, 2500);

    // The deploy runs against the branch the user selected (defaults to the
    // session/worktree branch). This value becomes the workflow --ref, so the
    // dispatched branch always matches what's shown in the Branch dropdown.
    var deployBranch = (branchSelect && branchSelect.value) || CTX_BRANCH;
    fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: env, provider: provider, targetRepo: CTX_REPO, branch: deployBranch, appFile: '.radius/app.bicep' })
    }).then(function(r) {
        return r.json().catch(function() { return {}; }).then(function(d) { return { ok: r.ok, d: d }; });
    }).then(function(result) {
        if (result.ok) return;
        clearInterval(wfPoll);
        clearTimeout(autoHide);
        delete OP_STATUS[opKey(app, env)];
        document.getElementById('deploy-progress-modal').style.display = 'none';
        deployBtn.disabled = false;
        refreshDeployBtn();
        showInline('error', (result.d && result.d.error) || 'Could not start the deployment.');
        loadDeployments(true);
    })
      .catch(function() {
          clearInterval(wfPoll);
          clearTimeout(autoHide);
          delete OP_STATUS[opKey(app, env)];
          document.getElementById('deploy-progress-modal').style.display = 'none';
          deployBtn.disabled = false;
          refreshDeployBtn();
          showInline('error', 'Could not start the deployment. Please try again.');
          loadDeployments(true);
      });
});

// Dismiss the deploy dialog by clicking the backdrop; the deployment keeps
// running in the background and shows up in the deployments table.
(function() {
    var pm = document.getElementById('deploy-progress-modal');
    if (pm) pm.addEventListener('click', function(e) {
        if (e.target === pm) {
            pm.style.display = 'none';
            resetDeployModal();
            deployBtn.disabled = false;
            refreshDeployBtn();
            loadDeployments(true);
        }
    });
})();

// Deploys started from the Planned or Deployed graph redirect here. Carrying
// the selected app/environment in the URL lets this page restore the same
// optimistic row and polling used for deployments started locally, closing the
// gap before GitHub publishes the deployment record.
function resumeRedirectedDeployment() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return false; }
    var app = params.get('application') || '';
    var env = params.get('environment') || '';
    if (!app || !env || !CTX_REPO) return false;

    var key = opKey(app, env);
    OP_STATUS[key] = 'pending';
    DEPLOYED_ENVS[env] = 'pending';
    refreshDeployBtn();
    loadDeployments(true);

    var ticks = 0;
    var recordSeen = false;
    var poll = setInterval(function() {
        if (++ticks > 720) {
            clearInterval(poll);
            delete OP_STATUS[key];
            loadDeployments(true);
            return;
        }
        fetch('/api/deploy-status')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var attempt = (d && d.attempt) || {};
                var sameAttempt = (!attempt.targetRepo || attempt.targetRepo === CTX_REPO) &&
                    (!attempt.environment || attempt.environment === env);
                if (d && d.active && sameAttempt) {
                    // Once GitHub has published the real deployment record, the
                    // optimistic override keeps its status pending; repeatedly
                    // bypassing the list cache after that would fan out several
                    // GitHub API calls per environment every 2.5 seconds.
                    if (!recordSeen && DEPLOY_RECORDS_PRESENT[key]) recordSeen = true;
                    if (!recordSeen) loadDeployments(true, true);
                    return;
                }
                clearInterval(poll);
                delete OP_STATUS[key];
                if (d && d.status === 'failed' && sameAttempt) {
                    showDeployFailed(app, env, d.error || '', d.deployRunUrl || '', d.errorKind || '', d.errorBranch || '', d.repairing || false, d.handoff || {});
                }
                loadDeployments(true);
            })
            .catch(function() {});
    }, 2500);
    return true;
}

loadApplications();
loadEnvironmentsDropdown();
loadBranches();
if (!resumeRedirectedDeployment()) loadDeployments();`;
