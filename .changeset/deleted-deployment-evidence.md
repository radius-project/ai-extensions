---
"radius": patch
---

**Fixed:** Stop status polling from restoring a deleted application's graph. Once GitHub accepts a matching delete, its old deployment handles stop resolving and attached panels clear the old result without hiding later deployments. If the delete's run URL is unavailable, report the accepted dispatch with an empty URL and retain the operation lock rather than inviting a duplicate delete.
