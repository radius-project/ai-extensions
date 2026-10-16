---
"radius": patch
---

**Fixed:** Keep permanent modeling failures across automatic reloads. Retry after saved source changes, a new branch commit, a target environment or provider change, or an explicit **Refresh**.

If source reads fail or lack a baseline, automatic retry stays paused. **Refresh** lets you retry after an external fix without a source edit or commit.

When a retry is recommended on the application graph or the planned graph, the primary button changes from **Plan Deployment** or **Deploy Application** to **Refresh**. The graph diff shows a separate **Refresh** button.
