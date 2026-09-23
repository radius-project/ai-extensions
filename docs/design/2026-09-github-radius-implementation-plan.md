# GitHub Radius library: staged implementation plan

- **Status**: Stage 0 inventory and characterization implemented; Extraction stages have not started.
- **Design**: [GitHub Radius: Extracting a Reusable Library from Canvas](./2026-09-github-radius.md), approved and merged in [#845](https://github.com/radius-project/ai-extensions/pull/845).
- **Planning baseline**: `c1c9e938963bbca923984138c82173ec3f0d8b08`, inspected on September 23, 2026. Recheck the current code and concurrent work before starting each slice.
- **Implementation basis**: The approved design and current production code only.

## Delivery strategy

Extract one complete use case at a time, with Canvas calling the extracted implementation before that slice is considered complete. Start with read-only workflow observation rather than environment creation: it establishes the library boundary without moving the large setup state machine or introducing new mutations. Keep the existing plugin usable and releasable after every merge.

Use `packages/core` for UI-independent coordination and typed ports, `packages/adapter-shared` for reusable Node execution bindings, and `packages/adapter-canvas` for host integration and presentation. Do not introduce a fourth package, hosted service, general operation framework, or separately published library. Add interfaces only when a migrated caller needs them.

The stages below are delivery checkpoints, not eight large pull requests. Each implementation stage can contain several small PRs. The default sequence is serial except that stage 3a's deployment-attempt owner must land before stage 2's tool entry points. Independent leaf extractions can proceed after their prerequisites, but only one PR at a time should change a shared composition or registration file.

| Stage | Deliverable                                                         | Prerequisite                                  | Safe stopping point                                                           |
|-------|---------------------------------------------------------------------|-----------------------------------------------|-------------------------------------------------------------------------------|
| 0     | Compatibility inventory and focused characterization                | None                                          | No runtime change                                                             |
| 1     | Read-only workflow observation through core and a non-Canvas caller | 0                                             | Existing Canvas deployment experience preserved                               |
| 2     | Environment setup, verification, and tool access                    | 1; tool entry points also require 3a          | Setup uses shared coordination; other capabilities remain unchanged           |
| 3     | Deployment, explicit repair, and direct deploy/status tools         | 1; reuse stage 2 bindings where available     | Deployment no longer needs a Canvas server                                    |
| 4     | Graph reads and comparison                                          | 1; coordinate with graph work before starting | Canvas and a non-Canvas caller share source resolution and graph coordination |
| 5     | Application authoring and supported inspection                      | 4; reuse stage 3 execution references         | Authoring remains separate from reads and deployment                          |
| 6     | Application and environment deletion, including tool access         | 2 and 3                                       | Both deletion flows use shared safeguards without requiring a panel           |
| 7     | Final compatibility cleanup and reuse evidence                      | 2 through 6                                   | All in-scope coordination has one implementation                              |

Stages 2, 3, and 4 need not wait for unrelated work in each other. Stage 2's coordinator extraction can start after stage 1, but its tool PR waits for stage 3a so verification-triggered deployment has an owner without a panel. Stage 3a depends only on stage 1, avoiding a dependency cycle. Merge order should otherwise follow current ownership and conflicts, not a long-lived stack of branches. Stage 6 can precede stage 5 if that avoids contention. None of these options permits skipping a capability's compatibility gate.

## Rules that keep other developers unblocked

- **Keep branches short-lived.** Branch each slice from current `main`, merge it, then base the next slice on the new `main`. Avoid a branch containing the whole migration or a stack that forces unrelated contributors to rebase.
- **Announce a narrow edit scope.** Each PR identifies its capability, source files, destination modules, owner, and expected edits to shared wiring. Coordinate those files with affected authors; do not freeze an entire package.
- **Preserve old import paths temporarily.** A moved module may leave a behavior-free forwarding export. Existing callers can continue importing it while fixes reach the single implementation. Record each forwarder, remaining callers, removal condition, and owner in the migration inventory.
- **Separate relocation from corrections.** Make a behavior-preserving extraction independently reviewable. Follow it with a focused correction PR where the approved design requires different behavior. Do not merge deliberately failing characterization tests; add the changed expectation with its correction.
- **Do not dual-run mutations.** Compare old recorded behavior and new behavior with deterministic fixtures, never by dispatching both implementations against GitHub or a cloud. Prefer one production implementation and ordinary reverts over runtime old/new selectors.
- **Limit shared-file churn.** Batch a slice's exports and dependency wiring. Avoid unrelated edits to `extension.ts`, `server.ts`, `shared.ts`, `operations.ts`, runtime declarations, package manifests, and the lockfile. Do not reformat or rename neighboring code.
- **Move tests with behavior.** Keep shared logic tests beside the new owner; retain Canvas boundary tests. Do not make feature authors maintain duplicate implementations or two copies of the same business-logic tests.
- **Leave user installations alone.** Use normal builds and isolated test processes, not `build:install`, extension reloads, or edits to shared developer credentials as migration validation.

### Concurrent work to coordinate

This is a September 23 snapshot, not a dependency on those PRs merging. Refresh it at each stage. If an overlapping PR remains active, agree on a small handoff, wait for that file to settle, or choose another capability; do not import its unmerged implementation.

Coordination starts in stage 1, not only in the graph stage. Its deployed-graph reads and failure interpretation consume behavior affected by #861 and #858 respectively. Preserve those contracts even where the PRs do not edit the same files.

| Work                                                                                              | Confirmed overlap                                                                      | Planning response                                                                                                           |
|---------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| [#724](https://github.com/radius-project/ai-extensions/pull/724), branch graph artifact reuse     | Graph pipeline/workflows, runtime tools, composition roots, shared `rad` helpers       | Defer graph extraction until ownership is coordinated; preserve whichever implementation is on `main` when the slice begins |
| [#861](https://github.com/radius-project/ai-extensions/pull/861), friendly deployed service names | Core deployed-graph projection, browser graph modules, shared HTTP and Chromium tests  | Reuse the resulting projection; keep browser rendering out of this migration                                                |
| [#858](https://github.com/radius-project/ai-extensions/pull/858), Bicep diagnostic columns        | Modeling failure handling, graph workflow tests, authoring skill and validation script | Carry diagnostic contracts forward; do not rewrite the authoring scripts                                                    |
| [#857](https://github.com/radius-project/ai-extensions/pull/857), cross-platform coverage         | Shared Chromium tests, reliability configuration, plugin/release tooling               | Keep packaging and cross-platform tooling stable; coordinate small test-file edits                                          |
| [#839](https://github.com/radius-project/ai-extensions/pull/839), AWS specification               | Future provider behavior, rather than a confirmed source-file collision                | Preserve current supported-provider boundaries; do not turn this extraction into AWS feature work                           |

## Stage 0: inventory contracts and protect the first seam

**Delivery record:** The [migration inventory](./2026-09-github-radius-migration-inventory.md#stage-0-execution-evidence) records current owners, contracts, known gaps, and execution evidence. Focused characterization, typecheck, lint, formatting, build, artifact, component, and Canvas Windows-process checks pass. Full coverage and Chromium journeys also pass in an isolated Linux environment using the pinned toolchain and CI browser image. No extraction or production behavior change is included.

**Outcome:** A migration checklist grounded in the implementation at the time work starts, plus characterization tests for the first slice. Inventory the full scope now, then add detailed characterization just before each capability moves.

Record each capability's entry points, owning helpers, source/target identity, mutations, permission checks, persistence, cancellation, errors, required interactions, and observable result contracts. Give each row an owner and status, with links to its tests and migration PR. Track both residual business logic and compatibility forwarders so completion is measurable.

Use these current seams as starting points:

| Capability                         | Current implementation to trace                                                                                                                                                                                                                                                                                                                |
|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Environment setup and verification | `server/routes/create-environment.ts` and its sibling helpers; Azure automatic-setup routes/services, `azure-oidc.ts`, `azure-app-create-continuation.ts`, credential-provenance and identity-profile modules; `server/services/github-environment.ts`, account coordination, verification services, `operations.ts`, and `operation-store.ts` |
| Deployment and status              | `deploy.ts`, `deploy-diagnostics.ts`, `deploy-artifacts.ts`, `deploy-tools.ts`; `server/services/deploy-request.ts`, `deploy-dispatch.ts`, `deploy-monitor.ts`, `deploy-outcome.ts`; `server/routes/deployments.ts` and runtime tool/lifecycle bindings                                                                                        |
| Graphs                             | `server/routes/graphs-planning.ts`, `graph-workflows.ts`, `graph-pipeline.ts`; `runtime/graph-context.ts`, the PR-diff tool, `server/services/deploy-planned-graph.ts`, `workspace.ts`, source-reference helpers, and existing core graph/modeling functions                                                                                   |
| Authoring and publication          | Runtime modeling/handoff modules, `runtime/create-radius-tools.ts`, and repository-root `extensions/radius/skills/radius-app-bicep`                                                                                                                                                                                                            |
| Deletion                           | `server/routes/deployments.ts`, `server/routes/environments.ts` admission/provider guards, `server/services/environment-deletion.ts`, `azure-oidc.ts`, deletion/provenance services, and operation retry/control routes                                                                                                                        |

Paths without a package prefix in this table are relative to `packages/adapter-canvas/src`.

Characterize successful, rejected, ambiguous, cancelled, and partially completed flows, including side-effect order. Record the exact HTTP/tool fields, status values, progress transitions, and workflow inputs in existing test suites rather than inventing a second protocol document. Record known gaps separately from intended compatibility.

Record these known gaps and ownership dependencies explicitly:

- `radius_deploy` and `radius_deploy_status` currently select a Canvas server and fetch its local API. Attempt state and previous parameters are panel-owned, and status polling can initiate repair. Stage 3a establishes independent ownership before headless mutations ship.
- The status tool currently passes through `pending`, `in_progress`, `complete`, and `failed`, although its declaration and skill promise `success`. Canvas uses `complete`. Stage 3c corrects only the tool translation and polling instructions; this is not mechanical extraction.
- The existing core `GitHub` port collapses some failures into `null` or empty arrays. Stage 4 distinguishes absence from unreadable content without changing all callers at once.
- The PR-diff tool describes committed comparisons but uses `runtime/graph-context.ts` workspace-aware reads, including remote fallback when a local file is missing. Stage 4 explicitly corrects this entry point to committed reads; ordinary comparisons remain workspace-aware.
- Setup task/shutdown tracking (`hasActiveEnvironmentTasks` and `markEnvironmentInstanceShuttingDown`), account lease metadata, and `isServerOwnedRequest` are instance-bound. Verification also writes `CanvasState.verifyRunId` and `deployDispatchedAt`, which environment routes use as fallbacks. Stage 2 must replace these assumptions for the tool path without weakening HTTP admission or losing operation identity.

Do not mistake existing dependency injection for the completed extraction. Link each inventory row to its owning module and executable characterization before moving it.

**Exit gate:** The capability inventory is reviewed, the first slice has passing characterization, and each known behavior correction has an explicit destination stage. No source reorganization or broad public API is needed in this stage.

## Stage 1: extract read-only workflow observation

**Outcome:** The first complete call works through both Canvas and a small caller with no Canvas server.

Start with observing an explicitly identified workflow execution and interpreting the available evidence. Trace `deploy.ts` monitoring/log parsing and `deploy-diagnostics.ts` alongside the deploy monitor/outcome services. Extract only the relevant decisions, not entire files: the services currently mutate `CanvasState` and graph presentation. Keep state projection and refresh scheduling in Canvas.

Define the smallest needed core inputs and results: authorized target, execution identity, observation, structured diagnostics, and uncertainty. Distinguish workflow execution outcome from failure to read that outcome. Add narrowly scoped read/clock ports and reusable execution bindings as needed. Do not move all of `gh.ts` or `deploy-artifacts.ts` merely to extract a small reader.

Suggested PR sequence:

1. Extract the existing observation/interpretation behavior, adopt it in the Canvas monitor/outcome path, and add a direct non-Canvas fixture caller. Extend existing import restrictions in `eslint.config.mjs`, including shared-to-Canvas restrictions, rather than creating a second enforcement framework. Cover direct and transitive dependencies with focused positive/negative fixtures where lint alone cannot prove the boundary: core must not import adapters, SDK, HTTP, or DOM; shared execution must not depend on Canvas.
2. Correct evidence interpretation independently: preserve the primary failure when diagnostics or cleanup fail, and distinguish approval waiting, cancellation, unavailable detail, stale observations, and confirmed state-save failure.
3. Validate artifact identity/schema in a separate focused PR, retaining uncertainty when evidence is missing or conflicting.
4. Add bounded read retries in their own PR. First expose the necessary GitHub response/retry metadata through the execution binding; then use injectable timing/jitter and honor retry/rate-limit instructions without an earlier retry. Do not retry mutations.

Only classify phase outcomes supported by existing run/job/artifact evidence. Missing evidence remains unknown. A richer workflow result schema is not a prerequisite and belongs in separate work.

**Exit gate:** Actual Canvas bindings and the non-Canvas caller agree on results and side effects for the shared scenarios. Observation never dispatches a workflow, authors files, or starts repair. The existing Canvas wrapper may still explicitly combine observation with its existing repair behavior until stage 3 separates the full flow.

**Pause/revert boundary:** No persisted format or workflow input changes. Revert the wiring only with any dependent callers accounted for; do not remove independently required safety corrections.

## Stage 2: extract environment setup and verification

**Outcome:** Existing Azure and AWS setup flows share one coordinator, including permission checks, workflow publication, verification, and required interactions.

This is the highest state-management risk and should be several PRs, not a wholesale move of `create-environment.ts`. Include Azure automatic setup and credentials/OIDC interactions, not just the final create-environment route. Account for the automatic-setup, continuation, identity-profile, and credential-provenance modules when sizing slices.

1. Separate operation transitions and setup policy from HTTP responses and UI narration. Introduce the narrow callback/port surface needed for progress, mutation checkpoints, stop boundaries, input requests, and persistence. The frontend adapter retains the existing operation store, identifiers, provenance, locks, and recovery schema, binding them independently of panel construction. Move only required pure policy; do not relocate the entire store or replace it with a new framework.
2. Extract the setup coordinator into core and the reusable command/workspace bindings into shared. Move each prerequisite with its tests and existing callers; then wire the complete route to the coordinator. Keep the current route's response timing and errors, including persistence failure before further mutations. Do not import HTTP request types, `CanvasState`, or selected-account UI types into core.
3. After stage 3a lands, add tool-backed setup/verification entry points and update the source `radius-environment` skill in the same slice. Collect missing inputs and approvals through host interactions. Construct the host-owned execution/operation context independently of opening a panel; Canvas uses the same ownership and locking when it attaches to that operation. Preserve verification that intentionally leads to deployment, attaching its execution reference to the runtime-owned attempt rather than silently returning a configuration-only result. The remaining stage 3 tool/repair slices need not block this setup slice.

Use a runtime/session-scoped owner key for task tracking and account leases, with the existing operation ID identifying the work; a panel ID identifies only a subscriber. Adapt the old panel-bound metadata without changing persisted operation identifiers. Keep `isServerOwnedRequest` and browser admission checks at the HTTP boundary; the tool binding instead obtains trusted authorization/context through the runtime and runs the same shared permission/precondition checks. Neither path trusts editable identity claims.

For tool-driven verification, read execution identity and status from the existing operation record through its adapter binding, never from a `CanvasState` fallback. Characterize legacy records before removing any fallback from the Canvas path; records lacking sufficient evidence must produce an explicit unavailable result rather than guessing the newest run. Test closing a panel, attaching a panel to tool-started work, shutdown, account changes during an active lease, and late callbacks against the existing cancel-or-continue policy.

A partial provider migration is acceptable between PRs if each provider has exactly one implementation and the unmigrated inventory is explicit. Both currently supported setup providers must pass before closing the stage.

**Exit gate:** Test selected GitHub account continuity, required scopes, GHCR bootstrap failures, Azure provenance, publication through protected branches/PRs, pending approval, verification correlation, cancellation between writes, checkpoint failure, and resume without repeating settled mutations. The real runtime tool handler completes supported setup or returns a tied interaction request with no Canvas instance or local HTTP fetch. Unsupported interactions are visible limitations, never success.

**Pause/revert boundary:** Existing persisted operations remain readable. Exercise a pre-extraction record through the new binding and preserve its identity; a rollback must likewise be safe for records written by the slice. If that cannot be proven, split out the incompatible change rather than bundling it into extraction.

## Stage 3: extract deployment and explicit repair coordination

**Outcome:** Deploy, observe, and repair are separate shared calls; existing deploy/status tools call them directly rather than fetching Canvas routes.

Extract request validation, allowed command construction, workflow preparation/dispatch, execution correlation, and monitoring decisions from the current deployment services. Reuse stage 1 evidence interpretation. Keep planned-graph recovery behind a narrow port until stage 4 migrates its implementation.

Keep the selected repository, branch, environment, application, account, and attempt identity together through every call. Preserve current no-argument deploy behavior when an unambiguous prior context exists, explicit target overrides where allowed, and rejection of stale or retargeted repair attempts. Do not select an arbitrary active deployment when context is ambiguous.

### Stage 3a: establish deployment-attempt ownership

Introduce an in-memory attempt owner constructed for each runtime/session at the composition root, independent of panel creation. It owns attempt identity, prior parameters, execution references, monitor lifecycle, diagnostics, and repair counters. Do not introduce a process-global singleton, disk persistence, cross-session recovery, or new durable operation framework. Core receives explicit inputs/ports; it does not own the runtime registry.

Canvas and tools resolve the same authorized target/attempt through this owner. Canvas projects observations into its existing `CanvasState` and attaches/detaches as a subscriber, without starting a second monitor or acquiring a separate mutation lease. No-argument deploy reuses an unambiguous prior attempt in the current runtime; when none exists, return an actionable request for explicit target inputs without opening a panel. Reject ambiguous or stale context.

Define lifecycle behavior in the same PR: closing a panel detaches that view without losing a tool-owned/shared attempt; session shutdown stops local monitoring and disposes subscriptions/timers but does not imply remote workflow cancellation or rollback. Capture the current panel-only cancel-or-continue behavior first, and label/test any necessary change to shared-attempt lifetime explicitly rather than treating it as a file move. Reopening a panel in the same runtime attaches to the existing attempt; process restart carries no new recovery promise.

Adopt the owner in the existing Canvas deployment and verification-triggered paths, with fake-SDK tests for no-panel ownership and shared attachment. This slice depends on stage 1, not stage 2, and is the prerequisite for stage 2's tool PR.

### Stage 3b: extract dispatch, monitoring, and repair

Separate repair policy from status observation and presentation. Canvas explicitly composes the shared calls to preserve its current repair experience, including any tool-mediated repair loop. The runtime tool handler also composes observation with the explicit repair policy when operating without a panel; the read-only library call never initiates repair. Both entry points use the attempt owner's shared repair claim/counter so concurrent polls cannot duplicate a handoff. Frontend scheduling may decide when to ask; shared policy decides whether repair is allowed, and the host supplies the agent interaction. An ambiguous dispatch must not trigger a second mutation or an automatic repair.

Land dispatch/execution-reference extraction and monitoring/repair extraction in separate PRs, each adopting its coordinator in Canvas. Include success, error, and partial-completion tests with each slice rather than waiting for direct tool binding.

### Stage 3c: bind tools and correct their status contract

Replace local HTTP fetches with direct calls using the attempt owner. Then ship the status correction in a separately reviewed PR with a Changeset: translate Canvas's existing terminal `complete` to tool-facing `success` only at the tool boundary. Keep `pending` and `in_progress` nonterminal, and update the shipped skill/declaration together to poll either and stop on `success` or `failed`. Do not normalize Canvas's `complete` away or turn an observation failure into an execution failure. Add before/after tests covering every status and the actual skill-facing output.

**Exit gate:** A fake SDK session invokes the real deploy/status handlers with no panel or loopback server. Prove the chosen mapping (`pending`/`in_progress` continue, `complete` becomes tool `success`, `failed` remains `failed`), polling termination, workflow links, diagnostic bounds, and repair attempt limits/identity. Canvas still receives `complete`; no prior attempt produces explicit guidance, not success. Observation errors must not masquerade as confirmed deployment failure. Concurrent Canvas/tool polling shares one monitor and at most one repair handoff for the same eligible attempt.

**Pause/revert boundary:** No workflow protocol or new durability guarantee. Test simultaneous Canvas/tool access so it cannot create duplicate dispatches or disagree about the active attempt. Stop admission of new work and account for in-flight attempts before any rollback; code rollback does not undo remote execution.

## Stage 4: extract graph reads and comparison

**Outcome:** Shared source resolution and graph orchestration return domain data, while Canvas retains view selection, source-reference tokens, caches, and rendering.

Coordinate this stage with active graph PRs before touching `graph-workflows.ts` or `graph-pipeline.ts`. Reuse existing core graph transforms, diff algorithms, recipe enrichment, and managed `rad` helpers; do not replace them with a parallel graph model or another team's proposed graph library.

1. Introduce a typed source-read result that distinguishes present content, confirmed absence, and unreadable content; empty content is not absence. Preserve legacy callers through a compatibility adapter where needed instead of changing the existing `GitHub` port globally.
2. Extract ordinary reads and comparison with explicit sources and workspace authorization. Land the absence/error correction separately from mechanical moves, with before/after fixtures. Resolve comparison sides independently, use uncommitted workspace content when repository and branch match, read other sources from GitHub, and stage both sides before compiling either.
3. Rewire Canvas load/planned/diff wrappers to the shared calls. Keep authoring/freshness handoffs explicit outside pure reads; preserve the existing combined Canvas experience. Move shared CLI/source bindings only as their callers migrate.
4. Correct the PR-diff tool's source selection in its own PR with a Changeset. Its current workspace-aware behavior does not meet its committed-comparison description. Resolve both explicit base/head branches to committed revisions through GitHub, read and stage those sources independently, and return their identities. Do not borrow dirty workspace content or fall back to it when a committed source cannot be read. Ordinary Canvas branch comparisons keep the workspace-aware policy from step 2.

**Exit gate:** Cover local changes on either matching side, nonmatching GitHub sources, first addition, last removal, neither definition present, empty/invalid definitions, unreadable sources, staging order, failed compilation, cancellation, and temporary-workspace cleanup. Never fall back to stale remote content for a missing or unreadable matching workspace. Neither reads nor comparisons commit, push, publish, or silently author.

Preserve authored/planned/deployed meanings, current-worktree branch selection for ordinary views, stale source-reference rejection, and error diagnostics. Establish the promised committed base/head contract for the PR-specific entry point through the explicit correction above, not as a claimed existing behavior. Test the same branch with dirty workspace content through both entry points: ordinary comparison sees the local changes, while PR comparison sees only committed content. Include missing local files, remote read errors, and confirmed committed absence so neither entry point silently uses the other's source policy. Resolving actual environment recipe registrations remains a separate improvement; missing registrations must not be concealed by invented types or recipes.

**Pause/revert boundary:** Keep old import paths as forwarders where active callers need them. Revert an orchestration slice without discarding unrelated graph/UI fixes that landed in the meantime.

## Stage 5: extract application authoring and supported inspection

**Outcome:** The library coordinates authoring and validation without mistaking an agent response for a valid model or a deployed application.

Move eligibility/freshness decisions, explicit authoring requests, output validation, and required publication coordination behind core calls and host interaction ports. Reuse the existing authoring skill, staging/promotion script, and publishing helpers. Keep SDK prompts, notifications, and panel lifecycle in the host adapter.

Tie interaction responses to their originating request/source and reject stale completions. Preserve workspace change checks, path confinement, managed-file overwrite protection, command allow-lists, and publication approval. A read may report that authoring is required; it must not perform it implicitly. Canvas can still compose the two operations intentionally.

Extract existing application/deployment discovery and inspection using the current `rad` and artifact readers, distinguishing definition files, observed resources, and individual workflow attempts. Do not add a new discovery product or expand provider support.

**Exit gate:** Exercise unsupported agent capability, rejection, cancellation, agent failure, invalid or incomplete output, stale completion, modified workspace, successful validation/promotion, and publication refusal. Run actual runtime bindings and generated-plugin checks so authoring and custom-type/recipe publication remain usable. Missing deployment artifacts must not imply deletion.

## Stage 6: extract deletion and remove its panel prerequisite

**Outcome:** Application deletion and environment deletion use shared authorization and sequencing, with explicit confirmations and tool entry points independent of Canvas.

Use separate PRs for application deletion and environment deletion. Trace admission and provider refusal in `server/routes/environments.ts` as well as the runner. Do not treat the existing environment-deletion service as already portable: it imports Canvas-owned operation/provenance helpers and `azure-oidc.ts`, and includes agent-facing narration. Extract policy into core, retain presentation in the adapter, and reuse the operation ports established in stage 2.

For application deletion, preserve workflow synchronization, allowed targets, run correlation, and the separate force confirmation. Re-read the conflict artifact before accepting force; a frontend approval flag does not authorize an otherwise invalid destructive request.

For environment deletion, preserve the current Azure-only support boundary and teardown ordering: confirm Radius environment deletion while its credential still exists, then perform provenance-checked credential cleanup, GitHub environment removal, and confirmed state-package deletion. Leave shared app registrations untouched. Reuse the same GitHub-environment deletion primitive used by setup rollback.

Add the deletion tool declarations/handlers and update the source `radius-delete` skill atomically with them. Missing inputs or confirmation must return a specific required interaction; the runtime must not silently open a panel or translate silence into approval.

**Exit gate:** Cover deployed-app guards, wrong identity, missing ownership proof, unreadable artifacts, unsupported providers, force conflict revalidation, cancellation/failure, cleanup order, incomplete package deletion, and retries of unresolved stages only. Exercise existing persisted deletion records and Canvas/tool concurrency. Preserve workflow restore/save safeguards and report partial completion without claiming rollback.

## Stage 7: close the migration, not just the file moves

**Outcome:** Every in-scope capability is exercised without Canvas, and Canvas no longer owns a second implementation of the same decisions.

Audit imports and the capability inventory, including transitive helper dependencies. Remove residual business logic from routes/tools, remove unused dependencies and forwarders only when their caller inventory is empty, and retain thin Canvas translation/presentation wrappers.

Extend the non-Canvas fixtures introduced in stage 1 across setup, verification, managed `rad` invocation, graph reads/diffs, authoring, deployment/status/repair, inspection, and both deletion flows. Use ordinary tests, not a new conformance framework. Demonstrate the actual environment, deployment, and deletion tool handlers without a Canvas server as well as the library calls with controlled dependencies.

Document the minimal consumer contract and a small tested example: authorized execution, workspace access, operation-state ownership, supported interactions, cleanup, and uncertainty. A full CLI or VSCode frontend is not part of this work.

Preserve the current release layout rather than restoring the design's historical paths. At the planning baseline, `extensions/radius/package.json` is the release-unit manifest, and the build assembles `.artifacts/radius/com.github.copilot/extensions/radius/extension.mjs` for publication under `plugins/radius`. Keep one loadable runtime bundle with the SDK externalized; never hand-edit generated output.

**Exit gate:** Every inventory row points to its shared implementation, Canvas binding, direct caller evidence, and relevant safety tests. No library call requires an instance ID, HTTP response, SDK handle, panel, or Canvas server. No duplicate coordinator, new operation store, workflow protocol, or separate package publication has been introduced.

## Evidence required for every slice

Follow the repository's [code-quality policy](../../.github/skills/radius-code-quality/SKILL.md), [test architecture](./2026-08-radius-canvas-test-architecture.md), and [test plan](./2026-08-radius-canvas-test-plan.md). Identify the exact affected requirements from the plan when preparing each PR rather than inventing new requirement IDs here.

Those documents still mention the historical `plugins/radius/dist/extension.mjs` path. For this migration, validate the current build/manifest layout recorded in stage 7, not that obsolete location. Correct the stale policy references in a separate documentation-only PR before implementation; all behavioral, single-bundle, SDK-externalization, and test requirements continue to apply.

| Changed boundary                                      | Evidence                                                                                                                                                                |
|-------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Shared policy or execution binding                    | Collocated unit tests, real deterministic helpers where possible, explicit success/failure/edge cases, and direct non-Canvas caller scenarios                           |
| Runtime tools, actions, hooks, lifecycle, or context  | Runtime integration with a fake SDK session and real factories; include no-panel operation, stale events, and cleanup                                                   |
| Routes, operation state, caches, or streams           | HTTP integration on a real loopback server; preserve payloads, headers, error/status mapping, stream termination, admission checks, and cancellation                    |
| Cross-page setup/deploy/delete or changed interaction | Existing Chromium critical journeys and applicable browser functional, accessibility, and keyboard coverage; add browser component coverage if browser behavior changes |
| Runtime dependencies or bundled sources               | Production build and built-extension smoke, including registration, failure propagation, shutdown, and artifact layout                                                  |

Target 100% coverage of changed reachable production paths and never reduce aggregate or package coverage baselines. Keep tests offline, deterministic, isolated from personal credentials, and explicit about cleanup. Add race/repetition cases to the existing scheduled reliability coverage where needed; visual and reliability suites are not substitute PR gates. Real-host qualification remains separate release work and cannot be claimed from loopback or Chromium tests.

Use targeted tests while implementing, followed by the current required typecheck, lint, format, coverage, build, Windows-process, artifact, component, and Chromium gates. Coverage already includes runtime and HTTP integration; do not rerun them unnecessarily. Use the owning CI environment where local prerequisites are unavailable. Any supported-workflow live demonstration must use the existing controlled scheduled/on-demand infrastructure, never a contributor's credentials or a new live PR gate.

## Release and rollback policy

Keep each merge releasable. Mechanical refactors and this planning document do not need a Changeset; propose `pr:no-changeset` with the concrete behavior-preservation rationale. Evaluate each correction, new tool, or shipped skill change separately for a Changeset against the actual release unit. Internal core/shared packages remain ignored by Changesets; do not version them as new products.

A migration slice is safe to revert only after checking downstream callers, persisted record compatibility, and in-flight operations. Reverting code never undoes GitHub/cloud mutations. Do not replay setup, deployment, or deletion merely to determine which implementation ran. If a new admission path is faulty, stop admitting new work through it while preserving observation and recovery of already-started work; prefer a focused forward fix if reverting would lose that capability.

Completion means shared behavior and preserved supported workflows, not a target number of moved files. It is acceptable to pause after any stage, leaving unrelated capabilities in their current owners, provided completed capabilities have one implementation and the residual inventory is accurate.
