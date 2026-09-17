---
description: "Executable task list for the shared Radius lifecycle contract and Copilot App migration"
---

# Tasks: Frontend-Neutral GitHub Radius

**Input**: Design documents in `specs/001-frontend-neutral-radius/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), and [contracts](contracts/lifecycle.md).

**Tests**: Required by the specification's conformance requirements and repository engineering policy. Every production logic change includes collocated unit tests and every applicable boundary layer from [conformance.md](contracts/conformance.md). Write regression/acceptance assertions before implementing the behavior; demonstrate the behavioral failure where an executable seam exists, not merely an import error. Land tests and production changes together.

**Organization**: Setup, foundation, four P1 stories in specification order (US1, US2, US3, US5), four P2 stories (US4, US6, US7, US8), then cross-cutting completion. Story numbers always refer to the specification, not phase numbers.

**Scope**: Shared lifecycle contract and Copilot App only. Do not implement a CLI, hosted service, general operation-history database, distributed coordination, or new restart-recovery guarantees. Existing persisted setup behavior and remote Radius state remain protected.

## Format: `[ID] [P?] [Story] Description`

- `[P]` identifies tasks that can run together in the named parallel batch after their phase prerequisites are satisfied. It does not waive a dependency or permit concurrent edits to shared files.
- `[US1]` through `[US8]` map directly to the specification's user stories.
- Paths are repository-relative; an unqualified filename refers to the same directory as the preceding full file path. New files are proposed implementation destinations; reuse an existing equivalent helper instead of creating a duplicate and update the task's recorded destination if needed.
- Each task's collocated unit tests must cover success, failure propagation, relevant branches, cleanup, and boundaries. Story-level boundary tests supplement rather than replace those tests.
- A story checkpoint includes its required built-extension smoke and browser/accessibility/keyboard evidence when the changed seam requires them. Do not defer all boundary coverage to the final phase.
- Shared composition roots, manifests, route tables, script entry points, and broad journey files have one writer at a time. Parallel work joins before editing those files.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the supported baseline, dependency changes, public package entry, and test discovery without changing existing lifecycle behavior.

- [X] T001 [P] Capture current tool/action/page and exact route declarations plus legacy workflow/result versions in `packages/adapter-canvas/test/fixtures/lifecycle/compatibility-baseline.ts`; use `packages/adapter-canvas/src/runtime/declarations.ts` and `packages/adapter-canvas/src/server/route-table.ts`, not the historical 40-route count.
- [X] T002 Add the planned type-only `json-schema-to-ts` and Ajv validation dependencies to `packages/core/package.json` and `packages/adapter-shared/package.json`, lock compatible versions in `pnpm-lock.yaml`, and restore dependencies without changing the SDK or Node pins.
- [X] T003 Add the `@radius-project/core/lifecycle` export in `packages/core/package.json` and its versioned entry in `packages/core/src/lifecycle/index.ts`; add `index.test.ts` coverage proving it imports without SDK, HTTP, filesystem, or browser dependencies.
- [X] T004 [P] Verify lifecycle unit and existing boundary-test discovery in `packages/core/vitest.config.ts`, `packages/adapter-shared/vitest.config.ts`, and `packages/adapter-canvas/vitest.config.ts`; add inclusions only where needed and preserve root `vitest.config.ts` coverage floors without adding redundant suites.

**Checkpoint**: Dependencies and the public entry are coherent; existing tests remain discoverable; baseline fixtures describe current behavior rather than freeze removed declarations.

**Validation status (2026-09-15)**: T001-T004 are implemented. The compatibility fixture captures seven tools, two actions, seven pages, and 52 ordered routes across nine owners, with 11 passing runtime assertions. Frozen dependency restoration, 132 focused core/export/boundary assertions, 17 built-extension assertions, and 16 dedicated Windows process assertions pass. The new version entry has 100% measured coverage. The user-approved Windows storage corrections preserve real round trips and explicit failures, test requested permissions on Windows and actual permissions on POSIX, and add the storage suites to scheduled reliability coverage. The complete Linux Node coverage gate passes without changing coverage floors: 10,952 passed and 34 intentionally skipped assertions across 312 discovered files. Linux verification used a non-root, isolated Node 24.13.1 container with copied workspace files and its own Git metadata and dependencies; it did not modify the Windows installation. In the pinned CI Playwright image, 30 browser component tests and 73 Chromium cases pass with zero retry-only passes, using the same setup snapshot. These results do not claim real-host or live-cloud qualification.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared message shapes, trusted context, source safety, operation ownership, and action-response primitives needed by multiple stories.

**Gate**: Complete T001-T017 before beginning story implementation. This phase does not claim any unimplemented operation is available.

- [X] T005 Define common draft-07 schema data and inferred types for targets, sources, provenance, observations, operation/action records, validation reports, and errors in `packages/core/src/lifecycle/contracts/common.ts` with `common.test.ts`, following `specs/001-frontend-neutral-radius/data-model.md`.
- [X] T006 Define all 21 operation-specific request/result unions in `packages/core/src/lifecycle/contracts/catalog.ts` with `catalog.test.ts`; enforce operation-required fields, authored application inspection with source/definition but no environment, an explicit environment for deployed observations, closed authority-sensitive inputs, independently authorized diff sources, and declared pagination bounds; export through `packages/core/src/lifecycle/index.ts`.
- [X] T007 Implement context-owned schema validators in `packages/adapter-shared/src/lifecycle/validation.ts` with `validation.test.ts`; reject unsupported versions and malformed variants without coercion, defaults, remote schema loading, or silent unknown-operation acceptance; publish through `packages/adapter-shared/src/index.ts` with public-consumer coverage in `index.test.ts`.
- [X] T008 Define narrow source, graph, environment, identity, workflow, agent, registry, clock, and diagnostics ports in `packages/core/src/lifecycle/ports.ts` and explicit failure helpers in `errors.ts` with `errors.test.ts`; distinguish absence, unavailability, and forbidden access.
- [X] T009 Implement deterministic effective-input manifests and source expectation policy in `packages/core/src/lifecycle/source.ts` with `source.test.ts`; cover referenced modules/configuration/artifacts and added/deleted inputs, treating an unestablished closure as incomplete rather than unchanged.
- [X] T010 Implement authorized worktree/remote snapshots in `packages/adapter-shared/src/lifecycle/source-access.ts` with `source-access.test.ts`; preserve uncommitted input bytes and exact commits, reject traversal/drive/UNC/symlink/junction escape, and clean temporary snapshots on success, failure, and cancellation.
- [X] T011 Bind trusted caller identity and operation/target/source approval checks in `packages/adapter-canvas/src/runtime/lifecycle-authorization.ts` with `lifecycle-authorization.test.ts`, reusing existing identity helpers and rejecting public credential or `approved` claims.
- [X] T012 Implement an injected session registry and operation state/observation reducer in `packages/core/src/lifecycle/operations.ts` with `operations.test.ts`; keep run/attempt IDs distinct, permit evidence-based fast completion, fence late results, and do not add global state or durable history.
- [X] T013 Implement outstanding-action creation and guarded response consumption in `packages/core/src/lifecycle/actions.ts` with `actions.test.ts`; bind responder, operation, target, source, and response kind, reject stale/repeated answers, and revalidate preconditions before continuation.
- [X] T014 Implement the typed service dispatcher and explicit capability registration in `packages/core/src/lifecycle/service.ts` with `service.test.ts`; reject missing dependencies for advertised operations during construction and expose intentionally unsupported operations as declared limitations, never fallback success.
- [X] T015 Construct the session lifecycle context and additive `radius_lifecycle` tool with the foundation's `operation.respond` handler in `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts`, `packages/adapter-canvas/src/runtime/declarations.ts`, `packages/adapter-canvas/src/runtime/create-radius-tools.ts`, and `packages/adapter-canvas/src/extension.ts`; establish per-family routing guards in `packages/adapter-canvas/src/runtime/lifecycle-routing.ts` before changing existing mutation bindings, rejecting transitions that lose or redispatch known operations; add collocated tests for routing, trusted context, expected-source preservation, guarded responses, zero panel/server creation, keepalive, and shutdown.
- [X] T016 Bridge `packages/adapter-canvas/src/operations.ts` and `packages/adapter-canvas/src/operation-store.ts` persistence through `packages/adapter-canvas/src/runtime/lifecycle-setup-store.ts` with `lifecycle-setup-store.test.ts`; preserve setup/deletion resume and control semantics, retain compatible reader/control paths during routing transitions, and reject transitions that orphan known records without claiming those records represent every deployment.
- [X] T017 Add strict typed fake ports and conformance support in `packages/adapter-canvas/test/support/lifecycle.ts` with `lifecycle.test.ts`, plus foundation registration/lifetime and guarded cutover/rollback checks in `packages/adapter-canvas/test/integration/runtime/lifecycle-foundation.test.ts`; prove known legacy and new operations remain addressable without duplicate execution before any mutation cutover, and run affected runtime and built-extension smoke through `packages/adapter-canvas/test/integration/artifact/built-extension.test.ts`.

**Checkpoint**: A real App runtime can invoke the shared dispatcher without a Canvas. Supported operations have complete dependencies; unavailable operations fail explicitly. Shared action primitives are ready for authoring and setup before the full repair/control story. Per-family routing guards and compatible reader/control retention are prerequisites for every later mutation cutover, not deferred US8 deliverables.

**Earlier T005-T008 checkpoint**: The shared public validator entry, schemas, and failure helpers passed their focused checks with 100% measured coverage of new production code. That snapshot passed root typecheck, lint, formatting, the complete Linux Node coverage gate (11,099 passed, 34 skipped), and 17 built-extension assertions. It did not yet include the App binding; schema availability alone was not an executable-operation claim.

T009's pure manifest and source-expectation policy is also implemented, with 55 source-policy assertions and 100% changed-code coverage. The combined focused lifecycle/public-entry/package-boundary run passes 267 assertions after adding public validation regressions without changing the existing schema grammar. This pure policy does not itself discover dependencies or capture filesystem snapshots.

T010 is implemented through a context-owned `SourceReadAdapter`, with separate filesystem and closure helpers. Its 128 focused assertions cover exact bytes, authorization, source races, links/junctions, limits, cancellation, retryable cleanup, and concurrent release/shutdown. The integrated Linux snapshot passes 11,308 Node assertions (34 skipped) and 17 built-extension assertions with unchanged coverage floors. Windows targeted coverage is 100% functions, 99.61% lines, 99.46% statements, and 99.15% branches. The remaining paths are invariant defenses: `source-access-closure.ts:331` cannot miss its private cache entry after setting it; `source-access-files.ts:181` cannot fall through a nonempty validated path loop and `:291` cannot escape after lexical confinement; `source-access.ts:357` cannot reach an unmatched source-kind branch after paired authority validation. No coverage exclusions or test-only hooks were added to force those paths.

**Completed foundation**: T001-T017 are implemented and verified.

**Completed scope**: T001-T078 are complete. The user authorized T068-T078 on 2026-09-17, and the environment and credential setup checkpoint passed its same-source quality, boundary, browser, and artifact gates. Implementation stops here; T079-T116 remain outside the authorized implementation scope.

The final integrated snapshot passes frozen dependency restoration, typecheck, lint, formatting, the full Linux Node coverage gate (11,433 passed, 34 skipped), build, 17 built-extension assertions, 16 Windows process assertions, 30 browser component tests, and 73 Chromium cases with zero retry-only passes. Coverage floors are unchanged. Operations, actions, service, authorization, binding, and routing have 100% measured coverage. Additional invariant defenses remain unexecuted in `declarations.ts:219,225` because the fixed catalog supplies object targets with required arrays, and in `lifecycle-setup-store.ts:72,85` because the existing client-view/action projectors construct their own validated descriptors; malformed public messages cannot reach those branches.

The `radius_lifecycle` tool includes the `operation.respond` handler, but handler registration is not authority. Current production host approval, agent-outcome verification, and workspace-source prerequisites return `CAPABILITY_UNAVAILABLE` when no trusted seam exists; the specific safe explanation is included in public error diagnostics. Guarded success is exercised with injected trusted contexts. Existing mutation writers remain on legacy routing, and no full-feature, real-host, or live-cloud qualification is claimed.

## Phase 3: User Story 1 - Discover Applications and Available Actions (Priority: P1)

**Goal**: Discover authorized applications/environments and their evidence, and expose truthful capabilities without a panel.

**Independent Test**: Use controlled authored/deployed observations and different caller permissions; list/inspect through the service and App without mutations, distinguishing empty, stale, incomplete, and unavailable results.

**Prerequisites**: Foundation only. This is the suggested MVP.

### Tests for User Story 1

- [X] T018 [P] [US1] Add capability/discovery service cases in `packages/core/src/lifecycle/discovery.test.ts` for authored inspection when no environment exists, explicit environment scope for deployed observations, rejection when neither source/definition nor environment is selected, authored versus deployed evidence, same names across scopes, empty versus unavailable results, observation freshness, access denial, and pagination/cursor boundaries.
- [X] T019 [P] [US1] Add panel-free App and legacy-listing contracts in `packages/adapter-canvas/test/integration/runtime/lifecycle-discovery.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-discovery.test.ts`; include authored inspection without an environment through the App and require zero source publication, interactive login, deployment, or server startup on the tool path.

### Implementation for User Story 1

- [X] T020 [US1] Implement `capabilities.get` in `packages/core/src/lifecycle/capabilities.ts` with `capabilities.test.ts`; disclose operation/version/context/provider/agent support without treating availability as authorization.
- [X] T021 [US1] Implement `application.list` and `application.inspect` in `packages/core/src/lifecycle/discovery.ts`; support authorized source/definition inspection without an environment, require an explicit environment for deployed observations, and reject inspection requests selecting neither; retain separate authored/deployed evidence, explicit scope, observation time, completeness, and missing-versus-unavailable semantics.
- [X] T022 [US1] Bind application evidence reads in `packages/adapter-shared/src/lifecycle/application-read.ts` with `application-read.test.ts`, injecting existing GitHub/Radius executors and rejecting malformed/forbidden results instead of returning empty-success fallbacks.
- [X] T023 [US1] Implement `environment.list`/`environment.inspect` and their concrete reads in `packages/core/src/lifecycle/environments-read.ts` and `packages/adapter-shared/src/lifecycle/environment-read.ts`, with collocated tests for caller visibility, actual recipe registrations, partial evidence, and no mutation.
- [X] T024 [US1] Register implemented discovery handlers in `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts` and extend its unit tests; resolve current-session context explicitly and advertise only capabilities whose prerequisites exist.
- [X] T025 [US1] Delegate existing application/environment listings through shared read services in `packages/adapter-canvas/src/server/routes/deployments.ts` and `packages/adapter-canvas/src/server/routes/environments.ts`; preserve each route's established serialization and expose unavailable evidence through tested legacy mappings.
- [X] T026 [US1] Complete the T018-T019 assertions, run discovery unit/runtime/HTTP and required built-extension smoke, and record the independently runnable MVP scenario in `specs/001-frontend-neutral-radius/quickstart.md`.

**Checkpoint**: Discovery works without any deployment or authoring implementation. Unsupported capabilities remain explicit; this milestone is not the full-release acceptance claim.

**Discovery checkpoint complete**: T018-T026 are implemented. Legacy listings use the same core factories and shared adapters as lifecycle requests, with explicit compatibility serialization and production-boundary failure tests. Both canonical definitions are covered; discovery reports partial, not recursive, coverage. The final snapshot passes Linux frozen dependency restoration, typecheck, lint, formatting, full Node coverage (11,671 passed, 34 skipped), build, and 17 built-extension assertions. Dedicated Windows process suites pass 16 assertions. The pinned browser environment passes 30 component tests and all 73 Chromium cases with retries disabled and zero retry-only passes. Nine earlier browser failures were corrected by replacing outdated TSV fixtures with finite canonical read responses and synchronizing an existing planned-page reload; user-visible assertions and production behavior were not weakened. The runnable MVP and residual compatibility paths are recorded in `quickstart.md` and `contracts/conformance.md`.

Discovery's reachable behavior is covered without ignores or lower thresholds. Remaining defensive paths are `workspace-source.ts:111-112,173` (synchronous upstream cancellation and validated manifest invariants), `github-source.ts:92,116,226` (private control/root attestations and unreachable workspace dispatch), and `discovery-reader.ts:141,152,159-170,179,245,249` (unused required forwarding, context/scope checks, normalized absence, and same-inspection metadata invariants). An earlier additional Windows artifact run failed an installer directory rename with `EPERM` (16 passed, one failed); that failure remains recorded and was not retried or masked. The required Linux artifact gate passes. Actual recipe evidence and dependent planned graphs remain explicitly unavailable where no read-only evidence channel exists, as approved by the user.

## Phase 4: User Story 2 - Understand and Compare the Correct Application (Priority: P1)

**Goal**: Resolve authored/planned/deployed graphs and comparisons from the right source without publishing anything.

**Independent Test**: Use uncommitted supporting-file changes, independent remote base/head commits, and two environments with different recipe registrations. Verify provenance, semantic diff, unavailable-source reporting, and zero mutation.

**Prerequisites**: Foundation and US1's environment/evidence read adapters. No deployment or authoring implementation is required; use existing definitions and observed deployment fixtures.

### Tests for User Story 2

- [X] T027 [P] [US2] Add graph/diff/planned service cases in `packages/core/src/lifecycle/graphs.test.ts` for canonical equivalence, both source provenances, absent/unavailable definitions, real environment registrations, and missing known-type recipes.
- [X] T028 [P] [US2] Add worktree/remote/PR-diff boundary cases in `packages/adapter-canvas/test/integration/runtime/lifecycle-graphs.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-graphs.test.ts`, including zero source writes/commits/pushes and preservation of the PR description when comparison is unavailable; add a controlled fork-source fixture that inspects the compilation context for absence of deployment credentials and rejects any privileged workflow dispatch.

### Implementation for User Story 2

- [X] T029 [US2] Add typed graph/provenance projection in `packages/core/src/lifecycle/graph-result.ts` with `graph-result.test.ts`, reusing `packages/core/src/graph/appgraph.ts`, `packages/core/src/graph/model.ts`, and `packages/core/src/graph/diff.ts` without redefining Radius hashes or introducing new unchecked casts.
- [X] T030 [US2] Bind isolated canonical graph execution in `packages/adapter-shared/src/lifecycle/graph-execution.ts` with `graph-execution.test.ts`, reusing `packages/adapter-shared/src/rad.ts` temporary working directories, managed binaries, and cleared `GITHUB_ACTIONS`; separate authorized source fetching from compilation, prevent deployment credentials from reaching compilation of untrusted inputs including forks, and prohibit privileged workflow dispatch; test the credential boundary, cleanup, and no graph-archive publication.
- [X] T031 [US2] Add typed actual-environment recipe resolution in `packages/core/src/lifecycle/recipe-registrations.ts` with `recipe-registrations.test.ts`, consuming T023's read port and existing recipe parsers rather than substituting provider defaults or inventing recipes.
- [X] T032 [US2] Implement `graph.get` and `graph.diff` orchestration in `packages/core/src/lifecycle/graphs.ts`; resolve both sources independently, distinguish graph kinds, attach observation/provenance, and return unavailable comparisons without authoring or publication.
- [X] T033 [US2] Bind graph handlers and adapt `radius_generate_pr_diff_markdown` in `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts` and `packages/adapter-canvas/src/runtime/create-radius-tools.ts`; preserve explicit committed refs for the retained PR-diff tool and omit graph Markdown when unavailable.
- [X] T034 [US2] Delegate graph/planned/diff HTTP orchestration through shared services in `packages/adapter-canvas/src/server/routes/graphs-planning.ts` and `packages/adapter-canvas/src/server/routes/graph-workflows.ts`; preserve methods, stream framing, route ownership, terminal frames, and explicit error behavior.
- [X] T035 [US2] Adapt provenance/unavailable/planned-result rendering in `packages/adapter-canvas/src/pages/graph-page.ts`, `packages/adapter-canvas/src/pages/planned-graph-page.ts`, and `packages/adapter-canvas/src/pages/graph-diff-page.ts`, with corresponding unit/HTTP state tests using the existing serialized-state helpers.
- [X] T036 [US2] Preserve graph source-reference token fencing in `packages/adapter-canvas/src/runtime/create-radius-extension.ts` and `packages/adapter-canvas/src/runtime/create-radius-tools.ts` with collocated tests; do not let a stale source-link response mutate a newer graph context.
- [X] T037 [US2] Add graph/planned/diff browser failure and stale-result cases beside `packages/adapter-canvas/src/browser/pages/graph-page.ts`, `planned-graph-page.ts`, and `graph-diff-page.ts`, and affected critical journey/accessibility/keyboard cases in `packages/adapter-canvas/test/e2e/canvas-chromium.test.ts`.
- [X] T038 [US2] Complete graph unit/runtime/HTTP, affected browser layers, and built-extension smoke; document the independent graph scenario and current fallback inventory in `specs/001-frontend-neutral-radius/quickstart.md` and `specs/001-frontend-neutral-radius/contracts/conformance.md`.

**Checkpoint**: Graph reads work on real source snapshots without generating a model, committing/pushing, opening a required panel, or inferring a deployment from an authored graph.

**Graph checkpoint complete**: T027-T038 are implemented and verified. The final immutable snapshot passes Linux frozen dependency restoration, typecheck, lint, formatting, the full Node coverage gate (11,892 passed, 40 skipped), build, and 17 built-extension assertions. The pinned browser environment passes 30 component tests and all 75 Chromium cases with retries disabled and zero retry-only passes. Dedicated Windows process integration passes 16 assertions. HTTP 409 supersession and 400 external-failure contracts are restored, SSE retains one terminal outcome, and inert registry strings no longer masquerade as compiler dependencies. Worktree refresh observes supporting and binary inputs without compiling or authoring. Exact-run retained monitoring remains distinct from unavailable canonical deployed evidence.

The core graph modules, lifecycle binding/graph registration, graph route/workflow modules, and source-reference module have 100% measured coverage across all metrics. Reachable changed runtime/process branches are covered across Windows and Linux; single-platform reports do not claim the other platform's branches. Remaining invariant defenses are `rad-process.mjs:191` (settled private stop cannot reenter after removing its callers), `create-radius-canvas.ts:385` (same-token synchronous setter), `graph-execution.ts:132-133` (incomplete captures are not compilable snapshots), and `source-access-closure.ts:400` (already-populated private map). Untouched historical gaps are not claimed as new coverage. No coverage floors, exclusions, or schemas were weakened.

The 40 Linux skips comprise 21 Windows-only cases, two Darwin-only cases, 16 existing live opt-ins, and one explicit Windows/native-tools qualification opt-in. The added Windows graph/process cases passed separately on Windows. A checked-in local-archive model with inert recipe metadata also compiled through real source capture and owned Radius v0.60.2/Bicep 0.42.1 tools. Genuine registry dependencies, unsupported closures, and incompatible Windows cache configuration remain unavailable; captured source/configuration is not rewritten. Planned/deployed production evidence remains unavailable when its read-only channel is absent. These limits and the runnable scenario/fallback inventory are in `quickstart.md` and `contracts/conformance.md`; this milestone is not real-host, live-cloud, or registry-restoration qualification.

**Completed T038 checkpoint**: T001-T038 are checked. The next authorized scope is T039-T050; T051-T116 remain outside it. No implementation hooks are configured, and no implementation commits or pushes were made.

## Phase 5: User Story 3 - Author and Validate Definitions Without Losing Work (Priority: P1)

**Goal**: Author guarded proposals and validate definitions without losing concurrent work or treating unavailable required checks as success.

**Independent Test**: Author in an isolated workspace while a referenced input changes; verify refusal to replace. Validate with no agent, required-check unavailability, and advisory-only unavailability.

**Prerequisites**: Foundation's source, action, and authorization primitives. Existing validation/type/recipe helpers supply controlled evidence; no US2 graph service or deployment is required.

### Tests for User Story 3

- [X] T039 [P] [US3] Add required/advisory and authoring-state cases in `packages/core/src/lifecycle/validation-policy.test.ts` and `authoring.test.ts`; cover pass/fail/unavailable/skipped reduction, unchanged-source checks, missing agent capability, and no commit/push/deploy.
- [X] T040 [P] [US3] Add staging/snapshot/validator boundary cases in `packages/adapter-shared/src/lifecycle/definition-validation.test.ts` and `definition-promotion.test.ts`; include added/deleted/changed modules/configuration, malformed staged references, failure rollback, and cleanup.
- [X] T041 [P] [US3] Add App authoring/validation/action-handoff contracts in `packages/adapter-canvas/test/integration/runtime/lifecycle-authoring.test.ts`, preserving current modelability refusals, attempt fencing, and standalone validation without an agent.

### Implementation for User Story 3

- [X] T042 [US3] Implement predeclared validation classifications and report reduction in `packages/core/src/lifecycle/validation-policy.ts`; retain existing blocking compiler/type/source warnings as required and allow only explicitly non-blocking advisory warnings.
- [X] T043 [US3] Implement the no-agent validation binding in `packages/adapter-shared/src/lifecycle/definition-validation.ts`, reusing `extensions/radius/skills/radius-app-bicep/scripts/validate-bicep.mjs` and existing schema/recipe helpers; report performed/unavailable checks without changing source or contacting live cloud in tests.
- [X] T044 [US3] Strengthen guarded promotion in `packages/core/src/modeling/app-staging.ts`, `packages/adapter-shared/src/lifecycle/definition-promotion.ts`, and `extensions/radius/skills/radius-app-bicep/scripts/promote-app-model.mjs`; bind the effective-input manifest to validation and recheck before all replacement, with corresponding collocated/executable boundary tests.
- [X] T045 [US3] Implement the operation/action-bound authoring agent bridge in `packages/adapter-canvas/src/runtime/lifecycle-agent.ts` with `lifecycle-agent.test.ts`; keep skill discovery host-specific, authenticate completion, and reject arbitrary/stale staged-output references.
- [X] T046 [US3] Implement `definition.author` in `packages/core/src/lifecycle/authoring.ts`, reusing modelability, staging, and custom-type/recipe rules; require agent/workspace capability, valid required checks, current approval, and unchanged original inputs before promotion.
- [X] T047 [US3] Implement `definition.validate` in `packages/core/src/lifecycle/definition-validation.ts` with `definition-validation.test.ts`; support authorized workspace/remote sources, return `passed`, `failed`, or `incomplete`, disclose advisory warnings separately including when the status is `passed`, and never imply deployment success.
- [X] T048 [US3] Register author/validate handlers and retain `radius_generate_app`/`radius_report_modeling_failure` behavior through `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts` and `packages/adapter-canvas/src/runtime/create-radius-tools.ts`; require T015-T017's routing guards to pass before switching the authoring binding, with regression tests for repeated and superseded agent reports.
- [X] T049 [US3] Update the authoring handoff instructions in `extensions/radius/skills/radius-app-bicep/SKILL.md` to use trusted action outcomes and required/advisory semantics while preserving the five-repair/six-compile ceiling and separate publication/deployment authorization.
- [X] T050 [US3] Complete T039-T041, promotion/validator executable cases, targeted coverage, and built-extension smoke; update the independent authoring/validation scenario in `specs/001-frontend-neutral-radius/quickstart.md`.

**Checkpoint**: Validated unchanged proposals may replace working definitions; missing required evidence or concurrent edits never do. Standalone validation remains agent-free and read-only.

**Completed authoring checkpoint**: The final isolated snapshot passes Linux typecheck, lint, formatting, full coverage (12,639 passed, 47 intentionally skipped), build, and 18 built-extension assertions. The same snapshot passes 30 component tests and all 75 Chromium cases with retries disabled; dedicated Windows process suites pass 16 assertions. The CLI suite additionally passes 30 executable cases on Windows, with one native-tool opt-in skipped. Cross-platform executable coverage covers every statement, function, and branch in the new CLI verification functions, and the retained generation helper has complete coverage. No coverage floor was lowered. The generation tool now honors its selected writer, and the original begin/validate/origin/promote sequence obtains validation evidence through actual checks rather than manufactured hashes. Source/output drift, missing or replaced evidence, and changes during verification are rejected.

**Compatibility decision (2026-09-16)**: The user explicitly chose to preserve legacy CLI compiler/static validation, with source/output-change safeguards, while keeping canonical lifecycle requirements strict. Legacy sealing and promotion do not claim canonical runtime/Recipe validation or authenticated approval. Standalone canonical validation is production-wired; guarded authoring success is exercised with a trusted fixture host. Current-host canonical authoring remains unavailable because the SDK cannot prove source-bound approval or authenticated assignment/outcome, while the legacy writer remains usable. An accepted canonical operation never falls back to it.

**Closeout**: T001-T050 are checked; T051-T116 remain unchecked. No implementation hooks are configured, and no implementation commit or push was made. The verified source snapshot is `8923F1BEEBB141D39D0E749171A7EE0D8F48473D625A5448E9CF52937C5CBA1C`; final logs and coverage evidence are retained in the session files. This checkpoint does not claim real-host, live-cloud, or native legacy-workload qualification.

## Phase 6: User Story 5 - Deploy and Observe a Specific Revision Without a Panel (Priority: P1)

**Goal**: Dispatch one authorized published revision and observe trustworthy operation/phase evidence without a panel or polling-driven repair.

**Independent Test**: Use an existing preconfigured environment and published definition with controlled workflows. Exercise success, stale approval/source, ambiguous dispatch, state-save failure, missing observations, and unrelated concurrent runs.

**Prerequisites**: Foundation and US1's environment/evidence reads. US3 authoring and US4 environment creation are not required to deploy an already published definition into an existing environment.

### Tests for User Story 5

- [x] T051 [P] [US5] Add deployment/observation/outcome matrices in `packages/core/src/lifecycle/deployment.test.ts` and `execution-result.test.ts`; cover all execution evidence combinations, exact target/run/attempt identity, and 100 status reads with zero repair or redispatch.
- [x] T052 [P] [US5] Add executable workflow-evidence and guard cases in `.github/extension/actions/lifecycle-evidence/evidence_test.sh`; use fake commands to prove restore failure blocks deploy/save, command failure preserves save attempts, save/cleanup exit outcomes remain separate, and secret-bearing diagnostics are redacted.
- [x] T053 [P] [US5] Add panel-free deployment and legacy HTTP contracts in `packages/adapter-canvas/test/integration/runtime/lifecycle-deployment.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-deployment.test.ts`, including wrong revision, dispatch uncertainty, artifact mismatch, and unavailable phase details.

### Implementation for User Story 5

- [x] T054 [US5] Implement reviewed deployment command/target and completion-policy builders in `packages/core/src/lifecycle/deployment-policy.ts` with `deployment-policy.test.ts`; require published source, source-bound approval, and operation-specific required phases instead of accepting arbitrary shell input.
- [x] T055 [US5] Extend `.github/extension/run-rad-commands.yml`, `run-rad-commands-azure.yml`, and `run-rad-commands-aws.yml` with the five versioned lifecycle inputs, exact run correlation, and checked-out commit validation before protected execution; reject partial identity inputs and preserve existing concurrency/protections.
- [x] T056 [US5] Implement versioned identity/phase evidence helpers in `.github/extension/actions/lifecycle-evidence/evidence.sh` and wire T052's executable tests; validate repository/environment/application/run/attempt/source fields and initialize interrupted outcomes rather than optimistic success.
- [x] T057 [US5] Capture restore, save, and cleanup outcomes in `.github/extension/actions/restore-state/action.yml` and `.github/extension/actions/teardown/action.yml`; preserve the restore-success save guard and primary command failure, and report best-effort cleanup failure instead of swallowing its evidence.
- [x] T058 [US5] Thread supported operation/attempt identity through `.github/extension/actions/run-rad-commands/action.yml` and `.github/extension/actions/deploy-progress/progress.sh`; retain legacy decoding and add paired executable identity, sequence, cancellation, and redaction tests.
- [x] T059 [US5] Add final post-save/cleanup publication in `.github/extension/actions/publish-lifecycle-result/action.yml` and wire both provider workflows; publish `lifecycle-result.json` only as supported evidence and do not convert artifact-upload failure or missing final evidence into execution success.
- [x] T060 [US5] Update `packages/core/src/workflows/deploy.ts` and `deploy.test.ts` to generate the extended canonical templates with unchanged legacy inputs, pinned actions, and explicit typed operation intent; test missing templates and partial version support as hard failures.
- [x] T061 [US5] Implement the reusable workflow binding in `packages/adapter-shared/src/lifecycle/workflow-execution.ts` with `workflow-execution.test.ts`; inject existing executors, dispatch once, reconcile exact identities, bound read retries/rate-limit handling, and never select the newest unrelated run.
- [x] T062 [US5] Implement artifact validation and outcome reduction in `packages/core/src/lifecycle/execution-result.ts` and `packages/adapter-shared/src/lifecycle/execution-evidence.ts` with collocated tests; preserve confirmed workflow conclusions, primary/secondary failures, source mismatch, and current/stale/unknown observation distinctions.
- [x] T063 [US5] Implement `deployment.start`, `operation.get`, and `operation.list` in `packages/core/src/lifecycle/deployment.ts` and `operation-reads.ts`, with collocated tests for scope, pagination, required phase completion, no durable-history promise, and no mutation during observation.
- [x] T064 [US5] Bind deploy/status handlers and retained tool context in `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts`, `packages/adapter-canvas/src/runtime/create-radius-tools.ts`, and `packages/adapter-canvas/src/server/routes/deployments.ts`; require T015-T017's routing guards to pass before cutover, remove `triggerDeployRepairHandoff` from status reads, and retain pure failure reporting through explicit legacy result mappings.
- [x] T065 [US5] Render and announce uncertain/partial/failed phase results in `packages/adapter-canvas/src/pages/deploying-page.ts` and `packages/adapter-canvas/src/browser/pages/deploy-result-page.ts`; add unit, serialized-state HTTP, browser component/functional, and keyboard/accessibility cases for affected states.
- [x] T066 [US5] Complete producer/reader compatibility cases in `packages/adapter-canvas/test/integration/http/lifecycle-deployment.test.ts` and `.github/extension/actions/lifecycle-evidence/evidence_test.sh`; verify pinned execution capability before advertising v1 completion and require `.github/workflows/extension-selftests.yml` including uploader rebuild checks when affected.
- [x] T067 [US5] Run the deployment unit/runtime/HTTP, workflow-helper, affected browser/journey, and built-extension gates; record the exact panel-free deployment and 100-read outcome expectations in `specs/001-frontend-neutral-radius/quickstart.md`.

**Checkpoint**: US1 + US2 + US5 demonstrate discover, graph, deploy, and observe without Canvas. State-save failure cannot appear successful, and uncertain dispatch never automatically repeats.

## Phase 7: User Story 4 - Prepare Environments Without Deploying Accidentally (Priority: P2)

**Goal**: Inspect and explicitly configure identity/environments without causing an unintended deployment.

**Independent Test**: Use a controlled existing or new environment requiring identity input, change recipe registrations, and assert correct authorization plus zero implicit deployment.

**Prerequisites**: Foundation, US1 reads, and US5's typed execution/workflow intent. Reuse the foundation's action-response engine; do not depend on the later repair implementation.

### Tests for User Story 4

- [x] T068 [P] [US4] Add credential/environment service cases in `packages/core/src/lifecycle/credentials.test.ts` and `environments.test.ts` for inspection without login, explicit authentication, unsupported providers, partial configuration, identity failure, and no implicit deploy.
- [x] T069 [P] [US4] Add setup/configuration runtime and HTTP cases in `packages/adapter-canvas/test/integration/runtime/lifecycle-environments.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-environments.test.ts`, preserving current workflow-publishing, profile, and protected-environment behavior.

### Implementation for User Story 4

- [x] T070 [US4] Implement `credentials.inspect`/`credentials.configure` in `packages/core/src/lifecycle/credentials.ts`; keep inspection read-only, request explicit user authentication through the action engine, and verify actual identity rather than accept claimed completion.
- [x] T071 [US4] Bind scoped credential operations in `packages/adapter-canvas/src/runtime/lifecycle-credentials.ts` with `lifecycle-credentials.test.ts`, reusing GitHub/cloud credential helpers while preventing raw secret values in public results, prompts, graphs, and diagnostics.
- [x] T072 [US4] Implement `environment.create` in `packages/core/src/lifecycle/environments.ts`, with current permission/approval checks, provider capability validation, identity references, recipe registrations, and explicit partial/prerequisite outcomes.
- [x] T073 [US4] Implement `environment.configure` in `packages/core/src/lifecycle/environment-configuration.ts` with `environment-configuration.test.ts`; validate explicit patches, preserve omitted fields, and reject implicit application deployment or provider substitution.
- [x] T074 [US4] Extract reusable environment execution/publishing in `packages/adapter-shared/src/lifecycle/environment-configuration.ts` with collocated tests, injecting existing publishers and typed workflow intent; ensure legacy verification continuation cannot bypass separate deployment authorization.
- [x] T075 [US4] Route setup/credential/environment compatibility paths through services in `packages/adapter-canvas/src/server/routes/create-environment.ts` and owning identity/environment route handlers identified by `packages/adapter-canvas/src/server/route-table.ts`, preserving request/status/stream contracts and existing durable setup control.
- [x] T076 [US4] Wire required authentication/configuration actions into `packages/adapter-canvas/src/pages/environment-page.ts` and `packages/adapter-canvas/src/browser/environment/operations.ts` with collocated and HTTP state tests; preserve focus, serialization, navigation, and explicit continuation.
- [x] T077 [US4] Add create/configure/error/resume scenarios to `packages/adapter-canvas/test/e2e/canvas-chromium.test.ts` with controlled identity/workflow ports, automated accessibility, and keyboard coverage; assert configuration produces no deployment call.
- [x] T078 [US4] Complete environment unit/runtime/HTTP, affected component/Chromium, and built-extension evidence; update setup validation instructions in `specs/001-frontend-neutral-radius/quickstart.md` without claiming Azure/AWS feature parity.

**Checkpoint**: Users can prepare environments independently of deploying applications, with identity actions and partial failures visible.

## Phase 8: User Story 6 - Respond, Repair, and Cancel Deliberately (Priority: P2)

**Goal**: Expose authenticated user/agent responses, bounded linked repair, and honest cancellation across the App's tools and controls.

**Independent Test**: Use outstanding actions, a failed operation, and a running operation; exercise wrong responder/source, repeated responses, exhausted repair budget, and cancellation request versus confirmation.

**Prerequisites**: Foundation, US3 agent/promotion integration, US5 execution/observation, and US4's setup controls. The generic action engine already exists; this story completes repair and cross-surface control, not a second response engine.

### Tests for User Story 6

- [ ] T079 [P] [US6] Add repair/cancellation service matrices in `packages/core/src/lifecycle/repair.test.ts` and `cancellation.test.ts`; cover linked IDs, inherited budgets, manual/explicit automatic policy, missing capabilities, terminal races, and no implied publication or rollback.
- [ ] T080 [P] [US6] Add response/control runtime and HTTP contracts in `packages/adapter-canvas/test/integration/runtime/lifecycle-controls.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-controls.test.ts`; include unauthorized/stale/wrong-kind outcomes and repeated status reads that start no agent work.

### Implementation for User Story 6

- [ ] T081 [US6] Implement `operation.repair` in `packages/core/src/lifecycle/repair.ts`; preserve the original failed operation, link new attempts, enforce the shared five-cycle ceiling without resetting consumed budget, and require separate publish/redeploy authorization.
- [ ] T082 [US6] Implement `operation.cancel` in `packages/core/src/lifecycle/cancellation.ts` and extend `packages/adapter-shared/src/lifecycle/workflow-execution.ts` with targeted cancellation; distinguish requests from confirmed cancellation and retain known cleanup/state outcomes.
- [ ] T083 [US6] Extend `packages/adapter-canvas/src/runtime/lifecycle-agent.ts` and its tests for authenticated repair outcomes against the approved source, guarded staged replacement, failure redaction, cancellation, and handoff-delivery retries distinct from repair cycles.
- [ ] T084 [US6] Register repair/cancel handlers and extend the existing response binding in `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts`; route user decisions and trusted agent outcomes through the foundation's single action engine with unchanged-source and environment approval rechecks.
- [ ] T085 [US6] Adapt existing setup operation controls in `packages/adapter-canvas/src/server/routes/operations-control.ts` and `operations-status.ts` with their collocated tests; preserve stop/continue/cancel-workflow/rollback/exit distinctions and map only semantically supported actions.
- [ ] T086 [US6] Add reusable explicit action/repair/cancel interaction in `packages/adapter-canvas/src/browser/lifecycle-controls.ts` with `lifecycle-controls.test.ts`, wire `packages/adapter-canvas/src/browser/environment/operations.ts` and deployment views, and add serialized-state, component, functional, accessibility, and keyboard tests.
- [ ] T087 [US6] Update App repair handoff wiring in `packages/adapter-canvas/src/runtime/create-radius-extension.ts` and the deployment-repair skill instructions under `extensions/radius/skills/radius-deploy/SKILL.md`; start repair only through an authorized operation/policy, never a status poll.
- [ ] T088 [US6] Extend process and lifecycle cancellation evidence in `packages/adapter-shared/src/rad-process.test.ts` and `packages/adapter-canvas/test/integration/runtime/lifecycle-controls.test.ts`; prove bounded child-tree cleanup, panel-close continuation policy, session shutdown fencing, and no false remote cancellation.
- [ ] T089 [US6] Complete control/repair unit/runtime/HTTP, affected browser journeys, Windows process, and built-extension gates; document explicit control semantics and the exhausted-budget case in `specs/001-frontend-neutral-radius/quickstart.md`.

**Checkpoint**: Polling only observes. Valid responses and explicit repair/cancellation act on the correct identity, source, and authority without repeating or over-authorizing work.

## Phase 9: User Story 7 - Delete Only What Was Approved (Priority: P2)

**Goal**: Delete an application or tear down an environment through explicit scoped approval, protecting shared resources and reporting partial outcomes.

**Independent Test**: Delete one of two applications, then exercise environment teardown with shared identity/state and an injected phase failure; verify unapproved targets remain and recovery guidance is accurate.

**Prerequisites**: US4 environment operations, US5 execution evidence, and US6 response/control integration.

### Tests for User Story 7

- [ ] T090 [P] [US7] Add deletion-plan and execution-policy cases in `packages/core/src/lifecycle/deletion.test.ts`; cover preview-first approval, stale plan references, per-phase ownership/permission changes, shared resources, cancellation, and partial completion.
- [ ] T091 [P] [US7] Add destructive runtime/HTTP contracts in `packages/adapter-canvas/test/integration/runtime/lifecycle-deletion.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-deletion.test.ts`, including repeated requests, wrong target/source/identity, and another application's retained artifacts.

### Implementation for User Story 7

- [ ] T092 [US7] Implement deletion-plan capture and approval binding in `packages/core/src/lifecycle/deletion-plan.ts` with `deletion-plan.test.ts`; return an operation-bound phase preview before mutation, reject stale supplied plans, and treat missing provenance as a blocker.
- [ ] T093 [US7] Implement `application.delete` in `packages/core/src/lifecycle/application-deletion.ts` with collocated tests, using the typed execution binding and approved application target to reconcile its status artifacts without inferring environment teardown.
- [ ] T094 [US7] Implement `environment.delete` orchestration in `packages/core/src/lifecycle/deletion.ts`; revalidate each phase, protect unapproved shared workloads/state/workflows/identities, and report completed/failed/blocked/not-started phases with safe recovery.
- [ ] T095 [US7] Extract concrete deletion ports from `packages/adapter-canvas/src/server/services/environment-deletion.ts` into `packages/adapter-shared/src/lifecycle/environment-deletion.ts` where reusable, with collocated tests; inject existing executors instead of copying business rules or weakening setup persistence.
- [ ] T096 [US7] Register destructive handlers and plan-approval continuation in `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts` with runtime tests; enforce current approval before every protected phase and reject fabricated public approval claims.
- [ ] T097 [US7] Delegate legacy deletion routes in `packages/adapter-canvas/src/server/routes/deployments.ts` and `packages/adapter-canvas/src/server/routes/environments.ts` with collocated/HTTP tests; preserve established request contracts while exposing new partial/blocked outcomes explicitly.
- [ ] T098 [US7] Render approved scope, shared-resource treatment, partial results, and recovery actions in `packages/adapter-canvas/src/pages/environment/environments-pane.ts` and `packages/adapter-canvas/src/browser/environment/environments.ts`; add unit, HTTP state, component, accessibility, and keyboard cases.
- [ ] T099 [US7] Add application-delete and environment-teardown critical journeys to `packages/adapter-canvas/test/e2e/canvas-chromium.test.ts`, using controlled cloud/repository state to prove unauthorized phases do not execute and retries within the same known operation do not repeat completed destructive phases.
- [ ] T100 [US7] Complete destructive unit/runtime/HTTP, affected browser/journey, workflow-helper, and built-extension gates; update the partial-deletion validation scenario in `specs/001-frontend-neutral-radius/quickstart.md`.

**Checkpoint**: Every destructive phase has explicit authority and evidence. Partial completion is visible; no generic cancellation or application deletion is represented as full environment rollback.

## Phase 10: User Story 8 - Keep Existing Workflows Usable During Adoption (Priority: P2)

**Goal**: Complete the App cutover while retaining supported legacy contracts and access to in-flight operations.

**Independent Test**: Replay supported baseline requests/results through real App composition, change compatible routing with an operation in flight, and prove no duplicate dispatch, lost operation, or unsupported-version guess.

**Prerequisites**: US1-US7 complete. Preserve compatibility incrementally in earlier stories; this phase verifies and completes the combined cutover.

### Tests for User Story 8

- [ ] T101 [P] [US8] Add complete legacy/new runtime and HTTP conformance cases in `packages/adapter-canvas/test/integration/runtime/lifecycle-compatibility.test.ts` and `packages/adapter-canvas/test/integration/http/lifecycle-compatibility.test.ts`, using T001's inventory and explicit fixtures for intentional safety changes.
- [ ] T102 [P] [US8] Extend `packages/adapter-canvas/test/integration/artifact/built-extension.test.ts` for the additive tool, shared-contract packaging, legacy tools/actions, failure propagation, and shutdown from the real generated single-extension artifact.

### Implementation for User Story 8

- [ ] T103 [US8] Implement supported legacy result translation/version policy in `packages/adapter-shared/src/lifecycle/compatibility.ts` with `compatibility.test.ts`; retain explicit evidence limitations, reject unknown authoritative formats, and preserve readers needed by in-flight operations.
- [ ] T104 [US8] Complete and verify the foundational per-family routing in `packages/adapter-canvas/src/runtime/lifecycle-routing.ts` with `lifecycle-routing.test.ts` across all migrated operation families; exercise combined cutover/rollback, switch mutations once, retain compatible control/readers, and reject transitions that would discard or redispatch known operations.
- [ ] T105 [US8] Complete retained tool/action and route translation in `packages/adapter-canvas/src/runtime/create-radius-tools.ts`, `packages/adapter-canvas/src/runtime/create-radius-extension.ts`, and `packages/adapter-canvas/src/server/route-table.ts`; preserve names/inputs/page behavior and record explicit before/after exceptions without replacing all HTTP envelopes.
- [ ] T106 [US8] Complete real-runtime panel-close/reopen/session-shutdown cases in `packages/adapter-canvas/test/integration/runtime/lifecycle-compatibility.test.ts`; preserve session-owned operations/keepalive, existing persisted setup state, listener cleanup, and late-result fences.
- [ ] T107 [US8] Run all affected seven-page browser/server journeys in `packages/adapter-canvas/test/e2e/canvas-chromium.test.ts`, updating only intended result/action states while preserving source links, themes, serialization, focus, and accessibility.
- [ ] T108 [US8] Publish versioned machine-readable lifecycle schemas and public type exports from `packages/core/src/lifecycle/contracts/index.ts` through `packages/adapter-canvas/build.mjs`, with exporter/unit/artifact tests; keep SDK externalization and the current `.artifacts/radius/com.github.copilot/extensions/radius/extension.mjs` layout.
- [ ] T109 [US8] Complete `packages/adapter-canvas/test/integration/runtime/lifecycle-conformance.test.ts` with the full discover/graph/deploy/status panel-free acceptance flow and shared request/result/error/action fixtures covering all 21 catalog operations, without implementing a CLI.

**Checkpoint**: The shared contract and App agree across the complete lifecycle. Known operations remain addressable across permitted routing transitions, and the published artifacts contain the declared schemas.

## Phase 11: Polish and Cross-Cutting Concerns

**Purpose**: Finish release documentation, traceability, cleanup, and the complete applicable evidence gate. These tasks do not defer story-local tests or authorize live deployment.

- [ ] T110 Update user/contributor guidance in `plugins/radius/README.md`, `extensions/radius/skills/radius-deploy/SKILL.md`, and `specs/001-frontend-neutral-radius/quickstart.md` for panel-free tools, explicit repair/configuration behavior, incomplete validation, version limits, and CLI deferral.
- [ ] T111 Reconcile the residual migration inventory in `specs/001-frontend-neutral-radius/contracts/conformance.md` against `packages/adapter-canvas/src/runtime/lifecycle-routing.ts`; remove behavior-bearing duplicate/fallback paths only when unused and retain required compatibility decoders until their declared window and in-flight obligations permit removal.
- [ ] T112 Assess the actual shipped changes via `scripts/plugins.mjs` and `.changeset/config.json`; add release notes under `.changeset/` for the discovered `radius` release unit when production behavior changes, with appropriate bump and migration guidance rather than versioning ignored internal packages.
- [ ] T113 Add new race/process/polling tests to `packages/adapter-canvas/vitest.reliability.config.ts` where necessary and record scheduled visual/reliability plus real-host release prerequisites in `specs/001-frontend-neutral-radius/quickstart.md`; do not claim simulated hosts satisfy real-host qualification or add an unrelated host harness.
- [ ] T114 Run the complete applicable PR gate from `package.json` and `.github/workflows/build.yml`: typecheck, lint, format, coverage, build, built-extension smoke, Windows process, and component/Chromium evidence; require `.github/workflows/extension-selftests.yml` for changed workflow assets and inspect `coverage-baseline.json` without lowering floors.
- [ ] T115 Validate all feature Markdown, exported schema examples, operation coverage, and local links referenced by `specs/001-frontend-neutral-radius/quickstart.md`; remove task-created scratch files without changing unrelated work or hand-editing generated plugin artifacts.
- [ ] T116 Reconcile every FR-001 through FR-040 and SC-001 through SC-009 with actual checked-in evidence in `specs/001-frontend-neutral-radius/contracts/conformance.md`; record unavailable platform/release evidence honestly and leave blocked implementation tasks unchecked rather than declaring full feature completion from the MVP.

## Dependencies and Execution Order

### Phase Dependencies

Setup completes before foundation; foundation blocks every user story. Within a story, its parallel test-design batch precedes implementation, followed by boundary completion and the story checkpoint. Non-parallel implementation tasks run in listed order unless a narrower dependency is explicitly established and the shared-file ownership rule still holds.

The task IDs follow the default priority-ordered implementation route. US5 intentionally precedes US4 because it can use an existing environment; the later environment story consumes the new typed workflow intent. Foundational action handling allows US3 and US4 to complete without waiting for US6's repair controls.

```text
Setup T001-T004
  -> Foundation T005-T017
     -> US1 T018-T026 (P1)
        -> US2 T027-T038 (P1)
        -> US5 T051-T067 (P1)
           -> US4 T068-T078 (P2)
     -> US3 T039-T050 (P1)

