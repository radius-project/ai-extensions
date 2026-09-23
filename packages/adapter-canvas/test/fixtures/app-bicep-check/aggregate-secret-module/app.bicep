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

module child './child.bicep' = {
  name: 'child'
  params: {
    application: app.id
    environment: environment
    outputName: 'url'
    secretName: redisCache.properties.secrets.name
  }
}
