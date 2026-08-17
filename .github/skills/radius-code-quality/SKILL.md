---
name: radius-code-quality
description: 'Mandatory repository-wide engineering workflow for every TypeScript or JavaScript change in radius-project/ai-extensions. Use whenever an agent adds, edits, refactors, or reviews code, tests, runtime behavior, HTTP routes, page renderers, browser behavior, build logic, or generated-extension inputs. Enforces the Radius Canvas re-architecture, complete Vitest coverage with a goal of 100% coverage for changed production code, required boundary tests, and repository TypeScript/JavaScript conventions.'
argument-hint: 'The production-code change, bug, feature, or refactor to implement'
user-invocable: true
---

# Radius code quality

Apply this skill to every production TypeScript or JavaScript change in this repository. A code change is incomplete until its behavior is covered by unit tests, any boundary tests required for the seams it touches are included, and the production design follows the repository's architecture.

The Architecture, TypeScript and JavaScript, Vitest, and Coverage rules below are standing repository policy and apply now.

The two Radius Canvas design documents are the authority for phase-specific migration detail, requirement IDs, inventories, and gates:

- `docs/design/2026-08-radius-canvas-test-architecture.md` — what Radius Canvas does, why the original structure resisted testing, the approved runtime/server/page/browser boundaries, the test layers, and the regression classes.
- `docs/design/2026-08-radius-canvas-test-plan.md` — the phase table and current status, test priorities and enforcement, per-phase acceptance and checked-in evidence, fixtures, CI gates, and the appendices holding the requirement IDs and the exact action, tool, route, page, lifecycle, journey, visual, and host inventories.

Read the relevant sections before changing a seam they define. Never guess at a requirement identifier, phase status, route owner, page state, or test level, and prefer the documents over this summary if they disagree. If the documents are not yet on the current branch, read them from the branch that introduces them or through the GitHub contents API.

Both documents track their own delivery status; consult the plan's phase table rather than assuming a phase is complete. Phases 0 and 1 are complete, so the compatibility records, coverage baseline, extracted runtime factories, and the runtime-integration and built-extension suites already exist. Later phases are not yet delivered, so do not assume their suites or extracted modules are available.

## Required workflow

1. **Understand the change.** Read the affected production modules, their existing tests, package configuration, and relevant architecture or design documentation. Trace callers and external boundaries before editing.
2. **Classify the architecture seam.** Identify whether the change belongs to core, shared adapter, runtime, server, pages, browser, build and packaging, or plugin packaging. For Canvas re-architecture work, find the affected phase and requirement IDs in the test plan's appendices.
3. **Choose the required test levels.** Unit tests are mandatory for production logic that is reachable through a real seam. Add the cheapest additional test level that genuinely exercises every changed boundary, using the mapping below and respecting which boundaries have actually been extracted.
4. **Implement through the intended seam.** Keep dependency direction, state ownership, public contracts, and artifact behavior consistent with the re-architecture. Do not preserve an architectural violation merely to make a test easy to write.
5. **Add tests in the same change.** Cover successful behavior, validation, edge cases, failures, cleanup, and every changed branch. Refactors move or add their tests with the production module.
6. **Measure coverage.** Target 100% line, statement, function, and branch coverage for new and changed production code. Inspect the report and add meaningful missing scenarios rather than coverage-only assertions.
7. **Run the complete applicable gate.** Run targeted tests while iterating, then the repository commands listed under Verification. A manually verified behavior does not replace a checked-in automated test.

## Architecture rules

### Package boundaries

- `packages/core` owns UI-agnostic product logic. It must not depend on adapters, the Copilot SDK, HTTP implementations, the DOM, or browser globals. Outside behavior is represented by typed ports.
- `packages/adapter-shared` owns reusable Node adapter behavior such as managed `rad` and Bicep execution.
- `packages/adapter-canvas` owns Copilot SDK wiring, loopback HTTP, server-rendered pages, browser behavior, and concrete external adapters.
- Adapters may depend on core; core never depends on an adapter. Shared product behavior moves into core instead of being copied between adapters.
- Use real deterministic core functions in adapter tests where practical. Do not duplicate core's unit tests in the Canvas package.

