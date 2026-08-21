---
name: radius-app-bicep
description: >
  Analyze a source code repository and generate a Radius application
  definition (.radius/app.bicep) that models the app's compute and backing
  services as Radius resource types. Use for: creating, generating, or
  updating a Radius application definition or app.bicep; modeling or
  onboarding an app or repo to Radius; determining which Radius resource
  types an app needs; repairing or fixing an app.bicep that failed to
  deploy because of a modeling or schema error. Do not use for: authoring
  generic or Azure Bicep unrelated to Radius, or deploying or running an
  already-modeled app. Resolves the configured Radius schemas and the
  application's runtime contract to produce validated, deployable output.
---

# Radius Application Modeling

Use this skill to generate a Radius application definition (`app.bicep`) from a source code repository.

## Prerequisites

This skill currently supports only repositories that already contain a Dockerfile for building the application image, so a repository without one cannot be modeled.

The extension normally screens this out before handing over the skill, so re-running that check is not your job. If you do find the application has no Dockerfile, stop: generate nothing, write nothing, and report this to the user verbatim.

A Dockerfile means a file named `Dockerfile`, `Dockerfile.<suffix>`, or `<prefix>.Dockerfile`, matched case-insensitively on the file name, at the repository root or in a service subdirectory. Ignore any that sits inside a vendored, generated, or tooling directory — `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `venv`, `.venv`, or any other dot-directory apart from `.radius` and `.github`. A `.devcontainer` image builds the development environment, not the application, so it does not count.

> I could not find a Dockerfile in this repository. I can only create application definitions for containerized applications. Add a Dockerfile first, then I can create an application definition.

### Identifying the application

A repository with several Dockerfiles is normally still one application. A microservices repository builds many images, and this skill models a microservices repository into a single `Radius.Core/applications` named after the repository, with the services wired to each other through the addressing rules in [connection-conventions.md](references/connection-conventions.md). A Dockerfile count is never decisive on its own, and it is never by itself a reason to put a question to the user. Nor does a Dockerfile prove there is a service to model: it may build a CI image, a migration or tooling image, an unused example, or an alternative to another one. A root workspace manifest such as `pnpm-workspace.yaml` or `go.work` describes how the repository is organized, not that its projects form one application — independent applications use those tools too, so weigh it against the source rather than concluding from it.

Establish from the source which directories hold application services that share a runtime and deploy together, and model those as one application. Ask the user only when, after reading the source, you cannot identify an application at all. That happens in two cases:

- the repository holds more than one **independent** application, which a single definition cannot represent, or
- nothing in the repository is an application — for example the Dockerfiles build only tooling or CI images.

In either case, ask exactly:

> I looked through the repository but could not identify an application or application resources. Which directory contains your application source code and Dockerfile?

Then stop, and write nothing: no `.radius/app.bicep`, no `.radius/bicepconfig.json`, no origin record, no branch, no commit. Do not guess a directory on the user's behalf or model one candidate to "make progress" — a directory you chose yourself is not an answer to the question you just asked. The user replies with a directory and asks for analysis again, which scopes the next run to it; the skill already supports a subdirectory through the `build.source` rule.

## Response

When asked to model a repository:

1. Generate the application definition into a staging directory and publish it only once the whole run is complete (see [Staged runs](#staged-runs)). Never write `.radius/app.bicep`, `.radius/bicepconfig.json`, the origin record, or a custom-type artifact directly into `.radius/`, and never `git add` anything yourself: the promote script publishes and stages the run. Do NOT push, and do NOT open a pull request: modeling only writes and stages the files locally. The application graph renders from the on-disk working tree, so no push is needed to preview it, and pushing to a remote is a deployment concern handled later, not part of modeling.
2. In your chat reply, give a one-line intro naming the app (e.g. "I'll create an application definition for `todo-list-app`."), then a short, natural summary of the resources you identified, a brief list such as "Container: `todo-list-app`", "MySQL database", "Secret for DB credentials". A sentence or two of reasoning is fine; don't dump raw source analysis or the full file contents. Describe only what you actually did (that the run published and staged the model files in the working tree); do not claim the application graph or canvas is rendering, since you cannot observe that. If a graph view is opened and shows an error or empty state, report that honestly instead of asserting success. Keep the reply about the user's application and its resources; do not name internal skill or reference files (for example, reference examples the skill consulted).

## Radius CLI execution boundary

Never invoke `rad` or `rad.exe` directly from PowerShell, a shell, a subprocess, or a delegated agent. Compile the generated application definition with `node "<loaded-skill-base>/scripts/validate-bicep.mjs" .radius/app.bicep`; the checker uses only the extension-managed Bicep and fails on every compiler warning or error. Graph validation must go through the Radius canvas and its tools: open `canvasId: "radius"` with `instanceId: "radius-panel"`, pass the current session repository as `repo` in `owner/repo` form, and use the current Copilot worktree branch. The extension honors an existing `RADIUS_RAD_BINARY`; otherwise it runs its managed binary from `%USERPROFILE%\.radius\ai-extensions\bin\rad.exe` on Windows or `$HOME/.radius/ai-extensions/bin/rad` on macOS/Linux, downloading it when absent and attempting a best-effort upgrade when older than the latest release (offline/API failures keep the installed binary; set `RADIUS_RAD_SKIP_VERSION_CHECK` to skip the version check). It does not resolve `rad` from `PATH` or `.rad/bin`. Diagnose graph failures only from the Radius extension log; never reproduce them with a direct CLI command or through another agent.

## Workflow

1. Start the run with `node "<loaded-skill-base>/scripts/promote-app-model.mjs" --begin`, which prints the staging directory to write everything into (see [Staged runs](#staged-runs)). Then select one runnable deployment profile. Treat explicit user, scenario, and target-repository deployment requirements for Radius types, resource-name parameters, workload roles/count, native configuration keys, secret bindings, provider profile, protocol values, and connection names as acceptance criteria. Verify that the pinned source supports that profile; do not silently replace it with an easier default or optional backend.
2. Build an internal requirement ledger that maps every acceptance criterion and planned resource property reference to source evidence, an exact Radius schema/recipe field, and the workload setting that consumes it. Use it for reasoning and validation; do not print it or add it as Bicep comments. Follow [runtime-contract.md](references/runtime-contract.md).
3. Inventory every executable workload and backing service in the selected profile from manifests, Dockerfiles, compose/Helm files, entrypoints, source configuration reads, client initialization, and referenced config files. Treat web, worker, producer, consumer, migration, scheduler, and sidecar roles separately. Model a backing service only when source evidence proves it is mandatory for the selected startup/configuration path; a repo-wide optional dependency, extra, adapter, test, or example does not become a resource.
4. Extract each workload's runtime contract: image/build context and target platform, entrypoint and arguments, listener and ports, required environment/configuration including parser coercion and unset behavior, secrets, writable storage, dependencies, wire protocols, TLS, authentication/bootstrap setup, and feature-critical configuration. Inspect CLI flags and structured fields as well as environment variables.
5. Map every selected backing service to a Radius type with [component-catalog.md](references/component-catalog.md), using [architecture-patterns.md](references/architecture-patterns.md) only as context. Report unsupported essential components instead of substituting unrelated types.
6. First create or update the run's `bicepconfig.json` inside the staging directory (see [bicepconfig.json](#bicepconfigjson)), using any `bicepconfig.json` currently applicable to `.radius/app.bicep` as input. Resolve every emitted type and planned property read/write against the exact target Environment schema and Recipe contract, then reconcile that contract with the extension declared by `.radius/bicepconfig.json`. For every generated output, inspect the exact target Recipe or matching immutable provider recipe-pack source and record the verbatim mapping; schema descriptions and property names are not Recipe evidence. Also prove each managed-secret name/key, every omitted optional Recipe input, and Recipe availability for every emitted extensible type in the target Environment. The exact target schema and Recipe outrank stale mutable extension metadata. Refresh or pin a verified compatible extension when possible; otherwise fail closed before generation rather than deleting required wiring to fit the stale artifact.
7. Build the application's own workloads from the repository Dockerfile via `Radius.Compute/containerImages`; this is the default path, and a repository without a Dockerfile is unsupported (see [Prerequisites](#prerequisites)). Require a complete, practical build context and pin `build.source` to the exact modeled checkout or an explicit immutable release tag. When the ref is a commit, use its full 40-character SHA in `?ref=`; never use an abbreviated SHA. The image `tag` may remain abbreviated because it is not a Git ref. Resolve the exact `containerImages` Recipe: verify omitted optional inputs, set a Docker-valid immutable `tag` only when required by that contract, validate target-compatible `build.platforms`, and preserve required Git metadata with schema-supported build arguments. Use a pinned published image only for a genuinely third-party/backing container, never for the application's own code. Map every runtime value using [connection-conventions.md](references/connection-conventions.md), [secrets-handling.md](references/secrets-handling.md), and [bicep-structure-rules.md](references/bicep-structure-rules.md).
8. Generate the Bicep into `<staging-dir>/app.bicep` using [naming-conventions.md](references/naming-conventions.md), then run `node "<loaded-skill-base>/scripts/validate-bicep.mjs" <staging-dir>/app.bicep`. Repair every compiler error and warning until the checker exits successfully and prints no warnings. Never make compilation pass by deleting a required backend activation, native configuration value, secret binding, or dependency edge.
9. Perform the [validation checklist](#validation-checklist) and close every item in the requirement ledger. Compilation or process startup alone is not success.
10. Only after the checker exits successfully, write the [origin record](#origin-record-apporiginjson) into the staging directory.
11. Publish the run with the promote script, which is the last step of every modeling run and the only thing that writes into `.radius/` (see [Staged runs](#staged-runs)).

## Deployment Profile and Acceptance Contract

- **Explicit profile wins:** If the request names a supported Radius type, provider profile, workload role, native key, protocol value, secret binding, or relationship, model it exactly when the pinned source supports it. A source default or another valid deployment profile does not satisfy that request.
- **Source compatibility is still mandatory:** Resolve behavior from the requested commit/tag, not a different release or the current default branch. If an acceptance criterion conflicts with that source revision, stop and report the conflict instead of inventing compatibility.
- **No implicit omissions:** Each required typed resource must be emitted and wired to a consumer. Each required workload role must have a runnable process and complete config. Each required native key/value must appear in the exact source-supported location and format.
- **No decorative wiring:** Environment variables, connections, and resources must be consumed by the selected feature path. Merely declaring a dependency or starting a process does not prove the requested database, model, storage, or messaging path works.
- **Mandatory dependencies only:** Model only services required by the selected runnable path. Imports, package extras, adapters, examples, tests, or alternate configurations elsewhere in the repository do not prove that a backing service is required.
- **Infer only when unspecified:** Without an explicit profile, prefer a complete, documented manifest/configuration that exercises the application's primary feature. If multiple materially different profiles remain valid, ask the user rather than choosing an optional backend arbitrarily.
- **Fail closed on verified incompatibility:** Fully implement every clearly supported criterion. Stop after evidence proves the pinned source or exact schema/Recipe cannot satisfy a requirement; do not return a partial definition as deployable, leave unresolved runtime caveats, or delete feature-critical wiring to obtain a clean compile.

### Repairing an existing app.bicep

When a deploy fails because of a modeling or schema error in an existing `.radius/app.bicep` (unknown type or API version, unknown or missing property, invalid reference between resources, wrong credential shape, or a Bicep parse or compile error), repair that model rather than regenerating it from scratch. A repair is still a run: start it with `--begin`, copy the current `.radius/app.bicep` and `.radius/bicepconfig.json` into the staging directory, edit the staged copies, and publish with the promote script (see [Staged runs](#staged-runs)). Editing `.radius/app.bicep` in place would leave a half-repaired model behind if the repair failed partway. This assumes the deploy error and any relevant logs have been provided (by the `radius-deploy` skill or the user); if they haven't, ask for them before attempting a fix.

1. Confirm whether the failure comes from the application model. If it is an infrastructure, recipe, Environment, or cluster failure (for example, recipe download/execution or provider provisioning), stop and hand it back to the `radius-deploy` skill; editing `app.bicep` will not fix it. A pod that never becomes ready is not enough to classify the failure: inspect events and logs to distinguish infrastructure/connectivity failures from incorrect workload configuration, listeners, credentials, or dependency wiring in `app.bicep`.
2. Locate the implicated resource, property, or workload setting, then re-resolve the exact configured type schema and recipe output contract (see [Resource Type Resolution](#resource-type-resolution)) to confirm property names, required fields, credential shape, API version, and resource reference paths.
3. Apply the fix using the same runtime-contract, naming, structure, and secrets rules as authoring so the repaired resource stays consistent with the rest of the file. While you are in the file, also correct any other clear schema or rule violations you notice, and report each collateral fix you made. Never clear a compile error by deleting a required binding, native value, backend activation, or dependency edge; report version drift when the configured schema cannot represent the runnable profile.
4. Re-run the [validation checklist](#validation-checklist) against the whole file; a change in one resource can ripple to connections or references elsewhere.
5. Return the corrected file with a short note of what changed and why, then hand it back to `radius-deploy` to redeploy. Write a new [origin record](#origin-record-apporiginjson) into the staging directory after the checker passes, so the repaired bytes are the ones recorded, then publish the run. If the same error recurs, treat the previous fix as insufficient and try a different fix rather than reapplying the one that just failed. If a couple of different fixes still do not resolve it, or no different fix can be found, report that to `radius-deploy` so it can stop the retry loop and surface the problem to the user.

## Staged runs

A modeling run that stops partway must leave the repository exactly as it was. So a run never writes into `.radius/` directly: it writes everything into a staging directory inside `.radius/`, and a script moves that output into place only once the run is complete and its application model has compiled.

**Start every run** — generation or repair — with:

```text
node "<loaded-skill-base>/scripts/promote-app-model.mjs" --begin
```

It removes any staging directory a previous interrupted run left behind, records the fingerprints of the files in `.radius/` this run may replace, and prints the staging directory. It writes nothing outside that directory, which is what lets a failed run leave `.radius/` byte-identical without having to undo anything. Write every file the run produces into that directory and nowhere else: `app.bicep`, `bicepconfig.json`, the origin record, and any custom-type artifacts (`custom-types.yaml`, `custom-types.tgz`, `custom-recipe-pack.bicep`, and `<type>-recipe.bicep`) (pass the directory to `radius_publish_custom_type_extension` as `stagingDir` so its published package lands there too). Run the Bicep checker against the staged `app.bicep`, so what is verified is exactly what will be published.

**Finish every run** with:

```text
node "<loaded-skill-base>/scripts/promote-app-model.mjs" --staging "<staging-dir>"
```

It refuses unless the staging directory holds a complete set of files, the origin record describes the staged `app.bicep`, and `.radius/app.bicep` is still the file the run started from. On success it moves the files into `.radius/`, deletes the staging directory, adds `.staging-*/` to `.radius/.gitignore`, and stages the published files with `git add` — which is why you never run `git add` yourself. On any refusal it discards the staged run and writes nothing.

It exits `0` when the run was published and staged, `1` when it refused and nothing was written, and `2` when the files were published but `git add` failed. On `2` the model IS on disk: report that it was written but not staged, and do not re-run the run.

Rules:

- Never write, copy, or move a generated file into `.radius/` yourself, and never hand-write the files the script publishes. A file you place there directly is exactly the partial write staging exists to prevent.
- Never re-run modeling "to finish the job" after a refusal without starting a new run with `--begin`. A retry starts from a clean slate.
- Only the files listed above are published. Anything else you leave in the staging directory is discarded with it, so never keep notes, scratch output, or intermediate files there and expect them to survive.
- If the script refuses because a file in `.radius/` changed during the run, the user edited it while you were working. Report that their version is intact, that nothing was published, and offer to re-run modeling. Do not attempt to merge, restore, or overwrite their file.

### When a step fails

When any step of the run fails, discard the run with:

```text
node "<loaded-skill-base>/scripts/promote-app-model.mjs" --abort --staging "<staging-dir>"
```

Use this rather than deleting the directory yourself, so a run is always discarded the same way. Then report the failure. Say plainly that **nothing was written**: `.radius/` is exactly as it was, nothing was staged in git, and any application model the user already had is intact. Never keep the staging directory for inspection.

Do not retry on your own. Say which kind of failure it looks like and let the user decide:

- **Looks transient** — a network error fetching a schema, a registry timeout, an interrupted download. Offer to run modeling again.
- **Looks permanent** — no Dockerfile, a required backing service with no Radius type that cannot be provisioned on Azure, no source that resolves to a runnable profile. Report it and do not offer a retry, because the same run would fail the same way.

## Origin record (`app.origin.json`)

Every generation records what the model was produced from, in `.radius/app.origin.json` beside `app.bicep`. The Radius canvas reads this record before rendering a graph: without it, the only question the canvas can ask is "does `app.bicep` exist?", so a model whose source has since moved on is rendered as though it were current. Write it with the bundled script, never by hand, so the format stays exactly what the canvas parses:

```text
node "<loaded-skill-base>/scripts/write-app-origin.mjs" <staging-dir>/app.bicep --skill-version "<loaded-skill-version>"
```

Rules:

- Write the record on **every** generation and every repair, as the last step, and only after `validate-bicep.mjs` exits successfully with no warnings. The record holds a hash of the exact bytes that compiled, which is what lets the canvas treat the model as known-valid instead of recompiling it on every graph open. Recording a file that has not passed the checker asserts a validity that was never proven.
- `--skill-version` is optional. Pass it when the prompt gave you a real version; if the value you were given is still the literal `<loaded-skill-version>`, omit the flag entirely rather than passing the placeholder through. The script reads the version from the plugin manifest itself, and a placeholder recorded in the origin record would make every later freshness check report the model as generated by an unknown generator.
- Write it into the staging directory beside the `app.bicep` it describes, and let the promote script publish and stage the pair (see [Staged runs](#staged-runs)). A model committed without its origin record reads as unverified on every other checkout of that branch, and a run whose record is missing or does not match its model is refused rather than published.
- Never edit `app.bicep` after recording it. If you change one byte, re-run the checker and re-run the origin script.
- The script fails closed when it cannot resolve the source commit or read the model. Do not work around it by writing the JSON yourself; fix the underlying problem and re-run it.

## Refreshing a stale model

The canvas asks for a refresh when an existing model is stale: its branch has moved past the recorded commit, a different generator version is installed, or there is no usable origin record at all. Regenerate from current source and write a new origin record, with one guard:

- **When the model is reported as manually edited, ask the user before overwriting it.** That state means the model needs regenerating and was also changed after it was generated: hand-tuned properties, a custom type, or a recipe pack reference someone added deliberately. Say what would be lost and regenerate only after the user agrees. Offer to repair the specific problem in place (see [Repairing an existing app.bicep](#repairing-an-existing-appbicep)) as the alternative, since that preserves their edits.
- **When the model has no origin record, regenerate it and write one. Do not ask.** Nothing about a missing record shows the model was edited, so there is no decision to put to the user. Regenerate from current source and record it as you would for any other generation.
- A model that is stale only because the source or generator moved on carries no unproven content, so refresh it without asking.
- A manual edit is never reported on its own. Do not go looking for one, and do not raise it when the canvas has not, since an edit to a model that is otherwise current is the user's to keep.
- Refresh only the current workspace branch, where writing the working tree is enough. A model on a **different** branch cannot be refreshed by modeling: report the staleness to the user and let them decide, rather than committing or pushing a regenerated model to that branch.

## Deterministic Naming Rules

These rules eliminate ambiguity. Apply them exactly.

Explicit profile-required resource, relationship, parameter, and app-native configuration names take precedence over the default naming rules below. Never normalize a name the selected runtime contract requires verbatim. Preserve a resource-name parameter when deployment documentation, the target Environment Recipe, or verification couples it to a provider resource name.

### Symbolic names (left side of `=` in Bicep)

| Resource                          | Symbolic name                                                                                                                                                                    |
|-----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Application                       | `<shortName>App` where `<shortName>` is the app name without hyphens, camelCase (e.g., `todo-list-app` → `todoApp`)                                                              |
| Container                         | `<serviceName>Container` — service short name camelCase; single-container apps use `<shortName>Container` (e.g., `todoContainer`)                                                |
| Container image                   | `<serviceName>Image` (e.g., `todoImage`)                                                                                                                                         |
| Data store (database/cache/queue) | `<engine>` + role suffix, camelCase: `mysqlDb`, `postgresDb`, `neo4jDb`, `redisCache`. Multiple of the same engine: prefix with the source store name (e.g., `ordersPostgresDb`) |
| Data store secret                 | `<engine>Secret` when the type's schema requires `secretName`; app secrets use `appSecrets`                                                                                      |
| Route                             | `<serviceName>Route` (e.g., `todoRoute`)                                                                                                                                         |

### Resource `name` properties (string values in Bicep)

| Resource          | Name value                                                                                                                             |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| Application       | Repository name in kebab-case (e.g., `'todo-list-app'`)                                                                                |
| Container         | Service name in kebab-case; single-container apps use the app name (e.g., `'todo-list-app'`)                                           |
| Container image   | `'<service-name>-image'` (e.g., `'todo-list-app-image'`)                                                                               |
| Data store        | Engine short name in kebab-case (`'mysql'`, `'postgres'`, `'neo4j'`, `'redis'`); multiple of the same engine use the source store name |
| Data store secret | `'<engine>-secret'` (when the schema requires `secretName`); app secrets `'app-secrets'`                                               |

### Connection keys

| Connection | Key                                                                                                                                        |
|------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| Data store | Engine + role, lowercase: `mysqldb`, `postgresdb`, `neo4jdb`, `rediscache`. Multiple of the same engine: prefix with the source store name |

### Other fixed values

| Field                              | Value                                                                                                                                                                                                                                                                                     |
|------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Data store admin username          | The administrator username you author for the provisioned database. Set it wherever the schema puts credentials — `username` on the resource, or `USERNAME` in the secret when the schema uses `secretName`. Use a simple admin name (e.g., `myadmin`); it is NOT derived from the source |
| Data store `database` name         | Derived from source (e.g., `MYSQL_DATABASE`/`POSTGRES_DB`, or the database segment of a connection string)                                                                                                                                                                                |
| Data store `version`               | Derived from source (e.g., the image tag `mysql:8.0` → `'8.0'`)                                                                                                                                                                                                                           |
| Container key in `containers` map  | Service short name camelCase (single-container: derived from app, e.g., `todo`)                                                                                                                                                                                                           |
| Port key in `ports` map            | `web` for the primary HTTP port; additional ports derive from protocol/use (`http`, `grpc`)                                                                                                                                                                                               |
| `build.source` for containerImages | Repo git URL pinned to the modeled checkout: `git::https://github.com/<org>/<repo>.git//<subdir>?ref=<checked-out-sha-or-explicit-immutable-tag>` (`//<subdir>` only when the Dockerfile isn't at the repo root)                                                                          |

