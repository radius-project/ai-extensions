// Canvas adapter — inline browser script for the two-step New Environment
// wizard: step transitions, the credential form's docking between the wizard
// and the Credentials sub-tab, and the step 1 → step 2 gate.
//
// The credential form exists once in the document. Step 1 borrows it into
// #env-cred-form-host; editing an existing profile returns it to #cred-form on
// the Credentials sub-tab. Moving the single node keeps every credential field
// ID unique, so the credential script addresses them by ID from either host.

export const ENVIRONMENT_WIZARD_CLIENT_JS = `// ============================ Environment wizard ============================
// 'wizard' while the credential form is docked in step 1, 'standalone' while it
// is docked on the Credentials sub-tab for an edit. Drives the form's title,
// button labels, and what saving or cancelling returns to.
var CRED_FORM_CONTEXT = 'wizard';

function moveCredFormTo(hostId) {
    var card = document.getElementById('cred-form-card');
    var host = document.getElementById(hostId);
    if (!card || !host || card.parentNode === host) return;
    host.appendChild(card);
}

function setWizardStepState(stepId, state) {
    var el = document.getElementById(stepId);
    if (!el) return;
    el.classList.toggle('rad-wizard__step--active', state === 'active');
    el.classList.toggle('rad-wizard__step--done', state === 'done');
    if (state === 'active') el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
}

function showEnvWizardStep(step) {
    var isTwo = step === 2;
    var one = document.getElementById('env-step-credentials');
    var two = document.getElementById('env-step-details');
    if (one) one.style.display = isTwo ? 'none' : '';
    if (two) two.style.display = isTwo ? '' : 'none';
    setWizardStepState('env-wizard-step-1', isTwo ? 'done' : 'active');
    setWizardStepState('env-wizard-step-2', isTwo ? 'active' : 'todo');
}

// Step 2 is reachable only with a credential profile selected, because every
// later step (deploy identity, resource discovery, the OIDC trust) is derived
// from the profile's provider and subscription.
function updateEnvStep1State() {
    var next = document.getElementById('env-step1-next');
    var hint = document.getElementById('env-step1-hint');
    var ready = !!(envProfileSelect && envProfileSelect.value);
    if (next) next.disabled = !ready;
    if (hint) hint.style.display = ready ? 'none' : '';
}

function renderEnvProfileSummary(profile) {
    var summary = document.getElementById('env-profile-summary');
    if (!summary) return;
    summary.textContent = profile ?
        profile.name + ' (' + providerLabel(profile.provider) + ')' :
        'No credential profile selected';
}

// --- Credential form hosting ---------------------------------------------
// Creating a profile inside the wizard: swap the step 1 card for the form.
function startCredentialCreation(profile) {
    CRED_FORM_CONTEXT = 'wizard';
    showEnvWizardStep(1);
    moveCredFormTo('env-cred-form-host');
    var stepCard = document.getElementById('env-step-credentials-card');
    if (stepCard) stepCard.style.display = 'none';
    var host = document.getElementById('env-cred-form-host');
    if (host) host.style.display = '';
    if (credForm) credForm.style.display = 'none';
    showCredForm(profile);
}

// Leave the in-wizard credential form and return the node to its home so the
// Credentials sub-tab can host it for an edit without a stale parent.
function endCredentialCreation() {
    var host = document.getElementById('env-cred-form-host');
    if (host) host.style.display = 'none';
    var stepCard = document.getElementById('env-step-credentials-card');
    if (stepCard) stepCard.style.display = '';
    moveCredFormTo('cred-form');
    if (credForm) credForm.style.display = 'none';
    CRED_FORM_CONTEXT = 'wizard';
}

// Creating or editing a profile from the Credentials sub-tab. Both are
// credential management rather than environment creation, so the form stays on
// that sub-tab and saving returns to its listing.
function showStandaloneCredForm(profile) {
    CRED_FORM_CONTEXT = 'standalone';
    moveCredFormTo('cred-form');
    // The wizard may have been mid-creation when the user came here; restore
    // its step 1 card so returning to it does not show an empty step.
    var host = document.getElementById('env-cred-form-host');
    if (host) host.style.display = 'none';
    var stepCard = document.getElementById('env-step-credentials-card');
    if (stepCard) stepCard.style.display = '';
    if (credLanding) credLanding.style.display = 'none';
    if (credForm) credForm.style.display = '';
    showCredForm(profile);
}

var envStep1Next = document.getElementById('env-step1-next');
if (envStep1Next) envStep1Next.addEventListener('click', function() {
    if (!envProfileSelect || !envProfileSelect.value) return;
    showEnvWizardStep(2);
    if (envNameInput) envNameInput.focus();
});
var envStep2Back = document.getElementById('env-step2-back');
if (envStep2Back) envStep2Back.addEventListener('click', function() { showEnvWizardStep(1); });
var envChangeProfile = document.getElementById('env-change-profile-link');
if (envChangeProfile) envChangeProfile.addEventListener('click', function() { showEnvWizardStep(1); });`;
