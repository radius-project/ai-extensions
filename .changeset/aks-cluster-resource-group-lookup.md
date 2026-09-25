---
"radius": patch
---

**Fixed:** Look the AKS cluster up in its own resource group when connecting to it during deploy, verify, and delete. The generated Azure workflows used the application's resource group, which only works while the cluster happens to live there. Environments that do not record the cluster's resource group keep using the application's, so nothing needs to be reconfigured.
