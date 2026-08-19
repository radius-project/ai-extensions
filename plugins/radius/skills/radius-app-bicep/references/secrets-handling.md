# Secrets and Credentials

Secret behavior is part of the exact resource type, extension, recipe, and container contract. Do not copy a secret path or key from another type or version.

## Resolve the contract first

For every secret, inspect:

1. the exact registered resource schema for sensitive input properties, secret references, read-only outputs, and key names;
2. the configured recipe's parameters and output mapping;
3. the exact `Radius.Security/secrets` and `Radius.Compute/containers` schemas for authored-secret connections, producer connections, and `secretKeyRef` support; and
4. the application source for the final native variable/configuration name and required format.

Preserve the application's exact environment contract. Connection projection uses `CONNECTION_<CONNECTION>_<SECRETKEY>`; the suffix follows the authored secret data key or Recipe secret output key. When the application requires a different Kubernetes environment name, bind that name explicitly through `secretKeyRef`.

Never hardcode passwords, tokens, keys, or credential-bearing URLs. Use a `@secure()` parameter for developer-supplied Bicep inputs, including values placed in an authored `Radius.Security/secrets` resource. When an existing application also requires a different native environment name, an explicit `env.value` from that same secure parameter may coexist with the authored-secret connection to preserve behavior.

## Developer-supplied secret inputs

Follow the exact resource schema:

- If it defines an `x-radius-sensitive` property such as `password`, set that property from a `@secure()` parameter.
- If it defines a secret reference such as `secretName`, author the supported secret resource and reference it exactly as the schema requires.
- If it defines no credential input, do not invent one.

