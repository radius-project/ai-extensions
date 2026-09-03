---
"radius": patch
---

**Fixed:** Generated `app.bicep` no longer passes a raw password to a credential property that expects a secret reference. Two resource types can name a property `password` with opposite meanings — `Radius.Data/mySqlDatabases.password` is the sensitive value itself, while `Radius.Messaging/rabbitMQ.password` is the resource ID of a `Radius.Security/secrets` resource — and the previous guidance chose by property name, so a RabbitMQ app was modeled with the password where the Secret's resource ID belongs and the deployment failed Kubernetes validation. The application modeling guidance now decides from the schema's `x-radius-sensitive` flag instead of the property's name and ships a worked RabbitMQ example alongside the MySQL one.
