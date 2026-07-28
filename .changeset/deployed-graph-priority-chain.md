---
"@radius-project/canvas": patch
---

Wire the `/api/deployed-graph` handler to the new priority chain: **durable** (`radius-graph:<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json`) → **live** (`radius-deploy-status:deploy-graph-live.json`) → **legacy** (`radius-deploy-status:deploy-graph.json`) → **session cache** → **modeled scaffold** (nodes stamped `deployStatus:'pending'`, giving the Deployed tab a greyed skeleton even before a deploy has ever completed) → none. The client now receives a `source` field so it can decide whether to keep polling (`durable` is terminal; `scaffold`/`none` mean a deploy is expected). Handler reads `branch` and `environment` from `searchParams` to route the request; `scope` is fixed at `DEFAULT_RADIUS_SCOPE` for now. The pure resolver `resolveDeployedGraph({ key, fetchers, sessionDeployedGraph, scaffoldResources })` in `deploy.mjs` owns the chain so the priority order can be unit-tested without any HTTP or `gh` I/O.
