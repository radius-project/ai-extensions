# Azure provider value rules

Use these rules for a predefined type when its `show-radius-type.mjs` result has an available managed-default Azure Recipe: `recipe.status` is `available`, `recipe.provenance` is `managed-release-default`, and `recipe.recipePack` is `azure`. In that case, `recipe.definition` is the exact matching Recipe, and `recipe.repository`, `recipe.commit`, and `recipe.path` identify its pinned source.

Check these values before writing `app.bicep`. Write each one as a string literal or a parameter with a literal default. If the application requires a value that the Recipe cannot deploy, stop and report the conflict. Do not silently rename a required database, container, topic, or model.

## Static rules

| Radius property                              | Required value                                                                                                                                                                                                                                                                                                                                                     |
|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `Radius.Data/postgreSqlDatabases.database`   | Match `^[A-Za-z_][A-Za-z0-9_-]{0,62}$`. Do not use `postgres`, `azure_maintenance`, `azure_sys`, `template0`, or `template1`. These databases already exist or are built into PostgreSQL. `database: 'postgres'` cannot create another database through the current Recipe, even though an application can connect to PostgreSQL's existing default database.      |
| `Radius.Data/postgreSqlDatabases.username`   | Match `^[A-Za-z0-9]{1,63}$`. Do not use `azure_pg_admin`, `azuresu`, or `azure_superuser`, and do not start with lowercase `pg_`. Use `myadmin` when the source does not require a login.                                                                                                                                                                          |
| `Radius.Data/mySqlDatabases.database`        | Do not use `information_schema`, `mysql`, `performance_schema`, or `sys`, under ASCII case-insensitive comparison. Azure creates these schemas with every MySQL Flexible Server. Azure does not publish a complete database-name grammar, so do not claim other values are proven valid.                                                                           |
| `Radius.Data/mySqlDatabases.username`        | Use 1 through 32 Unicode characters. Do not use the exact lowercase values `azure_superuser`, `admin`, `administrator`, `root`, `guest`, `sa`, or `public`. Use `myadmin` when the source does not require a login. Azure does not publish a complete character grammar or case-comparison rule.                                                                   |
| `Radius.Data/sqlServerDatabases.database`    | Use 1 through 128 Unicode characters. Do not use `<>*%&:\/?`, Unicode control characters, a trailing period, or a trailing space. Do not use `master` or `tempdb`, under ASCII case-insensitive comparison. `model` and `msdb` are allowed for this Azure SQL Database rule.                                                                                       |
| `Radius.Data/sqlServerDatabases.username`    | Use 1 through 128 Unicode characters. Do not use `admin`, `administrator`, `sa`, `root`, `dbmanager`, `loginmanager`, `dbo`, `guest`, or `public`, under ASCII case-insensitive comparison. Generate within `^[A-Za-z][A-Za-z0-9]{0,127}$`; this is a safe subset, not Azure's complete published grammar. Use `myadmin` when the source does not require a login. |
| `Radius.Storage/objectStorage.containerName` | Match `^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$`. The current management-plane Recipe requires a standard container name, so do not use the data-plane special name `$root`.                                                                                                                                                                                         |
| `Radius.Messaging/kafka.topic`               | Match `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,247}[A-Za-z0-9])?$`. This is the intersection of the Event Hub and Kafka topic rules and limits the value to 249 characters.                                                                                                                                                                                                |
| `Radius.Data/mongoDatabases.database`        | Match `^[A-Za-z0-9_.()-]{1,42}$`. The current AVM module includes the value in a 64-character nested ARM deployment name. This is an AVM compatibility rule, not a complete Cosmos DB Mongo database-name grammar.                                                                                                                                                 |
| `Radius.AI/models.model`                     | For the current Recipe's fixed model version `2025-08-07`, use `gpt-5`, `gpt-5-mini`, or `gpt-5-nano`. Any other model is unproven for that fixed version.                                                                                                                                                                                                         |

## Context-dependent AI checks

The AI model list checks only compatibility with the version fixed by the Recipe. It does not prove that deployment will succeed.

Before generating an AI model resource, verify the exact Recipe, model, version, SKU, target region, capacity, subscription access, and quota. Stop if any item cannot be verified. Do not describe a static model-name match as Azure deployment validation.

## Defaults

When the source does not set an optional property, use the exact default from the resolved schema and check that value against the selected Recipe.

Administrator usernames are required and have no schema default. Use `myadmin` only when the application does not require a specific login.
