# Component Catalog

Maps common application components to Radius resource types, with detection cues from source code (client libraries across npm / PyPI / NuGet / RubyGems, plus manifest and connection-string hints). Use this to turn "what's in the repo" into "which type to emit". Always verify the resolved type against its schema in `radius-project/resource-types-contrib` (see the skill's Resource Type Resolution).

Match by **wire protocol, not exact library**: MariaDB clients map to MySQL, Valkey to Redis, DocumentDB / CosmosDB (Mongo API) to MongoDB.

## Compute

| Component | Detection cues | Radius type |
|---|---|---|
| Long-running service / worker / job | app entry point; a service in Dockerfile/compose | `Radius.Compute/containers` |
| Build image from a Dockerfile | `Dockerfile` present, no published image | `Radius.Compute/containerImages` |
| External ingress | HTTP server that needs a public URL | `Radius.Compute/routes` |
| Persistent volume | volume mounts in compose/Dockerfile | `Radius.Compute/persistentVolumes` |

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
| RabbitMQ | `amqplib` / `pika`, `aio-pika` / `RabbitMQ.Client` / `bunny` | `Radius.Messaging/rabbitMQ` | Microservices, Enterprise |
| LLM inference | `openai`, `@anthropic-ai/sdk`, `@google/generative-ai` / `openai`, `anthropic` / `Azure.AI.OpenAI` | `Radius.AI/models` | Web App, Microservices, AI/ML |
| Full-text / AI search | `@elastic/elasticsearch`, `@opensearch-project/opensearch` / `elasticsearch`, `opensearch-py` / `Azure.Search.Documents` | `Radius.AI/search` | Web App, Microservices, Data Pipeline, AI/ML |
| Object storage (S3 / Blob / GCS) | `@aws-sdk/client-s3`, `@azure/storage-blob` / `boto3`, `azure-storage-blob` / `AWSSDK.S3`, `Azure.Storage.Blobs` / `aws-sdk-s3` | `Radius.Storage/objectStorage` | Web App, Data Pipeline, AI/ML |
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