### Deterministic output

Two runs of this skill over the same source, with the same generator version and the same schema/recipe contract, must produce byte-identical `.radius/app.bicep`. A regeneration that reshuffles equivalent content produces a large diff that says nothing, which makes real changes hard to review and adds noise to the repository's history. Apply:

- **Canonical declaration order.** `extension` lines first, then `param` declarations, then the `Radius.Core/applications` resource, then the remaining resources. Never order resources by discovery order, file-walk order, or the order a tool happened to return them.
- **Canonical ordering within each group.** Order `param` declarations, and resources of the same type, by their `name` value using plain ASCII ordering. Resource types themselves follow the order they appear in the allow-list table under [Resource Type Resolution](#resource-type-resolution). The one exception is a resource that must be declared after something it references.
- **Canonical ordering inside a resource.** `name` first, then `properties`. Within a map whose keys you choose (`env`, `ports`, `containers`, `connections`), order keys ASCII-ascending.
- **Stable values.** Nothing derived from the current time, a random value, a temporary path, an absolute path on this machine, or an environment variable of the machine running the skill may appear in the output. Values pinned to a revision use the modeled commit or an explicit immutable tag, which are properties of the source rather than of the run.
- **Normalized formatting.** Two-space indentation, single quotes for strings, one trailing newline, no trailing whitespace, and no blank line runs longer than one.

## Source-code reference metadata (`codeReference`)

Each resource (except `applications`) may carry an optional `codeReference` in its `properties` — a repo-relative path, optionally with a `#L<line>` anchor, pointing at where that resource is defined/initialized in the source. It is metadata only: `rad app graph` preserves it and the application-graph canvas turns it into a clickable deep link on the node. It does not affect deployment.

Populate it for every non-application resource you can locate, because the developer is not hand-adding it:

```bicep
resource database 'Radius.Data/mySqlDatabases@2025-08-01-preview' = {
  name: 'mysql'
  properties: {
    environment: environment
    application: application
    codeReference: 'src/db/mysql.js#L14'
    // ...schema-verified properties...
  }
}
```

To find the definition/initialization site for each resource, follow the discovery methodology in the app-graph skill's [source-code-references.md](../radius-app-graph/references/source-code-references.md) (category detection, filename/init patterns, skip rules, line pinpointing, output format). Point at the real initialization site — for a container, the service `Dockerfile` or entrypoint. Leave it out rather than link a test/mock or a file you cannot confirm. On built-in types `codeReference` is a framework-owned optional base property (defined in Radius's base resource schema and inherited by every built-in type), so it is schema-valid but exempt from the per-type ledger's schema-proof requirement; omit it if in doubt.

