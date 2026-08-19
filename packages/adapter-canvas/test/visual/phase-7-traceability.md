# Phase 7 visual and reliability traceability

Phase 7 adds the Playwright visual suite (P2-A) in `test/visual/canvas-visual.test.ts` and the scheduled extended resilience gate (P2-B) in `.github/workflows/canvas-reliability.yml`. Both reuse the Phase 6 real Chromium harness and deterministic fake CLI boundary. No personal credential, live cloud, mutable repository, public content network, or inherited credential store is used.

## Visual baseline inventory

The fifteen PNGs in `__screenshots__/` are **proposed baselines awaiting human review**. They were captured by the Ubuntu GitHub-hosted runner, which owns the canonical rasterization, and they are not reviewed merely because continuous integration produced them. A reviewer must open each PNG and accept it before this suite is a trustworthy contract, and every later change to a PNG must state its product reason in the pull request and receive the same review.

The suite fixes Chromium, a 1440 by 1000 CSS-pixel viewport, device scale factor 1, reduced motion, the locally bundled Inter variable font, explicit host theme tokens, hidden carets, disabled animation and transition timing, one worker, and loopback-only networking. Native `toHaveScreenshot` assertions own the PNGs with a `maxDiffPixels` budget of 250, which absorbs residual raster noise while remaining far below the pixel area of a missing badge, icon, or status string. The cross-platform scheduled matrix runs behavioral reliability checks and never compares platform-specific rasterization.

| ID    | Baselines                                                                                                                                        | Disposition |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------|-------------|
| VI-01 | `vi-01-modeled-graph-light.png`, `vi-01-modeled-graph-dark.png`                                                                                  | Covered     |
| VI-02 | `vi-02-modeled-graph-details-light.png`                                                                                                          | Covered     |
| VI-03 | `vi-03-planned-unresolved-light.png`, `vi-03-planned-unresolved-dark.png`                                                                        | Covered     |
| VI-04 | `vi-04-graph-diff-all-statuses-light.png`, `vi-04-graph-diff-all-statuses-dark.png`                                                              | Covered     |
| VI-05 | `vi-05-credential-profile-list-light.png`, `vi-05-credential-profile-form-light.png`                                                             | Covered     |
| VI-06 | `vi-06-environment-list-light.png`, `vi-06-environment-list-dark.png`, `vi-06-environment-create-light.png`, `vi-06-environment-create-dark.png` | Covered     |
| VI-07 | `vi-07-deploy-success-light.png`, `vi-07-deploy-failed-light.png`                                                                                | Covered     |

### Baseline ownership and update procedure

`ubuntu-latest` is a moving image, so a runner or Chromium upgrade can invalidate every PNG at once. Until the generation step is pinned to a digest-addressed Playwright container, treat baseline churn as an expected maintenance event and handle it as follows.

1. Confirm the diff is environmental rather than a product regression by reading the uploaded diff images.
2. Regenerate on the canonical runner by dispatching **Canvas Reliability** and taking the captured PNGs, not local Windows or macOS output.
3. Commit the regenerated PNGs in their own commit whose message states the environmental cause.
4. Have a human review the regenerated images before merge.

Pinning generation and comparison to a digest-addressed container is the recommended follow-up and is not delivered here.

### Worktree branch preservation

The graph and planned views must never fall back to `main`. VI-01 asserts the rendered `#graph-branch` value and every intercepted `/api/load-graph` refresh body carries the session worktree branch; VI-03 asserts the same for `#planned-branch`. A regression to an implicit default branch fails these assertions rather than passing on an unchanged screenshot.

## Extended reliability inventory

`pnpm run test:reliability` runs on Ubuntu, Windows, and macOS each week and on manual dispatch. It selects the existing focused suites below rather than duplicating their behavior in a second harness. Running these suites natively on three hosts is what the schedule adds; it does not convert a unit test with a mocked boundary into a native end-to-end check, and the dispositions below say so.

| Phase 7 category                       | Owning checks                                                                                                                                                                                            | Disposition |
|----------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------|
| Empty or partial data                  | `pages/graph-page.test.ts`, `pages/planned-graph-page.test.ts`, `pages/graph-diff-page.test.ts`, `pages/deployed-graph-page.test.ts`, `environment/environments.test.ts`, `browser/repositories.test.ts` | Covered     |
| Expired caches                         | `src/deploy-artifacts.test.ts`, `test/integration/http/deployments.test.ts`, `test/integration/http/create-environment.test.ts`                                                                          | Covered     |
| Repeated polling                       | `browser/heartbeat.test.ts`, `environment/operations.test.ts`, `pages/deployed-graph-page.test.ts`, `browser/repositories.test.ts`                                                                       | Covered     |
| Cancellation races and late callbacks  | `pages/graph-page.test.ts`, `pages/planned-graph-page.test.ts`, `pages/graph-diff-page.test.ts`, `pages/deployed-graph-page.test.ts`, `environment/operations.test.ts`, `browser/lifecycle.test.ts`      | Covered     |
| Timeouts                               | `browser/heartbeat.test.ts` deadlines, `browser/repositories.test.ts` diff timeouts, `environment/operations.test.ts` bounded poll loops                                                                 | Covered     |
| Multiple instances                     | `src/server/create-canvas-server.test.ts` instance isolation, concurrent stop, reopen, and per-instance state                                                                                            | Covered     |
| Cleanup                                | `browser/lifecycle.test.ts` timer and listener teardown, `src/server/create-canvas-server.test.ts` server shutdown, Playwright global teardown                                                           | Partial     |
| GitHub authentication command behavior | `src/gh.test.ts` on all three matrix hosts, plus `src/gh.windows.test.ts` real Windows process behavior in the scheduled Windows job                                                                     | Partial     |
| Windows and macOS paths                | `src/workspace.test.ts` confinement, `browser/graph/build.test.ts` source normalization, `src/gh.windows.test.ts` native argument handling                                                               | Partial     |

### Residual gaps

These are named rather than implied covered, and each is a candidate follow-up.

- **Native GitHub authentication execution.** `src/gh.test.ts` fakes the child-process boundary and overrides the reported platform, so the matrix proves command construction is stable per host, not that a real `gh auth status`, `gh auth token`, or `gh auth switch` invocation behaves identically. Only Windows has a native process-level check, in `src/gh.windows.test.ts`; the Ubuntu and macOS equivalents are not delivered.
- **Native macOS path behavior.** Path confinement and source normalization run natively on macOS, but there is no macOS analogue of the Windows native process suite.
- **Harness cleanup depth.** `test/e2e/support/canvas-harness.test.ts` covers helper behavior; it does not construct and unwind a full harness or assert that no deadline timer remains pending after early settlement. The harness itself is Phase 6 code and is intentionally not modified here.

## Retry-only observability

The scheduled Ubuntu visual job runs every baseline twice. A first-attempt failure followed by a retry pass is never silent: both Playwright configurations write a JSON retry-only report, continuous integration uploads it with traces and HTML output, and a dedicated step writes the offending test titles into the job summary and raises a GitHub warning annotation for each one. Safety tests remain in the non-retrying Phase 6 project and never retry.
