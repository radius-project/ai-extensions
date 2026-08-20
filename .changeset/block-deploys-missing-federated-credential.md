---
"radius": patch
---

Block an Azure deploy before dispatch when the configured app registration holds no federated credential matching any GitHub OIDC subject the target environment could present, replacing a late `AADSTS7002138` workflow failure with an actionable message. The check runs after the branch-push check, scopes its Azure lookup to `AZURE_TENANT_ID` when one is configured, and warns instead of blocking whenever it cannot be completed or coverage is only partial, so a deploy that works today is never refused. The refusal is marked so it never opens an automatic repair loop.
