# Radius Canvas Phase 8 implementation plan

- **Status**: Draft for review
- **Scope**: Supported-host qualification

## Goal

Phase 8 qualifies the installed Radius extension in the GitHub Copilot app. It must test behavior owned by the real host: plugin discovery, canvas registration, panel lifecycle, runtime routing, close and reopen behavior, provider reconnect, host-injected authentication, and the real `gh` secure credential store.

The existing Playwright suite remains the browser and loopback-server gate. It must not be reported as real-host evidence.

## First dependency

Before implementing the suite, confirm that the supported GitHub Copilot app exposes an approved automation interface for installing an exact plugin artifact and controlling canvas open, focus, close, reload, and reconnect behavior. If no supported interface exists, coordinate an approved app-driver or UI-automation boundary first. Do not replace real-host qualification with another simulated SDK or loopback harness.

## Controlled test environment

Run qualification only on protected, ephemeral desktop runners using merged or release-candidate code. Each run records the operating system, Copilot app version, plugin version, source commit, and artifact digest.

Each runner uses:

- A dedicated operating-system profile.
- A disposable workspace and repository.
- Disposable GitHub test accounts.
- An isolated `GH_CONFIG_DIR`.
- No inherited GitHub, cloud, or developer credentials.
- The exact signed plugin artifact being qualified.
- Mandatory cleanup of the plugin, extension files, credentials, processes, logs, and workspace.

Credentials are available only after protected environment approval. Pull requests do not receive real-host credentials.

## Authentication profiles

Run the host cases with both supported credential paths:

1. **Host-injected token**: start with an empty `gh` credential store, confirm the expected disposable identity and scopes, and prove the token is neither persisted nor logged.
2. **Real `gh` secure store**: remove injected tokens, authenticate a disposable account through real `gh`, confirm identity survives reopen and reconnect, then log out and destroy the dedicated operating-system profile.

The harness verifies behavior through supported `gh` commands and rendered identity. It never reads token values, keychain files, or a developer credential store.

## Required host cases

| ID      | Required evidence                                                                                                                     |
|---------|---------------------------------------------------------------------------------------------------------------------------------------|
| HOST-01 | The installed artifact registers the Radius provider, canvas, actions, and tools exactly once.                                        |
| HOST-02 | Opening `canvasId: radius` with `instanceId: radius-panel` creates one panel.                                                         |
| HOST-03 | The iframe becomes ready, renders from the loopback server, and retains the session repository and worktree branch.                   |
| HOST-04 | One deterministic read-only action crosses the host, runtime, extension, and canvas boundaries and returns the expected result.       |
| HOST-05 | Reopening `radius-panel` focuses or reloads the existing panel without creating another panel or server.                              |
| HOST-06 | Closing the panel cancels browser-owned work and removes its server, listeners, timers, and child processes exactly once.             |
| HOST-07 | Reloading or reconnecting the provider restores the open instance with the same repository and branch and without a duplicate server. |

Close, reopen, and reconnect assertions must follow the existing cancel-or-continue policy. Browser-owned work is cancelled; durable server operations may continue only when they have persisted identity and are shown as continuing.

## Harness and results

Add a host suite under `packages/adapter-canvas/test/host/` only after the approved host-driver boundary exists. Keep the driver narrow: install, launch, discover, open, focus, close, reload, reconnect, collect diagnostics, and shut down.

Each case emits a redacted machine-readable result containing:

- Host case and authentication profile.
- App, plugin, operating-system, commit, and artifact versions.
- Instance and lifecycle identifiers.
- Product assertions and cleanup assertions.
- One classification: `passed`, `product_failure`, `harness_failure`, or `cleanup_failure`.

A cleanup failure always fails qualification. One diagnostic retry may be allowed, but the original failure and every retry-only pass remain visible in the job summary and uploaded artifacts.

## Release integration

Add a protected reusable or manual workflow, such as `.github/workflows/canvas-host-qualification.yml`, that:

- Uses the exact release-candidate artifact.
- Runs the supported operating-system and authentication-profile matrix.
- Uploads redacted logs and result JSON even on failure.
- Requires HOST-01 through HOST-07 and cleanup to pass.
- Gates stable publication from `release.yml`.
- Never runs as a normal pull-request gate.

Skipped, simulated, or cleanup-incomplete cases do not count as qualification.

## Delivery sequence

1. **Host contract**: add the driver interface, result schema, redaction, cleanup model, and deterministic fake-driver unit tests.
2. **Core host flow**: provision the protected runner and implement HOST-01 through HOST-04.
3. **Lifecycle and identity**: implement HOST-05 through HOST-07 and both authentication profiles.
4. **Release gate**: add the protected workflow, traceability, operator documentation, diagnostics, and stable-release requirement.
5. **Policy refresh**: update the Radius code-quality skill in a separate signed pull request after Phase 8 is complete.

Each implementation pull request must be independently reviewable, signed and signed off, and explicit about which host cases it delivers.

## Completion criteria

Phase 8 is complete when every HOST-01 through HOST-07 case passes in the supported GitHub Copilot app before release, both authentication profiles are qualified without exposing credentials, retry-only passes are reported, product failures are distinguishable from harness failures, and cleanup is proven on success and failure.
