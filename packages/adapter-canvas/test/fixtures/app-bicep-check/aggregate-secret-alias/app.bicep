extension radius

param environment string

resource app 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'test-app'
  properties: {
    environment: environment
  }
}

resource redisCache 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'test-cache'
  properties: {
    environment: environment
    application: app.id
  }
}

resource web 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'web'
  properties: {
    environment: environment
    application: app.id
    codeReference: 'src/web.ts#L1'
    containers: {
      web: {
        image: 'example.invalid/web:latest'
        env: {
          CACHE_URL_HELPER: {
            valueFrom: {
              secretKeyRef: {
                secretName: redisCache.properties.secrets.name
                key: 'url'
              }
            }
          }
          REDIS_ADDR: {
            value: '$(CACHE_URL_HELPER)'
          }
          REDIS_HOST: {
            valueFrom: {
              secretKeyRef: {
                secretName: redisCache.properties.secrets.name
                key: 'url'
              }
            }
          }
        }
      }
    }
  }
}
