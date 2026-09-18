---
"radius": patch
---

**Fixed:** Allow an environment on an AKS cluster that shares its name with another cluster in the same subscription. Radius now records the cluster's resource group, so a namespace is only reported as taken when it is taken on the same cluster. Environments created before this change do not record it and are still treated as possible holders of the namespace; recreate one to clear a false conflict.
