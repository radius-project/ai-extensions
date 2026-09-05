# Bicep Structure Rules

These rules apply to all generated `app.bicep` files. Resolve property names and types from the exact extension configured by the target repository and the matching registered schema/recipe contract. This file covers structural patterns only.

## General

- `extension radius` is the only extension line and comes first (it provides every Radius type; no per-namespace or per-type extensions)
- `param environment string` always declared
- A `@secure()` parameter is declared for each developer-supplied secret
- Exactly ONE `Radius.Core/applications` resource using the matching `resources[].apiVersion` returned by `show-radius-type.mjs`
- The `@<apiVersion>` shown in the examples below (e.g. `2025-08-01-preview`) is illustrative; replace it with the matching `resources[].apiVersion` returned by `show-radius-type.mjs`
- All output files go in `.radius/` directory
- Compile with an extension compatible with the exact target Environment schema and Recipe contract; stale mutable metadata never overrides deployment-required wiring
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
          SECRET_VAR: {               // bind a recipe-managed secret
            valueFrom: {
              secretKeyRef: {
                secretName: service.properties.secrets.name
                key: 'apiKey'
              }
            }
          }
        }
      }
    }
    connections: {                    // optional TOP-LEVEL relationship map
      credentials: {                 // object map, NOT array
        source: dbSecret.id           // authored secret, or producer.id for Recipe outputs
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
- `disableDefaultEnvVars` goes on the connection entry, NOT on the container; omit it when the workload relies on generated `CONNECTION_<CONNECTION>_<SECRETKEY>` variables
- Port property is `containerPort`, NOT `port`
- `env.value` uses `{ value: ... }` for a literal or verified nonsecret output. Direct `{ value: <secure-param> }` is allowed only as an explicit schema-supported or legacy compatibility fallback required by the native contract; prefer an authored Secret with `secretKeyRef` or a compatible Secret connection because the direct form stores the resolved value in the Radius container resource and generated Pod specification. Use `{ valueFrom: { secretKeyRef: { secretName: ..., key: ... } } }` with `<secret>.name` and a declared authored data key when preserving a native variable or compatibility fallback, or with `<producer>.properties.secrets.name` and a declared Recipe `result.secrets` key for a custom Kubernetes name
- `containerPort` exposes the process port; it does not configure the process listener
- `command` replaces the image `ENTRYPOINT`, and `args` replaces `CMD`; override only after inspecting the image contract and required binaries
- Never **set** a read-only property. Reference a nonsecret read-only output only when the exact schema declares it and the exact target Recipe explicitly maps it
- A connection to an authored or reused Secret uses `<secret>.id`; a connection for Recipe-generated `result.secrets` entries uses only `<producer>.id`. In `CONNECTION_<CONNECTION>_<SECRETKEY>`, `<CONNECTION>` is the connection map key uppercased without inserting separators, and `<SECRETKEY>` is the uppercased authored data key or Recipe result key; case-normalized Secret-key collisions fail validation
- An explicit `env` entry with the same name takes precedence over a generated connection variable. `disableDefaultEnvVars: true` suppresses all generated variables for that connection
- A direct resource output, image, or secret reference creates dependency ordering; `connections` is not mandatory for ordering except when connection projection is consumed
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

Confirm the mounted filename, process argument, and secret/container schemas at the configured versions. Keep credentials out of the file when it can reference environment variables; use an authored-secret connection for a developer-supplied credential, or a producer connection for a Recipe-managed value. Preserve an existing custom native name with an explicit supported binding when required. Use startup generation only when mounting cannot satisfy the source contract and the image's shell, tools, writable path, expansion, and final command are all verified.

## Radius.Compute/containerImages structure

```bicep
resource myImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'myapp-image'
  properties: {
    environment: environment
    application: app.id
    tag: 'v1.2.3'   // immutable; omit only when the exact Recipe supports omission
    build: {
      source: 'git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>'
    }
  }
}
```

Rules:

- The image is BUILT from `build.source` — there is NO `image` property and NO `param image string`
- `build.source` is the repo git URL: `git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>`. Omit `//<subdir>` when the build context is the repo root; pin `?ref=` to the exact modeled checkout or an explicit immutable release tag. Never copy `main`, `edge`, or another mutable ref from an existing deployment file. When the ref is a commit, use its full 40-character SHA; never use an abbreviated SHA. The image `tag` may remain abbreviated because it is not a Git ref
- Optional `build.dockerfile` (path to the Dockerfile relative to the source; defaults to `Dockerfile`)
- Inspect the exact Recipe before deciding whether to set `tag`. Omit it when the current contract's omitted-tag path is proven usable; otherwise set a Docker-valid immutable tag derived from the modeled source revision. Do not claim omission is broken without current Recipe evidence
- Decide `build.platforms` per image from the Dockerfile's own cross-build strategy — see [Choosing build.platforms](#choosing-buildplatforms). Never infer it from the language, a package manager, or the presence of a native dependency alone
- Inspect the Dockerfile and build commands for required Git metadata. BuildKit Git contexts omit `.git`; when the build demonstrably requires it, set schema-supported `build.args.BUILDKIT_CONTEXT_KEEP_GIT_DIR: '1'` or report the packaging gap
- The container references the built image via `<serviceName>Image.properties.imageReference`; this reference creates the dependency edge, so NO separate connection to the image is needed
- Use `containerImages` only when the source includes a complete, practical Dockerfile and build context. Do not invent a wrapper build merely to avoid a maintained published image
- Registry credentials used to push a generated image are distinct from Kubernetes credentials used to pull it at runtime

### Registry push credentials (required only for an authenticated registry)

The `containerImages` recipe builds the image in-cluster and pushes it to the OCI
registry the recipe pack configures via `containerImagesRegistry`. When that
registry requires authentication (the common case — e.g. `ghcr.io/<owner>/<repo>`,
which needs a token to push), the recipe reads the push credentials from a
Kubernetes Secret named by the pack's `containerImagesRegistrySecretName` =
**`radius-ghcr-registry-creds`** on the target cluster. So the app definition must stay
in parity with that pack parameter: when the target registry needs credentials,
author a matching registry-credentials Secret named exactly `radius-ghcr-registry-creds`.

An **unauthenticated** registry (e.g. a local/in-cluster registry the recipe pack
configures with an empty `containerImagesRegistrySecretName`) needs no
credentials — in that case do NOT author the Secret or the
`registryUsername`/`registryPassword` params, and do NOT add the `dependsOn`.
Default to authoring the Secret whenever the push registry is `ghcr.io` or any
other registry that requires a login; omit it only when you can confirm the
target registry is unauthenticated.

```bicep
@description('Username for the OCI registry the containerImages recipe pushes to (the GitHub actor for ghcr.io).')
param registryUsername string

@description('Password/token for the OCI registry the containerImages recipe pushes to (a GitHub token with write:packages for ghcr.io).')
@secure()
param registryPassword string

// Registry push credentials for the containerImages recipe. The name MUST be
// exactly 'radius-ghcr-registry-creds' to match the recipe pack's
// containerImagesRegistrySecretName — the recipe reads the push credentials
// from a Secret of that name on the target cluster. Omit this resource entirely
// when pushing to an unauthenticated registry.
resource registryCreds 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'radius-ghcr-registry-creds'
  properties: {
    environment: environment
    application: app.id
    data: {
      username: {
        value: registryUsername
      }
      password: {
        value: registryPassword
      }
    }
  }
}

resource myImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'myapp-image'
  properties: {
    environment: environment
    application: app.id
    build: {
      source: 'git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>'
    }
  }
  // The build reads the registry Secret at recipe execution time, so the Secret
  // must exist before the image is built and pushed. Omit this dependsOn when the
  // registry is unauthenticated and no Secret is authored.
  dependsOn: [
    registryCreds
  ]
}
```

Registry-credentials rules:

- Author the registry Secret only when the push registry requires authentication. For an unauthenticated registry, omit the Secret, the `registryUsername`/`registryPassword` params, and the `dependsOn` — the recipe pack registers the recipe with an empty `containerImagesRegistrySecretName` in that case
- WHEN the Secret is authored, its resource name MUST be exactly `radius-ghcr-registry-creds` — it is not free-form. It is the fixed `containerImagesRegistrySecretName` the recipe pack registers the recipe with; any other name means the recipe can't find the push credentials
- Author it with the two keys `username` and `password` (lowercase, exactly these keys — the recipe reads them by name)
- Populate the keys from a plain `param registryUsername string` and an `@secure() param registryPassword string`. Do NOT hardcode the credentials
- Add `dependsOn: [registryCreds]` on the `containerImages` resource so the Secret exists on the target cluster before the build/push runs
- Do NOT set a registry on the `containerImages` resource — the push registry (`ghcr.io/<owner>/<repo>`) is an operator concern supplied by the recipe pack's `containerImagesRegistry` parameter, not the app definition
- `registryUsername`/`registryPassword` are supplied by the deploy workflow from the runner identity (`github.actor` / `GITHUB_TOKEN`); they are workflow-managed parameters, so the extension never surfaces them in the deploy UI or auto-generates values for them. Declare them but do not give them defaults
- When authored, use exactly one `radius-ghcr-registry-creds` Secret even when the app builds several images — all `containerImages` resources share the one registry Secret and each `dependsOn` it

### Choosing build.platforms

Omitting `build.platforms` builds `linux/amd64` and `linux/arm64`. Both come from one BuildKit instance, so every platform other than the builder's own needs cross-compilation in the Dockerfile; the `containerImages` type definition states there is no QEMU/binfmt emulation fallback. Without cross-compilation, a target-platform `RUN` can fail during the build with `exec format error`, while build-platform output copied into another platform's image can build cleanly and fail only at runtime. Decide from the Dockerfile's own cross-compilation strategy and never assume emulation covers either gap.

Decide for each `containerImages` resource separately. A repository that builds several images usually mixes safe and unsafe ones, and pinning them all to the least capable Dockerfile discards architecture support the others have.

Read the Dockerfile named by `build.dockerfile` (default `Dockerfile`) at the modeled commit. An image builds correctly for a platform when ALL of the following hold.

**A. The final image is not fixed to one architecture.**

Take the last `FROM` and walk its ancestry through `FROM <stage>` inheritance only. `COPY --from=<stage>` is NOT inheritance — a stage referenced only by `COPY --from` is not an ancestor.

The image is fixed when the final stage or one of its ancestors uses `FROM --platform=$BUILDPLATFORM` or a literal such as `FROM --platform=linux/amd64`. A plain `FROM` and `FROM --platform=$TARGETPLATFORM` are NOT pins; both follow the requested platform. A digest-pinned base (`FROM alpine:3.21@sha256:…`) is not a pin either when the digest names a multi-platform manifest list, which is the usual case for official images; it fixes the image only when it names one platform's manifest.

**B. Every architecture-specific artifact reaching the final image is built for the requested architecture.**

Consider each stage that contributes to the final image: the final stage's own `RUN` steps, and every stage it takes a `COPY --from` from. For each, ask whether it emits architecture-specific output, and if so whether it targets the requested architecture.

- **Architecture-specific output**: compiled binaries (C, C++, Rust, Go, .NET native), Python C extensions and any wheel built from source, Node native addons (`node-gyp`, `npm rebuild`, packages shipping `.node`), and anything a package manager compiles rather than downloads prebuilt.
- **Architecture-neutral output**: shell and interpreted scripts, `.pyc` and JVM bytecode, static web bundles from `npm run build`, and data or configuration files.
- **Targeting the requested architecture**: the toolchain receives the target from `TARGETARCH`/`TARGETPLATFORM` or an equivalent — `GOARCH=$TARGETARCH`, Rust `--target`, .NET `-r`, `pip install --platform … --only-binary` — or the package manager installs a prebuilt binary for the target, such as a `manylinux`/`musllinux` aarch64 wheel. `TARGETARCH` and `TARGETPLATFORM` are automatic build arguments, so each consuming stage must re-declare them with its own `ARG TARGETARCH`; a stage that references one without declaring it gets an empty value and silently targets the builder. Declaring a fallback default (`ARG TARGETARCH=amd64`) is still correct, because the value BuildKit supplies for the requested platform takes precedence over the default. What does NOT target the request is a hardcoded architecture (`GOARCH=arm64`, `--target=aarch64-…`), which forces one architecture always.

An artifact is safe when it is architecture-neutral, or when it is architecture-specific and correctly targeted. The canonical correct pattern satisfies both: `FROM --platform=$BUILDPLATFORM golang AS build` compiling with `GOARCH=$TARGETARCH`, copied into an unpinned final stage. That build stage is pinned, but it targets the requested architecture, so the artifact is correct — a pinned build stage is not by itself a problem.

A `RUN` in an UNPINNED stage would execute inside a container of the requested platform, so whatever it compiles or installs is target-architecture by construction and satisfies B without needing `TARGETARCH`. That establishes artifact correctness only when the stage can execute; apply C separately.

`COPY --from` an external image rather than a stage (`COPY --from=golang:1.22`) is safe when that image publishes the requested platform, and fixes the artifact when it is single-arch or digest-pinned to one platform.

**C. Every `RUN` can execute on the builder for the requested platform.**

The builder is `linux/amd64` and has no QEMU/binfmt emulation. A `RUN` is executable when its stage uses `FROM --platform=$BUILDPLATFORM` or is otherwise fixed to `linux/amd64`. A `RUN` in a plain unpinned stage or a `$TARGETPLATFORM` stage requires the builder to execute target-platform binaries, so it is not buildable for `linux/arm64` even if its output would satisfy B. This includes ordinary single-stage images that run `yarn install`, `pip install`, `apt-get`, or any other command. Pin such images to `linux/amd64`; otherwise their arm64 build fails with `exec format error`.

Verdict:

- **A, B, and C hold for both default platforms** — omit `build.platforms` and keep the multi-arch default.
- **Any test fails, and the image can still be built for `linux/amd64`** — set `build.platforms: ['linux/amd64']`. Report which images were pinned, why, and that a pinned image will not run on an arm64 cluster until its Dockerfile cross-compiles. Do NOT pin silently.
- **The image is fixed to an architecture other than the builder's** — a final stage pinned to `linux/arm64`, or a hardcoded non-amd64 target — then `linux/amd64` is not buildable either. Do not emit a platform the Dockerfile cannot honor; report the packaging gap.
- **The Dockerfile cannot be read** at the modeled commit — report that the decision could not be made rather than guessing.

Do not infer from the language alone. Go is not automatically safe (`CGO_ENABLED=1` against a C dependency is not), and Python is not automatically unsafe (a pure-Python service, or one whose dependencies ship target wheels, cross-builds fine).

| Pattern                                                                                       | Verdict                                                        |
|-----------------------------------------------------------------------------------------------|----------------------------------------------------------------|
| `FROM --platform=$BUILDPLATFORM` build stage, `GOARCH=$TARGETARCH`, unpinned distroless final | Omit — pinned build stage, correctly targeted artifact         |
| Wheels built with `g++` in a `$BUILDPLATFORM` stage, final stage `FROM base` inheriting it    | `['linux/amd64']` — A fails                                    |
| `node-gyp` addons compiled in a build stage, copied into unpinned `alpine`                    | `['linux/amd64']` — B fails                                    |
| `npm run build` static bundle from a `$BUILDPLATFORM` stage, copied into `nginx`              | Omit — artifact is architecture-neutral                        |
| Single unpinned stage running `yarn install` or `pip install`                                 | `['linux/amd64']` — C fails without target-platform emulation  |
| `FROM --platform=$TARGETPLATFORM` final stage                                                 | Not a pin; judge on B and C                                    |
| `pip install --platform manylinux2014_aarch64 --only-binary=:all:` in a build-platform stage  | Omit — executable build stage installs a prebuilt target wheel |
| Rust `cargo build --target=<triple derived from TARGETARCH>` in a build-platform stage        | Omit — executable stage produces correctly targeted output     |
| Final stage `FROM --platform=linux/arm64`                                                     | Report packaging gap — `linux/amd64` is not buildable either   |

## Radius.Data/* structure

```bicep
resource mysqlDb 'Radius.Data/mySqlDatabases@2025-08-01-preview' = {
  name: 'todo-list-app-mysql'
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

- Credential inputs follow the type's schema, classified by sensitivity rather than by property name (do not assume by engine, and do not assume by the word `password`):
  - property marked `x-radius-sensitive: true`: set it on the resource from a `@secure() param` (`Radius.Data/mySqlDatabases.password`)
  - plain, non-sensitive `string` property whose schema description identifies it as the resource ID of a `Radius.Security/secrets` resource: create or reuse that Secret and assign `<secret>.id`, never a `@secure() param` (`Radius.Messaging/rabbitMQ.password`, and likewise a property named `passwordSecret` or `secretName`); assigning the raw credential makes it the Kubernetes Secret name the Recipe looks up and fails the deployment
  - schema has neither: do not invent credentials; inspect the recipe outputs and application auth requirements
- Symbolic name is engine/instance-derived (`mysqlDb`), NOT fixed — so multiple data stores never collide
- The `name` value starts with the application name (`'todo-list-app-mysql'`), because a Recipe derives the provisioned cloud resource's name from a resource ID that identifies the resource but not its application — see [Backing-resource names are application-scoped](../SKILL.md#backing-resource-names-are-application-scoped). Connection keys stay engine-derived, so the generated `CONNECTION_*` variables do not change with it
- Developer-facing props (`database`, `version`, `size`, `topic`, `queue`, `container`) are derived from source — do NOT hardcode; only set properties the schema defines
- Do NOT set readOnly properties (`host`, `port`, `connectionString`) — these are recipe outputs
- A nonsecret read-only output such as `host`, `port`, or `endpoint` may be referenced for app-native wiring only when the exact schema declares it and the selected Recipe explicitly maps it. Schema presence alone is insufficient; use a provider-fixed literal only with proof from the concrete provider contract
- Resolve sensitive results from the exact schema and Recipe `result.secrets` contract. On a verified compatible Kubernetes Container Recipe, connect to the producer for standard `CONNECTION_*` projection; for an explicit custom Kubernetes environment name, bind its declared name/key through `valueFrom.secretKeyRef`. Never copy the value into an authored Secret or guess a sibling convenience property. See [secrets-handling.md](secrets-handling.md)
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
Rules:

- Use only when the exact schema supports it: for a type's secret-reference credential input, app secrets/config files, or the `radius-ghcr-registry-creds` registry-push Secret required by a `Radius.Compute/containerImages` build when the push registry is authenticated (see [containerImages](#radiuscomputecontainerimages-structure))
- Do not re-author a recipe-generated output. Bind directly from its schema-declared managed secret, or report that the exact contract cannot supply it
- Never set authored secret `data.value` from a recipe resource's sensitive output or a guessed convenience property
- NEVER hardcode passwords — use `@secure() param`
- `data` is an object map, NOT an array
- Keys in `data` must match their exact consumer or schema contract; do not impose universal casing
- `USERNAME` is the database administrator you author (e.g. `myadmin`) — it is not derived from the source
- A developer-supplied credential consumed through connection projection belongs in an authored `Radius.Security/secrets`; connect the workload to `<secret>.id` so Radius injects a secret-backed `CONNECTION_<CONNECTION>_<SECRETKEY>` variable
- For Recipe-generated credentials, connect only to `<producer>.id`. Use `valueFrom.secretKeyRef` with `<producer>.properties.secrets.name` and the declared Recipe `result.secrets` key only when an explicit custom Kubernetes environment variable name is required
- Never use `<producer>.properties.secrets.name` as a connection source or author a secret to wrap a Recipe output
- Never use authored secret `data.value` interpolation to manufacture a credential-bearing URL or configuration value

## Radius.Compute/routes structure

```bicep
resource myRoute 'Radius.Compute/routes@2025-08-01-preview' = {
  name: 'my-route'
  properties: {
    environment: environment
    application: app.id
    kind: 'HTTP'
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
- `rules` is a required array of objects with `matches` and `destinationContainer`
- `kind` supports `HTTP`, `TCP`, `TLS`, and `UDP`; when omitted, it defaults to `HTTP`
- Omit `hostnames` unless the request names an exact HTTP Host or TLS SNI value; it does not assign the exposed hostname, which the Recipe determines
- Do not author the read-only `listener`; the Recipe assigns the route to a Gateway listener, and the Gateway may use a public or private load balancer
- `destinationContainer` requires ALL THREE: `resourceId`, `containerName`, `containerPort`
- Follow the route authoring rule in [app.bicep Structure](../SKILL.md#appbicep-structure-mandatory-order)

## Image resolution

The repository must contain a Dockerfile; a repo without one is unsupported at launch and the skill stops before modeling (see the [Prerequisites in SKILL.md](../SKILL.md#prerequisites)). Building the application's own workloads from that Dockerfile is the default path:

1. Build the application's own workloads from a complete, practical repository Dockerfile/context using `Radius.Compute/containerImages` with an immutable `build.source` ref, Recipe-validated tag behavior, and target-compatible platforms.
2. Use a published image (immutable digest or pinned release tag) only for a genuinely third-party/backing container (for example a stock proxy, admin UI, or monitoring sidecar), never for the application's own code.
3. If a required workload has neither a usable Dockerfile (application code) nor a suitable maintained published image (third-party component), report the packaging gap instead of using a bare runtime base image or inventing a fragile build wrapper.

Do not use branch refs or `latest` when an immutable commit, tag, or digest is available.

## Runtime semantics

- Infer the listener address and port from the process/configuration, not only `EXPOSE`, compose mappings, or health checks.
- Model web, worker, producer, consumer, init, and one-shot roles according to their actual lifecycle.
- Preserve image entrypoint behavior unless a required override is verified. Confirm any shell, templating command, or helper binary exists in the image.
- Model writable and persistent paths with the ownership and access mode required by the process.
- Preserve exact required provider literals and nested configuration keys from an explicit compatible profile. A complete FQDN, TLS/SASL/encryption setting, model alias, or config-file stanza is application runtime wiring, not provider provisioning.
- Preserve source parser semantics, including type coercion and unset behavior. A non-empty string such as `'false'` may be truthy in the pinned source.
- Model only backing services mandatory for the selected source path. Optional dependencies, adapters, tests, examples, and alternate profiles do not become resources.
- Do not return an idle default, placeholder config, or UI-only process when the selected profile requires a functioning model route, remote storage backend, database connection, or message pipeline.
- Follow [runtime-contract.md](runtime-contract.md) for the full consistency pass.

## Application/provider boundary

`app.bicep` expresses developer intent and app-facing runtime values. Environment/provider Bicep owns recipe modules, cloud SKUs, regions, quota, network/firewall configuration, and output mapping. Keep provider implementation out of the app model unless the application itself must consume a provider-specific runtime value.

## Properties that do NOT exist

These are commonly hallucinated. They will cause deployment errors:

| Resource Type               | Invalid property                                   |
|-----------------------------|----------------------------------------------------|
| `Radius.Compute/containers` | `port` (use `containerPort`), `image` at top level |
| `Radius.Compute/routes`     | `target`, `source`, `destination`, `backend`       |

## Output rules

- Do NOT include comments explaining skill rules in generated Bicep
- Do NOT set readOnly properties
- Reference read-only outputs only when the exact schema declares the value and the exact target Recipe maps it
- Do NOT add `@description` decorators unless the user asks for them
