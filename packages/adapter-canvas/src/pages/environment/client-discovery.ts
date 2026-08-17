// Canvas adapter — inline browser script for cloud resource discovery and the
// deploy-identity (app registration) picker.

import {
  formatServesReposLabel,
  discoverStatusText
} from "../../azure-oidc.js";
import { serializeBrowserFunction } from "../browser-function.js";

export const ENVIRONMENT_DISCOVERY_CLIENT_JS = `// Shared-identity pin helpers. The pin (az-selected-app-id) makes this repo
// reuse another app's identity — deliberately wider blast radius, so it must
// be cleared on any fresh form or context change and be explicitly reversible.
function clearSharedAppPin() {
    var hid = document.getElementById('az-selected-app-id');
    if (hid) hid.value = '';
    var note = document.getElementById('az-selected-app-note');
    if (note) { note.style.display = 'none'; note.textContent = ''; }
    var clearLink = document.getElementById('az-clear-pin-link');
    if (clearLink) clearLink.style.display = 'none';
    var nameEl = document.getElementById('az-app-name-input');
    if (nameEl) {
        nameEl.value = nameEl.getAttribute('data-default-name') || '';
        nameEl.disabled = false;
        nameEl.style.opacity = '';
    }
}
(function(){
    var clearLink = document.getElementById('az-clear-pin-link');
    if (clearLink) clearLink.addEventListener('click', function(e){ e.preventDefault(); clearSharedAppPin(); });
})();
// Opt-in "use an existing application" (advanced, non-default): lists ALL
// App Registrations the user owns and lets them deliberately share one across
// repos. A shared deploy identity has a wider blast radius, so this is never
// reached automatically — only via this explicit action.
(function(){
    var link = document.getElementById('az-use-existing-link');
    if (!link) return;
    link.addEventListener('click', function(e){
        e.preventDefault();
        var note = document.getElementById('az-selected-app-note');
        link.textContent = 'Loading applications…';
        fetch('/api/list-azure-app-registrations').then(function(r){ return r.json(); }).then(function(data){
            link.textContent = 'Use an existing application…';
            if (data.error) { if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-danger,#cf222e)'; note.textContent = 'Could not list applications: ' + data.error; } return; }
            var apps = data.apps || [];
            if (!apps.length) { if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-danger,#cf222e)'; note.textContent = 'You do not own any App Registrations yet — create one instead.'; } return; }
            showAppPicker({
                title: 'Use an existing application',
                intro: 'Select an App Registration you already own to reuse as this repository\u2019s deploy identity.',
                caution: 'Sharing one identity across repositories means every wired repository can use its Azure permissions. Only do this for repos that belong to the same product.',
                candidates: apps,
                defaultAppId: '',
                allowCreateNew: false
            }).then(function(choice){
                var hid = document.getElementById('az-selected-app-id');
                if (hid && choice.appId) hid.value = choice.appId;
                var picked = apps.filter(function(a){ return a.appId === choice.appId; })[0];
                if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-info,#0969da)'; note.textContent = 'Will reuse: ' + ((picked && picked.displayName) || choice.appId) + ' (' + choice.appId + ').'; }
                var clearLink = document.getElementById('az-clear-pin-link');
                if (clearLink) clearLink.style.display = 'inline';
                var nameEl = document.getElementById('az-app-name-input');
                if (nameEl) {
                    nameEl.value = (picked && picked.displayName) || choice.appId;
                    nameEl.disabled = true;
                    nameEl.style.opacity = '0.6';
                }
            }).catch(function(){ /* cancelled */ });
        }).catch(function(err){
            link.textContent = 'Use an existing application…';
            if (note) { note.style.display = 'block'; note.style.color = 'var(--rad-danger,#cf222e)'; note.textContent = 'Could not list applications: ' + (err && err.message || err); }
        });
    });
})();
document.getElementById('new-env-btn').addEventListener('click', function() { showEnvForm({ name: '' }); });
document.getElementById('cancel-env-btn').addEventListener('click', showEnvLanding);
document.getElementById('env-create-profile-link').addEventListener('click', function(e) {
    // Creating a profile now happens inline in wizard step 1 rather than by
    // sending the user to the Credentials sub-tab and back.
    e.preventDefault(); openProfileMenu(false); startCredentialCreation();
});

// combo select: reveal custom input on "__custom__"
function setupCombo(selectId, customId) {
    var sel = document.getElementById(selectId);
    var inp = document.getElementById(customId);
    if (!sel || !inp) return;
    sel.addEventListener('change', function() {
        inp.style.display = this.value === '__custom__' ? '' : 'none';
        if (this.value === '__custom__') inp.focus();
    });
}
['azure-cluster-select|azure-cluster-custom','azure-rg-select|azure-rg-custom','azure-namespace-select|azure-namespace-custom',
 'aws-cluster-select|aws-cluster-custom','aws-namespace-select|aws-namespace-custom','aws-vpc-select|aws-vpc-custom','aws-subnets-select|aws-subnets-custom']
 .forEach(function(pair) { var p = pair.split('|'); setupCombo(p[0], p[1]); });

function populateSelect(selectId, items, placeholder) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    if (items.length === 0) {
        var opt = document.createElement('option');
        opt.value = ''; opt.disabled = true; opt.selected = true; opt.textContent = 'No resources found';
        sel.appendChild(opt);
    } else {
        var ph = document.createElement('option');
        ph.value = ''; ph.disabled = true; ph.selected = true; ph.textContent = placeholder || 'Select...';
        sel.appendChild(ph);
        for (var i = 0; i < items.length; i++) {
            var o = document.createElement('option');
            o.value = items[i].id || items[i];
            o.textContent = items[i].name || items[i].id || items[i];
            sel.appendChild(o);
        }
    }
    var custom = document.createElement('option');
    custom.value = '__custom__'; custom.textContent = '+ Enter custom...';
    sel.appendChild(custom);
}
// Case-insensitive sort by display name so discovered resource lists render in
// a predictable order in the dropdowns.
function sortByName(items) {
    return (items || []).slice().sort(function(a, b) {
        var an = String((a && (a.name || a.id)) || a).toLowerCase();
        var bn = String((b && (b.name || b.id)) || b).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
    });
}
// Populate the AKS cluster dropdown from a (possibly RG-filtered) list, keeping
// the current selection when it is still present in the new list.
function renderAzureClusters(list, keepValue) {
    populateSelect('azure-cluster-select', list, 'Select AKS cluster…');
    if (!keepValue) return;
    var sel = document.getElementById('azure-cluster-select');
    for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === keepValue) { sel.value = keepValue; break; }
    }
}
function setupAzureInfraFilter() {
    var clusterSel = document.getElementById('azure-cluster-select');
    var rgSel = document.getElementById('azure-rg-select');
    if (!clusterSel || !rgSel || clusterSel.__filterWired) return;
    clusterSel.__filterWired = true;
    function findCluster(cid) {
        var list = window.__azureClusters || [];
        for (var i = 0; i < list.length; i++) { if ((list[i].id || list[i].name) === cid) return list[i]; }
        return null;
    }
    // Selecting a resource group limits the cluster dropdown to the AKS clusters
    // that live in that resource group. A custom-typed or empty RG shows them all.
    rgSel.addEventListener('change', function() {
        var rg = rgSel.value;
        var all = window.__azureClusters || [];
        if (rg === '' || rg === '__custom__') { renderAzureClusters(all, clusterSel.value); return; }
        var filtered = [];
        for (var i = 0; i < all.length; i++) { if ((all[i].resourceGroup || '') === rg) filtered.push(all[i]); }
        var keep = '';
        for (var j = 0; j < filtered.length; j++) { if ((filtered[j].id || filtered[j].name) === clusterSel.value) { keep = clusterSel.value; break; } }
        renderAzureClusters(filtered, keep);
    });
    // Selecting a cluster back-fills its resource group so the two stay linked.
    clusterSel.addEventListener('change', function() {
        var cid = clusterSel.value;
        if (cid === '__custom__' || cid === '') return;
        var cluster = findCluster(cid);
        if (!cluster || !cluster.resourceGroup) return;
        var hasRg = false, customOpt = null;
        for (var i = 0; i < rgSel.options.length; i++) {
            if (rgSel.options[i].value === cluster.resourceGroup) hasRg = true;
            if (rgSel.options[i].value === '__custom__') customOpt = rgSel.options[i];
        }
        if (!hasRg) {
            var opt = document.createElement('option');
            opt.value = cluster.resourceGroup; opt.textContent = cluster.resourceGroup;
            if (customOpt) rgSel.insertBefore(opt, customOpt); else rgSel.appendChild(opt);
        }
        rgSel.value = cluster.resourceGroup;
    });
}
function discoverResources(provider, subId, tenantId) {
    var payload = { provider: provider };
    if (subId) payload.subscriptionId = subId;
    if (tenantId) payload.tenantId = tenantId;
    var statusId = provider === 'azure' ? 'azure-discover-status' : 'aws-discover-status';
    var statusEl = document.getElementById(statusId);
    if (statusEl) statusEl.textContent = 'Discovering resources…';
    fetch('/api/discover', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (provider === 'azure') {
                if (statusEl) statusEl.textContent = discoverStatusText(data, 'azure');
                window.__azureClusters = sortByName(data.clusters || []);
                renderAzureClusters(window.__azureClusters, '');
                populateSelect('azure-rg-select', sortByName(data.resourceGroups || []), 'Select resource group…');
                populateSelect('azure-namespace-select', sortByName(data.namespaces || ['default','kube-system','radius-system']), 'Select namespace…');
                setupAzureInfraFilter();
            } else {
                if (statusEl) statusEl.textContent = discoverStatusText(data, 'aws');
                populateSelect('aws-cluster-select', sortByName(data.clusters || []), 'Select EKS cluster…');
                populateSelect('aws-namespace-select', sortByName(data.namespaces || ['default','kube-system','radius-system']), 'Select namespace…');
                populateSelect('aws-vpc-select', [{id:'', name:'None (optional)'}].concat(data.vpcs || []), 'Select VPC…');
                populateSelect('aws-subnets-select', [{id:'', name:'None (optional)'}].concat(data.subnets || []), 'Select subnets…');
            }
        })
        .catch(function(e) { if (statusEl) statusEl.textContent = 'Discovery error: ' + e.message; });
}
function getComboValue(selectId, customId) {
    var sel = document.getElementById(selectId);
    if (sel.value === '__custom__') return document.getElementById(customId).value;
    return sel.value;
}
// Look up a discovered AKS cluster's own resource group by its selected id/name.
// Returns '' when the cluster was typed by hand (not in the discovery list), so
// the server falls back to the deployment resource group.
function findAzureClusterResourceGroup(clusterId) {
    var list = window.__azureClusters || [];
    for (var i = 0; i < list.length; i++) {
        if ((list[i].id || list[i].name) === clusterId) return list[i].resourceGroup || '';
    }
    return '';
}
// Prompt for a Service Management Reference (GUID) via the modal; resolves the
// entered GUID or rejects if the user cancels.
function promptSmr() {
    var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    var modal = document.getElementById('env-smr-modal');
    var input = document.getElementById('env-smr-input');
    var errEl = document.getElementById('env-smr-error');
    var retryBtn = document.getElementById('env-smr-retry');
    var cancelBtn = document.getElementById('env-smr-cancel');
    input.value = ''; errEl.style.display = 'none';
    modal.style.display = 'flex';
    input.focus();
    return new Promise(function(resolve, reject) {
        function cleanup() {
            modal.style.display = 'none';
            retryBtn.removeEventListener('click', onRetry);
            cancelBtn.removeEventListener('click', onCancel);
        }
        function onRetry() {
            var smr = input.value.trim();
            if (!UUID_RE.test(smr)) {
                errEl.textContent = 'Enter a valid GUID.';
                errEl.style.display = 'block';
                return;
            }
            cleanup();
            resolve(smr);
        }
        function onCancel() { cleanup(); var error = new Error('Service Management Reference is required to continue.'); error.abandonOperation = true; reject(error); }
        retryBtn.addEventListener('click', onRetry);
        cancelBtn.addEventListener('click', onCancel);
    });
}

// Single source of truth: these two pure helpers are authored and unit-tested
// in azure-oidc.ts, then serialized into this browser bundle so the SHIPPING
// client runs the exact tested code instead of a hand-copied twin. Assign each
// helper to its stable browser name explicitly: the Node bundle is minified, so
// Function#toString returns mangled declaration names even with keepNames=true.
// Function declarations inside the assigned expression remain self-contained.
${serializeBrowserFunction("formatServesReposLabel", formatServesReposLabel)}
${serializeBrowserFunction("discoverStatusText", discoverStatusText)}

// Render the identity picker. opts.candidates is a list of
// {appId, displayName, createdDateTime, servesRepos?}. Resolves with
// {appId} or {createNew:true}; rejects on cancel.
function showAppPicker(opts) {
    var modal = document.getElementById('env-appselect-modal');
    var titleEl = document.getElementById('env-appselect-title');
    var introEl = document.getElementById('env-appselect-intro');
    var cautionEl = document.getElementById('env-appselect-caution');
    var listEl = document.getElementById('env-appselect-list');
    var errEl = document.getElementById('env-appselect-error');
    var confirmBtn = document.getElementById('env-appselect-confirm');
    var cancelBtn = document.getElementById('env-appselect-cancel');
    titleEl.textContent = opts.title || 'Choose a deploy identity';
    introEl.textContent = opts.intro || '';
    if (opts.caution) { cautionEl.textContent = opts.caution; cautionEl.style.display = 'block'; }
    else { cautionEl.style.display = 'none'; }
    errEl.style.display = 'none';
    listEl.innerHTML = '';
    var candidates = opts.candidates || [];
    var chosen = { value: opts.defaultAppId || (candidates[0] && candidates[0].appId) || '' };
    // appId -> row body element still awaiting its lazy "Serves:" label.
    var servesSlots = {};
    function appendServes(bodyEl, text) {
        var line3 = document.createElement('div');
        line3.style.cssText = 'font-size:11px; color:var(--rad-info,#0969da); margin-top:2px; word-break:break-all;';
        line3.textContent = text;
        bodyEl.appendChild(line3);
    }

    function row(value, primary, secondary, serves) {
        var id = 'appsel-' + (value || 'create');
        var label = document.createElement('label');
        label.setAttribute('for', id);
        label.style.cssText = 'display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--rad-stroke); border-radius:8px; cursor:pointer;';
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'appsel'; radio.id = id; radio.value = value;
        radio.style.marginTop = '2px';
        if (value === chosen.value) radio.checked = true;
        radio.addEventListener('change', function() { chosen.value = value; });
        var body = document.createElement('div');
        body.style.minWidth = '0';
        var line1 = document.createElement('div');
        line1.style.cssText = 'font-size:13px; font-weight:600; color:var(--rad-text); word-break:break-all;';
        line1.textContent = primary;
        body.appendChild(line1);
        if (secondary) {
            var line2 = document.createElement('div');
            line2.style.cssText = 'font-size:11px; color:var(--rad-text-tertiary); margin-top:2px; word-break:break-all;';
            line2.textContent = secondary;
            body.appendChild(line2);
        }
        var servesText = formatServesReposLabel(serves);
        if (servesText) {
            appendServes(body, servesText);
        } else if (value && value !== '__create__') {
            // No server-provided label: remember the row so it can be filled
            // lazily once /api/azure-app-serves-repos resolves for this app.
            servesSlots[value] = body;
        }
        label.appendChild(radio);
        label.appendChild(body);
        listEl.appendChild(label);
    }

    candidates.forEach(function(c) {
        var created = c.createdDateTime ? ('created ' + String(c.createdDateTime).slice(0, 10) + ' · ') : '';
        row(c.appId, c.displayName || c.appId, created + c.appId, c.servesRepos);
    });
    if (opts.allowCreateNew) {
        row('__create__', 'Create a new application instead', 'A fresh per-repo deploy identity that only this repository can use.');
        if (!chosen.value) chosen.value = '__create__';
    }

    // Lazy-load the per-app "Serves:" labels so the picker renders immediately
    // instead of blocking on one az federated-credential list per owned app.
    // Bounded concurrency; each label is best-effort and skipped on failure or
    // if its row was replaced by a later picker.
    (function loadServesLabels() {
        var pending = Object.keys(servesSlots);
        if (!pending.length) return;
        var pos = 0;
        var CONC = 6;
        function pump() {
            if (pos >= pending.length) return;
            var appId = pending[pos++];
            var bodyEl = servesSlots[appId];
            fetch('/api/azure-app-serves-repos?appId=' + encodeURIComponent(appId))
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    var text = formatServesReposLabel(d && d.servesRepos);
                    if (text && bodyEl && bodyEl.isConnected) appendServes(bodyEl, text);
                })
                .catch(function() { /* label is best-effort */ })
                .then(function() { pump(); });
        }
        for (var i = 0; i < Math.min(CONC, pending.length); i++) pump();
    })();

    modal.style.display = 'flex';
    return new Promise(function(resolve, reject) {
        function cleanup() {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        }
        function onConfirm() {
            if (!chosen.value) {
                errEl.textContent = 'Select an application or choose to create a new one.';
                errEl.style.display = 'block';
                return;
            }
            cleanup();
            if (chosen.value === '__create__') resolve({ createNew: true });
            else resolve({ appId: chosen.value });
        }
        function onCancel() { cleanup(); var error = new Error('Identity selection cancelled.'); error.abandonOperation = true; reject(error); }
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

deployBtn.addEventListener('click', function() {
    var btn = this;
    var statusEl = document.getElementById('deploy-status');
    function fail(msg) { statusEl.style.display = 'block'; statusEl.className = 'status error'; statusEl.textContent = msg; }
    if (!selectedProfile) { fail('Please select a credential profile.'); return; }
    var env = envNameInput.value.trim();
    if (!env) { fail('Please enter an environment name.'); return; }
    var provider = selectedProfile.provider === 'aws' ? 'aws' : 'azure';
    var targetRepo = document.getElementById('target-repo').value.trim();
    if (!targetRepo) { fail('Please specify a target repository (owner/repo).'); return; }
    var cluster, namespace, vpc, subnets, resourceGroup, clusterResourceGroup;
    if (provider === 'azure') {
        cluster = getComboValue('azure-cluster-select', 'azure-cluster-custom');
        namespace = getComboValue('azure-namespace-select', 'azure-namespace-custom') || 'default';
        resourceGroup = getComboValue('azure-rg-select', 'azure-rg-custom');
        if (!resourceGroup) { fail('Please specify a resource group.'); return; }
        if (!cluster) { fail('Please specify an AKS cluster.'); return; }
        // Capture the cluster's OWN resource group from discovery, independent of
        // the editable RG combo above, so the AKS Cluster Admin grant is scoped to
        // the cluster's real path even if the deployment RG differs. Empty for a
        // custom-typed cluster that never came from discovery.
        clusterResourceGroup = findAzureClusterResourceGroup(cluster);
    } else {
        cluster = getComboValue('aws-cluster-select', 'aws-cluster-custom');
        namespace = getComboValue('aws-namespace-select', 'aws-namespace-custom') || 'default';
        vpc = getComboValue('aws-vpc-select', 'aws-vpc-custom');
        subnets = getComboValue('aws-subnets-select', 'aws-subnets-custom');
        if (!cluster) { fail('Please specify an EKS cluster.'); return; }
    }

    btn.textContent = 'Creating environment…';
    btn.disabled = true;
    statusEl.style.display = 'none';
    var staleWarn = document.getElementById('env-warning-banner');
    if (staleWarn) staleWarn.style.display = 'none';
    var label = providerLabel(provider);
    // The panel and the operation record own the narration now; this only has to
    // say what went wrong. The panel is deliberately left on screen with its step
    // history intact — collapsing a twenty-five step operation into one red
    // sentence is what destroyed the context before.
    //
    // The message goes to the landing's error banner, not the form's status line:
    // by the time this runs the user is on the landing, and the form's status
    // element is hidden, so writing there would say nothing at all.
    function failEnv(msg) {
        stopEnvProgress();
        btn.textContent = 'Create Environment'; btn.disabled = false;
        statusEl.style.display = 'none';
        var panel = document.getElementById('env-progress-panel');
        if (panel) {
            panel.classList.remove('env-progress--done');
            panel.classList.add('env-progress--failed');
            var activityEl = document.getElementById('env-progress-activity');
            if (activityEl) activityEl.textContent = msg;
            var detailsEl = document.getElementById('env-progress-details');
            if (detailsEl) detailsEl.open = true;
        }
        showEnvError(msg);
    }
    if (provider === 'azure' && (!(selectedProfile.subscriptionId || '').trim() || !(selectedProfile.tenantId || '').trim())) {
        // Still a form-level error, so it belongs on the form, which is still on
        // screen: nothing has started yet.
        btn.textContent = 'Create Environment'; btn.disabled = false;
        fail('The selected profile needs both a tenant ID and subscription ID. Edit the profile before creating the environment.');
        return;
    }

    // Everything below mutates cloud and GitHub state, so this is the moment the
    // operation begins. Show the landing now: creation takes minutes, and the
    // user should be free to watch the panel, look at the graph, or leave
    // entirely — the record on the server is what lets them come back to any of
    // it.
    showEnvLanding();
    hideEnvTerminalBanners();
    renderEnvProgress({
        summary: 'Creating ' + env + '…', provider: provider, environment: env,
        stages: [], steps: [], terminalState: null, failure: null, startedAt: new Date().toISOString(),
    });
    focusEnvProgressPanel();

    var appNameEl = document.getElementById('az-app-name-input');
    var selectedAppId = (document.getElementById('az-selected-app-id') || {}).value || '';
    var envData = {
            repo: targetRepo,
            environment: env,
            provider: provider,
            cluster: cluster,
            namespace: namespace,
            profileName: selectedProfile.name,
            origin: 'environment',
            resumeTarget: { page: 'planned', repo: targetRepo, branch: CTX_BRANCH },
            resumeBranch: CTX_BRANCH,
            resumeReason: 'View planned graph'
    };
    envData.branch = (document.getElementById('deploy-branch-select') || {}).value || 'main';
    if (provider === 'azure') {
        envData.clientId = document.getElementById('az-client-id').value.trim();
        envData.tenantId = selectedProfile.tenantId || '';
        envData.subscriptionId = selectedProfile.subscriptionId || '';
        envData.resourceGroup = resourceGroup;
        envData.clusterResourceGroup = clusterResourceGroup;
        envData.appName = appNameEl ? appNameEl.value.trim() : '';
        envData.appId = selectedAppId;
    } else {
        envData.roleArn = selectedProfile.roleArn || '';
        envData.region = selectedProfile.region || '';
        envData.accountId = selectedProfile.accountId || '';
        envData.vpcId = vpc; envData.subnetIds = subnets;
    }
    fetch('/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envData) })
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
            .then(function(startResult) {
                var envResult = startResult.d || {};
                if (envResult.error) {
                    stopEnvProgress();
                    btn.textContent = 'Create Environment'; btn.disabled = false;
                    statusEl.style.display = 'none';
                    syncEnvFailureOperation(envResult)
                        .then(function(rendered) {
                            if (!rendered) failEnv('Environment setup failed: ' + envResult.error);
                        });
                    return;
                }
                envProgressTimer = setTimeout(function() {
                    trackEnvProgress(targetRepo, env, provider, function(finished) {
                        applyEnvTerminal(finished);
                    });
                }, 0);
            })
    .catch(function(err) {
        stopEnvProgress();
        btn.textContent = 'Create Environment'; btn.disabled = false;
        statusEl.style.display = 'none';
        syncEnvFailureOperation(err)
            .then(function(rendered) {
                if (!rendered) failEnv('Failed: ' + (err.message || 'unknown error'));
            });
    });
});
`;
