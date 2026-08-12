---
"radius": patch
---

Point the delete workflow templates and composite actions at `radius-project/radius@main` now that PR #12367 has merged. Removes the temporary `DELETE_RADIUS_REF` constant (and its `RADIUS_DELETE_REF` env override) that pinned the delete-workflow fetch and the generated `delete-azure.yml` / `delete-aws.yml` composite-action refs to a PR branch; both now reuse the shared `RADIUS_REF` (`main`).
