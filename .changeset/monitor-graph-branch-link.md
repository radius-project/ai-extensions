---
"@radius-project/canvas": patch
---

Thread each Deployments row's `sourceRef` into its Monitor Graph link as `&branch=<sourceRef>`, so `/api/deployed-graph` can address the durable graph at the exact `<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json` path the workflow published it under. Closes the end-to-end path from a deployment row click through to the correct per-(sourceBranch, scope, env) durable graph. Empty `sourceRef` — rare, only for rows with no linked run — falls through to the server's default-branch fallback.
