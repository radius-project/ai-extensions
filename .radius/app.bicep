extension radius

param environment string

resource aiExtensionsApp 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'ai-extensions'
  properties: {
    environment: environment
  }
}

resource aiExtensionsImage 'Radius.Compute/containerImages@2023-10-01-preview' = {
  name: 'ai-extensions-image'
  properties: {
    environment: environment
    application: aiExtensionsApp.id
    build: {
      source: 'git::https://github.com/radius-project/ai-extensions.git?ref=deployedgraph'
    }
  }
}

resource aiExtensionsContainer 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'ai-extensions'
  properties: {
    environment: environment
    application: aiExtensionsApp.id
    containers: {
      aiExtensions: {
        image: aiExtensionsImage.properties.imageReference
        ports: {
          web: {
            containerPort: 8080
          }
        }
      }
    }
  }
}