---
"@radius-project/core": patch
---

Introduce `deployedGraphPath({ sourceBranch, scope, environment })` and the storage constants (`RADIUS_GRAPH_BRANCH`, `DEFAULT_RADIUS_SCOPE`) that pin down where the persisted deployed application graph lives on the app repo. The layout `<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json` on the `radius-graph` orphan branch is the single addressing contract the canvas reader and the deploy workflow both use, so the two sides can't drift out of sync. Pure path math with no I/O; the canvas-side reader lands in a follow-up.
