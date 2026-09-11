---
"radius": patch
---

**Fixed:** Azure environment setup now grants the deploy identity the least-privilege **Locks Contributor** role (Azure built-in role `28bf596f-4eb7-45ce-b5bc-6cf482fec137`) on the target resource group, so recipes can create and remove resource locks without broader access-management permissions. The grant is best-effort and non-fatal, like the AKS cluster role: setup continues with a warning and the exact `az role assignment create` command when the operator cannot create the assignment.