Custom types do not get it for free. A `Radius.Resources/*` type generated from `custom-types.yaml` compiles to a closed object built from that manifest, so it accepts `codeReference` only when its own schema declares the property — which [custom-resource-types.md](references/custom-resource-types.md) now requires for every generated type. Before authoring `codeReference` on a custom-type resource, confirm the type's schema declares it (add it and republish `custom-types.tgz` if it does not); otherwise omit it, or compilation fails with `BCP037: The property "codeReference" is not allowed`.

Author it as a **repo-relative path** (`path` or `path#L<line>`), not a full URL — the graph canvas resolves it against the graph's repo and branch (`<repo-url>/blob/<branch>/<path>#L<line>`). Radius's base schema documents `codeReference` as a fully-qualified source URI, but a full URL breaks that canvas deep-link path, so author repo-relative here.

## Resource Type Resolution

### Built-in types (from `radius-project/radius`)

| Need                         | Resource Type              | API Version          |
|------------------------------|----------------------------|----------------------|
| Preview application grouping | `Radius.Core/applications` | `2025-08-01-preview` |

`Radius.Core/applications` is the preview application model used by this skill and is built into compatible `radius` extensions; there is no schema file for it in `resource-types-contrib`. This preview model does not imply that `Applications.Core/applications` has been removed from every Radius release. Verify that the target release supports `Radius.Core/applications`; if it does not, report the release-contract mismatch rather than silently changing application models.

