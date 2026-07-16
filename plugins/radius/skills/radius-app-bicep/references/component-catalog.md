# Component Catalog

Maps common application components to Radius resource types, with detection cues from source code (client libraries across npm / PyPI / NuGet / RubyGems, plus manifest and connection-string hints). Use this to turn the selected deployment profile and its pinned source support into types to emit. Always verify the type against the exact configured extension, registered schema, and Environment recipe.

Match by **wire protocol, not only a library or type name**: MariaDB clients can map to MySQL, Valkey to Redis, and DocumentDB / Cosmos DB's Mongo API to MongoDB only when protocol versions and authentication modes are compatible. A concrete recipe may back an abstract messaging type with Event Hubs, Service Bus, or another managed service; verify that the application client supports the actual endpoint, TLS, and authentication contract.

## Profile-aware detection

- An explicit compatible request for a Radius type selects that source-supported backend or feature even when it is optional or not the application's default.
- Confirm the pinned source has the adapter/client and exact configuration path. Do not emit a requested type merely because the repository mentions it in unrelated tests or examples.
- Without an explicit profile, prefer a complete documented runtime manifest/configuration. Do not promote an optional dependency solely because a package is installed.
- Every selected type must be used by a modeled workload's primary feature. A declared but unwired resource is not a detected component.

## Compute

| Component | Detection cues | Radius type |
|---|---|---|
| Long-running service / worker / job | app entry point; executable service in Dockerfile/compose; actual lifecycle | `Radius.Compute/containers` |
| Build image from source | the application's own code with a complete practical Dockerfile/build context | `Radius.Compute/containerImages` |
| External ingress | HTTP server with a verified listener that needs a public URL | `Radius.Compute/routes` |
| Persistent volume | source writes durable data; compose volume; writable path and access mode | `Radius.Compute/persistentVolumes` |

## Backing services (Radius type available)

| Component | Detection cues (npm / PyPI / NuGet / Gems) | Radius type | Patterns |
|---|---|---|---|
| PostgreSQL | `pg`, `postgres` / `psycopg`, `asyncpg` / `Npgsql` / `pg`; `postgres://` | `Radius.Data/postgreSqlDatabases` | Web App, Microservices, Data Pipeline, AI/ML |
| MySQL | `mysql`, `mysql2` / `PyMySQL`, `mysqlclient` / `MySqlConnector` / `mysql2`; `mysql://` | `Radius.Data/mySqlDatabases` | Web App, Enterprise, AI/ML |
| MongoDB | `mongodb`, `mongoose` / `pymongo`, `motor` / `MongoDB.Driver` / `mongo`; `mongodb://` | `Radius.Data/mongoDatabases` | Web App, Microservices |
| Redis | `redis`, `ioredis` / `redis` / `StackExchange.Redis` / `redis`; `redis://` | `Radius.Data/redisCaches` | Web App, Microservices, Real-time, AI/ML |
| SQL Server | `mssql`, `tedious` / `pyodbc`, `pymssql` / `Microsoft.Data.SqlClient`; `Server=...` | `Radius.Data/sqlServerDatabases` | Enterprise |
| Neo4j | `neo4j-driver` / `neo4j` / `Neo4j.Driver` / `neo4j` | `Radius.Data/neo4jDatabases` | Web App, AI/ML |
| Kafka | `kafkajs`, `node-rdkafka` / `confluent-kafka`, `kafka-python` / `Confluent.Kafka` / `ruby-kafka` | `Radius.Messaging/kafka` | Microservices, Data Pipeline |
| RabbitMQ / AMQP queue | `amqplib` / `pika`, `aio-pika` / `RabbitMQ.Client` / `bunny`; AMQP adapter/config selected by the profile | `Radius.Messaging/rabbitMQ` | Microservices, Enterprise |
| LLM inference | `openai`, `@anthropic-ai/sdk`, `@google/generative-ai` / `openai`, `anthropic` / `Azure.AI.OpenAI`; proxy/provider config selected by the profile | `Radius.AI/models` | Web App, Microservices, AI/ML |
| Full-text / AI search | `@elastic/elasticsearch`, `@opensearch-project/opensearch` / `elasticsearch`, `opensearch-py` / `Azure.Search.Documents` | `Radius.AI/search` | Web App, Microservices, Data Pipeline, AI/ML |
| Object storage (S3 / Blob / GCS) | SDK dependency, filesystem/backend adapter, compose/Helm config, or explicit compatible profile selecting remote object storage | `Radius.Storage/objectStorage` | Web App, Data Pipeline, AI/ML |
| App secrets (API keys, tokens); DB creds when the schema uses `secretName` | env-injected secrets; API keys in config | `Radius.Security/secrets` | supporting |

## Recognized but no Radius type yet

When present, include these in your summary and **report the gap** — do NOT substitute an unrelated type. Emit the supported components; if the missing piece is essential, ask the user how to proceed.

| Component | Detection cues | Note |
|---|---|---|
| Serverless functions | AWS Lambda / Azure Functions / GCP Functions handlers | No type yet |
| Generic message queue | `bullmq`, `celery`, `sidekiq`, SQS / Service Bus SDKs | Use Kafka/RabbitMQ if that is the actual broker; otherwise no type |
| MQTT / Mosquitto | `mqtt`, `paho-mqtt` | No type yet (blocks full IoT) |
| NATS | `nats` | No type yet |
| Oracle | `oracledb`, `cx_Oracle` | No type yet |
| Cassandra | `cassandra-driver` | No type yet |
| InfluxDB | `@influxdata/influxdb-client`, `influxdb-client` | No type yet |
| Memcached | `memcached`, `pymemcache` | No type yet |
| Vector DB (pgvector, Qdrant, Pinecone, Weaviate) | `pgvector`, `@qdrant/js-client`, `pinecone-client` | Use `Radius.Data/postgreSqlDatabases` for pgvector storage; vector features not modeled |
| Vault | `node-vault`, `hvac` | Use `Radius.Security/secrets` for app secrets; no Vault connection type |
