# Secrets and Credentials

Secret behavior is part of the exact resource type, extension, recipe, and container contract. Do not copy a secret path or key from another type or version.

## Resolve the contract first

For every secret, inspect:

1. the exact registered resource schema for sensitive input properties, secret references, read-only outputs, and key names;
2. the configured recipe's parameters and output mapping;
3. the exact `Radius.Security/secrets` and `Radius.Compute/containers` schemas for authored-secret connections, producer connections, and `secretKeyRef` support; and
4. the application source for the final native variable/configuration name and required format.

Preserve the application's exact environment contract. Connection projection uses `CONNECTION_<CONNECTION>_<SECRETKEY>`; the suffix is the uppercased authored Secret data key or Recipe `result.secrets` key. When the application requires a different Kubernetes environment name, bind that name explicitly through `secretKeyRef`.

Never hardcode passwords, tokens, keys, or credential-bearing URLs. Use a `@secure()` parameter for developer-supplied Bicep inputs, including values placed in an authored `Radius.Security/secrets` resource. Prefer an authored Secret with `secretKeyRef` or a compatible Secret connection. Bind the secure parameter directly to `env.value` only as an explicit schema-supported or legacy compatibility fallback required by the existing native contract: it is weaker because the resolved value is stored in the Radius container resource and generated Pod specification.

## Developer-supplied secret inputs

Decide each credential input from the schema, never from the property's name. A credential input property is one of two kinds:

- **Inline sensitive value** — the schema marks the property `x-radius-sensitive: true`. Assign the `@secure()` parameter directly to that property, as `Radius.Data/mySqlDatabases.password` requires.
- **Secret resource reference** — the schema types the property as a plain, non-sensitive `string` whose description identifies it as the resource ID of a `Radius.Security/secrets` resource. Author or reuse that Secret and assign `<secret>.id`, as `Radius.Messaging/rabbitMQ.password` requires. Never assign a `@secure()` parameter to a reference property.
- If the schema defines no credential input, do not invent one. Where a reference property is optional and the application does not need to own the credential, omitting it and consuming the Recipe-generated credential is valid.

A property named `password` may be either kind, and a reference property may be named `password`, `passwordSecret`, or `secretName`. The name carries no information — read the schema. Assigning a raw credential to a reference property is a deployment failure rather than a style difference: the Recipe derives the Kubernetes Secret name for `secretKeyRef` from that value, and Kubernetes rejects a password as an RFC 1123 subdomain.

`validate-bicep.mjs` enforces this from the same schema evidence. It reads the sensitivity `show-radius-type.mjs` staged for every resolved type and fails the compile when a `@secure()` parameter is assigned directly to a property the schema does not mark sensitive, naming the resource and property it rejected. The check reads the compiled template, so it sees a whole `@secure()` parameter assigned to a property of a resource's properties envelope; a credential that reaches the property through a variable, a string interpolation, or a nested object is not reported and remains yours to get right. It checks only where the credential is assigned, never what the authored Secret puts inside: the data-key contract below is not verified by any check, so a Secret with the wrong key casing compiles and passes the checker and still fails at container start.

