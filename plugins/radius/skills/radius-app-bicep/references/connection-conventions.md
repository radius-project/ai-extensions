# Connection Conventions

## What a connection does

A `Radius.Compute/containers` connection declares a generic Radius relationship to another resource. It can project resource properties into the workload, but it does **not** translate them into arbitrary names or formats expected by an application.

Connection projection is version-specific. Depending on the Radius/container schema and recipe, a connection may provide:

- a `CONNECTION_<NAME>_PROPERTIES` JSON value;
- individual `CONNECTION_<NAME>_<PROPERTY>` values, including secret-backed `CONNECTION_<CONNECTION>_<SECRETKEY>` values for connected Secrets and Recipe `result.secrets` entries;
- relationship metadata; and/or
- no sensitive outputs.

Inspect the exact configured extension, registered resource schema, recipe output mapping, and Radius runtime before relying on any projection shape. Do not infer it from a different version's documentation.

## Compatibility and gradual adoption

Secret-backed `CONNECTION_*` projection is behavior of the Kubernetes Container Recipe. It requires compatible Radius control-plane support ([radius#12709](https://github.com/radius-project/radius/pull/12709)) and compatible Container Recipes ([resource-types-contrib#300](https://github.com/radius-project/resource-types-contrib/pull/300) or later). Read the control-plane version with `rad version --output json`, inspect configured Recipe/template metadata with `rad recipe show <name> --resource-type <type> --output json`, and verify the resolved schema plus pinned Recipe tag or digest. These signals establish projection only when they resolve to a known compatible control-plane version and exact template contract; mixed, unknown, or older installations must preserve explicit wiring.

If compatibility cannot be proven, preserve or use the existing schema-supported wiring: explicit `env`, `valueFrom.secretKeyRef`, `envFrom`, the application's native variable, or another contract the target installation supports. For developer-supplied credentials, prefer an authored Secret with `secretKeyRef`; preserve a direct `@secure()` parameter-to-`env.value` binding only when the exact schema or legacy native contract requires it, because the resolved value is stored in the Radius container resource and generated Pod specification. Do not emit a connection-only model that depends on unverified projection. Do not automatically rewrite an existing working `app.bicep`; migration to secret-backed connections requires explicit user intent.

Azure Container Instances (ACI) behavior is unchanged. Do not recommend Kubernetes secret-backed connection projection for ACI.

## Decide wiring from source

For every dependency:

1. Inspect source, entrypoint, compose, and configuration files for the exact values the workload reads.
2. Record the selected profile's required names, casing, defaults, types, literal values, URL/config syntax, endpoint transformations, and secret handling.
3. Inspect the exact resource outputs and connection projection supplied by the target schema and recipe.
4. Prove the full client tuple: subresource, complete endpoint, port, protocol/version, TLS, auth mechanism, secret, and final source-supported format. Include the credential's **shape**: an aggregate URL and discrete host/port/password fields are different contracts, and a client accepts only the one it parses (see [Credential shape](secrets-handling.md#credential-shape)).
5. Select the wiring for each app-native value:
   - explicit `env.value` from a verified nonsecret output or literal;
   - a user-authored `Radius.Security/secrets` connection through `<secret>.id` for a developer-supplied credential;
   - a producer connection through `<producer>.id` for a Recipe-generated credential;
   - `valueFrom.secretKeyRef` through `<secret>.name` and a declared authored data key when preserving a native variable or compatibility fallback;
   - `valueFrom.secretKeyRef` through `<producer>.properties.secrets.name` only when a Recipe result requires a custom Kubernetes environment variable name;
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

For a developer-supplied credential, author the secret and connect to the secret resource ID:

```bicep
@secure()
param password string

resource credentials 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'database-client-credentials'
  properties: {
    environment: environment
    application: app.id
    data: {
      password: {
        value: password
      }
    }
  }
}

connections: {
  database: {
    source: credentials.id
  }
}
```

This connection injects secret-backed `CONNECTION_DATABASE_PASSWORD`. The `PASSWORD` suffix is the uppercased authored `password` data key. Preserve the exact key required by the source contract, and choose a Secret resource name that does not collide with a Recipe-owned Kubernetes Secret.

For a Recipe-generated credential, connect only to the producer. For example, a Redis consumer connects directly to the Redis resource:

```bicep
connections: {
  redis: {
    source: redisCache.id
  }
}
```

If the Redis Recipe declares `url` in `result.secrets`, the connection injects secret-backed `CONNECTION_REDIS_URL`. The suffix is the uppercased exact result key; do not author a wrapper Secret, connect to `redisCache.properties.secrets.name`, or invent a different suffix.

## Source expects native configuration

Map every required input to the exact name the source consumes:

```bicep
containers: {
  api: {
    image: apiImage.properties.imageReference
    env: {
      APP_DB_HOST: {
        value: database.properties.host
      }
    }
  }
}
```

This is a representative pattern for nonsecret values, not a required variable naming scheme. Supply credentials through the authored-secret or producer connection patterns above. If a developer-supplied credential must retain a different native environment name, prefer an authored Secret `secretKeyRef`; preserve a direct `env.value` from the same `@secure()` parameter only as an explicit schema-supported or legacy compatibility fallback, recognizing that the resolved value is stored in the Radius container resource and generated Pod specification. Confirm that `host` is explicitly mapped by the exact Recipe and that the app-native variables exist in the pinned source. Direct resource references create dependency ordering, so a connection is not required merely to order deployment.

Keep a connection alongside native variables when the source consumes generic values or the selected profile explicitly requires Radius relationship metadata. Explicit native variables are not categorically forbidden just because generic projection exists. An explicit `env` entry with the same name takes precedence over a generated connection variable. Set `disableDefaultEnvVars: true` on a connection only when all generated variables from that connection must be suppressed; do not set it when the workload depends on a generated secret-backed variable.

## Container-to-container (service-to-service) addressing

A `connections` entry to another container is for relationship metadata/projection; it does **not** supply the URL one service uses to call another. When a container makes an HTTP/gRPC call to a peer `Radius.Compute/containers` resource, compose the host by referencing the peer's read-only **`hosts`** output (a map of container name to its in-cluster Service DNS name, published by the containers recipe) over in-cluster DNS:

```bicep
env: {
  // peer resource is `resource orderingApi 'Radius.Compute/containers@...' = { name: 'ordering-api', properties: { containers: { ordering: {...} } } }`
  ORDERING_URL: {
    value: 'http://${orderingApi.properties.hosts['ordering']}:8080'
  }
}
```

- Host is an entry of the peer's `properties.hosts` output, addressed with **indexed access** (e.g. `orderingApi.properties.hosts['ordering']`, where `ordering` is the peer's key in its own `containers` map), never a literal built from the resource `name` or `<resource-name>-<containerKey>`. Use indexed (`['...']`) rather than dot access so keys containing hyphens or other non-identifier characters resolve. The containers recipe populates `hosts` with each port-exposing container's actual Service FQDN, so this reference is stable, predictable, and creates a deploy-time dependency edge.
- `hosts` is read-only — reference it, never set it. It has one entry per port-exposing container, so a multi-container peer publishes all of its Service hosts.
- Do not create a dependency cycle: because each `hosts` reference adds a deploy-time dependency edge, two containers that both reference each other's `hosts` form a circular dependency that fails to deploy. Break it by resolving one direction through `hosts` and the other via the peer's Service DNS name as a plain string literal (`<peer-resource-name>-<containerKey>.<namespace>`). This cycle break is the deliberate exception to the no-literal rule above. Report the cycle rather than emitting mutual references or adding a route for internal traffic.
- Port is the peer container's published `containerPort` number from source.
- Set the exact variable name, scheme, and path the calling source consumes; only the host follows this rule.

## Rules

1. Never assume a connection invents app-specific variables, URLs, credentials, database names, or protocol settings.
2. Never assume one universal JSON or scalar `CONNECTION_*` projection. Verify the target version.
3. On a compatible Kubernetes Container Recipe, a connection to a user-authored or reused `Radius.Security/secrets` resource projects its data as secret-backed `CONNECTION_<CONNECTION>_<SECRETKEY>` variables. A connection to a producer projects its Recipe `result.secrets` entries the same way. The suffix is the uppercased exact authored data key or Recipe result key.
   `<CONNECTION>` is the connection map key uppercased without inserting separators: `postgresSecret` becomes `POSTGRESSECRET`, producing names such as `CONNECTION_POSTGRESSECRET_USERNAME`.
   Use `<producer>.properties.secrets.name` only with `valueFrom.secretKeyRef` when the application requires a custom Kubernetes environment variable name. Never use that Kubernetes Secret name as a connection source, author a wrapper around a Recipe output, or guess a resource convenience property.
   Nonsecret `host`/`port` outputs are an address, not a credential: wiring only the address is complete only where the exact target Recipe provably generates no credential — otherwise it silently drops authentication. When the credential the Recipe generates is exposed in a shape the client cannot parse, report the gap per [Credential shape](secrets-handling.md#credential-shape) instead of wiring the address alone.
4. Reference a nonsecret read-only output only when the exact schema exposes it and the exact target Recipe maps it. Do not **set** read-only properties.
5. An explicit `env` entry wins when it has the same name as a generated connection variable. Among generated variables, a managed `result.secrets` reference takes precedence over an ordinary connection value with the same normalized name; two Secret-derived keys that normalize to the same uppercase name fail validation rather than choosing one. Use `disableDefaultEnvVars` only on the connection entry, only when the exact container schema supports it, and only when all generated variables from that connection should be disabled.
6. Treat case, number-to-string conversion, URL encoding, TLS mode, and protocol-specific formatting as part of the app's runtime contract.
7. Preserve exact relationship names and provider/runtime values supplied by an explicit compatible profile; do not normalize them to generic defaults.
8. Do not count a connected resource as used unless the selected feature path consumes its projection or explicit native wiring.
9. If schema drift blocks required connection or managed-secret wiring, resolve a compatible extension or fail closed. Never delete the binding to obtain a clean compile.
