// The AWS recipe pack. The action writes recipes.json next to this file before
// deploying it: backing services point at the AWS recipes in ./recipes,
// published to the repository's GHCR, and core primitives point at the same
// Kubernetes recipes as the Azure pack. loadJsonContent inlines the map at
// compile time, so the deployed template holds only literal values.

extension radius

@description('Recipe pack name.')
param packName string = 'aws-bicep'

resource pack 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: packName
  properties: {
    recipes: loadJsonContent('recipes.json')
  }
}
