---
"radius": patch
---

Block an Azure deploy before dispatch when the configured app registration is missing a federated credential for the target environment's effective GitHub OIDC subject, replacing a late `AADSTS7002138` workflow failure with an actionable message. Coverage is checked against every subject GitHub could mint, and the check fails closed whenever it cannot be completed.
