---
"radius": patch
---

**Fixed:** Keep simultaneous deployments to different environments attached to their own workflow runs, so one deployment cannot report another's result or request repair for it.

Deployment and environment-deletion discovery require an exact correlation token and refuse ambiguous matches. A correlated run remains discoverable despite clock skew or a delayed listing.
