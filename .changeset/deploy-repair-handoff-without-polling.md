---
"radius": patch
---

Fire the deploy repair handoff from the server-side deploy monitor instead of relying on the webview. The handoff was only ever triggered from the `/api/deploy-status` route, which the browser polls solely while the deployments page is mounted, so closing the canvas panel, navigating to another page, or reopening onto a different page left a failed deploy orphaned with the repair loop never attempted. The background monitor that already owns every terminal transition of a deploy now triggers it as it settles, so a modeling failure is handed back to the agent whether or not anyone is watching. The status route keeps its own call as a fallback, and the handoff remains idempotent per repair loop, so the two paths cannot double-fire.