### Canvas re-architecture

- `extension.ts` is the composition root and the only module that imports the SDK's `joinSession`. Other runtime modules may invoke an injected session port, as `runtime/bootstrap.ts` does. Put canvas declarations, tools, hooks, lifecycle, and handlers behind factories in `src/runtime/` with injected dependencies, constructible without joining a real session.
- Own per-instance state, caches, callbacks, server lifecycle, and clocks in the instance-scoped server container. Do not add process-global mutable state.
- Construct one complete typed production dependency object at the composition root. Give route families and services only narrowed dependency views. Missing dependencies fail during construction; never install a silent success-shaped default.
- Keep one route table as the source of truth for method, path, matching, body policy, and handler. Every route has exactly one owner.
- Keep route handlers thin: parse HTTP input, call a use-case service, and serialize its result. Multi-stage setup, graph, environment, deployment, operation, cache, or workflow behavior belongs in independently testable services with narrow ports.
- Preserve methods, status codes, headers, payloads, stream framing, body behavior, cache scope, and fallthrough results during structural moves. Contract hardening such as a request-size limit, a `413`, a global JSON `500`, or a centralized error envelope is a separate, explicitly approved change shipped with before-and-after HTTP integration contracts, never a side effect of moving a route.
- If a server-sent event handler fails after headers are sent, emit that route's terminal error or completion frame and close exactly once.
- Keep server modules decomposed. Route family names assign ownership and do not justify one large file per family.
- Split pages by responsibility into the shared shell, graph pages, environment and credential pages, and deployment pages. Preserve stable markup, serialized state, escaping, theme tokens, URLs, operation states, and accessibility semantics.
- Put executable browser behavior in importable TypeScript under `src/browser/`. Expose explicit initialization and teardown with narrow ports for network, navigation, clocks, external opening, and DOM access. Compile those modules in memory into deterministic self-contained inline scripts; do not commit generated JavaScript, maintain behavior as source strings, duplicate it in page templates, or fetch the extension's own browser modules at runtime.
- Keep already testable helper modules in place and inject them through the composition root. Re-architecture is a surgical seam extraction, not a repository-wide file shuffle.
- Preserve one loadable generated artifact at `plugins/radius/dist/extension.mjs`, with Copilot SDK imports externalized. Never hand-edit generated output.
- Compatibility records and forwarding modules may bridge a migration but contain no independent behavior. While old and new paths coexist, record the exact residual fallback inventory, and delete the fallback only when that inventory is empty.

### Safety and compatibility

- External errors must propagate as explicit failures; never return success-shaped fallbacks.
- Destructive environment and deployment operations fail closed whenever identity, preconditions, or external state cannot be established.
- The session repository's graph and planned views use the current worktree branch, never an implicit `main`. Graph diff uses explicit committed base and head branches.
- Reject stale source-reference context tokens, confine filesystem paths to the workspace, and preserve deployment repair attempt identity.
- Bind test HTTP servers to `127.0.0.1` on OS-assigned ports. Close servers, streams, child processes, timers, browser contexts, and temporary workspaces on success and failure.
- Rendered HTML, JavaScript strings, URLs, and serialized state must be escaped for their output context.
- Pass command arguments as an argv array. Never interpolate user-controlled values into a shell command or enable shell execution for them.
- Tests and diagnostics must not use personal credentials, inherited tokens, live cloud resources, mutable remote repositories, or secret-shaped fixture values.

## TypeScript and JavaScript rules

- Use ESM and follow existing import conventions, including `.js` specifiers from TypeScript source where the repository does so.
- Preserve strict type safety. Prefer domain types, discriminated unions, type guards, and `unknown` narrowing over `any`, broad index signatures, non-null assertions, or chained casts.
- Do not use `as any` or `as unknown as` to bypass a contract. Improve the contract or provide a typed test fake.
- Keep public and cross-module contracts explicit. Keep types local when no other module needs them.
- Prefer small pure functions and explicit dependencies over hidden I/O, module mocking, or mutable globals.
- Represent I/O behind narrow ports and inject time, filesystem, process, network, GitHub, cloud, and persistence behavior when logic depends on it.
- Handle promises explicitly. Await work or deliberately aggregate it; do not leave floating promises or unobserved rejections.
- Validate untrusted data at the boundary. Preserve actionable errors and avoid broad catches that hide the original failure.
- Make cleanup idempotent and use `try/finally` when acquiring resources.
- Avoid speculative abstractions and unrelated refactors. Reuse existing helpers and patterns before adding another implementation.
- Follow the repository ESLint, TypeScript, and Prettier configuration. Use two-space indentation, double quotes, semicolons, no trailing commas, and LF endings as configured.
- Add comments only for non-obvious invariants, safety constraints, or architectural intent. Comments do not substitute for clear names and types.

