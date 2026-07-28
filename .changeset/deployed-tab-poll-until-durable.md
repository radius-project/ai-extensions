---
"@radius-project/canvas": patch
---

Teach the Deployed tab to consume the new `source` field from `/api/deployed-graph` and thread the deployment's `branch` from the URL. On tab load with no in-session live deploy, the client walks the priority chain (durable → live → legacy → session → scaffold) and renders whichever tier answers first — so users always see the app topology, greyed out even before the first deploy has ever run. Continues polling every ~5s until `source === 'durable'` (the workflow-published final graph), then stops. A slower 15s retry kicks in when nothing came back so a repo with no `.radius/app.bicep` seen yet still auto-hydrates once the Modeled tab has been opened. In-session live-deploy tracking (`/api/deploy-status` fast path with per-node status streaming from `radius-deploy-status` logs) is unchanged.
