# Secrets and Credentials

Secrets flow in two directions, and an app can involve both:

- **Secret inputs** — credentials the *developer supplies* to a resource (a DB admin password, an app API key). How they are supplied is **type-specific** — read the type's schema.
- **Secret outputs** — sensitive values the *recipe generates* while provisioning (a connection string, a URL that embeds an access key, an API key). Radius redacts these from the resource's normal properties and materializes them into a **managed `Radius.Security/secrets` resource**, which the container consumes **by reference** via `secretKeyRef`.

## Rules

- NEVER hardcode passwords, tokens, or keys in `app.bicep`. Use a `@secure() param` and pass it at deploy time (`rad deploy -p password=...`).
- **Determine behavior from the type's schema — do not assume by engine.** Secret inputs key off which credential properties the schema defines; secret outputs key off the read-only `secrets` block the schema defines.
- The username is the **administrator** account you author for the database Radius provisions. Use a simple admin name (e.g. `myadmin`); it is not derived from the source.
- `Radius.Security/secrets` is authored by you for (a) a data type whose schema requires `secretName` and (b) genuine app secrets (API keys, tokens). For secret **outputs** Radius creates the managed secret itself — you never author it, you only reference `<resource>.properties.secrets.name`.

---

# Secret inputs

How database credentials are supplied is **type-specific** — read the type's schema. There are three shapes, keyed on which credential properties the schema defines.

## Shape 1 — schema defines `username` + `password`

Set them directly on the data resource; `password` is `x-radius-sensitive`. (Today: postgres, mysql, sqlserver, neo4j.)

```bicep
@secure()
param password string

resource postgresql 'Radius.Data/postgreSqlDatabases@2025-08-01-preview' = {
  name: 'postgresql'
  properties: {
    environment: environment
    application: app.id
    database: 'appdb'      // derived from source
    username: 'myadmin'
    password: password
  }
}
```

## Shape 2 — schema defines `secretName`

Create a `Radius.Security/secrets` holding `USERNAME` and `PASSWORD` (see the app-secrets example below for the resource shape) and reference it from the data resource via `secretName`. (Today: neo4j when authored with an explicit secret.)

## Shape 3 — schema defines no credential inputs

The type takes no credentials in the app definition; the recipe provisions the resource and generates its connection details. A container `connection` to the resource injects the **non-secret** `CONNECTION_*` env vars (host / port / database). See [connection-conventions.md](connection-conventions.md). (Today: redis, mongo, kafka, rabbitmq, objectStorage, AI models, AI search.)

> If the schema also defines a read-only `secrets` block, the connection string / URL / API key is a **secret output** (below), not a connection env var.

---

# Secret outputs

Some recipes produce sensitive outputs (a connection string, a TLS URL that embeds an access key, an API key). Instead of leaking these onto the resource's readable properties, Radius:

1. Redacts them from the resource's normal properties (they read back as `null`), and leaves them **out of** the connection's `CONNECTION_<NAME>_PROPERTIES` blob.
2. Materializes them into a **managed `Radius.Security/secrets` resource** that Radius owns.
3. Surfaces a read-only reference to that managed secret on the resource as `properties.secrets`, with a reserved `properties.secrets.name` key.

You detect this by reading the type's schema: a **read-only `secrets` block** (a `name` sub-property plus one or more read-only value keys) means the type has secret outputs.

## How to consume a secret output

Bind it into the container's `env` with `valueFrom.secretKeyRef`, using the managed secret's name and the schema's secret key:

```bicep
resource redisCache 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'redis'
  properties: {
    environment: environment
    application: app.id
    size: 'S'
  }
}

resource todoContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'todo-list-app'
  properties: {
    environment: environment
    application: app.id
    containers: {
      todo: {
        image: todoImage.properties.imageReference
        env: {
          // Bind the secret OUTPUT by reference — the value never lands on the
          // redisCache resource's readable properties or in the connection blob.
          REDIS_URL: {
            valueFrom: {
              secretKeyRef: {
                secretName: redisCache.properties.secrets.name   // reserved read-only reference
                key: 'url'                                        // a key from the schema's secrets block
              }
            }
          }
        }
      }
    }
    connections: {
      // Still declare the connection: it injects the NON-secret props (host, port).
      rediscache: {
        source: redisCache.id
      }
    }
  }
}
```

Key points:

- `secretName` is always `<dataResourceSymbol>.properties.secrets.name` — the reserved read-only reference to the managed secret. This is the one sanctioned exception to "do not reference readOnly properties".
- `key` must be one of the read-only value keys the schema's `secrets` block defines (never `name`).
- Name the `env` variable after whatever your application reads for that credential (e.g. the URL / connection string / API key it expects). Do not also inject the same value via a manual plaintext `env` or expect it in `CONNECTION_*`.
- Keep the `connection` to the resource for the non-secret discovery vars (host, port, database).

## Secret-output keys by type

Read the schema's `secrets` block to confirm, but currently:

| Type | Secret output key(s) |
|---|---|
| `Radius.Data/redisCaches` | `url` |
| `Radius.Data/mongoDatabases` | `connectionString` |
| `Radius.Messaging/kafka` | `connectionString` |
| `Radius.Messaging/rabbitMQ` | `connectionString` |
| `Radius.Storage/objectStorage` | `connectionString`, `accountKey` |
| `Radius.AI/models` | `apiKey` |
| `Radius.AI/search` | `apiKey` |

---

# App-specific secrets

Use `Radius.Security/secrets` for API keys and tokens the app itself needs (not produced by a recipe), referenced by the container via a connection or env.

```bicep
@secure()
param apiKey string

resource appSecrets 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'app-secrets'
  properties: {
    environment: environment
    application: app.id
    data: {
      API_KEY: { value: apiKey }
    }
  }
}
```

## Common mistakes to avoid

- Do NOT write `password: 'mysecretpassword'` — always use a `@secure() param`.
- Do NOT assume a credential model by engine — read the schema and follow the properties it defines.
- Do NOT create a `Radius.Security/secrets` when the schema defines `username`/`password` — set them directly on the resource.
- Do NOT add a `secretName` input property unless the schema defines one.
- Do NOT add credentials when the schema defines no credential inputs.
- Do NOT try to read a secret **output** (connection string, URL, API key) from `CONNECTION_*_PROPERTIES` or from the resource's plain properties — it is redacted there. Bind it with `secretKeyRef` from `<resource>.properties.secrets.name`.
- Do NOT author a `Radius.Security/secrets` for a secret output — Radius creates and owns the managed secret; you only reference it.
- Keys you author in a secret's `data` are UPPERCASE (`USERNAME`, `PASSWORD`, `API_KEY`); secret-output keys you reference come from the schema's `secrets` block (e.g. `url`, `connectionString`, `apiKey`).
