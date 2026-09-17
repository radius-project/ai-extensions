# Research: Frontend-Neutral GitHub Radius

**Date**: 2026-09-15

**Scope**: Shared contract and Copilot App migration only. Copilot CLI, hosting, and general operation-history storage are deferred.

**Evidence baseline**: Local commit `5204c989137f76ad88fa15ea0431fa1b15ed1e08`; source proposal [radius-project/radius#12967](https://github.com/radius-project/radius/pull/12967) at `1d218580e2eee9ea0ccc99bda647891fac29dd0a`. Read-only research separately inspected App seams and execution/authoring seams. Findings below distinguish existing implementation from planned behavior.

## 1. Package ownership and binding

**Decision**: Put contracts and lifecycle product logic in `packages/core/src/lifecycle`, concrete reusable Node adapters in `packages/adapter-shared/src/lifecycle`, and App translation in existing runtime/server factories. The initial contract is an in-process library boundary. Add a generic App lifecycle tool for capabilities absent from retained tools; do not build an HTTP service or CLI.

**Rationale**: The standing architecture already makes core depend on typed ports and adapters depend on core. `packages/core/src/ports/index.ts` demonstrates injection but its legacy GitHub reads collapse failures to null/empty collections, so it cannot provide the new contract's missing-versus-unavailable guarantees without a stronger port. `runtime/create-radius-extension.ts`, `runtime/create-radius-tools.ts`, and `server/route-table.ts` provide existing composition and translation seams.

**Alternatives considered**: Wrapping Canvas routes preserves panel dependence. A new service package duplicates the established core ownership. A hosted service or MCP server introduces authentication, deployment, and operational choices not needed for this release.

## 2. Published message definitions

**Decision**: Use JSON Schema draft-07 as the machine-readable contract source, represented as immutable schema data under the dedicated core subpath. Infer TypeScript unions using `json-schema-to-ts`; validate external requests/results through Ajv in adapter-shared. Compile and cache validators per injected lifecycle context, not in a mutable global.

**Rationale**: The existing TypeScript workspace and SDK-shaped declarations are not a public frontend-neutral schema. Schema-first definitions avoid maintaining independent request interpretations. Runtime validation must not coerce types, inject defaults silently, fetch schemas remotely, or accept a user-supplied authorization claim. Required runtime and build dependencies will be declared and pinned in the implementation change.

**Alternatives considered**: Handwritten type guards plus separate published schemas invite drift. SDK schemas alone retain frontend coupling. Generated HTTP endpoints select an unnecessary transport.

**Tooling evidence**: [Ajv's version guidance](https://ajv.js.org/json-schema.html) recommends draft-07 unless newer keywords are needed and warns that draft-2020-12 requires a separate incompatible validator instance. This contract needs only ordinary tagged object unions, required fields, enums, arrays, and local references. [`json-schema-to-ts`](https://github.com/ThomasAribart/json-schema-to-ts) supports immutable schema literals and type-only inference, avoiding runtime dependencies in core. Prefer that common subset and test both compile-time inference and runtime schema validation during implementation.

## 3. Lifetime and operation identity

**Decision**: The App composition root constructs a lifecycle context with injected clock, ID generator, registry, execution adapters, and authorization/agent ports. Panel servers receive a reference rather than own new domain operations. Existing persisted setup records retain their current storage behavior through an adapter; new deployment/action records are session-local with correlated remote evidence.

**Rationale**: Panel close cannot destroy the only execution identity. Browser/server listeners are disposed on close; session-owned local operations and accepted remote workflows follow their own cancellation policy. Session shutdown fences pending local work and releases resources but cannot claim a remote workflow was cancelled. Durable history, action replay after restart, and cross-session recovery are not promised.

**Alternatives considered**: Canvas instance IDs are view identities, not operation IDs. A process-global map violates state ownership. A new persistent operation store expands the explicitly deferred scope.

**Concrete migration seams**: App operation routes delegate to `packages/adapter-canvas/src/operations.ts`, which imports the existing `OperationStore` abstraction and normalizes persisted setup/deletion control records. Preserve that adapter's resume/stop/continue/rollback semantics rather than pretending these records already describe all deployments. `server/create-canvas-server.ts`, `server/dependencies.ts`, and `server/request-context.ts` provide the existing server composition seams.

## 4. Source and graph semantics

**Decision**: Resolve worktree sources through opaque authorized references and immutable copies of effective inputs; resolve remote sources to exact commits. Capture content fingerprints over the complete effective local definition input closure and recheck at guarded replacement. Reuse managed `rad` graph execution and existing graph equivalence.

**Rationale**: `packages/adapter-shared/src/rad.ts` already isolates graph compilation and clears `GITHUB_ACTIONS` to avoid archive writes. `packages/core/src/graph/appgraph.ts`, `model.ts`, and `diff.ts` normalize Radius output and preserve `diffHash`. `packages/core/src/modeling/app-staging.ts` currently fingerprints files it may replace, which is narrower than all effective inputs.

**Alternatives considered**: Hashing only `app.bicep` misses referenced-module changes. Running the raw compiler in the worktree can leave output or publish archives. Reimplementing graph construction would conflict with Radius ownership.

## 5. Environment-specific planned graphs

**Decision**: Add a typed environment recipe-registration read port. Resolve planned outputs from the actual selected environment's registrations and preserve their provenance. Missing registration is an explicit error.

**Rationale**: `packages/core/src/modeling/recipe-resolver.ts::fetchRecipePack` currently fetches a provider default and returns an empty list on missing content. That is not evidence of the environment's registrations. Existing recipe parsing and output derivation can be reused after a successful explicit lookup. Touch only the necessary typing/error boundaries rather than repairing every legacy `any` or `ts-nocheck` module.

**Alternatives considered**: Default-provider enrichment can show the wrong outputs. Invented custom types or singleton recipes would bypass the missing registration instead of resolving it.

**Implementation scope decision (T018-T038)**: The user chose to keep reads strictly read-only when existing deployment artifacts do not expose actual environment registrations. Report unavailable recipe evidence and planned graphs explicitly in that context. Do not restore a control plane, dispatch a workflow, or add a registration-artifact producer to obtain this evidence in the current milestone. Available registration evidence remains usable through the typed read port; unavailable evidence is not proof of an empty registration set or a missing recipe for a known type. Authored inspection and authored graph reads do not depend on this evidence.

## 6. Authoring and validation

**Decision**: Preserve staged authoring and the current modelability rules. Classify checks before execution; required-check failure blocks promotion, required-check unavailability produces incomplete validation, and unavailable advisory checks produce warnings. Shared lifecycle services validate agent output references and recheck source before promotion.

**Rationale**: `core/modeling/app-source.ts` supplies Dockerfile classification and non-modelable reporting. `core/modeling/app-staging.ts`, `promote-app-model.mjs`, and `validate-bicep.mjs` already guard staged output and bounded authoring repair. The clarified spec requires explicit classification and broader source fencing; an agent completion message cannot substitute for those checks.

**Required check classes**: Authorized path/input closure; modelability for authoring; complete staged artifact set and provenance; selected Radius type/recipe consistency; Bicep compilation; source-reference validity; and unchanged original inputs before replacement. Existing safety checks cannot become advisory because a dependency is unavailable.

**Advisory check classes**: Optional descriptive enrichment or non-blocking usability suggestions only. No cloud deployment or live provisioning is introduced into standalone validation. Deployment permissions and environment protections remain execution prerequisites, not proof supplied by validation.

The current authoring skill requires compiler validation without warnings, type/schema evidence, recipe/environment evidence, secure secret parameters, build/runtime correctness, and valid source references. Keep existing blocking diagnostics required; the new advisory classification does not downgrade those checks. Add advisory warnings only for explicitly non-blocking checks.

**Alternatives considered**: Calling incomplete validation successful is unsafe. Blocking on every optional enrichment would exceed the user's selected policy. Replacing the existing authoring scripts wholesale would discard already tested safeguards.

**Existing repair limit**: `core/modeling/app-staging.ts` declares `REPAIR_ATTEMPT_BUDGET = 5` and `REPAIR_COMPILE_LIMIT = 6` (the initial compile plus five repairs), explicitly aligned with the deploy repair-cycle cap. Preserve that ceiling in the new policy; distinguish repair cycles from delivery retries of an agent handoff. A caller may request fewer attempts or manual-only repair, not exceed the policy ceiling.

## 7. Workflow ownership and completion evidence

**Decision**: Extend the extension-owned dispatcher/provider workflows and result readers together to carry operation identity, attempt identity, expected commit, and phase outcomes. Preserve legacy inputs through explicit translation; new lifecycle operations use reviewed builders, not arbitrary shell strings.

**Rationale**: `.github/extension/run-rad-commands.yml` currently accepts `environment`, `image`, and `rad_commands`. Provider workflows use the selected workflow revision, OIDC identity, and repository-wide concurrency with cancellation disabled. Existing progress identifies application/environment/run/sequence, but not every new contract identity. Existing command results do not alone prove durable-state save succeeded.

`restore-state/action.yml` marks restoration successful only after startup. `teardown/action.yml` guards shutdown on that marker to avoid overwriting state after failed restore. Those protections must survive the migration. Final lifecycle completion needs separate state-save and cleanup evidence, not a successful earlier deploy-progress snapshot.

The current teardown propagates a real `rad shutdown` failure but runs application-status inspection and cluster deletion best-effort. New evidence must explicitly capture those additional outcomes instead of equating the surrounding cleanup shell's success with successful cleanup. Provider workflows currently publish deployment progress before teardown, which is why the new final evidence must be separate.

**Upstream evidence**: Radius [`pkg/cli/cmd/shutdown/shutdown.go`](https://github.com/radius-project/radius/blob/1d218580e2eee9ea0ccc99bda647891fac29dd0a/pkg/cli/cmd/shutdown/shutdown.go) returns errors from database backup, Terraform backup, and archive commit/push. It explicitly does not delete the cluster. Therefore the extension can capture shutdown as state-save evidence and cleanup as a separate phase; this design does not assume an unimplemented new Radius endpoint. Verify these behaviors against the pinned executable used by the release.

**Alternatives considered**: Treating command success as deployment success loses state-save failures. Parsing log words as authority is unreliable. Copying extension workflow responsibilities into the Radius repository reverses current ownership.

## 8. Dispatch ambiguity and concurrency

**Decision**: Generate an operation/attempt pair before dispatch and include it in the workflow run name and execution evidence. Match run discovery on exact identity, repository, source, and environment. A timeout without a unique matching run remains unconfirmed; do not retry dispatch automatically.

**Rationale**: GitHub dispatch and observation are separate interactions. A missing response does not prove no run exists. Current provider workflow concurrency is conservative and must remain until finer state-scope concurrency is explicitly proven safe. No distributed exactly-once guarantee is claimed.

**Alternatives considered**: Selecting the newest run can select another caller's mutation. Immediately retrying a timed-out dispatch can deploy twice. Narrowing concurrency to application alone can overlap mutations sharing a state archive.

## 9. Authorization and destructive actions

**Decision**: Keep caller identity and credential handles out of public messages. Inject an authorization port backed by current GitHub/cloud identity handling. Bind approvals to action, target, and source. Retain existing setup controls and map only supported semantics into the new operation contract.

**Rationale**: Existing App setup already distinguishes stop, continue, cancel-workflow, rollback, exit, and retry. A generic cancellation must not conflate these. Environment teardown validates a typed phase plan and shared-resource ownership before each mutation. Read operations still enforce access, and unavailable identity cannot be inferred as permission.

**Alternatives considered**: A public `approved: true` flag is not authority. Treating application deletion as permission to remove environment identity or state exceeds the approved target.

**Observed status-side mutation**: `server/routes/deployments.ts::handleDeployStatus` calls `triggerDeployRepairHandoff(entry, context.instanceId)` and separately calls `triggerDeployFailureNotice`. The former must move out of the polling path; the latter is not evidence that repair is already read-only. Existing `server/routes/operations-status.ts` provides a separate read-only setup observation seam.

**Existing orchestration to extract**: `server/routes/create-environment.ts` and its verification/workflow-publishing helpers, `server/services/environment-deletion.ts`, and graph/deployment route families are the migration starting points. Move shared decisions behind core ports while retaining host prompts, existing testable helpers, route ownership, and safe projections in their current adapters.

## 10. Compatibility, release, and tests

**Decision**: Keep v1 and legacy readers through migration and at least one published plugin release after a replacement contract version is available with deprecation guidance. Do not retire an execution decoder needed by a known in-flight operation. Switch each mutation path exactly once; keep a residual fallback inventory until it is empty.

**Rationale**: `runtime/declarations.ts` and `SERVER_ROUTE_DECLARATIONS` are the live compatibility sources. The design's historical route count is not today's inventory. Existing test requirements CA-05/CA-06, TL-02/TL-05/TL-07 through TL-11, RF-01 through RF-09, LC-10 through LC-17, and CN-01 through CN-08 remain applicable, with explicit updated fixtures for intentional safety changes.

`packages/adapter-canvas/build.mjs` now assembles the plugin under `.artifacts/radius`; `extensions/radius/package.json` is the `radius` release manifest. The source plugin metadata is under `plugins/radius`. Preserve that current layout rather than old documentation's build destination.

**Alternatives considered**: Silent schema replacement breaks installed plugins and in-flight results. Dual-running writes to compare paths is unsafe. A CLI implementation is not needed to prove the shared service can run through a fake host and the real App runtime without a panel.

## Resolution Status

All design unknowns needed for task decomposition are resolved above. Runtime availability of provider capabilities is represented explicitly, not treated as an unanswered design question. Dependency versions will be locked when dependencies are added; no production package is changed by planning. Performance SLOs, additional transports, CLI delivery, and general restart recovery remain excluded or deferred by the spec rather than pending decisions for this release.
