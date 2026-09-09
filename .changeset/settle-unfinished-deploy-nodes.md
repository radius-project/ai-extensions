---
"radius": patch
---

**Fixed:** Show cancellation, timeout, and available Radius error messages on failed deployment graph nodes while preserving resource-specific errors and successful resources. When monitoring times out, keep unfinished nodes settled despite stale progress artifacts without allowing an unsafe automatic redeploy. Successful deployments clear stale failure messages.
