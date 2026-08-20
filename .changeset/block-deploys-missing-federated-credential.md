---
"radius": patch
---

Block an Azure deploy before dispatch when the configured app registration holds no federated credential matching any GitHub OIDC subject the target environment could present, replacing a late `AADSTS700213` workflow failure (reported as `AADSTS7002138` in some Entra responses) with an actionable message. The check runs after the branch-push check, builds the subject from the environment name GitHub reports so a case difference cannot block a working deploy, and warns instead of blocking whenever it cannot be completed or coverage is only partial, so a deploy that works today is never refused. An environment that deliberately leaves `AZURE_CLIENT_ID` empty has no Azure login to check and is skipped. The refusal is marked so it never opens an automatic repair loop, and the deploy modal offers a direct route to Create Environment.
