# Phase 7 visual and reliability traceability

Phase 7 adds the reviewed Playwright visual suite (P2-A) in `test/visual/canvas-visual.test.ts` and the scheduled extended resilience gate (P2-B) in `.github/workflows/canvas-reliability.yml`. Both reuse the Phase 6 real Chromium harness and deterministic fake CLI boundary. No personal credential, live cloud, mutable repository, public content network, or inherited credential store is used.

## Visual baseline inventory

The visual suite fixes Chromium, a 1440 by 1000 CSS-pixel viewport, device scale factor 1, reduced motion, the locally bundled Inter variable font, explicit host theme tokens, hidden carets, disabled animation and transition timing, one worker, and loopback-only networking. Native `toHaveScreenshot` assertions own the reviewed PNGs. A screenshot change must state its product reason in the pull request and receive human review.

| ID    | Baselines                                                                                                                                        | Disposition |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------|-------------|
| VI-01 | `vi-01-modeled-graph-light.png`, `vi-01-modeled-graph-dark.png`                                                                                  | Covered     |
| VI-02 | `vi-02-modeled-graph-details-light.png`                                                                                                          | Covered     |
| VI-03 | `vi-03-planned-unresolved-light.png`, `vi-03-planned-unresolved-dark.png`                                                                        | Covered     |
| VI-04 | `vi-04-graph-diff-all-statuses-light.png`, `vi-04-graph-diff-all-statuses-dark.png`                                                              | Covered     |
| VI-05 | `vi-05-credential-profile-list-light.png`, `vi-05-credential-profile-form-light.png`                                                             | Covered     |
| VI-06 | `vi-06-environment-list-light.png`, `vi-06-environment-list-dark.png`, `vi-06-environment-create-light.png`, `vi-06-environment-create-dark.png` | Covered     |
| VI-07 | `vi-07-deploy-success-light.png`, `vi-07-deploy-failed-light.png`                                                                                | Covered     |

## Extended reliability inventory

`pnpm run test:reliability` runs on Ubuntu, Windows, and macOS each week and on manual dispatch. It selects the existing focused suites below rather than duplicating their behavior in a second harness.

| Phase 7 category                       | Owning checks                                                                                                                               |
|----------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| Empty or partial data                  | graph, planned graph, graph diff, deployed graph, environment, operation, and repository browser suites                                     |
| Expired caches                         | deployment artifact and environment/deployment route cache checks                                                                           |
| Repeated polling                       | heartbeat, environment, operation, repository, and deployed graph poll ownership checks                                                     |
| Cancellation races and late callbacks  | graph, planned graph, graph diff, deployed graph, environment operation, heartbeat, and lifecycle checks                                    |
| Timeouts                               | heartbeat deadlines, repository diff timeouts, bounded poll loops, harness server shutdown, and cleanup retries                             |
| Multiple instances                     | canvas server container instance isolation, concurrent stop, reopen, and per-instance state checks                                          |
| Cleanup                                | lifecycle timer/listener cleanup, Canvas harness construction unwind, server/process/page/temp-workspace cleanup, and global teardown       |
| GitHub authentication command behavior | `gh.test.ts` platform command construction on all matrix hosts plus `gh.windows.test.ts` real Windows process behavior in the scheduled job |
| Windows and macOS paths                | workspace confinement, graph source normalization, CLI quoting, and harness path behavior on native matrix hosts                            |

The scheduled Ubuntu visual job runs every baseline twice. A first-attempt failure followed by a retry pass is never silent: both Playwright configurations write a JSON retry-only report, print its count, and CI uploads the report with traces and HTML output. Safety tests remain in the non-retrying Phase 6 project.
