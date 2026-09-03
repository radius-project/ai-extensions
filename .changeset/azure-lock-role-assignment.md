---
"radius": patch
---

**Fixed:** Azure environment setup now grants the deploy identity **User Access Administrator** on the target resource group, so recipes that place a resource lock can both create and remove it. The identity previously received only `Contributor`, whose `notActions` exclude `Microsoft.Authorization/*/Write` and `Microsoft.Authorization/*/Delete`; any locked resource therefore failed to delete with `AuthorizationFailed` and left the lock — and everything it protected — orphaned in the subscription. The grant is best-effort and non-fatal, like the AKS cluster role: setup continues with a warning and the exact `az role assignment create` command when the operator lacks the permission to delegate it.
