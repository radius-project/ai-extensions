---
"radius": patch
---

Don't dispatch credential verification during environment creation when the
required cloud credentials are incomplete. The create-environment operation now
finishes as `action_required` with the reason (and the response carries a
distinct `verifySkipped`/`verifySkipReason` signal), so the canvas lands on the
environments list immediately and surfaces guidance — instead of spinning until
the verify timeout and then showing a misleading failure. Also adds a
"No subscriptions found" explainer to the verify-status failure path, collapsed
with the existing OIDC explainer to a single first match so the raw-error
separator is never emitted twice.
