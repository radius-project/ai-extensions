# Secrets and Credentials

Secret behavior is part of the exact resource type, extension, recipe, and container contract. Do not copy a secret path or key from another type or version.

## Resolve the contract first

For every secret, inspect:

1. the exact registered resource schema for sensitive input properties, secret references, read-only outputs, and key names;
2. the configured recipe's parameters and output mapping;
3. the exact `Radius.Security/secrets` and `Radius.Compute/containers` schemas for authored-secret and `secretKeyRef` support; and
4. the application source for the final native variable/configuration name and required format.

Also preserve any explicit profile requirement that a particular native key use `secretKeyRef`. Binding the same value under a helper name does not satisfy a workload that reads the required key directly.

Never hardcode passwords, tokens, keys, or credential-bearing URLs. Use a `@secure()` parameter for developer-supplied Bicep inputs. Radius carries a `@secure()` parameter to a sensitive resource property and, when the parameter is assigned to a container `env.value`, injects it into the container without materializing it into plain state.

## Developer-supplied secret inputs

Follow the exact resource schema:

- If it defines an `x-radius-sensitive` property such as `password`, set that property from a `@secure()` parameter.
- If it defines a secret reference such as `secretName`, author the supported secret resource and reference it exactly as the schema requires.
- If it defines no credential input, do not invent one.

When the application container also needs that developer-supplied credential (for example, it reads `MYSQL_PASSWORD`), assign the same `@secure()` parameter directly to the container's `env.value`. Radius encrypts the parameter and injects it into the container, so do not author a `Radius.Security/secrets` wrapper for a value you already hold as a parameter, and do not route it through `secretKeyRef`. A sensitive resource *input* is not readable back from the resource, so supply the value to the app from the same parameter:

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

resource apiContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'api'
  properties: {
    environment: environment
    application: app.id
    containers: {
      api: {
        image: apiImage.properties.imageReference
        env: {
          MYSQL_PASSWORD: {
            value: password
          }
        }
      }
    }
  }
}
```

The names above are illustrative. Confirm the resource properties, the app-native variable name, and the required value format against the target version and source. Reserve authored `Radius.Security/secrets` + `secretKeyRef` for recipe-generated managed-secret outputs (below) and for genuine application secrets or types whose schema requires `secretName`.

## Recipe-generated secret outputs

Some recipes generate sensitive values such as access keys, URLs, or connection strings. Their contract varies:

- a schema version may expose a managed-secret reference and declared secret keys;
- another version may use a different output shape or key names; or
- the configured recipe may not expose the value in a form containers can bind.

When the exact schema and recipe declare managed-secret metadata, that is the only supported projection path:

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

The names are illustrative. `properties.secrets.name` identifies the managed `Radius.Security/secrets` resource, while other fields declared under `properties.secrets` name keys stored in that resource. They are metadata, not secret values readable from `service.properties.apiKey` or `service.properties.secrets.apiKey`.

Bind a complete managed URL/connection string directly to the app-native key when its format matches the pinned source. Never create an authored `Radius.Security/secrets` wrapper whose `data` copies a recipe-generated value from a resource property. An authored secret is not an adapter for a missing or different output shape.

Do not assume one universal `properties.secrets` path or guess a key. If the exact schema/recipe does not expose the required managed-secret reference and key, report the gap. If a mutable compiled extension disagrees with that exact contract, report version drift rather than inventing a convenience property or wrapper.

If the exact contract cannot deliver a required secret by reference, report the schema/recipe gap rather than placing it in plain state.

## Runtime composition

Applications often require one URL or config value that embeds a secret. Bicep interpolation would materialize the combined value before the container starts, so prefer runtime composition:

1. Bind the secret into a helper environment variable: from the `@secure()` parameter via `env.value` for a developer-supplied credential, or via `secretKeyRef` from `<resource>.properties.secrets.name` for a recipe-generated output.
2. Bind nonsecret host, port, database, and username values from verified outputs or literals.
3. Declare the helper before dependent values when the runtime requires ordering.
4. Compose the final app-native value in the container runtime or let the application construct it. The final key and syntax must exactly match the selected pinned-source contract.

For a non-URL format, the pattern can look like:

```bicep
env: {
  DB_PASSWORD: {
    value: password
  }
  APP_DATABASE_OPTIONS: {
    value: 'host=${mysql.properties.host};password=$(DB_PASSWORD)'
  }
}
```

Kubernetes expands `$(VAR_NAME)` only from variables declared earlier in the environment list. Confirm the exact container recipe preserves this order, and preserve escaping through Bicep and any shell/config layer. Confirm the image has every shell or utility used by an entrypoint wrapper.

Credentials embedded in URLs must be URL-encoded. Kubernetes variable expansion does not encode them; use application logic or a verified runtime helper. If safe encoding cannot be guaranteed, do not generate a fragile connection string.

## Checklist

- The input property, secret resource, managed-secret path, and key all exist in the exact configured schemas and recipe.
- Every container variable uses the exact native name and format read by source.
- Every profile-required secret environment key uses `valueFrom.secretKeyRef` on that exact key.
- Recipe-generated secrets bind directly from the exact declared managed-secret name and key.
- No authored secret `data.value` references a recipe resource output or guessed convenience property.
- No secret is hardcoded, interpolated into a plain Bicep value, or assumed to appear in generic connection variables.
- A developer-supplied `@secure()` value reaches the app through a schema-sensitive property or by direct assignment to `env.value`; `secretKeyRef` and authored secret resources are reserved for recipe-generated managed secrets or schema-required `secretName` inputs.
- Runtime composition preserves dependency order, escaping, encoding, and image entrypoint behavior.
- A final credential-bearing URL/config is either bound directly from a matching managed secret or composed at runtime from secret references; it is never reconstructed in Bicep plain state.
