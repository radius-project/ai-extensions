---
"radius": patch
---

Add route-level tests for `/api/deploy` covering the cases where it refuses a repair redeploy, so the guarantee that a refusal costs no GitHub Actions run is asserted against the route itself rather than argued from its helpers.
