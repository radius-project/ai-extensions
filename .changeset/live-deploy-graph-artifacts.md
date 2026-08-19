---
"@radius-project/adapter-canvas": patch
---

Render live Radius deployment progress from the run-scoped artifact ring. The canvas validates active-run identity, selects the greatest payload sequence independent of artifact order, avoids downloading unchanged artifact IDs, and retains final-only artifact compatibility.
