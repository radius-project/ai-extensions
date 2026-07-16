# Bicep Structure Rules

These rules apply to all generated `app.bicep` files. Resolve property names and types from the exact extension configured by the target repository and the matching registered schema/recipe contract. This file covers structural patterns only.

## General

- `extension radius` is the only extension line and comes first (it provides every Radius type; no per-namespace or per-type extensions)
- `param environment string` always declared
- A `@secure()` parameter is declared for each developer-supplied secret
- Exactly ONE `Radius.Core/applications@2025-08-01-preview` resource
- The `@<apiVersion>` shown in the examples below (e.g. `2025-08-01-preview`) is illustrative — use the API version from each type's schema
- All output files go in `.radius/` directory
- Compile with the repository's exact configured extension and resolve unknown type/property warnings before returning
- Emit every exact type, workload role, native key/value, secret binding, and relationship required by the selected compatible deployment profile

## Radius.Compute/containers structure

```bicep
resource myContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'my-container'
  properties: {
    environment: environment
    application: app.id
    containers: {                     // object map, NOT array
      myapp: {                        // key = container name (camelCase)
        image: myImage.properties.imageReference
        ports: {                      // object map, NOT array
          web: {
            containerPort: 3000       // NOT "port"
          }
        }
        env: {                        // exact app-native variable names
          MY_VAR: {
            value: 'some-value'       // must use { value: '...' } syntax
          }
          SECRET_VAR: {               // bind a secret by reference
            valueFrom: {
              secretKeyRef: {
                secretName: runtimeSecret.name
                key: 'password'
              }
            }
          }
        }
      }
    }
    connections: {                    // optional TOP-LEVEL relationship map
      mysqldb: {                     // object map, NOT array
        source: mysqlDb.id
      }
    }
  }
}
```

Rules:
- `containers` is an object map, NOT an array
- `ports` is an object map, NOT an array
- `connections` is an object map, NOT an array
- `connections` is a TOP-LEVEL property under `properties` — NOT inside `containers`
- `disableDefaultEnvVars` goes on the connection entry, NOT on the container
- Port property is `containerPort`, NOT `port`
- `env` values use `{ value: ... }` for a literal, a verified nonsecret output, or a developer-supplied `@secure()` parameter (Radius encrypts and injects it); use `{ valueFrom: { secretKeyRef: { secretName: ..., key: ... } } }` to bind a secret resource, whether a recipe-generated managed secret (via `<resource>.properties.secrets.name`) or an authored `Radius.Security/secrets`
- `containerPort` exposes the process port; it does not configure the process listener
- `command` replaces the image `ENTRYPOINT`, and `args` replaces `CMD`; override only after inspecting the image contract and required binaries
- Never **set** a read-only property. Referencing a read-only output is valid only when the exact schema exposes it and the configured recipe populates it
- A direct resource output, image, or secret reference creates dependency ordering; `connections` is not mandatory for ordering
- Include every co-scheduled role required by the selected profile in the `containers` map. A producer, consumer, proxy, worker, or sidecar must have its own complete image/process/configuration entry
- A startup-generated config file is valid only when the pinned image contains the shell/tools, the destination is writable, interpolation is safe, and the process is explicitly launched with that file

### Config file delivery

Prefer a complete config already included by the source build. When an unmodified image needs an external config file and the exact schemas support it, a mounted `Radius.Security/secrets` resource avoids assuming the image has a shell:

```bicep
resource runtimeConfig 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'runtime-config'
  properties: {
    environment: environment
    application: app.id
    data: {
      'app.yaml': {
        value: '''
<complete source-supported configuration>
'''
      }
    }
  }
}

resource workload 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'workload'
  properties: {
    environment: environment
    application: app.id
    containers: {
      app: {
        image: '<pinned-image>'
        args: ['--config', '/etc/app/app.yaml']
        volumeMounts: [
          {
            volumeName: 'config'
            mountPath: '/etc/app'
          }
        ]
      }
    }
    volumes: {
      config: {
        secretName: runtimeConfig.name
      }
    }
  }
}
```

Confirm the mounted filename, process argument, and secret/container schemas at the configured versions. Keep credentials out of the file when it can reference environment variables; bind those variables separately with `secretKeyRef`. Use startup generation only when mounting cannot satisfy the source contract and the image's shell, tools, writable path, expansion, and final command are all verified.

## Radius.Compute/containerImages structure

```bicep
resource myImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'myapp-image'
  properties: {
    environment: environment
    application: app.id
    tag: 'v1.2.3'   // pin to a commit SHA or immutable tag; omit for a content-addressable digest
    build: {
      source: 'git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>'
    }
  }
}
```

Rules:
- The image is BUILT from `build.source` — there is NO `image` property and NO `param image string`
- `build.source` is the repo git URL: `git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>`. Omit `//<subdir>` when the build context is the repo root; pin `?ref=` to a commit SHA or release tag for reproducible builds
- Optional `build.dockerfile` (path to the Dockerfile relative to the source; defaults to `Dockerfile`) and optional `build.platforms`
- `tag` is optional — pin it to a SHA/immutable tag, otherwise the recipe computes a content-addressable digest
- The container references the built image via `<serviceName>Image.properties.imageReference`; this reference creates the dependency edge, so NO separate connection to the image is needed
- Use `containerImages` only when the source includes a complete, practical Dockerfile and build context. Do not invent a wrapper build merely to avoid a maintained published image
- Registry credentials used to push a generated image are distinct from Kubernetes credentials used to pull it at runtime

## Radius.Data/* structure

