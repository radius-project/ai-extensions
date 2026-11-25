# Wiring patterns for Stage 3

Read this before you write the settings. Each pattern shows one shape. Check the facts for your model with `types.mjs` (properties, read-only outputs, secret keys) and `recipe.mjs` (what the provider's Recipe deploys and how its outputs map).

## Contents

- A database whose credentials you choose
- A service whose Recipe makes the credential
- A credential property that takes a secret resource
- The app's own secrets
- Another workload in the app
- A persistent volume
- Image builds and the registry secret

## A database whose credentials you choose

PostgreSQL, MySQL, and SQL Server take `username` and `password` on the resource. Choose the username, and take the password from a `@secure()` parameter with no default. Put the password in an app secret, and read it with `secretKeyRef`. Read the host, port, and database from the resource's outputs.

```bicep
@secure()
param postgresPassword string

var postgresUsername = 'myadmin'

resource postgresDb 'Radius.Data/postgreSqlDatabases@2025-08-01-preview' = {
  name: 'postgres'
  properties: {
    // ...the Stage 1 and Stage 2 properties stay as they are
    username: postgresUsername
    password: postgresPassword
  }
}

// In the container that uses it, in the format that its parser reads:
env: {
  DB_HOST: { value: postgresDb.properties.host }
  DB_PORT: { value: string(postgresDb.properties.port) }
  DB_NAME: { value: postgresDb.properties.database }
  DB_USER: { value: postgresUsername }
  DB_PASSWORD: {
    valueFrom: {
      secretKeyRef: {
        secretName: appSecrets.name
        key: 'postgresPassword'
      }
    }
  }
}
```

The managed cloud databases require TLS by default. Turn TLS on in the client's own setting, such as `sslmode=require` in a URL, or a TLS flag. A connection to a database does not pass its password to the container, so read it from your secret as above.

## A service whose Recipe makes the credential

Redis, MongoDB, Kafka, object storage, AI models, and search services: the Recipe creates the key or connection string. The type card lists it under `secrets`. Read it in one of two ways:

- A whole value: `secretKeyRef: { secretName: redisCache.properties.secrets.name, key: 'accessKey' }`.
- Part of a value that you compose: give the container a connection, `connections: { rediscache: { source: redisCache.id } }`, and use `$(CONNECTION_REDISCACHE_ACCESSKEY)` inside an env value. The containers Recipe sets `CONNECTION_<CONNECTION NAME>_<KEY>` for each property and secret of a connected resource, unless the connection sets `disableDefaultEnvVars: true`. Kubernetes expands `$(NAME)` in env values.

Do not invent a password for these services.

## A credential property that takes a secret resource

Some types take a `Radius.Security/secrets` resource ID for a credential, such as `password: brokerSecret.id`. The type card's description says so. Put the value in that secret resource, and read it in the container from the same secret.

## The app's own secrets

Keys that the app needs and that no service creates, such as a session secret, an encryption key, or an admin password: take each from a `@secure()` parameter with no default, put them all in one `Radius.Security/secrets` resource, and read each with `secretKeyRef`.

```bicep
resource appSecrets 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'app-secrets'
  properties: {
    environment: environment
    application: app.id
    codeReference: '<the code that reads the first secret>'
    data: {
      postgresPassword: {
        value: postgresPassword
      }
      sessionSecret: {
        value: sessionSecret
      }
    }
  }
}
```

When the app reads a secret only from a file, mount the secret resource instead, and point the app's setting to the file. Each key becomes a file named after the key:

```bicep
// On the containers resource:
volumes: {
  secrets: {
    secretName: appSecrets.name
  }
}
// On the container that reads the file:
volumeMounts: [
  {
    volumeName: 'secrets'
    mountPath: '/run/secrets/app'
  }
]
```

## Another workload in the app

When a workload calls another workload, and the model already connects them, compose the address from the peer's `hosts` output with dot access, and the port that the peer listens on:

```bicep
API_URL: { value: 'http://${apiContainer.properties.hosts.api}:8080' }
```

`hosts` maps each container key to its Kubernetes Service. Do not add a reference to a workload that the model does not already connect: that adds a connection, and Stage 3 adds none.

## A persistent volume

When the model connects a container to a `Radius.Compute/persistentVolumes` resource, mount it:

```bicep
// On the containers resource:
volumes: {
  data: {
    persistentVolume: {
      resourceId: dataVolume.id
    }
  }
}
// On the container that uses it:
volumeMounts: [
  {
    volumeName: 'data'
    mountPath: '<the path where the app writes its data>'
  }
]
```

## Image builds and the registry secret

Each `Radius.Compute/containerImages` resource needs `build.platforms`, such as `['linux/amd64']`. Without it, the Recipe builds for amd64 and arm64 and cannot emulate, so a Dockerfile that does not cross-compile fails. The Radius deploy workflow configures the containerImages Recipe to push with the credentials in a secret named `radius-ghcr-registry-creds`:

```bicep
@secure()
param registryUsername string

@secure()
param registryPassword string

// Do not change this name. The deploy workflow configures the containerImages Recipe to read it.
resource registryCreds 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'radius-ghcr-registry-creds'
  properties: {
    environment: environment
    application: app.id
    codeReference: '.radius/app.bicep#L<line of this resource>'
    data: {
      username: {
        value: registryUsername
      }
      password: {
        value: registryPassword
      }
    }
  }
}
```

Add `dependsOn: [registryCreds]` to each `containerImages` resource.
