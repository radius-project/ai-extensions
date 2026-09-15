# Implementation Plan: Frontend-Neutral GitHub Radius

**Branch**: `nellshamrell-spec-kit-setup` | **Date**: 2026-09-15 | **Spec**: [spec.md](spec.md)

**Input**: `specs/001-frontend-neutral-radius/spec.md`

**Baseline**: `radius-project/ai-extensions` at `5204c989137f76ad88fa15ea0431fa1b15ed1e08`. The setup script reports the feature selector `001-frontend-neutral-radius` as `BRANCH`; the actual Git branch remains the branch above. No branch change is required.

## Summary

Deliver a versioned, frontend-neutral lifecycle contract and migrate Copilot App onto it. Put domain contracts, validation policy, lifecycle transitions, and orchestration behind typed ports in `packages/core`; put reusable Node execution bindings in `packages/adapter-shared`; keep Copilot SDK, panel, HTTP, page, and browser concerns in `packages/adapter-canvas`. Expose panel-free App access without adding a hosted service or shipping a Copilot CLI binding.

Reuse existing graph transformations, managed Radius execution, staged authoring, setup-operation storage, workflow generation, and destructive-operation safeguards. Add missing operation identity, explicit action responses, effective-input source fencing, and authoritative execution evidence. Compatibility adapters preserve retained tools and page contracts while explicitly changing unsafe behavior identified by the spec: status must not initiate repair, configuration must not implicitly deploy, and uncertain execution must not appear successful.

This command ends at design. It does not implement production code, create `tasks.md`, deploy infrastructure, or ratify the placeholder constitution.

## Technical Context

**Language/Version**: TypeScript 7.x in strict ESM modules, Node.js 24, pnpm 11.19.0; existing Bash composite-action helpers and ESM authoring scripts remain in their current runtimes. Follow existing `.js` import specifiers in TypeScript.

**Primary Dependencies**: Existing `@github/copilot-sdk` 1.0.11, managed `rad`/Bicep, `gh`, GitHub Actions, and provider identity integrations. Introduce schema-first JSON Schema draft-07 definitions as dependency-free data in core; plan `json-schema-to-ts` 3.x as a type-only development dependency for inferred contract types and Ajv 8.x in adapter-shared for runtime boundary validation. Lock exact compatible versions during the implementation dependency change; disable coercion, defaults, and remote schema loading. Do not introduce another application graph compiler.

**Storage**: An injected session-owned registry for new lifecycle operations and required actions; no process-global maps. Keep existing durable setup-operation storage behind an adapter. GitHub run metadata and artifacts retain remote execution evidence; Radius state archives retain deployment state. No new general-purpose operation database, cross-process recovery protocol, or durable history service.

**Testing**: Vitest 4.1.x collocated unit tests; existing runtime integration, HTTP integration, built-extension smoke, browser component, browser functional, critical journey, accessibility, and keyboard suites. Extension shell helpers and artifact-uploader tests remain required for workflow changes. Use shared semantic fixtures against core orchestration and the App binding, not a second production frontend.

**Target Platform**: Copilot App on supported desktop platforms, including Windows path/process boundaries; Linux GitHub Actions execution and the pinned Chromium CI image. Azure/AWS capabilities remain explicit rather than assumed equivalent.

**Project Type**: Existing multi-package plugin with a reusable library contract, a host adapter, and remote workflow execution.

**Performance Goals**: No new production throughput or latency SLO. Preserve existing bounded external-call policies and diagnostics limits, inject clocks, and prove cancellation/cleanup within existing test timeouts: unit 5 seconds, component/functional 10 seconds, runtime/HTTP 15 seconds, built-extension/journey 30 seconds. SC-005's 100 status reads must produce zero repairs.

**Constraints**: No Canvas requirement for lifecycle execution; no implicit source publication; no implicit deployment from configuration; no retries of uncertain mutations; required validation checks fail closed; no source substitution from the worktree to the default branch. Preserve existing identity policy, exact route ownership, output-context escaping, and a single loadable extension.

**Scale/Scope**: All 21 lifecycle operations in [the contract](contracts/lifecycle.md), the eight user stories, and all 40 functional requirements. One injected lifecycle context per App session may serve multiple panel lifetimes. Preserve current execution-layer serialization instead of promising distributed coordination. CLI, hosting, durable operation history, and restart recovery are excluded.

## Constitution Check

*Gate evaluated before research and again after design.*

The constitution remains an unfilled template. It contributes no ratified principles; this is not an invented constitutional approval. The standing repository engineering instructions and approved Canvas boundary rules supply the enforceable gates.

