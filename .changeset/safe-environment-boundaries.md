---
"radius": patch
---

Harden Azure environment creation across Azure, Microsoft Graph, GitHub, GHCR, and workflow-template boundaries. External reads now use bounded retries, ambiguous mutations reconcile exact provider state, workflow transformations fail closed on structural drift, and Azure setup rollback restores GitHub environment variables without overwriting manual changes.
