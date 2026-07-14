# Example: Todo-List-App (dockersamples/todo-list-app)

## Source analysis

- **Framework**: Node.js + Express.js
- **Port**: 3000
- **Persistence**: Swappable — SQLite (default) or MySQL (when `MYSQL_HOST` is set)
- **Env vars read by app**: `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DB`
- **Compose**: MySQL 8.0 with persistent volume
- **Dockerfile**: Yes — builds from `node:22-alpine`, runs `node src/index.js`
- **Published image**: No — must be built from Dockerfile
- **Pattern**: B — Stateful / Database-Backed Application

## Resource mapping

| Source component | Radius Resource Type | API Version |
|---|---|---|
| Application grouping | `Radius.Core/applications` | `2025-08-01-preview` |
| Dockerfile (build image) | `Radius.Compute/containerImages` | `2025-08-01-preview` |
| Node.js container | `Radius.Compute/containers` | `2025-08-01-preview` |
| MySQL 8.0 | `Radius.Data/mySqlDatabases` | `2025-08-01-preview` |

## Key decisions explained

1. **`Radius.Core/applications@2025-08-01-preview`** — the application resource is a built-in Radius type (provided by the `radius` extension), NOT from `resource-types-contrib`.
2. **`containerImages` resource** — the app has a Dockerfile but no published image. The `containerImages` resource builds and pushes it.
3. **`build.source`** — the `containerImages` resource builds from the repo's git URL (e.g. `git::https://github.com/dockersamples/todo-list-app.git?ref=<sha>`); there is no `image` property or `param image`.
4. **`imageReference`** — the container sets `image: todoImage.properties.imageReference`, which creates the build-ordering dependency (no explicit connection to the image).
5. **Database credentials** — `mySqlDatabases` takes `username` (an admin you author, e.g. `myadmin`) and `password` directly on the resource; no separate secret. The `password` comes from a `@secure() param`.
6. **`@secure() param password string`** — password is passed at deploy time, never hardcoded.
7. **`database: 'todos'`** — derived from the `MYSQL_DATABASE: todos` in compose.yaml, not hardcoded.
8. **`version: '8.0'`** — derived from the `mysql:8.0` image tag in compose.yaml, not hardcoded.
9. **One connection on the container** — `mysqldb` for database auto-injection. Build ordering comes from referencing `todoImage.properties.imageReference`, not a connection.
10. **No routes** — not added unless external ingress is explicitly required.
11. **App code change required** — `Radius.Compute/containers` injects a JSON blob via `CONNECTION_MYSQLDB_PROPERTIES`, not individual vars. The app's `src/persistence/index.js` must be updated to parse this JSON. See [connection-conventions.md](connection-conventions.md) for helper code.