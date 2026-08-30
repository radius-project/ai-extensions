# Radius Canvas test plan

- **Author**: Nicole James (@nicolejms)
- **Date**: 2026-08
- **Status**: Draft
- **Tracking issue**: [#334](https://github.com/radius-project/ai-extensions/issues/334)
- **Design PR**: [#282](https://github.com/radius-project/ai-extensions/pull/282)

## Purpose

The [test architecture](./2026-08-radius-canvas-test-architecture.md) explains the system, the problems this work addresses, and the chosen design. This plan tracks delivery, required checks, and the exact requirements. It does not repeat the architecture discussion.

Start with the status table. Use the phase sections for the work still to come. Use the appendices when a pull request needs an exact action, tool, route, page, workflow, screenshot, or host case.

## Current status

| Phase | Status      | Outcome                                                                                      | Evidence                                                                                                                                                                                                                                                         |
|-------|-------------|----------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0     | Complete    | Recorded the original behavior and removed four obsolete action/tool pairs                   | [#318](https://github.com/radius-project/ai-extensions/pull/318)                                                                                                                                                                                                 |
| 1     | Complete    | Made extension setup and lifecycle behavior testable without a live Copilot session          | [#288](https://github.com/radius-project/ai-extensions/pull/288), [#318](https://github.com/radius-project/ai-extensions/pull/318)                                                                                                                               |
| 2     | Complete    | Gave all 40 local API routes one owner and removed the old fallback path                     | [#339](https://github.com/radius-project/ai-extensions/pull/339) through [#382](https://github.com/radius-project/ai-extensions/pull/382) are merged                                                                                                             |
| 3     | Complete    | Split page rendering into smaller modules while preserving the seven page outputs            | [#379](https://github.com/radius-project/ai-extensions/pull/379) is merged                                                                                                                                                                                       |
| 4     | Complete    | Moved browser behavior into testable TypeScript and removed the duplicate JavaScript sources | Foundation [#393](https://github.com/radius-project/ai-extensions/pull/393) and graph [#394](https://github.com/radius-project/ai-extensions/pull/394) are merged; final browser behavior is in [#395](https://github.com/radius-project/ai-extensions/pull/395) |
| 5     | Complete    | Combine extension, local API, and packaged-extension checks into permanent CI gates          | —                                                                                                                                                                                                                                                                |
| 6     | Complete    | Test the interface in real Chromium, including keyboard and accessibility behavior           | —                                                                                                                                                                                                                                                                |
| 7     | Complete    | Add reviewed screenshots and scheduled reliability checks                                    | —                                                                                                                                                                                                                                                                |
| 8     | Not started | Test installation and panel lifecycle in a supported Copilot host before release             | —                                                                                                                                                                                                                                                                |

## Rules for every change

- Add focused tests with the production change. Manual checks do not replace automated tests.
- Use the simplest test that can reproduce the failure, then add a wider test only when the failure crosses a real boundary.
- Keep tests local and repeatable. Do not use personal credentials, live cloud resources, mutable repositories, or public network assets. Every pull request gate layer remains hermetic. The [Cloud E2E layer](./2026-08-cloud-e2e-environment-lifecycle.md) is the single, explicit exception: it exists to prove the facts a fake cloud cannot, runs only on a schedule or on demand, never gates a pull request, and uses dedicated test credentials and a dedicated fixture repository rather than personal ones.
- Show external failures as failures. If identity or state cannot be confirmed, deployment and deletion must stop.
- For the session repository, graph and plan views use the current worktree branch, not an assumed `main`.
- Close servers, streams, processes, timers, browser sessions, and temporary workspaces after success or failure.
- Every long-running workflow states whether close cancels it or leaves a durable, resumable operation running. Late work from a closed or superseded context must not mutate newer state.
- For local API changes, test cross-site mutation attempts, malformed bodies, approved request-size boundaries, path traversal, workspace confinement, and destructive actions that must stop safely.
- Preserve the seven page values, retained action and tool contracts, current 40 routes, branch behavior, and the single packaged extension unless a separate approved change says otherwise.

## Required checks

| Check                       | Required when                                                                    | What it protects                                                        |
|-----------------------------|----------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| Focused module tests        | Every behavior change                                                            | Rules, validation, state changes, escaping, and error handling          |
| Extension setup tests       | Canvas setup, actions, tools, lifecycle, callbacks, or branch handling change    | Registration, open, reopen, close, reconnect, and cleanup               |
| Local API tests             | A page route, API route, cache, stream, or destructive action changes            | Requests, responses, errors, state, cleanup, and safe failure           |
| Cancellation tests          | Async work, external calls, subprocesses, navigation, close, or shutdown changes | Leaked work, late mutation, false cancellation, and duplicate cleanup   |
| GitHub authentication tests | Token, account, scope, package, or `gh` command behavior changes                 | Wrong identity, unsafe fallback, leaked token, and unclear auth failure |
| Packaged-extension test     | Runtime, page, browser, dependency, build, or packaging changes                  | Missing code, duplicate setup, broken startup, and broken shutdown      |
| Chromium behavior tests     | Browser behavior changes after Phase 6 begins                                    | Real events, focus, forms, polling, navigation, and browser rendering   |
| End-to-end workflow tests   | A supported workflow crosses the browser and server                              | Regressions that smaller tests cannot see                               |
| Accessibility and keyboard  | An interactive page or material page state changes after Phase 6 begins          | Unusable controls, poor focus order, missing announcements, and WCAG    |
| Screenshot review           | A selected stable visual state changes after Phase 7 begins                      | Layout, clipping, theme, graph, and status presentation                 |
| Real-host check             | Before release after Phase 8 qualification                                       | Installation, discovery, panel lifecycle, focus, reopen, and reconnect  |
| Cloud E2E                   | Never required for merge; scheduled and on demand                                | That real Azure and GitHub accept what the extension sends              |

Tests that do not open a browser do not retry. Browser and host checks may retry once to collect useful failure information, but the original failure remains visible and a retry-only pass is recorded as flaky. Setting a check aside requires a linked issue, owner, narrow scope, and clear end condition. Safety checks cannot be skipped or set aside.

Cancellation is not a separate implementation phase. Add each test at the lowest boundary that owns the work, and add any missing production behavior in the same pull request. Phase 5 covers runtime, server, adapter, subprocess, and HTTP cancellation. Phase 6 covers browser abort, teardown, navigation, and stale results. Phase 7 adds bounded repeated races, timeouts, and cleanup checks. Phase 8 confirms close, reopen, and reconnect behavior in a supported host.

GitHub authentication follows the same approach rather than becoming a separate phase. Phase 5 covers injected `GH_TOKEN` and `GITHUB_TOKEN`, stored `gh` accounts, precedence, explicit account selection, required scopes, package credentials, redaction, and failures. Phase 6 covers the identity and account-selection UI. Phase 7 repeats the fake-credential matrix on supported operating systems. Phase 8 verifies a real secure credential store with disposable accounts and cleanup.

## Standard local check

Run the affected focused tests while working. Before completing a source change, run:

```console
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
pnpm run build
pnpm run test:integration:runtime
pnpm run test:integration:http
pnpm run test:integration:artifact
```

CI is authoritative for checks that require a controlled operating system or host.

## Completed phases

### Phases 0–2: record behavior, then separate runtime and server work

Phase 0 recorded the supported actions, tools, pages, routes, branch behavior, selected markup, package shape, and coverage baseline. Phase 1 made extension setup and lifecycle behavior testable without connecting to a real Copilot session. Phase 2 moved all 40 API routes to named owners, tested requests through a real local server, and removed the old fallback path.

Completion evidence: the matching requirements in the appendices pass; all 40 route declarations match 40 working handlers; no fallback route remains; and the packaged extension still loads.

### Phase 3: page rendering

Phase 3 split the shared page shell from graph, credential, environment, and deployment pages. A fixed 20-case record compares meaningful markup, state, escaping, IDs, and messages with the earlier implementation.

Completion evidence: PU-01–PU-13 pass, all seven pages are served through the real local server, and #379 is merged.

### Phase 4: browser behavior

Phase 4 moved graph, credential, environment, deployment, navigation, heartbeat, status, and polling behavior into importable TypeScript. Production builds those same modules into inline page scripts.

Completion evidence: BU-01–BU-14 pass; all 12 entries build safely and appear once; no extra browser file is requested while the page runs; the former `client.ts` and page-specific JavaScript strings are removed; browser coverage is 100% in all four measures; and extension, local API, page, build, and packaged-extension checks pass. Phases 0–4 do not claim real browser layout, focus, iframe, React Flow, accessibility, or keyboard coverage.

### Phase 5: permanent extension and server test gates

Combine the extension setup, local API, and packaged-extension checks already introduced by earlier phases. Fill any missing lifecycle, route, cleanup, branch, resume, package, cancellation, and GitHub authentication cases. Cover close or shutdown during startup, external calls, mutations, and subprocess execution; prove that late results cannot change newer state. Test injected tokens, stored accounts, scope-based fallback, explicit account choice, package credentials, redaction, and authentication failures without using real secrets. Make the complete checks required for pull requests and publishing.

Completion evidence: all three suites run without live GitHub or cloud access, produce short logs with no secrets, and block regressions in CI.

### Phase 6: real browser behavior

Run the interface in Chromium with controlled data. Cover the workflows in Appendix B, including graph details and links, GitHub identity and account selection, credentials, safe environment and deployment actions, branch selection, recovery, progress, resume, keyboard use, and accessibility. Prove that authentication errors and account mismatches are clear without exposing tokens. Prove that navigation and teardown abort browser-owned work, ignore late callbacks, and do not falsely report durable server work as cancelled.

Completion evidence: these checks are repeatable without a public content network, personal login, or mutable repository, and useful traces are saved when they fail.

### Phase 7: screenshots and reliability

Add the selected screenshots in Appendix D and scheduled checks for empty or partial data, expired caches, repeated polling, cancellation races, timeouts, multiple instances, cleanup, GitHub authentication command behavior on supported operating systems, and Windows/macOS paths. Screenshot changes require a clear product reason and human review.

Completion evidence: screenshots are stable, changed paths pass their reliability checks, and retry-only passes are recorded.

### Phase 8: supported-host qualification

Use a controlled Copilot host, non-personal authentication, disposable GitHub accounts, an isolated `GH_CONFIG_DIR`, and a disposable workspace to run HOST-01–HOST-07. Confirm host-injected-token and real `gh` secure-store behavior without reading or changing a developer credential. Confirm that closing, reopening, and reconnecting follow the documented cancel-or-continue policy. The harness must distinguish a test-system failure from a product failure and prove cleanup.

Complete when every host case passes before release. Skipped, simulated, or cleanup-incomplete runs do not count.

## Test data and safety

- Test data is small, readable, fixed, and uses obvious placeholder identities and secrets.
- Unexpected calls fail the test instead of returning a default success.
- Tests bind local servers to `127.0.0.1` on operating-system-assigned ports.
- Logs and saved failure files remove credentials and inherited environment values.
- Browser tests provide vendor code locally instead of downloading it from unpkg.
- Pull-request tests use a fake `gh`, placeholder tokens, and an isolated `GH_CONFIG_DIR`; only controlled host qualification may use a real secure credential store.
- Coverage for a package may not fall below its checked-in baseline. New modules target at least 80% line coverage, 80% function coverage, and 70% branch coverage. Named safety and error cases remain required regardless of the percentage.

## Completion

A phase starts only after the previous phase is green and its records are available. Keep each pull request reviewable and limited to its phase.

The full plan is complete when every requirement in the appendices has a passing test or an approved deferral, all required pull-request and publish checks pass, screenshots are reviewed, real-host qualification passes, no live credential or external mutation is needed, and the build still produces one loadable `plugins/radius/dist/extension.mjs`.

## Open decisions

1. Should production continue loading pinned vendor assets from unpkg, or should a later change package them? No, we are including vendor packages in the plugin
2. What request-size limit and common local API error format, if any, should be approved as a separate behavior change?

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
| TL-02 | `radius_generate_app`                  | Workspace analysis; compact skill handoff; packaged, source-checkout, and repaired-plugin discovery      |
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

The Phase 0 baseline recorded 37 routes. The authoritative Phase 2 closeout inventory contains 40 routes and is pinned by exact fixture, declaration, and concrete-handler set equality.

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
| LC-05 | A second instance ID is redirected to the session's one live panel rather than opening another                               |
| LC-06 | Reopen/focus preserve the supplied page                                                                                      |
| LC-07 | Provider rehydrate/open are idempotent                                                                                       |
| LC-08 | `onClose` removes the instance and closes its server                                                                         |
| LC-09 | Shutdown closes every remaining server exactly once                                                                          |
| LC-10 | Session-repository graph/planned views use the current worktree branch, never `main`                                         |
| LC-11 | A different repository/branch uses committed remote `.radius/app.bicep`                                                      |
| LC-12 | Graph diff compares explicit committed base/head branches                                                                    |
| LC-13 | Missing or stale model triggers handoff once per repository/branch *condition*; a changed condition reports again            |
| LC-14 | Heartbeat detects interruption and recovers the same page                                                                    |
| LC-15 | External errors are surfaced; no success-shaped fallback is returned                                                         |
| LC-16 | Deploy repair handoff preserves attempt identity across tool calls                                                           |
| LC-17 | Setup state survives navigation and supports safe polling, acknowledgement, and resume without exposing raw failure evidence |

#### Cancellation and abandoned work

| ID    | Requirement                                                                                                                                          |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| CN-01 | Every long-running workflow declares whether page, instance, session, and process close cancel it or leave a durable operation running               |
| CN-02 | Browser teardown aborts browser requests, timers, and polling; late callbacks cannot update the closed or superseded page                            |
| CN-03 | Durable work may outlive a canvas only when its operation identity and state are persisted, resumable, and shown as continuing                       |
| CN-04 | Cancellable GitHub, cloud, command-line, and filesystem calls receive a cancellation signal; uncancellable late results are fenced off               |
| CN-05 | Multi-step mutations check cancellation before irreversible steps and after external waits, then record any partial result without reporting success |
| CN-06 | Cancelling command-line work terminates only its child process tree and waits for bounded cleanup                                                    |
| CN-07 | Instance generation, operation identity, and graph context tokens prevent closed or superseded work from committing late results                     |
| CN-08 | Completion, cancellation, close, and shutdown races produce one terminal outcome and exactly-once cleanup                                            |

#### GitHub CLI authentication

| ID    | Requirement                                                                                                                                                     |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| GA-01 | `GH_TOKEN` and `GITHUB_TOKEN` work independently and follow explicit precedence when both are present                                                           |
| GA-02 | An injected token with required scopes remains the acting identity; scope-based fallback occurs only when a suitable stored account exists                      |
| GA-03 | With no injected token, `gh` uses the active stored account without reading the keychain or `hosts.yml` directly                                                |
| GA-04 | Explicit account selection wins across injected-token, keyring, multi-account, and enterprise-managed-user cases                                                |
| GA-05 | Package authentication requests the acting login's stored token before falling back to its injected token and surfaces missing package scopes                   |
| GA-06 | Missing, expired, revoked, malformed, unrecognized, insufficient-scope, timeout, token-read, status, and account-switch failures remain distinct and actionable |
| GA-07 | GitHub.com and unsupported GitHub Enterprise Server package paths cannot silently redirect credentials between hosts                                            |
| GA-08 | Tokens never appear in arguments, logs, snapshots, reports, browser state, or error text                                                                        |
| GA-09 | Pull-request tests use fake `gh` output, placeholder tokens, and isolated configuration; they never inspect or mutate a developer credential store              |
| GA-10 | Controlled host qualification verifies secure-store lookup and cleanup with disposable accounts separately from environment-token behavior                      |

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
| RU-07 | Generate-app workspace analysis; compact handoff; candidate order, required assets, and failure           |
| RU-08 | PR-diff repository/base/head mapping, fetch failure, Markdown result                                      |
| RU-09 | Custom-type publish confinement, defaults, invocation, errors                                             |
| RU-10 | Recipe publish confinement, GHCR validation, errors                                                       |
| RU-11 | Deploy attempt identity, input mapping, dispatch, repeat-last, failure                                    |
| RU-12 | Deploy status, log bounds, workflow URL, diagnostics                                                      |
| RU-13 | Default/all pages, active graph view, stable title/URL                                                    |
| RU-14 | Worktree branch, different-repository fallback, explicit branch                                           |
| RU-15 | Graph/planned model resolution and explicit diff preload                                                  |
| RU-16 | Missing-model handoff de-duplicates by repository/branch condition and never blocks open                  |
| RU-17 | Same-instance reuse; a later instance ID is redirected to the first claim, and release restores it        |
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
| QR-15 | Closed or superseded work leaks or mutates newer state   | CN-01–CN-08 across Phases 5–8            |
| QR-16 | Wrong GitHub identity, unsafe fallback, or leaked token  | GA-01–GA-10 across Phases 5–8            |

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
