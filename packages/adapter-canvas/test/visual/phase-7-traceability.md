# Phase 7 visual and reliability traceability

Phase 7 adds the Playwright visual suite (P2-A) in `test/visual/canvas-visual.test.ts`, the recurring functional workflow in `.github/workflows/canvas-functional.yml`, and the scheduled extended resilience gate (P2-B) in `.github/workflows/canvas-reliability.yml`. All reuse the Phase 6 real Chromium harness and deterministic fake CLI boundary. No personal credential, live cloud, mutable repository, public content network, or inherited credential store is used.

## Visual baseline inventory

The seventeen PNGs in `__screenshots__/` are **proposed baselines awaiting human review**. They were captured on the pinned Ubuntu 24.04 GitHub-hosted runner with the lockfile-pinned Playwright browser, which owns the canonical rasterization, and they are not reviewed merely because continuous integration produced them. A reviewer must open each PNG and accept it before this suite is a trustworthy contract, and every later change to a PNG must state its product reason in the pull request and receive the same review.

The suite fixes the Ubuntu 24.04 runner image, the lockfile-pinned Playwright package and Chromium build, a 1440 by 1000 CSS-pixel viewport, device scale factor 1, reduced motion, the locally bundled Inter variable font, a frozen synthetic host-token palette, hidden carets, disabled animation and transition timing, one worker, and loopback-only networking. The synthetic palette deliberately shadows the shell's fallback tokens so the baselines remain independent of host palette changes; these screenshots do not claim visual coverage of the no-host-token fallback path. Because an injected `@font-face` is fetched lazily, the suite explicitly loads every weight it uses and awaits `document.fonts.ready`, then asserts the face is available before any capture; a page that would otherwise be photographed in fallback metrics fails instead of silently minting a baseline. Native `toHaveScreenshot` assertions own the PNGs with a per-pixel threshold of 0.1 and a `maxDiffPixels` budget of 250, which absorbs residual raster noise while remaining far below the pixel area of a missing badge, icon, or status string. The cross-platform scheduled matrix runs behavioral reliability checks and never compares platform-specific rasterization.

VI-06 waits for the current selected-account readiness flow to settle before capture: the repository account must be selected, the readiness summary must report that deployments can be configured, the credential source must be the keyring, the re-check control must be idle, and the create action must be enabled. The lower-form capture also requires deterministic Azure discovery to return one resource group and one AKS cluster, selects both resources, and confirms the default namespace. These semantic guards fail before screenshot comparison if the form is still checking, discovery fails, or the current readiness contract changes.

| ID    | Baselines                                                                                                                                                                                                                               | Disposition |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------|
| VI-01 | `vi-01-modeled-graph-light.png`, `vi-01-modeled-graph-dark.png`                                                                                                                                                                         | Covered     |
| VI-02 | `vi-02-modeled-graph-details-light.png`                                                                                                                                                                                                 | Covered     |
| VI-03 | `vi-03-planned-unresolved-light.png`, `vi-03-planned-unresolved-dark.png`                                                                                                                                                               | Covered     |
| VI-04 | `vi-04-graph-diff-all-statuses-light.png`, `vi-04-graph-diff-all-statuses-dark.png`                                                                                                                                                     | Covered     |
| VI-05 | `vi-05-credential-profile-list-light.png`, `vi-05-credential-profile-form-light.png`                                                                                                                                                    | Covered     |
| VI-06 | `vi-06-environment-list-light.png`, `vi-06-environment-list-dark.png`, `vi-06-environment-create-light.png`, `vi-06-environment-create-dark.png`, `vi-06-environment-create-lower-light.png`, `vi-06-environment-create-lower-dark.png` | Covered     |
| VI-07 | `vi-07-deploy-success-light.png`, `vi-07-deploy-failed-light.png`                                                                                                                                                                       | Covered     |

### Baseline ownership and update procedure

The canonical visual environment uses the explicit `ubuntu-24.04` runner and caches the lockfile-selected Playwright browser by operating system, architecture, and lockfile hash. An intentional runner or Playwright browser upgrade can still invalidate every PNG at once; handle that baseline churn as follows.

1. Confirm the diff is environmental rather than a product regression by reading the uploaded diff images.
2. Dispatch **Canvas Functional Tests** with **Regenerate and upload the canonical visual baselines** enabled.
3. Download the `canvas-visual-functional` artifact and take the PNGs from `packages/adapter-canvas/test/visual/__screenshots__/`.
4. Commit the regenerated PNGs in their own commit whose message states the environmental cause.
5. Have a human review the regenerated images before merge.

The checked-in PNGs use Linux rasterization from the pinned Ubuntu 24.04 runner. A direct `pnpm test:visual` comparison on Windows or macOS is expected to fail even when the rendered state is correct; use `pnpm test:visual -- --ignore-snapshots` for local semantic checks and the workflow input above for canonical regeneration.

### Worktree branch preservation

The graph and planned views must never fall back to `main`. Every VI-01 and VI-02 case asserts the rendered branch control and polls every intercepted `/api/load-graph` body for the session repository and worktree branch. Every VI-03 case dispatches the current planned-branch selection through the real browser behavior and applies the same assertion to `/api/plan-graph` before restoring the seeded planned result. VI-04 separately asserts its explicit `main` base and worktree head because graph diff compares committed branches rather than using the implicit session branch. A regression to an implicit default branch fails these assertions rather than passing on an unchanged screenshot.

## Extended reliability inventory

`pnpm run test:reliability` runs on Ubuntu, Windows, and macOS every eight hours and on manual dispatch. A dedicated Vitest configuration selects the existing focused test areas with directory globs, so moving or adding a test inside an owning area cannot silently remove it from the scheduled run. Running these suites natively on three hosts is what the schedule adds; it does not convert a unit test with a mocked boundary into a native end-to-end check, and the dispositions below say so.

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
- **Heartbeat navigation race.** Build run `32389778496` recorded `drives heartbeat to recovery threshold and reloads only after recovery` as a retry-only pass after navigation destroyed the first attempt's execution context. The latest current-head run passed without retry, so the intermittent Phase 6 journey race is tracked separately in issue #449 rather than hidden or misattributed to the visual suite.

Scheduled jobs have explicit timeouts and concurrency cancellation. A scheduled failure opens or updates a repository issue and a later successful run closes it. GitHub can disable scheduled workflows after 60 days without repository activity; because a disabled workflow cannot alert on itself, repository activity or a manual re-enable remains the external prerequisite.

## Retry-only observability

The hermetic Canvas functional workflow runs the visual comparisons every eight hours with Playwright retries disabled, so a mismatch fails the run rather than becoming a retry-only warning. The visual suite is intentionally not a pull-request, publish, or release gate. The pull-request Chromium gate retains one permitted diagnostic retry for non-safety journeys: both Playwright configurations write a JSON retry-only report when used, and the reporter writes offending test titles into the job summary and raises a GitHub warning annotation for each one. Safety tests remain in the non-retrying Phase 6 project and never retry.
