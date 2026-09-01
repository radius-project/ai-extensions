---
"radius": minor
---

Delete application deployments and Azure environments through tracked workflows with explicit confirmation. Radius refuses environment deletion while applications remain, cleans up the Radius environment, GitHub environment, and per-environment Azure federated credential in safe order, preserves shared or manually changed resources, and supports recovery when cleanup cannot complete.
