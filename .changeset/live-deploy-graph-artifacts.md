---
"@radius-project/adapter-canvas": patch
---

Render live Radius deployment progress from the run-scoped artifact ring. The canvas validates active-run identity, selects the greatest payload sequence within an active run (and the newest terminal artifact on repo-wide reads), rejects payloads without a positive-integer sequence, avoids downloading unchanged artifact IDs while pruning cached artifact IDs that have dropped out of the listing, and retains final-only artifact compatibility.
