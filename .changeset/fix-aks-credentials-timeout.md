---
"@radius-project/adapter-canvas": patch
---

Raise the `az aks get-credentials` timeout so AKS namespace discovery succeeds on Windows, where the Azure CLI batch shim consistently exceeded the previous 20s budget and left the namespace picker empty.
