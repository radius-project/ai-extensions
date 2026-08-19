# Radius operation persistence manual testing

The automated functional suite covers restart recovery for input-required operations, exact verification references, post-mutation interruption, return context, terminal outcomes, active-operation conflicts, corrupt stores, and forbidden persisted data.

Manual testing remains required only where local fakes cannot prove the behavior of external systems:

1. Verify a real Azure App Registration, Service Principal, federated credential, and role assignment are not duplicated when the extension restarts after the remote mutation.
2. Verify GitHub's live Environment `GET`/`PUT` race still produces `created_candidate` and is never automatically deleted.
3. Verify a real GitHub Actions dispatch is resolved to the expected run when other verification runs exist in the repository.
4. Verify the Copilot host restarts the installed extension and restored Canvas panel with the expected session ID, repository, and worktree branch.
5. Inspect the installed extension's session operation file during a live setup to confirm no provider-specific CLI version emits an unexpected sensitive value into an allowlisted field.

Use disposable Azure and GitHub resources for these checks. Automated tests remain authoritative for deterministic state transitions and persistence behavior.

## Chromium Canvas checks

Install the supported browser once with `pnpm exec playwright install chromium`, then run `pnpm run test:chromium`.

The suite starts the real Canvas server through `getOrCreateServer` on `127.0.0.1` with an OS-assigned port and drives the production route table, page renderers, and compiled browser entries. External boundaries are replaced by fake `gh`, `rad`, `az`, and `aws` executables placed on `PATH`, an isolated `GH_CONFIG_DIR`, a per-test temporary workspace, and placeholder secrets. Any request to a non-loopback origin fails the test. React, React DOM, React Flow, and dagre are the real libraries production bundles into the graph browser entry, so the graph renders entirely offline with no mirror, interception, or test-only asset loader. Nothing reads personal credentials or contacts GitHub, a cloud provider, or a CDN.

Prerequisites:

- Chromium installed through Playwright, as above.
- Workspace dependencies installed with `pnpm install --frozen-lockfile`.
- On Windows, a Go toolchain on `PATH`. The harness compiles a tiny shim to produce `gh.exe` and `rad.exe` because Node cannot execute a `.cmd` shim without a shell. POSIX hosts use shell shims and need no extra tooling.

Safety, destructive, branch-selection, path-confinement, and redaction cases run in the `canvas-safety` Playwright project with retries disabled; the remaining cases allow one diagnostic retry. Failure traces, screenshots, and the HTML report are retained under `packages/adapter-canvas/test-results/` and `packages/adapter-canvas/playwright-report/` on failure only; those artifacts are diagnostics and are not visual baselines. `packages/adapter-canvas/test/e2e/phase-6-traceability.md` maps the evidence delivered here and the remaining Phase 6 gaps. The browser-functional layer and the two real-form submission journeys are not complete.

## Browser component checks

Run `pnpm run test:component` after the same one-time `pnpm exec playwright install chromium`. The suite is Vitest Browser Mode with the Playwright Chromium provider, and it mounts the production `src/browser/graph/` modules into a real DOM through the real ReactDOM concurrent root. It uses the same real React, React DOM, React Flow, and dagre packages the build bundles into the graph browser entry, so the packaged libraries are exercised offline with no stand-ins. Its ports for source opening and details toggling are injected, so it makes no network requests at all.

This layer covers real browser behavior that the journey suite does not reach at node-card granularity: keyboard activation of the card's details control with `Enter` and `Space`, focus retention, sequential tab order across cards, real dagre coordinates, disabled source rows, and mount/update/unmount lifecycle. It needs no Go toolchain and no fake CLI executables.

The separate P1-A browser-functional suite specified by the test architecture has not been added. The component suite should not be described as covering that layer, and the Playwright critical journeys should not be counted twice as browser-functional evidence.
