extension radius

resource cache 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'cache'
  properties: {
    application: 'test-app'
    environment: 'test'
    codeReference: 'src/cache.ts'
  }
}

resource web 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'web'
  properties: {
    application: 'test-app'
    environment: 'test'
    codeReference: 'src/web.ts'
    containers: {
      web: {
        image: 'example/web:latest'
      }
    }
    connections: {
      cache: {
        source: cache.properties.secrets.name
      }
    }
  }
}
