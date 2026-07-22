# Custom resource types (generated on demand)

Use this when the application genuinely needs a backing service that has NO matching type in the predefined allow-list in [Resource Type Resolution](../SKILL.md#resource-type-resolution). Instead of forcing an ill-fitting predefined type or stopping, generate a custom resource type so the application can still be modeled and deployed.

Custom types are generated automatically as part of modeling. Do not ask the user whether to generate one; decide from the source's actual dependency. The initial scope is backing services that Radius can provision on **Azure**. If the required service is not provisionable on Azure, do NOT invent a type: report the unsupported dependency and stop for that resource.

Every generated artifact lives in `.radius/`, co-located with `app.bicep` and `bicepconfig.json`, and is written and staged with the same behavior as the rest of the model (see the [Response](../SKILL.md#response) section). Publishing an extension or recipe to a registry is an OCI push, not a git push.

## When to generate a custom type

Generate a custom type only when ALL of these hold:

- The application requires a backing service (for example a specific Azure service) to function.
- No type in the predefined allow-list fits that need. Do not stretch a predefined type to cover a different service.
- The service is provisionable on Azure.

Otherwise, do not generate a type. Report the gap to the user.

## Namespace and naming

- Custom types ALWAYS use the `Radius.Resources` namespace. Do not invent other namespaces and do not extend the predefined `Radius.*` namespaces.
- The type name is a lowerCamelCase plural noun for the resource, for example `Radius.Resources/azureServiceBusNamespaces`.
- Define only the properties the application actually reads or writes, plus the Radius base properties (`environment`, `application`) and the read-only outputs the application consumes (host, endpoint, port, connection string, managed-secret name). Mark sensitive inputs and outputs as sensitive. Do NOT invent properties the application does not use.

## Generation flow

### 1. Author the schema: `.radius/custom-types.yaml`

Write a resource-provider manifest that follows the `resource-types-contrib` schema conventions:

- Namespace `Radius.Resources`.
- One or more API versions.
- A `properties` object for the inputs the application sets and the read-only outputs it consumes.
- A `secrets` block only when the recipe emits managed secrets.

A single manifest may declare multiple custom types when the application needs more than one.

### 2. Publish the extension locally: `rad bicep publish-extension`

Compile the manifest into a local Bicep extension co-located with `app.bicep`:

```
rad bicep publish-extension --from-file .radius/custom-types.yaml --target .radius/custom-types.tgz
```

`--target` is a local file path here (not an OCI reference), so the extension ships alongside `app.bicep` and needs no registry. Confirm the exact flags with `rad bicep publish-extension --help` in the session before running.

### 3. Wire the extension into `.radius/bicepconfig.json`

Add an alias for the local extension tgz next to the existing `radius` alias, for example an entry that points `customTypes` at `./custom-types.tgz`. Keep the `radius` extension. In `app.bicep`, declare `extension customTypes` in addition to `extension radius`.

### 4. Provide a recipe

A custom type needs a recipe so the target Environment can provision it. Prefer an Azure Verified Module (AVM) when one matches exactly; otherwise author a recipe from scratch.

#### 4a. AVM path (preferred, exact match only)

Use an AVM module only when a maintained module matches the required Azure resource exactly and can be pinned to a specific version. Reference it the way the AVM recipe packs in `radius-project/resource-types-contrib/recipepack/azure/` do (for example `br/public:avm/res/<service>/<resource>:<version>`). Do NOT use a loose or approximate AVM match. If you are not confident the module is an exact fit, author a recipe instead.

#### 4b. Generated recipe path (fallback)

Author a Bicep recipe that provisions the Azure resource and returns exactly the read-only outputs the custom type declares (host, endpoint, keys, managed-secret name). Publish it to the user's GitHub Container Registry for the repository being modeled:

```
rad bicep publish --file <recipe>.bicep --target br:ghcr.io/<owner>/<repo>/<recipe>:<tag>
```

- `<owner>/<repo>` is the repository being modeled; the session's GitHub credentials are used for the push.
- Pin an immutable `<tag>`; do not publish `latest`.
- OCI publishing requires a prior registry login (`docker login ghcr.io` or equivalent) with push permission. If the push is not authorized, stop and report it rather than guessing credentials.

### 5. Author the recipe pack: `.radius/custom-recipe-pack.bicep`

Write a recipe pack that registers a recipe for the custom type, referencing either the AVM module (4a) or the published GHCR path (4b). Model it on the AVM recipe packs in `radius-project/resource-types-contrib/recipepack/azure/`. Do not fabricate a per-type singleton recipe inline in `app.bicep`; the recipe pack is how the type is resolved at deploy time.

### 6. Reference the type in `app.bicep`

Use the custom type as `Radius.Resources/<typeName>@<apiVersion>` and wire it to the workloads like any other backing service: connections, environment projection, and secret handling follow [connection-conventions.md](connection-conventions.md) and [secrets-handling.md](secrets-handling.md).

## Artifacts (all in `.radius/`)

- `custom-types.yaml` — the resource-type schema (namespace `Radius.Resources`).
- `custom-types.tgz` — the locally published Bicep extension.
- `bicepconfig.json` — updated to alias the local custom-types extension.
- `custom-recipe-pack.bicep` — recipe pack mapping the type to its recipe.
- The generated recipe file, when the AVM path is not used.

## Validation

- `app.bicep` compiles with both the `radius` extension and the local custom-types extension.
- `custom-types.yaml`, `custom-types.tgz`, and `custom-recipe-pack.bicep` exist in `.radius/`, plus the recipe file when one was generated.
- The recipe pack reference resolves: a valid pinned AVM module reference, or a GHCR path that was actually published.
- The recipe's outputs match the read-only outputs and managed-secret keys the custom type declares.
- The generated type is Azure-provisionable. A non-Azure need was reported, not invented.
