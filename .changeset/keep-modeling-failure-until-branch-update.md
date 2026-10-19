---
"radius": patch
---

**Fixed:** Keep permanent modeling failures across automatic reloads. Retry after saved source changes, a new branch commit, a target environment or provider change, or an explicit **Refresh**.

If source reads fail or lack a baseline, automatic retry stays paused. **Refresh** lets you retry after an external fix without a source edit or commit.

When a retry is recommended on the application graph or the planned graph, the primary button changes from **Plan Deployment** or **Deploy Application** to **Refresh**, and the graph subtitle tells you to click **Refresh**. If the repository has no environment, the graph keeps **Create Environment** and shows a separate **Refresh** button. The graph diff shows its **Refresh** button only after a comparison fails.
