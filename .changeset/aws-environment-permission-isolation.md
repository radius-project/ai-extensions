---
"radius": patch
---

**Fixed:** Isolate regional AWS grants by repository and environment, retain exact policy names for deletion after repository renames, and migrate unambiguous legacy policies on picked roles. Recover inline-policy space during migration without deleting another environment's grant. Deployment and deletion workflows use setup-granted EKS access, and Canvas blocks stale AWS workflow templates before dispatch.
