# Deployed graph retrieval (GHCR-first, branch fallback)

The canvas "Deployed" tab renders the application graph that a deploy actually produced. This document describes where that graph comes from and how the reader resolves it.

## Source of the deployed graph

After a successful deploy, the GitHub Actions workflow publishes the deployed application graph to GHCR as a single OCI artifact (see radius-project/radius PR [#12591](https://github.com/radius-project/radius/pull/12591)). The producer's `publish-deploy-status` composite action runs `rad app graph` against the live control plane and `oras push`es these files as one artifact tagged `<environment>-<app>-latest`:

- `deploy-graph.json` — the deployed application graph (the authoritative payload)
- `deploy-progress.log`, `deploy-activity.log`, `deploy-controlplane.log`, `deploy-state.txt` — status snapshots

The artifact carries the artifact type `application/vnd.radius.deploy-status.v1+json`, and each file is a layer whose `org.opencontainers.image.title` annotation is the file name.

Historically the deployed graph was read from the `radius-deploy-status` orphan branch. That branch is kept as a fallback while producers migrate.

## Registry and tag derivation

The reader derives the GHCR reference the same way the producer does, so it pulls the exact artifact the deploy pushed:

- **Registry** — prefer an explicit graph registry override; otherwise derive from the environment's GHCR state registry (`RADIUS_STATE_REGISTRY`) by replacing the first `radius-state` token with `radius-graph`, or appending `-graph` when that token is absent.
- **Tag** — prefer an explicit tag override; otherwise `<environment>-<app>-latest`, lowercased with every run of characters outside `[a-z0-9._-]` collapsed to `-`, leading/trailing `-` stripped, and the base capped at 80 characters (falling back to `deploy-status` when the base sanitizes to empty).

On the canvas side the state registry is recomputed with `stateRegistryForEnvironment(repo, environment)`, the environment is the deploy environment, and the app name is extracted from the app bicep the same way the producer extracts it (the first `name: '...'` literal).

## Read path

`createDeployStatusReader` in [`adapters/canvas/src/deploy.mjs`](../../adapters/canvas/src/deploy.mjs) is GHCR-first with a transparent branch fallback:

1. Pull the OCI artifact (`pullOciArtifactFiles` in [`adapters/canvas/src/ghcr.mjs`](../../adapters/canvas/src/ghcr.mjs)) using the stored `gh` CLI credential, cached per short TTL with single-flight de-duplication.
2. Classify the outcome as `ok`, `missing`, `malformed`, `auth`, `error`, or `unconfigured`.
3. When the artifact is unavailable for any reason, read `deploy-graph.json` from the `radius-deploy-status` branch instead.

Only `deploy-graph.json` is treated as authoritative from GHCR. The sibling log/state files the producer packs there are result snapshots, so live-log and terminal-state reads stay on the branch.

The user-facing deploy feed distinguishes the outcomes: it reports whether the graph came from the GHCR artifact or the branch, and surfaces distinct guidance for `auth` (private package access denied — refresh `read:packages`) versus a `malformed` artifact versus "not available yet".

## Environment variables and permissions

- **Producer** reads `RADIUS_GRAPH_REGISTRY` and `RADIUS_GRAPH_TAG` (both optional) and derives from `RADIUS_STATE_REGISTRY` when they are unset.
- **Consumer** (canvas) needs a stored `gh` CLI login with package read access. The GHCR pull requests the `repository:<owner>/<package>:pull` scope, which requires the `read:packages` scope on the credential. Grant it with `gh auth refresh -s read:packages`. The deploy-status package is private, so the credential must also have access to the target repository.
