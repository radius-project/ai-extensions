---
"radius": patch
---

**Fixed:** Keep the planned application graph and Radius type lookups working after the Azure Recipe Pack in `resource-types-contrib` moved to `recipe-packs/azure-aks/azure-aks.bicep` and the Kubernetes pack to `recipe-packs/kubernetes/default.bicep`. Recipe lookups now use the `azure-aks` pack entry from newer Radius releases and still fall back to the `azure` entry from older ones.