### Extensible types (from `radius-project/resource-types-contrib`)

First inspect the target repository's `bicepconfig.json`: the `radius` extension alias is the local compile-time contract. Resolve schemas from the `resource-types-contrib` revision that produced that artifact and from the target Environment's registered type definition and Recipe. A mutable artifact such as `radius:latest`, a Recipe tagged `latest`, or a branch ref can drift. The exact target Environment schema and Recipe are authoritative for deployment; a clean compile against conflicting mutable metadata is not validation and must not override that contract.

Use the `radius-project/resource-types-contrib` repository for discovery. Do NOT hardcode a file path — derive it from the resource type name using the repo convention:

- Category = the segment after `Radius.` in the namespace (`Radius.Compute` → `Compute`, `Radius.Data` → `Data`, `Radius.Messaging` → `Messaging`, `Radius.AI` → `AI`, `Radius.Storage` → `Storage`, `Radius.Security` → `Security`)
- Schema path = `<Category>/<typeName>/<typeName>.yaml` (e.g., `Radius.Data/mySqlDatabases` → `Data/mySqlDatabases/mySqlDatabases.yaml`)

Read the matching schema file for property names, types, sensitivity, read-only outputs, and API versions. Inspect the exact Recipe to verify output mappings, managed-secret keys, omitted-input behavior, and registration in the target Environment. The configured extension and deployed contract must agree. Resolve a compatible immutable extension or stop and report the mismatch; never guess a path, remove required wiring, or substitute generic connection projection.

