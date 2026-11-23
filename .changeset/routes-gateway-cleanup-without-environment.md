---
"radius": patch
---

**Fixed:** Deleting an application no longer fails in routes Gateway cleanup when nothing was ever deployed to the environment, or when the environment has no routes recipe. Cleanup now keeps the Gateway in those cases, and an environment read failure is reported as a read failure instead of a missing routes recipe.
