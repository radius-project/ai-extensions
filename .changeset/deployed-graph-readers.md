---
"@radius-project/canvas": patch
---

Add `fetchDeployedGraph(repo, { sourceBranch, scope, environment })` for the durable per-deployment graph on the `radius-graph` orphan branch and `fetchLiveDeployedGraph(repo)` for the structured `rad app graph --preview` snapshot the workflow publishes on a loop during `rad deploy` (at `radius-deploy-status:deploy-graph-live.json`). Both reuse the addressing constants from `@radius-project/core` so the reader stays lockstep with the workflow writer. The existing `fetchDeployGraph(repo)` legacy fallback is unchanged; the `/api/deployed-graph` handler will chain durable → live → legacy → modeled-scaffold in a follow-up commit. Sibling `fetchLiveDeployLog` / `fetchLiveActivityLog` / `fetchLiveControlPlaneLog` / `fetchDeployState` now reference the same `RADIUS_DEPLOY_STATUS_BRANCH` constant so every `radius-deploy-status` URL in the file has one source of truth.
