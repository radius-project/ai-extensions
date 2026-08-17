// Canvas adapter — inline browser script for credential profile selection and
// the GitHub identity the environment setup acts as.

export const ENVIRONMENT_PROFILE_CLIENT_JS = `function findProfile(name) {
    for (var i = 0; i < PROFILES.length; i++) { if (PROFILES[i].name === name) return PROFILES[i]; }
    return null;
}

// --- Custom credential-profile dropdown (Figma: options + pinned action) ---
var envProfileBtn = document.getElementById('env-profile-button');
var envProfileMenu = document.getElementById('env-profile-menu');
var envProfileValue = document.getElementById('env-profile-value');
var envProfileOptions = document.getElementById('env-profile-options');

function openProfileMenu(open) {
    var show = open === undefined ? envProfileMenu.style.display === 'none' : open;
    envProfileMenu.style.display = show ? '' : 'none';
    envProfileBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
}
function setProfileValue(name) {
    envProfileSelect.value = name || '';
    if (name) {
        var p = findProfile(name);
        envProfileValue.textContent = name + (p ? ' (' + providerLabel(p.provider) + ')' : '');
        envProfileValue.classList.remove('rad-combo__value--placeholder');
    } else {
        envProfileValue.textContent = 'Select a credential profile…';
        envProfileValue.classList.add('rad-combo__value--placeholder');
    }
    onEnvProfileSelected();
}
function renderProfileOptions() {
    envProfileOptions.innerHTML = '';
    PROFILES.forEach(function(p) {
        var o = document.createElement('button');
        o.type = 'button';
        o.className = 'rad-combo__option';
        o.setAttribute('role', 'option');
        o.setAttribute('data-name', p.name);
        o.textContent = p.name + ' (' + providerLabel(p.provider) + ')';
        o.addEventListener('click', function() { setProfileValue(this.getAttribute('data-name')); openProfileMenu(false); });
        envProfileOptions.appendChild(o);
    });
    document.getElementById('env-profile-empty').style.display = PROFILES.length ? 'none' : '';
}
envProfileBtn.addEventListener('click', function(e) { e.stopPropagation(); openProfileMenu(); });
document.addEventListener('click', function(e) {
    var combo = document.getElementById('env-profile-combo');
    if (combo && !combo.contains(e.target)) openProfileMenu(false);
});

function loadProfilesIntoEnvSelect(preselectName, afterSelect) {
    var done = function(selectedName) {
        if (typeof afterSelect === 'function') afterSelect(selectedName);
    };
    fetch('/api/credential-profiles?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            PROFILES = (d && d.profiles) || [];
            renderProfileOptions();
            var selected = preselectName && findProfile(preselectName) ? preselectName : '';
            setProfileValue(selected);
            done(selected);
        })
        .catch(function() {
            PROFILES = [];
            renderProfileOptions();
            setProfileValue('');
            done('');
        });
}

// --- GitHub identity for setup (acting account + switcher) ---
// Setup mutations (App Registration create, environment PUT, workflow-file
// commit) run as an effective GitHub account that is NOT always the one the
// host app shows. Surface it, and let the user switch, so a wrong account
// (e.g. an enterprise/EMU login without repo or tenant access) is caught here
// rather than as a confusing mid-setup permission error.
var GH_IDENTITY = null;
var envGhField = document.getElementById('env-gh-identity-field');
var envGhBtn = document.getElementById('env-gh-account-button');
var envGhMenu = document.getElementById('env-gh-account-menu');
var envGhValue = document.getElementById('env-gh-account-value');
var envGhOptions = document.getElementById('env-gh-account-options');
var envGhNote = document.getElementById('env-gh-identity-note');
var envGhRecheck = document.getElementById('env-gh-recheck');
// True while the identity note is showing a missing-scope warning the user must
// fix out-of-band (run a gh command). Gates the auto re-check on window refocus
// so we only re-poll gh when there is actually something to clear.
var envGhScopeWarn = false;
// Guards against overlapping re-checks (rapid focus events / button spam).
var envGhChecking = false;

function openGhAccountMenu(open) {
    if (!envGhMenu) return;
    var show = open === undefined ? envGhMenu.style.display === 'none' : open;
    envGhMenu.style.display = show ? '' : 'none';
    if (envGhBtn) envGhBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
}
if (envGhBtn) envGhBtn.addEventListener('click', function(e) { e.stopPropagation(); openGhAccountMenu(); });
document.addEventListener('click', function(e) {
    var combo = document.getElementById('env-gh-account-combo');
    if (combo && !combo.contains(e.target)) openGhAccountMenu(false);
});

function renderGitHubIdentity() {
    if (!envGhField || !GH_IDENTITY) return;
    var id = GH_IDENTITY;
    if (id.error || !id.actingLogin) {
        // Detection failed or no account — keep the field hidden rather than
        // showing a misleading control. Setup still runs with whatever gh uses.
        envGhField.style.display = 'none';
        envGhScopeWarn = false;
        if (envGhRecheck) envGhRecheck.style.display = 'none';
        return;
    }
    envGhField.style.display = '';
    if (envGhValue) envGhValue.textContent = '@' + id.actingLogin;
    var accounts = id.accounts || [];
    if (envGhOptions) {
        envGhOptions.innerHTML = '';
        accounts.forEach(function(a) {
            var o = document.createElement('button');
            o.type = 'button';
            o.className = 'rad-combo__option';
            o.setAttribute('role', 'option');
            var label = '@' + a.login;
            var missingScopes = [];
            if (!a.hasWorkflow) missingScopes.push('workflow');
            if (!a.hasPackages) missingScopes.push('packages');
            if (missingScopes.length) label += ' — missing ' + missingScopes.join(' + ') + ' scope' + (missingScopes.length > 1 ? 's' : '');
            if (!a.switchable) label += ' (not switchable)';
            else if (a.login === id.actingLogin) label += ' ✓';
            o.textContent = label;
            if (a.switchable && a.login !== id.actingLogin) {
                o.setAttribute('data-login', a.login);
                o.addEventListener('click', function() {
                    switchGitHubAccount(this.getAttribute('data-login'));
                    openGhAccountMenu(false);
                });
            } else {
                o.disabled = true;
                o.style.opacity = '0.6';
                o.style.cursor = 'default';
            }
            envGhOptions.appendChild(o);
        });
    }
    var emptyEl = document.getElementById('env-gh-account-empty');
    if (emptyEl) emptyEl.style.display = accounts.length ? 'none' : '';

    if (envGhNote) {
        var warn = '';
        var scopeWarn = false;
        var repoWarn = false;
        if (id.repoAccess) {
            // The acting account can't admin (or can't read) the target repo, so
            // Create Environment would 403 at submit. Surface it HERE at open,
            // next to the account it concerns, rather than after the user fills
            // in all four steps. The submit-time preflight stays authoritative;
            // this is an early, additive heads-up. Offer Re-check so switching
            // accounts (or being granted access) clears it without reopening.
            warn = id.repoAccess;
            repoWarn = true;
        } else if (id.mismatch && id.displayLogin) {
            warn = 'The app shows @' + id.displayLogin + ' but setup will act as @' + id.actingLogin +
                '. If deployment fails with a permission error, switch to the account that has access to this repo and your Azure tenant.';
        } else if (!id.actingHasWorkflow || !id.actingHasPackages) {
            // Both scopes are needed to complete setup: 'workflow' to commit the
            // deploy workflow, 'write:packages' to publish the private state
            // package to GHCR. Name whichever is missing and build the exact
            // refresh command (read:packages accompanies write:packages).
            var missNames = [], refreshScopes = [];
            if (!id.actingHasWorkflow) { missNames.push('workflow'); refreshScopes.push('workflow'); }
            if (!id.actingHasPackages) { missNames.push('write:packages'); refreshScopes.push('read:packages'); refreshScopes.push('write:packages'); }
            // gh auth refresh has no --user flag: it refreshes whichever
            // account is ACTIVE for the host. In a multi-account (EMU/enterprise)
            // setup the active account may not be the one we act as, so first
            // switch to it with "gh auth switch -u" (which does take --user), then
            // run a bare refresh. Adding a -u flag to the refresh call errors
            // with "unknown shorthand flag: 'u'".
            var refreshScopeFlags = refreshScopes.map(function(s){ return ' -s ' + s; }).join('');
            var refreshCmd = 'gh auth switch -h github.com -u ' + id.actingLogin +
                ' && gh auth refresh -h github.com' + refreshScopeFlags;
            warn = 'The active account @' + id.actingLogin + ' is missing the ' + missNames.join(' and ') + ' scope' + (missNames.length > 1 ? 's' : '') +
                ' environment setup needs. Run "' + refreshCmd + '" or switch accounts. Note: gh auth switch changes your active GitHub account machine-wide for every tool in this terminal until you switch back.';
            scopeWarn = true;
        }
        // Remember whether a fixable scope warning is on screen, and offer the
        // manual Re-check control only in that case. Returning from the terminal
        // (window refocus) auto re-checks while this is true; see below.
        envGhScopeWarn = scopeWarn || repoWarn;
        if (envGhRecheck) envGhRecheck.style.display = (scopeWarn || repoWarn) ? '' : 'none';
        if (warn) {
            envGhNote.textContent = warn;
            envGhNote.style.color = 'var(--rad-warning, #9a6700)';
            envGhNote.style.display = '';
        } else {
            envGhNote.innerHTML = 'Acts as <strong>@' + id.actingLogin + '</strong> to commit the deploy workflow to your repo and publish the state package. Needs the <code>workflow</code> and <code>write:packages</code> scopes.';
            envGhNote.style.color = 'var(--rad-text-tertiary)';
            envGhNote.style.display = '';
        }
    }
}

function loadGitHubIdentity(fresh) {
    if (envGhChecking) return;
    envGhChecking = true;
    // On the very first load show the neutral "Detecting…" placeholder; on a
    // re-check the account value is already shown, so give feedback on the
    // button instead of blanking the field.
    if (fresh && envGhRecheck) { envGhRecheck.disabled = true; envGhRecheck.textContent = 'Checking…'; }
    else if (envGhValue) envGhValue.textContent = 'Detecting…';
    // fresh=1 asks the server to drop its memoized gh snapshot so newly added
    // scopes (e.g. write:packages) are actually observed. repo lets the server
    // fold in the repo admin/read preflight so a non-admin account is flagged
    // here at open, not only at submit.
    var idUrl = '/api/github-identity?repo=' + encodeURIComponent(CTX_REPO || '');
    if (fresh) idUrl += '&fresh=1';
    fetch(idUrl)
        .then(function(r) { return r.json(); })
        .then(function(d) { GH_IDENTITY = d || {}; renderGitHubIdentity(); })
        .catch(function() { if (envGhField) envGhField.style.display = 'none'; })
        .then(function() {
            envGhChecking = false;
            if (envGhRecheck) { envGhRecheck.disabled = false; envGhRecheck.textContent = 'Re-check'; }
        });
}

// Manual re-check: the user ran the gh command and wants the warning re-evaluated.
if (envGhRecheck) envGhRecheck.addEventListener('click', function() { loadGitHubIdentity(true); });

// Auto re-check when the canvas regains focus. The user leaves to a terminal to
// run the remediation command and comes back; refocus is the natural signal to
// re-poll. Only fire while a fixable scope warning is showing so we do not run
// gh on every unrelated focus.
function envGhAutoRecheck() {
    if (envGhScopeWarn && !envGhChecking && envGhField && envGhField.style.display !== 'none') {
        loadGitHubIdentity(true);
    }
}
document.addEventListener('visibilitychange', function() { if (!document.hidden) envGhAutoRecheck(); });
window.addEventListener('focus', envGhAutoRecheck);

function switchGitHubAccount(login) {
    if (!login) return;
    if (envGhValue) envGhValue.textContent = 'Switching…';
    fetch('/api/github-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login }),
    })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
        .then(function(res) {
            if (res.ok) {
                // Re-fetch identity WITH the repo so the admin/read preflight
                // re-runs for the freshly switched account — the switch response
                // resolves identity without the repo, so it carries no repoAccess.
                loadGitHubIdentity(true);
                return;
            }
            renderGitHubIdentity();
            if (envGhNote) {
                envGhNote.textContent = (res.d && res.d.error) || 'Could not switch account.';
                envGhNote.style.color = 'var(--rad-danger, #cf222e)';
                envGhNote.style.display = '';
            }
        })
        .catch(function() { renderGitHubIdentity(); });
}

function onEnvProfileSelected() {
    // A credential-profile / tenant change is a context change: never let a
    // shared-identity pin from a previous context silently carry over.
    selectedProfile = findProfile(envProfileSelect.value);
    var statusEl = document.getElementById('env-profile-status');
    var detailEl = document.getElementById('env-profile-detail');
    var idAz = document.getElementById('env-identity-azure');
    var idAws = document.getElementById('env-identity-aws');
    renderEnvProfileSummary(selectedProfile);
    updateEnvStep1State();
    if (!selectedProfile) {
        statusEl.style.display = 'none';
        if (detailEl) { detailEl.style.display = 'none'; detailEl.innerHTML = ''; }
        deployBtn.disabled = true;
        var azRb0 = document.getElementById('azure-refresh-btn'); if (azRb0) azRb0.disabled = true;
        var awsRb0 = document.getElementById('aws-refresh-btn'); if (awsRb0) awsRb0.disabled = true;
        return;
    }
    var prov = selectedProfile.provider === 'aws' ? 'aws' : 'azure';
    document.getElementById('env-selected-provider').value = prov;
    // Provider-aware profile detail: what the connection does, where deploys
    // land (subscription / account), and the verified identity behind it.
    var detail = '';
    if (prov === 'aws') {
        detail += '<div style="color:var(--rad-text-tertiary);margin-bottom:4px;">GitHub Actions assumes the IAM role in this profile over OIDC to deploy — no stored secrets.</div>';
        var awsDest = escapeHtmlClient(selectedProfile.accountId || '') + (selectedProfile.region ? ' · ' + escapeHtmlClient(selectedProfile.region) : '');
        if (awsDest.trim()) detail += '<div><span style="color:var(--rad-text-tertiary);">Account:</span> <strong style="color:var(--rad-text);">' + awsDest + '</strong></div>';
    } else {
        detail += '<div style="color:var(--rad-text-tertiary);margin-bottom:4px;">Creates the Entra app, the OIDC trust to your repo, and grants it Contributor on the resource group and AKS RBAC Cluster Admin on the cluster.</div>';
        var sub = selectedProfile.subscriptionName || selectedProfile.subscriptionId || '';
        if (sub) detail += '<div><span style="color:var(--rad-text-tertiary);">Subscription:</span> <strong style="color:var(--rad-text);">' + escapeHtmlClient(sub) + '</strong></div>';
    }
    if (selectedProfile.user) detail += '<div><span style="color:var(--rad-text-tertiary);">Signed in as</span> <strong style="color:var(--rad-text);">' + escapeHtmlClient(selectedProfile.user) + '</strong> <span style="color:var(--rad-primary);font-weight:600;">· ✓ Verified</span></div>';
    else detail += '<div><span style="color:var(--rad-primary);font-weight:600;">✓ Verified</span></div>';
    statusEl.style.display = '';
    statusEl.innerHTML = detail;
    if (detailEl) { detailEl.style.display = ''; detailEl.innerHTML = detail; }
    if (idAz) idAz.style.display = prov === 'azure' ? '' : 'none';
    if (idAws) idAws.style.display = prov === 'aws' ? '' : 'none';
    document.getElementById('panel-azure').style.display = prov === 'azure' ? '' : 'none';
    document.getElementById('panel-aws').style.display = prov === 'aws' ? '' : 'none';
    deployBtn.disabled = false;
    var rb = document.getElementById(prov === 'aws' ? 'aws-refresh-btn' : 'azure-refresh-btn');
    if (rb) rb.disabled = false;
    discoverResources(prov, selectedProfile.subscriptionId, selectedProfile.tenantId);
}
['azure-refresh-btn','aws-refresh-btn'].forEach(function(id){
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function(){
        if (!selectedProfile) return;
        var prov = selectedProfile.provider === 'aws' ? 'aws' : 'azure';
        discoverResources(prov, selectedProfile.subscriptionId, selectedProfile.tenantId);
    });
});`;