| Gate                                                            | Pre-research | Post-design evidence                                                                                                  |
|-----------------------------------------------------------------|--------------|-----------------------------------------------------------------------------------------------------------------------|
| Core has no SDK, HTTP, DOM, or concrete filesystem dependency   | Pass         | Domain schemas/services depend only on typed ports; execution stays in adapters                                       |
| Runtime composition owns host wiring and joins the session once | Pass         | Existing `extension.ts` and runtime factories remain the only host composition path                                   |
| State has an explicit owner and cleanup policy                  | Pass         | Session lifecycle context is injected, panel state remains instance-scoped, and shutdown fences local work            |
| Errors and destructive actions fail closed                      | Pass         | Required checks, authorization, source fencing, dispatch uncertainty, and partial deletion are specified in contracts |
| Existing supported surfaces do not change accidentally          | Pass         | Contract-specific migration flags and before/after fixtures isolate intentional behavior changes                      |
| Every changed seam has the required test levels                 | Pass         | [Conformance matrix](contracts/conformance.md) maps requirements to cumulative boundary evidence                      |
| Changed production coverage targets 100%; floors never decrease | Pass         | Existing coverage baseline remains authoritative, with explicit unreachable-path justification only                   |
| Build and release packaging are preserved                       | Pass         | Use the current build output and existing built-extension smoke, not an obsolete artifact path                        |
| No new CLI or operation-history service                         | Pass         | Both are explicitly excluded from this release                                                                        |

Existing documents sometimes describe an older output path and the historical 40-route closeout. Use current `build.mjs`, `scripts/plugins.mjs`, `SERVER_ROUTE_DECLARATIONS`, and their equality tests for live paths and inventories. This does not waive their architectural constraints.

## Project Structure

### Documentation (this feature)

```text
specs/001-frontend-neutral-radius/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  checklists/requirements.md
  contracts/
    lifecycle.md
    execution.md
    conformance.md
```

`tasks.md` is a later `/speckit-tasks` output and is not created by this plan.

### Source Code (repository root)

```text
packages/core/src/
  lifecycle/                       proposed: schemas, ports, policy, services, collocated tests
    contracts/                     proposed: versioned schema data and inferred public types
  graph/                           existing canonical transformations and diff
  modeling/                        existing staging, origin, source, recipe rules
  workflows/                       existing workflow generation
packages/adapter-shared/src/
  lifecycle/                       proposed: validation and reusable execution/source adapters
  rad.ts                           existing managed execution and graph isolation
packages/adapter-canvas/src/
  extension.ts                     existing composition root
  runtime/                         existing host factories; add lifecycle binding
  server/routes/                   existing thin compatibility adapters
  server/services/                 extract domain coordination without wholesale file moves
  pages/                           existing renderers and serialized state boundary
  browser/                         existing importable UI behavior
packages/adapter-canvas/test/
  fixtures/lifecycle/               proposed conformance requests and controlled evidence
  support/                         existing fakes and host/server harnesses
  integration/runtime/             include panel-free production-composition scenarios
  integration/http/                preserve legacy contracts and explicit new semantics
  integration/artifact/            preserve real production bundle behavior
  e2e/                             existing browser-and-server journeys
.github/extension/                  existing canonical workflow and action sources
extensions/radius/skills/           existing agent instructions and guarded authoring scripts
```

**Structure Decision**: Add bounded subdirectories to existing packages, not a fourth package. Export new core contracts through a dedicated `@radius-project/core/lifecycle` subpath so browser graph imports do not pull in host functionality. Keep already testable utilities where they are unless their concrete behavior is required by a new reusable binding. Do not create independent copies of graph, recipe, authorization, or deployment rules.

The current assembled entry point is `.artifacts/radius/com.github.copilot/extensions/radius/extension.mjs`, generated by `packages/adapter-canvas/build.mjs` and published in the plugin tree. Preserve SDK externalization. Do not hand-edit the assembled plugin or restore the historical `plugins/radius/dist/extension.mjs` location.

## Design and Implementation Sequence

### Phase 0: Research outcomes

[research.md](research.md) resolves ownership, binding, schemas, state lifetime, source resolution, validation policy, workflow evidence, and compatibility. The selected design uses an in-process contract, not existing Canvas HTTP as the shared API. Concrete current behavior is separated from new guarantees.

### Phase 1: Design outputs

- [data-model.md](data-model.md) defines identities, source snapshots, observations, operation/action transitions, validation checks, and deletion plans.
- [contracts/lifecycle.md](contracts/lifecycle.md) defines the operation catalog, message rules, error vocabulary, App binding, and port responsibilities.
- [contracts/execution.md](contracts/execution.md) defines dispatch correlation, revision enforcement, result evidence, completion interpretation, and migration.
- [contracts/conformance.md](contracts/conformance.md) specifies the test cases and their repository-policy mappings.
- [quickstart.md](quickstart.md) gives runnable baseline and implementation validation commands, plus expected outcomes.

