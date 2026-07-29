---
"@radius-project/canvas": patch
---

Rewrite `/api/deployed-graph` so the Deployed tab always shows the app topology. Base topology is now the modeled scaffold (via `buildGraphViaRad` on the branch's `.radius/app.bicep`), with a candidate-branch fallback (`sourceBranch` → `workspaceBranch` → `deployingBranch` → `plannedBranch` → `graphBranch` → `main`) so a fresh Deployed-tab open on a feature branch resolves even without a prior Modeled-tab open. Per-resource `deployStatus` is overlaid from the persisted `app-graph.json` on the `radius-graph` orphan branch (when the workflow has published it) via `fetchDeployedGraph` + `extractStatusesFromGraph`. No more "Nothing deployed yet" state — the scaffold always renders. The old `radius-deploy-status:deploy-graph.json` legacy path is dropped from this handler (session cache path in `/api/deploy` is unchanged).
