# Architecture Patterns

Composition is **component-driven**: detect the app's executable workloads and backing services, extract each workload's [runtime contract](runtime-contract.md), map components through [component-catalog.md](component-catalog.md), and emit those resources. The patterns below are a **lens for context**, not rigid buckets — a real app often combines several (e.g. a Web App that is also AI/ML). Pick a *primary* pattern for the summary, but let detected components and source behavior drive the Bicep.

If a detected component has no Radius type yet, note the gap and continue with the supported components; don't substitute an unrelated type.

## The patterns

### Web App
Request/response web applications (monolith or MVC).
- **Signals**: HTTP framework (Express, Django, Rails, Flask, Spring MVC, ASP.NET); server-rendered or REST; usually one primary database.
- **Typical components**: container + a relational or document database + optional cache + external ingress.
- **Radius types**: `Radius.Compute/containers` (+ `Radius.Compute/containerImages` for a complete source build) + `Radius.Data/*` + `Radius.Compute/routes`. Credentials follow the data type's schema; `Radius.Security/secrets` is used only when the exact contract requires an authored secret or the workload needs a secure binding for a developer-supplied value.

### Microservices
Distributed services communicating via APIs or messages.
- **Signals**: multiple app services (e.g. several services in compose); inter-service HTTP/gRPC; messaging clients (Kafka, RabbitMQ).
- **Typical components**: multiple containers + a message broker + shared databases/caches + ingress.
- **Radius types**: multiple `Radius.Compute/containers` + `Radius.Messaging/kafka` or `Radius.Messaging/rabbitMQ` + `Radius.Data/*` + `Radius.Compute/routes`.
- **Runtime check**: model each web, worker, producer, consumer, and init role separately; verify inter-service names, ports, protocols, and startup behavior from source.

### Data Pipeline
Batch or streaming ETL, analytics, and data processing.
- **Signals**: no long-lived HTTP server; runs to completion or on a schedule; ETL/stream libraries; object-storage or warehouse clients.
- **Typical components**: batch container + object storage + an event stream.
- **Radius types**: `Radius.Compute/containers` (with `restartPolicy: 'OnFailure'`/`'Never'` for batch) + `Radius.Storage/objectStorage` + `Radius.Messaging/kafka` when used.
- **Runtime check**: distinguish a genuine application role from a one-shot connectivity or migration probe; do not turn verification into a long-running process.
- **Readiness check**: a configurable engine needs a complete source and sink. Model each required producer/consumer or input/output role and ensure the process loads the generated configuration; an empty or placeholder pipeline is not functional.
- **Gap**: distributed processing (Spark) has no Radius type yet — recognize and report the gap.

### Real-time
Low-latency event processing, WebSockets, live updates.
- **Signals**: WebSocket/SSE servers (`ws`, `socket.io`); Redis pub/sub; live-update patterns.
- **Typical components**: container + Redis + ingress.
- **Radius types**: `Radius.Compute/containers` + `Radius.Data/redisCaches` + `Radius.Compute/routes`.

### Enterprise
Line-of-business applications with compliance and integration needs.
- **Signals**: .NET or Java stack; SQL Server (or Oracle); enterprise message brokers.
- **Typical components**: container + SQL Server + a message broker.
- **Radius types**: `Radius.Compute/containers` + `Radius.Data/sqlServerDatabases` (`username`/`password` on the resource) + `Radius.Messaging/rabbitMQ`.
- **Gap**: Oracle and Vault have no Radius type yet — report the gap.

### AI/ML
LLM inference, vector search, and model-backed features.
- **Signals**: LLM SDKs (`openai`, `anthropic`, `@google/generative-ai`, LangChain); embeddings/vector clients; search clients.
- **Typical components**: container + an LLM model endpoint + a search index + secure API-key binding + optionally a database for embeddings.
- **Radius types**: `Radius.Compute/containers` + `Radius.AI/models` + `Radius.AI/search` (+ `Radius.Security/secrets` only for developer-supplied app secrets, and `Radius.Data/postgreSqlDatabases` when Postgres is the store).
- **Readiness check**: when the selected profile requires inference, configure at least one usable source-supported model alias/provider route with its exact endpoint, key, and API/protocol version. A proxy UI or metadata database without a model route is not inference-ready.
- **Gap**: dedicated vector databases and pgvector's vector features aren't modeled — use Postgres for storage and report the vector gap.

### IoT
Device telemetry ingestion and command/control.
- **Signals**: MQTT clients (`mqtt`, `paho-mqtt`); Mosquitto; device/edge messaging.
- **Radius types**: none yet — MQTT/Mosquitto has no Radius type.
- **Gap**: recognize the pattern but report that the broker has no Radius type; emit only the supported container(s).

## How to apply (component-driven)

1. From the source, list every executable workload and backing service the app connects to.
2. Map each component to a Radius type via [component-catalog.md](component-catalog.md).
3. Note the primary pattern above for the summary — remember apps can combine patterns.
4. For any component with no Radius type, report the gap and continue with the supported ones (stop only if the missing piece is essential and the user must decide).
5. Emit resources only after the runtime contract identifies each workload's native configuration, listener, storage, lifecycle, and protocol requirements.