The following is the allow-list of predefined types this skill emits when one fits the need:

| Need                                     | Resource Type                      |
|------------------------------------------|------------------------------------|
| Container images (build from Dockerfile) | `Radius.Compute/containerImages`   |
| Containers                               | `Radius.Compute/containers`        |
| MySQL                                    | `Radius.Data/mySqlDatabases`       |
| PostgreSQL                               | `Radius.Data/postgreSqlDatabases`  |
| Neo4j                                    | `Radius.Data/neo4jDatabases`       |
| MongoDB                                  | `Radius.Data/mongoDatabases`       |
| Redis (cache)                            | `Radius.Data/redisCaches`          |
| SQL Server                               | `Radius.Data/sqlServerDatabases`   |
| Kafka (event streaming)                  | `Radius.Messaging/kafka`           |
| RabbitMQ (message queue)                 | `Radius.Messaging/rabbitMQ`        |
| AI model endpoint                        | `Radius.AI/models`                 |
| AI search                                | `Radius.AI/search`                 |
| Object storage                           | `Radius.Storage/objectStorage`     |
| Persistent storage                       | `Radius.Compute/persistentVolumes` |
| External ingress                         | `Radius.Compute/routes`            |
| Secrets                                  | `Radius.Security/secrets`          |

Do NOT invent properties on these types, and do NOT substitute one predefined type for another. When a backing service the application genuinely needs has NO matching type above, do not stop and do not force an ill-fitting type: generate a custom resource type under the `Radius.Resources` namespace, following [custom-resource-types.md](references/custom-resource-types.md), which is authoritative for the schema, extension, recipe, and recipe-pack flow (Azure scope for now).

