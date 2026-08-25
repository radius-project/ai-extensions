# Source-Code References for Graph Nodes

Each graph node can carry a **source-code reference** — a repo-relative path (optionally with a `#L<line>` anchor) that points at the place in the code where that resource is defined, created, or initialized. The canvas turns this into a clickable deep link on the node, so a reviewer can jump from a box in the application graph straight to, say, the file that opens the MySQL connection.

Radius treats this as optional metadata that a developer would normally hand-add. Because the app model here is generated rather than hand-crafted, this skill is responsible for finding that location and attaching it to the resource.

## Where the reference lives

The reference surfaces on the graph node as `codeRef` and is sourced from the resource's `codeReference` value:

- **In `app.bicep`** — set `codeReference: '<path>[#L<line>]'` inside every non-application resource's `properties`. `rad app graph` preserves it and the canvas renders the link. The `radius-app-bicep` skill must populate it before publishing a generated model. Built-in types get the property from Radius's base resource schema; a generated `Radius.Resources/*` custom type is a closed object built from `custom-types.yaml` and accepts it only because that manifest declares it, so on a custom type generated before that rule, add the property to the manifest and republish the extension rather than authoring an unsupported property.
- **When a graph reports a missing reference** — repair the staged `app.bicep` through the `radius-app-bicep` skill and rebuild the graph. The instance-scoped graph update action is retained for compatibility, but it is not durable model state and must not be used as the completion path for a generated model.

`applications` resources never get a source reference — skip them.

## The goal: definition/initialization site, not just any mention

Point the link at where the resource is **logically created or initialized**, not merely referenced:

- A data store → the file/line that opens the client/pool/connection (e.g. `createPool`, `new Pool`, `mongoose.connect`, `neo4j.driver`).
- A container/compute → the service entrypoint (`app.listen`, `http.ListenAndServe`, `Flask(__name__)`) or the service's `Dockerfile`.
- A secret → the file that reads/loads the credential (`process.env`, `os.environ`, `getSecret`) or the `.env` template.

Prefer the real usage/initialization site over a barrel/re-export file (`index.js`, `index.ts`), and **never** point at a test, spec, mock, fixture, or vendored file.

## Discovery method

For each resource missing a reference, work the branch the graph is being built for:

1. **Categorize the resource** from its `type` (case-insensitive substring):
   `mysql`, `postgres`/`pgsql`, `redis`/`cache`, `mongo`, `rabbit`/`queue`/`messaging`, `neo4j`, `secret`, `container`/`compute`.
2. **Match a file by name** using the category's file-name patterns (below). Take the first match that is not skipped.
3. **Pinpoint the line** by scanning the matched file for the category's initialization/content patterns; append `#L<line>` at the first match (1-based).
4. **Content fallback** — if no filename matched, scan a bounded set of source files (skip barrels last) for the initialization pattern and link `path#L<line>` at the first hit.
5. **Container special case** — prefer a `Dockerfile` in the directory that matches the service name; otherwise the service entrypoint file.
6. **Last resort** — a `docker-compose.*` file that declares the service/store is an acceptable file-level link when no source init site exists.

Keep the search bounded (don't fetch the whole repo): a few dozen candidate files and a small fetch budget are enough. Cache file contents you fetch.

### File-name patterns by category

| Category  | Filename cues (basename, any dir depth)                                                                                                    |
|-----------|--------------------------------------------------------------------------------------------------------------------------------------------|
| mysql     | `db`,`database`,`persistence`,`connection`,`datastore`,`mysql`; `config/database`; `models/{index,db}`; `prisma/schema.prisma`; `knexfile` |
| postgres  | `db`,`database`,`persistence`,`connection`,`datastore`,`postgres`,`pg`; `config/database`; `prisma/schema.prisma`; `knexfile`              |
| redis     | `redis`,`cache`,`session`; `config/{redis,cache}`                                                                                          |
| mongo     | `db`,`database`,`mongo`,`mongoose`; `models/{index,db}`                                                                                    |
| rabbitmq  | `queue`,`messaging`,`rabbitmq`,`amqp`,`broker`,`event(s)`                                                                                  |
| neo4j     | `db`,`database`,`neo4j`,`graph`                                                                                                            |
| container | `Dockerfile`; `server`,`app`,`main`,`index` (incl. under `src/`)                                                                           |
| secret    | `secret(s)`,`credential(s)`,`auth`,`env`; `config/{secrets,credentials}`; `.env`(`.example`/`.sample`)                                     |

Source extensions considered for content scans: `.js .ts .mjs .cjs .jsx .tsx .py .go .java .rb`.

### Initialization/content patterns by category

| Category  | First-match line cues (case-insensitive)                                        |
|-----------|---------------------------------------------------------------------------------|
| mysql     | `createConnection`, `createPool`, `mysql.connect`, `new MySQL`, `mysql2`        |
| postgres  | `new Pool`, `pg.connect`, `new Client`, `createClient`, `psycopg`, `sqlalchemy` |
| redis     | `createClient`, `new Redis`, `Redis(`, `redis.connect`, `ioredis`               |
| mongo     | `mongoose.connect`, `MongoClient`, `mongo.connect`, `new Mongo`                 |
| rabbitmq  | `amqp.connect`, `createChannel`, `RabbitMQ`, `pika.`                            |
| neo4j     | `neo4j.driver`, `GraphDatabase`, `new Driver`                                   |
| container | `listen(`, `createServer`, `app.listen`, `http.ListenAndServe`, `Flask(`        |
| secret    | `getSecret`, `SECRET_`, `process.env`, `os.environ`                             |

### Always skip

- Directories: `node_modules`, `vendor`, `dist`, `build`, `.git`, `test(s)`, `__tests__`, `spec(s)`, `__mocks__`, `e2e`, `cypress`, `fixtures`.
- Files: `*.spec.*`, `*.test.*`, `*.stories.*`, `*.mock.*`, `*.d.*`.

## Output format

- Author a **repo-relative path** with forward slashes, optionally `#L<line>`: `src/db/mysql.js#L14`, `services/api/Dockerfile`. This is the canonical authored value.
- Do not author a branch or full URL. The canvas resolves the repo-relative value against the graph's repo and branch into `<repo-url>/blob/<branch>/<path>#L<line>`. Radius's base resource schema documents `codeReference` as a fully-qualified source URI, but authoring a full URL breaks this canvas deep-link path, so keep authored values repo-relative.
- If nothing credible is found, stop and report that the generated model is incomplete rather than linking a wrong/test file or publishing without the durable reference.

## Verify

After attaching references, confirm each resolves against the branch being graphed (the file exists, the line is within range, and it is the initialization site, not a test). If you authored them into `app.bicep`, rebuild the graph and confirm the nodes now deep-link where expected.
