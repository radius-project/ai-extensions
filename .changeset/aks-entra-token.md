---
"radius": patch
---

**Fixed:** Azure deploys and deletes now work on AKS clusters with Microsoft Entra integration and local accounts disabled. The workflows replace the kubelogin credential that `az aks get-credentials` writes with a Microsoft Entra token for the AKS server application, store it in the `target-kubeconfig` Secret, and renew it while commands run. Kubeconfigs with client certificates are unchanged.
