# Radius Canvas test plan

- **Author**: Nicole James (@nicolejms)
- **Date**: 2026-08
- **Status**: Draft
- **Tracking issue**: [#334](https://github.com/radius-project/ai-extensions/issues/334)
- **Design PR**: [#282](https://github.com/radius-project/ai-extensions/pull/282)

## How to use this plan

Start with the phase table to find what exists and what the next pull request must deliver. Use the test-layer table to choose the cheapest test that can represent a regression. Read the relevant phase for acceptance and checked-in evidence. Use the appendices for requirement IDs and the exact action, tool, route, page, lifecycle, journey, visual, and host inventories.

The companion [test architecture](./2026-08-radius-canvas-test-architecture.md) explains what Radius Canvas does, why the original structure resisted testing, and why the approved design extracts runtime, server, page, and browser boundaries without rewriting the interface.

### Phase and status

| Phase | Current status                                                     | Purpose                                                              | Acceptance summary                                                                                                                            | Pull requests                                                                                                                                                                                           |
|-------|--------------------------------------------------------------------|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0     | Complete                                                           | Record compatibility and coverage; remove obsolete action/tool pairs | Two actions, six tools, seven pages, the original 37-route baseline, branch behavior, markup, and artifact shape are recorded                 | [#318](https://github.com/radius-project/ai-extensions/pull/318)                                                                                                                                        |
| 1     | Complete                                                           | Extract the runtime from import-time session startup                 | RU-01–RU-21, focused runtime integration, artifact smoke, existing tests, typecheck, and build pass                                           | [#288](https://github.com/radius-project/ai-extensions/pull/288), [#318](https://github.com/radius-project/ai-extensions/pull/318)                                                                      |
| 2     | Implementation and closeout complete in stacked review; not merged | Extract the server, route ownership, and heavy workflows             | SU-01–SU-18; 40 declarations match 40 concrete handlers; zero residual fallback; gates are green except the documented Windows chmod baseline | Scaffolding [#339](https://github.com/radius-project/ai-extensions/pull/339) and constituent slices are merged; final closeout [#382](https://github.com/radius-project/ai-extensions/pull/382) is open |
| 3     | Implementation complete and green; not merged                      | Split the page shell and renderers                                   | PU-01–PU-13; durable 20-case pre-extraction oracle; renderer, loopback, integration, artifact, typecheck, and build gates pass                | [#379](https://github.com/radius-project/ai-extensions/pull/379) is ready for review                                                                                                                    |
| 4     | Implementation in progress; stacked on #379                        | Make browser behavior importable and compile it inline               | BU-01–BU-14 are the active acceptance scope; generated scripts and renderer wiring must pass; no duplicate behavior source may remain         | Current Phase 4 branch; draft pull request pending                                                                                                                                                      |
| 5     | Not started                                                        | Consolidate Node boundary suites                                     | Runtime integration, HTTP integration, and built-extension smoke pass without live services and become required PR/publish gates              | —                                                                                                                                                                                                       |
| 6     | Not started                                                        | Add required Chromium gates                                          | Browser component, browser functional, journeys, accessibility, and keyboard checks pass deterministically                                    | —                                                                                                                                                                                                       |
| 7     | Not started                                                        | Add visual and extended regression gates                             | Reviewed screenshots and non-duplicative resilience/platform checks are stable                                                                | —                                                                                                                                                                                                       |
| 8     | Not started                                                        | Qualify a real Copilot host                                          | Harness self-test and HOST-01–HOST-07 pass; unavailable or emulated results do not qualify a release                                          | —                                                                                                                                                                                                       |

### Test priorities and enforcement

Test priority is independent of implementation phase: **P0** means Required PR gates, **P1** means Required browser gates, **P2** means Extended regression gates, and **P3** means Release qualification. Priority controls delivery order and where a test blocks; it does not make a lower-priority test optional when that test is the only faithful check of a boundary. A test is non-negotiable when a pull request changes the behavior it owns. Higher-level tests complement unit tests and never excuse missing focused unit coverage.

| Test layer            | Priority | Enforcement                                                                                                                    | Main regression caught                                                                        |
|-----------------------|----------|--------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| Unit                  | P0       | Every affected pull request; no retries                                                                                        | Logic, validation, state, escaping, serialization, and error propagation                      |
| Runtime integration   | P0       | Runtime, declaration, lifecycle, hook, action, tool, or branch-context changes; complete gate from Phase 5                     | Registration, open/reopen/close, callbacks, keepalive, and session routing                    |
| HTTP integration      | P0       | Server, route, cache, stream, or destructive-operation changes; complete gate from Phase 5                                     | Real methods, paths, status, headers, bodies, streaming, cleanup, and fail-closed results     |
| Built-extension smoke | P0       | Runtime, export, build, dependency, page, browser, skill, or packaging changes; complete gate and publish blocker from Phase 5 | Missing bundled code, bundled SDK, duplicate registration, broken startup, or broken shutdown |
| Browser component     | P1       | Affected browser unit from Phase 6; one diagnostic retry with the original failure retained                                    | Real DOM events, focus, storage, and rendering behavior                                       |
| Browser functional    | P1       | Affected page or cross-module browser behavior from Phase 6; one diagnostic retry with flake tracking                          | Forms, DOM state, polling, and browser HTTP interactions                                      |
| Critical journey      | P1       | Affected supported journey from Phase 6; one traced diagnostic retry with flake tracking                                       | Regressions crossing renderers, browser code, local HTTP, navigation, and server state        |
| Accessibility         | P1       | Every affected material page state from Phase 6; one diagnostic retry                                                          | WCAG 2.2 A/AA semantic violations                                                             |
| Keyboard              | P1       | Every affected interactive page state from Phase 6; one diagnostic retry                                                       | Keyboard traps, bad tab order, focus loss, and missing announcements                          |
| Visual                | P2       | Selected and affected stable states from Phase 7; one diagnostic retry and human-reviewed baseline changes                     | Layout, clipping, theme, graph, and status-presentation drift                                 |
| Real-host             | P3       | Weekly/manual after qualification and non-negotiable before release; at most one diagnostic retry                              | Installation, discovery, panel, iframe, focus, close, reopen, and reconnect                   |

Platform-matrix and resilience runs are execution policies over these test layers rather than additional test types. Platform-specific unit, runtime-integration, and HTTP-integration tests are P0 when a pull request changes path, process, managed-binary, or source-link behavior and P2 scheduled protection otherwise. P2 resilience runs choose the cheapest faithful layer for partial responses, expiry, repeated polling, cleanup, and timeouts; their scheduled priority does not permit a known failure to remain unowned.

## Scope and target map

Only four concentrated boundaries move. Existing testable helpers stay in place and are supplied to the new code as controlled dependencies.

| Current area                                                                       | Target                                                                      | Responsibility                                                                                                                    |
|------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| [`extension.ts`](../../packages/adapter-canvas/src/extension.ts)                   | `src/runtime/`; thin `extension.ts` entry                                   | Canvas, actions, tools, hooks, lifecycle, and the single production `joinSession()` call                                          |
| [`server.ts`](../../packages/adapter-canvas/src/server.ts)                         | `src/server/` container, request handler, route table, routes, and services | Per-instance state, HTTP translation, route ownership, and multi-stage workflows                                                  |
| [`pages.ts`](../../packages/adapter-canvas/src/pages.ts)                           | `src/pages/` shell, graph, environment, and deployment renderers            | HTML, theme, navigation, stable IDs, escaping, and serialized initial state                                                       |
| [`client.ts`](../../packages/adapter-canvas/src/client.ts) and inline page scripts | `src/browser/` entries, graph, forms, and shared helpers                    | Browser events, forms, graph behavior, navigation, polling, focus, and status                                                     |
| Existing helpers                                                                   | Stay in `src/`                                                              | `operations.ts`, `verification-plan.ts`, `bicep.ts`, `deploy.ts`, `gh.ts`, `ghcr.ts`, `workspace.ts`, `source-refs.ts`, and peers |
| Production build                                                                   | `build.mjs` plus the Phase 4 browser-bundle helper                          | One `plugins/radius/dist/extension.mjs` with inline browser code and external Copilot SDK imports                                 |

Unit tests remain beside production modules as `*.test.ts`. All non-unit tests live under `packages/adapter-canvas/test/`: `integration/runtime`, `integration/http`, `integration/artifact`, `component`, `functional`, `e2e/journeys`, `accessibility`, `keyboard`, `visual`, `host`, plus shared `fixtures` and `setup`.

### Short glossary

- **Controlled fake**: a test implementation of an external operation that returns only declared results and throws on unexpected calls.
- **Compatibility record**: checked-in expected metadata, schemas, routes, markup markers, or artifact imports used to detect drift.
- **Forwarding module**: a temporary old import path that delegates to extracted code and contains no independent behavior.
- **Self-contained inline script**: browser TypeScript compiled into text that runs immediately when inserted into a page; legacy documents call this an IIFE.
- **Server-sent events (SSE)**: a streamed HTTP response made of named event frames.
- **Side-by-side contract test**: the same request and controlled dependencies run through old and new implementations during migration.

## Operational plan

### Pull-request rule

Every phase pull request is independently green and checks in the production change, focused unit tests, controlled data, harness updates, and the command or CI job that runs the new boundary check. A manual validation note is not an exit gate. A focused test becomes part of the permanent suite when that suite is consolidated; it is not rewritten or silently dropped.

For repository source changes, the baseline local PR check is:

```console
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
pnpm run build
pnpm run test:integration:runtime
pnpm run test:integration:artifact
```

Run every additional affected suite introduced by the active phase. Phase 2 adds the checked-in HTTP integration command with its scaffolding; Phase 6 adds the Chromium commands. CI remains authoritative when a controlled host or operating-system matrix cannot run locally.

### Checked-in evidence by phase

| Phase | Evidence added with the production change                                                                                                                                                                                                                            |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0     | Compatibility records for canvas metadata, actions, tools, route methods/paths, selected markup, branch behavior, and artifact imports; coverage reports and summary validation                                                                                      |
| 1     | Focused real-runtime checks with a fake SDK session; operation-aware keepalive; production artifact registration proving one session-join path                                                                                                                       |
| 2     | Exact 40-route ownership proof with 40 declarations, 40 concrete handlers, and zero residual fallback; side-by-side route contracts; focused real-loopback cases for validation, failures, streams, caches, state, and fail-closed operations; facade/artifact smoke |
| 3     | Durable 20-case pre-extraction semantic oracle; old-versus-extracted renderer contracts; stable markup, state, escaping, IDs, and markers; each page served through real loopback HTTP; artifact smoke                                                               |
| 4     | Generated-script execution and renderer wiring; deterministic inline output, intended globals, no external runtime asset, and artifact smoke                                                                                                                         |
| 5     | Complete runtime, HTTP, and artifact suites in a dedicated Node integration job                                                                                                                                                                                      |
| 6     | Real-Chromium component, functional, journey, accessibility, and keyboard suites with controlled browser/server data and failure traces                                                                                                                              |
| 7     | Reviewed visual baselines, update procedure, resilience cases, platform cases, and retry-only flake reporting                                                                                                                                                        |
| 8     | Host harness self-test, HOST-01–HOST-07, isolated workspace, non-personal authentication, logs, and verified cleanup                                                                                                                                                 |

### Phase 0: compatibility and coverage

Phase 0 records the contracts before extraction, measures aggregate and per-package V8 coverage, exposes coverage deltas in CI, removes the four approved legacy action/tool pairs, and updates references to removed tools.

Acceptance: the exact current surface in Appendix A is recorded; current tests and build pass; coverage reports are deterministic; the Build job remains green. Phase 0 is complete through #318.

### Phase 1: runtime

Phase 1 moves declaration and lifecycle behavior into factories that can be built without joining a real session. `extension.ts` constructs production dependencies, calls `joinSession()` once, and wires process lifecycle. Server, page, and browser code remain at their existing paths.

Acceptance: RU-01–RU-21 pass; existing lifecycle, hook, action, tool, and operation-in-flight assertions are retained; focused runtime integration and artifact registration pass; the full existing suite, typecheck, and production build pass. Phase 1 is complete through #288 and #318.

### Phase 2: server

Phase 2 replaces the global loopback host with instance-scoped state, explicit dependencies, one route table, route ownership modules, and smaller services for multi-stage work. It is delivered in ordered green slices:

1. Add production dependency construction, narrow server-lifecycle dependencies, instance state, the server container, and request/response primitives. Keep `server.ts` as the production forwarding module and route all unmigrated requests through an internal fallback.
2. Add one route table containing method, path or prefix matching, body policy, owner, migration state, and handler. Its test compares the table with the Phase 0 compatibility record and exact fallback inventory.
3. Migrate liveness/source, operation status, repositories, identity/credentials, then graphs/planning. Each slice adds direct handler tests, side-by-side contracts, focused real-loopback tests, and a green workspace gate.
4. Migrate Azure discovery, environments, and deployments as thin HTTP adapters backed by services. Azure setup, environment create/list/status/delete, deployment dispatch/status/reset/delete, graph building, cache behavior, and workflows receive explicit state and only the external operations they use.
5. Remove each route from fallback after its new owner passes. Delete fallback only when the inventory is empty, then prove forwarding-module and built-artifact compatibility.
6. Consider request-size limits and centralized HTTP errors only after parity. If approved, ship them separately with explicit before-and-after HTTP contracts.

Phase 2 scaffolding in [#339](https://github.com/radius-project/ai-extensions/pull/339) delivered steps 1 and 2 and is merged. The constituent route-family slices are also merged. Final closeout is implemented in open stacked [#382](https://github.com/radius-project/ai-extensions/pull/382), whose authoritative proof has 40 route declarations, 40 concrete handlers, and zero residual fallback. Its gates are green except for the documented untouched Windows `operation-store.test.ts` chmod expectation. Phase 2 is not merged or complete on `main` until #382 lands and the merged tree passes the acceptance gate.

Phase 2 semantic gates:

- Preserve every current method, status, header, payload, stream frame, body behavior, cache scope, and fallthrough result during structural slices.
- Do not introduce an incidental request limit, `413`, global JSON `500`, success fallback, stream truncation, or response shape.
- If a server-sent event handler fails after headers, send that route's terminal error or completion frame and close exactly once.
- Preserve whether environment/deployment caches, workflow synchronization throttles, operation access, callbacks, and activity state are process-wide, container-wide, or per instance; two-instance tests distinguish scopes.
- Keep route ownership and dispatch in one table. Fail on duplicates, unowned routes, declarations without handlers, and any fallback route missing from the residual inventory.
- Keep route adapters limited to HTTP input/output. Multi-stage Azure, environment, deployment, graph-build, operation, cache, and workflow logic belongs in narrow services.
- Trigger an explicit decomposition review for any production server file above 750 lines; an exception must be recorded rather than assumed.

Acceptance: SU-01–SU-18 pass across success, validation, error, cache, operation, stream, and destructive branches; every route has exactly one owner; fallback is empty and deleted; external production adapters and global server maps are not imported by routes/services; existing canvas, core, and shared suites, typecheck, build, focused HTTP checks, and closing artifact checks pass after each slice.

### Phase 3: pages

Split the document shell from graph pages (`graph`, `planned`, `graph-diff`, `deployed`), environment pages (`credentials`, `environment`), and the deployment page (`deploying`). Keep browser scripts unchanged until Phase 4.

Tests compare meaningful fragments and serialized state rather than relying on broad full-page snapshots. Any intentional accessibility semantic change is identified separately from structural compatibility.

Acceptance: PU-01–PU-13 pass; existing page state branches are retained; operation progress and resume remain equivalent; every renderer is served through focused real-loopback checks; the forwarding module and built artifact remain complete; full tests, typecheck, and build pass.

Implementation is complete and green in open [#379](https://github.com/radius-project/ai-extensions/pull/379), ready for review but not merged. It includes PU-01–PU-13 and a durable 20-case semantic oracle generated from the exact pre-extraction source. The repaired Phase 3 head is `6cdee349d0c568fd50757332fc59a2dbfe664715`; its recorded `origin/main` ancestor is `196e821ae7ab251688507f93898ad7c34c124868`, with zero missing commits from that recorded base.

### Phase 4: browser

Add the in-memory browser build helper, shared fetch/navigation/timer/focus/polling helpers, form and graph modules, then entries for repository/branch, heartbeat, operation status, graph, credentials, environment, and deploying. The importable TypeScript becomes the only behavior source; production renderers inject its compiled inline scripts.

Phase 4 unit tests do not claim browser layout, real focus, React Flow, iframe, or accessibility coverage. Those begin in Phase 6.

Acceptance: BU-01–BU-14 pass; `client.ts` is removed or contains forwarding only; page templates contain no independent executable behavior; generated scripts are deterministic and inline-safe; production creates no new browser asset request; full tests, typecheck, build, and artifact checks pass.

Implementation is in progress on branch `nicolejms-extract-phase-4-browser`, stacked directly on [#379](https://github.com/radius-project/ai-extensions/pull/379). BU-01–BU-14 are the active acceptance scope. Phase 4 is not complete, and this work does not claim browser layout, real focus, React Flow, iframe, accessibility, keyboard, or Chromium coverage.

### Phase 5: Node boundaries

Consolidate the focused checks from Phases 1–4 and fill remaining cases:

- **Runtime integration**: declaration/schema serialization; open, action, reopen, close, rehydrate, and provider-failure routing; keepalive; worktree branch; explicit graph-diff branches; same-instance source-reference reload.
- **HTTP integration**: destructive fail-closed behavior; operation lookup and safe resumability; deployment state/retry; worktree versus remote graph; plan outcomes; path confinement; credential errors; server-sent event, progress, heartbeat, cross-site mutation, malformed body, and cleanup contracts.
- **Built-extension smoke**: exactly one session registration; expected canvas, actions, tools, hooks, pages, and browser entries; external SDK imports; no source-only/test path or missing dynamic asset; clean startup and shutdown.

Acceptance: all three suites pass without live GitHub or cloud access, produce bounded secret-free logs, and become required pull-request and publish gates.

### Phase 6: Chromium behavior

Browser component and functional tests cover graph source links, details, diff status, single event binding, credentials, environment safety, setup progress and resume, deployment states and retry, repository/branch selection, heartbeat recovery, and unresolved planning states.

Critical journeys cover J-01 and J-03–J-11 with the real renderers and loopback server. J-02 remains represented through its missing-application handoff path and may be combined with J-01 fixtures.

Accessibility checks use WCAG 2.2 A/AA axe tags on every primary page and material loading, empty, error, and success state used by the journeys, with zero violations for configured rules. Keyboard checks cover logical tab order, visible unclipped focus, pointer-free controls, popup/dialog focus and Escape behavior, disabled semantics, associated and announced validation errors, status announcements, meaningful graph names, and diff state that is not conveyed by color alone.

Acceptance: required browser gates pass deterministically without a public CDN, personal authentication, or mutable repository; traces and screenshots are retained on failure.

### Phase 7: visual and extended regression

Visual checks use Playwright Chromium on `ubuntu-latest`, a canonical 900 × 900 viewport, a 600 × 900 narrow behavioral viewport where needed, fixed locale/timezone/motion/fonts/assets/theme, and the VI-01–VI-07 states in Appendix D. Dynamic timestamps, ports, run IDs, and animation are fixed or narrowly masked. Broad masks and loose thresholds are prohibited. A baseline update needs an intended UI reason and human review of the diff.

Extended regression covers empty repositories and selection states, malformed graph/vendor data, cache expiry, repeated polling, partial GitHub/CLI responses, timeouts, multiple instances and cleanup, Windows/macOS paths and source references, and Chromium link behavior. It must add unique coverage rather than repeat required gates.

Acceptance: baselines are deterministic and reviewed; affected-path extended gates pass; scheduled failures are tracked; retry-only passes are recorded as flakes.

### Phase 8: real-host qualification

Prerequisites are a supported automatable Copilot desktop or CLI host, stable extension installation/discovery, non-personal test authentication, supported chat/tool/panel automation, an isolated disposable workspace with cleanup, and host/runtime/provider/renderer/loopback logs. A harness self-test distinguishes infrastructure failure from product failure and proves cleanup restores a known state.

Acceptance: HOST-01–HOST-07 pass on the controlled runner without personal credentials. Unavailable, skipped, emulated, cleanup-incomplete, or contract-only results do not qualify a release.

## Test data and controlled dependencies

Fixtures are deterministic, minimal, readable, and immutable by default. Tests require no personal login or internet access. Each test owns its server, workspace, mutable state, and clock where applicable; paths are synthetic and assertions are platform-neutral.

| Fixture set                            | Contents                                                                                                                                  |
|----------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `repo-session`                         | `octo/app`, worktree branch `feature/test`, workspace `.radius/app.bicep`                                                                 |
| `repo-remote`                          | Another repository with committed `main` and feature models                                                                               |
| `graph-small`                          | Container, gateway, datastore, secret, connections, and source references                                                                 |
| `graph-diff`                           | Added, removed, modified, and unchanged nodes plus added/removed edges                                                                    |
| `planned-resolved`                     | Built-in resource types with registered recipe-pack outputs                                                                               |
| `planned-unresolved-recipe`            | Existing type with no registered recipe pack                                                                                              |
| `planned-unsupported`                  | Service not provisionable on Azure, with an explicit error                                                                                |
| `credentials-azure`, `credentials-aws` | Verified/unverified profiles with placeholder identifiers                                                                                 |
| `deploy-states`                        | Queued, in progress, success, failure, cancelled, timed out, and deleting                                                                 |
| `operation-states`                     | Running, succeeded, warnings, action required, failed, partial, cancelled, acknowledged, and resumable records with redacted client views |
| `external-errors`                      | GitHub 401/403/404/500, missing command, timeout, malformed JSON, Radius command failure, and replication lag                             |

Controlled fakes cover GitHub contents, refs, branches, workflows, environments, deployments, packages, and identity; GHCR state bootstrap; `rad`, `az`, `aws`, `git`, and `gh`; workspace/filesystem identity; credential persistence; clocks; and polling. Tests assert both results and external calls. Any unspecified call throws.

## CI, retries, artifacts, and coverage

CI uses Node 24 and pnpm 11.19.0. The existing Build job on `ubuntu-latest` installs with the frozen lockfile, runs typecheck, lint, format check, unit coverage, and build, then uploads `plugins/radius/dist/`. Chromium installs only Playwright Chromium. Cache keys include the lockfile and Playwright version. HTTP workers use OS-assigned ports. Sharding is added only after measured need.

| Gate                         | Trigger                                                                    | Blocking point                                                           | Retry                                         |
|------------------------------|----------------------------------------------------------------------------|--------------------------------------------------------------------------|-----------------------------------------------|
| Unit and coverage            | Every push and pull request                                                | Required now                                                             | None                                          |
| Runtime integration          | Every pull request and `main` push                                         | Focused when introduced; complete gate in Phase 5                        | None                                          |
| HTTP integration             | Every pull request and `main` push                                         | Focused when introduced; complete gate in Phase 5                        | None                                          |
| Built-extension smoke        | Every pull request, `main` push, and publish                               | Focused when introduced; complete gate in Phase 5; always blocks publish | None                                          |
| Browser component/functional | Every pull request                                                         | Required in Phase 6                                                      | One diagnostic retry; flake tracked           |
| Critical journey             | Every pull request                                                         | Required in Phase 6                                                      | One traced diagnostic retry                   |
| Accessibility/keyboard       | Every pull request                                                         | Required in Phase 6                                                      | One diagnostic retry                          |
| Visual                       | Every pull request                                                         | Required for selected and affected states in Phase 7                     | One diagnostic retry; human-reviewed baseline |
| Windows/macOS Node matrix    | Nightly and affected path/process/managed-binary/source-link pull requests | Required when path-filtered; advisory nightly                            | None                                          |
| Extended resilience          | Nightly and on demand                                                      | Advisory; failure is tracked                                             | One diagnostic retry                          |
| Real-host                    | Weekly, manual, and before release                                         | Release qualification only                                               | At most one diagnostic retry                  |

Default test timeouts are 5 seconds for unit, 10 seconds for browser component/functional, 15 seconds for runtime/HTTP integration, 30 seconds for built-extension and each journey/accessibility/keyboard/visual case, and harness-defined bounded values for real-host. Tests use condition-based waits and controlled clocks. Fixed sleeps are allowed only when testing timer behavior.

A retry-only pass is a flake. Quarantine requires a linked issue, named owner, narrow isolation, and expiry/remediation condition. Safety, branch, path-confinement, external-error, or destructive-operation tests cannot be quarantined.

Upload `coverage/coverage-summary.json` and `coverage/lcov.info` on every run with bounded retention. On failure only, upload Playwright HTML, the first-retry trace, screenshots, visual expected/actual/diff images, machine-readable results, and relevant redacted extension/server logs.

The accepted aggregate and per-package V8 baseline lives in version-controlled configuration and may not decrease without explicit design-review justification. New runtime, route, renderer, and browser modules target at least 80% line, 80% function, and 70% branch coverage. Generated scripts, vendored libraries, and fixtures are excluded. Named scenarios remain required regardless of percentages.

## Security and compatibility

- Pull-request tests use no personal credentials, inherited tokens, live cloud resources, mutable repositories, or live package publication.
- Servers bind only to `127.0.0.1`; tests use OS-assigned ports.
- HTTP checks explicitly cover cross-site mutation protection, malformed bodies, approved request-size boundaries, traversal, workspace confinement, and destructive fail-closed behavior.
- RU-09 and RU-10 require path confinement for both publish tools.
- Controlled data uses obvious placeholder secrets. Logs and artifacts redact credential-bearing requests, responses, and inherited environment values.
- Tests inject vendor content rather than using unpkg.
- Every harness closes servers, streams, subprocesses, browser contexts, workspaces, and installed extensions after success or failure.
- Windows and macOS remain supported development environments and receive path/process/managed-binary/source-link Node coverage.
- Except for the four Phase 0 removals recorded in Appendix A, later phases preserve canvas values, retained schemas, the current 40 route contracts, selected markup, branch behavior, and the single artifact.

## Entry and completion criteria

Entry for a phase: the previous phase is green; its compatibility and coverage records are available; the active pull request contains one reviewable seam and no preparatory work for a later phase.

Overall completion: every CA, TL, RF, PG, LC, J, RU, SU, PU, and BU requirement has a passing owner or approved deferral; required PR and publish gates pass; visual baselines are reviewed; real-host qualification passes; no live credential or external mutation is needed; and the build remains one loadable `plugins/radius/dist/extension.mjs`.

## Open decisions

1. Should identity and credential routes share one file or use separate handler/service modules under the same ownership family?
2. Should the Windows/macOS matrix block affected pull requests or remain advisory and nightly?
3. How long should coverage and failure artifacts be retained?
4. Should scheduled resilience failures create an issue automatically or only report?
5. Which controlled runner owns real-host qualification and credential rotation?
6. Should compatibility records for removed action/tool declarations remain permanently as history?
7. What maximum request-body size and centralized HTTP error shape, if any, should be approved after route parity?

## Appendices

### Appendix A: compatibility inventory

#### Accepted actions

| ID    | Action                | Input                                                                      | Required contract                                                                             |
|-------|-----------------------|----------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| CA-05 | `get_graph_resources` | `missingOnly` (boolean, default true), `view` (`graph`, `planned`, `diff`) | Not-ready; active/explicit view; missing/all; application filtering; context token            |
| CA-06 | `update_source_refs`  | `refs` array of `{ id, codeReference }`, `contextToken`                    | Missing input; stale-token rejection; update/queue/skip; page selection; same-instance reload |

#### Accepted tools

| ID    | Tool                                   | Required contract                                                                                        |
|-------|----------------------------------------|----------------------------------------------------------------------------------------------------------|
| TL-02 | `radius_generate_app`                  | Workspace analysis and authoritative bundled skill content, including standalone installs                |
| TL-05 | `radius_generate_pr_diff_markdown`     | Repository/base/head mapping, fetch failure, Mermaid and summary result/error                            |
| TL-07 | `radius_publish_custom_type_extension` | Workspace confinement, managed Radius command, defaults, output/error                                    |
| TL-08 | `radius_publish_recipe`                | Workspace confinement, GHCR target validation, publish output/error                                      |
| TL-09 | `radius_deploy`                        | Attempt identity, environment/repository/branch/provider mapping, dispatch, repeat-last behavior, errors |
| TL-10 | `radius_deploy_status`                 | In-progress/success/failure, log bounds, workflow URL, diagnostics                                       |

Every retained action/tool has unit or runtime-integration coverage. Tools reaching a loopback API also have HTTP integration. Path confinement and error propagation are mandatory for both publish tools.

#### Historical Phase 0 removals

These declarations are not part of the current accepted surface. Their old shapes remain traceable through Phase 0 compatibility records.

| Action ID/action           | Old action input                                                     | Tool ID/tool                      | Reason removed                                                                       |
|----------------------------|----------------------------------------------------------------------|-----------------------------------|--------------------------------------------------------------------------------------|
| CA-01 `configure_oidc`     | Provider and Azure/AWS identity fields                               | TL-01 `radius_configure_oidc`     | Duplicated the credential-page flow; tool ignored its provider argument              |
| CA-04 `create_environment` | Name, provider, repository, and provider-specific environment fields | TL-06 `radius_create_environment` | Duplicated `/api/create-environment`; tool only instructed `open_canvas`             |
| CA-02 `render_graph`       | `resources` graph array                                              | TL-03 `radius_render_graph`       | Duplicated canonical branch-aware graph loading; tool only invoked its paired action |
| CA-03 `render_graph_diff`  | Base/head resources, repository, base/head branches                  | TL-04 `radius_render_graph_diff`  | Duplicated graph-diff open behavior                                                  |

#### Current route inventory: 40 routes in eight API families

| Requirement/family         | Exact methods and paths                                                                                                                                                                                                                                                          | Count |
|----------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------|
| RF-01 Liveness/source      | `ANY /api/ping`; `POST /api/open-source`                                                                                                                                                                                                                                         | 2     |
| RF-08 Operation status     | `GET /api/operations`; `GET /api/operations/…` (operation ID suffix); `POST /api/operations`; `POST /api/operations/:operationId/resume/:code`; `POST /api/operations/:operationId/abandon`                                                                                      | 5     |
| RF-02 Identity/credentials | `POST /api/oidc`; `POST /api/verify-azure-login`; `POST /api/verify-aws-login`; `POST /api/azure-cli-assist`; `GET /api/github-identity`; `POST /api/github-account`; `GET /api/credential-profiles`; `POST /api/save-credential-profile`; `POST /api/delete-credential-profile` | 9     |
| RF-03 Azure discovery      | `POST /api/azure-auto-setup`; `GET /api/list-azure-app-registrations`; `GET /api/azure-app-serves-repos`; `POST /api/discover`                                                                                                                                                   | 4     |
| RF-04 Repositories         | `GET /api/user-repos`; `POST /api/repo-branches`; `POST /api/discover-branches`                                                                                                                                                                                                  | 3     |
| RF-05 Graphs/planning      | `POST /api/load-graph`; `GET /api/load-graph-stream`; `GET /api/progress`; `GET /api/deployed-graph`; `POST /api/plan-graph`; `POST /api/diff-branches`                                                                                                                          | 6     |
| RF-06 Environments         | `POST /api/app-params`; `POST /api/create-environment`; `GET /api/list-environments`; `POST /api/delete-environment`; `GET /api/verify-status`                                                                                                                                   | 5     |
| RF-07 Deployments          | `GET /api/list-applications`; `GET /api/list-deployments`; `POST /api/deploy`; `GET /api/deploy-status`; `POST /api/delete-deployment`; `POST /api/deploy-reset`                                                                                                                 | 6     |

RF-09 owns page routing through `GET /?page=…`. Every API route requires a success HTTP contract and every applicable validation/error contract; destructive routes require explicit fail-closed cases.

#### Route-family acceptance

| ID    | Required contract                                                                                                                                                                     |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| RF-01 | Instance identity, safe path confinement, unavailable source handler, success, surfaced failure                                                                                       |
| RF-02 | Azure/AWS verification success/failure/malformed input; identity switch; profile list/save/update/delete; repository isolation; persistence errors                                    |
| RF-03 | Auto-discovery, application registrations, subject/repository-serving validation, infrastructure discovery, partial/failed responses                                                  |
| RF-04 | Empty/auth/failure states, sorting/default selection, branches, workspace branch preference                                                                                           |
| RF-05 | Workspace/remote selection, stream/progress, missing model, build errors, plan resolution, missing recipe pack, unsupported service, explicit diff branches, removed-source branch    |
| RF-06 | Parameter parsing, create validation/provider mapping, cache/expiry, workflow throttling, credential status, active-application guard, fail-closed delete                             |
| RF-07 | Queued/pending/in-progress/success/failure/cancelled/timed-out/deleting/deleted/unrelated states, branch dispatch, workflow publication, reset, cache invalidation, surfaced failures |
| RF-08 | Latest/by-ID lookup, null/unknown, safe projection, resumability, raw-failure redaction                                                                                               |
| RF-09 | Default and explicit pages, unknown page, active graph view, in-progress deployment redirect                                                                                          |

#### Seven pages

| ID    | Page          | Required states                                                                             |
|-------|---------------|---------------------------------------------------------------------------------------------|
| PG-01 | `credentials` | Azure/AWS profiles, verify/save/delete, errors, keyboard/focus                              |
| PG-02 | `graph`       | Workspace load, empty/missing model, resources, details, source links, errors               |
| PG-03 | `planned`     | Environment selection, resolving/resolved, missing recipe pack, unsupported service, errors |
| PG-04 | `graph-diff`  | Base/head discovery; added/removed/modified/unchanged resources and edges                   |
| PG-05 | `deployed`    | Topology, progress/activity, pending/success/failure                                        |
| PG-06 | `environment` | List/create/delete, profile, operation progress/action/resume, safety errors, subtab        |
| PG-07 | `deploying`   | Applications, deploy, polling, reset, delete, fail-closed states                            |

### Appendix B: lifecycle and journey requirements

#### Lifecycle, state, and branch

| ID    | Requirement                                                                                                                  |
|-------|------------------------------------------------------------------------------------------------------------------------------|
| LC-01 | Default open displays the expected default page                                                                              |
| LC-02 | Every valid page input opens the matching page                                                                               |
| LC-03 | Invalid canvas input is rejected before provider dispatch                                                                    |
| LC-04 | The same `instanceId` reuses its server/port and preserves domain state                                                      |
| LC-05 | Different instance IDs isolate transient server/UI state                                                                     |
| LC-06 | Reopen/focus preserve the supplied page                                                                                      |
| LC-07 | Provider rehydrate/open are idempotent                                                                                       |
| LC-08 | `onClose` removes the instance and closes its server                                                                         |
| LC-09 | Shutdown closes every remaining server exactly once                                                                          |
| LC-10 | Session-repository graph/planned views use the current worktree branch, never `main`                                         |
| LC-11 | A different repository/branch uses committed remote `.radius/app.bicep`                                                      |
| LC-12 | Graph diff compares explicit committed base/head branches                                                                    |
| LC-13 | Missing model triggers handoff once per repository/branch context                                                            |
| LC-14 | Heartbeat detects interruption and recovers the same page                                                                    |
| LC-15 | External errors are surfaced; no success-shaped fallback is returned                                                         |
| LC-16 | Deploy repair handoff preserves attempt identity across tool calls                                                           |
| LC-17 | Setup state survives navigation and supports safe polling, acknowledgement, and resume without exposing raw failure evidence |

#### Critical journeys

| ID   | Journey                                   | Primary assertion                                                                     |
|------|-------------------------------------------|---------------------------------------------------------------------------------------|
| J-01 | Open modeled graph for session repository | Worktree branch, graph render, local source open                                      |
| J-02 | Open repository without model             | Clear de-duplicated handoff; no fabricated graph, type, or recipe                     |
| J-03 | Plan application in environment           | Profile/environment, resolved output, missing-recipe message                          |
| J-04 | Compare application branches              | Explicit base/head, correct nodes/edges/source branches                               |
| J-05 | Manage credential profile                 | Verify, save, select, validate, delete, focus, error                                  |
| J-06 | Create environment                        | Required fields, progress/result, workflow/credential calls                           |
| J-07 | Deploy application                        | Branch-consistent dispatch, pending/success/failure/retry                             |
| J-08 | Delete deployment/environment safely      | Active-app conflict, deleting state, fail-closed API errors                           |
| J-09 | Recover loopback interruption             | Recovery UI, selected view, no duplicate action                                       |
| J-10 | Update graph source references            | Valid/stale token, same-panel reload, links                                           |
| J-11 | Resume long-running setup                 | Navigation-safe polling, progress/action state, same identity, server-side raw errors |

### Appendix C: structural unit requirements

#### Phase 1 runtime: RU-01–RU-21

| ID    | Unit behavior                                                                                             |
|-------|-----------------------------------------------------------------------------------------------------------|
| RU-01 | Canvas ID, display name, description, seven page values, repository/base/head fields, schema immutability |
| RU-02 | Retained action names/descriptions/required fields/enums and reserved-name exclusion                      |
| RU-03 | Retained tool names/schemas/descriptions and unique names                                                 |
| RU-04 | Removed action/tool declarations absent; prior shape recorded                                             |
| RU-05 | Graph-resources not-ready, active/explicit view, missing/all, filtering, context                          |
| RU-06 | Source-reference missing/stale input, update/queue/skip, page, reload                                     |
| RU-07 | Generate-app workspace analysis and bundled skill, including standalone fallback                          |
| RU-08 | PR-diff repository/base/head mapping, fetch failure, Markdown result                                      |
| RU-09 | Custom-type publish confinement, defaults, invocation, errors                                             |
| RU-10 | Recipe publish confinement, GHCR validation, errors                                                       |
| RU-11 | Deploy attempt identity, input mapping, dispatch, repeat-last, failure                                    |
| RU-12 | Deploy status, log bounds, workflow URL, diagnostics                                                      |
| RU-13 | Default/all pages, active graph view, stable title/URL                                                    |
| RU-14 | Worktree branch, different-repository fallback, explicit branch                                           |
| RU-15 | Graph/planned model resolution and explicit diff preload                                                  |
| RU-16 | Missing-model handoff de-duplicates by repository/branch and never blocks open                            |
| RU-17 | Same-instance reuse and different-instance isolation                                                      |
| RU-18 | Close one instance; shutdown closes all exactly once                                                      |
| RU-19 | Additional context, permission/session callbacks, host keepalive, failures                                |
| RU-20 | Production joins once with factory result; factory tests never join                                       |
| RU-21 | Keepalive remains active during setup, observes terminal state, avoids duplicate cleanup                  |

#### Phase 2 server: SU-01–SU-18

| ID    | Unit behavior                                                                                                                 |
|-------|-------------------------------------------------------------------------------------------------------------------------------|
| SU-01 | Production defaults, narrow family/service dependencies, override order, missing-dependency errors, no broad success fallback |
| SU-02 | Initial state, reuse/isolation, start/stop/all idempotence, loopback binding, activity clock                                  |
| SU-03 | Request parsing, aliases, active view, unknown route/page, method mismatch, malformed body, one-table dispatch, serialization |
| SU-04 | Liveness/source safe path, line parsing, unavailable handler, success/failure                                                 |
| SU-05 | Repository discovery/list/branch sorting, empty/auth/error, default, workspace preference                                     |
| SU-06 | Azure/AWS identity and login verification success/failure/malformed input without interactive login                           |
| SU-07 | Profile list/save/update/delete, validation, persistence, repository isolation, errors                                        |
| SU-08 | Azure auto-setup, registration list, repository-serving validation, discovery results/errors                                  |
| SU-09 | Graph workspace/remote, missing model, handoff, stream/progress, filter, build error, provenance                              |
| SU-10 | Planning resolved output, existing type without recipe pack, unsupported Azure service, no fabricated singleton recipe        |
| SU-11 | Branch discovery/diff loading, removed-resource source branch, missing model, partial/failure                                 |
| SU-12 | App parameters, environment validation/provider mapping, workflow/state, invalidation, errors                                 |
| SU-13 | Environment cache/expiry, synchronization throttle, credential status, active-deployment guard, fail-closed delete            |
| SU-14 | Deployment queued/pending/in-progress/success/failure/cancelled/timed-out/deleting/deleted/unrelated matrix                   |
| SU-15 | Deploy/delete branch consistency, workflow pre-sync/publication, reset, invalidation, surfaced failures                       |
| SU-16 | Operation latest/by-ID, null latest, unknown 404, redaction, resumable identity                                               |
| SU-17 | Default/all/unknown page, active view, deploying redirect                                                                     |
| SU-18 | Forwarding module preserves exports, entries, URLs, and state                                                                 |

#### Phase 3 pages: PU-01–PU-13

| ID    | Unit behavior                                                                             |
|-------|-------------------------------------------------------------------------------------------|
| PU-01 | Shell document, title, theme, vendor, navigation, feedback, heartbeat, safe title/body    |
| PU-02 | HTML, JavaScript string, URL, and serialized-state escaping against injection/tag closure |
| PU-03 | Modeled graph initial/loading/resources/missing/error and workspace provenance            |
| PU-04 | Planned graph empty/resolving/resolved/unresolved/error and recipe guidance               |
| PU-05 | Graph diff selector/preloaded/empty/error and repository/base/head/source context         |
| PU-06 | Deployed graph pending/success/failure/activity/progress                                  |
| PU-07 | Credential Azure/AWS empty/list/form/verified/error and active subtab                     |
| PU-08 | Environment list/create/result/error/delete-conflict and profile selection                |
| PU-09 | Deploying empty/list/pending/success/failure/deleting/retry                               |
| PU-10 | Navigation, page values, form actions, IDs, roles, names, disabled/status semantics       |
| PU-11 | Removed-token and singleton-recipe guards remain                                          |
| PU-12 | `pages.ts` forwards every prior renderer with equivalent output                           |
| PU-13 | Operation progress/checklist/resume/action/terminal/status-chip/safe-error states         |

#### Phase 4 browser: BU-01–BU-14

| ID    | Unit behavior                                                                                                             |
|-------|---------------------------------------------------------------------------------------------------------------------------|
| BU-01 | Bundle determinism, entry isolation, syntax, inline safety, no runtime asset, build errors                                |
| BU-02 | Repository/branch normalization, workspace default, remote loading, stale/error/selector state                            |
| BU-03 | Heartbeat timing, one in-flight request, interruption/recovery, page preservation, teardown/timers                        |
| BU-04 | Graph normalization, hidden resources, IDs/labels/icons, source/definition paths, Windows conversion                      |
| BU-05 | Layout inputs, connections, diff node/edge status, removed-source branch, arrows/minimap                                  |
| BU-06 | Details open/toggle/close, one handler, focus restore, local/remote link, external fallback                               |
| BU-07 | Credential validation/provider switch/verify/save/delete/result and secret-safe errors                                    |
| BU-08 | Environment profile/required state/create/delete/conflict redirect/fail-closed errors                                     |
| BU-09 | Deploy parameters/state, deploy/delete/reset, transitions, retry                                                          |
| BU-10 | Navigation query and page/state preservation                                                                              |
| BU-11 | Binding idempotence, teardown, disabled/status/error behavior for every initializer                                       |
| BU-12 | Generated inline scripts expose only intended globals; renderers inject each once                                         |
| BU-13 | Legacy `CLIENT_*_JS` text checks replaced by behavior plus narrow build guards                                            |
| BU-14 | Polling survives navigation, ignores stale responses, preserves identity, acknowledges/dismisses without duplicate timers |

### Appendix D: visual and host inventories

#### Visual baselines

| ID    | State                                | Theme      |
|-------|--------------------------------------|------------|
| VI-01 | Modeled graph, details closed        | Light/dark |
| VI-02 | Modeled graph details                | Light      |
| VI-03 | Planned graph unresolved recipe pack | Light/dark |
| VI-04 | Graph diff with all statuses         | Light/dark |
| VI-05 | Credential profile list/form         | Light      |
| VI-06 | Environment list/create form         | Light/dark |
| VI-07 | Deploy success/failure               | Light      |

#### Real-host cases

| ID      | Case                                                       |
|---------|------------------------------------------------------------|
| HOST-01 | Discover/register Radius provider, canvas, and tools       |
| HOST-02 | Open `canvasId: radius` with `instanceId: radius-panel`    |
| HOST-03 | Confirm iframe readiness and loopback rendering            |
| HOST-04 | Invoke one read-only canvas action through runtime routing |
| HOST-05 | Reopen same instance; focus/reload without second panel    |
| HOST-06 | Close panel; confirm provider/server cleanup               |
| HOST-07 | Reload/reconnect provider and restore open instance        |

### Appendix E: quality-risk traceability

| ID    | Risk                                                     | Primary control                          |
|-------|----------------------------------------------------------|------------------------------------------|
| QR-01 | Browser script compiles but fails in real DOM            | Browser component/functional and journey |
| QR-02 | Session branch replaced by `main`                        | LC-10 across runtime, HTTP, journey      |
| QR-03 | Duplicate server or lost instance state                  | LC-04/LC-05 runtime and HTTP             |
| QR-04 | External failure shown as success or enables destruction | Fail-closed unit/HTTP/journey            |
| QR-05 | Graph link opens wrong branch/file or fails silently     | Browser and journey link checks          |
| QR-06 | Planned graph invents recipes/types                      | Planned-state records/assertions         |
| QR-07 | Unsafe deployment/environment deletion/state             | RF-06/RF-07 and J-08                     |
| QR-08 | Inaccessible controls, focus loss, keyboard trap         | Accessible queries, keyboard, axe        |
| QR-09 | CSS/graph rendering drift                                | Selected visual baselines                |
| QR-10 | CDN/network variance flakes CI                           | Injected vendor content                  |
| QR-11 | Green source omits required packaged code                | Built-extension smoke                    |
| QR-12 | Loopback mistaken for host coverage                      | Separate real-host suite/reporting       |
| QR-13 | Unknown consumer of removed declaration                  | Phase 0 audit/history                    |
| QR-14 | Setup becomes stale/non-resumable or leaks raw errors    | LC-17, RF-08, J-11                       |

### Appendix F: priority suite identifiers

These labels retain traceability to earlier design discussions. P0–P3 are test priorities, not implementation phases; the letter suffix identifies a suite group within that priority.

| Legacy plan ID | Current name                                             |
|----------------|----------------------------------------------------------|
| P0-A           | Runtime integration suite, Phase 5                       |
| P0-B           | HTTP integration suite, Phase 5                          |
| P0-C           | Built-extension smoke suite, Phase 5                     |
| P1-A           | Browser component and browser functional suites, Phase 6 |
| P1-B           | Critical journey suite, Phase 6                          |
| P1-C           | Accessibility and keyboard suites, Phase 6               |
| P2-A           | Visual baselines, Phase 7                                |
| P2-B           | Extended resilience gates, Phase 7                       |
| P3-A           | Real-host harness qualification, Phase 8                 |
| P3-B           | HOST-01–HOST-07, Phase 8                                 |
