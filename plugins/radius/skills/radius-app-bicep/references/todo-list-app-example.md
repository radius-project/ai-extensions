# Example: Todo-List-App (dockersamples/todo-list-app)

This example records reasoning and acceptance checks for `dockersamples/todo-list-app` at immutable commit [`5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063`](https://github.com/dockersamples/todo-list-app/tree/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063), not a complete `app.bicep`. Do not copy its resource names or values into unrelated applications, and re-derive every value when modeling another revision.

## Selected profile

The requested profile runs the application with MySQL instead of its default SQLite path. The source supports that profile when `MYSQL_HOST` is present, so the SQLite default does not override the explicit selection.

| Acceptance criterion          | Source/schema-backed decision                                                     |
|-------------------------------|-----------------------------------------------------------------------------------|
| MySQL backing service         | Emit the exact configured `Radius.Data/mySqlDatabases` type                       |
| Source-built workload         | Use the complete Dockerfile context at an immutable source ref                    |
| Native database contract      | Supply `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DB`               |
| Developer-supplied credential | Set `MYSQL_PASSWORD` from the same `@secure()` password parameter via `env.value` |
| Listener                      | Expose the source-configured port 3000                                            |

## Source analysis

- **Role**: long-running Node.js/Express web service
- **Listener**: [`src/index.js#L17-L18`](https://github.com/dockersamples/todo-list-app/blob/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063/src/index.js#L17-L18) starts the application on port 3000 after persistence initialization.
- **Persistence selection**: [`src/persistence/index.js#L1-L2`](https://github.com/dockersamples/todo-list-app/blob/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063/src/persistence/index.js#L1-L2) selects MySQL only when `MYSQL_HOST` is present; otherwise it selects SQLite.
- **Native configuration**: [`src/persistence/mysql.js#L5-L14`](https://github.com/dockersamples/todo-list-app/blob/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063/src/persistence/mysql.js#L5-L14) reads `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DB`; [lines 24-38](https://github.com/dockersamples/todo-list-app/blob/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063/src/persistence/mysql.js#L24-L38) use port 3306 and pass those decomposed values to the MySQL client.
- **Backing service**: [`compose.yaml#L10-L22`](https://github.com/dockersamples/todo-list-app/blob/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063/compose.yaml#L10-L22) selects `mysql:8.0` and database `todos` for this profile.
- **Image**: the pinned [`Dockerfile`](https://github.com/dockersamples/todo-list-app/blob/5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063/Dockerfile) is the complete source-build context. Tag omission and target platforms still require validation against the exact current `containerImages` Recipe and target runtime; this example makes no claim that omission is broken or that one platform is universally required.
- **Storage**: the selected MySQL service owns persistence; no application filesystem volume is required.
- **Primary pattern**: Web App

## Modeling decisions

1. The explicit MySQL profile selects the optional source-supported MySQL path; do not fall back to SQLite merely because it is the application default.
2. Resolve the MySQL type, API version, credential inputs, and `host` output against the exact target schema and Recipe.
3. Map all four native variables. A generic connection does not invent these application-specific names.
4. Pass the developer-supplied password to the schema's sensitive resource property from a `@secure()` parameter, and assign that same parameter directly to the workload's `MYSQL_PASSWORD` `env.value`. Radius encrypts and injects it, so no wrapper `Radius.Security/secrets` resource or `secretKeyRef` is needed.
5. Referencing the image and Recipe-mapped MySQL host creates dependency ordering. Omit a generic connection unless the request explicitly requires Radius relationship metadata or the source consumes its exact projection.
6. Pin `build.source` to the modeled commit, validate tag omission and platforms against the exact current Recipe and target runtime, and consume the build through verified `properties.imageReference`.
7. Verify that the target Environment registers Recipes for every emitted extensible type.
8. Match `containerPort` to the inspected process listener. The loopback-only Compose mapping is not external-client ingress evidence.

## Completion checks

- The selected MySQL type and source-built workload are both emitted.
- Every required native variable appears with exact spelling and format.
- The workload password comes from the same `@secure()` parameter assigned to `env.value`; no password is hardcoded and no wrapper secret or `secretKeyRef` is authored.
- The exact target Recipe maps every consumed output and is registered for every emitted type.
- The source build uses the pinned commit and Recipe-validated tag/platform behavior, without unsupported package-manager or architecture assumptions.
- The process listener, image entrypoint, and database name/version agree with the pinned source.
- The definition compiles against an extension compatible with the exact target contract and has no unresolved runtime caveat.
