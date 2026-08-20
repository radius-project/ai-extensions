---
"radius": patch
---

Don't dispatch credential verification during environment creation while a
just-granted Azure role assignment is still propagating. When setup created a
subscription-visible role for this environment's service principal, the
operation now finishes as `action_required` with the
`azure-rbac-propagation` reason and guidance to verify again from the
environments list, instead of dispatching a verify run that fails with
"No subscriptions found" before RBAC has propagated.
