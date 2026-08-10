---
"radius": patch
---

Keep the rolling `radius-edge` entry in the marketplace catalog on `main` in sync with the released version instead of leaving it at `0.0.0`. `pnpm run version:check` now covers it, so the catalog end users add can no longer advertise a stale version for the edge channel.