```bicep
resource mysqlDb 'Radius.Data/mySqlDatabases@2025-08-01-preview' = {
  name: 'mysql'
  properties: {
    environment: environment
    application: app.id
    database: 'todos'      // derived from source (e.g. MYSQL_DATABASE)
    version: '8.0'         // derived from source (e.g. image tag mysql:8.0)
    username: 'myadmin'    // administrator you author for the provisioned DB
    password: password     // from a @secure() param
  }
}
```

Rules:
- Credentials follow whatever the type's schema defines (do not assume by engine):
  - schema has `username` + `password`: set them on the resource (`password` from a `@secure() param`, marked `x-radius-sensitive`)
  - schema has `secretName`: create a `Radius.Security/secrets` and reference it (see below)
  - schema has neither: do not invent credentials; inspect the recipe outputs and application auth requirements
- Symbolic name is engine/instance-derived (`mysqlDb`), NOT fixed — so multiple data stores never collide
- Developer-facing props (`database`, `version`, `size`, `topic`, `queue`, `container`) are derived from source — do NOT hardcode; only set properties the schema defines
- Do NOT set readOnly properties (`host`, `port`, `connectionString`) — these are recipe outputs
- A nonsecret read-only output such as `host`, `port`, or `endpoint` may be referenced for app-native wiring only when the exact schema and recipe expose it
- Resolve sensitive outputs from the exact schema and recipe. If that version exposes managed-secret metadata, bind its declared name/key directly through `valueFrom.secretKeyRef`; never copy the value into an authored secret or guess a sibling convenience property. Do not assume one universal `properties.secrets` shape. See [secrets-handling.md](secrets-handling.md)
- A selected resource is incomplete until a workload's primary feature consumes its exact subresource, endpoint, protocol/TLS/auth settings, and secret contract

## Radius.Security/secrets structure

```bicep
@secure()
param password string

resource dbSecret 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'db-secret'
  properties: {
    environment: environment
    application: app.id
    data: {
      USERNAME: {
        value: 'myadmin'
      }
      PASSWORD: {
        value: password
      }
    }
  }
}
```

Rules:
- Use only when the exact schema supports it: for a type's required secret input (`secretName`), or app secrets/config files
- Do not re-author a recipe-generated output. Bind directly from its schema-declared managed secret, or report that the exact contract cannot supply it
- Never set authored secret `data.value` from a recipe resource's sensitive output or a guessed convenience property
- NEVER hardcode passwords — use `@secure() param`
- `data` is an object map, NOT an array
- Keys in `data` must match their exact consumer or schema contract; do not impose universal casing
- `USERNAME` is the database administrator you author (e.g. `myadmin`) — it is not derived from the source
- A `@secure()` parameter assigned directly to `env.value` is encrypted and injected by Radius, so it stays out of plain state; a developer-supplied credential needs no authored secret and no `secretKeyRef`
- `valueFrom.secretKeyRef` binds any secret resource; the `<resource>.properties.secrets.name` form is specifically for a recipe-generated managed secret. Author a `Radius.Security/secrets` resource only for app secrets/config files or a type whose schema requires `secretName`; do not author one to wrap a recipe output

## Radius.Compute/routes structure

```bicep
resource myRoute 'Radius.Compute/routes@2025-08-01-preview' = {
  name: 'my-route'
  properties: {
    environment: environment
    application: app.id
    rules: [
      {
        matches: [
          { httpPath: '/' }
        ]
        destinationContainer: {
          resourceId: myContainer.id
          containerName: 'myapp'
          containerPort: 3000
        }
      }
    ]
  }
}
```

Rules:
- Do NOT use `target`, `source`, `destination`, or `backend` — these do NOT exist
- `rules` is the ONLY valid structure — array of objects with `matches` and `destinationContainer`
- `destinationContainer` requires ALL THREE: `resourceId`, `containerName`, `containerPort`
- Only add routes if external ingress is needed

## Image resolution

1. If the repo publishes a suitable image, use an immutable digest or pinned release tag directly.
2. Otherwise, if a complete practical Dockerfile and build context exist, use `Radius.Compute/containerImages` with an immutable `build.source` ref.
3. If neither path is viable, report the packaging gap instead of using a bare runtime base image or inventing a fragile build wrapper.

Do not use branch refs or `latest` when an immutable commit, tag, or digest is available.

## Runtime semantics

- Infer the listener address and port from the process/configuration, not only `EXPOSE`, compose mappings, or health checks.
- Model web, worker, producer, consumer, init, and one-shot roles according to their actual lifecycle.
- Preserve image entrypoint behavior unless a required override is verified. Confirm any shell, templating command, or helper binary exists in the image.
- Model writable and persistent paths with the ownership and access mode required by the process.
- Preserve exact required provider literals and nested configuration keys from an explicit compatible profile. A complete FQDN, TLS/SASL/encryption setting, model alias, or config-file stanza is application runtime wiring, not provider provisioning.
- Do not return an idle default, placeholder config, or UI-only process when the selected profile requires a functioning model route, remote storage backend, database connection, or message pipeline.
- Follow [runtime-contract.md](runtime-contract.md) for the full consistency pass.

## Application/provider boundary

`app.bicep` expresses developer intent and app-facing runtime values. Environment/provider Bicep owns recipe modules, cloud SKUs, regions, quota, network/firewall configuration, and output mapping. Keep provider implementation out of the app model unless the application itself must consume a provider-specific runtime value.

## Properties that do NOT exist

These are commonly hallucinated. They will cause deployment errors:

| Resource Type | Invalid property |
|---|---|
| `Radius.Compute/containers` | `port` (use `containerPort`), `image` at top level |
| `Radius.Compute/routes` | `target`, `source`, `destination`, `backend` |

## Output rules

- Do NOT include comments explaining skill rules in generated Bicep
- Do NOT set readOnly properties
- Reference read-only outputs only when the exact schema and recipe expose the value needed by the application
- Do NOT add `@description` decorators unless the user asks for them