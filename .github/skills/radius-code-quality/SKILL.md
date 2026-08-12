---
name: radius-code-quality
description: 'Mandatory repository-wide engineering workflow for every production TypeScript or JavaScript change in radius-project/ai-extensions. Use whenever an agent adds, edits, refactors, or reviews code, tests, runtime behavior, HTTP routes, page renderers, browser behavior, build logic, or generated-extension inputs. Enforces the Radius Canvas re-architecture from PR #282, complete Vitest coverage with a goal of 100% coverage for changed production code, required boundary tests, and repository TypeScript/JavaScript conventions.'
argument-hint: 'The production-code change, bug, feature, or refactor to implement'
user-invocable: true
---

# Radius code quality

Apply this skill to every production TypeScript or JavaScript change in this repository. A code change is incomplete until its behavior is covered by unit tests, any boundary tests required by the test architecture are included, and the production design follows the approved re-architecture.

This skill turns the [test architecture and test plan proposed in PR #282](https://github.com/radius-project/ai-extensions/pull/282) into an implementation workflow. Read the complete documents before changing a seam they define:

- `docs/design/2026-08-radius-canvas-test-architecture.md`
- `docs/design/2026-08-radius-canvas-test-plan.md`

If those files are not present on the current branch, inspect their versions in PR #282 with `gh pr view`, `gh pr diff`, or the GitHub contents API. Do not guess at a requirement identifier, phase gate, route owner, page state, or test level.

## Required workflow

1. **Understand the change.** Read the affected production modules, their existing tests, package configuration, and relevant architecture or design documentation. Trace callers and external boundaries before editing.
2. **Classify the architecture seam.** Identify whether the change belongs to core, shared adapter, runtime, server, pages, browser, build and packaging, or plugin packaging. For Canvas re-architecture work, identify the PR #282 phase and requirement IDs affected.
3. **Choose the required test levels.** Unit tests are mandatory for production logic. Add the cheapest additional test level that genuinely exercises every changed boundary; use the mapping below.
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

- `extension.ts` is the composition root and the only module that calls `joinSession()`. Put canvas declarations, tools, hooks, lifecycle, and handlers behind factories in `src/runtime/` with injected dependencies.
- Own per-instance state, caches, callbacks, server lifecycle, and clocks in the instance-scoped server container. Do not add process-global mutable state.
- Construct one complete typed production dependency object at the composition root. Give route families and services only narrowed dependency views. Missing dependencies fail during construction; never install a silent success-shaped default.
- Keep one route table as the source of truth for method, path, matching, body policy, and handler. Every route has exactly one owner.
- Keep route handlers thin: parse HTTP input, call a use-case service, and serialize its result. Multi-stage setup, graph, environment, deployment, operation, cache, or workflow behavior belongs in independently testable services with narrow ports.
- Preserve methods, status codes, headers, payloads, stream framing, fallthrough behavior, and state scope during structural moves. Contract hardening such as a request-size limit or a centralized error envelope is a separate, explicitly approved behavior change with before-and-after HIT coverage.
- Split pages by responsibility into the shared shell, graph pages, environment and credential pages, and deployment pages. Preserve stable markup, serialized state, escaping, theme tokens, URLs, operation states, and accessibility semantics.
- Put executable browser behavior in importable TypeScript under `src/browser/`. Expose explicit initialization and teardown with narrow ports for network, navigation, clocks, external opening, and DOM access. Compile those modules to deterministic inline IIFEs; do not maintain behavior as source strings or duplicate it in page templates.
- Keep already testable helper modules in place and inject them through the composition root. Re-architecture is a surgical seam extraction, not a repository-wide file shuffle.
- Preserve one loadable generated artifact at `plugins/radius/dist/extension.mjs`, with Copilot SDK imports externalized. Never hand-edit generated output.
- Compatibility facades may bridge a migration but contain no independent behavior. Record their deletion gate and remove them when callers migrate.

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
- Put all non-unit Canvas suites under `packages/adapter-canvas/test/`: `component/`, `functional/`, `integration/`, `e2e/journeys/`, `accessibility/`, `keyboard/`, `visual/`, and `host/`.
- Put reusable deterministic data and fakes in `test/fixtures/`, and non-unit harness setup in `test/setup/`. Production code must never import test support.

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
- A test that passes only on retry is a flake. Do not add retries to UT, RCT, or HIT. Never quarantine a safety, branch-selection, or destructive-action test.

## Required test level by change

Use the PR #282 taxonomy exactly:

| Changed boundary                                                              | Required evidence beyond collocated unit tests                                                                                                                           |
|-------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Runtime factory, declaration, action, tool, hook, open, or close              | Focused RCT using the real runtime composition with a fake SDK session                                                                                                   |
| Server container or dispatcher                                                | Focused HIT using a real ephemeral loopback server and deterministic external fakes                                                                                      |
| Route-family migration                                                        | Differential legacy-versus-new contracts while both paths exist, plus HIT for success and applicable validation, failure, stream, cache, state, and fail-closed behavior |
| Page renderer migration                                                       | Facade contract tests for semantic markup, serialized state, escaping, stable IDs, and required markers, plus focused page HIT                                           |
| Browser entry or helper migration                                             | Importable behavior tests plus generated-IIFE parse and execution contract smoke                                                                                         |
| Build, runtime composition, facade completion, or structural phase completion | Targeted ART against the real bundle and an SDK registration stub                                                                                                        |
| Browser DOM interaction                                                       | BCT or BFT in real Chromium; use Testing Library and `user-event`, with MSW at the network boundary                                                                      |
| Critical multi-page or browser/server journey                                 | Playwright E2E with deterministic server adapters                                                                                                                        |
| Accessibility or keyboard behavior                                            | A11Y and KBD at the states and journeys affected                                                                                                                         |
| Stable visual behavior                                                        | Reviewed VIS baseline only when the changed state is in the approved visual set                                                                                          |
| Real host discovery or panel lifecycle                                        | HOST; do not claim that HIT or an emulated contract covers the host                                                                                                      |

Choose the cheapest level that can faithfully represent the behavior, but do not stop at unit tests when the changed contract crosses a boundary. Focused RCT, HIT, and ART tests land with the seam they protect and are later promoted into permanent suites rather than duplicated.

## Coverage policy

- The goal is **100% line, statement, function, and branch coverage for every new or changed production-code path**.
- Treat 100% as a quality goal, not a mandate to force coverage through unnatural testing techniques. Do not expose production internals solely for tests, add test-only branches or hooks, over-mock implementation details, invoke unreachable states artificially, or write assertions whose only purpose is to execute a line. Prefer behavior-focused tests through natural seams; when a legitimate path cannot be exercised naturally, document the limitation as described below.
- Repository aggregate and per-package coverage must never decrease from the accepted version-controlled baseline described by PR #282.
- PR #282's 80% line, 80% function, and 70% branch thresholds for newly extracted modules are minimum migration gates, not the target for new work under this skill.
- Coverage percentages do not replace scenario gates. Explicitly test worktree branch selection, stale source-reference rejection, external-error propagation, path confinement, resumable operation identity, destructive fail-closed behavior, and retained action, tool, lifecycle, route, and artifact contracts whenever affected.
- Do not game coverage with ignored executable lines, uncovered allowlists, trivial assertions, or tests coupled to implementation details.
- Exclude only generated bundle text, vendored libraries, and test fixtures as defined by the test architecture.
- If 100% changed-code coverage is genuinely infeasible because of unreachable platform code or a tool limitation, document the exact uncovered path and reason in the pull request. Add the strongest behavior or boundary test available, and never lower a repository threshold automatically.
- Do not expand an unrelated change solely to cover pre-existing untouched code, but do not leave newly introduced branches or changed behavior untested.

## Verification

Run the smallest targeted Vitest command during implementation, then run all applicable repository gates from the workspace root:

```text
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
pnpm run build
```

Also run every required RCT, HIT, ART, browser, Playwright, accessibility, keyboard, visual, or host command introduced for the affected boundary. Do not report completion when a required suite is skipped, unavailable, or replaced by manual validation.

Before finishing, confirm:

- Every production behavior change has meaningful unit coverage.
- Changed production paths target 100% line, statement, function, and branch coverage.
- Required PR #282 boundary and scenario tests are checked in and executed.
- Architecture, package boundaries, state ownership, branch behavior, safety, and artifact contracts are preserved.
- Tests are deterministic, isolated, secret-free, and clean up all resources.
- Typecheck, lint, format, applicable tests, coverage, and build pass.
