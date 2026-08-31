# Runtime Contract

A compiling `app.bicep` proves only that its syntax and resource shapes are accepted. The generated model must also satisfy every workload's real process, configuration, storage, and dependency contract.

## Evidence to inspect

Start with an explicit request or scenario contract, then inspect primary evidence before relying on prose documentation:

1. Explicit profile: requested Radius types, provider/backend, resource-name parameters, workload roles/count, app-native keys, protocol/config values, secret bindings, and relationship names. Include deployment contracts in the target repository's documentation, Environment definition, and verification workflow.
2. Dockerfile and complete build context: stages, copied files, build arguments, target platforms, cross-build strategy, `ENTRYPOINT`, `CMD`, `WORKDIR`, `USER`, installed shells/tools, required Git metadata, and writable paths.
3. Compose/Helm/Kubernetes manifests: service roles, images, commands, environment, mounted config, ports, volumes, health checks, and dependency topology.
4. Entrypoints and source: environment/config reads, defaults, client constructors, URL assembly, protocol options, listener address/port, migrations, and worker-versus-web behavior.
5. Example configuration and documentation: use these to confirm source behavior, not to override pinned source or an explicit compatible profile.

`EXPOSE`, a Compose port mapping, or a health endpoint alone is not proof that the process listens correctly or can reach its dependencies. For external-client ingress, follow the route authoring rule in [app.bicep Structure](../SKILL.md#appbicep-structure-mandatory-order).

## Select the deployment profile

Choose the runtime path before choosing resources:

1. If the request supplies a profile, treat every named type, role, key, required value, secret binding, and connection as an acceptance criterion.
2. Confirm the pinned source revision contains the adapter, client, configuration syntax, and image tools needed to implement that profile.
3. Do not replace the requested profile with a source default or another supported backend. Defaults only resolve choices the request leaves open.
4. If no profile is supplied, select a complete documented manifest/configuration that exercises the primary feature. Ask when materially different runnable profiles remain.
5. Stop when the requested profile is impossible for the pinned revision or exact Radius schema/recipe; do not emit a partial definition with a caveat.
6. Include a backing service only when the selected startup/configuration path necessarily initializes or consumes it. A package import, optional extra, adapter, test fixture, example, or alternate profile elsewhere in the repository is not evidence that the service is required.

Create a requirement ledger before writing Bicep:

| Criterion                   | Required evidence                                                                                                                                                |
|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Typed resource              | Exact extension type/schema, a usable Recipe registered in the target Environment, and the selected source adapter or client                                     |
| Resource property reference | Verbatim read/write path in the exact schema/API version; exact Recipe mapping when the value is generated                                                       |
| Workload role               | Runnable image process and complete feature configuration                                                                                                        |
| Native key/value            | Pinned-source read and exact expected format/value                                                                                                               |
| Secret binding              | Developer-supplied `@secure()` parameter or exact managed/authored secret resource path and key, as appropriate                                                  |
| Provider behavior           | Exact Environment Recipe or immutable provider recipe-pack artifact and revision, verbatim output mapping, plus endpoint, protocol, TLS, and auth transformation |
| Provider resource name      | Exact explicit parameter and provider naming/uniqueness constraint when the Recipe or verification couples them                                                  |
| Connection                  | Exact requested relationship name and source; projection use if relied upon                                                                                      |

Every row must map to emitted Bicep and a real consumer. A declared but unused variable, connection, or resource does not close the row. A Recipe in a default pack does not prove that a custom target Environment registers it.

Before writing Bicep, enumerate every planned resource property read and write as a separate ledger row. Record the verbatim path and prove it against the exact target schema and API version. For a generated output, inspect the exact target Environment Recipe or matching immutable provider recipe-pack source and record the verbatim output mapping; schema prose, property names, and READMEs do not prove that a deployed Recipe returns a value. Also prove that the target Environment registers every emitted type and that every omitted optional Recipe input has a safe absent/null path. For a managed secret, prove the declared nested secret-name path and exact key; key declarations are metadata, not readable secret values. The consumer must use that managed secret directly through `secretKeyRef`; any row that reads the key as a resource property or copies it into an authored secret fails preflight.

Reject the model before generation if any schema path is absent, generated output lacks an exact Recipe mapping, omitted input is unsafe, or required Recipe is unavailable in the target Environment. Do not repair a missing output by guessing a direct convenience property, choosing a similarly named alias, copying it through an authored secret wrapper, or retaining only an unconsumed connection. Compilation is downstream confirmation, not property-path discovery.

When mutable local extension metadata disagrees with the exact target schema and Recipe, the target deployment contract outranks the mutable artifact. Refresh or pin a verified compatible extension. If none is available, fail closed before writing rather than removing feature-critical wiring or changing the model to a stale shape.

## Inventory each workload

Record this contract for every executable role:

| Field           | Questions to answer                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|-----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Role            | Long-running web service, worker, scheduler, migration/init job, sidecar, or one-shot CLI?                                                                                                                                                                                                                                                                                                                                                              |
| Image           | For the application's own code, which complete Dockerfile context and exact checkout commit or immutable release tag will be source-built? For a genuinely third-party/backing container, which pinned image tag or digest is used? Does the exact Recipe safely handle omitted `tag` and other optional inputs? Which platforms can this Dockerfile actually build (see [Choosing build.platforms](bicep-structure-rules.md#choosing-buildplatforms))? |
| Process         | What do the image entrypoint and command run? Is an override required and does the image contain the required executable or shell?                                                                                                                                                                                                                                                                                                                      |
| Listener        | Which address, port, and protocol does the process actually use? Which setting configures it?                                                                                                                                                                                                                                                                                                                                                           |
| Configuration   | Which exact environment variables, flags, files, nesting syntax, casing, version-specific names, representations, parser coercions, unset behavior, and defaults are consumed?                                                                                                                                                                                                                                                                          |
| Dependencies    | Which hosts, ports, database/topic/queue names, credentials, URLs, TLS modes, and protocol versions does the client require?                                                                                                                                                                                                                                                                                                                            |
| Secrets         | Which values are supplied by the developer and which are produced by a recipe? Can the container consume them by reference?                                                                                                                                                                                                                                                                                                                             |
| Storage         | Which paths must be writable or persistent? What ownership and access mode does the process require?                                                                                                                                                                                                                                                                                                                                                    |
| Primary feature | What model route, storage backend, database client, input/output pipeline, authentication/bootstrap setup, or other config proves this role performs the requested function?                                                                                                                                                                                                                                                                            |

Model separate web, worker, producer, consumer, and init roles separately even when they share an image.

## Map every required value

For each required app-native input, choose exactly one supported source:

- explicit `env.value` from a literal, a verified nonsecret resource output, or a developer-supplied `@secure()` parameter (Radius encrypts and injects it);
- `valueFrom.secretKeyRef` binding a Recipe-generated managed secret and key via the owner's read-only `<resource>.properties.secrets.name`;
- an authored `Radius.Security/secrets` delivered through a schema-supported mount for app secrets/config files, or referenced by a resource schema that requires `secretName`;
- runtime composition from previously bound values when the app requires a larger URL/config value; or
- a generic Radius connection only when the source parses the exact connection projection supplied by the configured Radius version.

Do not leave a required input implicit because a resource is connected. A direct property or secret reference creates a dependency edge without a connection.

Environment values are strings unless the exact container contract proves otherwise. Trace source parsing and unset behavior. Do not encode false as the non-empty string `'false'` when source uses truthiness such as `Boolean(value)`; omit an optional key or use the exact false representation the pinned source accepts.

An authored secret containing Bicep interpolation that constructs a credential-bearing aggregate value is not runtime composition. Prefer source-native decomposed host, port, database, username, password, and TLS inputs when the application safely composes them. If the workload accepts only one credential-bearing value, prove an exact compatible managed-secret output or a verified runtime encoder/composer before generation. Never assume an unconstrained credential is URL-safe.

## Prove each dependency client tuple

For every workload-to-resource edge, account for all applicable fields:

| Field                | Proof                                                                                                                                                |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Resource/subresource | Exact database, topic, queue, container, model, or index selected by the profile                                                                     |
| Endpoint             | Complete hostname/FQDN or URL, including any recipe-documented suffix/path transformation                                                            |
| Port                 | Client port from an explicitly mapped Recipe output or a provider-fixed literal proven by the concrete provider profile                              |
| Protocol             | Client wire protocol and version supported by the concrete backend                                                                                   |
| Transport security   | TLS mode, certificate behavior, and encryption flags expected by source                                                                              |
| Authentication       | Mechanism, identity/username, and source-supported config syntax                                                                                     |
| Secret               | A developer-supplied credential from a `@secure()` parameter assigned to `env.value`, or a Recipe-generated managed secret bound with `secretKeyRef` |
| Final format         | Native URL, nested environment key, JAAS/config block, or generated file actually parsed by the workload                                             |

A resource output named `host` may be only one segment of the endpoint. A type name such as Kafka or RabbitMQ does not prove broker compatibility. Apply provider-specific values in `app.bicep` when the application must consume them, while keeping provider provisioning in Environment Bicep.

## Process, network, and storage checks

- `containerPort` exposes a network endpoint; it does not change the process listener. Set the app's listener configuration when its default differs.
- Kubernetes `command` replaces the image `ENTRYPOINT`; `args` replaces `CMD`. Preserve the image defaults unless an inspected runtime contract requires an override.
- Before using shell-based runtime composition, confirm the image contains that shell and every invoked binary.
- A shell expansion is not URL encoding. Prove the runtime encoder or use source-native decomposed inputs that handle arbitrary valid credentials.
- Ensure config/data paths are writable for the image user. Add persistent storage only when state must survive restarts.
- Keep migrations and verification probes distinct from the long-running application. Use an init role only when the application genuinely requires it.
- When a selected profile requires multiple roles, model every role and its complete command/configuration. Do not collapse producer and consumer behavior into an idle process.
- If required configuration is not packaged in the image, generate or mount it only through a schema-supported mechanism. Validate the complete file syntax, expansion rules, destination ownership, and command that consumes it.
- For `Radius.Compute/containerImages`, pin the Git source to the exact modeled checkout. Inspect the exact Recipe's omitted-tag path and set a Docker-valid immutable tag only when that contract requires one.
- Decide each source build's `build.platforms` from the Dockerfile's own cross-compilation strategy, using the [Choosing build.platforms](bicep-structure-rules.md#choosing-buildplatforms) procedure. Do not treat builder emulation as a substitute: the type definition states there is no QEMU/binfmt fallback, so an image the Dockerfile cannot cross-compile must be pinned or reported rather than assumed to work.
- BuildKit Git contexts omit `.git` by default. When the Dockerfile or required build step demonstrably needs Git metadata, require schema-supported `BUILDKIT_CONTEXT_KEEP_GIT_DIR=1`; otherwise report the packaging gap.

## Prove primary-feature readiness

Process startup is insufficient for configurable proxies, gateways, file servers, and processing engines. The emitted workload must activate the selected feature path:

- a model-backed proxy has a usable model alias/provider route and endpoint/key/version wiring;
- a stream or queue pipeline has complete input and output roles/configuration;
- a storage-backed service configures the selected remote filesystem rather than leaving credential variables unused; a file server also has a bootstrapped account, folder, or equivalent runnable path that selects that filesystem;
- a database UI/client has a complete preconfigured native connection and usable noninteractive authentication/bootstrap path; and
- every generated config file is passed to the process that consumes it.

Do not count an empty default config, placeholder pipeline, admin UI or login-screen startup, health endpoint, or a dependency reserved for later manual configuration as readiness.

## Provider compatibility and ownership

Inspect the concrete type, registered recipe, and client source together. Derive FQDN suffixes, TLS, ports, auth modes, connection-string formats, protocol compatibility, network/firewall requirements, and sensitive outputs from that contract. A type named Kafka or RabbitMQ may be backed by a managed service with a compatible surface; the client must support the actual protocol and authentication mode.

`app.bicep` owns developer intent and runtime wiring. Environment/provider Bicep owns recipe modules, SKUs, region, quota, firewall/network policy, and provider-output mapping. Add provider-specific values to the app model only when the application must consume them at runtime.

## Static consistency pass

Before returning the model:

1. Account for every required app-native environment/config input or document an intentional source default.
2. Close every explicit acceptance criterion in the requirement ledger; preserve required literal values, resource-name parameters, and exact relationship names.
3. Reject every resource property read/write that lacks a closed ledger row proving its exact schema path and, for generated outputs, its exact Recipe mapping.
4. Confirm every developer-supplied secret flows through a `@secure()` parameter and directly to `env.value` when the app consumes it; every Recipe-generated secret uses `secretKeyRef` with the exact managed-secret path/key; and every authored secret is a genuine app secret/config file or schema-required secret. No authored wrapper copies an output or composes a credential-bearing aggregate.
5. Confirm every declared port matches a configured process listener.
6. Confirm every source build pins the modeled revision, validates optional Recipe paths, records a per-image `build.platforms` decision, and preserves required Git metadata.
7. Confirm every command/argument and generated config file is compatible with the image entrypoint and available binaries.
8. Confirm every writable/persistent path has the required ownership and access mode.
9. Confirm every connection is consumed by source or intentionally retained because the selected profile requires Radius relationship metadata.
10. Confirm the complete dependency tuple for every edge, including provider-specific endpoint transformations, TLS, auth, URL encoding, and final client syntax.
11. Confirm each workload's primary feature is ready and every selected typed resource is both mandatory and used by that feature.
12. Confirm every route follows the authoring rule in [app.bicep Structure](../SKILL.md#appbicep-structure-mandatory-order).
13. Confirm no required binding or dependency was deleted to satisfy stale mutable extension metadata or obtain a clean compile.
