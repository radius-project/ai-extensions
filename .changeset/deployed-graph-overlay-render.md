---
"@radius-project/canvas": patch
---

Deployed tab now overlays log statuses onto the modeled topology instead of trying to swap topology sources tick-to-tick.

`loadGraph` in `pages.mjs` fetches `/api/deployed-graph` (base topology, from the modeled scaffold, optionally with the persisted `app-graph.json` overlay from `radius-graph`) and `/api/deploy-status` (per-resource statuses from the activity-log parser) in parallel, then merges the log statuses onto the topology by resource name via a small pure `mergeStatusIntoResources` helper. Node set never changes mid-deploy; only the per-node badge does — grey ⏳ → yellow ⏳ → green ✓ / red ✗.

A cached `graphController` is used so subsequent polls call `graphController.update(resources)` instead of remounting — React reconciles only the changed node props (status badge glyph + card border), no full-canvas flash. Polling stops when `st !== 'in_progress'`. The "Loading deployed application graph…" banner starts hidden and is never re-shown on polls.

`radiusRenderGraph` is called with `deployMode: true` so the existing badge machinery (`radiusDeployBadgeKind` + `radiusDeployBadgeSvg`) attaches the corner status glyph to each node card.
