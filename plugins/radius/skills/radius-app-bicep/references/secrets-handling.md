# Secrets and Credentials

Secret behavior is part of the exact resource type, extension, recipe, and container contract. Do not copy a secret path or key from another type or version.

## Resolve the contract first

For every secret, inspect:

1. the exact registered resource schema for sensitive input properties, secret references, read-only outputs, and key names;
2. the configured recipe's parameters and output mapping;
3. the exact `Radius.Security/secrets` and `Radius.Compute/containers` schemas for authored-secret and `secretKeyRef` support; and
4. the application source for the final native variable/configuration name and required format.

Also preserve any explicit profile requirement that a particular native key use `secretKeyRef`. Binding the same value under a helper name does not satisfy a workload that reads the required key directly.

Never hardcode passwords, tokens, keys, or credential-bearing URLs. Use a `@secure()` parameter for developer-supplied Bicep inputs, but do not mistake that decorator for end-to-end secret handling: it protects parameter treatment and display, not every downstream resource property or container `env.value`.

## Developer-supplied secret inputs

Follow the exact resource schema:

- If it defines an `x-radius-sensitive` property such as `password`, set that property from a `@secure()` parameter.
- If it defines a secret reference such as `secretName`, author the supported secret resource and reference it exactly as the schema requires.
- If it defines no credential input, do not invent one.

When the application also needs a developer-supplied credential, author a supported `Radius.Security/secrets` binding and consume it through `secretKeyRef` rather than assigning the secure parameter to plain `env.value`. A sensitive property used to provision a resource is not automatically available to the workload:

```bicep
@secure()
param password string

resource databaseRuntimeSecret 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'database-runtime-secret'
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
        env: {
          APP_PASSWORD: {
            valueFrom: {
              secretKeyRef: {
                secretName: databaseRuntimeSecret.name
                key: 'password'
              }
            }
          }
        }
      }
    }
  }
}
```

The names above are illustrative. Confirm the secret resource shape, `secretName` expression, key, and app-native variable against the target version and source.

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

1. Bind the secret into a helper environment variable with `secretKeyRef`.
2. Bind nonsecret host, port, database, and username values from verified outputs or literals.
3. Declare the helper before dependent values when the runtime requires ordering.
4. Compose the final app-native value in the container runtime or let the application construct it. The final key and syntax must exactly match the selected pinned-source contract.

For a non-URL format, the pattern can look like:

```bicep
env: {
  DB_PASSWORD: {
    valueFrom: {
      secretKeyRef: {
        secretName: databaseRuntimeSecret.name
        key: 'password'
      }
    }
  }
  APP_DATABASE_OPTIONS: {
    value: 'host=${database.properties.host};password=$(DB_PASSWORD)'
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
- `@secure()` values flow only through properties marked sensitive or supported secret resources.
- Runtime composition preserves dependency order, escaping, encoding, and image entrypoint behavior.
- A final credential-bearing URL/config is either bound directly from a matching managed secret or composed at runtime from secret references; it is never reconstructed in Bicep plain state.
