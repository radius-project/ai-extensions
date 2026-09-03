---
"radius": patch
---

**Fixed:** The application model checker now rejects a `@secure()` parameter assigned to a resource property that the type's schema does not mark sensitive, so a credential can no longer be written where a `Radius.Security/secrets` resource ID belongs. Type resolution records each resolved property's sensitivity for the checker, which lets it separate `Radius.Data/mySqlDatabases.password`, where the secure parameter belongs inline, from `Radius.Messaging/rabbitMQ.password`, where it produces a deployment that Kubernetes rejects. Resolve every predefined type the model uses so the check has the schema evidence it needs.
