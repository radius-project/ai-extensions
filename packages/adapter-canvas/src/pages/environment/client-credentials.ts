// Canvas adapter — inline browser script for the Credentials sub-tab: profile
// table, provider form, verification, and the page's initial load.

export const ENVIRONMENT_CREDENTIAL_CLIENT_JS = `// ============================ Credentials =============================
var credLanding = document.getElementById('cred-landing');
var credForm = document.getElementById('cred-form');
var credProviderSelect = document.getElementById('cred-provider-select');
var credVerified = null;
var credPackagesVerified = false;
var credGhChecking = false;

function loadCredTable() {
    var body = document.getElementById('cred-table-body');
    if (!CTX_REPO) {
        body.innerHTML = '<tr><td class="rad-table__env">No credential profiles created yet.</td><td></td><td></td><td class="rad-table__actions"></td></tr>';
        return;
    }
    body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading credential profiles…</td></tr>';
    fetch('/api/credential-profiles?repo=' + encodeURIComponent(CTX_REPO))
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var profiles = (d && d.profiles) || [];
            if (profiles.length === 0) {
                body.innerHTML = '<tr><td class="rad-table__env">No credential profiles created yet.</td><td></td><td></td><td class="rad-table__actions"></td></tr>';
                return;
            }
            body.innerHTML = profiles.map(function(p) {
                return '<tr>' +
                    '<td class="rad-table__env">' + escapeHtmlClient(p.name) + '</td>' +
                    '<td class="rad-table__provider">' + escapeHtmlClient(providerLabel(p.provider)) + '</td>' +
                    '<td>' + statusCell(p.status || 'verified') + '</td>' +
                    '<td class="rad-table__actions">' +
                        '<button class="rad-btn rad-btn--neutral js-cred-createenv" data-name="' + escapeHtmlClient(p.name) + '" style="margin:0;">Create Env</button>' +
                        '<button class="rad-btn rad-btn--danger-outline js-cred-delete" data-name="' + escapeHtmlClient(p.name) + '" style="margin:0;">Delete Profile</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
            wireCredRowActions(profiles);
        })
        .catch(function() {
            body.innerHTML = '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Could not load credential profiles.</td></tr>';
        });
}
function wireCredRowActions(profiles) {
    document.querySelectorAll('.js-cred-createenv').forEach(function(btn) {
        btn.addEventListener('click', function() { switchSubtab('environments'); showEnvForm({ name: '', profile: this.getAttribute('data-name') }); });
    });
    document.querySelectorAll('.js-cred-delete').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var name = this.getAttribute('data-name') || '';
            // Environments already created from a profile hold their own copy of
            // its values, so deleting one never affects an existing environment.
            if (!name || !confirm('Delete credential profile "' + name + '"?\\n\\nEnvironments already created from it keep working — they have their own copy of these values. You will not be able to create new environments from this profile.')) return;
            this.disabled = true; this.textContent = 'Deleting…';
            fetch('/api/delete-credential-profile', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ repo: CTX_REPO, name: name }) })
                .then(function(r) { return r.json(); }).then(function() { loadCredTable(); })
                .catch(function() { loadCredTable(); });
        });
    });
}

function applyCredProvider(p) {
    var isAws = p === 'aws';
    document.getElementById('cred-panel-azure').style.display = isAws ? 'none' : '';
    document.getElementById('cred-panel-aws').style.display = isAws ? '' : 'none';
}
credProviderSelect.addEventListener('change', function() { applyCredProvider(this.value); resetCredVerify(); });

function resetCredVerify() {
    credVerified = null;
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'none'; st.innerHTML = '';
    document.getElementById('cred-verify-hint').style.display = '';
    updateCredSaveState();
}
function updateCredSaveState() {
    document.getElementById('save-cred-btn').disabled = !(credVerified && credPackagesVerified);
}
function renderCredGitHubAccess(id) {
    var status = document.getElementById('cred-ghcr-status');
    var commandRow = document.getElementById('cred-ghcr-command-row');
    var command = document.getElementById('cred-ghcr-command');
    var retry = document.getElementById('cred-ghcr-retry');
    credPackagesVerified = !!(id && id.actingLogin && id.actingHasPackages);
    commandRow.style.display = 'none';
    retry.style.display = 'none';
    if (!id || id.error || !id.actingLogin) {
        status.textContent = 'Could not detect a GitHub CLI account. Sign in with gh auth login, then retry.';
        status.style.color = 'var(--rad-danger)';
    } else if (credPackagesVerified) {
        status.innerHTML = '✓ GitHub Packages access verified for <strong>@' + escapeHtmlClient(id.actingLogin) + '</strong>.';
        status.style.color = 'var(--rad-primary)';
    } else {
        var refreshCmd = 'gh auth switch -h github.com -u ' + id.actingLogin +
            ' && gh auth refresh -h github.com -s read:packages -s write:packages';
        status.innerHTML = 'The active account <strong>@' + escapeHtmlClient(id.actingLogin) +
            '</strong> cannot publish packages. Run the command below, complete the GitHub authorization, then retry. <strong>Note:</strong> <code>gh auth switch</code> changes the active account machine-wide until you switch back.';
        status.style.color = 'var(--rad-warning, #9a6700)';
        command.textContent = refreshCmd;
        commandRow.style.display = 'flex';
        retry.style.display = '';
    }
    updateCredSaveState();
}
function loadCredGitHubAccess(fresh) {
    if (credGhChecking) return;
    credGhChecking = true;
    var status = document.getElementById('cred-ghcr-status');
    var retry = document.getElementById('cred-ghcr-retry');
    status.textContent = 'Checking GitHub Packages access…';
    status.style.color = 'var(--rad-text-tertiary)';
    if (retry) { retry.disabled = true; retry.textContent = 'Checking…'; }
    var url = '/api/github-identity' + (fresh ? '?fresh=1' : '');
    fetch(url)
        .then(function(r) { return r.json(); })
        .then(renderCredGitHubAccess)
        .catch(function(err) { renderCredGitHubAccess({ error: err && err.message ? err.message : 'GitHub identity check failed' }); })
        .then(function() {
            credGhChecking = false;
            if (retry) { retry.disabled = false; retry.textContent = 'I’ve updated permissions — retry'; }
        });
}
// Profiles are created, never edited: every field here must be re-verified
// against the cloud account before it can be saved, so an edit was already
// equivalent to creating a profile. Removing it also removes renaming, which
// was the only way a profile's name could drift from the one recorded on the
// environments created from it.
function showCredForm() {
    document.getElementById('cred-success-banner').style.display = 'none';
    document.getElementById('cred-form-title').textContent = 'Create Credential Profile';
    document.getElementById('save-cred-btn').textContent = credSaveLabel();
    document.getElementById('cancel-cred-btn').textContent = CRED_FORM_CONTEXT === 'wizard' ? 'Cancel' : '← Back to credentials';
    document.getElementById('cred-name-input').value = '';
    credProviderSelect.value = 'azure';
    applyCredProvider('azure');
    document.getElementById('az-tenant-id').value = '';
    document.getElementById('az-sub-id').value = '';
    var acc = document.getElementById('aws-account-id'); if (acc) acc.value = '';
    var reg = document.getElementById('aws-region'); if (reg) reg.value = '';
    var role = document.getElementById('aws-role-arn'); if (role) role.value = '';
    resetCredVerify();
    credPackagesVerified = false;
    updateCredSaveState();
    loadCredGitHubAccess(true);
    document.getElementById('cred-name-input').focus();
}
// In the wizard the save continues the environment flow, so the button says so.
function credSaveLabel() {
    return CRED_FORM_CONTEXT === 'wizard' ? 'Save & Continue' : 'Save Credential Profile';
}
function showCredLanding() {
    credForm.style.display = 'none';
    credLanding.style.display = '';
    loadCredTable();
}
function showCredSuccessBanner(name) {
    var banner = document.getElementById('cred-success-banner');
    document.getElementById('cred-success-banner-text').innerHTML = 'Successfully created credential profile ' + escapeHtmlClient(name);
    banner.style.display = 'flex';
}
// Creating a profile from the Credentials sub-tab is credential management, not
// environment setup: the user asked for a profile, so saving returns them to the
// listing rather than pushing them into the environment flow.
document.getElementById('new-cred-btn').addEventListener('click', function() {
    showStandaloneCredForm();
});
document.getElementById('cancel-cred-btn').addEventListener('click', function() {
    if (CRED_FORM_CONTEXT === 'wizard') { endCredentialCreation(); return; }
    showCredLanding();
});
var credSuccessClose = document.getElementById('cred-success-banner-close');
if (credSuccessClose) credSuccessClose.addEventListener('click', function() { document.getElementById('cred-success-banner').style.display = 'none'; });

function markVerified(user, extra) {
    credVerified = extra || {};
    credVerified.user = user || '';
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'flex';
    st.innerHTML = '<span class="rad-verified-pill">✓ Credentials verified</span>' +
        (user ? '<span class="rad-verified-meta">Logged in as <strong>' + escapeHtmlClient(user) + '</strong></span>' : '');
    document.getElementById('cred-verify-hint').style.display = 'none';
    updateCredSaveState();
}

var credGhRetry = document.getElementById('cred-ghcr-retry');
if (credGhRetry) credGhRetry.addEventListener('click', function() { loadCredGitHubAccess(true); });
var credGhCopy = document.getElementById('cred-ghcr-copy');
if (credGhCopy) credGhCopy.addEventListener('click', function() {
    var command = document.getElementById('cred-ghcr-command').textContent || '';
    var done = function() {
        credGhCopy.textContent = 'Copied';
        setTimeout(function() { credGhCopy.textContent = 'Copy command'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(done).catch(function() {});
    }
});

function credVerifyError(msg) {
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'block';
    st.innerHTML = '<span style="color:var(--rad-danger);">' + escapeHtmlClient(msg) + '</span>';
}

function credVerifyInfo(msg) {
    var st = document.getElementById('cred-verify-status');
    st.style.display = 'block';
    st.innerHTML = '<span>' + escapeHtmlClient(msg) + '</span>';
}

function requestAzureCliAssist(action, tenantId, fallbackMessage) {
    fetch('/api/azure-cli-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, tenantId: tenantId || '' })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.error) {
            credVerifyError(data.error + (fallbackMessage ? ' ' + fallbackMessage : ''));
            return;
        }
        credVerifyInfo((data && data.message) || 'Copilot is helping with Azure CLI setup. After it finishes, click Verify Credentials again.');
    }).catch(function(err) {
        credVerifyError('Error: ' + err.message + (fallbackMessage ? ' ' + fallbackMessage : ''));
    });
}

var pendingAzureCliAssist = null;
function showAzureCliAssistPrompt(action, tenantId, fallbackMessage) {
    pendingAzureCliAssist = {
        action: action,
        tenantId: tenantId || '',
        fallbackMessage: fallbackMessage || ''
    };
    var isInstall = action === 'install';
    document.getElementById('azure-cli-assist-title').textContent = isInstall ? 'Install Azure CLI?' : 'Start Azure login?';
    document.getElementById('azure-cli-assist-message').textContent = isInstall
        ? 'Azure CLI is not installed. Would you like Copilot to attempt to install it and then start Azure login?'
        : 'No active Azure session was found. Would you like Copilot to start the Azure login flow?';
    document.getElementById('azure-cli-assist-confirm').textContent = isInstall ? 'Ask Copilot to install' : 'Start Azure login';
    document.getElementById('azure-cli-assist-modal').style.display = 'flex';
    document.getElementById('azure-cli-assist-confirm').focus();
}

function closeAzureCliAssistPrompt() {
    document.getElementById('azure-cli-assist-modal').style.display = 'none';
    pendingAzureCliAssist = null;
}

document.getElementById('azure-cli-assist-cancel').addEventListener('click', function() {
    var fallbackMessage = pendingAzureCliAssist && pendingAzureCliAssist.fallbackMessage;
    closeAzureCliAssistPrompt();
    if (fallbackMessage) credVerifyError(fallbackMessage);
});

document.getElementById('azure-cli-assist-confirm').addEventListener('click', function() {
    var request = pendingAzureCliAssist;
    closeAzureCliAssistPrompt();
    if (request) requestAzureCliAssist(request.action, request.tenantId, request.fallbackMessage);
});

document.getElementById('btn-verify-azure').addEventListener('click', function() {
    var btn = this;
    var profileName = document.getElementById('cred-name-input').value.trim();
    var tenantId = document.getElementById('az-tenant-id').value.trim();
    var subId = document.getElementById('az-sub-id').value.trim();
    var modal = document.getElementById('env-verify-modal');
    var titleEl = document.getElementById('env-verify-title');
    resetCredVerify();
    if (!profileName) { credVerifyError('Please enter a Profile Name before verifying.'); return; }
    if (!tenantId || !subId) { credVerifyError('Please enter both a Tenant ID and a Subscription ID before verifying.'); return; }
    btn.disabled = true; btn.textContent = '⏳ Verifying…';
    if (titleEl) titleEl.textContent = 'Verifying authentication to Azure…';
    modal.style.display = 'flex';
    fetch('/api/verify-azure-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: tenantId, subscriptionId: subId }) })
        .then(function(r) { return r.json(); }).then(function(data) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            if (data.error) {
                if (data.code === 'az-login-required') {
                    showAzureCliAssistPrompt('login', data.tenantId || tenantId, data.error);
                    return;
                }
                if (data.code === 'az-cli-missing') {
                    showAzureCliAssistPrompt('install', data.tenantId || tenantId, data.error);
                    return;
                }
                credVerifyError(data.error);
                return;
            }
            if (data.tenantId) document.getElementById('az-tenant-id').value = data.tenantId;
            if (data.subscriptionId) document.getElementById('az-sub-id').value = data.subscriptionId;
            markVerified(data.user, { tenantId: data.tenantId || tenantId, subscriptionId: data.subscriptionId || subId, subscriptionName: data.subscriptionName || '' });
        }).catch(function(err) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            credVerifyError('Error: ' + err.message);
        });
});

var verifyAwsBtn = document.getElementById('btn-verify-aws');
if (verifyAwsBtn) verifyAwsBtn.addEventListener('click', function() {
    var btn = this;
    var profileName = document.getElementById('cred-name-input').value.trim();
    var accountId = document.getElementById('aws-account-id').value.trim();
    var region = document.getElementById('aws-region').value.trim();
    var modal = document.getElementById('env-verify-modal');
    var titleEl = document.getElementById('env-verify-title');
    resetCredVerify();
    if (!profileName) { credVerifyError('Please enter a Profile Name before verifying.'); return; }
    btn.disabled = true; btn.textContent = '⏳ Verifying…';
    if (titleEl) titleEl.textContent = 'Verifying authentication to AWS…';
    modal.style.display = 'flex';
    fetch('/api/verify-aws-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: accountId, region: region }) })
        .then(function(r) { return r.json(); }).then(function(data) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            if (data.error) { credVerifyError(data.error); return; }
            if (data.accountId) document.getElementById('aws-account-id').value = data.accountId;
            markVerified(data.user || data.arn || '', { accountId: data.accountId || accountId, region: region });
        }).catch(function(err) {
            modal.style.display = 'none'; btn.disabled = false; btn.textContent = 'Verify Credentials';
            credVerifyError('Error: ' + err.message);
        });
});

document.getElementById('save-cred-btn').addEventListener('click', function() {
    var btn = this;
    var name = document.getElementById('cred-name-input').value.trim();
    if (!name) { alert('Please enter a profile name.'); return; }
    if (!credVerified) { alert('Please verify your credentials first.'); return; }
    var provider = credProviderSelect.value;
    var profile = { repo: CTX_REPO, name: name, provider: provider, user: credVerified.user || '' };
    if (provider === 'azure') { profile.tenantId = credVerified.tenantId || ''; profile.subscriptionId = credVerified.subscriptionId || ''; profile.subscriptionName = credVerified.subscriptionName || ''; }
    else { profile.accountId = credVerified.accountId || ''; profile.region = credVerified.region || ''; profile.roleArn = document.getElementById('aws-role-arn').value.trim(); }
    var wizard = CRED_FORM_CONTEXT === 'wizard';
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch('/api/save-credential-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })
        .then(function(r) { return r.json(); }).then(function(d) {
            btn.disabled = false; btn.textContent = credSaveLabel();
            if (d && d.error) { alert('Could not save profile: ' + d.error); return; }
            if (wizard) {
                // The profile was created for the environment being set up:
                // select it and carry the user straight into step 2.
                endCredentialCreation();
                loadProfilesIntoEnvSelect(name, function(selected) {
                    if (!selected) return;
                    showEnvWizardStep(2);
                    envNameInput.focus();
                });
                return;
            }
            showCredLanding(); showCredSuccessBanner(name);
        }).catch(function(err) {
            btn.disabled = false; btn.textContent = credSaveLabel();
            alert('Could not save profile: ' + err.message);
        });
});

// ============================ Init =============================
if (document.getElementById('pane-credentials').style.display !== 'none') { loadCredTable(); } else { loadEnvTable(); }
// Rejoin an operation already in flight. Without this the panel would only ever
// exist for the tab that started the work, and a reload — or a trip to the graph
// and back — would look exactly like nothing was happening.
resumeEnvProgress(CTX_REPO);

// Deep link: '/?page=environment&new=1' opens the creation form directly
// (used by the Modeled graph's "Create Environment" call to action) rather
// than landing on the environments table. This runs after the resume call, but
// that call is asynchronous, so an operation still in flight wins and replaces
// the form with its progress once the lookup returns.
(function() {
    var wantsNew = false;
    try { wantsNew = new URLSearchParams(window.location.search).get('new') === '1'; } catch (e) { /* URLSearchParams unavailable */ }
    if (!wantsNew) return;
    switchSubtab('environments');
    showEnvForm({ name: '' });
})();`;