## Vitest rules

### Unit-test placement and structure

- Collocate each unit test beside its production module as `*.test.ts`. There is no `test/unit/` directory.
- When production code moves, move its tests to the same destination in the same change.
- Put all non-unit Canvas suites under `packages/adapter-canvas/test/`. The plan's target layout is `integration/runtime`, `integration/http`, `integration/artifact`, `component`, `functional`, `e2e/journeys`, `accessibility`, `keyboard`, `visual`, and `host`. Only the directories for delivered phases exist today; do not create the rest speculatively.
- Put reusable deterministic data in `test/fixtures/` and shared fakes and harnesses in `test/support/`, following the existing layout. Production code must never import test support.
- A new suite directory only runs once it is added to `packages/adapter-canvas/vitest.config.ts` or a dedicated config such as `vitest.artifact.config.ts`, with a matching package script. Wire it up in the same change.

### Test design

- Test observable behavior, not implementation text. Source substring assertions may guard a narrow build contract but cannot replace executable behavior tests.
- Give tests descriptive behavior-oriented names. Keep arrange, act, and assert phases easy to identify without boilerplate comments.
- Use table-driven `it.each` or `describe.each` cases for genuine input matrices; do not obscure distinct behaviors merely to reduce line count.
- Assert meaningful outputs, state transitions, and calls through ports. Avoid assertions that only prove a mock returned its configured value.
- Cover the happy path, invalid input, empty and boundary values, external failure, malformed or partial responses, timeout behavior, idempotency, retries where applicable, and cleanup.
- Use explicit deterministic fakes that throw on unspecified operations. Do not use broad module mocks that silently succeed for behavior the scenario did not model.
- Reset or restore spies, fake timers, globals, environment variables, and module state. Tests must be order-independent and safe under parallel execution.
- Use fake clocks and condition-based waits. Fixed sleeps are prohibited except when the sleep behavior itself is under test.
- Keep fixtures minimal, readable, immutable by default, platform-neutral, and secret-free. Use repository-relative synthetic paths and explicit Windows cases where path behavior matters.
- Do not reach GitHub, GHCR, cloud APIs, public CDNs, user storage, local CLI login, or the internet from pull-request tests.
- Small snapshots are acceptable for stable structural fragments. Broad snapshots must not replace semantic, state, escaping, or error assertions.
- A test that passes only on retry is a flake. Unit, runtime-integration, and HTTP-integration tests never retry; Chromium layers allow at most one diagnostic retry with the original failure retained. Never quarantine a safety, branch-selection, path-confinement, external-error, or destructive-action test.
- Keep test timeouts within the plan's defaults: 5 seconds for unit, 10 seconds for browser component and functional, 15 seconds for runtime and HTTP integration, and 30 seconds for built-extension smoke and each journey, accessibility, keyboard, or visual case.

## When the testability work has not landed yet

The re-architecture is delivered in phases, so some areas are not yet reachable through a testable seam. Never force a test that the current structure cannot support honestly.

