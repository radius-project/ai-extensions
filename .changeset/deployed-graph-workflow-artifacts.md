---
"radius": patch
---

Read the deployed application graph and per-resource deploy status from GitHub Actions workflow artifacts, and render the Deployed tab as the modeled topology painted with per-node status badges and a status legend. A failed resource now surfaces the producer's failure message in its node popup. Removes the GHCR OCI-artifact read path and the dead `radius-deploy-status` orphan-branch reads, which could never succeed. Also fixes the deploy monitor gating its in-flight handling on a workflow step name that does not exist, and the Deployed page resolving source links against `main` instead of the branch the graph was built from.
