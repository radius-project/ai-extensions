---
"radius": patch
---

Surface a manual subscription-role grant command during environment creation on
the manual-credentials path. When Azure credentials are complete, the
create-environment flow now shows the exact `az role assignment create` command
(scoped to the resource group when one is configured, otherwise the
subscription) so the operator can grant the configured identity a
subscription-visible role if credential verification fails at Azure Login with
"No subscriptions found" (issue #280). The command is shown, not run, because
the app registration may be shared or owned by another team.
