---
"radius": patch
---

**Changed:** Azure deploys and deletes now retry a failed GitHub token refresh every 15 seconds instead of waiting 2 minutes, so a brief outage is less likely to fail a long operation.
