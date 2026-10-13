---
"radius": patch
---

**Fixed:** Keep permanent modeling failures across automatic reloads. Retry after saved source changes, a new branch commit, a target environment or provider change, or an explicit **Refresh**.

If source reads fail or lack a baseline, automatic retry stays paused. **Refresh** lets you retry after an external fix without a source edit or commit.
