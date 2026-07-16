# Example: Todo-List-App (dockersamples/todo-list-app)

This example records the reasoning and acceptance checks rather than a complete
`app.bicep`, so its resource names and values are not copied into unrelated
applications.

## Selected profile

The requested profile runs the application with MySQL instead of its default
SQLite path. The source supports that profile when `MYSQL_HOST` is present, so
the SQLite default does not override the explicit selection.

| Acceptance criterion | Source/schema-backed decision |
|---|---|
| MySQL backing service | Emit the exact configured `Radius.Data/mySqlDatabases` type |
| Source-built workload | Use the complete Dockerfile context at an immutable source ref |
| Native database contract | Supply `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DB` |
| Developer-supplied credential | Set `MYSQL_PASSWORD` from the same `@secure()` password parameter via `env.value` |
| Listener | Expose the source-configured port 3000 |

## Source analysis

- **Role**: long-running Node.js/Express web service
- **Listener**: port 3000, configured by the application
- **Persistence**: SQLite by default; MySQL when `MYSQL_HOST` is present
- **Native configuration read by source**: `MYSQL_HOST`, `MYSQL_USER`,
  `MYSQL_PASSWORD`, `MYSQL_DB`
- **Backing service**: MySQL 8.0 with database `todos`
- **Image**: complete Dockerfile/build context, pinned to an immutable source commit
- **Storage**: the modeled MySQL service owns persistence; no application
  filesystem volume is required
- **Primary pattern**: Web App

## Modeling decisions

1. The explicit MySQL profile selects the optional source-supported MySQL path;
   do not fall back to SQLite merely because it is the application default.
2. Resolve the MySQL type, API version, credential inputs, and `host` output
   against the exact configured extension and recipe.
3. Map all four native variables. A generic connection does not invent these
   application-specific names.
4. Pass the developer-supplied password to the schema's sensitive resource
   property from a `@secure()` parameter, and assign that same parameter directly
   to the workload's `MYSQL_PASSWORD` `env.value`. Radius encrypts and injects it,
   so no wrapper `Radius.Security/secrets` resource or `secretKeyRef` is needed.
5. Referencing the image and MySQL host creates dependency
   ordering. Omit a generic connection unless the request explicitly requires
   Radius relationship metadata or the source consumes its exact projection.
6. Consume the source build through the image resource's verified
   `properties.imageReference`.
7. Match `containerPort` to the inspected process listener. Do not add a route
   unless external ingress is requested.

## Completion checks

- The selected MySQL type and source-built workload are both emitted.
- Every required native variable appears with exact spelling and format.
- The workload password comes from the same `@secure()` parameter assigned to
  `env.value`; no password is hardcoded and no wrapper secret or `secretKeyRef`
  is authored.
- The process listener, image entrypoint, and database name/version agree with
  the pinned source.
- The definition compiles against the exact configured extension and has no
  unresolved runtime caveat.
