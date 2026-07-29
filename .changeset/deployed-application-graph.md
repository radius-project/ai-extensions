---
"@radius-project/core": minor
"@radius-project/canvas": minor
---

Deployed application graph now renders the Modeled topology (one node per Radius resource, no output resources) and drives per-node status live from the `rad deploy` step stdout in the workflow job log. The graph opens greyed with an hourglass badge on every node the moment the user lands on **Monitor Graph**, transitions each node individually to a green check on `Completed <name>` or a red cross on `Failed <name>`, and a legend beside the graph maps the three symbols to their meaning. On a successful run, the terminal `rad app graph` JSON captured from the same job log is stored and rendered as the settled Deployed view. The extension no longer depends on the `radius-deploy-status` orphan branch — `fetchLiveDeployLog`, `fetchLiveActivityLog`, `fetchLiveControlPlaneLog`, `fetchDeployState`, and `fetchDeployGraph` are removed along with the activity-log / control-plane helpers that only fed them. See `docs/design/2026-07-deployed-application-graph.md` for the design.