## Extension

Declare `extension radius`. It provides every predefined Radius type (`Radius.Core/*`, `Radius.Compute/*`, `Radius.Data/*`, `Radius.Messaging/*`, `Radius.AI/*`, `Radius.Storage/*`, `Radius.Security/*`). Do NOT declare per-namespace or per-type extensions (`radiusCompute`, `containers`, `kafka`, etc.). When the application uses a generated custom type (see [custom-resource-types.md](references/custom-resource-types.md)), also declare the local custom-types extension published into `.radius/` (for example `extension customTypes`). Every extension alias must resolve through `.radius/bicepconfig.json`, which the skill always creates or updates (see [bicepconfig.json](#bicepconfigjson)); only ever write that file, never a config outside `.radius/`.

## bicepconfig.json

`app.bicep` cannot compile or deploy unless a `bicepconfig.json` resolves the `radius` extension. Always create or update `.radius/bicepconfig.json` (co-located with `.radius/app.bicep`) so it fits the generated `app.bicep`; only ever write that file, never a `bicepconfig.json` outside `.radius/`. When the application uses a generated custom type, this file also aliases the local custom-types extension tgz alongside the `radius` extension (see [custom-resource-types.md](references/custom-resource-types.md)).

- If `.radius/bicepconfig.json` already exists, update it to fit `app.bicep`: add or correct what `app.bicep` needs (the `radius` extension reference and `extensibility`), preserve unrelated existing settings, and change or remove entries only where they conflict with what `app.bicep` needs. An already-correct file produces an empty diff.
- If it does not exist, create it. When a `bicepconfig.json` in a parent directory would otherwise be the config discovered for `.radius/app.bicep` (before you write `.radius/bicepconfig.json`), use it as input: seed the new file from its compatible settings and adjust so it fits `app.bicep` (add, correct, or drop entries as needed). Do not modify the parent file.
- When there is nothing to carry forward, derive the extension tag from the installed Radius release and the target Environment's release contract. For a normal release, use the matching release channel/version; reserve `latest` for an explicitly selected edge or development release. If the installed and target releases disagree, stop and resolve the mismatch instead of choosing `latest`.
- After resolving `<target-release>` to the actual immutable or release-channel tag, create `.radius/bicepconfig.json` with the following shape. Never write the placeholder literally:

```json
{
  "experimentalFeaturesEnabled": {
    "extensibility": true
  },
  "extensions": {
    "radius": "br:biceptypes.azurecr.io/radius:<target-release>"
  }
}
```

Do not upgrade or downgrade an existing compatible pinned extension merely because another release is newer. Use `radius:latest` only when the target is explicitly an edge/development environment whose release contract maps to that tag.

## app.bicep Structure (mandatory order)

Declare resources in this order (do NOT output this as code — it is only for your reference):

1. Extensions: `extension radius` (always; covers all predefined Radius types) plus the local custom-types extension (for example `extension customTypes`) when the app uses a generated `Radius.Resources/*` custom type
2. Params: `environment`; add a `@secure() param` for each developer-supplied secret value
3. Application resource (`Radius.Core/applications@2025-08-01-preview`) — always exactly one
4. Data / infrastructure resources (databases, caches, message brokers, object storage, AI services)
5. Secret resources (app secrets, or schema-required credentials via `secretName`)
6. Container image resources (if building from Dockerfile)
7. Container resources (with image, configuration, secret, and dependency wiring)
8. Routes (only if external ingress needed)

Rules:

- One `Radius.Compute/containers` per deployment unit; its `containers` map must include every co-scheduled role required by that unit. Separate independently deployed services into separate resources. Create one typed resource per selected backing service.
- Building from a complete Dockerfile context: add a `Radius.Compute/containerImages` resource with `build.source` set to the repo git URL (`git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>`); the container references the built image via `<serviceName>Image.properties.imageReference` (no separate connection needed). When the push registry is authenticated (e.g. `ghcr.io`), also add the registry-push Secret named exactly `radius-ghcr-registry-creds` (`username`/`password` from `registryUsername` + `@secure() registryPassword` params) and `dependsOn` it — its name must match the recipe pack's `containerImagesRegistrySecretName`. Omit the Secret for an unauthenticated registry. See [containerImages structure](references/bicep-structure-rules.md#radiuscomputecontainerimages-structure).
- Database credentials follow the type's schema: if it defines `username`/`password`, set them on the resource; if it defines `secretName`, create a `Radius.Security/secrets` and reference it; if it defines neither, the type takes no credentials. Always use a `@secure() param` for the password.
- Add `Radius.Compute/routes` only when an explicit request, deployment manifest, or other pinned-source evidence requires external ingress. An HTTP listener or `EXPOSE` instruction alone is insufficient.
- Keep provider modules, SKUs, regions, firewall/network policy, and recipe output mapping in Environment/provider Bicep. `app.bicep` contains only developer intent and app-facing runtime wiring.

## Connections

`connections` declares a generic Radius relationship. It does not translate resource properties into arbitrary application-specific variable or configuration names. Read [connection-conventions.md](references/connection-conventions.md).

Rules:

- Inspect the source to identify the exact names, casing, value format, defaults, and configuration mechanism it consumes.
- Generic projection can be a `CONNECTION_<NAME>_PROPERTIES` JSON value, individual `CONNECTION_<NAME>_<PROPERTY>` values, or another version-specific shape. Verify the configured extension/runtime contract; do not assume one format.
- Use a connection alone only when the application explicitly consumes that applicable generic contract. Otherwise map each required native input explicitly from a verified nonsecret resource output, a secret reference, a literal/default, or runtime composition.
- A direct resource property or secret reference creates dependency ordering. Do not add a connection merely for ordering; retain one only when the application/tooling consumes the relationship.
- An explicit request for Radius relationship metadata is a valid reason to retain a connection. Use the exact requested connection key and `source`; explicit native wiring may still be required for the workload.
- Explicit native variables may coexist with generic projection. Avoid conflicting values, and use `disableDefaultEnvVars` only when the exact container schema supports it and the generic variables would be harmful.

## Service-to-service addressing

When one container calls another `Radius.Compute/containers` resource in the same application (inter-service HTTP/gRPC in a microservices app), address the peer by referencing its read-only **`hosts`** output — a map of container name to that container's in-cluster Service DNS name, published by the containers recipe — never a hand-composed Service name:

```text
http://${<peerSymbolicName>.properties.hosts['<containerKey>']}:<containerPort>
```

Rules:

- Reference the peer's host with **indexed access**, `<peer>.properties.hosts['<containerKey>']`, NOT the resource `name` or a literal `<resource-name>-<containerKey>` string. `<containerKey>` is the peer's key in its own `containers` map. Use indexed (`['...']`) rather than dot access because a container key may contain hyphens or other characters that are not valid Bicep identifiers; indexed access works for every key. The containers recipe populates `hosts` with each port-exposing container's actual Service FQDN, so the reference is the stable, predictable host and it also creates a deploy-time dependency edge. (`identityApi.properties.hosts['identity']` → `'http://${identityApi.properties.hosts['identity']}:8080'`, never a hardcoded `http://identity-api:8080` or `http://identity-api-identity:8080`.)
- `hosts` is a read-only output — reference it, never set it. It has one entry per port-exposing container, so a multi-container peer publishes all of its Service hosts. Compose the full URL in a bicep string interpolation and assign it to the consuming `env.value`.
- **Do not create a dependency cycle.** Referencing `<peer>.properties.hosts[...]` creates a deploy-time dependency edge from the caller to the peer, so a pair (or ring) of containers that each reference the other's `hosts` forms a circular dependency that fails deployment. When two services genuinely need to call each other, break the cycle: address only one direction through `hosts` and give the other direction a value that carries no dependency edge — the peer's Service DNS name composed as a plain string literal `<peer-resource-name>-<containerKey>.<namespace>` (the exact name the recipe assigns), or route one side through a `Radius.Compute/routes`/gateway. Report the cycle and the chosen resolution rather than emitting mutual `hosts` references or silently guessing a Service name.
- `<containerPort>` is the peer container's published port number from source, not the `ports`-map key.
- Put the composed URL/host into the exact inter-service variable, config field, or CLI flag the calling source consumes (e.g. a `*_URL`/`*Url` env var, a config-file host, or .NET service discovery `services__<peer-resource-name>__http__0`). Derive the variable name, scheme (`http`/`https`/`grpc`), and any path from source — only the host portion follows this rule.
- This addressing is required only for container-to-container calls. Backing services (databases, caches, brokers) use their resource `host`/endpoint outputs per [connection-conventions.md](references/connection-conventions.md).

## Secrets

See [secrets-handling.md](references/secrets-handling.md). Secret contracts are version- and type-specific:

- **Inputs** (credentials you supply): follow the exact schema — set an `x-radius-sensitive` property (e.g. `password`) from a `@secure()` parameter; author a referenced `Radius.Security/secrets` only when the schema uses `secretName`; or none. When the app container also needs a supplied credential, assign the same `@secure()` parameter directly to its `env.value` — Radius encrypts and injects it, so do NOT wrap it in a `Radius.Security/secrets` or route it through `secretKeyRef`.
- **Outputs** (values a recipe generates): inspect the exact registered schema and recipe output mapping. When they declare managed-secret metadata, bind the workload directly with `secretName: <resource>.properties.secrets.name` and an exact key declared in that block. Those key declarations are not readable convenience properties. Never copy a recipe secret through an authored wrapper or guess `<resource>.properties.<key>`; if the managed-secret contract is absent, report the gap.
- When an application requires a connection string containing a secret, bind the secret as a helper environment variable and compose at runtime with correct ordering and escaping. URL-encode credentials when the target syntax requires it.

## Bicep Structure Rules

Read [bicep-structure-rules.md](references/bicep-structure-rules.md) for all structural rules.

## Validation Checklist

Before returning the Bicep, verify:

- [ ] One deployment profile is selected. Every explicit type, workload role/count, native key, required value, secret binding, and connection name from the request is represented in a closed requirement ledger.
- [ ] Every planned resource property read/write has its verbatim path in the ledger and exists in the exact configured schema/API version. Every recipe-generated output also has a verified output mapping; every managed-secret reference has the declared secret-name path and key. An absent path blocks generation rather than being replaced by a guessed property, alias, or wrapper.
- [ ] Every extensible type has an exact Recipe available in the target Environment. Each generated output and managed-secret key is verified against that Recipe or immutable provider recipe-pack source; each omitted optional input has a proven safe path.
- [ ] Exactly one `Radius.Core/applications@2025-08-01-preview`. `extension radius` is always declared; a local custom-types extension (for example `extension customTypes`) is also declared when the app uses a generated `Radius.Resources/*` custom type. No per-namespace or per-type extensions.
- [ ] `node "<loaded-skill-base>/scripts/validate-bicep.mjs" <staging-dir>/app.bicep` exits successfully and prints no errors or warnings. The file compiles with the target repository's exact configured extension; every `Radius.*` type is on the allow-list or is a generated `Radius.Resources/*` custom type, and matches that version's schema and API version. No direct `rad` command was used.
- [ ] `param environment string` is declared; add a `@secure() param` for each developer-supplied secret.
- [ ] Every required executable role is modeled, including co-scheduled producer/consumer or proxy/backend roles. Its image/build, entrypoint/arguments, listener, exposed ports, config artifacts, writable storage/ownership, and lifecycle are correct. `containerPort` matches the process; it does not configure the listener.
- [ ] Every required app-native input is supplied with the exact pinned-source name, casing, type, URL/config syntax, and value. Each declared generic connection is consumed by source or explicitly required as relationship metadata.
- [ ] The application's own workloads build from the repository Dockerfile via `Radius.Compute/containerImages` with an immutable ref; a pinned published image is used only for a third-party/backing container. Generated builds are consumed through `.properties.imageReference`.
- [ ] When a `Radius.Compute/containerImages` resource pushes to an authenticated registry, it is paired with a `Radius.Security/secrets` named exactly `radius-ghcr-registry-creds` (keys `username`/`password` from `registryUsername` + `@secure() registryPassword` params) and `dependsOn`s it; no registry is set on the resource. The Secret name matches the recipe pack's `containerImagesRegistrySecretName`. For an unauthenticated registry, no such Secret is authored.
- [ ] Every source build pins the exact modeled revision, validates tag behavior against the exact Recipe, selects platforms compatible with the Dockerfile and target runtime, and preserves required Git-context metadata through schema-supported inputs.
- [ ] Credentials match the type's schema: `username`+`password` on the resource, or `secretName`+secret, or none — whichever the schema defines. Password via `@secure() param`; `database`/`topic`/`queue`/etc. derived from source.
- [ ] A developer-supplied credential the app consumes reaches the container via the same `@secure()` parameter assigned to `env.value` — no authored wrapper `Radius.Security/secrets`, no `secretKeyRef`. `secretKeyRef` + `<resource>.properties.secrets.name` is used only for recipe-generated managed-secret outputs; no authored secret copies a resource output or guessed convenience property. No secret is hardcoded or moved into plain state; runtime composition preserves ordering, escaping, and required encoding.
- [ ] Read-only properties are never **set**. A referenced nonsecret output exists in the exact schema and recipe; a referenced secret path/key exists in the exact secret-output contract. Such direct references provide dependency ordering.
- [ ] Every dependency has a complete client tuple: subresource name, endpoint/FQDN transformation, port, protocol/version, TLS mode, auth mechanism/identity, secret source, and final client syntax. Provider modules, SKUs, regions, and firewall configuration remain outside `app.bicep`.
- [ ] Runtime parser coercion and unset behavior, TLS, authentication, bootstrap, listener configuration, ingress evidence, and primary-feature readiness are proven. Required model aliases, storage backends, database clients, and messaging inputs/outputs reference only mandatory selected resources; a health endpoint, login screen, or idle/placeholder process is insufficient.
- [ ] No required binding or dependency was deleted to satisfy stale mutable extension metadata or obtain a clean compile.
- [ ] Perform the static consistency pass in [runtime-contract.md](references/runtime-contract.md); no unresolved runtime caveat remains.
- [ ] The generated Bicep contains no explanatory comments. `.radius/bicepconfig.json` resolves the `radius` extension for `app.bicep`: created or updated in place (a parent `bicepconfig.json` is used only as input, never modified).
- [ ] The output follows the [deterministic output](#deterministic-output) rules, so regenerating from unchanged source would produce the identical file.
- [ ] `.radius/app.origin.json` was written by `write-app-origin.mjs` after the checker passed, describes the final `app.bicep` byte-for-byte, and is staged with it (see [Origin record](#origin-record-apporiginjson)).
- [ ] An existing model reported as manually edited was not overwritten without the user's agreement. A model with no origin record was regenerated without asking (see [Refreshing a stale model](#refreshing-a-stale-model)).

## Example

See [todo-list-app-example.md](references/todo-list-app-example.md) for source-derived modeling decisions when an application expects native database variables instead of Radius generic connection variables.
