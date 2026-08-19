# Phase 7 screenshots and reliability evidence

Phase 7 adds P2-A reviewed visual baselines and P2-B extended resilience checks without replacing the Phase 6 Chromium harness, real React/React Flow/dagre stack, loopback server, fake command boundary, network guard, traces, or fixtures. The suites remain local, deterministic, secret-free, and isolated from public networks, mutable repositories, personal credentials, and live cloud resources.

## P2-A visual baseline inventory

The visual suite uses Playwright native `toHaveScreenshot` assertions on the Ubuntu Chromium runner only. It fixes Chromium, viewport `900 × 900`, device scale `1`, UTC, `en-US`, reduced motion, light/dark media, DejaVu Sans, hidden carets, disabled animations, real packaged graph libraries, and fixed readable state. Exact pixels are required. Baseline changes are accepted only with a product reason and human review of the image diff.

| ID    | Baseline files                                                                                                                                             | Disposition                                                                                                 |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| VI-01 | `vi-01-modeled-graph-light.png`, `vi-01-modeled-graph-dark.png`                                                                                            | Modeled graph with three rendered cards and details closed.                                                 |
| VI-02 | `vi-02-modeled-graph-details-light.png`                                                                                                                    | Modeled graph with the web resource details panel open.                                                     |
| VI-03 | `vi-03-planned-unresolved-recipe-light.png`, `vi-03-planned-unresolved-recipe-dark.png`                                                                    | Terminal error names the unresolved type and required recipe pack without fabricating a resource or recipe. |
| VI-04 | `vi-04-graph-diff-all-statuses-light.png`, `vi-04-graph-diff-all-statuses-dark.png`                                                                        | Added, removed, modified, and unchanged resources appear together.                                          |
| VI-05 | `vi-05-credential-profile-list-light.png`, `vi-05-credential-profile-form-light.png`                                                                       | Fixed verified profile listing and the shared create-profile form.                                          |
| VI-06 | `vi-06-environment-list-light.png`, `vi-06-environment-list-dark.png`, `vi-06-environment-create-form-light.png`, `vi-06-environment-create-form-dark.png` | Fixed Environment listing and the second step of the create wizard.                                         |
| VI-07 | `vi-07-deploy-success-light.png`, `vi-07-deploy-failure-light.png`                                                                                         | Terminal deployment initiation and failure presentations.                                                   |

## P2-B reliability dispositions

The scheduled workflow runs the Node reliability selection on `ubuntu-latest`, `windows-latest`, and `macos-latest`, then runs the bounded Chromium race check and P2-A visual suite on Ubuntu. This is extended scheduled coverage, not Phase 8 real-host qualification.

| Phase 7 category                               | Automated evidence                                                                       | Disposition                                                                                                             |
|------------------------------------------------|------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| Empty or partial data                          | `azure-discovery.test.ts`, `deployments.test.ts`, `page.test.ts`, `environments.test.ts` | Empty lists remain explicit; partial/error payloads do not become success-shaped state.                                 |
| Expired caches                                 | `deploy-artifacts.test.ts`, `deployments.test.ts`                                        | Injected clocks and expired entries prove refetch and replacement.                                                      |
| Repeated polling                               | `page.test.ts`, `environments.test.ts`                                                   | Fake clocks cover poll caps, repeated pending state, stale identities, and timer removal.                               |
| Cancellation races                             | `canvas-reliability.test.ts`, `page.test.ts`, `environments.test.ts`                     | Eight real-browser abandon/resolve races supplement bounded unit races and stale-response fencing.                      |
| Timeouts                                       | `canvas-harness.test.ts`, `runtime-contracts.test.ts`, `page.test.ts`                    | Graceful-close deadlines, keepalive deadlines, bounded poll limits, and timeout cleanup are explicit.                   |
| Multiple instances                             | `runtime-contracts.test.ts`, `server-scaffolding.test.ts`                                | Reuse preserves one instance while distinct instance IDs keep isolated server state and ports.                          |
| Cleanup                                        | `canvas-harness.test.ts`, `runtime-contracts.test.ts`, Playwright global teardown        | Partial construction, normal completion, forced close, aggregate cleanup failure, and temporary-root sweep fail closed. |
| GitHub authentication commands on supported OS | `gh.test.ts`, `gh.posix.test.ts`, `gh.windows.test.ts` on the three-runner matrix        | The complete fake credential policy is platform-neutral; real process argv behavior runs on each supported OS.          |
| Windows and macOS paths                        | `workspace.test.ts`, `gh.posix.test.ts`, `gh.windows.test.ts` on native runners          | Native separators, paths with spaces, Windows quoting, and synthetic macOS/Linux workspace paths retain boundaries.     |

## Retry observability

Node, runtime, and HTTP checks have no retries. P2-A visual checks have no retries. Chromium behavior and P2-B Chromium checks allow one diagnostic retry, but `failOnFlakyTests: true` makes a retry-only pass fail the check. The original failure, retry result, trace, screenshot, and HTML report are uploaded from scheduled runs even when a later attempt passes, so a flaky pass cannot silently appear green.

## Exclusions

- PR #426 and commit `dc7008160273c8bdbfdffbf5726436609d366a52` are not included or duplicated.
- HOST-01 through HOST-07 and real secure-store behavior remain Phase 8. Loopback Chromium and native fake-command process checks are not reported as host qualification.
- The only production behavior change clears stale graph-loading content after a terminal planning error or app-bicep handoff. VI-03 exposed the defect, and focused browser unit coverage protects the error, incomplete-response, request-failure, handoff, and absent-container paths.
