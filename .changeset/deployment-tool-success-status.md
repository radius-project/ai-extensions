---
"radius": patch
---

**Fixed:** Report completed deployments as `success` in `radius_deploy_status`, matching the deployment skill's terminal-state instructions while preserving Canvas status. Keep polling `pending` and `in_progress`, retain uncertain-outcome diagnostics, and report missing or unavailable status explicitly rather than inventing a pending deployment.
