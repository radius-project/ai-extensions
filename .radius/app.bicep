extension radius

param environment string

resource app 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'ai-extensions'
  properties: {
    environment: environment
  }
}

