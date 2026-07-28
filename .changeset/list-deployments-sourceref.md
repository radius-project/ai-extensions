---
"@radius-project/canvas": patch
---

Attach `sourceRef` (the run's `head_branch`) to each row returned by `/api/list-deployments` so the Deployments row's Monitor Graph link can address the durable graph by the exact `(sourceBranch, scope, env)` tuple the deploy workflow published it under. Additive-only change to `resolveEnvDeployment`: adds `head_branch` to the actions-run jq projection and threads it out to the row. Empty when the linked run is unresolvable, letting the client fall back to its default branch. The client link builder that consumes this field ships in a follow-up commit.
