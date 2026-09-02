---
"radius": patch
---

**Fixed:** Deleting an application now clears its deployed graph. The Deployed view no longer keeps showing the deleted application's last deployment until its status artifact expires. Only the graph for the exact application and environment you deleted is removed; other applications in the same environment, and the same application in other environments, are untouched.
