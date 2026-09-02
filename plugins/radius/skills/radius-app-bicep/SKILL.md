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
2. In your chat reply, give a one-line intro naming the app (e.g. "I'll create an application definition for `todo-list-app`."), then a short, natural summary of the resources you identified, a brief list such as "Container: `todo-list-app`", "MySQL database", "Secret for DB credentials". A sentence or two of reasoning is fine; don't dump raw source analysis or the full file contents. If external-client ingress was considered but omitted, state why. Describe only what you actually did (that the run published and staged the model files in the working tree); do not claim the application graph or canvas is rendering, since you cannot observe that. If a graph view is opened and shows an error or empty state, report that honestly instead of asserting success. Keep the reply about the user's application and its resources; do not name internal skill or reference files (for example, reference examples the skill consulted).

## Radius CLI execution boundary

Never invoke `rad` or `rad.exe` directly from PowerShell, a shell, a subprocess, or a delegated agent. Use `node "<loaded-skill-base>/scripts/show-radius-type.mjs"` to resolve predefined Radius type definitions. Compile the generated application definition with `node "<loaded-skill-base>/scripts/validate-bicep.mjs" .radius/app.bicep`; the checker uses only the extension-managed Bicep and fails on every compiler warning or error. Graph validation must go through the Radius canvas and its tools: open `canvasId: "radius"` with `instanceId: "radius-panel"`, pass the current session repository as `repo` in `owner/repo` form, and use the current Copilot worktree branch. The extension honors an existing `RADIUS_RAD_BINARY`; otherwise it runs its managed binary from `%USERPROFILE%\.radius\ai-extensions\bin\rad.exe` on Windows or `$HOME/.radius/ai-extensions/bin/rad` on macOS/Linux, downloading it when absent and attempting a best-effort upgrade when older than the latest release (offline/API failures keep the installed binary; set `RADIUS_RAD_SKIP_VERSION_CHECK` to skip the version check). It does not resolve `rad` from `PATH` or `.rad/bin`. Diagnose graph failures only from the Radius extension log; never reproduce them with a direct CLI command or through another agent.

## Workflow

