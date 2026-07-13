# Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Bicep symbolic name | camelCase, descriptive | `todoApp`, `mysqlDb`, `todoContainer` |
| Data store symbolic name | `<engine>` + role suffix, camelCase | `mysqlDb`, `postgresDb`, `redisCache` |
| Secret symbolic name | `<engine>Secret` or `appSecrets`, camelCase | `appSecrets` |
| Resource `name` property | kebab-case, matches app/repo name | `'todo-list-app'`, `'my-database'` |
| Connection keys | lowercase, engine + role | `mysqldb`, `postgresdb`, `rediscache` |
| Application name | kebab-case, matches repository name | `'todo-list-app'` |
| Container keys (in `containers` map) | camelCase, describes the container role | `todo`, `frontend`, `api` |
| Port keys (in `ports` map) | camelCase, describes the protocol/use | `web`, `http`, `grpc` |
| Volume keys (in `volumes` map) | camelCase, describes the data | `data`, `cache`, `secrets` |

## Rules

- Bicep symbolic names (left side of `=`) are always camelCase
- Resource `name` properties (string values) are always kebab-case
- Map keys inside `containers`, `ports`, and `volumes` are camelCase; `connections` keys are lowercase (engine + role)
- Never use spaces, underscores, or special characters in any name