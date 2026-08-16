// Canvas adapter — markup for the Credentials sub-tab of the environment page:
// the credential profile table and the Azure/AWS verification form.

export function credentialsPaneMarkup(activeSubtab: string): string {
  return `<!-- ══════════════ CREDENTIALS SUBTAB ══════════════ -->
<section id="pane-credentials" style="${
    activeSubtab === "credentials" ? "" : "display:none;"
  }">
<p class="rad-lede" style="margin-bottom:20px;">Configure and manage the credentials needed to connect to your cloud account. Each environment requires credentials to deploy infrastructure.</p>

<div id="cred-landing">
  <div id="cred-success-banner" class="rad-cred-banner" role="status" style="display:none;">
    <span class="rad-cred-banner__check" aria-hidden="true">✓</span>
    <span id="cred-success-banner-text" class="rad-cred-banner__text"></span>
    <button type="button" id="cred-success-banner-close" class="rad-cred-banner__close" aria-label="Dismiss">×</button>
  </div>
  <button id="new-cred-btn" class="rad-btn rad-btn--primary" style="margin:0 0 16px;">New Credential Profile</button>
  <div class="rad-table-wrap">
    <table class="rad-table">
      <thead><tr><th>Profile Name</th><th>Provider</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody id="cred-table-body">
        <tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading credential profiles…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div id="cred-form" style="display:none;">
  <div class="rad-card">
    <div class="rad-card__title" style="margin:0 0 8px;">Create Credential Profile</div>
    <div class="rad-section">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <div class="rad-field">
          <label>Profile Name</label>
          <input id="cred-name-input" type="text" placeholder="e.g. azure-production" />
        </div>
        <div class="rad-field">
          <label>Provider</label>
          <div class="rad-select-wrap" style="display:block;">
            <select id="cred-provider-select" style="width:100%; min-width:0;">
              <option value="azure">Azure</option>
              <option value="aws">AWS</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="rad-section" id="cred-ghcr-section">
      <div class="rad-section__title">GitHub Packages access</div>
      <div class="rad-section__desc">Radius stores deployment state in a private GHCR package. Verify that the active GitHub account can publish packages before saving this profile.</div>
      <div id="cred-ghcr-status" style="margin-top:12px; font-size:13px; color:var(--rad-text-tertiary);">Checking GitHub Packages access…</div>
      <div id="cred-ghcr-command-row" style="display:none; margin-top:10px; align-items:center; gap:8px; background:var(--rad-code-bg); border:1px solid var(--rad-stroke); border-radius:6px; padding:8px 10px;">
        <code id="cred-ghcr-command" style="flex:1; font-family:var(--font-mono, monospace); font-size:12px; color:var(--rad-text); white-space:pre-wrap; overflow-wrap:anywhere;"></code>
        <button type="button" id="cred-ghcr-copy" class="rad-btn rad-btn--neutral" style="margin:0; padding:2px 10px; font-size:12px; flex:none;">Copy command</button>
      </div>
      <button type="button" id="cred-ghcr-retry" class="rad-btn rad-btn--neutral" style="display:none; margin:10px 0 0;">I’ve updated permissions — retry</button>
    </div>

    <!-- Azure account -->
    <div id="cred-panel-azure" class="rad-section">
      <div class="rad-section__title">Account</div>
      <div class="rad-section__desc">Enter your Azure tenant and subscription, then verify your CLI login to ensure you have the necessary credentials.</div>
      <div class="rad-field" style="margin-top:14px;">
        <label>Tenant ID</label>
        <input id="az-tenant-id" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </div>
      <div class="rad-field" style="margin-top:14px;">
        <label>Subscription ID</label>
        <input id="az-sub-id" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </div>
      <button id="btn-verify-azure" class="rad-btn rad-btn--primary" style="margin-top:16px;">Verify Credentials</button>
    </div>

    <!-- AWS account -->
    <div id="cred-panel-aws" class="rad-section" style="display:none;">
      <div class="rad-section__title">Account</div>
      <div class="rad-section__desc">Enter your AWS account details, then verify your CLI login to ensure you have the necessary credentials.</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px;">
        <div class="rad-field"><label>Account ID</label><input id="aws-account-id" type="text" placeholder="123456789012" /></div>
        <div class="rad-field"><label>Region</label><input id="aws-region" type="text" placeholder="us-east-1" /></div>
      </div>
      <div class="rad-field" style="margin-top:14px;"><label>Role ARN (optional)</label><input id="aws-role-arn" type="text" placeholder="arn:aws:iam::123456789012:role/radius-deploy" /></div>
      <button id="btn-verify-aws" class="rad-btn rad-btn--primary" style="margin-top:16px;">Verify Credentials</button>
    </div>

    <div id="cred-verify-status" class="rad-verified-line" style="margin-top:14px; display:none;"></div>

    <div class="rad-section">
      <div id="cred-verify-hint" style="font-size:13px; color:var(--rad-text-tertiary); padding:12px 14px; background:var(--rad-bg-subtle); border-radius:8px; margin-bottom:16px;">Verify your credentials above to continue profile setup.</div>
      <div style="display:flex; align-items:center; gap:16px;">
        <button id="save-cred-btn" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;" disabled>Save Credential Profile</button>
        <button id="cancel-cred-btn" type="button" class="rad-link" style="background:none; border:none; padding:0; font-size:12px; font-weight:500; cursor:pointer;">← Back to credentials</button>
      </div>
    </div>
  </div>
</div>
</section>`;
}
