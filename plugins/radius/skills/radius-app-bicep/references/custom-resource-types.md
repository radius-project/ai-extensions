# Custom resource types (generated on demand)

Use this when the application genuinely needs a backing service that has NO matching type in the predefined allow-list in [Resource Type Resolution](../SKILL.md#resource-type-resolution). Instead of forcing an ill-fitting predefined type or stopping, generate a custom resource type so the application can still be modeled and deployed.

Custom types are generated automatically as part of modeling. Do not ask the user whether to generate one; decide from the source's actual dependency. The initial scope is backing services that Radius can provision on **Azure**. If the required service is not provisionable on Azure, do NOT invent a type: report the unsupported dependency and stop for that resource.

Every generated artifact lives in `.radius/`, co-located with `app.bicep` and `bicepconfig.json`, and is written and staged with the same behavior as the rest of the model (see the [Response](../SKILL.md#response) section). Publishing an extension or recipe to a registry is an OCI push, not a git push.

Author every artifact from the templates below: copy the skeleton and fill only the marked `<placeholders>`. The surrounding structure, resource types, API versions, and wiring keys are fixed and must not be changed or renamed.

## When to generate a custom type

Generate a custom type only when ALL of these hold:

- The application requires a backing service (for example a specific Azure service) to function.
- No type in the predefined allow-list fits that need. Do not stretch a predefined type to cover a different service.
- The service is provisionable on Azure.

Otherwise, do not generate a type. Report the gap to the user.

## Namespace and naming

- Custom types ALWAYS use the `Radius.Resources` namespace. Do not invent other namespaces and do not extend the predefined `Radius.*` namespaces.
- The type name is a lowerCamelCase plural noun for the resource, for example `Radius.Resources/azureServiceBusNamespaces`.
- Define only the properties the application actually reads or writes, plus the Radius base properties (`environment`, `application`) and the read-only outputs the application consumes (host, endpoint, port, connection string, managed-secret name). Do NOT invent properties the application does not use.

## Generation flow

### 1. Author the schema: `.radius/custom-types.yaml`

The manifest shape is fixed; only the type name and the `properties` vary. Model it on an existing type such as `Data/mySqlDatabases/mySqlDatabases.yaml` in `resource-types-contrib`:

```yaml
namespace: Radius.Resources
types:
  <typeNamePlural>:
    description: |
      <one-line description, plus a short app.bicep usage example>
    apiVersions:
      '2025-08-01-preview':
        schema:
          type: object
          properties:
            environment:
              type: string
              description: "(Required) The Radius Environment ID. Typically set by the rad CLI."
            application:
              type: string
              description: "(Optional) The Radius Application ID."
            # Developer inputs the application sets:
            <inputProperty>:
              type: string            # or integer / boolean
              description: "(Required|Optional) ..."
            <secretInput>:
              type: string
              x-radius-sensitive: true   # encrypted at rest, redacted on reads, decrypted only into the recipe
              description: "(Required) ..."
            # Read-only outputs the application consumes (populated by the recipe):
            host:
              type: string
              readOnly: true
              description: "Mapped from the recipe's output."
            port:
              type: integer
              readOnly: true
              description: "Mapped from the recipe's output."
          required: [environment, <required input properties>]
```

Rules:
- Base properties `environment` (required) and `application` (optional) are always present.
- Developer inputs are plain typed properties; use `enum: [...]` for a fixed value set.
- Mark every sensitive input or sensitive output `x-radius-sensitive: true`.
- Read-only outputs set `readOnly: true` and are populated by the recipe; do not list them in `required`.
- A single manifest may declare multiple types under `types:`.

### 2. Publish the extension locally: `rad bicep publish-extension`

Compile the manifest into a local Bicep extension co-located with `app.bicep`:

```
rad bicep publish-extension --from-file .radius/custom-types.yaml --target .radius/custom-types.tgz
```

`--target` is a local file path here (not an OCI reference), so the extension ships alongside `app.bicep` and needs no registry. Confirm the exact flags with `rad bicep publish-extension --help` in the session before running.

### 3. Wire the extension into `.radius/bicepconfig.json`

Add an alias for the local extension tgz next to the existing `radius` alias, for example an entry that points `customTypes` at `./custom-types.tgz`. Keep the `radius` extension. In `app.bicep`, declare `extension customTypes` in addition to `extension radius`.

### 4. Provide a recipe

A recipe is the module that actually provisions the resource; the recipe pack (step 5) points at it through a `source`. There are two ways to supply one. Prefer AVM.

#### 4a. AVM path (preferred, exact match only)

An Azure Verified Module needs NO authoring and NO publishing: reference the published module directly as the recipe pack entry's `source`, using its Microsoft Container Registry (MCR) path pinned to a specific version:

```
source: 'mcr.microsoft.com/bicep/avm/res/<service>/<resource>:<x.y.z>'
```

For example `mcr.microsoft.com/bicep/avm/res/db-for-my-sql/flexible-server:0.10.3`. Use an AVM module only when a maintained module matches the required Azure resource exactly and can be pinned to a version. Do NOT use a loose or approximate match; if you are not confident it is an exact fit, author a recipe instead (4b). The module's inputs and outputs are wired through the recipe pack entry's `parameters` and `outputs` maps (step 5).

#### 4b. Authored recipe (fallback): `.radius/<type>-recipe.bicep`

When no AVM module fits, author a Bicep recipe. A recipe takes a single `context` object and returns a `result` object with exactly three maps. Model it on an existing recipe such as `Data/mySqlDatabases/recipes/kubernetes/bicep/kubernetes-mysql.bicep`:

```bicep
@description('Information about what resource is calling this Recipe. Generated by Radius.')
param context object

// Read developer inputs from the calling resource:
var <input> = context.resource.properties.<inputProperty>

// ...provision the Azure resource(s) here. Declare whatever provider extension or
// AVM modules the provisioning needs; model the body on an existing recipe...

output result object = {
  // Radius resource IDs of everything this recipe provisioned:
  resources: [
    '<provisioned resource id>'
  ]
  // Non-secret read-only outputs, keyed by the type's property names:
  values: {
    host: <...>
    port: <...>
  }
  // Sensitive outputs, keyed by the type's sensitive property names:
  secrets: {
    connectionString: <...>
  }
}
```

Then publish it to the user's GitHub Container Registry for the repository being modeled and use that path as the recipe pack `source`:

```
rad bicep publish --file .radius/<type>-recipe.bicep --target br:ghcr.io/<owner>/<repo>/<recipe>:<tag>
```

- `<owner>/<repo>` is the repository being modeled; the session's GitHub credentials are used for the push.
- Pin an immutable `<tag>`; do not publish `latest`.
- OCI publishing requires a prior registry login (`docker login ghcr.io` or equivalent) with push permission. If the push is not authorized, stop and report it rather than guessing credentials.

### 5. Author the recipe pack: `.radius/custom-recipe-pack.bicep`

The recipe pack registers the recipe for the custom type. It is a `Radius.Core/recipePacks` resource whose `recipes` map is keyed by the full type name. Model it on `recipepack/azure/aks-recipepack.bicep` in `resource-types-contrib`:

```bicep
extension radius

resource pack 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: '<pack-name>'
  properties: {
    recipes: {
      'Radius.Resources/<typeNamePlural>': {
        kind: 'bicep'
        source: '<MCR AVM path from 4a, or ghcr path from 4b>'
        parameters: {
          // Map the module's inputs from the calling resource via {{context}} templating:
          name: '{{context.resource.name}}'
          <moduleParam>: '{{context.resource.properties.<inputProperty>}}'
        }
        outputs: {
          // Rename the module's outputs to the type's read-only property names:
          host: '<moduleOutputName>'
          secrets: {
            <sensitiveProperty>: '<moduleSecretOutputName>'
          }
        }
      }
    }
  }
}
```

Notes:
- `parameters` values use Radius `{{context.resource...}}` templating (not Bicep expressions); this is how developer inputs reach the module.
- `outputs` maps the recipe's outputs to the type's `readOnly` property names. Non-secret outputs are mapped at the top level of `outputs` (`<typeProperty>: '<moduleOutputName>'`), and sensitive outputs go under the nested `secrets` map. This recipe-pack mapping shape is deliberately different from an authored recipe's own return value in 4b, which is `output result object = { resources, values, secrets }`.
- An authored recipe (4b) already returns `values`/`secrets` keyed by the type's property names, so in the recipe pack its `outputs` mapping is usually the identity (and can be omitted); an AVM module (4a) needs a real mapping because its output names differ (for example `host: 'fqdn'`).
- Do NOT fabricate a per-type singleton recipe inline in `app.bicep`; the recipe pack is how the type is resolved at deploy time. Registering the pack on the target Environment is a deployment concern (see the radius-deploy flow); modeling only writes the pack file.

### 6. Reference the type in `app.bicep`

Use the custom type as `Radius.Resources/<typeNamePlural>@2025-08-01-preview` and wire it to the workloads like any other backing service: connections, environment projection, and secret handling follow [connection-conventions.md](connection-conventions.md) and [secrets-handling.md](secrets-handling.md).

## Artifacts (all in `.radius/`)

- `custom-types.yaml` — the resource-type schema (namespace `Radius.Resources`).
- `custom-types.tgz` — the locally published Bicep extension.
- `bicepconfig.json` — updated to alias the local custom-types extension.
- `custom-recipe-pack.bicep` — the `Radius.Core/recipePacks` resource mapping the type to its recipe.
- `<type>-recipe.bicep` — the authored recipe, only when the AVM path (4a) is not used.

## Validation

- `app.bicep` compiles with both the `radius` extension and the local custom-types extension.
- `custom-types.yaml`, `custom-types.tgz`, and `custom-recipe-pack.bicep` exist in `.radius/`, plus `<type>-recipe.bicep` when one was authored.
- The recipe pack `source` resolves: a pinned MCR AVM path (4a), or a GHCR path that was actually published (4b).
- The recipe pack `parameters` cover the module's required inputs (via `{{context}}`), and `outputs` map every `readOnly` property of the type (sensitive ones under `secrets`).
- An authored recipe returns `output result object = { resources, values, secrets }`, with `values` and `secrets` keyed by the type's property names.
- The generated type is Azure-provisionable. A non-Azure need was reported, not invented.
