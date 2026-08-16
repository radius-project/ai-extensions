// Canvas adapter — inline browser script for the environment page: sub-tab
// switching, the environment table, the creation form, and its banners.

export const ENVIRONMENT_TABLE_CLIENT_JS = `function escapeHtmlClient(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
}
function providerLabel(p) { return p === 'aws' ? 'AWS' : (p === 'azure' ? 'Azure' : (p || '—')); }

// ============================ Subtab switching ============================
function switchSubtab(name) {
    var isCred = name === 'credentials';
    document.getElementById('pane-environments').style.display = isCred ? 'none' : '';
    document.getElementById('pane-credentials').style.display = isCred ? '' : 'none';
    var links = document.querySelectorAll('#env-subtabs .rad-subtab');
    for (var i = 0; i < links.length; i++) {
        links[i].classList.toggle('rad-subtab--active', links[i].getAttribute('data-subtab') === name);
    }
    try { history.replaceState(null, '', '/?page=' + (isCred ? 'credentials' : 'environment')); } catch (e) {}
    if (isCred) {
        loadCredTable();
    } else {
        loadEnvTable();
        // If the user is returning to an already-open Create Environment form
        // (e.g. they opened it, hit the combo's "+ Create new profile" action to
        // add a profile on the Credentials subtab, then came back), the combo
        // still holds the PROFILES snapshot from when the form opened — so a
        // just-created profile is missing until a full canvas reload. Re-sync it
        // here, preserving the current selection. Skipped on the landing view:
        // the combo is hidden there, New Environment re-fetches via showEnvForm(),
        // and refreshing would fire resource discovery on a hidden form.
        if (envForm && envForm.style.display !== 'none') loadProfilesIntoEnvSelect(envProfileSelect.value);
    }
}
(function() {
    var links = document.querySelectorAll('#env-subtabs .rad-subtab');
    for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function(e) { e.preventDefault(); switchSubtab(this.getAttribute('data-subtab')); });
    }
})();

// ============================ Environments =============================
var envLanding = document.getElementById('env-landing');
var envForm = document.getElementById('env-form');
var envNameInput = document.getElementById('env-name-input');
var envProfileSelect = document.getElementById('env-profile-select'); // hidden input holding selected name
var deployBtn = document.getElementById('deploy-btn');
var PROFILES = [];
var selectedProfile = null;

function statusCell(status) {
    var map = { success: ['success','Success'], verified: ['success','Verified'], failed: ['failed','Failed'], pending: ['pending','Pending'], unverified: ['pending','Unverified'] };
    var m = map[status] || map.pending;
    return '<span class="rad-dot rad-dot--' + m[0] + '"></span><span class="rad-status-label">' + m[1] + '</span>';
}

var envPollTimer = null;
function loadEnvTable() {
    var body = document.getElementById('env-table-body');
    if (!CTX_REPO) {
        body.innerHTML = '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td><td></td><td class="rad-table__actions"></td></tr>';
        return;
    }
    body.innerHTML = '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>';
    fetch('/api/list-environments?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var envs = (data && data.environments) || [];
            if (envs.length === 0) {
                body.innerHTML = '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td><td></td><td class="rad-table__actions"></td></tr>';
                return;
            }
            body.innerHTML = envs.map(function(e) {
                var prov = e.provider || '—';
                var creds = e.credentialProfile || '—';
                var editHref = e.webUrl || ('https://github.com/' + CTX_REPO + '/settings/environments');
                return '<tr>' +
                    '<td class="rad-table__env">' + escapeHtmlClient(e.name) + '</td>' +
                    '<td>' + statusCell(e.status) + '</td>' +
                    '<td class="rad-table__provider">' + escapeHtmlClient(prov) + '</td>' +
                    '<td class="rad-table__creds">' + escapeHtmlClient(creds) + '</td>' +
                    '<td class="rad-table__actions">' +
                        '<a class="rad-link" href="' + escapeHtmlClient(editHref) + '" target="_blank" rel="noopener noreferrer">edit</a>' +
                        '<button class="rad-btn rad-btn--neutral js-deploy-apps" data-env="' + escapeHtmlClient(e.name) + '" style="margin:0;">Deploy Apps</button>' +
                        '<button class="rad-btn rad-btn--danger-outline js-delete-env" data-env="' + escapeHtmlClient(e.name) + '" style="margin:0;">Delete Env</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
            wireRowActions();
            if (envPollTimer) { clearTimeout(envPollTimer); envPollTimer = null; }
            if (envs.some(function(e) { return e.status === 'pending'; })) {
                envPollTimer = setTimeout(loadEnvTable, 10000);
            }
        })
        .catch(function() {
            body.innerHTML = '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Could not load environments.</td></tr>';
        });
}
function wireRowActions() {
    document.querySelectorAll('.js-deploy-apps').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var envName = this.getAttribute('data-env') || '';
            window.location.href = '/?page=deploying' + (envName ? '&env=' + encodeURIComponent(envName) : '');
        });
    });
    document.querySelectorAll('.js-delete-env').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var envName = this.getAttribute('data-env') || '';
            if (!envName || !confirm('Delete environment "' + envName + '"? This removes the GitHub environment and its Radius configuration.')) return;
            this.disabled = true; this.textContent = 'Deleting…';
            var delBtn = this;
            fetch('/api/delete-environment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, environment: envName }) })
                .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
                .then(function(res) {
                    if (!res.ok) {
                        delBtn.disabled = false; delBtn.textContent = 'Delete Env';
                        // An environment can't be deleted while an app is still
                        // deployed to it — show the error and send the user to the
                        // application-deletion flow (Deployments page) to remove it.
                        if (res.d && res.d.code === 'app-deployed') {
                            showEnvError((res.d.error || 'Delete the application deployment first.') + ' Redirecting you to delete the application…');
                            var target = (res.d && res.d.redirect) || '/?page=deploying';
                            setTimeout(function() { window.location.href = target; }, 2000);
                            return;
                        }
                        alert((res.d && res.d.error) || 'Could not delete the environment.');
                        return;
                    }
                    loadEnvTable();
                })
                .catch(function() {
                    delBtn.disabled = false; delBtn.textContent = 'Delete Env';
                    alert('Could not delete the environment. Please try again.');
                });
        });
    });
}

function showEnvForm(preset) {
    preset = preset || {};
    hideEnvTerminalBanners();
    envNameInput.value = preset.name !== undefined ? preset.name : '';
    document.getElementById('az-client-id').value = '';
    clearSharedAppPin();
    document.getElementById('deploy-status').style.display = 'none';
    envLanding.style.display = 'none';
    envForm.style.display = '';
    loadProfilesIntoEnvSelect(preset.profile);
    loadGitHubIdentity();
    envNameInput.focus();
}
function showEnvLanding() {
    envForm.style.display = 'none';
    envLanding.style.display = '';
    loadEnvTable();
}
function showEnvSuccessBanner(provider, name) {
    var banner = document.getElementById('env-success-banner');
    var text = document.getElementById('env-success-banner-text');
    if (!banner || !text) return;
    text.innerHTML = 'Successfully created <strong>' + escapeHtmlClient(providerLabel(provider)) +
        '</strong> Environment <strong>' + escapeHtmlClient(name) + '</strong>';
    banner.style.display = 'flex';
}
var envSuccessClose = document.getElementById('env-success-banner-close');
if (envSuccessClose) envSuccessClose.addEventListener('click', function() {
    document.getElementById('env-success-banner').style.display = 'none';
});

function hideEnvTerminalBanners() {
    ['env-success-banner', 'env-error-banner', 'env-warning-banner', 'env-action-banner'].forEach(function(id) {
        var banner = document.getElementById(id);
        if (banner) banner.style.display = 'none';
    });
}

// Show a red error banner on the environments landing (e.g. when an environment
// can't be deleted because an app is still deployed to it). Message may contain
// intentionally-built escaped markup from the caller.
function showEnvError(msg) {
    var banner = document.getElementById('env-error-banner');
    var text = document.getElementById('env-error-banner-text');
    if (!banner || !text) return;
    text.textContent = msg;
    banner.style.display = 'flex';
    banner.scrollIntoView({ block: 'nearest' });
}
var envErrorClose = document.getElementById('env-error-banner-close');
if (envErrorClose) envErrorClose.addEventListener('click', function() {
    document.getElementById('env-error-banner').style.display = 'none';
});

// Surface non-fatal auto-setup warnings (steps prefixed with "⚠️") on the
// SUCCESS path. Auto-setup returns a 'steps' log; the AKS Cluster Admin grant is
// best-effort and only pushes a warning into that log, so without this the user
// would never see (on success) that they must grant the role manually before the
// deploy will pass "Verify AKS Access". Renders nothing when there are no
// warnings. Steps are server-built plain text; render as text, not markup.
function showEnvSetupWarnings(steps) {
    var banner = document.getElementById('env-warning-banner');
    var text = document.getElementById('env-warning-banner-text');
    if (!banner || !text) return;
    var warnings = (steps || []).filter(function(s) { return typeof s === 'string' && s.indexOf('⚠️') === 0; });
    if (!warnings.length) { banner.style.display = 'none'; return; }
    text.textContent = warnings.join('\\n\\n');
    banner.style.display = 'flex';
    banner.scrollIntoView({ block: 'nearest' });
}
var envWarningClose = document.getElementById('env-warning-banner-close');
if (envWarningClose) envWarningClose.addEventListener('click', function() {
    document.getElementById('env-warning-banner').style.display = 'none';
});

// The pull-request terminal state. When Radius lacks push access to the default
// branch it commits the workflows to a branch and opens a PR instead — and it
// deliberately does NOT dispatch credential verification, because the workflow
// file does not exist on the default branch yet and the dispatch would 404.
// Nothing failed, and nothing is still running; the operation is finished and
// waiting on the user. Before this existed the client polled for a verify run
// that was never going to appear and, eight minutes later, reported this
// correct outcome as "Timed out waiting for credential verification".
function showEnvActionRequired(provider, name, pullRequestUrl, terminal) {
    var banner = document.getElementById('env-action-banner');
    var text = document.getElementById('env-action-banner-text');
    if (!banner || !text) return;
    var hasPr = typeof pullRequestUrl === 'string' && pullRequestUrl.indexOf('https://github.com/') === 0;
    var html = '<strong>' + escapeHtmlClient(providerLabel(provider)) + '</strong> Environment <strong>' +
        escapeHtmlClient(name) + '</strong> is set up, but one step is left for you. ';
    if (hasPr) {
        html += 'Radius could not push the deploy workflows to the default branch, so it opened a pull request. ' +
            'Credential verification and deploys start working once it merges.';
    } else {
        var branch = terminal && terminal.branch ? terminal.branch : 'the setup branch';
        var base = terminal && terminal.baseBranch ? terminal.baseBranch : 'the default branch';
        html += 'Radius committed the deploy workflows to <code>' + escapeHtmlClient(branch) +
            '</code>, but could not open a pull request automatically. Open a pull request into <code>' +
            escapeHtmlClient(base) + '</code> and merge it to finish setup.';
    }
    // Only render a link for a URL we recognise; anything else is shown as text
    // so a malformed value can never become an anchor target.
    if (hasPr) {
        html += ' <a href="' + escapeHtmlClient(pullRequestUrl) + '" target="_blank" rel="noopener noreferrer">Review the pull request →</a>';
    }
    text.innerHTML = html;
    banner.style.display = 'flex';
    banner.scrollIntoView({ block: 'nearest' });
}
var envActionClose = document.getElementById('env-action-banner-close');
if (envActionClose) envActionClose.addEventListener('click', function() {
    document.getElementById('env-action-banner').style.display = 'none';
});

// ---------------- Environment setup progress (non-blocking) ----------------
//
// The panel is a view over the server's operation record, not over the fetch
// that started it. That indirection is the whole point: the record outlives the
// request, so closing the page, navigating to the graph, or reloading the canvas
// mid-operation all rejoin the same operation instead of losing it.
var envProgressTimer = null;
var envProgressElapsedTimer = null;
// The Actions step the verify run is on. Held here rather than in the record
// because it comes from a different poll on a slower cadence, and the panel
// re-renders faster than that poll refreshes.
var envVerifyActivity = '';
`;