When the workload consumes a developer-supplied credential through connection projection, author or reuse a `Radius.Security/secrets` resource and connect the workload to its resource ID. A sensitive backing-resource input is not readable back from that resource, so do not connect to the backing resource and expect Radius to project the supplied value. Developer-owned inputs remain inputs and must not be returned through Recipe `result.secrets`, as reflected by the PostgreSQL and MySQL ownership corrections in [resource-types-contrib#298](https://github.com/radius-project/resource-types-contrib/pull/298) and [resource-types-contrib#315](https://github.com/radius-project/resource-types-contrib/pull/315):

```bicep
@secure()
param password string

resource mysql 'Radius.Data/mySqlDatabases@2025-08-01-preview' = {
  name: 'mysql'
  properties: {
    environment: environment
    application: app.id
    username: 'myadmin'
    password: password
  }
}

resource mysqlCredentials 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'mysql-client-credentials'
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

resource apiContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'api'
  properties: {
    environment: environment
    application: app.id
    containers: {
      api: {
        image: apiImage.properties.imageReference
      }
    }
    connections: {
      mysql: {
        source: mysql.id
      }
      mysqlSecret: {
        source: mysqlCredentials.id
      }
    }
  }
}
```

The `mysql` producer connection projects verified ordinary outputs such as `CONNECTION_MYSQL_HOST` and `CONNECTION_MYSQL_PORT`. The authored Secret connection injects `CONNECTION_MYSQLSECRET_PASSWORD`: `MYSQLSECRET` is the `mysqlSecret` connection map key uppercased without inserting a separator, and `PASSWORD` is the uppercased authored `password` data key. The names are illustrative. Confirm the resource properties, connection keys, Secret data key, generated environment names, and required value format against the target version and source. Keep the authored Secret name distinct from Recipe-owned Kubernetes Secret names. If the application requires a different native name, model an explicit supported binding rather than assuming the connection renames it.

### The same property name, the opposite form

`Radius.Messaging/rabbitMQ` also defines a property named `password`, but its schema types it as a plain, non-sensitive `string` whose description identifies it as the resource ID of a `Radius.Security/secrets` resource holding the broker password under the data key `password`. It therefore takes `<secret>.id` — the exact opposite of the identically named `Radius.Data/mySqlDatabases.password` above, which takes the secure parameter inline:

```bicep
@secure()
param rabbitmqPassword string

resource rabbitmqCredentials 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'rabbitmq-credentials'
  properties: {
    environment: environment
    application: app.id
    data: {
      password: {
        value: rabbitmqPassword
      }
    }
  }
}

resource rabbitmq 'Radius.Messaging/rabbitMQ@2025-08-01-preview' = {
  name: 'rabbitmq'
  properties: {
    environment: environment
    application: app.id
    queue: 'orders'          // derived from source (e.g. ORDER_QUEUE_NAME)
    username: 'myadmin'      // authored broker administrator; consumers authenticate as this same value
    password: rabbitmqCredentials.id
  }
}
```

Writing `password: rabbitmqPassword` here deploys a broken application: the Recipe reads the property as a resource ID and uses its last segment as the Kubernetes Secret name in `secretKeyRef`, so the supplied password becomes the looked-up Secret name and Kubernetes rejects the Deployment because a password is not a lowercase RFC 1123 subdomain. Because the property is optional, omitting it entirely and consuming the Recipe-generated credential is also valid. Resolve every credential property's kind from `show-radius-type.mjs` output before assigning it; two types that share a property name do not share a convention.

### The data key is part of the contract

Pointing at the right Secret is only half of a reference property's contract. When a schema property references a `Radius.Security/secrets` resource, the authored Secret must expose the value under the exact data key the consuming schema names, matching case. The key is fixed by the consuming type and its Recipe, not chosen by the model.

- Data keys are case-sensitive. Do not uppercase them by convention, and do not assume the key matches the property name, the resource name, or the application's environment-variable name.
- Read the required key from the consuming type's schema description, not from the native variable the application happens to call it. `Radius.Messaging/rabbitMQ.password` is documented as the resource ID of the `Radius.Security/secrets` resource that holds the broker password under the data key `password`, so the authored key is exactly `password`.
- Every `secretKeyRef.key` that reads the same authored Secret must use that same exact key. The uppercased form appears only in a generated `CONNECTION_<CONNECTION>_<SECRETKEY>` variable name; it is a projection of the key, never a replacement for it.

In the example above the authored data key is `password`, the broker receives `rabbitmqCredentials.id`, and a container reading the same Secret uses the identical lowercase key:

```bicep
RABBITMQ_PASSWORD: {
  valueFrom: {
    secretKeyRef: {
      secretName: rabbitmqCredentials.name
      key: 'password'
    }
  }
}
```

Authoring that data key as `PASSWORD` fails even though the Bicep compiles and the resource ID is correct. The RabbitMQ Kubernetes Recipe reads a hardcoded lowercase `password` key from the resolved Secret, so the broker Pod resolves the right Secret, finds no `password` entry, and never starts — a `CreateContainerConfigError` rather than an admission failure. A key-casing mismatch is not cosmetic, and it survives every check that only validates the resource ID.

## Recipe-generated secret results

Some Recipes generate sensitive values such as access keys, URLs, or connection strings through `result.secrets`. Their contract varies:

- a schema version may expose a public managed-secret name and declared `result.secrets` keys;
- another version may use a different output shape or key names; or
- the configured recipe may not expose the value in a form containers can bind.

Use a connection to the producer resource for the standard connection environment:

```bicep
connections: {
  service: {
    source: service.id
  }
}
```

If the Recipe declares `apiKey` in `result.secrets`, Radius injects it as secret-backed `CONNECTION_SERVICE_APIKEY`. The `APIKEY` suffix is the uppercased exact result key; it does not come from a guessed resource property. Connect only to `service.id`, not `service.properties.secrets.name`.

Radius materializes Recipe `result.secrets` entries into a managed Kubernetes Secret and keeps `<producer>.properties.secrets.name` public as that Kubernetes Secret name. Use it only when the application requires an explicit custom environment name:

```bicep
APP_API_KEY: {
  valueFrom: {
    secretKeyRef: {
      secretName: service.properties.secrets.name
      key: 'apiKey'
    }
  }
}
```

The key must be declared by the exact Recipe `result.secrets` contract. Never create an authored `Radius.Security/secrets` wrapper whose `data` copies a Recipe-generated value from a resource property. An authored secret is not an adapter for a missing or different output shape.

The public Recipe-managed property is `properties.secrets.name`; do not invent an alternate nested identifier or guess a key. If the exact schema/Recipe does not expose the required managed-secret name and key, report the gap. If a mutable compiled extension disagrees with that exact contract, report version drift rather than inventing a convenience property or wrapper.

If the exact contract cannot deliver a required secret by reference, report the schema/recipe gap rather than placing it in plain state.

## Runtime composition

Applications often require one URL or config value that embeds a secret. Bicep interpolation would materialize the combined value before the container starts, so prefer runtime composition:

1. Bind the secret into a helper environment variable: through an authored-secret connection for a developer-supplied credential, through a producer connection for a Recipe-generated standard `CONNECTION_*` variable, or through `secretKeyRef` from `<producer>.properties.secrets.name` for an explicit custom Kubernetes environment name.
2. Bind nonsecret host, port, database, and username values from verified outputs or literals.
3. Make sure the helper actually reaches the container's environment before the value that reads it. Authoring order does not decide this — see below.
4. Compose the final app-native value in the container runtime or let the application construct it. The final key and syntax must exactly match the selected pinned-source contract.

For a non-URL format, the application or entrypoint can compose a generated secret-backed variable such as `CONNECTION_DATABASE_PASSWORD` with separately bound nonsecret values. When preserving a pre-existing native name for a Recipe-generated credential instead, bind the declared Recipe result through an explicit `secretKeyRef`:

```bicep
env: {
  APP_DATABASE_OPTIONS: {
    // cache is the resource symbol; substitute your actual resource
    value: 'host=${cache.properties.host};password=$(DB_PASSWORD)'
  }
  DB_PASSWORD: {
    valueFrom: {
      secretKeyRef: {
        secretName: cache.properties.secrets.name
        key: 'password'
      }
    }
  }
}
```

`DB_PASSWORD` sorts after the value that reads it, and still resolves: the recipe emits every `secretKeyRef` variable ahead of every plain value, so a recipe-generated credential is bound under the exact name the application reads and ordering never enters into it.

Kubernetes expands `$(VAR_NAME)` only from variables earlier in the container's environment list, and the recipe decides that order, not the order you write the `env` map in. The containers recipe builds the list with `items()`, which sorts by key, so authored order is discarded — writing the helper first buys nothing.

What the Kubernetes recipe does guarantee is that `secretKeyRef` variables are emitted before plain `value` variables. So a composed value can always read a secret-backed helper, whatever the two keys are called, and that is the form to prefer.

Two plain values are sorted against each other by name. This still matters when preserving an existing developer-supplied `@secure()` `env.value` fallback: if the application dictates both names and the helper's does not sort first, that composition cannot be expressed — report it rather than renaming a key the application reads. On a verified compatible Kubernetes Container Recipe, an explicitly requested migration may instead use an authored or reused Secret connection, whose generated value is secret-backed and emitted before plain values. `validate-bicep.mjs` fails the model when a plain value reads a plain helper that cannot reach it.

Verify this against the exact target recipe rather than carrying it over: the Azure ACI recipe emits every variable in one name-sorted list with no such separation, and `$(VAR_NAME)` expansion is a Kubernetes container behavior to begin with, so this composition pattern does not hold on every platform.

Preserve escaping through Bicep and any shell/config layer, and confirm the image has every shell or utility used by an entrypoint wrapper. The inverse direction — the contract exposes one aggregate value and the application wants the parts — is governed by [Credential shape](#credential-shape); it is not symmetric with composition and is usually a contract gap to report.

Credentials embedded in URLs must be URL-encoded. Kubernetes variable expansion does not encode them; use application logic or a verified runtime helper. If safe encoding cannot be guaranteed, do not generate a fragile connection string.

Do not assume an unconstrained developer-supplied password is URL-safe, recommend a restricted character set as a workaround, or treat shell expansion as encoding. Prefer source-native decomposed host, port, database, username, password, and TLS flags or fields when the application safely assembles the final client value.

### Authored secrets are not composition engines

`Radius.Security/secrets` can carry an exact application secret, but it does not turn Bicep interpolation into runtime composition. Never manufacture an aggregate credential-bearing URL or configuration in authored `data.value`, regardless of whether its other parts come from outputs, parameters, variables, or literals.

When the application accepts only one credential-bearing value, choose one proven path:

1. Bind an exact, source-compatible connection string from schema-declared managed-secret metadata.
2. Bind the parts separately and use a verified application, entrypoint, or helper that safely encodes and composes them at runtime.

If neither path exists, report the schema/application contract gap and do not emit a definition described as deployable.

## Credential shape

A resource type being available does not prove its credential fits the client. Before wiring any dependency that authenticates, resolve both sides:

- **What the contract exposes.** Use the batched resolver's exact `resources[].schema` for nonsecret read-only outputs and managed-secret metadata. Then inspect the selected Recipe that maps those values. Use `resources[].recipe.definition` for the managed-default Azure profile; when explicit target evidence selects an override, inspect that exact target Recipe instead. Prove target-Environment registration separately. `host` and `port` are an address, not a credential.
- **What the application consumes.** The exact native key and the exact value format the pinned client parses. Record literal examples from the selected manifest, chart, Compose file, or configuration alongside the source read and client constructor. A configured `host:port` value proves an address shape; do not replace it directly with a Recipe `url` or `connectionString` unless their aggregate syntax matches. A package name without a checked-in consumer is not evidence, but an exact pinned dependency plus the checked-in call site that passes the value to that client's configuration API identifies the parser contract and permits using that client's documented syntax. Combine that evidence with checked-in parser code, selected-profile literals, and the selected Recipe's auth and output mappings.

For StackExchange.Redis, distinguish its configuration string from a Redis URI. When pinned .NET source passes a native setting such as `REDIS_ADDR` to `RedisCacheOptions.Configuration` or `ConfigurationOptions.Parse`, the client expects StackExchange.Redis option syntax such as `host:port,ssl=True`, with credentials supplied through supported options when required; a Recipe `result.secrets.url` value such as `rediss://...` is not the same aggregate shape. Never bind that Recipe key directly to the native setting with `secretKeyRef`, rename `CONNECTION_REDIS_URL` to the native setting, or treat the `ADDR` name and string type as compatibility evidence. A Recipe URL may still be bound directly when the checked-in source passes it to an API that accepts that exact URI syntax.

First look for a direct match: aggregate to aggregate or part to part. If an aggregate output does not match, inspect every schema-declared discrete output before refusing. A Recipe that exposes `host`, `port`, and a credential such as `accessKey` can support an application that reads one aggregate setting when the pinned client parser accepts a safely composed value and the runtime composition rules below are satisfied. Do not require a checked-in credential-bearing literal, because credentials must not be committed. If the client instead needs parts and the Recipe exposes only an aggregate, consider runtime decomposition under the stricter rules below. Classify compatibility as unknown only after direct binding and every supported composition or decomposition path have been exhausted.

### The Recipe decides whether there is a credential

Managed-secret metadata on a type says an aggregate output may carry a credential, not that one exists: a Recipe can map that same key to an unauthenticated value. The selected exact Recipe establishes whether the backend requires a credential and what the value's syntax is. Perform this check before authoring. For the managed-default Azure profile, inspect `resources[].recipe.definition` from the resolver without following its provenance links. For an override selected by explicit target evidence, inspect that exact Recipe from the supplied modeling context or target repository. Target-Environment registration is a separate requirement that must match the selected Recipe; do not defer the credential-shape check until registration or deployment readiness.

- **The Recipe generates a credential.** Bind it. Inspect every credential representation the Recipe exposes. If the client cannot consume one directly, use schema-declared discrete outputs for safe client-native composition or a proven runtime decomposition path. If none exists, report the gap; never fall back to wiring `host`/`port` alone. That yields a model that deploys and silently cannot authenticate, the worst available outcome, because neither the model nor the deploy says the credential was dropped.
- **The Recipe provably generates no credential.** Address-only wiring is complete for that Environment, since there is nothing to drop. Say so in the reply: name the Recipe and state that a Recipe generating a credential would require rewiring.
- **The Recipe cannot be resolved.** Treat the declared credential as required and apply the first case. An unproven assumption that the backend is open is the same silent failure, arrived at by guessing.

### Never reconstruct a credential you cannot read

A declared managed-secret key is metadata, not a readable value, so an aggregate credential cannot be split in Bicep at all — there is nothing there to split. Do not:

- read a declared key as `<resource>.properties.<key>` or `<resource>.properties.secrets.<key>` to slice or reformat it;
- invent a discrete property (for example `password`, `accessKey`, `primaryKey`) that the exact schema does not declare, or bind a key name the managed-secret metadata does not declare;
- author a `Radius.Security/secrets` whose `data` derives parts from an aggregate output or an aggregate from parts — an authored secret is no more a decomposition engine than a composition engine; or
- generate a `Radius.Resources/*` custom type to obtain a shape the predefined type does not expose (see [custom-resource-types.md](custom-resource-types.md#when-to-generate-a-custom-type)).

### Runtime decomposition needs a proven process

Splitting an aggregate at runtime is the mirror of composing one and carries the mirror hazard: Kubernetes `$(VAR_NAME)` expansion cannot slice a value at all, and slicing in a shell does not percent-decode, so a credential that had to be URL-encoded into the aggregate comes back out wrong in exactly the cases that made encoding necessary. Treat decomposition as available only when one of these is proven:

1. the application performs the split itself — its client accepts the aggregate, or its own configuration parses it into the fields it needs. This is the preferred form, because no wrapper is involved; or
2. the pinned image already contains the shell, utilities, or executable parser the wrapper would use, the exact container schema supports the entrypoint/argument override, the override preserves the image's own entrypoint contract, and the split decodes correctly for every value the exact Recipe can generate.

Establish that from the pinned image itself, not from its base's reputation: a `scratch`, distroless, or chiseled image normally has no shell, some debug variants of the same images do, and a compiled entrypoint that parses the value can succeed where a shell wrapper is impossible. What modeling cannot do is add a parser to an image it does not build, so for a third-party image the capability either exists at the modeled revision or option 2 does not apply.

### Report the gap

When neither shape matches and no proven decomposition path exists, this is a verified incompatibility: stop before the origin record and do not publish the run. Report, in the user's terms:

- the resource type and API version, the Recipe it resolves to in the target Environment, and the credential keys that Recipe actually exposes;
- the app-native key that needs a different shape, the source file and line that reads it, and the format that client accepts;
- why runtime decomposition is unavailable — naming the pinned image and what it lacks when that is the reason; and
- what would unblock it: the application consuming the exposed shape, or a Recipe/schema that exposes the values the client needs.

Do not return the definition as deployable with the dependency unwired, silently unauthenticated, or hardcoded, and do not ask the user to choose between two wirings that are both wrong.

## Checklist

- The input property, authored secret, producer connection, managed-secret name, and key all exist in the exact configured schemas and Recipe.
- Every container variable uses the exact native name and format read by source.
- Every developer-supplied credential consumed through connection projection is in an authored `Radius.Security/secrets` connected through `<secret>.id`.
- Every authored Secret used for an explicit native or compatibility-fallback binding is referenced through `valueFrom.secretKeyRef` with `<secret>.name` and its exact declared data key.
- Every Recipe-generated credential consumed through standard connection projection comes from a connection to `<producer>.id`, and its `CONNECTION_<CONNECTION>_<SECRETKEY>` suffix is the uppercased declared Recipe `result.secrets` key.
- Every custom Kubernetes environment name for a Recipe-generated credential uses `valueFrom.secretKeyRef` with `<producer>.properties.secrets.name` and the exact declared key.
- No authored secret `data.value` references a recipe resource output or guessed convenience property.
- No authored secret `data.value` interpolates an aggregate credential-bearing URL/config.
- No secret is hardcoded, assumed URL-safe, or assumed to appear in generic connection variables.
- An explicit `env` entry takes precedence over a generated connection variable of the same name. `disableDefaultEnvVars: true` suppresses all generated variables for that connection, so it is absent whenever the workload relies on a generated secret-backed value.
- A managed `result.secrets` reference wins over an ordinary generated connection value with the same normalized name; Secret-derived keys that normalize to the same uppercase variable name fail validation.
- `properties.secrets.name` remains the public Kubernetes Secret name for Recipe outputs; connections use the producer resource ID instead.
- Runtime composition preserves dependency order, escaping, encoding, and image entrypoint behavior.
- The credential shape the exact contract exposes directly matches the shape the pinned client parses, or every schema-declared discrete output and supported runtime composition or decomposition path was considered before the mismatch was reported. Address outputs stand alone only where the exact target Recipe is proven to provision no credential and the reply says so. No undeclared discrete property or secret key is invented, and no runtime split is assumed for an image with no shell.
- A final credential-bearing URL/config is bound from a matching managed secret or safely composed at runtime; it is never reconstructed in Bicep or an authored secret.
