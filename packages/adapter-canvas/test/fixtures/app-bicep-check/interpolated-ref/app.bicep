extension radius

param gitRef string = 'eb33f12'

resource containerImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'test-image'
  location: 'global'
  properties: {
    application: 'test-app'
    environment: 'test'
    tag: 'latest'
    build: {
      source: 'git::https://github.com/example/app.git?ref=${gitRef}'
    }
  }
}
