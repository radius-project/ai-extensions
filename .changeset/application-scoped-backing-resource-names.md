---
"radius": patch
---

**Fixed:** Generated application models now name every `Radius.AI/*`, `Radius.Data/*`, `Radius.Messaging/*`, and `Radius.Storage/*` resource after the application, so a PostgreSQL store becomes `posthog-postgres` rather than `postgres`. A Recipe derives the cloud resource it provisions from a Radius resource ID that carries no application identity, so two applications deployed into the same Azure scope that both used the engine name resolved to one shared server: the second deploy adopted the first application's server and reported success, its workloads then failed to authenticate because Azure only accepts an administrator login when the server is created, and deleting either application destroyed the other's data. The model checker now rejects a backing resource whose name is not scoped to its application.