1. Start the run with `node "<loaded-skill-base>/scripts/promote-app-model.mjs" --begin`, which prints the staging directory to write everything into (see [Staged runs](#staged-runs)). Then select one runnable deployment profile. Treat explicit user, scenario, and target-repository deployment requirements for Radius types, resource-name parameters, workload roles/count, native configuration keys, secret bindings, provider profile, protocol values, and connection names as acceptance criteria. Verify that the pinned source supports that profile; do not silently replace it with an easier default or optional backend.
2. Build and maintain an internal requirement ledger. Record every acceptance criterion and planned resource property read or write with its source evidence and consuming workload setting. After type resolution, add the exact `resources[].apiVersion` and recursive `resources[].schema` path returned by `show-radius-type.mjs`, any `readOnly` or `writeOnly` restriction, and the separate Recipe and target-Environment evidence required for generated values. Use the ledger for reasoning and validation; do not print it or add it as Bicep comments. Follow [runtime-contract.md](references/runtime-contract.md).
3. Inventory every executable workload and backing service in the selected profile from manifests, Dockerfiles, compose/Helm files, entrypoints, source configuration reads, client initialization, and referenced config files. Treat web, worker, producer, consumer, migration, scheduler, and sidecar roles separately. Model a backing service only when source evidence proves it is mandatory for the selected startup/configuration path; a repo-wide optional dependency, extra, adapter, test, or example does not become a resource. After completing this inventory, decide external-client ingress using only the selected profile's startup and configuration chain and the [route authoring rule](#appbicep-structure-mandatory-order). Ask and stop if it is ambiguous; do not revisit the decision with files from an unselected profile.
4. Extract each workload's runtime contract: image/build context and target platform, entrypoint and arguments, listener and ports, required environment/configuration including parser coercion and unset behavior, secrets, writable storage, dependencies, wire protocols, TLS, authentication/bootstrap setup, and feature-critical configuration. Inspect CLI flags and structured fields as well as environment variables.
5. Map every selected backing service to a Radius type with [component-catalog.md](references/component-catalog.md), using [architecture-patterns.md](references/architecture-patterns.md) only as context. Report unsupported essential components instead of substituting unrelated types.
6. After the workload, backing-service, ingress, image-publishing, and secret inventory is complete, but before authoring Bicep, resolve every planned predefined type in one `show-radius-type.mjs` batch as described in [Resource Type Resolution](#resource-type-resolution). Apply the resource-specific structure rules before this call so companion predefined resources are included in the same batch. Unless target evidence explicitly proves an unauthenticated image registry, planning `Radius.Compute/containerImages` also plans the single `Radius.Security/secrets` registry-push companion described below. Preserve and inspect the complete returned JSON. Use each returned `type`, `apiVersion`, `schema`, and `recipe`, and handle every nonzero exit or `notFound` entry as described there. The script creates or merges the staged `bicepconfig.json` and owns its `radius` alias. The result supplies type-schema evidence and, when available, managed-release default Recipe evidence. Before authoring, apply the [Credential shape](references/secrets-handling.md#credential-shape) check. Use an available `recipe.definition` as the managed-default Azure Recipe profile unless explicit target evidence selects another Recipe; use that selected Recipe to decide whether a credential exists and inspect every credential representation it exposes. For each predefined type whose resolved Recipe meets the applicability check in [azure-provider-value-rules.md](references/azure-provider-value-rules.md), apply those rules to every property that the Recipe copies into an Azure name, administrator login, or AI model setting. Do not apply those Azure rules to AWS, Kubernetes, or an unverified custom Recipe. Prefer a direct shape match. When an aggregate output is incompatible or unknown, consider schema-declared discrete outputs and safe runtime composition before reporting a blocker; when the client needs parts, consider a proven runtime decomposition path. A package name without a checked-in consumer is not evidence, but an exact pinned dependency together with the checked-in call site that passes the value to that client's configuration API identifies the parser contract and permits using that client's documented syntax. Combine that client evidence with selected-profile literals, checked-in parser code, schema descriptions, and the selected Recipe's auth and output mappings. Treat compatibility as unknown only after direct binding and every supported composition or decomposition path have been considered. Stop on missing Recipe behavior or a remaining incompatible or unknown shape. Verify target-Environment registration, Recipe declarations outside the returned definition, and other application runtime behavior separately.
7. Build the application's own workloads from the repository Dockerfile via `Radius.Compute/containerImages`; this is the default path, and a repository without a Dockerfile is unsupported (see [Prerequisites](#prerequisites)). Require a complete, practical build context and pin `build.source` to the exact modeled checkout or an explicit immutable release tag. When the ref is a commit, use its full 40-character SHA in `?ref=`; never use an abbreviated SHA. The image `tag` may remain abbreviated because it is not a Git ref. Resolve the exact `containerImages` Recipe: verify omitted optional inputs, set a Docker-valid immutable `tag` only when required by that contract, decide `build.platforms` per image with the [Choosing build.platforms](references/bicep-structure-rules.md#choosing-buildplatforms) procedure, and preserve required Git metadata with schema-supported build arguments. Use a pinned published image only for a genuinely third-party/backing container, never for the application's own code. Map every runtime value using [connection-conventions.md](references/connection-conventions.md), [secrets-handling.md](references/secrets-handling.md), and [bicep-structure-rules.md](references/bicep-structure-rules.md).
8. Generate the Bicep into `<staging-dir>/app.bicep` using [naming-conventions.md](references/naming-conventions.md). For each predefined type whose resolved Recipe meets the applicability check in [azure-provider-value-rules.md](references/azure-provider-value-rules.md), keep its Azure-bound names, administrator logins, and model names within those rules. Use string literals or parameters with literal defaults for these values. If the source requires a value that the selected Recipe cannot deploy, report the conflict and abort the run; do not rename the source-required database, container, topic, or model. Then run `node "<loaded-skill-base>/scripts/validate-bicep.mjs" <staging-dir>/app.bicep`. Repair every compiler error and warning until the checker exits successfully and prints no warnings, within the [repair budget](#repair-budget) it enforces. Never make compilation pass by deleting a required backend activation, native configuration value, secret binding, or dependency edge.
9. Perform the [validation checklist](#validation-checklist) and close every item in the requirement ledger. Compilation or process startup alone is not success.
10. Only after the checker exits successfully, write the [origin record](#origin-record-apporiginjson) into the staging directory.
11. Publish the run with the promote script, which is the last step of every modeling run and the only thing that writes into `.radius/` (see [Staged runs](#staged-runs)).

### Repair budget

A compile error the skill cannot resolve is usually a real signal — a schema that has moved, a type the configured extension does not have, or a changed recipe contract — not something more attempts will fix. So `validate-bicep.mjs` bounds the repair loop itself, and the run ends by reporting rather than by editing indefinitely.

The checker enforces this whenever the model it compiles is inside a staging directory, by counting its own compiles in that run's `run.json`. It records the attempt before compiling, so an interrupted compile still counts, and it refuses to compile at all if that record cannot be read or updated — a budget it cannot count is one it cannot enforce. The count covers exactly one modeling run, and a later run starts fresh. You do not track attempts yourself, and you cannot compile your way past the limit.

- **Five repairs per run.** The first compile is free, because it is what reveals the problem; after five repair-and-recompile cycles the checker refuses to compile again and exits non-zero saying the budget is spent. That is the same number of repair cycles the deploy-failure repair loop allows after a failed deploy, so the product has one answer to "how many times do we retry a repair on `app.bicep`".
- **The checker tells you when a failure repeats.** It fingerprints the compiler output with line numbers and diagnostic ordering normalized out, and says so when a failure is the one you just saw. Treat that as proof the last fix was wrong: make a materially different fix rather than varying it, or use the remaining budget to establish why the schema cannot express what the source needs.
- **If the checker refuses to compile, stop.** Whether the budget is spent or the run's bookkeeping is broken, do not edit and retry. Do not write the origin record and do not publish the run. Tell the user which resource and property the compiler rejected, quote the last compiler output verbatim, and say that no application definition was written. The raw error is the most useful thing to hand over, because it is usually pointing at something real.

Never buy a clean compile by deleting a required backend activation, native configuration value, secret binding, or dependency edge. Running out of budget is the correct outcome when the alternative is a model that compiles and does not work.

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
2. Locate the implicated resource, property, or workload setting, then re-resolve the exact configured type schema and Recipe contract (see [Resource Type Resolution](#resource-type-resolution)) to confirm property names, required fields, credential shape, API version, resource reference paths, and provider restrictions. If the implicated predefined type's resolved Recipe meets the applicability check in [azure-provider-value-rules.md](references/azure-provider-value-rules.md), apply those rules. If the application requires the rejected value, report the application/Recipe conflict instead of silently changing it.
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
- `--skill-version` carries the one version that matters, so pass it whenever the prompt gave you a real one. The value comes from the running canvas, which is also what later compares the record against the installed generator, so passing it through unchanged is what keeps the writer and the reader talking about the same thing. Never pass the literal `<loaded-skill-version>`: if that is still the value you were given — which happens when `SKILL.md` was loaded directly rather than through the `radius_generate_app` handoff — omit the flag entirely. The script then records an empty version and prints a warning saying so; that warning is expected in this case and does not mean the run failed. The canvas simply skips the generator comparison for that model, which is safe. It does **not** work the version out for itself: a version read from whichever copy of the plugin this script happens to live in can disagree with the copy the canvas is running, and that disagreement reports the model as stale on every graph open forever.
- Write it into the staging directory beside the `app.bicep` it describes, and let the promote script publish and stage the pair (see [Staged runs](#staged-runs)). A model committed without its origin record reads as unverified on every other checkout of that branch, and a run whose record is missing or does not match its model is refused rather than published.
- Never edit `app.bicep` after recording it. If you change one byte, re-run the checker and re-run the origin script.
- The script fails closed when it cannot resolve the source commit or read the model. Do not work around it by writing the JSON yourself; fix the underlying problem and re-run it.

## Refreshing a stale model

The canvas asks for a refresh when an existing model is stale: its branch has moved past the recorded commit, a different generator version is installed, or there is no usable origin record at all. Regenerate from current source and write a new origin record, with one guard:

- **When the model is reported as manually edited, ask the user before overwriting it.** That state means the model needs regenerating and was also changed after it was generated: hand-tuned properties, a custom type, or a recipe pack reference someone added deliberately. Say what would be lost and regenerate only after the user agrees. Offer to repair the specific problem in place (see [Repairing an existing app.bicep](#repairing-an-existing-appbicep)) as the alternative, since that preserves their edits.
- **When the model has no origin record, regenerate it and write one. Do not ask.** Nothing about a missing record shows the model was edited, so there is no decision to put to the user, and the canvas only reports it this way when the file is committed and unmodified, so git still has the version being replaced. Regenerate from current source and record it as you would for any other generation.
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

| Field                              | Value                                                                                                                                                                                                                                                                                                                                                                       |
|------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Data store admin username          | The administrator username you author for the provisioned database. It is not derived from the source. Set it wherever the schema puts credentials — `username` on the resource, or `USERNAME` in the secret when the schema uses `secretName`. Use `myadmin` when the source does not require a login; it fits the Azure PostgreSQL, MySQL, and SQL safe subsets.          |
| Data store `database` name         | Derived from source (e.g., `MYSQL_DATABASE`/`POSTGRES_DB`, or the database segment of a connection string). If the data store type's resolved Recipe meets the applicability check in [azure-provider-value-rules.md](references/azure-provider-value-rules.md), the database name must also satisfy those rules. Do not rename a source-required database to make it pass. |
| Data store `version`               | Derived from source (e.g., the image tag `mysql:8.0` → `'8.0'`)                                                                                                                                                                                                                                                                                                             |
| Container key in `containers` map  | Service short name camelCase (single-container: derived from app, e.g., `todo`)                                                                                                                                                                                                                                                                                             |
| Port key in `ports` map            | `web` for the primary HTTP port; additional ports derive from protocol/use (`http`, `grpc`)                                                                                                                                                                                                                                                                                 |
| `build.source` for containerImages | Repo git URL pinned to the modeled checkout: `git::https://github.com/<org>/<repo>.git//<subdir>?ref=<checked-out-sha-or-explicit-immutable-tag>` (`//<subdir>` only when the Dockerfile isn't at the repo root)                                                                                                                                                            |

### Deterministic output

Two runs of this skill over the same source, with the same generator version and the same schema/recipe contract, must produce byte-identical `.radius/app.bicep`. A regeneration that reshuffles equivalent content produces a large diff that says nothing, which makes real changes hard to review and adds noise to the repository's history. Apply:

- **Canonical declaration order.** `extension` lines first, then `param` declarations, then the `Radius.Core/applications` resource, then the remaining resources. Never order resources by discovery order, file-walk order, or the order a tool happened to return them.
- **Canonical ordering within each group.** Order `param` declarations, and resources of the same type, by their `name` value using plain ASCII ordering. Resource types themselves follow the order they appear in the allow-list table under [Resource Type Resolution](#resource-type-resolution). The one exception is a resource that must be declared after something it references.
- **Canonical ordering inside a resource.** `name` first, then `properties`. Within a map whose keys you choose (`env`, `ports`, `containers`, `connections`), order keys ASCII-ascending.
- **Stable values.** Nothing derived from the current time, a random value, a temporary path, an absolute path on this machine, or an environment variable of the machine running the skill may appear in the output. Values pinned to a revision use the modeled commit or an explicit immutable tag, which are properties of the source rather than of the run.
- **Normalized formatting.** Two-space indentation, single quotes for strings, one trailing newline, no trailing whitespace, and no blank line runs longer than one.

## Source-code reference metadata (`codeReference`)

Each generated resource (except `applications`) must carry a `codeReference` in its `properties` pointing at where that resource is defined or initialized. Use a repo-relative path for a file available in the current worktree, or an exact GitHub `blob` URL when the source is being read from a committed repository branch. Either form may include a `#L<line>` anchor. It is metadata only: `rad app graph` preserves it and the application-graph canvas turns it into a clickable node link. It does not affect deployment.

Populate it for every non-application resource, because the developer is not hand-adding it and validation treats a missing durable graph link as an incomplete generated model:

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

To find the definition/initialization site for each resource, follow the discovery methodology in the app-graph skill's [source-code-references.md](../radius-app-graph/references/source-code-references.md) (category detection, filename/init patterns, skip rules, line pinpointing, output format), which owns the per-category rules. Two container cases matter most here and are opposites. A `Radius.Compute/containers` resource points at the entrypoint of the process it runs, never at a `Dockerfile`, compose file, Helm chart, or Kubernetes manifest; resolve it from the container's own `command`/`args` first, then through the image's Dockerfile to the source it executes. A `Radius.Compute/containerImages` resource points at the `Dockerfile` its build reads, which genuinely is that resource's definition site. For a declarative resource, use the checked-in manifest or configuration that requires it. When the application has no separate initialization site, use that resource's declaration line in `.radius/app.bicep` as the durable definition link. Do not publish a model with an ephemeral or missing graph link. On built-in types `codeReference` is a framework-owned optional base property (defined in Radius's base resource schema and inherited by every built-in type), so it is schema-valid but exempt from the per-type ledger's schema-proof requirement. Optional in the framework schema means hand-authored models may omit the metadata; it does not weaken this generator's completeness requirement.

Custom types do not get it for free. A `Radius.Resources/*` type generated from `custom-types.yaml` compiles to a closed object built from that manifest, so it accepts `codeReference` only when its own schema declares the property — which [custom-resource-types.md](references/custom-resource-types.md) now requires for every generated type. Before authoring `codeReference` on a custom-type resource, confirm the type's schema declares it; if it does not, add the property and republish `custom-types.tgz` before validating the model. Do not omit the reference, because validation rejects every generated non-application resource without one.

Choose the form from the source status. For a file in the selected current worktree, author a **repo-relative path** (`path` or `path#L<line>`) so the canvas can open the on-disk file in the editor. For a file resolved from a committed GitHub branch rather than the current worktree, author its exact `https://github.com/<owner>/<repo>/blob/<branch>/<path>[#L<line>]` URL. Never use a GitHub URL for an uncommitted or unpushed file, and never use a local absolute path.

## Resource Type Resolution

Use [component-catalog.md](references/component-catalog.md) only to choose candidate types. Before authoring, pass every currently planned predefined `Radius.*` type to one `show-radius-type.mjs` invocation. Do not pass generated `Radius.Resources/*` types or legacy `Applications.*` types.

```text
node "<loaded-skill-base>/scripts/show-radius-type.mjs" \
  --staging "<staging-dir>" \
  "Radius.Core/applications" \
  "Radius.Compute/containerImages" \
  "Radius.Compute/containers" \
  "Radius.Data/postgreSqlDatabases"
```

Preserve the process contract. Do not pipe the command through `head`, `tail`, `grep`, `2>&1`, or another filter. Capture stdout and stderr separately and capture the exit status immediately. If stdout is too large for one tool response, save its complete contents in a temporary file inside the staging directory and query that file locally. Do not rerun a successful batch merely to inspect another field, and do not replace the complete result with a projection that discards `schema` or `notFound`.

Normally omit `@<api-version>`. When exactly one version exists, the script selects it. When several versions exist, the command exits `1`, lists them on stderr, leaves the staged config unchanged, and emits no JSON. For a repair, rerun with the existing model's version if it is listed. For a new model, rerun one batch containing the listed versions explicitly and select the newest version whose schema satisfies the application requirements. If the type exists but an explicitly requested version does not, the command exits `1` and lists the available versions. If the type has no versions at all, it appears in `notFound` even when the selector includes an explicit version.

On exit `0`, the script first writes the staged configuration and then prints one line of contract-version `1` JSON. The only public top-level fields are `contractVersion`, `resources`, and `notFound`. Each `resources[]` entry contains `type`, `apiVersion`, `schema`, and `recipe`. The script exact-matches each resolved type against the managed release's pinned Azure Recipe pack. When `recipe.status` is `available`, the object contains `provenance`, `recipePack`, `repository`, `commit`, `path`, and the exact matching Bicep `definition`. When the pack has no exact entry for the type, `recipe.status` is `notFound` and `recipe.message` explains the miss. Duplicate selectors that resolve to the same type and API version appear once. The Radius extension reference and managed Radius commit remain internal.

Treat an available `recipe.definition` as evidence for the managed release's default Azure Recipe behavior for that exact type. Use it during the pre-authoring credential-shape check whenever the managed-default Azure profile applies. If explicit target evidence selects a different Recipe, inspect that exact Recipe instead. Target-Environment registration remains separate evidence: the returned definition does not prove that an Environment registers it, and registration proof does not replace the up-front behavior check. Do not parse the returned definition through a lossy projection, and do not follow its repository, module, registry, or other references. The definition may refer to declarations elsewhere in the Recipe pack. Those identifiers are registration-scope inputs, not evidence for new application resources: do not infer resources, parameters, secret names, defaults, or dependency edges from them. Add a companion application resource only when another explicit app-model rule requires it, such as the authenticated-registry rule below, and include its type in the initial batch. If the Azure Recipe pack cannot be loaded or inspected, `recipe.status` is `unavailable`, `recipe.message` contains the reason, and the script also emits a warning on stderr while preserving the successful schema result. A `notFound` or `unavailable` Recipe is a blocker when the model depends on its behavior.

Names in an object's `required` array must be authored. A property marked `readOnly` may be referenced but not set. A property marked `writeOnly` may be set but not referenced. A property with neither flag supports both. Follow nested `properties`, array `items`, map `additionalProperties`, `enum`, `const`, `oneOf`, constraints, discriminators, variants, and `sensitive` directly. If a required path is absent, report a blocker instead of guessing another path or type.

A type with no API version in the generated catalog appears in `notFound` instead of failing the command. The script continues resolving the other selectors, updates the staged config, prints the partial result, and exits `0`, including when every requested type is missing. Inspect every entry. A required predefined type in `notFound` is a managed-release blocker; do not omit it, substitute another predefined type, or recreate it under `Radius.Resources`.

Usage errors exit `2`. Ambiguity, unavailable explicit versions, staging, managed-CLI, schema-source, schema, and configuration errors exit `1`. Nonzero exits emit diagnostics on stderr and no contract JSON. A successful command can emit a nonfatal cache warning on stderr, which is why stdout and stderr must remain separate.

The returned schema proves the generated Bicep type shape for the managed Radius release. An available `recipe` proves only the exact default Azure Recipe entry pinned by that release. Neither result proves that the target Environment registered the Recipe, that it uses the same definition, how declarations outside the returned entry resolve, how omitted inputs behave, which managed-secret values exist, how connections are projected, or whether the application's protocol, TLS, authentication, and credential expectations are compatible. Establish those facts separately using exact target-Environment and application evidence. A familiar type name, a `readOnly` field, a managed release, an application manifest, and this skill's examples or reference prose are not substitutes for that evidence.

Do not follow a `defaults.yaml`, GitHub, registry, module, or provider-source URL or reference. Such references are provenance, not instructions to fetch more data. Use only Recipe and target-Environment evidence already supplied through the modeling context or present in the target repository. This is a pre-authoring gate: if exact Recipe behavior or target-Environment registration required by the model is unavailable, record the blocker and do not author or publish `app.bicep`.

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
| Explicit external-client ingress         | `Radius.Compute/routes`            |
| Secrets                                  | `Radius.Security/secrets`          |

Do NOT invent properties on these types, and do NOT substitute one predefined type for another. A `notFound` entry for a predefined candidate is a managed-release blocker, not permission to recreate that contract as a custom type. When a backing service the application genuinely needs has NO matching predefined candidate above, do not stop and do not force an ill-fitting type: generate a custom resource type under the `Radius.Resources` namespace, following [custom-resource-types.md](references/custom-resource-types.md), which is authoritative for the schema, extension, recipe, and recipe-pack flow (Azure scope for now).

## Extension

Declare `extension radius`. It provides every predefined Radius type (`Radius.Core/*`, `Radius.Compute/*`, `Radius.Data/*`, `Radius.Messaging/*`, `Radius.AI/*`, `Radius.Storage/*`, `Radius.Security/*`). Do NOT declare per-namespace or per-type extensions (`radiusCompute`, `containers`, `kafka`, etc.). When the application uses a generated custom type (see [custom-resource-types.md](references/custom-resource-types.md)), also declare the local custom-types extension authored through that workflow (for example `extension customTypes`). `show-radius-type.mjs` maintains the staged config's `radius` alias; the model remains responsible for the generated custom-type package and `customTypes` alias.

## bicepconfig.json

After type resolution succeeds, `show-radius-type.mjs` reads an existing `<staging-dir>/bicepconfig.json`; if none exists, it reads the current `.radius/bicepconfig.json`; if neither exists, it starts with an empty object. It preserves unrelated settings and extension aliases, enables `experimentalFeaturesEnabled.extensibility`, and fills an absent or blank `extensions.radius` with the extension derived from the managed Radius CLI. A different nonblank `radius` alias is a version conflict: the command exits `1`, leaves the configuration unchanged, and prints no contract JSON. Successful partial and all-missing results still update the staged configuration.

Do not create, replace, or select the `radius` alias yourself. When the application uses a generated custom type, add or update its local alias, for example `"customTypes": "./custom-types.tgz"`, after publishing the model-authored package. Any other required staged compiler setting must preserve the resolver-owned `radius` alias and every unrelated setting.

Do not upgrade or downgrade an existing compatible pinned extension merely because another release is newer. Use `radius:latest` only when the target is explicitly an edge/development environment whose release contract maps to that tag.

## app.bicep Structure (mandatory order)

Declare resources in this order (do NOT output this as code — it is only for your reference):

1. Extensions: `extension radius` (always; covers all predefined Radius types) plus the local custom-types extension (for example `extension customTypes`) when the app uses a generated `Radius.Resources/*` custom type
2. Params: `environment`; add a `@secure() param` for each developer-supplied secret value
3. Application resource (`Radius.Core/applications@<resolved-api-version>`) — always exactly one
4. Data / infrastructure resources (databases, caches, message brokers, object storage, AI services)
5. Secret resources (app secrets, or schema-required credentials via `secretName`)
6. Container image resources (if building from Dockerfile)
7. Container resources (with image, configuration, secret, and dependency wiring)
8. Routes (only when external-client ingress is required)

Rules:

- One `Radius.Compute/containers` per deployment unit; its `containers` map must include every co-scheduled role required by that unit. Separate independently deployed services into separate resources. Create one typed resource per selected backing service.
- Building from a complete Dockerfile context: add a `Radius.Compute/containerImages` resource with `build.source` set to the repo git URL (`git::https://github.com/<org>/<repo>.git//<subdir>?ref=<sha-or-tag>`); the container references the built image via `<serviceName>Image.properties.imageReference` (no separate connection needed). When the push registry is authenticated (e.g. `ghcr.io`), also add the registry-push Secret named exactly `radius-ghcr-registry-creds` (`username`/`password` from `registryUsername` + `@secure() registryPassword` params) and `dependsOn` it — its name must match the recipe pack's `containerImagesRegistrySecretName`. Omit the Secret for an unauthenticated registry. See [containerImages structure](references/bicep-structure-rules.md#radiuscomputecontainerimages-structure).
- Database credentials follow the type's schema: if it defines `username`/`password`, set them on the resource; if it defines `secretName`, create a `Radius.Security/secrets` and reference it; if it defines neither, the type takes no credentials. Always use a `@secure() param` for the password.
- Add `Radius.Compute/routes` only when the selected deployment profile explicitly requires external clients to reach a workload. Evidence must be an explicit user request or a pinned-source ingress contract reached through the selected startup entrypoint and its manifest/configuration chain, such as Kubernetes `Ingress` or Gateway API resources, public or private DNS or load-balancer configuration, or deployment documentation that specifies non-local external access. Do not import ingress settings from an unselected deployment script, bundle, example, or alternate profile, even when it reuses the selected profile's Compose manifest. The Route Recipe determines the exposed hostname and assigns the Gateway listener; the Gateway may use a public or private load balancer, and application source does not need to define that infrastructure. When the selected profile has no access evidence, or its only access evidence is service-to-service traffic, an app-owned reverse proxy used only for internal routing, localhost documentation, Compose port publishing, a single application entrypoint, an architecture diagram alone, Dockerfile `EXPOSE`, a health endpoint, a listener, or a component name such as `ingress` or `gateway`, omit the route without asking. If other evidence from the selected profile points toward external-client access but does not establish whether the profile requires it, ask the user whether to add a route before generating the model.
- A source `LoadBalancer`, Ingress, public URL, or other external-ingress signal justifies the route resource; it does **not** authorize a public cloud endpoint. The managed deploy Gateway is `ClusterIP` by default. Public exposure is an environment operator decision made only after an explicit user request through `RADIUS_ROUTES_EXPOSURE=public`, and it affects every routes app attached to that environment's shared Gateway. Do not encode or infer that deployment policy in `app.bicep`.
- Keep provider modules, SKUs, regions, firewall/network policy, and recipe output mapping in Environment/provider Bicep. `app.bicep` contains only developer intent and app-facing runtime wiring.

## Connections

`connections` declares a generic Radius relationship. It does not translate resource properties into arbitrary application-specific variable or configuration names. Read [connection-conventions.md](references/connection-conventions.md).

Rules:

- Inspect the source to identify the exact names, casing, value format, defaults, and configuration mechanism it consumes.
- Generic projection can be a `CONNECTION_<NAME>_PROPERTIES` JSON value, individual `CONNECTION_<NAME>_<PROPERTY>` values, or another version-specific shape. Automatic secret-backed `CONNECTION_*` projection is Kubernetes Container Recipe behavior only. Select it when the required managed `show-radius-type.mjs` result for `Radius.Compute/containers` has `recipe.status: "available"` and its returned `recipe.definition` identifies the Kubernetes Container Recipe. An explicit target Recipe supplied in the user brief, managed context, or a repository-pinned local file may establish the same support when it identifies that Recipe. The skill handoff itself and a resolved resource schema alone do not establish runtime projection support. If the Recipe is absent, unavailable, unresolved, or not the Kubernetes Container Recipe, preserve schema-supported `env`, `secretKeyRef`, `envFrom`, native variables, or equivalent explicit wiring. Inspect only the returned definition or supplied local artifact. Do not execute `rad`, fetch versions or Recipe metadata, or visit external links to discover compatibility, and do not follow references from the definition. Azure Container Instances (ACI) behavior is unchanged and must not use this Kubernetes projection. Do not migrate a working `app.bicep` without explicit user intent.
- An authored `Radius.Security/secrets` connection uses `<secret>.id` and projects its declared data keys. A producer connection uses `<producer>.id` and may project ordinary properties plus keys declared by the Recipe in `result.secrets`. `<producer>.properties.secrets.name` is only the Kubernetes Secret name for an explicit `secretKeyRef`; it is never a connection source, and `properties.secrets.id` does not exist.
- The Kubernetes Container Recipe applies generated ordinary and secret-backed `CONNECTION_*` variables to both regular containers and init containers under the same precedence, disabling, and collision rules. `<CONNECTION>` is the uppercased connection map key without separator insertion (`postgresSecret` becomes `POSTGRESSECRET`); `<SECRETKEY>` is the uppercased authored Secret data key or Recipe `result.secrets` key. An explicit `env` entry wins over a generated variable with the same name. When an ordinary projected property and a managed secret-derived value normalize to the same generated name, the managed secret value wins. When two secret-derived values normalize to the same generated name, fail rather than choose silently. `disableDefaultEnvVars: true` suppresses all generated variables for that connection.
- Developer-owned credentials remain inputs in authored Secrets or explicit schema-supported wiring. Credentials generated by a Recipe or its infrastructure belong in `result.secrets`; never copy them into developer-owned inputs or authored wrapper Secrets.
- Use a connection alone only when the application explicitly consumes that applicable generic contract. Otherwise map each required native input explicitly from a verified nonsecret resource output, a secret reference, a literal/default, or runtime composition.
- A direct resource property or secret reference creates dependency ordering. Do not add a connection merely for ordering; retain one only when the application/tooling consumes the relationship.
- An explicit request for Radius relationship metadata is a valid reason to retain a connection. Use the exact requested connection key and `source`; explicit native wiring may still be required for the workload.
- Explicit native variables may coexist with generic projection. Avoid conflicting values, and set `disableDefaultEnvVars: true` on the connection only when all of that connection's generated variables must be suppressed; never set it when the workload relies on a generated secret-backed variable.

## Service-to-service addressing

When one container calls another `Radius.Compute/containers` resource in the same application (inter-service HTTP/gRPC in a microservices app), address the peer by referencing its read-only **`hosts`** output — a map of container name to that container's in-cluster Service DNS name, published by the containers recipe — never a hand-composed Service name:

```text
http://${<peerSymbolicName>.properties.hosts['<containerKey>']}:<containerPort>
```

Rules:

- Reference the peer's host with **indexed access**, `<peer>.properties.hosts['<containerKey>']`, NOT the resource `name` or a literal `<resource-name>-<containerKey>` string. `<containerKey>` is the peer's key in its own `containers` map. Use indexed (`['...']`) rather than dot access because a container key may contain hyphens or other characters that are not valid Bicep identifiers; indexed access works for every key. The containers recipe populates `hosts` with each port-exposing container's actual Service FQDN, so the reference is the stable, predictable host and it also creates a deploy-time dependency edge. (`identityApi.properties.hosts['identity']` → `'http://${identityApi.properties.hosts['identity']}:8080'`, never a hardcoded `http://identity-api:8080` or `http://identity-api-identity:8080`.)
- `hosts` is a read-only output — reference it, never set it. It has one entry per port-exposing container, so a multi-container peer publishes all of its Service hosts. Compose the full URL in a bicep string interpolation and assign it to the consuming `env.value`.
- **Do not create a dependency cycle.** Referencing `<peer>.properties.hosts[...]` creates a deploy-time dependency edge from the caller to the peer, so a pair (or ring) of containers that each reference the other's `hosts` forms a circular dependency that fails deployment. When two services genuinely need to call each other, break the cycle: address only one direction through `hosts` and give the other direction a value that carries no dependency edge, using the peer's Service DNS name composed as a plain string literal `<peer-resource-name>-<containerKey>.<namespace>` (the exact name the recipe assigns). This cycle break is the deliberate exception to the no-literal rule above. Report the cycle and the chosen resolution rather than emitting mutual `hosts` references, silently guessing a Service name, or adding a route for internal traffic.
- `<containerPort>` is the peer container's published port number from source, not the `ports`-map key.
- Put the composed URL/host into the exact inter-service variable, config field, or CLI flag the calling source consumes (e.g. a `*_URL`/`*Url` env var, a config-file host, or .NET service discovery `services__<peer-resource-name>__http__0`). Derive the variable name, scheme (`http`/`https`/`grpc`), and any path from source — only the host portion follows this rule.
- This addressing is required only for container-to-container calls. Backing services (databases, caches, brokers) use their resource `host`/endpoint outputs per [connection-conventions.md](references/connection-conventions.md).

## Secrets

See [secrets-handling.md](references/secrets-handling.md). Secret contracts are version- and type-specific:

- **Inputs** (credentials you supply): follow the exact backing-resource schema and use a `@secure()` parameter for every sensitive value. Preserve existing explicit wiring unless the user requests migration. When a compatible Kubernetes workload intentionally consumes that credential through Secret connection projection, author or reuse a non-colliding `Radius.Security/secrets` resource containing the value and connect the workload to `<secret>.id`; do not connect to the backing resource and expect its sensitive input to be readable. Developer-owned inputs stay developer-owned and must not be echoed through Recipe `result.secrets`.
- **Outputs** (values a Recipe generates): inspect the exact registered schema and Recipe `result.secrets` contract. On a compatible Kubernetes Container Recipe, connect the workload only to `<producer>.id`; Radius injects each result entry as a secret-backed `CONNECTION_<CONNECTION>_<SECRETKEY>` variable whose suffix follows the declared result key. Do not connect to `<producer>.properties.secrets.name`; that public property is the Kubernetes Secret name and is used only when an explicit custom environment variable requires `secretKeyRef`. Never copy a Recipe secret through an authored wrapper or guess `<producer>.properties.<key>`; if the Recipe secret-output contract is absent, report the gap.
- **Shape**: the exposed credential must be a shape the pinned client parses. An aggregate URL and discrete host/port/password/TLS fields are different contracts. Whether a credential exists at all is established by the exact target Recipe, not by the type's managed-secret metadata: address outputs alone are complete only where that Recipe provably generates none, and an unresolved Recipe counts as generating one. Do not invent an undeclared discrete property or key, split an aggregate in Bicep, or assume an image can split it at runtime. Report a mismatch instead — see [Credential shape](references/secrets-handling.md#credential-shape).
- When an application requires a connection string containing a secret, bind the secret as a helper environment variable and compose at runtime with correct ordering and escaping. URL-encode credentials when the target syntax requires it.

## Bicep Structure Rules

Read [bicep-structure-rules.md](references/bicep-structure-rules.md) for all structural rules.

## Validation Checklist

Before returning the Bicep, verify:

- [ ] One deployment profile is selected. Every explicit type, workload role/count, native key, required value, secret binding, and connection name from the request is represented in a closed requirement ledger.
- [ ] One `show-radius-type.mjs` batch covered every planned predefined type. Every property the model sets or references has its exact recursive path and access restriction in the returned schema. Every required `notFound` entry is reported as a blocker.
- [ ] Every relied-upon generated value has separate evidence for its exact Recipe mapping and target-Environment registration. The returned schema and application source are not used as substitutes for that evidence.
- [ ] For each predefined type whose resolved Recipe meets the applicability check in [azure-provider-value-rules.md](references/azure-provider-value-rules.md), every provider-bound database name, administrator login, container name, Kafka topic, MongoDB database, or AI model used by that type satisfies those rules. Each value is a string literal or has a literal parameter default. A source-required incompatible value stops the run instead of being renamed. Azure-only rules were not applied to another provider or an unverified custom Recipe.
- [ ] Exactly one `Radius.Core/applications` resource uses its returned API version. `extension radius` is declared, plus the model-authored local custom-types extension when generated `Radius.Resources/*` types are used. No per-namespace or per-type extensions.
- [ ] `node "<loaded-skill-base>/scripts/validate-bicep.mjs" <staging-dir>/app.bicep` exits successfully and prints no errors or warnings. Every predefined type and API version matches the resolver output. The resolver wrote the staged `bicepconfig.json`; no direct `rad` command or manually selected Radius extension alias was used.
- [ ] `param environment string` is declared; add a `@secure() param` for each developer-supplied secret.
- [ ] Every required executable role is modeled, including co-scheduled producer/consumer or proxy/backend roles. Its image/build, entrypoint/arguments, listener, exposed ports, config artifacts, writable storage/ownership, and lifecycle are correct. `containerPort` matches the process; it does not configure the listener.
- [ ] Every required app-native input is supplied with the exact pinned-source name, casing, type, URL/config syntax, and value. Each declared generic connection is consumed by source or explicitly required as relationship metadata.
- [ ] The application's own workloads build from the repository Dockerfile via `Radius.Compute/containerImages` with an immutable ref; a pinned published image is used only for a third-party/backing container. Generated builds are consumed through `.properties.imageReference`.
- [ ] When a `Radius.Compute/containerImages` resource pushes to an authenticated registry, it is paired with a `Radius.Security/secrets` named exactly `radius-ghcr-registry-creds` (keys `username`/`password` from `registryUsername` + `@secure() registryPassword` params) and `dependsOn`s it; no registry is set on the resource. The Secret name matches the recipe pack's `containerImagesRegistrySecretName`. For an unauthenticated registry, no such Secret is authored.
- [ ] Every source build pins the exact modeled revision, validates tag behavior against the exact Recipe, and preserves required Git-context metadata through schema-supported inputs.
- [ ] Every source-built image has its own recorded `build.platforms` decision from the [Choosing build.platforms](references/bicep-structure-rules.md#choosing-buildplatforms) procedure: the multi-arch default is kept only where the Dockerfile proves it safe, and any pinned image or packaging gap was reported to the user rather than left silent.
- [ ] Credentials match the type's schema: `username`+`password` on the resource, or `secretName`+secret, or none — whichever the schema defines. Password via `@secure() param`; `database`/`topic`/`queue`/etc. derived from source.
- [ ] A developer-supplied credential consumed through connection projection is stored in an authored or reused `Radius.Security/secrets` and connected through `<secret>.id`; a Recipe-generated credential is obtained by connecting only to `<producer>.id`. Each generated `CONNECTION_<CONNECTION>_<SECRETKEY>` suffix is the uppercased authored data key or Recipe `result.secrets` key. An explicit native or compatibility-fallback `secretKeyRef` for an authored Secret uses `<secret>.name` and its declared data key; `secretKeyRef` with `<producer>.properties.secrets.name` is reserved for an explicitly required custom Kubernetes environment name for a Recipe result. Explicit `env` precedence is intentional; a managed secret-derived generated value wins over an ordinary projected property with the same normalized name; two secret-derived values with the same normalized name fail; and `disableDefaultEnvVars` does not suppress a required generated credential. No secret is hardcoded, copied from a Recipe result, or moved into plain state; runtime composition preserves ordering, escaping, and required encoding.
- [ ] Read-only properties are never **set**. Every referenced nonsecret value is present in the returned schema and has separate evidence that the target Recipe populates it in a form compatible with the application. Every referenced secret path and key exists in the exact secret-output contract. Such direct references provide dependency ordering.
- [ ] Every dependency has a complete client tuple: subresource name, endpoint/FQDN transformation, port, protocol/version, TLS mode, auth mechanism/identity, secret source, credential shape, and final client syntax. Provider modules, SKUs, regions, and firewall configuration remain outside `app.bicep`.
- [ ] The credential shape the exact schema and Recipe expose either directly matches what the pinned client parses or can be converted through a safe, proven runtime path. Every Recipe-exposed representation was considered: matching aggregate values first, then schema-declared discrete outputs for client-native composition, then runtime decomposition when the pinned image and parser support it. A package name alone, a string type, a credential-like variable name, or a direct `secretKeyRef` is not proof; an exact pinned dependency plus the checked-in configuration-API call that consumes the value can establish the client parser contract. Address outputs stand alone only where the exact target Recipe provably generates no credential and the reply names that dependence; an unresolved Recipe counts as generating one. No undeclared discrete property or secret key is invented; no aggregate credential is split in Bicep, in an authored secret, or by a wrapper the pinned image cannot run. A remaining incompatible or unknown shape with no supported path is reported and the run is not published.
- [ ] Runtime parser coercion and unset behavior, TLS, authentication, bootstrap, listener configuration, ingress evidence, and primary-feature readiness are proven. Required model aliases, storage backends, database clients, and messaging inputs/outputs reference only mandatory selected resources; a health endpoint, login screen, or idle/placeholder process is insufficient.
- [ ] No required binding or dependency was deleted to satisfy stale mutable extension metadata or obtain a clean compile.
- [ ] Every generated non-application resource stores a verified `properties.codeReference` appropriate to its source status: repo-relative for a current-worktree file, or an exact GitHub `blob` URL for a committed branch file. No graph-only source-reference update is treated as completion.
- [ ] No `Radius.Compute/containers` resource's `codeReference` points at a packaging file (`Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `docker-compose*.{yml,yaml}`, `compose*.{yml,yaml}`, `Chart.yaml`, `values.yaml`); each resolves to the entrypoint of the process that container runs. A `Radius.Compute/containerImages` resource is the exception and does point at the `Dockerfile` its build reads.
- [ ] Perform the static consistency pass in [runtime-contract.md](references/runtime-contract.md); no unresolved runtime caveat remains.
- [ ] The generated Bicep contains no explanatory comments. The staged `bicepconfig.json` preserves unrelated settings and resolves every declared extension. The resolver owns its `radius` alias; any model-authored compiler setting or generated custom-type alias preserves that value.
- [ ] The output follows the [deterministic output](#deterministic-output) rules, so regenerating from unchanged source would produce the identical file.
- [ ] `.radius/app.origin.json` was written by `write-app-origin.mjs` after the checker passed, describes the final `app.bicep` byte-for-byte, and is staged with it (see [Origin record](#origin-record-apporiginjson)).
- [ ] Any model the canvas said needed the user's agreement was not overwritten without it. A model with no origin record that the canvas did not flag was regenerated without asking (see [Refreshing a stale model](#refreshing-a-stale-model)).

## Example

See [todo-list-app-example.md](references/todo-list-app-example.md) for source-derived modeling decisions when an application expects native database variables instead of Radius generic connection variables.
