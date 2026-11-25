// A complete Stage 1 model for a made-up app in github.com/contoso/shop:
// a web front end from a published image, an API built from the repository,
// a PostgreSQL database, a search engine that has no Radius type, and a
// route to the web front end. Copy its shape, not its choices.
extension radius

param environment string

resource shopApp 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'shop'
  properties: {
    environment: environment
  }
}

// A backing service with a Radius type. Set only what the source names.
resource postgresDb 'Radius.Data/postgreSqlDatabases@2025-08-01-preview' = {
  name: 'postgres'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/api/db/connect.go#L18'
    database: 'shop'
  }
}

// A backing service with no Radius type runs as a container from the image
// that the deployment files name, with a volume for its data.
resource searchData 'Radius.Compute/persistentVolumes@2025-08-01-preview' = {
  name: 'search-data'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/compose.yaml#L41'
    sizeInGib: 10
  }
}

resource searchContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'search'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/compose.yaml#L33'
    containers: {
      search: {
        image: 'docker.io/example/search-engine:8.2'
        ports: {
          http: {
            containerPort: 9200
          }
        }
      }
    }
  }
  dependsOn: [
    searchData
  ]
}

// The API builds from the repository at the checked-out commit. The build
// context is the api folder, so build.source ends in //api and
// build.dockerfile would be relative to that folder.
resource apiImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'api-image'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/api/Dockerfile#L1'
    build: {
      source: 'git::https://github.com/contoso/shop.git//api?ref=<commit>'
    }
  }
}

resource apiContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'api'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/api/main.go#L25'
    containers: {
      api: {
        image: apiImage.properties.imageReference
        ports: {
          web: {
            containerPort: 8080
          }
        }
      }
    }
  }
  // "api uses postgres and search". Stage 3 later wires the settings.
  dependsOn: [
    postgresDb
    searchContainer
  ]
}

// The web front end uses the image that the deployment files publish.
resource webContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'web'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/web/src/server.ts#L9'
    containers: {
      web: {
        image: 'ghcr.io/contoso/shop-web:2.1.0'
        ports: {
          web: {
            containerPort: 3000
          }
        }
      }
    }
  }
  dependsOn: [
    apiContainer
  ]
}

// The deployment files expose the web front end through an Ingress.
resource webRoute 'Radius.Compute/routes@2025-08-01-preview' = {
  name: 'web-route'
  properties: {
    environment: environment
    application: shopApp.id
    codeReference: 'https://github.com/contoso/shop/blob/<commit>/deploy/ingress.yaml#L7'
    kind: 'HTTP'
    rules: [
      {
        matches: [
          {
            httpPath: '/'
          }
        ]
        destinationContainer: {
          resourceId: webContainer.id
          containerName: 'web'
          containerPort: 3000
        }
      }
    ]
  }
}
