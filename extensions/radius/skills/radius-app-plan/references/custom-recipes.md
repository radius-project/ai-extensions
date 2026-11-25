# Recipes for custom resource types

The provider's Recipe pack has no Recipe for a custom type (`Radius.Resources/*`), so write one in `custom-recipe-pack.bicep` in the run directory. `plan.mjs` checks that each custom type has a Recipe with a fixed version. At deployment, the deploy workflow deploys this pack and adds it to the Environment.

## Choose the Recipe

1. **Use an Azure Verified Module (AVM) when one deploys the service exactly.** It needs no code and no publishing. Pin a version, and take its parameter and output names from that version:
   - First, look for the module path, such as `avm/res/service-bus/namespace`, in the provider's Recipe pack: `recipe-packs/<pack>/<pack>.bicep` in `radius-project/resource-types-contrib`. `plan.mjs` prints the pack name. A pack entry gives a tested version, parameter names, required settings, and output names. Change only the `{{context...}}` values and the output keys to your type's properties.
   - Otherwise, read `main.bicep` at the version's tag: `https://raw.githubusercontent.com/Azure/bicep-registry-modules/avm/res/<service>/<resource>/<x.y.z>/avm/res/<service>/<resource>/main.bicep`. Do not take names from the README or the main branch. A deployment fails when an output name does not exist in the pinned version.
2. **Write a Recipe only when no module fits.** See [Authored Recipe](#authored-recipe).

## The pack

```bicep
extension radius

resource customRecipes 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: 'custom-recipes'
  properties: {
    recipes: {
      'Radius.Resources/messageQueues': {
        kind: 'bicep'
        source: 'mcr.microsoft.com/bicep/avm/res/service-bus/namespace:0.16.2'
        parameters: {
          name: 'sbns-{{context.azure.resourceNameHash}}'
          skuObject: {
            name: 'Standard'
          }
          zoneRedundant: false
          disableLocalAuth: false
          queues: [
            {
              name: '{{context.resource.properties.queue}}'
            }
          ]
          enableTelemetry: false
        }
        outputs: {
          secrets: {
            connectionString: 'primaryConnectionString'
          }
        }
      }
    }
  }
}
```

- One pack holds the Recipes of all the custom types. Do not add a type that the provider's pack already has.
- A `parameters` value can read the resource's properties with `{{context.resource.properties.<name>}}`. Each `<name>` must be a property in `custom-types.yaml`.
- `outputs` maps each read-only property of the type to a module output, and each key under the type's `secrets` to a secure module output under `secrets`. Map every one, except the reserved `secrets.name`.
- Set the module parameters that the outputs depend on. For example, a connection string needs `disableLocalAuth: false`.

## Authored Recipe

Write `<type>-recipe.bicep` in the run directory, for example `messageQueues-recipe.bicep`:

```bicep
@description('Information about the resource that calls this Recipe. Radius sets it.')
param context object

// Deploy the service here. Read inputs from context.resource.properties.

output result object = {
  resources: [
    // The ID of each resource that the Recipe deploys.
  ]
  values: {
    // Each read-only property that is not a secret.
  }
  secrets: {
    // Each read-only property that is a secret.
  }
}
```

`values` and `secrets` use the type's property names, so its pack entry needs no `outputs`. The entry's `source` is `ghcr.io/<owner>/<repo>/recipes/<type>:<version>`, in lowercase.

The Recipe must be in that registry before the app deploys. A push changes a registry, so push only after the plan is published and the user agrees:

- If the `radius_publish_recipe` tool is available, use it with the file `.radius/<type>-recipe.bicep` and the target `br:<source>`.
- Otherwise, give the user this command. It needs `docker login ghcr.io` with a token that can write packages: `rad bicep publish --file .radius/<type>-recipe.bicep --target br:<source>`.

GHCR makes a new package private. Tell the user that the Environment can deploy the Recipe only when it can pull the package.