When the workload consumes a developer-supplied credential through connection projection, author a `Radius.Security/secrets` resource and connect the workload to its resource ID. A sensitive backing-resource input is not readable back from that resource, so do not connect to the backing resource and expect Radius to project the supplied value:

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
  name: 'mysql-credentials'
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
      database: {
        source: mysqlCredentials.id
      }
    }
  }
}
```

The connection above injects secret-backed `CONNECTION_DATABASE_PASSWORD`; `PASSWORD` follows the authored `password` data key. The names are illustrative. Confirm the resource properties, connection key, secret data key, generated environment name, and required value format against the target version and source. If the application requires a different native name, model an explicit supported binding rather than assuming the connection renames it.

## Recipe-generated secret outputs

Some Recipes generate sensitive values such as access keys, URLs, or connection strings. Their contract varies:

- a schema version may expose a public managed-secret name and declared secret output keys;
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

If the Recipe declares an `apiKey` secret output, Radius injects it as secret-backed `CONNECTION_SERVICE_APIKEY`. The `APIKEY` suffix follows the exact Recipe output key; it does not come from a guessed resource property. Connect only to `service.id`, not `service.properties.secrets.name`.

Radius materializes Recipe secret outputs into a managed Kubernetes Secret and keeps `<producer>.properties.secrets.name` public as that Kubernetes Secret name. Use it only when the application requires an explicit custom environment name:

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

The key must be declared by the exact Recipe output contract. Never create an authored `Radius.Security/secrets` wrapper whose `data` copies a Recipe-generated value from a resource property. An authored secret is not an adapter for a missing or different output shape.

The public Recipe-managed property is `properties.secrets.name`; do not invent an alternate nested identifier or guess a key. If the exact schema/Recipe does not expose the required managed-secret name and key, report the gap. If a mutable compiled extension disagrees with that exact contract, report version drift rather than inventing a convenience property or wrapper.

If the exact contract cannot deliver a required secret by reference, report the schema/recipe gap rather than placing it in plain state.

## Runtime composition

Applications often require one URL or config value that embeds a secret. Bicep interpolation would materialize the combined value before the container starts, so prefer runtime composition:

1. Bind the secret into a helper environment variable: through an authored-secret connection for a developer-supplied credential, through a producer connection for a Recipe-generated standard `CONNECTION_*` variable, or through `secretKeyRef` from `<producer>.properties.secrets.name` for an explicit custom Kubernetes environment name.
2. Bind nonsecret host, port, database, and username values from verified outputs or literals.
3. Make sure the helper actually reaches the container's environment before the value that reads it. Authoring order does not decide this — see below.
4. Compose the final app-native value in the container runtime or let the application construct it. The final key and syntax must exactly match the selected pinned-source contract.

For a non-URL format, the application or entrypoint can compose a generated secret-backed variable such as `CONNECTION_DATABASE_PASSWORD` with separately bound nonsecret values. When preserving a pre-existing native name instead, bind the same `@secure()` parameter explicitly while retaining the authored-secret connection:

```bicep
env: {
  APP_DATABASE_OPTIONS: {
    // cache is the resource symbol; substitute your actual resource
    value: 'host=${cache.properties.host};******'
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

Two plain values are sorted against each other by name, which only matters for a developer-supplied credential: a `@secure()` parameter reaches the container through `env.value` and must not be routed through `secretKeyRef` or an authored secret, so `secretKeyRef` is not available to it and the helper is a plain value like its consumer. If the application dictates both names and the helper's does not sort first, this composition cannot be expressed — report that rather than renaming a key the application reads. `validate-bicep.mjs` fails the model when a plain value reads a plain helper that cannot reach it.

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

- **What the contract exposes.** The exact schema's nonsecret read-only outputs plus the exact keys declared under its managed-secret metadata, each proven against the Recipe that maps them. `host` and `port` are an address, not a credential.
- **What the application consumes.** The exact native key and the exact value format the pinned client parses. A client that parses a credential-bearing URL and a client that takes discrete host/port/password/TLS fields are different contracts; neither accepts the other's value.

The two shapes either match or they do not. When they match, bind them as they are — aggregate to aggregate, part to part. When they do not, that is a contract gap, and the rules below exist so it is reported rather than hidden.

### The Recipe decides whether there is a credential

Managed-secret metadata on a type says an aggregate output may carry a credential, not that one exists: a Recipe can map that same key to an unauthenticated value. Only the exact Recipe registered in the target Environment, read from its source, establishes whether the backend requires a credential and what the value's syntax is.

- **The Recipe generates a credential.** Bind it. If the client cannot consume the shape it is exposed in and no proven runtime split exists, report the gap — never fall back to wiring `host`/`port` alone. That yields a model that deploys and silently cannot authenticate, the worst available outcome, because neither the model nor the deploy says the credential was dropped.
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
- Every Recipe-generated credential consumed through standard connection projection comes from a connection to `<producer>.id`, and its `CONNECTION_<CONNECTION>_<SECRETKEY>` suffix follows the declared Recipe output key.
- Every custom Kubernetes environment name for a Recipe-generated credential uses `valueFrom.secretKeyRef` with `<producer>.properties.secrets.name` and the exact declared key.
- No authored secret `data.value` references a recipe resource output or guessed convenience property.
- No authored secret `data.value` interpolates an aggregate credential-bearing URL/config.
- No secret is hardcoded, assumed URL-safe, or assumed to appear in generic connection variables.
- An explicit `env` entry takes precedence over a generated connection variable of the same name. `disableDefaultEnvVars: true` suppresses all generated variables for that connection, so it is absent whenever the workload relies on a generated secret-backed value.
- `properties.secrets.name` remains the public Kubernetes Secret name for Recipe outputs; connections use the producer resource ID instead.
- Runtime composition preserves dependency order, escaping, encoding, and image entrypoint behavior.
- The credential shape the exact contract exposes matches the shape the pinned client parses, or the mismatch is reported. Address outputs stand alone only where the exact target Recipe is proven to provision no credential and the reply says so. No undeclared discrete property or secret key is invented, and no runtime split is assumed for an image with no shell.
- A final credential-bearing URL/config is bound from a matching managed secret or safely composed at runtime; it is never reconstructed in Bicep or an authored secret.
