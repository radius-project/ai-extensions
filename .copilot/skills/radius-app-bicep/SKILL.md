---
name: radius-app-bicep
description: >
  Analyze a source code repository and generate a Radius application
  definition (.radius/app.bicep) that models the app's compute and backing
  services as Radius resource types. Use for: creating, generating, or
  updating a Radius application definition or app.bicep; modeling or
  onboarding an app or repo to Radius; determining which Radius resource
  types an app needs; repairing or fixing an app.bicep that failed to
  deploy because of a modeling or schema error. Do not use for: authoring
  generic or Azure Bicep unrelated to Radius, or deploying or running an
  already-modeled app.
---

# Radius Application Modeling

Use this skill to generate a Radius application definition (`app.bicep`) from a source code repository.

## Response

When asked to model a repository, your chat reply should contain:

1. A one-line intro naming the app (e.g. "I'll create an application definition for `todo-list-app`.").
2. A short, natural summary of the application resources you identified — a brief list such as "Container: `todo-list-app`", "MySQL database", "Secret for DB credentials". A sentence or two of reasoning is fine; don't dump raw source analysis.
3. The `.radius/app.bicep` in a single code block.
4. An offer to open a pull request.

Don't create the pull request automatically — wait for the user to confirm. If they confirm, open a PR adding `.radius/app.bicep` with title `Add Radius application definition` and body `Add .radius/app.bicep for <app-name>.`

## Workflow

Before writing the Bicep:

