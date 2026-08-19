---
name: radius-code-quality
description: 'Mandatory repository-wide engineering workflow for every TypeScript or JavaScript change in radius-project/ai-extensions. Use whenever an agent adds, edits, refactors, or reviews code, tests, runtime behavior, HTTP routes, page renderers, browser behavior, build logic, or generated-extension inputs. Enforces the Radius Canvas architecture, complete Vitest coverage with a goal of 100% coverage for changed production code, required boundary tests, and repository TypeScript/JavaScript conventions.'
argument-hint: 'The production-code change, bug, feature, or refactor to implement'
user-invocable: true
---

# Radius code quality

Apply this skill to every production TypeScript or JavaScript change in this repository. A code change is incomplete until its behavior is covered by unit tests, every delivered boundary it affects has the appropriate integration or browser evidence, and the production design follows the repository architecture.

The proposed [Radius Canvas test architecture and plan](https://github.com/radius-project/ai-extensions/pull/282) define the intended layer names, requirement IDs, inventories, and remaining rollout. Their phase tables are historical and are not present on `main`; determine current availability from the merged tree, package scripts, test configs, CI workflows, and checked-in traceability. Never use an unmerged stacked pull request as evidence of current `main` behavior.

## Current delivery state

| Phase | Current state | Delivered evidence                                                                                                                                                     |
|-------|---------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0–4   | Complete      | Compatibility and coverage records; runtime, server, page, and browser seams; every declared route singly owned with no legacy fallback; importable browser TypeScript |
| 5     | Complete      | Permanent runtime integration, HTTP integration, and built-extension artifact suites run in the pull-request gates                                                     |
| 6     | Complete      | PR #411 added the real Chromium browser-component, critical-journey, accessibility, and keyboard gates plus the production loopback-server harness                     |
| 7     | Not delivered | No approved visual baselines or scheduled reliability matrix; failure screenshots are diagnostics only                                                                 |
| 8     | Not delivered | No supported-host installation, discovery, panel-lifecycle, reopen, or reconnect qualification                                                                         |

The delivered Phase 6 scope is the browser-component suite plus the Playwright critical-journey, accessibility, and keyboard gates. A separate browser-functional directory is not a current required gate; the remaining real-form-submission journeys are tracked as follow-up work in issue #412. `packages/adapter-canvas/test/e2e/phase-6-traceability.md` and `packages/adapter-canvas/MANUAL-TESTING.md` were written against the narrower foundations scope and still describe that layer as outstanding; this skill records the gates CI actually enforces today. Do not treat the absent browser-functional layer as evidence that already ran, and do not describe loopback HTTP as real-host coverage.

Phase 7 visual and Phase 8 host suites are not delivered. Do not create them speculatively or claim their evidence; add them only when their phase is approved and implemented, then refresh this skill.

After each remaining automation phase completes, refresh this skill in a separate signed and signed-off pull request so its available suites and required gates never lag implementation. Base the refresh on the phase branch when the delivery is still stacked and unmerged, or on the newly updated `main` after merge.

## Required workflow

1. **Understand the change.** Read the affected production modules, callers, existing tests, package configuration, and relevant architecture or design documentation before editing.
2. **Classify the seam.** Identify whether the change belongs to core, shared adapter, runtime, server, pages, browser, build and packaging, plugin packaging, or a cross-cutting safety contract.
3. **Choose the required test levels.** Add collocated unit coverage for reachable production logic and the cheapest delivered higher layer that faithfully exercises every changed boundary.
4. **Implement through the intended seam.** Preserve dependency direction, instance ownership, public contracts, branch behavior, and artifact behavior. Never keep an architectural violation merely to simplify a test.
5. **Add tests in the same change.** Cover success, validation, edge cases, external failure, cleanup, and every changed branch. Refactors move or add their tests with the production module.
6. **Measure coverage.** Target 100% line, statement, function, and branch coverage for new and changed production paths. Add meaningful missing scenarios rather than coverage-only assertions.
7. **Run the complete applicable gate.** Use focused commands while iterating, then run the current CI-equivalent checks and every delivered boundary suite affected by the change. Manual validation never replaces checked-in automation.

## Architecture rules

### Package and composition boundaries

- `packages/core` owns UI-agnostic product logic. It must not depend on adapters, the Copilot SDK, HTTP implementations, the DOM, or browser globals. Represent outside behavior with typed ports.
- `packages/adapter-shared` owns reusable Node adapter behavior such as managed `rad` and Bicep execution.
- `packages/adapter-canvas` owns Copilot SDK wiring, loopback HTTP, server-rendered pages, browser behavior, and concrete external adapters.
- Adapters may depend on core; core never depends on an adapter. Move shared product behavior into core instead of copying it between adapters.
- `extension.ts` is the composition root and the only module that imports the SDK's `joinSession`. Runtime declarations, tools, hooks, lifecycle, and handlers belong behind factories in `src/runtime/` with injected dependencies.
- Own per-instance state, caches, callbacks, server lifecycle, and clocks in the instance-scoped server container. Do not add process-global mutable state.
- Construct one complete typed production dependency object at the composition root. Give route families and services narrowed dependency views. Missing dependencies fail during construction; never install a silent success-shaped default.
- Keep one route table as the source of truth for method, path, matching, body policy, and handler. Every route has exactly one owner.
- Keep route handlers thin: parse HTTP input, call a use-case service, and serialize its result. Multi-stage setup, graph, environment, deployment, operation, cache, or workflow behavior belongs in independently testable services with narrow ports.
- Keep page responsibilities split across the shared shell, graph pages, environment and credential pages, and deployment pages. Preserve stable markup, serialized state, escaping, theme tokens, URLs, operation states, and accessibility semantics.
- Put executable browser behavior in importable TypeScript under `src/browser/`. Expose explicit initialization and teardown with narrow ports for network, navigation, clocks, external opening, and DOM access.
- Compile browser modules in memory into deterministic self-contained inline scripts. Do not commit generated JavaScript, maintain behavior as source strings, duplicate it in templates, or fetch extension-owned browser modules at runtime.
- Preserve one loadable generated artifact at `plugins/radius/dist/extension.mjs`, with Copilot SDK imports externalized. Never hand-edit generated output.

### Safety and compatibility

- Preserve methods, status codes, headers, payloads, stream framing, body behavior, cache scope, and fallthrough results during structural work. Contract hardening is a separate, explicitly approved behavior change with before-and-after boundary tests.
- External errors must propagate as explicit failures; never return success-shaped fallbacks.
- Destructive environment and deployment operations fail closed whenever identity, preconditions, or external state cannot be established.
- If a server-sent event handler fails after headers are sent, emit that route's terminal error or completion frame and close exactly once.
- The session repository's graph and planned views use the current worktree branch, never an implicit `main`. Graph diff uses explicit committed base and head branches.
- Reject stale source-reference context tokens, confine filesystem paths to the workspace, and preserve deployment repair attempt identity.
- Bind test HTTP servers to `127.0.0.1` on operating-system-assigned ports. Close servers, streams, child processes, timers, browser contexts, and temporary workspaces on success and failure.
- Escape rendered HTML, JavaScript strings, URLs, and serialized state for their output context.
- Pass command arguments as an argv array. Never interpolate user-controlled values into a shell command or enable shell execution for them.
- Tests and diagnostics must not use personal credentials, inherited tokens, live cloud resources, mutable remote repositories, public CDNs, or secret-shaped fixture values.

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
- Add comments only for non-obvious invariants, safety constraints, or architectural intent.

## Delivered test layers

| Layer                                         | Location and configuration                                                                                                                                        | Command and current CI gate                                                                        |
|-----------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| Unit and coverage                             | Collocated `packages/*/src/**/*.test.ts`; package `vitest.config.ts` files; root `vitest.config.ts` and `coverage-baseline.json`                                  | `pnpm run coverage`; `build` job                                                                   |
| Runtime integration                           | `packages/adapter-canvas/test/integration/runtime/`; included by `packages/adapter-canvas/vitest.config.ts`                                                       | `pnpm run test:integration:runtime`; also included in root coverage                                |
| HTTP integration                              | `packages/adapter-canvas/test/integration/http/`; real loopback servers through `packages/adapter-canvas/vitest.config.ts`                                        | `pnpm run test:integration:http`; also included in root coverage                                   |
| Built-extension smoke                         | `packages/adapter-canvas/test/integration/artifact/` and `vitest.artifact.config.ts`; real built artifact in an isolated subprocess with an SDK registration stub | Run `pnpm run build` immediately before `pnpm run test:integration:artifact`; `build` job          |
| Browser component                             | `packages/adapter-canvas/test/component/` and `vitest.component.config.ts`; Vitest Browser Mode with Playwright Chromium, Testing Library, and `user-event`       | `pnpm run test:component`; `canvas-chromium` job                                                   |
| Critical journey, accessibility, and keyboard | `packages/adapter-canvas/test/e2e/canvas-chromium.test.ts`, support harness, and `playwright.config.ts`; Playwright and `@axe-core/playwright`                    | `pnpm run test:chromium`; `canvas-chromium` job                                                    |
| Windows process integration                   | `packages/adapter-canvas/src/gh.windows.test.ts`                                                                                                                  | `pnpm run test:integration:windows-process`; `windows-process-integration` job on `windows-latest` |

The regular Canvas Vitest config includes collocated tests, coverage-summary checks, Chromium harness unit tests, runtime integration, and HTTP integration with a 15-second timeout. Core and shared-adapter unit configs use Vitest's default 5-second timeout. The artifact config uses 30 seconds, the browser-component config uses 10 seconds, and Playwright uses 30 seconds per case. No separate browser-functional gate is required by current CI. Do not invent a visual, scheduled-reliability, or host directory until its phase delivers and wires one into a script and CI.

### Chromium harness contract

- Start the real production Canvas server through `getOrCreateServer` on `127.0.0.1` with an operating-system-assigned port. Drive the real route table, renderers, and compiled browser entries.
- Give every case an isolated temporary workspace, fake executable directory, `GH_CONFIG_DIR`, fake CLI scenario and log, placeholder tokens, and credential-store path established before production imports.
- Model `gh`, `rad`, `az`, and `aws` at the process boundary. Scenarios match exact argv prefixes and required environment state; an unmodeled command fails instead of returning a default success.
- POSIX uses executable shell shims. Local Windows Chromium runs require Go so global setup can build the `gh.exe` and `rad.exe` launch shim; `.cmd` shims cover all four fake CLIs. CI currently runs Chromium on `ubuntu-latest`, not Windows or macOS.
- Allow only the production loopback server origin in the Playwright browser context. Abort every other request and fail cleanup if any non-loopback request was attempted. Service workers remain blocked.
- Use the packaged local React, React DOM, React Flow, and dagre dependencies. Do not add CDN mirrors, network interception that disguises an external dependency, fake React, or a test-only asset loader.
- Global setup establishes credential isolation, warms the real server-module compilation, and prepares the Windows shim when needed. Global teardown sweeps the suite temporary root.
- Each fixture must close the page, stop and deregister its server, wait for active tasks and identity probes, reset shared state, restore environment variables, and remove its workspace. Cleanup failures are aggregated and reported; they are never swallowed.

### Test design and placement

- Collocate unit tests beside production as `*.test.ts`. Put non-unit Canvas suites and support under `packages/adapter-canvas/test/`; production code must never import test support.
- Keep deterministic reusable data under `test/fixtures/` and shared fakes and harnesses under `test/support/` or the owning suite's `support/` directory.
- Test observable behavior, not implementation text. Narrow source assertions may protect a build contract but cannot replace executable behavior.
- Use descriptive behavior-oriented names and table-driven cases only for genuine input matrices.
- Assert outputs, state transitions, and calls through ports. Do not merely prove that a mock returned its configured value.
- Cover happy paths, invalid and boundary values, external failures, malformed or partial responses, timeout behavior, idempotency, cancellation, retries where applicable, and cleanup.
- Use explicit deterministic fakes that fail on unspecified operations. Avoid broad module mocks and success-shaped defaults.
- Restore spies, fake timers, globals, environment variables, and module state. Tests must be order-independent and safe under their configured execution model.
- Use fake clocks and condition-based waits. Fixed sleeps are prohibited except when the sleep behavior itself is under test.
- Keep fixtures minimal, readable, immutable by default, platform-neutral, and secret-free. Add explicit Windows cases where path or process behavior matters.
- Small snapshots are acceptable for stable structural fragments. Broad snapshots never replace semantic, state, escaping, or error assertions.

### Retry and diagnostic policy

Vitest layers do not configure retries. In Playwright, `@safety` cases run in the `canvas-safety` project with zero retries; all other current Chromium cases run in the `canvas` project with one diagnostic retry. Safety, destructive, branch-selection, path-confinement, and redaction coverage must never pass through a retry.

The Playwright list reporter and HTML result classify a retry-only pass as flaky, so the original failure remains visible in the run output. The workflow uploads `test-results` and `playwright-report` only when the final Chromium job fails; a retry-only passing CI job therefore remains visible in the job log but does not receive an uploaded artifact. Report every retry-only pass as a flake and investigate it rather than rerunning or summarizing the gate as clean.

Failure traces use `retain-on-failure`, screenshots use `only-on-failure`, video is off, and the HTML report never opens automatically. These diagnostics are not Phase 7 visual baselines.

## Required test level by change

| Changed boundary                                                                                  | Required evidence beyond collocated unit tests                                                                                           |
|---------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| Runtime factory, declaration, action, tool, hook, branch context, open, or close                  | Runtime integration built from the real runtime composition with a fake SDK session                                                      |
| Server container, request parsing, dispatch, route, service, stream, cache, or destructive action | HTTP integration against a real loopback server with controlled external fakes                                                           |
| Page renderer or served page contract                                                             | Renderer tests for markup, state, escaping, IDs, and accessibility semantics plus HTTP integration proving the page is served            |
| Browser entry, helper, form, polling, navigation, focus, or teardown                              | Importable browser unit tests plus browser component or current Playwright evidence when real DOM or cross-boundary behavior is affected |
| Build, packaging, exports, dependencies, generated inputs, or structural completion               | Built-extension smoke against the real production build                                                                                  |
| Supported multi-page or browser-and-server workflow already represented in Phase 6                | Critical journey in the real Chromium harness                                                                                            |
| Accessibility or keyboard behavior in a represented material state                                | Real Chromium keyboard assertions and `@axe-core/playwright` checks                                                                      |
| Windows command resolution, quoting, or argv behavior                                             | Windows process integration on a real Windows runner                                                                                     |
| Stable visual behavior                                                                            | No automated gate exists yet; do not create or approve a baseline outside Phase 7                                                        |
| Real host installation, discovery, or panel lifecycle                                             | No automated gate exists yet; loopback and emulated contracts must not be reported as host coverage                                      |

Choose the cheapest faithful layer, but do not stop at unit tests when the changed contract crosses a delivered boundary. Higher layers complement unit tests and never excuse missing focused unit coverage.

Build scripts, configuration, and workflow generators are verified by artifact, configuration, or command-level checks rather than a forced unit test. Generated output such as `plugins/radius/dist/` is never hand-edited or tested directly; rebuild it from source and confirm it is in sync.

When the only faithful layer is not delivered, add the strongest honest evidence available and name the residual gap explicitly. Never close the gap by:

- Claiming an absent suite or layer ran, or renaming an existing suite to look like the missing one.
- Counting one layer's evidence as another's, such as reporting Playwright journeys as browser-functional coverage or loopback HTTP as real-host coverage.
- Manufacturing testability with broad module mocks, import-time side-effect juggling, source-substring assertions, private reach-through, or test-only production hooks.

Safety, branch-selection, path-confinement, external-error, redaction, and destructive-operation behavior is never deferred on these grounds.

## Coverage policy

- Target 100% line, statement, function, and branch coverage for every new or changed production path reachable through a real seam.
- Treat 100% as a quality goal, not permission to expose internals, add test-only hooks, over-mock implementation details, invoke impossible states, or write assertions whose only purpose is execution.
- Root V8 coverage includes `packages/*/src/**/*.ts`, excludes collocated test files, and emits text, JSON summary, and LCOV reports.
- `coverage-baseline.json` supplies the enforced aggregate, per-package, runtime, and browser thresholds in root `vitest.config.ts`. Do not hardcode drifting coverage counts in policy or pull-request prose.
- Aggregate and per-package coverage must not decrease. Raise the checked-in baseline alongside measured improvements; never lower it without explicit justification and review approval.
- The runtime scope retains configured branch, function, and line migration floors and intentionally sets no statement threshold. `packages/adapter-canvas/src/browser/**` is pinned at 100% statements, branches, functions, and lines.
- When a path in a 100%-pinned scope is genuinely unreachable, ignore only that exact path with the accepted V8 directive and an adjacent explanation of why it is unreachable and what would make it testable. Call it out in the pull request. Awkwardness is not a justification.
- Coverage percentages never replace named branch-selection, stale-token, path-confinement, external-error, cancellation, resumability, redaction, destructive fail-closed, lifecycle, route, or artifact scenarios.
- Never game coverage with broad ignores, uncovered allowlists, trivial assertions, or tests coupled to implementation details.

## Verification

Run focused commands while iterating. `pnpm run coverage` already executes the collocated Canvas tests, harness unit tests, runtime integration, and HTTP integration through `packages/adapter-canvas/vitest.config.ts`; use the dedicated runtime and HTTP commands for faster targeted work and to make affected-boundary evidence explicit.

The current pull-request workflow requires these Linux build-job commands from the workspace root, in this order:

```text
pnpm install --frozen-lockfile
pnpm run version:check
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
pnpm --filter @radius-project/adapter-canvas run demo:check
pnpm run build
pnpm run test:integration:artifact
```

The current Chromium job additionally requires:

```text
pnpm exec playwright install --with-deps chromium
pnpm run test:component
pnpm run test:chromium
```

The separate Windows job requires:

```text
pnpm run test:integration:windows-process
```

Also run these targeted commands whenever their boundary changes, even though root coverage includes them:

```text
pnpm run test:integration:runtime
pnpm run test:integration:http
```

Do not require absent Phase 7 visual or scheduled-reliability commands or Phase 8 host commands. Before finishing, confirm all affected delivered layers ran, architecture and safety contracts remain intact, coverage floors did not regress, retry-only Chromium passes are reported as flakes, and every acquired resource is cleaned up.