US3 + US5 + US4 -> US6 T079-T089 (P2)
US4 + US5 + US6 -> US7 T090-T100 (P2)
US1 through US7 -> US8 T101-T109 (P2)
All stories -> Polish T110-T116
```

The default sequential route is US1, US2, US3, US5, US4, US6, US7, US8. The graph also permits independent work once prerequisites are met.

### User Story Dependencies

| Story | Blocking prerequisites      | Independent test boundary                                                              |
|-------|-----------------------------|----------------------------------------------------------------------------------------|
| US1   | Foundation                  | Controlled application/environment evidence; no mutations                              |
| US2   | US1 read adapters           | Existing definitions, two source snapshots, and configured-environment fixtures        |
| US3   | Foundation                  | Isolated workspace, fake agent/validator, action primitives                            |
| US5   | US1 read adapters           | Existing published definition and preconfigured environment; fake correlated workflows |
| US4   | US1 and US5 workflow intent | Controlled identity/configuration with zero implicit deployments                       |
| US6   | US3, US5, US4               | Existing failed/running operations and outstanding actions                             |
| US7   | US4, US5, US6               | Explicit deletion plans and isolated shared-resource state                             |
| US8   | US1-US7                     | Combined real App composition and existing/new format fixtures                         |

Independently testable does not mean dependency-free. Each story supplies controlled prerequisites and delivers its own acceptance outcome; it does not call unfinished stories or mock away the boundary it claims to prove.

### Shared File Ownership

Serialize edits to `packages/adapter-canvas/src/runtime/create-lifecycle-binding.ts`, `packages/adapter-canvas/src/runtime/lifecycle-routing.ts`, `packages/adapter-canvas/src/runtime/create-radius-tools.ts`, `packages/adapter-canvas/src/runtime/create-radius-extension.ts`, `packages/adapter-canvas/src/server/route-table.ts`, `packages/adapter-canvas/test/e2e/canvas-chromium.test.ts`, root manifests/lockfiles, and shared workflow templates. Parallel contributors can prepare separate service/test files but must join before modifying these integration points.

The story checkpoint owns publication of that story's evidence and any directly related release note. The final phase reconciles the combined result; it does not allow earlier behavior changes to land without tests or required migration guidance.

## Parallel Execution Examples

These batches contain different files and no dependency on another task in the same batch. All named phase/story prerequisites must already be satisfied.

| Scope | Safe parallel batch                                                                            | Join before                                                     |
|-------|------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|
| Setup | T001 baseline fixture and T004 test-discovery inspection                                       | Foundation; keep dependency manifests T002 then T003 serialized |
| US1   | T018 pure discovery assertions and T019 runtime/HTTP discovery assertions                      | T020-T026 implementation and integration                        |
| US2   | T027 graph service assertions and T028 graph boundary assertions                               | T029-T038 implementation and integration                        |
| US3   | T039 policy assertions, T040 source/promotion boundary assertions, T041 App handoff assertions | T042-T050 implementation and integration                        |
| US5   | T051 result-policy assertions, T052 executable shell assertions, T053 App/HTTP assertions      | T054-T067 producer, consumer, and binding implementation        |
| US4   | T068 credential/configuration assertions and T069 runtime/HTTP setup assertions                | T070-T078 implementation and integration                        |
| US6   | T079 repair/cancellation assertions and T080 response/control boundary assertions              | T081-T089 implementation and integration                        |
| US7   | T090 deletion-plan assertions and T091 destructive boundary assertions                         | T092-T100 implementation and integration                        |
| US8   | T101 compatibility boundary assertions and T102 real-artifact assertions                       | T103-T109 cutover and publication                               |

After foundation, US1 and US3 can progress independently outside shared integration files. After US1, graph work and deployment work can progress independently under the same ownership rule. These are optional scheduling opportunities, not permission to run mutations twice or alter a shared external environment concurrently.

## Requirement and Operation Traceability

| Ownership  | Operations or concerns                                                                                                                                                       | Primary task ranges                |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------|
| Foundation | Common schema/version/authority/source/registry/action invariants and routing guards; FR-001, FR-005, FR-006, FR-007, FR-008, FR-022, FR-023, FR-033, FR-034, FR-039, FR-040 | T005-T017                          |
| US1        | `capabilities.get`, `application.list`, `application.inspect`, `environment.list`, `environment.inspect`; FR-002, FR-003, FR-004                                             | T018-T026                          |
| US2        | `graph.get`, `graph.diff`; FR-007 through FR-012, FR-032                                                                                                                     | T027-T038                          |
| US3        | `definition.author`, `definition.validate`; FR-013 through FR-016                                                                                                            | T039-T050                          |
| US5        | `deployment.start`, `operation.get`, `operation.list`; FR-020 through FR-032                                                                                                 | T051-T067                          |
| US4        | `credentials.inspect`, `credentials.configure`, `environment.create`, `environment.configure`; FR-017 through FR-019                                                         | T068-T078                          |
| US6        | `operation.respond`, `operation.repair`, `operation.cancel`; FR-033 through FR-036                                                                                           | T079-T089, reusing T013            |
| US7        | `application.delete`, `environment.delete`; FR-037, FR-038                                                                                                                   | T090-T100                          |
| US8        | App/contract parity and compatibility; FR-001, FR-006, FR-039, FR-040                                                                                                        | T101-T109                          |
| Completion | Every SC-001 through SC-009 and all cumulative evidence gates                                                                                                                | Story checkpoints, T109, T110-T116 |

## Implementation Strategy

### MVP First

Complete setup, foundation, and US1 (T001-T026). Demonstrate application/environment discovery and truthful capabilities through the real App runtime without opening a panel. Keep unimplemented operations explicitly unavailable. Stop to assess that increment; do not claim the complete feature has shipped.

### Incremental Delivery

1. Deliver discovery, then graphs and safe authoring as separate tested increments.
2. Deliver panel-free deployment into an existing environment only after versioned correlation and required completion evidence are available.
3. Deliver explicit environment configuration, responses/repair/cancellation, and scoped deletion using the already-established shared invariants.
4. Complete App cutover, schema publication, all-story conformance, and the release compatibility/evidence requirements.

For each increment, use the smallest faithful tests during development, then its complete applicable boundary gate. Preserve supported callers while making intentional safety changes explicit in fixtures and release notes. Do not create or publish live deployments as part of this task-generation workflow.

### Completion Rules

All tasks start unchecked because this file describes future implementation. Mark a task complete only when its concrete deliverable and owning evidence exist. Record blocked upstream or platform prerequisites explicitly; do not manufacture success, lower coverage thresholds, or treat an unavailable capability as implementation of a required release path.

The constitution is still a template, not a ratified policy. Existing repository engineering instructions remain authoritative. This task-generation change is documentation-only and does not itself require a Changeset; `pr:no-changeset` remains the proposed label for planning-only changes.
