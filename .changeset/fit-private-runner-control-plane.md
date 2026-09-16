---
"radius": patch
---

**Fixed:** Allow Repo Radius control-plane bootstrap on standard private-repository runners by lowering PostgreSQL's CPU request. Update the Radius plugin, then regenerate and recommit existing pinned `run-rad-commands-azure.yml`, `run-rad-commands-aws.yml`, `delete-azure.yml`, `delete-aws.yml`, and `delete-environment-azure.yml` workflows to use the corrected setup action.
