# Runtime Contract

A compiling `app.bicep` proves only that its syntax and resource shapes are accepted. The generated model must also satisfy every workload's real process, configuration, storage, and dependency contract.

## Evidence to inspect

Start with an explicit request or scenario contract, then inspect primary evidence before relying on prose documentation:

1. Explicit profile: requested Radius types, provider/backend, workload roles/count, app-native keys, protocol/config values, secret bindings, and relationship names.
2. Dockerfile and complete build context: stages, copied files, build arguments, `ENTRYPOINT`, `CMD`, `WORKDIR`, `USER`, installed shells/tools, and writable paths.
3. Compose/Helm/Kubernetes manifests: service roles, images, commands, environment, mounted config, ports, volumes, health checks, and dependency topology.
4. Entrypoints and source: environment/config reads, defaults, client constructors, URL assembly, protocol options, listener address/port, migrations, and worker-versus-web behavior.
5. Example configuration and documentation: use these to confirm source behavior, not to override pinned source or an explicit compatible profile.

`EXPOSE`, a compose port mapping, or a health endpoint alone is not proof that the process listens correctly or can reach its dependencies.

## Select the deployment profile

Choose the runtime path before choosing resources:

1. If the request supplies a profile, treat every named type, role, key, required value, secret binding, and connection as an acceptance criterion.
2. Confirm the pinned source revision contains the adapter, client, configuration syntax, and image tools needed to implement that profile.
3. Do not replace the requested profile with a source default or another supported backend. Defaults only resolve choices the request leaves open.
4. If no profile is supplied, select a complete documented manifest/configuration that exercises the primary feature. Ask when materially different runnable profiles remain.
5. Stop when the requested profile is impossible for the pinned revision or exact Radius schema/recipe; do not emit a partial definition with a caveat.

Create a requirement ledger before writing Bicep:

| Criterion | Required evidence |
|---|---|
| Typed resource | Exact extension type/schema plus selected source adapter or client |
| Resource property reference | Verbatim read/write path in the exact schema/API version; recipe mapping when the value is generated |
| Workload role | Runnable image process and complete feature configuration |
| Native key/value | Pinned-source read and exact expected format/value |
| Secret binding | Exact managed/authored secret resource path and key |
| Provider behavior | Exact recipe output plus endpoint, protocol, TLS, and auth transformation |
| Connection | Exact requested relationship name and source; projection use if relied upon |

Every row must map to emitted Bicep and a real consumer. A declared but unused variable, connection, or resource does not close the row.

Before writing Bicep, enumerate every planned resource property read and write as a separate ledger row. Record the verbatim path and prove it against the exact configured extension schema and API version. For a generated output, also prove that the selected recipe maps that output. For a managed secret, prove the declared managed-secret name path and key; the key declaration is metadata, not a readable secret value. When `properties.secrets` declares the output contract, the consumer row must use that managed secret name and verified key directly through `secretKeyRef`; any row that reads the key as a resource property or copies it into an authored secret fails preflight.

Reject the model before generation if any schema path is absent or any generated output cannot be reconciled with the recipe. Do not repair a missing output by guessing a direct convenience property, choosing a similarly named alias, or copying it through an authored secret wrapper. Compilation is a downstream confirmation, not the discovery mechanism for property paths.

## Inventory each workload

Record this contract for every executable role:

| Field | Questions to answer |
|---|---|
| Role | Long-running web service, worker, scheduler, migration/init job, sidecar, or one-shot CLI? |
| Image | Complete source build or pinned published image? Which immutable commit, tag, or digest? |
| Process | What do the image entrypoint and command run? Is an override required and does the image contain the required executable or shell? |
| Listener | Which address, port, and protocol does the process actually use? Which setting configures it? |
| Configuration | Which exact environment variables, flags, files, nesting syntax, casing, version-specific names, and defaults are consumed? |
| Dependencies | Which hosts, ports, database/topic/queue names, credentials, URLs, TLS modes, and protocol versions does the client require? |
| Secrets | Which values are supplied by the developer and which are produced by a recipe? Can the container consume them by reference? |
| Storage | Which paths must be writable or persistent? What ownership and access mode does the process require? |
| Primary feature | What model route, storage backend, database client, input/output pipeline, or other config proves this role performs the requested function? |

Model separate web, worker, producer, consumer, and init roles separately even when they share an image.

## Map every required value

For each required app-native input, choose exactly one supported source:

- explicit `env.value` from a literal, a verified nonsecret resource output, or a developer-supplied `@secure()` parameter (Radius encrypts and injects it);
- `valueFrom.secretKeyRef` using an exact recipe-generated managed secret resource and key;
- runtime composition from previously bound values when the app requires a larger URL/config value; or
- a generic Radius connection only when the source parses the exact connection projection supplied by the configured Radius version.

Do not leave a required input implicit because a resource is connected. A direct property or secret reference creates a dependency edge without a connection.

## Prove each dependency client tuple

For every workload-to-resource edge, account for all applicable fields:

| Field | Proof |
|---|---|
| Resource/subresource | Exact database, topic, queue, container, model, or index selected by the profile |
| Endpoint | Complete hostname/FQDN or URL, including any recipe-documented suffix/path transformation |
| Port | Client port from the concrete provider profile, not only a generic resource name |
| Protocol | Client wire protocol and version supported by the concrete backend |
| Transport security | TLS mode, certificate behavior, and encryption flags expected by source |
| Authentication | Mechanism, identity/username, and source-supported config syntax |
| Secret | A developer-supplied credential from a `@secure()` parameter assigned to `env.value`, or a recipe-generated/authored secret bound with `secretKeyRef` |
| Final format | Native URL, nested environment key, JAAS/config block, or generated file actually parsed by the workload |

A resource output named `host` may be only one segment of the endpoint. A type name such as Kafka or RabbitMQ does not prove broker compatibility. Apply provider-specific values in `app.bicep` when the application must consume them, while keeping provider provisioning in Environment Bicep.

## Process, network, and storage checks

- `containerPort` exposes a network endpoint; it does not change the process listener. Set the app's listener configuration when its default differs.
- Kubernetes `command` replaces the image `ENTRYPOINT`; `args` replaces `CMD`. Preserve the image defaults unless an inspected runtime contract requires an override.
- Before using shell-based runtime composition, confirm the image contains that shell and every invoked binary.
- Ensure config/data paths are writable for the image user. Add persistent storage only when state must survive restarts.
- Keep migrations and verification probes distinct from the long-running application. Use an init role only when the application genuinely requires it.
- When a selected profile requires multiple roles, model every role and its complete command/configuration. Do not collapse producer and consumer behavior into an idle process.
- If required configuration is not packaged in the image, generate or mount it only through a schema-supported mechanism. Validate the complete file syntax, expansion rules, destination ownership, and command that consumes it.

## Prove primary-feature readiness

Process startup is insufficient for configurable proxies, gateways, file servers, and processing engines. The emitted workload must activate the selected feature path:

- a model-backed proxy has a usable model alias/provider route and endpoint/key/version wiring;
- a stream or queue pipeline has complete input and output roles/configuration;
- a storage-backed service configures the selected remote filesystem rather than leaving credential variables unused;
- a database UI/client has a complete preconfigured native connection; and
- every generated config file is passed to the process that consumes it.

Do not count an empty default config, placeholder pipeline, admin UI startup, or health endpoint as readiness.

## Provider compatibility and ownership

Inspect the concrete type, registered recipe, and client source together. Derive FQDN suffixes, TLS, ports, auth modes, connection-string formats, protocol compatibility, network/firewall requirements, and sensitive outputs from that contract. A type named Kafka or RabbitMQ may be backed by a managed service with a compatible surface; the client must support the actual protocol and authentication mode.

`app.bicep` owns developer intent and runtime wiring. Environment/provider Bicep owns recipe modules, SKUs, region, quota, firewall/network policy, and provider-output mapping. Add provider-specific values to the app model only when the application must consume them at runtime.

## Static consistency pass

Before returning the model:

1. Account for every required app-native environment/config input or document an intentional source default.
2. Close every explicit acceptance criterion in the requirement ledger; preserve required literal values and exact relationship names.
3. Reject every resource property read/write that lacks a closed ledger row proving its exact schema path and, for generated outputs, its recipe mapping.
4. Confirm every secret uses a supported path (a `@secure()` parameter assigned to `env.value`, or a recipe-generated/authored secret bound with `secretKeyRef`) and is never hardcoded or copied into plain state.
5. Confirm every declared port matches a configured process listener.
6. Confirm every command/argument and generated config file is compatible with the image entrypoint and available binaries.
7. Confirm every writable/persistent path has the required ownership and access mode.
8. Confirm every connection is consumed by source or intentionally retained because the selected profile requires Radius relationship metadata.
9. Confirm the complete dependency tuple for every edge, including provider-specific endpoint transformations, TLS, auth, and final client syntax.
10. Confirm each workload's primary feature is ready and every selected typed resource is used by that feature.
