# Naming Conventions

| Element                              | Convention                                  | Example                               |
|--------------------------------------|---------------------------------------------|---------------------------------------|
| Bicep symbolic name                  | camelCase, descriptive                      | `todoApp`, `mysqlDb`, `todoContainer` |
| Data store symbolic name             | `<engine>` + role suffix, camelCase         | `mysqlDb`, `postgresDb`, `redisCache` |
| Secret symbolic name                 | `<engine>Secret` or `appSecrets`, camelCase | `appSecrets`                          |
| Resource `name` property             | kebab-case, matches app/repo name           | `'todo-list-app'`, `'my-database'`    |
| Connection keys                      | lowercase, engine + role                    | `mysqldb`, `postgresdb`, `rediscache` |
| Application name                     | kebab-case, matches repository name         | `'todo-list-app'`                     |
| Container keys (in `containers` map) | camelCase, describes the container role     | `todo`, `frontend`, `api`             |
| Port keys (in `ports` map)           | camelCase, describes the protocol/use       | `web`, `http`, `grpc`                 |
| Volume keys (in `volumes` map)       | camelCase, describes the data               | `data`, `cache`, `secrets`            |

## Rules

- Bicep symbolic names (left side of `=`) are always camelCase
- Resource `name` properties (string values) are always kebab-case
- Map keys inside `containers`, `ports`, and `volumes` are camelCase; `connections` keys are lowercase (engine + role)
- Never use spaces, underscores, or special characters in any name
- Explicit deployment-contract names and parameters take precedence over defaults. Preserve a documented resource-name parameter when a target Environment Recipe or verification couples it to a provider resource with naming or uniqueness constraints.
- A [fixed peer hostname](runtime-contract.md#fixed-peer-hostnames) in the selected image is a runtime constraint, not a naming preference. Choose resource names and container keys only after proving how the exact selected Recipe maps them to DNS names. Default app/repo-based resource names and container-role keys can change to satisfy that mapping, but all names must still meet the selected Recipe's constraints. Preserve explicit deployment-contract names; when they conflict with a fixed hostname and no consumed override exists, report the incompatibility and stop rather than changing the Recipe naming rule or publishing a broken model.