1. Analyze the source (package manifest, Dockerfile/compose, entry point, persistence layer, env vars) and detect the app's components — the compute runtime and each backing service. Map each to a Radius type using [component-catalog.md](references/component-catalog.md).
2. Note the primary architecture pattern for context — see [architecture-patterns.md](references/architecture-patterns.md). Composition is driven by the detected components, not the pattern label, and an app may combine patterns. If a detected component has no Radius type yet, report the gap rather than substituting an unrelated type.
3. Resolve the resource types the app needs from `radius-project/resource-types-contrib`. Derive each schema path from the type name (see [Resource Type Resolution](#resource-type-resolution)) and read only those files. If a needed type's schema isn't at the derived path, search the repo for `<typeName>.yaml`; if it still can't be resolved, stop and report the missing type rather than guessing. Types the app doesn't use don't need to resolve.
4. Apply the naming, structure, and secrets rules below (and in [bicep-structure-rules.md](references/bicep-structure-rules.md), [naming-conventions.md](references/naming-conventions.md), [secrets-handling.md](references/secrets-handling.md)).
5. Generate the Bicep and check it against the [validation checklist](#validation-checklist).

### Repairing an existing app.bicep

When a deploy fails because of a modeling or schema error in an existing `.radius/app.bicep` (unknown type or API version, unknown or missing property, invalid reference between resources, wrong credential shape, or a Bicep parse or compile error), repair the file in place instead of regenerating it. This assumes the deploy error and any relevant logs have been provided (by the `radius-deploy` skill or the user); if they haven't, ask for them before attempting a fix.

1. Confirm the failure is a modeling error. If it is an infrastructure, recipe, environment, or cluster failure (recipe download or execution, provider mismatch, credential or connectivity issues, a pod that never becomes ready), stop and hand it back to the `radius-deploy` skill; editing `app.bicep` will not fix it.
2. Locate the resource and property the error implicates, then re-resolve that type's schema (see [Resource Type Resolution](#resource-type-resolution)) to confirm the correct property names, required fields, credential shape, and API version.
3. Apply the fix using the same naming, structure, and secrets rules as authoring so the repaired resource stays consistent with the rest of the file. While you are in the file, also correct any other clear schema or rule violations you notice, and report each collateral fix you made.
4. Re-run the [validation checklist](#validation-checklist) against the whole file; a change in one resource can ripple to connections or references elsewhere.
5. Return the corrected file with a short note of what changed and why. If the same error recurs, treat the previous fix as insufficient and try a different fix rather than reapplying the one that just failed. Hand the corrected file back to `radius-deploy` to redeploy. If you have no different fix left to try, report that to `radius-deploy` and let it own the retry cap and the hand-off to the user - do not surface to the user yourself.

## Deterministic Naming Rules

These rules eliminate ambiguity. Apply them exactly.

### Symbolic names (left side of `=` in Bicep)

| Resource | Symbolic name |
|---|---|
| Application | `<shortName>App` where `<shortName>` is the app name without hyphens, camelCase (e.g., `todo-list-app` → `todoApp`) |
| Container | `<serviceName>Container` — service short name camelCase; single-container apps use `<shortName>Container` (e.g., `todoContainer`) |
| Container image | `<serviceName>Image` (e.g., `todoImage`) |
| Data store (database/cache/queue) | `<engine>` + role suffix, camelCase: `mysqlDb`, `postgresDb`, `neo4jDb`, `redisCache`. Multiple of the same engine: prefix with the source store name (e.g., `ordersPostgresDb`) |
| Data store secret | `<engine>Secret` — only when the type's schema defines `secretName`; app secrets use `appSecrets` |
| Route | `<serviceName>Route` (e.g., `todoRoute`) |

### Resource `name` properties (string values in Bicep)

| Resource | Name value |
|---|---|
| Application | Repository name in kebab-case (e.g., `'todo-list-app'`) |
| Container | Service name in kebab-case; single-container apps use the app name (e.g., `'todo-list-app'`) |
| Container image | `'<service-name>-image'` (e.g., `'todo-list-app-image'`) |
| Data store | Engine short name in kebab-case (`'mysql'`, `'postgres'`, `'neo4j'`, `'redis'`); multiple of the same engine use the source store name |
| Data store secret | `'<engine>-secret'`; app secrets `'app-secrets'` |

### Connection keys

| Connection | Key |
|---|---|
| Data store | Engine + role, lowercase: `mysqldb`, `postgresdb`, `neo4jdb`, `rediscache`. Multiple of the same engine: prefix with the source store name |

### Other fixed values

| Field | Value |
|---|---|
| Data store admin username | The administrator username you author for the provisioned database. Set it wherever the schema puts credentials — `username` on the resource, or `USERNAME` in the secret when the schema uses `secretName`. Use a simple admin name (e.g., `myadmin`); it is NOT derived from the source |
| Data store `database` name | Derived from source (e.g., `MYSQL_DATABASE`/`POSTGRES_DB`, or the database segment of a connection string) |
| Data store `version` | Derived from source (e.g., the image tag `mysql:8.0` → `'8.0'`) |
| Container key in `containers` map | Service short name camelCase (single-container: derived from app, e.g., `todo`) |
| Port key in `ports` map | `web` for the primary HTTP port; additional ports derive from protocol/use (`http`, `grpc`) |
| `build.source` for containerImages | Repo git URL: `git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>` (`//<subdir>` only when the Dockerfile isn't at the repo root) |

## Resource Type Resolution

### Built-in types (from `radius-project/radius`)

| Need | Resource Type | API Version |
|---|---|---|
| Application grouping | `Radius.Core/applications` | `2025-08-01-preview` |

`Radius.Core/applications` is built into the `radius` extension — there is no schema file for it in `resource-types-contrib`. Do NOT use `Applications.Core/applications` — the model has moved to `Radius.Core/applications`.

### Extensible types (from `radius-project/resource-types-contrib`)

Resolve each type's schema at runtime from the `radius-project/resource-types-contrib` repository. Do NOT hardcode a file path — derive it from the resource type name using the repo convention:

- Category = the segment after `Radius.` in the namespace (`Radius.Compute` → `Compute`, `Radius.Data` → `Data`, `Radius.Messaging` → `Messaging`, `Radius.AI` → `AI`, `Radius.Storage` → `Storage`, `Radius.Security` → `Security`)
- Schema path = `<Category>/<typeName>/<typeName>.yaml` (e.g., `Radius.Data/mySqlDatabases` → `Data/mySqlDatabases/mySqlDatabases.yaml`)

Read the schema file to get the exact property names, types, and API version. Use the API version declared in the schema (currently `2025-08-01-preview` for these types) rather than assuming a fixed value.

The following is the COMPLETE allow-list of types this skill may emit:

| Need | Resource Type |
|---|---|
| Container images (build from Dockerfile) | `Radius.Compute/containerImages` |
| Containers | `Radius.Compute/containers` |
| MySQL | `Radius.Data/mySqlDatabases` |
| PostgreSQL | `Radius.Data/postgreSqlDatabases` |
| Neo4j | `Radius.Data/neo4jDatabases` |
| MongoDB | `Radius.Data/mongoDatabases` |
| Redis (cache) | `Radius.Data/redisCaches` |
| SQL Server | `Radius.Data/sqlServerDatabases` |
| Kafka (event streaming) | `Radius.Messaging/kafka` |
| RabbitMQ (message queue) | `Radius.Messaging/rabbitMQ` |
| AI model endpoint | `Radius.AI/models` |
| AI search | `Radius.AI/search` |
| Object storage | `Radius.Storage/objectStorage` |
| Persistent storage | `Radius.Compute/persistentVolumes` |
| External ingress | `Radius.Compute/routes` |
| Secrets | `Radius.Security/secrets` |

Do NOT use any type not listed above. Do NOT invent properties.

## Extension

Declare exactly one extension, `extension radius`. It provides every Radius type (`Radius.Core/*`, `Radius.Compute/*`, `Radius.Data/*`, `Radius.Messaging/*`, `Radius.AI/*`, `Radius.Security/*`). Do NOT declare per-namespace or per-type extensions (`radiusCompute`, `containers`, `kafka`, etc.).

## app.bicep Structure (mandatory order)

Declare resources in this order (do NOT output this as code — it is only for your reference):

1. Extension: `extension radius` (single, covers all Radius types)
2. Params: `environment`; add a `@secure() param` for each secret value needed (DB password, API key)
3. Application resource (`Radius.Core/applications@2025-08-01-preview`) — always exactly one
4. Data / infrastructure resources (databases, caches, message brokers, object storage, AI services)
5. Secret resources (app API keys, or DB credentials when a schema uses `secretName`)
6. Container image resources (if building from Dockerfile)
7. Container resources (with connections to images and infra)
8. Routes (only if external ingress needed)

Rules:
- One `Radius.Compute/containers` per container service; one `Radius.Data/*` per backing data store (engine/instance-derived symbolic name).
- Building from a Dockerfile: add a `Radius.Compute/containerImages` resource with `build.source` set to the repo git URL (`git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>`); the container references the built image via `<serviceName>Image.properties.imageReference` (no separate connection needed).
- Database credentials follow the type's schema: if it defines `username`/`password`, set them on the resource; if it defines `secretName`, create a `Radius.Security/secrets` and reference it; if it defines neither, the type takes no credentials. Always use a `@secure() param` for the password.
- Add `Radius.Compute/routes` only for external ingress.

## Connections

Wire containers to infrastructure via `connections`. Read [connection-conventions.md](references/connection-conventions.md) for the correct env var format.

Rules:
- NEVER duplicate auto-injected env vars with manual `env` entries.
- Only add explicit `env` entries for app-specific variables NOT covered by connection auto-injection.
- A sensitive recipe output (connection string, URL with an access key, API key) is NOT in the connection blob — bind it with `valueFrom.secretKeyRef` from `<resource>.properties.secrets.name`. Keep the `connection` for the non-secret discovery vars (host, port).

## Secrets

See [secrets-handling.md](references/secrets-handling.md). Secrets flow in two directions:

- **Inputs** (credentials you supply): read the type's schema for the shape — `username` + `password` directly on the resource; a `Radius.Security/secrets` referenced via `secretName`; or none. Do not assume by engine. The password is always a `@secure() param`, and the username is the database administrator you author (e.g. `myadmin`). Use `Radius.Security/secrets` for app secrets (API keys) too.
- **Outputs** (sensitive values the recipe generates — connection strings, URLs with access keys, API keys): when the schema defines a read-only `secrets` block, Radius redacts these from the resource's properties and materializes them into a managed secret. Consume them in a container with `valueFrom.secretKeyRef`, using `<resource>.properties.secrets.name` and a key from that block. Do NOT author a secret for these and do NOT read them from the connection blob.

## Bicep Structure Rules

Read [bicep-structure-rules.md](references/bicep-structure-rules.md) for all structural rules.

## Validation Checklist

Before returning the Bicep, verify:
- [ ] Exactly one `Radius.Core/applications@2025-08-01-preview`, and one `extension radius` (no per-namespace or per-type extensions).
- [ ] Every `Radius.*` type is on the allow-list and matches its schema; use the API version from the schema.
- [ ] `param environment string` is declared; add a `@secure() param` for each secret (DB password, API key).
- [ ] `connections` is a top-level object map under `properties` (not inside `containers`, not an array).
- [ ] Ports use `containerPort`; a built image uses `build.source` (repo git URL) and the container references `.imageReference`.
- [ ] Credentials match the type's schema: `username`+`password` on the resource, or `secretName`+secret, or none — whichever the schema defines. Password via `@secure() param`; `database`/`topic`/`queue`/etc. derived from source.
- [ ] Secret outputs (schema has a read-only `secrets` block) are consumed via `valueFrom.secretKeyRef` using `<resource>.properties.secrets.name` and a key from that block — never read as plain properties or from the connection blob, and never re-authored as a `Radius.Security/secrets`.
- [ ] No hardcoded passwords, no readOnly properties **set**, no comments in the Bicep, and no `bicepconfig.json`. (Referencing `.properties.imageReference` and `.properties.secrets.name` is allowed — those are the only sanctioned read-only references.)

## Example

See [todo-list-app-example.md](references/todo-list-app-example.md) for a worked example of the modeling decisions (source analysis, resource mapping, and key choices) for `dockersamples/todo-list-app`.