- Check the plan's phase table before deciding what is required. If the boundary a change touches has not been extracted, do not invent a suite, a directory, or a harness for it, and do not claim a layer ran when it does not exist.
- In an un-extracted area, add the strongest test the current structure genuinely supports, and say plainly which layer remains unavailable and which phase will deliver it.
- Do not manufacture testability with broad module mocks, import-time side-effect juggling, source-substring assertions standing in for behavior, private-internal reach-through, or test-only production hooks. Those techniques produce green tests that do not protect the risky behavior, which is the exact failure the re-architecture exists to fix.
- Prefer extracting the seam properly when the change is already touching it. Prefer a smaller honest test over a larger dishonest one otherwise, and never expand a change into an unrelated phase's extraction just to make a test possible.
- Newly added or changed logic still needs real unit coverage. This carve-out applies to the boundary layers a phase has not yet enabled, not to ordinary testable logic and not to a module that is simply awkward to test.
- Safety, branch-selection, path-confinement, external-error, and destructive-operation behavior is never deferred on these grounds. If it cannot be covered at the intended layer, cover it at the closest layer available and record the gap.

## Required test level by change

Use the test layer names from the design documents exactly: unit, runtime integration, HTTP integration, built-extension smoke, browser component, browser functional, critical journey, accessibility, keyboard, visual, and real-host. Do not reintroduce older acronyms for these layers.

Test priority is independent of implementation phase. **P0** layers are required pull-request gates, **P1** are required browser gates, **P2** are extended regression gates, and **P3** is release qualification. Priority controls delivery order and where a test blocks; it never makes a lower-priority test optional when that test is the only faithful check of the behavior a change touches.

| Changed boundary                                                                 | Required evidence beyond collocated unit tests                                                                                                                                                                      |
|----------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Runtime factory, declaration, action, tool, hook, branch context, open, or close | Runtime integration built from the real runtime composition with a fake SDK session                                                                                                                                 |
| Server container, request parsing, or dispatch                                   | HTTP integration against a real loopback server on an OS-assigned port with controlled external fakes                                                                                                               |
| Route-family migration                                                           | The residual fallback inventory, side-by-side old-versus-new contracts while both paths exist, and HTTP integration for success plus applicable validation, failure, stream, cache, state, and fail-closed behavior |
| Page renderer migration                                                          | Old-versus-extracted renderer contracts for meaningful markup, serialized state, escaping, stable IDs, and required markers, plus the page served through real loopback HTTP                                        |
| Browser entry or helper migration                                                | Importable behavior tests plus generated-script execution and renderer wiring checks proving deterministic inline output and no external runtime asset                                                              |
| Build, packaging, exports, dependencies, or structural phase completion          | Built-extension smoke against the real production build in a subprocess with an SDK registration stub                                                                                                               |
| Browser DOM interaction                                                          | Browser component or browser functional tests in real Chromium, using Testing Library and `user-event`, with Mock Service Worker at the network boundary                                                            |
| Supported multi-page or browser-and-server workflow                              | A critical journey in Playwright with controlled server data                                                                                                                                                        |
| Accessibility or keyboard behavior                                               | Automated WCAG 2.2 A/AA checks and keyboard coverage at the affected material and interactive states                                                                                                                |
| Stable visual behavior                                                           | A reviewed visual baseline, only when the changed state is in the selected visual set                                                                                                                               |
| Real host installation, discovery, or panel lifecycle                            | Real-host qualification; loopback HTTP and emulated contracts must never be reported as host coverage                                                                                                               |

Add a level when its boundary exists and can run. Phases 0 and 1 are complete, so unit tests, runtime integration (`packages/adapter-canvas/test/integration/runtime/`), and built-extension smoke (`packages/adapter-canvas/test/integration/artifact/`) apply now. HTTP integration applies as the server boundary lands in Phase 2, the Chromium layers become required gates in Phase 6, visual follows in Phase 7, and real-host is a scheduled and release gate in Phase 8 that never blocks a pull request. When a layer's infrastructure does not exist yet, add the focused evidence the active phase requires at the strongest available layer and state the gap plainly instead of inventing a suite or implying one passed.

Match the evidence to the kind of change:

| Change type                                     | Expected evidence                                                                     |
|-------------------------------------------------|---------------------------------------------------------------------------------------|
| Production logic                                | Collocated unit tests, plus the boundary rows above when a seam changes               |
| Build, packaging, or workflow generation        | Artifact, configuration, or command-level verification rather than a forced unit test |
| Test, fixture, or harness code                  | The suites it supports pass and remain deterministic                                  |
| Generated output such as `plugins/radius/dist/` | Rebuild from source and confirm the artifact is in sync; never hand-edit or test it   |

