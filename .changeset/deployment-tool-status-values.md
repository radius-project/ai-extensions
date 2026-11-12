---
"radius": patch
---

**Fixed:** Return the documented `in_progress`, `success` and `failed` values from `radius_deploy_status`, so callers stop polling when deployment completes. An unconfirmed workflow outcome remains `failed` with guidance against automatic repair.
