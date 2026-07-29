---
"@radius-project/core": minor
"@radius-project/canvas": patch
---

Co-locate the live deployed-graph snapshot with the durable one on the `radius-graph` orphan branch, so both artifacts share a single addressing family keyed by `(sourceBranch, scope, environment)`.

Previously the live snapshot lived at a flat `radius-deploy-status:deploy-graph-live.json` while the durable one lived at the scoped `radius-graph:<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json`. The flat top-level path can't distinguish multiple apps or environments in the same repo, and having live vs. durable on two different branches with two different path shapes was surface area for the reader, the writer, and human debugging to remember.

New layout, under one directory on `radius-graph`:

- `<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json` — durable, terminal (unchanged).
- `<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.live.json` — overwritten by the deploy workflow on a ~5s loop while `rad deploy` runs. Same schema as the durable file.

New export `liveDeployedGraphPath({ sourceBranch, scope, environment })` returns the live file path; the durable `deployedGraphPath()` is unchanged. `LIVE_GRAPH_FILE` (the old flat `deploy-graph-live.json` constant) is removed — the live file now lives at a keyed path just like its durable sibling. `LEGACY_DEPLOY_GRAPH_FILE` on `radius-deploy-status` is unchanged and still serves as the backward-compat fallback for repos whose workflow hasn't migrated.

Canvas reader (`fetchLiveDeployedGraph`) now takes the same `(sourceBranch, scope, environment)` key as `fetchDeployedGraph` and reads from `radius-graph`; the `/api/deployed-graph` priority chain wires both durable and live to the same key. `rad app delete` deleting the per-tuple directory now wipes both files together.
