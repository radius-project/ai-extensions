// Canvas adapter — inline browser script for environment setup operations:
// progress checklist, elapsed time, failure cards, resume, and terminal state.

export const ENVIRONMENT_OPERATION_CLIENT_JS = `function formatElapsed(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

var ENV_STAGE_GLYPH = { pending: '○', running: '◐', succeeded: '✓', warning: '⚠', failed: '✗', skipped: '–' };

function setFailureList(items, listId, blockId) {
    var list = document.getElementById(listId);
    var block = document.getElementById(blockId);
    if (!list || !block) return;
    list.innerHTML = '';
    if (!items || !items.length) {
        block.style.display = 'none';
        return;
    }
    items.forEach(function(item) {
        var li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
    });
    block.style.display = '';
}

function renderEnvFailureCard(op) {
    var card = document.getElementById('env-progress-failure');
    var messageEl = document.getElementById('env-progress-failure-message');
    var cleanupEl = document.getElementById('env-progress-cleanup-status');
    var retryEl = document.getElementById('env-progress-retry');
    if (!card || !messageEl || !cleanupEl || !retryEl) return;
    var failed = op && (op.terminalState === 'failed' || op.terminalState === 'failed_partial');
    if (!failed) {
        card.style.display = 'none';
        return;
    }

    var cleanup = op.cleanup || {};
    var retry = cleanup.retry || {};
    var removed = (cleanup.removed || []).map(function(entry) {
        return entry && entry.target ? entry.target : '';
    }).filter(Boolean);
    var retained = (cleanup.retained || []).map(function(entry) {
        return entry && entry.target ? entry.target : '';
    }).filter(Boolean);
    var warnings = (cleanup.warnings || []).filter(Boolean);
    var cleanupStatus = cleanup.state === 'running' ? 'Cleanup is still running.' :
        cleanup.state === 'pending' ? 'Cleanup has not started yet.' :
        cleanup.rollbackBeforeCommit === false ? 'Cleanup stopped at the commit point, so reusable artifacts were left in place.' :
        cleanup.state === 'succeeded_with_warnings' ? 'Cleanup finished with warnings.' :
        cleanup.state === 'succeeded' ? 'Cleanup finished.' :
        'Cleanup was not needed.';

    messageEl.textContent = op.failure && op.failure.message ? op.failure.message : 'The setup request failed.';
    cleanupEl.textContent = cleanupStatus;
    retryEl.textContent = retry.guidance ? ('Retry starts cleanly: ' + (retry.startsCleanly ? 'Yes' : 'No') + '. ' + retry.guidance) : '';
    setFailureList(removed, 'env-progress-cleanup-removed', 'env-progress-cleanup-removed-block');
    setFailureList(retained, 'env-progress-cleanup-retained', 'env-progress-cleanup-retained-block');
    setFailureList(warnings, 'env-progress-cleanup-warnings', 'env-progress-cleanup-warnings-block');
    card.style.display = '';
}

function renderEnvProgress(op) {
    var panel = document.getElementById('env-progress-panel');
    if (!panel) return;
    if (!op) {
        panel.style.display = 'none';
        renderEnvFailureCard(null);
        return;
    }
    panel.style.display = '';
    panel.classList.toggle('env-progress--done', op.terminalState === 'succeeded' || op.terminalState === 'succeeded_with_warnings' || op.terminalState === 'action_required');
    panel.classList.toggle('env-progress--failed', op.terminalState === 'failed' || op.terminalState === 'failed_partial');

    document.getElementById('env-progress-title').textContent = op.summary || '';

    // The current step doubles as the activity line. When the record has nothing
    // to say we clear it rather than substitute filler.
    var activity = '';
    for (var i = op.steps.length - 1; i >= 0; i--) {
        if (op.steps[i].state === 'running') { activity = op.steps[i].label; break; }
    }
    if (!activity && op.steps.length) activity = op.steps[op.steps.length - 1].label;
    if (op.currentStage === 'verify' && envVerifyActivity && !op.terminalState) {
        activity = 'Verifying credentials — ' + envVerifyActivity;
    }
    if (op.failure && op.failure.message) activity = op.failure.message;
    document.getElementById('env-progress-activity').textContent = activity;

    var stagesEl = document.getElementById('env-progress-stages');
    stagesEl.innerHTML = '';
    op.stages.forEach(function(stage) {
        var li = document.createElement('li');
        li.className = 'env-progress__stage env-progress__stage--' + stage.state;
        var glyph = document.createElement('span');
        glyph.className = 'env-progress__glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = ENV_STAGE_GLYPH[stage.state] || '○';
        var label = document.createElement('span');
        // The glyph is decorative, so the state has to reach a screen reader as
        // words. Color and shape alone would not.
        label.textContent = stage.label + ' — ' + stage.state;
        li.appendChild(glyph);
        li.appendChild(label);
        stagesEl.appendChild(li);
    });

    var stepsEl = document.getElementById('env-progress-steps');
    stepsEl.innerHTML = '';
    op.steps.forEach(function(step) {
        var li = document.createElement('li');
        li.className = 'env-progress__step env-progress__step--' + step.state;
        // Server-built copy, but it still goes in as text: a step label can
        // quote an Azure CLI error, and that is not ours to trust as markup.
        li.textContent = (ENV_STAGE_GLYPH[step.state] || '·') + ' ' + step.label;
        stepsEl.appendChild(li);
    });
    renderEnvFailureCard(op);
    document.getElementById('env-progress-details').style.display = op.steps.length ? '' : 'none';
    var actions = document.getElementById('env-progress-actions');
    var resume = document.getElementById('env-progress-resume');
    var dismiss = document.getElementById('env-progress-dismiss');
    var target = op.journey && op.journey.resumeTarget;
    var canResume = op.terminalState && target && target.page === 'planned' && target.repo;
    if (resume && canResume) {
        var href = '/?page=planned&repo=' + encodeURIComponent(target.repo);
        if (target.branch) href += '&branch=' + encodeURIComponent(target.branch);
        resume.href = href;
        resume.textContent = op.journey.resumeReason || 'View planned graph';
    }
    if (resume) resume.style.display = canResume ? '' : 'none';
    if (dismiss) dismiss.style.display = op.terminalState ? '' : 'none';
    if (actions) actions.style.display = op.terminalState ? 'flex' : 'none';
}

function stopEnvProgress() {
    envVerifyActivity = '';
    if (envProgressTimer) { clearTimeout(envProgressTimer); envProgressTimer = null; }
    if (envProgressElapsedTimer) { clearInterval(envProgressElapsedTimer); envProgressElapsedTimer = null; }
}

function hideEnvProgress() {
    stopEnvProgress();
    var panel = document.getElementById('env-progress-panel');
    if (panel) panel.style.display = 'none';
}

var envProgressDismiss = document.getElementById('env-progress-dismiss');
if (envProgressDismiss) envProgressDismiss.addEventListener('click', function() {
    hideEnvProgress();
});

function focusEnvProgressPanel() {
    var panel = document.getElementById('env-progress-panel');
    if (!panel) return;
    try { panel.focus({ preventScroll: true }); }
    catch (e) { panel.focus(); }
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

function syncEnvFailureOperation(data) {
    var operationId = data && typeof data.operationId === 'string' ? data.operationId : '';
    var url = operationId ? '/api/operations/' + encodeURIComponent(operationId) : '';
    if (!url) return Promise.resolve(false);
    return fetch(url)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(payload) {
            var op = payload && payload.operation;
            if (!op) return false;
            renderEnvProgress(op);
            var detailsEl = document.getElementById('env-progress-details');
            if (detailsEl && (op.terminalState === 'failed' || op.terminalState === 'failed_partial')) {
                detailsEl.open = true;
            }
            var errorBanner = document.getElementById('env-error-banner');
            if (errorBanner) errorBanner.style.display = 'none';
            return true;
        })
        .catch(function() { return false; });
}

// Poll the record for the given repo. Returns nothing — the panel is driven entirely by
// what the server reports, so a caller that also holds the POST promise and this
// poller can never show two different truths.
function trackEnvProgress(repo, environment, provider, onTerminal) {
    stopEnvProgress();
    var startedAtMs = Date.now();
    var observedOperation = false;
    var operationId = '';
    var verifyDispatchedAtMs = 0;
    var verifyDeadlineMs = 45 * 60 * 1000;
    var promptingRequestedAt = '';
    var elapsedEl = document.getElementById('env-progress-elapsed');
    envProgressElapsedTimer = setInterval(function() {
        if (elapsedEl) elapsedEl.textContent = formatElapsed(Date.now() - startedAtMs);
    }, 1000);

    function tick() {
        fetch('/api/operations?repo=' + encodeURIComponent(repo))
            .then(function(r) { return r.json(); })
            .then(function(payload) {
                var op = payload && payload.operation;
                // The registry retains the latest terminal operation for this
                // repository. During the short gap before a new POST registers,
                // that record belongs to the previous environment and must not
                // replace the optimistic panel for the setup just requested.
                if (!observedOperation && op && (op.environment !== environment || op.terminalState)) {
                    envProgressTimer = setTimeout(tick, 1500);
                    return;
                }
                if (!op) {
                    // A just-started setup has not necessarily reached the server
                    // operation registry yet. Verification status is historical
                    // and can still report the previous successful run for this
                    // environment name, so only use it for restart recovery after
                    // this poller has first observed the current operation.
                    if (!observedOperation) {
                        envProgressTimer = setTimeout(tick, 1500);
                        return;
                    }
                    // Verification is tracked separately from the process-local
                    // operation registry. If the extension restarts after
                    // dispatch, the record can disappear while the Actions run
                    // still reaches a terminal result.
                    if (!environment) { envProgressTimer = setTimeout(tick, 1500); return; }
                    fetch('/api/verify-status?repo=' + encodeURIComponent(repo) + '&environment=' + encodeURIComponent(environment) + '&operationId=' + encodeURIComponent(operationId))
                        .then(function(r) { return r.json(); })
                        .then(function(v) {
                            if (v.state === 'expired' || v.terminal) {
                                stopEnvProgress();
                                var expiredActivity = document.getElementById('env-progress-activity');
                                if (expiredActivity) expiredActivity.textContent = v.error || 'Credential verification is no longer being tracked.';
                                return;
                            }
                            if (verifyDispatchedAtMs && Date.now() - verifyDispatchedAtMs > verifyDeadlineMs) {
                                stopEnvProgress();
                                var timedOutActivity = document.getElementById('env-progress-activity');
                                if (timedOutActivity) timedOutActivity.textContent = 'Credential verification exceeded its tracking window. Check the GitHub Actions run before retrying.';
                                return;
                            }
                            if (v.state === 'success') {
                                hideEnvProgress();
                                showEnvSuccessBanner(provider || 'azure', environment);
                                loadEnvTable();
                                return;
                            }
                            if (v.state === 'failed') {
                                stopEnvProgress();
                                var panel = document.getElementById('env-progress-panel');
                                if (panel) {
                                    panel.style.display = 'block';
                                    panel.classList.remove('env-progress--done');
                                    panel.classList.add('env-progress--failed');
                                }
                                var activity = document.getElementById('env-progress-activity');
                                if (activity) activity.textContent = 'Credential verification failed. ' + (v.error || '');
                                var details = document.getElementById('env-progress-details');
                                if (details && v.runUrl) details.textContent = 'View the run: ' + v.runUrl;
                                return;
                            }
                            if (v.activity) envVerifyActivity = v.activity;
                            envProgressTimer = setTimeout(tick, 1500);
                        })
                        .catch(function() { envProgressTimer = setTimeout(tick, 3000); });
                    return;
                }
                observedOperation = true;
                operationId = op.operationId || operationId;
                if (op.verification && op.verification.dispatchedAt) verifyDispatchedAtMs = Number(op.verification.dispatchedAt);
                startedAtMs = new Date(op.startedAt).getTime();
                if (elapsedEl) {
                    elapsedEl.textContent = formatElapsed((op.endedAt ? new Date(op.endedAt).getTime() : Date.now()) - startedAtMs);
                }
                renderEnvProgress(op);
                if (op.terminalState) {
                    stopEnvProgress();
                    if (onTerminal) onTerminal(op);
                    return;
                }
                if (op.state === 'input_required' && op.inputRequired && op.inputRequired.requestedAt !== promptingRequestedAt) {
                    promptingRequestedAt = op.inputRequired.requestedAt;
                    var prompt = op.inputRequired;
                    var answer;
                    if (prompt.code === 'service-management-reference-required') {
                        answer = promptSmr().then(function(smr) {
                            return { serviceManagementReference: smr };
                        });
                    } else if (prompt.code === 'app-selection-required') {
                        answer = showAppPicker({
                            title: 'Choose a deploy identity',
                            intro: 'You own more than one App Registration matching this repository. Choose which identity to use for GitHub Actions deployments, or create a new one.',
                            candidates: (prompt.metadata && prompt.metadata.candidates) || [],
                            defaultAppId: prompt.metadata && prompt.metadata.defaultAppId,
                            allowCreateNew: true
                        }).then(function(choice) {
                            return choice.createNew ? { createNew: true } : { appId: choice.appId };
                        });
                    }
                    if (answer) {
                        answer.then(function(values) {
                            values.checkpoint = prompt.checkpoint;
                            values.repo = repo;
                            values.environment = environment;
                            values.provider = provider;
                            return fetch('/api/operations/' + encodeURIComponent(operationId) + '/resume/' + encodeURIComponent(prompt.code), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(values)
                            }).then(function(response) {
                                if (response.ok) return response;
                                return response.json().catch(function() { return {}; }).then(function(payload) {
                                    var error = new Error(payload.error || payload.message || 'Unable to resume environment setup.');
                                    error.retryPrompt = payload.code !== 'operation-input-expired';
                                    error.operation = payload.operation;
                                    throw error;
                                });
                            });
                        }).then(function() {
                            envProgressTimer = setTimeout(tick, 0);
                        }).catch(function(error) {
                            if (error && error.abandonOperation) {
                                fetch('/api/operations/' + encodeURIComponent(operationId) + '/abandon', { method: 'POST' })
                                    .then(function(response) {
                                        if (!response.ok) {
                                            promptingRequestedAt = '';
                                            throw new Error('Unable to cancel environment setup.');
                                        }
                                        envProgressTimer = setTimeout(tick, 0);
                                    })
                                    .catch(function() { envProgressTimer = setTimeout(tick, 1500); });
                                return;
                            }
                            if (error && error.operation && error.operation.failure && error.operation.failure.code === 'operation-input-expired') {
                                stopEnvProgress();
                                applyEnvTerminal(error.operation);
                                return;
                            }
                            if (error && error.retryPrompt) promptingRequestedAt = '';
                            envProgressTimer = setTimeout(tick, 1500);
                        });
                        return;
                    }
                }
                envProgressTimer = setTimeout(tick, 1500);
            })
            .catch(function() {
                // A dropped poll is routine — the server respawns after an idle
                // reap and the next tick reconnects. Never surface it as failure.
                envProgressTimer = setTimeout(tick, 3000);
            });
    }
    tick();
}

// On load, rejoin an operation that is already running for this repo. This is
// what makes navigating away safe: the user can leave the page mid-setup and
// find the same panel, with the same history, when they come back.
function resumeEnvProgress(repo) {
    if (!repo) return;
    fetch('/api/operations?repo=' + encodeURIComponent(repo))
        .then(function(r) { return r.json(); })
        .then(function(payload) {
            var op = payload && payload.operation;
            if (!op || op.terminalState) return;
            renderEnvProgress(op);
            trackEnvProgress(repo, op.environment || '', op.provider || '', function(finished) { applyEnvTerminal(finished); });
        })
        .catch(function() { /* nothing to resume */ });
}

// One place that turns a terminal record into what the landing shows, so the
// resumed path and the just-clicked path cannot disagree.
function applyEnvTerminal(op) {
    var btn = document.getElementById('deploy-btn');
    if (btn) resetEnvSubmitButton();
    var warnings = op.steps.filter(function(s) { return s.state === 'warning'; })
        .map(function(s) { return '⚠️ ' + s.label; });
    if (op.terminalState === 'action_required') {
        showEnvSetupWarnings(warnings);
        showEnvActionRequired(op.provider, op.environment, op.terminal && op.terminal.pullRequestUrl, op.terminal);
    } else if (op.terminalState === 'succeeded' || op.terminalState === 'succeeded_with_warnings') {
        showEnvSuccessBanner(op.provider, op.environment);
        showEnvSetupWarnings(warnings);
    } else if (op.terminalState === 'cancelled') {
        var cancelledPanel = document.getElementById('env-progress-panel');
        if (cancelledPanel) {
            cancelledPanel.classList.remove('env-progress--done', 'env-progress--failed');
        }
        var cancelledActivity = document.getElementById('env-progress-activity');
        if (cancelledActivity) cancelledActivity.textContent = 'Environment setup cancelled.';
        showEnvSetupWarnings(warnings);
    } else {
        var message = 'Environment setup failed: ' + ((op.failure && op.failure.message) || 'unknown error');
        var panel = document.getElementById('env-progress-panel');
        if (panel) {
            panel.classList.remove('env-progress--done');
            panel.classList.add('env-progress--failed');
        }
        var activityEl = document.getElementById('env-progress-activity');
        if (activityEl) activityEl.textContent = message;
        showEnvError(message);
    }
    loadEnvTable();
}
`;
