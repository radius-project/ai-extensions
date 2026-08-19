# Deployed application graph

- **Authors**: Nithya Subramanian (@nithyatsu), Brooke Hamilton (@brooke-hamilton)
- **Date**: 2026-08
- **Status**: Implemented

## Overview

The Radius side panel renders four views of an application: **Modeled** (the app as authored in `.radius/app.bicep`), **Planned** (Modeled with recipe outputs resolved), **Diff** (Planned changes between two branches), and **Deployed**. The Deployed tab showed "Nothing deployed yet" after a successful deploy, and showed no per-resource progress during one.

This design makes Deployed a first-class view of the application in a target environment. The graph mirrors the Modeled topology — one node per Radius resource, no output resources — starts fully greyed when the user opens it, and transitions each node individually through a per-node lifecycle as deployment status arrives. A legend explains the three states.

The projection design, the greyed-at-open behavior, the status legend, and the per-node lifecycle are @nithyatsu's, from PR [#200](https://github.com/radius-project/ai-extensions/pull/200) ("live graph support") and its design note `docs/design/2026-07-deployed-application-graph.md` on branch `deployedgraphsidecar`. That PR's transport does not work (see [Transport](#transport)), and PR #267 restructured the repository underneath it, so this document carries the design forward on the current layout with a different status signal.

## Terms and definitions

- **Modeled graph** — the Radius resources declared in `.radius/app.bicep`, produced by `rad app graph` and normalized by `applicationGraphToResources`. One node per Radius resource; the concrete cloud resources a recipe expands to are carried on each node's `outputResources`.
- **Deployed graph (projection)** — the Modeled topology annotated with a per-node deploy status of `pending`, `in_progress`, `success`, or `failed`.
- **Output resource** — a concrete cloud resource under a Radius resource. Present on Modeled resources, but never rendered as a separate node on the Deployed view.
- **Deploy-status artifact** — the GitHub Actions workflow artifact the deploy publishes, carrying the deployed graph and the per-resource status map. Its contract is documented in [`docs/architecture/deployed-graph.md`](../architecture/deployed-graph.md).

## Objectives

### Goals

1. Give Deployed a stable topology — the Modeled resources with no output resources — so the shape does not shift when a deploy starts or finishes.
2. Render the view as a greyed skeleton the moment the user lands on it, before any status is known.
3. Drive per-node status: progress badge while pending or deploying, green check on success, red cross on failure.
4. Render a legend mapping the three badges to their meanings.
5. Show a correct deployed graph after every run, including failures.

### Non-goals

1. **Rendering output resources on the Deployed view.** The Modeled view continues to expand them; the Deployed view does not.
2. **Persisting the live snapshot history.** The view renders the greatest valid sequence; older ring slots are transport history, not a deployment timeline.
3. **Persisting deployment history across canvas sessions.** Status is per-session; the newest published artifact is re-read on open.

## Design

Deployed is a **projection**: a fixed topology rendered with a per-node status map derived from the deploy-status stream. Topology and status are computed independently, so the graph can render before any status is known and never changes shape once a deploy starts. This is Option 2 from @nithyatsu's original design note, adopted unchanged.

Three components:

1. **`@radius-project/core`** — `projectDeployedGraph` builds the Deployed skeleton from Modeled resources: apply the shared visualization filter, strip `outputResources`, stamp `deployStatus`. Pure.
2. **Canvas server** — `/api/deployed-graph` returns the projection with an explicit `mode` of `greyed`, `live`, or `terminal`, scoped to the application and environment the page's selectors request. The deploy monitor folds published status into the resources it is already tracking.
3. **Canvas UI** — `deployedGraphPage` mounts the skeleton on first paint with `deployMode` and `showLegend`, and updates through the renderer's controller so React Flow keeps its viewport.

### Transport

The original design read `rad deploy` stdout live from the GitHub Actions job-log endpoint. **That cannot work.** GitHub exposes no API for a running job's log output:

- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` returns 200 but withholds the currently-running step. A controlled workflow printing a line every two seconds showed zero lines for three minutes, then all 91 at once on completion.
- The web UI's live view endpoint is session-cookie-only and 404s with a full repo-scope token.
- `gh run watch` streams step status with no log content.

Workflow artifacts are the only transport with the required property: they are listable and downloadable while a run is still in progress. The deploy workflow publishes a `radius-deploy-status-<environment>-<app>` artifact, and the canvas polls for it. The full contract — artifact name, lookup rule, `deploy-progress.json` schema, status mapping, and merge rules — is normative in [`docs/architecture/deployed-graph.md`](../architecture/deployed-graph.md) and is not restated here.

Two alternatives were considered and rejected explicitly: a GHCR OCI artifact (the previous transport; its registry and tag were derived independently in bash and TypeScript and compared for equality, which silently broke whenever the two derivations disagreed), and a git orphan branch (`radius-deploy-status`; no workflow had created it for some time, so every read returned nothing).

### Status keying

Each node is matched to a status entry by exact `id`, then lowercased `name|type` with the API version stripped, then lowercased `name`.

The original design proposed `id || name`. The middle tier is added because modeled resource ids are synthesized locally by `buildResourceID` and are not guaranteed to equal the UCP ids the control plane reports — with id-then-name alone, an id mismatch silently degrades every node to bare-name matching, which collides across resource types.

### Merging

Each payload is an independent snapshot, not a stream of transitions, so merging is conservative: `failed` is terminal within a run, `success` regresses only on an explicit `failed`, and a resource absent from a payload keeps its current status rather than resetting. The run's own conclusion settles the graph at the end — success forces every node green, any other conclusion fails whatever is still unfinished while leaving already-terminal values alone. This resolves open question 3 from the original design the way it proposed.

## Two bugs found while implementing

Both predate this design and are fixed alongside it.

1. **The deploy monitor's in-flight handling never ran.** `server.ts` gated it on finding a workflow step named `"Deploy Application"`. No such step exists anywhere in `radius-project/radius`; the step that runs `rad deploy` is named `Run rad commands`. Because the name never matched, the start-time capture, per-resource status handling, the "still running" heartbeat, and the fallback that unsticks a fully-grey graph were all unreachable on every real deploy. The name now lives in an exported `DEPLOY_RAD_COMMANDS_STEP` constant with a test pinning its value.
2. **The Deployed page discarded the branch the server sent.** `deployedGraphPage` hardcoded `branch: 'main'` when mounting the graph even though `/api/deployed-graph` already returned the workspace branch, so "View source code" resolved against `main` for anyone working on a session worktree branch.

## Live progress

The Radius deploy action publishes changed per-resource snapshots through an eight-slot run-scoped artifact ring while `rad deploy` executes. Each successful upload increments the payload `sequence`; the fixed-name terminal artifact uses the next sequence and adds the deployed graph and diagnostics.

The consumer polls on a timer while a run is in progress, downloads only newly observed artifact IDs, rejects explicit run mismatches, and selects the greatest valid sequence independent of artifact list order or ring slot. Existing final-only artifacts remain supported.

The refresh interval is 15 seconds and is stated in the UI. An artifact upload takes several seconds, so a faster poll returns identical bytes; saying so means a graph that has not changed reads as "no new data yet" rather than "broken". The deploy log below the graph keeps its 1.5-second stream and carries the moment-to-moment liveness.

## Error handling

- **No `.radius/app.bicep`.** The page falls through to the existing app-bicep generation path rather than rendering an empty graph.
- **No deployment yet.** The modeled topology renders greyed with `mode: greyed`; the empty state is reserved for having no resources at all.
- **Artifact unreadable (401/403).** Classified as `auth` and reported distinctly from a missing artifact, since retrying will not help.
- **Artifact malformed.** Reported as such and the graph falls back to the modeled topology; a payload declaring an unknown `schemaVersion` is rejected rather than guessed at, because a misread status map paints the graph with wrong colors.
- **Status read fails during a run.** The failure is logged to the deploy feed and the graph keeps its current status; a read failure must not blank the tab.
- **Deploy failed.** The completed run log is read with `fetchRunLog` and mined for the structured `rad` error block. This is the one signal the artifact transport does not carry, and it works because the run is complete by then.

## Test plan

Every test runs with no network, Docker, or `gh`, against pure functions or injected ports.

- `packages/core/src/graph/deployed_test.ts` — key derivation and precedence, outputs stripped, unknown key defaults to pending, visualization filter applied, input never mutated.
- `packages/adapter-canvas/src/deploy-artifacts.test.ts` — name sanitization including multi-byte and length cap; two-tier artifact selection and payload confirmation; schema validation; the full `provisioningState` mapping; status-map keying; merge rules; reader classification, TTL cache, single-flight, and stale-`sequence` rejection.
- `packages/adapter-canvas/src/server.test.ts` — the deploy step-name constant.
- `packages/adapter-canvas/src/pages.test.ts` — deploy mode and legend on mount, controller-based updates, server-supplied branch, scoped graph request, empty-state condition, stated cadence, visibility pause.
- `packages/adapter-canvas/src/client.test.ts` — status legend in deploy mode, category legend elsewhere, no output-resource child nodes.

Not coverable here: a real run producing a real artifact. One manual deploy — verified for both a success and a failure — is the gate before merge.
