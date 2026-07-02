extension radius

param environment string
param application string

@secure()
param redisPassword string = ''

// Container images
param mgmtApiImage string = 'ghcr.io/drasi-project/api:latest'
param kubernetesProviderImage string = 'ghcr.io/drasi-project/kubernetes-provider:latest'
param queryHostImage string = 'ghcr.io/drasi-project/query-host:latest'
param publishApiImage string = 'ghcr.io/drasi-project/publish-api:latest'
param viewSvcImage string = 'ghcr.io/drasi-project/view-svc:latest'

// ─── Infrastructure ────────────────────────────────────────────────────────────

resource redisCache 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'redis-cache'
  properties: {
    environment: environment
    application: application
  }
}

resource daprStateStore 'Radius.Dapr/stateStores@2025-08-01-preview' = {
  name: 'drasi-state-store'
  properties: {
    environment: environment
    application: application
  }
}

// ─── Control Plane ─────────────────────────────────────────────────────────────

resource mgmtApi 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'mgmt-api'
  properties: {
    environment: environment
    application: application
    container: {
      image: mgmtApiImage
      ports: {
        http: {
          containerPort: 8080
          protocol: 'TCP'
        }
      }
    }
    connections: {
      stateStore: {
        source: daprStateStore.id
      }
    }
  }
}

resource kubernetesProvider 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'kubernetes-provider'
  properties: {
    environment: environment
    application: application
    container: {
      image: kubernetesProviderImage
      ports: {
        http: {
          containerPort: 8080
          protocol: 'TCP'
        }
      }
    }
    connections: {
      mgmtApi: {
        source: mgmtApi.id
      }
      stateStore: {
        source: daprStateStore.id
      }
    }
  }
}

// ─── Query Container ───────────────────────────────────────────────────────────

resource queryHost 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'query-host'
  properties: {
    environment: environment
    application: application
    container: {
      image: queryHostImage
      ports: {
        http: {
          containerPort: 8080
          protocol: 'TCP'
        }
      }
    }
    connections: {
      redis: {
        source: redisCache.id
      }
      stateStore: {
        source: daprStateStore.id
      }
    }
  }
}

resource publishApi 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'publish-api'
  properties: {
    environment: environment
    application: application
    container: {
      image: publishApiImage
      ports: {
        http: {
          containerPort: 8080
          protocol: 'TCP'
        }
      }
    }
    connections: {
      redis: {
        source: redisCache.id
      }
      queryHost: {
        source: queryHost.id
      }
    }
  }
}

resource viewSvc 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'view-svc'
  properties: {
    environment: environment
    application: application
    container: {
      image: viewSvcImage
      ports: {
        http: {
          containerPort: 8080
          protocol: 'TCP'
        }
      }
    }
    connections: {
      redis: {
        source: redisCache.id
      }
      queryHost: {
        source: queryHost.id
      }
    }
  }
}

// ─── API Route (Ingress) ───────────────────────────────────────────────────────

resource apiRoute 'Radius.Compute/routes@2025-05-01-preview' = {
  name: 'api-route'
  properties: {
    environment: environment
    application: application
  }
}
