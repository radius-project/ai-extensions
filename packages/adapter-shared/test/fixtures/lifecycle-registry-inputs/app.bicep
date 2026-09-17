extension './custom-types.tgz' as radius

// module ignored 'br:registry.invalid/not-restored:1' = {}
var documentation = '''
extension 'br:registry.invalid/not-restored:1'
'''
var recipeName = 'cache'
var recipeReference = 'br:registry.invalid/recipes/${recipeName}:1'
output recipe string = recipeReference
output description string = documentation
output ordinaryData string = loadTextContent('./ordinary.bicep')

resource application 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'registry-data'
  properties: {
    environment: '/planes/radius/local/resourceGroups/default/providers/Applications.Core/environments/test'
  }
}

resource api 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'api'
  properties: {
    application: application.id
    environment: '/planes/radius/local/resourceGroups/default/providers/Applications.Core/environments/test'
    containers: {
      api: {
        image: 'example.invalid/api:fixture'
      }
    }
  }
}
