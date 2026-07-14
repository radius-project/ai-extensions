# Connection Conventions

## Overview

When a Radius container has a `connection` to a resource, Radius injects environment variables into the container so your application code can discover the resource's connection details at runtime.

`Radius.Compute/containers` injects all of a connection's **non-secret** properties as a single JSON blob (see below). Sensitive recipe outputs (connection strings, URLs that embed access keys, API keys) are **not** in this blob — they are delivered through a managed secret and consumed with `secretKeyRef` (see [Secret outputs](#secret-outputs-not-in-the-connection-blob) below and [secrets-handling.md](secrets-handling.md)).

## Radius.Compute/containers — JSON Properties Blob

All properties are packed into a single JSON environment variable:

```
CONNECTION_<NAME>_PROPERTIES={"host":"...","port":"...","database":"...","username":"...","password":"..."}
CONNECTION_<NAME>_ID=<resource-id>
CONNECTION_<NAME>_NAME=<connection-name>
CONNECTION_<NAME>_TYPE=<resource-type>
```

> Property names in the JSON blob are **lowercase** (matching the resource type schema). The connection name in the env var prefix is **UPPERCASE**.

### Example

Connection named `mysqldb` to `Radius.Data/mySqlDatabases`:

| Variable | Example Value |
|----------|---------------|
| `CONNECTION_MYSQLDB_PROPERTIES` | `{"database":"todos","username":"myadmin","password":"abc123","version":"8.0","host":"mysql-svc.default.svc.cluster.local","port":"3306"}` |
| `CONNECTION_MYSQLDB_ID` | `/planes/radius/local/.../Radius.Data/mySqlDatabases/mysql` |
| `CONNECTION_MYSQLDB_NAME` | `mysqldb` |
| `CONNECTION_MYSQLDB_TYPE` | `Radius.Data/mySqlDatabases` |

## Reading Connection Properties

Parse the `CONNECTION_<NAME>_PROPERTIES` JSON blob to read a property (Node.js example):

```javascript
function getConnProp(connName, prop) {
  const propsJson = process.env[`CONNECTION_${connName}_PROPERTIES`];
  if (!propsJson) return '';
  try {
    const props = JSON.parse(propsJson);
    return props[prop.toLowerCase()] || '';
  } catch (e) {
    return '';
  }
}
```

The same pattern applies in any language: read `CONNECTION_<NAME>_PROPERTIES`, JSON-parse it, and look up the lowercase property key.

## Secret outputs (not in the connection blob)

When the connected resource's schema defines a read-only `secrets` block, its sensitive recipe outputs (connection string, URL with an embedded access key, API key) are **redacted from the resource's properties and omitted from `CONNECTION_<NAME>_PROPERTIES`**. Radius materializes them into a managed secret instead. Read them with `secretKeyRef`, not from the connection blob:

```bicep
containers: {
  todo: {
    image: todoImage.properties.imageReference
    env: {
      REDIS_URL: {
        valueFrom: {
          secretKeyRef: {
            secretName: redisCache.properties.secrets.name   // reserved read-only reference
            key: 'url'                                        // key from the schema's secrets block
          }
        }
      }
    }
  }
}
connections: {
  // Keep the connection for the NON-secret discovery vars (host, port).
  rediscache: {
    source: redisCache.id
  }
}
```

See [secrets-handling.md](secrets-handling.md) for the full pattern and the per-type secret keys.

## Valid Bicep structure

```bicep
connections: {
  mysqldb: {
    source: mysqlDb.id
  }
}
```

## Rules

1. NEVER add manual `env` entries that duplicate auto-injected vars.
2. The app must parse `CONNECTION_<NAME>_PROPERTIES` as JSON to read connection details.
3. Do NOT reference readOnly properties of other resources in Bicep — with two sanctioned exceptions: `<image>.properties.imageReference` (wiring a built image) and `<resource>.properties.secrets.name` (wiring a `secretKeyRef` to a secret output).
4. `connections` is a top-level property under `properties` — NOT inside `containers`.
5. `connections` is an object map, NOT an array.
6. `disableDefaultEnvVars` goes on the individual connection entry, NOT on the container.

## Common Gotchas

- **Case sensitivity:** JSON keys in `_PROPERTIES` are lowercase (`host`, `port`). Connection name in env var prefix is UPPERCASE (`MYSQLDB`).
- **Number types:** JSON may parse `port` as a number. Always convert to string when needed.
- **Multiple connections:** Each connection gets its own set of env vars.
- **Secrets are not in the blob:** sensitive recipe outputs are redacted from `CONNECTION_<NAME>_PROPERTIES`; read them via `secretKeyRef` from `<resource>.properties.secrets.name` (see above).