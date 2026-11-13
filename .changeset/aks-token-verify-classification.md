---
"@radius-project/core": patch
---

**Fixed:** Classify a failed Microsoft Entra token step for AKS in credential verification by its error code. A rejected federated credential is a trust problem, Microsoft Entra not answering is an unreachable cloud provider, and every other code is a failure that cannot be bypassed. These failures are no longer reported as cluster permission or reachability problems.