Choose the cheapest layer that can faithfully represent the regression, but do not stop at unit tests when the changed contract crosses a boundary. Higher layers complement unit tests and never excuse missing focused unit coverage. Focused tests introduced during an extraction land with the seam they protect and are later promoted into the permanent suites rather than duplicated or dropped.

## Coverage policy

- The goal is **100% line, statement, function, and branch coverage for every new or changed production-code path that is reachable through a real seam**.
- Treat 100% as a quality goal, not a mandate to force coverage through unnatural testing techniques. Do not expose production internals solely for tests, add test-only branches or hooks, over-mock implementation details, invoke unreachable states artificially, or write assertions whose only purpose is to execute a line. Prefer behavior-focused tests through natural seams; when a legitimate path cannot be exercised naturally, document the limitation as described below.
- When a changed path sits in an area whose testability work has not landed, meet the phase's required evidence and record the residual gap. Do not chase the percentage with broad module mocks or private reach-through, and do not treat the gap as permission to skip the coverage that the current structure does support.
- Repository aggregate and per-package coverage must never decrease. The accepted baseline lives in `coverage-baseline.json` and is enforced as Vitest thresholds in `vitest.config.ts`; treat it as a hard floor. Raise it alongside tested production changes, and never lower it without explicit justification and review approval.
- The 80% line, 80% function, and 70% branch thresholds that apply to newly extracted runtime, route, and renderer modules are minimum migration gates, not the target for new work under this skill. `packages/adapter-canvas/src/browser/**` has completed its migration and is pinned at 100% statements, branches, functions, and lines; that directory is held to the goal directly rather than to a migration gate.
- A directory pinned at 100% has no headroom, so the escape valve is explicit rather than silent. When a changed path in such a directory is genuinely unreachable — a defensive branch that only a violated invariant could reach, or a platform capability the test substrate cannot withhold — mark exactly that path with a `/* v8 ignore next */` comment whose adjacent line states why it is unreachable and what would have to change to make it testable, and call it out in the pull request for review. Never widen the ignore beyond the unreachable path, never ignore a path merely because covering it is awkward, and never lower the pinned threshold instead. An ignore without a justification comment, or one a reviewer has not accepted, is coverage gaming under the rule above.
- Coverage percentages do not replace scenario gates. Explicitly test worktree branch selection, stale source-reference rejection, external-error propagation, path confinement, resumable operation identity, destructive fail-closed behavior, and retained action, tool, lifecycle, route, and artifact contracts whenever affected.
- Do not game coverage with ignored executable lines, uncovered allowlists, trivial assertions, or tests coupled to implementation details.
- Exclude only generated bundle text, vendored libraries, and test fixtures as defined by the test architecture.
- If 100% changed-code coverage is genuinely infeasible, document the exact uncovered lines or branches and why they are structurally unreachable or blocked by an undelivered boundary, rather than merely inconvenient, and add the strongest behavior or boundary test available. Effort, time pressure, and test awkwardness do not qualify, and a repository threshold is never lowered automatically.
- Do not expand an unrelated change solely to cover pre-existing untouched code, but do not leave newly introduced branches or changed behavior untested.

## Verification

Run the smallest targeted Vitest command during implementation, then run the baseline pull-request check from the workspace root:

```text
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
pnpm run build
pnpm run test:integration:runtime
pnpm run test:integration:artifact
```

Also run every additional suite the active phase has introduced for the affected boundary. Do not report completion when a required suite is skipped or replaced by manual validation. When a layer does not exist yet, say so explicitly instead of implying it passed.

Before finishing, confirm:

- Every production behavior change that is reachable through a real seam has meaningful unit coverage.
- Those changed production paths target 100% line, statement, function, and branch coverage.
- The boundary and scenario evidence required by the affected phase is checked in and executed, and any layer that does not exist yet is named as an explicit gap rather than faked.
- Architecture, package boundaries, state ownership, branch behavior, safety, and artifact contracts are preserved.
- Tests are deterministic, isolated, secret-free, and clean up all resources.
- Typecheck, lint, format, applicable tests, coverage, and build pass.
