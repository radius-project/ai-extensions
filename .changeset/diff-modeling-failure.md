---
"radius": patch
---

**Fixed:** Stop the graph compare view from asking for an application model forever after modeling has permanently failed. When neither compared branch has `.radius/app.bicep` and Copilot reports that it cannot author one, the compare view now shows the reported reason and stops re-requesting generation, and refreshing the Radius Canvas starts a fresh attempt.
