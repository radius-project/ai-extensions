# Connection Conventions

## What a connection does

A `Radius.Compute/containers` connection declares a generic Radius relationship to another resource. It can project resource properties into the workload, but it does **not** translate them into arbitrary names or formats expected by an application.

Connection projection is version-specific. Depending on the Radius/container schema and recipe, a connection may provide:

- a `CONNECTION_<NAME>_PROPERTIES` JSON value;
- individual `CONNECTION_<NAME>_<PROPERTY>` values;
- relationship metadata; and/or
- no sensitive outputs.

Inspect the exact configured extension, registered resource schema, recipe output mapping, and Radius runtime before relying on any projection shape. Do not infer it from a different version's documentation.

## Decide wiring from source

For every dependency:

1. Inspect source, entrypoint, compose, and configuration files for the exact values the workload reads.
2. Record the selected profile's required names, casing, defaults, types, literal values, URL/config syntax, endpoint transformations, and secret handling.
3. Inspect the exact resource outputs and connection projection supplied by the target schema and recipe.
4. Prove the full client tuple: subresource, complete endpoint, port, protocol/version, TLS, auth mechanism, secret, and final source-supported format.
5. Select the wiring for each app-native value:
   - explicit `env.value` from a verified nonsecret output or literal, or from a developer-supplied `@secure()` parameter (Radius encrypts and injects it);
   - `valueFrom.secretKeyRef` from an exact Recipe-generated managed secret and key via `<resource>.properties.secrets.name`;
   - runtime composition; or
   - generic connection projection only when the source explicitly consumes that applicable contract.

An unmodified third-party image usually expects its own native variables or configuration. A connection alone does not configure it unless its source already understands the projected `CONNECTION_*` contract. A provider-specific `host` output may also require a documented suffix, port, TLS mode, or auth block before it is a usable client endpoint. Requiring an operator to configure the dependency later through an admin UI or API does not make the generated deployment runnable.

## Source consumes the generic contract

When the application explicitly parses the exact projection supplied by the target Radius version, or the selected profile explicitly requires Radius relationship metadata, declare the relationship with the required key:

```bicep
connections: {
  database: {
    source: database.id
  }
}
```

`connections` is a top-level object map under container resource `properties`, not inside an individual container.

## Source expects native configuration

Map every required input to the exact name the source consumes:

```bicep
@secure()
param password string

containers: {
  api: {
    image: apiImage.properties.imageReference
    env: {
      APP_DB_HOST: {
        value: database.properties.host
      }
      APP_DB_PASSWORD: {
        value: password
      }
    }
  }
}
```

This is a representative pattern, not a required variable naming scheme. `APP_DB_PASSWORD` is set from the same `@secure()` parameter supplied to the database resource; Radius encrypts and injects it into the container without materializing it into plain state, so do not wrap it in an authored secret. Confirm that `host` is explicitly mapped by the exact Recipe and that the app-native variables exist in the pinned source. Direct resource references create dependency ordering, so a connection is not required merely to order deployment.

Keep a connection alongside native variables when the source consumes generic values or the selected profile explicitly requires Radius relationship metadata. Explicit native variables are not categorically forbidden just because generic projection exists. Ensure duplicate names do not carry conflicting values.

## Container-to-container (service-to-service) addressing

A `connections` entry to another container is for relationship metadata/projection; it does **not** supply the URL one service uses to call another. When a container makes an HTTP/gRPC call to a peer `Radius.Compute/containers` resource, compose the host by referencing the peer's read-only **`hosts`** output (a map of container name to its in-cluster Service DNS name, published by the containers recipe) over in-cluster DNS:

```bicep
env: {
  // peer resource is `resource orderingApi 'Radius.Compute/containers@...' = { name: 'ordering-api', properties: { containers: { ordering: {...} } } }`
  ORDERING_URL: {
    value: 'http://${orderingApi.properties.hosts.ordering}:8080'
  }
}
```

- Host is an entry of the peer's `properties.hosts` output (e.g. `orderingApi.properties.hosts.ordering`, where `ordering` is the peer's key in its own `containers` map), never a literal built from the resource `name` or `<resource-name>-<containerKey>`. The containers recipe populates `hosts` with each port-exposing container's actual Service FQDN, so this reference is stable, predictable, and creates a deploy-time dependency edge.
- `hosts` is read-only — reference it, never set it. It has one entry per port-exposing container, so a multi-container peer publishes all of its Service hosts.
- Port is the peer container's published `containerPort` number from source.
- Set the exact variable name, scheme, and path the calling source consumes; only the host follows this rule.

## Rules

1. Never assume a connection invents app-specific variables, URLs, credentials, database names, or protocol settings.
2. Never assume one universal JSON or scalar `CONNECTION_*` projection. Verify the target version.
3. Sensitive recipe outputs may be omitted from generic projection. Resolve and bind them through the exact secret contract described in [secrets-handling.md](secrets-handling.md).
   A recipe-generated sensitive app-native key must use an explicit `secretKeyRef` even when its name looks exactly like `CONNECTION_<NAME>_<PROPERTY>`; the matching connection does not project the secret. Bind it directly from schema-declared managed-secret metadata, never through an authored wrapper or guessed resource property. A developer-supplied credential you already hold as a `@secure()` parameter goes straight to `env.value` instead.
4. Reference a nonsecret read-only output only when the exact schema exposes it and the exact target Recipe maps it. Do not **set** read-only properties.
5. Use `disableDefaultEnvVars` only on the connection entry, only when the exact container schema supports it, and only when generic projection would conflict with the application.
6. Treat case, number-to-string conversion, URL encoding, TLS mode, and protocol-specific formatting as part of the app's runtime contract.
7. Preserve exact relationship names and provider/runtime values supplied by an explicit compatible profile; do not normalize them to generic defaults.
8. Do not count a connected resource as used unless the selected feature path consumes its projection or explicit native wiring.
9. If schema drift blocks required native or nested managed-secret wiring, resolve a compatible extension or fail closed. Never delete the binding and retain only a connection to obtain a clean compile.
