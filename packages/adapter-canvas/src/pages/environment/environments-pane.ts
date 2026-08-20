// Canvas adapter — markup for the Environments sub-tab of the environment
// page: the environment table, the creation form, and the operation progress
// and failure panels the client script drives.

import { escapeHtml } from "../../shared.js";

export interface EnvironmentsPaneOptions {
  activeSubtab: string;
  envName: string;
  ctxRepo: string;
  deployDefaultBranch: string;
}

export function environmentsPaneMarkup(
  options: EnvironmentsPaneOptions
): string {
  const { activeSubtab, envName, ctxRepo, deployDefaultBranch } = options;
  return `<!-- ══════════════ ENVIRONMENTS SUBTAB ══════════════ -->
<section id="pane-environments" style="${
    activeSubtab === "environments" ? "" : "display:none;"
  }">
<p class="rad-lede" style="margin-bottom:20px;">An Environment defines where applications are deployed, i.e. a landing zone for applications. Deploy your application into an environment to run it with a specific infrastructure configuration.</p>

<!-- Landing: New Environment button + environments table -->
<div id="env-landing">
  <div id="env-success-banner" role="status" style="display:none;">
    <span class="env-success-banner__check" aria-hidden="true">✓</span>
    <span id="env-success-banner-text" class="env-success-banner__text"></span>
    <button type="button" id="env-success-banner-close" class="env-success-banner__close" aria-label="Dismiss">×</button>
  </div>
  <div id="env-error-banner" role="alert" style="display:none;">
    <span class="env-error-banner__icon" aria-hidden="true">⚠</span>
    <span id="env-error-banner-text" class="env-error-banner__text"></span>
    <button type="button" id="env-error-banner-close" class="env-error-banner__close" aria-label="Dismiss">×</button>
  </div>
  <div id="env-warning-banner" role="status" style="display:none;">
    <span class="env-warning-banner__icon" aria-hidden="true">⚠</span>
    <span id="env-warning-banner-text" class="env-warning-banner__text"></span>
    <button type="button" id="env-warning-banner-close" class="env-warning-banner__close" aria-label="Dismiss">×</button>
  </div>
  <!-- "Ready, action required": the pull-request path, which is neither success
       nor failure. Setup completed, but the workflows landed on a branch, so
       credential verification cannot run until the PR merges. -->
  <div id="env-action-banner" role="status" style="display:none;">
    <span class="env-action-banner__icon" aria-hidden="true">→</span>
    <span id="env-action-banner-text" class="env-action-banner__text"></span>
    <button type="button" id="env-action-banner-close" class="env-action-banner__close" aria-label="Dismiss">×</button>
  </div>
  <!-- Progress panel. This replaced a full-screen blocking overlay that showed a
       spinner and the words "This may take a few moments" for up to eight
       minutes. It is inline and non-blocking on purpose: the operation runs for
       minutes, and trapping the user behind a modal for that long is the one
       thing every comparable product avoids. It lives on the environments
       landing, above the table the operation will eventually add a row to.

       No percentage. The step count varies with branching — credentials are
       skipped when they already exist, verification never runs on the pull
       request path — so any percentage would be derived from an assumed shape.
       Stage, current step and elapsed time are honest and sufficient. -->
  <div id="env-progress-panel" style="display:none;" role="region" aria-label="Environment setup progress" tabindex="-1">
    <div class="env-progress__head">
      <div class="env-progress__spinner" aria-hidden="true"></div>
      <div class="env-progress__headtext">
        <div id="env-progress-title" class="env-progress__title"></div>
        <div id="env-progress-headline-note" class="env-progress__headline-note" style="display:none;"></div>
        <div id="env-progress-activity" class="env-progress__activity" role="status" aria-live="polite"></div>
      </div>
      <div id="env-progress-elapsed" class="env-progress__elapsed" aria-label="Elapsed time"></div>
    </div>
    <ol id="env-progress-stages" class="env-progress__stages"></ol>
    <div id="env-progress-failure" class="env-progress__failure" style="display:none;" role="alert">
      <div id="env-progress-failure-title" class="env-progress__failure-title">Setup didn’t finish</div>
      <div id="env-progress-failure-message" class="env-progress__failure-copy"></div>
      <div id="env-progress-cleanup-status" class="env-progress__failure-copy"></div>
      <div id="env-progress-retry" class="env-progress__failure-copy"></div>
      <div id="env-progress-cleanup-warnings-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Cleanup warnings / manual guidance</div>
        <ul id="env-progress-cleanup-warnings" class="env-progress__failure-list"></ul>
      </div>
    </div>
    <!-- Server-projected commands. The page renders whatever the operation
         record says is allowed; it never re-derives eligibility itself. The
         forward action comes first and the destructive one second, and neither
         is a default: the customer chooses whether to finish the environment or
         abandon it. -->
    <div id="env-progress-commands" class="env-progress__commands" role="group" aria-label="Environment setup controls" style="display:none;">
      <div id="env-progress-command-buttons" class="env-progress__command-buttons"></div>
      <div id="env-progress-command-note" class="env-progress__command-note"></div>
      <!-- Why a path the customer might expect is missing. Silence reads as a
           bug, so every refusal that a customer can reach gets a sentence. -->
      <ul id="env-progress-command-guidance" class="env-progress__command-guidance" style="display:none;"></ul>
      <div id="env-progress-command-status" class="env-progress__command-status" role="status" aria-live="polite"></div>
      <div id="env-progress-command-error" class="env-progress__command-error" role="alert"></div>
    </div>
    <details id="env-progress-details" class="env-progress__details">
      <summary>Show details</summary>
      <ol id="env-progress-steps" class="env-progress__steps"></ol>
      <!-- Resource inventory stays inside Details while work is active. The
           renderer exposes it only for a terminal decision state — a stopped or
           partially failed attempt the customer must continue or roll back. A
           running rollback, a finished rollback, and a successful setup have no
           such decision left, so it stays hidden for all three. -->
      <div id="env-progress-state" class="env-progress__state" style="display:none;">
        <div class="env-progress__failure-title">What exists right now</div>
        <div id="env-progress-state-created-block" class="env-progress__failure-block" style="display:none;">
          <div class="env-progress__failure-label">Created by Radius and still present</div>
          <ul id="env-progress-state-created" class="env-progress__failure-list"></ul>
        </div>
        <div id="env-progress-state-retained-block" class="env-progress__failure-block" style="display:none;">
          <div class="env-progress__failure-label">Created by Radius and available to roll back</div>
          <ul id="env-progress-state-retained" class="env-progress__failure-list"></ul>
        </div>
        <div id="env-progress-state-reused-block" class="env-progress__failure-block" style="display:none;">
          <div class="env-progress__failure-label">Reused — not created by this attempt</div>
          <ul id="env-progress-state-reused" class="env-progress__failure-list"></ul>
        </div>
        <div id="env-progress-state-cleaned-block" class="env-progress__failure-block" style="display:none;">
          <div class="env-progress__failure-label">Removed or already absent</div>
          <ul id="env-progress-state-cleaned" class="env-progress__failure-list"></ul>
        </div>
        <div id="env-progress-state-manual-block" class="env-progress__failure-block" style="display:none;">
          <div class="env-progress__failure-label">Needs an action from you</div>
          <ul id="env-progress-state-manual" class="env-progress__failure-list"></ul>
        </div>
      </div>
    </details>
    <!-- Bottom action row, below the details disclosure. The way out of the
         panel lives here rather than beside the setup decisions: Exit setup is
         a server command that closes the record and removes what this attempt
         created, and the acknowledgement an already-settled outcome closes on
         sits next to it. -->
    <div id="env-progress-actions" class="env-progress__actions" style="display:none;">
      <div id="env-progress-bottom-buttons" class="env-progress__bottom-buttons"></div>
      <button type="button" id="env-progress-dismiss" class="rad-btn rad-btn--secondary" aria-label="Dismiss completed environment setup progress">Dismiss</button>
    </div>
  </div>
  <!-- Rollback confirmation. Removing cloud resources cannot be undone, so the
       destructive command is confirmed against a server-projected preview that
       names exactly what goes and exactly what stays. The lists are filled from
       the operation record; nothing here is reconstructed in the browser. -->
  <div id="env-rollback-modal" role="dialog" aria-modal="true" aria-labelledby="env-rollback-title" aria-describedby="env-rollback-intro" style="display:none; position:fixed; inset:0; z-index:1004; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
    <div class="env-rollback__panel">
      <div id="env-rollback-title" class="env-rollback__title" tabindex="-1">Roll back resources created by this setup?</div>
      <div id="env-rollback-intro" class="env-rollback__intro">Radius removes only the resources it proved it created before the workflows were committed. This cannot be undone.</div>
      <div id="env-rollback-remove-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Radius will remove</div>
        <ul id="env-rollback-remove" class="env-progress__failure-list"></ul>
      </div>
      <div id="env-rollback-keep-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Radius will keep</div>
        <ul id="env-rollback-keep" class="env-progress__failure-list"></ul>
      </div>
      <div id="env-rollback-manual-block" class="env-progress__failure-block" style="display:none;">
        <div class="env-progress__failure-label">Needs an action from you</div>
        <ul id="env-rollback-manual" class="env-progress__failure-list"></ul>
      </div>
      <div class="env-rollback__buttons">
        <button type="button" id="env-rollback-cancel" class="rad-btn rad-btn--neutral" style="margin:0;">Keep resources</button>
        <button type="button" id="env-rollback-confirm" class="rad-btn rad-btn--danger" style="margin:0;">Roll back resources</button>
      </div>
    </div>
  </div>
  <button id="new-env-btn" class="rad-btn rad-btn--primary" style="margin:0 0 16px;">New Environment</button>
  <div class="rad-table-wrap">
    <table class="rad-table">
      <thead><tr><th>Environment</th><th>Status</th><th>Provider</th><th>Credentials</th><th>Actions</th></tr></thead>
      <tbody id="env-table-body">
        <tr><td colspan="5" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Create Environment wizard (revealed by New Environment / Deploy Apps / edit).
     Two steps, because a credential profile only ever exists in service of an
     environment: pick or create the cloud credential first, then describe the
     environment that uses it. -->
<div id="env-form" style="display:none;">
  <div class="rad-wizard-head">
    <ol class="rad-wizard" id="env-wizard-steps">
      <li class="rad-wizard__step rad-wizard__step--active" id="env-wizard-step-1" data-step="1" aria-current="step">
        <span class="rad-wizard__num">1</span><span class="rad-wizard__label">Cloud credentials</span>
      </li>
      <li class="rad-wizard__sep" aria-hidden="true"></li>
      <li class="rad-wizard__step" id="env-wizard-step-2" data-step="2">
        <span class="rad-wizard__num">2</span><span class="rad-wizard__label">Environment</span>
      </li>
    </ol>
    <button id="cancel-env-btn" type="button" class="rad-link" style="background:none; border:none; padding:0; margin:0; font-size:12px; font-weight:500; cursor:pointer;">← Back to environments</button>
  </div>

  <!-- ── Step 1 · Cloud credentials ── -->
  <div id="env-step-credentials">
    <div class="rad-card" id="env-step-credentials-card">
      <div class="rad-card__title" style="margin:0;">Choose cloud credentials</div>
      <div class="rad-section">
        <div class="rad-section__desc">Select the verified cloud account this environment deploys into, or create a new credential profile for it.</div>
        <div class="rad-field" style="max-width:520px; margin-top:14px;">
          <label>Credential profile</label>
          <div class="rad-combo" id="env-profile-combo">
            <button type="button" class="rad-combo__button" id="env-profile-button" aria-haspopup="listbox" aria-expanded="false">
              <span class="rad-combo__value" id="env-profile-value">Select a credential profile…</span>
              <span class="rad-combo__chevron" aria-hidden="true"></span>
            </button>
            <div class="rad-combo__menu" id="env-profile-menu" role="listbox" style="display:none;">
              <div class="rad-combo__options" id="env-profile-options"></div>
              <div class="rad-combo__empty" id="env-profile-empty" style="display:none;">No credential profiles yet.</div>
              <button type="button" class="rad-combo__action" id="env-create-profile-link">+ Create new profile</button>
            </div>
          </div>
          <!-- Holds the selected profile name; read by the create flow. -->
          <input type="hidden" id="env-profile-select" value="" />
          <div id="env-profile-status" style="margin-top:6px; font-size:13px; line-height:1.6; display:none;"></div>
        </div>
      </div>
      <div class="rad-section" id="env-step1-actions">
        <div style="display:flex; align-items:center; gap:16px;">
          <button id="env-step1-next" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;" disabled>Continue</button>
          <span id="env-step1-hint" style="font-size:12px; color:var(--rad-text-tertiary);">Select or create a credential profile to continue.</span>
        </div>
      </div>
    </div>
    <!-- The shared credential form docks here while the wizard is creating or
         editing a profile; #env-step-credentials-card hides in that mode. -->
    <div id="env-cred-form-host" style="display:none;"></div>
  </div>

  <!-- ── Step 2 · Environment ── -->
  <div id="env-step-details" style="display:none;">
  <div class="rad-card">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <div class="rad-card__title" id="env-step2-title" style="margin:0;">Create Environment</div>
      <button id="env-step2-back" type="button" class="rad-link" style="background:none; border:none; padding:0; margin:0; font-size:12px; font-weight:500; cursor:pointer;">← Back to credentials</button>
    </div>
    <!-- 1 · Name this environment -->
    <div class="rad-section">
      <div class="rad-section__title">1 · Name this environment</div>
      <div class="rad-field" style="max-width:420px;">
        <label for="env-name-input">Environment name</label>
        <input id="env-name-input" type="text" placeholder="e.g. prod, test, eastus-prod" value="${escapeHtml(
          envName
        )}" />
        <div class="rad-field__help" id="env-name-help">The deployment target you'll deploy apps into by name.</div>
      </div>
      <!-- Repository and branch are assumed from the current workspace. -->
      <input type="hidden" id="target-repo" value="${escapeHtml(ctxRepo)}" />
      <input type="hidden" id="deploy-branch-select" value="${escapeHtml(
        deployDefaultBranch || "main"
      )}" />
      <input type="hidden" id="az-client-id" value="" />
      <input type="hidden" id="env-selected-provider" value="" />
    </div>

    <!-- 2 · Connect GitHub to a cloud -->
    <div class="rad-section">
      <div class="rad-section__title">2 · Connect GitHub to a cloud</div>
      <div class="rad-section__desc">Radius wires a passwordless OIDC trust so GitHub Actions can deploy into this environment — no secrets stored in the repo. These are the two ends of that trust, not a choice between them: the cloud credentials are the profile you selected, shown here to confirm.</div>

      <div class="rad-conn">
        <!-- GitHub side of the trust. The account combo is populated by
             loadGitHubIdentity() when the env form opens; it warns when the
             acting account differs from the one the app shows, or lacks the
             workflow scope needed to write the deploy workflow file. -->
        <div class="rad-conn__side">
          <div class="rad-conn__badge">
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            GitHub
          </div>
          <div class="rad-field" id="env-gh-identity-field" style="display:none;">
            <label>GitHub account</label>
            <div class="rad-combo" id="env-gh-account-combo">
              <button type="button" class="rad-combo__button" id="env-gh-account-button" aria-haspopup="listbox" aria-expanded="false">
                <span class="rad-combo__value" id="env-gh-account-value">Detecting…</span>
                <span class="rad-combo__chevron" aria-hidden="true"></span>
              </button>
              <div class="rad-combo__menu" id="env-gh-account-menu" role="listbox" style="display:none;">
                <div class="rad-combo__options" id="env-gh-account-options"></div>
                <div class="rad-combo__empty" id="env-gh-account-empty" style="display:none;">No GitHub accounts detected.</div>
              </div>
            </div>
            <div class="rad-field__help" id="env-gh-account-note" style="margin-top:6px;">Used to create GitHub Environment.</div>
            <div id="env-gh-identity-note" role="status" style="margin-top:8px; font-size:13px; display:none;"></div>
            <div style="display:flex; gap:8px; margin-top:6px;">
              <button type="button" id="env-gh-fix-access" class="rad-btn rad-btn--ghost" style="display:none; font-size:12px; padding:2px 10px;">Show how to fix</button>
              <button type="button" id="env-gh-recheck" class="rad-btn rad-btn--ghost" style="display:none; font-size:12px; padding:2px 10px;">Re-check</button>
            </div>
            <details id="env-gh-details-panel" style="margin-top:8px; font-size:12px;">
              <summary>View technical details</summary>
              <div id="env-gh-technical-details" style="margin-top:6px; line-height:1.5;"></div>
              <div id="env-gh-repair" style="display:none; margin-top:6px; font-family:monospace; overflow-wrap:anywhere;"></div>
            </details>
          </div>
        </div>

        <div class="rad-conn__arrow" aria-hidden="true">→</div>

        <!-- Cloud side of the trust. The profile itself is chosen in step 1;
             this is the read-only confirmation of that choice, with a way back
             to step 1 to change it. -->
        <div class="rad-conn__side">
          <div class="rad-conn__badge">
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 13a3.5 3.5 0 01-.36-6.98A4 4 0 0111.9 6.1 3 3 0 0111.5 13h-7z"/></svg>
            Cloud credentials
          </div>
          <div class="rad-field">
            <label>Credential profile</label>
            <div class="rad-chosen">
              <span class="rad-chosen__value" id="env-profile-summary">No credential profile selected</span>
              <button type="button" class="rad-link" id="env-change-profile-link" style="background:none; border:none; padding:0; margin:0; font-size:12px; font-weight:500; cursor:pointer;">Change</button>
            </div>
            <div id="env-profile-detail" style="margin-top:6px; font-size:13px; line-height:1.6; display:none;"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3 · Deploy identity -->
    <div class="rad-section" id="env-identity-section">
      <div class="rad-section__title">3 · Deploy identity</div>
      <div class="rad-section__desc">The Microsoft Entra app GitHub Actions signs in as — over OIDC, no stored secrets.</div>
      <div class="rad-field" id="env-identity-azure" style="max-width:560px;">
        <label for="az-app-name-input">Azure app registration</label>
        <input id="az-app-name-input" type="text" autocomplete="off" spellcheck="false" placeholder="radius-deploy-owner-repo" value="radius-deploy-${escapeHtml(
          (ctxRepo || "").replace("/", "-")
        )}" data-default-name="radius-deploy-${escapeHtml(
          (ctxRepo || "").replace("/", "-")
        )}" />
        <input type="hidden" id="az-selected-app-id" value="" />
        <div class="rad-field__help">
          Created in your tenant, federated to <code>repo:${escapeHtml(
            ctxRepo
          )}</code>, and granted <strong>Contributor</strong> on the selected resource group below, plus <strong>Azure Kubernetes Service RBAC Cluster Admin</strong> on the target cluster (required for clusters using Azure RBAC for Kubernetes, the default for AKS Automatic). If one already exists, you may
         <a href="#" id="az-use-existing-link">use an existing application…</a>
        </div>
        <div id="az-selected-app-note" style="display:none; font-size:11px; color:var(--rad-info,#0969da); margin-top:4px;"></div>
        <a href="#" id="az-clear-pin-link" style="display:none; font-size:11px; margin-top:2px;">Use a per-repo identity instead</a>
      </div>
      <div class="rad-field__help" id="env-identity-aws" style="display:none;">GitHub Actions assumes the IAM role from your credential profile — no extra identity to configure here.</div>
    </div>

    <!-- 4 · Infrastructure -->
    <div class="rad-section" id="env-infra-section">
      <div class="rad-section__title">4 · Infrastructure</div>
      <div class="rad-section__desc">Configure the compute infrastructure for your environment.</div>

      <!-- Azure infra -->
      <div id="panel-azure">
        <div style="display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin:8px 0;">
          <div id="azure-discover-status" style="font-size:12px; color:var(--rad-text-tertiary);">Select a credential profile to discover resources.</div>
          <button type="button" id="azure-refresh-btn" class="rad-btn rad-btn--ghost" style="font-size:12px; padding:2px 10px;" disabled>↻ Refresh</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">
          <div class="rad-field">
            <label for="azure-rg-select">Resource Group</label>
            <select id="azure-rg-select"><option value="" disabled selected>Loading…</option></select>
            <input id="azure-rg-custom" type="text" aria-label="Resource Group (custom)" placeholder="Enter resource group" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label for="azure-cluster-select">Cluster</label>
            <select id="azure-cluster-select"><option value="" disabled selected>Loading…</option></select>
            <input id="azure-cluster-custom" type="text" aria-label="Cluster (custom)" placeholder="Enter cluster name" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label for="azure-namespace-select">Namespace</label>
            <select id="azure-namespace-select"><option value="" disabled selected>Loading…</option></select>
            <input id="azure-namespace-custom" type="text" aria-label="Namespace (custom)" placeholder="Enter namespace" style="display:none; margin-top:4px;" />
          </div>
        </div>
      </div>

      <!-- AWS infra -->
      <div id="panel-aws" style="display:none;">
        <div style="display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin:8px 0;">
          <div id="aws-discover-status" style="font-size:12px; color:var(--rad-text-tertiary);">Select a credential profile to discover resources.</div>
          <button type="button" id="aws-refresh-btn" class="rad-btn rad-btn--ghost" style="font-size:12px; padding:2px 10px;" disabled>↻ Refresh</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="rad-field">
            <label for="aws-cluster-select">EKS Cluster</label>
            <select id="aws-cluster-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-cluster-custom" type="text" aria-label="EKS Cluster (custom)" placeholder="Enter cluster name" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label for="aws-namespace-select">Namespace</label>
            <select id="aws-namespace-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-namespace-custom" type="text" aria-label="Namespace (custom)" placeholder="Enter namespace" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label for="aws-vpc-select">VPC</label>
            <select id="aws-vpc-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-vpc-custom" type="text" aria-label="VPC (custom)" placeholder="vpc-xxxxxxxx" style="display:none; margin-top:4px;" />
          </div>
          <div class="rad-field">
            <label for="aws-subnets-select">Subnets</label>
            <select id="aws-subnets-select"><option value="" disabled selected>Loading…</option></select>
            <input id="aws-subnets-custom" type="text" aria-label="Subnets (custom)" placeholder="subnet-xxx,subnet-yyy" style="display:none; margin-top:4px;" />
          </div>
        </div>
      </div>
    </div>

    <div id="deploy-status" style="margin-top:12px; display:none;"></div>

    <div class="rad-section">
      <button id="deploy-btn" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;" disabled>Create Environment</button>
    </div>
  </div>
  </div>
</div>
</section>`;
}
