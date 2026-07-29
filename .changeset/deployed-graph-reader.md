---
"@radius-project/canvas": patch
---

Add `fetchDeployedGraph(repo, key)` and the pure helpers `mapProvisioningStateToDeployStatus(state)` and `extractStatusesFromGraph(graph)` in `adapters/canvas/src/deploy.mjs`. `fetchDeployedGraph` reads the persisted `app-graph.json` the workflow force-publishes on deploy completion to the `radius-graph` orphan branch, addressed by the shared `deployedGraphPath` helper from `@radius-project/core`. The two pure helpers project each resource's raw `provisioningState` to the canvas' four-value `deployStatus` vocabulary and produce a `{ [name]: deployStatus }` overlay map the /api/deployed-graph handler stamps onto the modeled scaffold. Wiring lands in a follow-up.
