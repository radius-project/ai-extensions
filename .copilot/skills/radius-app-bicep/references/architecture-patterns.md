# Architecture Patterns

Composition is **component-driven**: detect the app's components (compute runtime + backing services), map each to a Radius type via [component-catalog.md](component-catalog.md), and emit those resources. The patterns below are a **lens for context**, not rigid buckets — a real app often combines several (e.g. a Web App that is also AI/ML). Pick a *primary* pattern for the summary, but let the detected components drive the Bicep.

If a detected component has no Radius type yet, note the gap and continue with the supported components; don't substitute an unrelated type.

## The patterns

### Web App
Request/response web applications (monolith or MVC).
- **Signals**: HTTP framework (Express, Django, Rails, Flask, Spring MVC, ASP.NET); server-rendered or REST; usually one primary database.
- **Typical components**: container + a relational or document database + optional cache + external ingress.
- **Radius types**: `Radius.Compute/containers` (+ `Radius.Compute/containerImages` when building from a Dockerfile) + `Radius.Data/*` + `Radius.Compute/routes`. Credentials follow the data type's schema; a `Radius.Security/secrets` is only needed when a type's schema defines `secretName`, or for app API keys.

### Microservices
Distributed services communicating via APIs or messages.
- **Signals**: multiple app services (e.g. several services in compose); inter-service HTTP/gRPC; messaging clients (Kafka, RabbitMQ).
- **Typical components**: multiple containers + a message broker + shared databases/caches + ingress.
- **Radius types**: multiple `Radius.Compute/containers` + `Radius.Messaging/kafka` or `Radius.Messaging/rabbitMQ` + `Radius.Data/*` + `Radius.Compute/routes`.

### Data Pipeline
Batch or streaming ETL, analytics, and data processing.
- **Signals**: no long-lived HTTP server; runs to completion or on a schedule; ETL/stream libraries; object-storage or warehouse clients.
- **Typical components**: batch container + object storage + an event stream.
- **Radius types**: `Radius.Compute/containers` (with `restartPolicy: 'OnFailure'`/`'Never'` for batch) + `Radius.Storage/objectStorage` + `Radius.Messaging/kafka` when used.
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
- **Typical components**: container + an LLM model endpoint + a search index + a secret for the API key + optionally a database for embeddings.
- **Radius types**: `Radius.Compute/containers` + `Radius.AI/models` + `Radius.AI/search` + `Radius.Security/secrets` (+ `Radius.Data/postgreSqlDatabases` when Postgres is the store).
- **Gap**: dedicated vector databases and pgvector's vector features aren't modeled — use Postgres for storage and report the vector gap.

### IoT
Device telemetry ingestion and command/control.
- **Signals**: MQTT clients (`mqtt`, `paho-mqtt`); Mosquitto; device/edge messaging.
- **Radius types**: none yet — MQTT/Mosquitto has no Radius type.
- **Gap**: recognize the pattern but report that the broker has no Radius type; emit only the supported container(s).

## How to apply (component-driven)

1. From the source, list the compute runtime(s) and every backing service the app connects to.
2. Map each component to a Radius type via [component-catalog.md](component-catalog.md).
3. Note the primary pattern above for the summary — remember apps can combine patterns.
4. For any component with no Radius type, report the gap and continue with the supported ones (stop only if the missing piece is essential and the user must decide).
5. Emit one resource per detected component, following the naming and structure rules.