The contract documents are normative design inputs. Machine-readable schemas, generated types, and executable conformance fixtures are production deliverables of the implementation phase, not artifacts claimed to exist today.

### Implementation slices for later task generation

1. **Contract and compatibility baseline**: Define v1 schemas, inferred types, strict validators, typed ports, fixture format, current tool/route inventory, and legacy-result decoding. Establish per-family routing and in-flight-operation guards before any existing mutation binding switches; retain compatible reader/control paths and reject transitions that would lose or redispatch known operations. Add production dependency/export/build changes with built-extension smoke. Cover FR-001, FR-002, FR-005, FR-006, FR-039, FR-040.
2. **Source and read services**: Resolve authorized worktree/remote snapshots, graph kinds and comparisons, actual environment recipe registrations, discovery, and inspection. Support authored-source inspection without an environment and require an explicit environment for deployed observations. Separate authorized source fetching from graph compilation; prove fork graph execution receives no deployment credentials and cannot dispatch privileged workflows. Remove success-shaped empty fallbacks only at the new contract boundary, with explicit legacy mappings. Cover FR-003, FR-004, FR-007 through FR-012, FR-032.
3. **Operations, actions, and validation**: Introduce the injected lifecycle context, state reduction, response authority, bounded repair policy, required/advisory validation, and effective-input promotion fence. Bridge existing setup records without replacing their persistence semantics. Cover FR-013 through FR-016, FR-022 through FR-025, FR-033 through FR-036.
4. **Execution evidence before stronger deployment claims**: Extend canonical workflows and readers together; enforce expected commit, correlate operation/run/attempt, separate configuration from deployment, and expose restore/command/save/cleanup evidence. Cover FR-020, FR-021, FR-026 through FR-032. Do not enable v1 deployment success until this evidence is available.
5. **Environment and destructive services**: Extract scoped credential/environment coordination, application deletion, and phased environment teardown with authoritative approvals and partial results. Cover FR-017 through FR-019, FR-037, FR-038.
6. **App cutover and release**: Complete routing of retained tools and pages through the shared services operation by operation using the foundational guards, expose panel-free lifecycle access, replace polling-driven work with explicit controls, and exercise combined migration/rollback without duplicate mutation. Earlier slices must pass their routing guards before switching a mutation binding; this slice does not introduce those prerequisites. Cover FR-001, FR-025, FR-039, FR-040 and all success criteria.

Slices are dependency guidance, not an alternative `tasks.md`. Each production slice includes its tests, release-note assessment, directly related documentation, and retained fallback inventory. Read-only comparisons may run against the same fixture; mutations never run twice for migration comparison.

## Validation and Delivery Gates

Preserve CA-05/CA-06, TL-02/TL-05/TL-07 through TL-11, affected RF-01 through RF-09, LC-10 through LC-17, and CN-01 through CN-08 from the existing test plan. Their current fixtures and declarations, not a copied count, define the compatibility surface. Explicitly update affected expectations when the new spec changes automatic modeling, repair, or deployment behavior.

Run applicable cumulative layers from the repository evidence matrix. `pnpm run coverage` includes runtime and HTTP integration; do not rerun those suites during the complete gate unless investigating a failure. Windows process tests run in the Windows job, browser/component/journey/accessibility/keyboard tests in the pinned Playwright image, and workflow shell/uploader tests in Extension self-tests. Visual and reliability remain scheduled gates. Real-host qualification remains a separately tracked release requirement; simulated hosts do not count as qualification.

A missing supported upstream capability is a declared limitation, not a stubbed success. The release acceptance path must exercise at least one supported provider with complete evidence; unsupported provider-specific operations remain explicit. No new Radius API or resource schema is assumed. If pinned `rad` behavior cannot supply a required fact, keep that capability disabled and coordinate a Radius change before enabling it.

## Complexity Tracking

No constitutional or package-boundary exception is required. Session-owned lifecycle state is a new explicit owner, not process-global Canvas state; existing panel/browser caches remain instance-scoped. Schema validation dependencies are justified by a published versioned contract and shared runtime validation, not a new service framework.

**Changeset**: Not required for these planning artifacts or the repository-local Spec Kit setup; neither changes released plugin behavior. Proposed PR label: `pr:no-changeset`. Future production slices must assess the `radius` release unit discovered through `scripts/plugins.mjs`; internal packages are ignored by Changesets but ship through that plugin.
