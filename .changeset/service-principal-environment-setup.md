---
"radius": patch
---

Let **Create Environment** run under a service principal, not just a signed-in human. The App Registration setup resolved the caller's directory object id with `az ad signed-in-user show`, which is a Microsoft Graph `/me` call that does not exist for a service principal, so anyone who had run `az login --service-principal` — including CI runners and other automation — failed the flow outright with `app-owner-lookup-failed`.

Setup now reads the principal type from `az account show` before looking up an object id, and resolves a service principal through `az ad sp show --id <appId>`. Both identity types yield an owner object id, so the ownership checks, the post-create owner assignment, and its verification all behave identically and the new App Registration ends up owned by whichever principal ran setup. The principal type is read directly rather than inferred from a failed `/me` call, so a genuine permissions failure is still reported as a permissions failure instead of being mistaken for a service principal. If the caller's identity cannot be established, setup fails closed as before and never creates or mutates an App Registration. Messages that said "signed-in user" now say "Azure CLI identity"; the failure codes are unchanged.
