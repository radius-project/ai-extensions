---
name: radius-app-bicep
description: Generate a Radius app.bicep manifest from the contents of a repository. Use when the user asks to create, generate, scaffold, or update the .radius/app.bicep file that describes a Radius application's containers, databases, secrets, volumes, and routes.
---

# Radius — Generate app.bicep

Create or update the `.radius/app.bicep` file that describes a Radius application. The file uses the `Radius.*` resource types from `radius-project/resource-types-contrib` and is what `rad deploy` consumes.

## When to use this skill

- "Generate a Radius app.bicep for this repo"
- "Add a postgres database to my Radius app"
- "Scaffold the Radius manifest"
- "Update app.bicep to add a new container"
- "Create the Radius app file"

## Inputs you need

Before writing the file, gather:
1. **Application name** — usually the repo name in kebab-case.
2. **Containers** — one per service. Inspect the repo for `Dockerfile`(s), `package.json` scripts, `pyproject.toml`, etc. Each container needs:
   - a logical name
   - source build context (path to Dockerfile) OR an image reference
   - exposed port(s)
   - env vars (often from secrets or connection strings)
3. **Databases** — look for `DATABASE_URL`, ORMs (`prisma`, `sqlalchemy`, `mongoose`), or compose files. Map to `Radius.Data/postgreSqlDatabases` or `Radius.Data/mySqlDatabases`.
4. **Secrets** — anything sensitive (API keys, DB passwords). Use `Radius.Security/secrets`.
5. **Routes** — public-facing HTTP routes. Use `Radius.Compute/routes`.
6. **Volumes** — persistent storage needs. Use `Radius.Compute/persistentVolumes`.

If anything is ambiguous, ask the user before writing.

## Resource type cheat sheet

| Need | Resource type | Notes |
|---|---|---|
| Container | `Radius.Compute/containers` | Built from Dockerfile by the `containerImages` recipe |
| Built image | `Radius.Compute/containerImages` | Required if you want the workflow to build & push |
| Postgres | `Radius.Data/postgreSqlDatabases` | k8s recipe always available |
| MySQL | `Radius.Data/mySqlDatabases` | AWS recipe (needs VPC) or Azure recipe (needs RG) — **no k8s/terraform recipe**, only bicep |
| Volume | `Radius.Compute/persistentVolumes` | |
| Route | `Radius.Compute/routes` | Public HTTP ingress |
| Secret | `Radius.Security/secrets` | |

## Template structure

Write the file at `.radius/app.bicep`. Skeleton:

```bicep
extension radius

@description('Radius environment to deploy into.')
param environment string

@description('Radius application resource.')
param application string

@description('Container image registry (set by deploy workflow vars).')
param registry string = ''

// Image build
resource appImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: '${appName}-image'
  properties: {
    environment: environment
    application: application
    source: '.'              // path relative to repo root
    dockerfile: 'Dockerfile'
    registry: registry
  }
}

// Container
resource appContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: '${appName}-web'
  properties: {
    environment: environment
    application: application
    container: {
      image: appImage.properties.image
      ports: {
        web: { containerPort: 3000 }
      }
      env: {
        DATABASE_URL: { value: db.properties.connectionString }
      }
    }
  }
}

// Database (pick ONE based on provider)
resource db 'Radius.Data/postgreSqlDatabases@2025-08-01-preview' = {
  name: '${appName}-db'
  properties: {
    environment: environment
    application: application
    databaseName: appName
  }
}
```

## Process

1. **Read the repo**: list top-level files, look for `Dockerfile`, `package.json`, language manifests, env file templates (`.env.example`). Run a quick grep for `DATABASE_URL` or common ORM imports to detect data deps.
2. **Confirm with the user** if any resource type or value is ambiguous (port number, db engine, etc.).
3. **Write `.radius/app.bicep`** using the skeleton above, filling in real values. Use `view`/`create` tools — don't shell out to `cat <<EOF`.
4. **Tell the user the next step**: open the `radius` canvas, pick the app, choose an env, click Deploy (or invoke the `radius-deploy` skill).

## Validation

- `rad bicep build .radius/app.bicep` locally if `rad` CLI is on `$PATH`. Otherwise the GitHub Actions deploy run will catch any syntax errors.
- The mySql recipe needs provider-matching environment — use postgres if the env is plain k8s.

## Related files

- `plugins/radius/extensions/radius/extension.mjs` — repo analysis → bicep generation (`generateBicepFromRepo`)
- `plugins/radius/extensions/radius/extension.mjs` — commit/update `.radius/app.bicep` via GitHub Contents API (`/api/commit-app-bicep`)
- Upstream contrib repo: https://github.com/radius-project/resource-types-contrib (browse `Compute/`, `Data/`, `Security/` for available resource types)
