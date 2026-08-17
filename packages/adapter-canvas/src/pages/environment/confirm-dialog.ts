// Canvas adapter — the Environments page's destructive-action confirmation
// dialog. Deleting an environment or a credential profile both route through
// this one modal so the two flows cannot describe the same class of action with
// different weight. Every text slot is filled from JS via textContent, so the
// markup carries no interpolated values.

export function confirmDialogMarkup(): string {
  return `<div id="env-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="env-confirm-title" style="display:none; position:fixed; inset:0; z-index:1004; background:rgba(0,0,0,0.45); align-items:center; justify-content:center;">
  <div style="background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 30px var(--rad-shadow); padding:22px 26px; max-width:480px; width:90%; max-height:80vh; overflow:auto;">
    <div id="env-confirm-title" style="font-size:16px; font-weight:600; line-height:1.4; margin-bottom:8px;"></div>
    <div id="env-confirm-message" style="font-size:13px; color:var(--rad-text-tertiary); line-height:1.5; white-space:pre-wrap;"></div>
    <div id="env-confirm-usage" style="display:none; margin-top:12px; padding:10px 12px; border-radius:8px; background:var(--rad-warning-bg); border:1px solid var(--rad-warning);">
      <div id="env-confirm-usage-label" style="font-size:13px; color:var(--rad-text); line-height:1.4;"></div>
      <ul id="env-confirm-usage-list" style="margin:6px 0 0; padding-left:20px; font-size:13px; color:var(--rad-text); line-height:1.5;"></ul>
    </div>
    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
      <button id="env-confirm-cancel" type="button" class="rad-btn rad-btn--neutral" style="margin:0;">Cancel</button>
      <button id="env-confirm-ok" type="button" class="rad-btn rad-btn--danger-outline" style="margin:0;"></button>
    </div>
  </div>
</div>`;
}
