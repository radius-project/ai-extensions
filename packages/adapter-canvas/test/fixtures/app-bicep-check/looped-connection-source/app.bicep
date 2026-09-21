extension radius

param idx int = 1

resource caches 'Radius.Data/redisCaches@2025-08-01-preview' = [for i in range(0, 2): {
  name: 'cache-${i}'
  properties: {
    application: 'test-app'
    environment: 'test'
    codeReference: 'src/cache.ts'
  }
}]

resource literalIndex 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'literal-index'
  properties: {
    application: 'test-app'
    environment: 'test'
    codeReference: 'src/literal-index.ts'
    containers: {
      web: {
        image: 'example/web:latest'
      }
    }
    connections: {
      cache: {
        source: caches[0].properties.secrets.name
      }
    }
  }
}

resource parameterIndex 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'parameter-index'
  properties: {
    application: 'test-app'
    environment: 'test'
    codeReference: 'src/parameter-index.ts'
    containers: {
      web: {
        image: 'example/web:latest'
      }
    }
    connections: {
      cache: {
        source: caches[idx].properties.secrets.name
      }
    }
  }
}
