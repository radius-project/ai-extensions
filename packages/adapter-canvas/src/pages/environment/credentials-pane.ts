// Canvas adapter — markup for the Credentials sub-tab of the environment page:
// the credential profile table plus the host the shared credential form docks
// into when an existing profile is edited.
//
// Creating a profile is no longer a standalone flow: "New Credential Profile"
// hands off to step 1 of the New Environment wizard, because a credential only
// ever exists in service of an environment. The listing stays here so existing
// profiles can still be edited and deleted.

import { credentialFormMarkup } from "./credential-form.js";

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

<!-- Home of the shared credential form. The wizard borrows this node into
     #env-cred-form-host and returns it here, so the form exists exactly once
     and its element IDs stay unique in the document. -->
<div id="cred-form" style="display:none;">
${credentialFormMarkup()}
</div>
</section>`;
}
