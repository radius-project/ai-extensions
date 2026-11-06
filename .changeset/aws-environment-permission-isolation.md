---
"radius": patch
---

**Fixed:** Isolate regional AWS grants by repository and environment. Each environment's inline policy is named from the GitHub repository ID, so a rename keeps the name and a new repository at the old name gets a different one. Deletion removes that policy and the trust subjects setup recorded, including subjects from before a rename. Deployment and deletion workflows use setup-granted EKS access, and Canvas checks AWS workflow templates against the saved environment provider and blocks stale ones before dispatch.

AWS environments created by earlier development builds aren't migrated. Run setup again, and delete their old permission policies from the role by hand.
