# Source-Code References for Graph Nodes

Each graph node can carry a **source-code reference** that points at the place in the code where that resource is defined, created, or initialized. It is either a repo-relative worktree path or an exact GitHub branch/file URL, optionally with a `#L<line>` anchor. The canvas turns it into a clickable node link, so a reviewer can jump from a box in the application graph straight to, say, the file that opens the MySQL connection.

Radius's reusable schemas treat this as optional metadata that a developer may hand-add. Generated app models use a stricter completeness contract: this skill must attach one durable reference to every non-application resource so source navigation survives graph regeneration.

## Where the reference lives

The reference surfaces on the graph node as `codeRef` and is sourced from the resource's `codeReference` value:

- **In `app.bicep`** — set `codeReference` inside every non-application resource's `properties`. Use `'<path>[#L<line>]'` for a current-worktree file and an exact `https://github.com/<owner>/<repo>/blob/<branch>/<path>[#L<line>]` URL for a committed branch file. `rad app graph` preserves it and the canvas renders the link. The `radius-app-bicep` skill must populate it before publishing a generated model. Built-in types get the property from Radius's base resource schema; a generated `Radius.Resources/*` custom type is a closed object built from `custom-types.yaml` and accepts it only because that manifest declares it, so on a custom type generated before that rule, add the property to the manifest and republish the extension rather than authoring an unsupported property.
- **When a graph reports a missing reference** — repair the staged `app.bicep` through the `radius-app-bicep` skill and rebuild the graph. The instance-scoped graph update action is retained for compatibility, but it is not durable model state and must not be used as the completion path for a generated model.

`applications` resources never get a source reference — skip them.

## The goal: definition/initialization site, not just any mention

Point the link at where the resource is **logically created or initialized**, not merely referenced:

- A data store → the file/line that opens the client/pool/connection (e.g. `createPool`, `new Pool`, `mongoose.connect`, `neo4j.driver`).
- A container/compute → the entrypoint of the workload the image runs (`app.listen`, `http.ListenAndServe`, `Flask(__name__)`, `func main`), never the `Dockerfile` or a compose/Helm manifest. Those describe how the workload is packaged, not where it is defined; a Dockerfile is a _lookup aid_ for finding the entrypoint, not a destination.
- A container **image** (`containerImage`) → the `Dockerfile` the build reads. Here the packaging file genuinely is the definition site: the image resource exists to build it, and `build.dockerfile`/`build.source` name the file and the commit it is read from. This keeps an image node and the workload node that consumes it pointing at distinct, meaningful locations.
- A secret → the file that reads/loads the credential (`process.env`, `os.environ`, `getSecret`) or the `.env` template.

Prefer the real usage/initialization site over a barrel/re-export file (`index.js`, `index.ts`), and **never** point at a test, spec, mock, fixture, or vendored file.

## Discovery method

For each resource missing a reference, work the branch the graph is being built for:

1. **Categorize the resource** from its `type` (case-insensitive substring), taking the **first match in the order listed here**: `mysql`, `postgres`/`pgsql`, `redis`/`cache`, `mongo`, `rabbit`/`queue`/`messaging`, `kafka`/`event`, `neo4j`, `secret`, `containerImage`, `container`/`compute`, `storage`/`volume`, `route`/`ingress`, `model`/`search`, or `custom`. Order decides here, because `Radius.Compute/containerImages` contains both `containerimage` and `container` and the two categories now resolve to opposite destinations. `containerImage` is listed first so an image is never categorized as a container; if you match on the type segment instead of a substring, match `containerImages` before `containers` for the same reason. Getting this backwards points an image at an entrypoint and collapses it onto the workload's link, and `validate-bicep.mjs` cannot catch it because `containerImages` is exempt from the packaging-file check.
2. **Match a file by name** using the category's file-name patterns (below). Take the first match that is not skipped.
3. **Pinpoint the line** by scanning the matched file for the category's initialization/content patterns; append `#L<line>` at the first match (1-based).
4. **Content fallback** — if no filename matched, scan a bounded set of source files (skip barrels last) for the initialization pattern and link `path#L<line>` at the first hit.
5. **Container entrypoint resolution** — this narrows steps 2-4 for the `container`/`compute` category; it does not bypass them. Resolve the entrypoint in this order, and take the first that resolves:
   1. **The resource's own `command`/`args`, applied over the image defaults** — `bicep-structure-rules.md` defines `command` as replacing the image `ENTRYPOINT` and `args` as replacing `CMD`. They override those two defaults **independently**, so neither field is a process path on its own. Build the _effective invocation_ first: take `command` if the resource sets it, otherwise the Dockerfile's `ENTRYPOINT`; take `args` if the resource sets it, otherwise the Dockerfile's `CMD`; then concatenate entrypoint followed by args. Resolve the executable or script from that combined invocation — its first element, or the first non-flag element after it when the entrypoint is a bare interpreter or launcher (`node`, `python`, `dotnet`, `sh -c`). Never read `args` alone as the process: `args: ['--port', '8080']` replaces only `CMD`, the image `ENTRYPOINT` still runs, and treating that flag as a path makes it fall through to an unrelated filename match. Prefer this over the image whenever the overrides change the effective invocation, because that is what keeps two containers built from one image — an api and a worker, say — pointed at their own entrypoints instead of both at the api's. The resolved element names a path **inside the container**, not in the repository, so this branch is not finished until that path is mapped back: read the image's Dockerfile `WORKDIR` and `COPY`/`ADD` instructions to invert the container path to a repository path (`args: ['/app/worker.js']` against an entrypoint of `['node']`, with `WORKDIR /app` and `COPY src/ /app/`, resolves to `src/worker.js`). Use the resolved process from the effective invocation, but use the Dockerfile in 5.2 both to supply the unoverridden default and to do the mapping. If the mapping does not resolve to a file in the repository, fall through to 5.3 — never author a container-absolute path such as `/app/worker.js`, which `validate-bicep.mjs` rejects as a malformed reference, and never guess a repository path.
   2. **The Dockerfile the container's image is built from** — when the resource overrides neither field, the effective invocation is entirely the image's, so read the Dockerfile's `ENTRYPOINT`/`CMD` to identify the module, script, or binary it executes, then map that container path back to the repository through `WORKDIR` and `COPY`/`ADD` as in 5.1. If it runs a package script (`npm start`) or a module (`python -m ...`), follow the manifest (`package.json`, `pyproject.toml`, `go.mod`) to the real entrypoint file.
   3. **Steps 2-4 with the `container` cues** — when no Dockerfile matches the service, or its entrypoint does not resolve to a file in the repository, fall back to the normal filename and content search. A repository is only required to have one Dockerfile, and a multi-image repository is modeled as a single application, so several containers sharing one Dockerfile is the normal case rather than an error.

   Whichever branch resolves, link the source line that starts the process and never the `Dockerfile` itself. If none resolves, continue to step 6/7 rather than linking a packaging file.

6. **Declarative resources** — for storage, routes, AI endpoints, recipe-backed custom types, and other resources without a runtime constructor, use the checked-in manifest, migration, schema, configuration, or application wiring that requires the resource.
7. **Last resort** — use a `docker-compose.*` declaration when it exists; otherwise use the resource's own declaration line in `.radius/app.bicep`. The generated Bicep declaration is the authoritative definition site when the application has no separate initialization file. For a `container`/`compute` resource, skip the compose option and go straight to the `.radius/app.bicep` declaration: a compose service block is packaging, and linking it is the failure this ordering exists to prevent.

Keep the search bounded (don't fetch the whole repo): a few dozen candidate files and a small fetch budget are enough. Cache file contents you fetch.

### File-name patterns by category

| Category       | Filename or path cues (basename unless the cue contains `/`, at any dir depth)                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| mysql          | `db`,`database`,`persistence`,`connection`,`datastore`,`mysql`; `config/database`; `models/{index,db}`; `prisma/schema.prisma`; `knexfile` |
| postgres       | `db`,`database`,`persistence`,`connection`,`datastore`,`postgres`,`pg`; `config/database`; `prisma/schema.prisma`; `knexfile`              |
| redis          | `redis`,`cache`,`session`; `config/{redis,cache}`                                                                                          |
| mongo          | `db`,`database`,`mongo`,`mongoose`; `models/{index,db}`                                                                                    |
| rabbitmq/kafka | `queue`,`messaging`,`rabbitmq`,`amqp`,`kafka`,`broker`,`event(s)`                                                                          |
| neo4j          | `db`,`database`,`neo4j`,`graph`                                                                                                            |
| containerImage | `Dockerfile`, `Dockerfile.*`, `*.Dockerfile` — the build's own file, per the image bullet above                                            |
| container      | `server`,`app`,`main`,`index`,`entrypoint` (incl. under `src/`); `cmd/*/main`. Reached through step 5.3; never `Dockerfile`                |
| storage/volume | `storage`,`volume`,`uploads`,`assets`,`data`; `docker-compose.*`; deployment manifests                                                     |
| route/ingress  | `route(s)`,`ingress`,`gateway`,`proxy`; framework route configuration; deployment manifests                                                |
| AI             | `ai`,`model`,`search`,`embedding`; client/configuration modules                                                                            |
| secret         | `secret(s)`,`credential(s)`,`auth`,`env`; `config/{secrets,credentials}`; `.env`(`.example`/`.sample`)                                     |
| custom         | The manifest, configuration, or application integration that motivates the custom backing service                                          |

Source extensions considered for content scans: `.js .ts .mjs .cjs .jsx .tsx .py .go .java .rb`.

### Initialization/content patterns by category

| Category  | First-match line cues (case-insensitive)                                              |
| --------- | ------------------------------------------------------------------------------------- |
| mysql     | `createConnection`, `createPool`, `mysql.connect`, `new MySQL`, `mysql2`              |
| postgres  | `new Pool`, `pg.connect`, `new Client`, `createClient`, `psycopg`, `sqlalchemy`       |
| redis     | `createClient`, `new Redis`, `Redis(`, `redis.connect`, `ioredis`                     |
| mongo     | `mongoose.connect`, `MongoClient`, `mongo.connect`, `new Mongo`                       |
| rabbitmq  | `amqp.connect`, `createChannel`, `RabbitMQ`, `pika.`                                  |
| kafka     | `Kafka(`, `producer(`, `consumer(`, `subscribe(`, `publish(`                          |
| neo4j     | `neo4j.driver`, `GraphDatabase`, `new Driver`                                         |
| container | `listen(`, `createServer`, `app.listen`, `http.ListenAndServe`, `Flask(`, `func main` |
| storage   | `upload`, `blob`, `bucket`, `volume`, `mount`, `readFile`, `writeFile`                |
| route     | `route`, `ingress`, `gateway`, `proxy`, `host`, `path`                                |
| AI        | `model`, `embedding`, `search`, `completion`, `inference`                             |
| secret    | `getSecret`, `SECRET_`, `process.env`, `os.environ`                                   |

### Always skip

- Directories: `node_modules`, `vendor`, `dist`, `build`, `.git`, `test(s)`, `__tests__`, `spec(s)`, `__mocks__`, `e2e`, `cypress`, `fixtures`.
- Files: `*.spec.*`, `*.test.*`, `*.stories.*`, `*.mock.*`, `*.d.*`.
- **As a `container`/`compute` destination only** (these are valid targets for a `containerImage`, and the first three are valid last-resort targets for a backing store): `Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `docker-compose*.{yml,yaml}`, `compose*.{yml,yaml}`, `Chart.yaml`, `values.yaml`. `validate-bicep.mjs` enforces exactly this list on `Radius.Compute/containers`. A Kubernetes manifest such as `deployment.yaml` is equally wrong but is not name-distinguishable from any other YAML, so it is covered by the prose rule above rather than by a pattern.

## Output format

- For a source file in the selected current worktree, author a **repo-relative path** with forward slashes, optionally `#L<line>`: `src/db/mysql.js#L14`, `services/api/src/server.ts#L42`. Although the reusable Radius base schema describes `codeReference` as a source URI, the generated-model contract intentionally permits this local form so the editor canvas can open uncommitted and local-only files that have no truthful remote URL.
- For a source file resolved from a committed GitHub branch rather than the current worktree, author the exact `https://github.com/<owner>/<repo>/blob/<branch>/<path>[#L<line>]` URL. The URL must name the branch and file that were actually inspected. Never create such a URL for an uncommitted or unpushed file.
- If no separate application file is credible, link the resource declaration in `.radius/app.bicep`; never link a wrong/test file or publish without the durable reference.

## Verify

After attaching references, confirm each resolves against the branch being graphed (the file exists, the line is within range, and it is the initialization site, not a test). Confirm no `container`/`compute` reference points at a `Dockerfile`, compose file, or other packaging manifest, and that a `containerImage` reference points at the Dockerfile its build actually reads. If you authored them into `app.bicep`, rebuild the graph and confirm the nodes now deep-link where expected.
